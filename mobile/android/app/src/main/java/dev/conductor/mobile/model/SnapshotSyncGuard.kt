package dev.conductor.mobile.model

/**
 * Prevents stale out-of-order snapshots (e.g. a slower polling or REST response arriving
 * after a newer SSE frame) from overwriting the chat history on Android.
 */
object SnapshotSyncGuard {
    fun shouldAccept(
        current: AppSnapshot?,
        incoming: AppSnapshot,
        fromSse: Boolean,
    ): Boolean {
        if (current == null) return true

        val curEpoch = current.snapshotEpoch?.takeIf { it.isNotBlank() }
        val nextEpoch = incoming.snapshotEpoch?.takeIf { it.isNotBlank() }
        val curVersion = current.snapshotVersion
        val nextVersion = incoming.snapshotVersion

        if (curEpoch != null && nextEpoch != null) {
            if (curEpoch != nextEpoch) {
                // Desktop controller restarted with a new epoch; always adopt.
                return true
            }
            if (curVersion != null && nextVersion != null) {
                return nextVersion >= curVersion
            }
        }

        // Backward-compatible fallback when talking to an older desktop build without version metadata:
        // reject a lagging non-SSE poll that has strictly fewer messages for the same active session
        // whose IDs are all a prefix of the current messages.
        if (
            !fromSse &&
            current.activeChatSessionId.isNotBlank() &&
            current.activeChatSessionId == incoming.activeChatSessionId &&
            incoming.messages.size < current.messages.size &&
            isPrefixById(incoming.messages, current.messages)
        ) {
            return false
        }

        return true
    }

    fun isKnownSession(snapshot: AppSnapshot?, sessionId: String?): Boolean {
        val clean = sessionId?.trim().orEmpty()
        if (snapshot == null || clean.isEmpty()) return false
        if (snapshot.activeChatSessionId == clean) return true
        return snapshot.chatSessions.any { it.id == clean }
    }

    private fun isPrefixById(shorter: List<ChatMessage>, longer: List<ChatMessage>): Boolean {
        for (i in shorter.indices) {
            if (shorter[i].id != longer[i].id) return false
        }
        return true
    }
}
