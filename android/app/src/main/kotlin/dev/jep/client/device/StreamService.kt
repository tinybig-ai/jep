package dev.jep.client.device

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat
import dev.jep.client.MainActivity
import dev.jep.client.data.GatewayChatRepository
import dev.jep.client.domain.repository.ChatRepository

// The one long-lived piece of the client: for as long as the process lives,
// this foreground service holds the push feed, so asks from a backgrounded
// session still surface as notifications. Android stops suspended
// applications' sockets; the service is the sanctioned excuse to keep ours.
class StreamService : Service() {

    private var thread: Thread? = null
    private var cancelled = false

    override fun onCreate() {
        super.onCreate()
        channel(this)
        startForeground(
            FOREGROUND_ID,
            holdNotification("holding the line"),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startObserving()
        return START_STICKY
    }

    override fun onDestroy() {
        cancelled = true
        thread?.interrupt()
        thread = null
        super.onDestroy()
    }

    /** a thread, not coroutines: the service outlives any ViewModel scope */
    private fun startObserving() {
        if (thread?.isAlive == true) return
        cancelled = false
        thread = Thread {
            val pairing = PairingStore(getSharedPreferences("jep", Context.MODE_PRIVATE))
            if (!pairing.isPaired) return@Thread
            val repo: ChatRepository =
                GatewayChatRepository(pairing.baseUrl ?: return@Thread, { pairing.token }, JepHttp.client())
            runCatching {
                kotlinx.coroutines.runBlocking {
                    repo.events().collect { evt ->
                        // the service hosts the stream; what is worth a
                        // notification is the policy's call, not its own
                        when (NotificationPolicy.decide(evt, AppPresence.openSessionId, AppPresence.foreground)) {
                            NotificationPolicy.Notice.FINISHED -> evt.sessionId?.let { notify(titleOf(repo, it), "finished replying") }
                            NotificationPolicy.Notice.ASKED -> evt.sessionId?.let { notify(titleOf(repo, it), "needs you") }
                            null -> Unit
                        }
                    }
                }
            }
        }.also { it.start() }
    }

    // A notification is only useful if it says which conversation it is about.
    // The event carries an id, not a title, so ask the gateway — and only when
    // there is actually something to say.
    private fun titleOf(repo: ChatRepository, sessionId: String): String =
        runCatching {
            kotlinx.coroutines.runBlocking { repo.sessions() }.firstOrNull { it.id == sessionId }?.title
        }.getOrNull()?.ifBlank { null } ?: "jep"

    private fun notify(title: String, text: String) {
        if (cancelled) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val n: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        manager.notify(System.currentTimeMillis().toInt(), n)
    }

    private fun holdNotification(text: String): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentText(text)
            .setOngoing(true)
            .build()

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val CHANNEL_ID = "jep.events"
        private const val FOREGROUND_ID = 42

        fun channel(context: Context) {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "agent activity", NotificationManager.IMPORTANCE_HIGH),
            )
        }
    }
}
