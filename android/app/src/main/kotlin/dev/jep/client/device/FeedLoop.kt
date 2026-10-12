package dev.jep.client.device

import dev.jep.client.data.GatewayChatRepository
import dev.jep.client.domain.repository.ChatEvent
import dev.jep.client.domain.repository.ChatRepository
import kotlinx.coroutines.delay

/**
 * Hold the gateway's push feed for as long as [running] says so.
 *
 * A feed ends when its connection does: a daemon restart, a network change,
 * the radio going to sleep. Collected once, the first of those ended the
 * service's thread, and notifications stopped until the app happened to start
 * the service again. So the feed is opened again after every end, waiting
 * longer while the gateway stays away and starting over once it delivers.
 *
 * The pairing is read each time round, not once: a phone paired after the
 * service started, or re-paired with another machine, is followed there.
 */
internal suspend fun followFeed(
    pairing: PairingStore,
    running: () -> Boolean,
    firstWaitMs: Long = 1_000L,
    maxWaitMs: Long = 30_000L,
    connect: (base: String) -> ChatRepository = { base -> GatewayChatRepository(base, { pairing.token }, JepHttp.client()) },
    onEvent: suspend (ChatRepository, ChatEvent) -> Unit,
) {
    var wait = firstWaitMs
    var repo: ChatRepository? = null
    var repoBase: String? = null
    while (running()) {
        val base = pairing.baseUrl
        if (pairing.isPaired && base != null) {
            if (base != repoBase) {
                repo = connect(base)
                repoBase = base
            }
            val r = repo!!
            runCatching {
                r.events().collect { evt ->
                    if (evt !is ChatEvent.Lost) wait = firstWaitMs
                    onEvent(r, evt)
                }
            }
        }
        if (!running()) break
        delay(wait)
        wait = (wait * 2).coerceAtMost(maxWaitMs)
    }
}
