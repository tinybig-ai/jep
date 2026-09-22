package dev.jep.client

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
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
        rule.onNodeWithText("Generated").assertExists()
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
}
