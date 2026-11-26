import type {
  ListDirectoryResult,
  ProjectFileEntry,
  ProjectFileKind,
  TextFileDocument,
  TextFileReadResult,
} from "./file-tree.js";
import type { PreferredLanguage } from "./language.js";
import type {
  TerminalBackendKind,
  TerminalCloseResult,
  TerminalCreateOptions,
  TerminalCreateResult,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalResizeResult,
  TerminalSessionInfo,
  TerminalWriteResult,
} from "./terminal.js";
import type { TokenUsage, UsagePeriod, UsageRecord, UsageSource, UsageSummary } from "./usage.js";
import type {
  VoiceMicPermissionResult,
  VoiceSpeakRequest,
  VoiceSpeakResult,
} from "./voice.js";

export type {
  ListDirectoryResult,
  ProjectFileEntry,
  ProjectFileKind,
  TextFileDocument,
  TextFileReadResult,
} from "./file-tree.js";
export type { PreferredLanguage } from "./language.js";
export type {
  TerminalBackendKind,
  TerminalCloseResult,
  TerminalCreateOptions,
  TerminalCreateResult,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalResizeResult,
  TerminalSessionInfo,
  TerminalWriteResult,
} from "./terminal.js";
export type { TokenUsage, UsagePeriod, UsageRecord, UsageSource, UsageSummary } from "./usage.js";
export type {
  VoiceMicPermissionResult,
  VoiceSpeakRequest,
  VoiceSpeakResult,
} from "./voice.js";

export type AgentProvider = "codex" | "agy" | "claude";

export interface ProviderStatus {
  id: AgentProvider;
  label: string;
  available: boolean;
  detail: string;
  models: ModelOption[];
}

export type ProjectSource = "manual" | "codex_history" | "workspace_scan";

export type IntegrationMode = "feature-branch" | "per-task-pr" | "direct";

export type TaskLandStatus =
  | "unlanded"
  | "landing"
  | "landed"
  | "pushed"
  | "pr_created"
  | "conflict"
  | "error";

export interface Project {
  id: string;
  name: string;
  path: string;
  colorHex: string;
  gitBranch: string | null;
  integrationMode?: IntegrationMode;
  addedAt: string;
  lastActiveAt?: string;
  source?: ProjectSource;
}

export const PROJECT_PALETTE = [
  "#3B82F6", // Blue
  "#10B981", // Emerald
  "#F59E0B", // Amber
  "#8B5CF6", // Violet
  "#EC4899", // Pink
  "#06B6D4", // Cyan
  "#EF4444", // Red
  "#84CC16", // Lime
] as const;

export type AgentTaskStatus = "queued" | "running" | "needs_review" | "done" | "failed";

export interface WorkerActivityEntry {
  id: string;
  kind: "command" | "file" | "message" | "reasoning" | "error" | "system";
  title: string;
  detail: string | null;
  timestamp: string;
}

export interface AgentTask {
  id: string;
  taskNumber: number;
  title: string;
  summary: string;
  projectId: string | null;
  projectName: string;
  projectPath: string | null;
  status: AgentTaskStatus;
  provider?: AgentProvider;
  autoResumeOnStartup?: boolean;
  workerPrompt?: string | null;
  lastWorkerPrompt?: string | null;
  workerModel?: string | null;
  workerEffort?: string | null;
  currentStep: string | null;
  workerThreadId: string | null;
  activeTurnId: string | null;
  previewURL: string | null;
  latestOutput: string;
  activities: WorkerActivityEntry[];
  worktreePath?: string | null;
  worktreeBranch?: string | null;
  baseBranch?: string | null;
  baseCommit?: string | null;
  landStatus?: TaskLandStatus;
  landedBranch?: string | null;
  landedCommit?: string | null;
  prUrl?: string | null;
  landError?: string | null;
  conflictFiles?: string[];
  conflictParentHead?: string | null;
  conflictTargetBranch?: string | null;
  autoResolveConflictAttempts?: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskWorktreeStatus {
  hasWorktree: boolean;
  worktreeExists: boolean;
  worktreePath: string | null;
  worktreeBranch: string | null;
  parentBranch: string | null;
  parentDirty: boolean;
  worktreeDirty: boolean;
  changedFilesCount: number;
  aheadCommits: number;
  diffSummary: string | null;
  effectiveMode: IntegrationMode;
  suggestedTargetBranch: string | null;
  ghAvailable: boolean;
}

export interface LandTaskResult {
  ok: boolean;
  mode: IntegrationMode;
  action: "landed" | "noop" | "pushed" | "pr_created" | "conflict" | "error";
  targetBranch?: string | null;
  parentHead?: string | null;
  commitHash?: string | null;
  prUrl?: string | null;
  message: string;
  conflictFiles?: string[];
}

export type ChatAttachmentKind = "image" | "browserElement" | "browserURL" | "taskRef" | "consoleErrors";

export interface ChatAttachment {
  id: string;
  kind: ChatAttachmentKind;
  label: string;
  imagePath?: string;
  imageDataUrl?: string;
  url?: string;
  metadataText?: string;
}

export type ChatMessageRole = "user" | "assistant" | "taskEvent" | "system";

export interface ToolActivityChip {
  id: string;
  toolName?: string;
  label: string;
  detail: string | null;
  isCompleted: boolean;
  isError: boolean;
}

export type ChatMessageMentionRef =
  | {
      kind: "project";
      projectId: string | null;
      projectName: string;
      projectPath: string | null;
      projectColorHex: string;
    }
  | {
      kind: "task";
      taskId: string;
      taskNumber: number;
      taskTitle: string;
      taskStatus?: AgentTaskStatus;
      projectId: string | null;
      projectName: string;
      projectPath: string | null;
      projectColorHex: string;
    };

export interface ChatMessage {
  id: string;
  role: ChatMessageRole;
  provider?: AgentProvider;
  text: string;
  reasoningSummary?: string;
  attachments: ChatAttachment[];
  mentions?: ChatMessageMentionRef[];
  inferredMentions?: ChatMessageMentionRef[];
  toolChips: ToolActivityChip[];
  relatedTaskId?: string;
  replyToMessageId?: string;
  replyToSnippet?: string;
  responderThreadId?: string;
  responderTurnId?: string;
  isStreaming: boolean;
  createdAt: string;
}

export interface ChatSessionBackendIds {
  codex?: string | null;
  agy?: string | null;
  claude?: string | null;
}

export interface ChatSession {
  id: string;
  title: string;
  preview: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
  provider?: AgentProvider;
  backendSessionIds?: ChatSessionBackendIds;
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  preview: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  provider?: AgentProvider;
}

export interface BrowserConsoleEntry {
  id: string;
  level: "error" | "warning" | "log";
  text: string;
  source?: string;
  line?: number;
  timestamp: string;
}

export interface BrowserNetworkError {
  id: string;
  url: string;
  method: string;
  status: number | null;
  errorText: string;
  timestamp: string;
}

export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  projectId?: string | null;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  consoleErrorCount: number;
  networkErrorCount: number;
}

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}

export type RightPaneMode = "browser" | "markdown" | "image" | "code" | "terminal";

export interface ImageReadResult {
  ok: boolean;
  filePath: string;
  fileName?: string;
  dataUrl?: string;
  mimeType?: string;
  sizeBytes?: number;
  error?: string;
}

export interface MarkdownDocument {
  filePath: string;
  fileName: string;
  content: string;
  mtimeMs: number;
  sizeBytes: number;
}

export interface MarkdownReadResult {
  ok: boolean;
  filePath: string;
  document?: MarkdownDocument;
  error?: string;
}

export interface MarkdownWriteResult {
  ok: boolean;
  filePath: string;
  document?: MarkdownDocument;
  error?: string;
}

export interface MarkdownWatchEvent {
  filePath: string;
  kind: "changed" | "deleted" | "error";
  document?: MarkdownDocument;
  error?: string;
}

export interface ModelOption {
  id: string;
  model: string;
  displayName: string;
  description: string;
  supportedEfforts: string[];
  defaultEffort: string;
  isDefault: boolean;
}

export interface RemoteAccessStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  token: string;
  bindHost: string | null;
  tailscaleIp: string | null;
  magicDnsName: string | null;
  lanIp: string | null;
  url: string | null;
  magicDnsUrl: string | null;
  connectUri: string | null;
  connectedClients: number;
  error: string | null;
}

export interface AppSnapshot {
  projects: Project[];
  scanRoots: string[];
  tasks: AgentTask[];
  messages: ChatMessage[];
  activeChatSessionId: string;
  chatSessions: ChatSessionSummary[];
  browserTabs: BrowserTab[];
  activeBrowserTabId: string | null;
  isPickingElement: boolean;
  showTaskSidebar: boolean;
  showBrowserPane: boolean;
  isConnected: boolean;
  connectionStatus: string;
  activeResponderCount: number;
  providers: Record<AgentProvider, ProviderStatus>;
  chatProvider: AgentProvider;
  workerProvider: AgentProvider;
  models: ModelOption[];
  chatModel: string | null;
  chatEffort: string | null;
  workerModel: string | null;
  workerEffort: string | null;
  defaultIntegrationMode: IntegrationMode;
  autoLandOnComplete: boolean;
  preferredLanguage: PreferredLanguage;
  voiceReadbackEnabled?: boolean;
  remoteAccessEnabled?: boolean;
  remoteAccessPort?: number;
  remoteAccessToken?: string;
  remoteAccess?: RemoteAccessStatus;
  usageRecords?: UsageRecord[];
  lastErrorBanner: string | null;
}

export interface PersistedState {
  projects: Project[];
  scanRoots: string[];
  tasks: AgentTask[];
  nextTaskNumber?: number;
  messages: ChatMessage[];
  chatSessions?: ChatSession[];
  activeChatSessionId?: string | null;
  browserTabs: Array<{ id: string; title: string; url: string; projectId?: string | null }>;
  activeBrowserTabId: string | null;
  showTaskSidebar: boolean;
  showBrowserPane: boolean;
  chatProvider?: AgentProvider;
  workerProvider?: AgentProvider;
  chatModel: string | null;
  chatEffort: string | null;
  workerModel: string | null;
  workerEffort: string | null;
  defaultIntegrationMode?: IntegrationMode;
  autoLandOnComplete?: boolean;
  preferredLanguage?: PreferredLanguage;
  voiceReadbackEnabled?: boolean;
  remoteAccessEnabled?: boolean;
  remoteAccessPort?: number;
  remoteAccessToken?: string;
  usageRecords?: UsageRecord[];
}

export interface TaskStatusUpdateResult {
  ok: boolean;
  error?: string;
}

export type ExplicitMentionTarget =
  | {
      kind: "project";
      projectId: string | null;
      projectName?: string;
      projectPath?: string | null;
      projectColorHex?: string;
    }
  | {
      kind: "task";
      taskId: string;
      taskNumber?: number;
      taskTitle?: string;
      taskStatus?: AgentTaskStatus;
      projectId?: string | null;
      projectName?: string;
      projectPath?: string | null;
      projectColorHex?: string;
    };

export interface SendMessagePayload {
  text: string;
  attachments: ChatAttachment[];
  mentions?: ExplicitMentionTarget[];
}

export interface ConductorAPI {
  getSnapshot(): Promise<AppSnapshot>;
  onSnapshot(listener: (snapshot: AppSnapshot) => void): () => void;
  onAttachmentFromBrowser(listener: (attachment: ChatAttachment) => void): () => void;
  onShortcut(listener: (action: string) => void): () => void;

  // Engine
  reconnect(): Promise<void>;
  setChatProvider(provider: AgentProvider): Promise<void>;
  setWorkerProvider(provider: AgentProvider): Promise<void>;
  setChatModel(model: string, effort?: string): Promise<void>;
  setWorkerModel(model: string, effort?: string): Promise<void>;
  dismissError(): Promise<void>;

  // Layout
  setLayout(patch: { showTaskSidebar?: boolean; showBrowserPane?: boolean }): Promise<void>;

  // Projects
  addProjectDialog(): Promise<Project[]>;
  scanDirectoryDialog(): Promise<Project[]>;
  rescanProjects(): Promise<void>;
  removeProject(projectId: string): Promise<void>;
  openPathInFinder(path: string): Promise<void>;

  // Chat (100% non-blocking)
  sendMessage(payload: SendMessagePayload): Promise<void>;
  stopMessage(messageId: string): Promise<void>;
  stopAllResponders(): Promise<void>;
  startFreshChat(): Promise<void>;
  selectChatSession(sessionId: string): Promise<void>;
  deleteChatSession(sessionId: string): Promise<void>;
  pickLocalImages(): Promise<ChatAttachment[]>;
  savePastedImage(base64Png: string): Promise<ChatAttachment | null>;

  // Settings & Integration
  setDefaultIntegrationMode(mode: IntegrationMode): Promise<void>;
  setAutoLandOnComplete(enabled: boolean): Promise<void>;
  setProjectIntegrationMode(projectId: string, mode: IntegrationMode | null): Promise<void>;
  setPreferredLanguage(language: PreferredLanguage): Promise<void>;
  setVoiceReadbackEnabled(enabled: boolean): Promise<void>;
  setRemoteAccessEnabled(enabled: boolean): Promise<RemoteAccessStatus>;
  setRemoteAccessPort(port: number): Promise<RemoteAccessStatus>;
  regenerateRemoteAccessToken(): Promise<RemoteAccessStatus>;
  refreshRemoteAccessStatus(): Promise<RemoteAccessStatus>;
  clearUsageRecords(): Promise<void>;

  // Voice (TTS & macOS Microphone Permission)
  voiceSpeak(request: VoiceSpeakRequest): Promise<VoiceSpeakResult>;
  voiceStop(): Promise<void>;
  voiceRequestMicPermission(): Promise<VoiceMicPermissionResult>;

  // Tasks
  updateTaskStatus(taskId: string, status: AgentTaskStatus): Promise<TaskStatusUpdateResult>;
  stopTaskWorker(taskId: string): Promise<void>;
  deleteTask(taskId: string): Promise<void>;
  getTaskGitStatus(taskId: string): Promise<string | null>;
  getTaskWorktreeStatus(taskId: string): Promise<TaskWorktreeStatus | null>;
  landTask(taskId: string, options?: { createPr?: boolean }): Promise<LandTaskResult>;
  resolveTaskConflictWithAI(taskId: string): Promise<{ ok: boolean; error?: string }>;
  cleanupTaskWorktree(taskId: string): Promise<{ ok: boolean; error?: string }>;

  // In-App Chromium Browser (WebContentsView + CDP)
  browserSetBounds(bounds: BrowserBounds): Promise<void>;
  browserNavigate(url: string, newTab?: boolean, projectId?: string | null): Promise<string | void>;
  browserNewTab(url?: string, projectId?: string | null): Promise<string | void>;
  browserSelectTab(tabId: string): Promise<void>;
  browserCloseTab(tabId: string): Promise<void>;
  browserBack(): Promise<void>;
  browserForward(): Promise<void>;
  browserReload(): Promise<void>;
  browserToggleDevTools(): Promise<void>;
  browserToggleElementPicker(): Promise<void>;
  browserCaptureScreenshot(): Promise<ChatAttachment | null>;
  browserGetConsoleAttachment(): Promise<ChatAttachment | null>;
  browserOpenExternal(): Promise<void>;

  // Local Markdown Viewer
  markdownOpenDialog(): Promise<string[]>;
  markdownReadFile(filePathOrUrl: string, baseFilePath?: string): Promise<MarkdownReadResult>;
  markdownWriteFile(filePath: string, content: string): Promise<MarkdownWriteResult>;
  markdownWatchFile(filePathOrUrl: string): Promise<{ ok: boolean; filePath?: string; error?: string }>;
  markdownUnwatch(): Promise<void>;
  onMarkdownFileChanged(listener: (event: MarkdownWatchEvent) => void): () => void;

  // Local Image Viewer
  imageReadFile(filePathOrUrl: string, baseFilePath?: string): Promise<ImageReadResult>;

  // Project File Tree (read-only)
  fsListDir(
    dirPath: string,
    options?: { rootPath?: string; includeIgnored?: boolean },
  ): Promise<ListDirectoryResult>;
  fsReadTextFile(
    filePath: string,
    options?: { rootPath?: string },
  ): Promise<TextFileReadResult>;

  // Interactive Terminal (PTY)
  terminalCreate(options?: TerminalCreateOptions): Promise<TerminalCreateResult>;
  terminalWrite(sessionId: string, data: string): Promise<TerminalWriteResult>;
  terminalResize(sessionId: string, cols: number, rows: number): Promise<TerminalResizeResult>;
  terminalClose(sessionId: string): Promise<TerminalCloseResult>;
  onTerminalData(listener: (event: TerminalDataEvent) => void): () => void;
  onTerminalExit(listener: (event: TerminalExitEvent) => void): () => void;

  getPathForFile(file: File): string;
}

declare global {
  interface Window {
    conductor: ConductorAPI;
  }
}
