package dev.jep.client

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.jep.client.domain.repository.ChatEvent
import dev.jep.client.presentation.chat.ChatScreen
import dev.jep.client.presentation.chat.ChatViewModel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

// How an open conversation keeps up with the machine: the push feed, the
// history reads behind it, and the order the two leave the transcript in.
@RunWith(AndroidJUnit4::class)
class ChatSyncTest {

    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun a_dropped_feed_is_opened_again_and_the_reply_keeps_streaming() {
        val repo = FakeChatRepository()
        val vm = ChatViewModel(repo, "s1", "T")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitUntil(5_000) { repo.subscribed }
        // the daemon restarts, or the phone changes network
        rule.runOnUiThread { repo.emitEvent(ChatEvent.Lost) }
        rule.waitUntil(5_000) { repo.subscriptions == 2 && repo.subscribed }
        rule.runOnUiThread { repo.emitEvent(ChatEvent.TextDelta("s1", "a1", "p1", "text", "still here")) }
        rule.waitUntil(5_000) { rule.onAllNodesWithText("still here", substring = true).fetchSemanticsNodes().isNotEmpty() }
        assertFalse("the header still says reconnecting", vm.state.value.lost)
        assertEquals(0, rule.onAllNodesWithText("reconnecting", substring = true).fetchSemanticsNodes().size)
    }
}
