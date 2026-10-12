package dev.jep.client

import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.jep.client.presentation.chat.ChatScreen
import dev.jep.client.presentation.chat.ChatViewModel
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

// The app runs edge to edge (MainActivity), so nothing pads for the system
// bars unless a screen does. The chat has no Scaffold to do it.
@RunWith(AndroidJUnit4::class)
class InsetsTest {

    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun the_composer_clears_the_navigation_bar_with_the_keyboard_down() {
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        rule.setContent { ChatScreen(ChatViewModel(FakeChatRepository(), "s1", "T"), onBack = {}, onNew = {}, onForgetPairing = {}) }
        rule.waitForIdle()
        // the test AVD has no navigation bar of its own, so hand the screen
        // one: a 48dp bar, the height of the three-button bar
        val bar = (48 * rule.density.density).toInt()
        rule.runOnUiThread {
            val content = rule.activity.findViewById<android.view.ViewGroup>(android.R.id.content).getChildAt(0)
            val insets = WindowInsetsCompat.Builder()
                .setInsets(WindowInsetsCompat.Type.navigationBars(), Insets.of(0, 0, 0, bar))
                .setVisible(WindowInsetsCompat.Type.navigationBars(), true)
                .build()
            ViewCompat.dispatchApplyWindowInsets(content, insets)
        }
        rule.waitForIdle()
        val screen = rule.onRoot().fetchSemanticsNode().boundsInRoot.bottom
        val send = rule.onNodeWithTag("send-button").fetchSemanticsNode().boundsInRoot.bottom
        assertTrue("send ends at $send, the bar starts at ${screen - bar}", send <= screen - bar)
    }
}
