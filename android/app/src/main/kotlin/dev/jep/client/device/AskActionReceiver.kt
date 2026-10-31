package dev.jep.client.device

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import dev.jep.client.data.GatewayChatRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * The Allow / Deny buttons on an ask notification.
 *
 * The decision is the same POST the card makes, so it needs no screen and no
 * service: take the ask and the option off the intent and send them. The
 * gateway's feed then reports the ask resolved, which takes the notification
 * back.
 */
class AskActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val askId = intent.getStringExtra(EXTRA_ASK) ?: return
        val optionId = intent.getStringExtra(EXTRA_OPTION)
        val reject = intent.getBooleanExtra(EXTRA_REJECT, false)
        val done = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val pairing = PairingStore(context.getSharedPreferences("jep", Context.MODE_PRIVATE))
                val base = pairing.baseUrl
                if (base != null && pairing.isPaired) {
                    val repo = GatewayChatRepository(base, { pairing.token }, JepHttp.rpc())
                    if (reject) repo.reject(askId) else optionId?.let { repo.respond(askId, it) }
                }
            } catch (_: Throwable) {
                // the feed decides the outcome: a failed call leaves the ask
                // pending and the card still offers it
            } finally {
                done.finish()
            }
        }
    }

    companion object {
        const val ACTION = "dev.jep.client.ASK_ACTION"
        const val EXTRA_ASK = "askID"
        const val EXTRA_OPTION = "optionID"
        const val EXTRA_REJECT = "reject"
    }
}
