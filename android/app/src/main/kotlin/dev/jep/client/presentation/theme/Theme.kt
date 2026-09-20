package dev.jep.client.presentation.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// The palette reads like the reference app: near-black field, quiet surfaces,
// warm accent, generous white for the words that matter. Light is the same
// hierarchy inverted.
private val terracotta = Color(0xFFD97757)
private val dark = darkColorScheme(
    primary = terracotta,
    onPrimary = Color(0xFF171716),
    background = Color(0xFF131312),
    onBackground = Color(0xFFF2F1ED),
    surface = Color(0xFF1B1B19),
    onSurface = Color(0xFFE4E3DE),
    surfaceVariant = Color(0xFF242422),
    onSurfaceVariant = Color(0xFFA9A8A1),
    surfaceContainer = Color(0xFF202020),
    outline = Color(0xFF393936),
    error = Color(0xFFE56B5D),
)

private val light = lightColorScheme(
    primary = terracotta,
    onPrimary = Color(0xFFFFFFFF),
    background = Color(0xFFFAF9F5),
    onBackground = Color(0xFF1A1A18),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF262624),
    surfaceVariant = Color(0xFFEFEEE8),
    onSurfaceVariant = Color(0xFF6E6D66),
    surfaceContainer = Color(0xFFF1F0EA),
    outline = Color(0xFFDEDDD5),
    error = Color(0xFFB3402E),
)

@Composable
fun JepTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) dark else light,
        content = content,
    )
}
