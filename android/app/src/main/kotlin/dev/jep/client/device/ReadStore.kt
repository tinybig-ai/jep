package dev.jep.client.device

import android.content.SharedPreferences
import dev.jep.client.domain.model.SessionSummary

// Which conversations have been looked at since they last changed. The daemon
// keeps the mark too (SessionSummary.seenAt), so a reinstall or a second device
// agrees; this copy answers at once, before the daemon's reply comes back.
class ReadStore(private val prefs: SharedPreferences) {

    fun lastRead(sessionId: String): Long = runCatching { prefs.getLong(key(sessionId), 0L) }.getOrDefault(0L)

    fun markRead(sessionId: String, at: Long = System.currentTimeMillis()) =
        prefs.edit().putLong(key(sessionId), at).apply()

    /** put it back to unseen, for "mark as unread" — forgetting the mark is
     * what makes it unread again, since anything newer than 0 counts */
    fun markUnread(sessionId: String) = prefs.edit().remove(key(sessionId)).apply()

    /** a conversation that has moved on since it was last opened */
    fun isUnread(session: SessionSummary): Boolean = session.updatedAt > maxOf(lastRead(session.id), session.seenAt)

    private fun key(sessionId: String) = "$PREFIX$sessionId"

    private companion object {
        const val PREFIX = "read_"
    }
}
