package dev.jep.client

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.jep.client.domain.model.ChatMessage
import dev.jep.client.domain.model.ChatPart
import dev.jep.client.domain.model.Role
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
