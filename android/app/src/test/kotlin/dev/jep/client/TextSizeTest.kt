package dev.jep.client

import dev.jep.client.domain.model.TextSize
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// The text-size steps: an absent or unknown name falls back to the default
// rather than crashing on launch (an old build, a hand-edited prefs file), and
// the factors are ordered and distinct so the choice is worth having.
class TextSizeTest {

    @Test
    fun an_absent_or_unknown_name_is_the_default_step() {
        assertEquals(TextSize.DEFAULT, TextSize.from(null))
        assertEquals(TextSize.DEFAULT, TextSize.from(""))
        assertEquals(TextSize.DEFAULT, TextSize.from("ENORMOUS"))
    }

    @Test
    fun a_known_name_is_its_own_step() {
        TextSize.entries.forEach { assertEquals(it, TextSize.from(it.name)) }
    }

    @Test
    fun the_steps_rise_and_none_are_the_same() {
        val scales = TextSize.entries.map { it.scale }
        assertTrue("small is smaller than the default", scales.first() < 1f)
        assertEquals(scales.sorted(), scales)
        assertEquals(TextSize.entries.size, scales.toSet().size)
    }
}
