package dev.conductor.mobile.ui.screens

import kotlin.math.floor
import kotlin.math.max

enum class TerminalAuxKeyKind {
    /** Sends raw escape/control sequence directly to PTY stdin. */
    CONTROL,
    /** Inserts symbol text into the command input field for easy mobile typing. */
    INSERT,
}

data class TerminalAuxKey(
    val label: String,
    val payload: String,
    val kind: TerminalAuxKeyKind,
    val isDanger: Boolean = false,
    val contentDescription: String = label,
)

object TerminalAuxKeys {
    val defaultKeys: List<TerminalAuxKey> = listOf(
        TerminalAuxKey(
            label = "Ctrl+C",
            payload = "\u0003",
            kind = TerminalAuxKeyKind.CONTROL,
            isDanger = true,
            contentDescription = "Ctrl+C (中断)",
        ),
        TerminalAuxKey(
            label = "Tab",
            payload = "\t",
            kind = TerminalAuxKeyKind.CONTROL,
            contentDescription = "Tab (補完)",
        ),
        TerminalAuxKey(
            label = "↑",
            payload = "\u001B[A",
            kind = TerminalAuxKeyKind.CONTROL,
            contentDescription = "上矢印 (履歴前)",
        ),
        TerminalAuxKey(
            label = "↓",
            payload = "\u001B[B",
            kind = TerminalAuxKeyKind.CONTROL,
            contentDescription = "下矢印 (履歴次)",
        ),
        TerminalAuxKey(
            label = "Esc",
            payload = "\u001B",
            kind = TerminalAuxKeyKind.CONTROL,
            contentDescription = "Escape",
        ),
        TerminalAuxKey(
            label = "/",
            payload = "/",
            kind = TerminalAuxKeyKind.INSERT,
            contentDescription = "スラッシュを入力",
        ),
        TerminalAuxKey(
            label = "-",
            payload = "-",
            kind = TerminalAuxKeyKind.INSERT,
            contentDescription = "ハイフンを入力",
        ),
        TerminalAuxKey(
            label = "|",
            payload = "|",
            kind = TerminalAuxKeyKind.INSERT,
            contentDescription = "パイプを入力",
        ),
        TerminalAuxKey(
            label = "~",
            payload = "~",
            kind = TerminalAuxKeyKind.INSERT,
            contentDescription = "チルダを入力",
        ),
        TerminalAuxKey(
            label = ".",
            payload = ".",
            kind = TerminalAuxKeyKind.INSERT,
            contentDescription = "ドットを入力",
        ),
        TerminalAuxKey(
            label = "←",
            payload = "\u001B[D",
            kind = TerminalAuxKeyKind.CONTROL,
            contentDescription = "左矢印",
        ),
        TerminalAuxKey(
            label = "→",
            payload = "\u001B[C",
            kind = TerminalAuxKeyKind.CONTROL,
            contentDescription = "右矢印",
        ),
        TerminalAuxKey(
            label = "Ctrl+D",
            payload = "\u0004",
            kind = TerminalAuxKeyKind.CONTROL,
            contentDescription = "Ctrl+D (EOF)",
        ),
        TerminalAuxKey(
            label = "Ctrl+L",
            payload = "\u000C",
            kind = TerminalAuxKeyKind.CONTROL,
            contentDescription = "Ctrl+L (画面クリア)",
        ),
        TerminalAuxKey(
            label = ">",
            payload = ">",
            kind = TerminalAuxKeyKind.INSERT,
            contentDescription = "リダイレクトを入力",
        ),
        TerminalAuxKey(
            label = "&",
            payload = "&",
            kind = TerminalAuxKeyKind.INSERT,
            contentDescription = "アンパサンドを入力",
        ),
    )
}

/**
 * Pure scroll-follow heuristics and viewport dimension calculations for the Android Terminal screen.
 */
object TerminalScrollLogic {
    const val BOTTOM_THRESHOLD_DP = 24
    const val MIN_COLS = 32
    const val MAX_COLS = 240
    const val MIN_ROWS = 8
    const val MAX_ROWS = 120

    /**
     * Resolves whether auto-scroll should remain active after a scroll event.
     * - When the user scrolls upward away from the bottom, auto-follow pauses (`false`).
     * - When the user scrolls back to the bottom (or content fits without scrolling),
     *   auto-follow resumes (`true`).
     * - Programmatic auto-scrolls never turn off follow mode.
     */
    fun resolveAutoFollowAfterScroll(
        currentAutoFollow: Boolean,
        metrics: ChatScrollMetrics,
        lineCount: Int,
        thresholdPx: Int,
        isUserScrolling: Boolean,
        wasUserScrolling: Boolean,
        isProgrammaticScrolling: Boolean,
    ): Boolean {
        if (lineCount <= 0) return true
        if (isProgrammaticScrolling) return currentAutoFollow
        if (metrics.totalItemsCount <= 0 || metrics.lastVisibleItemIndex == null) {
            return currentAutoFollow
        }
        if (!metrics.canScrollForward) {
            return true
        }
        if (isUserScrolling || wasUserScrolling) {
            return ChatScrollLogic.isAtBottom(
                metrics = metrics,
                messageCount = lineCount,
                thresholdPx = thresholdPx,
            )
        }
        return currentAutoFollow
    }

    /**
     * Computes terminal grid dimensions (cols x rows) from viewport pixel dimensions
     * and monospace cell metrics.
     */
    fun computeTerminalGridSize(
        viewportWidthPx: Int,
        viewportHeightPx: Int,
        charWidthPx: Float,
        lineHeightPx: Float,
    ): Pair<Int, Int> {
        if (viewportWidthPx <= 0 || viewportHeightPx <= 0 || charWidthPx <= 0f || lineHeightPx <= 0f) {
            return 64 to 24
        }
        val rawCols = floor(viewportWidthPx / charWidthPx).toInt()
        val rawRows = floor(viewportHeightPx / lineHeightPx).toInt()
        val cols = max(MIN_COLS, rawCols).coerceAtMost(MAX_COLS)
        val rows = max(MIN_ROWS, rawRows).coerceAtMost(MAX_ROWS)
        return cols to rows
    }

    /**
     * Formats an absolute directory path concisely for the mobile top header
     * (e.g. `/Users/alice/projects/conductor` -> `~/projects/conductor`).
     */
    fun formatCompactCwd(cwd: String?): String {
        val trimmed = cwd?.trim().orEmpty()
        if (trimmed.isEmpty()) return "~"
        val macHome = Regex("^/Users/[^/]+(?=/|$)").find(trimmed)
        if (macHome != null) {
            val rest = trimmed.substring(macHome.range.last + 1)
            return if (rest.isEmpty()) "~" else "~$rest"
        }
        val linuxHome = Regex("^/home/[^/]+(?=/|$)").find(trimmed)
        if (linuxHome != null) {
            val rest = trimmed.substring(linuxHome.range.last + 1)
            return if (rest.isEmpty()) "~" else "~$rest"
        }
        return trimmed
    }
}
