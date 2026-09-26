package dev.jep.client.domain.repository

/**
 * What the device needs to hear from the screens to decide whether to
 * interrupt the person, and to take back what it already announced. The
 * screens only say what happened; how it becomes a notification, or no
 * notification, is the device's business (see device/NotificationPolicy).
 */
interface Attention {
    /** a conversation is on screen: a finished turn there is not news */
    fun chatOpened(sessionId: String)
    fun chatClosed(sessionId: String)
    /** the person opened it: whatever was announced about it is seen */
    fun seen(sessionId: String)

    /** tells no one: tests, previews */
    object None : Attention {
        override fun chatOpened(sessionId: String) = Unit
        override fun chatClosed(sessionId: String) = Unit
        override fun seen(sessionId: String) = Unit
    }
}
