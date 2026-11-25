import { contextBridge, ipcRenderer, webUtils } from "electron";
import { PROJECT_FILE_TREE_IPC_CHANNELS } from "../shared/file-tree.js";
import type {
  AgentTaskStatus,
  AppSnapshot,
  BrowserBounds,
  ChatAttachment,
  ConductorAPI,
  IntegrationMode,
  MarkdownWatchEvent,
  PreferredLanguage,
  SendMessagePayload,
} from "../shared/types.js";

const api: ConductorAPI = {
  getSnapshot: () => ipcRenderer.invoke("conductor:getSnapshot"),
  onSnapshot: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: AppSnapshot) => listener(snapshot);
    ipcRenderer.on("conductor:snapshot", handler);
    return () => ipcRenderer.off("conductor:snapshot", handler);
  },
  onAttachmentFromBrowser: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, attachment: ChatAttachment) => listener(attachment);
    ipcRenderer.on("conductor:browserAttachment", handler);
    return () => ipcRenderer.off("conductor:browserAttachment", handler);
  },
  onShortcut: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, action: string) => listener(action);
    ipcRenderer.on("conductor:shortcut", handler);
    return () => ipcRenderer.off("conductor:shortcut", handler);
  },

  reconnect: () => ipcRenderer.invoke("conductor:reconnect"),
  setChatProvider: (provider) => ipcRenderer.invoke("conductor:setChatProvider", provider),
  setWorkerProvider: (provider) => ipcRenderer.invoke("conductor:setWorkerProvider", provider),
  setChatModel: (model, effort) => ipcRenderer.invoke("conductor:setChatModel", model, effort),
  setWorkerModel: (model, effort) => ipcRenderer.invoke("conductor:setWorkerModel", model, effort),
  dismissError: () => ipcRenderer.invoke("conductor:dismissError"),

  setLayout: (patch) => ipcRenderer.invoke("conductor:setLayout", patch),

  addProjectDialog: () => ipcRenderer.invoke("conductor:addProjectDialog"),
  scanDirectoryDialog: () => ipcRenderer.invoke("conductor:scanDirectoryDialog"),
  rescanProjects: () => ipcRenderer.invoke("conductor:rescanProjects"),
  removeProject: (projectId) => ipcRenderer.invoke("conductor:removeProject", projectId),
  openPathInFinder: (p) => ipcRenderer.invoke("conductor:openPathInFinder", p),

  sendMessage: (payload: SendMessagePayload) => ipcRenderer.invoke("conductor:sendMessage", payload),
  stopMessage: (messageId) => ipcRenderer.invoke("conductor:stopMessage", messageId),
  stopAllResponders: () => ipcRenderer.invoke("conductor:stopAllResponders"),
  startFreshChat: () => ipcRenderer.invoke("conductor:startFreshChat"),
  selectChatSession: (sessionId: string) =>
    ipcRenderer.invoke("conductor:selectChatSession", sessionId),
  deleteChatSession: (sessionId: string) =>
    ipcRenderer.invoke("conductor:deleteChatSession", sessionId),
  pickLocalImages: () => ipcRenderer.invoke("conductor:pickLocalImages"),
  savePastedImage: (base64Png) => ipcRenderer.invoke("conductor:savePastedImage", base64Png),

  setDefaultIntegrationMode: (mode: IntegrationMode) =>
    ipcRenderer.invoke("conductor:setDefaultIntegrationMode", mode),
  setAutoLandOnComplete: (enabled: boolean) =>
    ipcRenderer.invoke("conductor:setAutoLandOnComplete", enabled),
  setProjectIntegrationMode: (projectId: string, mode: IntegrationMode | null) =>
    ipcRenderer.invoke("conductor:setProjectIntegrationMode", projectId, mode),
  setPreferredLanguage: (language: PreferredLanguage) =>
    ipcRenderer.invoke("conductor:setPreferredLanguage", language),

  updateTaskStatus: (taskId: string, status: AgentTaskStatus) =>
    ipcRenderer.invoke("conductor:updateTaskStatus", taskId, status),
  stopTaskWorker: (taskId) => ipcRenderer.invoke("conductor:stopTaskWorker", taskId),
  deleteTask: (taskId) => ipcRenderer.invoke("conductor:deleteTask", taskId),
  getTaskGitStatus: (taskId) => ipcRenderer.invoke("conductor:getTaskGitStatus", taskId),
  getTaskWorktreeStatus: (taskId) => ipcRenderer.invoke("conductor:getTaskWorktreeStatus", taskId),
  landTask: (taskId, options) => ipcRenderer.invoke("conductor:landTask", taskId, options),
  resolveTaskConflictWithAI: (taskId) =>
    ipcRenderer.invoke("conductor:resolveTaskConflictWithAI", taskId),
  cleanupTaskWorktree: (taskId) => ipcRenderer.invoke("conductor:cleanupTaskWorktree", taskId),

  browserSetBounds: (bounds: BrowserBounds) => ipcRenderer.invoke("browser:setBounds", bounds),
  browserNavigate: (url, newTab, projectId) =>
    ipcRenderer.invoke("browser:navigate", url, newTab, projectId),
  browserNewTab: (url, projectId) => ipcRenderer.invoke("browser:newTab", url, projectId),
  browserSelectTab: (tabId) => ipcRenderer.invoke("browser:selectTab", tabId),
  browserCloseTab: (tabId) => ipcRenderer.invoke("browser:closeTab", tabId),
  browserBack: () => ipcRenderer.invoke("browser:back"),
  browserForward: () => ipcRenderer.invoke("browser:forward"),
  browserReload: () => ipcRenderer.invoke("browser:reload"),
  browserToggleDevTools: () => ipcRenderer.invoke("browser:toggleDevTools"),
  browserToggleElementPicker: () => ipcRenderer.invoke("browser:toggleElementPicker"),
  browserCaptureScreenshot: () => ipcRenderer.invoke("browser:captureScreenshot"),
  browserGetConsoleAttachment: () => ipcRenderer.invoke("browser:getConsoleAttachment"),
  browserOpenExternal: () => ipcRenderer.invoke("browser:openExternal"),

  markdownOpenDialog: () => ipcRenderer.invoke("markdown:openDialog"),
  markdownReadFile: (filePathOrUrl, baseFilePath) =>
    ipcRenderer.invoke("markdown:readFile", filePathOrUrl, baseFilePath),
  markdownWatchFile: (filePathOrUrl) => ipcRenderer.invoke("markdown:watchFile", filePathOrUrl),
  markdownUnwatch: () => ipcRenderer.invoke("markdown:unwatch"),
  onMarkdownFileChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, event: MarkdownWatchEvent) => listener(event);
    ipcRenderer.on("markdown:fileChanged", handler);
    return () => ipcRenderer.off("markdown:fileChanged", handler);
  },
  imageReadFile: (filePathOrUrl, baseFilePath) =>
    ipcRenderer.invoke("image:readFile", filePathOrUrl, baseFilePath),
  fsListDir: (dirPath, options) =>
    ipcRenderer.invoke(PROJECT_FILE_TREE_IPC_CHANNELS.listDir, dirPath, options),
  fsReadTextFile: (filePath, options) =>
    ipcRenderer.invoke(PROJECT_FILE_TREE_IPC_CHANNELS.readTextFile, filePath, options),
  getPathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
};

contextBridge.exposeInMainWorld("conductor", api);
