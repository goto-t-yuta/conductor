import type { AgentTask, AgentTaskStatus, TaskLandStatus } from "./types.js";
import { t, type UiLocale } from "./i18n.js";

export const RUNNING_TASK_DONE_BLOCKED_REASON =
  "実行中のタスクは直接完了にできません。先にワーカーを停止してください。";

export const UNLANDED_TASK_DONE_BLOCKED_REASON =
  "未Landの変更が残っているため完了にできません。先に Land を実行（または Worktree を破棄）してください。";

export function getLocalizedMarkTaskDoneBlockedReason(
  task: MarkTaskDoneGuardInput,
  locale: UiLocale = "ja",
): string | null {
  if (task.status === "running" || task.hasActiveWorker) {
    return t(locale, "task.blockedRunning");
  }
  if (requiresLandBeforeDone(task)) {
    return t(locale, "task.blockedUnlanded");
  }
  return null;
}

export type TaskLandGuardFields = Pick<
  AgentTask,
  "worktreePath" | "worktreeBranch" | "landStatus"
>;

export interface MarkTaskDoneGuardInput extends TaskLandGuardFields {
  status: AgentTaskStatus;
  hasActiveWorker?: boolean;
}

export interface TaskStatusTransitionValidation {
  ok: boolean;
  error?: string;
}

const COMPLETED_LAND_STATUSES: ReadonlySet<TaskLandStatus> = new Set([
  "landed",
  "pushed",
  "pr_created",
]);

const UNLANDED_LAND_STATUSES: ReadonlySet<TaskLandStatus> = new Set([
  "unlanded",
  "landing",
  "conflict",
  "error",
]);

/**
 * Returns true if the task still has an active/unlanded worktree that must be
 * landed (or explicitly discarded via worktree cleanup) before marking `done`.
 */
export function requiresLandBeforeDone(
  task?: TaskLandGuardFields | null,
): boolean {
  if (!task) return false;
  if (task.landStatus && COMPLETED_LAND_STATUSES.has(task.landStatus)) {
    return false;
  }
  const hasWorktreeRef =
    Boolean(task.worktreePath?.trim()) || Boolean(task.worktreeBranch?.trim());
  const hasUnlandedStatus = Boolean(
    task.landStatus && UNLANDED_LAND_STATUSES.has(task.landStatus),
  );
  return hasWorktreeRef || hasUnlandedStatus;
}

/**
 * Returns the user-facing reason why the task cannot currently be marked `done`,
 * or `null` if transitioning to `done` is allowed.
 *
 * Enforces:
 * 1. Running / active-worker guard (must stop worker first)
 * 2. Unlanded worktree guard (must Land or discard worktree first)
 */
export function getMarkTaskDoneBlockedReason(
  status: AgentTaskStatus,
  hasActiveWorker?: boolean,
  worktree?: TaskLandGuardFields | null,
): string | null;
export function getMarkTaskDoneBlockedReason(
  task: MarkTaskDoneGuardInput,
): string | null;
export function getMarkTaskDoneBlockedReason(
  taskOrStatus: AgentTaskStatus | MarkTaskDoneGuardInput,
  hasActiveWorkerArg = false,
  worktreeArg?: TaskLandGuardFields | null,
): string | null {
  const status =
    typeof taskOrStatus === "string" ? taskOrStatus : taskOrStatus.status;
  const hasActiveWorker =
    typeof taskOrStatus === "string"
      ? hasActiveWorkerArg
      : Boolean(taskOrStatus.hasActiveWorker);
  const worktree: TaskLandGuardFields | null | undefined =
    typeof taskOrStatus === "string" ? worktreeArg : taskOrStatus;

  if (status === "running" || hasActiveWorker) {
    return RUNNING_TASK_DONE_BLOCKED_REASON;
  }
  if (requiresLandBeforeDone(worktree)) {
    return UNLANDED_TASK_DONE_BLOCKED_REASON;
  }
  return null;
}

/**
 * Returns true if a task in the given state can be marked `done` directly by a user/agent.
 * Running tasks (or tasks with an active live worker turn/process) must be stopped first,
 * and tasks with an unlanded worktree must be landed or have their worktree discarded first.
 */
export function canMarkTaskDone(
  status: AgentTaskStatus,
  hasActiveWorker?: boolean,
  worktree?: TaskLandGuardFields | null,
): boolean;
export function canMarkTaskDone(task: MarkTaskDoneGuardInput): boolean;
export function canMarkTaskDone(
  taskOrStatus: AgentTaskStatus | MarkTaskDoneGuardInput,
  hasActiveWorker = false,
  worktree?: TaskLandGuardFields | null,
): boolean {
  if (typeof taskOrStatus === "string") {
    return getMarkTaskDoneBlockedReason(taskOrStatus, hasActiveWorker, worktree) === null;
  }
  return getMarkTaskDoneBlockedReason(taskOrStatus) === null;
}

/**
 * Validates manual / IPC / MCP task status transitions.
 * Blocks silently flipping a running task (or one with an active worker) or an unlanded
 * worktree task directly to `done`, while preserving normal transitions such as:
 * - running -> needs_review / failed
 * - done -> needs_review / running (reopen / resume)
 * - queued / needs_review / failed -> done (when no active worker is running and no unlanded worktree remains)
 */
export function validateManualTaskStatusTransition(params: {
  currentStatus: AgentTaskStatus;
  nextStatus: AgentTaskStatus;
  hasActiveWorker?: boolean;
  worktreePath?: string | null;
  worktreeBranch?: string | null;
  landStatus?: TaskLandStatus;
}): TaskStatusTransitionValidation {
  const {
    currentStatus,
    nextStatus,
    hasActiveWorker = false,
    worktreePath,
    worktreeBranch,
    landStatus,
  } = params;
  if (nextStatus === "done") {
    const blockedReason = getMarkTaskDoneBlockedReason({
      status: currentStatus,
      hasActiveWorker,
      worktreePath,
      worktreeBranch,
      landStatus,
    });
    if (blockedReason) {
      return {
        ok: false,
        error: blockedReason,
      };
    }
  }
  return { ok: true };
}
