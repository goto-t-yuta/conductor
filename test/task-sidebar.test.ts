import { describe, expect, it } from "vitest";
import type { AgentTask, AgentTaskStatus } from "../src/shared/types.js";
import {
  RUNNING_TASK_DONE_BLOCKED_REASON,
  canMarkTaskDone,
  validateManualTaskStatusTransition,
} from "../src/shared/task-status.js";
import {
  QUESTIONS_SECTION_HEIGHT_STORAGE_KEY,
  QUESTIONS_SECTION_MIN_HEIGHT,
  REOPEN_TARGET_STATUS,
  clampQuestionsSectionHeight,
  filterCompletedTasks,
  formatCompletedCountBadge,
  getQuestionsSectionMaxHeight,
  getQuickStatusTransition,
  getTaskCardSubtitle,
  loadQuestionsSectionHeight,
  matchesCompletedTaskQuery,
  parseQuestionsSectionHeight,
  partitionSidebarTasks,
  saveQuestionsSectionHeight,
  type QuestionsHeightStorageLike,
} from "../src/renderer/lib/task-sidebar.js";

function makeTask(
  overrides: Partial<AgentTask> & { id: string; taskNumber: number; title: string; status: AgentTaskStatus },
): AgentTask {
  return {
    summary: "",
    projectId: "proj-1",
    projectName: "agent_terminal_2",
    projectPath: "/tmp/agent_terminal_2",
    currentStep: null,
    workerThreadId: null,
    activeTurnId: null,
    previewURL: null,
    latestOutput: "",
    activities: [],
    createdAt: "2026-11-26T00:00:00.000Z",
    updatedAt: "2026-11-26T00:00:00.000Z",
    ...overrides,
  };
}

describe("task-sidebar helpers", () => {
  it("partitions non-done tasks (including failed) into activeTasks and done tasks into completedTasks", () => {
    const tasks: AgentTask[] = [
      makeTask({ id: "t1", taskNumber: 1, title: "Running task", status: "running", projectId: "p1" }),
      makeTask({ id: "t2", taskNumber: 2, title: "Queued task", status: "queued", projectId: "p1" }),
      makeTask({ id: "t3", taskNumber: 3, title: "Review task", status: "needs_review", projectId: "p2" }),
      makeTask({ id: "t4", taskNumber: 4, title: "Failed task", status: "failed", projectId: "p1" }),
      makeTask({ id: "t5", taskNumber: 5, title: "Done task A", status: "done", projectId: "p1" }),
      makeTask({ id: "t6", taskNumber: 6, title: "Done task B", status: "done", projectId: "p2" }),
    ];

    const all = partitionSidebarTasks(tasks, null);
    expect(all.activeTasks.map((t) => t.id)).toEqual(["t1", "t2", "t3", "t4"]);
    expect(all.completedTasks.map((t) => t.id)).toEqual(["t5", "t6"]);

    const projectOne = partitionSidebarTasks(tasks, "p1");
    expect(projectOne.filteredTasks.map((t) => t.id)).toEqual(["t1", "t2", "t4", "t5"]);
    expect(projectOne.activeTasks.map((t) => t.id)).toEqual(["t1", "t2", "t4"]);
    expect(projectOne.completedTasks.map((t) => t.id)).toEqual(["t5"]);
  });

  it("omits quick Done transition for running tasks while returning Done for other non-done statuses and Reopen for done", () => {
    expect(getQuickStatusTransition("running")).toBeNull();

    for (const status of ["queued", "needs_review", "failed"] as const) {
      expect(getQuickStatusTransition(status)).toMatchObject({
        action: "done",
        label: "Done",
        nextStatus: "done",
      });
    }

    expect(getQuickStatusTransition("done")).toMatchObject({
      action: "reopen",
      label: "Reopen",
      nextStatus: REOPEN_TARGET_STATUS,
    });
  });

  it("blocks marking running or active-worker tasks as done while allowing normal transitions", () => {
    expect(canMarkTaskDone("running")).toBe(false);
    expect(canMarkTaskDone("needs_review", true)).toBe(false);
    expect(canMarkTaskDone("queued", false)).toBe(true);
    expect(canMarkTaskDone("needs_review", false)).toBe(true);
    expect(canMarkTaskDone("failed", false)).toBe(true);

    expect(
      validateManualTaskStatusTransition({ currentStatus: "running", nextStatus: "done" }),
    ).toEqual({
      ok: false,
      error: RUNNING_TASK_DONE_BLOCKED_REASON,
    });

    expect(
      validateManualTaskStatusTransition({
        currentStatus: "needs_review",
        nextStatus: "done",
        hasActiveWorker: true,
      }),
    ).toEqual({
      ok: false,
      error: RUNNING_TASK_DONE_BLOCKED_REASON,
    });

    // Normal completion / stop / reopen / resume transitions remain valid
    expect(
      validateManualTaskStatusTransition({ currentStatus: "running", nextStatus: "needs_review" }),
    ).toEqual({ ok: true });
    expect(
      validateManualTaskStatusTransition({ currentStatus: "running", nextStatus: "failed" }),
    ).toEqual({ ok: true });
    expect(
      validateManualTaskStatusTransition({ currentStatus: "done", nextStatus: "needs_review" }),
    ).toEqual({ ok: true });
    expect(
      validateManualTaskStatusTransition({ currentStatus: "done", nextStatus: "running" }),
    ).toEqual({ ok: true });
    expect(
      validateManualTaskStatusTransition({ currentStatus: "needs_review", nextStatus: "done" }),
    ).toEqual({ ok: true });
  });

  it("filters completed tasks by title, projectName, or summary (case-insensitive & multi-token)", () => {
    const completed: AgentTask[] = [
      makeTask({
        id: "c1",
        taskNumber: 10,
        title: "Add sidebar Done button",
        projectName: "agent_terminal_2",
        summary: "Implemented one-click Done and Reopen buttons",
        status: "done",
      }),
      makeTask({
        id: "c2",
        taskNumber: 11,
        title: "Fix OAuth redirect",
        projectName: "billing-portal",
        summary: "コールバックURLの検証を修正",
        status: "done",
      }),
      makeTask({
        id: "c3",
        taskNumber: 12,
        title: "Upgrade Vite",
        projectName: "docs-site",
        summary: "Bundler migration complete",
        status: "done",
      }),
    ];

    expect(filterCompletedTasks(completed, "")).toHaveLength(3);
    expect(filterCompletedTasks(completed, "   ")).toHaveLength(3);

    // Match by title
    expect(filterCompletedTasks(completed, "OAUTH").map((t) => t.id)).toEqual(["c2"]);
    // Match by projectName
    expect(filterCompletedTasks(completed, "docs-site").map((t) => t.id)).toEqual(["c3"]);
    // Match by summary (Japanese)
    expect(filterCompletedTasks(completed, "コールバック").map((t) => t.id)).toEqual(["c2"]);
    // Multi-token across projectName + summary
    expect(filterCompletedTasks(completed, "agent_terminal reopen").map((t) => t.id)).toEqual(["c1"]);
    // No match
    expect(filterCompletedTasks(completed, "nonexistent-keyword")).toEqual([]);
    expect(matchesCompletedTaskQuery(completed[0]!, "sidebar done")).toBe(true);
  });

  it("formats count badges and chooses appropriate subtitles for active vs done cards", () => {
    expect(formatCompletedCountBadge(4, 4, false)).toBe("4");
    expect(formatCompletedCountBadge(2, 4, true)).toBe("2/4");
    expect(formatCompletedCountBadge(0, 4, true)).toBe("0/4");

    const doneTask = makeTask({
      id: "d1",
      taskNumber: 1,
      title: "Completed",
      status: "done",
      currentStep: "完了・確認待ち",
      summary: "UIを改善しました",
    });
    const reviewTask = makeTask({
      id: "r1",
      taskNumber: 2,
      title: "Review",
      status: "needs_review",
      currentStep: "完了・確認待ち",
      summary: "UIを改善しました",
    });

    expect(getTaskCardSubtitle(doneTask)).toBe("UIを改善しました");
    expect(getTaskCardSubtitle(reviewTask)).toBe("完了・確認待ち");
  });

  it("clamps Questions section height between min height and 65% of sidebar height", () => {
    expect(getQuestionsSectionMaxHeight(800)).toBe(520);
    expect(getQuestionsSectionMaxHeight(120)).toBe(QUESTIONS_SECTION_MIN_HEIGHT);
    expect(getQuestionsSectionMaxHeight(0)).toBe(QUESTIONS_SECTION_MIN_HEIGHT);
    expect(getQuestionsSectionMaxHeight(Number.NaN)).toBe(QUESTIONS_SECTION_MIN_HEIGHT);

    expect(clampQuestionsSectionHeight(40, 800)).toBe(QUESTIONS_SECTION_MIN_HEIGHT);
    expect(clampQuestionsSectionHeight(240, 800)).toBe(240);
    expect(clampQuestionsSectionHeight(249.6, 800)).toBe(250);
    expect(clampQuestionsSectionHeight(700, 800)).toBe(520);
    expect(clampQuestionsSectionHeight(300, 120)).toBe(QUESTIONS_SECTION_MIN_HEIGHT);
    expect(clampQuestionsSectionHeight(Number.NaN, 800)).toBe(QUESTIONS_SECTION_MIN_HEIGHT);

    // Without known sidebar height, still enforces minimum and rounds
    expect(clampQuestionsSectionHeight(50)).toBe(QUESTIONS_SECTION_MIN_HEIGHT);
    expect(clampQuestionsSectionHeight(360.4)).toBe(360);
  });

  it("parses, persists, restores, and resets Questions section height in storage", () => {
    expect(parseQuestionsSectionHeight(null)).toBeNull();
    expect(parseQuestionsSectionHeight("")).toBeNull();
    expect(parseQuestionsSectionHeight("   ")).toBeNull();
    expect(parseQuestionsSectionHeight("abc")).toBeNull();
    expect(parseQuestionsSectionHeight("0")).toBeNull();
    expect(parseQuestionsSectionHeight("-120")).toBeNull();
    expect(parseQuestionsSectionHeight("Infinity")).toBeNull();
    expect(parseQuestionsSectionHeight(" 280.6 ", 800)).toBe(281);
    expect(parseQuestionsSectionHeight("900", 800)).toBe(520);
    expect(parseQuestionsSectionHeight("40", 800)).toBe(QUESTIONS_SECTION_MIN_HEIGHT);

    const store = new Map<string, string>();
    const memoryStorage: QuestionsHeightStorageLike = {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => {
        store.set(key, value);
      },
      removeItem: (key) => {
        store.delete(key);
      },
    };

    expect(loadQuestionsSectionHeight(memoryStorage, 800)).toBeNull();

    saveQuestionsSectionHeight(310.4, memoryStorage, 800);
    expect(store.get(QUESTIONS_SECTION_HEIGHT_STORAGE_KEY)).toBe("310");
    expect(loadQuestionsSectionHeight(memoryStorage, 800)).toBe(310);
    // Re-clamps dynamically if the sidebar later becomes shorter
    expect(loadQuestionsSectionHeight(memoryStorage, 400)).toBe(260);

    // Clamps on save as well
    saveQuestionsSectionHeight(900, memoryStorage, 800);
    expect(store.get(QUESTIONS_SECTION_HEIGHT_STORAGE_KEY)).toBe("520");

    // Reset removes the persisted key
    saveQuestionsSectionHeight(null, memoryStorage);
    expect(store.has(QUESTIONS_SECTION_HEIGHT_STORAGE_KEY)).toBe(false);
    expect(loadQuestionsSectionHeight(memoryStorage, 800)).toBeNull();

    // Works even if storage omits removeItem
    const minimalStore = new Map<string, string>();
    const minimalStorage: QuestionsHeightStorageLike = {
      getItem: (key) => minimalStore.get(key) ?? null,
      setItem: (key, value) => {
        minimalStore.set(key, value);
      },
    };
    saveQuestionsSectionHeight(240, minimalStorage, 800);
    expect(loadQuestionsSectionHeight(minimalStorage, 800)).toBe(240);
    saveQuestionsSectionHeight(null, minimalStorage);
    expect(loadQuestionsSectionHeight(minimalStorage, 800)).toBeNull();

    // Handles null or throwing storage gracefully
    expect(loadQuestionsSectionHeight(null)).toBeNull();
    const throwingStorage: QuestionsHeightStorageLike = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(() => saveQuestionsSectionHeight(200, throwingStorage)).not.toThrow();
    expect(() => saveQuestionsSectionHeight(null, throwingStorage)).not.toThrow();
    expect(loadQuestionsSectionHeight(throwingStorage)).toBeNull();
  });
});
