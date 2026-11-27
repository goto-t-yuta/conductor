package dev.conductor.mobile.data

import dev.conductor.mobile.model.TerminalRenderedLine
import dev.conductor.mobile.model.TerminalSpanStyle
import dev.conductor.mobile.model.TerminalStyledSpan
import kotlin.math.max

/**
 * Dark terminal ANSI color palette matching Desktop Conductor's `CONDUCTOR_TERMINAL_DARK_THEME`.
 */
object TerminalAnsiPalette {
    const val BACKGROUND_ARGB: Long = 0xFF0F1115
    const val FOREGROUND_ARGB: Long = 0xFFE4E4E7
    const val CURSOR_ARGB: Long = 0xFF818CF8

    // Standard 0..7 + Bright 8..15 ANSI colors
    private val base16: LongArray = longArrayOf(
        0xFF27272A, // 0: black
        0xFFF87171, // 1: red
        0xFF34D399, // 2: green
        0xFFFBBF24, // 3: yellow
        0xFF60A5FA, // 4: blue
        0xFFC084FC, // 5: magenta
        0xFF22D3EE, // 6: cyan
        0xFFE4E4E7, // 7: white
        0xFF71717A, // 8: brightBlack
        0xFFFCA5A5, // 9: brightRed
        0xFF6EE7B7, // 10: brightGreen
        0xFFFCD34D, // 11: brightYellow
        0xFF93C5FD, // 12: brightBlue
        0xFFD8B4FE, // 13: brightMagenta
        0xFF67E8F9, // 14: brightCyan
        0xFFFAFAFA, // 15: brightWhite
    )

    fun colorForIndex(index: Int): Long {
        if (index in 0..15) return base16[index]
        if (index in 16..231) {
            val idx = index - 16
            val r = idx / 36
            val g = (idx % 36) / 6
            val b = idx % 6
            val toLevel = { v: Int -> if (v == 0) 0 else 55 + v * 40 }
            return rgbToArgb(toLevel(r), toLevel(g), toLevel(b))
        }
        if (index in 232..255) {
            val gray = 8 + (index - 232) * 10
            return rgbToArgb(gray, gray, gray)
        }
        return FOREGROUND_ARGB
    }

    fun rgbToArgb(r: Int, g: Int, b: Int): Long {
        val rc = r.coerceIn(0, 255).toLong()
        val gc = g.coerceIn(0, 255).toLong()
        val bc = b.coerceIn(0, 255).toLong()
        return (0xFFL shl 24) or (rc shl 16) or (gc shl 8) or bc
    }
}

private enum class AnsiParseState {
    NORMAL,
    ESC,
    CSI,
    OSC,
    OSC_ESC,
    ESC_INTERMEDIATE,
}

private data class TerminalCell(
    val ch: Char,
    val style: TerminalSpanStyle,
)

private class MutableTerminalLine(val id: Long) {
    val cells = ArrayList<TerminalCell>()

    fun writeAt(col: Int, ch: Char, style: TerminalSpanStyle) {
        while (cells.size < col) {
            cells.add(TerminalCell(' ', TerminalSpanStyle.Default))
        }
        if (col < cells.size) {
            cells[col] = TerminalCell(ch, style)
        } else {
            cells.add(TerminalCell(ch, style))
        }
    }

    fun eraseFrom(col: Int) {
        if (col < cells.size) {
            cells.subList(col, cells.size).clear()
        }
    }

    fun eraseTo(col: Int) {
        val limit = minOf(col + 1, cells.size)
        for (i in 0 until limit) {
            cells[i] = TerminalCell(' ', TerminalSpanStyle.Default)
        }
    }

    fun eraseAll() {
        cells.clear()
    }

    fun deleteCharsAt(col: Int, count: Int) {
        if (col >= cells.size || count <= 0) return
        val end = minOf(col + count, cells.size)
        cells.subList(col, end).clear()
    }

    fun insertBlanksAt(col: Int, count: Int) {
        if (count <= 0) return
        while (cells.size < col) {
            cells.add(TerminalCell(' ', TerminalSpanStyle.Default))
        }
        val blanks = List(count) { TerminalCell(' ', TerminalSpanStyle.Default) }
        cells.addAll(col, blanks)
    }

    fun toRenderedLine(): TerminalRenderedLine {
        if (cells.isEmpty()) {
            return TerminalRenderedLine(id = id, spans = emptyList())
        }
        val spans = ArrayList<TerminalStyledSpan>()
        var currentStyle = cells[0].style
        val sb = StringBuilder()
        for (cell in cells) {
            if (cell.style == currentStyle) {
                sb.append(cell.ch)
            } else {
                if (sb.isNotEmpty()) {
                    spans.add(TerminalStyledSpan(sb.toString(), currentStyle))
                    sb.setLength(0)
                }
                currentStyle = cell.style
                sb.append(cell.ch)
            }
        }
        if (sb.isNotEmpty()) {
            spans.add(TerminalStyledSpan(sb.toString(), currentStyle))
        }
        return TerminalRenderedLine(id = id, spans = spans)
    }
}

/**
 * Stateful VT100/ANSI stream parser & bounded scrollback buffer for mobile terminal rendering.
 * Handles SGR colors (16/256/truecolor), carriage-return overwrites, backspaces, tabs,
 * line/screen erasures (`clear` / Ctrl+L), and strips OSC/private-mode escape sequences cleanly.
 */
class TerminalOutputBuffer(
    private val maxLines: Int = 2_000,
) {
    private var nextLineId: Long = 1L
    private val lines = ArrayList<MutableTerminalLine>().apply {
        add(MutableTerminalLine(nextLineId++))
    }
    private var cursorCol: Int = 0
    private var currentStyle: TerminalSpanStyle = TerminalSpanStyle.Default
    private var parseState: AnsiParseState = AnsiParseState.NORMAL
    private val csiBuffer = StringBuilder()

    @Synchronized
    fun clear() {
        lines.clear()
        lines.add(MutableTerminalLine(nextLineId++))
        cursorCol = 0
        currentStyle = TerminalSpanStyle.Default
        parseState = AnsiParseState.NORMAL
        csiBuffer.setLength(0)
    }

    @Synchronized
    fun replaceAll(text: String) {
        clear()
        if (text.isNotEmpty()) {
            appendInternal(text)
        }
    }

    @Synchronized
    fun append(chunk: String) {
        if (chunk.isEmpty()) return
        appendInternal(chunk)
    }

    @Synchronized
    fun snapshotLines(): List<TerminalRenderedLine> {
        return lines.map { it.toRenderedLine() }
    }

    @Synchronized
    fun plainText(): String {
        return lines.joinToString("\n") { line ->
            val sb = StringBuilder(line.cells.size)
            for (c in line.cells) sb.append(c.ch)
            sb.toString()
        }
    }

    private fun currentLine(): MutableTerminalLine = lines[lines.size - 1]

    private fun appendInternal(chunk: String) {
        var i = 0
        while (i < chunk.length) {
            val ch = chunk[i]
            when (parseState) {
                AnsiParseState.NORMAL -> handleNormalChar(ch)
                AnsiParseState.ESC -> handleEscChar(ch)
                AnsiParseState.CSI -> handleCsiChar(ch)
                AnsiParseState.OSC -> handleOscChar(ch)
                AnsiParseState.OSC_ESC -> {
                    parseState = if (ch == '\\') AnsiParseState.NORMAL else AnsiParseState.OSC
                }
                AnsiParseState.ESC_INTERMEDIATE -> {
                    // Consume single final byte of charset designation like ESC ( B
                    parseState = AnsiParseState.NORMAL
                }
            }
            i += 1
        }
    }

    private fun handleNormalChar(ch: Char) {
        when (ch) {
            '\u001B' -> {
                parseState = AnsiParseState.ESC
            }
            '\n' -> {
                lines.add(MutableTerminalLine(nextLineId++))
                cursorCol = 0
                trimOverflow()
            }
            '\r' -> {
                cursorCol = 0
            }
            '\b' -> {
                if (cursorCol > 0) cursorCol -= 1
            }
            '\t' -> {
                val nextStop = ((cursorCol / 8) + 1) * 8
                while (cursorCol < nextStop) {
                    currentLine().writeAt(cursorCol, ' ', currentStyle)
                    cursorCol += 1
                }
            }
            '\u0007', '\u0000', '\u000E', '\u000F' -> {
                // Ignore BEL / NUL / shift controls
            }
            else -> {
                if (ch.code >= 0x20 || ch.code >= 0xA0) {
                    currentLine().writeAt(cursorCol, ch, currentStyle)
                    cursorCol += 1
                }
            }
        }
    }

    private fun handleEscChar(ch: Char) {
        when (ch) {
            '[' -> {
                csiBuffer.setLength(0)
                parseState = AnsiParseState.CSI
            }
            ']' -> {
                parseState = AnsiParseState.OSC
            }
            '(', ')', '*', '+', '#' -> {
                parseState = AnsiParseState.ESC_INTERMEDIATE
            }
            'c' -> {
                // Full terminal reset (RIS)
                clear()
            }
            else -> {
                // Other 2-byte ESC sequences (e.g., =, >, M, 7, 8)
                parseState = AnsiParseState.NORMAL
            }
        }
    }

    private fun handleOscChar(ch: Char) {
        when (ch) {
            '\u0007' -> parseState = AnsiParseState.NORMAL
            '\u001B' -> parseState = AnsiParseState.OSC_ESC
            else -> {
                // Consume OSC payload
            }
        }
    }

    private fun handleCsiChar(ch: Char) {
        if (ch.code in 0x40..0x7E) {
            executeCsi(csiBuffer.toString(), ch)
            csiBuffer.setLength(0)
            parseState = AnsiParseState.NORMAL
        } else {
            if (csiBuffer.length < 128) {
                csiBuffer.append(ch)
            }
        }
    }

    private fun executeCsi(paramsRaw: String, command: Char) {
        // Private mode sequences (e.g. ?2004h, ?25l, >0c) do not alter visible scrollback text
        if (paramsRaw.startsWith("?") || paramsRaw.startsWith(">") || paramsRaw.startsWith("=")) {
            return
        }
        val params = if (paramsRaw.isEmpty()) {
            emptyList()
        } else {
            paramsRaw.split(';').map { it.toIntOrNull() }
        }
        val firstParam = params.firstOrNull() ?: 0

        when (command) {
            'm' -> applySgr(params)
            'K' -> {
                when (firstParam) {
                    0 -> currentLine().eraseFrom(cursorCol)
                    1 -> currentLine().eraseTo(cursorCol)
                    2 -> currentLine().eraseAll()
                }
            }
            'J' -> {
                if (firstParam == 2 || firstParam == 3) {
                    lines.clear()
                    lines.add(MutableTerminalLine(nextLineId++))
                    cursorCol = 0
                } else if (firstParam == 0) {
                    currentLine().eraseFrom(cursorCol)
                }
            }
            'C' -> {
                cursorCol += max(1, firstParam)
            }
            'D' -> {
                cursorCol = max(0, cursorCol - max(1, firstParam))
            }
            'G' -> {
                cursorCol = max(0, max(1, firstParam) - 1)
            }
            'P' -> {
                currentLine().deleteCharsAt(cursorCol, max(1, firstParam))
            }
            '@' -> {
                currentLine().insertBlanksAt(cursorCol, max(1, firstParam))
            }
            'H', 'f' -> {
                // Cursor position: reset column to requested col when at top/home
                val colParam = params.getOrNull(1) ?: 1
                cursorCol = max(0, colParam - 1)
            }
            else -> {
                // Ignore unsupported CSI commands cleanly
            }
        }
    }

    private fun applySgr(params: List<Int?>) {
        if (params.isEmpty()) {
            currentStyle = TerminalSpanStyle.Default
            return
        }
        var idx = 0
        while (idx < params.size) {
            val code = params[idx] ?: 0
            when {
                code == 0 -> currentStyle = TerminalSpanStyle.Default
                code == 1 -> currentStyle = currentStyle.copy(bold = true)
                code == 2 -> currentStyle = currentStyle.copy(dim = true)
                code == 3 -> currentStyle = currentStyle.copy(italic = true)
                code == 4 -> currentStyle = currentStyle.copy(underline = true)
                code == 22 -> currentStyle = currentStyle.copy(bold = false, dim = false)
                code == 23 -> currentStyle = currentStyle.copy(italic = false)
                code == 24 -> currentStyle = currentStyle.copy(underline = false)
                code in 30..37 -> {
                    currentStyle = currentStyle.copy(
                        fgColorArgb = TerminalAnsiPalette.colorForIndex(code - 30),
                    )
                }
                code == 39 -> currentStyle = currentStyle.copy(fgColorArgb = null)
                code in 40..47 -> {
                    currentStyle = currentStyle.copy(
                        bgColorArgb = TerminalAnsiPalette.colorForIndex(code - 40),
                    )
                }
                code == 49 -> currentStyle = currentStyle.copy(bgColorArgb = null)
                code in 90..97 -> {
                    currentStyle = currentStyle.copy(
                        fgColorArgb = TerminalAnsiPalette.colorForIndex(8 + (code - 90)),
                    )
                }
                code in 100..107 -> {
                    currentStyle = currentStyle.copy(
                        bgColorArgb = TerminalAnsiPalette.colorForIndex(8 + (code - 100)),
                    )
                }
                code == 38 || code == 48 -> {
                    val isForeground = code == 38
                    val mode = params.getOrNull(idx + 1)
                    if (mode == 5) {
                        val colorIdx = params.getOrNull(idx + 2)
                        if (colorIdx != null) {
                            val argb = TerminalAnsiPalette.colorForIndex(colorIdx)
                            currentStyle = if (isForeground) {
                                currentStyle.copy(fgColorArgb = argb)
                            } else {
                                currentStyle.copy(bgColorArgb = argb)
                            }
                        }
                        idx += 2
                    } else if (mode == 2) {
                        val r = params.getOrNull(idx + 2)
                        val g = params.getOrNull(idx + 3)
                        val b = params.getOrNull(idx + 4)
                        if (r != null && g != null && b != null) {
                            val argb = TerminalAnsiPalette.rgbToArgb(r, g, b)
                            currentStyle = if (isForeground) {
                                currentStyle.copy(fgColorArgb = argb)
                            } else {
                                currentStyle.copy(bgColorArgb = argb)
                            }
                        }
                        idx += 4
                    }
                }
            }
            idx += 1
        }
    }

    private fun trimOverflow() {
        val overflow = lines.size - maxLines
        if (overflow > 0) {
            lines.subList(0, overflow).clear()
        }
    }
}
