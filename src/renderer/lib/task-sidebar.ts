import type { AgentTask, AgentTaskStatus, Project } from "../../shared/types.js";
import { t, type UiLocale } from "../../shared/i18n.js";

export const REOPEN_TARGET_STATUS: AgentTaskStatus = "needs_review";

export interface QuickStatusTransition {
  action: "done" | "reopen";
  label: "Done" | "Reopen";
  nextStatus: AgentTaskStatus;
  title: string;
}

export function getQuickStatusTransition(
  status: AgentTaskStatus,
  locale: UiLocale = "ja",
): QuickStatusTransition | null {
  if (status === "running") {
    return null;
  }
  if (status === "done") {
    return {
      action: "reopen",
      label: "Reopen",
      nextStatus: REOPEN_TARGET_STATUS,
      title: t(locale, "task.reopenTitle"),
    };
  }
  return {
    action: "done",
    label: "Done",
    nextStatus: "done",
    title: t(locale, "task.markDoneTitle"),
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

export const TASK_GROUP_BY_PROJECT_STORAGE_KEY = "conductor:taskSidebarGroupByProject";
export const DEFAULT_TASK_GROUP_BY_PROJECT = true;
export const COLLAPSED_PROJECT_GROUPS_STORAGE_KEY = "conductor:taskSidebarCollapsedProjectGroups";
export const UNASSIGNED_PROJECT_GROUP_KEY = "__unassigned__";

export type TaskSidebarSection = "active" | "completed";

export interface TaskProjectGroup {
  groupKey: string;
  projectName: string;
  projectId: string | null;
  colorHex: string;
  tasks: AgentTask[];
  runningCount: number;
  needsReviewCount: number;
  queuedCount: number;
  failedCount: number;
  doneCount: number;
  latestUpdatedAtMs: number;
}

export interface QuestionsHeightStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export type SidebarStorageLike = QuestionsHeightStorageLike;

function getBrowserStorage(): QuestionsHeightStorageLike | null {
  try {
    const g = globalThis as unknown as { localStorage?: QuestionsHeightStorageLike };
    return g.localStorage ?? null;
  } catch {
    return null;
  }
}

function findMatchingProjectForTask(
  projects: readonly Project[],
  task: AgentTask,
): Project | undefined {
  if (task.projectId) {
    const byId = projects.find((p) => p.id === task.projectId);
    if (byId) return byId;
  }
  const normalizedName = task.projectName.trim().toLowerCase();
  if (!normalizedName) return undefined;
  return projects.find((p) => p.name.trim().toLowerCase() === normalizedName);
}

export function normalizeProjectGroupKey(projectName: string | null | undefined): string {
  const trimmed = (projectName ?? "").trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : UNASSIGNED_PROJECT_GROUP_KEY;
}

export function makeProjectGroupCollapseKey(
  section: TaskSidebarSection,
  groupKey: string,
): string {
  return `${section}:${groupKey}`;
}

function parseTaskTimestampMs(task: AgentTask): number {
  const updatedMs = Date.parse(task.updatedAt);
  if (Number.isFinite(updatedMs)) return updatedMs;
  const createdMs = Date.parse(task.createdAt);
  return Number.isFinite(createdMs) ? createdMs : 0;
}

function getProjectGroupPriorityTier(group: TaskProjectGroup): number {
  if (group.runningCount > 0) return 3;
  if (group.needsReviewCount > 0) return 2;
  if (group.queuedCount > 0 || group.failedCount > 0) return 1;
  return 0;
}

export function compareTaskProjectGroups(a: TaskProjectGroup, b: TaskProjectGroup): number {
  const tierDiff = getProjectGroupPriorityTier(b) - getProjectGroupPriorityTier(a);
  if (tierDiff !== 0) return tierDiff;

  const updatedDiff = b.latestUpdatedAtMs - a.latestUpdatedAtMs;
  if (updatedDiff !== 0) return updatedDiff;

  const runningDiff = b.runningCount - a.runningCount;
  if (runningDiff !== 0) return runningDiff;

  const reviewDiff = b.needsReviewCount - a.needsReviewCount;
  if (reviewDiff !== 0) return reviewDiff;

  if (a.groupKey === UNASSIGNED_PROJECT_GROUP_KEY && b.groupKey !== UNASSIGNED_PROJECT_GROUP_KEY) {
    return 1;
  }
  if (b.groupKey === UNASSIGNED_PROJECT_GROUP_KEY && a.groupKey !== UNASSIGNED_PROJECT_GROUP_KEY) {
    return -1;
  }

  return a.projectName.localeCompare(b.projectName, undefined, { sensitivity: "base" });
}

/**
 * Groups tasks by projectName (case-insensitive) and sorts groups so projects with
 * running or needs_review tasks and most-recently-updated tasks appear first.
 */
export function groupTasksByProject(
  tasks: readonly AgentTask[],
  projects: readonly Project[] = [],
  locale: UiLocale = "ja",
): TaskProjectGroup[] {
  const groups = new Map<string, TaskProjectGroup>();

  for (const task of tasks) {
    const matchedProject = findMatchingProjectForTask(projects, task);
    const rawName = task.projectName.trim() || matchedProject?.name.trim() || "";
    const groupKey = normalizeProjectGroupKey(rawName);
    const displayName = rawName || t(locale, "sidebar.unassignedProject");
    const colorHex = matchedProject?.colorHex ?? "#6366F1";
    const taskUpdatedMs = parseTaskTimestampMs(task);

    let group = groups.get(groupKey);
    if (!group) {
      group = {
        groupKey,
        projectName: displayName,
        projectId: matchedProject?.id ?? task.projectId ?? null,
        colorHex,
        tasks: [],
        runningCount: 0,
        needsReviewCount: 0,
        queuedCount: 0,
        failedCount: 0,
        doneCount: 0,
        latestUpdatedAtMs: taskUpdatedMs,
      };
      groups.set(groupKey, group);
    } else {
      if (!group.projectId && (matchedProject?.id ?? task.projectId)) {
        group.projectId = matchedProject?.id ?? task.projectId ?? null;
      }
      if (group.colorHex === "#6366F1" && matchedProject?.colorHex) {
        group.colorHex = matchedProject.colorHex;
      }
      if (taskUpdatedMs > group.latestUpdatedAtMs) {
        group.latestUpdatedAtMs = taskUpdatedMs;
      }
    }

    group.tasks.push(task);
    switch (task.status) {
      case "running":
        group.runningCount += 1;
        break;
      case "needs_review":
        group.needsReviewCount += 1;
        break;
      case "queued":
        group.queuedCount += 1;
        break;
      case "failed":
        group.failedCount += 1;
        break;
      case "done":
        group.doneCount += 1;
        break;
    }
  }

  return Array.from(groups.values()).sort(compareTaskProjectGroups);
}

/**
 * Counts tasks per normalized project group key (useful for showing filtered/total counts while searching).
 */
export function countTasksByProjectGroup(
  tasks: readonly AgentTask[],
  projects: readonly Project[] = [],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    const matchedProject = findMatchingProjectForTask(projects, task);
    const rawName = task.projectName.trim() || matchedProject?.name.trim() || "";
    const key = normalizeProjectGroupKey(rawName);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function parseTaskGroupByProject(raw: string | null | undefined): boolean {
  if (raw == null) return DEFAULT_TASK_GROUP_BY_PROJECT;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "false" || normalized === "0") return false;
  if (normalized === "true" || normalized === "1") return true;
  return DEFAULT_TASK_GROUP_BY_PROJECT;
}

export function loadTaskGroupByProject(storage?: SidebarStorageLike | null): boolean {
  try {
    const target = storage === undefined ? getBrowserStorage() : storage;
    if (!target) return DEFAULT_TASK_GROUP_BY_PROJECT;
    return parseTaskGroupByProject(target.getItem(TASK_GROUP_BY_PROJECT_STORAGE_KEY));
  } catch {
    return DEFAULT_TASK_GROUP_BY_PROJECT;
  }
}

export function saveTaskGroupByProject(
  enabled: boolean,
  storage?: SidebarStorageLike | null,
): void {
  try {
    const target = storage === undefined ? getBrowserStorage() : storage;
    if (!target) return;
    target.setItem(TASK_GROUP_BY_PROJECT_STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // Ignore storage errors (e.g. private browsing / quota limits)
  }
}

export function parseCollapsedProjectGroups(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    const result = new Set<string>();
    for (const item of parsed) {
      if (typeof item === "string") {
        const trimmed = item.trim();
        if (trimmed) result.add(trimmed);
      }
    }
    return result;
  } catch {
    return new Set();
  }
}

export function loadCollapsedProjectGroups(storage?: SidebarStorageLike | null): Set<string> {
  try {
    const target = storage === undefined ? getBrowserStorage() : storage;
    if (!target) return new Set();
    return parseCollapsedProjectGroups(target.getItem(COLLAPSED_PROJECT_GROUPS_STORAGE_KEY));
  } catch {
    return new Set();
  }
}

export function saveCollapsedProjectGroups(
  collapsedKeys: ReadonlySet<string> | readonly string[],
  storage?: SidebarStorageLike | null,
): void {
  try {
    const target = storage === undefined ? getBrowserStorage() : storage;
    if (!target) return;
    const normalized = Array.from(
      new Set(
        Array.from(collapsedKeys)
          .map((key) => key.trim())
          .filter(Boolean),
      ),
    ).sort();
    if (normalized.length === 0) {
      if (typeof target.removeItem === "function") {
        target.removeItem(COLLAPSED_PROJECT_GROUPS_STORAGE_KEY);
      } else {
        target.setItem(COLLAPSED_PROJECT_GROUPS_STORAGE_KEY, "[]");
      }
      return;
    }
    target.setItem(COLLAPSED_PROJECT_GROUPS_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Ignore storage errors (e.g. private browsing / quota limits)
  }
}

export function toggleCollapsedProjectGroup(
  collapsedKeys: ReadonlySet<string>,
  collapseKey: string,
): Set<string> {
  const next = new Set(collapsedKeys);
  if (next.has(collapseKey)) {
    next.delete(collapseKey);
  } else {
    next.add(collapseKey);
  }
  return next;
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
