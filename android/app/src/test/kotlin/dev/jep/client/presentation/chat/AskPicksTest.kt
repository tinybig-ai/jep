package dev.jep.client.presentation.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// A multi-question ask is answered by sending every pick at once, because the
// harness reads the answers positionally — one list per question, in the order
// they were asked. The card encodes the picks into one option id and reads them
// back to show what was chosen, so the two have to agree.
class AskPicksTest {

    @Test
    fun `picks encode as one array in question order`() {
        val encoded = encodePicked(2, mapOf(0 to "0:Inline", 1 to "1:Maximize above attach"))
        assertEquals("[\"0:Inline\",\"1:Maximize above attach\"]", encoded)
    }

    @Test
    fun `an answer round-trips back to the question it belongs to`() {
        val picks = mapOf(0 to "0:Inline", 1 to "1:Maximize above attach")
        assertEquals(picks, parsePicked(encodePicked(2, picks)))
    }

    @Test
    fun `a skipped question does not shift the ones after it`() {
        // question 1 left unanswered, question 2 answered: the picks must still
        // land on the question they were made for
        val picks = mapOf(0 to "0:A", 2 to "2:C")
        val decoded = parsePicked(encodePicked(3, picks))
        assertEquals("0:A", decoded[0])
        assertEquals(null, decoded[1])
        assertEquals("2:C", decoded[2])
    }

    @Test
    fun `a single-question card's bare option id highlights nothing positional`() {
        // the ordinary card answers with one option id, not an array; reading it
        // as picks would be a guess, so it highlights by equality instead
        assertTrue(parsePicked("0:once").isEmpty())
        assertTrue(parsePicked(null).isEmpty())
    }
}
