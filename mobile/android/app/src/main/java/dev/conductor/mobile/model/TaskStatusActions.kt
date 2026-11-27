package dev.conductor.mobile.model

enum class QuickTaskAction {
    DONE,
    REOPEN,
}

data class QuickTaskTransition(
    val action: QuickTaskAction,
    val label: String,
    val nextStatus: String,
    val isBlocked: Boolean = false,
    val blockedReason: String? = null,
)

/**
 * Desktop-aligned quick status transition rules and guards for AgentTask items.
 * Mirrors `src/shared/task-status.ts` and `src/renderer/lib/task-sidebar.ts`.
 */
object TaskStatusActions {
    const val STATUS_DONE = "done"
    const val STATUS_RUNNING = "running"
    const val REOPEN_TARGET_STATUS = "needs_review"

    const val RUNNING_DONE_BLOCKED_REASON =
        "実行中のタスクは直接完了にできません。先にワーカーを停止してください。"

    const val UNLANDED_DONE_BLOCKED_REASON =
        "未Landの変更が残っているため完了にできません。先に Land を実行（または Worktree を破棄）してください。"

    fun getMarkDoneBlockedReason(task: AgentTask): String? = when {
        task.status == STATUS_RUNNING -> RUNNING_DONE_BLOCKED_REASON
        task.isUnlandedWorktree -> UNLANDED_DONE_BLOCKED_REASON
        else -> null
    }

    fun canMarkDone(task: AgentTask): Boolean = getMarkDoneBlockedReason(task) == null

    fun getQuickTransition(task: AgentTask): QuickTaskTransition? {
        if (task.status == STATUS_RUNNING) {
            return null
        }
        if (task.status == STATUS_DONE) {
            return QuickTaskTransition(
                action = QuickTaskAction.REOPEN,
                label = "再オープン",
                nextStatus = REOPEN_TARGET_STATUS,
            )
        }
        val blockedReason = getMarkDoneBlockedReason(task)
        return QuickTaskTransition(
            action = QuickTaskAction.DONE,
            label = "完了",
            nextStatus = STATUS_DONE,
            isBlocked = blockedReason != null,
            blockedReason = blockedReason,
        )
    }

    fun canQuickLand(task: AgentTask): Boolean =
        task.hasWorktree && task.status != STATUS_RUNNING && task.landStatus != "landed"

    fun applyTaskUpdate(
        snapshot: AppSnapshot?,
        taskId: String,
        updatedTask: AgentTask? = null,
        fallbackStatus: String? = null,
    ): AppSnapshot? {
        if (snapshot == null) return null
        var changed = false
        val nextTasks = snapshot.tasks.map { existing ->
            if (existing.id != taskId) {
                existing
            } else {
                changed = true
                when {
                    updatedTask != null -> updatedTask
                    fallbackStatus != null -> existing.copy(status = fallbackStatus)
                    else -> existing
                }
            }
        }
        return if (changed) snapshot.copy(tasks = nextTasks) else snapshot
    }

    fun formatStatusFeedback(
        task: AgentTask?,
        nextStatus: String,
        isUndo: Boolean = false,
    ): String {
        val subject = if (task != null && task.taskNumber > 0) "T${task.taskNumber} " else "タスク"
        return when {
            isUndo -> "${subject}のステータスを元に戻しました"
            nextStatus == STATUS_DONE -> "${subject}を完了にしました"
            else -> "${subject}を再オープンしました"
        }
    }
}
