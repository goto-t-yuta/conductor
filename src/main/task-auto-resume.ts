import crypto from "node:crypto";
import type { AgentTask } from "../shared/types.js";

export const SHUTDOWN_INTERRUPTED_STEP = "終了により中断（次回起動時に自動再開）";
export const STARTUP_AUTO_RESUME_PENDING_STEP = "再起動後の自動再開を待機中...";

export function markTasksForAutoResumeOnShutdown(
  tasks: readonly AgentTask[],
  pendingResumeTaskIds: readonly string[] = [],
  nowIso: string = new Date().toISOString(),
): { tasks: AgentTask[]; markedTaskIds: string[] } {
  const pendingSet = new Set(pendingResumeTaskIds);
  const markedTaskIds: string[] = [];

  const nextTasks = tasks.map((task) => {
    const wasRunning = task.status === "running";
    const wasPendingResume = pendingSet.has(task.id) && task.status !== "done" && task.status !== "failed";
    if (!wasRunning && !wasPendingResume) {
      return task;
    }

    markedTaskIds.push(task.id);
    const activities = wasRunning
      ? [
          ...task.activities,
          {
            id: crypto.randomUUID(),
            kind: "system" as const,
            title: SHUTDOWN_INTERRUPTED_STEP,
            detail: null,
            timestamp: nowIso,
          },
        ]
      : [...task.activities];

    return {
      ...task,
      status: "queued" as const,
      autoResumeOnStartup: true,
      activeTurnId: null,
      currentStep: SHUTDOWN_INTERRUPTED_STEP,
      activities,
      updatedAt: nowIso,
    };
  });

  return { tasks: nextTasks, markedTaskIds };
}

/**
 * Inspects persisted tasks on startup, identifies any tasks that should auto-resume
 * (either explicitly flagged via `autoResumeOnStartup: true` during clean shutdown, or
 * still left in `running` state from an unexpected crash/unclean exit), and immediately
 * clears `autoResumeOnStartup` so a crash during startup can never cause an infinite loop.
 */
export function prepareTasksForStartupAutoResume(
  tasks: readonly AgentTask[],
): { tasks: AgentTask[]; resumeTaskIds: string[]; changed: boolean } {
  const resumeTaskIds: string[] = [];
  let changed = false;

  const nextTasks = tasks.map((task) => {
    let next = task;

    if (next.landStatus === "landing") {
      next = { ...next, landStatus: "unlanded" };
      changed = true;
    }

    const shouldResume = next.autoResumeOnStartup === true || next.status === "running";
    if (shouldResume) {
      resumeTaskIds.push(next.id);
      next = {
        ...next,
        status: "queued",
        autoResumeOnStartup: false,
        activeTurnId: null,
        currentStep: STARTUP_AUTO_RESUME_PENDING_STEP,
      };
      changed = true;
    } else if (next.autoResumeOnStartup === false) {
      // keep as-is
    }

    return next;
  });

  return { tasks: nextTasks, resumeTaskIds, changed };
}

export function extractTaskPromptForRerun(
  task: Pick<AgentTask, "title" | "summary" | "workerPrompt" | "lastWorkerPrompt" | "activities">,
): string {
  const primary = task.workerPrompt?.trim();
  if (primary) return primary;

  const last = task.lastWorkerPrompt?.trim();
  if (last) return last;

  for (const act of task.activities) {
    if (act.kind === "system" && act.detail?.trim()) {
      return act.detail.trim();
    }
  }

  const summary = task.summary?.trim();
  if (summary) return `${task.title}\n\n${summary}`;

  return task.title;
}

export function buildSessionResumePrompt(
  task: Pick<AgentTask, "title" | "taskNumber" | "projectName" | "worktreeBranch">,
): string {
  const lines = [
    "Conductor was restarted while this task was running, so your previous turn was interrupted.",
    "Please check the current workspace and git state (`git status`, `git diff`, and existing modified files) to see what work is already in place, avoid overwriting or repeating completed changes, and continue from where you left off until the task is finished and verified.",
  ];
  if (task.worktreeBranch) {
    lines.push(`Continue working in the isolated git worktree branch "${task.worktreeBranch}".`);
  }
  return lines.join("\n");
}

export function buildFallbackRerunPrompt(
  task: Pick<
    AgentTask,
    "title" | "summary" | "workerPrompt" | "lastWorkerPrompt" | "activities" | "worktreeBranch"
  >,
): string {
  const originalPrompt = extractTaskPromptForRerun(task);
  const headerLines = [
    "[Auto-Resumed After Conductor Restart]",
    "Conductor restarted while this task was running and the previous worker session could not be resumed.",
    "IMPORTANT: Before editing files, inspect the current workspace and git state (`git status` / `git diff`) to see what progress is already present so you do not overwrite already-completed work. Continue from the current state until the task is complete and verified.",
  ];
  if (task.worktreeBranch) {
    headerLines.push(`Working in isolated git worktree branch "${task.worktreeBranch}".`);
  }

  const sections: string[] = [
    headerLines.join("\n"),
    `[Original Task Instructions]\n${originalPrompt}`,
  ];

  const followUp = task.lastWorkerPrompt?.trim();
  if (followUp && followUp !== originalPrompt.trim()) {
    sections.push(`[Latest Follow-up Instructions]\n${followUp}`);
  }

  return sections.join("\n\n");
}
