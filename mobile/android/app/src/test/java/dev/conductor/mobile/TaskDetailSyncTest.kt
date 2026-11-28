package dev.conductor.mobile

import dev.conductor.mobile.model.AgentTask
import dev.conductor.mobile.model.TaskActivityLog
import dev.conductor.mobile.model.TaskDetailRefreshPlan
import dev.conductor.mobile.model.TaskDetailResponse
import dev.conductor.mobile.model.TaskDetailSync
import dev.conductor.mobile.model.TaskWorktreeStatus
import dev.conductor.mobile.model.WorkerActivityEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TaskDetailSyncTest {
    private fun makeActivity(
        id: String,
        kind: String,
        title: String,
        detail: String? = null,
        timestamp: String = "2026-11-28T01:00:00Z",
    ) = WorkerActivityEntry(
        id = id,
        kind = kind,
        title = title,
        detail = detail,
        timestamp = timestamp,
    )

    private fun makeTask(
        id: String = "task-1",
        status: String = "running",
        currentStep: String? = "作業中...",
        latestOutput: String = "",
        outputLength: Int? = null,
        activities: List<WorkerActivityEntry> = emptyList(),
        activityCount: Int? = null,
        latestActivity: WorkerActivityEntry? = null,
        landStatus: String? = null,
        updatedAt: String = "2026-11-28T01:00:00Z",
    ) = AgentTask(
        id = id,
        taskNumber = 12,
        title = "Fix mobile task progress",
        summary = "Ensure live logs and output appear on mobile",
        projectName = "conductor",
        projectPath = "/repo/conductor",
        worktreePath = "/repo/worktrees/task-12",
        status = status,
        currentStep = currentStep,
        latestOutput = latestOutput,
        outputLength = outputLength,
        activities = activities,
        activityCount = activityCount,
        latestActivity = latestActivity,
        landStatus = landStatus,
        updatedAt = updatedAt,
    )

    @Test
    fun mergeLiveTaskNeverFreezesOnStaleDetailWhilePreservingActivities() {
        val initialActivities = listOf(
            makeActivity("a1", "system", "Codex ワーカー開始"),
            makeActivity("a2", "command", "$ pnpm test", "PASS 10 tests"),
        )
        val staleDetail = makeTask(
            status = "running",
            currentStep = "実行中: pnpm test",
            latestOutput = "",
            activities = initialActivities,
            updatedAt = "2026-11-28T01:01:00Z",
        )
        val freshSnapshot = makeTask(
            status = "needs_review",
            currentStep = "完了（確認待ち）",
            latestOutput = "## 完了レポート\n修正が完了しました。",
            outputLength = 24,
            activities = emptyList(), // stripped in remote snapshot
            activityCount = 3,
            latestActivity = makeActivity("a3", "message", "Worker 報告"),
            updatedAt = "2026-11-28T01:02:00Z",
        )

        val merged = TaskDetailSync.mergeLiveTask(
            snapshotTask = freshSnapshot,
            detailTask = staleDetail,
        )
        assertNotNull(merged)
        assertEquals("needs_review", merged!!.status)
        assertEquals("完了（確認待ち）", merged.currentStep)
        assertEquals("## 完了レポート\n修正が完了しました。", merged.latestOutput)
        assertEquals(2, merged.activities.size) // preserved from detail until new detail arrives
        assertEquals(3, merged.effectiveActivityCount)
    }

    @Test
    fun mergeLiveTaskPreservesUntruncatedDetailOutputWhenSnapshotIsTruncated() {
        val fullOutput = "x".repeat(4_500) + "TAIL_END"
        val truncatedSnapshotOutput = fullOutput.takeLast(3_000)

        val detail = makeTask(
            status = "needs_review",
            latestOutput = fullOutput,
            activities = listOf(makeActivity("a1", "command", "$ pnpm build")),
            updatedAt = "2026-11-28T01:05:00Z",
        )
        val snapshot = makeTask(
            status = "needs_review",
            latestOutput = truncatedSnapshotOutput,
            outputLength = fullOutput.length,
            activities = emptyList(),
            activityCount = 1,
            updatedAt = "2026-11-28T01:05:00Z",
        )

        val merged = TaskDetailSync.mergeLiveTask(snapshotTask = snapshot, detailTask = detail)
        assertEquals(fullOutput, merged!!.latestOutput)
    }

    @Test
    fun mergeLiveTaskUsesLatestActivityFallbackBeforeDetailLoads() {
        val latestAct = makeActivity("a1", "command", "$ ./gradlew testDebugUnitTest")
        val snapshot = makeTask(
            activities = emptyList(),
            activityCount = 1,
            latestActivity = latestAct,
        )

        val merged = TaskDetailSync.mergeLiveTask(snapshotTask = snapshot, detailTask = null)
        assertEquals(listOf(latestAct), merged!!.activities)
        assertEquals(1, merged.effectiveActivityCount)
    }

    @Test
    fun resolveDetailRefreshPlanTriggersFastRefreshForActivityUpdatesAndFullRefreshOnStatusChange() {
        val detail = makeTask(
            status = "running",
            latestOutput = "partial",
            activities = listOf(makeActivity("a1", "command", "$ ls")),
            updatedAt = "2026-11-28T01:00:00Z",
        )

        // No change -> NONE
        assertEquals(
            TaskDetailRefreshPlan.NONE,
            TaskDetailSync.resolveDetailRefreshPlan(
                previousSnapshotTask = detail.copy(activities = emptyList(), activityCount = 1),
                incomingSnapshotTask = detail.copy(activities = emptyList(), activityCount = 1),
                currentDetailTask = detail,
            ),
        )

        // New activity -> ACTIVITIES_ONLY (skipGit=1)
        assertEquals(
            TaskDetailRefreshPlan.ACTIVITIES_ONLY,
            TaskDetailSync.resolveDetailRefreshPlan(
                previousSnapshotTask = detail.copy(activities = emptyList(), activityCount = 1),
                incomingSnapshotTask = detail.copy(
                    activities = emptyList(),
                    activityCount = 2,
                    updatedAt = "2026-11-28T01:00:05Z",
                ),
                currentDetailTask = detail,
            ),
        )

        // Status transition running -> needs_review -> FULL_WITH_GIT
        assertEquals(
            TaskDetailRefreshPlan.FULL_WITH_GIT,
            TaskDetailSync.resolveDetailRefreshPlan(
                previousSnapshotTask = detail.copy(status = "running", activities = emptyList()),
                incomingSnapshotTask = detail.copy(status = "needs_review", activities = emptyList()),
                currentDetailTask = detail,
            ),
        )

        // No cached detail yet -> FULL_WITH_GIT
        assertEquals(
            TaskDetailRefreshPlan.FULL_WITH_GIT,
            TaskDetailSync.resolveDetailRefreshPlan(
                previousSnapshotTask = null,
                incomingSnapshotTask = detail,
                currentDetailTask = null,
            ),
        )
    }

    @Test
    fun mergeDetailResponsePreservesWorktreeAndGitStatusOnSkipGitRefresh() {
        val prev = TaskDetailResponse(
            ok = true,
            task = makeTask(latestOutput = "old"),
            worktreeStatus = TaskWorktreeStatus(hasWorktree = true, worktreeBranch = "conductor/t12", aheadCommits = 2),
            gitStatus = "M src/app.ts",
        )
        val incoming = TaskDetailResponse(
            ok = true,
            task = makeTask(
                latestOutput = "new streaming output",
                activities = listOf(makeActivity("a1", "command", "$ pnpm test")),
            ),
            worktreeStatus = null,
            gitStatus = null,
        )

        val merged = TaskDetailSync.mergeDetailResponse(prev, incoming, skipGit = true)
        assertEquals("new streaming output", merged.task?.latestOutput)
        assertEquals(1, merged.task?.activities?.size)
        assertEquals("conductor/t12", merged.worktreeStatus?.worktreeBranch)
        assertEquals("M src/app.ts", merged.gitStatus)
    }

    @Test
    fun buildTaskMarkdownBasePathPrefersWorktreeThenProjectPath() {
        val withWorktree = makeTask()
        assertEquals(
            "/repo/worktrees/task-12/__task_report__.md",
            TaskDetailSync.buildTaskMarkdownBasePath(withWorktree),
        )

        val projectOnly = withWorktree.copy(worktreePath = null)
        assertEquals(
            "/repo/conductor/__task_report__.md",
            TaskDetailSync.buildTaskMarkdownBasePath(projectOnly),
        )

        val neither = projectOnly.copy(projectPath = null)
        assertNull(TaskDetailSync.buildTaskMarkdownBasePath(neither))
    }

    @Test
    fun partitionTaskActivitiesMirrorsDesktopHighSignalAndToolCounts() {
        val activities = listOf(
            makeActivity("1", "system", "Worker started"),
            makeActivity("2", "command", "$ pnpm test", "PASS"),
            makeActivity("3", "command", "default_api:read_file", "src/App.tsx"),
            makeActivity("4", "command", "default_api:read_file", "src/main.ts"),
            makeActivity("5", "file", "Modified 2 file(s)", "src/App.tsx, src/main.ts"),
            makeActivity("6", "reasoning", "Analyzing bug"),
            makeActivity("7", "system", "system_message", "heartbeat"),
            makeActivity("8", "error", "Build failed", "exit 1"),
        )

        val partitioned = TaskActivityLog.partitionTaskActivities(activities)
        // High signal is newest-first: error -> file -> system("Worker started")
        assertEquals(listOf("8", "5", "1"), partitioned.highSignal.map { it.id })
        // Routine tool logs are chronological: command, read_file, read_file, reasoning, system_message
        assertEquals(listOf("2", "3", "4", "6", "7"), partitioned.toolActivities.map { it.id })
        assertEquals("read_file", partitioned.toolCounts[0].name)
        assertEquals(2, partitioned.toolCounts[0].count)

        val summary = TaskActivityLog.formatToolLogSummary(
            totalCount = partitioned.toolActivities.size,
            toolCounts = partitioned.toolCounts,
        )
        assertTrue(summary.contains("全 5件"))
        assertTrue(summary.contains("read_file ×2"))
        assertTrue(summary.contains("run_command ×1"))
        assertFalse(summary.contains("default_api:"))
    }
}
