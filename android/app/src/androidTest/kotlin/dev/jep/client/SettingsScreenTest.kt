package dev.jep.client

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.isToggleable
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.jep.client.device.ThemeMode
import dev.jep.client.domain.model.TerminalAccess
import dev.jep.client.presentation.settings.SettingsScreen
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

// The app-wide settings view: appearance, the coupon-gated terminal feature,
// and the connection read-out.
@RunWith(AndroidJUnit4::class)
class SettingsScreenTest {

    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun picking_a_theme_reports_it() {
        var picked: ThemeMode? = null
        show(theme = ThemeMode.SYSTEM, onTheme = { picked = it })
        rule.onNodeWithText("Dark").performClick()
        assertEquals(ThemeMode.DARK, picked)
    }

    @Test
    fun enabling_the_terminal_asks_for_the_pairing_code() {
        show(theme = ThemeMode.SYSTEM, terminalEnabled = false)
        rule.onNodeWithContentDescription("In-chat terminal").performClick()
        rule.onNodeWithText("Enable terminal").assertExists()
        rule.onNodeWithText("Pairing code").assertExists()
    }

    @Test
    fun turning_the_terminal_off_reports_it() {
        var disabled = false
        show(theme = ThemeMode.SYSTEM, terminalEnabled = true, onDisable = { disabled = true })
        rule.onNodeWithContentDescription("In-chat terminal").performClick()
        assertTrue(disabled)
    }

    @Test
    fun the_connection_is_shown() {
        show(theme = ThemeMode.SYSTEM, gateway = "http://100.0.0.1:8931")
        rule.onNodeWithText("http://100.0.0.1:8931").assertExists()
    }

    private fun show(
        theme: ThemeMode,
        terminalEnabled: Boolean = false,
        gateway: String? = null,
        onTheme: (ThemeMode) -> Unit = {},
        onUnlockTerminal: (String, (Boolean) -> Unit) -> Unit = { _, _ -> },
        onDisable: () -> Unit = {},
    ) {
        rule.setContent {
            SettingsScreen(
                theme = theme,
                terminalEnabled = terminalEnabled,
                backgroundStreaming = true,
                knownCode = null,
                terminalAccess = TerminalAccess(allowed = true, authorized = false),
                gateway = gateway,
                onBack = {},
                onTheme = onTheme,
                onUnlockTerminal = onUnlockTerminal,
                onDisableTerminal = onDisable,
                onBackgroundStreaming = {},
                onReconnect = { _, _, done -> done(false) },
            )
        }
    }
}
