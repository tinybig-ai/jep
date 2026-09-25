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
 * row that still believed it was streaming, cursor and all. Our live rows carry
 * time 0, so a real timestamp in the record is what says the turn is over.
 */
class LiveRowTest {

    private fun served(id: String, time: Long) = ChatMessage(id, Role.ASSISTANT, time, listOf(ChatPart.Text("done")))

    @Test
    fun `a record with a real time for the streamed message means the turn is over`() {
        assertTrue(liveRowIsSettled("m1", listOf(served("m1", 1_700_000_000_000))))
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
