import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentTask, AgentTaskStatus, ChatMessage, Project } from "../src/shared/types.js";
import { RUNNING_TASK_DONE_BLOCKED_REASON } from "../src/shared/task-status.js";
import { deriveQuestionItems } from "../src/renderer/lib/questions.js";
import {
  COLLAPSED_PROJECT_GROUPS_STORAGE_KEY,
  QUESTIONS_SECTION_HEIGHT_STORAGE_KEY,
  REOPEN_TARGET_STATUS,
  TASK_GROUP_BY_PROJECT_STORAGE_KEY,
  makeProjectGroupCollapseKey,
} from "../src/renderer/lib/task-sidebar.js";
import { TaskInspectorModal, TaskStatusSelect } from "../src/renderer/components/TaskInspectorModal.js";
import {
  ProjectTaskGroupSection,
  TaskCard,
  TaskSidebar,
  type TaskSidebarProps,
} from "../src/renderer/components/TaskSidebar.js";

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
    expect(html).toContain("完了");
    expect(html).toContain("質問");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/data-testid="completed-count-badge"[^>]*>2<\/span>/);
    // Completed cards and search input are hidden while collapsed
    expect(html).not.toContain("Shipped feature");
    expect(html).not.toContain("完了タスクを検索...");

    const enHtml = renderToStaticMarkup(<TaskSidebar {...makeSidebarProps({ locale: "en" })} />);
    expect(enHtml).toContain("Completed");
    expect(enHtml).toContain("Questions");
    expect(enHtml).toContain("Tasks");
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

  it("renders Questions search input, filters by text/project/task, shows clear button and 0-hit empty state in JA/EN", () => {
    const secondProject = makeProject({
      id: "proj-2",
      name: "billing-portal",
      colorHex: "#10B981",
    });
    const allProjects = [...baseProjects, secondProject];
    const extraTask = makeTask({
      id: "task-9",
      taskNumber: 9,
      title: "Fix OAuth redirect loop",
      projectId: "proj-2",
      projectName: "billing-portal",
      status: "needs_review",
    });
    const allTasks = [...baseTasks, extraTask];

    const chatMessages: ChatMessage[] = [
      {
        id: "q-u1",
        role: "user",
        text: "@T9 の原因と修正方針を教えて",
        attachments: [],
        toolChips: [],
        isStreaming: false,
        createdAt: "2026-11-26T01:00:00.000Z",
      },
      {
        id: "q-a1",
        role: "assistant",
        provider: "claude",
        replyToMessageId: "q-u1",
        text: "リダイレクトURIの正規化漏れが原因です。",
        attachments: [],
        toolChips: [],
        isStreaming: false,
        createdAt: "2026-11-26T01:00:05.000Z",
      },
      {
        id: "q-u2",
        role: "user",
        text: "サイドバーのパフォーマンス最適化について",
        attachments: [],
        mentions: [
          {
            kind: "project",
            projectId: "proj-1",
            projectName: "agent_terminal_2",
            projectPath: "/tmp/agent_terminal_2",
            projectColorHex: "#3B82F6",
          },
        ],
        toolChips: [],
        isStreaming: false,
        createdAt: "2026-11-26T01:05:00.000Z",
      },
      {
        id: "q-a2",
        role: "assistant",
        provider: "codex",
        replyToMessageId: "q-u2",
        text: "React.memo と useMemo で再描画を抑えます。",
        attachments: [],
        toolChips: [],
        isStreaming: false,
        createdAt: "2026-11-26T01:05:05.000Z",
      },
    ];

    const questions = deriveQuestionItems(chatMessages, new Set(), "ja", {
      projects: allProjects,
      tasks: allTasks,
    });

    // 1. Default expanded with questions: search input shown, no clear button yet, count badge = 2
    const defaultHtml = renderToStaticMarkup(
      <TaskSidebar
        {...makeSidebarProps({
          projects: allProjects,
          tasks: allTasks,
          questions,
        })}
      />,
    );
    expect(defaultHtml).toContain('data-testid="questions-search-input"');
    expect(defaultHtml).toContain("質問を検索...");
    expect(defaultHtml).not.toContain('data-testid="questions-search-clear"');
    expect(defaultHtml).not.toContain('data-testid="questions-search-count"');
    expect(defaultHtml).toMatch(/data-testid="questions-count-badge"[^>]*>2<\/span>/);
    expect(defaultHtml).toContain("@T9 の原因と修正方針を教えて");
    expect(defaultHtml).toContain("サイドバーのパフォーマンス最適化について");
    expect(defaultHtml).toContain('data-testid="question-relation-badges"');
    expect(defaultHtml).toContain("T9");
    expect(defaultHtml).toContain("billing-portal");

    // 2. Filtering by related task title ("OAuth") narrows to 1/2, shows clear button & showing count,
    //    and works cleanly even while Tasks project filter is active
    const filteredHtml = renderToStaticMarkup(
      <TaskSidebar
        {...makeSidebarProps({
          projects: allProjects,
          tasks: allTasks,
          questions,
          selectedProjectId: "proj-1",
          defaultQuestionsSearch: "oauth",
        })}
      />,
    );
    expect(filteredHtml).toMatch(/data-testid="questions-count-badge"[^>]*>1\/2<\/span>/);
    expect(filteredHtml).toContain('data-testid="questions-search-clear"');
    expect(filteredHtml).toContain('data-testid="questions-search-count"');
    expect(filteredHtml).toContain("1 / 2 件表示");
    expect(filteredHtml).toContain("@T9 の原因と修正方針を教えて");
    expect(filteredHtml).not.toContain("サイドバーのパフォーマンス最適化について");

    // 3. 0-hit empty state in JA
    const emptyJaHtml = renderToStaticMarkup(
      <TaskSidebar
        {...makeSidebarProps({
          projects: allProjects,
          tasks: allTasks,
          questions,
          defaultQuestionsSearch: "does-not-exist",
        })}
      />,
    );
    expect(emptyJaHtml).toMatch(/data-testid="questions-count-badge"[^>]*>0\/2<\/span>/);
    expect(emptyJaHtml).toContain('data-testid="questions-search-empty"');
    expect(emptyJaHtml).toContain("一致する質問がありません");
    expect(emptyJaHtml).toContain('data-testid="questions-search-clear-empty"');
    expect(emptyJaHtml).toContain("フィルタをクリア");

    // 4. 0-hit empty state & search labels in EN
    const emptyEnHtml = renderToStaticMarkup(
      <TaskSidebar
        {...makeSidebarProps({
          projects: allProjects,
          tasks: allTasks,
          questions,
          locale: "en",
          defaultQuestionsSearch: "does-not-exist",
        })}
      />,
    );
    expect(emptyEnHtml).toContain("Search questions...");
    expect(emptyEnHtml).toContain("Showing 0 of 2");
    expect(emptyEnHtml).toContain("No matching questions");
    expect(emptyEnHtml).toContain("Clear filter");

    // 5. Collapsed Questions section hides search input
    const collapsedHtml = renderToStaticMarkup(
      <TaskSidebar
        {...makeSidebarProps({
          projects: allProjects,
          tasks: allTasks,
          questions,
          defaultQuestionsExpanded: false,
          defaultQuestionsSearch: "oauth",
        })}
      />,
    );
    expect(collapsedHtml).not.toContain('data-testid="questions-search-input"');
    expect(collapsedHtml).not.toContain('data-testid="questions-list-container"');
  });

  it("groups tasks by project by default with running/needs_review badges, supports collapse/flat toggle persistence, and auto-expands matched groups on search", () => {
    const projects: Project[] = [
      makeProject({ id: "proj-alpha", name: "alpha-web", colorHex: "#3B82F6" }),
      makeProject({ id: "proj-beta", name: "beta-api", colorHex: "#10B981" }),
      makeProject({ id: "proj-gamma", name: "gamma-cli", colorHex: "#F59E0B" }),
    ];

    const tasks: AgentTask[] = [
      makeTask({
        id: "t-gamma-queued",
        taskNumber: 10,
        title: "Gamma queued task",
        projectId: "proj-gamma",
        projectName: "gamma-cli",
        status: "queued",
        updatedAt: "2026-11-26T12:00:00.000Z",
      }),
      makeTask({
        id: "t-alpha-review",
        taskNumber: 11,
        title: "Alpha review task",
        projectId: "proj-alpha",
        projectName: "alpha-web",
        status: "needs_review",
        updatedAt: "2026-11-26T11:00:00.000Z",
      }),
      makeTask({
        id: "t-beta-running",
        taskNumber: 12,
        title: "Beta running task",
        projectId: "proj-beta",
        projectName: "beta-api",
        status: "running",
        updatedAt: "2026-11-26T10:00:00.000Z",
      }),
      makeTask({
        id: "t-beta-review",
        taskNumber: 13,
        title: "Beta review task",
        projectId: "proj-beta",
        projectName: "beta-api",
        status: "needs_review",
        updatedAt: "2026-11-26T10:05:00.000Z",
      }),
      makeTask({
        id: "t-alpha-done-1",
        taskNumber: 14,
        title: "Alpha OAuth fix",
        projectId: "proj-alpha",
        projectName: "alpha-web",
        status: "done",
        summary: "Fixed OAuth callback",
        updatedAt: "2026-11-26T09:00:00.000Z",
      }),
      makeTask({
        id: "t-alpha-done-2",
        taskNumber: 15,
        title: "Alpha lint cleanup",
        projectId: "proj-alpha",
        projectName: "alpha-web",
        status: "done",
        summary: "Cleaned eslint warnings",
        updatedAt: "2026-11-26T08:00:00.000Z",
      }),
      makeTask({
        id: "t-beta-done-1",
        taskNumber: 16,
        title: "Beta metrics endpoint",
        projectId: "proj-beta",
        projectName: "beta-api",
        status: "done",
        summary: "Added Prometheus metrics",
        updatedAt: "2026-11-26T09:30:00.000Z",
      }),
    ];

    // 1. Default grouped view: toggle is pressed, groups sorted beta (running) -> alpha (needs_review) -> gamma (queued)
    const groupedHtml = renderToStaticMarkup(
      <TaskSidebar {...makeSidebarProps({ projects, tasks })} />,
    );
    expect(groupedHtml).toContain('data-testid="toggle-project-grouping"');
    expect(groupedHtml).toContain('aria-pressed="true"');
    expect(groupedHtml).toContain('data-testid="active-project-groups"');
    expect(groupedHtml).toContain('data-testid="project-group-running-badge"');
    expect(groupedHtml).toContain('data-testid="project-group-review-badge"');

    const betaIdx = groupedHtml.indexOf('data-project-group="beta-api"');
    const alphaIdx = groupedHtml.indexOf('data-project-group="alpha-web"');
    const gammaIdx = groupedHtml.indexOf('data-project-group="gamma-cli"');
    expect(betaIdx).toBeGreaterThan(-1);
    expect(alphaIdx).toBeGreaterThan(betaIdx);
    expect(gammaIdx).toBeGreaterThan(alphaIdx);

    // 2. Collapsed project group hides its task cards while preserving header & counts
    const collapsedHtml = renderToStaticMarkup(
      <TaskSidebar
        {...makeSidebarProps({
          projects,
          tasks,
          defaultCollapsedProjectGroups: [makeProjectGroupCollapseKey("active", "beta-api")],
        })}
      />,
    );
    expect(collapsedHtml).not.toContain("Beta running task");
    expect(collapsedHtml).not.toContain("Beta review task");
    expect(collapsedHtml).toContain("Alpha review task");
    expect(collapsedHtml).toMatch(
      /data-testid="project-group-header"[^>]*data-project-group="beta-api"[^>]*aria-expanded="false"/,
    );

    // 3. Completed search auto-expands matched project groups even when collapsed and shows filtered/total badge
    const searchCompletedHtml = renderToStaticMarkup(
      <TaskSidebar
        {...makeSidebarProps({
          projects,
          tasks,
          defaultCompletedExpanded: true,
          defaultCompletedSearch: "oauth",
          defaultCollapsedProjectGroups: [makeProjectGroupCollapseKey("completed", "alpha-web")],
        })}
      />,
    );
    expect(searchCompletedHtml).toContain('data-testid="completed-project-groups"');
    expect(searchCompletedHtml).toContain("Alpha OAuth fix");
    expect(searchCompletedHtml).not.toContain("Alpha lint cleanup");
    expect(searchCompletedHtml).not.toContain("Beta metrics endpoint");
    expect(searchCompletedHtml).toMatch(
      /data-testid="project-group-header"[^>]*data-project-group="alpha-web"[^>]*data-section="completed"[^>]*aria-expanded="true"/,
    );
    expect(searchCompletedHtml).toMatch(/data-testid="project-group-count"[^>]*>1\/2<\/span>/);

    // 4. Project filter narrows visible groups to the selected project
    const filteredProjectHtml = renderToStaticMarkup(
      <TaskSidebar
        {...makeSidebarProps({
          projects,
          tasks,
          selectedProjectId: "proj-alpha",
        })}
      />,
    );
    expect(filteredProjectHtml).toContain("Alpha review task");
    expect(filteredProjectHtml).not.toContain("Beta running task");
    expect(filteredProjectHtml).not.toContain("Gamma queued task");

    // 5. Flat list mode (defaultGroupByProject=false) omits project group headers
    const flatHtml = renderToStaticMarkup(
      <TaskSidebar
        {...makeSidebarProps({
          projects,
          tasks,
          defaultGroupByProject: false,
        })}
      />,
    );
    expect(flatHtml).toContain('aria-pressed="false"');
    expect(flatHtml).not.toContain('data-testid="active-project-groups"');
    expect(flatHtml).not.toContain('data-testid="project-group-header"');
    expect(flatHtml).toContain("Beta running task");

    // 6. Persisted localStorage preferences (flat mode + collapsed groups) are restored on render
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
      store.set(TASK_GROUP_BY_PROJECT_STORAGE_KEY, "false");
      const persistedFlatHtml = renderToStaticMarkup(
        <TaskSidebar {...makeSidebarProps({ projects, tasks })} />,
      );
      expect(persistedFlatHtml).toContain('aria-pressed="false"');
      expect(persistedFlatHtml).not.toContain('data-testid="project-group-header"');

      store.set(TASK_GROUP_BY_PROJECT_STORAGE_KEY, "true");
      store.set(
        COLLAPSED_PROJECT_GROUPS_STORAGE_KEY,
        JSON.stringify([makeProjectGroupCollapseKey("active", "alpha-web")]),
      );
      const persistedCollapsedHtml = renderToStaticMarkup(
        <TaskSidebar {...makeSidebarProps({ projects, tasks })} />,
      );
      expect(persistedCollapsedHtml).toContain('aria-pressed="true"');
      expect(persistedCollapsedHtml).not.toContain("Alpha review task");
      expect(persistedCollapsedHtml).toContain("Beta running task");
    } finally {
      if (originalStorage === undefined) {
        delete g.localStorage;
      } else {
        g.localStorage = originalStorage;
      }
    }

    // 7. ProjectTaskGroupSection header click triggers toggle when not forceExpanded, and ignores clicks while forceExpanded
    const onToggleCollapse = vi.fn();
    const normalGroupEl = ProjectTaskGroupSection({
      group: {
        groupKey: "beta-api",
        projectName: "beta-api",
        projectId: "proj-beta",
        colorHex: "#10B981",
        tasks: [tasks[2]!],
        runningCount: 1,
        needsReviewCount: 0,
        queuedCount: 0,
        failedCount: 0,
        doneCount: 0,
        latestUpdatedAtMs: Date.parse("2026-11-26T10:00:00.000Z"),
      },
      section: "active",
      locale: "ja",
      isCollapsed: false,
      onToggleCollapse,
      renderTaskCard: () => null,
    });
    const headerBtn = findElementByTestId(normalGroupEl, "project-group-header");
    expect(headerBtn).not.toBeNull();
    (headerBtn!.props.onClick as () => void)();
    expect(onToggleCollapse).toHaveBeenCalledWith("active:beta-api");

    onToggleCollapse.mockClear();
    const forcedGroupEl = ProjectTaskGroupSection({
      group: {
        groupKey: "alpha-web",
        projectName: "alpha-web",
        projectId: "proj-alpha",
        colorHex: "#3B82F6",
        tasks: [tasks[4]!],
        runningCount: 0,
        needsReviewCount: 0,
        queuedCount: 0,
        failedCount: 0,
        doneCount: 1,
        latestUpdatedAtMs: Date.parse("2026-11-26T09:00:00.000Z"),
      },
      section: "completed",
      locale: "en",
      isCollapsed: true,
      forceExpanded: true,
      totalCountInGroup: 2,
      onToggleCollapse,
      renderTaskCard: () => null,
    });
    const forcedHeaderBtn = findElementByTestId(forcedGroupEl, "project-group-header");
    expect(forcedHeaderBtn).not.toBeNull();
    (forcedHeaderBtn!.props.onClick as () => void)();
    expect(onToggleCollapse).not.toHaveBeenCalled();
  });
});
