package dev.conductor.mobile

import dev.conductor.mobile.ui.screens.ChatScrollLogic
import dev.conductor.mobile.ui.screens.ChatScrollMetrics
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatScrollLogicTest {
    private val thresholdPx = 72 // 24dp at 3x density

    @Test
    fun hidesButtonWhenChatIsEmptyOrNotScrollable() {
        val emptyMetrics = ChatScrollMetrics(
            totalItemsCount = 0,
            lastVisibleItemIndex = null,
            lastVisibleItemBottomPx = null,
            viewportContentBottomPx = 1000,
            canScrollForward = false,
        )
        assertFalse(
            ChatScrollLogic.shouldShowScrollToBottomButton(
                metrics = emptyMetrics,
                messageCount = 0,
                isScrollingToBottom = false,
                thresholdPx = thresholdPx,
            ),
        )

        val shortListMetrics = ChatScrollMetrics(
            totalItemsCount = 4, // 3 messages + bottom anchor
            lastVisibleItemIndex = 3,
            lastVisibleItemBottomPx = 620,
            viewportContentBottomPx = 1000,
            canScrollForward = false,
        )
        assertFalse(
            ChatScrollLogic.shouldShowScrollToBottomButton(
                metrics = shortListMetrics,
                messageCount = 3,
                isScrollingToBottom = false,
                thresholdPx = thresholdPx,
            ),
        )
    }

    @Test
    fun hidesButtonWhenAtBottomOrWithinThreshold() {
        // Anchored right at the bottom anchor item
        val atAnchor = ChatScrollMetrics(
            totalItemsCount = 21, // 20 messages + bottom anchor
            lastVisibleItemIndex = 20,
            lastVisibleItemBottomPx = 1000,
            viewportContentBottomPx = 1000,
            canScrollForward = false,
        )
        assertFalse(
            ChatScrollLogic.shouldShowScrollToBottomButton(
                metrics = atAnchor,
                messageCount = 20,
                isScrollingToBottom = false,
                thresholdPx = thresholdPx,
            ),
        )

        // Slightly nudged upward by 20px (< thresholdPx) so bottom anchor is just offscreen
        val slightNudge = ChatScrollMetrics(
            totalItemsCount = 21,
            lastVisibleItemIndex = 19,
            lastVisibleItemBottomPx = 1020,
            viewportContentBottomPx = 1000,
            canScrollForward = true,
        )
        assertFalse(
            ChatScrollLogic.shouldShowScrollToBottomButton(
                metrics = slightNudge,
                messageCount = 20,
                isScrollingToBottom = false,
                thresholdPx = thresholdPx,
            ),
        )
    }

    @Test
    fun showsButtonWhenScrolledUpPastOlderMessagesOrTallLatestMessage() {
        // Scrolled up past the latest message completely
        val scrolledUpHistory = ChatScrollMetrics(
            totalItemsCount = 21,
            lastVisibleItemIndex = 14,
            lastVisibleItemBottomPx = 980,
            viewportContentBottomPx = 1000,
            canScrollForward = true,
        )
        assertTrue(
            ChatScrollLogic.shouldShowScrollToBottomButton(
                metrics = scrolledUpHistory,
                messageCount = 20,
                isScrollingToBottom = false,
                thresholdPx = thresholdPx,
            ),
        )

        // Latest message is very tall and user is reading the top of it
        val tallLatestMessageScrolledUp = ChatScrollMetrics(
            totalItemsCount = 21,
            lastVisibleItemIndex = 19,
            lastVisibleItemBottomPx = 1450,
            viewportContentBottomPx = 1000,
            canScrollForward = true,
        )
        assertTrue(
            ChatScrollLogic.shouldShowScrollToBottomButton(
                metrics = tallLatestMessageScrolledUp,
                messageCount = 20,
                isScrollingToBottom = false,
                thresholdPx = thresholdPx,
            ),
        )
    }

    @Test
    fun hidesButtonImmediatelyWhileSmoothScrollingToBottom() {
        val scrolledUp = ChatScrollMetrics(
            totalItemsCount = 21,
            lastVisibleItemIndex = 8,
            lastVisibleItemBottomPx = 990,
            viewportContentBottomPx = 1000,
            canScrollForward = true,
        )
        assertFalse(
            ChatScrollLogic.shouldShowScrollToBottomButton(
                metrics = scrolledUp,
                messageCount = 20,
                isScrollingToBottom = true,
                thresholdPx = thresholdPx,
            ),
        )
    }

    @Test
    fun autoScrollRespectsUserScrolledUpState() {
        val scrolledUp = ChatScrollMetrics(
            totalItemsCount = 21,
            lastVisibleItemIndex = 10,
            lastVisibleItemBottomPx = 980,
            viewportContentBottomPx = 1000,
            canScrollForward = true,
        )
        assertFalse(
            ChatScrollLogic.shouldAutoScrollOnMessageCountChange(
                metrics = scrolledUp,
                messageCount = 20,
                thresholdPx = thresholdPx,
            ),
        )
        assertFalse(
            ChatScrollLogic.shouldAutoScrollOnStreamingUpdate(
                metrics = scrolledUp,
                messageCount = 20,
                thresholdPx = thresholdPx,
            ),
        )

        val nearBottomAfterAppend = ChatScrollMetrics(
            totalItemsCount = 21,
            lastVisibleItemIndex = 18,
            lastVisibleItemBottomPx = 1030,
            viewportContentBottomPx = 1000,
            canScrollForward = true,
        )
        assertTrue(
            ChatScrollLogic.shouldAutoScrollOnMessageCountChange(
                metrics = nearBottomAfterAppend,
                messageCount = 20,
                thresholdPx = thresholdPx,
            ),
        )
    }
}
