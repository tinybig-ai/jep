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
                        when (evt) {
                            is dev.jep.client.domain.repository.ChatEvent.Asked -> notify("the harness asks", evt.ask.title)
                            is dev.jep.client.domain.repository.ChatEvent.Failed -> {
                                // A stop you asked for is not a failure. The chat
                                // view already knows this; the service did not, so
                                // pressing stop raised "harness failed" with the
                                // harness's raw error payload as the body.
                                if (!evt.error.isAbort()) notify("turn failed", humanError(evt.error))
                            }
                            is dev.jep.client.domain.repository.ChatEvent.Lost -> Unit
                            else -> Unit
                        }
                    }
                }
            }
        }.also { it.start() }
    }

    // the harness reports errors as JSON; a notification wants a sentence
    private fun humanError(raw: String): String =
        Regex("\"message\"\\s*:\\s*\"([^\"]+)\"").find(raw)?.groupValues?.get(1)
            ?: raw.take(140)

    private fun String.isAbort(): Boolean = contains("abort", ignoreCase = true)

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
