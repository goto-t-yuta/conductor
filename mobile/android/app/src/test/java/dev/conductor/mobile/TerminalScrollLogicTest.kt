package dev.conductor.mobile

import dev.conductor.mobile.ui.screens.ChatScrollMetrics
import dev.conductor.mobile.ui.screens.TerminalAuxKeys
import dev.conductor.mobile.ui.screens.TerminalScrollLogic
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalScrollLogicTest {

    @Test
    fun autoFollowPausesWhenUserScrollsUpAndResumesAtBottom() {
        val scrolledUp = ChatScrollMetrics(
            totalItemsCount = 50,
            lastVisibleItemIndex = 20,
            lastVisibleItemBottomPx = 1000,
            viewportContentBottomPx = 1000,
            canScrollForward = true,
        )
        assertFalse(
            TerminalScrollLogic.resolveAutoFollowAfterScroll(
                currentAutoFollow = true,
                metrics = scrolledUp,
                lineCount = 50,
                thresholdPx = 48,
                isUserScrolling = true,
                wasUserScrolling = false,
                isProgrammaticScrolling = false,
            ),
        )

        // Programmatic scroll must never disable auto-follow
        assertTrue(
            TerminalScrollLogic.resolveAutoFollowAfterScroll(
                currentAutoFollow = true,
                metrics = scrolledUp,
                lineCount = 50,
                thresholdPx = 48,
                isUserScrolling = false,
                wasUserScrolling = false,
                isProgrammaticScrolling = true,
            ),
        )

        // Returning to bottom resumes auto-follow
        val atBottom = ChatScrollMetrics(
            totalItemsCount = 50,
            lastVisibleItemIndex = 49,
            lastVisibleItemBottomPx = 1010,
            viewportContentBottomPx = 1000,
            canScrollForward = false,
        )
        assertTrue(
            TerminalScrollLogic.resolveAutoFollowAfterScroll(
                currentAutoFollow = false,
                metrics = atBottom,
                lineCount = 50,
                thresholdPx = 48,
                isUserScrolling = false,
                wasUserScrolling = true,
                isProgrammaticScrolling = false,
            ),
        )
    }

    @Test
    fun computesClampedGridDimensionsAndCompactCwd() {
        assertEquals(64 to 24, TerminalScrollLogic.computeTerminalGridSize(0, 0, 10f, 20f))
        assertEquals(80 to 30, TerminalScrollLogic.computeTerminalGridSize(800, 600, 10f, 20f))
        assertEquals(TerminalScrollLogic.MIN_COLS to TerminalScrollLogic.MIN_ROWS, TerminalScrollLogic.computeTerminalGridSize(50, 50, 10f, 20f))

        assertEquals("~", TerminalScrollLogic.formatCompactCwd("/Users/yutagoto"))
        assertEquals("~/conductor", TerminalScrollLogic.formatCompactCwd("/Users/yutagoto/conductor"))
        assertEquals("~/work/app", TerminalScrollLogic.formatCompactCwd("/home/dev/work/app"))
        assertEquals("/tmp/demo", TerminalScrollLogic.formatCompactCwd("/tmp/demo"))
        assertEquals("~", TerminalScrollLogic.formatCompactCwd(null))
    }

    @Test
    fun defaultAuxiliaryKeysContainEssentialMobileTerminalKeys() {
        val labels = TerminalAuxKeys.defaultKeys.map { it.label }.toSet()
        for (expected in listOf("Ctrl+C", "Tab", "↑", "↓", "Esc", "/", "-", "|")) {
            assertTrue("Expected key $expected in aux key bar", expected in labels)
        }
    }
}
