import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  BarChart3,
  Bell,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  FolderOpen,
  GitMerge,
  GitPullRequest,
  Image as ImageIcon,
  Loader2,
  PanelLeft,
  PanelRight,
  RefreshCw,
  RotateCcw,
  Settings,
  Sparkles,
  Square,
  Volume2,
  VolumeX,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import type {
  AgentProvider,
  AgentTask,
  AgentTaskStatus,
  AppSnapshot,
  AppUpdateState,
  ChatAttachment,
  ChatMessage,
  ChatSessionSummary,
  ExplicitMentionTarget,
  IntegrationMode,
  Project,
  ProviderStatus,
  RightPaneMode,
  ToolActivityChip,
  UsageBudgetSettings,
  UsageRecord,
} from "../../shared/types.js";
import {
  findProjectForTask,
  formatTaskCode,
  resolveMessageMentionBadges,
  type MentionChipRemovalTarget,
} from "../../shared/mentions.js";
import {
  getLocalizedMarkTaskDoneBlockedReason,
  requiresLandBeforeDone,
  validateManualTaskStatusTransition,
} from "../../shared/task-status.js";
import {
  evaluateUsageBudget,
  formatTokenCount,
  formatUsdCost,
  normalizeUsageBudgetSettings,
  summarizeAllUsagePeriods,
} from "../../shared/usage.js";
import { resolveUiLocale, t, type UiLocale } from "../../shared/i18n.js";
import { getEffectiveProjectMode } from "../lib/integration-mode.js";
import {
  buildToolChipDisplayPlan,
  formatToolChipsSummary,
} from "../lib/activity-log.js";
import { stabilizeMentionTasks } from "../lib/composer-perf.js";
import { isViewableImageAttachment } from "../lib/image-viewer.js";
import type { MarkdownImageCache } from "../lib/markdown-image-cache.js";
import type { MarkdownVideoCache } from "../lib/markdown-video-cache.js";
import { buildTaskMarkdownBasePath, resolveTaskForTaskEvent } from "../lib/task-event.js";
import { getQuickStatusTransition } from "../lib/task-sidebar.js";
import { ChatComposer, type ChatComposerHandle } from "./ChatComposer.js";
import { ChatSessionControls } from "./ChatHistoryMenu.js";
import { MarkdownView, type MarkdownOpenedImage } from "./MarkdownView.js";
import { UserMessageMentionBadges } from "./MentionBadges.js";
import {
  classifyMessagesUpdate,
  clearPendingProgrammaticScroll,
  computeJumpScrollTop,
  createInitialChatScrollState,
  evaluateAutoScrollOnUpdate,
  handleContainerScroll,
  handleUserScrollIntent,
  recordProgrammaticScroll,
  recordSmoothScrollToBottom,
  shouldShowScrollToBottomButton,
  syncScrollStateAfterResize,
  type ChatScrollState,
  type ScrollMetrics,
} from "../lib/chat-scroll.js";

const EMPTY_PROJECTS: Project[] = [];
const EMPTY_TASKS: AgentTask[] = [];
const EMPTY_MENTIONS: ExplicitMentionTarget[] = [];
const EMPTY_USAGE_RECORDS: UsageRecord[] = [];
const ALL_PROVIDERS: AgentProvider[] = ["codex", "agy", "claude"];

function readScrollMetrics(el: HTMLElement): ScrollMetrics {
  return {
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  };
}

export interface ChatJumpRequest {
  messageId: string;
  nonce: number;
}

interface UnifiedChatProps {
  snapshot: AppSnapshot;
  locale?: UiLocale;
  composerText?: string;
  attachments: ChatAttachment[];
  selectedMentions?: ExplicitMentionTarget[];
  jumpRequest?: ChatJumpRequest | null;
  unreadReplyIds?: ReadonlySet<string>;
  onMarkMessagesRead?: (messageIds: string[]) => void;
  isMessageVisibleRef?: React.MutableRefObject<((messageId: string) => boolean) | null>;
  onComposerTextChange?: (text: string) => void;
  onAddMention?: (target: ExplicitMentionTarget) => void;
  onRemoveMention?: (target: MentionChipRemovalTarget) => void;
  onRemoveAttachment: (id: string) => void;
  onAddAttachment: (att: ChatAttachment) => void;
  onSend: (text?: string) => void;
  onStopMessage: (id: string) => void;
  onStopAll: () => void;
  onNewChat: () => void;
  onSelectChatSession: (sessionId: string) => void;
  onDeleteChatSession: (sessionId: string) => void;
  newChatConfirmTrigger?: number;
  onToggleSidebar: () => void;
  onToggleBrowser: () => void;
  rightPaneMode?: RightPaneMode;
  isBrowserTabActive?: boolean;
  onToggleMarkdownViewer: () => void;
  onAddProject: () => void;
  onOpenUrl: (url: string, context?: { message?: ChatMessage }) => void;
  onOpenMarkdownFile: (
    target: string,
    baseFilePath?: string,
    context?: { message?: ChatMessage },
  ) => void;
  onOpenImageAttachment?: (
    attachment: ChatAttachment,
    context?: {
      message?: ChatMessage;
      draftText?: string;
      draftMentions?: ExplicitMentionTarget[];
    },
  ) => void;
  onOpenMarkdownImage?: (image: MarkdownOpenedImage, context?: { message?: ChatMessage }) => void;
  onOpenTask: (taskId: string) => void;
  onUpdateTaskStatus?: (taskId: string, status: AgentTaskStatus) => void;
  onLandTask?: (taskId: string, options?: { createPr?: boolean }) => void;
  onToggleElementPicker: () => void;
  onCaptureScreenshot: () => void;
  onAttachCurrentUrl: () => void;
  onAttachConsoleErrors: () => void;
  onPickLocalImages: () => void;
  onPasteImage: (base64: string) => void;
  onReconnect: () => void;
  onDismissError: () => void;
  onSetChatProvider: (provider: AgentProvider) => void;
  onSetWorkerProvider: (provider: AgentProvider) => void;
  onSetChatModel: (model: string, effort?: string) => void;
  onSetWorkerModel: (model: string, effort?: string) => void;
  onOpenUsage?: () => void;
  onOpenSettings?: () => void;
  voiceReadbackEnabled?: boolean;
  isSpeaking?: boolean;
  voiceAutoSend?: boolean;
  onToggleVoiceReadback?: () => void;
  onStopSpeaking?: () => void;
  onToggleVoiceAutoSend?: () => void;
  appUpdate?: AppUpdateState | null;
  updateBannerDismissed?: boolean;
  onDismissUpdateBanner?: () => void;
  onDownloadAndOpenUpdate?: () => void;
  onOpenDownloadedUpdate?: () => void;
  onShowDownloadedUpdateInFolder?: () => void;
  onOpenUpdateReleasePage?: (url?: string) => void;
  onInstallAndRestartUpdate?: () => void;
}

export const UnifiedChat: React.FC<UnifiedChatProps> = React.memo(({
  snapshot,
  locale,
  composerText,
  attachments,
  selectedMentions = EMPTY_MENTIONS,
  jumpRequest,
  unreadReplyIds,
  onMarkMessagesRead,
  isMessageVisibleRef,
  onComposerTextChange,
  onAddMention,
  onRemoveMention,
  onRemoveAttachment,
  onSend,
  onStopMessage,
  onStopAll,
  onNewChat,
  onSelectChatSession,
  onDeleteChatSession,
  newChatConfirmTrigger,
  onToggleSidebar,
  onToggleBrowser,
  rightPaneMode,
  isBrowserTabActive = false,
  onToggleMarkdownViewer,
  onAddProject,
  onOpenUrl,
  onOpenMarkdownFile,
  onOpenImageAttachment,
  onOpenMarkdownImage,
  onOpenTask,
  onUpdateTaskStatus,
  onLandTask,
  onToggleElementPicker,
  onCaptureScreenshot,
  onAttachCurrentUrl,
  onAttachConsoleErrors,
  onPickLocalImages,
  onPasteImage,
  onReconnect,
  onDismissError,
  onSetChatProvider,
  onSetWorkerProvider,
  onSetChatModel,
  onSetWorkerModel,
  onOpenUsage,
  onOpenSettings,
  voiceReadbackEnabled = Boolean(snapshot.voiceReadbackEnabled),
  isSpeaking = false,
  voiceAutoSend = false,
  onToggleVoiceReadback,
  onStopSpeaking,
  onToggleVoiceAutoSend,
  appUpdate = null,
  updateBannerDismissed = false,
  onDismissUpdateBanner,
  onDownloadAndOpenUpdate,
  onOpenDownloadedUpdate,
  onShowDownloadedUpdateInFolder,
  onOpenUpdateReleasePage,
  onInstallAndRestartUpdate,
}) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const contentContainerRef = useRef<HTMLDivElement>(null);
  const messageElementsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const scrollStateRef = useRef<ChatScrollState>(createInitialChatScrollState());
  const prevMessagesRef = useRef<readonly ChatMessage[] | null>(null);
  const prevChatSessionIdRef = useRef<string>(snapshot.activeChatSessionId);
  const lastTouchYRef = useRef<number | null>(null);
  const composerHandleRef = useRef<ChatComposerHandle | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const hasMessagesRef = useRef(snapshot.messages.length > 0);
  hasMessagesRef.current = snapshot.messages.length > 0;
  const activeLocale = locale ?? resolveUiLocale(snapshot.preferredLanguage);

  // Stabilize task references for mention badges / autocomplete so high-frequency
  // background worker log ticks never force user messages or the composer to re-render.
  const stableMentionTasksRef = useRef<AgentTask[]>(snapshot.tasks);
  const mentionTasks = stabilizeMentionTasks(stableMentionTasksRef.current, snapshot.tasks);
  stableMentionTasksRef.current = mentionTasks;

  const registerMessageEl = useCallback((messageId: string, el: HTMLDivElement | null) => {
    if (el) {
      messageElementsRef.current.set(messageId, el);
    } else {
      messageElementsRef.current.delete(messageId);
    }
  }, []);

  const checkMessageVisible = useCallback((messageId: string): boolean => {
    const container = scrollContainerRef.current;
    const el = messageElementsRef.current.get(messageId);
    if (!container || !el) return false;
    const containerRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    if (containerRect.height <= 0 || elRect.height <= 0) return false;
    const margin = Math.min(16, elRect.height / 2);
    return elRect.bottom > containerRect.top + margin && elRect.top < containerRect.bottom - margin;
  }, []);

  useEffect(() => {
    if (!isMessageVisibleRef) return;
    isMessageVisibleRef.current = checkMessageVisible;
    return () => {
      isMessageVisibleRef.current = null;
    };
  }, [isMessageVisibleRef, checkMessageVisible]);

  const flushVisibleUnread = useCallback(() => {
    if (!unreadReplyIds || unreadReplyIds.size === 0 || !onMarkMessagesRead) return;
    const newlyVisible: string[] = [];
    for (const id of unreadReplyIds) {
      if (checkMessageVisible(id)) {
        newlyVisible.push(id);
      }
    }
    if (newlyVisible.length > 0) {
      onMarkMessagesRead(newlyVisible);
    }
  }, [unreadReplyIds, onMarkMessagesRead, checkMessageVisible]);

  const flushVisibleUnreadRef = useRef(flushVisibleUnread);
  flushVisibleUnreadRef.current = flushVisibleUnread;

  useEffect(() => {
    if (!unreadReplyIds || unreadReplyIds.size === 0 || !onMarkMessagesRead) return;
    const container = scrollContainerRef.current;
    if (!container || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visibleIds: string[] = [];
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const id = (entry.target as HTMLElement).dataset.messageId;
          if (id && unreadReplyIds.has(id)) {
            visibleIds.push(id);
          }
        }
        if (visibleIds.length > 0) {
          onMarkMessagesRead(visibleIds);
        }
      },
      { root: container, threshold: 0.01 },
    );

    for (const id of unreadReplyIds) {
      const el = messageElementsRef.current.get(id);
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, [unreadReplyIds, onMarkMessagesRead, snapshot.messages.length]);

  const syncScrollToBottomVisibility = useCallback(
    (metrics: ScrollMetrics | null, now: number = Date.now()) => {
      setShowScrollToBottom(
        shouldShowScrollToBottomButton(scrollStateRef.current, metrics, {
          hasMessages: hasMessagesRef.current,
          now,
        }),
      );
    },
    [],
  );

  const scrollContainerToBottom = useCallback(
    (container: HTMLDivElement) => {
      const beforeScrollTop = container.scrollTop;
      container.scrollTop = container.scrollHeight;
      const actualMetrics = readScrollMetrics(container);
      const didScroll = Math.abs(actualMetrics.scrollTop - beforeScrollTop) >= 0.5;
      const now = Date.now();
      scrollStateRef.current = recordProgrammaticScroll(
        scrollStateRef.current,
        "bottom",
        actualMetrics,
        didScroll,
        now,
      );
      syncScrollToBottomVisibility(actualMetrics, now);
    },
    [syncScrollToBottomVisibility],
  );

  const handleScrollToBottomClick = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    if (typeof container.scrollTo === "function") {
      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
    } else {
      container.scrollTop = container.scrollHeight;
    }
    const now = Date.now();
    const metrics = readScrollMetrics(container);
    scrollStateRef.current = recordSmoothScrollToBottom(scrollStateRef.current, metrics, now);
    syncScrollToBottomVisibility(metrics, now);
    flushVisibleUnread();
  }, [flushVisibleUnread, syncScrollToBottomVisibility]);

  const handleChatScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const now = Date.now();
    const metrics = readScrollMetrics(el);
    scrollStateRef.current = handleContainerScroll(scrollStateRef.current, metrics, now);
    syncScrollToBottomVisibility(metrics, now);
    flushVisibleUnread();
  }, [flushVisibleUnread, syncScrollToBottomVisibility]);

  const handleChatWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      const el = scrollContainerRef.current;
      if (!el || e.deltaY === 0) return;
      const metrics = readScrollMetrics(el);
      scrollStateRef.current = handleUserScrollIntent(
        scrollStateRef.current,
        e.deltaY < 0 ? "up" : "down",
        metrics,
      );
      syncScrollToBottomVisibility(metrics);
    },
    [syncScrollToBottomVisibility],
  );

  const handleChatTouchStart = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      lastTouchYRef.current = e.touches[0]?.clientY ?? null;
      scrollStateRef.current = clearPendingProgrammaticScroll(scrollStateRef.current);
      const el = scrollContainerRef.current;
      if (el) {
        syncScrollToBottomVisibility(readScrollMetrics(el));
      }
    },
    [syncScrollToBottomVisibility],
  );

  const handleChatTouchMove = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      const el = scrollContainerRef.current;
      const currentY = e.touches[0]?.clientY;
      const prevY = lastTouchYRef.current;
      if (currentY !== undefined) {
        lastTouchYRef.current = currentY;
      }
      if (!el || currentY === undefined || prevY === null || currentY === prevY) return;
      // Swiping finger downward scrolls chat content upward toward earlier messages.
      const metrics = readScrollMetrics(el);
      scrollStateRef.current = handleUserScrollIntent(
        scrollStateRef.current,
        currentY > prevY ? "up" : "down",
        metrics,
      );
      syncScrollToBottomVisibility(metrics);
    },
    [syncScrollToBottomVisibility],
  );

  const handleChatTouchEnd = useCallback(() => {
    lastTouchYRef.current = null;
  }, []);

  const handleChatPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const el = scrollContainerRef.current;
      if (el && e.target === el) {
        scrollStateRef.current = clearPendingProgrammaticScroll(scrollStateRef.current);
        syncScrollToBottomVisibility(readScrollMetrics(el));
      }
    },
    [syncScrollToBottomVisibility],
  );

  const handleChatKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const el = scrollContainerRef.current;
      if (!el) return;
      if (e.key === "PageUp" || e.key === "ArrowUp" || e.key === "Home") {
        const metrics = readScrollMetrics(el);
        scrollStateRef.current = handleUserScrollIntent(scrollStateRef.current, "up", metrics);
        syncScrollToBottomVisibility(metrics);
      } else if (e.key === "PageDown" || e.key === "ArrowDown" || e.key === "End") {
        const metrics = readScrollMetrics(el);
        scrollStateRef.current = handleUserScrollIntent(scrollStateRef.current, "down", metrics);
        syncScrollToBottomVisibility(metrics);
      }
    },
    [syncScrollToBottomVisibility],
  );

  useEffect(() => {
    const scrollEl = scrollContainerRef.current;
    const contentEl = contentContainerRef.current;
    if (!scrollEl || !contentEl || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      const now = Date.now();
      const metrics = readScrollMetrics(scrollEl);
      scrollStateRef.current = syncScrollStateAfterResize(scrollStateRef.current, metrics, now);
      syncScrollToBottomVisibility(metrics, now);
    });

    observer.observe(contentEl);
    observer.observe(scrollEl);
    return () => observer.disconnect();
  }, [syncScrollToBottomVisibility]);

  useLayoutEffect(() => {
    if (!jumpRequest) return;
    const container = scrollContainerRef.current;
    const el = messageElementsRef.current.get(jumpRequest.messageId);
    if (!container || !el) return;

    const containerRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const targetScrollTop = computeJumpScrollTop({
      containerScrollTop: container.scrollTop,
      containerClientHeight: container.clientHeight,
      containerScrollHeight: container.scrollHeight,
      containerTop: containerRect.top,
      targetTop: elRect.top,
      targetHeight: elRect.height,
    });

    const beforeScrollTop = container.scrollTop;
    container.scrollTop = targetScrollTop;
    const actualMetrics = readScrollMetrics(container);
    const didScroll = Math.abs(actualMetrics.scrollTop - beforeScrollTop) >= 0.5;
    const now = Date.now();
    scrollStateRef.current = recordProgrammaticScroll(
      scrollStateRef.current,
      "jump",
      actualMetrics,
      didScroll,
      now,
    );
    syncScrollToBottomVisibility(actualMetrics, now);
    flushVisibleUnreadRef.current();

    setHighlightedMessageId(jumpRequest.messageId);

    const timer = window.setTimeout(() => {
      setHighlightedMessageId((current) =>
        current === jumpRequest.messageId ? null : current,
      );
    }, 1800);

    return () => window.clearTimeout(timer);
  }, [jumpRequest, syncScrollToBottomVisibility]);

  const activeTab = snapshot.browserTabs.find((t) => t.id === snapshot.activeBrowserTabId);
  const browserErrorCount = (activeTab?.consoleErrorCount ?? 0) + (activeTab?.networkErrorCount ?? 0);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (prevChatSessionIdRef.current !== snapshot.activeChatSessionId) {
      prevChatSessionIdRef.current = snapshot.activeChatSessionId;
      scrollStateRef.current = createInitialChatScrollState();
      prevMessagesRef.current = null;
    }
    const prevMessages = prevMessagesRef.current;
    const nextMessages = snapshot.messages;
    prevMessagesRef.current = nextMessages;

    if (!container) return;

    const updateKind = classifyMessagesUpdate(prevMessages, nextMessages);
    const now = Date.now();
    const currentMetrics = readScrollMetrics(container);
    const decision = evaluateAutoScrollOnUpdate(scrollStateRef.current, {
      updateKind,
      currentMetrics,
      now,
    });
    scrollStateRef.current = decision.nextState;

    if (decision.shouldScrollToBottom) {
      scrollContainerToBottom(container);
      flushVisibleUnreadRef.current();
    } else {
      syncScrollToBottomVisibility(currentMetrics, now);
    }
  }, [
    snapshot.activeChatSessionId,
    snapshot.messages,
    scrollContainerToBottom,
    syncScrollToBottomVisibility,
  ]);

  const handlePickWelcomePrompt = useCallback(
    (prompt: string) => {
      if (composerHandleRef.current) {
        composerHandleRef.current.setDraftText(prompt);
      } else {
        onComposerTextChange?.(prompt);
      }
    },
    [onComposerTextChange],
  );

  const recentProjectNames = useMemo(
    () => snapshot.projects.slice(0, 4).map((p) => p.name),
    [snapshot.projects],
  );

  return (
    <section className="@container flex flex-col h-full min-w-0 bg-white dark:bg-[#0f1115]">
      {/* Top Bar (memoized so typing, scrolling, and message streaming never re-render the header) */}
      <UnifiedChatHeader
        showTaskSidebar={snapshot.showTaskSidebar}
        isConnected={snapshot.isConnected}
        connectionStatus={snapshot.connectionStatus}
        activeResponderCount={snapshot.activeResponderCount}
        providers={snapshot.providers}
        chatProvider={snapshot.chatProvider}
        workerProvider={snapshot.workerProvider}
        chatModel={snapshot.chatModel}
        chatEffort={snapshot.chatEffort}
        workerModel={snapshot.workerModel}
        workerEffort={snapshot.workerEffort}
        usageRecords={snapshot.usageRecords ?? EMPTY_USAGE_RECORDS}
        usageBudgets={snapshot.usageBudgets}
        chatSessions={snapshot.chatSessions}
        activeChatSessionId={snapshot.activeChatSessionId}
        activeMessageCount={snapshot.messages.length}
        showBrowserPane={snapshot.showBrowserPane}
        rightPaneMode={rightPaneMode}
        locale={activeLocale}
        newChatConfirmTrigger={newChatConfirmTrigger}
        voiceReadbackEnabled={voiceReadbackEnabled}
        isSpeaking={isSpeaking}
        appUpdate={appUpdate}
        onToggleSidebar={onToggleSidebar}
        onReconnect={onReconnect}
        onStopAll={onStopAll}
        onStopSpeaking={onStopSpeaking}
        onSetChatProvider={onSetChatProvider}
        onSetWorkerProvider={onSetWorkerProvider}
        onSetChatModel={onSetChatModel}
        onSetWorkerModel={onSetWorkerModel}
        onOpenUsage={onOpenUsage}
        onToggleVoiceReadback={onToggleVoiceReadback}
        onOpenSettings={onOpenSettings}
        onSelectChatSession={onSelectChatSession}
        onNewChat={onNewChat}
        onDeleteChatSession={onDeleteChatSession}
        onToggleMarkdownViewer={onToggleMarkdownViewer}
        onToggleBrowser={onToggleBrowser}
      />

      {/* Subtle App Update Banner */}
      {appUpdate &&
        appUpdate.latestRelease &&
        !updateBannerDismissed &&
        (appUpdate.status === "available" ||
          appUpdate.status === "downloading" ||
          appUpdate.status === "staging" ||
          appUpdate.status === "ready_to_install" ||
          appUpdate.status === "installing" ||
          appUpdate.status === "downloaded") && (
          <div
            data-testid="app-update-banner"
            className={`flex items-center gap-2 px-4 py-1.5 text-[11.5px] border-b shrink-0 ${
              appUpdate.status === "ready_to_install" || appUpdate.status === "installing"
                ? "bg-emerald-500/10 dark:bg-emerald-500/12 text-emerald-800 dark:text-emerald-200 border-emerald-500/25"
                : "bg-indigo-500/8 dark:bg-indigo-500/12 text-indigo-700 dark:text-indigo-200 border-indigo-500/20"
            }`}
          >
            {appUpdate.status === "downloading" ||
            appUpdate.status === "staging" ||
            appUpdate.status === "installing" ? (
              <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-indigo-500" />
            ) : appUpdate.status === "ready_to_install" || appUpdate.status === "downloaded" ? (
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-emerald-500" />
            ) : (
              <Download className="w-3.5 h-3.5 shrink-0 text-indigo-500" />
            )}

            <span className="flex-1 min-w-0 truncate font-medium">
              {appUpdate.status === "downloading"
                ? appUpdate.downloadProgress?.percent !== null &&
                  appUpdate.downloadProgress?.percent !== undefined
                  ? t(activeLocale, "update.bannerDownloading", {
                      tag: appUpdate.latestRelease.tagName,
                      percent: appUpdate.downloadProgress.percent,
                    })
                  : t(activeLocale, "update.bannerDownloadingIndeterminate", {
                      tag: appUpdate.latestRelease.tagName,
                    })
                : appUpdate.status === "staging"
                  ? t(activeLocale, "update.bannerStaging", {
                      tag: appUpdate.latestRelease.tagName,
                    })
                  : appUpdate.status === "ready_to_install"
                    ? `${t(activeLocale, "update.bannerReadyToInstall", {
                        tag: appUpdate.stagedVersionTag ?? appUpdate.latestRelease.tagName,
                      })}${
                        appUpdate.applyOnQuit && appUpdate.canSelfUpdate && !appUpdate.isDevMode
                          ? t(activeLocale, "update.bannerReadyApplyOnQuitSuffix")
                          : ""
                      }`
                    : appUpdate.status === "installing"
                      ? t(activeLocale, "update.bannerInstalling", {
                          tag: appUpdate.stagedVersionTag ?? appUpdate.latestRelease.tagName,
                        })
                      : appUpdate.status === "downloaded"
                        ? t(activeLocale, "update.bannerDownloaded", {
                            tag: appUpdate.latestRelease.tagName,
                          })
                        : t(activeLocale, "update.bannerAvailable", {
                            tag: appUpdate.latestRelease.tagName,
                          })}
            </span>

            <div className="flex items-center gap-1.5 shrink-0">
              {appUpdate.status === "available" &&
                appUpdate.latestRelease.selectedAsset &&
                onDownloadAndOpenUpdate && (
                  <button
                    type="button"
                    data-testid="app-update-banner-download-btn"
                    onClick={onDownloadAndOpenUpdate}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-indigo-600 hover:bg-indigo-500 text-white transition-colors cursor-pointer"
                  >
                    <Download className="w-3 h-3" />
                    <span>
                      {appUpdate.platform === "darwin"
                        ? t(activeLocale, "update.prepareUpdateBtn")
                        : t(activeLocale, "update.downloadAndOpenBtn")}
                    </span>
                  </button>
                )}

              {appUpdate.status === "ready_to_install" && onInstallAndRestartUpdate && (
                <button
                  type="button"
                  data-testid="app-update-banner-restart-btn"
                  disabled={!appUpdate.canSelfUpdate || appUpdate.isDevMode}
                  onClick={onInstallAndRestartUpdate}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white transition-colors cursor-pointer"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>{t(activeLocale, "update.restartAndUpdateBtn")}</span>
                </button>
              )}

              {appUpdate.status === "downloaded" && onOpenDownloadedUpdate && (
                <button
                  type="button"
                  data-testid="app-update-banner-open-btn"
                  onClick={onOpenDownloadedUpdate}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition-colors cursor-pointer"
                >
                  <Download className="w-3 h-3" />
                  <span>{t(activeLocale, "update.openInstallerBtn")}</span>
                </button>
              )}

              {appUpdate.status === "downloaded" && onShowDownloadedUpdateInFolder && (
                <button
                  type="button"
                  onClick={onShowDownloadedUpdateInFolder}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-white/80 dark:bg-zinc-800/80 border border-indigo-500/25 hover:border-indigo-500/50 transition-colors cursor-pointer"
                >
                  <FolderOpen className="w-3 h-3" />
                  <span>{t(activeLocale, "update.showInFolderBtn")}</span>
                </button>
              )}

              {onOpenSettings && (
                <button
                  type="button"
                  data-testid="app-update-banner-details-btn"
                  onClick={onOpenSettings}
                  className="px-2 py-0.5 rounded-md text-[11px] font-medium hover:bg-indigo-500/15 transition-colors cursor-pointer"
                >
                  {t(activeLocale, "update.bannerDetailsBtn")}
                </button>
              )}

              {onOpenUpdateReleasePage && (
                <button
                  type="button"
                  onClick={() => onOpenUpdateReleasePage(appUpdate.latestRelease?.htmlUrl)}
                  title={t(activeLocale, "update.openReleasePageBtn")}
                  className="p-1 rounded hover:bg-indigo-500/15 transition-colors cursor-pointer"
                >
                  <ExternalLink className="w-3 h-3" />
                </button>
              )}

              {onDismissUpdateBanner &&
                appUpdate.status !== "downloading" &&
                appUpdate.status !== "staging" &&
                appUpdate.status !== "installing" && (
                <button
                  type="button"
                  data-testid="app-update-banner-dismiss-btn"
                  onClick={onDismissUpdateBanner}
                  aria-label={t(activeLocale, "update.bannerDismissAria")}
                  className="p-0.5 rounded hover:bg-indigo-500/15 transition-colors cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        )}

      {/* Error banner */}
      {snapshot.lastErrorBanner && (
        <div className="flex items-center gap-2 px-4 py-2 text-[12px] bg-rose-500/10 text-rose-600 dark:text-rose-400 border-b border-rose-500/20 min-w-0 shrink-0">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span className="flex-1 min-w-0 truncate">{snapshot.lastErrorBanner}</span>
          <button type="button" onClick={onDismissError} className="p-0.5 cursor-pointer shrink-0">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Unified Chat Stream */}
      <div className="relative flex-1 min-h-0 flex flex-col">
        <div
          ref={scrollContainerRef}
          onScroll={handleChatScroll}
          onWheel={handleChatWheel}
          onTouchStart={handleChatTouchStart}
          onTouchMove={handleChatTouchMove}
          onTouchEnd={handleChatTouchEnd}
          onTouchCancel={handleChatTouchEnd}
          onPointerDown={handleChatPointerDown}
          onKeyDown={handleChatKeyDown}
          className="flex-1 overflow-y-auto px-5 py-6"
        >
          <div ref={contentContainerRef} className="max-w-[740px] mx-auto space-y-5">
            {snapshot.messages.length === 0 ? (
              <EmptyWelcome
                projectCount={snapshot.projects.length}
                recentProjectNames={recentProjectNames}
                locale={activeLocale}
                onAddProject={onAddProject}
                onPickPrompt={handlePickWelcomePrompt}
              />
            ) : (
              <ChatMessageList
                messages={snapshot.messages}
                projects={snapshot.projects}
                tasks={snapshot.tasks}
                mentionTasks={mentionTasks}
                defaultIntegrationMode={snapshot.defaultIntegrationMode}
                locale={activeLocale}
                highlightedMessageId={highlightedMessageId}
                registerMessageEl={registerMessageEl}
                onOpenUrl={onOpenUrl}
                onOpenMarkdownFile={onOpenMarkdownFile}
                onOpenImageAttachment={onOpenImageAttachment}
                onOpenMarkdownImage={onOpenMarkdownImage}
                onOpenTask={onOpenTask}
                onUpdateTaskStatus={onUpdateTaskStatus}
                onLandTask={onLandTask}
                onStopMessage={onStopMessage}
              />
            )}
          </div>
        </div>

        <ScrollToBottomButton
          visible={showScrollToBottom}
          locale={activeLocale}
          onClick={handleScrollToBottomClick}
        />
      </div>

      {/* Non-Blocking Isolated Composer */}
      <ChatComposer
        composerText={composerText}
        onComposerTextChange={onComposerTextChange}
        attachments={attachments}
        selectedMentions={selectedMentions}
        projects={snapshot.projects}
        tasks={mentionTasks}
        locale={activeLocale}
        preferredLanguage={snapshot.preferredLanguage}
        isBrowserTabActive={isBrowserTabActive}
        isPickingElement={snapshot.isPickingElement}
        browserErrorCount={browserErrorCount}
        voiceAutoSend={voiceAutoSend}
        composerHandleRef={composerHandleRef}
        onAddMention={onAddMention}
        onRemoveMention={onRemoveMention}
        onRemoveAttachment={onRemoveAttachment}
        onSend={onSend}
        onOpenImageAttachment={onOpenImageAttachment}
        onToggleElementPicker={onToggleElementPicker}
        onCaptureScreenshot={onCaptureScreenshot}
        onAttachCurrentUrl={onAttachCurrentUrl}
        onAttachConsoleErrors={onAttachConsoleErrors}
        onPickLocalImages={onPickLocalImages}
        onPasteImage={onPasteImage}
        onStopSpeaking={onStopSpeaking}
        onToggleVoiceAutoSend={onToggleVoiceAutoSend}
      />
    </section>
  );
});

interface UnifiedChatHeaderProps {
  showTaskSidebar: boolean;
  isConnected: boolean;
  connectionStatus: string;
  activeResponderCount: number;
  providers: Record<AgentProvider, ProviderStatus>;
  chatProvider: AgentProvider;
  workerProvider: AgentProvider;
  chatModel: string | null;
  chatEffort: string | null;
  workerModel: string | null;
  workerEffort: string | null;
  usageRecords: UsageRecord[];
  usageBudgets?: UsageBudgetSettings;
  chatSessions: ChatSessionSummary[];
  activeChatSessionId: string;
  activeMessageCount: number;
  showBrowserPane: boolean;
  rightPaneMode?: RightPaneMode;
  locale: UiLocale;
  newChatConfirmTrigger?: number;
  voiceReadbackEnabled: boolean;
  isSpeaking: boolean;
  appUpdate: AppUpdateState | null;
  onToggleSidebar: () => void;
  onReconnect: () => void;
  onStopAll: () => void;
  onStopSpeaking?: () => void;
  onSetChatProvider: (provider: AgentProvider) => void;
  onSetWorkerProvider: (provider: AgentProvider) => void;
  onSetChatModel: (model: string, effort?: string) => void;
  onSetWorkerModel: (model: string, effort?: string) => void;
  onOpenUsage?: () => void;
  onToggleVoiceReadback?: () => void;
  onOpenSettings?: () => void;
  onSelectChatSession: (sessionId: string) => void;
  onNewChat: () => void;
  onDeleteChatSession: (sessionId: string) => void;
  onToggleMarkdownViewer: () => void;
  onToggleBrowser: () => void;
}

const UnifiedChatHeader: React.FC<UnifiedChatHeaderProps> = React.memo(({
  showTaskSidebar,
  isConnected,
  connectionStatus,
  activeResponderCount,
  providers,
  chatProvider,
  workerProvider,
  chatModel,
  chatEffort,
  workerModel,
  workerEffort,
  usageRecords,
  usageBudgets,
  chatSessions,
  activeChatSessionId,
  activeMessageCount,
  showBrowserPane,
  rightPaneMode,
  locale,
  newChatConfirmTrigger,
  voiceReadbackEnabled,
  isSpeaking,
  appUpdate,
  onToggleSidebar,
  onReconnect,
  onStopAll,
  onStopSpeaking,
  onSetChatProvider,
  onSetWorkerProvider,
  onSetChatModel,
  onSetWorkerModel,
  onOpenUsage,
  onToggleVoiceReadback,
  onOpenSettings,
  onSelectChatSession,
  onNewChat,
  onDeleteChatSession,
  onToggleMarkdownViewer,
  onToggleBrowser,
}) => {
  const [showModelMenu, setShowModelMenu] = useState(false);

  const chatProviderInfo = providers[chatProvider];
  const workerProviderInfo = providers[workerProvider];
  const activeChatModel = chatProviderInfo?.models.find((m) => m.model === chatModel);
  const activeWorkerModel = workerProviderInfo?.models.find((m) => m.model === workerModel);

  const usageSummaries = useMemo(
    () => summarizeAllUsagePeriods(usageRecords),
    [usageRecords],
  );
  const todayUsage = usageSummaries.today;
  const allTimeUsage = usageSummaries.all;
  const usageAlertSeverity = useMemo(() => {
    const budgets = normalizeUsageBudgetSettings(usageBudgets);
    const w = evaluateUsageBudget(
      usageSummaries.week.costUsd,
      usageSummaries.week.totalTokens,
      budgets.weekly,
    );
    const m = evaluateUsageBudget(
      usageSummaries.month.costUsd,
      usageSummaries.month.totalTokens,
      budgets.monthly,
    );
    if (w.severity === "exceeded" || m.severity === "exceeded") return "exceeded";
    if (w.severity === "warning" || m.severity === "warning") return "warning";
    return "ok";
  }, [usageSummaries.week, usageSummaries.month, usageBudgets]);

  const chatModelDisplayName = activeChatModel?.displayName ?? chatModel ?? "Default";
  const chatModelFullTitle = [
    chatProviderInfo?.label ?? chatProvider,
    chatModelDisplayName,
    chatEffort,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <header
      data-testid="chat-header"
      className="drag-region relative z-20 border-b border-zinc-200/70 dark:border-zinc-800/80 shrink-0 bg-white dark:bg-[#0f1115]"
    >
      <div className="flex flex-wrap @[840px]:flex-nowrap items-center justify-between gap-x-2 @[840px]:px-3">
        {/* Row 1 Left: Sidebar toggle + Brand + Connection status */}
        <div
          className={`no-drag order-1 h-11 flex items-center gap-2 min-w-0 flex-1 @[840px]:flex-initial pr-1 @[840px]:pr-0 ${
            showTaskSidebar
              ? "pl-3 @[840px]:pl-0"
              : "pl-[78px] @[840px]:pl-[66px]"
          }`}
        >
          <button
            type="button"
            onClick={onToggleSidebar}
            title={t(locale, "chat.toggleSidebarTitle")}
            className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
          >
            <PanelLeft className="w-4 h-4" />
          </button>

          <div className="flex items-center gap-1.5 min-w-0">
            <span
              title={connectionStatus}
              className={`w-2 h-2 rounded-full shrink-0 ${
                isConnected ? "bg-emerald-500" : "bg-amber-500"
              }`}
            />
            <span className="text-[13px] font-semibold truncate whitespace-nowrap">
              Conductor
            </span>
            {!isConnected && (
              <span
                title={connectionStatus}
                className="text-[11px] text-zinc-400 truncate hidden @[520px]:inline @[840px]:max-w-[140px]"
              >
                {connectionStatus}
              </span>
            )}
          </div>
        </div>

        {/* Context & Status Pills: neat sub-toolbar below 840px, inline before icons at 840px+ */}
        <div
          data-testid="chat-header-controls"
          className="no-drag order-3 basis-full flex flex-wrap items-center gap-1.5 min-w-0 px-3 py-1.5 border-t border-zinc-200/60 dark:border-zinc-800/70 bg-zinc-50/60 dark:bg-[#12151c]/70 @[840px]:order-2 @[840px]:basis-auto @[840px]:ml-auto @[840px]:flex-nowrap @[840px]:justify-end @[840px]:h-11 @[840px]:px-0 @[840px]:py-0 @[840px]:border-t-0 @[840px]:bg-transparent"
        >
          {!isConnected && (
            <button
              type="button"
              data-testid="chat-reconnect-btn"
              onClick={onReconnect}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 cursor-pointer whitespace-nowrap shrink-0"
            >
              <RefreshCw className="w-3 h-3 shrink-0" />
              <span>{t(locale, "chat.reconnect")}</span>
            </button>
          )}

          {activeResponderCount > 0 && (
            <div
              data-testid="chat-parallel-responding-pill"
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 text-[11px] font-medium whitespace-nowrap shrink-0"
            >
              <Loader2 className="w-3 h-3 animate-spin shrink-0" />
              <span className="whitespace-nowrap">
                {t(locale, "chat.parallelResponding", {
                  count: activeResponderCount,
                })}
              </span>
              <button
                type="button"
                data-testid="chat-stop-all-btn"
                onClick={onStopAll}
                className="text-rose-500 hover:underline ml-0.5 cursor-pointer whitespace-nowrap shrink-0"
              >
                {t(locale, "chat.stopAll")}
              </button>
            </div>
          )}

          {isSpeaking && onStopSpeaking && (
            <button
              type="button"
              data-testid="voice-stop-speaking-btn"
              onClick={onStopSpeaking}
              title={t(locale, "voice.stopSpeakingTitle")}
              aria-label={t(locale, "voice.stopSpeakingTitle")}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-indigo-500/15 text-indigo-600 dark:text-indigo-300 hover:bg-rose-500/15 hover:text-rose-600 dark:hover:text-rose-300 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-ping shrink-0" />
              <Square className="w-2.5 h-2.5 fill-current shrink-0" />
              <span className="whitespace-nowrap">{t(locale, "voice.stopSpeaking")}</span>
            </button>
          )}

          {/* Provider & Model Split Menu (Codex / AGY / Claude) */}
          <div className="relative min-w-0 max-w-full">
            <button
              type="button"
              data-testid="chat-model-selector-btn"
              onClick={() => setShowModelMenu((v) => !v)}
              title={chatModelFullTitle}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-medium bg-zinc-100 dark:bg-zinc-800/90 hover:bg-zinc-200/80 dark:hover:bg-zinc-800 transition-colors cursor-pointer whitespace-nowrap max-w-full min-w-0"
            >
              <Zap className="w-3 h-3 text-amber-500 shrink-0" />
              <span className="font-semibold text-indigo-600 dark:text-indigo-400 shrink-0 whitespace-nowrap">
                {chatProviderInfo?.label ?? chatProvider}
              </span>
              <span className="min-w-0 max-w-[116px] @[520px]:max-w-[148px] @[840px]:max-w-[110px] @[1020px]:max-w-[148px] truncate">
                {chatModelDisplayName}
              </span>
              {chatEffort && (
                <span className="hidden @[600px]:inline @[840px]:hidden @[1080px]:inline text-zinc-400 shrink-0 whitespace-nowrap">
                  · {chatEffort}
                </span>
              )}
              <ChevronDown className="w-3 h-3 text-zinc-400 shrink-0" />
            </button>

            {showModelMenu && (
              <>
                <div
                  className="fixed inset-0 z-30"
                  onClick={() => setShowModelMenu(false)}
                />
                <div className="absolute left-0 @[840px]:left-auto @[840px]:right-0 mt-1.5 z-40 w-[min(20rem,calc(100vw-24px))] rounded-xl bg-white dark:bg-[#191d26] border border-zinc-200 dark:border-zinc-700 shadow-xl p-3 space-y-3">
                  {/* Front-Desk Chat Provider & Model */}
                  <div className="space-y-1.5">
                    <div className="text-[10.5px] font-semibold text-zinc-400 uppercase tracking-wider">
                      {t(locale, "chat.frontDeskProvider")}
                    </div>
                    <div className="grid grid-cols-3 gap-1">
                      {ALL_PROVIDERS.map((pId) => {
                        const info = providers[pId];
                        const active = chatProvider === pId;
                        return (
                          <button
                            key={pId}
                            type="button"
                            disabled={!info?.available}
                            onClick={() => onSetChatProvider(pId)}
                            title={info?.detail}
                            className={`px-2 py-1 rounded-lg text-[11.5px] font-medium border transition-colors whitespace-nowrap ${
                              active
                                ? "bg-indigo-600 text-white border-indigo-600 cursor-pointer"
                                : info?.available
                                  ? "bg-zinc-100 dark:bg-zinc-800 border-transparent hover:border-zinc-300 dark:hover:border-zinc-600 cursor-pointer"
                                  : "bg-zinc-100/50 dark:bg-zinc-900/50 border-transparent text-zinc-400 opacity-50 cursor-not-allowed"
                            }`}
                          >
                            {info?.label ?? pId}
                          </button>
                        );
                      })}
                    </div>
                    {chatProviderInfo && chatProviderInfo.models.length > 0 && (
                      <select
                        value={chatModel ?? ""}
                        onChange={(e) => onSetChatModel(e.target.value)}
                        className="w-full text-[12px] rounded-lg px-2 py-1.5 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700"
                      >
                        {chatProviderInfo.models.map((m) => (
                          <option key={m.id} value={m.model}>
                            {m.displayName}
                          </option>
                        ))}
                      </select>
                    )}
                    {activeChatModel && activeChatModel.supportedEfforts.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {activeChatModel.supportedEfforts.map((eff) => (
                          <button
                            key={eff}
                            type="button"
                            onClick={() => onSetChatModel(activeChatModel.model, eff)}
                            className={`px-2 py-0.5 rounded text-[11px] cursor-pointer whitespace-nowrap ${
                              chatEffort === eff
                                ? "bg-indigo-500 text-white"
                                : "bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300"
                            }`}
                          >
                            {eff}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Background Worker Provider & Model */}
                  <div className="border-t border-zinc-200 dark:border-zinc-800 pt-2.5 space-y-1.5">
                    <div className="text-[10.5px] font-semibold text-zinc-400 uppercase tracking-wider">
                      {t(locale, "chat.workerProvider")}
                    </div>
                    <div className="grid grid-cols-3 gap-1">
                      {ALL_PROVIDERS.map((pId) => {
                        const info = providers[pId];
                        const active = workerProvider === pId;
                        return (
                          <button
                            key={pId}
                            type="button"
                            disabled={!info?.available}
                            onClick={() => onSetWorkerProvider(pId)}
                            title={info?.detail}
                            className={`px-2 py-1 rounded-lg text-[11.5px] font-medium border transition-colors whitespace-nowrap ${
                              active
                                ? "bg-indigo-600 text-white border-indigo-600 cursor-pointer"
                                : info?.available
                                  ? "bg-zinc-100 dark:bg-zinc-800 border-transparent hover:border-zinc-300 dark:hover:border-zinc-600 cursor-pointer"
                                  : "bg-zinc-100/50 dark:bg-zinc-900/50 border-transparent text-zinc-400 opacity-50 cursor-not-allowed"
                            }`}
                          >
                            {info?.label ?? pId}
                          </button>
                        );
                      })}
                    </div>
                    {workerProviderInfo && workerProviderInfo.models.length > 0 && (
                      <select
                        value={workerModel ?? ""}
                        onChange={(e) => onSetWorkerModel(e.target.value)}
                        className="w-full text-[12px] rounded-lg px-2 py-1.5 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700"
                      >
                        {workerProviderInfo.models.map((m) => (
                          <option key={m.id} value={m.model}>
                            {m.displayName}
                          </option>
                        ))}
                      </select>
                    )}
                    {activeWorkerModel && activeWorkerModel.supportedEfforts.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {activeWorkerModel.supportedEfforts.map((eff) => (
                          <button
                            key={eff}
                            type="button"
                            onClick={() => onSetWorkerModel(activeWorkerModel.model, eff)}
                            className={`px-2 py-0.5 rounded text-[11px] cursor-pointer whitespace-nowrap ${
                              workerEffort === eff
                                ? "bg-indigo-500 text-white"
                                : "bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300"
                            }`}
                          >
                            {eff}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>

          {onOpenUsage && (
            <button
              type="button"
              data-testid="open-usage-btn"
              onClick={onOpenUsage}
              title={
                allTimeUsage.totalTokens > 0
                  ? t(locale, "chat.usagePillTitle", {
                      todayTokens: formatTokenCount(todayUsage.totalTokens),
                      todayCost: formatUsdCost(todayUsage.costUsd, {
                        estimated: todayUsage.hasEstimatedCost,
                      }),
                      allTokens: formatTokenCount(allTimeUsage.totalTokens),
                      allCost: formatUsdCost(allTimeUsage.costUsd, {
                        estimated: allTimeUsage.hasEstimatedCost,
                      }),
                    })
                  : t(locale, "chat.usagePillEmptyTitle")
              }
              className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium text-zinc-600 dark:text-zinc-300 bg-zinc-100/80 dark:bg-zinc-800/70 hover:bg-zinc-200/80 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors cursor-pointer tabular-nums whitespace-nowrap shrink-0"
            >
              <BarChart3
                className={`w-3 h-3 shrink-0 ${
                  usageAlertSeverity === "exceeded"
                    ? "text-rose-500"
                    : usageAlertSeverity === "warning"
                      ? "text-amber-500"
                      : "text-indigo-500"
                }`}
              />
              {usageAlertSeverity !== "ok" && (
                <span
                  data-testid="usage-pill-alert-dot"
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    usageAlertSeverity === "exceeded" ? "bg-rose-500" : "bg-amber-500"
                  }`}
                />
              )}
              {todayUsage.totalTokens > 0 ? (
                <>
                  <span className="hidden @[480px]:inline @[840px]:hidden @[980px]:inline">
                    {formatTokenCount(todayUsage.totalTokens)}
                  </span>
                  <span className="hidden @[480px]:inline @[840px]:hidden @[980px]:inline text-zinc-400">
                    ·
                  </span>
                  <span>
                    {formatUsdCost(todayUsage.costUsd, {
                      estimated: todayUsage.hasEstimatedCost,
                      compact: true,
                    })}
                  </span>
                </>
              ) : (
                <span className="hidden @[420px]:inline">Usage</span>
              )}
            </button>
          )}
        </div>

        {/* Row 1 Right: Utility icon buttons */}
        <div className="no-drag order-2 @[840px]:order-3 h-11 flex items-center gap-0.5 shrink-0 pr-3 @[840px]:pr-0">
          {onToggleVoiceReadback && (
            <button
              type="button"
              data-testid="voice-readback-toggle-btn"
              aria-pressed={voiceReadbackEnabled}
              onClick={onToggleVoiceReadback}
              title={
                voiceReadbackEnabled
                  ? t(locale, "voice.readbackOnTitle")
                  : t(locale, "voice.readbackOffTitle")
              }
              aria-label={
                voiceReadbackEnabled
                  ? t(locale, "voice.readbackDisableAria")
                  : t(locale, "voice.readbackEnableAria")
              }
              className={`p-1.5 rounded-md transition-colors cursor-pointer shrink-0 ${
                voiceReadbackEnabled
                  ? "text-indigo-500 bg-indigo-500/10 hover:bg-indigo-500/20"
                  : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              }`}
            >
              {voiceReadbackEnabled ? (
                <Volume2 className="w-4 h-4" />
              ) : (
                <VolumeX className="w-4 h-4" />
              )}
            </button>
          )}

          {onOpenSettings && (
            <button
              type="button"
              data-testid="open-settings-btn"
              onClick={onOpenSettings}
              title={
                appUpdate?.updateAvailable && appUpdate.latestRelease
                  ? t(locale, "chat.settingsTitleWithUpdate", {
                      tag: appUpdate.latestRelease.tagName,
                    })
                  : t(locale, "chat.settingsTitle")
              }
              className="relative p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
            >
              <Settings className="w-4 h-4" />
              {appUpdate &&
                (appUpdate.updateAvailable ||
                  appUpdate.status === "downloading" ||
                  appUpdate.status === "staging" ||
                  appUpdate.status === "ready_to_install" ||
                  appUpdate.status === "installing" ||
                  appUpdate.status === "downloaded") && (
                  <span
                    data-testid="settings-update-badge"
                    aria-hidden="true"
                    className={`absolute top-1 right-1 w-2 h-2 rounded-full ring-2 ring-white dark:ring-[#0f1115] ${
                      appUpdate.status === "ready_to_install" ||
                      appUpdate.status === "installing" ||
                      appUpdate.status === "downloaded"
                        ? "bg-emerald-500"
                        : "bg-indigo-500"
                    }`}
                  />
                )}
            </button>
          )}

          <ChatSessionControls
            sessions={chatSessions}
            activeSessionId={activeChatSessionId}
            activeMessageCount={activeMessageCount}
            activeResponderCount={activeResponderCount}
            locale={locale}
            newChatConfirmTrigger={newChatConfirmTrigger}
            onSelectSession={onSelectChatSession}
            onNewChat={onNewChat}
            onDeleteSession={onDeleteChatSession}
          />

          <button
            type="button"
            onClick={onToggleMarkdownViewer}
            title={t(locale, "chat.toggleMarkdownTitle")}
            className={`p-1.5 rounded-md transition-colors cursor-pointer shrink-0 ${
              showBrowserPane && rightPaneMode === "markdown"
                ? "text-indigo-500 bg-indigo-500/10"
                : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            }`}
          >
            <BookOpen className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={onToggleBrowser}
            title={t(locale, "chat.toggleRightPaneTitle")}
            className={`p-1.5 rounded-md transition-colors cursor-pointer shrink-0 ${
              showBrowserPane
                ? "text-indigo-500 bg-indigo-500/10"
                : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            }`}
          >
            <PanelRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </header>
  );
});

export interface ScrollToBottomButtonProps {
  visible: boolean;
  locale: UiLocale;
  onClick: () => void;
}

export const ScrollToBottomButton: React.FC<ScrollToBottomButtonProps> = React.memo(
  ({ visible, locale, onClick }) => {
    if (!visible) return null;
    const label = t(locale, "chat.scrollToBottom");
    return (
      <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-4">
        <button
          type="button"
          data-testid="chat-scroll-to-bottom-btn"
          onClick={onClick}
          title={label}
          aria-label={label}
          className="pointer-events-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11.5px] font-medium border border-zinc-200/90 dark:border-zinc-700/90 bg-white/95 dark:bg-[#191d26]/95 backdrop-blur-md text-zinc-700 dark:text-zinc-200 shadow-md shadow-zinc-950/10 dark:shadow-black/35 hover:border-indigo-500/50 hover:text-indigo-600 dark:hover:text-indigo-300 hover:bg-white dark:hover:bg-[#1f2430] active:scale-[0.98] transition-all cursor-pointer"
        >
          <ArrowDown className="w-3.5 h-3.5 shrink-0" />
          <span>{label}</span>
        </button>
      </div>
    );
  },
);

const ChatMessageItem: React.FC<{
  message: ChatMessage;
  projects: Project[];
  tasks: AgentTask[];
  resolvedTask?: AgentTask | null;
  resolvedProject?: Project | null;
  defaultIntegrationMode?: IntegrationMode;
  locale: UiLocale;
  isHighlighted: boolean;
  registerMessageEl: (messageId: string, el: HTMLDivElement | null) => void;
  onOpenUrl: (url: string, context?: { message?: ChatMessage }) => void;
  onOpenMarkdownFile: (
    target: string,
    baseFilePath?: string,
    context?: { message?: ChatMessage },
  ) => void;
  onOpenImageAttachment?: (
    attachment: ChatAttachment,
    context?: {
      message?: ChatMessage;
      draftText?: string;
      draftMentions?: ExplicitMentionTarget[];
    },
  ) => void;
  onOpenMarkdownImage?: (image: MarkdownOpenedImage, context?: { message?: ChatMessage }) => void;
  onOpenTask: (taskId: string) => void;
  onUpdateTaskStatus?: (taskId: string, status: AgentTaskStatus) => void;
  onLandTask?: (taskId: string, options?: { createPr?: boolean }) => void;
  onStopMessage: (id: string) => void;
}> = React.memo(({
  message,
  projects,
  tasks,
  resolvedTask,
  resolvedProject,
  defaultIntegrationMode,
  locale,
  isHighlighted,
  registerMessageEl,
  onOpenUrl,
  onOpenMarkdownFile,
  onOpenImageAttachment,
  onOpenMarkdownImage,
  onOpenTask,
  onUpdateTaskStatus,
  onLandTask,
  onStopMessage,
}) => {
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      registerMessageEl(message.id, el);
    },
    [registerMessageEl, message.id],
  );

  const handleOpenUrl = useCallback(
    (url: string) => onOpenUrl(url, { message }),
    [onOpenUrl, message],
  );

  const handleOpenMarkdownFile = useCallback(
    (target: string, base?: string) => onOpenMarkdownFile(target, base, { message }),
    [onOpenMarkdownFile, message],
  );

  const handleOpenImage = useCallback(
    (att: ChatAttachment) => onOpenImageAttachment?.(att, { message }),
    [onOpenImageAttachment, message],
  );

  const handleOpenMarkdownImg = useCallback(
    (image: MarkdownOpenedImage) => onOpenMarkdownImage?.(image, { message }),
    [onOpenMarkdownImage, message],
  );

  const handleStop = useCallback(
    () => onStopMessage(message.id),
    [onStopMessage, message.id],
  );

  return (
    <div
      ref={setRef}
      data-message-id={message.id}
      className={`scroll-mt-6 -mx-2.5 px-2.5 py-2 rounded-2xl transition-colors duration-300 ${
        isHighlighted
          ? "bg-indigo-500/[0.09] dark:bg-indigo-500/[0.16] ring-2 ring-indigo-500/60 shadow-sm"
          : "ring-0 ring-transparent"
      }`}
    >
      <MessageRow
        message={message}
        projects={projects}
        tasks={tasks}
        resolvedTask={resolvedTask}
        resolvedProject={resolvedProject}
        defaultIntegrationMode={defaultIntegrationMode}
        locale={locale}
        onOpenUrl={handleOpenUrl}
        onOpenMarkdownFile={handleOpenMarkdownFile}
        onOpenImageAttachment={onOpenImageAttachment ? handleOpenImage : undefined}
        onOpenMarkdownImage={onOpenMarkdownImage ? handleOpenMarkdownImg : undefined}
        onOpenTask={onOpenTask}
        onUpdateTaskStatus={onUpdateTaskStatus}
        onLandTask={onLandTask}
        onStop={handleStop}
      />
    </div>
  );
});

const ChatMessageList: React.FC<{
  messages: ChatMessage[];
  projects: Project[];
  tasks: AgentTask[];
  mentionTasks: AgentTask[];
  defaultIntegrationMode?: IntegrationMode;
  locale: UiLocale;
  highlightedMessageId: string | null;
  registerMessageEl: (messageId: string, el: HTMLDivElement | null) => void;
  onOpenUrl: (url: string, context?: { message?: ChatMessage }) => void;
  onOpenMarkdownFile: (
    target: string,
    baseFilePath?: string,
    context?: { message?: ChatMessage },
  ) => void;
  onOpenImageAttachment?: (
    attachment: ChatAttachment,
    context?: {
      message?: ChatMessage;
      draftText?: string;
      draftMentions?: ExplicitMentionTarget[];
    },
  ) => void;
  onOpenMarkdownImage?: (image: MarkdownOpenedImage, context?: { message?: ChatMessage }) => void;
  onOpenTask: (taskId: string) => void;
  onUpdateTaskStatus?: (taskId: string, status: AgentTaskStatus) => void;
  onLandTask?: (taskId: string, options?: { createPr?: boolean }) => void;
  onStopMessage: (id: string) => void;
}> = React.memo(({
  messages,
  projects,
  tasks,
  mentionTasks,
  defaultIntegrationMode,
  locale,
  highlightedMessageId,
  registerMessageEl,
  onOpenUrl,
  onOpenMarkdownFile,
  onOpenImageAttachment,
  onOpenMarkdownImage,
  onOpenTask,
  onUpdateTaskStatus,
  onLandTask,
  onStopMessage,
}) => {
  return (
    <>
      {messages.map((msg) => {
        if (msg.role === "taskEvent") {
          const resolvedTask = resolveTaskForTaskEvent(msg, tasks) ?? null;
          const resolvedProject = resolvedTask
            ? (findProjectForTask(projects, resolvedTask) ?? null)
            : null;
          return (
            <ChatMessageItem
              key={msg.id}
              message={msg}
              projects={EMPTY_PROJECTS}
              tasks={EMPTY_TASKS}
              resolvedTask={resolvedTask}
              resolvedProject={resolvedProject}
              defaultIntegrationMode={defaultIntegrationMode}
              locale={locale}
              isHighlighted={highlightedMessageId === msg.id}
              registerMessageEl={registerMessageEl}
              onOpenUrl={onOpenUrl}
              onOpenMarkdownFile={onOpenMarkdownFile}
              onOpenImageAttachment={onOpenImageAttachment}
              onOpenMarkdownImage={onOpenMarkdownImage}
              onOpenTask={onOpenTask}
              onUpdateTaskStatus={onUpdateTaskStatus}
              onLandTask={onLandTask}
              onStopMessage={onStopMessage}
            />
          );
        }

        const userNeedsMentionRefs =
          msg.role === "user" &&
          (msg.text.includes("@") ||
            Boolean(msg.mentions?.length) ||
            Boolean(msg.inferredMentions?.length));

        return (
          <ChatMessageItem
            key={msg.id}
            message={msg}
            projects={userNeedsMentionRefs ? projects : EMPTY_PROJECTS}
            tasks={userNeedsMentionRefs ? mentionTasks : EMPTY_TASKS}
            defaultIntegrationMode={undefined}
            locale={locale}
            isHighlighted={highlightedMessageId === msg.id}
            registerMessageEl={registerMessageEl}
            onOpenUrl={onOpenUrl}
            onOpenMarkdownFile={onOpenMarkdownFile}
            onOpenImageAttachment={onOpenImageAttachment}
            onOpenMarkdownImage={onOpenMarkdownImage}
            onOpenTask={onOpenTask}
            onUpdateTaskStatus={onUpdateTaskStatus}
            onLandTask={onLandTask}
            onStopMessage={onStopMessage}
          />
        );
      })}
    </>
  );
});

const EmptyWelcome: React.FC<{
  projectCount: number;
  recentProjectNames: string[];
  locale: UiLocale;
  onAddProject: () => void;
  onPickPrompt: (prompt: string) => void;
}> = React.memo(({ projectCount, recentProjectNames, locale, onAddProject, onPickPrompt }) => {
  const sampleName = recentProjectNames[0] ?? t(locale, "chat.welcomeSampleFallback");
  const prompts = [
    {
      title: t(locale, "chat.welcomePrompt1Title"),
      prompt: t(locale, "chat.welcomePrompt1Body"),
    },
    {
      title: t(locale, "chat.welcomePrompt2Title", { name: sampleName }),
      prompt: t(locale, "chat.welcomePrompt2Body", { name: sampleName }),
    },
    {
      title: t(locale, "chat.welcomePrompt3Title"),
      prompt: t(locale, "chat.welcomePrompt3Body"),
    },
    {
      title: t(locale, "chat.welcomePrompt4Title"),
      prompt: t(locale, "chat.welcomePrompt4Body", { name: sampleName }),
    },
  ];

  return (
    <div className="pt-14 pb-6 flex flex-col items-center text-center space-y-5">
      <div className="w-14 h-14 rounded-2xl bg-indigo-500/15 flex items-center justify-center">
        <Sparkles className="w-7 h-7 text-indigo-500" />
      </div>
      <div className="space-y-1.5">
        <h1 className="text-[21px] font-semibold tracking-tight">
          {t(locale, "chat.welcomeHeading")}
        </h1>
        <p className="text-[13px] text-zinc-500 dark:text-zinc-400 max-w-md">
          {t(locale, "chat.welcomeSubtitle")}
        </p>
      </div>

      <div className="inline-flex flex-wrap items-center justify-center gap-x-2 gap-y-1 px-3 py-1 rounded-full text-[11.5px] bg-zinc-100 dark:bg-zinc-800/80 text-zinc-600 dark:text-zinc-300 max-w-full">
        <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
        <span className="whitespace-nowrap">
          {projectCount > 0
            ? t(locale, "chat.welcomeProjectsDetected", { count: projectCount })
            : t(locale, "chat.welcomeProjectsScanning")}
        </span>
        <button
          type="button"
          onClick={onAddProject}
          className="text-indigo-500 hover:underline font-medium cursor-pointer ml-1 whitespace-nowrap shrink-0"
        >
          {t(locale, "chat.welcomeAddFolder")}
        </button>
      </div>

      <div className="grid grid-cols-1 @[440px]:grid-cols-2 gap-2.5 w-full max-w-xl pt-2">
        {prompts.map((item) => (
          <button
            key={item.title}
            type="button"
            onClick={() => onPickPrompt(item.prompt)}
            className="text-left p-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-[#161a22] hover:border-indigo-500/40 hover:bg-zinc-100/70 dark:hover:bg-[#1b202b] transition-colors cursor-pointer"
          >
            <div className="text-[12.5px] font-medium text-zinc-800 dark:text-zinc-200">
              {item.title}
            </div>
            <div className="text-[11px] text-zinc-400 line-clamp-2 mt-0.5">{item.prompt}</div>
          </button>
        ))}
      </div>
    </div>
  );
});

export interface TaskEventCardProps {
  message: ChatMessage;
  tasks: AgentTask[];
  projects?: Project[];
  resolvedTask?: AgentTask | null;
  resolvedProject?: Project | null;
  defaultIntegrationMode?: IntegrationMode;
  locale?: UiLocale;
  onOpenUrl: (url: string) => void;
  onOpenMarkdownFile: (target: string, baseFilePath?: string) => void;
  onOpenImage?: (image: MarkdownOpenedImage) => void;
  onOpenTask: (taskId: string) => void;
  onUpdateTaskStatus?: (taskId: string, status: AgentTaskStatus) => void;
  onLandTask?: (taskId: string, options?: { createPr?: boolean }) => void;
  imageCache?: MarkdownImageCache;
  videoCache?: MarkdownVideoCache;
}

export const TaskEventCard: React.FC<TaskEventCardProps> = ({
  message,
  tasks,
  projects = EMPTY_PROJECTS,
  resolvedTask: preResolvedTask,
  resolvedProject: preResolvedProject,
  defaultIntegrationMode = "feature-branch",
  locale = "ja",
  onOpenUrl,
  onOpenMarkdownFile,
  onOpenImage,
  onOpenTask,
  onUpdateTaskStatus,
  onLandTask,
  imageCache,
  videoCache,
}) => {
  const resolvedTask =
    preResolvedTask !== undefined
      ? (preResolvedTask ?? undefined)
      : resolveTaskForTaskEvent(message, tasks);
  const taskBaseFilePath = buildTaskMarkdownBasePath(resolvedTask);
  const targetTaskId = resolvedTask?.id ?? message.relatedTaskId;
  const quickTransition = resolvedTask ? getQuickStatusTransition(resolvedTask.status, locale) : null;
  const isDone = resolvedTask?.status === "done";
  const isRunning = resolvedTask?.status === "running";
  const needsLand = resolvedTask ? requiresLandBeforeDone(resolvedTask) : false;
  const doneBlockedReason =
    resolvedTask && quickTransition?.action === "done"
      ? getLocalizedMarkTaskDoneBlockedReason(resolvedTask, locale)
      : null;
  const isQuickDoneBlocked = Boolean(doneBlockedReason);
  const hasActiveWorktree = Boolean(resolvedTask?.worktreePath && resolvedTask?.worktreeBranch);
  const isLanding = resolvedTask?.landStatus === "landing";
  const canQuickLand = Boolean(
    resolvedTask &&
      onLandTask &&
      hasActiveWorktree &&
      !isRunning &&
      resolvedTask.landStatus !== "landed",
  );
  const resolvedProject =
    preResolvedProject !== undefined
      ? (preResolvedProject ?? undefined)
      : resolvedTask
        ? findProjectForTask(projects, resolvedTask)
        : undefined;
  const effectiveMode = getEffectiveProjectMode(resolvedProject, defaultIntegrationMode);
  const isPrMode = effectiveMode === "per-task-pr";

  return (
    <div
      data-testid="task-event-card"
      className={`rounded-xl p-3.5 border transition-colors ${
        isDone
          ? "border-emerald-500/25 bg-emerald-500/[0.04]"
          : "border-indigo-500/25 bg-indigo-500/[0.06]"
      }`}
    >
      {resolvedTask ? (
        <div className="space-y-2">
          <div
            data-testid="task-event-header"
            className={`flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 pb-2 border-b ${
              isDone
                ? "border-emerald-500/15 dark:border-emerald-400/15"
                : "border-indigo-500/15 dark:border-indigo-400/15"
            }`}
          >
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              <Bell
                className={`w-3.5 h-3.5 shrink-0 ${
                  isDone ? "text-emerald-500" : "text-indigo-500"
                }`}
              />
              <span className="px-1.5 py-0.5 rounded font-mono text-[10px] font-semibold bg-indigo-500/12 text-indigo-600 dark:text-indigo-300 border border-indigo-500/20 shrink-0 whitespace-nowrap">
                {formatTaskCode(resolvedTask.taskNumber)}
              </span>
              <span className="text-[11.5px] font-medium text-zinc-700 dark:text-zinc-200 truncate">
                {resolvedTask.title}
              </span>
              {isDone && (
                <span
                  data-testid="task-event-done-badge"
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 shrink-0 whitespace-nowrap"
                >
                  <CheckCircle2 className="w-3 h-3 shrink-0" />
                  <span>{t(locale, "task.doneBadge")}</span>
                </span>
              )}
              {isRunning && (
                <span
                  data-testid="task-event-running-badge"
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-indigo-500/15 text-indigo-600 dark:text-indigo-300 shrink-0 whitespace-nowrap"
                >
                  <Loader2 className="w-2.5 h-2.5 animate-spin shrink-0" />
                  <span>{t(locale, "task.runningBadge")}</span>
                </span>
              )}
              {needsLand && !isRunning && (
                <span
                  data-testid="task-event-unlanded-badge"
                  title={doneBlockedReason ?? undefined}
                  className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/15 text-amber-700 dark:text-amber-300 shrink-0 whitespace-nowrap"
                >
                  {t(locale, "task.unlandedBadge")}
                </span>
              )}
            </div>

            <div className="flex items-center gap-1.5 shrink-0 ml-auto">
              {canQuickLand && (
                <button
                  type="button"
                  disabled={isLanding}
                  data-testid="task-event-quick-land"
                  onClick={(e) => {
                    e.stopPropagation();
                    onLandTask?.(resolvedTask.id, isPrMode ? { createPr: true } : undefined);
                  }}
                  title={
                    isPrMode
                      ? t(locale, "sidebar.pushPrTitle", {
                          branch: resolvedTask.worktreeBranch ?? "",
                        })
                      : t(locale, "sidebar.landChangesTitle", { mode: effectiveMode })
                  }
                  aria-label={`${resolvedTask.title}: ${isPrMode ? "Push / PR" : "Land"}`}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium border transition-colors shrink-0 whitespace-nowrap ${
                    isLanding
                      ? "bg-indigo-500/10 border-indigo-500/25 text-indigo-500 opacity-70 cursor-wait"
                      : resolvedTask.landStatus === "conflict" || resolvedTask.landStatus === "error"
                        ? "bg-amber-500/12 border-amber-500/35 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 cursor-pointer"
                        : "bg-indigo-500/12 border-indigo-500/30 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-500/22 hover:border-indigo-500/45 cursor-pointer"
                  }`}
                >
                  {isLanding ? (
                    <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                  ) : isPrMode ? (
                    <GitPullRequest className="w-3 h-3 shrink-0" />
                  ) : (
                    <GitMerge className="w-3 h-3 shrink-0" />
                  )}
                  <span>{isLanding ? "..." : isPrMode ? "Push/PR" : "Land"}</span>
                </button>
              )}

              {quickTransition && onUpdateTaskStatus && (
                <button
                  type="button"
                  disabled={isQuickDoneBlocked}
                  aria-disabled={isQuickDoneBlocked || undefined}
                  data-testid={`task-event-quick-${quickTransition.action}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (
                      !validateManualTaskStatusTransition({
                        currentStatus: resolvedTask.status,
                        nextStatus: quickTransition.nextStatus,
                        worktreePath: resolvedTask.worktreePath,
                        worktreeBranch: resolvedTask.worktreeBranch,
                        landStatus: resolvedTask.landStatus,
                      }).ok
                    ) {
                      return;
                    }
                    onUpdateTaskStatus(resolvedTask.id, quickTransition.nextStatus);
                  }}
                  title={doneBlockedReason ?? quickTransition.title}
                  aria-label={`${resolvedTask.title}: ${quickTransition.label}`}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium border transition-colors shrink-0 whitespace-nowrap ${
                    isQuickDoneBlocked
                      ? "bg-zinc-100 dark:bg-zinc-800/60 border-zinc-200/80 dark:border-zinc-700/70 text-zinc-400 dark:text-zinc-500 opacity-60 cursor-not-allowed"
                      : isDone
                        ? "bg-zinc-100 dark:bg-zinc-800/80 border-zinc-200/90 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-indigo-500/12 hover:border-indigo-500/35 hover:text-indigo-600 dark:hover:text-indigo-300 cursor-pointer"
                        : "bg-emerald-500/12 border-emerald-500/30 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/22 hover:border-emerald-500/45 cursor-pointer"
                  }`}
                >
                  {isDone ? (
                    <RotateCcw className="w-3 h-3 shrink-0" />
                  ) : (
                    <Check className="w-3 h-3 shrink-0" />
                  )}
                  <span>{quickTransition.label}</span>
                </button>
              )}
            </div>
          </div>

          <MarkdownView
            content={message.text}
            locale={locale}
            baseFilePath={taskBaseFilePath}
            onOpenUrl={onOpenUrl}
            onOpenMarkdownFile={onOpenMarkdownFile}
            onOpenImage={onOpenImage}
            imageCache={imageCache}
            videoCache={videoCache}
          />

          <button
            type="button"
            data-testid="task-event-open-detail"
            onClick={() => onOpenTask(resolvedTask.id)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11.5px] font-medium bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 hover:border-indigo-500/50 transition-colors cursor-pointer"
          >
            <span className="font-mono text-[10.5px] font-semibold text-indigo-600 dark:text-indigo-300">
              {formatTaskCode(resolvedTask.taskNumber)}
            </span>
            <span>{t(locale, "chat.openTaskDetail")}</span>
          </button>
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <Bell className="w-4 h-4 text-indigo-500 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0 space-y-2">
            <MarkdownView
              content={message.text}
              locale={locale}
              baseFilePath={taskBaseFilePath}
              onOpenUrl={onOpenUrl}
              onOpenMarkdownFile={onOpenMarkdownFile}
              onOpenImage={onOpenImage}
              imageCache={imageCache}
              videoCache={videoCache}
            />
            {targetTaskId && (
              <button
                type="button"
                data-testid="task-event-open-detail"
                onClick={() => onOpenTask(targetTaskId)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11.5px] font-medium bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 hover:border-indigo-500/50 transition-colors cursor-pointer"
              >
                <span>{t(locale, "chat.openTaskDetail")}</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const MemoTaskEventCard = React.memo(TaskEventCard);

const MessageRow: React.FC<{
  message: ChatMessage;
  projects: Project[];
  tasks: AgentTask[];
  resolvedTask?: AgentTask | null;
  resolvedProject?: Project | null;
  defaultIntegrationMode?: IntegrationMode;
  locale: UiLocale;
  onOpenUrl: (url: string) => void;
  onOpenMarkdownFile: (target: string, baseFilePath?: string) => void;
  onOpenImageAttachment?: (attachment: ChatAttachment) => void;
  onOpenMarkdownImage?: (image: MarkdownOpenedImage) => void;
  onOpenTask: (taskId: string) => void;
  onUpdateTaskStatus?: (taskId: string, status: AgentTaskStatus) => void;
  onLandTask?: (taskId: string, options?: { createPr?: boolean }) => void;
  onStop: () => void;
}> = React.memo(({
  message,
  projects,
  tasks,
  resolvedTask,
  resolvedProject,
  defaultIntegrationMode,
  locale,
  onOpenUrl,
  onOpenMarkdownFile,
  onOpenImageAttachment,
  onOpenMarkdownImage,
  onOpenTask,
  onUpdateTaskStatus,
  onLandTask,
  onStop,
}) => {
  const [showReasoning, setShowReasoning] = useState(false);
  const mentionBadges = useMemo(
    () =>
      message.role === "user" &&
      (message.text.includes("@") ||
        Boolean(message.mentions?.length) ||
        Boolean(message.inferredMentions?.length))
        ? resolveMessageMentionBadges(
            message.text,
            projects,
            tasks,
            message.mentions,
            message.inferredMentions,
          )
        : [],
    [message.role, message.text, message.mentions, message.inferredMentions, projects, tasks],
  );
  const hasInlineAt = message.role === "user" && message.text.includes("@");
  const userMentionContext = useMemo(
    () => (hasInlineAt ? { projects, tasks, onOpenTask } : undefined),
    [hasInlineAt, projects, tasks, onOpenTask],
  );

  if (message.role === "user") {
    const hasMetaChips = mentionBadges.length > 0 || message.attachments.length > 0;
    return (
      <div className="flex flex-col items-end gap-1.5">
        {hasMetaChips && (
          <div
            data-testid="user-message-meta-chips"
            className="flex flex-wrap justify-end gap-1.5 max-w-[82%]"
          >
            <UserMessageMentionBadges
              badges={mentionBadges}
              locale={locale}
              onOpenTask={onOpenTask}
            />
            {message.attachments.map((att) => {
              const viewableImage =
                isViewableImageAttachment(att) && Boolean(onOpenImageAttachment);
              if (viewableImage) {
                return (
                  <button
                    key={att.id}
                    type="button"
                    onClick={() => onOpenImageAttachment?.(att)}
                    title={t(locale, "chat.openImageInRightPaneTitle", { label: att.label })}
                    aria-label={t(locale, "chat.openImageInRightPaneAria", { label: att.label })}
                    className="group inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200/80 dark:hover:bg-zinc-700/80 border border-transparent hover:border-indigo-500/40 text-[11px] text-zinc-600 dark:text-zinc-300 hover:text-indigo-600 dark:hover:text-indigo-300 transition-all cursor-pointer"
                  >
                    {att.imageDataUrl ? (
                      <img
                        src={att.imageDataUrl}
                        alt={att.label}
                        className="w-6 h-6 rounded object-cover ring-1 ring-transparent group-hover:ring-indigo-500/70 group-hover:scale-105 transition-all shrink-0"
                      />
                    ) : (
                      <ImageIcon className="w-4 h-4 text-indigo-500 shrink-0" />
                    )}
                    <span>{att.label}</span>
                  </button>
                );
              }
              return (
                <div
                  key={att.id}
                  className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-[11px] text-zinc-600 dark:text-zinc-300"
                >
                  {att.imageDataUrl && (
                    <img
                      src={att.imageDataUrl}
                      alt={att.label}
                      className="w-6 h-6 rounded object-cover"
                    />
                  )}
                  <span>{att.label}</span>
                </div>
              );
            })}
          </div>
        )}
        <div
          data-testid="user-message-bubble"
          className="max-w-[82%] min-w-0 rounded-2xl px-4 py-2.5 bg-indigo-500/12 dark:bg-indigo-500/20 text-zinc-900 dark:text-zinc-100 select-text"
        >
          <MarkdownView
            content={message.text}
            variant="user"
            locale={locale}
            onOpenUrl={onOpenUrl}
            onOpenMarkdownFile={onOpenMarkdownFile}
            mentionContext={userMentionContext}
          />
        </div>
      </div>
    );
  }

  if (message.role === "taskEvent") {
    return (
      <MemoTaskEventCard
        message={message}
        tasks={tasks}
        projects={projects}
        resolvedTask={resolvedTask}
        resolvedProject={resolvedProject}
        defaultIntegrationMode={defaultIntegrationMode}
        locale={locale}
        onOpenUrl={onOpenUrl}
        onOpenMarkdownFile={onOpenMarkdownFile}
        onOpenImage={onOpenMarkdownImage}
        onOpenTask={onOpenTask}
        onUpdateTaskStatus={onUpdateTaskStatus}
        onLandTask={onLandTask}
      />
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 min-w-0">
        <div className="w-5 h-5 rounded-md bg-indigo-500/15 flex items-center justify-center shrink-0">
          <Sparkles className="w-3 h-3 text-indigo-500" />
        </div>
        <span className="text-[12px] font-semibold text-zinc-600 dark:text-zinc-400 whitespace-nowrap shrink-0">
          Conductor
          {message.provider && (
            <span className="ml-1 font-normal text-zinc-400">
              · {message.provider === "agy" ? "AGY" : message.provider === "claude" ? "Claude" : "Codex"}
            </span>
          )}
        </span>
        {message.replyToSnippet && (
          <span className="px-2 py-0.5 rounded-full text-[10.5px] bg-zinc-100 dark:bg-zinc-800 text-zinc-500 truncate min-w-0 max-w-[260px]">
            ↩ {message.replyToSnippet}
          </span>
        )}
        {message.isStreaming && (
          <>
            <Loader2 className="w-3 h-3 text-indigo-500 animate-spin shrink-0" />
            <div className="flex-1" />
            <button
              type="button"
              onClick={onStop}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-rose-500 hover:bg-rose-500/10 cursor-pointer whitespace-nowrap shrink-0"
            >
              <Square className="w-2.5 h-2.5 fill-current shrink-0" />
              {t(locale, "common.stop")}
            </button>
          </>
        )}
      </div>

      {message.reasoningSummary && (
        <div className="pl-7">
          <button
            type="button"
            onClick={() => setShowReasoning((v) => !v)}
            className="inline-flex items-center gap-1 text-[11.5px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 cursor-pointer"
          >
            {showReasoning ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            {t(locale, "chat.reasoningProcess")}
          </button>
          {showReasoning && (
            <div className="mt-1 p-2.5 rounded-lg bg-zinc-100/70 dark:bg-zinc-900/70 text-[12px] text-zinc-500 dark:text-zinc-400 whitespace-pre-wrap select-text">
              {message.reasoningSummary}
            </div>
          )}
        </div>
      )}

      {message.toolChips.length > 0 && (
        <MessageToolChips
          toolChips={message.toolChips}
          isStreaming={message.isStreaming}
          locale={locale}
        />
      )}

      <div className="pl-7">
        {message.text ? (
          <MarkdownView
            content={message.text}
            locale={locale}
            onOpenUrl={onOpenUrl}
            onOpenMarkdownFile={onOpenMarkdownFile}
            onOpenImage={onOpenMarkdownImage}
          />
        ) : message.isStreaming ? (
          <span className="text-[13px] text-zinc-400">{t(locale, "chat.preparingReply")}</span>
        ) : null}
      </div>
    </div>
  );
});

export interface MessageToolChipsProps {
  toolChips: ToolActivityChip[];
  isStreaming: boolean;
  locale: UiLocale;
  defaultExpanded?: boolean;
}

const ToolChipPill: React.FC<{ chip: ToolActivityChip }> = React.memo(({ chip }) => (
  <span
    data-testid="message-tool-chip"
    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-zinc-100 dark:bg-zinc-800/80 text-zinc-600 dark:text-zinc-300"
  >
    {chip.isError ? (
      <XCircle className="w-3 h-3 text-rose-500 shrink-0" />
    ) : chip.isCompleted ? (
      <CheckCircle2 className="w-3 h-3 text-emerald-500 shrink-0" />
    ) : (
      <Loader2 className="w-3 h-3 text-indigo-500 animate-spin shrink-0" />
    )}
    <span>{chip.label}</span>
  </span>
));

export const MessageToolChips: React.FC<MessageToolChipsProps> = React.memo(({
  toolChips,
  isStreaming,
  locale,
  defaultExpanded = false,
}) => {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const plan = useMemo(
    () => buildToolChipDisplayPlan(toolChips, { isStreaming }),
    [toolChips, isStreaming],
  );

  if (toolChips.length === 0) {
    return null;
  }

  return (
    <div data-testid="message-tool-chips" className="pl-7 space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {plan.shouldCollapseByDefault && (
          <button
            type="button"
            data-testid="message-tool-chips-toggle"
            aria-expanded={isExpanded}
            aria-label={
              isExpanded
                ? t(locale, "chat.toolChipsCollapseAria")
                : t(locale, "chat.toolChipsExpandAria")
            }
            onClick={() => setIsExpanded((prev) => !prev)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-zinc-100 dark:bg-zinc-800/80 hover:bg-zinc-200/80 dark:hover:bg-zinc-700/80 text-zinc-600 dark:text-zinc-300 border border-zinc-200/70 dark:border-zinc-700/70 transition-colors cursor-pointer"
          >
            {plan.errorCount > 0 ? (
              <XCircle className="w-3 h-3 text-rose-500 shrink-0" />
            ) : (
              <CheckCircle2 className="w-3 h-3 text-emerald-500 shrink-0" />
            )}
            <span>
              {formatToolChipsSummary(
                plan.collapsibleChips.length,
                plan.toolCounts,
                plan.errorCount,
                locale,
              )}
            </span>
            {isExpanded ? (
              <ChevronDown className="w-3 h-3 text-zinc-400 shrink-0" />
            ) : (
              <ChevronRight className="w-3 h-3 text-zinc-400 shrink-0" />
            )}
          </button>
        )}

        {plan.visibleChips.map((chip) => (
          <ToolChipPill key={chip.id} chip={chip} />
        ))}
      </div>

      {plan.shouldCollapseByDefault && isExpanded && (
        <div data-testid="message-tool-chips-expanded" className="flex flex-wrap gap-1.5">
          {plan.collapsibleChips.map((chip) => (
            <ToolChipPill key={chip.id} chip={chip} />
          ))}
        </div>
      )}
    </div>
  );
});
