package dev.jep.client

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.isToggleable
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.jep.client.device.ThemeMode
import dev.jep.client.presentation.settings.SettingsScreen
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

// The app-wide settings view: appearance, the terminal feature toggle, and the
// connection read-out.
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
    fun the_terminal_feature_is_toggleable_here() {
        var enabled: Boolean? = null
        show(theme = ThemeMode.SYSTEM, terminalEnabled = false, onTerminal = { enabled = it })
        rule.onNodeWithText("In-chat terminal").assertExists()
        rule.onNode(isToggleable()).performClick() // the only switch on this screen
        assertEquals(true, enabled)
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
        onTerminal: (Boolean) -> Unit = {},
    ) {
        rule.setContent {
            SettingsScreen(
                theme = theme,
                terminalEnabled = terminalEnabled,
                gateway = gateway,
                onBack = {},
                onTheme = onTheme,
                onTerminal = onTerminal,
            )
        }
    }
}
