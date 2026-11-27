import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserManager } from "../src/main/browser-manager.js";
import type { CliTurnCallbacks, RunningCliTurn } from "../src/main/cli-agent-runner.js";
import { ConductorController } from "../src/main/conductor-controller.js";
import { type MCPToolResult } from "../src/main/local-mcp-server.js";
import { StateStore } from "../src/main/state-store.js";
import { ChatSessionControls, formatRelativeSessionTime } from "../src/renderer/components/ChatHistoryMenu.js";
import { InAppBrowserPane } from "../src/renderer/components/InAppBrowserPane.js";
import { MentionPopover } from "../src/renderer/components/MentionPopover.js";
import { RightPaneProjectSwitcher } from "../src/renderer/components/RightPaneProjectSwitcher.js";
import { SettingsModal } from "../src/renderer/components/SettingsModal.js";
import { TaskInspectorModal } from "../src/renderer/components/TaskInspectorModal.js";
import { TaskSidebar } from "../src/renderer/components/TaskSidebar.js";
import { TerminalPane } from "../src/renderer/components/TerminalPane.js";
import { TaskEventCard, UnifiedChat } from "../src/renderer/components/UnifiedChat.js";
import { UnifiedRightPane } from "../src/renderer/components/UnifiedRightPane.js";
import { deriveQuestionItems } from "../src/renderer/lib/questions.js";
import {
  makeBrowserUnifiedTabId,
  makeMarkdownUnifiedTabId,
  type ProjectSwitcherItem,
  type UnifiedRightPaneTab,
} from "../src/renderer/lib/right-pane-tabs.js";
import {
  detectSystemLocale,
  formatTaskStatusLabel,
  getFriendlyToolLabel,
  getLocalizedIntegrationModeMeta,
  getLocalizedLanguageOptionMeta,
  resolveUiLocale,
  t,
} from "../src/shared/i18n.js";
import type { AgentTask, AppSnapshot, BrowserTab, ChatMessage, Project } from "../src/shared/types.js";

const JAPANESE_CHAR_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const SAMPLE_PROJECT: Project = {
  id: "proj-acme",
  name: "acme-web",
  path: "/workspace/acme-web",
  colorHex: "#3B82F6",
  gitBranch: "main",
  addedAt: "2026-11-26T00:00:00.000Z",
};

const SAMPLE_TASK: AgentTask = {
  id: "task-3",
  taskNumber: 3,
  title: "Build real-time analytics overview dashboard",
  summary: "Created KPI cards, traffic chart, and deployment status table.",
  projectId: SAMPLE_PROJECT.id,
  projectName: SAMPLE_PROJECT.name,
  projectPath: SAMPLE_PROJECT.path,
  status: "needs_review",
  provider: "agy",
  currentStep: "Auto-landed on conductor/t3-analytics-ui",
  workerThreadId: null,
  activeTurnId: null,
  previewURL: "http://localhost:5173/analytics",
  latestOutput: "### Summary\n\n- Built `AnalyticsOverview.tsx` with KPI cards.",
  activities: [
    {
      id: "act-1",
      kind: "command",
      title: "pnpm test",
      detail: "42/42 tests passed",
      timestamp: "2026-11-26T02:00:00.000Z",
    },
  ],
  worktreePath: "/workspace/.conductor/worktrees/t3-analytics-ui",
  worktreeBranch: "conductor/t3-analytics-ui",
  landStatus: "landed",
  landedBranch: "conductor/t3-analytics-ui",
  landedCommit: "4c8e91d2",
  createdAt: "2026-11-26T01:00:00.000Z",
  updatedAt: "2026-11-26T02:00:00.000Z",
};

const SAMPLE_BROWSER_TAB: BrowserTab = {
  id: "bt-1",
  title: "Acme Analytics",
  url: "http://localhost:5173/analytics",
  projectId: SAMPLE_PROJECT.id,
  isLoading: false,
  canGoBack: true,
  canGoForward: false,
  consoleErrorCount: 0,
  networkErrorCount: 0,
};

function makeEnSnapshot(messages: ChatMessage[] = []): AppSnapshot {
  return {
    projects: [SAMPLE_PROJECT],
    scanRoots: [],
    tasks: [SAMPLE_TASK],
    messages,
    activeChatSessionId: "sess-1",
    chatSessions: [
      {
        id: "sess-1",
        title: "Analytics Dashboard",
        preview: "Checked T4 via read-only inspection",
        messageCount: messages.length,
        createdAt: "2026-11-26T00:00:00.000Z",
        updatedAt: "2026-11-26T02:00:00.000Z",
        provider: "codex",
      },
    ],
    browserTabs: [SAMPLE_BROWSER_TAB],
    activeBrowserTabId: SAMPLE_BROWSER_TAB.id,
    isPickingElement: false,
    showTaskSidebar: true,
    showBrowserPane: true,
    isConnected: true,
    connectionStatus: "Codex / AGY / Claude ready",
    activeResponderCount: 0,
    providers: {
      codex: { id: "codex", label: "Codex", available: true, detail: "Connected", models: [] },
      agy: { id: "agy", label: "AGY", available: true, detail: "Available", models: [] },
      claude: { id: "claude", label: "Claude", available: true, detail: "Available", models: [] },
    },
    chatProvider: "codex",
    workerProvider: "agy",
    models: [],
    chatModel: "gpt-5.3-codex",
    chatEffort: "low",
    workerModel: null,
    workerEffort: null,
    defaultIntegrationMode: "feature-branch",
    autoLandOnComplete: true,
    preferredLanguage: "en",
    lastErrorBanner: null,
  };
}

describe("UI i18n locale resolution & translation helpers (src/shared/i18n.ts)", () => {
  it("resolves active UI locale from preferredLanguage (ja, en, auto)", () => {
    expect(resolveUiLocale("ja", "en-US")).toBe("ja");
    expect(resolveUiLocale("en", "ja-JP")).toBe("en");

    expect(resolveUiLocale("auto", "ja")).toBe("ja");
    expect(resolveUiLocale("auto", "ja-JP")).toBe("ja");
    expect(resolveUiLocale("auto", "ja_JP.UTF-8")).toBe("ja");

    expect(resolveUiLocale("auto", "en-US")).toBe("en");
    expect(resolveUiLocale("auto", "en-GB")).toBe("en");
    expect(resolveUiLocale("auto", "fr-FR")).toBe("en");
    expect(resolveUiLocale("auto", "de-DE")).toBe("en");

    expect(detectSystemLocale("ja-JP")).toBe("ja");
    expect(detectSystemLocale("en-US")).toBe("en");
    expect(detectSystemLocale("ko-KR")).toBe("en");

    // Undefined/null falls back to DEFAULT_PREFERRED_LANGUAGE ("ja")
    expect(resolveUiLocale(undefined)).toBe("ja");
    expect(resolveUiLocale(null)).toBe("ja");
  });

  it("translates key UI strings accurately in both ja and en", () => {
    expect(t("ja", "chat.openTaskDetail")).toBe("タスク詳細を開く");
    expect(t("en", "chat.openTaskDetail")).toBe("Open Task Detail");

    expect(t("ja", "taskEvent.completedReview")).toBe("完了（確認待ち）");
    expect(t("en", "taskEvent.completedReview")).toBe("Completed (Needs Review)");

    expect(t("ja", "sidebar.questions")).toBe("質問");
    expect(t("en", "sidebar.questions")).toBe("Questions");

    expect(formatTaskStatusLabel("running", "ja")).toBe("実行中");
    expect(formatTaskStatusLabel("running", "en")).toBe("Running");
    expect(formatTaskStatusLabel("needs_review", "ja")).toBe("確認待ち");
    expect(formatTaskStatusLabel("needs_review", "en")).toBe("Needs Review");
    expect(formatTaskStatusLabel("done", "ja")).toBe("完了");
    expect(formatTaskStatusLabel("done", "en")).toBe("Completed");

    expect(getFriendlyToolLabel("start_worker", "ja")).toBe("ワーカーを起動");
    expect(getFriendlyToolLabel("start_worker", "en")).toBe("Start worker");
    expect(getFriendlyToolLabel("get_task_detail", "ja")).toBe("タスク詳細を取得");
    expect(getFriendlyToolLabel("get_task_detail", "en")).toBe("Get task detail");

    expect(getLocalizedIntegrationModeMeta("feature-branch", "ja").label).toBe("Feature Branch（既定）");
    expect(getLocalizedIntegrationModeMeta("feature-branch", "en").label).toBe(
      "Feature Branch (Default)",
    );

    expect(getLocalizedLanguageOptionMeta("auto", "ja").label).toBe("自動 (Auto)");
    expect(getLocalizedLanguageOptionMeta("auto", "en").label).toBe("Auto");

    const now = Date.parse("2026-11-26T01:00:00.000Z");
    expect(formatRelativeSessionTime("2026-11-26T00:59:40.000Z", now, "en")).toBe("Just now");
    expect(formatRelativeSessionTime("2026-11-26T00:55:00.000Z", now, "en")).toBe("5m ago");
    expect(formatRelativeSessionTime("2026-11-25T01:00:00.000Z", now, "en")).toBe("Yesterday");
  });
});

describe("English UI rendering has zero leaked Japanese strings across all major components", () => {
  it("renders TaskSidebar, UnifiedChat, TaskEventCard, TaskInspectorModal, and UnifiedRightPane in clean English", () => {
    const taskEventMsg: ChatMessage = {
      id: "ev-1",
      role: "taskEvent",
      provider: "agy",
      relatedTaskId: SAMPLE_TASK.id,
      text: `**[T3 · acme-web · AGY] ${SAMPLE_TASK.title}** — ${t("en", "taskEvent.completedReview")}\nAuto-landed cleanly onto \`conductor/t3-analytics-ui\`.`,
      attachments: [],
      toolChips: [],
      isStreaming: false,
      createdAt: "2026-11-26T02:00:00.000Z",
    };

    const userQuestion: ChatMessage = {
      id: "u-1",
      role: "user",
      text: "How does OAuth token refresh prevent race conditions?",
      attachments: [],
      toolChips: [],
      isStreaming: false,
      createdAt: "2026-11-26T02:05:00.000Z",
    };

    const assistantReply: ChatMessage = {
      id: "a-1",
      role: "assistant",
      provider: "codex",
      replyToMessageId: "u-1",
      replyToSnippet: "How does OAuth token refresh prevent race conditions?",
      text: "It caches a single in-flight refresh promise.",
      attachments: [],
      toolChips: [
        {
          id: "tc-1",
          toolName: "get_task_detail",
          label: "get_task_detail · T4 (read-only)",
          detail: null,
          isCompleted: true,
          isError: false,
        },
      ],
      isStreaming: false,
      createdAt: "2026-11-26T02:05:10.000Z",
    };

    const questions = deriveQuestionItems([userQuestion, assistantReply], new Set(), "en");

    const sidebarHtml = renderToStaticMarkup(
      <TaskSidebar
        projects={[SAMPLE_PROJECT]}
        tasks={[
          SAMPLE_TASK,
          { ...SAMPLE_TASK, id: "task-2", taskNumber: 2, title: "Running task", status: "running" },
          {
            ...SAMPLE_TASK,
            id: "task-4",
            taskNumber: 4,
            title: "Unassigned task",
            projectId: null,
            projectName: "",
            status: "queued",
          },
          { ...SAMPLE_TASK, id: "task-1", taskNumber: 1, title: "Done task", status: "done" },
        ]}
        questions={questions}
        locale="en"
        defaultCompletedExpanded={true}
        selectedProjectId={null}
        selectedTaskId={null}
        onSelectProjectFilter={vi.fn()}
        onAddProject={vi.fn()}
        onScanDirectory={vi.fn()}
        onRescanProjects={vi.fn()}
        onRemoveProject={vi.fn()}
        onMentionProject={vi.fn()}
        onSelectTask={vi.fn()}
        onOpenPreviewUrl={vi.fn()}
        onMentionTask={vi.fn()}
        onUpdateTaskStatus={vi.fn()}
        onStopWorker={vi.fn()}
        onDeleteTask={vi.fn()}
      />,
    );
    expect(sidebarHtml).toContain("Auto-detected");
    expect(sidebarHtml).toContain("All");
    expect(sidebarHtml).toContain("Active &amp; Review");
    expect(sidebarHtml).toContain("Completed");
    expect(sidebarHtml).toContain("Questions");
    expect(sidebarHtml).toContain("Search questions...");
    expect(sidebarHtml).toContain("Group by project: ON (click for flat list)");
    expect(sidebarHtml).toContain("Unassigned");
    expect(sidebarHtml).not.toMatch(JAPANESE_CHAR_RE);

    const sidebarEmptyQuestionsSearchHtml = renderToStaticMarkup(
      <TaskSidebar
        projects={[SAMPLE_PROJECT]}
        tasks={[SAMPLE_TASK]}
        questions={questions}
        locale="en"
        defaultQuestionsSearch="unmatched-query"
        selectedProjectId={null}
        selectedTaskId={null}
        onSelectProjectFilter={vi.fn()}
        onAddProject={vi.fn()}
        onScanDirectory={vi.fn()}
        onRescanProjects={vi.fn()}
        onRemoveProject={vi.fn()}
        onMentionProject={vi.fn()}
        onSelectTask={vi.fn()}
        onOpenPreviewUrl={vi.fn()}
        onMentionTask={vi.fn()}
        onUpdateTaskStatus={vi.fn()}
        onStopWorker={vi.fn()}
        onDeleteTask={vi.fn()}
      />,
    );
    expect(sidebarEmptyQuestionsSearchHtml).toContain("No matching questions");
    expect(sidebarEmptyQuestionsSearchHtml).toContain("Clear filter");
    expect(sidebarEmptyQuestionsSearchHtml).not.toMatch(JAPANESE_CHAR_RE);

    const chatHtml = renderToStaticMarkup(
      <UnifiedChat
        snapshot={makeEnSnapshot([taskEventMsg, userQuestion, assistantReply])}
        composerText=""
        attachments={[]}
        isBrowserTabActive={true}
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
        onOpenSettings={vi.fn()}
      />,
    );
    expect(chatHtml).toContain("Open Task Detail");
    expect(chatHtml).toContain("Completed (Needs Review)");
    expect(chatHtml).toContain("Screenshot");
    expect(chatHtml).toContain("Pick Element");
    expect(chatHtml).not.toMatch(JAPANESE_CHAR_RE);

    const inspectorHtml = renderToStaticMarkup(
      <TaskInspectorModal
        task={SAMPLE_TASK}
        project={SAMPLE_PROJECT}
        projectColorHex={SAMPLE_PROJECT.colorHex}
        locale="en"
        onClose={vi.fn()}
        onUpdateStatus={vi.fn()}
        onOpenPreviewUrl={vi.fn()}
        onMentionInChat={vi.fn()}
        onStopWorker={vi.fn()}
        onCleanupWorktree={vi.fn()}
      />,
    );
    expect(inspectorHtml).toContain("Remove Worktree");
    expect(inspectorHtml).toContain("Summary");
    expect(inspectorHtml).toContain("Latest Worker Output");
    expect(inspectorHtml).toContain("Open in Browser");
    expect(inspectorHtml).toContain("Mention in chat");
    expect(inspectorHtml).not.toContain("Delete");
    expect(inspectorHtml).toContain("Needs Review");
    expect(inspectorHtml).not.toMatch(JAPANESE_CHAR_RE);

    const activeItem: ProjectSwitcherItem = {
      scopeKey: SAMPLE_PROJECT.id,
      project: SAMPLE_PROJECT,
      name: SAMPLE_PROJECT.name,
      path: SAMPLE_PROJECT.path,
      colorHex: SAMPLE_PROJECT.colorHex,
      tabCount: 2,
      browserCount: 1,
      markdownCount: 1,
      imageCount: 0,
      isActive: true,
      isGeneral: false,
    };

    const mdUnifiedTab: UnifiedRightPaneTab = {
      id: makeMarkdownUnifiedTabId("/workspace/acme-web/docs/ARCHITECTURE.md"),
      kind: "markdown",
      projectScope: SAMPLE_PROJECT.id,
      title: "ARCHITECTURE.md",
      subtitle: "/workspace/acme-web/docs/ARCHITECTURE.md",
      isLoading: false,
      hasError: false,
      markdownTab: {
        filePath: "/workspace/acme-web/docs/ARCHITECTURE.md",
        fileName: "ARCHITECTURE.md",
        document: {
          filePath: "/workspace/acme-web/docs/ARCHITECTURE.md",
          fileName: "ARCHITECTURE.md",
          content: "# Architecture\n\nClean English docs.",
          mtimeMs: 1700000000000,
          sizeBytes: 1200,
        },
        error: null,
        isLoading: false,
        lastReloadedAt: 1700000000000,
      },
    };

    const browserUnifiedTab: UnifiedRightPaneTab = {
      id: makeBrowserUnifiedTabId(SAMPLE_BROWSER_TAB.id),
      kind: "browser",
      projectScope: SAMPLE_PROJECT.id,
      title: SAMPLE_BROWSER_TAB.title,
      subtitle: SAMPLE_BROWSER_TAB.url,
      isLoading: false,
      hasError: false,
      browserTab: SAMPLE_BROWSER_TAB,
    };

    const rightPaneMdHtml = renderToStaticMarkup(
      <UnifiedRightPane
        activeProjectItem={activeItem}
        switcherWithTabs={[activeItem]}
        switcherOthers={[]}
        tabs={[browserUnifiedTab, mdUnifiedTab]}
        activeTab={mdUnifiedTab}
        projectRecentMdFiles={[]}
        locale="en"
        initialShowFileTree={true}
        initialFileTreeEntries={{ [SAMPLE_PROJECT.path]: [] }}
        isPickingElement={false}
        hideNativeView={false}
        onNavigateBrowser={vi.fn()}
        onNewBrowserTab={vi.fn()}
        onBrowserBack={vi.fn()}
        onBrowserForward={vi.fn()}
        onBrowserReload={vi.fn()}
        onBrowserToggleDevTools={vi.fn()}
        onBrowserTogglePicker={vi.fn()}
        onBrowserCaptureScreenshot={vi.fn()}
        onBrowserAttachErrors={vi.fn()}
        onBrowserOpenExternal={vi.fn()}
        mdAutoReload={true}
        mdIsWatching={true}
        mdJustReloadedAt={null}
        mdPendingAnchor={null}
        onClearMdPendingAnchor={vi.fn()}
        onToggleMdAutoReload={vi.fn()}
        onOpenMarkdownDialog={vi.fn()}
        onOpenMarkdownFile={vi.fn()}
        onRefreshActiveMd={vi.fn()}
        onRemoveRecentMd={vi.fn()}
        onAttachMdFileToChat={vi.fn()}
        onRetryImageTab={vi.fn()}
        onImageLoadError={vi.fn()}
        onSelectProjectScope={vi.fn()}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onOpenUrl={vi.fn()}
        onRevealInFinder={vi.fn()}
      />,
    );
    expect(rightPaneMdHtml).toContain("3 lines");
    expect(rightPaneMdHtml).toContain("Toggle file tree");
    expect(rightPaneMdHtml).toContain("Filter by filename...");
    expect(rightPaneMdHtml).not.toMatch(JAPANESE_CHAR_RE);

    const browserHtml = renderToStaticMarkup(
      <InAppBrowserPane
        activeTab={SAMPLE_BROWSER_TAB}
        isPickingElement={false}
        hideNativeView={false}
        locale="en"
        onNavigate={vi.fn()}
        onBack={vi.fn()}
        onForward={vi.fn()}
        onReload={vi.fn()}
        onToggleDevTools={vi.fn()}
        onTogglePicker={vi.fn()}
        onCaptureScreenshot={vi.fn()}
        onAttachUrl={vi.fn()}
        onAttachErrors={vi.fn()}
        onOpenExternal={vi.fn()}
      />,
    );
    expect(browserHtml).toContain("Screenshot");
    expect(browserHtml).toContain("Pick Element");
    expect(browserHtml).toContain("Attach URL");
    expect(browserHtml).toContain("Attach Errors");
    expect(browserHtml).not.toMatch(JAPANESE_CHAR_RE);

    const switcherHtml = renderToStaticMarkup(
      <RightPaneProjectSwitcher
        activeItem={activeItem}
        withTabs={[activeItem]}
        others={[]}
        isOpen={true}
        locale="en"
        onOpenChange={vi.fn()}
        onSelectScope={vi.fn()}
      />,
    );
    expect(switcherHtml).toContain("Open Tabs");
    expect(switcherHtml).not.toMatch(JAPANESE_CHAR_RE);

    const historyHtml = renderToStaticMarkup(
      <ChatSessionControls
        sessions={makeEnSnapshot([]).chatSessions}
        activeSessionId="sess-1"
        activeMessageCount={3}
        activeResponderCount={1}
        locale="en"
        defaultHistoryOpen={true}
        defaultConfirmNewChatOpen={true}
        onSelectSession={vi.fn()}
        onNewChat={vi.fn()}
        onDeleteSession={vi.fn()}
      />,
    );
    expect(historyHtml).toContain("Chat History");
    expect(historyHtml).toContain("Start a new chat?");
    expect(historyHtml).not.toMatch(JAPANESE_CHAR_RE);

    const mentionHtml = renderToStaticMarkup(
      <MentionPopover
        query={{ start: 0, end: 1, mode: "all", rawQuery: "", projectQuery: "", taskQuery: "" }}
        suggestions={[]}
        scopedProject={null}
        activeIndex={0}
        locale="en"
        onHoverIndex={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    expect(mentionHtml).toContain("Mention project or task");
    expect(mentionHtml).not.toMatch(JAPANESE_CHAR_RE);

    const settingsHtml = renderToStaticMarkup(
      <SettingsModal
        defaultIntegrationMode="feature-branch"
        autoLandOnComplete={true}
        preferredLanguage="en"
        remoteAccess={{
          enabled: true,
          running: true,
          port: 4789,
          token: "abcdef0123456789abcdef0123456789",
          bindHost: "0.0.0.0",
          tailscaleIp: "100.121.247.7",
          magicDnsName: "macbook-pro.taile00453.ts.net",
          lanIp: "192.168.1.5",
          url: "http://100.121.247.7:4789",
          magicDnsUrl: "http://macbook-pro.taile00453.ts.net:4789",
          connectUri:
            "conductor://connect?url=http%3A%2F%2F100.121.247.7%3A4789&token=abcdef0123456789abcdef0123456789",
          connectedClients: 1,
          error: null,
        }}
        projects={[SAMPLE_PROJECT]}
        onClose={vi.fn()}
        onSetDefaultIntegrationMode={vi.fn()}
        onSetAutoLandOnComplete={vi.fn()}
        onSetProjectIntegrationMode={vi.fn()}
        onChangePreferredLanguage={vi.fn()}
      />,
    );
    expect(settingsHtml).toContain("Conductor Settings");
    expect(settingsHtml).toContain("Language / Output Language");
    expect(settingsHtml).toContain("Remote Access / Tailscale Mobile Bridge");
    expect(settingsHtml).toContain("Android Quick Setup (QR Code)");
    expect(settingsHtml).toContain("Git Worktree Integration Mode (Global Default)");
    expect(settingsHtml).toContain("Per-Project Overrides");
    expect(settingsHtml).toContain("Close");
    expect(settingsHtml).not.toContain("リモートアクセス");
    expect(settingsHtml).not.toContain("稼働中");

    const usageSettingsHtml = renderToStaticMarkup(
      <SettingsModal
        defaultIntegrationMode="feature-branch"
        preferredLanguage="en"
        initialTab="usage"
        projects={[SAMPLE_PROJECT]}
        usageRecords={[
          {
            id: "u-en-1",
            timestamp: new Date().toISOString(),
            source: "chat",
            provider: "codex",
            model: "gpt-5.4",
            projectName: null,
            inputTokens: 2000,
            cachedInputTokens: 1000,
            outputTokens: 500,
            costUsd: 0.0125,
            isEstimated: true,
            turnCount: 1,
          },
        ]}
        onClearUsage={vi.fn()}
        onUpdateUsageBudgets={vi.fn()}
        onRefreshProviderQuotas={vi.fn()}
        onClose={vi.fn()}
        onSetDefaultIntegrationMode={vi.fn()}
        onSetProjectIntegrationMode={vi.fn()}
      />,
    );
    expect(usageSettingsHtml).toContain("Weekly &amp; Monthly Quota");
    expect(usageSettingsHtml).toContain("General Chat");
    expect(usageSettingsHtml).toContain("Reset History");
    expect(usageSettingsHtml).not.toMatch(JAPANESE_CHAR_RE);

    const taskEventHtml = renderToStaticMarkup(
      <TaskEventCard
        message={taskEventMsg}
        tasks={[SAMPLE_TASK]}
        projects={[SAMPLE_PROJECT]}
        locale="en"
        onOpenUrl={vi.fn()}
        onOpenMarkdownFile={vi.fn()}
        onOpenTask={vi.fn()}
        onUpdateTaskStatus={vi.fn()}
      />,
    );
    expect(taskEventHtml).toContain("Open Task Detail");
    expect(taskEventHtml).not.toMatch(JAPANESE_CHAR_RE);
  });
});

describe("Main-process ConductorController TaskEvent localization", () => {
  it("emits English TaskEvent completion headers when preferredLanguage is en and Japanese when ja", async () => {
    const dataDir = makeTempDir("conductor-i18n-ctrl-");
    const projectDir = makeTempDir("conductor-i18n-proj-");
    const store = new StateStore(dataDir);

    const fakeBrowser = {
      getTabs: () => [],
      getActiveTabId: () => null,
      getActiveTab: () => null,
      isPickingElement: () => false,
      restore: () => {},
    } as unknown as BrowserManager;

    const capturedCallbacks: CliTurnCallbacks[] = [];
    const controller = new ConductorController({
      store,
      browser: fakeBrowser,
      onSnapshot: () => {},
      cliWorkerRunner: {
        runAgyTurn: (_opts, callbacks: CliTurnCallbacks): RunningCliTurn => {
          capturedCallbacks.push(callbacks);
          return { cancel: vi.fn(), waitForExit: async () => {} };
        },
        runClaudeTurn: (_opts, callbacks: CliTurnCallbacks): RunningCliTurn => {
          capturedCallbacks.push(callbacks);
          return { cancel: vi.fn(), waitForExit: async () => {} };
        },
      },
    });

    (controller as unknown as Record<string, unknown>).isConnected = true;
    (controller as unknown as Record<string, unknown>).providers = {
      codex: { id: "codex", label: "Codex", available: false, detail: "", models: [] },
      agy: {
        id: "agy",
        label: "AGY",
        available: true,
        detail: "ok",
        models: [
          {
            id: "gemini-4-neon-high",
            model: "gemini-4-neon-high",
            displayName: "Gemini 4 Neon",
            description: "",
            supportedEfforts: [],
            defaultEffort: "",
            isDefault: true,
          },
        ],
      },
      claude: { id: "claude", label: "Claude", available: false, detail: "", models: [] },
    };

    const project = controller.registerProject(projectDir, "demo-app")!;
    const callMcp = (name: string, args: Record<string, unknown>) =>
      (
        controller as unknown as {
          handleMCPToolCall: (n: string, a: Record<string, unknown>) => Promise<MCPToolResult>;
        }
      ).handleMCPToolCall(name, args);

    // 1. English mode -> "Completed (Needs Review)"
    controller.setPreferredLanguage("en");
    await callMcp("start_worker", {
      project_name: project.name,
      title: "Add health check endpoint",
      prompt: "Add /healthz route",
      provider: "agy",
    });
    expect(capturedCallbacks).toHaveLength(1);
    capturedCallbacks[0]?.onComplete?.({
      ok: true,
      finalText: "Added /healthz endpoint.",
    });

    const enEvent = controller
      .getSnapshot()
      .messages.filter((m) => m.role === "taskEvent")
      .at(-1);
    expect(enEvent?.text).toContain("— Completed (Needs Review)");
    expect(enEvent?.text).not.toContain("完了（確認待ち）");

    // 2. Japanese mode -> "完了（確認待ち）"
    controller.setPreferredLanguage("ja");
    await callMcp("start_worker", {
      project_name: project.name,
      title: "ヘルスチェックを追加",
      prompt: "ヘルスチェックを追加して",
      provider: "agy",
    });
    expect(capturedCallbacks).toHaveLength(2);
    capturedCallbacks[1]?.onComplete?.({
      ok: true,
      finalText: "追加しました。",
    });

    const jaEvent = controller
      .getSnapshot()
      .messages.filter((m) => m.role === "taskEvent")
      .at(-1);
    expect(jaEvent?.text).toContain("— 完了（確認待ち）");
  });

  it("renders TerminalPane cleanly in both Japanese and English with zero leaked Japanese in English mode", () => {
    expect(t("ja", "rightPane.newTerminalTabBtn")).toBe("新しいターミナル");
    expect(t("en", "rightPane.newTerminalTabBtn")).toBe("New Terminal");
    expect(t("ja", "terminal.restartBtn")).toBe("再起動");
    expect(t("en", "terminal.restartBtn")).toBe("Restart");

    const enTerminalHtml = renderToStaticMarkup(
      <TerminalPane
        tab={{
          id: "term-en",
          title: "zsh",
          cwd: "/workspace/acme-web",
          shell: "/bin/zsh",
          shellName: "zsh",
          pid: 1234,
          backend: "node-pty",
          projectId: SAMPLE_PROJECT.id,
          status: "exited",
          exitCode: 0,
          error: null,
          sequenceNumber: 1,
        }}
        isVisible={true}
        locale="en"
        onRestart={vi.fn()}
        onNewTerminalTab={vi.fn()}
        onRevealInFinder={vi.fn()}
      />,
    );
    expect(enTerminalHtml).toContain("Exited (code 0)");
    expect(enTerminalHtml).toContain("Restart");
    expect(enTerminalHtml).not.toMatch(JAPANESE_CHAR_RE);
  });
});
