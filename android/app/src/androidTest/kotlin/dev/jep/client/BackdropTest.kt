package dev.jep.client

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.PixelMap
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.jep.client.domain.model.ChatMessage
import dev.jep.client.domain.model.ChatPart
import dev.jep.client.domain.model.Model
import dev.jep.client.domain.model.Role
import dev.jep.client.domain.model.TokenUsage
import dev.jep.client.domain.repository.ModelChoices
import dev.jep.client.presentation.chat.ChatScreen
import dev.jep.client.presentation.chat.ChatViewModel
import dev.jep.client.presentation.theme.JepBackdrop
import dev.jep.client.presentation.theme.JepTheme
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.math.abs
import kotlin.math.roundToInt

// The backdrop is one gradient behind every screen, painted at full height. A
// surface drawn over it in a fixed colour matches it at one height only, so the
// chat's own bands (composer, status line) must let it through. The chat sits
// in the top quarter here, which is where an open keyboard pushes the composer:
// that is where the old opaque composer showed as a dark band.
@RunWith(AndroidJUnit4::class)
class BackdropTest {

    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private fun setChat(vm: ChatViewModel) = rule.setContent {
        JepTheme(darkTheme = true) {
            Box(Modifier.fillMaxSize()) {
                JepBackdrop()
                Box(Modifier.fillMaxWidth().fillMaxHeight(0.3f)) {
                    ChatScreen(vm, onBack = {}, onNew = {}, onForgetPairing = {})
                }
            }
        }
    }

    /** mean grey level of a small patch, so a lattice hairline cannot decide it */
    private fun PixelMap.level(cx: Int, cy: Int, r: Int = 3): Double {
        var sum = 0.0
        var n = 0
        for (x in cx - r..cx + r) for (y in cy - r..cy + r) {
            val c = this[x.coerceIn(0, width - 1), y.coerceIn(0, height - 1)]
            sum += (c.red + c.green + c.blue) / 3.0 * 255
            n++
        }
        return sum / n
    }

    private fun assertSeamless(what: String, inside: Double, outside: Double) =
        assertTrue("$what differs from the backdrop next to it: $inside vs $outside", abs(inside - outside) < 4)

    @Test
    fun the_composer_lets_the_backdrop_through_wherever_it_sits() {
        setChat(ChatViewModel(FakeChatRepository(), "s1", "T"))
        rule.waitForIdle()
        val field: Rect = rule.onNodeWithTag("composer").fetchSemanticsNode().boundsInRoot
        val px = rule.onRoot().captureToImage().toPixelMap()
        val dp = rule.density.density
        val x = (field.left - 5 * dp).roundToInt() // the composer's own margin, beside the field
        val inside = px.level(x, field.center.y.roundToInt())
        val outside = px.level(x, (field.top - 20 * dp).roundToInt()) // above the composer, in the list
        assertSeamless("the composer", inside, outside)
    }

    @Test
    fun the_status_line_lets_the_backdrop_through() {
        val choices = ModelChoices(listOf(Model("opencode", "test-model", contextLimit = 32_000)), "opencode/test-model")
        val reply = ChatMessage(
            "a0", Role.ASSISTANT, 1, listOf(ChatPart.Text("hi")),
            model = "opencode/test-model", tokens = TokenUsage(input = 1_200),
        )
        setChat(ChatViewModel(FakeChatRepository(messages = listOf(reply), choices = choices), "s1", "T"))
        rule.waitUntil(10_000) { rule.onAllNodesWithText("test-model", substring = true).fetchSemanticsNodes().isNotEmpty() }
        val line = rule.onNodeWithText("test-model", substring = true).fetchSemanticsNode().boundsInRoot
        val px = rule.onRoot().captureToImage().toPixelMap()
        val dp = rule.density.density
        val x = (px.width * 0.75).roundToInt() // past the status text, still on its strip
        val inside = px.level(x, line.center.y.roundToInt())
        val outside = px.level(x, (line.top - 8 * dp).roundToInt()) // the transparent title bar
        assertSeamless("the status line", inside, outside)
    }
}
