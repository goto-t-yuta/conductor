package dev.conductor.mobile.ui.screens

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import dev.conductor.mobile.model.ChatMessage
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
 * Lightweight summary of the current chat timeline used to distinguish returning
 * to the Chat tab (no change) from newly appended messages, streaming updates,
 * or switching/resetting to a different chat session.
 */
data class ChatTimelineSnapshot(
    val sessionId: String = "",
    val messageCount: Int = 0,
    val firstMessageId: String? = null,
    val lastMessageId: String? = null,
    val lastMessageRole: String? = null,
    val lastMessageContentFingerprint: String = "",
)

/**
 * Persistent scroll tracking state hoisted above tab switching so returning to
 * the Chat tab preserves the reader's position without accidental auto-scroll.
 */
data class ChatScrollSessionSnapshot(
    val sessionId: String = "",
    val hasInitializedScroll: Boolean = false,
    val isPinnedToBottom: Boolean = true,
    val lastObservedMessageCount: Int = 0,
    val lastObservedFirstMessageId: String? = null,
    val lastObservedLastMessageId: String? = null,
    val lastObservedLastMessageContentFingerprint: String = "",
)

data class ChatScrollResolution(
    val nextSession: ChatScrollSessionSnapshot,
    val shouldScrollToBottom: Boolean,
)

@Stable
class ChatScrollSessionState(
    initial: ChatScrollSessionSnapshot = ChatScrollSessionSnapshot(),
) {
    var snapshot by mutableStateOf(initial)
        private set

    fun apply(next: ChatScrollSessionSnapshot) {
        snapshot = next
    }

    fun updatePinnedToBottom(pinned: Boolean) {
        if (snapshot.isPinnedToBottom != pinned) {
            snapshot = snapshot.copy(isPinnedToBottom = pinned)
        }
    }

    fun reset() {
        snapshot = ChatScrollSessionSnapshot()
    }

    companion object {
        val Saver: Saver<ChatScrollSessionState, Any> = listSaver(
            save = { state ->
                val s = state.snapshot
                listOf(
                    s.sessionId,
                    s.hasInitializedScroll,
                    s.isPinnedToBottom,
                    s.lastObservedMessageCount,
                    s.lastObservedFirstMessageId,
                    s.lastObservedLastMessageId,
                    s.lastObservedLastMessageContentFingerprint,
                )
            },
            restore = { saved ->
                ChatScrollSessionState(
                    ChatScrollSessionSnapshot(
                        sessionId = saved.getOrNull(0) as? String ?: "",
                        hasInitializedScroll = saved.getOrNull(1) as? Boolean ?: false,
                        isPinnedToBottom = saved.getOrNull(2) as? Boolean ?: true,
                        lastObservedMessageCount = saved.getOrNull(3) as? Int ?: 0,
                        lastObservedFirstMessageId = saved.getOrNull(4) as? String,
                        lastObservedLastMessageId = saved.getOrNull(5) as? String,
                        lastObservedLastMessageContentFingerprint = saved.getOrNull(6) as? String ?: "",
                    ),
                )
            },
        )
    }
}

@Composable
fun rememberChatScrollSessionState(): ChatScrollSessionState =
    rememberSaveable(saver = ChatScrollSessionState.Saver) {
        ChatScrollSessionState()
    }

/**
 * Pure scroll-position heuristics for the Android chat screen, aligned with
 * desktop Conductor's T53 scroll-to-bottom behavior.
 */
object ChatScrollLogic {
    /** Matches desktop's 24px bottom threshold in density-independent pixels. */
    const val BOTTOM_THRESHOLD_DP = 24

    fun buildMessageContentFingerprint(message: ChatMessage?): String {
        if (message == null) return ""
        val reasoningLen = message.reasoningSummary?.length ?: 0
        return "${message.text.length}:$reasoningLen:${message.toolChips.size}:${message.attachments.size}:${message.isStreaming}"
    }

    /**
     * Resolves whether the chat list should auto-scroll to the bottom when
     * [ChatScreen] enters composition or when the timeline updates.
     *
     * Key guarantees:
     * - Returning to Chat while scrolled up (`isPinnedToBottom == false`) NEVER
     *   overwrites the preserved [LazyListState] position, even if the latest
     *   message is a user message or new assistant/system updates arrived while away.
     * - Returning to Chat while anchored at the bottom (`isPinnedToBottom == true`)
     *   keeps the list at the bottom and catches up with any new messages.
     * - Sending a brand-new user message always scrolls to the bottom and re-pins.
     */
    fun resolveScrollOnTimelineUpdate(
        previous: ChatScrollSessionSnapshot,
        current: ChatTimelineSnapshot,
        isCompositionEntry: Boolean,
        isUserScrolling: Boolean = false,
        isAnimatingScrollToBottom: Boolean = false,
    ): ChatScrollResolution {
        if (current.messageCount <= 0) {
            return ChatScrollResolution(
                nextSession = ChatScrollSessionSnapshot(
                    sessionId = current.sessionId,
                    hasInitializedScroll = false,
                    isPinnedToBottom = true,
                ),
                shouldScrollToBottom = false,
            )
        }

        val isSessionChanged = previous.sessionId.isNotEmpty() &&
            current.sessionId.isNotEmpty() &&
            previous.sessionId != current.sessionId

        val isConversationReplaced = previous.hasInitializedScroll &&
            previous.lastObservedFirstMessageId != null &&
            current.firstMessageId != null &&
            previous.lastObservedFirstMessageId != current.firstMessageId &&
            current.messageCount < previous.lastObservedMessageCount

        if (!previous.hasInitializedScroll || isSessionChanged || isConversationReplaced) {
            return ChatScrollResolution(
                nextSession = ChatScrollSessionSnapshot(
                    sessionId = current.sessionId,
                    hasInitializedScroll = true,
                    isPinnedToBottom = true,
                    lastObservedMessageCount = current.messageCount,
                    lastObservedFirstMessageId = current.firstMessageId,
                    lastObservedLastMessageId = current.lastMessageId,
                    lastObservedLastMessageContentFingerprint = current.lastMessageContentFingerprint,
                ),
                shouldScrollToBottom = true,
            )
        }

        val resolvedSessionId = current.sessionId.ifEmpty { previous.sessionId }
        val hasNewMessage = current.messageCount > previous.lastObservedMessageCount ||
            (
                current.messageCount >= previous.lastObservedMessageCount &&
                    current.lastMessageId != previous.lastObservedLastMessageId
                )
        val hasStreamingUpdate = !hasNewMessage &&
            current.lastMessageId == previous.lastObservedLastMessageId &&
            current.lastMessageContentFingerprint != previous.lastObservedLastMessageContentFingerprint
        val isNewUserMessage = hasNewMessage && current.lastMessageRole == "user"

        if (!hasNewMessage && !hasStreamingUpdate) {
            val shouldKeepBottomOnReturn = isCompositionEntry &&
                previous.isPinnedToBottom &&
                !isUserScrolling &&
                !isAnimatingScrollToBottom
            return ChatScrollResolution(
                nextSession = previous.copy(
                    sessionId = resolvedSessionId,
                    lastObservedFirstMessageId = current.firstMessageId,
                ),
                shouldScrollToBottom = shouldKeepBottomOnReturn,
            )
        }

        if (isNewUserMessage) {
            return ChatScrollResolution(
                nextSession = ChatScrollSessionSnapshot(
                    sessionId = resolvedSessionId,
                    hasInitializedScroll = true,
                    isPinnedToBottom = true,
                    lastObservedMessageCount = current.messageCount,
                    lastObservedFirstMessageId = current.firstMessageId,
                    lastObservedLastMessageId = current.lastMessageId,
                    lastObservedLastMessageContentFingerprint = current.lastMessageContentFingerprint,
                ),
                shouldScrollToBottom = true,
            )
        }

        val shouldFollow = previous.isPinnedToBottom &&
            !isUserScrolling &&
            !isAnimatingScrollToBottom
        return ChatScrollResolution(
            nextSession = ChatScrollSessionSnapshot(
                sessionId = resolvedSessionId,
                hasInitializedScroll = true,
                isPinnedToBottom = previous.isPinnedToBottom,
                lastObservedMessageCount = current.messageCount,
                lastObservedFirstMessageId = current.firstMessageId,
                lastObservedLastMessageId = current.lastMessageId,
                lastObservedLastMessageContentFingerprint = current.lastMessageContentFingerprint,
            ),
            shouldScrollToBottom = shouldFollow,
        )
    }

    /**
     * Updates the persisted bottom-pin flag only when the user actually scrolled
     * (or when the entire list fits without forward scroll), ignoring unmeasured
     * first frames and programmatic auto-scrolls.
     */
    fun resolvePinnedToBottomAfterScroll(
        currentPinned: Boolean,
        metrics: ChatScrollMetrics,
        messageCount: Int,
        thresholdPx: Int,
        isUserScrolling: Boolean,
        wasUserScrolling: Boolean,
        isAnimatingScrollToBottom: Boolean,
    ): Boolean {
        if (messageCount <= 0) return true
        if (isAnimatingScrollToBottom) return currentPinned
        if (metrics.totalItemsCount <= 0 || metrics.lastVisibleItemIndex == null) {
            return currentPinned
        }
        if (!metrics.canScrollForward) {
            return true
        }
        if (isUserScrolling || wasUserScrolling) {
            return isAtBottom(
                metrics = metrics,
                messageCount = messageCount,
                thresholdPx = thresholdPx,
            )
        }
        return currentPinned
    }

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
