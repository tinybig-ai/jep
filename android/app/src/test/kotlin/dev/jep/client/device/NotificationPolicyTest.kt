package dev.jep.client.device

import dev.jep.client.domain.repository.ChatEvent
import dev.jep.client.domain.model.Ask
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// What is worth a notification is the client's decision, so it is pinned here
// rather than left to the service's `when`. The rules: a finished turn, only
// when the app is away, and never for a failure or a stop.
class NotificationPolicyTest {

    private val ask = Ask(id = "a1", title = "run the tests?", options = emptyList())

    @Test
    fun `a finished turn notifies when the app is away`() {
        assertEquals(
            NotificationPolicy.Notice.FINISHED,
            NotificationPolicy.decide(ChatEvent.Quiet("s1"), openSessionId = null, foreground = false),
        )
    }

    @Test
    fun `a finished turn is silent while the app is up`() {
        assertNull(NotificationPolicy.decide(ChatEvent.Quiet("s1"), openSessionId = null, foreground = true))
        assertNull(NotificationPolicy.decide(ChatEvent.Quiet("s1"), openSessionId = "s1", foreground = true))
        // even a different conversation: the list carries the signal instead
        assertNull(NotificationPolicy.decide(ChatEvent.Quiet("s2"), openSessionId = "s1", foreground = true))
    }

    @Test
    fun `an ask notifies when the app is away`() {
        assertEquals(
            NotificationPolicy.Notice.ASKED,
            NotificationPolicy.decide(ChatEvent.Asked("s1", ask), openSessionId = null, foreground = false),
        )
    }

    @Test
    fun `a failure or a stop never notifies`() {
        assertNull(NotificationPolicy.decide(ChatEvent.Failed("s1", "boom"), openSessionId = null, foreground = false))
        assertNull(NotificationPolicy.decide(ChatEvent.Aborted("s1"), openSessionId = null, foreground = false))
        assertNull(NotificationPolicy.decide(ChatEvent.Lost, openSessionId = null, foreground = false))
    }
}
