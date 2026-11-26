import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SettingsModal, VoiceSettingsSection } from "../src/renderer/components/SettingsModal.js";
import { UnifiedChat } from "../src/renderer/components/UnifiedChat.js";
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
    voiceReadbackEnabled: false,
    lastErrorBanner: null,
    ...overrides,
  };
}

describe("Voice UI controls in UnifiedChat and SettingsModal", () => {
  it("renders microphone button, auto-send toggle, readback toggle, and stop speaking button in UnifiedChat", () => {
    const htmlIdle = renderToStaticMarkup(
      <UnifiedChat
        snapshot={makeSnapshot({ voiceReadbackEnabled: false })}
        composerText=""
        attachments={[]}
        voiceReadbackEnabled={false}
        isSpeaking={false}
        voiceAutoSend={false}
        onToggleVoiceReadback={vi.fn()}
        onStopSpeaking={vi.fn()}
        onToggleVoiceAutoSend={vi.fn()}
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

    expect(htmlIdle).toContain('data-testid="composer-voice-mic-btn"');
    expect(htmlIdle).toContain('data-testid="composer-voice-autosend-btn"');
    expect(htmlIdle).toContain('data-testid="voice-readback-toggle-btn"');
    expect(htmlIdle).toContain('aria-pressed="false"');
    expect(htmlIdle).not.toContain('data-testid="voice-stop-speaking-btn"');

    const htmlSpeaking = renderToStaticMarkup(
      <UnifiedChat
        snapshot={makeSnapshot({ voiceReadbackEnabled: true })}
        composerText=""
        attachments={[]}
        voiceReadbackEnabled={true}
        isSpeaking={true}
        voiceAutoSend={true}
        onToggleVoiceReadback={vi.fn()}
        onStopSpeaking={vi.fn()}
        onToggleVoiceAutoSend={vi.fn()}
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

    expect(htmlSpeaking).toContain('data-testid="voice-stop-speaking-btn"');
    expect(htmlSpeaking).toContain("読み上げ停止");
  });

  it("renders VoiceSettingsSection in SettingsModal and triggers callbacks on click", () => {
    const onSetVoiceReadbackEnabled = vi.fn();
    const onSetVoiceAutoSend = vi.fn();

    const html = renderToStaticMarkup(
      <SettingsModal
        defaultIntegrationMode="feature-branch"
        preferredLanguage="ja"
        voiceReadbackEnabled={false}
        voiceAutoSend={false}
        projects={[]}
        onClose={vi.fn()}
        onSetDefaultIntegrationMode={vi.fn()}
        onSetProjectIntegrationMode={vi.fn()}
        onSetVoiceReadbackEnabled={onSetVoiceReadbackEnabled}
        onSetVoiceAutoSend={onSetVoiceAutoSend}
      />,
    );

    expect(html).toContain('data-testid="voice-settings-section"');
    expect(html).toContain('data-testid="voice-readback-toggle"');
    expect(html).toContain('data-testid="voice-autosend-toggle"');
    expect(html).toContain("発話終了時に自動送信");

    const tree = VoiceSettingsSection({
      voiceReadbackEnabled: false,
      voiceAutoSend: false,
      onSetVoiceReadbackEnabled,
      onSetVoiceAutoSend,
    });

    const readbackSwitch = findElementByTestId(tree, "voice-readback-toggle");
    expect(readbackSwitch).not.toBeNull();
    (readbackSwitch!.props.onClick as () => void)();
    expect(onSetVoiceReadbackEnabled).toHaveBeenCalledWith(true);

    const autoSendSwitch = findElementByTestId(tree, "voice-autosend-toggle");
    expect(autoSendSwitch).not.toBeNull();
    (autoSendSwitch!.props.onClick as () => void)();
    expect(onSetVoiceAutoSend).toHaveBeenCalledWith(true);
  });
});
