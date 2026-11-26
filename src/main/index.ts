import crypto from "node:crypto";
import path from "node:path";
import { app, BrowserWindow, Menu, dialog, ipcMain, shell, systemPreferences } from "electron";
import type {
  AgentProvider,
  AgentTaskStatus,
  BrowserBounds,
  ChatAttachment,
  IntegrationMode,
  PreferredLanguage,
  SendMessagePayload,
  VoiceMicPermissionResult,
  VoiceSpeakRequest,
} from "../shared/types.js";
import { BrowserManager } from "./browser-manager.js";
import { ConductorController } from "./conductor-controller.js";
import { readLocalImageFile } from "./image-viewer.js";
import {
  MarkdownFileWatcher,
  readLocalMarkdownFile,
  writeLocalMarkdownFile,
} from "./markdown-viewer.js";
import { registerProjectFileTreeIpcHandlers } from "./project-files.js";
import { QuitGuard } from "./quit-guard.js";
import { StateStore } from "./state-store.js";
import { VoiceTtsManager } from "./voice-tts.js";

let mainWindow: BrowserWindow | null = null;
let browserManager: BrowserManager | null = null;
let markdownWatcher: MarkdownFileWatcher | null = null;
let controller: ConductorController | null = null;
let stateStore: StateStore | null = null;
const voiceTts = new VoiceTtsManager();

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
    voiceTts.stop();
    markdownWatcher?.dispose();
    markdownWatcher = null;
    browserManager?.destroyAll();
    if (controller) {
      await Promise.race([
        controller.shutdown(),
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
      ]);
    }
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

  ipcMain.handle("conductor:updateTaskStatus", (_e, taskId: string, status: AgentTaskStatus) =>
    controller?.updateTaskStatus(taskId, status) ?? { ok: false, error: "Controller not initialized" },
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

  // Local Image Viewer IPC
  ipcMain.handle("image:readFile", (_e, filePathOrUrl: string, baseFilePath?: string) =>
    readLocalImageFile(filePathOrUrl, baseFilePath),
  );

  // Project File Tree read-only IPC (fs:list-dir, fs:read-text-file)
  registerProjectFileTreeIpcHandlers(ipcMain);
}

async function createWindow(): Promise<void> {
  stateStore = new StateStore(path.join(app.getPath("userData"), "conductor-data"));

  mainWindow = new BrowserWindow({
    width: 1520,
    height: 920,
    minWidth: 960,
    minHeight: 620,
    title: "Conductor",
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

  browserManager = new BrowserManager({
    window: mainWindow,
    store: stateStore,
    onTabsChanged: (reason) =>
      controller?.notifyBrowserChanged({ persist: reason !== "transient" }),
    onElementPicked: (attachment) => sendToRenderer("conductor:browserAttachment", attachment),
  });

  controller = new ConductorController({
    store: stateStore,
    browser: browserManager,
    onSnapshot: (snapshot) => sendToRenderer("conductor:snapshot", snapshot),
  });

  const devUrl = process.env.CONDUCTOR_DEV_SERVER_URL;
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
    await mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("closed", () => {
    voiceTts.stop();
    markdownWatcher?.dispose();
    markdownWatcher = null;
    browserManager?.destroyAll();
    mainWindow = null;
  });

  void controller.start();
}

app.setName("Conductor");

app.whenReady().then(async () => {
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
