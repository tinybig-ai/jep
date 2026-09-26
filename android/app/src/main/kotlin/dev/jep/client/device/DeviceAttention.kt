package dev.jep.client.device

import android.content.Context
import dev.jep.client.domain.repository.Attention

// Attention on the phone: which chat is open (for NotificationPolicy, through
// AppPresence) and the notifications a seen conversation takes back.
class DeviceAttention(private val context: Context) : Attention {
    override fun chatOpened(sessionId: String) = AppPresence.onChatOpen(sessionId)
    override fun chatClosed(sessionId: String) = AppPresence.onChatClosed(sessionId)
    override fun seen(sessionId: String) = Notifications.clear(context, sessionId)
}
