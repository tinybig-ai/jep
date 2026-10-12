package dev.jep.client

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.jep.client.presentation.chat.Spinner
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

// The turn's spinner is composed afresh when it moves from the "awaiting" row
// into the reply. A fresh one must pick up where the old one was, not start
// over: Material's spinner starts from an almost empty arc, which blinked.
@RunWith(AndroidJUnit4::class)
class SpinnerTest {

    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun a_spinner_composed_later_shows_what_one_already_running_shows() {
        var second by mutableStateOf(false)
        rule.mainClock.autoAdvance = false
        rule.setContent {
            Column {
                Spinner()
                if (second) Spinner()
            }
        }
        rule.mainClock.advanceTimeBy(500)
        second = true
        rule.mainClock.advanceTimeByFrame()
        rule.mainClock.advanceTimeByFrame()
        assertTrue("two spinners", rule.onAllNodesWithTag("responding-spinner").fetchSemanticsNodes().size == 2)
        val image = rule.onAllNodesWithTag("responding-spinner")
        val first = image[0].captureToImage().toPixelMap()
        val later = image[1].captureToImage().toPixelMap()
        var differ = 0
        var inked = 0
        for (x in 0 until first.width) for (y in 0 until first.height) {
            if (first[x, y] != later[x, y]) differ++
            if (later[x, y].alpha > 0.5f) inked++
        }
        assertTrue("the new spinner draws next to nothing ($inked px)", inked > first.width * first.height / 6)
        assertTrue("the new spinner is not where the running one is ($differ px differ)", differ <= first.width * first.height / 20)
        rule.mainClock.autoAdvance = true
    }
}
