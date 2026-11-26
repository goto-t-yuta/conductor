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

export const QUESTIONS_SECTION_HEIGHT_STORAGE_KEY = "conductor:questionsSectionHeight";
export const QUESTIONS_SECTION_MIN_HEIGHT = 100;
export const QUESTIONS_SECTION_MAX_HEIGHT_RATIO = 0.65;

export interface QuestionsHeightStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

function getBrowserStorage(): QuestionsHeightStorageLike | null {
  try {
    const g = globalThis as unknown as { localStorage?: QuestionsHeightStorageLike };
    return g.localStorage ?? null;
  } catch {
    return null;
  }
}

export function getQuestionsSectionMaxHeight(sidebarHeight: number): number {
  if (!Number.isFinite(sidebarHeight) || sidebarHeight <= 0) {
    return QUESTIONS_SECTION_MIN_HEIGHT;
  }
  return Math.max(
    QUESTIONS_SECTION_MIN_HEIGHT,
    Math.floor(sidebarHeight * QUESTIONS_SECTION_MAX_HEIGHT_RATIO),
  );
}

export function clampQuestionsSectionHeight(
  height: number,
  sidebarHeight?: number | null,
): number {
  if (!Number.isFinite(height)) {
    return QUESTIONS_SECTION_MIN_HEIGHT;
  }
  const rounded = Math.round(height);
  if (typeof sidebarHeight === "number" && Number.isFinite(sidebarHeight) && sidebarHeight > 0) {
    const maxHeight = getQuestionsSectionMaxHeight(sidebarHeight);
    return Math.min(maxHeight, Math.max(QUESTIONS_SECTION_MIN_HEIGHT, rounded));
  }
  return Math.max(QUESTIONS_SECTION_MIN_HEIGHT, rounded);
}

export function parseQuestionsSectionHeight(
  raw: string | null | undefined,
  sidebarHeight?: number | null,
): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return clampQuestionsSectionHeight(parsed, sidebarHeight);
}

export function loadQuestionsSectionHeight(
  storage?: QuestionsHeightStorageLike | null,
  sidebarHeight?: number | null,
): number | null {
  try {
    const target = storage === undefined ? getBrowserStorage() : storage;
    if (!target) return null;
    return parseQuestionsSectionHeight(
      target.getItem(QUESTIONS_SECTION_HEIGHT_STORAGE_KEY),
      sidebarHeight,
    );
  } catch {
    return null;
  }
}

export function saveQuestionsSectionHeight(
  height: number | null,
  storage?: QuestionsHeightStorageLike | null,
  sidebarHeight?: number | null,
): void {
  try {
    const target = storage === undefined ? getBrowserStorage() : storage;
    if (!target) return;
    if (height === null) {
      if (typeof target.removeItem === "function") {
        target.removeItem(QUESTIONS_SECTION_HEIGHT_STORAGE_KEY);
      } else {
        target.setItem(QUESTIONS_SECTION_HEIGHT_STORAGE_KEY, "");
      }
      return;
    }
    if (!Number.isFinite(height)) return;
    const clamped = clampQuestionsSectionHeight(height, sidebarHeight);
    target.setItem(QUESTIONS_SECTION_HEIGHT_STORAGE_KEY, String(clamped));
  } catch {
    // Ignore storage errors (e.g. private browsing / quota limits)
  }
}
