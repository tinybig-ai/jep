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
        var url = withScheme.toHttpUrlOrNull()
        if (url == null) {
            // people type "host: 8931"; OkHttp won't, so shrug the space off
            url = withScheme.replace(Regex(":\\s+"), ":").toHttpUrlOrNull() ?: return null
        }
        return url.toString().trimEnd('/')
    }

    fun save(base: String, tokenValue: String) {
        baseUrl = base.trimEnd('/')
        token = tokenValue
    }

    /** The code the daemon will accept next, handed over when a pairing or a
     * terminal unlock succeeds. The daemon rotates its code per use, so the
     * one the person just proved is already spent — this is the live one, and
     * it saves them going to read it off the machine. */
    var nextCode: String?
        get() = prefs.getString(KEY_NEXT_CODE, null)
        private set(value) = prefs.edit().putString(KEY_NEXT_CODE, value).apply()

    fun rememberCode(code: String?) {
        if (!code.isNullOrBlank()) nextCode = code
    }

    fun forget() {
        baseUrl = null
        token = null
        nextCode = null
    }

    // token and base ride SharedPreferences' simple storage: fine on the
    // private profile the app owns, and reversible with Forget Pairing.
    private companion object {
        const val KEY_BASE = "gateway_base"
        const val KEY_TOKEN = "gateway_token"
        const val KEY_NEXT_CODE = "gateway_next_code"
    }
}
