package dev.conductor.mobile.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import dev.conductor.mobile.model.ThemeMode

// Core Conductor Brand & Status Palette (aligned with Desktop Tailwind zinc + indigo tokens)
val ConductorIndigo = Color(0xFF6366F1)      // indigo-500
val ConductorIndigoAction = Color(0xFF4F46E5) // indigo-600
val ConductorIndigoLight = Color(0xFFA5B4FC)  // indigo-300
val ConductorEmerald = Color(0xFF10B981)     // emerald-500
val ConductorAmber = Color(0xFFF59E0B)       // amber-500
val ConductorRose = Color(0xFFF43F5E)        // rose-500
val ConductorRed = ConductorRose             // alias kept for compatibility
val ConductorSky = Color(0xFF0EA5E9)         // sky-500

// Neutral Zinc Scale (Tailwind CSS v4 exact values + Desktop dark surfaces)
private val Zinc50 = Color(0xFFFAFAFA)
private val Zinc100 = Color(0xFFF4F4F5)
private val Zinc200 = Color(0xFFE4E4E7)
private val Zinc300 = Color(0xFFD4D4D8)
private val Zinc400 = Color(0xFFA1A1AA)
private val Zinc500 = Color(0xFF71717A)
private val Zinc600 = Color(0xFF52525B)
private val Zinc700 = Color(0xFF3F3F46)
private val Zinc800 = Color(0xFF27272A)
private val Zinc900 = Color(0xFF18181B)

// Desktop Conductor exact dark surfaces from index.html, UnifiedChat.tsx, TaskSidebar.tsx
private val DarkCanvas = Color(0xFF0F1115)          // dark:bg-[#0f1115]
private val DarkSurfaceSecondary = Color(0xFF13161C) // dark:bg-[#13161c]
private val DarkCardMuted = Color(0xFF161A22)        // dark:bg-[#161a22]
private val DarkComposer = Color(0xFF171B24)         // dark:bg-[#171b24]
private val DarkCard = Color(0xFF191D26)             // dark:bg-[#191d26]

@Immutable
data class ConductorColors(
    val isDark: Boolean,
    val canvas: Color,
    val surfaceSecondary: Color,
    val card: Color,
    val cardMuted: Color,
    val composer: Color,
    val surfaceSubtle: Color,
    val border: Color,
    val borderSubtle: Color,
    val borderStrong: Color,
    val textPrimary: Color,
    val textSecondary: Color,
    val textMuted: Color,
    val textSubtle: Color,
    val indigo: Color,
    val indigoAction: Color,
    val indigoText: Color,
    val indigoBg: Color,
    val indigoBorder: Color,
    val userBubbleBg: Color,
    val userBubbleBorder: Color,
    val userInlineCodeBg: Color,
    val userInlineCodeText: Color,
    val emerald: Color,
    val emeraldText: Color,
    val emeraldBg: Color,
    val emeraldBorder: Color,
    val amber: Color,
    val amberText: Color,
    val amberBg: Color,
    val amberBorder: Color,
    val rose: Color,
    val roseText: Color,
    val roseBg: Color,
    val roseBorder: Color,
    val sky: Color,
    val skyText: Color,
    val skyBg: Color,
    val codeBlockBg: Color,
    val codeBlockHeaderBg: Color,
    val inlineCodeBg: Color,
    val blockquoteBg: Color,
)

private val LightConductorColors = ConductorColors(
    isDark = false,
    canvas = Color.White,
    surfaceSecondary = Zinc50,
    card = Color.White,
    cardMuted = Zinc50,
    composer = Color(0xFFFAFAFC),
    surfaceSubtle = Zinc100,
    border = Zinc200,
    borderSubtle = Zinc200.copy(alpha = 0.75f),
    borderStrong = Zinc300,
    textPrimary = Zinc900,
    textSecondary = Zinc600,
    textMuted = Zinc500,
    textSubtle = Zinc400,
    indigo = ConductorIndigo,
    indigoAction = ConductorIndigoAction,
    indigoText = ConductorIndigoAction,
    indigoBg = ConductorIndigo.copy(alpha = 0.10f),
    indigoBorder = ConductorIndigo.copy(alpha = 0.22f),
    userBubbleBg = ConductorIndigo.copy(alpha = 0.12f),
    userBubbleBorder = ConductorIndigo.copy(alpha = 0.20f),
    userInlineCodeBg = Color.White.copy(alpha = 0.72f),
    userInlineCodeText = Color(0xFF312E81),
    emerald = ConductorEmerald,
    emeraldText = Color(0xFF047857),
    emeraldBg = ConductorEmerald.copy(alpha = 0.12f),
    emeraldBorder = ConductorEmerald.copy(alpha = 0.26f),
    amber = ConductorAmber,
    amberText = Color(0xFFB45309),
    amberBg = ConductorAmber.copy(alpha = 0.13f),
    amberBorder = ConductorAmber.copy(alpha = 0.30f),
    rose = ConductorRose,
    roseText = Color(0xFFE11D48),
    roseBg = ConductorRose.copy(alpha = 0.10f),
    roseBorder = ConductorRose.copy(alpha = 0.25f),
    sky = ConductorSky,
    skyText = Color(0xFF0369A1),
    skyBg = ConductorSky.copy(alpha = 0.12f),
    codeBlockBg = Zinc50,
    codeBlockHeaderBg = Zinc100,
    inlineCodeBg = Zinc200.copy(alpha = 0.65f),
    blockquoteBg = Zinc100.copy(alpha = 0.75f),
)

private val DarkConductorColors = ConductorColors(
    isDark = true,
    canvas = DarkCanvas,
    surfaceSecondary = DarkSurfaceSecondary,
    card = DarkCard,
    cardMuted = DarkCardMuted,
    composer = DarkComposer,
    surfaceSubtle = Zinc800,
    border = Zinc800,
    borderSubtle = Zinc800.copy(alpha = 0.85f),
    borderStrong = Zinc700,
    textPrimary = Zinc100,
    textSecondary = Zinc300,
    textMuted = Zinc400,
    textSubtle = Zinc500,
    indigo = ConductorIndigo,
    indigoAction = ConductorIndigoAction,
    indigoText = ConductorIndigoLight,
    indigoBg = ConductorIndigo.copy(alpha = 0.16f),
    indigoBorder = ConductorIndigo.copy(alpha = 0.30f),
    userBubbleBg = ConductorIndigo.copy(alpha = 0.20f),
    userBubbleBorder = Color(0xFF818CF8).copy(alpha = 0.28f),
    userInlineCodeBg = DarkCanvas.copy(alpha = 0.55f),
    userInlineCodeText = Color(0xFFE0E7FF),
    emerald = ConductorEmerald,
    emeraldText = Color(0xFF6EE7B7),
    emeraldBg = ConductorEmerald.copy(alpha = 0.15f),
    emeraldBorder = ConductorEmerald.copy(alpha = 0.30f),
    amber = ConductorAmber,
    amberText = Color(0xFFFCD34D),
    amberBg = ConductorAmber.copy(alpha = 0.15f),
    amberBorder = ConductorAmber.copy(alpha = 0.32f),
    rose = ConductorRose,
    roseText = Color(0xFFFDA4AF),
    roseBg = ConductorRose.copy(alpha = 0.15f),
    roseBorder = ConductorRose.copy(alpha = 0.30f),
    sky = ConductorSky,
    skyText = Color(0xFF7DD3FC),
    skyBg = ConductorSky.copy(alpha = 0.15f),
    codeBlockBg = DarkSurfaceSecondary,
    codeBlockHeaderBg = DarkCard,
    inlineCodeBg = Zinc800,
    blockquoteBg = DarkCardMuted,
)

private val DarkColorScheme = darkColorScheme(
    primary = ConductorIndigo,
    onPrimary = Color.White,
    primaryContainer = Color(0xFF312E81),
    onPrimaryContainer = Color(0xFFE0E7FF),
    secondary = ConductorEmerald,
    onSecondary = Color.White,
    secondaryContainer = Color(0xFF064E3B),
    onSecondaryContainer = Color(0xFFD1FAE5),
    background = DarkCanvas,
    onBackground = Zinc100,
    surface = DarkCard,
    onSurface = Zinc100,
    surfaceVariant = Zinc800,
    onSurfaceVariant = Zinc400,
    surfaceContainerLowest = DarkCanvas,
    surfaceContainerLow = DarkSurfaceSecondary,
    surfaceContainer = DarkCardMuted,
    surfaceContainerHigh = DarkCard,
    surfaceContainerHighest = Zinc800,
    outline = Zinc700,
    outlineVariant = Zinc800,
    error = ConductorRose,
    onError = Color.White,
)

private val LightColorScheme = lightColorScheme(
    primary = ConductorIndigoAction,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFE0E7FF),
    onPrimaryContainer = Color(0xFF1E1B4B),
    secondary = ConductorEmerald,
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFD1FAE5),
    onSecondaryContainer = Color(0xFF064E3B),
    background = Color.White,
    onBackground = Zinc900,
    surface = Color.White,
    onSurface = Zinc900,
    surfaceVariant = Zinc100,
    onSurfaceVariant = Zinc500,
    surfaceContainerLowest = Color.White,
    surfaceContainerLow = Zinc50,
    surfaceContainer = Zinc100,
    surfaceContainerHigh = Zinc100,
    surfaceContainerHighest = Zinc200,
    outline = Zinc300,
    outlineVariant = Zinc200,
    error = Color(0xFFE11D48),
    onError = Color.White,
)

private val ConductorTypography = Typography(
    headlineMedium = TextStyle(
        fontSize = 24.sp,
        lineHeight = 30.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = (-0.3).sp,
    ),
    titleLarge = TextStyle(
        fontSize = 19.sp,
        lineHeight = 25.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = (-0.2).sp,
    ),
    titleMedium = TextStyle(
        fontSize = 15.5.sp,
        lineHeight = 21.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = (-0.1).sp,
    ),
    titleSmall = TextStyle(
        fontSize = 13.5.sp,
        lineHeight = 19.sp,
        fontWeight = FontWeight.SemiBold,
    ),
    bodyMedium = TextStyle(
        fontSize = 14.sp,
        lineHeight = 22.sp,
        fontWeight = FontWeight.Normal,
    ),
    bodySmall = TextStyle(
        fontSize = 12.5.sp,
        lineHeight = 18.sp,
        fontWeight = FontWeight.Normal,
    ),
    labelLarge = TextStyle(
        fontSize = 13.sp,
        lineHeight = 18.sp,
        fontWeight = FontWeight.Medium,
    ),
    labelMedium = TextStyle(
        fontSize = 11.5.sp,
        lineHeight = 15.sp,
        fontWeight = FontWeight.Medium,
    ),
    labelSmall = TextStyle(
        fontSize = 10.5.sp,
        lineHeight = 14.sp,
        fontWeight = FontWeight.Medium,
    ),
)

val LocalConductorColors = staticCompositionLocalOf { DarkConductorColors }

object ConductorTheme {
    val colors: ConductorColors
        @Composable
        @ReadOnlyComposable
        get() = LocalConductorColors.current
}

@Composable
fun resolveDarkTheme(themeMode: ThemeMode): Boolean = when (themeMode) {
    ThemeMode.SYSTEM -> isSystemInDarkTheme()
    ThemeMode.LIGHT -> false
    ThemeMode.DARK -> true
}

@Composable
fun ConductorTheme(
    themeMode: ThemeMode = ThemeMode.SYSTEM,
    content: @Composable () -> Unit,
) {
    val darkTheme = resolveDarkTheme(themeMode)
    val extendedColors = if (darkTheme) DarkConductorColors else LightConductorColors

    CompositionLocalProvider(LocalConductorColors provides extendedColors) {
        MaterialTheme(
            colorScheme = if (darkTheme) DarkColorScheme else LightColorScheme,
            typography = ConductorTypography,
            content = content,
        )
    }
}
