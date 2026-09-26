package dev.jep.client.data

import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetSocketAddress

// The newest history page is polled every 1.2s during a turn. The client sends
// back the tag of the page it holds, and an "unchanged" answer must hand back
// that page, not an empty one.
class HistoryEtagTest {

    @Test
    fun `an unchanged page is served from what the client already holds`() {
        val seen = mutableListOf<String>()
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/history") { ex ->
            val body = ex.requestBody.readBytes().decodeToString()
            seen += body
            val reply = if (body.contains("\"etag\":\"t1\"")) {
                """{"unchanged":true,"etag":"t1"}"""
            } else {
                """{"messages":[{"id":"m1","role":"assistant","time":1,"parts":[{"kind":"text","text":"hello"}]}],"hasMore":false,"asks":[],"etag":"t1"}"""
            }
            val bytes = reply.encodeToByteArray()
            ex.sendResponseHeaders(200, bytes.size.toLong())
            ex.responseBody.use { it.write(bytes) }
        }
        server.start()
        try {
            val repo = GatewayChatRepository("http://127.0.0.1:${server.address.port}", { "tok" }, OkHttpClient())
            val first = runBlocking { repo.history("s1", limit = 30) }
            val second = runBlocking { repo.history("s1", limit = 30) }
            assertTrue("the first ask holds nothing to tag", !seen[0].contains("etag"))
            assertTrue("the second sends the tag it holds", seen[1].contains("\"etag\":\"t1\""))
            assertEquals(first, second)
            assertEquals("m1", second.messages.single().id)
            // an older page is fetched once and never tagged
            runBlocking { repo.history("s1", limit = 30, before = 5) }
            assertTrue(!seen[2].contains("etag"))
        } finally {
            server.stop(0)
        }
    }
}
