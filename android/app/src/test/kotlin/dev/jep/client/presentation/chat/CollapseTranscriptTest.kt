package dev.jep.client.presentation.chat

import dev.jep.client.domain.model.ChatPart
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Consecutive tool calls of the same kind, as one row.
 *
 * Grouping is by consecutive runs of the same tool and never across kinds: a
 * read/edit/test alternation is the order the work happened in, and collapsing
 * that would throw away the thing you were reading the transcript for.
 */
class CollapseTranscriptTest {

    private fun tool(name: String, id: String, added: Int? = null, removed: Int? = null) =
        ChatPart.Tool(id = id, name = name, status = null, title = null, added = added, removed = removed)

    private fun text(t: String) = ChatPart.Text(t)

    private fun shape(rows: List<TranscriptRow>): List<String> = rows.map { row ->
        when (row) {
            is TranscriptRow.One -> {
                val part = row.part
                "one:" + when (part) {
                    is ChatPart.Text -> part.text
                    is ChatPart.Tool -> part.id.orEmpty()
                    else -> "?"
                }
            }
            is TranscriptRow.Group -> "group:" + row.tools.joinToString(",") { it.id.orEmpty() }
        }
    }

    @Test
    fun `a run of three or more becomes one row`() {
        val rows = collapseTranscript(listOf(tool("read", "1"), tool("read", "2"), tool("read", "3")))
        assertEquals(listOf("group:1,2,3"), shape(rows))
    }

    @Test
    fun `two calls are not worth a disclosure`() {
        val rows = collapseTranscript(listOf(tool("read", "1"), tool("read", "2")))
        assertEquals(listOf("one:1", "one:2"), shape(rows))
    }

    @Test
    fun `a lone tool is left exactly as it was`() {
        // a group of one is a wrapper around something already readable
        val rows = collapseTranscript(listOf(tool("bash", "1")))
        assertEquals(listOf("one:1"), shape(rows))
    }

    @Test
    fun `an alternation of tools keeps its order`() {
        val rows = collapseTranscript(
            listOf(tool("read", "1"), tool("edit", "2"), tool("read", "3"), tool("bash", "4")),
        )
        assertEquals(listOf("one:1", "one:2", "one:3", "one:4"), shape(rows))
    }

    @Test
    fun `a run broken by prose is two runs, and only long ones count`() {
        val rows = collapseTranscript(
            listOf(
                tool("read", "1"), tool("read", "2"), tool("read", "3"),
                text("here"),
                tool("read", "4"), tool("read", "5"),
            ),
        )
        assertEquals(listOf("group:1,2,3", "one:here", "one:4", "one:5"), shape(rows))
    }

    @Test
    fun `a group reads as one line with its totals`() {
        val tools = listOf(
            tool("edit", "1", added = 10, removed = 2),
            tool("edit", "2", added = 118, removed = 92),
        )
        assertEquals("Edited 2 files +128 -94", toolGroupSummary(tools))
    }

    @Test
    fun `a read run says how many files`() {
        assertEquals("Read 17 files", toolGroupSummary(List(17) { tool("read", "$it") }))
    }

    @Test
    fun `a run with no line changes says nothing about them`() {
        assertEquals("Ran 3 commands", toolGroupSummary(List(3) { tool("bash", "$it") }))
    }

    @Test
    fun `an unfamiliar tool still reads as a run`() {
        val summary = toolGroupSummary(listOf(tool("weird", "1"), tool("weird", "2")))
        assertTrue(summary, summary.startsWith("Weird 2 "))
    }
}
