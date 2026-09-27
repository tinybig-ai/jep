package dev.jep.client.presentation.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.dp

/**
 * The app's spacing scale. There was none — every gap was a number typed where
 * it was used, so two rows meant to align drifted apart. These are the few
 * sizes the screens actually share; anything genuinely local stays local.
 */
object Spacing {
    /** page side padding, the inset every screen's content hangs from */
    val gutter = 16.dp

    /** between a control and its neighbour in a list */
    val row = 12.dp

    /** between tightly related things (an icon and its label) */
    val tight = 8.dp
}

/**
 * The app's corner radii, in one place. These were ad-hoc numbers too, and they
 * had drifted upward: 24dp on the composer, 18dp on bubbles, 16dp on the ask
 * bar, next to 7dp on a text-size segment. Nothing was coordinating, so the app
 * read as a set of unrelated pills rather than one product.
 *
 * The steps are close together on purpose. A big visible jump from 6 to 16 is
 * what made the old values look arbitrary; a tight ladder reads as deliberate.
 * Anything that should be a pill is [pill], not a big radius.
 */
object Radius {
    /** a selected segment, a tiny chip */
    val chip = 6.dp

    /** a small surface: a thumbnail, an attachment card */
    val control = 8.dp

    /** a card or panel: the ask bar, a dropdown, a commit card */
    val card = 12.dp

    /** a message bubble */
    val bubble = 14.dp

    /** the composer's input, the largest radius in the app */
    val field = 16.dp
}

/** fully rounded — for a badge or a tag, where "how round" is the point */
val pill = RoundedCornerShape(percent = 50)
