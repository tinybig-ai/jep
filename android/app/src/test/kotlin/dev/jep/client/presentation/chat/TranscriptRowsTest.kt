package dev.jep.client.presentation.chat

import dev.jep.client.domain.model.Ask
import dev.jep.client.domain.model.AskOption
import dev.jep.client.domain.model.ChatMessage
import dev.jep.client.domain.model.ChatPart
import dev.jep.client.domain.model.Role
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Where the ask sits in the transcript, and when its buttons go dead. Both were
// wrong in the same way: the card was pinned above the composer, so it never
// moved up with the chat, and it kept offering its choices after the user had
// answered in their own words instead.
class TranscriptRowsTest {

    private val ask = Ask(
        id = "a1",
        title = "external_directory",
        options = listOf(AskOption("once", "Allow once"), AskOption("always", "Always allow")),
    )

    private fun msg(id: String, role: Role, time: Long) =
        ChatMessage(id, role, time, listOf(ChatPart.Text(id)))

    private fun keys(rows: List<Row>) = rows.map { it.key }

    @Test
    fun `no ask means the transcript is untouched`() {
        val ordered = listOf(msg("m2", Role.ASSISTANT, 20), msg("m1", Role.USER, 10))
        assertEquals(listOf("m2", "m1"), keys(transcriptRows(ordered, null, 0)))
    }

    @Test
    fun `a fresh ask lands at the bottom, where it is visible`() {
        // ordered is newest-first, so index 0 is the bottom of the screen — which
        // is where a just-raised ask has to be, or the user never sees it
        val ordered = listOf(msg("m2", Role.ASSISTANT, 20), msg("m1", Role.USER, 10))
        assertEquals(listOf("ask-a1", "m2", "m1"), keys(transcriptRows(ordered, ask, 30)))
    }

    @Test
    fun `output newer than the ask lands below it, carrying the ask up`() {
        // m3 streamed in after the ask was raised: it belongs under the ask, so
        // the ask is no longer the bottom row and moves up the transcript
        val ordered = listOf(
            msg("m3", Role.ASSISTANT, 40),
            msg("m2", Role.ASSISTANT, 20),
            msg("m1", Role.USER, 10),
        )
        assertEquals(listOf("m3", "ask-a1", "m2", "m1"), keys(transcriptRows(ordered, ask, 30)))
    }

    @Test
    fun `an ask raised mid-turn sits between the message before and after it`() {
        val ordered = listOf(
            msg("m3", Role.ASSISTANT, 40),
            msg("m2", Role.ASSISTANT, 20),
            msg("m1", Role.USER, 10),
        )
        assertEquals(listOf("m3", "m2", "ask-a1", "m1"), keys(transcriptRows(ordered, ask, 15)))
    }

    @Test
    fun `an ask older than everything in view is still shown, at the top`() {
        val ordered = listOf(msg("m2", Role.ASSISTANT, 20), msg("m1", Role.USER, 10))
        assertEquals(listOf("m2", "m1", "ask-a1"), keys(transcriptRows(ordered, ask, 5)))
    }

    @Test
    fun `answering in chat puts the ask's own choices out of play`() {
        val ordered = listOf(msg("m2", Role.USER, 40), msg("m1", Role.ASSISTANT, 20))
        val rows = transcriptRows(ordered, ask, 30)
        assertTrue("a user message after the ask retires its buttons", askAnsweredInChat(rows, 30))
    }

    @Test
    fun `an unanswered ask keeps its choices`() {
        val ordered = listOf(msg("m2", Role.ASSISTANT, 20), msg("m1", Role.USER, 10))
        val rows = transcriptRows(ordered, ask, 30)
        assertFalse(askAnsweredInChat(rows, 30))
    }

    @Test
    fun `the user's own message before the ask does not retire its choices`() {
        val ordered = listOf(msg("m2", Role.ASSISTANT, 40), msg("m1", Role.USER, 10))
        val rows = transcriptRows(ordered, ask, 30)
        assertFalse(askAnsweredInChat(rows, 30))
    }
}
