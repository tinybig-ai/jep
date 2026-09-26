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
import dev.jep.client.domain.repository.ChatEvent
import kotlinx.coroutines.launch
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
                    val scope = this
                    repo.events().collect { evt ->
                        // an ask settled anywhere takes its "needs you" back:
                        // one left standing sends the person to a card that is
                        // already gone
                        if (evt is ChatEvent.AskResolved) {
                            pendingAsks.remove(evt.askId)
                            if (pendingAsks.none { it.value == evt.sessionId }) {
                                Notifications.withdraw(this@StreamService, evt.sessionId, Notifications.ASKED)
                            }
                        }
                        if (evt is ChatEvent.Asked) pendingAsks[evt.ask.id] = evt.sessionId
                        // the service hosts the stream; what is worth a
                        // notification is the policy's call, not its own
                        when (NotificationPolicy.decide(evt, AppPresence.openSessionId, AppPresence.foreground)) {
                            NotificationPolicy.Notice.FINISHED -> evt.sessionId?.let {
                                Notifications.withdraw(this@StreamService, it, Notifications.ASKED)
                                notify(titleOf(repo, it), "finished replying", it, Notifications.FINISHED)
                            }
                            NotificationPolicy.Notice.ASKED -> (evt as? ChatEvent.Asked)?.let { asked ->
                                // An ask a harness answers itself (an "always
                                // allow" rule) is raised and settled within a
                                // moment; announcing it was the false "needs
                                // you". Only one still open after a beat is.
                                // waited apart from the feed, which must keep
                                // reading or the resolution could never arrive
                                scope.launch {
                                    kotlinx.coroutines.delay(ASK_GRACE_MS)
                                    if (pendingAsks.containsKey(asked.ask.id)) {
                                        notify(titleOf(repo, asked.sessionId), "needs you", asked.sessionId, Notifications.ASKED)
                                    }
                                }
                            }
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

    // asks surfaced and not yet settled, id -> conversation
    private val pendingAsks = java.util.concurrent.ConcurrentHashMap<String, String>()

    private fun notify(title: String, text: String, sessionId: String, kind: Int) {
        if (cancelled) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        // Tapping it should land in the conversation it is about, not on the
        // list. The id rides the intent, and the request code is per
        // conversation — otherwise Android reuses the first notification's
        // intent and every tap opens the same chat.
        val open = PendingIntent.getActivity(
            this, sessionId.hashCode(),
            Intent(this, MainActivity::class.java)
                .putExtra(MainActivity.EXTRA_SESSION, sessionId)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(open)
            .setAutoCancel(true)
            // A group of its own, per conversation. Left ungrouped, Android
            // bundles the app's notifications (this one and the standing
            // "holding the line") under a summary it makes itself, and tapping
            // that summary opens the app's launcher, which is the list: the tap
            // landed on the list or in the chat depending on where the finger
            // hit. Android only bundles notifications that have no group.
            .setGroup("jep:$sessionId")
            .build()
        // one per conversation and kind, so a newer one replaces an older one
        // and opening the chat can take them back (Notifications.clear)
        manager.notify(sessionId, kind, n)
    }

    // the standing notification a foreground service must show: on a quiet
    // channel of its own, and in its own group, so it is never bundled with the
    // ones that matter (see notify)
    private fun holdNotification(text: String): Notification =
        NotificationCompat.Builder(this, HOLD_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentText(text)
            .setOngoing(true)
            .setGroup("jep:hold")
            .build()

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val CHANNEL_ID = "jep.events"
        private const val HOLD_CHANNEL_ID = "jep.hold"
        private const val FOREGROUND_ID = 42
        private const val ASK_GRACE_MS = 1_500L

        fun channel(context: Context) {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "agent activity", NotificationManager.IMPORTANCE_HIGH),
            )
            manager.createNotificationChannel(
                NotificationChannel(HOLD_CHANNEL_ID, "staying connected", NotificationManager.IMPORTANCE_MIN),
            )
        }
    }
}
