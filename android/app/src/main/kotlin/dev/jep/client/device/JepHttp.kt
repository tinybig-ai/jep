package dev.jep.client.device

import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

// One connection pool for the whole app, so the feed's pings keep NAT paths
// warm for the command calls too. Two read timeouts on top of it:
//
// - client(): none. The push feed never ends on its own, and /prompt and
//   /compact answer only when the harness is done, minutes later.
// - rpc(): a bound for everything else. With no bound, a socket that died
//   without a reset (a network change mid-request) held a history read or a
//   session list open for good, and whatever waited on it waited for good.
object JepHttp {
    private val shared: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .pingInterval(20, TimeUnit.SECONDS)
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build()
    }

    fun client(): OkHttpClient = shared

    /** `readTimeoutMs` is the longest silence allowed while the answer is read */
    fun rpc(readTimeoutMs: Long = 60_000): OkHttpClient =
        shared.newBuilder().readTimeout(readTimeoutMs, TimeUnit.MILLISECONDS).build()
}
