import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  AppUpdateSettingsSection,
  SettingsModal,
} from "../src/renderer/components/SettingsModal.js";
import { UnifiedChat } from "../src/renderer/components/UnifiedChat.js";
import type { AppSnapshot, AppUpdateState } from "../src/shared/types.js";

const JAPANESE_CHAR_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;

function makeUpdateState(overrides: Partial<AppUpdateState> = {}): AppUpdateState {
  return {
    status: "available",
    currentVersion: "0.1.0",
    currentTag: "v0.1.0-41-aaaaaaa",
    currentCommitSha: "aaaaaaa",
    currentRunNumber: 41,
    isDevMode: false,
    platform: "darwin",
    arch: "arm64",
    lastCheckedAt: "2026-11-26T08:00:00.000Z",
    latestRelease: {
      tagName: "v0.1.0-42-1a351f7",
      version: "0.1.0",
      name: "Conductor v0.1.0-42-1a351f7",
      body: "## What's Changed\n- Added GitHub Releases update checker",
      notesExcerpt: "## What's Changed\n- Added GitHub Releases update checker",
      htmlUrl: "https://github.com/goto-t-yuta/conductor/releases/tag/v0.1.0-42-1a351f7",
      publishedAt: "2026-11-26T07:00:00.000Z",
      selectedAsset: {
        name: "Conductor-0.1.0-mac-arm64.dmg",
        downloadUrl:
          "https://github.com/goto-t-yuta/conductor/releases/download/v0.1.0-42-1a351f7/Conductor-0.1.0-mac-arm64.dmg",
        size: 98_000_000,
        contentType: "application/x-apple-diskimage",
      },
      allAssetsCount: 10,
    },
    updateAvailable: true,
    downloadProgress: null,
    downloadedFilePath: null,
    openedInstaller: false,
    error: null,
    errorCode: null,
    ...overrides,
  };
}

function makeSnapshot(preferredLanguage: "ja" | "en" = "en"): AppSnapshot {
  return {
    projects: [],
    scanRoots: [],
    tasks: [],
    messages: [],
    activeChatSessionId: "sess-1",
    chatSessions: [],
    browserTabs: [],
    activeBrowserTabId: null,
    isPickingElement: false,
    showTaskSidebar: true,
    showBrowserPane: false,
    isConnected: true,
    connectionStatus: "Ready",
    activeResponderCount: 0,
    providers: {
      codex: { id: "codex", label: "Codex", available: true, detail: "ok", models: [] },
      agy: { id: "agy", label: "AGY", available: true, detail: "ok", models: [] },
      claude: { id: "claude", label: "Claude", available: true, detail: "ok", models: [] },
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
    preferredLanguage,
    lastErrorBanner: null,
  };
}

describe("AppUpdateSettingsSection & UnifiedChat update UI", () => {
  it("renders available update with version, release notes, asset, and action buttons in ja and en (no Japanese leak in en)", () => {
    const state = makeUpdateState({ isDevMode: true });

    const jaHtml = renderToStaticMarkup(
      <AppUpdateSettingsSection appUpdate={state} locale="ja" />,
    );
    expect(jaHtml).toContain("アプリのアップデート");
    expect(jaHtml).toContain("開発モード (pnpm dev)");
    expect(jaHtml).toContain("v0.1.0-41-aaaaaaa");
    expect(jaHtml).toContain("v0.1.0-42-1a351f7");
    expect(jaHtml).toContain("Conductor-0.1.0-mac-arm64.dmg");
    expect(jaHtml).toContain("今すぐダウンロードして開く");
    expect(jaHtml).toContain("リリースページを開く");

    const enHtml = renderToStaticMarkup(
      <AppUpdateSettingsSection appUpdate={state} locale="en" />,
    );
    expect(enHtml).toContain("App Updates");
    expect(enHtml).toContain("Dev Mode (pnpm dev)");
    expect(enHtml).toContain("Download &amp; Open");
    expect(enHtml).toContain("Open Release Page");
    expect(enHtml).not.toMatch(JAPANESE_CHAR_RE);
  });

  it("renders downloading progress bar and downloaded installer actions cleanly", () => {
    const downloadingHtml = renderToStaticMarkup(
      <AppUpdateSettingsSection
        appUpdate={makeUpdateState({
          status: "downloading",
          downloadProgress: {
            downloadedBytes: 49_000_000,
            totalBytes: 98_000_000,
            percent: 50,
          },
        })}
        locale="en"
      />,
    );
    expect(downloadingHtml).toContain('role="progressbar"');
    expect(downloadingHtml).toContain("50%");
    expect(downloadingHtml).toContain("Cancel Download");
    expect(downloadingHtml).not.toMatch(JAPANESE_CHAR_RE);

    const downloadedHtml = renderToStaticMarkup(
      <AppUpdateSettingsSection
        appUpdate={makeUpdateState({
          status: "downloaded",
          downloadedFilePath: "/Users/test/Downloads/Conductor-Updates/Conductor-0.1.0-mac-arm64.dmg",
          openedInstaller: true,
        })}
        locale="en"
      />,
    );
    expect(downloadedHtml).toContain("Open Installer");
    expect(downloadedHtml).toContain("Show in Folder");
    expect(downloadedHtml).toContain("Gatekeeper");
    expect(downloadedHtml).toContain('data-testid="app-update-macos-gatekeeper-hint"');
    expect(downloadedHtml).toContain("xattr -cr /Applications/Conductor.app");
    expect(downloadedHtml).not.toMatch(JAPANESE_CHAR_RE);

    const downloadedJaHtml = renderToStaticMarkup(
      <AppUpdateSettingsSection
        appUpdate={makeUpdateState({
          status: "downloaded",
          platform: "darwin",
          downloadedFilePath: "/Users/test/Downloads/Conductor-Updates/Conductor-0.1.0-mac-arm64.dmg",
          openedInstaller: false,
        })}
        locale="ja"
      />,
    );
    expect(downloadedJaHtml).toContain('data-testid="app-update-macos-gatekeeper-hint"');
    expect(downloadedJaHtml).toContain("xattr -cr /Applications/Conductor.app");
    expect(downloadedJaHtml).toContain("壊れているため開けません");

    // Non-macOS platforms should not display the macOS Gatekeeper xattr hint
    const downloadedWinHtml = renderToStaticMarkup(
      <AppUpdateSettingsSection
        appUpdate={makeUpdateState({
          status: "downloaded",
          platform: "win32",
          arch: "x64",
          downloadedFilePath: "C:\\Users\\test\\Downloads\\Conductor-0.1.0-win-x64-setup.exe",
          openedInstaller: true,
        })}
        locale="en"
      />,
    );
    expect(downloadedWinHtml).not.toContain('data-testid="app-update-macos-gatekeeper-hint"');
    expect(downloadedWinHtml).not.toContain("xattr -cr");
    expect(downloadedWinHtml).not.toMatch(JAPANESE_CHAR_RE);
  });

  it("renders AppUpdateSettingsSection inside SettingsModal when appUpdate is provided", () => {
    const modalHtml = renderToStaticMarkup(
      <SettingsModal
        defaultIntegrationMode="feature-branch"
        projects={[]}
        locale="en"
        appUpdate={makeUpdateState({ status: "up_to_date", updateAvailable: false })}
        onClose={vi.fn()}
        onSetDefaultIntegrationMode={vi.fn()}
        onSetProjectIntegrationMode={vi.fn()}
      />,
    );
    expect(modalHtml).toContain('data-testid="app-update-section"');
    expect(modalHtml).toContain("You are running the latest version of Conductor.");
    // Exclude the intentional native language name "日本語 (Japanese)" in LanguageSettingsSection
    expect(modalHtml.replace("日本語 (Japanese)", "")).not.toMatch(JAPANESE_CHAR_RE);
  });

  it("renders subtle notification badge and dismissible update banner in UnifiedChat", () => {
    const chatHtml = renderToStaticMarkup(
      <UnifiedChat
        snapshot={makeSnapshot("en")}
        locale="en"
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
        onOpenSettings={vi.fn()}
        appUpdate={makeUpdateState()}
        updateBannerDismissed={false}
        onDismissUpdateBanner={vi.fn()}
        onDownloadAndOpenUpdate={vi.fn()}
        onOpenUpdateReleasePage={vi.fn()}
      />,
    );
    expect(chatHtml).toContain('data-testid="settings-update-badge"');
    expect(chatHtml).toContain('data-testid="app-update-banner"');
    expect(chatHtml).toContain("New version v0.1.0-42-1a351f7 is available");
    expect(chatHtml).not.toMatch(JAPANESE_CHAR_RE);

    const dismissedHtml = renderToStaticMarkup(
      <UnifiedChat
        snapshot={makeSnapshot("ja")}
        locale="ja"
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
        onOpenSettings={vi.fn()}
        appUpdate={makeUpdateState()}
        updateBannerDismissed={true}
        onDismissUpdateBanner={vi.fn()}
      />,
    );
    // Settings badge remains visible even after dismissing the banner
    expect(dismissedHtml).toContain('data-testid="settings-update-badge"');
    expect(dismissedHtml).not.toContain('data-testid="app-update-banner"');
  });
});
