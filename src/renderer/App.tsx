import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentTask,
  AgentTaskStatus,
  AppSnapshot,
  AppUpdateState,
  ChatAttachment,
  ChatMessage,
  ExplicitMentionTarget,
  MarkdownDocument,
  Project,
  ProjectFileEntry,
  RightPaneMode,
} from "../shared/types.js";
import { classifyProjectFile, formatFileTreeIpcError } from "../shared/file-tree.js";
import { resolveUiLocale, t } from "../shared/i18n.js";
import { buildTerminalTabTitle } from "../shared/terminal.js";
import {
  addExplicitMentionTarget,
  removeExplicitMentionTarget,
  type MentionChipRemovalTarget,
} from "../shared/mentions.js";
import {
  DEFAULT_VOICE_AUTO_SEND,
  collectVoiceReadbackUtterances,
  createInitialVoiceReadbackTracker,
} from "../shared/voice.js";
import { speakTextWithFallback, stopAllVoicePlayback } from "./lib/voice-client.js";
import { ImageLightboxModal } from "./components/ImageLightboxModal.js";
import type { MarkdownOpenedImage } from "./components/MarkdownView.js";
import type { MarkdownViewerTab } from "./components/MarkdownViewerPane.js";
import { SettingsModal, type SettingsModalTab } from "./components/SettingsModal.js";
import { TaskInspectorModal } from "./components/TaskInspectorModal.js";
import { TaskSidebar } from "./components/TaskSidebar.js";
import { UnifiedChat, type ChatJumpRequest } from "./components/UnifiedChat.js";
import { UnifiedRightPane } from "./components/UnifiedRightPane.js";
import { hideBrowserBounds } from "./lib/browser-bounds-client.js";
import {
  buildAttachmentFromMarkdownImage,
  buildImageTabFromAttachment,
  isViewableImageAttachment,
  mergeLoadedImageIntoAttachment,
  upsertImageTab,
  type ImageViewerTab,
} from "./lib/image-viewer.js";
import {
  applyMarkdownDiskDeleted,
  applyMarkdownDiskReload,
  applyMarkdownDraftEdit,
  beginMarkdownSave,
  completeMarkdownSave,
  discardMarkdownDraft,
  dismissMarkdownExternalChange,
  getEffectiveMarkdownContent,
  setMarkdownTabViewMode,
} from "./lib/markdown-editor-state.js";
import { extractHash, isMarkdownPathOrUrl } from "./lib/markdown-utils.js";
import {
  deriveQuestionItems,
  reconcileUnreadReplies,
  type QuestionItem,
} from "./lib/questions.js";
import { stabilizeMentionTasks } from "./lib/composer-perf.js";
import { reconcileAppSnapshot } from "./lib/snapshot-reconcile.js";
import {
  activateTabInWorkspace,
  buildProjectSwitcherItems,
  closeTabInWorkspace,
  filterRecentFilesForProject,
  GENERAL_PROJECT_SCOPE,
  getActiveUnifiedTab,
  getProjectUnifiedTabs,
  inferProjectFromFilePath,
  inferProjectFromMessage,
  inferProjectFromTask,
  isRightPaneBrowserTabActive,
  loadRightPaneWorkspaceFromStorage,
  makeBrowserUnifiedTabId,
  makeCodeUnifiedTabId,
  makeImageUnifiedTabId,
  makeMarkdownUnifiedTabId,
  makeTerminalUnifiedTabId,
  parseUnifiedTabId,
  reconcileWorkspaceState,
  resolveProjectFromChatText,
  saveRightPaneWorkspaceToStorage,
  scopeKeyToBrowserProjectId,
  selectTabInWorkspace,
  switchActiveProjectScope,
  toProjectScopeKey,
  type CodeViewerTab,
  type ProjectScopeKey,
  type RightPaneWorkspaceState,
  type TerminalTab,
  type UnifiedRightPaneTab,
} from "./lib/right-pane-tabs.js";
import { terminalOutputStore } from "./lib/terminal-session-store.js";

const RECENT_MD_STORAGE_KEY = "conductor:recentMarkdownFiles";
const VOICE_AUTO_SEND_STORAGE_KEY = "conductor:voiceAutoSend";

function loadVoiceAutoSend(): boolean {
  try {
    return window.localStorage.getItem(VOICE_AUTO_SEND_STORAGE_KEY) === "true";
  } catch {
    return DEFAULT_VOICE_AUTO_SEND;
  }
}

function saveVoiceAutoSend(enabled: boolean): void {
  try {
    window.localStorage.setItem(VOICE_AUTO_SEND_STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // ignore storage errors
  }
}

function loadRecentMarkdownFiles(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_MD_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === "string" && p.length > 0).slice(0, 12);
  } catch {
    return [];
  }
}

function saveRecentMarkdownFiles(files: string[]): void {
  try {
    window.localStorage.setItem(RECENT_MD_STORAGE_KEY, JSON.stringify(files.slice(0, 12)));
  } catch {
    // ignore storage quota errors
  }
}

function normalizeUrlForCompare(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
      ? trimmed
      : /^(localhost|127\.0\.0\.1|\d+\.\d+\.\d+\.\d+)(:\d+)?(\/|$)/i.test(trimmed)
        ? `http://${trimmed}`
        : `https://${trimmed}`;
    const u = new URL(withScheme);
    return u.toString().replace(/\/$/, "");
  } catch {
    return trimmed.replace(/\/$/, "");
  }
}

const EMPTY_APP_TASKS: AgentTask[] = [];
const EMPTY_APP_PROJECTS: Project[] = [];

export const App: React.FC = () => {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [selectedMentions, setSelectedMentions] = useState<ExplicitMentionTarget[]>([]);
  const attachmentsRef = useRef<ChatAttachment[]>([]);
  const selectedMentionsRef = useRef<ExplicitMentionTarget[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [settingsModalTab, setSettingsModalTab] = useState<SettingsModalTab | null>(null);
  const [appUpdate, setAppUpdate] = useState<AppUpdateState | null>(null);
  const [dismissedUpdateTag, setDismissedUpdateTag] = useState<string | null>(null);
  const [voiceAutoSend, setVoiceAutoSend] = useState<boolean>(() => loadVoiceAutoSend());
  const [isSpeaking, setIsSpeaking] = useState(false);
  const voiceTrackerRef = useRef(createInitialVoiceReadbackTracker());
  const voiceQueueRef = useRef<Array<{ text: string; language: "ja" | "en" }>>([]);
  const voiceDrainingRef = useRef(false);
  const voiceEpochRef = useRef(0);

  const updateVoiceAutoSend = useCallback((enabled: boolean) => {
    setVoiceAutoSend(enabled);
    saveVoiceAutoSend(enabled);
  }, []);

  const handleStopSpeaking = useCallback(() => {
    voiceEpochRef.current += 1;
    voiceQueueRef.current = [];
    voiceDrainingRef.current = false;
    setIsSpeaking(false);
    void stopAllVoicePlayback();
  }, []);

  const drainVoiceQueue = useCallback(async () => {
    if (voiceDrainingRef.current) return;
    voiceDrainingRef.current = true;
    const epoch = voiceEpochRef.current;

    try {
      while (voiceQueueRef.current.length > 0 && voiceEpochRef.current === epoch) {
        const next = voiceQueueRef.current.shift();
        if (!next) break;
        setIsSpeaking(true);
        await speakTextWithFallback(next, () => voiceEpochRef.current !== epoch);
      }
    } finally {
      if (voiceEpochRef.current === epoch) {
        voiceDrainingRef.current = false;
        setIsSpeaking(false);
      }
    }
  }, []);

  useEffect(() => {
    return () => {
      voiceEpochRef.current += 1;
      voiceQueueRef.current = [];
      void stopAllVoicePlayback();
    };
  }, []);

  const updateAttachments = useCallback(
    (updater: ChatAttachment[] | ((prev: ChatAttachment[]) => ChatAttachment[])) => {
      const next =
        typeof updater === "function" ? updater(attachmentsRef.current) : updater;
      attachmentsRef.current = next;
      setAttachments(next);
    },
    [],
  );

  const updateSelectedMentions = useCallback(
    (
      updater:
        | ExplicitMentionTarget[]
        | ((prev: ExplicitMentionTarget[]) => ExplicitMentionTarget[]),
    ) => {
      const next =
        typeof updater === "function" ? updater(selectedMentionsRef.current) : updater;
      selectedMentionsRef.current = next;
      setSelectedMentions(next);
    },
    [],
  );

  // Unified project-scoped right-pane workspace state
  const initialPersistedWorkspaceRef = useRef<ReturnType<
    typeof loadRightPaneWorkspaceFromStorage
  > | null>(null);
  if (!initialPersistedWorkspaceRef.current) {
    initialPersistedWorkspaceRef.current = loadRightPaneWorkspaceFromStorage();
  }

  const [workspaceState, setWorkspaceState] = useState<RightPaneWorkspaceState>(
    () => initialPersistedWorkspaceRef.current!.state,
  );
  const workspaceStateRef = useRef<RightPaneWorkspaceState>(workspaceState);
  workspaceStateRef.current = workspaceState;

  const pendingRestoreMdPathsRef = useRef<Set<string>>(
    new Set(initialPersistedWorkspaceRef.current!.openMarkdownFiles.map((f) => f.filePath)),
  );
  const hasStartedMdRestoreRef = useRef(false);
  const [mdRestoreTick, setMdRestoreTick] = useState(0);
  const seenBrowserTabIdsRef = useRef<Set<string> | null>(null);

  // Local Markdown Viewer state
  const [mdTabs, setMdTabs] = useState<MarkdownViewerTab[]>([]);
  const mdTabsRef = useRef<MarkdownViewerTab[]>(mdTabs);
  mdTabsRef.current = mdTabs;
  const lastSelfSavedMdDocsRef = useRef<Map<string, MarkdownDocument>>(new Map());
  const [recentMdFiles, setRecentMdFiles] = useState<string[]>(() => loadRecentMarkdownFiles());
  const [mdAutoReload, setMdAutoReload] = useState(true);
  const [mdIsWatching, setMdIsWatching] = useState(false);
  const [mdJustReloadedAt, setMdJustReloadedAt] = useState<number | null>(null);
  const [mdPendingAnchor, setMdPendingAnchor] = useState<string | null>(null);

  // Right-pane Image Viewer state
  const [imageTabs, setImageTabs] = useState<ImageViewerTab[]>([]);
  const imageTabsRef = useRef<ImageViewerTab[]>([]);
  const imageDiskFallbackAttemptedRef = useRef<Set<string>>(new Set());
  imageTabsRef.current = imageTabs;

  // Center-screen Image Lightbox modal state (default destination on image click)
  const [lightboxImage, setLightboxImage] = useState<{
    requestId: number;
    attachment: ChatAttachment;
    context?: {
      message?: ChatMessage;
      draftText?: string;
      draftMentions?: ExplicitMentionTarget[];
      projectId?: string | null;
    };
    tab: ImageViewerTab;
    diskFallbackAttempted: boolean;
  } | null>(null);
  const lightboxRequestIdRef = useRef(0);

  // Right-pane Code/Text Viewer state (opened from Project File Tree)
  const [codeTabs, setCodeTabs] = useState<CodeViewerTab[]>([]);

  // Right-pane Interactive Terminal tabs
  const [terminalTabs, setTerminalTabs] = useState<TerminalTab[]>([]);
  const terminalTabsRef = useRef<TerminalTab[]>(terminalTabs);
  terminalTabsRef.current = terminalTabs;
  const terminalSeqByScopeRef = useRef<Map<ProjectScopeKey, number>>(new Map());

  const snapshotRef = useRef<AppSnapshot | null>(null);
  snapshotRef.current = snapshot;

  const [leftWidth, setLeftWidth] = useState(268);
  const [rightWidth, setRightWidth] = useState(520);

  // Questions sidebar unread tracking & chat jump state
  const [unreadReplyIds, setUnreadReplyIds] = useState<Set<string>>(() => new Set());
  const [jumpRequest, setJumpRequest] = useState<ChatJumpRequest | null>(null);
  const [newChatConfirmTrigger, setNewChatConfirmTrigger] = useState(0);
  const unreadReplyIdsRef = useRef<Set<string>>(new Set());
  const prevStreamingIdsRef = useRef<Set<string>>(new Set());
  const isMessageVisibleRef = useRef<((messageId: string) => boolean) | null>(null);
  const jumpNonceRef = useRef(0);

  // Reset unread reply tracking cleanly when switching between chat sessions
  useEffect(() => {
    prevStreamingIdsRef.current = new Set();
    unreadReplyIdsRef.current = new Set();
    setUnreadReplyIds(new Set());
    setJumpRequest(null);
  }, [snapshot?.activeChatSessionId]);

  // Automatic OS-standard TTS readback for completed replies and concise TaskEvent notices
  useEffect(() => {
    if (!snapshot) return;
    const readbackEnabled = Boolean(snapshot.voiceReadbackEnabled);
    const { nextState, utterances } = collectVoiceReadbackUtterances(voiceTrackerRef.current, {
      sessionId: snapshot.activeChatSessionId,
      messages: snapshot.messages,
      tasks: snapshot.tasks,
      preferredLanguage: snapshot.preferredLanguage,
      readbackEnabled,
    });
    voiceTrackerRef.current = nextState;

    if (!readbackEnabled) {
      return;
    }

    if (utterances.length > 0) {
      voiceQueueRef.current.push(...utterances);
      void drainVoiceQueue();
    }
  }, [
    snapshot?.activeChatSessionId,
    snapshot?.messages,
    snapshot?.tasks,
    snapshot?.preferredLanguage,
    snapshot?.voiceReadbackEnabled,
    drainVoiceQueue,
  ]);

  // Immediately stop any active readback if user disables voiceReadbackEnabled
  useEffect(() => {
    if (snapshot && !snapshot.voiceReadbackEnabled && isSpeaking) {
      handleStopSpeaking();
    }
  }, [snapshot?.voiceReadbackEnabled, isSpeaking, handleStopSpeaking]);

  useEffect(() => {
    const messages = snapshot?.messages ?? [];
    const result = reconcileUnreadReplies({
      messages,
      prevStreamingIds: prevStreamingIdsRef.current,
      prevUnreadIds: unreadReplyIdsRef.current,
      isMessageVisible: (id) => isMessageVisibleRef.current?.(id) ?? false,
    });
    prevStreamingIdsRef.current = result.nextStreamingIds;

    const prev = unreadReplyIdsRef.current;
    const changed =
      prev.size !== result.nextUnreadIds.size ||
      Array.from(result.nextUnreadIds).some((id) => !prev.has(id));
    if (changed) {
      unreadReplyIdsRef.current = result.nextUnreadIds;
      setUnreadReplyIds(result.nextUnreadIds);
    }
  }, [snapshot?.messages]);

  const handleMarkMessagesRead = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    const prev = unreadReplyIdsRef.current;
    let changed = false;
    const next = new Set(prev);
    for (const id of ids) {
      if (next.delete(id)) changed = true;
    }
    if (changed) {
      unreadReplyIdsRef.current = next;
      setUnreadReplyIds(next);
    }
  }, []);

  const handleSelectQuestion = useCallback(
    (question: QuestionItem) => {
      const idsToClear = [question.replyMessageId, question.targetMessageId].filter(
        (id): id is string => Boolean(id),
      );
      handleMarkMessagesRead(idsToClear);
      jumpNonceRef.current += 1;
      setJumpRequest({
        messageId: question.targetMessageId,
        nonce: jumpNonceRef.current,
      });
    },
    [handleMarkMessagesRead],
  );

  const uiLocale = useMemo(
    () => resolveUiLocale(snapshot?.preferredLanguage),
    [snapshot?.preferredLanguage],
  );
  const uiLocaleRef = useRef(uiLocale);
  uiLocaleRef.current = uiLocale;

  const stableMentionTasksRef = useRef<AgentTask[]>(EMPTY_APP_TASKS);
  const stableMentionTasks = stabilizeMentionTasks(
    stableMentionTasksRef.current,
    snapshot?.tasks ?? EMPTY_APP_TASKS,
  );
  stableMentionTasksRef.current = stableMentionTasks;

  const questions = useMemo(
    () =>
      deriveQuestionItems(snapshot?.messages ?? [], unreadReplyIds, uiLocale, {
        projects: snapshot?.projects ?? EMPTY_APP_PROJECTS,
        tasks: stableMentionTasks,
      }),
    [snapshot?.messages, snapshot?.projects, stableMentionTasks, unreadReplyIds, uiLocale],
  );

  useEffect(() => {
    const applyIncomingSnapshot = (incoming: AppSnapshot) => {
      setSnapshot((prev) => reconcileAppSnapshot(prev, incoming));
    };
    void window.conductor.getSnapshot().then(applyIncomingSnapshot);
    const unsubSnap = window.conductor.onSnapshot(applyIncomingSnapshot);
    const unsubAtt = window.conductor.onAttachmentFromBrowser((att) => {
      updateAttachments((prev) => [...prev, att]);
    });
    const unsubTermData = window.conductor.onTerminalData?.((event) => {
      terminalOutputStore.append(event.sessionId, event.data);
    });
    const unsubTermExit = window.conductor.onTerminalExit?.((event) => {
      setTerminalTabs((prev) =>
        prev.map((tab) =>
          tab.id === event.sessionId
            ? { ...tab, status: "exited", exitCode: event.exitCode ?? null }
            : tab,
        ),
      );
    });
    void window.conductor.updaterGetState?.().then((state) => {
      if (state) setAppUpdate(state);
    });
    const unsubUpdater = window.conductor.onUpdaterStateChanged?.((state) => {
      setAppUpdate(state);
    });

    const closeAllTerminals = () => {
      for (const tab of terminalTabsRef.current) {
        void window.conductor.terminalClose?.(tab.id);
      }
      terminalOutputStore.clearAll();
    };
    window.addEventListener("beforeunload", closeAllTerminals);

    return () => {
      window.removeEventListener("beforeunload", closeAllTerminals);
      unsubSnap();
      unsubAtt();
      unsubTermData?.();
      unsubTermExit?.();
      unsubUpdater?.();
    };
  }, [updateAttachments]);

  const recordRecentMarkdownFile = useCallback((filePath: string) => {
    setRecentMdFiles((prev) => {
      const next = [filePath, ...prev.filter((p) => p !== filePath)].slice(0, 12);
      saveRecentMarkdownFiles(next);
      return next;
    });
  }, []);

  // Restore persisted open Markdown files once after initial snapshot loads
  useEffect(() => {
    if (!snapshot || hasStartedMdRestoreRef.current) return;
    hasStartedMdRestoreRef.current = true;
    const toRestore = initialPersistedWorkspaceRef.current?.openMarkdownFiles ?? [];
    if (toRestore.length === 0) return;

    void (async () => {
      for (const item of toRestore) {
        try {
          const result = await window.conductor.markdownReadFile(item.filePath);
          const now = Date.now();
          if (result.ok && result.document) {
            const doc = result.document;
            setMdTabs((prev) => {
              if (prev.some((t) => t.filePath === doc.filePath)) return prev;
              return [
                ...prev,
                {
                  filePath: doc.filePath,
                  fileName: doc.fileName,
                  document: doc,
                  error: null,
                  deletedOnDisk: false,
                  isLoading: false,
                  lastReloadedAt: now,
                },
              ];
            });
          }
        } catch {
          // ignore unreadable restored file
        } finally {
          pendingRestoreMdPathsRef.current.delete(item.filePath);
          setMdRestoreTick((n) => n + 1);
        }
      }
    })();
  }, [snapshot]);

  // Reconcile unified right-pane workspace state with live browser/markdown/image tabs & projects
  useEffect(() => {
    if (!snapshot) return;

    const currentBrowserIds = new Set(snapshot.browserTabs.map((t) => t.id));
    let newlyAddedBrowserTabs: typeof snapshot.browserTabs = [];
    if (seenBrowserTabIdsRef.current === null) {
      seenBrowserTabIdsRef.current = currentBrowserIds;
    } else {
      newlyAddedBrowserTabs = snapshot.browserTabs.filter(
        (t) => !seenBrowserTabIdsRef.current!.has(t.id),
      );
      seenBrowserTabIdsRef.current = currentBrowserIds;
    }

    setWorkspaceState((prev) => {
      let next = reconcileWorkspaceState(prev, {
        browserTabs: snapshot.browserTabs,
        mdTabs,
        imageTabs,
        codeTabs,
        terminalTabs,
        projects: snapshot.projects,
        tasks: snapshot.tasks,
        pendingMarkdownPaths: pendingRestoreMdPathsRef.current,
      });

      // If main process opened a new browser tab (e.g. popup link or MCP browser_open),
      // make it active in its owning project scope without stealing focus from another active project.
      for (const bt of newlyAddedBrowserTabs) {
        const unifiedId = makeBrowserUnifiedTabId(bt.id);
        const btScope = toProjectScopeKey(bt.projectId, snapshot.projects);
        const isCurrentProjectEmpty =
          (next.workspaces[next.activeProjectScope]?.tabOrder.length ?? 0) === 0;
        const shouldSwitchProject =
          btScope === next.activeProjectScope || isCurrentProjectEmpty;
        next = activateTabInWorkspace(next, unifiedId, btScope, {
          switchProject: shouldSwitchProject,
        });
      }

      return next;
    });
  }, [
    snapshot?.browserTabs,
    snapshot?.projects,
    snapshot?.tasks,
    mdTabs,
    imageTabs,
    codeTabs,
    terminalTabs,
    mdRestoreTick,
  ]);

  const hasSnapshot = snapshot !== null;

  // Persist right-pane workspace state (active project, tab order, open markdown files)
  useEffect(() => {
    if (!hasSnapshot || pendingRestoreMdPathsRef.current.size > 0) return;
    saveRightPaneWorkspaceToStorage(workspaceState, mdTabs);
  }, [hasSnapshot, workspaceState, mdTabs]);

  // Derived unified right-pane selectors
  const activeProjectScope = workspaceState.activeProjectScope;
  const tabSources = useMemo(
    () => ({
      browserTabs: snapshot?.browserTabs ?? [],
      mdTabs,
      imageTabs,
      codeTabs,
      terminalTabs,
      projects: snapshot?.projects ?? [],
    }),
    [snapshot?.browserTabs, snapshot?.projects, mdTabs, imageTabs, codeTabs, terminalTabs],
  );

  const activeProjectTabs = useMemo(
    () => getProjectUnifiedTabs(workspaceState, activeProjectScope, tabSources),
    [workspaceState, activeProjectScope, tabSources],
  );

  const activeUnifiedTab = useMemo(
    () => getActiveUnifiedTab(workspaceState, tabSources),
    [workspaceState, tabSources],
  );

  const switcherData = useMemo(
    () => buildProjectSwitcherItems(workspaceState, tabSources),
    [workspaceState, tabSources],
  );

  const activeProjectItem = useMemo(
    () =>
      switcherData.all.find((item) => item.scopeKey === activeProjectScope) ?? {
        scopeKey: GENERAL_PROJECT_SCOPE,
        project: null,
        name: "General",
        path: null,
        colorHex: "#71717A",
        tabCount: activeProjectTabs.length,
        browserCount: 0,
        markdownCount: 0,
        imageCount: 0,
        isActive: true,
        isGeneral: true,
      },
    [switcherData.all, activeProjectScope, activeProjectTabs.length],
  );

  const projectRecentMdFiles = useMemo(
    () =>
      filterRecentFilesForProject(
        recentMdFiles,
        activeProjectScope,
        snapshot?.projects ?? [],
        snapshot?.tasks ?? [],
      ),
    [recentMdFiles, activeProjectScope, snapshot?.projects, snapshot?.tasks],
  );

  const activeMdPath =
    activeUnifiedTab?.kind === "markdown" ? activeUnifiedTab.markdownTab.filePath : null;
  const activeCodePath =
    activeUnifiedTab?.kind === "code" ? activeUnifiedTab.codeTab.filePath : null;
  const isMarkdownPaneVisible =
    Boolean(snapshot?.showBrowserPane) && activeUnifiedTab?.kind === "markdown";
  const isBrowserTabActive = isRightPaneBrowserTabActive(
    snapshot?.showBrowserPane,
    activeUnifiedTab,
  );
  const derivedRightPaneMode: RightPaneMode = activeUnifiedTab?.kind ?? "browser";

  // Keep native Electron BrowserManager active tab & WebContentsView visibility in sync
  useEffect(() => {
    if (!hasSnapshot) return;
    if (!snapshot?.showBrowserPane || activeUnifiedTab?.kind !== "browser") {
      hideBrowserBounds();
      return;
    }
    if (snapshot.activeBrowserTabId !== activeUnifiedTab.browserTab.id) {
      void window.conductor.browserSelectTab(activeUnifiedTab.browserTab.id);
    }
  }, [
    hasSnapshot,
    snapshot?.showBrowserPane,
    snapshot?.activeBrowserTabId,
    activeUnifiedTab?.kind,
    activeUnifiedTab?.id,
  ]);

  const loadMarkdownIntoTab = useCallback(
    async (
      pathOrUrl: string,
      options?: {
        baseFilePath?: string;
        switchToViewer?: boolean;
        activateTab?: boolean;
        anchor?: string | null;
        fallbackProjectId?: string | null;
        message?: ChatMessage | null;
        forceDiscardDraft?: boolean;
      },
    ) => {
      const anchor = options?.anchor !== undefined ? options.anchor : extractHash(pathOrUrl);
      const shouldSwitch = options?.switchToViewer !== false;
      const shouldActivate = options?.activateTab !== false;

      if (shouldSwitch) {
        void window.conductor.setLayout({ showBrowserPane: true });
      }

      const result = await window.conductor.markdownReadFile(pathOrUrl, options?.baseFilePath);
      const now = Date.now();
      const snap = snapshotRef.current;
      const projects = snap?.projects ?? [];
      const tasks = snap?.tasks ?? [];

      const canonicalPath = result.ok && result.document ? result.document.filePath : result.filePath || pathOrUrl;

      // Resolve owning project: longest project.path prefix > explicit fallback > message mention > active project
      const pathProject = inferProjectFromFilePath(canonicalPath, projects, tasks);
      const fallbackProject = options?.fallbackProjectId
        ? toProjectScopeKey(options.fallbackProjectId, projects)
        : null;
      const messageProject = options?.message
        ? inferProjectFromMessage(options.message, projects, tasks)
        : null;
      const targetScope: ProjectScopeKey =
        pathProject?.id ??
        (fallbackProject && fallbackProject !== GENERAL_PROJECT_SCOPE ? fallbackProject : null) ??
        messageProject?.id ??
        workspaceStateRef.current.activeProjectScope;

      if (result.ok && result.document) {
        const doc = result.document;
        setMdTabs((prev) => {
          const existingIdx = prev.findIndex((t) => t.filePath === doc.filePath);
          if (existingIdx >= 0) {
            const copy = [...prev];
            copy[existingIdx] = applyMarkdownDiskReload(copy[existingIdx], doc, now, {
              force: options?.forceDiscardDraft,
              lastSelfSavedDoc: lastSelfSavedMdDocsRef.current.get(doc.filePath) ?? null,
            }).tab;
            return copy;
          }
          const nextTab: MarkdownViewerTab = {
            filePath: doc.filePath,
            fileName: doc.fileName,
            document: doc,
            error: null,
            deletedOnDisk: false,
            isLoading: false,
            lastReloadedAt: now,
          };
          return [...prev, nextTab];
        });
        recordRecentMarkdownFile(doc.filePath);
        if (shouldActivate) {
          setWorkspaceState((prev) =>
            activateTabInWorkspace(prev, makeMarkdownUnifiedTabId(doc.filePath), targetScope, {
              switchProject: shouldSwitch,
            }),
          );
        }
        if (anchor) {
          setMdPendingAnchor(anchor);
        }
      } else {
        const targetPath = result.filePath || pathOrUrl;
        const baseName = targetPath.split(/[/\\]/).pop() || targetPath;
        setMdTabs((prev) => {
          const existingIdx = prev.findIndex((t) => t.filePath === targetPath);
          if (existingIdx >= 0) {
            const copy = [...prev];
            copy[existingIdx] = {
              ...copy[existingIdx],
              error: result.error ?? t(uiLocaleRef.current, "markdown.readFailed"),
              isLoading: false,
            };
            return copy;
          }
          return [
            ...prev,
            {
              filePath: targetPath,
              fileName: baseName,
              document: null,
              error: result.error ?? t(uiLocaleRef.current, "markdown.readFailed"),
              isLoading: false,
              lastReloadedAt: now,
            },
          ];
        });
        if (shouldActivate) {
          setWorkspaceState((prev) =>
            activateTabInWorkspace(prev, makeMarkdownUnifiedTabId(targetPath), targetScope, {
              switchProject: shouldSwitch,
            }),
          );
        }
      }
    },
    [recordRecentMarkdownFile],
  );

  const handleOpenMarkdownFile = useCallback(
    (
      pathOrUrl: string,
      baseFilePath?: string,
      context?: { message?: ChatMessage; fallbackProjectId?: string | null },
    ) => {
      void loadMarkdownIntoTab(pathOrUrl, {
        baseFilePath,
        switchToViewer: true,
        activateTab: true,
        message: context?.message,
        fallbackProjectId: context?.fallbackProjectId,
      });
    },
    [loadMarkdownIntoTab],
  );

  const handleOpenMarkdownDialog = useCallback(async () => {
    const filePaths = await window.conductor.markdownOpenDialog();
    if (filePaths.length === 0) return;
    void window.conductor.setLayout({ showBrowserPane: true });
    for (const filePath of filePaths) {
      await loadMarkdownIntoTab(filePath, { switchToViewer: true, activateTab: true });
    }
  }, [loadMarkdownIntoTab]);

  const handleRefreshActiveMd = useCallback(() => {
    if (!activeMdPath) return;
    const currentTab = mdTabsRef.current.find((t) => t.filePath === activeMdPath);
    const wasDirty = Boolean(currentTab?.isDirty);
    setMdTabs((prev) =>
      prev.map((t) => (t.filePath === activeMdPath ? { ...t, isLoading: true } : t)),
    );
    void loadMarkdownIntoTab(activeMdPath, {
      switchToViewer: false,
      activateTab: false,
      anchor: null,
    }).then(() => {
      if (!wasDirty) {
        setMdJustReloadedAt(Date.now());
      }
    });
  }, [activeMdPath, loadMarkdownIntoTab]);

  const handleMarkdownDraftChange = useCallback((filePath: string, nextContent: string) => {
    setMdTabs((prev) =>
      prev.map((t) => (t.filePath === filePath ? applyMarkdownDraftEdit(t, nextContent) : t)),
    );
  }, []);

  const handleChangeMarkdownViewMode = useCallback(
    (filePath: string, mode: "rendered" | "raw") => {
      setMdTabs((prev) =>
        prev.map((t) => (t.filePath === filePath ? setMarkdownTabViewMode(t, mode) : t)),
      );
    },
    [],
  );

  const handleSaveActiveMarkdown = useCallback(async () => {
    if (!activeMdPath) return;
    const tab = mdTabsRef.current.find((t) => t.filePath === activeMdPath);
    if (!tab || tab.isSaving || (!tab.isDirty && !tab.deletedOnDisk)) return;

    const targetPath = tab.filePath;
    const contentToSave = getEffectiveMarkdownContent(tab);

    setMdTabs((prev) =>
      prev.map((t) => (t.filePath === targetPath ? beginMarkdownSave(t) : t)),
    );

    try {
      const result = await window.conductor.markdownWriteFile(targetPath, contentToSave);
      if (result.ok && result.document) {
        lastSelfSavedMdDocsRef.current.set(result.document.filePath, result.document);
      }
      const savedAt = Date.now();
      setMdTabs((prev) =>
        prev.map((t) => (t.filePath === targetPath ? completeMarkdownSave(t, result, savedAt) : t)),
      );
    } catch (err) {
      const savedAt = Date.now();
      const message =
        err instanceof Error ? err.message : t(uiLocaleRef.current, "markdown.saveFailed");
      setMdTabs((prev) =>
        prev.map((t) =>
          t.filePath === targetPath
            ? completeMarkdownSave(t, { ok: false, filePath: targetPath, error: message }, savedAt)
            : t,
        ),
      );
    }
  }, [activeMdPath]);

  const handleDiscardActiveMarkdown = useCallback(async () => {
    if (!activeMdPath) return;
    const targetPath = activeMdPath;
    setMdTabs((prev) =>
      prev.map((t) => (t.filePath === targetPath ? { ...t, isLoading: true } : t)),
    );
    try {
      const result = await window.conductor.markdownReadFile(targetPath);
      const now = Date.now();
      if (result.ok && result.document) {
        setMdTabs((prev) =>
          prev.map((t) =>
            t.filePath === targetPath
              ? { ...discardMarkdownDraft(t, result.document, now), isLoading: false }
              : t,
          ),
        );
        setMdJustReloadedAt(now);
      } else {
        setMdTabs((prev) =>
          prev.map((t) =>
            t.filePath === targetPath
              ? {
                  ...discardMarkdownDraft(t),
                  error: result.error ?? t.error,
                  isLoading: false,
                }
              : t,
          ),
        );
      }
    } catch {
      setMdTabs((prev) =>
        prev.map((t) =>
          t.filePath === targetPath ? { ...discardMarkdownDraft(t), isLoading: false } : t,
        ),
      );
    }
  }, [activeMdPath]);

  const handleReloadExternalMarkdownChange = useCallback(async () => {
    if (!activeMdPath) return;
    const targetPath = activeMdPath;
    setMdTabs((prev) =>
      prev.map((t) => (t.filePath === targetPath ? { ...t, isLoading: true } : t)),
    );
    await loadMarkdownIntoTab(targetPath, {
      switchToViewer: false,
      activateTab: false,
      anchor: null,
      forceDiscardDraft: true,
    });
    setMdJustReloadedAt(Date.now());
  }, [activeMdPath, loadMarkdownIntoTab]);

  const handleDismissExternalMarkdownChange = useCallback(() => {
    if (!activeMdPath) return;
    setMdTabs((prev) =>
      prev.map((t) => (t.filePath === activeMdPath ? dismissMarkdownExternalChange(t) : t)),
    );
  }, [activeMdPath]);

  // Subscribe to main-process file watcher live-reload events
  useEffect(() => {
    return window.conductor.onMarkdownFileChanged((event) => {
      if (event.kind === "changed" && event.document) {
        const doc = event.document;
        const now = Date.now();
        const lastSelfSavedDoc = lastSelfSavedMdDocsRef.current.get(event.filePath) ?? null;
        const existing = mdTabsRef.current.find((t) => t.filePath === event.filePath);
        if (existing) {
          const preview = applyMarkdownDiskReload(existing, doc, now, { lastSelfSavedDoc });
          if (preview.didReload) {
            setMdJustReloadedAt(now);
          }
        }
        setMdTabs((prev) =>
          prev.map((t) =>
            t.filePath === event.filePath
              ? applyMarkdownDiskReload(t, doc, now, { lastSelfSavedDoc }).tab
              : t,
          ),
        );
      } else if (event.kind === "deleted") {
        const now = Date.now();
        setMdTabs((prev) =>
          prev.map((t) =>
            t.filePath === event.filePath ? applyMarkdownDiskDeleted(t, event.error, now) : t,
          ),
        );
      } else if (event.kind === "error") {
        setMdTabs((prev) =>
          prev.map((tab) =>
            tab.filePath === event.filePath
              ? {
                  ...tab,
                  error: event.error ?? t(uiLocaleRef.current, "markdown.reloadFailed"),
                  isLoading: false,
                }
              : tab,
          ),
        );
      }
    });
  }, []);

  // Manage active watcher lifecycle cleanly when switching tabs or closing pane
  useEffect(() => {
    let cancelled = false;
    if (isMarkdownPaneVisible && activeMdPath && mdAutoReload) {
      void window.conductor.markdownWatchFile(activeMdPath).then((res) => {
        if (!cancelled) {
          setMdIsWatching(Boolean(res?.ok));
        }
      });
    } else {
      setMdIsWatching(false);
      void window.conductor.markdownUnwatch();
    }

    return () => {
      cancelled = true;
      void window.conductor.markdownUnwatch();
    };
  }, [isMarkdownPaneVisible, activeMdPath, mdAutoReload]);

  const loadImageTabFromDisk = useCallback(async (tabId: string, pathOrUrl: string) => {
    imageDiskFallbackAttemptedRef.current.add(tabId);
    setImageTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, isLoading: true, error: null } : t)),
    );
    try {
      const res = await window.conductor.imageReadFile(pathOrUrl);
      if (res.ok && res.dataUrl) {
        setImageTabs((prev) =>
          prev.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  src: res.dataUrl!,
                  fileName: res.fileName ?? t.fileName,
                  imagePath: res.filePath || t.imagePath,
                  isLoading: false,
                  error: null,
                }
              : t,
          ),
        );
      } else {
        setImageTabs((prev) =>
          prev.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  isLoading: false,
                  error: res.error ?? "画像を読み込めませんでした。",
                }
              : t,
          ),
        );
      }
    } catch (err) {
      setImageTabs((prev) =>
        prev.map((t) =>
          t.id === tabId
            ? {
                ...t,
                isLoading: false,
                error: err instanceof Error ? err.message : "画像を読み込めませんでした。",
              }
            : t,
        ),
      );
    }
  }, []);

  const openImageAttachmentInRightPane = useCallback(
    (
      attachment: ChatAttachment,
      context?: {
        message?: ChatMessage;
        draftText?: string;
        draftMentions?: ExplicitMentionTarget[];
        projectId?: string | null;
      },
    ) => {
      if (!isViewableImageAttachment(attachment)) return;
      const { tab, localPathToLoad } = buildImageTabFromAttachment(attachment);
      const upserted = upsertImageTab(imageTabsRef.current, tab);
      imageTabsRef.current = upserted.tabs;

      const active = upserted.tabs.find((t) => t.id === upserted.activeTabId);
      const needsDiskLoad = Boolean(!active?.src && localPathToLoad);

      const snap = snapshotRef.current;
      const projects = snap?.projects ?? [];
      const tasks = snap?.tasks ?? [];
      const pathProject = attachment.imagePath
        ? inferProjectFromFilePath(attachment.imagePath, projects, tasks)
        : null;
      const explicitProject = context?.projectId
        ? toProjectScopeKey(context.projectId, projects)
        : null;
      const messageProject = context?.message
        ? inferProjectFromMessage(context.message, projects, tasks)
        : null;
      const draftProject =
        context?.draftText || (context?.draftMentions && context.draftMentions.length > 0)
          ? resolveProjectFromChatText(
              context?.draftText ?? "",
              projects,
              tasks,
              context?.draftMentions,
            )
          : null;
      const targetScope: ProjectScopeKey =
        pathProject?.id ??
        (explicitProject && explicitProject !== GENERAL_PROJECT_SCOPE ? explicitProject : null) ??
        messageProject?.id ??
        draftProject?.id ??
        workspaceStateRef.current.activeProjectScope;

      setImageTabs(upserted.tabs);
      setWorkspaceState((prev) =>
        activateTabInWorkspace(prev, makeImageUnifiedTabId(upserted.activeTabId), targetScope, {
          switchProject: true,
        }),
      );
      void window.conductor.setLayout({ showBrowserPane: true });

      if (needsDiskLoad && localPathToLoad) {
        void loadImageTabFromDisk(upserted.activeTabId, localPathToLoad);
      }
    },
    [loadImageTabFromDisk],
  );

  const loadLightboxImageFromDisk = useCallback(async (requestId: number, pathOrUrl: string) => {
    setLightboxImage((prev) =>
      prev && prev.requestId === requestId
        ? {
            ...prev,
            diskFallbackAttempted: true,
            tab: { ...prev.tab, isLoading: true, error: null },
          }
        : prev,
    );
    try {
      const res = await window.conductor.imageReadFile(pathOrUrl);
      if (res.ok && res.dataUrl) {
        setLightboxImage((prev) =>
          prev && prev.requestId === requestId
            ? {
                ...prev,
                tab: {
                  ...prev.tab,
                  src: res.dataUrl!,
                  fileName: res.fileName ?? prev.tab.fileName,
                  imagePath: res.filePath || prev.tab.imagePath,
                  isLoading: false,
                  error: null,
                },
              }
            : prev,
        );
      } else {
        setLightboxImage((prev) =>
          prev && prev.requestId === requestId
            ? {
                ...prev,
                tab: {
                  ...prev.tab,
                  isLoading: false,
                  error: res.error ?? "画像を読み込めませんでした。",
                },
              }
            : prev,
        );
      }
    } catch (err) {
      setLightboxImage((prev) =>
        prev && prev.requestId === requestId
          ? {
              ...prev,
              tab: {
                ...prev.tab,
                isLoading: false,
                error: err instanceof Error ? err.message : "画像を読み込めませんでした。",
              },
            }
          : prev,
      );
    }
  }, []);

  const handleOpenImageAttachment = useCallback(
    (
      attachment: ChatAttachment,
      context?: {
        message?: ChatMessage;
        draftText?: string;
        draftMentions?: ExplicitMentionTarget[];
        projectId?: string | null;
      },
    ) => {
      if (!isViewableImageAttachment(attachment)) return;
      const { tab, localPathToLoad } = buildImageTabFromAttachment(attachment);
      const requestId = lightboxRequestIdRef.current + 1;
      lightboxRequestIdRef.current = requestId;
      const needsDiskLoad = Boolean(!tab.src && localPathToLoad);

      setLightboxImage({
        requestId,
        attachment,
        context,
        tab,
        diskFallbackAttempted: needsDiskLoad,
      });

      if (needsDiskLoad && localPathToLoad) {
        void loadLightboxImageFromDisk(requestId, localPathToLoad);
      }
    },
    [loadLightboxImageFromDisk],
  );

  const handleCloseLightbox = useCallback(() => {
    lightboxRequestIdRef.current += 1;
    setLightboxImage(null);
  }, []);

  const handleOpenLightboxInRightPane = useCallback(() => {
    if (!lightboxImage) return;
    const mergedAttachment = mergeLoadedImageIntoAttachment(
      lightboxImage.attachment,
      lightboxImage.tab,
    );
    const context = lightboxImage.context;
    lightboxRequestIdRef.current += 1;
    setLightboxImage(null);
    setSelectedTaskId(null);
    openImageAttachmentInRightPane(mergedAttachment, context);
  }, [lightboxImage, openImageAttachmentInRightPane]);

  const handleRetryLightboxImage = useCallback(() => {
    if (!lightboxImage?.tab.imagePath) return;
    void loadLightboxImageFromDisk(lightboxImage.requestId, lightboxImage.tab.imagePath);
  }, [lightboxImage, loadLightboxImageFromDisk]);

  const handleLightboxImageLoadError = useCallback(() => {
    if (!lightboxImage) return;
    if (lightboxImage.tab.imagePath && !lightboxImage.diskFallbackAttempted) {
      void loadLightboxImageFromDisk(lightboxImage.requestId, lightboxImage.tab.imagePath);
      return;
    }
    setLightboxImage((prev) =>
      prev && prev.requestId === lightboxImage.requestId
        ? {
            ...prev,
            tab: { ...prev.tab, isLoading: false, error: "画像データの読み込みに失敗しました。" },
          }
        : prev,
    );
  }, [lightboxImage, loadLightboxImageFromDisk]);

  const handleRetryImageTab = useCallback(
    (tabId: string) => {
      const target = imageTabs.find((t) => t.id === tabId);
      if (!target?.imagePath) return;
      void loadImageTabFromDisk(tabId, target.imagePath);
    },
    [imageTabs, loadImageTabFromDisk],
  );

  const handleOpenMarkdownImage = useCallback(
    (
      image: MarkdownOpenedImage,
      context?: { message?: ChatMessage; projectId?: string | null },
    ) => {
      const fallbackProjectId = context?.projectId ?? activeProjectItem.project?.id ?? null;
      handleOpenImageAttachment(buildAttachmentFromMarkdownImage(image), {
        message: context?.message,
        projectId: fallbackProjectId,
      });
    },
    [activeProjectItem.project?.id, handleOpenImageAttachment],
  );

  const handleImageLoadError = useCallback(
    (tabId: string) => {
      const target = imageTabs.find((t) => t.id === tabId);
      if (target?.imagePath && !imageDiskFallbackAttemptedRef.current.has(tabId)) {
        void loadImageTabFromDisk(tabId, target.imagePath);
        return;
      }
      setImageTabs((prev) =>
        prev.map((t) =>
          t.id === tabId
            ? { ...t, isLoading: false, error: "画像データの読み込みに失敗しました。" }
            : t,
        ),
      );
    },
    [imageTabs, loadImageTabFromDisk],
  );

  const loadCodeFileIntoTab = useCallback(
    async (
      filePath: string,
      options?: {
        rootPath?: string;
        switchToViewer?: boolean;
        activateTab?: boolean;
        fallbackProjectId?: string | null;
      },
    ) => {
      const shouldSwitch = options?.switchToViewer !== false;
      const shouldActivate = options?.activateTab !== false;

      if (shouldSwitch) {
        void window.conductor.setLayout({ showBrowserPane: true });
      }

      const baseName = filePath.split(/[/\\]/).pop() || filePath;
      const snap = snapshotRef.current;
      const projects = snap?.projects ?? [];
      const tasks = snap?.tasks ?? [];

      const pathProject = inferProjectFromFilePath(filePath, projects, tasks);
      const fallbackProject = options?.fallbackProjectId
        ? toProjectScopeKey(options.fallbackProjectId, projects)
        : null;
      const targetScope: ProjectScopeKey =
        pathProject?.id ??
        (fallbackProject && fallbackProject !== GENERAL_PROJECT_SCOPE ? fallbackProject : null) ??
        workspaceStateRef.current.activeProjectScope;

      // Insert/mark tab loading immediately for snappy feedback
      setCodeTabs((prev) => {
        const existingIdx = prev.findIndex((t) => t.filePath === filePath);
        if (existingIdx >= 0) {
          const copy = [...prev];
          copy[existingIdx] = { ...copy[existingIdx], isLoading: true };
          return copy;
        }
        return [
          ...prev,
          {
            filePath,
            fileName: baseName,
            document: null,
            error: null,
            isLoading: true,
            lastReloadedAt: null,
          },
        ];
      });

      if (shouldActivate) {
        setWorkspaceState((prev) =>
          activateTabInWorkspace(prev, makeCodeUnifiedTabId(filePath), targetScope, {
            switchProject: shouldSwitch,
          }),
        );
      }

      try {
        const result = await window.conductor.fsReadTextFile(
          filePath,
          options?.rootPath ? { rootPath: options.rootPath } : undefined,
        );
        const now = Date.now();
        if (result.ok && result.document) {
          const doc = result.document;
          setCodeTabs((prev) =>
            prev.map((t) =>
              t.filePath === filePath
                ? {
                    filePath: doc.filePath,
                    fileName: doc.fileName,
                    document: doc,
                    error: null,
                    isBinary: false,
                    isTooLarge: false,
                    isLoading: false,
                    lastReloadedAt: now,
                  }
                : t,
            ),
          );
        } else {
          setCodeTabs((prev) =>
            prev.map((t) =>
              t.filePath === filePath
                ? {
                    ...t,
                    error: result.error ?? "ファイルを読み込めませんでした。",
                    isBinary: Boolean(result.isBinary),
                    isTooLarge: Boolean(result.isTooLarge),
                    isLoading: false,
                    lastReloadedAt: now,
                  }
                : t,
            ),
          );
        }
      } catch (err) {
        const msg = formatFileTreeIpcError(err, "ファイルを読み込めませんでした。");
        setCodeTabs((prev) =>
          prev.map((t) =>
            t.filePath === filePath
              ? {
                  ...t,
                  error: msg,
                  isLoading: false,
                  lastReloadedAt: Date.now(),
                }
              : t,
          ),
        );
      }
    },
    [],
  );

  const handleOpenProjectFile = useCallback(
    (entry: ProjectFileEntry) => {
      if (entry.isDirectory) return;
      const kind = entry.fileKind ?? classifyProjectFile(entry.path);
      const fallbackProjectId = activeProjectItem.project?.id ?? null;

      if (kind === "markdown") {
        handleOpenMarkdownFile(entry.path, undefined, { fallbackProjectId });
        return;
      }
      if (kind === "image") {
        openImageAttachmentInRightPane(
          {
            id: `file-image:${entry.path}`,
            kind: "image",
            label: entry.name,
            imagePath: entry.path,
          },
          { projectId: fallbackProjectId },
        );
        return;
      }
      void loadCodeFileIntoTab(entry.path, {
        rootPath: activeProjectItem.path ?? undefined,
        switchToViewer: true,
        activateTab: true,
        fallbackProjectId,
      });
    },
    [
      activeProjectItem.path,
      activeProjectItem.project?.id,
      handleOpenMarkdownFile,
      openImageAttachmentInRightPane,
      loadCodeFileIntoTab,
    ],
  );

  const handleRefreshActiveCode = useCallback(() => {
    if (!activeCodePath) return;
    void loadCodeFileIntoTab(activeCodePath, {
      switchToViewer: false,
      activateTab: false,
    });
  }, [activeCodePath, loadCodeFileIntoTab]);

  const handleCloseRightPane = useCallback(() => {
    hideBrowserBounds();
    void window.conductor.setLayout({ showBrowserPane: false });
  }, []);

  const handleNewBrowserTab = useCallback(async () => {
    const scope = workspaceStateRef.current.activeProjectScope;
    const browserProjectId = scopeKeyToBrowserProjectId(scope);
    void window.conductor.setLayout({ showBrowserPane: true });
    const newTabId = await window.conductor.browserNewTab("", browserProjectId);
    if (typeof newTabId === "string" && newTabId) {
      seenBrowserTabIdsRef.current?.add(newTabId);
      setWorkspaceState((prev) =>
        activateTabInWorkspace(prev, makeBrowserUnifiedTabId(newTabId), scope, {
          switchProject: true,
        }),
      );
    }
  }, []);

  const handleNewTerminalTab = useCallback(async () => {
    const scope = workspaceStateRef.current.activeProjectScope;
    const projects = snapshotRef.current?.projects ?? [];
    const activeProject =
      scope !== GENERAL_PROJECT_SCOPE ? (projects.find((p) => p.id === scope) ?? null) : null;
    const initialCwd = activeProject?.path ?? null;
    const projectId = activeProject?.id ?? null;

    const nextSeq = (terminalSeqByScopeRef.current.get(scope) ?? 0) + 1;
    terminalSeqByScopeRef.current.set(scope, nextSeq);

    const sessionId = `term-${crypto.randomUUID()}`;
    const defaultLabel = t(uiLocaleRef.current, "terminal.defaultTitle");
    const placeholderTab: TerminalTab = {
      id: sessionId,
      title: buildTerminalTabTitle(null, nextSeq, defaultLabel),
      cwd: initialCwd ?? "",
      shell: null,
      shellName: null,
      pid: null,
      backend: null,
      projectId,
      status: "starting",
      exitCode: null,
      error: null,
      sequenceNumber: nextSeq,
    };

    hideBrowserBounds();
    void window.conductor.setLayout({ showBrowserPane: true });
    setTerminalTabs((prev) => [...prev, placeholderTab]);
    setWorkspaceState((prev) =>
      activateTabInWorkspace(prev, makeTerminalUnifiedTabId(sessionId), scope, {
        switchProject: true,
      }),
    );

    try {
      const result = await window.conductor.terminalCreate({
        id: sessionId,
        cwd: initialCwd,
        projectId,
      });

      // If user closed the tab while the shell was starting, kill the newly created PTY immediately
      if (!terminalTabsRef.current.some((tab) => tab.id === sessionId)) {
        if (result.ok && result.session) {
          void window.conductor.terminalClose(result.session.id);
        }
        terminalOutputStore.delete(sessionId);
        return;
      }

      if (result.ok && result.session) {
        const session = result.session;
        setTerminalTabs((prev) =>
          prev.map((tab) =>
            tab.id === sessionId
              ? {
                  ...tab,
                  title: buildTerminalTabTitle(session.shellName, tab.sequenceNumber, defaultLabel),
                  cwd: session.cwd,
                  shell: session.shell,
                  shellName: session.shellName,
                  pid: session.pid,
                  backend: session.backend,
                  status: "running",
                  exitCode: null,
                  error: null,
                }
              : tab,
          ),
        );
      } else {
        setTerminalTabs((prev) =>
          prev.map((tab) =>
            tab.id === sessionId
              ? {
                  ...tab,
                  status: "error",
                  error: result.error ?? t(uiLocaleRef.current, "terminal.startFailed"),
                }
              : tab,
          ),
        );
      }
    } catch (err) {
      setTerminalTabs((prev) =>
        prev.map((tab) =>
          tab.id === sessionId
            ? {
                ...tab,
                status: "error",
                error:
                  err instanceof Error
                    ? err.message
                    : t(uiLocaleRef.current, "terminal.startFailed"),
              }
            : tab,
        ),
      );
    }
  }, []);

  const handleRestartTerminalTab = useCallback(async (tabId: string) => {
    const existing = terminalTabsRef.current.find((tab) => tab.id === tabId);
    if (!existing) return;

    await window.conductor.terminalClose(tabId);
    terminalOutputStore.clearBuffer(tabId);

    setTerminalTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId
          ? { ...tab, status: "starting", exitCode: null, error: null, pid: null }
          : tab,
      ),
    );

    const defaultLabel = t(uiLocaleRef.current, "terminal.defaultTitle");
    try {
      const result = await window.conductor.terminalCreate({
        id: tabId,
        cwd: existing.cwd || null,
        projectId: existing.projectId,
      });

      if (!terminalTabsRef.current.some((tab) => tab.id === tabId)) {
        if (result.ok && result.session) {
          void window.conductor.terminalClose(result.session.id);
        }
        terminalOutputStore.delete(tabId);
        return;
      }

      if (result.ok && result.session) {
        const session = result.session;
        setTerminalTabs((prev) =>
          prev.map((tab) =>
            tab.id === tabId
              ? {
                  ...tab,
                  title: buildTerminalTabTitle(session.shellName, tab.sequenceNumber, defaultLabel),
                  cwd: session.cwd,
                  shell: session.shell,
                  shellName: session.shellName,
                  pid: session.pid,
                  backend: session.backend,
                  status: "running",
                  exitCode: null,
                  error: null,
                }
              : tab,
          ),
        );
      } else {
        setTerminalTabs((prev) =>
          prev.map((tab) =>
            tab.id === tabId
              ? {
                  ...tab,
                  status: "error",
                  error: result.error ?? t(uiLocaleRef.current, "terminal.startFailed"),
                }
              : tab,
          ),
        );
      }
    } catch (err) {
      setTerminalTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId
            ? {
                ...tab,
                status: "error",
                error:
                  err instanceof Error
                    ? err.message
                    : t(uiLocaleRef.current, "terminal.startFailed"),
              }
            : tab,
        ),
      );
    }
  }, []);

  const handleOpenUrlInBrowser = useCallback(
    async (
      url: string,
      options?: {
        task?: AgentTask | null;
        message?: ChatMessage | null;
        projectId?: string | null;
        newTab?: boolean;
      },
    ) => {
      const snap = snapshotRef.current;
      const projects = snap?.projects ?? [];
      const tasks = snap?.tasks ?? [];

      const explicitScope = options?.projectId
        ? toProjectScopeKey(options.projectId, projects)
        : null;
      const filePathProject = /^file:\/\//i.test(url.trim())
        ? inferProjectFromFilePath(url, projects, tasks)
        : null;
      const taskProject = inferProjectFromTask(options?.task, projects);
      const messageProject = inferProjectFromMessage(options?.message, projects, tasks);

      const targetScope: ProjectScopeKey =
        (explicitScope && explicitScope !== GENERAL_PROJECT_SCOPE ? explicitScope : null) ??
        filePathProject?.id ??
        taskProject?.id ??
        messageProject?.id ??
        workspaceStateRef.current.activeProjectScope;

      const browserProjectId = scopeKeyToBrowserProjectId(targetScope);
      void window.conductor.setLayout({ showBrowserPane: true });

      const normalizedTarget = normalizeUrlForCompare(url);
      const projectBrowserTabs = (snap?.browserTabs ?? []).filter(
        (bt) => toProjectScopeKey(bt.projectId, projects) === targetScope,
      );

      if (!options?.newTab) {
        const exactMatch = projectBrowserTabs.find(
          (bt) => bt.url && normalizeUrlForCompare(bt.url) === normalizedTarget,
        );
        if (exactMatch) {
          void window.conductor.browserSelectTab(exactMatch.id);
          setWorkspaceState((prev) =>
            activateTabInWorkspace(prev, makeBrowserUnifiedTabId(exactMatch.id), targetScope, {
              switchProject: true,
            }),
          );
          return;
        }

        const blankTab = projectBrowserTabs.find((bt) => !bt.url);
        if (blankTab) {
          await window.conductor.browserSelectTab(blankTab.id);
          await window.conductor.browserNavigate(url, false, browserProjectId);
          setWorkspaceState((prev) =>
            activateTabInWorkspace(prev, makeBrowserUnifiedTabId(blankTab.id), targetScope, {
              switchProject: true,
            }),
          );
          return;
        }
      }

      const newTabId = await window.conductor.browserNewTab(url, browserProjectId);
      if (typeof newTabId === "string" && newTabId) {
        seenBrowserTabIdsRef.current?.add(newTabId);
        setWorkspaceState((prev) =>
          activateTabInWorkspace(prev, makeBrowserUnifiedTabId(newTabId), targetScope, {
            switchProject: true,
          }),
        );
      } else {
        setWorkspaceState((prev) => switchActiveProjectScope(prev, targetScope));
      }
    },
    [],
  );

  const handleNavigateActiveBrowser = useCallback(async (url: string, newTab = false) => {
    const scope = workspaceStateRef.current.activeProjectScope;
    const browserProjectId = scopeKeyToBrowserProjectId(scope);
    if (newTab) {
      const newTabId = await window.conductor.browserNewTab(url, browserProjectId);
      if (typeof newTabId === "string" && newTabId) {
        seenBrowserTabIdsRef.current?.add(newTabId);
        setWorkspaceState((prev) =>
          activateTabInWorkspace(prev, makeBrowserUnifiedTabId(newTabId), scope, {
            switchProject: true,
          }),
        );
      }
      return;
    }
    await window.conductor.browserNavigate(url, false, browserProjectId);
  }, []);

  const handleSelectUnifiedTab = useCallback(
    (tab: UnifiedRightPaneTab) => {
      setWorkspaceState((prev) => selectTabInWorkspace(prev, tab.id));
      if (tab.kind === "browser") {
        void window.conductor.browserSelectTab(tab.browserTab.id);
      } else if (tab.kind === "markdown") {
        // Re-read on tab focus so edits made while tab was inactive are reflected immediately
        void loadMarkdownIntoTab(tab.markdownTab.filePath, {
          switchToViewer: false,
          activateTab: false,
          anchor: null,
        });
      }
    },
    [loadMarkdownIntoTab],
  );

  const handleCloseUnifiedTab = useCallback((tab: UnifiedRightPaneTab) => {
    const { nextState, nextActiveTabId } = closeTabInWorkspace(workspaceStateRef.current, tab.id);
    setWorkspaceState(nextState);

    if (tab.kind === "browser") {
      void window.conductor.browserCloseTab(tab.browserTab.id);
    } else if (tab.kind === "markdown") {
      lastSelfSavedMdDocsRef.current.delete(tab.markdownTab.filePath);
      setMdTabs((prev) => prev.filter((t) => t.filePath !== tab.markdownTab.filePath));
    } else if (tab.kind === "code") {
      setCodeTabs((prev) => prev.filter((t) => t.filePath !== tab.codeTab.filePath));
    } else if (tab.kind === "terminal") {
      void window.conductor.terminalClose(tab.terminalTab.id);
      terminalOutputStore.delete(tab.terminalTab.id);
      setTerminalTabs((prev) => prev.filter((t) => t.id !== tab.terminalTab.id));
    } else if (tab.kind === "image") {
      imageDiskFallbackAttemptedRef.current.delete(tab.imageTab.id);
      setImageTabs((prev) => {
        const next = prev.filter((t) => t.id !== tab.imageTab.id);
        imageTabsRef.current = next;
        return next;
      });
    }

    const parsedNext = nextActiveTabId ? parseUnifiedTabId(nextActiveTabId) : null;
    if (parsedNext?.kind === "browser") {
      void window.conductor.browserSelectTab(parsedNext.rawId);
    } else {
      hideBrowserBounds();
    }
  }, []);

  const handleSelectProjectScope = useCallback((scopeKey: ProjectScopeKey) => {
    setWorkspaceState((prev) => switchActiveProjectScope(prev, scopeKey));
  }, []);

  const captureScreenshot = useCallback(async () => {
    const att = await window.conductor.browserCaptureScreenshot();
    if (att) {
      updateAttachments((prev) => [...prev, att]);
    }
  }, [updateAttachments]);

  const attachConsoleErrors = useCallback(async () => {
    const att = await window.conductor.browserGetConsoleAttachment();
    if (att) {
      updateAttachments((prev) => [...prev, att]);
    }
  }, [updateAttachments]);

  const handleToggleElementPicker = useCallback(() => {
    void window.conductor.setLayout({ showBrowserPane: true });
    if (activeUnifiedTab?.kind !== "browser") {
      const firstBrowserTab = activeProjectTabs.find((t) => t.kind === "browser");
      if (firstBrowserTab && firstBrowserTab.kind === "browser") {
        setWorkspaceState((prev) => selectTabInWorkspace(prev, firstBrowserTab.id));
        void window.conductor.browserSelectTab(firstBrowserTab.browserTab.id).then(() => {
          void window.conductor.browserToggleElementPicker();
        });
        return;
      }
    }
    void window.conductor.browserToggleElementPicker();
  }, [activeUnifiedTab, activeProjectTabs]);

  const handleToggleMarkdownViewer = useCallback(() => {
    const snap = snapshotRef.current;
    if (!snap) return;
    if (!snap.showBrowserPane) {
      void window.conductor.setLayout({ showBrowserPane: true });
    }
    const existingMdTab = activeProjectTabs.find((t) => t.kind === "markdown");
    if (existingMdTab && activeUnifiedTab?.kind !== "markdown") {
      handleSelectUnifiedTab(existingMdTab);
      return;
    }
    void handleOpenMarkdownDialog();
  }, [activeProjectTabs, activeUnifiedTab?.kind, handleSelectUnifiedTab, handleOpenMarkdownDialog]);

  // Global keyboard shortcuts from macOS menu
  useEffect(() => {
    return window.conductor.onShortcut((action) => {
      const snap = snapshotRef.current;
      if (!snap) return;
      switch (action) {
        case "toggle-sidebar":
          void window.conductor.setLayout({ showTaskSidebar: !snap.showTaskSidebar });
          break;
        case "toggle-browser":
          if (snap.showBrowserPane) {
            handleCloseRightPane();
          } else {
            void window.conductor.setLayout({ showBrowserPane: true });
          }
          break;
        case "toggle-markdown-viewer":
          handleToggleMarkdownViewer();
          break;
        case "new-terminal":
          void handleNewTerminalTab();
          break;
        case "open-markdown-file":
          void handleOpenMarkdownDialog();
          break;
        case "new-chat":
          setNewChatConfirmTrigger((n) => n + 1);
          break;
        case "add-project":
          void window.conductor.addProjectDialog();
          break;
        case "scan-directory":
          void window.conductor.scanDirectoryDialog();
          break;
        case "toggle-picker":
          handleToggleElementPicker();
          break;
        case "capture-screenshot":
          void captureScreenshot();
          break;
        case "check-updates":
          setDismissedUpdateTag(null);
          setSettingsModalTab("general");
          break;
      }
    });
  }, [
    captureScreenshot,
    handleToggleMarkdownViewer,
    handleOpenMarkdownDialog,
    handleNewTerminalTab,
    handleToggleElementPicker,
    handleCloseRightPane,
  ]);

  const startResize = (e: React.MouseEvent, side: "left" | "right") => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = side === "left" ? leftWidth : rightWidth;

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      if (side === "left") {
        setLeftWidth(Math.min(420, Math.max(210, startW + dx)));
      } else {
        const maxRight = Math.max(420, window.innerWidth * 0.62);
        setRightWidth(Math.min(maxRight, Math.max(320, startW - dx)));
      }
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const handleSend = useCallback(
    (submittedText?: string) => {
      const snap = snapshotRef.current;
      if (!snap) return;
      const text = submittedText ?? "";
      const atts = [...attachmentsRef.current];
      const mentions = [...selectedMentionsRef.current];
      if (!text.trim() && atts.length === 0) return;

      updateAttachments([]);
      updateSelectedMentions([]);

      // Automatically switch the right-pane project scope when the user mentions a project or task
      const mentionedProject = resolveProjectFromChatText(
        text,
        snap.projects,
        snap.tasks,
        mentions,
      );
      if (mentionedProject) {
        setWorkspaceState((prev) => switchActiveProjectScope(prev, mentionedProject.id));
      }

      void window.conductor.sendMessage({
        text,
        attachments: atts,
        ...(mentions.length > 0 ? { mentions } : {}),
      });
    },
    [updateAttachments, updateSelectedMentions],
  );

  const handleAttachCurrentUrl = useCallback(() => {
    const snap = snapshotRef.current;
    if (!snap) return;
    const firstBrowserWithUrl = activeProjectTabs.find(
      (t): t is Extract<UnifiedRightPaneTab, { kind: "browser" }> =>
        t.kind === "browser" && Boolean(t.browserTab.url),
    );
    const activeBrowser =
      (activeUnifiedTab?.kind === "browser" ? activeUnifiedTab.browserTab : null) ??
      firstBrowserWithUrl?.browserTab ??
      snap.browserTabs.find((t) => t.id === snap.activeBrowserTabId) ??
      null;
    if (!activeBrowser?.url) return;
    updateAttachments((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        kind: "browserURL",
        label: activeBrowser.title || activeBrowser.url,
        url: activeBrowser.url,
        metadataText: `[Current In-App Browser URL: ${activeBrowser.url} (${activeBrowser.title})]`,
      },
    ]);
  }, [activeProjectTabs, activeUnifiedTab, updateAttachments]);

  const handleAttachMarkdownFile = useCallback(
    (filePath: string, fileName: string) => {
      updateAttachments((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          kind: "taskRef",
          label: `MD: ${fileName}`,
          metadataText: `[Referenced Local Markdown File path="${filePath}"]`,
        },
      ]);
    },
    [updateAttachments],
  );

  const handleAttachCodeFile = useCallback(
    (filePath: string, fileName: string) => {
      updateAttachments((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          kind: "taskRef",
          label: `File: ${fileName}`,
          metadataText: `[Referenced Local File path="${filePath}"]`,
        },
      ]);
    },
    [updateAttachments],
  );

  const handleAddMention = useCallback(
    (target: ExplicitMentionTarget) => {
      updateSelectedMentions((prev) => addExplicitMentionTarget(prev, target));
    },
    [updateSelectedMentions],
  );

  const handleRemoveMention = useCallback(
    (target: MentionChipRemovalTarget) => {
      updateSelectedMentions((prev) => removeExplicitMentionTarget(prev, target));
    },
    [updateSelectedMentions],
  );

  const handleMentionProject = useCallback(
    (proj: Project) => {
      handleAddMention({
        kind: "project",
        projectId: proj.id,
        projectName: proj.name,
        projectPath: proj.path,
        projectColorHex: proj.colorHex,
      });
    },
    [handleAddMention],
  );

  const handleMentionTask = useCallback(
    (task: AgentTask) => {
      const projects = snapshotRef.current?.projects ?? [];
      const taskProject = projects.find(
        (p) =>
          (task.projectId && p.id === task.projectId) ||
          p.name.toLowerCase() === task.projectName.toLowerCase(),
      );
      handleAddMention({
        kind: "task",
        taskId: task.id,
        taskNumber: task.taskNumber,
        taskTitle: task.title,
        taskStatus: task.status,
        projectId: taskProject?.id ?? task.projectId,
        projectName: task.projectName || taskProject?.name || "",
        projectPath: task.projectPath ?? taskProject?.path ?? null,
        projectColorHex: taskProject?.colorHex ?? "#6366F1",
      });
    },
    [handleAddMention],
  );

  const handleUpdateTaskStatus = useCallback(
    (taskId: string, status: AgentTaskStatus) => window.conductor.updateTaskStatus(taskId, status),
    [],
  );

  const handleAddProjectDialog = useCallback(() => {
    void window.conductor.addProjectDialog();
  }, []);

  const handleScanDirectoryDialog = useCallback(() => {
    void window.conductor.scanDirectoryDialog();
  }, []);

  const handleRescanProjects = useCallback(() => {
    void window.conductor.rescanProjects();
  }, []);

  const handleRemoveProject = useCallback((id: string) => {
    setSelectedProjectId((prev) => (prev === id ? null : prev));
    void window.conductor.removeProject(id);
  }, []);

  const handleOpenPreviewUrl = useCallback(
    (url: string, task?: AgentTask) => {
      void handleOpenUrlInBrowser(url, { task });
    },
    [handleOpenUrlInBrowser],
  );

  const handleStopWorker = useCallback((id: string) => {
    void window.conductor.stopTaskWorker(id);
  }, []);

  const handleDeleteTask = useCallback((id: string) => {
    setSelectedTaskId((prev) => (prev === id ? null : prev));
    void window.conductor.deleteTask(id);
  }, []);

  const handleLandTask = useCallback((id: string, opts?: { createPr?: boolean }) => {
    void window.conductor.landTask(id, opts);
  }, []);

  const handleRemoveAttachment = useCallback(
    (id: string) => {
      updateAttachments((prev) => prev.filter((a) => a.id !== id));
    },
    [updateAttachments],
  );

  const handleAddAttachment = useCallback(
    (att: ChatAttachment) => {
      updateAttachments((prev) => [...prev, att]);
    },
    [updateAttachments],
  );

  const handleStopMessage = useCallback((id: string) => {
    void window.conductor.stopMessage(id);
  }, []);

  const handleStopAllResponders = useCallback(() => {
    void window.conductor.stopAllResponders();
  }, []);

  const handleNewChat = useCallback(() => {
    updateSelectedMentions([]);
    void window.conductor.startFreshChat();
  }, [updateSelectedMentions]);

  const handleSelectChatSession = useCallback((id: string) => {
    void window.conductor.selectChatSession(id);
  }, []);

  const handleDeleteChatSession = useCallback((id: string) => {
    void window.conductor.deleteChatSession(id);
  }, []);

  const handleToggleSidebar = useCallback(() => {
    const snap = snapshotRef.current;
    if (!snap) return;
    void window.conductor.setLayout({ showTaskSidebar: !snap.showTaskSidebar });
  }, []);

  const handleToggleBrowserPane = useCallback(() => {
    const snap = snapshotRef.current;
    if (!snap) return;
    if (snap.showBrowserPane) {
      handleCloseRightPane();
    } else {
      void window.conductor.setLayout({ showBrowserPane: true });
    }
  }, [handleCloseRightPane]);

  const handleOpenChatUrl = useCallback(
    (url: string, ctx?: { message?: ChatMessage }) => {
      void handleOpenUrlInBrowser(url, { message: ctx?.message });
    },
    [handleOpenUrlInBrowser],
  );

  const handleCaptureScreenshotClick = useCallback(() => {
    void captureScreenshot();
  }, [captureScreenshot]);

  const handleAttachConsoleErrorsClick = useCallback(() => {
    void attachConsoleErrors();
  }, [attachConsoleErrors]);

  const handlePickLocalImages = useCallback(async () => {
    const imgs = await window.conductor.pickLocalImages();
    if (imgs.length > 0) updateAttachments((prev) => [...prev, ...imgs]);
  }, [updateAttachments]);

  const handlePasteImage = useCallback(
    async (base64: string) => {
      const att = await window.conductor.savePastedImage(base64);
      if (att) updateAttachments((prev) => [...prev, att]);
    },
    [updateAttachments],
  );

  const handleReconnect = useCallback(() => {
    void window.conductor.reconnect();
  }, []);

  const handleDismissError = useCallback(() => {
    void window.conductor.dismissError();
  }, []);

  const handleSetChatProvider = useCallback((p: AppSnapshot["chatProvider"]) => {
    void window.conductor.setChatProvider(p);
  }, []);

  const handleSetWorkerProvider = useCallback((p: AppSnapshot["workerProvider"]) => {
    void window.conductor.setWorkerProvider(p);
  }, []);

  const handleSetChatModel = useCallback((m: string, e?: string) => {
    void window.conductor.setChatModel(m, e);
  }, []);

  const handleSetWorkerModel = useCallback((m: string, e?: string) => {
    void window.conductor.setWorkerModel(m, e);
  }, []);

  const handleOpenUsage = useCallback(() => {
    setSettingsModalTab("usage");
    void window.conductor.refreshProviderQuotas();
  }, []);

  const handleOpenSettings = useCallback(() => {
    setSettingsModalTab("general");
  }, []);

  const handleToggleVoiceReadback = useCallback(() => {
    const snap = snapshotRef.current;
    if (!snap) return;
    const next = !snap.voiceReadbackEnabled;
    if (!next) {
      handleStopSpeaking();
    }
    void window.conductor.setVoiceReadbackEnabled(next);
  }, [handleStopSpeaking]);

  const handleToggleVoiceAutoSend = useCallback(() => {
    setVoiceAutoSend((prev) => {
      const next = !prev;
      saveVoiceAutoSend(next);
      return next;
    });
  }, []);

  const handleNavigateBrowserProp = useCallback(
    (url: string, newTab?: boolean) => {
      void handleNavigateActiveBrowser(url, newTab);
    },
    [handleNavigateActiveBrowser],
  );

  const handleNewBrowserTabClick = useCallback(() => {
    void handleNewBrowserTab();
  }, [handleNewBrowserTab]);

  const handleNewTerminalTabClick = useCallback(() => {
    void handleNewTerminalTab();
  }, [handleNewTerminalTab]);

  const handleRestartTerminalTabClick = useCallback(
    (tabId: string) => {
      void handleRestartTerminalTab(tabId);
    },
    [handleRestartTerminalTab],
  );

  const handleBrowserBack = useCallback(() => {
    void window.conductor.browserBack();
  }, []);

  const handleBrowserForward = useCallback(() => {
    void window.conductor.browserForward();
  }, []);

  const handleBrowserReload = useCallback(() => {
    void window.conductor.browserReload();
  }, []);

  const handleBrowserToggleDevTools = useCallback(() => {
    void window.conductor.browserToggleDevTools();
  }, []);

  const handleBrowserOpenExternal = useCallback(() => {
    void window.conductor.browserOpenExternal();
  }, []);

  const handleClearMdPendingAnchor = useCallback(() => {
    setMdPendingAnchor(null);
  }, []);

  const handleToggleMdAutoReload = useCallback(() => {
    setMdAutoReload((v) => !v);
  }, []);

  const handleOpenMarkdownDialogClick = useCallback(() => {
    void handleOpenMarkdownDialog();
  }, [handleOpenMarkdownDialog]);

  const handleRemoveRecentMd = useCallback((fp: string) => {
    setRecentMdFiles((prev) => {
      const next = prev.filter((p) => p !== fp);
      saveRecentMarkdownFiles(next);
      return next;
    });
  }, []);

  const handleOpenRightPaneUrl = useCallback(
    (url: string) => {
      void handleOpenUrlInBrowser(url);
    },
    [handleOpenUrlInBrowser],
  );

  const handleRevealInFinder = useCallback((fp: string) => {
    void window.conductor.openPathInFinder(fp);
  }, []);

  const handleCheckForUpdates = useCallback(() => {
    void window.conductor.updaterCheckForUpdates?.().then((state) => {
      if (state) setAppUpdate(state);
    });
  }, []);

  const handleDownloadAndOpenUpdate = useCallback(() => {
    setDismissedUpdateTag(null);
    void window.conductor.updaterDownloadAndOpen?.().then((state) => {
      if (state) setAppUpdate(state);
    });
  }, []);

  const handleCancelUpdateDownload = useCallback(() => {
    void window.conductor.updaterCancelDownload?.().then((state) => {
      if (state) setAppUpdate(state);
    });
  }, []);

  const handleOpenDownloadedUpdate = useCallback(() => {
    void window.conductor.updaterOpenDownloaded?.();
  }, []);

  const handleShowDownloadedUpdateInFolder = useCallback(() => {
    void window.conductor.updaterShowInFolder?.();
  }, []);

  const handleOpenUpdateReleasePage = useCallback((url?: string) => {
    void window.conductor.updaterOpenReleasePage?.(url);
  }, []);

  const handleInstallAndRestartUpdate = useCallback(() => {
    void window.conductor.updaterInstallAndRestart?.();
  }, []);

  const handleSetApplyUpdateOnQuit = useCallback((enabled: boolean) => {
    void window.conductor.updaterSetApplyOnQuit?.(enabled).then((state) => {
      if (state) setAppUpdate(state);
    });
  }, []);

  const handleDismissUpdateBanner = useCallback(() => {
    if (appUpdate?.latestRelease?.tagName) {
      setDismissedUpdateTag(appUpdate.latestRelease.tagName);
    }
  }, [appUpdate?.latestRelease?.tagName]);

  if (!snapshot) {
    return (
      <div className="h-full w-full flex items-center justify-center text-[13px] text-zinc-400">
        {t(uiLocale, "app.starting")}
      </div>
    );
  }

  const selectedTask = selectedTaskId
    ? snapshot.tasks.find((t) => t.id === selectedTaskId) ?? null
    : null;

  const selectedTaskProject = selectedTask
    ? snapshot.projects.find(
        (p) =>
          p.id === selectedTask.projectId ||
          p.name.toLowerCase() === selectedTask.projectName.toLowerCase(),
      ) ?? null
    : null;

  const selectedTaskColor = selectedTaskProject?.colorHex ?? "#6366F1";

  const handleWindowDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
    }
  };

  const handleWindowDrop = (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer?.files ?? []);
    const mdPaths = files
      .map(
        (file) =>
          window.conductor.getPathForFile(file) ||
          (file as File & { path?: string }).path ||
          "",
      )
      .filter((p) => p && isMarkdownPathOrUrl(p));

    if (mdPaths.length > 0) {
      e.preventDefault();
      for (const p of mdPaths) {
        handleOpenMarkdownFile(p);
      }
    }
  };

  return (
    <div
      onDragOver={handleWindowDragOver}
      onDrop={handleWindowDrop}
      className="flex h-screen w-screen overflow-hidden"
    >
      {/* Left Pane: Agent Tasks */}
      {snapshot.showTaskSidebar && (
        <>
          <div style={{ width: leftWidth }} className="shrink-0 h-full">
            <TaskSidebar
              projects={snapshot.projects}
              tasks={snapshot.tasks}
              questions={questions}
              defaultIntegrationMode={snapshot.defaultIntegrationMode}
              locale={uiLocale}
              selectedProjectId={selectedProjectId}
              selectedTaskId={selectedTaskId}
              onSelectProjectFilter={setSelectedProjectId}
              onAddProject={handleAddProjectDialog}
              onScanDirectory={handleScanDirectoryDialog}
              onRescanProjects={handleRescanProjects}
              onRemoveProject={handleRemoveProject}
              onMentionProject={handleMentionProject}
              onSelectTask={setSelectedTaskId}
              onSelectQuestion={handleSelectQuestion}
              onOpenPreviewUrl={handleOpenPreviewUrl}
              onMentionTask={handleMentionTask}
              onUpdateTaskStatus={handleUpdateTaskStatus}
              onStopWorker={handleStopWorker}
              onDeleteTask={handleDeleteTask}
              onLandTask={handleLandTask}
            />
          </div>
          <div
            onMouseDown={(e) => startResize(e, "left")}
            className="w-1 hover:bg-indigo-500/40 cursor-col-resize transition-colors shrink-0"
          />
        </>
      )}

      {/* Center Pane: Single Unified Non-Blocking Chat */}
      <div className="flex-1 min-w-[360px] h-full">
        <UnifiedChat
          snapshot={snapshot}
          locale={uiLocale}
          attachments={attachments}
          selectedMentions={selectedMentions}
          jumpRequest={jumpRequest}
          unreadReplyIds={unreadReplyIds}
          onMarkMessagesRead={handleMarkMessagesRead}
          isMessageVisibleRef={isMessageVisibleRef}
          onAddMention={handleAddMention}
          onRemoveMention={handleRemoveMention}
          onRemoveAttachment={handleRemoveAttachment}
          onAddAttachment={handleAddAttachment}
          onSend={handleSend}
          onStopMessage={handleStopMessage}
          onStopAll={handleStopAllResponders}
          onNewChat={handleNewChat}
          onSelectChatSession={handleSelectChatSession}
          onDeleteChatSession={handleDeleteChatSession}
          newChatConfirmTrigger={newChatConfirmTrigger}
          onToggleSidebar={handleToggleSidebar}
          onToggleBrowser={handleToggleBrowserPane}
          rightPaneMode={derivedRightPaneMode}
          isBrowserTabActive={isBrowserTabActive}
          onToggleMarkdownViewer={handleToggleMarkdownViewer}
          onAddProject={handleAddProjectDialog}
          onOpenUrl={handleOpenChatUrl}
          onOpenMarkdownFile={handleOpenMarkdownFile}
          onOpenImageAttachment={handleOpenImageAttachment}
          onOpenMarkdownImage={handleOpenMarkdownImage}
          onOpenTask={setSelectedTaskId}
          onUpdateTaskStatus={handleUpdateTaskStatus}
          onLandTask={handleLandTask}
          onToggleElementPicker={handleToggleElementPicker}
          onCaptureScreenshot={handleCaptureScreenshotClick}
          onAttachCurrentUrl={handleAttachCurrentUrl}
          onAttachConsoleErrors={handleAttachConsoleErrorsClick}
          onPickLocalImages={handlePickLocalImages}
          onPasteImage={handlePasteImage}
          onReconnect={handleReconnect}
          onDismissError={handleDismissError}
          onSetChatProvider={handleSetChatProvider}
          onSetWorkerProvider={handleSetWorkerProvider}
          onSetChatModel={handleSetChatModel}
          onSetWorkerModel={handleSetWorkerModel}
          onOpenUsage={handleOpenUsage}
          onOpenSettings={handleOpenSettings}
          voiceReadbackEnabled={Boolean(snapshot.voiceReadbackEnabled)}
          isSpeaking={isSpeaking}
          voiceAutoSend={voiceAutoSend}
          onToggleVoiceReadback={handleToggleVoiceReadback}
          onStopSpeaking={handleStopSpeaking}
          onToggleVoiceAutoSend={handleToggleVoiceAutoSend}
          appUpdate={appUpdate}
          updateBannerDismissed={
            Boolean(dismissedUpdateTag) &&
            dismissedUpdateTag === appUpdate?.latestRelease?.tagName
          }
          onDismissUpdateBanner={handleDismissUpdateBanner}
          onDownloadAndOpenUpdate={handleDownloadAndOpenUpdate}
          onOpenDownloadedUpdate={handleOpenDownloadedUpdate}
          onShowDownloadedUpdateInFolder={handleShowDownloadedUpdateInFolder}
          onOpenUpdateReleasePage={handleOpenUpdateReleasePage}
          onInstallAndRestartUpdate={handleInstallAndRestartUpdate}
        />
      </div>

      {/* Right Pane: Unified Project-Scoped Browser / Markdown / Image Tabs */}
      {snapshot.showBrowserPane && (
        <>
          <div
            onMouseDown={(e) => startResize(e, "right")}
            className="w-1 hover:bg-indigo-500/40 cursor-col-resize transition-colors shrink-0"
          />
          <div style={{ width: rightWidth }} className="shrink-0 h-full">
            <UnifiedRightPane
              activeProjectItem={activeProjectItem}
              switcherWithTabs={switcherData.withTabs}
              switcherOthers={switcherData.others}
              tabs={activeProjectTabs}
              activeTab={activeUnifiedTab}
              projectRecentMdFiles={projectRecentMdFiles}
              locale={uiLocale}
              isPickingElement={snapshot.isPickingElement}
              hideNativeView={Boolean(
                selectedTask || settingsModalTab !== null || lightboxImage !== null,
              )}
              onNavigateBrowser={handleNavigateBrowserProp}
              onNewBrowserTab={handleNewBrowserTabClick}
              onBrowserBack={handleBrowserBack}
              onBrowserForward={handleBrowserForward}
              onBrowserReload={handleBrowserReload}
              onBrowserToggleDevTools={handleBrowserToggleDevTools}
              onBrowserTogglePicker={handleToggleElementPicker}
              onBrowserCaptureScreenshot={handleCaptureScreenshotClick}
              onBrowserAttachUrl={handleAttachCurrentUrl}
              onBrowserAttachErrors={handleAttachConsoleErrorsClick}
              onBrowserOpenExternal={handleBrowserOpenExternal}
              mdAutoReload={mdAutoReload}
              mdIsWatching={mdIsWatching}
              mdJustReloadedAt={mdJustReloadedAt}
              mdPendingAnchor={mdPendingAnchor}
              onClearMdPendingAnchor={handleClearMdPendingAnchor}
              onToggleMdAutoReload={handleToggleMdAutoReload}
              onOpenMarkdownDialog={handleOpenMarkdownDialogClick}
              onOpenMarkdownFile={handleOpenMarkdownFile}
              onRefreshActiveMd={handleRefreshActiveMd}
              onRemoveRecentMd={handleRemoveRecentMd}
              onAttachMdFileToChat={handleAttachMarkdownFile}
              onOpenMarkdownImage={handleOpenMarkdownImage}
              onMarkdownDraftChange={handleMarkdownDraftChange}
              onSaveActiveMd={handleSaveActiveMarkdown}
              onDiscardActiveMd={handleDiscardActiveMarkdown}
              onReloadExternalMdChange={handleReloadExternalMarkdownChange}
              onDismissExternalMdChange={handleDismissExternalMarkdownChange}
              onChangeMdViewMode={handleChangeMarkdownViewMode}
              onRetryImageTab={handleRetryImageTab}
              onImageLoadError={handleImageLoadError}
              onOpenProjectFile={handleOpenProjectFile}
              onRefreshActiveCode={handleRefreshActiveCode}
              onAttachCodeFileToChat={handleAttachCodeFile}
              onNewTerminalTab={handleNewTerminalTabClick}
              onRestartTerminalTab={handleRestartTerminalTabClick}
              onCloseRightPane={handleCloseRightPane}
              onSelectProjectScope={handleSelectProjectScope}
              onSelectTab={handleSelectUnifiedTab}
              onCloseTab={handleCloseUnifiedTab}
              onOpenUrl={handleOpenRightPaneUrl}
              onRevealInFinder={handleRevealInFinder}
            />
          </div>
        </>
      )}

      {/* Task Inspector Modal (automatically hides WebContentsView while open) */}
      {selectedTask && (
        <TaskInspectorModal
          task={selectedTask}
          project={selectedTaskProject}
          projectColorHex={selectedTaskColor}
          defaultIntegrationMode={snapshot.defaultIntegrationMode}
          locale={uiLocale}
          onClose={() => setSelectedTaskId(null)}
          onUpdateStatus={(st) => handleUpdateTaskStatus(selectedTask.id, st)}
          onOpenPreviewUrl={(url) => void handleOpenUrlInBrowser(url, { task: selectedTask })}
          onOpenMarkdownFile={(target, base) =>
            handleOpenMarkdownFile(target, base, {
              fallbackProjectId: selectedTaskProject?.id ?? null,
            })
          }
          onOpenImage={(image) =>
            handleOpenMarkdownImage(image, { projectId: selectedTaskProject?.id ?? null })
          }
          onMentionInChat={() => handleMentionTask(selectedTask)}
          onStopWorker={() => void window.conductor.stopTaskWorker(selectedTask.id)}
          onLandTask={(opts) => window.conductor.landTask(selectedTask.id, opts)}
          onResolveConflictWithAI={() => window.conductor.resolveTaskConflictWithAI(selectedTask.id)}
          onCleanupWorktree={async () => {
            await window.conductor.cleanupTaskWorktree(selectedTask.id);
          }}
        />
      )}

      {/* Conductor Settings & Usage Modal */}
      {settingsModalTab !== null && (
        <SettingsModal
          defaultIntegrationMode={snapshot.defaultIntegrationMode}
          autoLandOnComplete={snapshot.autoLandOnComplete}
          preferredLanguage={snapshot.preferredLanguage}
          voiceReadbackEnabled={Boolean(snapshot.voiceReadbackEnabled)}
          voiceAutoSend={voiceAutoSend}
          remoteAccess={snapshot.remoteAccess}
          locale={uiLocale}
          projects={snapshot.projects}
          initialTab={settingsModalTab}
          usageRecords={snapshot.usageRecords ?? []}
          usageBudgets={snapshot.usageBudgets}
          providerQuotas={snapshot.providerQuotas}
          onClearUsage={() => void window.conductor.clearUsageRecords()}
          onUpdateUsageBudgets={(budgets) => void window.conductor.setUsageBudgets(budgets)}
          onRefreshProviderQuotas={() => window.conductor.refreshProviderQuotas()}
          onClose={() => setSettingsModalTab(null)}
          onSetDefaultIntegrationMode={(mode) =>
            void window.conductor.setDefaultIntegrationMode(mode)
          }
          onSetAutoLandOnComplete={(enabled) =>
            void window.conductor.setAutoLandOnComplete(enabled)
          }
          onSetProjectIntegrationMode={(projectId, mode) =>
            void window.conductor.setProjectIntegrationMode(projectId, mode)
          }
          onChangePreferredLanguage={(lang) =>
            void window.conductor.setPreferredLanguage(lang)
          }
          onSetVoiceReadbackEnabled={(enabled) => {
            if (!enabled) {
              handleStopSpeaking();
            }
            void window.conductor.setVoiceReadbackEnabled(enabled);
          }}
          onSetVoiceAutoSend={updateVoiceAutoSend}
          onSetRemoteAccessEnabled={(enabled) =>
            void window.conductor.setRemoteAccessEnabled(enabled)
          }
          onSetRemoteAccessPort={(port) =>
            void window.conductor.setRemoteAccessPort(port)
          }
          onRegenerateRemoteAccessToken={() =>
            void window.conductor.regenerateRemoteAccessToken()
          }
          onRefreshRemoteAccessStatus={() =>
            void window.conductor.refreshRemoteAccessStatus()
          }
          appUpdate={appUpdate}
          onCheckForUpdates={handleCheckForUpdates}
          onDownloadAndOpenUpdate={handleDownloadAndOpenUpdate}
          onCancelUpdateDownload={handleCancelUpdateDownload}
          onOpenDownloadedUpdate={handleOpenDownloadedUpdate}
          onShowDownloadedUpdateInFolder={handleShowDownloadedUpdateInFolder}
          onOpenUpdateReleasePage={handleOpenUpdateReleasePage}
          onInstallAndRestartUpdate={handleInstallAndRestartUpdate}
          onSetApplyUpdateOnQuit={handleSetApplyUpdateOnQuit}
        />
      )}
      {/* Center Image Lightbox Modal (automatically hides WebContentsView while open) */}
      {lightboxImage && (
        <ImageLightboxModal
          image={lightboxImage.tab}
          locale={uiLocale}
          onClose={handleCloseLightbox}
          onOpenInRightPane={handleOpenLightboxInRightPane}
          onRetryLoad={handleRetryLightboxImage}
          onImageLoadError={handleLightboxImageLoadError}
          onOpenUrl={(url) => void handleOpenUrlInBrowser(url)}
          onRevealInFinder={handleRevealInFinder}
        />
      )}
    </div>
  );
};
