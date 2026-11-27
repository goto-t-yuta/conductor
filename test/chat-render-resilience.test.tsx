import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageRenderErrorBoundary, UnifiedChat } from "../src/renderer/components/UnifiedChat.js";
import type { AppSnapshot, ChatMessage } from "../src/shared/types.js";

function makeMessage(
  overrides: Partial<ChatMessage> & { id: string; role: ChatMessage["role"]; text: string },
): ChatMessage {
  return {
    attachments: [],
    toolChips: [],
    isStreaming: false,
    createdAt: "2026-11-27T00:00:00.000Z",
    ...overrides,
  };
}

function makeSnapshot(messages: ChatMessage[]): AppSnapshot {
  return {
    snapshotEpoch: "ui-epoch-1",
    snapshotVersion: 1,
    projects: [],
    scanRoots: [],
    tasks: [],
    messages,
    activeChatSessionId: "sess-ui-1",
    chatSessions: [
      {
        id: "sess-ui-1",
        title: "何を比較してたんやw",
        preview: "完全にやらかしてましたw",
        messageCount: messages.length,
        createdAt: "2026-11-27T00:00:00.000Z",
        updatedAt: "2026-11-27T00:00:00.000Z",
        provider: "codex",
      },
    ],
    browserTabs: [],
    activeBrowserTabId: null,
    isPickingElement: false,
    showTaskSidebar: true,
    showBrowserPane: false,
    isConnected: true,
    connectionStatus: "接続済み",
    activeResponderCount: 0,
    providers: {
      codex: { id: "codex", label: "Codex", available: true, detail: "ok", models: [] },
      agy: { id: "agy", label: "AGY", available: false, detail: "off", models: [] },
      claude: { id: "claude", label: "Claude", available: false, detail: "off", models: [] },
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

describe("UnifiedChat rendering resilience", () => {
  it("falls back to plain text on render error and recovers automatically when resetKey changes", () => {
    const boundary = new MessageRenderErrorBoundary({
      resetKey: "m1:10",
      fallbackText: "完全にやらかしてましたw",
      children: React.createElement("div", { "data-testid": "healthy-child" }, "ok"),
    });

    // Healthy render passes children through
    const healthyHtml = renderToStaticMarkup(boundary.render() as React.ReactElement);
    expect(healthyHtml).toContain("healthy-child");

    // Simulate React error boundary transition
    boundary.state = MessageRenderErrorBoundary.getDerivedStateFromError();
    const fallbackHtml = renderToStaticMarkup(boundary.render() as React.ReactElement);
    expect(fallbackHtml).toContain("message-markdown-fallback");
    expect(fallbackHtml).toContain("完全にやらかしてましたw");

    // Simulate resetKey update after streaming appends new text
    const updatedBoundary = new MessageRenderErrorBoundary({
      resetKey: "m1:20",
      fallbackText: "完全にやらかしてましたw\n\n追記",
      children: React.createElement("div", null, "recovered"),
    });
    updatedBoundary.state = { hasError: true };
    let nextState: { hasError: boolean } | null = null;
    updatedBoundary.setState = ((partial: { hasError: boolean }) => {
      nextState = partial;
    }) as typeof updatedBoundary.setState;
    updatedBoundary.componentDidUpdate({
      resetKey: "m1:10",
      fallbackText: "完全にやらかしてましたw",
      children: null,
    });
    expect(nextState).toEqual({ hasError: false });
  });

  it("renders all messages stably across streaming and completion even with missing optional arrays", () => {
    const initialMessages: ChatMessage[] = [
      makeMessage({
        id: "u1",
        role: "user",
        text: "何を比較してたんやw",
        attachments: undefined as unknown as ChatMessage["attachments"],
      }),
      makeMessage({
        id: "a1",
        role: "assistant",
        provider: "codex",
        text: "完全にやらかしてましたw",
        isStreaming: true,
        toolChips: undefined as unknown as ChatMessage["toolChips"],
      }),
    ];

    const noop = () => {};
    const makeProps = (snapshot: AppSnapshot) => ({
      snapshot,
      composerText: "",
      attachments: [],
      selectedMentions: [],
      isBrowserTabActive: false,
      onAddMention: noop,
      onRemoveMention: noop,
      onAddAttachment: noop,
      onRemoveAttachment: noop,
      onSend: noop,
      onStopMessage: noop,
      onStopAll: noop,
      onNewChat: noop,
      onSelectChatSession: noop,
      onDeleteChatSession: noop,
      onToggleSidebar: noop,
      onToggleMarkdownViewer: noop,
      onToggleBrowser: noop,
      onReconnect: noop,
      onAddProject: noop,
      onOpenTask: noop,
      onOpenUrl: noop,
      onOpenMarkdownFile: noop,
      onToggleElementPicker: noop,
      onCaptureScreenshot: noop,
      onAttachCurrentUrl: noop,
      onAttachConsoleErrors: noop,
      onPickLocalImages: noop,
      onPasteImage: noop,
      onSetChatProvider: noop,
      onSetWorkerProvider: noop,
      onSetChatModel: noop,
      onSetWorkerModel: noop,
      onDismissError: noop,
    });

    const streamingHtml = renderToStaticMarkup(
      React.createElement(UnifiedChat, makeProps(makeSnapshot(initialMessages))),
    );
    expect(streamingHtml).toContain("何を比較してたんやw");
    expect(streamingHtml).toContain("完全にやらかしてましたw");

    const completedMessages: ChatMessage[] = [
      initialMessages[0]!,
      {
        ...initialMessages[1]!,
        text: "完全にやらかしてましたw\n\n原因を特定しました。",
        isStreaming: false,
      },
    ];

    const completedHtml = renderToStaticMarkup(
      React.createElement(
        UnifiedChat,
        makeProps({
          ...makeSnapshot(completedMessages),
          snapshotVersion: 2,
        }),
      ),
    );

    expect(completedHtml).toContain("何を比較してたんやw");
    expect(completedHtml).toContain("完全にやらかしてましたw");
    expect(completedHtml).toContain("原因を特定しました。");
  });
});
