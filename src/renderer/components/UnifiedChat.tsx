import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BarChart3,
  Bell,
  BookOpen,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Crosshair,
  FolderPlus,
  GitMerge,
  GitPullRequest,
  Globe,
  Image as ImageIcon,
  Link2,
  Loader2,
  Mic,
  MicOff,
  PanelLeft,
  PanelRight,
  Paperclip,
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
  ChatAttachment,
  ChatMessage,
  ExplicitMentionTarget,
  IntegrationMode,
  Project,
  RightPaneMode,
  ToolActivityChip,
} from "../../shared/types.js";
import {
  detectActiveMention,
  extractResolvedMentionChips,
  formatTaskCode,
  getMentionSuggestions,
  removeActiveMentionQuery,
  removeResolvedMentionChip,
  resolveMessageMentionBadges,
  suggestionToExplicitMentionTarget,
  type MentionChipRemovalTarget,
  type MentionSuggestion,
  type ResolvedMentionChip,
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
import {
  appendVoiceTranscript,
  formatSpeechRecognitionError,
  resolveSpeechLocale,
} from "../../shared/voice.js";
import { getEffectiveProjectMode } from "../lib/integration-mode.js";
import {
  buildToolChipDisplayPlan,
  formatToolChipsSummary,
} from "../lib/activity-log.js";
import { isViewableImageAttachment } from "../lib/image-viewer.js";
import { resolveTaskForTaskEvent } from "../lib/task-event.js";
import { getQuickStatusTransition } from "../lib/task-sidebar.js";
import {
  getSpeechRecognitionConstructor,
  type BrowserSpeechRecognition,
} from "../lib/voice-client.js";
import { ChatSessionControls } from "./ChatHistoryMenu.js";
import { MarkdownView } from "./MarkdownView.js";
import { UserMessageMentionBadges } from "./MentionBadges.js";
import { DraftMentionContextBar } from "./MentionChips.js";
import { MentionPopover } from "./MentionPopover.js";
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
  composerText: string;
  attachments: ChatAttachment[];
  selectedMentions?: ExplicitMentionTarget[];
  jumpRequest?: ChatJumpRequest | null;
  unreadReplyIds?: ReadonlySet<string>;
  onMarkMessagesRead?: (messageIds: string[]) => void;
  isMessageVisibleRef?: React.MutableRefObject<((messageId: string) => boolean) | null>;
  onComposerTextChange: (text: string) => void;
  onAddMention?: (target: ExplicitMentionTarget) => void;
  onRemoveMention?: (target: MentionChipRemovalTarget) => void;
  onRemoveAttachment: (id: string) => void;
  onAddAttachment: (att: ChatAttachment) => void;
  onSend: () => void;
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
}

export const UnifiedChat: React.FC<UnifiedChatProps> = ({
  snapshot,
  locale,
  composerText,
  attachments,
  selectedMentions = [],
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
}) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const contentContainerRef = useRef<HTMLDivElement>(null);
  const messageElementsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const scrollStateRef = useRef<ChatScrollState>(createInitialChatScrollState());
  const prevMessagesRef = useRef<readonly ChatMessage[] | null>(null);
  const prevChatSessionIdRef = useRef<string>(snapshot.activeChatSessionId);
  const lastTouchYRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerWrapperRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);
  const pendingCaretRef = useRef<number | null>(null);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [caretPos, setCaretPos] = useState(0);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [dismissedMentionKey, setDismissedMentionKey] = useState<string | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const hasMessagesRef = useRef(snapshot.messages.length > 0);
  hasMessagesRef.current = snapshot.messages.length > 0;
  const activeLocale = locale ?? resolveUiLocale(snapshot.preferredLanguage);

  // Voice Input (Web Speech API STT) state
  const [isListening, setIsListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const latestComposerTextRef = useRef(composerText);
  latestComposerTextRef.current = composerText;
  const interimTranscriptRef = useRef(interimTranscript);
  interimTranscriptRef.current = interimTranscript;
  const voiceAutoSendRef = useRef(voiceAutoSend);
  voiceAutoSendRef.current = voiceAutoSend;
  const preferredLanguageRef = useRef(snapshot.preferredLanguage);
  preferredLanguageRef.current = snapshot.preferredLanguage;
  const onComposerTextChangeRef = useRef(onComposerTextChange);
  onComposerTextChangeRef.current = onComposerTextChange;
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  const onStopSpeakingRef = useRef(onStopSpeaking);
  onStopSpeakingRef.current = onStopSpeaking;
  const voiceRecognizedAnyRef = useRef(false);
  const voiceAbortedByUserRef = useRef(false);
  const voiceHadErrorRef = useRef(false);

  const speechLocale = useMemo(
    () =>
      resolveSpeechLocale(
        snapshot.preferredLanguage,
        typeof navigator !== "undefined" ? navigator.language : undefined,
      ),
    [snapshot.preferredLanguage],
  );

  const stopVoiceInput = useCallback((options?: { cancel?: boolean }) => {
    const rec = recognitionRef.current;
    if (!rec) {
      setIsListening(false);
      setInterimTranscript("");
      interimTranscriptRef.current = "";
      return;
    }
    if (options?.cancel) {
      voiceAbortedByUserRef.current = true;
      setInterimTranscript("");
      interimTranscriptRef.current = "";
      try {
        rec.abort();
      } catch {
        // ignore
      }
    } else {
      try {
        rec.stop();
      } catch {
        // ignore
      }
    }
  }, []);

  const startVoiceInput = useCallback(async () => {
    // Stop TTS readback before opening the microphone so Conductor doesn't hear itself
    onStopSpeakingRef.current?.();
    setVoiceError(null);

    const RecognitionCtor = getSpeechRecognitionConstructor();
    if (!RecognitionCtor) {
      setVoiceError(
        formatSpeechRecognitionError("unsupported", preferredLanguageRef.current),
      );
      return;
    }

    if (typeof window !== "undefined" && window.conductor?.voiceRequestMicPermission) {
      try {
        const perm = await window.conductor.voiceRequestMicPermission();
        if (!perm.granted) {
          setVoiceError(
            formatSpeechRecognitionError("not-allowed", preferredLanguageRef.current),
          );
          return;
        }
      } catch {
        // Continue and let Chromium handle permission if IPC is unavailable
      }
    }

    // Ensure any stale recognition session is cleaned up
    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch {
        // ignore
      }
      recognitionRef.current = null;
    }

    const recognition = new RecognitionCtor();
    recognition.lang = speechLocale;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    voiceRecognizedAnyRef.current = false;
    voiceAbortedByUserRef.current = false;
    voiceHadErrorRef.current = false;
    interimTranscriptRef.current = "";
    setInterimTranscript("");
    recognitionRef.current = recognition;

    recognition.onstart = () => {
      if (recognitionRef.current !== recognition) return;
      setIsListening(true);
      textareaRef.current?.focus();
    };

    recognition.onresult = (event) => {
      if (recognitionRef.current !== recognition) return;
      let finalChunk = "";
      let interimChunk = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result?.[0]?.transcript ?? "";
        if (!transcript) continue;
        if (result.isFinal) {
          finalChunk = appendVoiceTranscript(finalChunk, transcript);
        } else {
          interimChunk = appendVoiceTranscript(interimChunk, transcript);
        }
      }

      if (finalChunk) {
        const nextText = appendVoiceTranscript(latestComposerTextRef.current, finalChunk);
        latestComposerTextRef.current = nextText;
        voiceRecognizedAnyRef.current = true;
        onComposerTextChangeRef.current(nextText);
        setCaretPos(nextText.length);
      }

      interimTranscriptRef.current = interimChunk;
      setInterimTranscript(interimChunk);
    };

    recognition.onerror = (event) => {
      if (recognitionRef.current !== recognition) return;
      voiceHadErrorRef.current = true;
      if (voiceAbortedByUserRef.current || event.error === "aborted") {
        return;
      }
      const friendly = formatSpeechRecognitionError(
        event.error || "unknown",
        preferredLanguageRef.current,
      );
      if (friendly) {
        setVoiceError(friendly);
      }
    };

    recognition.onend = () => {
      if (recognitionRef.current === recognition) {
        recognitionRef.current = null;
      }
      setIsListening(false);

      const leftoverInterim = interimTranscriptRef.current.trim();
      interimTranscriptRef.current = "";
      setInterimTranscript("");

      if (!voiceAbortedByUserRef.current && leftoverInterim) {
        const nextText = appendVoiceTranscript(latestComposerTextRef.current, leftoverInterim);
        latestComposerTextRef.current = nextText;
        voiceRecognizedAnyRef.current = true;
        onComposerTextChangeRef.current(nextText);
        setCaretPos(nextText.length);
      }

      if (
        voiceAutoSendRef.current &&
        voiceRecognizedAnyRef.current &&
        !voiceAbortedByUserRef.current &&
        !voiceHadErrorRef.current &&
        latestComposerTextRef.current.trim().length > 0
      ) {
        setDismissedMentionKey(null);
        setCaretPos(0);
        onSendRef.current();
      }
    };

    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setIsListening(false);
      setVoiceError(
        formatSpeechRecognitionError("service-not-allowed", preferredLanguageRef.current),
      );
    }
  }, [speechLocale]);

  const toggleVoiceInput = useCallback(() => {
    if (isListening || recognitionRef.current) {
      stopVoiceInput();
    } else {
      void startVoiceInput();
    }
  }, [isListening, startVoiceInput, stopVoiceInput]);

  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {
          // ignore
        }
        recognitionRef.current = null;
      }
    };
  }, []);

  // Global Option+Space / Alt+Space shortcut inside Conductor window to toggle voice input
  useEffect(() => {
    const onWindowKeyDown = (e: KeyboardEvent) => {
      if (
        e.altKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.shiftKey &&
        (e.code === "Space" || e.key === " " || e.key === "\u00a0")
      ) {
        // Avoid hijacking inputs inside modals
        const target = e.target as HTMLElement | null;
        if (target && target !== textareaRef.current && target.closest("input, textarea, select")) {
          return;
        }
        e.preventDefault();
        textareaRef.current?.focus();
        toggleVoiceInput();
      }
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [toggleVoiceInput]);

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

  const draftMentionChips = useMemo(
    () =>
      extractResolvedMentionChips(
        composerText,
        snapshot.projects,
        snapshot.tasks,
        selectedMentions,
      ),
    [composerText, snapshot.projects, snapshot.tasks, selectedMentions],
  );

  const activeMention = useMemo(
    () => detectActiveMention(composerText, caretPos),
    [composerText, caretPos],
  );
  const mentionKey = activeMention ? `${activeMention.start}:${activeMention.rawQuery}` : null;

  const { suggestions: mentionSuggestions, scopedProject } = useMemo(() => {
    if (!activeMention) return { suggestions: [] as MentionSuggestion[], scopedProject: null };
    return getMentionSuggestions(activeMention, snapshot.projects, snapshot.tasks);
  }, [activeMention, snapshot.projects, snapshot.tasks]);

  const showMentionPopover =
    activeMention !== null &&
    mentionKey !== dismissedMentionKey &&
    (mentionSuggestions.length > 0 || activeMention.mode === "project_tasks");

  const clampedMentionIndex =
    mentionSuggestions.length > 0
      ? Math.min(activeMentionIndex, mentionSuggestions.length - 1)
      : 0;

  useEffect(() => {
    setActiveMentionIndex(0);
  }, [activeMention?.start, activeMention?.rawQuery]);

  useEffect(() => {
    if (!showMentionPopover) return;
    const handlePointerDown = (ev: MouseEvent) => {
      if (
        composerWrapperRef.current &&
        !composerWrapperRef.current.contains(ev.target as Node)
      ) {
        setDismissedMentionKey(mentionKey);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [showMentionPopover, mentionKey]);

  useLayoutEffect(() => {
    if (pendingCaretRef.current === null) return;
    const targetCaret = pendingCaretRef.current;
    pendingCaretRef.current = null;
    const el = textareaRef.current;
    if (el) {
      el.focus();
      const clamped = Math.max(0, Math.min(targetCaret, el.value.length));
      el.setSelectionRange(clamped, clamped);
    }
  }, [composerText, caretPos]);

  const handleSelectMention = (suggestion: MentionSuggestion) => {
    if (!activeMention) return;
    onAddMention?.(suggestionToExplicitMentionTarget(suggestion));

    const { nextText, nextCaret } = removeActiveMentionQuery(composerText, activeMention);
    const postSelectionMention = detectActiveMention(nextText, nextCaret);
    setDismissedMentionKey(
      postSelectionMention
        ? `${postSelectionMention.start}:${postSelectionMention.rawQuery}`
        : null,
    );
    setActiveMentionIndex(0);
    pendingCaretRef.current = nextCaret;
    onComposerTextChange(nextText);
    setCaretPos(nextCaret);
  };

  const handleRemoveDraftMention = useCallback(
    (chip: ResolvedMentionChip) => {
      const target: MentionChipRemovalTarget =
        chip.kind === "task"
          ? { kind: "task", taskId: chip.task.id, taskNumber: chip.task.taskNumber }
          : { kind: "project", projectId: chip.project.id, projectName: chip.project.name };
      onRemoveMention?.(target);

      const { nextText, nextCaret, removedCount } = removeResolvedMentionChip(
        composerText,
        target,
        snapshot.projects,
        snapshot.tasks,
        caretPos,
      );
      setDismissedMentionKey(null);
      if (removedCount > 0) {
        pendingCaretRef.current = nextCaret;
        onComposerTextChange(nextText);
        setCaretPos(nextCaret);
      } else {
        textareaRef.current?.focus();
      }
    },
    [
      composerText,
      snapshot.projects,
      snapshot.tasks,
      caretPos,
      onComposerTextChange,
      onRemoveMention,
    ],
  );

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

  const displayComposerText =
    isListening && interimTranscript
      ? appendVoiceTranscript(composerText, interimTranscript)
      : composerText;

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(160, Math.max(44, el.scrollHeight))}px`;
  }, [displayComposerText]);

  const handlePickWelcomePrompt = useCallback(
    (prompt: string) => {
      onComposerTextChange(prompt);
      textareaRef.current?.focus();
    },
    [onComposerTextChange],
  );

  const recentProjectNames = useMemo(
    () => snapshot.projects.slice(0, 4).map((p) => p.name),
    [snapshot.projects],
  );

  const canSend = composerText.trim().length > 0 || attachments.length > 0;
  const handleTriggerSend = useCallback(() => {
    if (isListening || recognitionRef.current) {
      stopVoiceInput({ cancel: true });
    }
    if (!canSend) return;
    setDismissedMentionKey(null);
    setCaretPos(0);
    onSend();
  }, [canSend, isListening, onSend, stopVoiceInput]);
  const chatProviderInfo = snapshot.providers[snapshot.chatProvider];
  const workerProviderInfo = snapshot.providers[snapshot.workerProvider];
  const activeChatModel = chatProviderInfo?.models.find((m) => m.model === snapshot.chatModel);
  const activeWorkerModel = workerProviderInfo?.models.find((m) => m.model === snapshot.workerModel);
  const allProviders: AgentProvider[] = ["codex", "agy", "claude"];
  const usageSummaries = useMemo(
    () => summarizeAllUsagePeriods(snapshot.usageRecords ?? []),
    [snapshot.usageRecords],
  );
  const todayUsage = usageSummaries.today;
  const allTimeUsage = usageSummaries.all;
  const usageAlertSeverity = useMemo(() => {
    const budgets = normalizeUsageBudgetSettings(snapshot.usageBudgets);
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
  }, [usageSummaries.week, usageSummaries.month, snapshot.usageBudgets]);

  return (
    <section className="flex flex-col h-full min-w-0 bg-white dark:bg-[#0f1115]">
      {/* Top Bar */}
      <header
        className={`drag-region h-11 flex items-center justify-between gap-2 pr-3 border-b border-zinc-200/70 dark:border-zinc-800/80 shrink-0 ${
          snapshot.showTaskSidebar ? "pl-3" : "pl-[78px]"
        }`}
      >
        <div className="no-drag flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={onToggleSidebar}
            title={t(activeLocale, "chat.toggleSidebarTitle")}
            className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <PanelLeft className="w-4 h-4" />
          </button>

          <div className="flex items-center gap-1.5 min-w-0">
            <span
              title={snapshot.connectionStatus}
              className={`w-2 h-2 rounded-full shrink-0 ${
                snapshot.isConnected ? "bg-emerald-500" : "bg-amber-500"
              }`}
            />
            <span className="text-[13px] font-semibold">Conductor</span>
            {!snapshot.isConnected && (
              <span className="text-[11px] text-zinc-400 truncate hidden sm:inline">
                {snapshot.connectionStatus}
              </span>
            )}
          </div>

          {!snapshot.isConnected && (
            <button
              type="button"
              onClick={onReconnect}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 cursor-pointer"
            >
              <RefreshCw className="w-3 h-3" />
              {t(activeLocale, "chat.reconnect")}
            </button>
          )}
        </div>

        <div className="no-drag flex items-center gap-1.5">
          {snapshot.activeResponderCount > 0 && (
            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 text-[11px] font-medium">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>
                {t(activeLocale, "chat.parallelResponding", {
                  count: snapshot.activeResponderCount,
                })}
              </span>
              <button
                type="button"
                onClick={onStopAll}
                className="text-rose-500 hover:underline ml-0.5 cursor-pointer"
              >
                {t(activeLocale, "chat.stopAll")}
              </button>
            </div>
          )}

          {/* Provider & Model Split Menu (Codex / AGY / Claude) */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowModelMenu((v) => !v)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-medium bg-zinc-100 dark:bg-zinc-800/90 hover:bg-zinc-200/80 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              <Zap className="w-3 h-3 text-amber-500" />
              <span className="font-semibold text-indigo-600 dark:text-indigo-400">
                {chatProviderInfo?.label ?? snapshot.chatProvider}
              </span>
              <span className="max-w-[140px] truncate">
                {activeChatModel?.displayName ?? snapshot.chatModel ?? "Default"}
              </span>
              {snapshot.chatEffort && (
                <span className="text-zinc-400">· {snapshot.chatEffort}</span>
              )}
              <ChevronDown className="w-3 h-3 text-zinc-400" />
            </button>

            {showModelMenu && (
              <>
                <div
                  className="fixed inset-0 z-30"
                  onClick={() => setShowModelMenu(false)}
                />
                <div className="absolute right-0 mt-1.5 z-40 w-80 rounded-xl bg-white dark:bg-[#191d26] border border-zinc-200 dark:border-zinc-700 shadow-xl p-3 space-y-3">
                  {/* Front-Desk Chat Provider & Model */}
                  <div className="space-y-1.5">
                    <div className="text-[10.5px] font-semibold text-zinc-400 uppercase tracking-wider">
                      {t(activeLocale, "chat.frontDeskProvider")}
                    </div>
                    <div className="grid grid-cols-3 gap-1">
                      {allProviders.map((pId) => {
                        const info = snapshot.providers[pId];
                        const active = snapshot.chatProvider === pId;
                        return (
                          <button
                            key={pId}
                            type="button"
                            disabled={!info?.available}
                            onClick={() => onSetChatProvider(pId)}
                            title={info?.detail}
                            className={`px-2 py-1 rounded-lg text-[11.5px] font-medium border transition-colors ${
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
                        value={snapshot.chatModel ?? ""}
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
                            className={`px-2 py-0.5 rounded text-[11px] cursor-pointer ${
                              snapshot.chatEffort === eff
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
                      {t(activeLocale, "chat.workerProvider")}
                    </div>
                    <div className="grid grid-cols-3 gap-1">
                      {allProviders.map((pId) => {
                        const info = snapshot.providers[pId];
                        const active = snapshot.workerProvider === pId;
                        return (
                          <button
                            key={pId}
                            type="button"
                            disabled={!info?.available}
                            onClick={() => onSetWorkerProvider(pId)}
                            title={info?.detail}
                            className={`px-2 py-1 rounded-lg text-[11.5px] font-medium border transition-colors ${
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
                        value={snapshot.workerModel ?? ""}
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
                            className={`px-2 py-0.5 rounded text-[11px] cursor-pointer ${
                              snapshot.workerEffort === eff
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
                  ? t(activeLocale, "chat.usagePillTitle", {
                      todayTokens: formatTokenCount(todayUsage.totalTokens),
                      todayCost: formatUsdCost(todayUsage.costUsd, {
                        estimated: todayUsage.hasEstimatedCost,
                      }),
                      allTokens: formatTokenCount(allTimeUsage.totalTokens),
                      allCost: formatUsdCost(allTimeUsage.costUsd, {
                        estimated: allTimeUsage.hasEstimatedCost,
                      }),
                    })
                  : t(activeLocale, "chat.usagePillEmptyTitle")
              }
              className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium text-zinc-600 dark:text-zinc-300 bg-zinc-100/80 dark:bg-zinc-800/70 hover:bg-zinc-200/80 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors cursor-pointer tabular-nums"
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
                  <span>{formatTokenCount(todayUsage.totalTokens)}</span>
                  <span className="text-zinc-400">·</span>
                  <span>
                    {formatUsdCost(todayUsage.costUsd, {
                      estimated: todayUsage.hasEstimatedCost,
                      compact: true,
                    })}
                  </span>
                </>
              ) : (
                <span>Usage</span>
              )}
            </button>
          )}

          {isSpeaking && onStopSpeaking && (
            <button
              type="button"
              data-testid="voice-stop-speaking-btn"
              onClick={onStopSpeaking}
              title={t(activeLocale, "voice.stopSpeakingTitle")}
              aria-label={t(activeLocale, "voice.stopSpeakingTitle")}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-indigo-500/15 text-indigo-600 dark:text-indigo-300 hover:bg-rose-500/15 hover:text-rose-600 dark:hover:text-rose-300 transition-colors cursor-pointer"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-ping" />
              <Square className="w-2.5 h-2.5 fill-current" />
              <span>{t(activeLocale, "voice.stopSpeaking")}</span>
            </button>
          )}

          {onToggleVoiceReadback && (
            <button
              type="button"
              data-testid="voice-readback-toggle-btn"
              aria-pressed={voiceReadbackEnabled}
              onClick={onToggleVoiceReadback}
              title={
                voiceReadbackEnabled
                  ? t(activeLocale, "voice.readbackOnTitle")
                  : t(activeLocale, "voice.readbackOffTitle")
              }
              aria-label={
                voiceReadbackEnabled
                  ? t(activeLocale, "voice.readbackDisableAria")
                  : t(activeLocale, "voice.readbackEnableAria")
              }
              className={`p-1.5 rounded-md transition-colors cursor-pointer ${
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
              title={t(activeLocale, "chat.settingsTitle")}
              className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              <Settings className="w-4 h-4" />
            </button>
          )}

          <ChatSessionControls
            sessions={snapshot.chatSessions}
            activeSessionId={snapshot.activeChatSessionId}
            activeMessageCount={snapshot.messages.length}
            activeResponderCount={snapshot.activeResponderCount}
            locale={activeLocale}
            newChatConfirmTrigger={newChatConfirmTrigger}
            onSelectSession={onSelectChatSession}
            onNewChat={onNewChat}
            onDeleteSession={onDeleteChatSession}
          />

          <button
            type="button"
            onClick={onToggleMarkdownViewer}
            title={t(activeLocale, "chat.toggleMarkdownTitle")}
            className={`p-1.5 rounded-md transition-colors cursor-pointer ${
              snapshot.showBrowserPane && rightPaneMode === "markdown"
                ? "text-indigo-500 bg-indigo-500/10"
                : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            }`}
          >
            <BookOpen className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={onToggleBrowser}
            title={t(activeLocale, "chat.toggleRightPaneTitle")}
            className={`p-1.5 rounded-md transition-colors cursor-pointer ${
              snapshot.showBrowserPane
                ? "text-indigo-500 bg-indigo-500/10"
                : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            }`}
          >
            <PanelRight className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Error banner */}
      {snapshot.lastErrorBanner && (
        <div className="flex items-center gap-2 px-4 py-2 text-[12px] bg-rose-500/10 text-rose-600 dark:text-rose-400 border-b border-rose-500/20">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span className="flex-1 truncate">{snapshot.lastErrorBanner}</span>
          <button type="button" onClick={onDismissError} className="p-0.5 cursor-pointer">
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
                defaultIntegrationMode={snapshot.defaultIntegrationMode}
                locale={activeLocale}
                highlightedMessageId={highlightedMessageId}
                registerMessageEl={registerMessageEl}
                onOpenUrl={onOpenUrl}
                onOpenMarkdownFile={onOpenMarkdownFile}
                onOpenImageAttachment={onOpenImageAttachment}
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

      {/* Non-Blocking Composer */}
      <div className="px-4 pb-4 pt-1 shrink-0">
        <div
          ref={composerWrapperRef}
          className="relative max-w-[740px] mx-auto rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/90 dark:bg-[#171b24] shadow-sm focus-within:border-indigo-500/60 transition-colors"
        >
          {showMentionPopover && activeMention && (
            <MentionPopover
              query={activeMention}
              suggestions={mentionSuggestions}
              scopedProject={scopedProject}
              activeIndex={clampedMentionIndex}
              locale={activeLocale}
              onHoverIndex={setActiveMentionIndex}
              onSelect={handleSelectMention}
            />
          )}

          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
              {attachments.map((att) => {
                const viewableImage =
                  isViewableImageAttachment(att) && Boolean(onOpenImageAttachment);
                return (
                  <div
                    key={att.id}
                    className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11.5px] bg-zinc-200/70 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200"
                  >
                    {viewableImage ? (
                      <button
                        type="button"
                        onClick={() =>
                          onOpenImageAttachment?.(att, {
                            draftText: composerText,
                            draftMentions: selectedMentions,
                          })
                        }
                        title={t(activeLocale, "chat.openImageInRightPaneTitle", {
                          label: att.label,
                        })}
                        aria-label={t(activeLocale, "chat.openImageInRightPaneAria", {
                          label: att.label,
                        })}
                        className="group inline-flex items-center gap-1.5 min-w-0 rounded hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors cursor-pointer"
                      >
                        {att.imageDataUrl ? (
                          <img
                            src={att.imageDataUrl}
                            alt={att.label}
                            className="w-5 h-5 rounded object-cover ring-1 ring-transparent group-hover:ring-indigo-500/70 group-hover:scale-105 transition-all shrink-0"
                          />
                        ) : (
                          <ImageIcon className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
                        )}
                        <span className="max-w-[180px] truncate">{att.label}</span>
                      </button>
                    ) : (
                      <>
                        {att.imageDataUrl && (
                          <img
                            src={att.imageDataUrl}
                            alt={att.label}
                            className="w-5 h-5 rounded object-cover"
                          />
                        )}
                        <span className="max-w-[180px] truncate">{att.label}</span>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => onRemoveAttachment(att.id)}
                      aria-label={t(activeLocale, "chat.removeAttachmentAria", {
                        label: att.label,
                      })}
                      className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-100 cursor-pointer"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <DraftMentionContextBar
            chips={draftMentionChips}
            locale={activeLocale}
            onRemoveChip={handleRemoveDraftMention}
            hasAttachmentsAbove={attachments.length > 0}
          />

          {isListening && (
            <div
              data-testid="composer-voice-listening-bar"
              className="flex items-center justify-between gap-2 px-3.5 pt-2 pb-0.5 text-[11.5px] text-rose-600 dark:text-rose-400"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="relative flex h-2 w-2 shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500" />
                </span>
                <span className="font-medium shrink-0">
                  {t(activeLocale, "voice.listeningLabel", { locale: speechLocale })}
                </span>
                <span className="text-zinc-500 dark:text-zinc-400 truncate">
                  {interimTranscript || t(activeLocale, "voice.listeningHint")}
                </span>
              </div>
              <button
                type="button"
                onClick={() => stopVoiceInput()}
                className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-rose-500/12 hover:bg-rose-500/20 text-rose-600 dark:text-rose-300 cursor-pointer shrink-0"
              >
                {t(activeLocale, "common.stop")}
              </button>
            </div>
          )}

          {voiceError && (
            <div
              data-testid="composer-voice-error-banner"
              className="mx-3 mt-2 px-2.5 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-[11.5px] text-amber-800 dark:text-amber-200 flex items-start gap-2"
            >
              <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
              <span className="flex-1 leading-relaxed">{voiceError}</span>
              <button
                type="button"
                onClick={() => setVoiceError(null)}
                aria-label={t(activeLocale, "voice.dismissErrorAria")}
                className="text-amber-600/80 hover:text-amber-800 dark:text-amber-300/80 dark:hover:text-amber-100 cursor-pointer shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={displayComposerText}
            onChange={(e) => {
              if (interimTranscriptRef.current) {
                interimTranscriptRef.current = "";
                setInterimTranscript("");
              }
              onComposerTextChange(e.target.value);
              setCaretPos(e.target.selectionStart ?? e.target.value.length);
              setDismissedMentionKey(null);
            }}
            onClick={(e) => {
              setCaretPos(e.currentTarget.selectionStart ?? e.currentTarget.value.length);
            }}
            onSelect={(e) => {
              if (pendingCaretRef.current !== null) return;
              setCaretPos(e.currentTarget.selectionStart ?? e.currentTarget.value.length);
            }}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={(e) => {
              isComposingRef.current = false;
              setCaretPos(e.currentTarget.selectionStart ?? e.currentTarget.value.length);
            }}
            onKeyUp={(e) => {
              if (
                pendingCaretRef.current !== null ||
                (showMentionPopover &&
                  (e.key === "ArrowUp" ||
                    e.key === "ArrowDown" ||
                    e.key === "Enter" ||
                    e.key === "Tab" ||
                    e.key === "Escape"))
              ) {
                return;
              }
              setCaretPos(e.currentTarget.selectionStart ?? e.currentTarget.value.length);
            }}
            onKeyDown={(e) => {
              const composing =
                e.nativeEvent.isComposing || isComposingRef.current || e.keyCode === 229;
              if (composing) return;

              if (
                e.altKey &&
                !e.metaKey &&
                !e.ctrlKey &&
                !e.shiftKey &&
                (e.code === "Space" || e.key === " " || e.key === "\u00a0")
              ) {
                e.preventDefault();
                toggleVoiceInput();
                return;
              }

              if (isListening && e.key === "Escape") {
                e.preventDefault();
                stopVoiceInput({ cancel: true });
                return;
              }

              if (showMentionPopover) {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setDismissedMentionKey(mentionKey);
                  return;
                }
                if (mentionSuggestions.length > 0) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setActiveMentionIndex((prev) => (prev + 1) % mentionSuggestions.length);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setActiveMentionIndex(
                      (prev) => (prev - 1 + mentionSuggestions.length) % mentionSuggestions.length,
                    );
                    return;
                  }
                  if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                    e.preventDefault();
                    handleSelectMention(mentionSuggestions[clampedMentionIndex]);
                    return;
                  }
                }
              }

              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleTriggerSend();
              }
            }}
            onPaste={(e) => {
              const items = e.clipboardData?.items;
              if (!items) return;
              for (const item of Array.from(items)) {
                if (item.type.startsWith("image/")) {
                  const file = item.getAsFile();
                  if (!file) continue;
                  e.preventDefault();
                  const reader = new FileReader();
                  reader.onload = () => {
                    if (typeof reader.result === "string") {
                      onPasteImage(reader.result);
                    }
                  };
                  reader.readAsDataURL(file);
                  break;
                }
              }
            }}
            placeholder={t(activeLocale, "chat.composerPlaceholder")}
            rows={1}
            className="w-full resize-none bg-transparent px-3.5 pt-3 pb-1.5 text-[14px] leading-relaxed outline-none placeholder:text-zinc-400 dark:placeholder:text-zinc-500 select-text"
          />

          <div className="flex items-center justify-between px-2.5 pb-2 pt-0.5">
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                data-testid="composer-attach-image-btn"
                onClick={onPickLocalImages}
                title={t(activeLocale, "chat.attachImage")}
                aria-label={t(activeLocale, "chat.attachImage")}
                className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
              >
                <Paperclip className="w-4 h-4" />
              </button>

              {isBrowserTabActive && (
                <>
                  <button
                    type="button"
                    data-testid="composer-screenshot-btn"
                    onClick={onCaptureScreenshot}
                    title={t(activeLocale, "chat.screenshotTitle")}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11.5px] text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                  >
                    <Camera className="w-3.5 h-3.5" />
                    <span>{t(activeLocale, "chat.screenshotBtn")}</span>
                  </button>

                  <button
                    type="button"
                    data-testid="composer-element-picker-btn"
                    onClick={onToggleElementPicker}
                    title={t(activeLocale, "chat.elementPickerTitle")}
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11.5px] transition-colors cursor-pointer ${
                      snapshot.isPickingElement
                        ? "bg-indigo-500 text-white"
                        : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800"
                    }`}
                  >
                    <Crosshair className="w-3.5 h-3.5" />
                    <span>{t(activeLocale, "chat.elementPickerBtn")}</span>
                  </button>

                  <button
                    type="button"
                    data-testid="composer-attach-url-btn"
                    onClick={onAttachCurrentUrl}
                    title={t(activeLocale, "chat.attachUrlTitle")}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11.5px] text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                  >
                    <Link2 className="w-3.5 h-3.5" />
                    <span>URL</span>
                  </button>

                  {browserErrorCount > 0 && (
                    <button
                      type="button"
                      data-testid="composer-attach-errors-btn"
                      onClick={onAttachConsoleErrors}
                      title={t(activeLocale, "chat.attachErrorsTitle")}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11.5px] font-medium bg-rose-500/15 text-rose-600 dark:text-rose-400 hover:bg-rose-500/25 transition-colors cursor-pointer"
                    >
                      <AlertTriangle className="w-3.5 h-3.5" />
                      <span>{t(activeLocale, "chat.errorsCountBtn", { count: browserErrorCount })}</span>
                    </button>
                  )}
                </>
              )}
            </div>

            <div className="flex items-center gap-1.5">
              {onToggleVoiceAutoSend && (
                <button
                  type="button"
                  data-testid="composer-voice-autosend-btn"
                  aria-pressed={voiceAutoSend}
                  onClick={onToggleVoiceAutoSend}
                  title={
                    voiceAutoSend
                      ? t(activeLocale, "voice.autoSendOnTitle")
                      : t(activeLocale, "voice.autoSendOffTitle")
                  }
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium transition-colors cursor-pointer ${
                    voiceAutoSend
                      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30"
                      : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 border border-transparent"
                  }`}
                >
                  <span>{t(activeLocale, "voice.autoSendShort")}</span>
                </button>
              )}

              <button
                type="button"
                data-testid="composer-voice-mic-btn"
                aria-pressed={isListening}
                onClick={toggleVoiceInput}
                title={
                  isListening
                    ? t(activeLocale, "voice.micStopTitle", { locale: speechLocale })
                    : t(activeLocale, "voice.micStartTitle", { locale: speechLocale })
                }
                aria-label={
                  isListening
                    ? t(activeLocale, "voice.micStopAria")
                    : t(activeLocale, "voice.micStartAria")
                }
                className={`relative w-8 h-8 rounded-full flex items-center justify-center transition-all cursor-pointer ${
                  isListening
                    ? "bg-rose-500 hover:bg-rose-600 text-white shadow-sm ring-2 ring-rose-500/35"
                    : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/70 dark:hover:bg-zinc-800"
                }`}
              >
                {isListening && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-0 rounded-full bg-rose-500/40 animate-ping pointer-events-none"
                  />
                )}
                {isListening ? (
                  <MicOff className="w-4 h-4 relative z-10" />
                ) : (
                  <Mic className="w-4 h-4" />
                )}
              </button>

              <button
                type="button"
                onClick={handleTriggerSend}
                disabled={!canSend}
                title={t(activeLocale, "chat.sendTitle")}
                className={`w-8 h-8 rounded-full flex items-center justify-center transition-all ${
                  canSend
                    ? "bg-indigo-600 hover:bg-indigo-500 text-white cursor-pointer shadow-sm"
                    : "bg-zinc-200 dark:bg-zinc-800 text-zinc-400 cursor-not-allowed"
                }`}
              >
                <ArrowUp className="w-4 h-4 stroke-[2.5]" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

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
  onOpenTask: (taskId: string) => void;
  onUpdateTaskStatus?: (taskId: string, status: AgentTaskStatus) => void;
  onLandTask?: (taskId: string, options?: { createPr?: boolean }) => void;
  onStopMessage: (id: string) => void;
}> = React.memo(({
  message,
  projects,
  tasks,
  defaultIntegrationMode,
  locale,
  isHighlighted,
  registerMessageEl,
  onOpenUrl,
  onOpenMarkdownFile,
  onOpenImageAttachment,
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
        defaultIntegrationMode={defaultIntegrationMode}
        locale={locale}
        onOpenUrl={handleOpenUrl}
        onOpenMarkdownFile={handleOpenMarkdownFile}
        onOpenImageAttachment={onOpenImageAttachment ? handleOpenImage : undefined}
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
  onOpenTask: (taskId: string) => void;
  onUpdateTaskStatus?: (taskId: string, status: AgentTaskStatus) => void;
  onLandTask?: (taskId: string, options?: { createPr?: boolean }) => void;
  onStopMessage: (id: string) => void;
}> = React.memo(({
  messages,
  projects,
  tasks,
  defaultIntegrationMode,
  locale,
  highlightedMessageId,
  registerMessageEl,
  onOpenUrl,
  onOpenMarkdownFile,
  onOpenImageAttachment,
  onOpenTask,
  onUpdateTaskStatus,
  onLandTask,
  onStopMessage,
}) => {
  return (
    <>
      {messages.map((msg) => {
        const needsWorkspaceRefs = msg.role !== "assistant";
        return (
          <ChatMessageItem
            key={msg.id}
            message={msg}
            projects={needsWorkspaceRefs ? projects : EMPTY_PROJECTS}
            tasks={needsWorkspaceRefs ? tasks : EMPTY_TASKS}
            defaultIntegrationMode={
              msg.role === "taskEvent" ? defaultIntegrationMode : undefined
            }
            locale={locale}
            isHighlighted={highlightedMessageId === msg.id}
            registerMessageEl={registerMessageEl}
            onOpenUrl={onOpenUrl}
            onOpenMarkdownFile={onOpenMarkdownFile}
            onOpenImageAttachment={onOpenImageAttachment}
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

      <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-[11.5px] bg-zinc-100 dark:bg-zinc-800/80 text-zinc-600 dark:text-zinc-300">
        <span className="w-2 h-2 rounded-full bg-emerald-500" />
        <span>
          {projectCount > 0
            ? t(locale, "chat.welcomeProjectsDetected", { count: projectCount })
            : t(locale, "chat.welcomeProjectsScanning")}
        </span>
        <button
          type="button"
          onClick={onAddProject}
          className="text-indigo-500 hover:underline font-medium cursor-pointer ml-1"
        >
          {t(locale, "chat.welcomeAddFolder")}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2.5 w-full max-w-xl pt-2">
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
  defaultIntegrationMode?: IntegrationMode;
  locale?: UiLocale;
  onOpenUrl: (url: string) => void;
  onOpenMarkdownFile: (target: string, baseFilePath?: string) => void;
  onOpenTask: (taskId: string) => void;
  onUpdateTaskStatus?: (taskId: string, status: AgentTaskStatus) => void;
  onLandTask?: (taskId: string, options?: { createPr?: boolean }) => void;
}

export const TaskEventCard: React.FC<TaskEventCardProps> = ({
  message,
  tasks,
  projects = [],
  defaultIntegrationMode = "feature-branch",
  locale = "ja",
  onOpenUrl,
  onOpenMarkdownFile,
  onOpenTask,
  onUpdateTaskStatus,
  onLandTask,
}) => {
  const resolvedTask = resolveTaskForTaskEvent(message, tasks);
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
  const resolvedProject = resolvedTask
    ? (resolvedTask.projectId
        ? projects.find((p) => p.id === resolvedTask.projectId)
        : undefined) ??
      projects.find((p) => p.name.toLowerCase() === resolvedTask.projectName.toLowerCase())
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
            className={`flex items-center justify-between gap-2 pb-2 border-b ${
              isDone
                ? "border-emerald-500/15 dark:border-emerald-400/15"
                : "border-indigo-500/15 dark:border-indigo-400/15"
            }`}
          >
            <div className="flex items-center gap-1.5 min-w-0">
              <Bell
                className={`w-3.5 h-3.5 shrink-0 ${
                  isDone ? "text-emerald-500" : "text-indigo-500"
                }`}
              />
              <span className="px-1.5 py-0.5 rounded font-mono text-[10px] font-semibold bg-indigo-500/12 text-indigo-600 dark:text-indigo-300 border border-indigo-500/20 shrink-0">
                {formatTaskCode(resolvedTask.taskNumber)}
              </span>
              <span className="text-[11.5px] font-medium text-zinc-700 dark:text-zinc-200 truncate">
                {resolvedTask.title}
              </span>
              {isDone && (
                <span
                  data-testid="task-event-done-badge"
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 shrink-0"
                >
                  <CheckCircle2 className="w-3 h-3" />
                  <span>{t(locale, "task.doneBadge")}</span>
                </span>
              )}
              {isRunning && (
                <span
                  data-testid="task-event-running-badge"
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-indigo-500/15 text-indigo-600 dark:text-indigo-300 shrink-0"
                >
                  <Loader2 className="w-2.5 h-2.5 animate-spin" />
                  <span>{t(locale, "task.runningBadge")}</span>
                </span>
              )}
              {needsLand && !isRunning && (
                <span
                  data-testid="task-event-unlanded-badge"
                  title={doneBlockedReason ?? undefined}
                  className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/15 text-amber-700 dark:text-amber-300 shrink-0"
                >
                  {t(locale, "task.unlandedBadge")}
                </span>
              )}
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
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
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium border transition-colors shrink-0 ${
                    isLanding
                      ? "bg-indigo-500/10 border-indigo-500/25 text-indigo-500 opacity-70 cursor-wait"
                      : resolvedTask.landStatus === "conflict" || resolvedTask.landStatus === "error"
                        ? "bg-amber-500/12 border-amber-500/35 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 cursor-pointer"
                        : "bg-indigo-500/12 border-indigo-500/30 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-500/22 hover:border-indigo-500/45 cursor-pointer"
                  }`}
                >
                  {isLanding ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : isPrMode ? (
                    <GitPullRequest className="w-3 h-3" />
                  ) : (
                    <GitMerge className="w-3 h-3" />
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
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium border transition-colors shrink-0 ${
                    isQuickDoneBlocked
                      ? "bg-zinc-100 dark:bg-zinc-800/60 border-zinc-200/80 dark:border-zinc-700/70 text-zinc-400 dark:text-zinc-500 opacity-60 cursor-not-allowed"
                      : isDone
                        ? "bg-zinc-100 dark:bg-zinc-800/80 border-zinc-200/90 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-indigo-500/12 hover:border-indigo-500/35 hover:text-indigo-600 dark:hover:text-indigo-300 cursor-pointer"
                        : "bg-emerald-500/12 border-emerald-500/30 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/22 hover:border-emerald-500/45 cursor-pointer"
                  }`}
                >
                  {isDone ? <RotateCcw className="w-3 h-3" /> : <Check className="w-3 h-3" />}
                  <span>{quickTransition.label}</span>
                </button>
              )}
            </div>
          </div>

          <MarkdownView
            content={message.text}
            locale={locale}
            onOpenUrl={onOpenUrl}
            onOpenMarkdownFile={onOpenMarkdownFile}
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
              onOpenUrl={onOpenUrl}
              onOpenMarkdownFile={onOpenMarkdownFile}
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
  defaultIntegrationMode?: IntegrationMode;
  locale: UiLocale;
  onOpenUrl: (url: string) => void;
  onOpenMarkdownFile: (target: string, baseFilePath?: string) => void;
  onOpenImageAttachment?: (attachment: ChatAttachment) => void;
  onOpenTask: (taskId: string) => void;
  onUpdateTaskStatus?: (taskId: string, status: AgentTaskStatus) => void;
  onLandTask?: (taskId: string, options?: { createPr?: boolean }) => void;
  onStop: () => void;
}> = React.memo(({
  message,
  projects,
  tasks,
  defaultIntegrationMode,
  locale,
  onOpenUrl,
  onOpenMarkdownFile,
  onOpenImageAttachment,
  onOpenTask,
  onUpdateTaskStatus,
  onLandTask,
  onStop,
}) => {
  const [showReasoning, setShowReasoning] = useState(false);
  const mentionBadges = useMemo(
    () =>
      message.role === "user"
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
  const userMentionContext = useMemo(
    () => (message.role === "user" ? { projects, tasks, onOpenTask } : undefined),
    [message.role, projects, tasks, onOpenTask],
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
        defaultIntegrationMode={defaultIntegrationMode}
        locale={locale}
        onOpenUrl={onOpenUrl}
        onOpenMarkdownFile={onOpenMarkdownFile}
        onOpenTask={onOpenTask}
        onUpdateTaskStatus={onUpdateTaskStatus}
        onLandTask={onLandTask}
      />
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="w-5 h-5 rounded-md bg-indigo-500/15 flex items-center justify-center">
          <Sparkles className="w-3 h-3 text-indigo-500" />
        </div>
        <span className="text-[12px] font-semibold text-zinc-600 dark:text-zinc-400">
          Conductor
          {message.provider && (
            <span className="ml-1 font-normal text-zinc-400">
              · {message.provider === "agy" ? "AGY" : message.provider === "claude" ? "Claude" : "Codex"}
            </span>
          )}
        </span>
        {message.replyToSnippet && (
          <span className="px-2 py-0.5 rounded-full text-[10.5px] bg-zinc-100 dark:bg-zinc-800 text-zinc-500 truncate max-w-[260px]">
            ↩ {message.replyToSnippet}
          </span>
        )}
        {message.isStreaming && (
          <>
            <Loader2 className="w-3 h-3 text-indigo-500 animate-spin" />
            <div className="flex-1" />
            <button
              type="button"
              onClick={onStop}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-rose-500 hover:bg-rose-500/10 cursor-pointer"
            >
              <Square className="w-2.5 h-2.5 fill-current" />
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
