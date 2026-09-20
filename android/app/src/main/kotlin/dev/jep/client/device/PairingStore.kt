package dev.jep.client.device

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

// Where the phone remembers how to reach the gateway. Device-layer concern:
// the rest of the app sees plain values.
class PairingStore(private val prefs: android.content.SharedPreferences) {

    var baseUrl: String?
        get() = prefs.getString(KEY_BASE, null)
        private set(value) = prefs.edit().putString(KEY_BASE, value).apply()

    var token: String?
        get() = prefs.getString(KEY_TOKEN, null)
        private set(value) = prefs.edit().putString(KEY_TOKEN, value).apply()

    val isPaired: Boolean get() = token != null && baseUrl?.startsWith("http") == true

    /** normalizes "host:port" or "http://host:port" into an http:// base */
    fun normalize(input: String): String? {
        val trimmed = input.trim()
        if (trimmed.isEmpty()) return null
        val withScheme = if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) trimmed else "http://$trimmed"
        val url = withScheme.toHttpUrlOrNull() ?: return null
        return url.toString().trimEnd('/')
    }

    fun save(base: String, tokenValue: String) {
        baseUrl = base.trimEnd('/')
        token = tokenValue
    }

    fun forget() {
        baseUrl = null
        token = null
    }

    // token and base ride SharedPreferences' simple storage: fine on the
    // private profile the app owns, and reversible with Forget Pairing.
    private companion object {
        const val KEY_BASE = "gateway_base"
        const val KEY_TOKEN = "gateway_token"
    }
}
