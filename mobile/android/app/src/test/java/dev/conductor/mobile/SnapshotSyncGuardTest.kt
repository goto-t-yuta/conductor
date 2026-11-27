package dev.conductor.mobile

import dev.conductor.mobile.model.AppSnapshot
import dev.conductor.mobile.model.ChatMessage
import dev.conductor.mobile.model.SnapshotSyncGuard
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SnapshotSyncGuardTest {
    private fun msg(id: String, text: String = id) = ChatMessage(
        id = id,
        role = "user",
        text = text,
    )

    @Test
    fun acceptsFirstSnapshot() {
        val incoming = AppSnapshot(snapshotEpoch = "e1", snapshotVersion = 1L)
        assertTrue(SnapshotSyncGuard.shouldAccept(null, incoming, fromSse = false))
    }

    @Test
    fun rejectsStaleSnapshotWithinSameEpoch() {
        val current = AppSnapshot(
            snapshotEpoch = "e1",
            snapshotVersion = 10L,
            activeChatSessionId = "s1",
            messages = listOf(msg("m1"), msg("m2")),
        )
        val stale = AppSnapshot(
            snapshotEpoch = "e1",
            snapshotVersion = 8L,
            activeChatSessionId = "s1",
            messages = listOf(msg("m1")),
        )
        assertFalse(SnapshotSyncGuard.shouldAccept(current, stale, fromSse = false))
        assertFalse(SnapshotSyncGuard.shouldAccept(current, stale, fromSse = true))
    }

    @Test
    fun acceptsEqualOrNewerVersionWithinSameEpoch() {
        val current = AppSnapshot(snapshotEpoch = "e1", snapshotVersion = 10L)
        assertTrue(
            SnapshotSyncGuard.shouldAccept(
                current,
                AppSnapshot(snapshotEpoch = "e1", snapshotVersion = 10L),
                fromSse = false,
            ),
        )
        assertTrue(
            SnapshotSyncGuard.shouldAccept(
                current,
                AppSnapshot(snapshotEpoch = "e1", snapshotVersion = 11L),
                fromSse = true,
            ),
        )
    }

    @Test
    fun acceptsNewEpochAfterDesktopRestart() {
        val current = AppSnapshot(snapshotEpoch = "e1", snapshotVersion = 50L)
        val restarted = AppSnapshot(snapshotEpoch = "e2", snapshotVersion = 1L)
        assertTrue(SnapshotSyncGuard.shouldAccept(current, restarted, fromSse = true))
    }

    @Test
    fun legacyServerFallbackRejectsLaggingPollPrefixButAllowsSse() {
        val current = AppSnapshot(
            activeChatSessionId = "s1",
            messages = listOf(msg("m1"), msg("m2"), msg("m3")),
        )
        val laggingPoll = AppSnapshot(
            activeChatSessionId = "s1",
            messages = listOf(msg("m1"), msg("m2")),
        )
        assertFalse(SnapshotSyncGuard.shouldAccept(current, laggingPoll, fromSse = false))
        assertTrue(SnapshotSyncGuard.shouldAccept(current, laggingPoll, fromSse = true))
    }
}
