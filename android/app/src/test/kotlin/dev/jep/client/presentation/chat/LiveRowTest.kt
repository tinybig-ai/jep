package dev.jep.client.presentation.chat

import dev.jep.client.domain.model.ChatMessage
import dev.jep.client.domain.model.ChatPart
import dev.jep.client.domain.model.Role
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * When a live row has been overtaken by the record.
 *
 * A live row is closed by a turn-ending event, and the transcript always prefers
 * the live row over its twin in the record. So an event that never arrived — a
 * dropped stream, a backgrounded app — stranded a finished answer under a stale
 * row that still believed it was streaming, cursor and all. Only a completion
 * stamp (durationMs) in the record says the turn is over; its creation time is
 * there from the first poll.
 */
class LiveRowTest {

    private fun served(id: String, time: Long, durationMs: Long? = 4_000) =
        ChatMessage(id, Role.ASSISTANT, time, listOf(ChatPart.Text("done")), durationMs = durationMs)

    @Test
    fun `a record that has completed the streamed message means the turn is over`() {
        assertTrue(liveRowIsSettled("m1", listOf(served("m1", 1_700_000_000_000))))
    }

    @Test
    fun `a record still writing the streamed message leaves the live row alone`() {
        // it has a creation time from the first poll; dropping the row here made
        // the next delta start an empty one that showed only the tail
        assertFalse(liveRowIsSettled("m1", listOf(served("m1", 1_700_000_000_000, durationMs = null))))
    }

    @Test
    fun `a record that has not caught up leaves the live row alone`() {
        assertFalse(liveRowIsSettled("m1", emptyList()))
        assertFalse(liveRowIsSettled("m1", listOf(served("other", 1_700_000_000_000))))
    }

    @Test
    fun `no live row is nothing to settle`() {
        assertFalse(liveRowIsSettled(null, listOf(served("m1", 1_700_000_000_000))))
    }
}
