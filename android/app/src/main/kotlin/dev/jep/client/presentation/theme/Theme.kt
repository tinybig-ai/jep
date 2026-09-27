package dev.jep.client.presentation.theme

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.Density
import androidx.core.view.WindowCompat

// A neutral field, quiet surfaces and one warm accent — no tint in the greys, so
// the only colour on screen is what the app means by it. Light and dark are the
// same hierarchy, inverted.
//
// Every token the app touches is written out. A token left unset falls back to
// Material's baseline palette, which is a faintly purple grey — the bottom
// sheets, the branch pill and the snackbars all read lavender against this
// neutral, so the whole container ramp, the secondary and tertiary families and
// the inverse pair are given explicit greys here.
private val terracotta = Color(0xFFD97757)

private val dark = darkColorScheme(
    primary = terracotta,
    onPrimary = Color(0xFF1B120E),
    primaryContainer = Color(0xFF3B2419),
    onPrimaryContainer = Color(0xFFF4D8CB),
    secondary = Color(0xFFB4B4B4),
    onSecondary = Color(0xFF1A1A1A),
    secondaryContainer = Color(0xFF2A2A2A),
    onSecondaryContainer = Color(0xFFE6E6E6),
    tertiary = Color(0xFF9CA3AF),
    onTertiary = Color(0xFF111827),
    tertiaryContainer = Color(0xFF27272A),
    onTertiaryContainer = Color(0xFFE5E7EB),
    background = Color(0xFF111111),
    onBackground = Color(0xFFEDEDED),
    surface = Color(0xFF171717),
    onSurface = Color(0xFFE8E8E8),
    surfaceVariant = Color(0xFF232323),
    onSurfaceVariant = Color(0xFFA1A1AA),
    surfaceContainerLowest = Color(0xFF0B0B0B),
    surfaceContainerLow = Color(0xFF191919),
    surfaceContainer = Color(0xFF1C1C1C),
    surfaceContainerHigh = Color(0xFF242424),
    surfaceContainerHighest = Color(0xFF2C2C2C),
    // tonal surfaces would otherwise be tinted with the accent, which warms
    // every elevated card; the greys here are meant to stay grey
    surfaceTint = Color.Transparent,
    inverseSurface = Color(0xFFE8E8E8),
    inverseOnSurface = Color(0xFF1A1A1A),
    inversePrimary = Color(0xFFE0805F),
    outline = Color(0xFF2E2E2E),
    outlineVariant = Color(0xFF232323),
    scrim = Color(0xFF000000),
    error = Color(0xFFF85149),
    errorContainer = Color(0xFF3B1715),
    onErrorContainer = Color(0xFFFFDAD6),
)

private val light = lightColorScheme(
    primary = terracotta,
    onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFF6E1D8),
    onPrimaryContainer = Color(0xFF3A1E12),
    secondary = Color(0xFF5A5A5A),
    onSecondary = Color(0xFFFFFFFF),
    secondaryContainer = Color(0xFFE6E6E6),
    onSecondaryContainer = Color(0xFF1A1A1A),
    tertiary = Color(0xFF4B5563),
    onTertiary = Color(0xFFFFFFFF),
    tertiaryContainer = Color(0xFFE5E7EB),
    onTertiaryContainer = Color(0xFF111827),
    background = Color(0xFFF6F6F6),
    onBackground = Color(0xFF18181B),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF18181B),
    surfaceVariant = Color(0xFFECECEC),
    onSurfaceVariant = Color(0xFF71717A),
    surfaceContainerLowest = Color(0xFFFFFFFF),
    surfaceContainerLow = Color(0xFFF0F0F0),
    surfaceContainer = Color(0xFFEFEFEF),
    surfaceContainerHigh = Color(0xFFE6E6E6),
    surfaceContainerHighest = Color(0xFFE0E0E0),
    surfaceTint = Color.Transparent,
    inverseSurface = Color(0xFF2A2A2A),
    inverseOnSurface = Color(0xFFF0F0F0),
    inversePrimary = Color(0xFFB25B3C),
    outline = Color(0xFFE0E0E0),
    outlineVariant = Color(0xFFEDEDED),
    scrim = Color(0xFF000000),
    error = Color(0xFFCF222E),
    errorContainer = Color(0xFFFBE0DE),
    onErrorContainer = Color(0xFF4A0F0B),
)

// Code and status colours, which cannot come from the scheme: they colour a
// string, not a surface. Muted enough to sit in a diff without shouting, and
// lifted in dark so they keep their contrast. One value each, read where a diff
// or the terminal is drawn; the highlighter takes its three from here too.
@Immutable
data class SyntaxColors(
    val keyword: Color,
    val string: Color,
    val number: Color,
    val added: Color,
    val removed: Color,
    val terminalBg: Color,
    val terminalFg: Color,
    val live: Color,
)

private val lightSyntax = SyntaxColors(
    keyword = Color(0xFF8250DF),
    string = Color(0xFF0A7D35),
    number = Color(0xFF0550AE),
    added = Color(0xFF1A7F37),
    removed = Color(0xFFCF222E),
    terminalBg = Color(0xFF0D0D0D),
    terminalFg = Color(0xFFD6D6D4),
    live = Color(0xFF1A7F37),
)

private val darkSyntax = SyntaxColors(
    keyword = Color(0xFFD2A8FF),
    string = Color(0xFF7EE787),
    number = Color(0xFF79C0FF),
    added = Color(0xFF3FB950),
    removed = Color(0xFFF85149),
    terminalBg = Color(0xFF0D0D0D),
    terminalFg = Color(0xFFD6D6D4),
    live = Color(0xFF3FB950),
)

/** the diff, terminal and status colours for the app's current theme */
val LocalSyntaxColors = staticCompositionLocalOf { lightSyntax }

@Composable
fun JepTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    /** the person's text-size choice, applied on top of the system font scale */
    textScale: Float = 1f,
    content: @Composable () -> Unit,
) {
    // The status and navigation bar icons must follow the APP's theme, not the
    // system's. enableEdgeToEdge() decides once, from the system's night mode, so
    // a light system with the app set to Dark leaves dark icons on our dark bar —
    // invisible. Ask the window for light icons whenever the app is dark.
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as? Activity)?.window ?: return@SideEffect
            WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = !darkTheme
                isAppearanceLightNavigationBars = !darkTheme
            }
        }
    }
    // The whole type scale — every `.sp`, including the sizes written inline in
    // the screens — scales with the person's choice, multiplied by the system's
    // own font scale so accessibility settings are honoured rather than
    // overridden. A density override is how one preference reaches text that was
    // never routed through a theme token.
    val density = LocalDensity.current
    CompositionLocalProvider(
        LocalDensity provides Density(density.density, density.fontScale * textScale),
        LocalSyntaxColors provides if (darkTheme) darkSyntax else lightSyntax,
    ) {
        MaterialTheme(
            colorScheme = if (darkTheme) dark else light,
            typography = JepTypography,
            content = content,
        )
    }
}
