package dev.jep.client.presentation.chat

import dev.jep.client.domain.model.Ask
import dev.jep.client.domain.model.AskEntry
import dev.jep.client.domain.model.AskOption
import dev.jep.client.domain.model.ChatMessage
import dev.jep.client.domain.model.ChatPart
import dev.jep.client.domain.model.Role
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// A card is part of the conversation's record. It used to live in one slot:
// the next ask overwrote it, standing it down deleted it, and a phone that was
// not listening when it arrived never learned the turn was parked on it.
class AskRecordTest {

    private fun ask(id: String, at: Long, messageId: String? = null) =
        Ask(id = id, title = "bash", options = listOf(AskOption("once", "Allow once"), AskOption("reject", "Deny", danger = true)), messageId = messageId, at = at)

    private fun msg(id: String, time: Long) = ChatMessage(id, Role.ASSISTANT, time, listOf(ChatPart.Text(id)))

    @Test
    fun `an answered card replaced by the next ask stays on the record with its answer`() {
        val st = ChatViewModel.UiState(ask = ask("a1", 10), askAt = 10, askChoice = "once")
        val next = st.retireAsk().copy(ask = ask("a2", 20), askAt = 20)
        assertEquals(listOf(AskEntry(ask("a1", 10), pending = false, choice = "once")), next.pastAsks)
        assertEquals("a2", next.ask?.id)
    }

    @Test
    fun `a card stood down unanswered is kept, with nothing chosen`() {
        val st = ChatViewModel.UiState(ask = ask("a1", 10), askAt = 10).retireAsk()
        assertNull(st.ask)
        assertEquals(listOf(AskEntry(ask("a1", 10))), st.pastAsks)
    }

    @Test
    fun `answering in your own words is not an option chosen`() {
        val st = ChatViewModel.UiState(ask = ask("a1", 10), askAt = 10, askChoice = SOMETHING_ELSE).retireAsk()
        assertNull(st.pastAsks.single().choice)
    }

    @Test
    fun `a chat opened later learns the turn is parked on a card`() {
        val st = ChatViewModel.UiState().withServedAsks(
            listOf(AskEntry(ask("a1", 10), choice = "once"), AskEntry(ask("a2", 20), pending = true)),
        )
        assertEquals("a2", st.ask?.id)
        assertEquals(20L, st.askAt)
        assertEquals(listOf("a1"), st.pastAsks.map { it.ask.id })
    }

    @Test
    fun `the record settling the open card stands it down`() {
        val st = ChatViewModel.UiState(ask = ask("a1", 10), askAt = 10)
            .withServedAsks(listOf(AskEntry(ask("a1", 10), choice = "once")))
        assertNull(st.ask)
        assertEquals("once", st.pastAsks.single().choice)
    }

    @Test
    fun `a tap still in flight is not undone by a record that lags it`() {
        val st = ChatViewModel.UiState(ask = ask("a1", 10), askAt = 10, askChoice = "once")
            .withServedAsks(listOf(AskEntry(ask("a1", 10), pending = true)))
        assertEquals("a1", st.ask?.id)
        assertEquals("once", st.askChoice)
    }

    @Test
    fun `reading the record twice adds nothing`() {
        val served = listOf(AskEntry(ask("a1", 10), choice = "once"))
        val st = ChatViewModel.UiState().withServedAsks(served).withServedAsks(served)
        assertEquals(1, st.pastAsks.size)
    }

    @Test
    fun `every card sits under its own message, the open one included`() {
        // newest first: index 0 is the bottom of the screen
        val ordered = listOf(msg("m3", 30), msg("m2", 20), msg("m1", 10))
        val rows = transcriptRows(
            ordered,
            ask("a3", 31, messageId = "m3"),
            31,
            past = listOf(AskEntry(ask("a1", 11, messageId = "m1"), choice = "once"), AskEntry(ask("a2", 21))),
        )
        assertEquals(listOf("ask-a3", "m3", "ask-a2", "m2", "ask-a1", "m1"), rows.map { it.key })
        assertEquals(listOf(Row.PastAsk::class, Row.PastAsk::class), rows.filterIsInstance<Row.PastAsk>().map { it::class })
    }

    @Test
    fun `a card sits inside its message, right after the call it holds up`() {
        // claude streams a whole turn as ONE live message: calls and the text
        // after them. Under the message, the card sank below everything written
        // after the call, and only fell into place once the turn ended.
        val tool = ChatPart.Tool(id = "toolu_1", name = "Bash", status = null, title = null)
        val live = ChatMessage("live", Role.ASSISTANT, 0, listOf(ChatPart.Text("before"), tool, ChatPart.Text("after")))
        val card = Ask(id = "a1", title = "Bash wants to run", callId = "toolu_1", at = 5)
        val rows = transcriptRows(listOf(live, msg("m1", 1)), card, 5, liveMessageId = "live")
        assertEquals(listOf("live", "m1"), rows.map { it.key })
        val host = rows[0] as Row.Msg
        assertEquals(listOf("ask-a1"), host.cards["toolu_1"]?.map { it.key })
        // and the call with a card under it is never folded into a group
        val grouped = collapseTranscript(listOf(tool, tool.copy(id = "t2"), tool.copy(id = "t3")), setOf("toolu_1"))
        assertEquals(TranscriptRow.One(tool), grouped.first())
    }
}

