import type { AgentTask, AgentTaskStatus } from "../../shared/types.js";

export const REOPEN_TARGET_STATUS: AgentTaskStatus = "needs_review";

export interface QuickStatusTransition {
  action: "done" | "reopen";
  label: "Done" | "Reopen";
  nextStatus: AgentTaskStatus;
  title: string;
}

export function getQuickStatusTransition(status: AgentTaskStatus): QuickStatusTransition | null {
  if (status === "running") {
    return null;
  }
  if (status === "done") {
    return {
      action: "reopen",
      label: "Reopen",
      nextStatus: REOPEN_TARGET_STATUS,
      title: "再オープンする",
    };
  }
  return {
    action: "done",
    label: "Done",
    nextStatus: "done",
    title: "完了にする",
  };
}

export interface PartitionedSidebarTasks {
  filteredTasks: AgentTask[];
  activeTasks: AgentTask[];
  completedTasks: AgentTask[];
}

/**
 * Filters tasks by selected project (when set) and splits them into:
 * - activeTasks: all non-done tasks (running, queued, needs_review, failed)
 * - completedTasks: only completed ("done") tasks
 */
export function partitionSidebarTasks(
  tasks: readonly AgentTask[],
  selectedProjectId: string | null,
): PartitionedSidebarTasks {
  const filteredTasks = selectedProjectId
    ? tasks.filter((t) => t.projectId === selectedProjectId)
    : [...tasks];

  const activeTasks: AgentTask[] = [];
  const completedTasks: AgentTask[] = [];

  for (const task of filteredTasks) {
    if (task.status === "done") {
      completedTasks.push(task);
    } else {
      activeTasks.push(task);
    }
  }

  return { filteredTasks, activeTasks, completedTasks };
}

/**
 * Matches a completed task against a user search query using title, projectName, and summary.
 * Whitespace-separated tokens are matched with AND semantics (case-insensitive).
 */
export function matchesCompletedTaskQuery(task: AgentTask, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;

  const haystack = [task.title, task.projectName, task.summary]
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .toLowerCase();

  return tokens.every((token) => haystack.includes(token));
}

export function filterCompletedTasks(
  completedTasks: readonly AgentTask[],
  query: string,
): AgentTask[] {
  if (!query.trim()) return [...completedTasks];
  return completedTasks.filter((task) => matchesCompletedTaskQuery(task, query));
}

export function formatCompletedCountBadge(
  filteredCount: number,
  totalCount: number,
  hasQuery: boolean,
): string {
  return hasQuery ? `${filteredCount}/${totalCount}` : `${totalCount}`;
}

export function getTaskCardSubtitle(task: AgentTask): string | null {
  if (task.status === "done") {
    return task.summary || task.currentStep || null;
  }
  return task.currentStep || task.summary || null;
}
