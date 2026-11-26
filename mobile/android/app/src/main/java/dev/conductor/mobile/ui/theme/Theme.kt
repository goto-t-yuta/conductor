package dev.conductor.mobile.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val ConductorIndigo = Color(0xFF6366F1)
val ConductorIndigoLight = Color(0xFFA5B4FC)
val ConductorEmerald = Color(0xFF10B981)
val ConductorAmber = Color(0xFFF59E0B)
val ConductorRed = Color(0xFFEF4444)

private val DarkColors = darkColorScheme(
    primary = ConductorIndigo,
    onPrimary = Color.White,
    primaryContainer = Color(0xFF312E81),
    onPrimaryContainer = Color(0xFFE0E7FF),
    secondary = ConductorEmerald,
    onSecondary = Color.White,
    background = Color(0xFF0F1115),
    onBackground = Color(0xFFF4F4F6),
    surface = Color(0xFF161A22),
    onSurface = Color(0xFFF4F4F6),
    surfaceVariant = Color(0xFF202634),
    onSurfaceVariant = Color(0xFFA1A1AA),
    outline = Color(0xFF2E3545),
    error = ConductorRed,
)

private val LightColors = lightColorScheme(
    primary = ConductorIndigo,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFE0E7FF),
    onPrimaryContainer = Color(0xFF1E1B4B),
    secondary = ConductorEmerald,
    onSecondary = Color.White,
    background = Color(0xFFF8FAFC),
    onBackground = Color(0xFF0F172A),
    surface = Color.White,
    onSurface = Color(0xFF0F172A),
    surfaceVariant = Color(0xFFF1F5F9),
    onSurfaceVariant = Color(0xFF64748B),
    outline = Color(0xFFCBD5E1),
    error = ConductorRed,
)

@Composable
fun ConductorTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        content = content,
    )
}
