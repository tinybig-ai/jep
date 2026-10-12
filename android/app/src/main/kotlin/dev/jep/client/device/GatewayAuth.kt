package dev.jep.client.device

import android.content.Context
import coil3.ImageLoader
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.Response

/**
 * Sign requests for the paired gateway with its token, and nothing else.
 *
 * The image loader fetches workspace files (/file) on its own, outside the
 * repository's header path, so the token used to ride in the URL's query.
 * A URL is copied into caches, logs and crash reports; a header is not. Only
 * the paired gateway's own scheme, host and port get it: an image linked from
 * anywhere else must never carry the pairing token there.
 */
class GatewayAuth(private val base: () -> String?, private val token: () -> String?) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val req = chain.request()
        val gateway = base()?.toHttpUrlOrNull()
        val t = token()
        val ours = gateway != null && req.url.scheme == gateway.scheme && req.url.host == gateway.host && req.url.port == gateway.port
        if (!ours || t == null || req.header("authorization") != null) return chain.proceed(req)
        return chain.proceed(req.newBuilder().header("authorization", "Bearer $t").build())
    }
}

/** the app's image loader: the shared HTTP client, signing for the gateway */
fun jepImageLoader(context: Context, pairing: PairingStore): ImageLoader =
    ImageLoader.Builder(context)
        .components {
            add(
                OkHttpNetworkFetcherFactory(
                    callFactory = {
                        JepHttp.rpc().newBuilder()
                            .addInterceptor(GatewayAuth({ pairing.baseUrl }, { pairing.token }))
                            .build()
                    },
                ),
            )
        }
        .build()
