import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentTask, AgentTaskStatus, Project } from "../src/shared/types.js";
import { RUNNING_TASK_DONE_BLOCKED_REASON } from "../src/shared/task-status.js";
import {
  QUESTIONS_SECTION_HEIGHT_STORAGE_KEY,
  REOPEN_TARGET_STATUS,
} from "../src/renderer/lib/task-sidebar.js";
import { TaskInspectorModal, TaskStatusSelect } from "../src/renderer/components/TaskInspectorModal.js";
import { TaskCard, TaskSidebar, type TaskSidebarProps } from "../src/renderer/components/TaskSidebar.js";

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

function makeProject(overrides: Partial<Project> & { id: string; name: string }): Project {
  return {
    path: `/tmp/${overrides.name}`,
    colorHex: "#3B82F6",
    gitBranch: "main",
    addedAt: "2026-11-26T00:00:00.000Z",
    ...overrides,
  };
}

function findElementByTestId(
  node: unknown,
  testId: string,
): React.ReactElement<Record<string, unknown>> | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElementByTestId(child, testId);
      if (found) return found;
    }
    return null;
  }
  if (!React.isValidElement(node)) return null;
  const props = node.props as Record<string, unknown>;
  if (props["data-testid"] === testId) {
    return node as React.ReactElement<Record<string, unknown>>;
  }
  return findElementByTestId(props.children, testId);
}

describe("TaskCard & TaskSidebar rendering and click isolation", () => {
  const baseProjects: Project[] = [makeProject({ id: "proj-1", name: "agent_terminal_2" })];
  const baseTasks: AgentTask[] = [
    makeTask({
      id: "active-1",
      taskNumber: 1,
      title: "Active review item",
      status: "needs_review",
      currentStep: "完了・確認待ち",
    }),
    makeTask({
      id: "done-1",
      taskNumber: 2,
      title: "Shipped feature",
      status: "done",
      summary: "Released to production",
    }),
    makeTask({
      id: "done-2",
      taskNumber: 3,
      title: "Fixed lint issue",
      status: "done",
      summary: "Cleaned up warnings",
    }),
  ];

  function makeSidebarProps(overrides: Partial<TaskSidebarProps> = {}): TaskSidebarProps {
    return {
      projects: baseProjects,
      tasks: baseTasks,
      selectedProjectId: null,
      selectedTaskId: null,
      onSelectProjectFilter: vi.fn(),
      onAddProject: vi.fn(),
      onScanDirectory: vi.fn(),
      onRescanProjects: vi.fn(),
      onRemoveProject: vi.fn(),
      onMentionProject: vi.fn(),
      onSelectTask: vi.fn(),
      onOpenPreviewUrl: vi.fn(),
      onMentionTask: vi.fn(),
      onUpdateTaskStatus: vi.fn(),
      onStopWorker: vi.fn(),
      onDeleteTask: vi.fn(),
      ...overrides,
    };
  }

  it("renders Done button on active cards and collapses Completed section with count badge by default", () => {
    const html = renderToStaticMarkup(<TaskSidebar {...makeSidebarProps()} />);

    expect(html).toContain("Active review item");
    expect(html).toContain('data-testid="task-quick-done"');
    expect(html).toContain("Completed");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/data-testid="completed-count-badge"[^>]*>2<\/span>/);
    // Completed cards and search input are hidden while collapsed
    expect(html).not.toContain("Shipped feature");
    expect(html).not.toContain("完了タスクを検索...");
  });

  it("renders search input and Reopen buttons when Completed section is expanded", () => {
    const html = renderToStaticMarkup(
      <TaskSidebar {...makeSidebarProps({ defaultCompletedExpanded: true })} />,
    );

    expect(html).toContain('aria-expanded="true"');
    expect(html).toMatch(/data-testid="completed-count-badge"[^>]*>2<\/span>/);
    expect(html).toContain("完了タスクを検索...");
    expect(html).toContain("Shipped feature");
    expect(html).toContain("Fixed lint issue");
    expect(html).toContain('data-testid="task-quick-reopen"');
  });

  it("calls stopPropagation and updates status without triggering card onSelect when clicking Done or Reopen", () => {
    const onSelect = vi.fn();
    const onUpdateStatus = vi.fn();

    const activeElement = TaskCard({
      task: baseTasks[0]!,
      colorHex: "#3B82F6",
      isSelected: false,
      onSelect,
      onOpenPreview: vi.fn(),
      onMention: vi.fn(),
      onUpdateStatus,
      onStop: vi.fn(),
      onDelete: vi.fn(),
    });

    const doneButton = findElementByTestId(activeElement, "task-quick-done");
    expect(doneButton).not.toBeNull();

    const stopPropagationDone = vi.fn();
    (doneButton!.props.onClick as (e: { stopPropagation: () => void }) => void)({
      stopPropagation: stopPropagationDone,
    });

    expect(stopPropagationDone).toHaveBeenCalledTimes(1);
    expect(onUpdateStatus).toHaveBeenCalledWith("done");
    expect(onSelect).not.toHaveBeenCalled();

    onUpdateStatus.mockClear();

    const completedElement = TaskCard({
      task: baseTasks[1]!,
      colorHex: "#3B82F6",
      isSelected: false,
      onSelect,
      onOpenPreview: vi.fn(),
      onMention: vi.fn(),
      onUpdateStatus,
      onStop: vi.fn(),
      onDelete: vi.fn(),
    });

    const reopenButton = findElementByTestId(completedElement, "task-quick-reopen");
    expect(reopenButton).not.toBeNull();

    const stopPropagationReopen = vi.fn();
    (reopenButton!.props.onClick as (e: { stopPropagation: () => void }) => void)({
      stopPropagation: stopPropagationReopen,
    });

    expect(stopPropagationReopen).toHaveBeenCalledTimes(1);
    expect(onUpdateStatus).toHaveBeenCalledWith(REOPEN_TARGET_STATUS);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("omits the quick Done button on running cards while keeping Stop available", () => {
    const runningTask = makeTask({
      id: "running-1",
      taskNumber: 4,
      title: "Live background build",
      status: "running",
      currentStep: "テスト実行中...",
    });

    const onSelect = vi.fn();
    const onStop = vi.fn();
    const onUpdateStatus = vi.fn();

    const html = renderToStaticMarkup(
      <TaskCard
        task={runningTask}
        colorHex="#3B82F6"
        isSelected={false}
        onSelect={onSelect}
        onOpenPreview={vi.fn()}
        onMention={vi.fn()}
        onUpdateStatus={onUpdateStatus}
        onStop={onStop}
        onDelete={vi.fn()}
      />,
    );

    expect(html).not.toContain('data-testid="task-quick-done"');
    expect(html).not.toContain('data-testid="task-quick-reopen"');
    expect(html).toContain('data-testid="task-stop-worker"');

    const cardElement = TaskCard({
      task: runningTask,
      colorHex: "#3B82F6",
      isSelected: false,
      onSelect,
      onOpenPreview: vi.fn(),
      onMention: vi.fn(),
      onUpdateStatus,
      onStop,
      onDelete: vi.fn(),
    });

    expect(findElementByTestId(cardElement, "task-quick-done")).toBeNull();
    const stopButton = findElementByTestId(cardElement, "task-stop-worker");
    expect(stopButton).not.toBeNull();

    const stopPropagation = vi.fn();
    (stopButton!.props.onClick as (e: { stopPropagation: () => void }) => void)({
      stopPropagation,
    });
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onUpdateStatus).not.toHaveBeenCalled();
  });

  it("disables and blocks transitioning a running task to done in TaskInspectorModal", () => {
    const runningTask = makeTask({
      id: "running-2",
      taskNumber: 5,
      title: "Running worker task",
      status: "running",
      currentStep: "コード編集中...",
    });
    const reviewTask = makeTask({
      id: "review-2",
      taskNumber: 6,
      title: "Ready for review task",
      status: "needs_review",
      currentStep: "完了・確認待ち",
    });

    const runningHtml = renderToStaticMarkup(
      <TaskInspectorModal
        task={runningTask}
        projectColorHex="#3B82F6"
        onClose={vi.fn()}
        onUpdateStatus={vi.fn()}
        onOpenPreviewUrl={vi.fn()}
        onMentionInChat={vi.fn()}
        onStopWorker={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(runningHtml).toContain('data-testid="inspector-status-select"');
    expect(runningHtml).toMatch(/<option value="done"[^>]*disabled=""/);
    expect(runningHtml).toContain(RUNNING_TASK_DONE_BLOCKED_REASON);

    const reviewHtml = renderToStaticMarkup(
      <TaskInspectorModal
        task={reviewTask}
        projectColorHex="#3B82F6"
        onClose={vi.fn()}
        onUpdateStatus={vi.fn()}
        onOpenPreviewUrl={vi.fn()}
        onMentionInChat={vi.fn()}
        onStopWorker={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(reviewHtml).not.toMatch(/<option value="done"[^>]*disabled=""/);

    // Verify onChange guard blocks running -> done even if invoked directly
    const onUpdateStatus = vi.fn();
    const runningSelect = findElementByTestId(
      TaskStatusSelect({
        status: "running",
        onUpdateStatus,
      }),
      "inspector-status-select",
    );

    expect(runningSelect).not.toBeNull();
    const onChange = runningSelect!.props.onChange as (e: { target: { value: string } }) => void;

    onChange({ target: { value: "done" } });
    expect(onUpdateStatus).not.toHaveBeenCalled();

    onChange({ target: { value: "needs_review" } });
    expect(onUpdateStatus).toHaveBeenCalledWith("needs_review");

    // Non-running status allows done; done allows reopen/resume
    onUpdateStatus.mockClear();
    const reviewSelect = findElementByTestId(
      TaskStatusSelect({
        status: "needs_review",
        onUpdateStatus,
      }),
      "inspector-status-select",
    );
    expect(reviewSelect).not.toBeNull();
    (reviewSelect!.props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: "done" },
    });
    expect(onUpdateStatus).toHaveBeenCalledWith("done");

    onUpdateStatus.mockClear();
    const doneSelect = findElementByTestId(
      TaskStatusSelect({
        status: "done",
        onUpdateStatus,
      }),
      "inspector-status-select",
    );
    expect(doneSelect).not.toBeNull();
    (doneSelect!.props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: "needs_review" },
    });
    expect(onUpdateStatus).toHaveBeenCalledWith("needs_review");
  });

  it("renders a vertical resize handle for Questions when expanded, restores persisted height, and collapses cleanly", () => {
    const g = globalThis as unknown as {
      localStorage?: {
        getItem(key: string): string | null;
        setItem(key: string, value: string): void;
        removeItem(key: string): void;
      };
    };
    const originalStorage = g.localStorage;
    const store = new Map<string, string>();
    g.localStorage = {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => {
        store.set(key, value);
      },
      removeItem: (key) => {
        store.delete(key);
      },
    };

    try {
      // 1. Default expanded state (no persisted height)
      const defaultHtml = renderToStaticMarkup(<TaskSidebar {...makeSidebarProps()} />);
      expect(defaultHtml).toContain('data-testid="questions-resize-handle"');
      expect(defaultHtml).toContain("cursor-row-resize");
      expect(defaultHtml).toContain('role="separator"');
      expect(defaultHtml).toContain('aria-orientation="horizontal"');
      expect(defaultHtml).toContain('data-testid="questions-list-container"');
      expect(defaultHtml).toContain("max-h-[38vh]");
      expect(defaultHtml).not.toMatch(/data-testid="questions-section"[^>]*style="/);

      // 2. Expanded state with persisted height
      store.set(QUESTIONS_SECTION_HEIGHT_STORAGE_KEY, "260");
      const persistedHtml = renderToStaticMarkup(<TaskSidebar {...makeSidebarProps()} />);
      expect(persistedHtml).toContain('data-testid="questions-resize-handle"');
      expect(persistedHtml).toMatch(
        /data-testid="questions-section"[^>]*style="height:260px;max-height:65%"/,
      );
      expect(persistedHtml).toMatch(
        /data-testid="questions-list-container"[^>]*class="flex-1 min-h-0 overflow-y-auto/,
      );
      expect(persistedHtml).not.toContain("max-h-[38vh]");

      // 3. Collapsed state omits resize handle, list, and inline height even when a height is persisted
      const collapsedHtml = renderToStaticMarkup(
        <TaskSidebar {...makeSidebarProps({ defaultQuestionsExpanded: false })} />,
      );
      expect(collapsedHtml).not.toContain('data-testid="questions-resize-handle"');
      expect(collapsedHtml).not.toContain('data-testid="questions-list-container"');
      expect(collapsedHtml).not.toMatch(/data-testid="questions-section"[^>]*style="/);
      expect(collapsedHtml).toMatch(
        /aria-expanded="false"[^>]*data-testid="questions-toggle-button"/,
      );
    } finally {
      if (originalStorage === undefined) {
        delete g.localStorage;
      } else {
        g.localStorage = originalStorage;
      }
    }
  });
});
