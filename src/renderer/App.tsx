import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentTask,
  AgentTaskStatus,
  AppSnapshot,
  ChatAttachment,
  ChatMessage,
  ExplicitMentionTarget,
  Project,
  ProjectFileEntry,
  RightPaneMode,
} from "../shared/types.js";
import { classifyProjectFile, formatFileTreeIpcError } from "../shared/file-tree.js";
import {
  addExplicitMentionTarget,
  removeExplicitMentionTarget,
  type MentionChipRemovalTarget,
} from "../shared/mentions.js";
import type { MarkdownViewerTab } from "./components/MarkdownViewerPane.js";
import { SettingsModal } from "./components/SettingsModal.js";
import { TaskInspectorModal } from "./components/TaskInspectorModal.js";
import { TaskSidebar } from "./components/TaskSidebar.js";
import { UnifiedChat, type ChatJumpRequest } from "./components/UnifiedChat.js";
import { UnifiedRightPane } from "./components/UnifiedRightPane.js";
import {
  buildImageTabFromAttachment,
  isViewableImageAttachment,
  upsertImageTab,
  type ImageViewerTab,
} from "./lib/image-viewer.js";
import { extractHash, isMarkdownPathOrUrl } from "./lib/markdown-utils.js";
import {
  deriveQuestionItems,
  reconcileUnreadReplies,
  type QuestionItem,
} from "./lib/questions.js";
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
  loadRightPaneWorkspaceFromStorage,
  makeBrowserUnifiedTabId,
  makeCodeUnifiedTabId,
  makeImageUnifiedTabId,
  makeMarkdownUnifiedTabId,
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
  type UnifiedRightPaneTab,
} from "./lib/right-pane-tabs.js";

const RECENT_MD_STORAGE_KEY = "conductor:recentMarkdownFiles";

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

export const App: React.FC = () => {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [composerText, setComposerText] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [selectedMentions, setSelectedMentions] = useState<ExplicitMentionTarget[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

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

  // Right-pane Code/Text Viewer state (opened from Project File Tree)
  const [codeTabs, setCodeTabs] = useState<CodeViewerTab[]>([]);

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

  const questions = useMemo(
    () => deriveQuestionItems(snapshot?.messages ?? [], unreadReplyIds),
    [snapshot?.messages, unreadReplyIds],
  );

  useEffect(() => {
    void window.conductor.getSnapshot().then(setSnapshot);
    const unsubSnap = window.conductor.onSnapshot(setSnapshot);
    const unsubAtt = window.conductor.onAttachmentFromBrowser((att) => {
      setAttachments((prev) => [...prev, att]);
    });
    return () => {
      unsubSnap();
      unsubAtt();
    };
  }, []);

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
    mdRestoreTick,
  ]);

  // Persist right-pane workspace state (active project, tab order, open markdown files)
  useEffect(() => {
    if (!snapshot || pendingRestoreMdPathsRef.current.size > 0) return;
    saveRightPaneWorkspaceToStorage(workspaceState, mdTabs);
  }, [snapshot, workspaceState, mdTabs]);

  // Derived unified right-pane selectors
  const activeProjectScope = workspaceState.activeProjectScope;
  const tabSources = useMemo(
    () => ({
      browserTabs: snapshot?.browserTabs ?? [],
      mdTabs,
      imageTabs,
      codeTabs,
      projects: snapshot?.projects ?? [],
    }),
    [snapshot?.browserTabs, snapshot?.projects, mdTabs, imageTabs, codeTabs],
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
  const derivedRightPaneMode: RightPaneMode = activeUnifiedTab?.kind ?? "browser";

  // Keep native Electron BrowserManager active tab & WebContentsView visibility in sync
  useEffect(() => {
    if (!snapshot) return;
    if (!snapshot.showBrowserPane || activeUnifiedTab?.kind !== "browser") {
      void window.conductor.browserSetBounds({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        visible: false,
      });
      return;
    }
    if (snapshot.activeBrowserTabId !== activeUnifiedTab.browserTab.id) {
      void window.conductor.browserSelectTab(activeUnifiedTab.browserTab.id);
    }
  }, [
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
          const nextTab: MarkdownViewerTab = {
            filePath: doc.filePath,
            fileName: doc.fileName,
            document: doc,
            error: null,
            deletedOnDisk: false,
            isLoading: false,
            lastReloadedAt: now,
          };
          if (existingIdx >= 0) {
            const copy = [...prev];
            copy[existingIdx] = nextTab;
            return copy;
          }
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
              error: result.error ?? "ファイルを読み込めませんでした。",
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
              error: result.error ?? "ファイルを読み込めませんでした。",
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
    setMdTabs((prev) =>
      prev.map((t) => (t.filePath === activeMdPath ? { ...t, isLoading: true } : t)),
    );
    void loadMarkdownIntoTab(activeMdPath, {
      switchToViewer: false,
      activateTab: false,
      anchor: null,
    }).then(() => {
      setMdJustReloadedAt(Date.now());
    });
  }, [activeMdPath, loadMarkdownIntoTab]);

  // Subscribe to main-process file watcher live-reload events
  useEffect(() => {
    return window.conductor.onMarkdownFileChanged((event) => {
      if (event.kind === "changed" && event.document) {
        const doc = event.document;
        const now = Date.now();
        setMdTabs((prev) =>
          prev.map((t) =>
            t.filePath === event.filePath
              ? {
                  ...t,
                  document: doc,
                  error: null,
                  deletedOnDisk: false,
                  isLoading: false,
                  lastReloadedAt: now,
                }
              : t,
          ),
        );
        setMdJustReloadedAt(now);
      } else if (event.kind === "deleted") {
        setMdTabs((prev) =>
          prev.map((t) =>
            t.filePath === event.filePath
              ? {
                  ...t,
                  deletedOnDisk: true,
                  error: event.error ?? "ファイルが削除または移動されました。",
                  isLoading: false,
                }
              : t,
          ),
        );
      } else if (event.kind === "error") {
        setMdTabs((prev) =>
          prev.map((t) =>
            t.filePath === event.filePath
              ? {
                  ...t,
                  error: event.error ?? "ファイルの再読み込みに失敗しました。",
                  isLoading: false,
                }
              : t,
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

  const handleRetryImageTab = useCallback(
    (tabId: string) => {
      const target = imageTabs.find((t) => t.id === tabId);
      if (!target?.imagePath) return;
      void loadImageTabFromDisk(tabId, target.imagePath);
    },
    [imageTabs, loadImageTabFromDisk],
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
        handleOpenImageAttachment(
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
      handleOpenImageAttachment,
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
    void window.conductor.browserSetBounds({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      visible: false,
    });
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
      const taskProject = inferProjectFromTask(options?.task, projects);
      const messageProject = inferProjectFromMessage(options?.message, projects, tasks);

      const targetScope: ProjectScopeKey =
        (explicitScope && explicitScope !== GENERAL_PROJECT_SCOPE ? explicitScope : null) ??
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
      setMdTabs((prev) => prev.filter((t) => t.filePath !== tab.markdownTab.filePath));
    } else if (tab.kind === "code") {
      setCodeTabs((prev) => prev.filter((t) => t.filePath !== tab.codeTab.filePath));
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
      void window.conductor.browserSetBounds({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        visible: false,
      });
    }
  }, []);

  const handleSelectProjectScope = useCallback((scopeKey: ProjectScopeKey) => {
    setWorkspaceState((prev) => switchActiveProjectScope(prev, scopeKey));
  }, []);

  const captureScreenshot = useCallback(async () => {
    const att = await window.conductor.browserCaptureScreenshot();
    if (att) {
      setAttachments((prev) => [...prev, att]);
    }
  }, []);

  const attachConsoleErrors = useCallback(async () => {
    const att = await window.conductor.browserGetConsoleAttachment();
    if (att) {
      setAttachments((prev) => [...prev, att]);
    }
  }, []);

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
    if (!snapshot) return;
    if (!snapshot.showBrowserPane) {
      void window.conductor.setLayout({ showBrowserPane: true });
    }
    const existingMdTab = activeProjectTabs.find((t) => t.kind === "markdown");
    if (existingMdTab && activeUnifiedTab?.kind !== "markdown") {
      handleSelectUnifiedTab(existingMdTab);
      return;
    }
    void handleOpenMarkdownDialog();
  }, [snapshot, activeProjectTabs, activeUnifiedTab?.kind, handleSelectUnifiedTab, handleOpenMarkdownDialog]);

  // Global keyboard shortcuts from macOS menu
  useEffect(() => {
    return window.conductor.onShortcut((action) => {
      if (!snapshot) return;
      switch (action) {
        case "toggle-sidebar":
          void window.conductor.setLayout({ showTaskSidebar: !snapshot.showTaskSidebar });
          break;
        case "toggle-browser":
          if (snapshot.showBrowserPane) {
            handleCloseRightPane();
          } else {
            void window.conductor.setLayout({ showBrowserPane: true });
          }
          break;
        case "toggle-markdown-viewer":
          handleToggleMarkdownViewer();
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
      }
    });
  }, [
    snapshot,
    captureScreenshot,
    handleToggleMarkdownViewer,
    handleOpenMarkdownDialog,
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

  if (!snapshot) {
    return (
      <div className="h-full w-full flex items-center justify-center text-[13px] text-zinc-400">
        Conductor を起動しています...
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

  const handleSend = () => {
    const text = composerText;
    const atts = attachments;
    const mentions = selectedMentions;
    setComposerText("");
    setAttachments([]);
    setSelectedMentions([]);

    // Automatically switch the right-pane project scope when the user mentions a project or task
    const mentionedProject = resolveProjectFromChatText(
      text,
      snapshot.projects,
      snapshot.tasks,
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
  };

  const handleAttachCurrentUrl = () => {
    const firstBrowserWithUrl = activeProjectTabs.find(
      (t): t is Extract<UnifiedRightPaneTab, { kind: "browser" }> =>
        t.kind === "browser" && Boolean(t.browserTab.url),
    );
    const activeBrowser =
      (activeUnifiedTab?.kind === "browser" ? activeUnifiedTab.browserTab : null) ??
      firstBrowserWithUrl?.browserTab ??
      snapshot.browserTabs.find((t) => t.id === snapshot.activeBrowserTabId) ??
      null;
    if (!activeBrowser?.url) return;
    setAttachments((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        kind: "browserURL",
        label: activeBrowser.title || activeBrowser.url,
        url: activeBrowser.url,
        metadataText: `[Current In-App Browser URL: ${activeBrowser.url} (${activeBrowser.title})]`,
      },
    ]);
  };

  const handleAttachMarkdownFile = (filePath: string, fileName: string) => {
    setAttachments((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        kind: "taskRef",
        label: `MD: ${fileName}`,
        metadataText: `[Referenced Local Markdown File path="${filePath}"]`,
      },
    ]);
  };

  const handleAttachCodeFile = (filePath: string, fileName: string) => {
    setAttachments((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        kind: "taskRef",
        label: `File: ${fileName}`,
        metadataText: `[Referenced Local File path="${filePath}"]`,
      },
    ]);
  };

  const handleAddMention = (target: ExplicitMentionTarget) => {
    setSelectedMentions((prev) => addExplicitMentionTarget(prev, target));
  };

  const handleRemoveMention = (target: MentionChipRemovalTarget) => {
    setSelectedMentions((prev) => removeExplicitMentionTarget(prev, target));
  };

  const handleMentionProject = (proj: Project) => {
    handleAddMention({
      kind: "project",
      projectId: proj.id,
      projectName: proj.name,
    });
  };

  const handleMentionTask = (task: (typeof snapshot.tasks)[number]) => {
    handleAddMention({
      kind: "task",
      taskId: task.id,
      taskNumber: task.taskNumber,
    });
  };

  const handleUpdateTaskStatus = (taskId: string, status: AgentTaskStatus) => {
    void window.conductor.updateTaskStatus(taskId, status);
  };

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
              selectedProjectId={selectedProjectId}
              selectedTaskId={selectedTaskId}
              onSelectProjectFilter={setSelectedProjectId}
              onAddProject={() => void window.conductor.addProjectDialog()}
              onScanDirectory={() => void window.conductor.scanDirectoryDialog()}
              onRescanProjects={() => void window.conductor.rescanProjects()}
              onRemoveProject={(id) => {
                if (selectedProjectId === id) setSelectedProjectId(null);
                void window.conductor.removeProject(id);
              }}
              onMentionProject={handleMentionProject}
              onSelectTask={setSelectedTaskId}
              onSelectQuestion={handleSelectQuestion}
              onOpenPreviewUrl={(url, task) => void handleOpenUrlInBrowser(url, { task })}
              onMentionTask={handleMentionTask}
              onUpdateTaskStatus={handleUpdateTaskStatus}
              onStopWorker={(id) => void window.conductor.stopTaskWorker(id)}
              onDeleteTask={(id) => {
                if (selectedTaskId === id) setSelectedTaskId(null);
                void window.conductor.deleteTask(id);
              }}
              onLandTask={(id, opts) => void window.conductor.landTask(id, opts)}
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
          composerText={composerText}
          attachments={attachments}
          selectedMentions={selectedMentions}
          jumpRequest={jumpRequest}
          unreadReplyIds={unreadReplyIds}
          onMarkMessagesRead={handleMarkMessagesRead}
          isMessageVisibleRef={isMessageVisibleRef}
          onComposerTextChange={setComposerText}
          onAddMention={handleAddMention}
          onRemoveMention={handleRemoveMention}
          onRemoveAttachment={(id) => setAttachments((prev) => prev.filter((a) => a.id !== id))}
          onAddAttachment={(att) => setAttachments((prev) => [...prev, att])}
          onSend={handleSend}
          onStopMessage={(id) => void window.conductor.stopMessage(id)}
          onStopAll={() => void window.conductor.stopAllResponders()}
          onNewChat={() => {
            setSelectedMentions([]);
            void window.conductor.startFreshChat();
          }}
          onSelectChatSession={(id) => void window.conductor.selectChatSession(id)}
          onDeleteChatSession={(id) => void window.conductor.deleteChatSession(id)}
          newChatConfirmTrigger={newChatConfirmTrigger}
          onToggleSidebar={() =>
            void window.conductor.setLayout({ showTaskSidebar: !snapshot.showTaskSidebar })
          }
          onToggleBrowser={() => {
            if (snapshot.showBrowserPane) {
              handleCloseRightPane();
            } else {
              void window.conductor.setLayout({ showBrowserPane: true });
            }
          }}
          rightPaneMode={derivedRightPaneMode}
          onToggleMarkdownViewer={handleToggleMarkdownViewer}
          onAddProject={() => void window.conductor.addProjectDialog()}
          onOpenUrl={(url, ctx) => void handleOpenUrlInBrowser(url, { message: ctx?.message })}
          onOpenMarkdownFile={handleOpenMarkdownFile}
          onOpenImageAttachment={handleOpenImageAttachment}
          onOpenTask={setSelectedTaskId}
          onUpdateTaskStatus={handleUpdateTaskStatus}
          onLandTask={(id, opts) => void window.conductor.landTask(id, opts)}
          onToggleElementPicker={handleToggleElementPicker}
          onCaptureScreenshot={() => void captureScreenshot()}
          onAttachCurrentUrl={handleAttachCurrentUrl}
          onAttachConsoleErrors={() => void attachConsoleErrors()}
          onPickLocalImages={async () => {
            const imgs = await window.conductor.pickLocalImages();
            if (imgs.length > 0) setAttachments((prev) => [...prev, ...imgs]);
          }}
          onPasteImage={async (base64) => {
            const att = await window.conductor.savePastedImage(base64);
            if (att) setAttachments((prev) => [...prev, att]);
          }}
          onReconnect={() => void window.conductor.reconnect()}
          onDismissError={() => void window.conductor.dismissError()}
          onSetChatProvider={(p) => void window.conductor.setChatProvider(p)}
          onSetWorkerProvider={(p) => void window.conductor.setWorkerProvider(p)}
          onSetChatModel={(m, e) => void window.conductor.setChatModel(m, e)}
          onSetWorkerModel={(m, e) => void window.conductor.setWorkerModel(m, e)}
          onOpenSettings={() => setShowSettings(true)}
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
              isPickingElement={snapshot.isPickingElement}
              hideNativeView={Boolean(selectedTask || showSettings)}
              onNavigateBrowser={(url, newTab) => void handleNavigateActiveBrowser(url, newTab)}
              onNewBrowserTab={() => void handleNewBrowserTab()}
              onBrowserBack={() => void window.conductor.browserBack()}
              onBrowserForward={() => void window.conductor.browserForward()}
              onBrowserReload={() => void window.conductor.browserReload()}
              onBrowserToggleDevTools={() => void window.conductor.browserToggleDevTools()}
              onBrowserTogglePicker={handleToggleElementPicker}
              onBrowserCaptureScreenshot={() => void captureScreenshot()}
              onBrowserAttachErrors={() => void attachConsoleErrors()}
              onBrowserOpenExternal={() => void window.conductor.browserOpenExternal()}
              mdAutoReload={mdAutoReload}
              mdIsWatching={mdIsWatching}
              mdJustReloadedAt={mdJustReloadedAt}
              mdPendingAnchor={mdPendingAnchor}
              onClearMdPendingAnchor={() => setMdPendingAnchor(null)}
              onToggleMdAutoReload={() => setMdAutoReload((v) => !v)}
              onOpenMarkdownDialog={() => void handleOpenMarkdownDialog()}
              onOpenMarkdownFile={handleOpenMarkdownFile}
              onRefreshActiveMd={handleRefreshActiveMd}
              onRemoveRecentMd={(fp) => {
                setRecentMdFiles((prev) => {
                  const next = prev.filter((p) => p !== fp);
                  saveRecentMarkdownFiles(next);
                  return next;
                });
              }}
              onAttachMdFileToChat={handleAttachMarkdownFile}
              onRetryImageTab={handleRetryImageTab}
              onImageLoadError={handleImageLoadError}
              onOpenProjectFile={handleOpenProjectFile}
              onRefreshActiveCode={handleRefreshActiveCode}
              onAttachCodeFileToChat={handleAttachCodeFile}
              onCloseRightPane={handleCloseRightPane}
              onSelectProjectScope={handleSelectProjectScope}
              onSelectTab={handleSelectUnifiedTab}
              onCloseTab={handleCloseUnifiedTab}
              onOpenUrl={(url) => void handleOpenUrlInBrowser(url)}
              onRevealInFinder={(fp) => void window.conductor.openPathInFinder(fp)}
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
          onClose={() => setSelectedTaskId(null)}
          onUpdateStatus={(st) => handleUpdateTaskStatus(selectedTask.id, st)}
          onOpenPreviewUrl={(url) => void handleOpenUrlInBrowser(url, { task: selectedTask })}
          onOpenMarkdownFile={(target, base) =>
            handleOpenMarkdownFile(target, base, {
              fallbackProjectId: selectedTaskProject?.id ?? null,
            })
          }
          onMentionInChat={() => handleMentionTask(selectedTask)}
          onStopWorker={() => void window.conductor.stopTaskWorker(selectedTask.id)}
          onLandTask={(opts) => window.conductor.landTask(selectedTask.id, opts)}
          onResolveConflictWithAI={() => window.conductor.resolveTaskConflictWithAI(selectedTask.id)}
          onCleanupWorktree={async () => {
            await window.conductor.cleanupTaskWorktree(selectedTask.id);
          }}
          onDelete={() => {
            void window.conductor.deleteTask(selectedTask.id);
            setSelectedTaskId(null);
          }}
        />
      )}

      {/* Conductor Settings Modal */}
      {showSettings && (
        <SettingsModal
          defaultIntegrationMode={snapshot.defaultIntegrationMode}
          autoLandOnComplete={snapshot.autoLandOnComplete}
          preferredLanguage={snapshot.preferredLanguage}
          projects={snapshot.projects}
          onClose={() => setShowSettings(false)}
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
        />
      )}
    </div>
  );
};
