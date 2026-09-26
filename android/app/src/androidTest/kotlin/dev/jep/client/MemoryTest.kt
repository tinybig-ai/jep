package dev.jep.client

import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.jep.client.domain.model.ChatMessage
import dev.jep.client.domain.model.ChatPart
import dev.jep.client.domain.model.Role
import dev.jep.client.presentation.chat.ChatViewModel
import dev.jep.client.presentation.chat.ConversationMemory
import dev.jep.client.presentation.chat.SavedDraft
import dev.jep.client.presentation.chat.SavedSend
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

// Nothing typed or sent is lost with the process: the draft and the sends the
// daemon never took outlive the ViewModel that held them.
@RunWith(AndroidJUnit4::class)
class MemoryTest {

    private class InMemory : ConversationMemory {
        val drafts = mutableMapOf<String, SavedDraft>()
        val outboxes = mutableMapOf<String, List<SavedSend>>()
        override fun loadDraft(sessionId: String) = drafts[sessionId]
        override fun saveDraft(sessionId: String, draft: SavedDraft) { drafts[sessionId] = draft }
        override fun loadOutbox(sessionId: String) = outboxes[sessionId].orEmpty()
        override fun saveOutbox(sessionId: String, sends: List<SavedSend>) { outboxes[sessionId] = sends }
    }

    private fun waitFor(ms: Long = 5_000, cond: () -> Boolean) {
        val until = System.currentTimeMillis() + ms
        while (!cond()) {
            check(System.currentTimeMillis() < until) { "timed out" }
            Thread.sleep(20)
        }
    }

    private fun onMain(block: () -> Unit) =
        androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().runOnMainSync(block)

    @Test
    fun a_draft_outlives_the_view_model_that_held_it() {
        val memory = InMemory()
        onMain {
            val first = ChatViewModel(FakeChatRepository(), "s1", "T", memory = memory)
            first.setDraft("half a thought")
        }
        waitFor { memory.drafts["s1"]?.text == "half a thought" }
        var restored = ""
        onMain { restored = ChatViewModel(FakeChatRepository(), "s1", "T", memory = memory).state.value.draft }
        assertEquals("half a thought", restored)
    }

    @Test
    fun an_unsent_message_comes_back_and_goes_again_once_the_gateway_answers() {
        val memory = InMemory()
        memory.outboxes["s1"] = listOf(SavedSend("local-1", "never got there", time = 5))
        val repo = FakeChatRepository()
        lateinit var vm: ChatViewModel
        onMain { vm = ChatViewModel(repo, "s1", "T", memory = memory) }
        waitFor { repo.prompts.contains("never got there") }
        waitFor { memory.outboxes["s1"].isNullOrEmpty() }
        assertEquals(1, repo.prompts.count { it == "never got there" })
    }

    @Test
    fun a_send_the_daemon_did_take_is_never_sent_twice() {
        val memory = InMemory()
        memory.outboxes["s1"] = listOf(SavedSend("local-1", "it did arrive", time = 5))
        // the record has it: the connection dropped after the daemon took it
        val repo = FakeChatRepository(
            messages = listOf(ChatMessage("u1", Role.USER, 6, listOf(ChatPart.Text("it did arrive")))),
        )
        lateinit var vm: ChatViewModel
        onMain { vm = ChatViewModel(repo, "s1", "T", memory = memory) }
        waitFor { memory.outboxes["s1"]?.isEmpty() == true }
        Thread.sleep(300)
        assertTrue("the record's copy is proof enough", repo.prompts.isEmpty())
        assertEquals(1, vm.state.value.messages.count { m -> m.parts.any { (it as? ChatPart.Text)?.text == "it did arrive" } })
    }
}
