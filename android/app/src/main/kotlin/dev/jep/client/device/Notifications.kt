package dev.jep.client.device

import android.app.NotificationManager
import android.content.Context

// A conversation's notifications are tagged with its id, one per kind, so they
// can be taken back: when the ask they announce is settled, and when the person
// opens the conversation they are about.
object Notifications {
    const val FINISHED = 1
    const val ASKED = 2

    fun withdraw(context: Context, sessionId: String, kind: Int) {
        manager(context).cancel(sessionId, kind)
    }

    /** the person is looking at the conversation: nothing about it is news */
    fun clear(context: Context, sessionId: String) {
        withdraw(context, sessionId, FINISHED)
        withdraw(context, sessionId, ASKED)
    }

    private fun manager(context: Context) =
        context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
}
