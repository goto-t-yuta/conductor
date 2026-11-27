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
    canSelfUpdate: true,
    targetAppPath: "/Applications/Conductor.app",
    stagedAppPath: null,
    stagedVersionTag: null,
    applyOnQuit: false,
    lastCheckedAt: "2026-11-26T08:00:00.000Z",
    latestRelease: {
      tagName: "v0.1.0-42-1a351f7",
      version: "0.1.0",
      name: "Conductor v0.1.0-42-1a351f7",
      body: "## What's Changed\n- Added macOS background staging & one-click updater",
      notesExcerpt: "## What's Changed\n- Added macOS background staging & one-click updater",
      htmlUrl: "https://github.com/goto-t-yuta/conductor/releases/tag/v0.1.0-42-1a351f7",
      publishedAt: "2026-11-26T07:00:00.000Z",
      selectedAsset: {
        name: "Conductor-0.1.0-mac-arm64.zip",
        downloadUrl:
          "https://github.com/goto-t-yuta/conductor/releases/download/v0.1.0-42-1a351f7/Conductor-0.1.0-mac-arm64.zip",
        size: 95_000_000,
        contentType: "application/zip",
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
  it("renders available macOS background-prepare update with version, release notes, asset, and dev mode notice in ja and en", () => {
    const state = makeUpdateState({ isDevMode: true, canSelfUpdate: false, targetAppPath: null });

    const jaHtml = renderToStaticMarkup(
      <AppUpdateSettingsSection appUpdate={state} locale="ja" />,
    );
    expect(jaHtml).toContain("アプリのアップデート");
    expect(jaHtml).toContain("開発モード (pnpm dev)");
    expect(jaHtml).toContain('data-testid="app-update-dev-mode-notice"');
    expect(jaHtml).toContain("v0.1.0-41-aaaaaaa");
    expect(jaHtml).toContain("v0.1.0-42-1a351f7");
    expect(jaHtml).toContain("Conductor-0.1.0-mac-arm64.zip");
    expect(jaHtml).toContain("今すぐアップデートを準備");
    expect(jaHtml).toContain("リリースページを開く");

    const enHtml = renderToStaticMarkup(
      <AppUpdateSettingsSection appUpdate={state} locale="en" />,
    );
    expect(enHtml).toContain("App Updates");
    expect(enHtml).toContain("Dev Mode (pnpm dev)");
    expect(enHtml).toContain("Prepare Update Now");
    expect(enHtml).toContain("Open Release Page");
    expect(enHtml).not.toMatch(JAPANESE_CHAR_RE);
  });

  it("renders background downloading, background staging, and ready_to_install states cleanly in ja and en", () => {
    const downloadingHtml = renderToStaticMarkup(
      <AppUpdateSettingsSection
        appUpdate={makeUpdateState({
          status: "downloading",
          downloadProgress: {
            downloadedBytes: 47_500_000,
            totalBytes: 95_000_000,
            percent: 50,
          },
        })}
        locale="en"
      />,
    );
    expect(downloadingHtml).toContain('role="progressbar"');
    expect(downloadingHtml).toContain("50%");
    expect(downloadingHtml).toContain("Cancel Preparation");
    expect(downloadingHtml).not.toMatch(JAPANESE_CHAR_RE);

    const stagingHtml = renderToStaticMarkup(
      <AppUpdateSettingsSection
        appUpdate={makeUpdateState({
          status: "staging",
          downloadProgress: {
            downloadedBytes: 95_000_000,
            totalBytes: 95_000_000,
            percent: 100,
          },
        })}
        locale="en"
      />,
    );
    expect(stagingHtml).toContain('data-testid="app-update-staging-progress"');
    expect(stagingHtml).toContain("Extracting and verifying in the background");
    expect(stagingHtml).not.toMatch(JAPANESE_CHAR_RE);

    // Packaged macOS ready_to_install: Restart & Update Now enabled + apply-on-quit checkbox
    const readyJaHtml = renderToStaticMarkup(
      <AppUpdateSettingsSection
        appUpdate={makeUpdateState({
          status: "ready_to_install",
          stagedAppPath: "/tmp/conductor-staging/Conductor.app",
          stagedVersionTag: "v0.1.0-42-1a351f7",
          applyOnQuit: true,
        })}
        locale="ja"
      />,
    );
    expect(readyJaHtml).toContain('data-testid="app-update-ready-hint"');
    expect(readyJaHtml).toContain('data-testid="app-update-apply-on-quit-toggle"');
    expect(readyJaHtml).toContain('data-testid="app-update-restart-apply-btn"');
    expect(readyJaHtml).toContain("再起動して今すぐ適用");
    expect(readyJaHtml).toContain("アプリの通常終了時に自動で適用する");
    expect(readyJaHtml).toContain("/Applications/Conductor.app");

    const readyEnHtml = renderToStaticMarkup(
      <AppUpdateSettingsSection
        appUpdate={makeUpdateState({
          status: "ready_to_install",
          stagedAppPath: "/tmp/conductor-staging/Conductor.app",
          stagedVersionTag: "v0.1.0-42-1a351f7",
          applyOnQuit: true,
        })}
        locale="en"
      />,
    );
    expect(readyEnHtml).toContain("Restart &amp; Update Now");
    expect(readyEnHtml).toContain("Apply automatically when quitting Conductor");
    expect(readyEnHtml).not.toMatch(JAPANESE_CHAR_RE);

    // Dev mode ready_to_install: restart button is disabled and apply-on-quit toggle hidden
    const readyDevHtml = renderToStaticMarkup(
      <AppUpdateSettingsSection
        appUpdate={makeUpdateState({
          status: "ready_to_install",
          isDevMode: true,
          canSelfUpdate: false,
          targetAppPath: null,
          stagedAppPath: "/tmp/conductor-staging/Conductor.app",
          stagedVersionTag: "v0.1.0-42-1a351f7",
          applyOnQuit: false,
        })}
        locale="en"
      />,
    );
    expect(readyDevHtml).toContain('data-testid="app-update-restart-apply-btn" disabled=""');
    expect(readyDevHtml).not.toContain('data-testid="app-update-apply-on-quit-toggle"');
    expect(readyDevHtml).not.toMatch(JAPANESE_CHAR_RE);
  });

  it("renders non-macOS external installer download actions cleanly without macOS Gatekeeper hint", () => {
    const winAvailableHtml = renderToStaticMarkup(
      <AppUpdateSettingsSection
        appUpdate={makeUpdateState({
          platform: "win32",
          arch: "x64",
          canSelfUpdate: false,
          targetAppPath: null,
        })}
        locale="en"
      />,
    );
    expect(winAvailableHtml).toContain("Download &amp; Open");
    expect(winAvailableHtml).not.toMatch(JAPANESE_CHAR_RE);

    const downloadedWinHtml = renderToStaticMarkup(
      <AppUpdateSettingsSection
        appUpdate={makeUpdateState({
          status: "downloaded",
          platform: "win32",
          arch: "x64",
          canSelfUpdate: false,
          targetAppPath: null,
          downloadedFilePath: "C:\\Users\\test\\Downloads\\Conductor-0.1.0-win-x64-setup.exe",
          openedInstaller: true,
        })}
        locale="en"
      />,
    );
    expect(downloadedWinHtml).toContain("Open Installer");
    expect(downloadedWinHtml).toContain("Show in Folder");
    expect(downloadedWinHtml).not.toContain('data-testid="app-update-macos-gatekeeper-hint"');
    expect(downloadedWinHtml).not.toContain("xattr -cr");
    expect(downloadedWinHtml).not.toMatch(JAPANESE_CHAR_RE);

    const stagingErrHtml = renderToStaticMarkup(
      <AppUpdateSettingsSection
        appUpdate={makeUpdateState({
          status: "error",
          errorCode: "staging_failed",
          error: "Missing Info.plist",
        })}
        locale="en"
      />,
    );
    expect(stagingErrHtml).toContain('data-testid="app-update-error"');
    expect(stagingErrHtml).toContain("Your existing app was not modified");
    expect(stagingErrHtml).not.toMatch(JAPANESE_CHAR_RE);
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

  it("renders notification badge and dismissible update banner across available and ready_to_install states in UnifiedChat", () => {
    const baseProps = {
      composerText: "",
      attachments: [],
      onComposerTextChange: vi.fn(),
      onRemoveAttachment: vi.fn(),
      onAddAttachment: vi.fn(),
      onSend: vi.fn(),
      onStopMessage: vi.fn(),
      onStopAll: vi.fn(),
      onNewChat: vi.fn(),
      onSelectChatSession: vi.fn(),
      onDeleteChatSession: vi.fn(),
      onToggleSidebar: vi.fn(),
      onToggleBrowser: vi.fn(),
      onToggleMarkdownViewer: vi.fn(),
      onAddProject: vi.fn(),
      onOpenUrl: vi.fn(),
      onOpenMarkdownFile: vi.fn(),
      onOpenTask: vi.fn(),
      onToggleElementPicker: vi.fn(),
      onCaptureScreenshot: vi.fn(),
      onAttachCurrentUrl: vi.fn(),
      onAttachConsoleErrors: vi.fn(),
      onPickLocalImages: vi.fn(),
      onPasteImage: vi.fn(),
      onReconnect: vi.fn(),
      onDismissError: vi.fn(),
      onSetChatProvider: vi.fn(),
      onSetWorkerProvider: vi.fn(),
      onSetChatModel: vi.fn(),
      onSetWorkerModel: vi.fn(),
      onOpenSettings: vi.fn(),
    };

    const availableChatHtml = renderToStaticMarkup(
      <UnifiedChat
        {...baseProps}
        snapshot={makeSnapshot("en")}
        locale="en"
        appUpdate={makeUpdateState()}
        updateBannerDismissed={false}
        onDismissUpdateBanner={vi.fn()}
        onDownloadAndOpenUpdate={vi.fn()}
        onOpenUpdateReleasePage={vi.fn()}
      />,
    );
    expect(availableChatHtml).toContain('data-testid="settings-update-badge"');
    expect(availableChatHtml).toContain('data-testid="app-update-banner"');
    expect(availableChatHtml).toContain("New version v0.1.0-42-1a351f7 is available");
    expect(availableChatHtml).toContain("Prepare Update Now");
    expect(availableChatHtml).not.toMatch(JAPANESE_CHAR_RE);

    const readyChatHtml = renderToStaticMarkup(
      <UnifiedChat
        {...baseProps}
        snapshot={makeSnapshot("ja")}
        locale="ja"
        appUpdate={makeUpdateState({
          status: "ready_to_install",
          stagedAppPath: "/tmp/staging/Conductor.app",
          stagedVersionTag: "v0.1.0-42-1a351f7",
          applyOnQuit: true,
        })}
        updateBannerDismissed={false}
        onDismissUpdateBanner={vi.fn()}
        onInstallAndRestartUpdate={vi.fn()}
      />,
    );
    expect(readyChatHtml).toContain('data-testid="app-update-banner-restart-btn"');
    expect(readyChatHtml).toContain("再起動して今すぐ適用");
    expect(readyChatHtml).toContain("終了時に自動適用");

    const dismissedHtml = renderToStaticMarkup(
      <UnifiedChat
        {...baseProps}
        snapshot={makeSnapshot("ja")}
        locale="ja"
        appUpdate={makeUpdateState()}
        updateBannerDismissed={true}
        onDismissUpdateBanner={vi.fn()}
      />,
    );
    expect(dismissedHtml).toContain('data-testid="settings-update-badge"');
    expect(dismissedHtml).not.toContain('data-testid="app-update-banner"');
  });
});
