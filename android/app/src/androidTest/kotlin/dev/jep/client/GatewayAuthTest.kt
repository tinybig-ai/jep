package dev.jep.client

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import coil3.request.ImageRequest
import dev.jep.client.data.GatewayChatRepository
import dev.jep.client.device.JepHttp
import dev.jep.client.device.PairingStore
import dev.jep.client.device.jepImageLoader
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

// Workspace images are fetched by the image loader, not the repository: the
// token goes with them as a header, to the paired gateway only.
@RunWith(AndroidJUnit4::class)
class GatewayAuthTest {

    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val prefs = context.getSharedPreferences("jep-auth-test", Context.MODE_PRIVATE)
    private val gateway = LocalGateway()
    private val elsewhere = LocalGateway()

    @After
    fun tearDown() {
        gateway.close()
        elsewhere.close()
        prefs.edit().clear().commit()
    }

    @Test
    fun a_file_url_carries_no_token_and_the_loader_signs_only_the_gateway() = runBlocking {
        val pairing = PairingStore(prefs).apply { save(gateway.base, "secret") }
        val url = GatewayChatRepository(gateway.base, { "secret" }, JepHttp.rpc()).fileUrl("shot.png", "s1")
        assertFalse("the token is in the URL: $url", url.contains("secret"))

        val loader = jepImageLoader(context, pairing)
        loader.execute(ImageRequest.Builder(context).data(url).build())
        assertTrue("the gateway was not signed for: ${gateway.seen}", gateway.seen.any { it == "/file Bearer secret" })

        loader.execute(ImageRequest.Builder(context).data("${elsewhere.base}/cat.png").build())
        assertEquals("another host got the token", listOf("/cat.png"), elsewhere.seen.toList())
    }
}
