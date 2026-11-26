import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AppSnapshot, BrowserTab } from "../src/shared/types.js";
import { InAppBrowserPane } from "../src/renderer/components/InAppBrowserPane.js";
import { UnifiedChat } from "../src/renderer/components/UnifiedChat.js";
import {
  isRightPaneBrowserTabActive,
  makeBrowserUnifiedTabId,
  makeCodeUnifiedTabId,
  makeImageUnifiedTabId,
  makeMarkdownUnifiedTabId,
  type UnifiedRightPaneTab,
} from "../src/renderer/lib/right-pane-tabs.js";

const SAMPLE_BROWSER_TAB: BrowserTab = {
  id: "bt-1",
  title: "Local Preview",
  url: "http://localhost:3000",
  projectId: "proj-1",
  isLoading: false,
  canGoBack: true,
  canGoForward: false,
  consoleErrorCount: 0,
  networkErrorCount: 0,
};

const BROWSER_TAB_WITH_ERRORS: BrowserTab = {
  ...SAMPLE_BROWSER_TAB,
  consoleErrorCount: 2,
  networkErrorCount: 1,
};

const BROWSER_UNIFIED_TAB: UnifiedRightPaneTab = {
  id: makeBrowserUnifiedTabId(SAMPLE_BROWSER_TAB.id),
  kind: "browser",
  projectScope: "proj-1",
  title: SAMPLE_BROWSER_TAB.title,
  subtitle: SAMPLE_BROWSER_TAB.url,
  isLoading: false,
  hasError: false,
  browserTab: SAMPLE_BROWSER_TAB,
};

const MARKDOWN_UNIFIED_TAB: UnifiedRightPaneTab = {
  id: makeMarkdownUnifiedTabId("/repo/README.md"),
  kind: "markdown",
  projectScope: "proj-1",
  title: "README.md",
  subtitle: "/repo/README.md",
  isLoading: false,
  hasError: false,
  markdownTab: {
    filePath: "/repo/README.md",
    fileName: "README.md",
    document: null,
    error: null,
    isLoading: false,
    lastReloadedAt: null,
  },
};

const CODE_UNIFIED_TAB: UnifiedRightPaneTab = {
  id: makeCodeUnifiedTabId("/repo/src/index.ts"),
  kind: "code",
  projectScope: "proj-1",
  title: "index.ts",
  subtitle: "/repo/src/index.ts",
  isLoading: false,
  hasError: false,
  codeTab: {
    filePath: "/repo/src/index.ts",
    fileName: "index.ts",
    document: null,
    error: null,
    isLoading: false,
    lastReloadedAt: null,
  },
};

const IMAGE_UNIFIED_TAB: UnifiedRightPaneTab = {
  id: makeImageUnifiedTabId("img-1"),
  kind: "image",
  projectScope: "proj-1",
  title: "mockup.png",
  subtitle: "/repo/mockup.png",
  isLoading: false,
  hasError: false,
  imageTab: {
    id: "img-1",
    label: "mockup.png",
    fileName: "mockup.png",
    src: "data:image/png;base64,AAAA",
    imagePath: "/repo/mockup.png",
    isLoading: false,
    error: null,
  },
};

function makeSnapshot(overrides: Partial<AppSnapshot> = {}): AppSnapshot {
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
        messageCount: 0,
        createdAt: "2026-11-26T00:00:00.000Z",
        updatedAt: "2026-11-26T00:00:00.000Z",
      },
    ],
    browserTabs: [SAMPLE_BROWSER_TAB],
    activeBrowserTabId: SAMPLE_BROWSER_TAB.id,
    isPickingElement: false,
    showTaskSidebar: true,
    showBrowserPane: true,
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

function renderComposer(options: {
  snapshot?: Partial<AppSnapshot>;
  isBrowserTabActive?: boolean;
}): string {
  return renderToStaticMarkup(
    <UnifiedChat
      snapshot={makeSnapshot(options.snapshot)}
      composerText=""
      attachments={[]}
      isBrowserTabActive={options.isBrowserTabActive}
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

describe("isRightPaneBrowserTabActive helper", () => {
  it("returns true only when the right pane is open and the active tab is a browser tab", () => {
    expect(isRightPaneBrowserTabActive(true, BROWSER_UNIFIED_TAB)).toBe(true);
    expect(isRightPaneBrowserTabActive(false, BROWSER_UNIFIED_TAB)).toBe(false);
    expect(isRightPaneBrowserTabActive(true, null)).toBe(false);
    expect(isRightPaneBrowserTabActive(true, MARKDOWN_UNIFIED_TAB)).toBe(false);
    expect(isRightPaneBrowserTabActive(true, CODE_UNIFIED_TAB)).toBe(false);
    expect(isRightPaneBrowserTabActive(true, IMAGE_UNIFIED_TAB)).toBe(false);
  });
});

describe("UnifiedChat composer browser-only button contextual visibility", () => {
  it("hides all browser-only buttons when isBrowserTabActive is false while keeping image upload visible", () => {
    const html = renderComposer({
      snapshot: {
        showBrowserPane: false,
        browserTabs: [BROWSER_TAB_WITH_ERRORS],
        activeBrowserTabId: BROWSER_TAB_WITH_ERRORS.id,
      },
      isBrowserTabActive: false,
    });

    // Image file upload stays available regardless of browser state
    expect(html).toContain('data-testid="composer-attach-image-btn"');
    expect(html).toContain('title="画像を添付"');

    // Browser-only actions are completely hidden
    expect(html).not.toContain('data-testid="composer-screenshot-btn"');
    expect(html).not.toContain('data-testid="composer-element-picker-btn"');
    expect(html).not.toContain('data-testid="composer-attach-url-btn"');
    expect(html).not.toContain('data-testid="composer-attach-errors-btn"');
  });

  it("hides browser-only buttons when right pane is open on Markdown, Code, or Image tabs", () => {
    for (const activeTab of [MARKDOWN_UNIFIED_TAB, CODE_UNIFIED_TAB, IMAGE_UNIFIED_TAB, null]) {
      const html = renderComposer({
        snapshot: {
          showBrowserPane: true,
          browserTabs: [BROWSER_TAB_WITH_ERRORS],
          activeBrowserTabId: BROWSER_TAB_WITH_ERRORS.id,
        },
        isBrowserTabActive: isRightPaneBrowserTabActive(true, activeTab),
      });

      expect(html).toContain('data-testid="composer-attach-image-btn"');
      expect(html).not.toContain('data-testid="composer-screenshot-btn"');
      expect(html).not.toContain('data-testid="composer-element-picker-btn"');
      expect(html).not.toContain('data-testid="composer-attach-url-btn"');
      expect(html).not.toContain('data-testid="composer-attach-errors-btn"');
    }
  });

  it("shows browser-only buttons when a browser tab is active in the open right pane", () => {
    const htmlNoErrors = renderComposer({
      snapshot: {
        showBrowserPane: true,
        browserTabs: [SAMPLE_BROWSER_TAB],
        activeBrowserTabId: SAMPLE_BROWSER_TAB.id,
      },
      isBrowserTabActive: isRightPaneBrowserTabActive(true, BROWSER_UNIFIED_TAB),
    });

    expect(htmlNoErrors).toContain('data-testid="composer-attach-image-btn"');
    expect(htmlNoErrors).toContain('data-testid="composer-screenshot-btn"');
    expect(htmlNoErrors).toContain("スクショ");
    expect(htmlNoErrors).toContain('data-testid="composer-element-picker-btn"');
    expect(htmlNoErrors).toContain("要素選択");
    expect(htmlNoErrors).toContain('data-testid="composer-attach-url-btn"');
    expect(htmlNoErrors).toContain("URL");
    expect(htmlNoErrors).not.toContain('data-testid="composer-attach-errors-btn"');

    const htmlWithErrors = renderComposer({
      snapshot: {
        showBrowserPane: true,
        browserTabs: [BROWSER_TAB_WITH_ERRORS],
        activeBrowserTabId: BROWSER_TAB_WITH_ERRORS.id,
      },
      isBrowserTabActive: isRightPaneBrowserTabActive(true, BROWSER_UNIFIED_TAB),
    });

    expect(htmlWithErrors).toContain('data-testid="composer-attach-errors-btn"');
    expect(htmlWithErrors).toContain("エラー (3)");
  });
});

describe("InAppBrowserPane inspection toolbar", () => {
  it("renders clearly labeled buttons with tooltips for スクショ, 要素選択, URL添付, and エラー添付", () => {
    const htmlNoErrors = renderToStaticMarkup(
      <InAppBrowserPane
        activeTab={SAMPLE_BROWSER_TAB}
        isPickingElement={false}
        hideNativeView={false}
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

    expect(htmlNoErrors).toContain('data-testid="browser-inspection-toolbar"');
    expect(htmlNoErrors).toContain('data-testid="browser-toolbar-screenshot-btn"');
    expect(htmlNoErrors).toContain("スクショ");
    expect(htmlNoErrors).toContain('title="画面スクショをチャットに添付 (⌘⇧S)"');

    expect(htmlNoErrors).toContain('data-testid="browser-toolbar-element-picker-btn"');
    expect(htmlNoErrors).toContain("要素選択");
    expect(htmlNoErrors).toContain('title="ページ上の要素を選択してチャットに添付 (⌘⇧P)"');

    expect(htmlNoErrors).toContain('data-testid="browser-toolbar-attach-url-btn"');
    expect(htmlNoErrors).toContain("URL添付");
    expect(htmlNoErrors).toContain('title="現在のブラウザURLをチャットに添付"');

    expect(htmlNoErrors).toContain('data-testid="browser-toolbar-attach-errors-btn"');
    expect(htmlNoErrors).toContain("エラー添付");
    expect(htmlNoErrors).toContain(
      'title="コンソール/通信エラーをチャットへ添付（現在エラーはありません）"',
    );
    expect(htmlNoErrors).toMatch(/data-testid="browser-toolbar-attach-errors-btn"[^>]*disabled=""/);

    const htmlWithErrors = renderToStaticMarkup(
      <InAppBrowserPane
        activeTab={BROWSER_TAB_WITH_ERRORS}
        isPickingElement={true}
        hideNativeView={false}
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

    expect(htmlWithErrors).toContain('aria-pressed="true"');
    expect(htmlWithErrors).toContain('title="コンソール/通信エラー (3件) をチャットへ添付"');
    expect(htmlWithErrors).toContain(">3<");
    expect(htmlWithErrors).not.toMatch(
      /data-testid="browser-toolbar-attach-errors-btn"[^>]*disabled=""/,
    );
  });
});
