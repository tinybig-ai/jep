package dev.jep.client

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.jep.client.domain.model.ChatMessage
import dev.jep.client.domain.model.ChatPart
import dev.jep.client.domain.model.Role
import dev.jep.client.domain.repository.ChatEvent
import kotlinx.coroutines.CompletableDeferred
import dev.jep.client.presentation.chat.ChatScreen
import dev.jep.client.presentation.chat.ChatViewModel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
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

    private val earlier = listOf(
        ChatMessage("u1", Role.USER, 1, listOf(ChatPart.Text("an older question"))),
        ChatMessage("a1", Role.ASSISTANT, 2, listOf(ChatPart.Text("an older answer"))),
    )

    private fun top(text: String) =
        rule.onNodeWithText(text, substring = true).fetchSemanticsNode().boundsInRoot.top

    private fun shown(text: String) =
        rule.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty()

    @Test
    fun a_message_being_sent_shows_under_the_conversation_not_above_it() {
        val repo = FakeChatRepository(messages = earlier)
        repo.promptGate = CompletableDeferred() // the turn stays in flight
        val vm = ChatViewModel(repo, "s1", "T")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitUntil(5_000) { shown("an older answer") }
        rule.runOnUiThread { vm.send("the newest words") }
        rule.waitUntil(5_000) { shown("the newest words") }
        assertTrue("the message being sent sits above the conversation", top("the newest words") > top("an older answer"))
        assertEquals("u1", vm.state.value.messages.last().id)
    }

    @Test
    fun a_reply_streaming_before_the_record_has_it_shows_at_the_end() {
        val repo = FakeChatRepository(messages = earlier)
        val vm = ChatViewModel(repo, "s1", "T")
        rule.setContent { ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitUntil(5_000) { shown("an older answer") && repo.subscribed }
        rule.runOnUiThread { repo.emitEvent(ChatEvent.TextDelta("s1", "a2", "p1", "text", "a fresh reply")) }
        rule.waitUntil(5_000) { shown("a fresh reply") }
        assertTrue("the live reply sits above the conversation", top("a fresh reply") > top("an older answer"))
    }

    @Test
    fun the_same_words_on_an_older_page_survive_a_newer_copy_in_the_window() {
        val repo = FakeChatRepository(
            messages = listOf(
                ChatMessage("u2", Role.USER, 10, listOf(ChatPart.Text("yes"))),
                ChatMessage("a2", Role.ASSISTANT, 11, listOf(ChatPart.Text("done again"))),
            ),
            olderMessages = listOf(
                ChatMessage("u1", Role.USER, 1, listOf(ChatPart.Text("yes"))),
                ChatMessage("a1", Role.ASSISTANT, 2, listOf(ChatPart.Text("done"))),
            ),
        )
        lateinit var vm: ChatViewModel
        rule.runOnUiThread { vm = ChatViewModel(repo, "s1", "T") }
        rule.waitUntil(5_000) { vm.state.value.hasMore }
        rule.runOnUiThread { vm.loadOlder() }
        rule.waitUntil(5_000) { vm.state.value.messages.size == 4 }
        rule.runOnUiThread { vm.refresh() }
        Thread.sleep(500)
        assertEquals(listOf("a2", "u2", "a1", "u1"), vm.state.value.messages.map { it.id })
    }

    @Test
    fun saying_the_same_words_again_shows_until_the_record_has_the_new_copy() {
        val old = ChatMessage("u1", Role.USER, 1, listOf(ChatPart.Text("yes")))
        val repo = FakeChatRepository(messages = listOf(old))
        repo.promptGate = CompletableDeferred()
        lateinit var vm: ChatViewModel
        rule.runOnUiThread { vm = ChatViewModel(repo, "s1", "T") }
        rule.waitUntil(5_000) { vm.state.value.messages.isNotEmpty() }
        rule.runOnUiThread { vm.send("yes") }
        rule.runOnUiThread { vm.refresh() }
        Thread.sleep(500)
        // the old "yes" is not the copy of the new one
        assertEquals(2, vm.state.value.messages.size)
        repo.historyOverride = listOf(old, ChatMessage("u2", Role.USER, 5, listOf(ChatPart.Text("yes"))))
        rule.runOnUiThread { vm.refresh() }
        rule.waitUntil(5_000) { vm.state.value.messages.map { it.id } == listOf("u2", "u1") }
    }

    @Test
    fun history_reads_during_a_turn_never_overlap_on_a_slow_link() {
        val repo = FakeChatRepository(messages = earlier)
        repo.promptGate = CompletableDeferred() // a turn in flight: the 1.2s poll runs
        lateinit var vm: ChatViewModel
        rule.runOnUiThread { vm = ChatViewModel(repo, "s1", "T") }
        rule.waitUntil(5_000) { vm.state.value.messages.isNotEmpty() }
        repo.historyDelayMs = 3_000 // each read outlasts two poll ticks
        rule.runOnUiThread { vm.send("go") }
        Thread.sleep(7_000)
        assertEquals("history reads in flight at once", 1, repo.historyMostAtOnce.get())
    }
}
