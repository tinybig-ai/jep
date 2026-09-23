package dev.jep.client

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.printToLog
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.test.swipeRight
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.jep.client.domain.model.ChatMessage
import dev.jep.client.domain.model.ChatPart
import dev.jep.client.domain.model.Role
import dev.jep.client.domain.repository.ChatEvent
import dev.jep.client.domain.model.TokenUsage
import dev.jep.client.domain.model.ToolStatus
import dev.jep.client.presentation.chat.ChatScreen
import dev.jep.client.presentation.chat.ChatViewModel
import org.junit.Assert.assertEquals
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
            rule.onAllNodesWithText("message number 30").fetchSemanticsNodes().isNotEmpty()
        }
        rule.onNodeWithText("message number 30").assertIsDisplayed()
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
        rule.waitForIdle()
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

    @Test
    fun a_jump_to_latest_button_appears_once_scrolled_up() {
        val vm = ChatViewModel(FakeChatRepository(messages = manyMessages(30)), "s1", "T")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitUntil(10_000) {
            rule.onAllNodesWithText("message number 30").fetchSemanticsNodes().isNotEmpty()
        }
        // at the bottom there is nothing to jump to
        rule.onAllNodesWithContentDescription("jump to latest").assertCountEquals(0)
        repeat(4) { rule.onNodeWithTag("chat-list").performTouchInput { swipeDown() } }
        rule.waitForIdle()
        rule.waitUntil(5_000) {
            rule.onAllNodesWithContentDescription("jump to latest").fetchSemanticsNodes().isNotEmpty()
        }
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
        rule.onNodeWithContentDescription("queued").assertExists()
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
}
