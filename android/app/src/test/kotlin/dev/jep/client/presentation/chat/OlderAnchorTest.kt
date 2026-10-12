package dev.jep.client.presentation.chat

import dev.jep.client.domain.model.ChatMessage
import dev.jep.client.domain.model.ChatPart
import dev.jep.client.domain.model.Role
import dev.jep.client.domain.model.ToolStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

// What the chat holds on to while an older page loads above it. A "Worked for"
// run is keyed by its oldest step, so a page that adds older steps to the run
// at the top of the screen changes its key; the anchor must not change.
class OlderAnchorTest {

    private fun work(id: String, time: Long) =
        ChatMessage(id, Role.ASSISTANT, time, listOf(ChatPart.Tool("t-$id", "read", ToolStatus.COMPLETED, "/f")))

    private fun rows(vararg m: ChatMessage) = groupWorkRuns(m.map { rowFor(it) })

    @Test
    fun a_work_run_keeps_its_anchor_when_older_steps_join_it() {
        // newest first, as the transcript is
        val before = rows(work("w3", 3), work("w2", 2)).single()
        val after = rows(work("w3", 3), work("w2", 2), work("w1", 1)).single()
        assertNotEquals("the key is what changes", before.key, after.key)
        assertEquals(before.anchor(), after.anchor())
    }

    @Test
    fun a_message_is_its_own_anchor() {
        val m = ChatMessage("m1", Role.ASSISTANT, 1, listOf(ChatPart.Text("hi")))
        assertEquals(rowFor(m).key, rowFor(m).anchor())
    }
}
