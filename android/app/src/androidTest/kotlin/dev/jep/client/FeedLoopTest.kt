package dev.jep.client

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.jep.client.device.PairingStore
import dev.jep.client.device.followFeed
import dev.jep.client.domain.repository.ChatEvent
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Collections
import kotlin.concurrent.thread

// The background service's hold on the push feed (followFeed), against real
// gateways on loopback ports. Each /stream here answers one event and hangs
// up, the way a feed ends when its connection does.
@RunWith(AndroidJUnit4::class)
class FeedLoopTest {

    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    // a store of its own: the app's pairing is left alone
    private val prefs = context.getSharedPreferences("jep-feed-test", Context.MODE_PRIVATE)
    private val gateways = mutableListOf<LocalGateway>()
    @Volatile private var running = true

    @After
    fun tearDown() {
        running = false
        gateways.forEach { it.close() }
        prefs.edit().clear().commit()
    }

    private fun gateway() = LocalGateway(
        mutableMapOf("/stream" to (200 to "data: {\"type\":\"session.changed\",\"sessionID\":\"s1\"}\n\n")),
    ).also { gateways += it }

    private fun waitFor(ms: Long = 10_000, what: String, cond: () -> Boolean) {
        val until = System.currentTimeMillis() + ms
        while (!cond()) {
            check(System.currentTimeMillis() < until) { "timed out: $what" }
            Thread.sleep(20)
        }
    }

    @Test
    fun the_feed_is_opened_again_after_it_ends_and_follows_a_new_pairing() {
        val first = gateway()
        val second = gateway()
        val pairing = PairingStore(prefs)
        pairing.save(first.base, "token-a")
        val heard = Collections.synchronizedList(mutableListOf<ChatEvent>())
        thread(isDaemon = true) {
            kotlinx.coroutines.runBlocking {
                followFeed(pairing, running = { running }, firstWaitMs = 50, maxWaitMs = 200) { _, evt -> heard += evt }
            }
        }
        waitFor(what = "a second subscription") { first.paths().count { it == "/stream" } >= 2 }
        waitFor(what = "an event from each") { heard.count { it is ChatEvent.Changed } >= 2 }
        pairing.save(second.base, "token-b")
        waitFor(what = "the new machine's feed") { second.seen.any { it == "/stream Bearer token-b" } }
    }
}
