package dev.jep.client

import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.jep.client.data.GatewayChatRepository
import dev.jep.client.device.JepHttp
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

// A gateway that takes a request and never answers: what a socket that died
// without a reset looks like from the phone.
@RunWith(AndroidJUnit4::class)
class TimeoutTest {

    private val gw = LocalGateway(hang = mutableSetOf("/history", "/prompt"))

    @After
    fun tearDown() = gw.close()

    private fun repo() = GatewayChatRepository(gw.base, { "t" }, JepHttp.rpc(readTimeoutMs = 500), long = JepHttp.client())

    @Test
    fun a_command_call_gives_up_on_a_silent_gateway() = runBlocking {
        val started = System.currentTimeMillis()
        val outcome = runCatching { repo().history("s1", limit = 30) }
        assertTrue("a history read to a silent gateway did not fail", outcome.isFailure)
        assertTrue("it took ${System.currentTimeMillis() - started}ms", System.currentTimeMillis() - started < 5_000)
    }

    @Test
    fun a_prompt_waits_for_the_turn_however_long_it_is_silent() = runBlocking {
        // the turn is answered only when the harness is done: silence is normal
        val prompt = async(kotlinx.coroutines.Dispatchers.IO) { runCatching { repo().prompt("s1", "hi", emptyList()) } }
        delay(2_000)
        assertFalse("a prompt gave up while its turn was still running", prompt.isCompleted)
        gw.close()
        prompt.await()
        Unit
    }
}
