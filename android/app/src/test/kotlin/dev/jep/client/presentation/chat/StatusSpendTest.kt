package dev.jep.client.presentation.chat

import dev.jep.client.domain.model.ChatMessage
import dev.jep.client.domain.model.ChatPart
import dev.jep.client.domain.model.Role
import dev.jep.client.domain.model.Usage
import org.junit.Assert.assertEquals
import org.junit.Test

// The top bar read $0.04 beside a usage sheet saying $1.01: it summed only the
// messages loaded on screen, and then held on to the largest figure it had seen.
class StatusSpendTest {

    private fun reply(id: String, cost: Double) =
        ChatMessage(id, Role.ASSISTANT, 1, listOf(ChatPart.Text(id)), cost = cost)

    @Test
    fun `the conversation's spend wins over the loaded window's`() {
        val st = ChatViewModel.UiState(messages = listOf(reply("m1", 0.04)), usage = Usage(cost = 1.01))
        assertEquals(1.01, statusSummary(st).spend!!, 1e-9)
    }

    @Test
    fun `the window stands in until usage arrives`() {
        val st = ChatViewModel.UiState(messages = listOf(reply("m1", 0.02), reply("m2", 0.02)))
        assertEquals(0.04, statusSummary(st).spend!!, 1e-9)
    }

    @Test
    fun `a newer figure replaces an older one instead of the larger one sticking`() {
        val shown = retainStatus(StatusSummary(spend = 0.50), StatusSummary(spend = 0.30))
        assertEquals(0.30, shown.spend!!, 1e-9)
        assertEquals(0.30, retainStatus(shown, StatusSummary(spend = null)).spend!!, 1e-9)
    }

    @Test
    fun `a limit smaller than what is in use is not shown`() {
        assertEquals("opus  ·  461.1K tok", statusText(StatusSummary(model = "opus", used = 461_100, limit = 200_000)))
        assertEquals("opus  ·  461.1K/1.0M  46%", statusText(StatusSummary(model = "opus", used = 461_100, limit = 1_000_000)))
    }
}

