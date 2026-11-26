import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ScrollToBottomButton, UnifiedChat } from "../src/renderer/components/UnifiedChat.js";
import { t } from "../src/shared/i18n.js";
import type { AppSnapshot } from "../src/shared/types.js";

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
    browserTabs: [],
    activeBrowserTabId: null,
    isPickingElement: false,
    showTaskSidebar: true,
    showBrowserPane: false,
    isConnected: true,
    connectionStatus: "Codex ready",
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

describe("ScrollToBottomButton UI & localization", () => {
  it("provides localized labels in both ja and en", () => {
    expect(t("ja", "chat.scrollToBottom")).toBe("最新メッセージへ");
    expect(t("en", "chat.scrollToBottom")).toBe("Scroll to bottom");
  });

  it("renders nothing when hidden and renders a localized floating button with ArrowDown icon when visible", () => {
    const hiddenHtml = renderToStaticMarkup(
      <ScrollToBottomButton visible={false} locale="ja" onClick={vi.fn()} />,
    );
    expect(hiddenHtml).toBe("");

    const jaHtml = renderToStaticMarkup(
      <ScrollToBottomButton visible={true} locale="ja" onClick={vi.fn()} />,
    );
    expect(jaHtml).toContain('data-testid="chat-scroll-to-bottom-btn"');
    expect(jaHtml).toContain("最新メッセージへ");
    expect(jaHtml).toContain('title="最新メッセージへ"');
    expect(jaHtml).toContain('aria-label="最新メッセージへ"');
    expect(jaHtml).toContain("<svg");

    const enHtml = renderToStaticMarkup(
      <ScrollToBottomButton visible={true} locale="en" onClick={vi.fn()} />,
    );
    expect(enHtml).toContain('data-testid="chat-scroll-to-bottom-btn"');
    expect(enHtml).toContain("Scroll to bottom");
    expect(enHtml).toContain('title="Scroll to bottom"');
    expect(enHtml).toContain('aria-label="Scroll to bottom"');
    expect(enHtml).not.toContain("最新メッセージへ");
  });

  it("invokes onClick when the floating button is clicked", () => {
    const onClick = vi.fn();
    const memoType = ScrollToBottomButton as unknown as {
      type: React.FC<{ visible: boolean; locale: "ja" | "en"; onClick: () => void }>;
    };
    const tree = memoType.type({ visible: true, locale: "en", onClick });
    const button = findElementByTestId(tree, "chat-scroll-to-bottom-btn");
    expect(button).not.toBeNull();
    (button!.props.onClick as () => void)();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("keeps the floating button hidden by default on initial render of UnifiedChat", () => {
    const html = renderToStaticMarkup(
      <UnifiedChat
        snapshot={makeSnapshot()}
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

    expect(html).not.toContain('data-testid="chat-scroll-to-bottom-btn"');
  });
});
