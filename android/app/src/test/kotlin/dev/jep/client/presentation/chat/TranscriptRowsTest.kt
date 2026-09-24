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
    fun `the card lands under the tool call that raised it, not above it`() {
        // The bug the screenshot showed: "Used question" is a part of the
        // streaming assistant message, and that message's time is when it
        // started — before the ask. Comparing times therefore floated the card
        // above the question it answers, and above the user's own message from
        // before it. The anchor wins: the card follows the message that was
        // streaming when the ask arrived.
        val ordered = listOf(
            msg("live", Role.ASSISTANT, 0),
            msg("m3", Role.USER, 25),
            msg("m2", Role.ASSISTANT, 20),
            msg("m1", Role.USER, 10),
        )
        assertEquals(
            listOf("live", "ask-a1", "m3", "m2", "m1"),
            keys(transcriptRows(ordered, ask, 30, liveMessageId = "live", askAfter = "live")),
        )
    }

    @Test
    fun `an anchor that has scrolled away falls back to the by-time rule`() {
        val ordered = listOf(msg("m3", Role.USER, 40), msg("m2", Role.ASSISTANT, 20), msg("m1", Role.USER, 10))
        assertEquals(
            listOf("m3", "ask-a1", "m2", "m1"),
            keys(transcriptRows(ordered, ask, 30, liveMessageId = null, askAfter = "gone")),
        )
    }

    @Test
    fun `a turn in flight does not park the ask at the bottom`() {
        // The live row is always the bottom slot (it is appended last) but it
        // carries no usable timestamp — liveAsMessage gives it 0. Scanning by
        // time alone therefore met it first, read it as the oldest thing in the
        // list, and planted the ask underneath it: the card sat at the bottom of
        // the pane for the whole turn, exactly the bug being fixed.
        val ordered = listOf(
            msg("live", Role.ASSISTANT, 0),
            msg("m3", Role.USER, 40),
            msg("m2", Role.ASSISTANT, 20),
            msg("m1", Role.USER, 10),
        )
        assertEquals(
            listOf("live", "m3", "ask-a1", "m2", "m1"),
            keys(transcriptRows(ordered, ask, 30, liveMessageId = "live")),
        )
    }

    @Test
    fun `with no live row the same transcript places the ask the same way`() {
        val ordered = listOf(msg("m3", Role.USER, 40), msg("m2", Role.ASSISTANT, 20), msg("m1", Role.USER, 10))
        assertEquals(listOf("m3", "ask-a1", "m2", "m1"), keys(transcriptRows(ordered, ask, 30)))
    }

    @Test
    fun `a tapped choice spends the ask, and the card stays in the transcript`() {
        // tapping used to clear the ask, which threw the card away and left a
        // thin receipt line hard-appended to the end of the transcript — a line
        // that never moved up either. The card is the record now.
        val ordered = listOf(msg("m2", Role.ASSISTANT, 20), msg("m1", Role.USER, 10))
        val rows = transcriptRows(ordered, ask, 30, liveMessageId = null)
        assertTrue("a tap spends it", askIsSpent(ask, "always"))
        assertTrue("and the card is still there", rows.any { it is Row.Pending && it.ask.id == "a1" })
    }

    @Test
    fun `an unanswered ask keeps its choices`() {
        assertFalse(askIsSpent(ask, null))
    }

    @Test
    fun `no ask means nothing is spent`() {
        val ordered = listOf(msg("m2", Role.USER, 40))
        assertFalse(askIsSpent(null, null))
    }

    @Test
    fun `a card standing open holds the send button`() {
        // a message typed during an ask used to queue silently behind a turn
        // blocked on the very question being asked, which read as the app
        // swallowing what you wrote
        assertTrue("nothing to answer", canSend(null, null))
        assertFalse("card is up, nothing chosen", canSend(ask, null))
    }

    @Test
    fun `answering the card, or saying it in words, brings sending back`() {
        assertTrue("tapped an option", canSend(ask, "always"))
        assertTrue("said it in words", canSend(ask, SOMETHING_ELSE))
    }
}
