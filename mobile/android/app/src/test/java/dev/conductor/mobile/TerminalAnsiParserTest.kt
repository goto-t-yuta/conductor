package dev.conductor.mobile

import dev.conductor.mobile.data.TerminalAnsiPalette
import dev.conductor.mobile.data.TerminalOutputBuffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalAnsiParserTest {

    @Test
    fun parsesPlainTextCrlfCarriageReturnAndBackspace() {
        val buf = TerminalOutputBuffer()
        buf.append("hello world\r\nsecond line\rSECOND\nfoo\b\bbar")
        assertEquals("hello world\nSECOND line\nfbar", buf.plainText())
    }

    @Test
    fun parsesAnsiSgrColorsAndStylesEvenAcrossChunkBoundaries() {
        val buf = TerminalOutputBuffer()
        // Split ANSI escape right in the middle of CSI parameters
        buf.append("\u001B[1;3")
        buf.append("2mOK\u001B[0m plain \u001B[38;2;10;20;30mrgb\u001B[0m")

        val lines = buf.snapshotLines()
        assertEquals(1, lines.size)
        val spans = lines[0].spans
        assertEquals(3, spans.size)

        assertEquals("OK", spans[0].text)
        assertTrue(spans[0].style.bold)
        assertEquals(TerminalAnsiPalette.colorForIndex(2), spans[0].style.fgColorArgb)

        assertEquals(" plain ", spans[1].text)
        assertFalse(spans[1].style.bold)
        assertEquals(null, spans[1].style.fgColorArgb)

        assertEquals("rgb", spans[2].text)
        assertEquals(TerminalAnsiPalette.rgbToArgb(10, 20, 30), spans[2].style.fgColorArgb)
    }

    @Test
    fun stripsOscAndPrivateModesAndHandlesClearDisplay() {
        val buf = TerminalOutputBuffer()
        buf.append("\u001B]0;zsh - conductor\u0007\u001B[?2004hbefore-clear\r\n")
        assertEquals("before-clear\n", buf.plainText())

        // CSI 2J clears display buffer
        buf.append("\u001B[2J\u001B[Hafter-clear\u001B]7;file://mac/Users/dev\u001B\\")
        assertEquals("after-clear", buf.plainText())
    }

    @Test
    fun capsScrollbackToMaxLines() {
        val buf = TerminalOutputBuffer(maxLines = 5)
        for (i in 1..12) {
            buf.append("line-$i\n")
        }
        val lines = buf.snapshotLines()
        assertEquals(5, lines.size)
        assertTrue(lines.first().plainText().contains("line-9"))
    }
}
