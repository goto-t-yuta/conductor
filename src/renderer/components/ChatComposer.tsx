import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUp,
  Camera,
  Crosshair,
  Image as ImageIcon,
  Link2,
  Mic,
  MicOff,
  Paperclip,
  X,
} from "lucide-react";
import type {
  AgentTask,
  ChatAttachment,
  ChatMessage,
  ExplicitMentionTarget,
  PreferredLanguage,
  Project,
} from "../../shared/types.js";
import {
  detectActiveMention,
  extractResolvedMentionChips,
  getMentionSuggestions,
  removeActiveMentionQuery,
  removeResolvedMentionChip,
  suggestionToExplicitMentionTarget,
  type ActiveMentionQuery,
  type MentionChipRemovalTarget,
  type MentionSuggestion,
  type ResolvedMentionChip,
} from "../../shared/mentions.js";
import { t, type UiLocale } from "../../shared/i18n.js";
import {
  appendVoiceTranscript,
  formatSpeechRecognitionError,
  resolveSpeechLocale,
} from "../../shared/voice.js";
import {
  COMPOSER_TEXTAREA_MIN_HEIGHT,
  areActiveMentionQueriesEqual,
  clampComposerTextareaHeight,
  planComposerTextareaResize,
} from "../lib/composer-perf.js";
import { isViewableImageAttachment } from "../lib/image-viewer.js";
import {
  getSpeechRecognitionConstructor,
  type BrowserSpeechRecognition,
} from "../lib/voice-client.js";
import { DraftMentionContextBar } from "./MentionChips.js";
import { MentionPopover } from "./MentionPopover.js";

const MemoDraftMentionContextBar = React.memo(DraftMentionContextBar);

export interface ChatComposerHandle {
  setDraftText: (text: string) => void;
  focus: () => void;
}

export interface ChatComposerProps {
  /**
   * Optional controlled text value. When omitted (production `App`), `ChatComposer`
   * owns the draft text state locally so typing never re-renders `App`, `UnifiedChat`,
   * the header, or the message list.
   */
  composerText?: string;
  onComposerTextChange?: (text: string) => void;
  attachments: ChatAttachment[];
  selectedMentions: ExplicitMentionTarget[];
  projects: Project[];
  tasks: AgentTask[];
  locale: UiLocale;
  preferredLanguage?: PreferredLanguage;
  isBrowserTabActive: boolean;
  isPickingElement: boolean;
  browserErrorCount: number;
  voiceAutoSend: boolean;
  composerHandleRef?: React.MutableRefObject<ChatComposerHandle | null>;
  onAddMention?: (target: ExplicitMentionTarget) => void;
  onRemoveMention?: (target: MentionChipRemovalTarget) => void;
  onRemoveAttachment: (id: string) => void;
  onSend: (text?: string) => void;
  onOpenImageAttachment?: (
    attachment: ChatAttachment,
    context?: {
      message?: ChatMessage;
      draftText?: string;
      draftMentions?: ExplicitMentionTarget[];
    },
  ) => void;
  onToggleElementPicker: () => void;
  onCaptureScreenshot: () => void;
  onAttachCurrentUrl: () => void;
  onAttachConsoleErrors: () => void;
  onPickLocalImages: () => void;
  onPasteImage: (base64: string) => void;
  onStopSpeaking?: () => void;
  onToggleVoiceAutoSend?: () => void;
}

export const ChatComposer: React.FC<ChatComposerProps> = React.memo(({
  composerText: controlledComposerText,
  onComposerTextChange,
  attachments,
  selectedMentions,
  projects,
  tasks,
  locale,
  preferredLanguage = "auto",
  isBrowserTabActive,
  isPickingElement,
  browserErrorCount,
  voiceAutoSend,
  composerHandleRef,
  onAddMention,
  onRemoveMention,
  onRemoveAttachment,
  onSend,
  onOpenImageAttachment,
  onToggleElementPicker,
  onCaptureScreenshot,
  onAttachCurrentUrl,
  onAttachConsoleErrors,
  onPickLocalImages,
  onPasteImage,
  onStopSpeaking,
  onToggleVoiceAutoSend,
}) => {
  const isControlled = controlledComposerText !== undefined;
  const [internalText, setInternalText] = useState("");
  const composerText = isControlled ? controlledComposerText : internalText;

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerWrapperRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);
  const pendingCaretRef = useRef<number | null>(null);
  const caretPosRef = useRef(0);

  const [activeMention, setActiveMention] = useState<ActiveMentionQuery | null>(null);
  const activeMentionRef = useRef<ActiveMentionQuery | null>(activeMention);
  activeMentionRef.current = activeMention;

  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [dismissedMentionKey, setDismissedMentionKey] = useState<string | null>(null);

  // Voice Input (Web Speech API STT) state
  const [isListening, setIsListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const latestComposerTextRef = useRef(composerText);
  latestComposerTextRef.current = composerText;
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const interimTranscriptRef = useRef(interimTranscript);
  interimTranscriptRef.current = interimTranscript;
  const voiceAutoSendRef = useRef(voiceAutoSend);
  voiceAutoSendRef.current = voiceAutoSend;
  const preferredLanguageRef = useRef(preferredLanguage);
  preferredLanguageRef.current = preferredLanguage;
  const onComposerTextChangeRef = useRef(onComposerTextChange);
  onComposerTextChangeRef.current = onComposerTextChange;
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  const onStopSpeakingRef = useRef(onStopSpeaking);
  onStopSpeakingRef.current = onStopSpeaking;
  const isControlledRef = useRef(isControlled);
  isControlledRef.current = isControlled;
  const voiceRecognizedAnyRef = useRef(false);
  const voiceAbortedByUserRef = useRef(false);
  const voiceHadErrorRef = useRef(false);

  // Textarea auto-resize tracking refs (to eliminate forced reflow on every keystroke)
  const appliedHeightRef = useRef<number | null>(null);
  const prevMeasuredTextRef = useRef("");
  const prevMeasuredWidthRef = useRef(0);
  const resizeRafRef = useRef<number | null>(null);

  const applyComposerTextUpdate = useCallback((nextText: string) => {
    latestComposerTextRef.current = nextText;
    if (!isControlledRef.current) {
      setInternalText(nextText);
    }
    onComposerTextChangeRef.current?.(nextText);
  }, []);

  const syncActiveMention = useCallback((text: string, caret: number) => {
    caretPosRef.current = caret;
    if (!text.includes("@")) {
      if (activeMentionRef.current !== null) {
        activeMentionRef.current = null;
        setActiveMention(null);
      }
      return;
    }
    const next = detectActiveMention(text, caret);
    if (!areActiveMentionQueriesEqual(activeMentionRef.current, next)) {
      activeMentionRef.current = next;
      setActiveMention(next);
    }
  }, []);

  // Expose imperative handle so EmptyWelcome prompt clicks never need composer state in UnifiedChat
  useEffect(() => {
    if (!composerHandleRef) return;
    composerHandleRef.current = {
      setDraftText: (nextText: string) => {
        applyComposerTextUpdate(nextText);
        setDismissedMentionKey(null);
        syncActiveMention(nextText, nextText.length);
        textareaRef.current?.focus();
      },
      focus: () => {
        textareaRef.current?.focus();
      },
    };
    return () => {
      composerHandleRef.current = null;
    };
  }, [composerHandleRef, applyComposerTextUpdate, syncActiveMention]);

  const speechLocale = useMemo(
    () =>
      resolveSpeechLocale(
        preferredLanguage,
        typeof navigator !== "undefined" ? navigator.language : undefined,
      ),
    [preferredLanguage],
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
        voiceRecognizedAnyRef.current = true;
        applyComposerTextUpdate(nextText);
        syncActiveMention(nextText, nextText.length);
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
        voiceRecognizedAnyRef.current = true;
        applyComposerTextUpdate(nextText);
        syncActiveMention(nextText, nextText.length);
      }

      if (
        voiceAutoSendRef.current &&
        voiceRecognizedAnyRef.current &&
        !voiceAbortedByUserRef.current &&
        !voiceHadErrorRef.current &&
        latestComposerTextRef.current.trim().length > 0
      ) {
        const textToSend = latestComposerTextRef.current;
        setDismissedMentionKey(null);
        activeMentionRef.current = null;
        setActiveMention(null);
        caretPosRef.current = 0;
        if (!isControlledRef.current) {
          latestComposerTextRef.current = "";
          setInternalText("");
        }
        onSendRef.current(textToSend);
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
  }, [speechLocale, applyComposerTextUpdate, syncActiveMention]);

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

  // Only re-scan draft mention chips when the text actually contains `@`,
  // avoiding wasted recomputation when typing normal prose alongside selected chips.
  const inlineMentionSourceText = composerText.includes("@") ? composerText : "";
  const draftMentionChips = useMemo(
    () =>
      extractResolvedMentionChips(
        inlineMentionSourceText,
        projects,
        tasks,
        selectedMentions,
      ),
    [inlineMentionSourceText, projects, tasks, selectedMentions],
  );

  const mentionKey = activeMention ? `${activeMention.start}:${activeMention.rawQuery}` : null;

  const { suggestions: mentionSuggestions, scopedProject } = useMemo(() => {
    if (!activeMention) return { suggestions: [] as MentionSuggestion[], scopedProject: null };
    return getMentionSuggestions(activeMention, projects, tasks);
  }, [activeMention, projects, tasks]);

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
  }, [composerText, activeMention]);

  const handleSelectMention = useCallback(
    (suggestion: MentionSuggestion) => {
      const currentMention = activeMentionRef.current;
      if (!currentMention) return;
      onAddMention?.(suggestionToExplicitMentionTarget(suggestion));

      const { nextText, nextCaret } = removeActiveMentionQuery(
        latestComposerTextRef.current,
        currentMention,
      );
      const postSelectionMention = nextText.includes("@")
        ? detectActiveMention(nextText, nextCaret)
        : null;
      setDismissedMentionKey(
        postSelectionMention
          ? `${postSelectionMention.start}:${postSelectionMention.rawQuery}`
          : null,
      );
      setActiveMentionIndex(0);
      pendingCaretRef.current = nextCaret;
      caretPosRef.current = nextCaret;
      activeMentionRef.current = postSelectionMention;
      setActiveMention(postSelectionMention);
      applyComposerTextUpdate(nextText);
    },
    [onAddMention, applyComposerTextUpdate],
  );

  const handleRemoveDraftMention = useCallback(
    (chip: ResolvedMentionChip) => {
      const target: MentionChipRemovalTarget =
        chip.kind === "task"
          ? { kind: "task", taskId: chip.task.id, taskNumber: chip.task.taskNumber }
          : { kind: "project", projectId: chip.project.id, projectName: chip.project.name };
      onRemoveMention?.(target);

      const currentText = latestComposerTextRef.current;
      const { nextText, nextCaret, removedCount } = removeResolvedMentionChip(
        currentText,
        target,
        projects,
        tasks,
        caretPosRef.current,
      );
      setDismissedMentionKey(null);
      if (removedCount > 0) {
        pendingCaretRef.current = nextCaret;
        applyComposerTextUpdate(nextText);
        syncActiveMention(nextText, nextCaret);
      } else {
        textareaRef.current?.focus();
      }
    },
    [projects, tasks, onRemoveMention, applyComposerTextUpdate, syncActiveMention],
  );

  const displayComposerText =
    isListening && interimTranscript
      ? appendVoiceTranscript(composerText, interimTranscript)
      : composerText;

  // Batched, reflow-minimized textarea auto-resize (scheduled in requestAnimationFrame)
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;

    const performResize = () => {
      const target = textareaRef.current;
      if (!target) return;
      const clientWidth = target.clientWidth;
      const action = planComposerTextareaResize({
        nextText: displayComposerText,
        prevText: prevMeasuredTextRef.current,
        currentHeight: appliedHeightRef.current,
        clientWidth,
        prevClientWidth: prevMeasuredWidthRef.current,
      });

      prevMeasuredTextRef.current = displayComposerText;
      prevMeasuredWidthRef.current = clientWidth;

      if (action === "skip") {
        return;
      }

      if (action === "set_min") {
        appliedHeightRef.current = COMPOSER_TEXTAREA_MIN_HEIGHT;
        target.style.height = `${COMPOSER_TEXTAREA_MIN_HEIGHT}px`;
        return;
      }

      if (action === "measure_grow") {
        const nextHeight = clampComposerTextareaHeight(target.scrollHeight);
        if (appliedHeightRef.current === null || nextHeight > appliedHeightRef.current) {
          appliedHeightRef.current = nextHeight;
          target.style.height = `${nextHeight}px`;
        }
        return;
      }

      // action === "measure_full" (shrink / width change / initial measurement)
      target.style.height = "auto";
      const nextHeight = clampComposerTextareaHeight(target.scrollHeight);
      appliedHeightRef.current = nextHeight;
      target.style.height = `${nextHeight}px`;
    };

    if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
      performResize();
      return;
    }

    if (resizeRafRef.current !== null) {
      window.cancelAnimationFrame(resizeRafRef.current);
    }
    resizeRafRef.current = window.requestAnimationFrame(() => {
      resizeRafRef.current = null;
      performResize();
    });

    return () => {
      if (resizeRafRef.current !== null) {
        window.cancelAnimationFrame(resizeRafRef.current);
        resizeRafRef.current = null;
      }
    };
  }, [displayComposerText]);

  const canSend = composerText.trim().length > 0 || attachments.length > 0;
  const handleTriggerSend = useCallback(() => {
    if (isListening || recognitionRef.current) {
      stopVoiceInput({ cancel: true });
    }
    const textToSend = latestComposerTextRef.current;
    if (!textToSend.trim() && attachmentsRef.current.length === 0) return;
    setDismissedMentionKey(null);
    activeMentionRef.current = null;
    setActiveMention(null);
    caretPosRef.current = 0;
    if (!isControlledRef.current) {
      latestComposerTextRef.current = "";
      setInternalText("");
    }
    onSendRef.current(textToSend);
  }, [isListening, stopVoiceInput]);

  return (
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
            locale={locale}
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
                  className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11.5px] bg-zinc-200/70 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 max-w-full min-w-0"
                >
                  {viewableImage ? (
                    <button
                      type="button"
                      onClick={() =>
                        onOpenImageAttachment?.(att, {
                          draftText: latestComposerTextRef.current,
                          draftMentions: selectedMentions,
                        })
                      }
                      title={t(locale, "chat.openImageTitle", {
                        label: att.label,
                      })}
                      aria-label={t(locale, "chat.openImageAria", {
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
                    aria-label={t(locale, "chat.removeAttachmentAria", {
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

        <MemoDraftMentionContextBar
          chips={draftMentionChips}
          locale={locale}
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
              <span className="font-medium shrink-0 whitespace-nowrap">
                {t(locale, "voice.listeningLabel", { locale: speechLocale })}
              </span>
              <span className="text-zinc-500 dark:text-zinc-400 truncate">
                {interimTranscript || t(locale, "voice.listeningHint")}
              </span>
            </div>
            <button
              type="button"
              onClick={() => stopVoiceInput()}
              className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-rose-500/12 hover:bg-rose-500/20 text-rose-600 dark:text-rose-300 cursor-pointer shrink-0 whitespace-nowrap"
            >
              {t(locale, "common.stop")}
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
              aria-label={t(locale, "voice.dismissErrorAria")}
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
            const nextVal = e.target.value;
            const nextCaret = e.target.selectionStart ?? nextVal.length;
            applyComposerTextUpdate(nextVal);
            if (!isComposingRef.current) {
              syncActiveMention(nextVal, nextCaret);
            } else {
              caretPosRef.current = nextCaret;
            }
            setDismissedMentionKey((prev) => (prev === null ? prev : null));
          }}
          onClick={(e) => {
            if (isComposingRef.current) return;
            const nextVal = e.currentTarget.value;
            const nextCaret = e.currentTarget.selectionStart ?? nextVal.length;
            caretPosRef.current = nextCaret;
            if (!nextVal.includes("@") && activeMentionRef.current === null) return;
            syncActiveMention(nextVal, nextCaret);
          }}
          onSelect={(e) => {
            if (pendingCaretRef.current !== null || isComposingRef.current) return;
            const nextVal = e.currentTarget.value;
            const nextCaret = e.currentTarget.selectionStart ?? nextVal.length;
            caretPosRef.current = nextCaret;
            if (!nextVal.includes("@") && activeMentionRef.current === null) return;
            syncActiveMention(nextVal, nextCaret);
          }}
          onCompositionStart={() => {
            isComposingRef.current = true;
          }}
          onCompositionEnd={(e) => {
            isComposingRef.current = false;
            const nextVal = e.currentTarget.value;
            const nextCaret = e.currentTarget.selectionStart ?? nextVal.length;
            syncActiveMention(nextVal, nextCaret);
          }}
          onKeyUp={(e) => {
            if (
              pendingCaretRef.current !== null ||
              isComposingRef.current ||
              (showMentionPopover &&
                (e.key === "ArrowUp" ||
                  e.key === "ArrowDown" ||
                  e.key === "Enter" ||
                  e.key === "Tab" ||
                  e.key === "Escape"))
            ) {
              return;
            }
            const nextVal = e.currentTarget.value;
            const nextCaret = e.currentTarget.selectionStart ?? nextVal.length;
            caretPosRef.current = nextCaret;
            if (!nextVal.includes("@") && activeMentionRef.current === null) return;
            syncActiveMention(nextVal, nextCaret);
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
          placeholder={t(locale, "chat.composerPlaceholder")}
          rows={1}
          className="w-full resize-none bg-transparent px-3.5 pt-3 pb-1.5 text-[14px] leading-relaxed outline-none placeholder:text-zinc-400 dark:placeholder:text-zinc-500 select-text"
        />

        <div
          data-testid="composer-toolbar"
          className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 px-2.5 pb-2 pt-0.5"
        >
          <div className="flex flex-wrap items-center gap-0.5 min-w-0">
            <button
              type="button"
              data-testid="composer-attach-image-btn"
              onClick={onPickLocalImages}
              title={t(locale, "chat.attachImage")}
              aria-label={t(locale, "chat.attachImage")}
              className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
            >
              <Paperclip className="w-4 h-4" />
            </button>

            {isBrowserTabActive && (
              <>
                <button
                  type="button"
                  data-testid="composer-screenshot-btn"
                  onClick={onCaptureScreenshot}
                  title={t(locale, "chat.screenshotTitle")}
                  aria-label={t(locale, "chat.screenshotTitle")}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11.5px] text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  <Camera className="w-3.5 h-3.5 shrink-0" />
                  <span className="hidden @[480px]:inline">
                    {t(locale, "chat.screenshotBtn")}
                  </span>
                </button>

                <button
                  type="button"
                  data-testid="composer-element-picker-btn"
                  onClick={onToggleElementPicker}
                  title={t(locale, "chat.elementPickerTitle")}
                  aria-label={t(locale, "chat.elementPickerTitle")}
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11.5px] transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    isPickingElement
                      ? "bg-indigo-500 text-white"
                      : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800"
                  }`}
                >
                  <Crosshair className="w-3.5 h-3.5 shrink-0" />
                  <span className="hidden @[480px]:inline">
                    {t(locale, "chat.elementPickerBtn")}
                  </span>
                </button>

                <button
                  type="button"
                  data-testid="composer-attach-url-btn"
                  onClick={onAttachCurrentUrl}
                  title={t(locale, "chat.attachUrlTitle")}
                  aria-label={t(locale, "chat.attachUrlTitle")}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11.5px] text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  <Link2 className="w-3.5 h-3.5 shrink-0" />
                  <span className="hidden @[480px]:inline">URL</span>
                </button>

                {browserErrorCount > 0 && (
                  <button
                    type="button"
                    data-testid="composer-attach-errors-btn"
                    onClick={onAttachConsoleErrors}
                    title={t(locale, "chat.attachErrorsTitle")}
                    aria-label={t(locale, "chat.attachErrorsTitle")}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11.5px] font-medium bg-rose-500/15 text-rose-600 dark:text-rose-400 hover:bg-rose-500/25 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                    <span>
                      {t(locale, "chat.errorsCountBtn", { count: browserErrorCount })}
                    </span>
                  </button>
                )}
              </>
            )}
          </div>

          <div className="flex items-center gap-1.5 shrink-0 ml-auto">
            {onToggleVoiceAutoSend && (
              <button
                type="button"
                data-testid="composer-voice-autosend-btn"
                aria-pressed={voiceAutoSend}
                onClick={onToggleVoiceAutoSend}
                title={
                  voiceAutoSend
                    ? t(locale, "voice.autoSendOnTitle")
                    : t(locale, "voice.autoSendOffTitle")
                }
                className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  voiceAutoSend
                    ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30"
                    : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 border border-transparent"
                }`}
              >
                <span>{t(locale, "voice.autoSendShort")}</span>
              </button>
            )}

            <button
              type="button"
              data-testid="composer-voice-mic-btn"
              aria-pressed={isListening}
              onClick={toggleVoiceInput}
              title={
                isListening
                  ? t(locale, "voice.micStopTitle", { locale: speechLocale })
                  : t(locale, "voice.micStartTitle", { locale: speechLocale })
              }
              aria-label={
                isListening
                  ? t(locale, "voice.micStopAria")
                  : t(locale, "voice.micStartAria")
              }
              className={`relative w-8 h-8 rounded-full flex items-center justify-center transition-all cursor-pointer shrink-0 ${
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
              title={t(locale, "chat.sendTitle")}
              className={`w-8 h-8 rounded-full flex items-center justify-center transition-all shrink-0 ${
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
  );
});
