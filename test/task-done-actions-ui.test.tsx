import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentTask, AgentTaskStatus, AppSnapshot, ChatMessage, Project } from "../src/shared/types.js";
import { UNLANDED_TASK_DONE_BLOCKED_REASON } from "../src/shared/task-status.js";
import { resolveTaskForTaskEvent } from "../src/renderer/lib/task-event.js";
import { REOPEN_TARGET_STATUS } from "../src/renderer/lib/task-sidebar.js";
import {
  TaskInspectorModal,
  TaskInspectorQuickStatusButton,
  TaskStatusSelect,
} from "../src/renderer/components/TaskInspectorModal.js";
import { TaskCard } from "../src/renderer/components/TaskSidebar.js";
import { TaskEventCard, UnifiedChat } from "../src/renderer/components/UnifiedChat.js";

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

function makeTaskEventMessage(
  overrides: Partial<ChatMessage> & { id: string; text: string },
): ChatMessage {
  return {
    role: "taskEvent",
    attachments: [],
    toolChips: [],
    isStreaming: false,
    createdAt: "2026-11-26T01:00:00.000Z",
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

const SAMPLE_PROJECTS: Project[] = [
  {
    id: "proj-1",
    name: "agent_terminal_2",
    path: "/tmp/agent_terminal_2",
    colorHex: "#3B82F6",
    gitBranch: "main",
    addedAt: "2026-11-26T00:00:00.000Z",
  },
];

function makeSnapshot(tasks: AgentTask[], messages: ChatMessage[]): AppSnapshot {
  return {
    projects: SAMPLE_PROJECTS,
    scanRoots: [],
    tasks,
    messages,
    activeChatSessionId: "sess-1",
    chatSessions: [
      {
        id: "sess-1",
        title: "Task Reports",
        preview: "",
        messageCount: messages.length,
        createdAt: "2026-11-26T00:00:00.000Z",
        updatedAt: "2026-11-26T00:00:00.000Z",
      },
    ],
    browserTabs: [],
    activeBrowserTabId: null,
    isPickingElement: false,
    showTaskSidebar: true,
    showBrowserPane: false,
    isConnected: true,
    connectionStatus: "Codex 利用可能",
    activeResponderCount: 0,
    providers: {
      codex: { id: "codex", label: "Codex", available: true, detail: "ok", models: [] },
      agy: { id: "agy", label: "AGY", available: true, detail: "ok", models: [] },
      claude: { id: "claude", label: "Claude", available: false, detail: "", models: [] },
    },
    chatProvider: "codex",
    workerProvider: "codex",
    models: [],
    chatModel: null,
    chatEffort: null,
    workerModel: null,
    workerEffort: null,
    defaultIntegrationMode: "feature-branch",
    autoLandOnComplete: true,
    preferredLanguage: "ja",
    lastErrorBanner: null,
  };
}

describe("resolveTaskForTaskEvent", () => {
  const tasks: AgentTask[] = [
    makeTask({ id: "task-1", taskNumber: 1, title: "First task", status: "needs_review" }),
    makeTask({
      id: "task-12",
      taskNumber: 12,
      title: "Add one-click Done buttons",
      projectName: "agent_terminal_2",
      status: "needs_review",
    }),
  ];

  it("resolves directly by relatedTaskId and does not mis-resolve when relatedTaskId is deleted", () => {
    const directMsg = makeTaskEventMessage({
      id: "m1",
      relatedTaskId: "task-12",
      text: "**[T12 · agent_terminal_2] Add one-click Done buttons** — 完了（確認待ち）",
    });
    expect(resolveTaskForTaskEvent(directMsg, tasks)?.id).toBe("task-12");

    const deletedMsg = makeTaskEventMessage({
      id: "m2",
      relatedTaskId: "deleted-task-99",
      text: "**[T12 · agent_terminal_2] Old deleted task** — 完了（確認待ち）",
    });
    expect(resolveTaskForTaskEvent(deletedMsg, tasks)).toBeUndefined();
  });

  it("gracefully resolves legacy messages without relatedTaskId by unambiguous [T# ...] header code", () => {
    const legacyWithProvider = makeTaskEventMessage({
      id: "m3",
      text: "**[T12 · agent_terminal_2 · AGY] Add one-click Done buttons** — 完了（確認待ち）\nDone.",
    });
    expect(resolveTaskForTaskEvent(legacyWithProvider, tasks)?.id).toBe("task-12");

    const legacyMinimal = makeTaskEventMessage({
      id: "m4",
      text: "[T1] Legacy worker completion report",
    });
    expect(resolveTaskForTaskEvent(legacyMinimal, tasks)?.id).toBe("task-1");
  });

  it("disambiguates duplicate legacy task numbers with project name and rejects ambiguous headers", () => {
    const duplicateTasks: AgentTask[] = [
      makeTask({
        id: "t-alpha",
        taskNumber: 5,
        title: "Alpha task",
        projectName: "alpha-app",
        status: "needs_review",
      }),
      makeTask({
        id: "t-beta",
        taskNumber: 5,
        title: "Beta task",
        projectName: "beta-app",
        status: "failed",
      }),
    ];

    expect(
      resolveTaskForTaskEvent(
        makeTaskEventMessage({ id: "m5", text: "**[T5 · beta-app] Beta task** — 失敗" }),
        duplicateTasks,
      )?.id,
    ).toBe("t-beta");

    // Duplicate task number with no project hint -> ambiguous
    expect(
      resolveTaskForTaskEvent(
        makeTaskEventMessage({ id: "m6", text: "**[T5] Ambiguous task** — 完了" }),
        duplicateTasks,
      ),
    ).toBeUndefined();

    // Multiple distinct [T#] codes in the header -> ambiguous
    expect(
      resolveTaskForTaskEvent(
        makeTaskEventMessage({ id: "m7", text: "[T1] と [T12] のまとめレポート" }),
        tasks,
      ),
    ).toBeUndefined();

    // No task code at all -> undefined
    expect(
      resolveTaskForTaskEvent(
        makeTaskEventMessage({ id: "m8", text: "一般的なシステム通知です" }),
        tasks,
      ),
    ).toBeUndefined();
  });
});

describe("TaskInspectorModal one-click Done / Reopen", () => {
  it("renders Done button for non-running non-done tasks, Reopen for done tasks, and hides both for running tasks", () => {
    const statusesForDone: AgentTaskStatus[] = ["queued", "needs_review", "failed"];
    for (const status of statusesForDone) {
      const task = makeTask({ id: `t-${status}`, taskNumber: 1, title: `Task ${status}`, status });
      const html = renderToStaticMarkup(
        <TaskInspectorModal
          task={task}
          projectColorHex="#3B82F6"
          onClose={vi.fn()}
          onUpdateStatus={vi.fn()}
          onOpenPreviewUrl={vi.fn()}
          onMentionInChat={vi.fn()}
          onStopWorker={vi.fn()}
          onDelete={vi.fn()}
        />,
      );
      expect(html).toContain('data-testid="inspector-quick-done"');
      expect(html).not.toContain('data-testid="inspector-quick-reopen"');
    }

    const doneTask = makeTask({ id: "t-done", taskNumber: 2, title: "Shipped task", status: "done" });
    const doneHtml = renderToStaticMarkup(
      <TaskInspectorModal
        task={doneTask}
        projectColorHex="#3B82F6"
        onClose={vi.fn()}
        onUpdateStatus={vi.fn()}
        onOpenPreviewUrl={vi.fn()}
        onMentionInChat={vi.fn()}
        onStopWorker={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(doneHtml).toContain('data-testid="inspector-quick-reopen"');
    expect(doneHtml).not.toContain('data-testid="inspector-quick-done"');

    const runningTask = makeTask({
      id: "t-running",
      taskNumber: 3,
      title: "Active worker task",
      status: "running",
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
    expect(runningHtml).not.toContain('data-testid="inspector-quick-done"');
    expect(runningHtml).not.toContain('data-testid="inspector-quick-reopen"');
  });

  it("handles Done and Reopen clicks with stopPropagation and guards running status", () => {
    const onUpdateStatus = vi.fn();

    // Running returns null
    expect(
      TaskInspectorQuickStatusButton({
        task: { title: "Running", status: "running" },
        onUpdateStatus,
      }),
    ).toBeNull();

    // Review -> Done
    const doneBtn = findElementByTestId(
      TaskInspectorQuickStatusButton({
        task: { title: "Review item", status: "needs_review" },
        onUpdateStatus,
      }),
      "inspector-quick-done",
    );
    expect(doneBtn).not.toBeNull();
    const stopPropDone = vi.fn();
    (doneBtn!.props.onClick as (e: { stopPropagation: () => void }) => void)({
      stopPropagation: stopPropDone,
    });
    expect(stopPropDone).toHaveBeenCalledTimes(1);
    expect(onUpdateStatus).toHaveBeenCalledWith("done");

    // Done -> Reopen
    onUpdateStatus.mockClear();
    const reopenBtn = findElementByTestId(
      TaskInspectorQuickStatusButton({
        task: { title: "Done item", status: "done" },
        onUpdateStatus,
      }),
      "inspector-quick-reopen",
    );
    expect(reopenBtn).not.toBeNull();
    const stopPropReopen = vi.fn();
    (reopenBtn!.props.onClick as (e: { stopPropagation: () => void }) => void)({
      stopPropagation: stopPropReopen,
    });
    expect(stopPropReopen).toHaveBeenCalledTimes(1);
    expect(onUpdateStatus).toHaveBeenCalledWith(REOPEN_TARGET_STATUS);
  });
});

describe("UnifiedChat TaskEventCard one-click Done / Reopen", () => {
  it("renders Done button for review/failed tasks, Done badge + Reopen for done tasks, and hides Done for running tasks", () => {
    const reviewTask = makeTask({
      id: "task-review",
      taskNumber: 10,
      title: "Fix chat scroll",
      status: "needs_review",
    });
    const failedTask = makeTask({
      id: "task-failed",
      taskNumber: 11,
      title: "Run migration",
      status: "failed",
    });
    const doneTask = makeTask({
      id: "task-done",
      taskNumber: 12,
      title: "Add markdown viewer",
      status: "done",
    });
    const runningTask = makeTask({
      id: "task-running",
      taskNumber: 13,
      title: "Build release",
      status: "running",
    });
    const tasks = [reviewTask, failedTask, doneTask, runningTask];

    const reviewHtml = renderToStaticMarkup(
      <TaskEventCard
        message={makeTaskEventMessage({
          id: "ev-1",
          relatedTaskId: reviewTask.id,
          text: "**[T10 · agent_terminal_2] Fix chat scroll** — 完了（確認待ち）",
        })}
        tasks={tasks}
        onOpenUrl={vi.fn()}
        onOpenMarkdownFile={vi.fn()}
        onOpenTask={vi.fn()}
        onUpdateTaskStatus={vi.fn()}
      />,
    );
    expect(reviewHtml).toContain('data-testid="task-event-quick-done"');
    expect(reviewHtml).not.toContain('data-testid="task-event-done-badge"');

    const failedHtml = renderToStaticMarkup(
      <TaskEventCard
        message={makeTaskEventMessage({
          id: "ev-2",
          relatedTaskId: failedTask.id,
          text: "**[T11 · agent_terminal_2] Run migration** — 失敗",
        })}
        tasks={tasks}
        onOpenUrl={vi.fn()}
        onOpenMarkdownFile={vi.fn()}
        onOpenTask={vi.fn()}
        onUpdateTaskStatus={vi.fn()}
      />,
    );
    expect(failedHtml).toContain('data-testid="task-event-quick-done"');

    const doneHtml = renderToStaticMarkup(
      <TaskEventCard
        message={makeTaskEventMessage({
          id: "ev-3",
          relatedTaskId: doneTask.id,
          text: "**[T12 · agent_terminal_2] Add markdown viewer** — 完了（確認待ち）",
        })}
        tasks={tasks}
        onOpenUrl={vi.fn()}
        onOpenMarkdownFile={vi.fn()}
        onOpenTask={vi.fn()}
        onUpdateTaskStatus={vi.fn()}
      />,
    );
    expect(doneHtml).toContain('data-testid="task-event-done-badge"');
    expect(doneHtml).toContain('data-testid="task-event-quick-reopen"');
    expect(doneHtml).not.toContain('data-testid="task-event-quick-done"');

    const runningHtml = renderToStaticMarkup(
      <TaskEventCard
        message={makeTaskEventMessage({
          id: "ev-4",
          relatedTaskId: runningTask.id,
          text: "**[T13 · agent_terminal_2] Build release** — 再起動後に自動再開しました",
        })}
        tasks={tasks}
        onOpenUrl={vi.fn()}
        onOpenMarkdownFile={vi.fn()}
        onOpenTask={vi.fn()}
        onUpdateTaskStatus={vi.fn()}
      />,
    );
    expect(runningHtml).toContain('data-testid="task-event-running-badge"');
    expect(runningHtml).not.toContain('data-testid="task-event-quick-done"');
    expect(runningHtml).not.toContain('data-testid="task-event-quick-reopen"');
  });

  it("isolates Done/Reopen clicks with stopPropagation, resolves legacy messages, and omits controls for deleted tasks", () => {
    const reviewTask = makeTask({
      id: "task-legacy-18",
      taskNumber: 18,
      title: "One-click Done in detail & chat",
      status: "needs_review",
    });
    const doneTask = makeTask({
      id: "task-done-19",
      taskNumber: 19,
      title: "Completed report task",
      status: "done",
    });
    const tasks = [reviewTask, doneTask];

    const onOpenTask = vi.fn();
    const onUpdateTaskStatus = vi.fn();

    // Legacy message without relatedTaskId resolves via [T18 · agent_terminal_2]
    const legacyEl = TaskEventCard({
      message: makeTaskEventMessage({
        id: "ev-legacy",
        text: "**[T18 · agent_terminal_2 · AGY] One-click Done in detail & chat** — 完了（確認待ち）",
      }),
      tasks,
      onOpenUrl: vi.fn(),
      onOpenMarkdownFile: vi.fn(),
      onOpenTask,
      onUpdateTaskStatus,
    });

    const doneBtn = findElementByTestId(legacyEl, "task-event-quick-done");
    expect(doneBtn).not.toBeNull();
    const stopPropDone = vi.fn();
    (doneBtn!.props.onClick as (e: { stopPropagation: () => void }) => void)({
      stopPropagation: stopPropDone,
    });
    expect(stopPropDone).toHaveBeenCalledTimes(1);
    expect(onUpdateTaskStatus).toHaveBeenCalledWith("task-legacy-18", "done");
    expect(onOpenTask).not.toHaveBeenCalled();

    // Clicking open detail button opens the resolved legacy task
    const openDetailBtn = findElementByTestId(legacyEl, "task-event-open-detail");
    expect(openDetailBtn).not.toBeNull();
    (openDetailBtn!.props.onClick as () => void)();
    expect(onOpenTask).toHaveBeenCalledWith("task-legacy-18");

    // Reopen on done task
    onOpenTask.mockClear();
    onUpdateTaskStatus.mockClear();
    const doneEl = TaskEventCard({
      message: makeTaskEventMessage({
        id: "ev-done",
        relatedTaskId: doneTask.id,
        text: "**[T19 · agent_terminal_2] Completed report task** — 完了（確認待ち）",
      }),
      tasks,
      onOpenUrl: vi.fn(),
      onOpenMarkdownFile: vi.fn(),
      onOpenTask,
      onUpdateTaskStatus,
    });
    const reopenBtn = findElementByTestId(doneEl, "task-event-quick-reopen");
    expect(reopenBtn).not.toBeNull();
    const stopPropReopen = vi.fn();
    (reopenBtn!.props.onClick as (e: { stopPropagation: () => void }) => void)({
      stopPropagation: stopPropReopen,
    });
    expect(stopPropReopen).toHaveBeenCalledTimes(1);
    expect(onUpdateTaskStatus).toHaveBeenCalledWith("task-done-19", REOPEN_TARGET_STATUS);
    expect(onOpenTask).not.toHaveBeenCalled();

    // Deleted task omits quick Done/Reopen controls cleanly
    const deletedHtml = renderToStaticMarkup(
      <TaskEventCard
        message={makeTaskEventMessage({
          id: "ev-deleted",
          relatedTaskId: "task-gone",
          text: "**[T18 · agent_terminal_2] Deleted task** — 完了（確認待ち）",
        })}
        tasks={tasks}
        onOpenUrl={vi.fn()}
        onOpenMarkdownFile={vi.fn()}
        onOpenTask={vi.fn()}
        onUpdateTaskStatus={vi.fn()}
      />,
    );
    expect(deletedHtml).not.toContain('data-testid="task-event-quick-done"');
    expect(deletedHtml).not.toContain('data-testid="task-event-quick-reopen"');
    expect(deletedHtml).not.toContain('data-testid="task-event-done-badge"');
  });

  it("wires onUpdateTaskStatus through UnifiedChat into rendered taskEvent cards", () => {
    const tasks: AgentTask[] = [
      makeTask({ id: "t-chat-1", taskNumber: 21, title: "Chat card A", status: "needs_review" }),
      makeTask({ id: "t-chat-2", taskNumber: 22, title: "Chat card B", status: "done" }),
      makeTask({ id: "t-chat-3", taskNumber: 23, title: "Chat card C", status: "running" }),
    ];
    const messages: ChatMessage[] = [
      makeTaskEventMessage({
        id: "m-a",
        relatedTaskId: "t-chat-1",
        text: "**[T21 · agent_terminal_2] Chat card A** — 完了（確認待ち）",
      }),
      makeTaskEventMessage({
        id: "m-b",
        relatedTaskId: "t-chat-2",
        text: "**[T22 · agent_terminal_2] Chat card B** — 完了（確認待ち）",
      }),
      makeTaskEventMessage({
        id: "m-c",
        relatedTaskId: "t-chat-3",
        text: "**[T23 · agent_terminal_2] Chat card C** — 再起動後に自動再開しました",
      }),
    ];

    const html = renderToStaticMarkup(
      <UnifiedChat
        snapshot={makeSnapshot(tasks, messages)}
        composerText=""
        attachments={[]}
        onComposerTextChange={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onAddAttachment={vi.fn()}
        onSend={vi.fn()}
        onStopMessage={vi.fn()}
        onStopAll={vi.fn()}
        onNewChat={vi.fn()}
        onSelectChatSession={vi.fn()}
        onDeleteChatSession={vi.fn()}
        onToggleSidebar={vi.fn()}
        onToggleBrowser={vi.fn()}
        rightPaneMode="browser"
        onToggleMarkdownViewer={vi.fn()}
        onAddProject={vi.fn()}
        onOpenUrl={vi.fn()}
        onOpenMarkdownFile={vi.fn()}
        onOpenTask={vi.fn()}
        onUpdateTaskStatus={vi.fn()}
        onToggleElementPicker={vi.fn()}
        onCaptureScreenshot={vi.fn()}
        onAttachCurrentUrl={vi.fn()}
        onAttachConsoleErrors={vi.fn()}
        onPickLocalImages={vi.fn()}
        onPasteImage={vi.fn()}
        onReconnect={vi.fn()}
        onDismissError={vi.fn()}
        onSetChatProvider={vi.fn()}
        onSetWorkerProvider={vi.fn()}
        onSetChatModel={vi.fn()}
        onSetWorkerModel={vi.fn()}
      />,
    );

    expect(html.match(/data-testid="task-event-quick-done"/g) ?? []).toHaveLength(1);
    expect(html.match(/data-testid="task-event-quick-reopen"/g) ?? []).toHaveLength(1);
    expect(html.match(/data-testid="task-event-done-badge"/g) ?? []).toHaveLength(1);
    expect(html.match(/data-testid="task-event-running-badge"/g) ?? []).toHaveLength(1);
  });
});

describe("Unlanded worktree Done guard across TaskSidebar, TaskInspectorModal, and TaskEventCard", () => {
  const unlandedTask = makeTask({
    id: "wt-ui-unlanded",
    taskNumber: 30,
    title: "Unlanded worktree task",
    status: "needs_review",
    worktreePath: "/tmp/wt/task-30",
    worktreeBranch: "conductor/task-30",
    landStatus: "unlanded",
  });

  const pushedTask = makeTask({
    id: "wt-ui-pushed",
    taskNumber: 31,
    title: "Pushed worktree task",
    status: "needs_review",
    worktreePath: "/tmp/wt/task-31",
    worktreeBranch: "conductor/task-31",
    landStatus: "pushed",
  });

  it("disables Done with tooltip and guards onClick on TaskCard for unlanded worktree tasks, while keeping Land enabled", () => {
    const onUpdateStatus = vi.fn();
    const onLand = vi.fn();

    const unlandedHtml = renderToStaticMarkup(
      <TaskCard
        task={unlandedTask}
        colorHex="#3B82F6"
        isSelected={false}
        onSelect={vi.fn()}
        onOpenPreview={vi.fn()}
        onMention={vi.fn()}
        onUpdateStatus={onUpdateStatus}
        onStop={vi.fn()}
        onDelete={vi.fn()}
        onLand={onLand}
      />,
    );
    expect(unlandedHtml).toContain('data-testid="task-unlanded-badge"');
    expect(unlandedHtml).toContain("未Land");
    expect(unlandedHtml).toContain('data-testid="task-quick-land"');
    expect(unlandedHtml).toContain(UNLANDED_TASK_DONE_BLOCKED_REASON);

    const cardEl = TaskCard({
      task: unlandedTask,
      colorHex: "#3B82F6",
      isSelected: false,
      onSelect: vi.fn(),
      onOpenPreview: vi.fn(),
      onMention: vi.fn(),
      onUpdateStatus,
      onStop: vi.fn(),
      onDelete: vi.fn(),
      onLand,
    });
    const doneBtn = findElementByTestId(cardEl, "task-quick-done");
    expect(doneBtn).not.toBeNull();
    expect(doneBtn!.props.disabled).toBe(true);
    expect(doneBtn!.props.title).toBe(UNLANDED_TASK_DONE_BLOCKED_REASON);

    const stopProp = vi.fn();
    (doneBtn!.props.onClick as (e: { stopPropagation: () => void }) => void)({
      stopPropagation: stopProp,
    });
    expect(stopProp).toHaveBeenCalledTimes(1);
    expect(onUpdateStatus).not.toHaveBeenCalled();

    // Once pushed/landed, Done unlocks
    const pushedCardEl = TaskCard({
      task: pushedTask,
      colorHex: "#3B82F6",
      isSelected: false,
      onSelect: vi.fn(),
      onOpenPreview: vi.fn(),
      onMention: vi.fn(),
      onUpdateStatus,
      onStop: vi.fn(),
      onDelete: vi.fn(),
      onLand,
    });
    const unlockedDoneBtn = findElementByTestId(pushedCardEl, "task-quick-done");
    expect(unlockedDoneBtn).not.toBeNull();
    expect(unlockedDoneBtn!.props.disabled).toBe(false);
    (unlockedDoneBtn!.props.onClick as (e: { stopPropagation: () => void }) => void)({
      stopPropagation: vi.fn(),
    });
    expect(onUpdateStatus).toHaveBeenCalledWith("done");
  });

  it("blocks Done button and Done select option in TaskInspectorModal for unlanded worktree tasks", () => {
    const onUpdateStatus = vi.fn();

    const modalHtml = renderToStaticMarkup(
      <TaskInspectorModal
        task={unlandedTask}
        project={SAMPLE_PROJECTS[0]}
        projectColorHex="#3B82F6"
        onClose={vi.fn()}
        onUpdateStatus={onUpdateStatus}
        onOpenPreviewUrl={vi.fn()}
        onMentionInChat={vi.fn()}
        onStopWorker={vi.fn()}
        onDelete={vi.fn()}
        onLandTask={vi.fn()}
      />,
    );
    expect(modalHtml).toContain('data-testid="inspector-unlanded-badge"');
    expect(modalHtml).toContain(UNLANDED_TASK_DONE_BLOCKED_REASON);
    expect(modalHtml).toMatch(/<option value="done"[^>]*disabled=""/);

    // Quick Done button disabled & guarded
    const quickDoneBtn = findElementByTestId(
      TaskInspectorQuickStatusButton({
        task: unlandedTask,
        onUpdateStatus,
      }),
      "inspector-quick-done",
    );
    expect(quickDoneBtn).not.toBeNull();
    expect(quickDoneBtn!.props.disabled).toBe(true);
    expect(quickDoneBtn!.props.title).toBe(UNLANDED_TASK_DONE_BLOCKED_REASON);
    (quickDoneBtn!.props.onClick as (e: { stopPropagation: () => void }) => void)({
      stopPropagation: vi.fn(),
    });
    expect(onUpdateStatus).not.toHaveBeenCalled();

    // Status select blocks "done" while allowing other transitions like "failed"
    const selectEl = findElementByTestId(
      TaskStatusSelect({
        status: unlandedTask.status,
        worktreePath: unlandedTask.worktreePath,
        worktreeBranch: unlandedTask.worktreeBranch,
        landStatus: unlandedTask.landStatus,
        onUpdateStatus,
      }),
      "inspector-status-select",
    );
    expect(selectEl).not.toBeNull();
    expect(selectEl!.props.title).toBe(UNLANDED_TASK_DONE_BLOCKED_REASON);
    const onChange = selectEl!.props.onChange as (e: { target: { value: string } }) => void;
    onChange({ target: { value: "done" } });
    expect(onUpdateStatus).not.toHaveBeenCalled();

    onChange({ target: { value: "failed" } });
    expect(onUpdateStatus).toHaveBeenCalledWith("failed");

    // Once pushed, both quick Done and select Done unlock
    onUpdateStatus.mockClear();
    const pushedQuickDone = findElementByTestId(
      TaskInspectorQuickStatusButton({
        task: pushedTask,
        onUpdateStatus,
      }),
      "inspector-quick-done",
    );
    expect(pushedQuickDone!.props.disabled).toBe(false);
    (pushedQuickDone!.props.onClick as (e: { stopPropagation: () => void }) => void)({
      stopPropagation: vi.fn(),
    });
    expect(onUpdateStatus).toHaveBeenCalledWith("done");
  });

  it("blocks Done and surfaces 未Land + Land button on UnifiedChat TaskEventCard for unlanded worktree tasks", () => {
    const onUpdateTaskStatus = vi.fn();
    const onLandTask = vi.fn();

    const msg = makeTaskEventMessage({
      id: "ev-wt-30",
      relatedTaskId: unlandedTask.id,
      text: "**[T30 · agent_terminal_2] Unlanded worktree task** — 完了（確認待ち）",
    });

    const html = renderToStaticMarkup(
      <TaskEventCard
        message={msg}
        tasks={[unlandedTask]}
        projects={SAMPLE_PROJECTS}
        onOpenUrl={vi.fn()}
        onOpenMarkdownFile={vi.fn()}
        onOpenTask={vi.fn()}
        onUpdateTaskStatus={onUpdateTaskStatus}
        onLandTask={onLandTask}
      />,
    );
    expect(html).toContain('data-testid="task-event-unlanded-badge"');
    expect(html).toContain("未Land");
    expect(html).toContain('data-testid="task-event-quick-land"');
    expect(html).toContain(UNLANDED_TASK_DONE_BLOCKED_REASON);

    const cardEl = TaskEventCard({
      message: msg,
      tasks: [unlandedTask],
      projects: SAMPLE_PROJECTS,
      onOpenUrl: vi.fn(),
      onOpenMarkdownFile: vi.fn(),
      onOpenTask: vi.fn(),
      onUpdateTaskStatus,
      onLandTask,
    });

    const doneBtn = findElementByTestId(cardEl, "task-event-quick-done");
    expect(doneBtn).not.toBeNull();
    expect(doneBtn!.props.disabled).toBe(true);
    expect(doneBtn!.props.title).toBe(UNLANDED_TASK_DONE_BLOCKED_REASON);
    (doneBtn!.props.onClick as (e: { stopPropagation: () => void }) => void)({
      stopPropagation: vi.fn(),
    });
    expect(onUpdateTaskStatus).not.toHaveBeenCalled();

    // Clicking Land triggers onLandTask with stopPropagation
    const landBtn = findElementByTestId(cardEl, "task-event-quick-land");
    expect(landBtn).not.toBeNull();
    const stopPropLand = vi.fn();
    (landBtn!.props.onClick as (e: { stopPropagation: () => void }) => void)({
      stopPropagation: stopPropLand,
    });
    expect(stopPropLand).toHaveBeenCalledTimes(1);
    expect(onLandTask).toHaveBeenCalledWith(unlandedTask.id, undefined);

    // Pushed worktree task unlocks Done on TaskEventCard
    const pushedMsg = makeTaskEventMessage({
      id: "ev-wt-31",
      relatedTaskId: pushedTask.id,
      text: "**[T31 · agent_terminal_2] Pushed worktree task** — 完了（確認待ち）",
    });
    const pushedEl = TaskEventCard({
      message: pushedMsg,
      tasks: [pushedTask],
      projects: SAMPLE_PROJECTS,
      onOpenUrl: vi.fn(),
      onOpenMarkdownFile: vi.fn(),
      onOpenTask: vi.fn(),
      onUpdateTaskStatus,
      onLandTask,
    });
    const unlockedDoneBtn = findElementByTestId(pushedEl, "task-event-quick-done");
    expect(unlockedDoneBtn).not.toBeNull();
    expect(unlockedDoneBtn!.props.disabled).toBe(false);
    (unlockedDoneBtn!.props.onClick as (e: { stopPropagation: () => void }) => void)({
      stopPropagation: vi.fn(),
    });
    expect(onUpdateTaskStatus).toHaveBeenCalledWith(pushedTask.id, "done");
  });
});
