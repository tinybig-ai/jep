package dev.jep.client.device

import android.content.SharedPreferences
import dev.jep.client.domain.model.SessionSummary

// Which conversations have been looked at since they last changed. Kept on the
// device, because "unread" is about this person on this phone — the daemon has
// no idea who has seen what.
class ReadStore(private val prefs: SharedPreferences) {

    fun lastRead(sessionId: String): Long = runCatching { prefs.getLong(key(sessionId), 0L) }.getOrDefault(0L)

    fun markRead(sessionId: String, at: Long = System.currentTimeMillis()) =
        prefs.edit().putLong(key(sessionId), at).apply()

    /** a conversation that has moved on since it was last opened */
    fun isUnread(session: SessionSummary): Boolean = session.updatedAt > lastRead(session.id)

    private fun key(sessionId: String) = "$PREFIX$sessionId"

    private companion object {
        const val PREFIX = "read_"
    }
}
