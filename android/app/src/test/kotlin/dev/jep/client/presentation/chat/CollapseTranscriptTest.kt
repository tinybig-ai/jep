package dev.jep.client.presentation.chat

import dev.jep.client.domain.model.ChatMessage
import dev.jep.client.domain.model.ChatPart
import dev.jep.client.domain.model.Role
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * A stretch of work — tool calls and thinking with nothing said between them —
 * as one row titled by what is inside it.
 */
class CollapseTranscriptTest {

    private fun tool(name: String, id: String, added: Int? = null, removed: Int? = null) =
        ChatPart.Tool(id = id, name = name, status = null, title = null, added = added, removed = removed)

    private fun think(t: String, ms: Long? = null) = ChatPart.Reasoning(t, ms)

    private fun text(t: String) = ChatPart.Text(t)

    private fun label(p: ChatPart): String = when (p) {
        is ChatPart.Text -> p.text
        is ChatPart.Tool -> p.id.orEmpty()
        is ChatPart.Reasoning -> "think:" + p.text
        else -> "?"
    }

    private fun shape(rows: List<TranscriptRow>): List<String> = rows.map { row ->
        when (row) {
            is TranscriptRow.One -> "one:" + label(row.part)
            is TranscriptRow.Group -> "group:" + row.parts.joinToString(",") { label(it) }
        }
    }

    @Test
    fun `tools and thoughts between two things said are one fold`() {
        val rows = collapseTranscript(
            listOf(text("looking"), think("a"), tool("edit", "1"), tool("read", "2"), think("b"), tool("bash", "3"), text("done")),
        )
        assertEquals(listOf("one:looking", "group:think:a,1,2,think:b,3", "one:done"), shape(rows))
    }

    @Test
    fun `a lone call or thought is left as it was`() {
        assertEquals(listOf("one:1"), shape(collapseTranscript(listOf(tool("bash", "1")))))
        assertEquals(listOf("one:think:a", "one:x"), shape(collapseTranscript(listOf(think("a"), text("x")))))
    }

    @Test
    fun `step markers and blank thinking neither show nor break a run`() {
        val rows = collapseTranscript(
            listOf(tool("read", "1"), ChatPart.Unsupported("step-finish"), think("  "), tool("edit", "2")),
        )
        assertEquals(listOf("group:1,2"), shape(rows))
    }

    @Test
    fun `a call with a card under it breaks the run`() {
        val rows = collapseTranscript(listOf(tool("read", "1"), tool("bash", "2"), tool("read", "3")), setOf("2"))
        assertEquals(listOf("one:1", "one:2", "one:3"), shape(rows))
    }

    @Test
    fun `the title says what is inside`() {
        val parts = listOf(
            tool("edit", "1", added = 10, removed = 2), think("hm", 2_000), tool("edit", "2"),
            tool("bash", "3"), tool("read", "4"),
        )
        // line counts are drawn beside the title, never inside it
        assertEquals("Edited 2 files, ran 1 command, read 1 file", workTitle(parts))
        assertEquals("Worked for 1m 13s · edited 2 files, ran 1 command, read 1 file", workTitle(parts, 73_000))
        assertEquals("Working · edited 2 files, ran 1 command, read 1 file", workTitle(parts, 73_000, active = true))
    }

    @Test
    fun `only thinking is a thought, timed when every part was`() {
        assertEquals("Thought for 3s", workTitle(listOf(think("a", 1_000), think("b", 2_000))))
        assertEquals("Thought", workTitle(listOf(think("a", 1_000), think("b"))))
    }

    @Test
    fun `an unfamiliar tool still counts`() {
        assertEquals("Weird 2 calls", workTitle(listOf(tool("weird", "1"), tool("weird", "2"))))
        assertEquals("Searched 2 searches", workTitle(listOf(tool("grep", "1"), tool("grep", "2"))))
    }

    @Test
    fun `spans read the way a person says them`() {
        assertEquals("42s", fmtSpan(42_400))
        assertEquals("1m 13s", fmtSpan(73_000))
        assertEquals("2h 5m", fmtSpan(7_500_000))
    }

    // ---- across messages, which is where opencode actually puts them ----

    private fun workMsg(id: String, time: Long, vararg parts: ChatPart, took: Long? = null) =
        Row.Msg(ChatMessage(id, Role.ASSISTANT, time, listOf(ChatPart.Unsupported("step-finish")) + parts, durationMs = took))

    private fun sayMsg(id: String) = Row.Msg(ChatMessage(id, Role.ASSISTANT, 0, listOf(text("done"))))

    private fun shapeRows(rows: List<Row>): List<String> = rows.map { row ->
        when (row) {
            is Row.Work -> "work:" + row.parts.joinToString(",") { label(it) }
            is Row.Msg -> "msg:" + row.m.id
            is Row.Pending -> "ask:" + row.ask.id
            is Row.PastAsk -> "past-ask:" + row.entry.ask.id
            is Row.Compaction -> "compaction:" + row.m.id
            is Row.AutoContinue -> "auto:" + row.m.id
        }
    }

    @Test
    fun `a run of work-only messages is one fold, in the order it happened`() {
        // rows are newest first; opencode emits one message per step
        val rows = groupWorkRuns(
            listOf(sayMsg("m4"), workMsg("m3", 3, tool("bash", "t3")), workMsg("m2", 2, think("b")), workMsg("m1", 1, tool("edit", "t1"))),
        )
        assertEquals(listOf("msg:m4", "work:t1,think:b,t3"), shapeRows(rows))
        assertEquals("work-m1", rows[1].key)
    }

    @Test
    fun `the fold is timed from the first start to the last finish`() {
        val rows = groupWorkRuns(
            listOf(workMsg("m2", 60_000, tool("bash", "t2"), took = 13_000), workMsg("m1", 1_000, tool("read", "t1"), took = 5_000)),
        )
        assertEquals(72_000L, (rows.single() as Row.Work).durationMs)
    }

    @Test
    fun `one work message stays a message, and folds inside itself`() {
        val rows = groupWorkRuns(listOf(workMsg("m1", 1, tool("read", "t1"), tool("read", "t2"))))
        assertEquals(listOf("msg:m1"), shapeRows(rows))
    }

    @Test
    fun `a message that says something is never swallowed`() {
        val says = Row.Msg(ChatMessage("m2", Role.ASSISTANT, 0, listOf(text("looking now"), tool("read", "t1"))))
        val rows = groupWorkRuns(listOf(workMsg("m3", 3, tool("read", "a")), says, workMsg("m1", 1, tool("read", "b"))))
        assertEquals(listOf("msg:m3", "msg:m2", "msg:m1"), shapeRows(rows))
    }

    @Test
    fun `the held message stays itself while the turn is live`() {
        val rows = groupWorkRuns(
            listOf(workMsg("m3", 3, tool("bash", "c")), workMsg("m2", 2, tool("read", "b")), workMsg("m1", 1, tool("read", "a"))),
            hold = "m3",
        )
        assertEquals(listOf("msg:m3", "work:a,b"), shapeRows(rows))
    }

    @Test
    fun `the user's own messages never fold`() {
        val user = Row.Msg(ChatMessage("u", Role.USER, 0, listOf(ChatPart.Unsupported("x"), tool("read", "t"))))
        assertEquals(listOf("msg:u", "msg:w"), shapeRows(groupWorkRuns(listOf(user, workMsg("w", 1, tool("read", "a"))))))
    }
}
