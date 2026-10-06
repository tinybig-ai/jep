package dev.jep.client.presentation.theme

import android.app.Activity
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.Density
import androidx.core.view.WindowCompat
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

// Ink on paper, the tinybig house style: a monochrome field, quiet surfaces
// and no accent — the only colour on screen is what the app means by it (code
// syntax, status dots). Light and dark are the same hierarchy, inverted.
//
// Every token the app touches is written out. A token left unset falls back to
// Material's baseline palette, which is a faintly purple grey — the bottom
// sheets, the branch pill and the snackbars all read lavender against this
// neutral, so the whole container ramp, the secondary and tertiary families and
// the inverse pair are given explicit greys here.
private val dark = darkColorScheme(
    primary = Color(0xFFF5F5F5),
    onPrimary = Color(0xFF0A0A0A),
    primaryContainer = Color(0xFF262626),
    onPrimaryContainer = Color(0xFFF5F5F5),
    secondary = Color(0xFFA0A0A0),
    onSecondary = Color(0xFF0A0A0A),
    secondaryContainer = Color(0xFF1F1F1F),
    onSecondaryContainer = Color(0xFFF5F5F5),
    tertiary = Color(0xFFA0A0A0),
    onTertiary = Color(0xFF0A0A0A),
    tertiaryContainer = Color(0xFF1F1F1F),
    onTertiaryContainer = Color(0xFFF5F5F5),
    background = Color(0xFF0A0A0A),
    onBackground = Color(0xFFF5F5F5),
    surface = Color(0xFF0A0A0A),
    onSurface = Color(0xFFF5F5F5),
    surfaceVariant = Color(0xFF1A1A1A),
    onSurfaceVariant = Color(0xFFA0A0A0),
    surfaceContainerLowest = Color(0xFF0D0D0D),
    surfaceContainerLow = Color(0xFF141414),
    surfaceContainer = Color(0xFF1A1A1A),
    surfaceContainerHigh = Color(0xFF1F1F1F),
    surfaceContainerHighest = Color(0xFF262626),
    // tonal surfaces would otherwise be tinted with the accent, which warms
    // every elevated card; the greys here are meant to stay grey
    surfaceTint = Color.Transparent,
    inverseSurface = Color(0xFFF5F5F5),
    inverseOnSurface = Color(0xFF0A0A0A),
    inversePrimary = Color(0xFF5C5C5C),
    outline = Color(0xFF2A2A2A),
    outlineVariant = Color(0xFF2A2A2A),
    scrim = Color(0xFF000000),
    error = Color(0xFFE5737F),
    errorContainer = Color(0xFF33181B),
    onError = Color(0xFF0A0A0A),
    onErrorContainer = Color(0xFFE5737F),
)

private val light = lightColorScheme(
    primary = Color(0xFF0A0A0A),
    onPrimary = Color(0xFFF7F7F7),
    primaryContainer = Color(0xFFE3E3E3),
    onPrimaryContainer = Color(0xFF0A0A0A),
    secondary = Color(0xFF5C5C5C),
    onSecondary = Color(0xFFF7F7F7),
    secondaryContainer = Color(0xFFEBEBEB),
    onSecondaryContainer = Color(0xFF0A0A0A),
    tertiary = Color(0xFF5C5C5C),
    onTertiary = Color(0xFFF7F7F7),
    tertiaryContainer = Color(0xFFEBEBEB),
    onTertiaryContainer = Color(0xFF0A0A0A),
    background = Color(0xFFF7F7F7),
    onBackground = Color(0xFF0A0A0A),
    surface = Color(0xFFF7F7F7),
    onSurface = Color(0xFF0A0A0A),
    surfaceVariant = Color(0xFFEBEBEB),
    onSurfaceVariant = Color(0xFF5C5C5C),
    surfaceContainerLowest = Color(0xFFFFFFFF),
    surfaceContainerLow = Color(0xFFFAFAFA),
    surfaceContainer = Color(0xFFF2F2F2),
    surfaceContainerHigh = Color(0xFFEBEBEB),
    surfaceContainerHighest = Color(0xFFE3E3E3),
    surfaceTint = Color.Transparent,
    inverseSurface = Color(0xFF2A2A2A),
    inverseOnSurface = Color(0xFFF0F0F0),
    inversePrimary = Color(0xFFA0A0A0),
    outline = Color(0xFFDADADA),
    outlineVariant = Color(0xFFDADADA),
    scrim = Color(0xFF000000),
    error = Color(0xFFB3261E),
    errorContainer = Color(0xFFFBE0DE),
    onError = Color(0xFFF7F7F7),
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

// The app backdrop, painted once behind every screen (they keep transparent
// containers so it reads through): a soft vertical gradient with a faint
// hexagon lattice that fades out towards the bottom of the screen.
@Composable
fun JepBackdrop() {
    val dark = MaterialTheme.colorScheme.background.luminance() < 0.5f
    val gradient = if (dark) listOf(Color(0xFF1C1C1C), Color(0xFF0E0E0E), Color(0xFF070707))
    else listOf(Color(0xFFFFFFFF), Color(0xFFF2F2F2), Color(0xFFE6E6E6))
    val lattice = if (dark) Color(0x10FFFFFF) else Color(0x12000000)
    Canvas(Modifier.fillMaxSize()) {
        drawRect(Brush.verticalGradient(colors = gradient, startY = 0f, endY = size.height))
        val r = 14f * density // hexagon circumradius
        val w = sqrt(3f) * r // pointy-top hex width
        val rowH = 1.5f * r
        val path = Path()
        var row = 0
        while (row * rowH < size.height + r) {
            val offsetX = if (row % 2 == 1) w / 2f else 0f
            var x = -w
            while (x < size.width + w) {
                val cx = x + offsetX
                val cy = row * rowH
                for (i in 0 until 6) {
                    val a = Math.toRadians((60 * i - 30).toDouble())
                    val p = Offset(cx + r * cos(a).toFloat(), cy + r * sin(a).toFloat())
                    if (i == 0) path.moveTo(p.x, p.y) else path.lineTo(p.x, p.y)
                }
                path.close()
                x += w
            }
            row++
        }
        drawPath(
            path,
            Brush.verticalGradient(
                colors = listOf(lattice, lattice.copy(alpha = 0f)),
                startY = 0f,
                endY = size.height * 0.75f,
            ),
        )
    }
}

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
