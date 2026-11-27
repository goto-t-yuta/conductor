package dev.conductor.mobile.model

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

enum class TaskDetailRefreshPlan {
    NONE,
    ACTIVITIES_ONLY,
    FULL_WITH_GIT,
}

/**
 * Keeps the open Task Detail bottom sheet synchronized with live SSE snapshots while
 * preserving full activities, untruncated output, and worktree/git metadata fetched
 * from `GET /api/tasks/:id`.
 */
object TaskDetailSync {
    private val timeFormatter: DateTimeFormatter =
        DateTimeFormatter.ofPattern("HH:mm:ss").withZone(ZoneId.systemDefault())

    /**
     * Merges a live snapshot task (compact, real-time) with a detailed task fetched from
     * `GET /api/tasks/:id` (full activities & full output).
     *
     * Never allows a stale detail response to freeze `status`, `currentStep`, `landStatus`,
     * or newly streamed `latestOutput` updates coming from SSE.
     */
    fun mergeLiveTask(
        snapshotTask: AgentTask?,
        detailTask: AgentTask?,
    ): AgentTask? {
        if (snapshotTask == null && detailTask == null) return null
        if (detailTask == null) {
            val s = snapshotTask!!
            val fallbackActs = if (s.activities.isNotEmpty()) {
                s.activities
            } else {
                listOfNotNull(s.latestActivity)
            }
            return if (fallbackActs === s.activities) s else s.copy(activities = fallbackActs)
        }
        if (snapshotTask == null) return detailTask

        val snapMillis = parseIsoMillis(snapshotTask.updatedAt)
        val detailMillis = parseIsoMillis(detailTask.updatedAt)
        val snapOutput = snapshotTask.latestOutput
        val detailOutput = detailTask.latestOutput
        val snapOutputLen = snapshotTask.outputLength ?: snapOutput.length

        val preferDetailOutput = detailOutput.isNotEmpty() && (
            (detailMillis != null && snapMillis != null && detailMillis >= snapMillis) ||
                (detailOutput.length >= snapOutputLen && detailOutput.endsWith(snapOutput))
            )

        val resolvedOutput = when {
            preferDetailOutput -> detailOutput
            snapOutput.isNotEmpty() -> snapOutput
            else -> detailOutput
        }

        val resolvedActivities = when {
            detailTask.activities.isNotEmpty() -> detailTask.activities
            snapshotTask.activities.isNotEmpty() -> snapshotTask.activities
            snapshotTask.latestActivity != null -> listOf(snapshotTask.latestActivity)
            else -> emptyList()
        }

        val resolvedActivityCount = maxOf(
            resolvedActivities.size,
            snapshotTask.activityCount ?: 0,
            detailTask.activityCount ?: 0,
        )

        return detailTask.copy(
            taskNumber = snapshotTask.taskNumber.takeIf { it > 0 } ?: detailTask.taskNumber,
            title = snapshotTask.title.ifBlank { detailTask.title },
            summary = snapshotTask.summary.ifBlank { detailTask.summary },
            projectId = snapshotTask.projectId ?: detailTask.projectId,
            projectName = snapshotTask.projectName.ifBlank { detailTask.projectName },
            projectPath = snapshotTask.projectPath ?: detailTask.projectPath,
            status = snapshotTask.status,
            provider = snapshotTask.provider ?: detailTask.provider,
            currentStep = snapshotTask.currentStep ?: detailTask.currentStep,
            previewURL = snapshotTask.previewURL ?: detailTask.previewURL,
            latestOutput = resolvedOutput,
            outputLength = maxOf(resolvedOutput.length, snapOutputLen),
            activities = resolvedActivities,
            activityCount = resolvedActivityCount,
            latestActivity = snapshotTask.latestActivity ?: resolvedActivities.lastOrNull() ?: detailTask.latestActivity,
            worktreePath = snapshotTask.worktreePath,
            worktreeBranch = snapshotTask.worktreeBranch,
            baseBranch = snapshotTask.baseBranch ?: detailTask.baseBranch,
            landStatus = snapshotTask.landStatus,
            landedBranch = snapshotTask.landedBranch,
            landedCommit = snapshotTask.landedCommit ?: detailTask.landedCommit,
            prUrl = snapshotTask.prUrl ?: detailTask.prUrl,
            landError = snapshotTask.landError,
            conflictFiles = snapshotTask.conflictFiles.ifEmpty { detailTask.conflictFiles },
            createdAt = snapshotTask.createdAt.ifBlank { detailTask.createdAt },
            updatedAt = snapshotTask.updatedAt.ifBlank { detailTask.updatedAt },
        )
    }

    /**
     * Decides whether an incoming SSE/poll snapshot requires re-fetching `GET /api/tasks/:id`
     * for the currently open task detail sheet.
     */
    fun resolveDetailRefreshPlan(
        previousSnapshotTask: AgentTask?,
        incomingSnapshotTask: AgentTask?,
        currentDetailTask: AgentTask?,
    ): TaskDetailRefreshPlan {
        val incoming = incomingSnapshotTask ?: return TaskDetailRefreshPlan.NONE
        if (currentDetailTask == null) {
            return TaskDetailRefreshPlan.FULL_WITH_GIT
        }
        val statusChanged = (previousSnapshotTask != null && previousSnapshotTask.status != incoming.status) ||
            currentDetailTask.status != incoming.status
        val landStatusChanged = (previousSnapshotTask != null && previousSnapshotTask.landStatus != incoming.landStatus) ||
            currentDetailTask.landStatus != incoming.landStatus
        if (statusChanged || landStatusChanged) {
            return TaskDetailRefreshPlan.FULL_WITH_GIT
        }

        val incomingActCount = incoming.activityCount
        if (incomingActCount != null && incomingActCount != currentDetailTask.activities.size) {
            return TaskDetailRefreshPlan.ACTIVITIES_ONLY
        }

        val incomingLatestActId = incoming.latestActivity?.id?.takeIf { it.isNotBlank() }
        val detailLatestActId = currentDetailTask.activities.lastOrNull()?.id?.takeIf { it.isNotBlank() }
        if (incomingLatestActId != null && incomingLatestActId != detailLatestActId) {
            return TaskDetailRefreshPlan.ACTIVITIES_ONLY
        }

        val incomingOutputLen = incoming.outputLength ?: incoming.latestOutput.length
        if (incomingOutputLen > currentDetailTask.latestOutput.length) {
            return TaskDetailRefreshPlan.ACTIVITIES_ONLY
        }

        if (incoming.updatedAt.isNotBlank() &&
            currentDetailTask.updatedAt.isNotBlank() &&
            incoming.updatedAt != currentDetailTask.updatedAt
        ) {
            return TaskDetailRefreshPlan.ACTIVITIES_ONLY
        }

        return TaskDetailRefreshPlan.NONE
    }

    /**
     * When refreshing with `skipGit = true` during live streaming, preserve previously fetched
     * `worktreeStatus` and `gitStatus` so the Git panel does not flicker or vanish.
     */
    fun mergeDetailResponse(
        previous: TaskDetailResponse?,
        incoming: TaskDetailResponse,
        skipGit: Boolean,
    ): TaskDetailResponse {
        if (!skipGit || previous == null) return incoming
        return incoming.copy(
            worktreeStatus = incoming.worktreeStatus ?: previous.worktreeStatus,
            gitStatus = incoming.gitStatus ?: previous.gitStatus,
        )
    }

    /**
     * Mirrors desktop `buildTaskMarkdownBasePath` so relative image paths inside task reports
     * resolve against the worktree or project root directory.
     */
    fun buildTaskMarkdownBasePath(task: AgentTask?): String? {
        val dir = task?.worktreePath?.trim()?.takeIf { it.isNotEmpty() }
            ?: task?.projectPath?.trim()?.takeIf { it.isNotEmpty() }
            ?: return null
        val normalized = dir.trimEnd('/', '\\')
        if (normalized.isEmpty()) return null
        return "$normalized/__task_report__.md"
    }

    fun formatActivityShortTime(timestamp: String?): String {
        val raw = timestamp?.trim().orEmpty()
        if (raw.isEmpty()) return ""
        return runCatching { timeFormatter.format(Instant.parse(raw)) }.getOrDefault("")
    }

    private fun parseIsoMillis(iso: String?): Long? {
        val raw = iso?.trim().orEmpty()
        if (raw.isEmpty()) return null
        return runCatching { Instant.parse(raw).toEpochMilli() }.getOrNull()
    }
}
