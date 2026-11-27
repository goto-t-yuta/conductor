import crypto from "node:crypto";
import path from "node:path";
import { app, BrowserWindow, Menu, dialog, ipcMain, protocol, shell, systemPreferences } from "electron";
import type {
  AgentProvider,
  AgentTaskStatus,
  BrowserBounds,
  ChatAttachment,
  IntegrationMode,
  PreferredLanguage,
  SendMessagePayload,
  TaskStatusUpdateOptions,
  TerminalCreateOptions,
  UsageBudgetSettings,
  VoiceMicPermissionResult,
  VoiceSpeakRequest,
} from "../shared/types.js";
import { AppUpdater } from "./app-updater.js";
import { loadAppIcon } from "./app-icon.js";
import { BrowserManager } from "./browser-manager.js";
import { ConductorController } from "./conductor-controller.js";
import { readLocalImageFile } from "./image-viewer.js";
import {
  CONDUCTOR_MEDIA_PROTOCOL,
  handleConductorMediaRequest,
  readLocalVideoFile,
} from "./media-viewer.js";
import {
  MarkdownFileWatcher,
  readLocalMarkdownFile,
  writeLocalMarkdownFile,
} from "./markdown-viewer.js";
import { installMainWindowNavigationGuard } from "./main-window-guard.js";
import { registerProjectFileTreeIpcHandlers } from "./project-files.js";
import { QuitGuard, buildUpdateRestartConfirmationDialog } from "./quit-guard.js";
import { StateStore } from "./state-store.js";
import { TerminalManager } from "./terminal-manager.js";
import { VoiceTtsManager } from "./voice-tts.js";

let mainWindow: BrowserWindow | null = null;
let browserManager: BrowserManager | null = null;
let markdownWatcher: MarkdownFileWatcher | null = null;
let terminalManager: TerminalManager | null = null;
let controller: ConductorController | null = null;
let stateStore: StateStore | null = null;
let createWindowPromise: Promise<void> | null = null;
let appUpdater: AppUpdater | null = null;
let startupUpdateTimer: ReturnType<typeof setTimeout> | null = null;
let hasRunStartupUpdateCheck = false;
const voiceTts = new VoiceTtsManager();

function getAppUpdater(): AppUpdater {
  if (appUpdater) return appUpdater;
  const buildVersion = process.env.CONDUCTOR_BUILD_VERSION?.trim() || app.getVersion() || "0.1.0";
  const buildTag = process.env.CONDUCTOR_BUILD_TAG?.trim() || null;
  const buildSha = process.env.CONDUCTOR_BUILD_SHA?.trim() || null;
  const rawRunNumber = process.env.CONDUCTOR_BUILD_RUN_NUMBER?.trim() || "";
  const buildRunNumber = /^\d+$/.test(rawRunNumber) ? Number(rawRunNumber) : null;
  const isDevMode = !app.isPackaged || Boolean(process.env.CONDUCTOR_DEV_SERVER_URL);
  const downloadsDir = path.join(app.getPath("downloads"), "Conductor-Updates");

  appUpdater = new AppUpdater({
    currentVersion: buildVersion,
    currentTag: buildTag,
    currentCommitSha: buildSha,
    currentRunNumber: buildRunNumber,
    isDevMode,
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    downloadsDir,
    openPath: (filePath) => shell.openPath(filePath),
    showItemInFolder: (filePath) => shell.showItemInFolder(filePath),
    openExternal: (url) => shell.openExternal(url),
    onStateChange: (state) => sendToRenderer("updater:stateChanged", state),
    requestRestartForUpdate: async ({ versionTag, onConfirmed }) => {
      const runningTasks = controller?.getRunningTasks() ?? [];
      return quitGuard.requestQuit({
        dialogContent:
          runningTasks.length > 0
            ? buildUpdateRestartConfirmationDialog(runningTasks, versionTag)
            : undefined,
        onConfirmedBeforeShutdown: onConfirmed,
      });
    },
  });
  return appUpdater;
}

const SHUTDOWN_TIMEOUT_MS = 3_000;

const quitGuard = new QuitGuard({
  getRunningTasks: () => controller?.getRunningTasks() ?? [],
  showConfirmationDialog: async (content) => {
    const targetWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const result = targetWindow
      ? await dialog.showMessageBox(targetWindow, content)
      : await dialog.showMessageBox(content);
    return result.response === 1;
  },
  performShutdown: async () => {
    if (startupUpdateTimer) {
      clearTimeout(startupUpdateTimer);
      startupUpdateTimer = null;
    }
    voiceTts.stop();
    markdownWatcher?.dispose();
    markdownWatcher = null;
    terminalManager?.disposeAll();
    browserManager?.destroyAll();
    if (controller) {
      await Promise.race([
        controller.shutdown(),
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
      ]);
    }
    // Launch detached macOS apply helper right before exit if a staged update is armed
    // (either via "Restart & Update Now" or "Apply automatically on quit").
    appUpdater?.launchPendingApplyHelperOnShutdown();
    appUpdater?.dispose();
  },
  quitApp: () => {
    app.quit();
  },
});

function sendToRenderer(channel: string, payload: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function createApplicationMenu(): void {
  const isMac = process.platform === "darwin";
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              {
                label: "アップデートを確認...",
                click: () => {
                  sendToRenderer("conductor:shortcut", "check-updates");
                  void getAppUpdater().checkForUpdates({ silent: false });
                },
              },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "新しいチャット",
          accelerator: "CmdOrCtrl+N",
          click: () => sendToRenderer("conductor:shortcut", "new-chat"),
        },
        {
          label: "プロジェクトフォルダを追加...",
          accelerator: "CmdOrCtrl+O",
          click: () => sendToRenderer("conductor:shortcut", "add-project"),
        },
        {
          label: "ディレクトリ配下のプロジェクトを一括追加...",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => sendToRenderer("conductor:shortcut", "scan-directory"),
        },
        {
          label: "Markdown ファイルを開く...",
          accelerator: "CmdOrCtrl+Alt+O",
          click: () => sendToRenderer("conductor:shortcut", "open-markdown-file"),
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "Workspace",
      submenu: [
        {
          label: "タスク一覧を表示/非表示",
          accelerator: "CmdOrCtrl+B",
          click: () => sendToRenderer("conductor:shortcut", "toggle-sidebar"),
        },
        {
          label: "In-App Browser を表示/非表示",
          accelerator: "CmdOrCtrl+\\",
          click: () => sendToRenderer("conductor:shortcut", "toggle-browser"),
        },
        {
          label: "Markdown Viewer に切替",
          accelerator: "CmdOrCtrl+Shift+M",
          click: () => sendToRenderer("conductor:shortcut", "toggle-markdown-viewer"),
        },
        {
          label: "新しいターミナルタブを開く",
          accelerator: "CmdOrCtrl+Shift+T",
          click: () => sendToRenderer("conductor:shortcut", "new-terminal"),
        },
        { type: "separator" },
        {
          label: "ブラウザ要素選択モード",
          accelerator: "CmdOrCtrl+Shift+P",
          click: () => sendToRenderer("conductor:shortcut", "toggle-picker"),
        },
        {
          label: "ブラウザ画面スクショを添付",
          accelerator: "CmdOrCtrl+Shift+S",
          click: () => sendToRenderer("conductor:shortcut", "capture-screenshot"),
        },
        {
          label: "ブラウザ DevTools を開閉",
          accelerator: "CmdOrCtrl+Alt+I",
          click: () => browserManager?.toggleDevTools(),
        },
        { type: "separator" },
        {
          label: "Conductor UI DevTools",
          accelerator: "CmdOrCtrl+Shift+Alt+I",
          click: () => mainWindow?.webContents.toggleDevTools(),
        },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "front" }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpcHandlers(): void {
  ipcMain.handle("conductor:getSnapshot", () => controller?.getSnapshot());
  ipcMain.handle("conductor:reconnect", () => controller?.start());
  ipcMain.handle("conductor:setChatProvider", (_e, provider: AgentProvider) =>
    controller?.setChatProvider(provider),
  );
  ipcMain.handle("conductor:setWorkerProvider", (_e, provider: AgentProvider) =>
    controller?.setWorkerProvider(provider),
  );
  ipcMain.handle("conductor:setChatModel", (_e, model: string, effort?: string) =>
    controller?.setChatModel(model, effort),
  );
  ipcMain.handle("conductor:setWorkerModel", (_e, model: string, effort?: string) =>
    controller?.setWorkerModel(model, effort),
  );
  ipcMain.handle("conductor:dismissError", () => controller?.dismissError());
  ipcMain.handle("conductor:setLayout", (_e, patch: { showTaskSidebar?: boolean; showBrowserPane?: boolean }) =>
    controller?.setLayout(patch),
  );

  ipcMain.handle("conductor:addProjectDialog", async () => {
    if (!mainWindow || !controller) return [];
    const res = await dialog.showOpenDialog(mainWindow, {
      title: "プロジェクトフォルダを追加",
      properties: ["openDirectory", "multiSelections"],
      buttonLabel: "追加",
    });
    if (res.canceled) return [];
    return res.filePaths
      .map((p) => controller!.registerProject(p))
      .filter((p): p is NonNullable<typeof p> => Boolean(p));
  });

  ipcMain.handle("conductor:scanDirectoryDialog", async () => {
    if (!mainWindow || !controller) return [];
    const res = await dialog.showOpenDialog(mainWindow, {
      title: "配下のプロジェクトを一括スキャンする親ディレクトリを選択",
      properties: ["openDirectory", "multiSelections"],
      buttonLabel: "配下を一括追加",
    });
    if (res.canceled) return [];
    return res.filePaths.flatMap((dir) => controller!.scanDirectoryAndRegisterProjects(dir));
  });

  ipcMain.handle("conductor:rescanProjects", () => controller?.rescanAllProjects());

  ipcMain.handle("conductor:removeProject", (_e, projectId: string) => controller?.removeProject(projectId));
  ipcMain.handle("conductor:openPathInFinder", (_e, targetPath: string) => {
    shell.showItemInFolder(targetPath);
  });

  ipcMain.handle("conductor:sendMessage", (_e, payload: SendMessagePayload) => controller?.sendMessage(payload));
  ipcMain.handle("conductor:stopMessage", (_e, messageId: string) => controller?.stopMessage(messageId));
  ipcMain.handle("conductor:stopAllResponders", () => controller?.stopAllResponders());
  ipcMain.handle("conductor:startFreshChat", () => controller?.startFreshChat());
  ipcMain.handle("conductor:selectChatSession", (_e, sessionId: string) =>
    controller?.selectChatSession(sessionId),
  );
  ipcMain.handle("conductor:deleteChatSession", (_e, sessionId: string) =>
    controller?.deleteChatSession(sessionId),
  );

  ipcMain.handle("conductor:pickLocalImages", async (): Promise<ChatAttachment[]> => {
    if (!mainWindow || !stateStore) return [];
    const res = await dialog.showOpenDialog(mainWindow, {
      title: "画像を添付",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
    });
    if (res.canceled) return [];
    return res.filePaths.map((filePath) => ({
      id: crypto.randomUUID(),
      kind: "image" as const,
      label: path.basename(filePath),
      imagePath: filePath,
      imageDataUrl: stateStore!.imageFileToDataUrl(filePath),
    }));
  });

  ipcMain.handle("conductor:savePastedImage", (_e, base64Png: string): ChatAttachment | null => {
    if (!stateStore) return null;
    try {
      const cleaned = base64Png.replace(/^data:image\/\w+;base64,/, "");
      const buf = Buffer.from(cleaned, "base64");
      const saved = stateStore.savePngBuffer(buf, "paste");
      return {
        id: crypto.randomUUID(),
        kind: "image",
        label: "Pasted Image",
        imagePath: saved.imagePath,
        imageDataUrl: saved.imageDataUrl,
      };
    } catch {
      return null;
    }
  });

  ipcMain.handle("conductor:setDefaultIntegrationMode", (_e, mode: IntegrationMode) =>
    controller?.setDefaultIntegrationMode(mode),
  );
  ipcMain.handle("conductor:setAutoLandOnComplete", (_e, enabled: boolean) =>
    controller?.setAutoLandOnComplete(Boolean(enabled)),
  );
  ipcMain.handle(
    "conductor:setProjectIntegrationMode",
    (_e, projectId: string, mode: IntegrationMode | null) =>
      controller?.setProjectIntegrationMode(projectId, mode),
  );
  ipcMain.handle("conductor:setPreferredLanguage", (_e, language: PreferredLanguage) =>
    controller?.setPreferredLanguage(language),
  );
  ipcMain.handle("conductor:setVoiceReadbackEnabled", (_e, enabled: boolean) => {
    const next = Boolean(enabled);
    if (!next) {
      voiceTts.stop();
    }
    controller?.setVoiceReadbackEnabled(next);
  });
  ipcMain.handle("conductor:setRemoteAccessEnabled", (_e, enabled: boolean) =>
    controller?.setRemoteAccessEnabled(Boolean(enabled)),
  );
  ipcMain.handle("conductor:setRemoteAccessPort", (_e, port: number) =>
    controller?.setRemoteAccessPort(Number(port)),
  );
  ipcMain.handle("conductor:regenerateRemoteAccessToken", () =>
    controller?.regenerateRemoteAccessToken(),
  );
  ipcMain.handle("conductor:refreshRemoteAccessStatus", () =>
    controller?.refreshRemoteAccessStatus(),
  );
  ipcMain.handle("conductor:clearUsageRecords", () => controller?.clearUsageRecords());
  ipcMain.handle("conductor:setUsageBudgets", (_e, budgets: UsageBudgetSettings) =>
    controller?.setUsageBudgets(budgets),
  );
  ipcMain.handle(
    "conductor:refreshProviderQuotas",
    () => controller?.refreshProviderQuotas() ?? {},
  );

  // Voice IPC (OS-standard TTS & macOS Microphone permission)
  ipcMain.handle("voice:speak", (_e, request: VoiceSpeakRequest) =>
    voiceTts.speak(request ?? { text: "" }),
  );
  ipcMain.handle("voice:stop", () => {
    voiceTts.stop();
  });
  ipcMain.handle("voice:requestMicPermission", async (): Promise<VoiceMicPermissionResult> => {
    if (process.platform !== "darwin") {
      return { granted: true, status: "granted", platform: process.platform };
    }
    try {
      const currentStatus = systemPreferences.getMediaAccessStatus("microphone");
      if (currentStatus === "granted") {
        return { granted: true, status: "granted", platform: "darwin" };
      }
      if (currentStatus === "not-determined") {
        const granted = await systemPreferences.askForMediaAccess("microphone");
        return {
          granted,
          status: granted ? "granted" : "denied",
          platform: "darwin",
        };
      }
      return { granted: false, status: currentStatus, platform: "darwin" };
    } catch {
      return { granted: false, status: "error", platform: "darwin" };
    }
  });

  ipcMain.handle(
    "conductor:updateTaskStatus",
    (_e, taskId: string, status: AgentTaskStatus, options?: TaskStatusUpdateOptions) =>
      controller?.updateTaskStatus(taskId, status, options) ?? {
        ok: false,
        error: "Controller not initialized",
      },
  );
  ipcMain.handle("conductor:stopTaskWorker", (_e, taskId: string) => controller?.stopTaskWorker(taskId));
  ipcMain.handle("conductor:deleteTask", (_e, taskId: string) => controller?.deleteTask(taskId));
  ipcMain.handle("conductor:getTaskGitStatus", (_e, taskId: string) => controller?.getTaskGitStatus(taskId) ?? null);
  ipcMain.handle("conductor:getTaskWorktreeStatus", (_e, taskId: string) =>
    controller?.getTaskWorktreeStatus(taskId) ?? null,
  );
  ipcMain.handle(
    "conductor:landTask",
    (_e, taskId: string, options?: { createPr?: boolean }) =>
      controller?.landTask(taskId, options) ?? {
        ok: false,
        mode: "feature-branch",
        action: "error",
        message: "Controller not initialized",
      },
  );
  ipcMain.handle("conductor:syncTaskLandStatus", (_e, taskId: string) =>
    controller?.syncTaskLandStatus(taskId) ?? {
      ok: false,
      updated: false,
      reason: "error",
      message: "Controller not initialized",
    },
  );
  ipcMain.handle("conductor:resolveTaskConflictWithAI", (_e, taskId: string) =>
    controller?.resolveTaskConflictWithAI(taskId) ?? {
      ok: false,
      error: "Controller not initialized",
    },
  );
  ipcMain.handle("conductor:cleanupTaskWorktree", (_e, taskId: string) =>
    controller?.cleanupTaskWorktree(taskId) ?? { ok: false, error: "Controller not initialized" },
  );

  // Browser IPC
  ipcMain.handle("browser:setBounds", (_e, bounds: BrowserBounds) => browserManager?.setBounds(bounds));
  ipcMain.handle(
    "browser:navigate",
    (_e, url: string, newTab?: boolean, projectId?: string | null) =>
      browserManager?.navigate(url, Boolean(newTab), projectId),
  );
  ipcMain.handle("browser:newTab", (_e, url?: string, projectId?: string | null) =>
    browserManager?.createTab(url ?? "", undefined, undefined, true, projectId),
  );
  ipcMain.handle("browser:selectTab", (_e, tabId: string) => browserManager?.selectTab(tabId));
  ipcMain.handle("browser:closeTab", (_e, tabId: string) => browserManager?.closeTab(tabId));
  ipcMain.handle("browser:back", () => browserManager?.goBack());
  ipcMain.handle("browser:forward", () => browserManager?.goForward());
  ipcMain.handle("browser:reload", () => browserManager?.reloadOrStop());
  ipcMain.handle("browser:toggleDevTools", () => browserManager?.toggleDevTools());
  ipcMain.handle("browser:toggleElementPicker", () =>
    browserManager?.setElementPicker(!browserManager.isPickingElement()),
  );
  ipcMain.handle("browser:captureScreenshot", () => browserManager?.captureViewportAttachment() ?? null);
  ipcMain.handle("browser:getConsoleAttachment", () => browserManager?.getConsoleErrorsAttachment() ?? null);
  ipcMain.handle("browser:openExternal", () => browserManager?.openExternal());

  // Local Markdown Viewer IPC
  ipcMain.handle("markdown:openDialog", async (): Promise<string[]> => {
    if (!mainWindow) return [];
    const res = await dialog.showOpenDialog(mainWindow, {
      title: "Markdown ファイルを開く",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd", "mdx"] }],
      buttonLabel: "開く",
    });
    if (res.canceled) return [];
    return res.filePaths;
  });

  ipcMain.handle(
    "markdown:readFile",
    (_e, filePathOrUrl: string, baseFilePath?: string) =>
      readLocalMarkdownFile(filePathOrUrl, baseFilePath),
  );

  ipcMain.handle(
    "markdown:write-file",
    (_e, filePathOrUrl: string, content: string) => {
      const result = writeLocalMarkdownFile(filePathOrUrl, content);
      if (result.ok && result.document) {
        markdownWatcher?.recordKnownDocument(result.document);
      }
      return result;
    },
  );

  ipcMain.handle("markdown:watchFile", (_e, filePathOrUrl: string) => {
    if (!markdownWatcher) {
      markdownWatcher = new MarkdownFileWatcher((event) =>
        sendToRenderer("markdown:fileChanged", event),
      );
    }
    return markdownWatcher.watch(filePathOrUrl);
  });

  ipcMain.handle("markdown:unwatch", () => {
    markdownWatcher?.unwatch();
  });

  // Local Image & Video Viewer IPC
  ipcMain.handle("image:readFile", (_e, filePathOrUrl: string, baseFilePath?: string) =>
    readLocalImageFile(filePathOrUrl, baseFilePath),
  );
  ipcMain.handle("media:readVideo", (_e, filePathOrUrl: string, baseFilePath?: string) =>
    readLocalVideoFile(filePathOrUrl, baseFilePath),
  );

  // Project File Tree read-only IPC (fs:list-dir, fs:read-text-file)
  registerProjectFileTreeIpcHandlers(ipcMain);

  // Interactive Terminal (PTY) IPC
  terminalManager = new TerminalManager({
    onData: (event) => sendToRenderer("terminal:data", event),
    onExit: (event) => sendToRenderer("terminal:exit", event),
  });

  ipcMain.handle("terminal:create", (_e, options?: TerminalCreateOptions) =>
    terminalManager?.create(options) ?? { ok: false, error: "Terminal manager not initialized" },
  );
  ipcMain.handle("terminal:write", (_e, sessionId: string, data: string) =>
    terminalManager?.write(sessionId, data) ?? { ok: false, error: "Terminal manager not initialized" },
  );
  ipcMain.handle("terminal:resize", (_e, sessionId: string, cols: number, rows: number) =>
    terminalManager?.resize(sessionId, cols, rows) ?? {
      ok: false,
      error: "Terminal manager not initialized",
    },
  );
  ipcMain.handle("terminal:close", (_e, sessionId: string) =>
    terminalManager?.close(sessionId) ?? { ok: false },
  );

  // App Updates (GitHub Releases) IPC
  ipcMain.handle("updater:getState", () => getAppUpdater().getState());
  ipcMain.handle("updater:check", () => getAppUpdater().checkForUpdates({ silent: false }));
  ipcMain.handle("updater:downloadAndOpen", () => getAppUpdater().downloadAndOpen());
  ipcMain.handle("updater:cancelDownload", () => getAppUpdater().cancelDownload());
  ipcMain.handle("updater:openDownloaded", () => getAppUpdater().openDownloaded());
  ipcMain.handle("updater:showInFolder", () => getAppUpdater().showDownloadedInFolder());
  ipcMain.handle("updater:openReleasePage", (_e, url?: string) =>
    getAppUpdater().openReleasePage(url),
  );
  ipcMain.handle("updater:installAndRestart", () => getAppUpdater().installAndRestart());
  ipcMain.handle("updater:setApplyOnQuit", (_e, enabled: boolean) =>
    getAppUpdater().setApplyOnQuit(Boolean(enabled)),
  );
}

async function createWindow(): Promise<void> {
  if (createWindowPromise) {
    return createWindowPromise;
  }
  const run = (async () => {
    const previousController = controller;
    if (previousController) {
      controller = null;
      await Promise.race([
        previousController.shutdown().catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
      ]);
    }
    browserManager?.destroyAll();
    browserManager = null;

    stateStore = new StateStore(path.join(app.getPath("userData"), "conductor-data"));
    const windowIcon = loadAppIcon();

    mainWindow = new BrowserWindow({
      width: 1520,
      height: 920,
      minWidth: 960,
      minHeight: 620,
      title: "Conductor",
      ...(windowIcon ? { icon: windowIcon } : {}),
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 14, y: 12 },
      backgroundColor: "#0f1115",
      webPreferences: {
        preload: path.join(__dirname, "../preload/index.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    const nextBrowserManager = new BrowserManager({
      window: mainWindow,
      store: stateStore,
      onTabsChanged: (reason) => {
        if (browserManager !== nextBrowserManager) return;
        controller?.notifyBrowserChanged({ persist: reason !== "transient" });
      },
      onElementPicked: (attachment) => {
        if (browserManager !== nextBrowserManager) return;
        sendToRenderer("conductor:browserAttachment", attachment);
      },
    });
    browserManager = nextBrowserManager;

    const nextController = new ConductorController({
      store: stateStore,
      browser: nextBrowserManager,
      onSnapshot: (snapshot) => {
        if (controller !== nextController) return;
        sendToRenderer("conductor:snapshot", snapshot);
      },
    });
    controller = nextController;

    const devUrl = process.env.CONDUCTOR_DEV_SERVER_URL;
    const rendererHtmlPath = path.join(__dirname, "../renderer/index.html");

    installMainWindowNavigationGuard(mainWindow.webContents, {
      devServerUrl: devUrl,
      rendererHtmlPath,
      onOpenInAppBrowser: (url) => {
        if (controller !== nextController || browserManager !== nextBrowserManager) return;
        nextController.setLayout({ showBrowserPane: true });
        void nextBrowserManager.navigate(url, true);
      },
    });

    mainWindow.webContents.session.setPermissionRequestHandler(
      (_webContents, permission, callback) => {
        if (permission === "clipboard-sanitized-write") {
          callback(true);
          return;
        }
        if (permission === "media") {
          if (process.platform === "darwin") {
            const status = systemPreferences.getMediaAccessStatus("microphone");
            if (status === "granted") {
              callback(true);
              return;
            }
            if (status === "not-determined") {
              void systemPreferences
                .askForMediaAccess("microphone")
                .then((granted) => callback(granted))
                .catch(() => callback(false));
              return;
            }
            callback(false);
            return;
          }
          callback(true);
          return;
        }
        callback(false);
      },
    );
    if (devUrl) {
      await mainWindow.loadURL(devUrl);
    } else {
      await mainWindow.loadFile(rendererHtmlPath);
    }

    mainWindow.on("closed", () => {
      voiceTts.stop();
      markdownWatcher?.dispose();
      markdownWatcher = null;
      terminalManager?.disposeAll();
      browserManager?.destroyAll();
      mainWindow = null;
    });

    void nextController.start();

    // Check for updates once in the background shortly after startup (silently ignores network failures)
    if (!hasRunStartupUpdateCheck) {
      hasRunStartupUpdateCheck = true;
      startupUpdateTimer = setTimeout(() => {
        startupUpdateTimer = null;
        void getAppUpdater().checkForUpdates({ silent: true });
      }, 3_000);
      startupUpdateTimer.unref?.();
    }
  })();

  createWindowPromise = run;
  try {
    await run;
  } finally {
    if (createWindowPromise === run) {
      createWindowPromise = null;
    }
  }
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: CONDUCTOR_MEDIA_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

app.setName("Conductor");

app.whenReady().then(async () => {
  if (process.platform === "darwin" && app.dock) {
    const dockIcon = loadAppIcon();
    if (dockIcon) {
      app.dock.setIcon(dockIcon);
    }
  }
  protocol.handle(CONDUCTOR_MEDIA_PROTOCOL, (request) => handleConductorMediaRequest(request));
  createApplicationMenu();
  registerIpcHandlers();
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  void quitGuard.handleBeforeQuit(event);
});
