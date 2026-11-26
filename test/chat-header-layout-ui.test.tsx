import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { UnifiedChat } from "../src/renderer/components/UnifiedChat.js";
import type { AppSnapshot, BrowserTab } from "../src/shared/types.js";
import { createUsageRecord } from "../src/shared/usage.js";

const SAMPLE_BROWSER_TAB: BrowserTab = {
  id: "bt-1",
  title: "Preview",
  url: "http://localhost:3000",
  projectId: "proj-1",
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
  consoleErrorCount: 2,
  networkErrorCount: 1,
};

function makeSnapshot(overrides: Partial<AppSnapshot> = {}): AppSnapshot {
  const todayUsageRecord = createUsageRecord({
    id: "usage-1",
    timestamp: new Date().toISOString(),
    source: "chat",
    provider: "codex",
    model: "gpt-5.4",
    tokens: { inputTokens: 8000, cachedInputTokens: 4000, outputTokens: 1000 },
  })!;

  return {
    projects: [],
    scanRoots: [],
    tasks: [],
    messages: [],
    activeChatSessionId: "sess-1",
    chatSessions: [
      {
        id: "sess-1",
        title: "Test Chat",
        preview: "",
        messageCount: 2,
        createdAt: "2026-11-26T00:00:00.000Z",
        updatedAt: "2026-11-26T00:00:00.000Z",
      },
      {
        id: "sess-2",
        title: "Previous Chat",
        preview: "hi",
        messageCount: 4,
        createdAt: "2026-11-25T00:00:00.000Z",
        updatedAt: "2026-11-25T00:00:00.000Z",
      },
    ],
    browserTabs: [SAMPLE_BROWSER_TAB],
    activeBrowserTabId: SAMPLE_BROWSER_TAB.id,
    isPickingElement: false,
    showTaskSidebar: true,
    showBrowserPane: true,
    isConnected: true,
    connectionStatus: "Codex 利用可能",
    activeResponderCount: 2,
    providers: {
      codex: {
        id: "codex",
        label: "Codex",
        available: true,
        detail: "ok",
        models: [
          {
            id: "gpt-5.4",
            model: "gpt-5.4",
            displayName: "gpt-5.4-super-long-model-name",
            description: "test",
            isDefault: true,
            supportedEfforts: ["low", "medium", "high"],
            defaultEffort: "high",
          },
        ],
      },
      agy: { id: "agy", label: "AGY", available: false, detail: "", models: [] },
      claude: { id: "claude", label: "Claude", available: false, detail: "", models: [] },
    },
    chatProvider: "codex",
    workerProvider: "codex",
    models: [],
    chatModel: "gpt-5.4",
    chatEffort: "high",
    workerModel: "gpt-5.4",
    workerEffort: "medium",
    defaultIntegrationMode: "feature-branch",
    autoLandOnComplete: true,
    preferredLanguage: "ja",
    voiceReadbackEnabled: true,
    usageRecords: [todayUsageRecord],
    lastErrorBanner: null,
    ...overrides,
  };
}

function renderChat(options: {
  snapshot?: Partial<AppSnapshot>;
  isSpeaking?: boolean;
  isBrowserTabActive?: boolean;
} = {}): string {
  return renderToStaticMarkup(
    <UnifiedChat
      snapshot={makeSnapshot(options.snapshot)}
      composerText=""
      attachments={[]}
      isBrowserTabActive={options.isBrowserTabActive ?? true}
      voiceReadbackEnabled={true}
      isSpeaking={options.isSpeaking ?? true}
      voiceAutoSend={true}
      onToggleVoiceReadback={vi.fn()}
      onStopSpeaking={vi.fn()}
      onToggleVoiceAutoSend={vi.fn()}
      onOpenUsage={vi.fn()}
      onOpenSettings={vi.fn()}
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

describe("UnifiedChat narrow-pane responsive header & composer layout", () => {
  it("enables container queries and uses a non-overflowing responsive header structure", () => {
    const html = renderChat();

    // Root section establishes a container query context with min-w-0
    expect(html).toMatch(/<section class="[^"]*@container[^"]*min-w-0[^"]*">/);

    // Header should not lock itself to a fixed h-11 that lets wrapped rows overflow onto chat body
    const headerMatch = html.match(/<header[^>]*data-testid="chat-header"[^>]*>/);
    expect(headerMatch).not.toBeNull();
    expect(headerMatch![0]).not.toContain(" h-11 ");

    // Responsive controls strip wraps below 840px and inlines at @[840px]
    const controlsMatch = html.match(/<div[^>]*data-testid="chat-header-controls"[^>]*>/);
    expect(controlsMatch).not.toBeNull();
    expect(controlsMatch![0]).toContain("basis-full");
    expect(controlsMatch![0]).toContain("flex-wrap");
    expect(controlsMatch![0]).toContain("@[840px]:basis-auto");
    expect(controlsMatch![0]).toContain("@[840px]:flex-nowrap");
  });

  it("prevents vertical single-character wrapping on parallel responding pill, stop-all button, and header pills", () => {
    const html = renderChat({
      snapshot: { isConnected: false, activeResponderCount: 2 },
      isSpeaking: true,
    });

    const parallelPill = html.match(
      /<div[^>]*data-testid="chat-parallel-responding-pill"[^>]*>/,
    );
    expect(parallelPill).not.toBeNull();
    expect(parallelPill![0]).toContain("whitespace-nowrap");
    expect(parallelPill![0]).toContain("shrink-0");

    const stopAllBtn = html.match(/<button[^>]*data-testid="chat-stop-all-btn"[^>]*>/);
    expect(stopAllBtn).not.toBeNull();
    expect(stopAllBtn![0]).toContain("whitespace-nowrap");
    expect(stopAllBtn![0]).toContain("shrink-0");

    const modelBtn = html.match(/<button[^>]*data-testid="chat-model-selector-btn"[^>]*>/);
    expect(modelBtn).not.toBeNull();
    expect(modelBtn![0]).toContain("whitespace-nowrap");
    expect(modelBtn![0]).toContain("min-w-0");
    expect(modelBtn![0]).toContain("gpt-5.4-super-long-model-name");

    const usageBtn = html.match(/<button[^>]*data-testid="open-usage-btn"[^>]*>/);
    expect(usageBtn).not.toBeNull();
    expect(usageBtn![0]).toContain("whitespace-nowrap");
    expect(usageBtn![0]).toContain("shrink-0");

    const stopSpeakingBtn = html.match(
      /<button[^>]*data-testid="voice-stop-speaking-btn"[^>]*>/,
    );
    expect(stopSpeakingBtn).not.toBeNull();
    expect(stopSpeakingBtn![0]).toContain("whitespace-nowrap");
    expect(stopSpeakingBtn![0]).toContain("shrink-0");

    const reconnectBtn = html.match(/<button[^>]*data-testid="chat-reconnect-btn"[^>]*>/);
    expect(reconnectBtn).not.toBeNull();
    expect(reconnectBtn![0]).toContain("whitespace-nowrap");
    expect(reconnectBtn![0]).toContain("shrink-0");
  });

  it("preserves macOS traffic-light clearance only on row 1 left when sidebar is hidden", () => {
    const htmlHidden = renderChat({ snapshot: { showTaskSidebar: false } });
    expect(htmlHidden).toContain("pl-[78px]");
    expect(htmlHidden).toContain("@[840px]:pl-[66px]");

    const htmlVisible = renderChat({ snapshot: { showTaskSidebar: true } });
    expect(htmlVisible).not.toContain("pl-[78px]");
  });

  it("keeps composer toolbar wrapping cleanly with nowrap action buttons", () => {
    const html = renderChat({ isBrowserTabActive: true });

    const toolbar = html.match(/<div[^>]*data-testid="composer-toolbar"[^>]*>/);
    expect(toolbar).not.toBeNull();
    expect(toolbar![0]).toContain("flex-wrap");

    for (const testId of [
      "composer-screenshot-btn",
      "composer-element-picker-btn",
      "composer-attach-url-btn",
      "composer-attach-errors-btn",
      "composer-voice-autosend-btn",
    ]) {
      const btn = html.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`));
      expect(btn, `expected ${testId}`).not.toBeNull();
      expect(btn![0]).toContain("whitespace-nowrap");
      expect(btn![0]).toContain("shrink-0");
    }
  });
});
