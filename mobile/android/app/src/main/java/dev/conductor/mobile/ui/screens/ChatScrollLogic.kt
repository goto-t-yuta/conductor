package dev.conductor.mobile.ui.screens

import androidx.compose.foundation.lazy.LazyListState
import kotlin.math.max

/**
 * Snapshot of [LazyListState] geometry used to determine whether the chat list
 * is anchored at the latest message or scrolled upward into history.
 */
data class ChatScrollMetrics(
    val totalItemsCount: Int,
    val lastVisibleItemIndex: Int?,
    val lastVisibleItemBottomPx: Int?,
    val viewportContentBottomPx: Int,
    val canScrollForward: Boolean,
)

/**
 * Pure scroll-position heuristics for the Android chat screen, aligned with
 * desktop Conductor's T53 scroll-to-bottom behavior.
 */
object ChatScrollLogic {
    /** Matches desktop's 24px bottom threshold in density-independent pixels. */
    const val BOTTOM_THRESHOLD_DP = 24

    /**
     * Returns whether the user is effectively at the bottom of the chat timeline
     * (within [thresholdPx] of the latest message bottom).
     */
    fun isAtBottom(
        metrics: ChatScrollMetrics,
        messageCount: Int,
        thresholdPx: Int,
    ): Boolean {
        if (messageCount <= 0 || metrics.totalItemsCount <= 0) return true
        if (!metrics.canScrollForward) return true

        val lastVisibleIndex = metrics.lastVisibleItemIndex ?: return true
        val lastMessageIndex = messageCount - 1
        if (lastVisibleIndex < lastMessageIndex) return false

        val lastVisibleBottom = metrics.lastVisibleItemBottomPx ?: return false
        val distanceFromBottom = max(0, lastVisibleBottom - metrics.viewportContentBottomPx)
        return distanceFromBottom <= thresholdPx
    }

    /**
     * Returns true only when there are messages, the user is scrolled above the
     * bottom threshold, and we are not already smoothly scrolling to the bottom.
     */
    fun shouldShowScrollToBottomButton(
        metrics: ChatScrollMetrics,
        messageCount: Int,
        isScrollingToBottom: Boolean,
        thresholdPx: Int,
    ): Boolean {
        if (messageCount <= 0 || isScrollingToBottom) return false
        if (metrics.totalItemsCount <= 0 || !metrics.canScrollForward) return false
        if (metrics.lastVisibleItemIndex == null) return false
        return !isAtBottom(
            metrics = metrics,
            messageCount = messageCount,
            thresholdPx = thresholdPx,
        )
    }

    /**
     * Decides whether a newly appended message should auto-scroll the list to the bottom.
     * Allows a small grace window for the newly added item(s) at the tail.
     */
    fun shouldAutoScrollOnMessageCountChange(
        metrics: ChatScrollMetrics,
        messageCount: Int,
        thresholdPx: Int,
    ): Boolean {
        if (messageCount <= 0) return false
        if (metrics.totalItemsCount <= 0 || metrics.lastVisibleItemIndex == null) return true
        if (!metrics.canScrollForward) return true

        val lastVisibleIndex = metrics.lastVisibleItemIndex
        val lastMessageIndex = messageCount - 1
        if (lastVisibleIndex >= lastMessageIndex) {
            return isAtBottom(metrics, messageCount, thresholdPx * 2)
        }
        // When a brand-new message was just appended while the user was at the bottom,
        // the previously-last message is at index `lastMessageIndex - 1`.
        return lastVisibleIndex >= lastMessageIndex - 1 &&
            metrics.lastVisibleItemBottomPx != null &&
            (metrics.lastVisibleItemBottomPx - metrics.viewportContentBottomPx) <= thresholdPx * 2
    }

    /**
     * Decides whether streaming updates to the latest message should keep the list
     * pinned to the bottom without pulling a reader who scrolled up.
     */
    fun shouldAutoScrollOnStreamingUpdate(
        metrics: ChatScrollMetrics,
        messageCount: Int,
        thresholdPx: Int,
    ): Boolean {
        if (messageCount <= 0) return false
        if (metrics.totalItemsCount <= 0 || metrics.lastVisibleItemIndex == null) return false
        return isAtBottom(
            metrics = metrics,
            messageCount = messageCount,
            thresholdPx = thresholdPx * 2,
        )
    }
}

internal fun LazyListState.toChatScrollMetrics(): ChatScrollMetrics {
    val info = layoutInfo
    val lastVisible = info.visibleItemsInfo.lastOrNull()
    val viewportContentBottom = info.viewportEndOffset - info.afterContentPadding
    return ChatScrollMetrics(
        totalItemsCount = info.totalItemsCount,
        lastVisibleItemIndex = lastVisible?.index,
        lastVisibleItemBottomPx = lastVisible?.let { it.offset + it.size },
        viewportContentBottomPx = viewportContentBottom,
        canScrollForward = canScrollForward,
    )
}
