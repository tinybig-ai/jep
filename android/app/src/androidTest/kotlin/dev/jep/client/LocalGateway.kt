package dev.jep.client

import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.Collections
import kotlin.concurrent.thread

/**
 * A gateway on a loopback port, for the tests that need the real repository
 * and its HTTP client rather than the fake port. One request per connection.
 * `answer` maps a path to a status and a body; a path it does not know gets
 * 200 and `{}`. `hang` names paths that are read and then never answered.
 */
class LocalGateway(
    val answer: MutableMap<String, Pair<Int, String>> = mutableMapOf(),
    val hang: MutableSet<String> = Collections.synchronizedSet(mutableSetOf()),
) : AutoCloseable {
    private val server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
    val base: String = "http://127.0.0.1:${server.localPort}"

    /** every request seen, as "path authorization" */
    val seen: MutableList<String> = Collections.synchronizedList(mutableListOf())
    private val open = Collections.synchronizedList(mutableListOf<Socket>())

    init {
        thread(isDaemon = true, name = "local-gateway") {
            while (!server.isClosed) {
                val socket = runCatching { server.accept() }.getOrNull() ?: break
                open += socket
                thread(isDaemon = true) { serve(socket) }
            }
        }
    }

    private fun serve(socket: Socket) {
        runCatching {
            val input = BufferedReader(InputStreamReader(socket.getInputStream()))
            val line = input.readLine() ?: return
            val path = line.split(" ").getOrNull(1)?.substringBefore('?') ?: "/"
            var length = 0
            var auth = ""
            while (true) {
                val h = input.readLine() ?: break
                if (h.isEmpty()) break
                val (k, v) = h.split(":", limit = 2).map { it.trim() }.let { it[0].lowercase() to it.getOrElse(1) { "" } }
                if (k == "content-length") length = v.toIntOrNull() ?: 0
                if (k == "authorization") auth = v
            }
            repeat(length) { input.read() }
            seen += "$path $auth".trim()
            if (path in hang) return // hold the socket open, say nothing
            val (status, body) = answer[path] ?: (200 to "{}")
            val bytes = body.toByteArray()
            socket.getOutputStream().apply {
                write("HTTP/1.1 $status X\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
                write(bytes)
                flush()
            }
            socket.close()
        }
    }

    fun paths(): List<String> = synchronized(seen) { seen.map { it.substringBefore(' ') } }

    override fun close() {
        runCatching { server.close() }
        synchronized(open) { open.forEach { runCatching { it.close() } } }
    }
}
