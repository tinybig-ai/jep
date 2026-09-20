package dev.jep.client.device

import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

// One client for the whole app: command calls and the push feed share it, so
// connection pools are shared and the feed gets pings that keep NAT paths warm.
object JepHttp {
    fun client(): OkHttpClient = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS) // the stream never ends on its own
        .build()
}
