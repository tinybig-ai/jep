package dev.jep.client.device

import android.content.SharedPreferences

// The user's app-wide preferences — not the per-conversation settings, which
// live on the session. Device-layer concern: the rest of the app sees values.
enum class ThemeMode { SYSTEM, LIGHT, DARK }

class AppSettings(private val prefs: SharedPreferences) {

    val theme: ThemeMode
        get() = runCatching { ThemeMode.valueOf(prefs.getString(KEY_THEME, null) ?: "") }
            .getOrDefault(ThemeMode.SYSTEM)

    /** whether the in-conversation terminal is offered at all.
     * Read via `all` and cast rather than getBoolean: a value of the wrong type
     * (an old build, a hand-edited prefs file) makes getBoolean throw, and this
     * is read while building the app-wide ViewModel — a crash on launch. */
    val terminalEnabled: Boolean
        get() = (prefs.all[KEY_TERMINAL] as? Boolean) ?: false

    /** Whether the app keeps its push feed alive while backgrounded. Off
     * means no foreground service, and therefore no notifications — the
     * trade the user makes is the persistent notification itself. Default on:
     * a notification about a finished turn is the reason the service exists. */
    val backgroundStreaming: Boolean
        get() = (prefs.all[KEY_STREAM] as? Boolean) ?: true

    fun setTheme(mode: ThemeMode) = prefs.edit().putString(KEY_THEME, mode.name).apply()

    fun setBackgroundStreaming(enabled: Boolean) = prefs.edit().putBoolean(KEY_STREAM, enabled).apply()

    fun setTerminalEnabled(enabled: Boolean) = prefs.edit().putBoolean(KEY_TERMINAL, enabled).apply()

    private companion object {
        const val KEY_THEME = "app_theme"
        const val KEY_TERMINAL = "app_terminal_enabled"
        const val KEY_STREAM = "app_background_streaming"
    }
}
