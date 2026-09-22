package dev.jep.client.device

// The two facts a notification policy needs and only the UI knows: whether the
// app is on screen, and which conversation is open. Process-wide, because the
// foreground service outlives every Activity and ViewModel — it is the piece
// that is still running when the answer lands and the person has walked away.
object AppPresence {
    @Volatile
    var foreground: Boolean = false

    @Volatile
    var openSessionId: String? = null

    fun onForeground() {
        foreground = true
    }

    fun onBackground() {
        foreground = false
        // nothing is being read once the app is away, so the conversation that
        // was open must not suppress its own notification
        openSessionId = null
    }

    fun onChatOpen(sessionId: String) {
        openSessionId = sessionId
    }

    fun onChatClosed(sessionId: String) {
        if (openSessionId == sessionId) openSessionId = null
    }
}
