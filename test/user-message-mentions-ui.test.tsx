import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { BrowserManager } from "../src/main/browser-manager.js";
import { ConductorController } from "../src/main/conductor-controller.js";
import { StateStore } from "../src/main/state-store.js";
import type {
  AgentTask,
  AppSnapshot,
  ChatMessage,
  ExplicitMentionTarget,
  Project,
} from "../src/shared/types.js";
import {
  addExplicitMentionTarget,
  detectActiveMention,
  getMentionSuggestions,
  removeActiveMentionQuery,
  resolveMessageMentionBadges,
  suggestionToExplicitMentionTarget,
} from "../src/shared/mentions.js";
import {
  UserMessageMentionBadges,
  formatMentionBadgeTooltip,
} from "../src/renderer/components/MentionBadges.js";
import { UnifiedChat } from "../src/renderer/components/UnifiedChat.js";

const SAMPLE_PROJECTS: Project[] = [
  {
    id: "proj-1",
    name: "agent_terminal_2",
    path: "/Users/dev/Documents/agent_terminal_2",
    colorHex: "#3B82F6",
    gitBranch: "main",
    addedAt: "2026-11-20T00:00:00.000Z",
  },
  {
    id: "proj-2",
    name: "web_dashboard",
    path: "/Users/dev/Documents/web_dashboard",
    colorHex: "#10B981",
    gitBranch: "dev",
    addedAt: "2026-11-20T00:00:00.000Z",
  },
];

const SAMPLE_TASKS: AgentTask[] = [
  {
    id: "task-6",
    taskNumber: 6,
    title: "Tab補完でプロジェクト名とタスク名を表示する非常に長いタイトルの確認",
    summary: "",
    projectId: "proj-1",
    projectName: "agent_terminal_2",
    projectPath: "/Users/dev/Documents/agent_terminal_2",
    status: "running",
    currentStep: null,
    workerThreadId: null,
    activeTurnId: null,
    previewURL: null,
    latestOutput: "",
    activities: [],
    createdAt: "2026-11-25T00:00:00.000Z",
    updatedAt: "2026-11-25T00:00:00.000Z",
  },
];

function makeSnapshot(messages: ChatMessage[]): AppSnapshot {
  return {
    projects: SAMPLE_PROJECTS,
    scanRoots: [],
    tasks: SAMPLE_TASKS,
    messages,
    activeChatSessionId: "sess-1",
    chatSessions: [
      {
        id: "sess-1",
        title: "Test Chat",
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
  };
}

function renderUnifiedChat(messages: ChatMessage[], snapshotOverride?: AppSnapshot): string {
  return renderToStaticMarkup(
    <UnifiedChat
      snapshot={snapshotOverride ?? makeSnapshot(messages)}
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
      onOpenImageAttachment={vi.fn()}
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
}

describe("User message mention badges UI", () => {
  it("renders clickable task badge with code, project name, truncated title, and full tooltip", () => {
    const badges = resolveMessageMentionBadges(
      "@T6 と @web_dashboard を確認して",
      SAMPLE_PROJECTS,
      SAMPLE_TASKS,
    );
    const html = renderToStaticMarkup(
      <UserMessageMentionBadges badges={badges} onOpenTask={vi.fn()} />,
    );

    expect(html).toContain('data-testid="user-message-mention-badge"');
    expect(html).toContain('data-mention-kind="task"');
    expect(html).toContain('data-task-code="T6"');
    expect(html).toContain("<button");
    expect(html).toContain("T6");
    expect(html).toContain("agent_terminal_2");
    expect(html).toContain("Tab補完でプロジェクト名とタスク名を表示する非常に長いタイトルの確認");
    expect(html).toContain(`title="${formatMentionBadgeTooltip(badges[0]!)}"`);

    expect(html).toContain('data-mention-kind="project"');
    expect(html).toContain('data-project-name="web_dashboard"');
    expect(html).toContain("web_dashboard");
    expect(html).toContain("/Users/dev/Documents/web_dashboard");
  });

  it("renders deleted snapshotted task badge as non-button div while preserving metadata", () => {
    const badges = resolveMessageMentionBadges("@T4 を確認", SAMPLE_PROJECTS, SAMPLE_TASKS, [
      {
        kind: "task",
        taskId: "deleted-task-4",
        taskNumber: 4,
        taskTitle: "Archived feature work",
        projectId: "proj-1",
        projectName: "agent_terminal_2",
        projectPath: "/Users/dev/Documents/agent_terminal_2",
        projectColorHex: "#3B82F6",
      },
    ]);

    const html = renderToStaticMarkup(
      <UserMessageMentionBadges badges={badges} onOpenTask={vi.fn()} />,
    );

    expect(html).toContain('data-task-code="T4"');
    expect(html).toContain("Archived feature work");
    expect(html).toContain("agent_terminal_2");
    expect(html).not.toContain("<button");
  });

  it("renders deduplicated mention badges above posted user bubbles alongside attachments and keeps inline highlight", () => {
    const messages: ChatMessage[] = [
      {
        id: "msg-user-1",
        role: "user",
        text: "tab押したときに @T6 と @agent_terminal_2/T6 と @web_dashboard を確認して",
        attachments: [
          {
            id: "att-1",
            kind: "image",
            label: "Pasted Image",
            imageDataUrl: "data:image/png;base64,AAAA",
          },
        ],
        toolChips: [],
        isStreaming: false,
        createdAt: "2026-11-26T01:00:00.000Z",
      },
      {
        id: "msg-assistant-1",
        role: "assistant",
        text: "@T6 と @web_dashboard を確認しました。",
        attachments: [],
        toolChips: [],
        isStreaming: false,
        createdAt: "2026-11-26T01:00:05.000Z",
      },
    ];

    const html = renderUnifiedChat(messages);

    // Above-bubble chip row contains both mention badges and attachment pill
    expect(html).toContain('data-testid="user-message-meta-chips"');
    expect(html).toContain("Pasted Image");

    // Deduplicated: only 1 task badge for T6 + 1 project badge for web_dashboard (none on assistant msg)
    const badgeMatches = html.match(/data-testid="user-message-mention-badge"/g) ?? [];
    expect(badgeMatches).toHaveLength(2);
    expect(html).toContain('data-task-code="T6"');
    expect(html).toContain('data-project-name="web_dashboard"');

    // Inline @T6 highlight inside the user bubble remains intact
    expect(html).toContain(">@T6</button>");
    expect(html).toContain(">@agent_terminal_2/T6</button>");
  });

  it("omits above-bubble meta chip container when user message has no mentions or attachments", () => {
    const messages: ChatMessage[] = [
      {
        id: "msg-plain",
        role: "user",
        text: "普通の質問です",
        attachments: [],
        toolChips: [],
        isStreaming: false,
        createdAt: "2026-11-26T01:00:00.000Z",
      },
    ];

    const html = renderUnifiedChat(messages);
    expect(html).not.toContain('data-testid="user-message-meta-chips"');
    expect(html).not.toContain('data-testid="user-message-mention-badge"');
  });

  it("renders persisted mention badges above a clean posted user message body with no raw @xxx tokens", () => {
    const messages: ChatMessage[] = [
      {
        id: "msg-clean-chips",
        role: "user",
        text: "テストが通るか確認して",
        attachments: [],
        mentions: [
          {
            kind: "task",
            taskId: "task-6",
            taskNumber: 6,
            taskTitle: "Tab補完でプロジェクト名とタスク名を表示する非常に長いタイトルの確認",
            taskStatus: "running",
            projectId: "proj-1",
            projectName: "agent_terminal_2",
            projectPath: "/Users/dev/Documents/agent_terminal_2",
            projectColorHex: "#3B82F6",
          },
          {
            kind: "project",
            projectId: "proj-2",
            projectName: "web_dashboard",
            projectPath: "/Users/dev/Documents/web_dashboard",
            projectColorHex: "#10B981",
          },
        ],
        toolChips: [],
        isStreaming: false,
        createdAt: "2026-11-26T02:00:00.000Z",
      },
    ];

    const html = renderUnifiedChat(messages);

    // Above-bubble badges render for both task and project
    expect(html).toContain('data-testid="user-message-meta-chips"');
    const badgeMatches = html.match(/data-testid="user-message-mention-badge"/g) ?? [];
    expect(badgeMatches).toHaveLength(2);
    expect(html).toContain('data-task-code="T6"');
    expect(html).toContain('data-project-name="web_dashboard"');

    // Posted bubble text stays clean without raw @xxx tokens
    expect(html).toContain("テストが通るか確認して");
    expect(html).not.toContain("@T6");
    expect(html).not.toContain("@web_dashboard");
    expect(html).not.toContain("@agent_terminal_2");
  });

  it("retains structured mention chips end-to-end from @xxx composer selection through sendMessage, immediate snapshot broadcast, and reload restore", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-e2e-mention-badges-"));
    try {
      const store = new StateStore(tmpDir);
      const initial = store.load();
      store.save({
        ...initial,
        projects: SAMPLE_PROJECTS,
        tasks: SAMPLE_TASKS,
        nextTaskNumber: 7,
      });

      const fakeBrowser = {
        getTabs: () => [],
        getActiveTabId: () => null,
        getActiveTab: () => null,
        isPickingElement: () => false,
        restore: () => {},
      } as unknown as BrowserManager;

      const broadcastedSnapshots: AppSnapshot[] = [];
      const controller = new ConductorController({
        store,
        browser: fakeBrowser,
        onSnapshot: (snap) => broadcastedSnapshots.push(snap),
      });
      (
        controller as unknown as {
          dispatchParallelResponderTurn: () => Promise<void>;
        }
      ).dispatchParallelResponderTurn = async () => {};

      // 1. Simulate selecting `@web_dashboard` and `@T6` in the composer (stripping @xxx from text)
      let composerText = "@web_dashboard";
      let selectedMentions: ExplicitMentionTarget[] = [];

      const qProj = detectActiveMention(composerText, composerText.length)!;
      const projSuggestion = getMentionSuggestions(
        qProj,
        SAMPLE_PROJECTS,
        SAMPLE_TASKS,
      ).suggestions.find((s) => s.kind === "project" && s.project.id === "proj-2")!;
      selectedMentions = addExplicitMentionTarget(
        selectedMentions,
        suggestionToExplicitMentionTarget(projSuggestion),
      );
      composerText = removeActiveMentionQuery(composerText, qProj).nextText;
      expect(composerText).toBe("");

      composerText = "@T6";
      const qTask = detectActiveMention(composerText, composerText.length)!;
      const taskSuggestion = getMentionSuggestions(
        qTask,
        SAMPLE_PROJECTS,
        SAMPLE_TASKS,
      ).suggestions.find((s) => s.kind === "task" && s.task.id === "task-6")!;
      selectedMentions = addExplicitMentionTarget(
        selectedMentions,
        suggestionToExplicitMentionTarget(taskSuggestion),
      );
      composerText = removeActiveMentionQuery(composerText, qTask).nextText;
      expect(composerText).toBe("");

      // User writes clean prompt text without any @xxx tokens and sends
      const cleanMessageText = "このバグの原因を調べて修正して";
      const capturedMentions = [...selectedMentions];
      // Simulate composer clearing chips on send after capturing payload
      selectedMentions = [];
      expect(selectedMentions).toEqual([]);

      await controller.sendMessage({
        text: cleanMessageText,
        attachments: [],
        mentions: capturedMentions,
      });

      // 2. Immediate snapshot broadcast retains mentions on ChatMessage & renders badges above user bubble
      expect(broadcastedSnapshots.length).toBeGreaterThan(0);
      const immediateSnapshot = broadcastedSnapshots[broadcastedSnapshots.length - 1]!;
      const postedUserMsg = immediateSnapshot.messages.find((m) => m.role === "user");
      expect(postedUserMsg?.text).toBe(cleanMessageText);
      expect(postedUserMsg?.text).not.toContain("@");
      expect(postedUserMsg?.mentions).toHaveLength(2);

      const immediateHtml = renderUnifiedChat(immediateSnapshot.messages, immediateSnapshot);
      expect(immediateHtml).toContain('data-testid="user-message-meta-chips"');
      expect((immediateHtml.match(/data-testid="user-message-mention-badge"/g) ?? []).length).toBe(2);
      expect(immediateHtml).toContain('data-project-name="web_dashboard"');
      expect(immediateHtml).toContain('data-task-code="T6"');
      expect(immediateHtml).toContain(cleanMessageText);

      // Verify badges appear before the user bubble text in DOM order
      const metaIdx = immediateHtml.indexOf('data-testid="user-message-meta-chips"');
      const bodyIdx = immediateHtml.indexOf(cleanMessageText);
      expect(metaIdx).toBeGreaterThan(-1);
      expect(bodyIdx).toBeGreaterThan(metaIdx);

      // 3. Reload / session restore from StateStore still renders both badges above the posted bubble
      const restoredController = new ConductorController({
        store: new StateStore(tmpDir),
        browser: fakeBrowser,
        onSnapshot: () => {},
      });
      const restoredSnapshot = restoredController.getSnapshot();
      const restoredUserMsg = restoredSnapshot.messages.find((m) => m.role === "user");
      expect(restoredUserMsg?.mentions).toHaveLength(2);

      const restoredHtml = renderUnifiedChat(restoredSnapshot.messages, restoredSnapshot);
      expect(restoredHtml).toContain('data-testid="user-message-meta-chips"');
      expect((restoredHtml.match(/data-testid="user-message-mention-badge"/g) ?? []).length).toBe(2);
      expect(restoredHtml).toContain('data-project-name="web_dashboard"');
      expect(restoredHtml).toContain('data-task-code="T6"');
      expect(restoredHtml).toContain(cleanMessageText);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
