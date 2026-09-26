package dev.jep.client.presentation.chat

import dev.jep.client.domain.model.ChatMessage
import dev.jep.client.domain.model.ChatPart
import dev.jep.client.domain.model.Role
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * opencode marks a compaction with a synthetic user message whose only part is
 * the compaction marker; it renders as its own divider row, not a bubble. A
 * message with no renderable part at all is still dropped.
 */
class RenderableMessagesTest {

    private fun text(id: String, body: String = "hi") =
        ChatMessage(id, Role.USER, 1, listOf(ChatPart.Text(body)))

    private fun compaction(id: String = "c1") =
        ChatMessage(id, Role.USER, 2, listOf(ChatPart.Compaction))

    @Test
    fun `a message with no renderable parts is not a bubble`() {
        val silent = ChatMessage("c1", Role.USER, 2, emptyList())
        assertEquals(listOf(text("a1")), renderableMessages(listOf(text("a1"), silent)))
    }

    @Test
    fun `a compaction marker is kept for its own row`() {
        assertEquals(listOf(compaction()), renderableMessages(listOf(compaction())))
    }

    @Test
    fun `a compaction-only message becomes a divider row`() {
        assertTrue(rowFor(compaction()) is Row.Compaction)
    }

    @Test
    fun `an ordinary message stays a message row`() {
        assertTrue(rowFor(text("u1")) is Row.Msg)
    }

    @Test
    fun `everything that renders something stays`() {
        val msgs = listOf(
            text("u1"),
            ChatMessage("a1", Role.ASSISTANT, 3, listOf(ChatPart.Tool("p1", "bash", null, null, null, null, null, null, null))),
            ChatMessage("a2", Role.ASSISTANT, 4, listOf(ChatPart.Reasoning("thinking", null))),
        )
        assertEquals(msgs, renderableMessages(msgs))
    }

    @Test
    fun `an empty record passes through empty`() {
        assertEquals(emptyList<ChatMessage>(), renderableMessages(emptyList()))
    }
}
