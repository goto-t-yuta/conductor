package dev.conductor.mobile.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.DarkMode
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.LightMode
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.SettingsBrightness
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.conductor.mobile.model.ChatMessageMentionRef
import dev.conductor.mobile.model.StreamTransportState
import dev.conductor.mobile.model.ThemeMode
import dev.conductor.mobile.ui.theme.ConductorIndigo
import dev.conductor.mobile.ui.theme.ConductorTheme

/**
 * Desktop-matched flat bordered card (white / #191D26 with subtle 1dp zinc border).
 */
@Composable
fun ConductorCard(
    modifier: Modifier = Modifier,
    containerColor: Color = ConductorTheme.colors.card,
    borderColor: Color = ConductorTheme.colors.border,
    cornerRadius: Dp = 14.dp,
    onClick: (() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val shape = RoundedCornerShape(cornerRadius)
    Surface(
        color = containerColor,
        shape = shape,
        border = BorderStroke(1.dp, borderColor),
        modifier = if (onClick != null) {
            modifier
                .clip(shape)
                .clickable(onClick = onClick)
        } else {
            modifier
        },
    ) {
        Column(content = content)
    }
}

/**
 * Monospace `T#` task badge matching desktop's `bg-indigo-500/12 border-indigo-500/20`.
 */
@Composable
fun TaskCodeBadge(
    taskNumber: Int,
    modifier: Modifier = Modifier,
) {
    val colors = ConductorTheme.colors
    Surface(
        color = colors.indigoBg,
        shape = RoundedCornerShape(5.dp),
        border = BorderStroke(1.dp, colors.indigoBorder),
        modifier = modifier,
    ) {
        Text(
            text = "T$taskNumber",
            fontFamily = FontFamily.Monospace,
            fontSize = 10.5.sp,
            fontWeight = FontWeight.SemiBold,
            color = colors.indigoText,
            maxLines = 1,
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
        )
    }
}

/**
 * Project pill with project color tint matching desktop `backgroundColor: colorHex + "22"`.
 */
@Composable
fun ProjectPill(
    name: String,
    colorHex: String?,
    modifier: Modifier = Modifier,
    showDot: Boolean = true,
) {
    val projectColor = parseConductorHexColor(colorHex)
    val colors = ConductorTheme.colors
    val textColor = if (colors.isDark) {
        blendColor(projectColor, Color.White, 0.25f)
    } else {
        blendColor(projectColor, Color.Black, 0.18f)
    }
    Surface(
        color = projectColor.copy(alpha = if (colors.isDark) 0.18f else 0.13f),
        shape = RoundedCornerShape(5.dp),
        modifier = modifier,
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            if (showDot) {
                Box(
                    modifier = Modifier
                        .size(6.dp)
                        .clip(CircleShape)
                        .background(projectColor),
                )
            }
            Text(
                text = name,
                fontSize = 10.5.sp,
                fontWeight = FontWeight.SemiBold,
                color = textColor,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/**
 * Provider badge (`Codex` / `AGY` / `Claude`) matching desktop neutral zinc pill.
 */
@Composable
fun ProviderPill(
    provider: String,
    modifier: Modifier = Modifier,
) {
    val colors = ConductorTheme.colors
    Surface(
        color = colors.surfaceSubtle,
        shape = RoundedCornerShape(5.dp),
        modifier = modifier,
    ) {
        Text(
            text = formatProviderLabel(provider),
            fontSize = 10.sp,
            fontWeight = FontWeight.Medium,
            color = colors.textMuted,
            maxLines = 1,
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
        )
    }
}

@Composable
fun TaskStatusIcon(
    status: String,
    modifier: Modifier = Modifier,
) {
    val colors = ConductorTheme.colors
    when (status) {
        "running" -> CircularProgressIndicator(
            modifier = modifier.size(14.dp),
            strokeWidth = 2.dp,
            color = colors.indigo,
            trackColor = colors.indigo.copy(alpha = 0.22f),
        )

        "needs_review" -> Icon(
            imageVector = Icons.Default.ErrorOutline,
            contentDescription = "確認待ち",
            tint = colors.amber,
            modifier = modifier.size(15.dp),
        )

        "done" -> Icon(
            imageVector = Icons.Default.CheckCircle,
            contentDescription = "完了",
            tint = colors.emerald,
            modifier = modifier.size(15.dp),
        )

        "failed" -> Icon(
            imageVector = Icons.Default.Cancel,
            contentDescription = "エラー",
            tint = colors.rose,
            modifier = modifier.size(15.dp),
        )

        else -> Icon(
            imageVector = Icons.Default.Schedule,
            contentDescription = "待機",
            tint = colors.textSubtle,
            modifier = modifier.size(15.dp),
        )
    }
}

@Composable
fun TaskStatusBadge(
    status: String,
    modifier: Modifier = Modifier,
) {
    val colors = ConductorTheme.colors
    val (label, bg, fg) = when (status) {
        "running" -> Triple("実行中", colors.indigoBg, colors.indigoText)
        "needs_review" -> Triple("確認待ち", colors.amberBg, colors.amberText)
        "done" -> Triple("完了", colors.emeraldBg, colors.emeraldText)
        "failed" -> Triple("エラー", colors.roseBg, colors.roseText)
        else -> Triple("待機", colors.surfaceSubtle, colors.textMuted)
    }
    Surface(
        color = bg,
        shape = RoundedCornerShape(99.dp),
        modifier = modifier,
    ) {
        Text(
            text = label,
            fontSize = 10.5.sp,
            fontWeight = FontWeight.SemiBold,
            color = fg,
            maxLines = 1,
            modifier = Modifier.padding(horizontal = 7.dp, vertical = 2.dp),
        )
    }
}

@Composable
fun MentionBadgeChip(
    mention: ChatMessageMentionRef,
    modifier: Modifier = Modifier,
) {
    val colors = ConductorTheme.colors
    val isTask = mention.kind == "task" && mention.taskNumber != null
    val dotColor = parseConductorHexColor(mention.projectColorHex)
    Surface(
        color = if (isTask) colors.indigoBg else colors.surfaceSubtle,
        shape = RoundedCornerShape(8.dp),
        border = BorderStroke(
            width = 1.dp,
            color = if (isTask) colors.indigoBorder else colors.border,
        ),
        modifier = modifier,
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 7.dp, vertical = 3.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            if (!isTask) {
                Box(
                    modifier = Modifier
                        .size(6.dp)
                        .clip(CircleShape)
                        .background(dotColor),
                )
            }
            Text(
                text = mention.displayLabel(),
                fontFamily = if (isTask) FontFamily.Monospace else FontFamily.Default,
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
                color = if (isTask) colors.indigoText else colors.textSecondary,
                maxLines = 1,
            )
        }
    }
}

/**
 * 3-way segmented theme picker (System / Light / Dark) matching desktop Conductor's clean bordered pills.
 */
@Composable
fun ThemeModeSelector(
    selectedMode: ThemeMode,
    onSelectMode: (ThemeMode) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = ConductorTheme.colors
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(colors.surfaceSubtle)
            .border(1.dp, colors.border, RoundedCornerShape(10.dp))
            .padding(3.dp),
        horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        ThemeMode.entries.forEach { mode ->
            val selected = mode == selectedMode
            val icon: ImageVector = when (mode) {
                ThemeMode.SYSTEM -> Icons.Default.SettingsBrightness
                ThemeMode.LIGHT -> Icons.Default.LightMode
                ThemeMode.DARK -> Icons.Default.DarkMode
            }
            val itemShape = RoundedCornerShape(8.dp)
            Row(
                modifier = Modifier
                    .weight(1f)
                    .clip(itemShape)
                    .background(if (selected) colors.indigoAction else Color.Transparent)
                    .clickable { onSelectMode(mode) }
                    .padding(vertical = 8.dp, horizontal = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center,
            ) {
                Icon(
                    imageVector = icon,
                    contentDescription = null,
                    tint = if (selected) Color.White else colors.textMuted,
                    modifier = Modifier.size(15.dp),
                )
                Text(
                    text = mode.label,
                    fontSize = 12.sp,
                    fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
                    color = if (selected) Color.White else colors.textSecondary,
                    maxLines = 1,
                    modifier = Modifier.padding(start = 5.dp),
                )
            }
        }
    }
}

@Composable
fun transportStatusColor(state: StreamTransportState): Color {
    val colors = ConductorTheme.colors
    return when (state) {
        StreamTransportState.CONNECTED_SSE -> colors.emerald
        StreamTransportState.CONNECTED_POLLING, StreamTransportState.CONNECTING -> colors.amber
        StreamTransportState.ERROR -> colors.rose
        StreamTransportState.DISCONNECTED -> colors.textSubtle
    }
}

fun formatProviderLabel(provider: String?): String = when (provider?.lowercase()) {
    "agy" -> "AGY"
    "claude" -> "Claude"
    "codex" -> "Codex"
    null, "" -> "Conductor"
    else -> provider
}

fun parseConductorHexColor(hex: String?): Color {
    if (hex.isNullOrBlank()) return ConductorIndigo
    return runCatching {
        Color(android.graphics.Color.parseColor(hex))
    }.getOrDefault(ConductorIndigo)
}

private fun blendColor(base: Color, target: Color, ratio: Float): Color = Color(
    red = base.red + (target.red - base.red) * ratio,
    green = base.green + (target.green - base.green) * ratio,
    blue = base.blue + (target.blue - base.blue) * ratio,
    alpha = base.alpha,
)
