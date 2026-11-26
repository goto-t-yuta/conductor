import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentTask, AppSnapshot, ChatMessage, Project } from "../src/shared/types.js";
import {
  detectActiveMention,
  getMentionSuggestions,
  parseAndResolveMentions,
} from "../src/shared/mentions.js";
import {
  COMPOSER_TEXTAREA_MAX_HEIGHT,
  COMPOSER_TEXTAREA_MIN_HEIGHT,
  MENTION_POPOVER_INITIAL_LIMIT,
  areActiveMentionQueriesEqual,
  areMentionTaskMetadataEqual,
  clampComposerTextareaHeight,
  computeMentionPopoverVisibleCount,
  planComposerTextareaResize,
  stabilizeMentionTasks,
} from "../src/renderer/lib/composer-perf.js";
import { ChatComposer } from "../src/renderer/components/ChatComposer.js";
import { ChatSessionControls } from "../src/renderer/components/ChatHistoryMenu.js";
import { MentionPopover } from "../src/renderer/components/MentionPopover.js";
import { TerminalPane } from "../src/renderer/components/TerminalPane.js";
import { TaskEventCard, UnifiedChat } from "../src/renderer/components/UnifiedChat.js";

function makeProject(i: number): Project {
  return {
    id: `proj-${i}`,
    name: `project_${String(i).padStart(3, "0")}`,
    path: `/Users/dev/repos/project_${String(i).padStart(3, "0")}`,
    colorHex: "#6366F1",
    gitBranch: "main",
    addedAt: "2026-11-20T00:00:00.000Z",
  };
}

function makeTask(i: number, overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: `task-${i}`,
    taskNumber: i,
    title: `Task number ${i} implementation`,
    summary: "",
    projectId: `proj-${(i % 20) + 1}`,
    projectName: `project_${String((i % 20) + 1).padStart(3, "0")}`,
    projectPath: `/Users/dev/repos/project_${String((i % 20) + 1).padStart(3, "0")}`,
    status: i % 5 === 0 ? "running" : "done",
    currentStep: null,
    workerThreadId: null,
    activeTurnId: null,
    previewURL: null,
    latestOutput: "",
    activities: [],
    createdAt: "2026-11-20T00:00:00.000Z",
    updatedAt: "2026-11-20T00:00:00.000Z",
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    projects: [makeProject(1)],
    scanRoots: [],
    tasks: [makeTask(1)],
    messages: [],
    activeChatSessionId: "sess-1",
    chatSessions: [
      {
        id: "sess-1",
        title: "Perf Test Chat",
        preview: "",
        messageCount: 0,
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
      agy: { id: "agy", label: "AGY", available: false, detail: "", models: [] },
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
    ...overrides,
  };
}

describe("planComposerTextareaResize (reflow avoidance)", () => {
  it("skips work when empty and already at minHeight, and sets min without measuring when cleared from taller state", () => {
    expect(
      planComposerTextareaResize({
        nextText: "",
        prevText: "",
        currentHeight: COMPOSER_TEXTAREA_MIN_HEIGHT,
        clientWidth: 640,
        prevClientWidth: 640,
      }),
    ).toBe("skip");

    expect(
      planComposerTextareaResize({
        nextText: "",
        prevText: "line1\nline2\nline3",
        currentHeight: 96,
        clientWidth: 640,
        prevClientWidth: 640,
      }),
    ).toBe("set_min");
  });

  it("uses measure_grow (no height='auto' reset) during normal forward typing and skips once clamped at maxHeight", () => {
    expect(
      planComposerTextareaResize({
        nextText: "こんにちは",
        prevText: "こんにち",
        currentHeight: COMPOSER_TEXTAREA_MIN_HEIGHT,
        clientWidth: 640,
        prevClientWidth: 640,
      }),
    ).toBe("measure_grow");

    expect(
      planComposerTextareaResize({
        nextText: "line1\nline2\nline3\nline4\nline5\nline6\nmore",
        prevText: "line1\nline2\nline3\nline4\nline5\nline6\nmor",
        currentHeight: COMPOSER_TEXTAREA_MAX_HEIGHT,
        clientWidth: 640,
        prevClientWidth: 640,
      }),
    ).toBe("skip");
  });

  it("skips shrinking when already at minHeight and performs full measurement when shrinking from multi-line or width changes", () => {
    expect(
      planComposerTextareaResize({
        nextText: "hell",
        prevText: "hello",
        currentHeight: COMPOSER_TEXTAREA_MIN_HEIGHT,
        clientWidth: 640,
        prevClientWidth: 640,
      }),
    ).toBe("skip");

    expect(
      planComposerTextareaResize({
        nextText: "line1",
        prevText: "line1\nline2",
        currentHeight: 72,
        clientWidth: 640,
        prevClientWidth: 640,
      }),
    ).toBe("measure_full");

    expect(
      planComposerTextareaResize({
        nextText: "hello world",
        prevText: "hello",
        currentHeight: 44,
        clientWidth: 500,
        prevClientWidth: 640,
      }),
    ).toBe("measure_full");

    expect(clampComposerTextareaHeight(20)).toBe(COMPOSER_TEXTAREA_MIN_HEIGHT);
    expect(clampComposerTextareaHeight(92.2)).toBe(93);
    expect(clampComposerTextareaHeight(500)).toBe(COMPOSER_TEXTAREA_MAX_HEIGHT);
  });
});

describe("areActiveMentionQueriesEqual", () => {
  it("treats identical mention queries and null pairs as equal to prevent redundant state updates", () => {
    expect(areActiveMentionQueriesEqual(null, null)).toBe(true);
    const q1 = detectActiveMention("hello @proj", 11);
    const q2 = detectActiveMention("hello @proj", 11);
    const q3 = detectActiveMention("hello @proje", 12);
    expect(areActiveMentionQueriesEqual(q1, q2)).toBe(true);
    expect(areActiveMentionQueriesEqual(q1, q3)).toBe(false);
    expect(areActiveMentionQueriesEqual(q1, null)).toBe(false);
  });
});

describe("stabilizeMentionTasks (background worker tick isolation)", () => {
  it("preserves array identity when only worker logs, currentStep, latestOutput, or updatedAt change", () => {
    const initial = [
      makeTask(1, { status: "running", currentStep: "Reading files" }),
      makeTask(2, { status: "done" }),
    ];

    const afterWorkerTick = [
      {
        ...initial[0],
        currentStep: "Running pnpm test",
        latestOutput: "450 tests passed...",
        updatedAt: "2026-11-26T12:00:05.000Z",
        activities: [
          {
            id: "act-1",
            kind: "command" as const,
            title: "pnpm test",
            detail: "running",
            timestamp: "2026-11-26T12:00:05.000Z",
          },
        ],
      },
      initial[1],
    ];

    expect(areMentionTaskMetadataEqual(initial, afterWorkerTick)).toBe(true);
    expect(stabilizeMentionTasks(initial, afterWorkerTick)).toBe(initial);
  });

  it("returns the new array when mention-visible task metadata changes", () => {
    const initial = [makeTask(1, { status: "running", title: "Old title" })];
    const statusChanged = [{ ...initial[0], status: "needs_review" as const }];
    const titleChanged = [{ ...initial[0], title: "New title" }];

    expect(stabilizeMentionTasks(initial, statusChanged)).toBe(statusChanged);
    expect(stabilizeMentionTasks(initial, titleChanged)).toBe(titleChanged);
  });
});

describe("Mention autocomplete scaling & MentionPopover DOM capping", () => {
  it("handles 120 projects and 120 tasks accurately with indexed lookup and caps initial DOM options", () => {
    const projects = Array.from({ length: 120 }, (_, i) => makeProject(i + 1));
    const tasks = Array.from({ length: 120 }, (_, i) => makeTask(i + 1));

    // Fast path for non-mention text
    const emptyParsed = parseAndResolveMentions("通常のメッセージ入力テスト", projects, tasks);
    expect(emptyParsed.mentions).toEqual([]);

    const query = detectActiveMention("@", 1)!;
    const { suggestions, scopedProject } = getMentionSuggestions(query, projects, tasks);
    expect(scopedProject).toBeNull();
    expect(suggestions).toHaveLength(240);

    // MentionPopover caps initial mounted option elements while showing total match count in header
    const html = renderToStaticMarkup(
      <MentionPopover
        query={query}
        suggestions={suggestions}
        scopedProject={null}
        activeIndex={0}
        onHoverIndex={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    const renderedOptions = html.match(/role="option"/g) ?? [];
    expect(renderedOptions).toHaveLength(MENTION_POPOVER_INITIAL_LIMIT);
    expect(html).toContain(">240<");
    expect(html).toContain('data-testid="mention-popover-load-more"');
    expect(html).toContain(`+${240 - MENTION_POPOVER_INITIAL_LIMIT}`);

    // Keyboard navigation beyond initial limit automatically expands visible window
    expect(computeMentionPopoverVisibleCount(240, 45, MENTION_POPOVER_INITIAL_LIMIT)).toBe(80);
    expect(computeMentionPopoverVisibleCount(240, 10, MENTION_POPOVER_INITIAL_LIMIT)).toBe(40);
  });
});

describe("Memoization boundaries & uncontrolled ChatComposer isolation", () => {
  const REACT_MEMO_TYPE = Symbol.for("react.memo");

  it("wraps key chat and pane components in React.memo", () => {
    expect((UnifiedChat as unknown as { $$typeof?: symbol }).$$typeof).toBe(REACT_MEMO_TYPE);
    expect((ChatComposer as unknown as { $$typeof?: symbol }).$$typeof).toBe(REACT_MEMO_TYPE);
    expect((ChatSessionControls as unknown as { $$typeof?: symbol }).$$typeof).toBe(REACT_MEMO_TYPE);
    expect((MentionPopover as unknown as { $$typeof?: symbol }).$$typeof).toBe(REACT_MEMO_TYPE);
    expect((TerminalPane as unknown as { $$typeof?: symbol }).$$typeof).toBe(REACT_MEMO_TYPE);
  });

  it("renders UnifiedChat cleanly in uncontrolled composer mode (App production path)", () => {
    const html = renderToStaticMarkup(
      <UnifiedChat
        snapshot={makeSnapshot()}
        attachments={[]}
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
        onToggleMarkdownViewer={vi.fn()}
        onAddProject={vi.fn()}
        onOpenUrl={vi.fn()}
        onOpenMarkdownFile={vi.fn()}
        onOpenTask={vi.fn()}
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

    expect(html).toContain("<textarea");
    expect(html).toContain('data-testid="chat-header"');
    expect(html).toContain('data-testid="composer-toolbar"');
  });

  it("supports pre-resolved task & project on TaskEventCard so unrelated task updates do not bust memoization", () => {
    const task = makeTask(42, { status: "needs_review", title: "Isolated task event" });
    const project = makeProject(1);
    const msg: ChatMessage = {
      id: "ev-42",
      role: "taskEvent",
      relatedTaskId: task.id,
      text: "Completed **T42** successfully.",
      attachments: [],
      toolChips: [],
      isStreaming: false,
      createdAt: "2026-11-26T00:00:00.000Z",
    };

    const html = renderToStaticMarkup(
      <TaskEventCard
        message={msg}
        tasks={[]}
        projects={[]}
        resolvedTask={task}
        resolvedProject={project}
        onOpenUrl={vi.fn()}
        onOpenMarkdownFile={vi.fn()}
        onOpenTask={vi.fn()}
        onUpdateTaskStatus={vi.fn()}
      />,
    );

    expect(html).toContain("T42");
    expect(html).toContain("Isolated task event");
    expect(html).toContain('data-testid="task-event-quick-done"');
  });
});
