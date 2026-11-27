package dev.conductor.mobile

import dev.conductor.mobile.model.AgentTask
import dev.conductor.mobile.model.AppSnapshot
import dev.conductor.mobile.model.QuickTaskAction
import dev.conductor.mobile.model.TaskDetailResponse
import dev.conductor.mobile.model.TaskStatusActions
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TaskStatusActionsTest {
    private fun makeTask(
        id: String = "task-1",
        taskNumber: Int = 10,
        status: String = "needs_review",
        worktreePath: String? = null,
        worktreeBranch: String? = null,
        landStatus: String? = null,
    ) = AgentTask(
        id = id,
        taskNumber = taskNumber,
        title = "Sample Task",
        projectName = "conductor",
        status = status,
        worktreePath = worktreePath,
        worktreeBranch = worktreeBranch,
        landStatus = landStatus,
    )

    @Test
    fun hidesQuickTransitionForRunningTasksAndBlocksMarkDone() {
        val running = makeTask(status = "running")
        assertNull(TaskStatusActions.getQuickTransition(running))
        assertFalse(TaskStatusActions.canMarkDone(running))
        assertEquals(
            TaskStatusActions.RUNNING_DONE_BLOCKED_REASON,
            TaskStatusActions.getMarkDoneBlockedReason(running),
        )
        assertFalse(TaskStatusActions.canQuickLand(running))
    }

    @Test
    fun enablesQuickDoneForIncompleteNonRunningTasksWithoutUnlandedWorktree() {
        for (status in listOf("needs_review", "queued", "failed")) {
            val task = makeTask(status = status)
            val transition = TaskStatusActions.getQuickTransition(task)
            assertNotNull("Expected transition for status=$status", transition)
            assertEquals(QuickTaskAction.DONE, transition!!.action)
            assertEquals("done", transition.nextStatus)
            assertFalse(transition.isBlocked)
            assertNull(transition.blockedReason)
            assertTrue(TaskStatusActions.canMarkDone(task))
        }
    }

    @Test
    fun blocksQuickDoneForUnlandedWorktreeAndUnlocksAfterLandOrPushOrPr() {
        val unlanded = makeTask(
            status = "needs_review",
            worktreePath = "/tmp/wt/t10",
            worktreeBranch = "conductor/task-10",
            landStatus = "unlanded",
        )
        val blockedTransition = TaskStatusActions.getQuickTransition(unlanded)
        assertNotNull(blockedTransition)
        assertEquals(QuickTaskAction.DONE, blockedTransition!!.action)
        assertTrue(blockedTransition.isBlocked)
        assertEquals(TaskStatusActions.UNLANDED_DONE_BLOCKED_REASON, blockedTransition.blockedReason)
        assertFalse(TaskStatusActions.canMarkDone(unlanded))
        assertTrue(TaskStatusActions.canQuickLand(unlanded))

        for (resolvedStatus in listOf("landed", "pushed", "pr_created")) {
            val resolved = unlanded.copy(landStatus = resolvedStatus)
            val transition = TaskStatusActions.getQuickTransition(resolved)
            assertNotNull(transition)
            assertFalse("Expected unblocked for landStatus=$resolvedStatus", transition!!.isBlocked)
            assertTrue(TaskStatusActions.canMarkDone(resolved))
        }

        val landed = unlanded.copy(landStatus = "landed")
        assertFalse(TaskStatusActions.canQuickLand(landed))
        assertFalse(TaskStatusActions.canSyncLandStatus(landed))
        assertFalse(TaskStatusActions.canForceMarkDone(landed))

        // Unlanded / error tasks expose re-check Land & force Done recovery actions
        assertTrue(TaskStatusActions.canSyncLandStatus(unlanded))
        assertTrue(TaskStatusActions.canForceMarkDone(unlanded))

        val stuckErrorWithoutPath = makeTask(
            status = "needs_review",
            worktreePath = null,
            worktreeBranch = null,
            landStatus = "error",
        )
        assertTrue(TaskStatusActions.canQuickLand(stuckErrorWithoutPath))
        assertTrue(TaskStatusActions.canSyncLandStatus(stuckErrorWithoutPath))
        assertTrue(TaskStatusActions.canForceMarkDone(stuckErrorWithoutPath))

        // Running tasks never allow force Done or sync Land
        val runningUnlanded = unlanded.copy(status = "running")
        assertFalse(TaskStatusActions.canSyncLandStatus(runningUnlanded))
        assertFalse(TaskStatusActions.canForceMarkDone(runningUnlanded))
    }

    @Test
    fun returnsReopenTransitionForDoneTasks() {
        val done = makeTask(status = "done")
        val transition = TaskStatusActions.getQuickTransition(done)
        assertNotNull(transition)
        assertEquals(QuickTaskAction.REOPEN, transition!!.action)
        assertEquals(TaskStatusActions.REOPEN_TARGET_STATUS, transition.nextStatus)
        assertFalse(transition.isBlocked)
    }

    @Test
    fun appliesImmediateTaskUpdateToSnapshotAndPreservesOtherTasks() {
        val t1 = makeTask(id = "t1", taskNumber = 1, status = "needs_review")
        val t2 = makeTask(id = "t2", taskNumber = 2, status = "queued")
        val snap = AppSnapshot(tasks = listOf(t1, t2))

        val serverUpdated = t1.copy(status = "done", updatedAt = "2026-11-27T12:00:00Z")
        val withServerTask = TaskStatusActions.applyTaskUpdate(snap, "t1", updatedTask = serverUpdated)
        assertEquals("done", withServerTask!!.tasks[0].status)
        assertEquals("2026-11-27T12:00:00Z", withServerTask.tasks[0].updatedAt)
        assertEquals("queued", withServerTask.tasks[1].status)

        val withFallbackStatus = TaskStatusActions.applyTaskUpdate(snap, "t2", fallbackStatus = "done")
        assertEquals("needs_review", withFallbackStatus!!.tasks[0].status)
        assertEquals("done", withFallbackStatus.tasks[1].status)

        assertNull(TaskStatusActions.applyTaskUpdate(null, "t1", fallbackStatus = "done"))
    }

    @Test
    fun formatsStatusFeedbackMessagesWithTaskCode() {
        val task = makeTask(taskNumber = 14)
        assertEquals("T14 を完了にしました", TaskStatusActions.formatStatusFeedback(task, "done"))
        assertEquals("T14 を再オープンしました", TaskStatusActions.formatStatusFeedback(task, "needs_review"))
        assertEquals("T14 のステータスを元に戻しました", TaskStatusActions.formatStatusFeedback(task, "queued", isUndo = true))
        assertEquals("タスクを完了にしました", TaskStatusActions.formatStatusFeedback(null, "done"))
    }

    @Test
    fun determinesWhenToAutoCloseTaskDetailAfterStatusUpdate() {
        // Done succeeds while the same task's detail is open -> auto-close
        assertTrue(
            TaskStatusActions.shouldCloseTaskDetailAfterStatusUpdate(
                selectedTaskId = "t1",
                updatedTaskId = "t1",
                nextStatus = "done",
                succeeded = true,
            ),
        )

        // API failure -> keep detail open
        assertFalse(
            TaskStatusActions.shouldCloseTaskDetailAfterStatusUpdate(
                selectedTaskId = "t1",
                updatedTaskId = "t1",
                nextStatus = "done",
                succeeded = false,
            ),
        )

        // Reopen (done -> needs_review) -> keep detail open
        assertFalse(
            TaskStatusActions.shouldCloseTaskDetailAfterStatusUpdate(
                selectedTaskId = "t1",
                updatedTaskId = "t1",
                nextStatus = "needs_review",
                succeeded = true,
            ),
        )

        // Different task is open in detail -> do not close
        assertFalse(
            TaskStatusActions.shouldCloseTaskDetailAfterStatusUpdate(
                selectedTaskId = "t2",
                updatedTaskId = "t1",
                nextStatus = "done",
                succeeded = true,
            ),
        )

        // Detail is not open -> nothing to close
        assertFalse(
            TaskStatusActions.shouldCloseTaskDetailAfterStatusUpdate(
                selectedTaskId = null,
                updatedTaskId = "t1",
                nextStatus = "done",
                succeeded = true,
            ),
        )

        // Undo action -> do not unexpectedly close detail
        assertFalse(
            TaskStatusActions.shouldCloseTaskDetailAfterStatusUpdate(
                selectedTaskId = "t1",
                updatedTaskId = "t1",
                nextStatus = "done",
                succeeded = true,
                isUndo = true,
            ),
        )
    }

    @Test
    fun applyStatusUpdateSuccessClosesDetailOnDoneAndKeepsOpenOnReopenOrOtherTask() {
        val t1 = makeTask(id = "t1", taskNumber = 1, status = "needs_review")
        val t2 = makeTask(id = "t2", taskNumber = 2, status = "done")
        val snap = AppSnapshot(tasks = listOf(t1, t2))
        val t1Detail = TaskDetailResponse(ok = true, task = t1)
        val t2Detail = TaskDetailResponse(ok = true, task = t2)

        // Marking the currently open detail task Done -> closes detail and updates snapshot
        val doneServerTask = t1.copy(status = "done")
        val doneOutcome = TaskStatusActions.applyStatusUpdateSuccess(
            snapshot = snap,
            selectedTaskId = "t1",
            selectedTaskDetail = t1Detail,
            isLoadingTaskDetail = true,
            taskId = "t1",
            nextStatus = "done",
            updatedTask = doneServerTask,
        )
        assertTrue(doneOutcome.shouldCloseDetail)
        assertFalse(doneOutcome.shouldRefreshDetail)
        assertNull(doneOutcome.selectedTaskId)
        assertNull(doneOutcome.selectedTaskDetail)
        assertFalse(doneOutcome.isLoadingTaskDetail)
        assertEquals("done", doneOutcome.snapshot!!.tasks[0].status)

        // Reopening the currently open detail task -> keeps detail open, patches detail, triggers refresh
        val reopenedServerTask = t2.copy(status = "needs_review")
        val reopenOutcome = TaskStatusActions.applyStatusUpdateSuccess(
            snapshot = snap,
            selectedTaskId = "t2",
            selectedTaskDetail = t2Detail,
            isLoadingTaskDetail = false,
            taskId = "t2",
            nextStatus = "needs_review",
            updatedTask = reopenedServerTask,
        )
        assertFalse(reopenOutcome.shouldCloseDetail)
        assertTrue(reopenOutcome.shouldRefreshDetail)
        assertEquals("t2", reopenOutcome.selectedTaskId)
        assertEquals("needs_review", reopenOutcome.selectedTaskDetail!!.task!!.status)
        assertEquals("needs_review", reopenOutcome.snapshot!!.tasks[1].status)

        // Marking a different task Done while another task's detail is open -> keeps detail open
        val otherTaskOutcome = TaskStatusActions.applyStatusUpdateSuccess(
            snapshot = snap,
            selectedTaskId = "t2",
            selectedTaskDetail = t2Detail,
            isLoadingTaskDetail = false,
            taskId = "t1",
            nextStatus = "done",
            updatedTask = doneServerTask,
        )
        assertFalse(otherTaskOutcome.shouldCloseDetail)
        assertFalse(otherTaskOutcome.shouldRefreshDetail)
        assertEquals("t2", otherTaskOutcome.selectedTaskId)
        assertEquals(t2Detail, otherTaskOutcome.selectedTaskDetail)
        assertEquals("done", otherTaskOutcome.snapshot!!.tasks[0].status)
    }
}
