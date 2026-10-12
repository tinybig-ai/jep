package dev.jep.client

import android.app.Application
import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.jep.client.presentation.app.AppViewModel
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

// The app view model against real gateways on loopback ports: pairing, and
// what the app does with the gateway's answers.
@RunWith(AndroidJUnit4::class)
class AppConnectionTest {

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as Application
    private val prefs = app.getSharedPreferences("jep", Context.MODE_PRIVATE)
    private var saved: Map<String, *> = emptyMap<String, Any>()
    private val gateways = mutableListOf<LocalGateway>()

    // the test shares the app's own preferences: keep whatever pairing the
    // device had, and put it back afterwards
    @Before
    fun clearPairing() {
        saved = prefs.all.toMap()
        prefs.edit().clear().commit()
    }

    @After
    fun restorePairing() {
        gateways.forEach { it.close() }
        val e = prefs.edit().clear()
        saved.forEach { (k, v) ->
            when (v) {
                is String -> e.putString(k, v)
                is Boolean -> e.putBoolean(k, v)
                is Int -> e.putInt(k, v)
                is Long -> e.putLong(k, v)
                is Float -> e.putFloat(k, v)
                is Set<*> -> e.putStringSet(k, v.filterIsInstance<String>().toSet())
            }
        }
        e.commit()
    }

    private fun gateway(token: String) =
        LocalGateway(mutableMapOf("/pair" to (200 to """{"token":"$token"}"""))).also { gateways += it }

    private fun waitFor(ms: Long = 5_000, what: String, cond: () -> Boolean) {
        val until = System.currentTimeMillis() + ms
        while (!cond()) {
            check(System.currentTimeMillis() < until) { "timed out: $what" }
            Thread.sleep(20)
        }
    }

    private fun pair(vm: AppViewModel, gw: LocalGateway) {
        var ok: Boolean? = null
        var why: String? = null
        instrumentation.runOnMainSync { vm.pair(gw.base, "CODE") { done, err -> why = err; ok = done } }
        waitFor(what = "pairing with ${gw.base}") { ok != null }
        assertTrue("pairing with ${gw.base} failed: $why (seen ${gw.seen})", ok == true)
    }

    @Test
    fun pairing_with_another_machine_talks_to_that_machine() {
        val first = gateway("token-a")
        val second = gateway("token-b")
        lateinit var vm: AppViewModel
        instrumentation.runOnMainSync { vm = AppViewModel(app) }
        pair(vm, first)
        waitFor(what = "the first machine's list") { "/sessions" in first.paths() }
        pair(vm, second)
        instrumentation.runOnMainSync { vm.refresh() }
        waitFor(what = "the second machine's list") { second.seen.any { it == "/sessions Bearer token-b" } }
    }
}
