package dev.conductor.mobile

import dev.conductor.mobile.model.ChatMessage
import dev.conductor.mobile.model.ToolActivityChip
import dev.conductor.mobile.ui.screens.ChatScrollLogic
import dev.conductor.mobile.ui.screens.ChatScrollMetrics
import dev.conductor.mobile.ui.screens.ChatScrollSessionSnapshot
import dev.conductor.mobile.ui.screens.ChatTimelineSnapshot
import org.junit.Assert.assertEquals
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

    @Test
    fun initialLoadScrollsToBottomOnceAndMarksSessionInitialized() {
        val initialTimeline = ChatTimelineSnapshot(
            sessionId = "session-1",
            messageCount = 20,
            firstMessageId = "msg-1",
            lastMessageId = "msg-20",
            lastMessageRole = "assistant",
            lastMessageContentFingerprint = "120:0:0:0:false",
        )

        val resolution = ChatScrollLogic.resolveScrollOnTimelineUpdate(
            previous = ChatScrollSessionSnapshot(),
            current = initialTimeline,
            isCompositionEntry = true,
        )

        assertTrue(resolution.shouldScrollToBottom)
        assertTrue(resolution.nextSession.hasInitializedScroll)
        assertTrue(resolution.nextSession.isPinnedToBottom)
        assertEquals(20, resolution.nextSession.lastObservedMessageCount)
        assertEquals("msg-20", resolution.nextSession.lastObservedLastMessageId)
    }

    @Test
    fun returningFromAnotherTabWhileScrolledUpPreservesPositionEvenWhenLastMessageIsUser() {
        val timeline = ChatTimelineSnapshot(
            sessionId = "session-1",
            messageCount = 20,
            firstMessageId = "msg-1",
            lastMessageId = "msg-20",
            lastMessageRole = "user",
            lastMessageContentFingerprint = "42:0:0:0:false",
        )
        val scrolledUpSession = ChatScrollSessionSnapshot(
            sessionId = "session-1",
            hasInitializedScroll = true,
            isPinnedToBottom = false,
            lastObservedMessageCount = 20,
            lastObservedFirstMessageId = "msg-1",
            lastObservedLastMessageId = "msg-20",
            lastObservedLastMessageContentFingerprint = "42:0:0:0:false",
        )

        val resolution = ChatScrollLogic.resolveScrollOnTimelineUpdate(
            previous = scrolledUpSession,
            current = timeline,
            isCompositionEntry = true,
        )

        assertFalse(resolution.shouldScrollToBottom)
        assertTrue(resolution.nextSession.hasInitializedScroll)
        assertFalse(resolution.nextSession.isPinnedToBottom)
    }

    @Test
    fun returningFromAnotherTabWhileScrolledUpDoesNotJumpWhenAssistantRepliedWhileAway() {
        val scrolledUpSession = ChatScrollSessionSnapshot(
            sessionId = "session-1",
            hasInitializedScroll = true,
            isPinnedToBottom = false,
            lastObservedMessageCount = 20,
            lastObservedFirstMessageId = "msg-1",
            lastObservedLastMessageId = "msg-20",
            lastObservedLastMessageContentFingerprint = "80:0:0:0:true",
        )
        val updatedWhileAway = ChatTimelineSnapshot(
            sessionId = "session-1",
            messageCount = 22,
            firstMessageId = "msg-1",
            lastMessageId = "msg-22",
            lastMessageRole = "assistant",
            lastMessageContentFingerprint = "240:0:1:0:false",
        )

        val resolution = ChatScrollLogic.resolveScrollOnTimelineUpdate(
            previous = scrolledUpSession,
            current = updatedWhileAway,
            isCompositionEntry = true,
        )

        assertFalse(resolution.shouldScrollToBottom)
        assertFalse(resolution.nextSession.isPinnedToBottom)
        assertEquals(22, resolution.nextSession.lastObservedMessageCount)
        assertEquals("msg-22", resolution.nextSession.lastObservedLastMessageId)
    }

    @Test
    fun returningFromAnotherTabWhileAtBottomMaintainsBottomAndFollowsNewMessages() {
        val pinnedSession = ChatScrollSessionSnapshot(
            sessionId = "session-1",
            hasInitializedScroll = true,
            isPinnedToBottom = true,
            lastObservedMessageCount = 20,
            lastObservedFirstMessageId = "msg-1",
            lastObservedLastMessageId = "msg-20",
            lastObservedLastMessageContentFingerprint = "80:0:0:0:false",
        )

        // Return with no new messages: stays anchored at bottom
        val unchangedReturn = ChatScrollLogic.resolveScrollOnTimelineUpdate(
            previous = pinnedSession,
            current = ChatTimelineSnapshot(
                sessionId = "session-1",
                messageCount = 20,
                firstMessageId = "msg-1",
                lastMessageId = "msg-20",
                lastMessageRole = "assistant",
                lastMessageContentFingerprint = "80:0:0:0:false",
            ),
            isCompositionEntry = true,
        )
        assertTrue(unchangedReturn.shouldScrollToBottom)
        assertTrue(unchangedReturn.nextSession.isPinnedToBottom)

        // Return after new assistant messages arrived while away: follows new bottom
        val newMessagesReturn = ChatScrollLogic.resolveScrollOnTimelineUpdate(
            previous = pinnedSession,
            current = ChatTimelineSnapshot(
                sessionId = "session-1",
                messageCount = 23,
                firstMessageId = "msg-1",
                lastMessageId = "msg-23",
                lastMessageRole = "assistant",
                lastMessageContentFingerprint = "190:0:0:0:true",
            ),
            isCompositionEntry = true,
        )
        assertTrue(newMessagesReturn.shouldScrollToBottom)
        assertTrue(newMessagesReturn.nextSession.isPinnedToBottom)
        assertEquals(23, newMessagesReturn.nextSession.lastObservedMessageCount)

        // Streaming update while staying on Chat continues following bottom
        val streamingFollow = ChatScrollLogic.resolveScrollOnTimelineUpdate(
            previous = newMessagesReturn.nextSession,
            current = ChatTimelineSnapshot(
                sessionId = "session-1",
                messageCount = 23,
                firstMessageId = "msg-1",
                lastMessageId = "msg-23",
                lastMessageRole = "assistant",
                lastMessageContentFingerprint = "320:0:0:0:true",
            ),
            isCompositionEntry = false,
        )
        assertTrue(streamingFollow.shouldScrollToBottom)
        assertTrue(streamingFollow.nextSession.isPinnedToBottom)
    }

    @Test
    fun sendingNewUserMessageRePinsAndScrollsToBottomFromHistory() {
        val scrolledUpSession = ChatScrollSessionSnapshot(
            sessionId = "session-1",
            hasInitializedScroll = true,
            isPinnedToBottom = false,
            lastObservedMessageCount = 20,
            lastObservedFirstMessageId = "msg-1",
            lastObservedLastMessageId = "msg-20",
            lastObservedLastMessageContentFingerprint = "80:0:0:0:false",
        )

        val resolution = ChatScrollLogic.resolveScrollOnTimelineUpdate(
            previous = scrolledUpSession,
            current = ChatTimelineSnapshot(
                sessionId = "session-1",
                messageCount = 21,
                firstMessageId = "msg-1",
                lastMessageId = "msg-21",
                lastMessageRole = "user",
                lastMessageContentFingerprint = "15:0:0:0:false",
            ),
            isCompositionEntry = false,
        )

        assertTrue(resolution.shouldScrollToBottom)
        assertTrue(resolution.nextSession.isPinnedToBottom)
    }

    @Test
    fun newChatAndSessionSwitchResetScrollToBottom() {
        val scrolledUpSession = ChatScrollSessionSnapshot(
            sessionId = "session-1",
            hasInitializedScroll = true,
            isPinnedToBottom = false,
            lastObservedMessageCount = 20,
            lastObservedFirstMessageId = "msg-1",
            lastObservedLastMessageId = "msg-20",
            lastObservedLastMessageContentFingerprint = "80:0:0:0:false",
        )

        // Emptying messages (New Chat) resets initialized flag
        val emptyResolution = ChatScrollLogic.resolveScrollOnTimelineUpdate(
            previous = scrolledUpSession,
            current = ChatTimelineSnapshot(sessionId = "session-2", messageCount = 0),
            isCompositionEntry = false,
        )
        assertFalse(emptyResolution.shouldScrollToBottom)
        assertFalse(emptyResolution.nextSession.hasInitializedScroll)
        assertTrue(emptyResolution.nextSession.isPinnedToBottom)

        // Switching directly to a different non-empty session jumps to bottom
        val switchedSession = ChatScrollLogic.resolveScrollOnTimelineUpdate(
            previous = scrolledUpSession,
            current = ChatTimelineSnapshot(
                sessionId = "session-2",
                messageCount = 5,
                firstMessageId = "other-1",
                lastMessageId = "other-5",
                lastMessageRole = "assistant",
                lastMessageContentFingerprint = "50:0:0:0:false",
            ),
            isCompositionEntry = true,
        )
        assertTrue(switchedSession.shouldScrollToBottom)
        assertTrue(switchedSession.nextSession.isPinnedToBottom)
        assertEquals("session-2", switchedSession.nextSession.sessionId)
    }

    @Test
    fun pinnedFlagIgnoresUnmeasuredFramesAndTracksUserScrollsAccurately() {
        val unmeasured = ChatScrollMetrics(
            totalItemsCount = 0,
            lastVisibleItemIndex = null,
            lastVisibleItemBottomPx = null,
            viewportContentBottomPx = 0,
            canScrollForward = false,
        )
        // Must preserve false on initial unmeasured frame when returning to Chat tab
        assertFalse(
            ChatScrollLogic.resolvePinnedToBottomAfterScroll(
                currentPinned = false,
                metrics = unmeasured,
                messageCount = 20,
                thresholdPx = thresholdPx,
                isUserScrolling = false,
                wasUserScrolling = false,
                isAnimatingScrollToBottom = false,
            ),
        )

        val scrolledUpMetrics = ChatScrollMetrics(
            totalItemsCount = 21,
            lastVisibleItemIndex = 10,
            lastVisibleItemBottomPx = 980,
            viewportContentBottomPx = 1000,
            canScrollForward = true,
        )
        // Non-user layout change (e.g. new message arriving before auto-scroll) keeps pinned = true
        assertTrue(
            ChatScrollLogic.resolvePinnedToBottomAfterScroll(
                currentPinned = true,
                metrics = scrolledUpMetrics,
                messageCount = 20,
                thresholdPx = thresholdPx,
                isUserScrolling = false,
                wasUserScrolling = false,
                isAnimatingScrollToBottom = false,
            ),
        )
        // User actively scrolling upward unpins from bottom
        assertFalse(
            ChatScrollLogic.resolvePinnedToBottomAfterScroll(
                currentPinned = true,
                metrics = scrolledUpMetrics,
                messageCount = 20,
                thresholdPx = thresholdPx,
                isUserScrolling = true,
                wasUserScrolling = false,
                isAnimatingScrollToBottom = false,
            ),
        )
        // Mid-animation of ScrollToBottom button does not clobber pinned state
        assertFalse(
            ChatScrollLogic.resolvePinnedToBottomAfterScroll(
                currentPinned = false,
                metrics = scrolledUpMetrics,
                messageCount = 20,
                thresholdPx = thresholdPx,
                isUserScrolling = false,
                wasUserScrolling = true,
                isAnimatingScrollToBottom = true,
            ),
        )

        val atBottomMetrics = ChatScrollMetrics(
            totalItemsCount = 21,
            lastVisibleItemIndex = 20,
            lastVisibleItemBottomPx = 1000,
            viewportContentBottomPx = 1000,
            canScrollForward = false,
        )
        // Reaching the bottom re-pins
        assertTrue(
            ChatScrollLogic.resolvePinnedToBottomAfterScroll(
                currentPinned = false,
                metrics = atBottomMetrics,
                messageCount = 20,
                thresholdPx = thresholdPx,
                isUserScrolling = false,
                wasUserScrolling = true,
                isAnimatingScrollToBottom = false,
            ),
        )
    }

    @Test
    fun messageFingerprintReflectsTextReasoningToolChipsAndStreamingState() {
        val base = ChatMessage(id = "m1", role = "assistant", text = "hello", isStreaming = true)
        val withChip = base.copy(toolChips = listOf(ToolActivityChip(id = "c1", label = "Read")))
        val finished = withChip.copy(isStreaming = false)

        val fpBase = ChatScrollLogic.buildMessageContentFingerprint(base)
        val fpChip = ChatScrollLogic.buildMessageContentFingerprint(withChip)
        val fpDone = ChatScrollLogic.buildMessageContentFingerprint(finished)

        assertTrue(fpBase != fpChip)
        assertTrue(fpChip != fpDone)
    }
}
