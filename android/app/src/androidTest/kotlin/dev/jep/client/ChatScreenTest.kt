package dev.jep.client

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotFocused
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.test.swipeRight
import androidx.compose.ui.test.swipeUp
import androidx.compose.ui.test.longClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.jep.client.domain.model.ChatMessage
import dev.jep.client.domain.model.ChatPart
import dev.jep.client.domain.model.HarnessSetting
import dev.jep.client.domain.model.HarnessSettings
import dev.jep.client.domain.model.Model
import dev.jep.client.domain.model.Role
import dev.jep.client.domain.model.SendMode
import dev.jep.client.domain.repository.ChatEvent
import dev.jep.client.domain.repository.ModelChoices
import dev.jep.client.domain.model.TokenUsage
import dev.jep.client.domain.model.ToolStatus
import dev.jep.client.presentation.chat.ChatScreen
import dev.jep.client.presentation.chat.ChatViewModel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ChatScreenTest {

    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun back_in_a_conversation_returns_to_the_list() {
        var backed = 0
        val vm = ChatViewModel(FakeChatRepository(), "s1", "T", "jep", "opencode")
        rule.setContent { ChatScreen(vm, onBack = { backed++ }, onNew = {}, onForgetPairing = {}) }
        rule.waitForIdle()
        rule.runOnUiThread { rule.activity.onBackPressedDispatcher.onBackPressed() }
        rule.waitForIdle()
        assertEquals(1, backed)
    }

    private fun manyMessages(n: Int) = (1..n).map {
        ChatMessage("m$it", Role.ASSISTANT, it.toLong(), listOf(ChatPart.Text("message number $it")))
    }

    @Test
    fun opening_a_conversation_lands_on_the_latest_message() {
        val vm = ChatViewModel(FakeChatRepository(messages = manyMessages(30)), "s1", "T")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitUntil(10_000) {
            rule.onAllNodesWithText("message number 30", substring = true).fetchSemanticsNodes().isNotEmpty() &&
                rule.onAllNodesWithTag("positioning-overlay").fetchSemanticsNodes().isEmpty()
        }
        rule.onNodeWithText("message number 30", substring = true).assertIsDisplayed()
        rule.onAllNodesWithContentDescription("jump to latest").assertCountEquals(0)
        rule.onAllNodesWithText("message number 1 ", substring = true).assertCountEquals(0)
        rule.onAllNodesWithText("▍", substring = true).assertCountEquals(0)
    }

    @Test
    fun status_line_keeps_last_reported_usage_during_a_partial_stream_refresh() {
        val choices = ModelChoices(
            all = listOf(Model("opencode", "test-model", contextLimit = 32_000)),
            current = "opencode/test-model",
        )
        val completed = ChatMessage(
            "a0", Role.ASSISTANT, 1, listOf(ChatPart.Text("previous reply")),
            model = "opencode/test-model",
            cost = 0.02,
            tokens = TokenUsage(input = 1_200),
        )
        val repo = FakeChatRepository(messages = listOf(completed), choices = choices)
        val vm = ChatViewModel(repo, "s1", "T", "jep", "opencode")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitUntil(10_000) {
            rule.onAllNodesWithText("test-model", substring = true).fetchSemanticsNodes().isNotEmpty() &&
                rule.onAllNodesWithText("1.2K/32.0K", substring = true).fetchSemanticsNodes().isNotEmpty() &&
                rule.onAllNodesWithText("$0.02", substring = true).fetchSemanticsNodes().isNotEmpty()
        }

        rule.runOnUiThread {
            repo.emitEvent(ChatEvent.TextDelta("s1", "a-live", "p1", "text", "streaming answer"))
        }
        rule.waitUntil(5_000) { vm.state.value.live != null }
        rule.runOnUiThread {
            repo.historyOverride = listOf(
                ChatMessage("a0", Role.ASSISTANT, 1, listOf(ChatPart.Text("partial snapshot"))),
            )
            vm.refresh()
        }
        rule.waitUntil(10_000) {
            rule.onAllNodesWithText("partial snapshot", substring = true).fetchSemanticsNodes().isNotEmpty()
        }
        rule.onNodeWithText("test-model", substring = true).assertExists()
        rule.onNodeWithText("1.2K/32.0K", substring = true).assertExists()
        rule.onNodeWithText("$0.02", substring = true).assertExists()
    }

    @Test
    fun the_user_message_echo_and_thinking_never_render_as_the_answer() {
        // opencode replays the user's own message mid-turn, then streams
        // thinking, then the answer — the echo once rendered as an agent
        // bubble, and the reasoning as the answer's text
        val repo = FakeChatRepository()
        val vm = ChatViewModel(repo, "s1", "T", "jep", "opencode")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitForIdle()
        rule.runOnUiThread {
            repo.emitEvent(ChatEvent.MessageSeen("s1", "u1", Role.USER))
            repo.emitEvent(ChatEvent.PartChanged("s1", "u1", "p0", ChatPart.Text("how much is a train to london")))
            repo.emitEvent(ChatEvent.TextDelta("s1", "a1", "p1", "reasoning", "The user asks about fares"))
            repo.emitEvent(ChatEvent.TextDelta("s1", "a1", "p2", "text", "about ninety pounds"))
        }
        // the events land in the live row, keyed to the agent's message
        rule.waitUntil(5_000) { vm.state.value.live != null }
        val live = vm.state.value.live!!
        assertEquals("a1", live.messageId)
        // the prompt never enters it — that is the user's message, not the agent's
        assertEquals(
            listOf("about ninety pounds"),
            live.parts.values.filterIsInstance<ChatPart.Text>().map { it.text },
        )
        // and thinking is a thinking block, not the answer's body
        assertEquals(
            listOf("The user asks about fares"),
            live.parts.values.filterIsInstance<ChatPart.Reasoning>().map { it.text },
        )
    }

    @Test
    fun the_live_row_survives_a_poll_while_the_turn_is_still_writing() {
        // The bug this guards: polling history settled the live row the moment
        // the record merely caught up with it (its time is set at creation,
        // mid-stream), so the next delta started an empty LiveTurn and every
        // part before the poll vanished — thinking showed only its last arriving
        // part. Only a completion stamp ends the row, and opencode stamps
        // durationMs at the end.
        val repo = FakeChatRepository()
        val vm = ChatViewModel(repo, "s1", "T", "jep", "opencode")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.runOnUiThread {
            repo.emitEvent(ChatEvent.TextDelta("s1", "a1", "p1", "reasoning", "one "))
        }
        rule.waitUntil(5_000) { vm.state.value.live != null }
        // the record catches up with the still-writing message: served with a
        // creation time but no completion stamp
        repo.historyOverride = listOf(
            ChatMessage("a1", Role.ASSISTANT, 1_700_000_000_000L, listOf(ChatPart.Reasoning("one ")), durationMs = null),
        )
        rule.runOnUiThread { vm.refresh() }
        rule.waitUntil(5_000) { vm.state.value.messages.any { it.id == "a1" } }
        assertTrue("a poll must not drop a turn that is still writing", vm.state.value.live != null)
        // the surviving row keeps what it had; the next delta lands on the SAME row
        rule.runOnUiThread { repo.emitEvent(ChatEvent.TextDelta("s1", "a1", "p1", "reasoning", "two ")) }
        rule.waitUntil(5_000) {
            vm.state.value.live?.parts?.values?.filterIsInstance<ChatPart.Reasoning>()?.singleOrNull()?.text == "one two "
        }
    }

    @Test
    fun your_message_is_not_shown_twice_while_the_turn_is_in_flight() {
        // the placeholder shows the moment you send; the harness's own record
        // then serves the same message. Matching them by id can never work
        // (ours is local), so without matching by text your message sat there
        // twice for the whole turn.
        val repo = FakeChatRepository(
            messages = listOf(ChatMessage("u1", Role.USER, 1, listOf(ChatPart.Text("what else? be creative")))),
        )
        val vm = ChatViewModel(repo, "s1", "T", "jep", "opencode")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitForIdle()
        rule.runOnUiThread { vm.send("what else? be creative") }
        // the turn is in flight; once history has served the message, only one copy remains
        rule.waitUntil(10_000) { vm.state.value.messages.size == 1 }
        rule.onAllNodesWithText("what else? be creative").assertCountEquals(1)
    }

    @Test
    fun a_reply_says_it_is_still_responding() {
        // a pause between parts (thinking, a tool call) must not read as an
        // ending, so the live reply carries a spinner and a word
        val repo = FakeChatRepository()
        val vm = ChatViewModel(repo, "s1", "T", "jep", "opencode")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitForIdle()
        rule.runOnUiThread { repo.emitEvent(ChatEvent.TextDelta("s1", "a1", "p1", "text", "thinking about it")) }
        rule.waitUntil(5_000) { rule.onAllNodesWithText("responding…").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithText("responding…").assertExists()
    }

    @Test
    fun every_delta_reaches_the_screen_not_just_the_first() {
        // The live row used to mutate its parts in place, and a StateFlow drops a
        // value equal to the last one — so every delta after the first was
        // invisible and the visible growth came from the 1.2s history poll. That
        // is what made streaming look chunky and late.
        val repo = FakeChatRepository()
        val vm = ChatViewModel(repo, "s1", "T", "jep", "opencode")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitForIdle()
        rule.runOnUiThread { repo.emitEvent(ChatEvent.TextDelta("s1", "a1", "p1", "text", "one ")) }
        rule.waitUntil(5_000) { rule.onAllNodesWithText("one ", substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        rule.runOnUiThread { repo.emitEvent(ChatEvent.TextDelta("s1", "a1", "p1", "text", "two")) }
        rule.waitUntil(5_000) { rule.onAllNodesWithText("one two", substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
    }

    @Test
    fun the_reply_does_not_rewind_when_the_turn_ends() {
        // The harness's record can lag the live row by a beat. Swapping to it at
        // the instant a turn ends rewound the text for a frame — the "deleted
        // and recreated" flicker. Whichever is further along wins.
        val repo = FakeChatRepository(
            messages = listOf(ChatMessage("a1", Role.ASSISTANT, 5, listOf(ChatPart.Text("one ")))),
        )
        val vm = ChatViewModel(repo, "s1", "T", "jep", "opencode")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        // under suite load waitForIdle can return before the ViewModel collects,
        // and the delta was dropped; the served copy must also be on screen first
        rule.waitUntil(10_000) {
            repo.subscribed &&
                rule.onAllNodesWithText("one ", substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        rule.runOnUiThread { repo.emitEvent(ChatEvent.TextDelta("s1", "a1", "p1", "text", "one two three")) }
        rule.waitUntil(5_000) {
            rule.onAllNodesWithText("one two three", substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        // the shorter served copy must not take over
        rule.onAllNodesWithText("one two three", substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    }

    @Test
    fun an_edit_shows_its_line_counts_without_opening_it() {
        val vm = ChatViewModel(
            FakeChatRepository(
                messages = listOf(
                    ChatMessage(
                        "a1", Role.ASSISTANT, 5,
                        listOf(ChatPart.Tool("t1", "write", ToolStatus.COMPLETED, "/tmp/fib.py", added = 12, removed = 3)),
                    ),
                ),
            ),
            "s1", "T", "jep", "opencode",
        )
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitUntil(6_000) { rule.onAllNodesWithText("+12").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithText("+12").assertExists()
        rule.onNodeWithText("-3").assertExists()
        rule.onNodeWithText("Edited fib.py").assertExists()
    }

    @Test
    fun an_edit_opens_its_change() {
        // the diff sheet used to open at the half-height anchor, so a short
        // change was clipped; skipPartiallyExpanded made it open at the
        // content's own height. This is the assertion that was missing.
        val vm = ChatViewModel(
            FakeChatRepository(
                messages = listOf(
                    ChatMessage(
                        "a1", Role.ASSISTANT, 5,
                        listOf(
                            ChatPart.Tool(
                                "t1", "edit", ToolStatus.COMPLETED, "/tmp/fib.py",
                                added = 1, removed = 1,
                                diff = "@@ -1,1 +1,1 @@\n-old line\n+new line",
                            ),
                        ),
                    ),
                ),
            ),
            "s1", "T", "jep", "opencode",
        )
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitUntil(6_000) { rule.onAllNodesWithText("Edited fib.py").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithText("Edited fib.py").performClick()
        // the sheet names the file and shows the change itself, both sides
        rule.waitUntil(6_000) { rule.onAllNodesWithText("new line", substring = true).fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithText("old line", substring = true).assertExists()
        rule.onNodeWithText("new line", substring = true).assertExists()
    }

    @Test
    fun only_the_message_that_ends_a_turn_has_the_buttons() {
        // opencode answers a turn with several assistant messages (the tool call,
        // then the text); the info/copy row belongs to the last one only
        val vm = ChatViewModel(
            FakeChatRepository(
                messages = listOf(
                    ChatMessage("u1", Role.USER, 1, listOf(ChatPart.Text("write it"))),
                    ChatMessage("a1", Role.ASSISTANT, 2, listOf(ChatPart.Tool("t1", "write", ToolStatus.COMPLETED, "/tmp/f.py", added = 3))),
                    ChatMessage("a2", Role.ASSISTANT, 3, listOf(ChatPart.Text("Created f.py"))),
                ),
            ),
            "s1", "T", "jep", "opencode",
        )
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitUntil(6_000) { rule.onAllNodesWithText("Created f.py", substring = true).fetchSemanticsNodes().isNotEmpty() }
        rule.onAllNodesWithContentDescription("copy response").assertCountEquals(1)
    }

    @Test
    fun a_reasoning_block_says_thinking_and_counts_while_it_is_still_going() {
        val repo = FakeChatRepository()
        val vm = ChatViewModel(repo, "s1", "T", "jep", "opencode")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitForIdle()
        rule.runOnUiThread { repo.emitEvent(ChatEvent.TextDelta("s1", "a1", "p1", "reasoning", "weighing the options")) }
        // present tense while it is going, with the counter (the seconds are
        // driven by an animation, so their advance is not clock-testable here;
        // what matters is that it does not read as finished)
        rule.waitUntil(10_000) {
            rule.onAllNodesWithText("thinking ·", substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
    }

    @Test
    fun a_finished_reasoning_block_reads_as_thought() {
        val vm = ChatViewModel(
            FakeChatRepository(
                messages = listOf(ChatMessage("a1", Role.ASSISTANT, 5, listOf(ChatPart.Reasoning("weighed it", 2_000)))),
            ),
            "s1", "T", "jep", "opencode",
        )
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitUntil(6_000) { rule.onAllNodesWithText("Thought for 2s").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithText("Thought for 2s").assertExists()
    }

    /** Compact is harness-declared: the row shows for opencode and acts once. */
    @Test
    fun the_hamburger_menu_offers_compact_where_the_harness_can() {
        val repo = FakeChatRepository(
            messages = listOf(ChatMessage("a1", Role.ASSISTANT, 1, listOf(ChatPart.Text("hello there")))),
            harness = HarnessSettings(canCompact = true),
        )
        val vm = ChatViewModel(repo, "s1", "T", "jep", "opencode")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitUntil(5_000) { rule.onAllNodesWithText("hello there", substring = true).fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithContentDescription("chat menu").performClick()
        rule.onNodeWithText("Compact").assertExists()
        rule.onNodeWithText("Compact").performClick()
        rule.waitUntil(5_000) { repo.compacted }
        assertEquals(true, repo.compacted)
    }

    /** the banner is read-when-read: an X closes it, nothing buries it on a timer */
    @Test
    fun the_info_banner_has_a_dismiss_button() {
        val repo = FakeChatRepository(
            messages = listOf(ChatMessage("a1", Role.ASSISTANT, 1, listOf(ChatPart.Text("hello there")))),
            harness = HarnessSettings(canCompact = true),
        ).apply {
            compactAnswer = false
        }
        val vm = ChatViewModel(repo, "s1", "T", "jep", "opencode")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitUntil(5_000) { rule.onAllNodesWithText("hello there", substring = true).fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithContentDescription("chat menu").performClick()
        rule.onNodeWithText("Compact").performClick()
        rule.waitUntil(5_000) { rule.onAllNodesWithText("the harness refused to compact").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithContentDescription("dismiss").performClick()
        rule.waitUntil(5_000) { rule.onAllNodesWithText("the harness refused to compact").fetchSemanticsNodes().isEmpty() }
    }

    /** compaction is visible while it runs, not only reported after the fact */
    @Test
    fun compacting_shows_a_progress_banner_until_it_settles() {
        val repo = FakeChatRepository(
            messages = listOf(ChatMessage("a1", Role.ASSISTANT, 1, listOf(ChatPart.Text("hello there")))),
            harness = HarnessSettings(canCompact = true),
        ).apply {
            compactDelayMs = 4_000
        }
        val vm = ChatViewModel(repo, "s1", "T", "jep", "opencode")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitUntil(5_000) { rule.onAllNodesWithText("hello there", substring = true).fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithContentDescription("chat menu").performClick()
        rule.onNodeWithText("Compact").performClick()
        // the menu closes on tap; the banner survives it
        rule.waitUntil(5_000) { rule.onAllNodesWithText("Compacting…").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithText("Compacting…").assertExists()
        rule.waitUntil(8_000) { rule.onAllNodesWithText("conversation compacted").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithText("Compacting…").assertDoesNotExist()
    }

    @Test
    fun a_jump_to_latest_button_appears_once_scrolled_up() {
        val vm = ChatViewModel(FakeChatRepository(messages = manyMessages(100)), "s1", "T")

        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitUntil(10_000) {
            rule.onAllNodesWithText("message number 100", substring = true).fetchSemanticsNodes().isNotEmpty() &&
                rule.onAllNodesWithTag("positioning-overlay").fetchSemanticsNodes().isEmpty()
        }
        // at the bottom there is nothing to jump to
        rule.onAllNodesWithContentDescription("jump to latest").assertCountEquals(0)
        repeat(4) { rule.onNodeWithTag("chat-list").performTouchInput { swipeDown() } }
        rule.waitForIdle()
        rule.waitUntil(5_000) {
            rule.onAllNodesWithContentDescription("jump to latest").fetchSemanticsNodes().isNotEmpty()
        }
        rule.onNodeWithContentDescription("jump to latest").performClick()
        rule.waitUntil(5_000) {
            rule.onAllNodesWithContentDescription("jump to latest").fetchSemanticsNodes().isEmpty()
        }
        rule.onNodeWithText("message number 100", substring = true).assertIsDisplayed()
    }

    @Test
    fun a_jump_button_hides_after_idle_and_returns_on_scroll() {
        val vm = ChatViewModel(FakeChatRepository(messages = manyMessages(30)), "s1", "T")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitUntil(10_000) {
            rule.onAllNodesWithText("message number 30", substring = true).fetchSemanticsNodes().isNotEmpty() &&
                rule.onAllNodesWithTag("positioning-overlay").fetchSemanticsNodes().isEmpty()
        }
        repeat(4) { rule.onNodeWithTag("chat-list").performTouchInput { swipeDown() } }
        rule.waitUntil(5_000) {
            rule.onAllNodesWithContentDescription("jump to latest").fetchSemanticsNodes().isNotEmpty()
        }
        rule.mainClock.advanceTimeBy(3_000)
        rule.waitUntil(5_000) {
            rule.onAllNodesWithContentDescription("jump to latest").fetchSemanticsNodes().isEmpty()
        }
        repeat(4) { rule.onNodeWithTag("chat-list").performTouchInput { swipeUp() } }
        rule.waitUntil(5_000) {
            rule.onAllNodesWithContentDescription("jump to latest").fetchSemanticsNodes().isEmpty()
        }
        rule.onNodeWithTag("chat-list").performTouchInput { swipeDown() }
        rule.waitUntil(5_000) {
            rule.onAllNodesWithContentDescription("jump to latest").fetchSemanticsNodes().isNotEmpty()
        }
    }

    @Test
    fun a_streamed_message_never_raises_the_jump_button_for_a_reader_still_at_the_end() {
        // Every streamed part re-runs the pin-to-end animation, which is a
        // programmatic scroll. The jump button used to answer it as if the
        // reader had left the end and flashed on every delta — and a reader who
        // never drags should never see it at all, however "not at the bottom"
        // the moment is between a part landing and the pin catching up.
        val repo = FakeChatRepository()
        val vm = ChatViewModel(repo, "s1", "T", "jep", "opencode")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitForIdle()
        for (part in listOf("one ", "two ", "three ", "four ")) {
            rule.runOnUiThread { repo.emitEvent(ChatEvent.TextDelta("s1", "a1", "p1", "text", part)) }
            rule.waitUntil(5_000) {
                rule.onAllNodesWithText(part.trim(), substring = true, useUnmergedTree = true)
                    .fetchSemanticsNodes().isNotEmpty()
            }
            // sample right as the delta lands, while the pin is still catching up
            assertTrue(
                "jump button flashed while streaming (after '${part.trim()}')",
                rule.onAllNodesWithContentDescription("jump to latest").fetchSemanticsNodes().isEmpty(),
            )
        }
    }

    @Test
    fun reaching_the_top_loads_older_messages_before_the_current_page() {
        val older = listOf(
            ChatMessage("old-1", Role.ASSISTANT, -2, listOf(ChatPart.Text("older message one"))),
            ChatMessage("old-2", Role.ASSISTANT, -1, listOf(ChatPart.Text("older message two"))),
        )
        val vm = ChatViewModel(
            FakeChatRepository(messages = manyMessages(30), olderMessages = older),
            "s1", "T", "jep", "opencode",
        )
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitUntil(10_000) {
            rule.onAllNodesWithText("message number 30", substring = true).fetchSemanticsNodes().isNotEmpty() &&
                rule.onAllNodesWithTag("positioning-overlay").fetchSemanticsNodes().isEmpty()
        }
        repeat(6) { rule.onNodeWithTag("chat-list").performTouchInput { swipeDown() } }
        rule.waitUntil(10_000) { vm.state.value.messages.size == 32 }
        rule.waitUntil(5_000) {
            rule.onAllNodesWithText("older message one", substring = true).fetchSemanticsNodes().isNotEmpty()
        }
        val first = rule.onNodeWithText("older message one", substring = true).fetchSemanticsNode().boundsInRoot.top
        val second = rule.onNodeWithText("older message two", substring = true).fetchSemanticsNode().boundsInRoot.top
        assertTrue("older page rows retain their chronological order", first < second)
    }

    /** opencode writes the compaction marker before its summarize reply; the line belongs below the reply. */
    @Test
    fun a_compaction_marker_renders_below_its_summary_response() {
        val repo = FakeChatRepository(
            messages = listOf(
                ChatMessage("sm", Role.ASSISTANT, 40, listOf(ChatPart.Text("Objective: the folded summary"))),
                ChatMessage("mk", Role.USER, 30, listOf(ChatPart.Compaction)),
                ChatMessage("old", Role.ASSISTANT, 10, listOf(ChatPart.Text("old answer"))),
            ),
        )
        val vm = ChatViewModel(repo, "s1", "T")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitUntil(5_000) { rule.onAllNodesWithText("compaction complete").fetchSemanticsNodes().isNotEmpty() }
        val line = rule.onNodeWithText("compaction complete").fetchSemanticsNode().boundsInRoot.top
        val summary = rule.onNodeWithText("Objective: the folded summary", substring = true).fetchSemanticsNode().boundsInRoot.top
        val old = rule.onNodeWithText("old answer", substring = true).fetchSemanticsNode().boundsInRoot.top
        assertTrue("the line sits below the summary it follows", line > summary)
        assertTrue("the line sits above the old history", line > old)
    }

    @Test
    fun a_new_reply_keeps_a_reader_pinned_to_the_end() {
        val repo = FakeChatRepository(messages = manyMessages(30))
        val vm = ChatViewModel(repo, "s1", "T", "jep", "opencode")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitUntil(10_000) {
            rule.onAllNodesWithText("message number 30", substring = true).fetchSemanticsNodes().isNotEmpty() &&
                rule.onAllNodesWithTag("positioning-overlay").fetchSemanticsNodes().isEmpty()
        }
        rule.runOnUiThread {
            repo.emitEvent(ChatEvent.TextDelta("s1", "a-new", "p1", "text", "new live reply"))
        }
        rule.waitUntil(10_000) {
            rule.onAllNodesWithText("new live reply", substring = true).fetchSemanticsNodes().isNotEmpty()
        }
        rule.onNodeWithText("new live reply", substring = true).assertIsDisplayed()
        rule.onAllNodesWithContentDescription("jump to latest").assertCountEquals(0)
    }

    @Test
    fun a_new_reply_does_not_pull_a_reader_out_of_history() {
        val repo = FakeChatRepository(messages = manyMessages(30))
        val vm = ChatViewModel(repo, "s1", "T", "jep", "opencode")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitUntil(10_000) {
            rule.onAllNodesWithText("message number 30", substring = true).fetchSemanticsNodes().isNotEmpty() &&
                rule.onAllNodesWithTag("positioning-overlay").fetchSemanticsNodes().isEmpty()
        }
        repeat(4) { rule.onNodeWithTag("chat-list").performTouchInput { swipeDown(durationMillis = 60L) } }
        rule.runOnUiThread {
            repo.emitEvent(ChatEvent.TextDelta("s1", "a-new", "p1", "text", "reply while reading history"))
        }
        rule.waitUntil(10_000) {
            vm.state.value.live != null &&
                rule.onAllNodesWithContentDescription("jump to latest").fetchSemanticsNodes().isNotEmpty()
        }
        rule.onNodeWithContentDescription("jump to latest").assertExists()
        rule.onAllNodesWithText("reply while reading history", substring = true).assertCountEquals(0)
    }

    @Test
    fun swiping_a_message_arms_a_reply() {
        val turn = ChatMessage("m1", Role.ASSISTANT, 1, listOf(ChatPart.Text("hello there")))
        val vm = ChatViewModel(FakeChatRepository(messages = listOf(turn)), "s1", "T")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitUntil(5_000) {
            rule.onAllNodesWithText("hello there", substring = true).fetchSemanticsNodes().isNotEmpty()
        }
        rule.onNodeWithText("hello there", substring = true).performTouchInput { swipeRight() }
        rule.waitForIdle()
        rule.waitUntil(3_000) {
            rule.onAllNodesWithContentDescription("cancel reply").fetchSemanticsNodes().isNotEmpty()
        }
    }

    @Test
    fun a_reply_offers_info_and_copy() {
        val turn = ChatMessage(
            id = "m1",
            role = Role.ASSISTANT,
            time = 1,
            parts = listOf(ChatPart.Text("hi")),
            model = "opencode/big-pickle",
        )
        val vm = ChatViewModel(FakeChatRepository(messages = listOf(turn)), "s1", "T")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitUntil(5_000) {
            rule.onAllNodesWithContentDescription("copy response").fetchSemanticsNodes().isNotEmpty()
        }
        rule.onNodeWithContentDescription("copy response").assertExists()
        rule.onNodeWithContentDescription("response info").assertExists()
    }

    @Test
    fun a_response_info_button_opens_the_detail_dialog() {
        val turn = ChatMessage(
            id = "m1",
            role = Role.ASSISTANT,
            time = 1,
            parts = listOf(ChatPart.Text("hi")),
            model = "opencode/big-pickle",
            cost = 0.01,
            tokens = TokenUsage(input = 10, output = 5, reasoning = 2, cacheRead = 1, cacheWrite = 0),
        )
        val vm = ChatViewModel(FakeChatRepository(messages = listOf(turn)), "s1", "T")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitUntil(5_000) {
            rule.onAllNodesWithContentDescription("response info").fetchSemanticsNodes().isNotEmpty()
        }
        rule.onNodeWithContentDescription("response info").performClick()
        rule.onNodeWithText("This reply").assertExists()
        rule.onNodeWithText("big-pickle").assertExists()
        rule.onNodeWithText("Output").assertExists()
    }

    @Test
    fun a_tool_row_expands_to_reveal_its_output() {
        val turn = ChatMessage(
            id = "m1",
            role = Role.ASSISTANT,
            time = 1,
            parts = listOf(ChatPart.Tool("t1", "bash", ToolStatus.COMPLETED, "ls -la", null, "total 0\nfile.txt")),
        )
        val vm = ChatViewModel(FakeChatRepository(messages = listOf(turn)), "s1", "T")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitUntil(5_000) {
            rule.onAllNodesWithText("Ran a command").fetchSemanticsNodes().isNotEmpty()
        }
        rule.onNodeWithText("Ran a command").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("total 0\nfile.txt", substring = true).assertExists()
    }

    @Test
    fun a_running_tool_does_not_expand_on_its_own() {
        // A running tool used to auto-open and then collapse when it finished,
        // jittering the list. It must stay a quiet line until asked, running or
        // not.
        val vm = ChatViewModel(
            FakeChatRepository(
                messages = listOf(
                    ChatMessage(
                        "a1", Role.ASSISTANT, 5,
                        listOf(ChatPart.Tool("t1", "bash", ToolStatus.RUNNING, "ls -la", null, "partial output")),
                    ),
                ),
            ),
            "s1", "T", "jep", "opencode",
        )
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitUntil(6_000) { rule.onAllNodesWithText("Ran a command").fetchSemanticsNodes().isNotEmpty() }
        rule.onAllNodesWithText("partial output", substring = true).assertCountEquals(0)
        rule.onNodeWithText("Ran a command").performClick()
        rule.waitUntil(4_000) {
            rule.onAllNodesWithText("partial output", substring = true).fetchSemanticsNodes().isNotEmpty()
        }
    }

    @Test
    fun tapping_a_thinking_block_collapses_it_again() {
        // The whole block is the tap target now, not only its header: once it had
        // grown, collapsing meant scrolling back up to the header.
        val vm = ChatViewModel(
            FakeChatRepository(
                messages = listOf(ChatMessage("a1", Role.ASSISTANT, 5, listOf(ChatPart.Reasoning("because reasons", 2_000)))),
            ),
            "s1", "T", "jep", "opencode",
        )
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitUntil(6_000) { rule.onAllNodesWithText("Thought for 2s").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithText("Thought for 2s").performClick()
        rule.waitUntil(4_000) { rule.onAllNodesWithText("because reasons", substring = true).fetchSemanticsNodes().isNotEmpty() }
        // tapping the body itself, not the header, must collapse it
        rule.onNodeWithText("because reasons", substring = true).performClick()
        rule.waitUntil(4_000) { rule.onAllNodesWithText("because reasons", substring = true).fetchSemanticsNodes().isEmpty() }
    }

    @Test
    fun the_reply_sheet_shows_model_duration_and_time() {
        val vm = ChatViewModel(
            FakeChatRepository(
                messages = listOf(
                    ChatMessage(
                        "a1", Role.ASSISTANT, 1, listOf(ChatPart.Text("hi")),
                        model = "opencode-go/deepseek-v4.1-flash",
                        cost = 0.01,
                        tokens = TokenUsage(input = 10, output = 5, reasoning = 2, cacheRead = 1, cacheWrite = 0),
                        durationMs = 3_400,
                    ),
                ),
            ),
            "s1", "T",
        )
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitUntil(5_000) { rule.onAllNodesWithContentDescription("response info").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithContentDescription("response info").performClick()
        rule.onNodeWithText("deepseek-v4.1-flash").assertExists()
        rule.onNodeWithText("Took").assertExists()
        rule.onNodeWithText("3.4s").assertExists()
        rule.onNodeWithText("Time").assertExists()
    }

    @Test
    fun a_tool_note_is_shown_without_its_markup() {
        val vm = ChatViewModel(
            FakeChatRepository(
                messages = listOf(
                    ChatMessage(
                        "a1", Role.ASSISTANT, 5,
                        listOf(
                            ChatPart.Tool(
                                "t1", "bash", ToolStatus.ERROR, "slow-thing", null,
                                "(no output)\n<shell_metadata>\nUser aborted the command\n</shell_metadata>",
                            ),
                        ),
                    ),
                ),
            ),
            "s1", "T", "jep", "opencode",
        )
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitUntil(6_000) { rule.onAllNodesWithText("Ran a command").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithText("Ran a command").performClick()
        rule.waitUntil(4_000) {
            rule.onAllNodesWithText("User aborted the command", substring = true).fetchSemanticsNodes().isNotEmpty()
        }
        rule.onAllNodesWithText("shell_metadata", substring = true).assertCountEquals(0)
    }

    @Test
    fun a_message_sent_while_busy_is_queued_with_an_hourglass() {
        val repo = FakeChatRepository()
        val gate = kotlinx.coroutines.CompletableDeferred<Unit>()
        repo.promptGate = gate
        val vm = ChatViewModel(repo, "s1", "T", "jep", "opencode")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitForIdle()
        rule.runOnUiThread { vm.send("first") }
        rule.waitUntil(5_000) { vm.state.value.sending }
        // sent while the turn is in flight: held and marked queued, not refused
        rule.runOnUiThread { vm.send("second while busy") }
        rule.waitUntil(5_000) { vm.state.value.queued.size == 1 }
        rule.onNodeWithContentDescription("steers in at the next tool call").assertExists()
        rule.onNodeWithText("second while busy").assertExists()
        // tapping it offers edit / send now / cancel
        rule.onNodeWithText("second while busy").performClick()
        rule.waitUntil(4_000) { rule.onAllNodesWithText("Send now").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithText("Edit").assertExists()
        // cancel asks first
        rule.onNodeWithText("Cancel").performClick()
        rule.waitUntil(4_000) { rule.onAllNodesWithText("Cancel this message?").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithText("Cancel it").performClick()
        rule.waitUntil(5_000) { vm.state.value.queued.isEmpty() }
        gate.complete(Unit)
    }

    @Test
    fun holding_send_while_busy_offers_every_way_in_and_marks_the_choice() {
        val repo = FakeChatRepository()
        val gate = kotlinx.coroutines.CompletableDeferred<Unit>()
        repo.promptGate = gate
        val vm = ChatViewModel(repo, "s1", "T", "jep", "opencode")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitForIdle()
        rule.runOnUiThread { vm.send("first") }
        rule.waitUntil(5_000) { vm.state.value.sending }
        rule.runOnUiThread { vm.setDraft("held for later") }
        rule.onNodeWithTag("send-button").performTouchInput { longClick() }
        rule.waitUntil(4_000) { rule.onAllNodesWithText("Send how?").fetchSemanticsNodes().isNotEmpty() }
        // all three, in one place
        rule.onNodeWithText("Steer in").assertExists()
        rule.onNodeWithText("Send now").assertExists()
        rule.onNodeWithText("After this reply").performClick()
        rule.waitUntil(5_000) { vm.state.value.queued.size == 1 }
        assertEquals(SendMode.AFTER_REPLY, vm.state.value.queued.single().mode)
        rule.waitUntil(5_000) { repo.modes.size == 2 }
        assertEquals(SendMode.AFTER_REPLY, repo.modes.last())
        // it says what it waits for, and it is not the steer's mark
        rule.onNodeWithText("sends after this reply").assertExists()
        rule.onAllNodesWithText("steers in at the next tool call").assertCountEquals(0)
        // a plain tap still steers, and the two read differently side by side
        rule.runOnUiThread { vm.send("steer this") }
        rule.waitUntil(5_000) { vm.state.value.queued.size == 2 }
        rule.onNodeWithText("steers in at the next tool call").assertExists()
        gate.complete(Unit)
    }

    @Test
    fun holding_send_with_nothing_running_just_sends() {
        val repo = FakeChatRepository()
        val vm = ChatViewModel(repo, "s1", "T", "jep", "opencode")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitForIdle()
        rule.runOnUiThread { vm.setDraft("idle hold") }
        rule.onNodeWithTag("send-button").performTouchInput { longClick() }
        rule.waitUntil(5_000) { repo.prompts.contains("idle hold") }
        rule.onAllNodesWithText("Send how?").assertCountEquals(0)
    }

    @Test
    fun queued_messages_remain_in_send_order_at_the_end_of_the_forward_list() {
        val repo = FakeChatRepository()
        val gate = kotlinx.coroutines.CompletableDeferred<Unit>()
        repo.promptGate = gate
        val vm = ChatViewModel(repo, "s1", "T", "jep", "opencode")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitForIdle()
        rule.runOnUiThread { vm.send("first") }
        rule.waitUntil(5_000) { vm.state.value.sending }
        rule.runOnUiThread {
            vm.send("queued one")
            vm.send("queued two")
        }
        rule.waitUntil(5_000) { vm.state.value.queued.size == 2 }
        val one = rule.onNodeWithText("queued one").fetchSemanticsNode().boundsInRoot.top
        val two = rule.onNodeWithText("queued two").fetchSemanticsNode().boundsInRoot.top
        assertTrue("the queue follows send order from top to bottom", one < two)
        gate.complete(Unit)
    }

    @Test
    fun a_queued_message_survives_the_same_words_being_sent_before() {
        // The queued bubble clears when its message shows in the record. Matching
        // by text alone cleared it at once when the same words had ever been sent
        // before — the bug the first queue test missed.
        val repo = FakeChatRepository(
            messages = listOf(ChatMessage("u0", Role.USER, 1, listOf(ChatPart.Text("hello")))),
        )
        val gate = kotlinx.coroutines.CompletableDeferred<Unit>()
        repo.promptGate = gate
        val vm = ChatViewModel(repo, "s1", "T", "jep", "opencode")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitUntil(5_000) { rule.onAllNodesWithText("hello").fetchSemanticsNodes().isNotEmpty() }
        rule.runOnUiThread { vm.send("first") }
        rule.waitUntil(5_000) { vm.state.value.sending }
        rule.runOnUiThread { vm.send("hello") }
        rule.waitUntil(5_000) { vm.state.value.queued.size == 1 }
        rule.waitForIdle()
        rule.onNodeWithContentDescription("steers in at the next tool call").assertExists()
        gate.complete(Unit)
    }

    /**
     * A collapsed tool run must line up with the call rows beside it.
     *
     * A tool row is rendered inside a message, which supplies the transcript's
     * inset. A collapsed run is a row in its own right and was rendered without
     * one, so it sat flush left against inset rows and read as misaligned — the
     * one thing a folded row must never look like. Every JVM test in this project
     * passes straight through that: none of them lay a row out.
     */
    @Test
    fun a_collapsed_tool_run_lines_up_with_the_call_rows_beside_it() {
        fun read(file: String) = ChatPart.Tool(id = "t-$file", name = "read", status = null, title = "src/$file")
        val messages = listOf(
            // a message that says something and calls a tool: rendered as a
            // message, with the call row inside it
            ChatMessage("a1", Role.ASSISTANT, 10, listOf(ChatPart.Text("Thought for 3s"), read("agents.ts"))),
            // three that carry nothing but the call and a step marker: these group
            ChatMessage("b1", Role.ASSISTANT, 20, listOf(ChatPart.Unsupported("step-finish"), read("one.ts"))),
            ChatMessage("b2", Role.ASSISTANT, 21, listOf(ChatPart.Unsupported("step-finish"), read("two.ts"))),
            ChatMessage("b3", Role.ASSISTANT, 22, listOf(ChatPart.Unsupported("step-finish"), read("three.ts"))),
        )
        val vm = ChatViewModel(FakeChatRepository(messages = messages), "s1", "T", "jep", "opencode")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitUntil(10_000) {
            rule.onAllNodesWithText("Read 3 files").fetchSemanticsNodes().isNotEmpty() &&
                rule.onAllNodesWithTag("positioning-overlay").fetchSemanticsNodes().isEmpty()
        }
        val grouped = rule.onNodeWithText("Read 3 files").fetchSemanticsNode().boundsInRoot
        val single = rule.onNodeWithText("Read agents.ts").fetchSemanticsNode().boundsInRoot
        assertEquals(
            "a folded run must share the transcript's inset",
            single.left,
            grouped.left,
            1f,
        )
    }

    /** The folded calls open below their header and push later messages down. */
    @Test
    fun opening_a_tool_group_keeps_its_header_and_pushes_later_content_down() {
        fun read(file: String) = ChatPart.Tool(id = "t-$file", name = "read", status = null, title = "src/$file")
        val messages = listOf(
            ChatMessage(
                "a1", Role.ASSISTANT, 10,
                listOf(
                    ChatPart.Text("before block"),
                    read("one.ts"), read("two.ts"), read("three.ts"),
                ),
            ),
            ChatMessage("a2", Role.ASSISTANT, 20, listOf(ChatPart.Text("later content"))),
        )
        val vm = ChatViewModel(FakeChatRepository(messages = messages), "s1", "T", "jep", "opencode")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitUntil(10_000) {
            rule.onAllNodesWithText("Read 3 files").fetchSemanticsNodes().isNotEmpty()
        }
        val before = rule.onNodeWithText("Read 3 files").fetchSemanticsNode().boundsInRoot.top
        val earlierBefore = rule.onNodeWithText("before block", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot.top
        val laterBefore = rule.onNodeWithTag("message-row-a2").fetchSemanticsNode().boundsInRoot.top
        rule.onNodeWithText("Read 3 files").performClick()
        rule.waitUntil(10_000) {
            rule.onAllNodesWithText("Read one.ts").fetchSemanticsNodes().isNotEmpty()
        }
        val after = rule.onNodeWithText("Read 3 files").fetchSemanticsNode().boundsInRoot.top
        val earlierAfter = rule.onNodeWithText("before block", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot.top
        val laterAfter = rule.onNodeWithTag("message-row-a2").fetchSemanticsNode().boundsInRoot.top
        assertEquals("the tapped header stays put", before, after, 2f)
        assertEquals("content above stays put", earlierBefore, earlierAfter, 2f)
        assertTrue("later content is pushed down", laterAfter > laterBefore)
    }

    @Test
    fun opening_a_finished_thought_pushes_later_content_down() {
        val message = ChatMessage(
            "a-thought", Role.ASSISTANT, 10,
            listOf(
                ChatPart.Text("before thought"),
                ChatPart.Reasoning("the hidden explanation", 3_000),
                ChatPart.Text("after thought"),
            ),
        )
        val vm = ChatViewModel(FakeChatRepository(messages = listOf(message)), "s1", "T", "jep", "opencode")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitUntil(10_000) {
            rule.onAllNodesWithText("Thought for 3s").fetchSemanticsNodes().isNotEmpty() &&
                rule.onAllNodesWithTag("positioning-overlay").fetchSemanticsNodes().isEmpty()
        }
        val headerBefore = rule.onNodeWithText("Thought for 3s").fetchSemanticsNode().boundsInRoot.top
        val earlierBefore = rule.onNodeWithText("before thought", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot.top
        val laterBefore = rule.onNodeWithText("after thought", substring = true, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot.top
        rule.onNodeWithText("Thought for 3s").performClick()
        rule.waitUntil(10_000) {
            rule.onAllNodesWithText("the hidden explanation", substring = true).fetchSemanticsNodes().isNotEmpty()
        }
        rule.mainClock.advanceTimeBy(1_000)
        val headerAfter = rule.onNodeWithText("Thought for 3s").fetchSemanticsNode().boundsInRoot.top
        val earlierAfter = rule.onNodeWithText("before thought", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot.top
        val laterAfter = rule.onNodeWithText("after thought", substring = true, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot.top
        assertEquals("the thought header stays put", headerBefore, headerAfter, 2f)
        assertEquals("content above stays put", earlierBefore, earlierAfter, 2f)
        assertTrue("content below the thought moves down", laterAfter > laterBefore)
    }
    // Settings moved from an AlertDialog to a bottom sheet so the harness's own
    // controls had somewhere to live. The section is generic: the phone renders
    // whatever the adapter declares and knows none of the ids, so this drives a
    // fake harness option end to end — menu, sheet, switch, repository.
    @Test
    fun settings_sheet_shows_the_harness_controls_and_writes_them_back() {
        val repo = FakeChatRepository(
            harness = HarnessSettings(
                options = listOf(
                    HarnessSetting(
                        id = "dangerouslySkipPermissions",
                        label = "Skip permission prompts",
                        description = "Tool use does not stop for approval.",
                        default = false,
                        danger = true,
                    ),
                ),
                values = mapOf("dangerouslySkipPermissions" to false),
            ),
        )
        val vm = ChatViewModel(repo, "s1", "T", "jep", "claude")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitForIdle()

        rule.onNodeWithContentDescription("chat menu").performClick()
        rule.onNodeWithText("Settings").performClick()
        // the sheet, not a dialog: it carries its own close affordance
        rule.waitUntil(10_000) {
            rule.onAllNodesWithContentDescription("close settings").fetchSemanticsNodes().isNotEmpty()
        }
        // the adapter-declared control is rendered by label, never by id
        rule.waitUntil(10_000) {
            rule.onAllNodesWithText("Skip permission prompts").fetchSemanticsNodes().isNotEmpty()
        }
        rule.onNodeWithText("Skip permission prompts").assertIsDisplayed()

        // and flipping it reaches the port
        rule.onNodeWithText("Skip permission prompts").performClick()
        rule.waitUntil(10_000) { repo.harnessWrites.isNotEmpty() }
        assertEquals(listOf("dangerouslySkipPermissions" to true), repo.harnessWrites.toList())
    }


    private fun bash(id: String, title: String, messageId: String? = null, at: Long? = null) =
        dev.jep.client.domain.model.Ask(
            id = id,
            title = title,
            options = listOf(
                dev.jep.client.domain.model.AskOption("once", "Allow once"),
                dev.jep.client.domain.model.AskOption("reject", "Deny", danger = true),
            ),
            messageId = messageId,
            at = at,
        )

    @Test
    fun a_card_out_of_view_is_announced_above_the_composer_and_jumps_to_it() {
        // A turn parked on a card above the fold looked hung: no spinner, Send
        // withheld, nothing in view to say why. Opening the chat later also has
        // to find the card at all, which only the gateway's ask record can say.
        val repo = FakeChatRepository(
            messages = manyMessages(60),
            asks = listOf(dev.jep.client.domain.model.AskEntry(bash("a1", "far-up-ask", messageId = "m5", at = 5), pending = true)),
        )
        val vm = ChatViewModel(repo, "s1", "T")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitUntil(10_000) { rule.onAllNodesWithTag("waiting-for-you").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithText("Waiting for your approval").assertIsDisplayed()
        rule.onNodeWithTag("waiting-for-you").performClick()
        rule.waitUntil(5_000) { rule.onAllNodesWithText("far-up-ask").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithText("far-up-ask").assertIsDisplayed()
        rule.waitUntil(5_000) { rule.onAllNodesWithTag("waiting-for-you").fetchSemanticsNodes().isEmpty() }
    }

    @Test
    fun a_card_replaced_by_the_next_ask_stays_in_the_transcript() {
        val repo = FakeChatRepository(messages = manyMessages(3))
        val vm = ChatViewModel(repo, "s1", "T")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitUntil(5_000) { repo.subscribed && vm.state.value.messages.isNotEmpty() }
        rule.runOnUiThread { repo.emitEvent(ChatEvent.Asked("s1", bash("a1", "first-ask", messageId = "m2", at = 2))) }
        rule.waitUntil(5_000) { rule.onAllNodesWithText("first-ask").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithText("Allow once").performClick()
        rule.waitUntil(5_000) { vm.state.value.askChoice == "once" }
        rule.runOnUiThread { repo.emitEvent(ChatEvent.Asked("s1", bash("a2", "second-ask", messageId = "m3", at = 3))) }
        rule.waitUntil(5_000) { rule.onAllNodesWithText("second-ask").fetchSemanticsNodes().isNotEmpty() }
        // the first card is the record now: still there, its answer still filled
        rule.onNodeWithText("first-ask").assertIsDisplayed()
        rule.onNodeWithContentDescription("Allow once, chosen").assertIsDisplayed()
    }

    @Test
    fun a_card_settled_elsewhere_stops_holding_the_composer() {
        val repo = FakeChatRepository(messages = manyMessages(3))
        val vm = ChatViewModel(repo, "s1", "T")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitUntil(5_000) { repo.subscribed && vm.state.value.messages.isNotEmpty() }
        rule.runOnUiThread { repo.emitEvent(ChatEvent.Asked("s1", bash("a1", "elsewhere-ask", messageId = "m3", at = 3))) }
        rule.waitUntil(5_000) { vm.state.value.ask?.id == "a1" }
        rule.runOnUiThread { repo.emitEvent(ChatEvent.AskResolved("s1", "a1")) }
        rule.waitUntil(5_000) { vm.state.value.ask == null }
        // the open slot is free (Send is back), and the card stays as the record
        rule.onNodeWithText("elsewhere-ask").assertIsDisplayed()
        assertEquals(listOf("a1"), vm.state.value.pastAsks.map { it.ask.id })
    }

    @Test
    fun a_long_message_opens_a_full_screen_editor_with_its_controls_together() {
        val repo = FakeChatRepository(messages = manyMessages(3))
        val vm = ChatViewModel(repo, "s1", "T")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitForIdle()
        // a short message has nothing to expand
        rule.onAllNodesWithContentDescription("expand the composer").assertCountEquals(0)
        rule.runOnUiThread { vm.setDraft("first line\nsecond line\nthird line") }
        rule.waitUntil(5_000) { rule.onAllNodesWithContentDescription("expand the composer").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithContentDescription("expand the composer").performClick()
        rule.waitUntil(5_000) { rule.onAllNodesWithTag("full-composer").fetchSemanticsNodes().isNotEmpty() }
        // the words carried over, and send sits in the editor's own bar
        rule.onNodeWithTag("full-composer-text").assertIsDisplayed()
        rule.onAllNodesWithText("first line", substring = true).fetchSemanticsNodes().isNotEmpty().let { assertTrue(it) }
        rule.onNode(
            androidx.compose.ui.test.hasContentDescription("send") and
                androidx.compose.ui.test.hasAnyAncestor(androidx.compose.ui.test.hasTestTag("full-composer")),
        ).performClick()
        rule.waitUntil(5_000) { repo.prompts.any { it.startsWith("first line") } }
        rule.waitUntil(5_000) { rule.onAllNodesWithTag("full-composer").fetchSemanticsNodes().isEmpty() }
    }

    @Test
    fun send_now_on_a_queued_message_does_not_raise_the_keyboard() {
        val repo = FakeChatRepository()
        val gate = kotlinx.coroutines.CompletableDeferred<Unit>()
        repo.promptGate = gate
        val vm = ChatViewModel(repo, "s1", "T", "jep", "opencode")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitForIdle()
        rule.runOnUiThread { vm.send("first") }
        rule.waitUntil(5_000) { vm.state.value.sending }
        // typed into the composer, as a person does, so it holds focus
        rule.onNodeWithTag("composer").performClick()
        rule.onNodeWithTag("composer").assertIsFocused()
        rule.runOnUiThread { vm.send("second while busy") }
        rule.waitUntil(5_000) { vm.state.value.queued.size == 1 }
        rule.onNodeWithText("second while busy").performClick()
        rule.waitUntil(4_000) { rule.onAllNodesWithText("Send now").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithText("Send now").performClick()
        rule.waitForIdle()
        // the dialog must not hand focus back to the composer on its way out
        rule.onNodeWithTag("composer").assertIsNotFocused()
        gate.complete(Unit)
    }

    @Test
    fun a_conversation_continued_elsewhere_appears_without_a_new_message() {
        // The desktop answered in this conversation while the phone had it open.
        // Nothing was sent from here, so nothing polls: the daemon's
        // session.changed is what brings it in.
        val repo = FakeChatRepository(messages = manyMessages(2))
        val vm = ChatViewModel(repo, "s1", "T")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitUntil(5_000) { repo.subscribed && vm.state.value.messages.isNotEmpty() }
        repo.historyOverride = manyMessages(2) + ChatMessage("d1", Role.ASSISTANT, 10, listOf(ChatPart.Text("written on the desktop")))
        rule.runOnUiThread { repo.emitEvent(ChatEvent.Changed("s1")) }
        rule.waitUntil(5_000) { rule.onAllNodesWithText("written on the desktop").fetchSemanticsNodes().isNotEmpty() }
    }

    @Test
    fun no_compact_row_where_the_harness_cannot() {
        val repo = FakeChatRepository(messages = listOf(ChatMessage("a1", Role.ASSISTANT, 1, listOf(ChatPart.Text("hello there")))))
        val vm = ChatViewModel(repo, "s1", "T", "jep", "codex")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitUntil(5_000) { rule.onAllNodesWithText("hello there", substring = true).fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithContentDescription("chat menu").performClick()
        rule.onAllNodesWithText("Compact").assertCountEquals(0)
    }
}
