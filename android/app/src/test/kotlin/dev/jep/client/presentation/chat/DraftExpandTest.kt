package dev.jep.client.presentation.chat

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DraftExpandTest {
    @Test
    fun a_short_draft_has_nothing_to_expand() {
        assertFalse(isWorthExpanding(1))
        assertFalse(isWorthExpanding(2))
    }

    @Test
    fun three_lines_is_still_not_enough() {
        // the cluster with expand is 90dp tall, and a 3-line field is shorter
        // than that: offering it here would push the pills out of the field
        assertFalse(isWorthExpanding(3))
    }

    @Test
    fun four_lines_is_what_makes_it_worth_expanding() {
        assertTrue(isWorthExpanding(4))
        assertTrue(isWorthExpanding(5))
        assertTrue(isWorthExpanding(12))
    }
}
