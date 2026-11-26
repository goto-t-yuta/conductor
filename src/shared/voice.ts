import type { PreferredLanguage } from "./language.js";

export const DEFAULT_VOICE_READBACK_ENABLED = false;
export const DEFAULT_VOICE_AUTO_SEND = false;
export const DEFAULT_SPEECH_MAX_LENGTH_JA = 240;
export const DEFAULT_SPEECH_MAX_LENGTH_EN = 320;

export interface VoiceSpeakRequest {
  text: string;
  language?: "ja" | "en";
}

export interface VoiceSpeakResult {
  ok: boolean;
  usedNativeSay?: boolean;
  fallbackToWebSpeech?: boolean;
  stopped?: boolean;
  error?: string;
}

export interface VoiceMicPermissionResult {
  granted: boolean;
  status: string;
  platform: string;
}

export interface FormatTextForSpeechOptions {
  maxLength?: number;
  language?: PreferredLanguage;
}

export interface VoiceTaskSummary {
  id: string;
  taskNumber: number;
  title: string;
  status?: string;
}

export interface VoiceMessageSummary {
  id: string;
  role: "user" | "assistant" | "taskEvent" | "system";
  text: string;
  isStreaming: boolean;
  relatedTaskId?: string;
}

const JAPANESE_CHAR_RE = /[\u3040-\u30ff\u3400-\u9fff]/;

export function hasJapaneseCharacters(text: string): boolean {
  return JAPANESE_CHAR_RE.test(text);
}

/**
 * Resolves the BCP-47 speech recognition locale synced with Conductor's language preference.
 */
export function resolveSpeechLocale(
  preferredLanguage: PreferredLanguage,
  browserLanguage?: string,
): string {
  if (preferredLanguage === "ja") return "ja-JP";
  if (preferredLanguage === "en") return "en-US";
  const normalized = (browserLanguage ?? "").trim().toLowerCase();
  if (normalized.startsWith("en")) return "en-US";
  if (normalized.startsWith("ja")) return "ja-JP";
  return browserLanguage?.trim() || "ja-JP";
}

/**
 * Resolves the spoken TTS language ("ja" | "en") for a given utterance.
 */
export function resolveTtsLanguage(
  preferredLanguage: PreferredLanguage,
  text: string,
): "ja" | "en" {
  if (preferredLanguage === "ja") return "ja";
  if (preferredLanguage === "en") return "en";
  return hasJapaneseCharacters(text) ? "ja" : "en";
}

/**
 * Appends a newly recognized speech chunk to existing composer text with smart spacing.
 */
export function appendVoiceTranscript(currentText: string, addition: string): string {
  const cleanAddition = addition.trim();
  if (!cleanAddition) return currentText;
  if (!currentText) return cleanAddition;

  if (/\s$/.test(currentText)) {
    return `${currentText}${cleanAddition}`;
  }

  const lastChar = currentText.slice(-1);
  const firstChar = cleanAddition.slice(0, 1);
  const bothCjkOrJpPunct =
    /[\u3000-\u30ff\u3400-\u9fff\uff00-\uffef]/.test(lastChar) &&
    /[\u3000-\u30ff\u3400-\u9fff\uff00-\uffef]/.test(firstChar);

  if (bothCjkOrJpPunct) {
    return `${currentText}${cleanAddition}`;
  }

  return `${currentText} ${cleanAddition}`;
}

/**
 * Returns a friendly, actionable error/hint message for Web Speech API failures in Electron.
 */
export function formatSpeechRecognitionError(
  errorCode: string,
  language: PreferredLanguage = "ja",
): string {
  const isEn = language === "en";
  switch (errorCode) {
    case "unsupported":
      return isEn
        ? "Web Speech API is unavailable in this environment. You can still use macOS Dictation (press Fn twice) directly in the chat box."
        : "この環境では Web Speech API による音声認識を利用できません。macOS 標準の音声入力（入力欄で Fn キーを2回押す）をそのままお使いいただけます。";
    case "not-allowed":
    case "permission-denied":
    case "audio-capture":
      return isEn
        ? "Microphone access was denied or no microphone was found. Enable Microphone permission for Conductor in System Settings > Privacy & Security > Microphone (or use macOS Dictation: Fn×2)."
        : "マイクへのアクセスが許可されていないか、マイクを検出できません。システム設定 > プライバシーとセキュリティ > マイク で Conductor を許可してください（macOS 音声入力 Fn×2 も利用可能です）。";
    case "network":
    case "service-not-allowed":
      return isEn
        ? "Electron's built-in speech recognition could not connect to the recognition service. As an instant zero-cost fallback, focus the composer and press Fn twice (macOS Dictation)."
        : "Electron 内蔵の音声認識サービスに接続できませんでした。入力欄にフォーカスして macOS 音声入力（Fn キーを2回押す）を使うとすぐに音声入力できます。";
    case "no-speech":
      return isEn
        ? "No speech was detected. Please try speaking again."
        : "音声が検出されませんでした。もう一度マイクボタンを押して話してください。";
    case "aborted":
      return "";
    default:
      return isEn
        ? `Voice input error (${errorCode}). You can also use macOS Dictation (Fn×2) directly in the composer.`
        : `音声入力でエラーが発生しました（${errorCode}）。macOS 標準の音声入力（Fn×2）もご利用いただけます。`;
  }
}

const URL_RE = /(?:https?|wss?|file|ftp):\/\/[^\s<>()[\]"'`]+/gi;
const WWW_URL_RE = /\bwww\.[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:\/[^\s<>()[\]"'`]*)?/gi;
const WINDOWS_PATH_RE = /\b[A-Za-z]:\\[^\s<>()[\]"'`]+/g;
const HOME_OR_REL_PATH_RE = /(?:^|(?<=[\s(\[「（:：]))(?:~|\.{1,2})\/[^\s<>()[\]"'`]+/g;
const ABS_POSIX_PATH_RE =
  /(?:^|(?<=[\s(\[「（:：]))\/(?:[A-Za-z0-9._@+-]+\/)+[A-Za-z0-9._@+-]*(?::\d+(?::\d+)?)?(?:#L\d+(?:-L?\d+)?)?/g;
const REL_FILE_PATH_RE =
  /(?:^|(?<=[\s(\[「（:：]))(?:[A-Za-z0-9._@-]+\/)+[A-Za-z0-9._@-]+\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?(?:#L\d+(?:-L?\d+)?)?/g;

function looksLikeUrlOrFilePath(value: string): boolean {
  const s = value.trim();
  if (!s) return false;
  if (/^(?:https?|wss?|file|ftp):\/\//i.test(s) || /^www\./i.test(s)) return true;
  if (/^[A-Za-z]:\\/.test(s)) return true;
  if (/^(?:\/|~\/|\.\.?\/)/.test(s) && s.length > 2) return true;
  if (/^(?:[A-Za-z0-9._@-]+\/)+[A-Za-z0-9._@-]+\.[A-Za-z0-9]{1,8}(?::\d+)?(?:#L\d+(?:-L?\d+)?)?$/.test(s)) {
    return true;
  }
  return false;
}

function stripPathsAndUrls(input: string): string {
  return input
    .replace(URL_RE, " ")
    .replace(WWW_URL_RE, " ")
    .replace(WINDOWS_PATH_RE, " ")
    .replace(HOME_OR_REL_PATH_RE, " ")
    .replace(ABS_POSIX_PATH_RE, " ")
    .replace(REL_FILE_PATH_RE, " ");
}

function truncateCleanly(text: string, maxLength: number, isJapanese: boolean): string {
  if (text.length <= maxLength) return text;
  const slice = text.slice(0, maxLength);
  const minBoundary = Math.floor(maxLength * 0.4);

  // Prefer cutting at a natural sentence boundary
  let bestSentenceEnd = -1;
  const sentenceEndRe = /(?:[。！？]|[.!?](?=\s|$))/g;
  let match: RegExpExecArray | null;
  while ((match = sentenceEndRe.exec(slice)) !== null) {
    bestSentenceEnd = match.index + 1;
  }
  if (bestSentenceEnd >= minBoundary) {
    return slice.slice(0, bestSentenceEnd).trim();
  }

  // Fallback to a clause/word boundary
  const targetLen = Math.max(1, maxLength - 1);
  let cut = text.slice(0, targetLen);
  if (!isJapanese) {
    const lastSpace = cut.lastIndexOf(" ");
    if (lastSpace >= minBoundary) {
      cut = cut.slice(0, lastSpace);
    }
  } else {
    const lastPause = Math.max(cut.lastIndexOf("、"), cut.lastIndexOf(" "));
    if (lastPause >= minBoundary) {
      cut = cut.slice(0, lastPause);
    }
  }

  cut = cut.replace(/[\s、,・:：\-—]+$/, "").trim();
  return cut ? `${cut}…` : text.slice(0, targetLen).trim() + "…";
}

/**
 * Converts Markdown-formatted assistant replies into concise, natural plain text
 * suitable for OS-standard TTS readback.
 */
export function formatTextForSpeech(
  rawText: string,
  options: FormatTextForSpeechOptions = {},
): string {
  if (!rawText || !rawText.trim()) return "";

  let text = rawText.replace(/\r\n?/g, "\n");

  // 1. Strip fenced code blocks (```...``` and ~~~...~~~), including unclosed trailing fences
  text = text.replace(/```[\s\S]*?(?:```|$)/g, "\n");
  text = text.replace(/~~~[\s\S]*?(?:~~~|$)/g, "\n");

  // 2. Strip Markdown images ![alt](url)
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");

  // 3. Replace Markdown links [label](target) with readable label (unless label is a URL/path)
  text = text.replace(/\[([^\]]+)\]\(([^)]*)\)/g, (_full, label: string) => {
    const cleanLabel = label.trim();
    if (!cleanLabel || looksLikeUrlOrFilePath(cleanLabel)) {
      return " ";
    }
    return cleanLabel;
  });

  // 4. Handle inline code `...` — strip paths/URLs/long shell invocations, unwrap short readable terms
  text = text.replace(/`([^`\n]+)`/g, (_full, inner: string) => {
    const trimmed = inner.trim();
    if (!trimmed) return " ";
    if (looksLikeUrlOrFilePath(trimmed)) return " ";
    if (/[\\/]/.test(trimmed) && trimmed.includes(".")) return " ";
    if (trimmed.length > 48 && /[\s&|;=]/.test(trimmed)) return " ";
    return trimmed;
  });

  // 5. Strip HTML tags
  text = text.replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[^>]*)?>/g, " ");

  // 6. Strip bare URLs and file paths
  text = stripPathsAndUrls(text);

  // 7. Process line-by-line Markdown structures (headings, lists, tables, blockquotes, HRs)
  const rawLines = text.split("\n");
  const cleanedLines: string[] = [];

  for (const rawLine of rawLines) {
    let line = rawLine.trim();
    if (!line) continue;

    // Skip horizontal rules and Markdown table separator rows
    if (/^[-*_]{3,}$/.test(line)) continue;
    if (/^\|?[\s:-]+(?:\|[\s:-]+)+\|?$/.test(line)) continue;

    // Strip blockquote and heading markers
    line = line.replace(/^(?:>\s*)+/, "");
    line = line.replace(/^#{1,6}\s+/, "");

    // Strip task checkboxes and list markers
    line = line.replace(/^[-*+]\s+\[[ xX]\]\s+/, "");
    line = line.replace(/^[-*+]\s+/, "");
    line = line.replace(/^\d+[.)]\s+/, "");

    // Flatten Markdown table rows
    if (line.includes("|")) {
      const cells = line
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean);
      line = cells.join("、");
    }

    // Strip emphasis/strikethrough markers while keeping readable text
    line = line.replace(/\*\*([^*]+)\*\*/g, "$1");
    line = line.replace(/__([^_]+)__/g, "$1");
    line = line.replace(/~~([^~]+)~~/g, "$1");
    line = line.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, "$1");
    line = line.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "$1");

    // Clean decorative status emojis & empty delimiters left after path/URL removal
    line = line.replace(/[✅⚠️❌ℹ️🔹🔸📌📎✨🚀🎉]/gu, " ");
    line = line.replace(/\(\s*\)/g, " ");
    line = line.replace(/\[\s*\]/g, " ");
    line = line.replace(/（\s*）/g, " ");
    line = line.replace(/「\s*」/g, " ");
    line = line.replace(/\s+/g, " ").trim();

    if (line) {
      cleanedLines.push(line);
    }
  }

  if (cleanedLines.length === 0) return "";

  const combinedSample = cleanedLines.join(" ");
  const isJapanese =
    options.language === "ja"
      ? true
      : options.language === "en"
        ? false
        : hasJapaneseCharacters(combinedSample);

  const sentenceSep = isJapanese ? "。" : ". ";
  let joined = "";
  for (const line of cleanedLines) {
    if (!joined) {
      joined = line;
    } else if (/[。！？.!?、,:：]$/.test(joined)) {
      joined = isJapanese ? `${joined}${line}` : `${joined} ${line}`;
    } else {
      joined = `${joined}${sentenceSep}${line}`;
    }
  }

  // Collapse repeated punctuation / whitespace
  joined = joined
    .replace(/。{2,}/g, "。")
    .replace(/\.{2,}/g, ".")
    .replace(/\s+([。！？、.,!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  const maxLength =
    options.maxLength ?? (isJapanese ? DEFAULT_SPEECH_MAX_LENGTH_JA : DEFAULT_SPEECH_MAX_LENGTH_EN);

  return truncateCleanly(joined, maxLength, isJapanese);
}

const TASK_EVENT_HEADER_CODE_RE = /\[T(\d+)(?:\s*[·•|/:-]\s*[^\]]+)?\]/i;
const TASK_EVENT_TITLE_RE = /\*\*\[[^\]]+\]\s*([^*]+?)\*\*/;

/**
 * Formats a concise spoken notification for a `taskEvent` message
 * (e.g. `T48 が完了しました` or `T48 completed.`).
 * Returns `null` for non-terminal/informational task events such as startup auto-resume notices.
 */
export function formatTaskEventForSpeech(
  message: Pick<VoiceMessageSummary, "text" | "relatedTaskId">,
  tasks: readonly VoiceTaskSummary[] = [],
  preferredLanguage: PreferredLanguage = "ja",
): string | null {
  const firstLine = message.text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!firstLine) return null;

  // Determine event outcome from header text and/or linked task
  const isAutoResumeStart = /再起動後に自動再開しました|auto-resumed after restart/i.test(firstLine);
  if (isAutoResumeStart) return null;

  const matchedTask = message.relatedTaskId
    ? tasks.find((t) => t.id === message.relatedTaskId)
    : undefined;

  const codeMatch = firstLine.match(TASK_EVENT_HEADER_CODE_RE);
  const taskNumber = matchedTask?.taskNumber ?? (codeMatch ? Number.parseInt(codeMatch[1]!, 10) : null);
  const taskCode = taskNumber && Number.isInteger(taskNumber) ? `T${taskNumber}` : null;

  const isFailed =
    /失敗|failed|エラー|コンフリクト/i.test(firstLine) || matchedTask?.status === "failed";
  const isCompleted =
    !isFailed &&
    (/完了|completed|done/i.test(firstLine) ||
      matchedTask?.status === "done" ||
      matchedTask?.status === "needs_review");

  if (!isCompleted && !isFailed) {
    return null;
  }

  const titleMatch = firstLine.match(TASK_EVENT_TITLE_RE);
  const rawTitle = matchedTask?.title ?? titleMatch?.[1]?.trim() ?? "";
  const cleanTitle = rawTitle
    ? formatTextForSpeech(rawTitle, { maxLength: 60, language: preferredLanguage }).replace(
        /[。.]$/,
        "",
      )
    : "";

  const ttsLang = resolveTtsLanguage(preferredLanguage, `${firstLine} ${cleanTitle}`);

  if (ttsLang === "en") {
    const subject = taskCode ?? "Task";
    const statusPhrase = isFailed ? `${subject} failed.` : `${subject} completed.`;
    return cleanTitle ? `${statusPhrase} ${cleanTitle}.` : statusPhrase;
  }

  const subject = taskCode ?? "タスク";
  const statusPhrase = isFailed ? `${subject} が失敗しました` : `${subject} が完了しました`;
  return cleanTitle ? `${statusPhrase}。${cleanTitle}` : statusPhrase;
}

export interface VoiceReadbackTrackerState {
  sessionId: string | null;
  seenIds: Set<string>;
  streamingIds: Set<string>;
  initialized: boolean;
}

export function createInitialVoiceReadbackTracker(): VoiceReadbackTrackerState {
  return {
    sessionId: null,
    seenIds: new Set<string>(),
    streamingIds: new Set<string>(),
    initialized: false,
  };
}

/**
 * Pure state-transition helper that collects utterances for newly completed assistant
 * messages and newly arrived completion/failure `taskEvent` messages, while never reading
 * historical messages on initial load or session switch.
 */
export function collectVoiceReadbackUtterances(
  prev: VoiceReadbackTrackerState,
  input: {
    sessionId: string;
    messages: readonly VoiceMessageSummary[];
    tasks: readonly VoiceTaskSummary[];
    preferredLanguage: PreferredLanguage;
    readbackEnabled: boolean;
  },
): {
  nextState: VoiceReadbackTrackerState;
  utterances: Array<{ text: string; language: "ja" | "en" }>;
} {
  const nextSeen = new Set<string>();
  const nextStreaming = new Set<string>();
  for (const msg of input.messages) {
    nextSeen.add(msg.id);
    if (msg.isStreaming) {
      nextStreaming.add(msg.id);
    }
  }

  const nextState: VoiceReadbackTrackerState = {
    sessionId: input.sessionId,
    seenIds: nextSeen,
    streamingIds: nextStreaming,
    initialized: true,
  };

  // Never speak historical messages on initial load or when switching chat sessions
  if (!prev.initialized || prev.sessionId !== input.sessionId || !input.readbackEnabled) {
    return { nextState, utterances: [] };
  }

  const utterances: Array<{ text: string; language: "ja" | "en" }> = [];

  for (const msg of input.messages) {
    if (msg.role === "assistant") {
      const finishedStreaming = prev.streamingIds.has(msg.id) && !msg.isStreaming;
      const newCompleted = !prev.seenIds.has(msg.id) && !msg.isStreaming;
      if (finishedStreaming || newCompleted) {
        const spoken = formatTextForSpeech(msg.text, { language: input.preferredLanguage });
        if (spoken) {
          utterances.push({
            text: spoken,
            language: resolveTtsLanguage(input.preferredLanguage, spoken),
          });
        }
      }
    } else if (msg.role === "taskEvent") {
      if (!prev.seenIds.has(msg.id)) {
        const notice = formatTaskEventForSpeech(msg, input.tasks, input.preferredLanguage);
        if (notice) {
          utterances.push({
            text: notice,
            language: resolveTtsLanguage(input.preferredLanguage, notice),
          });
        }
      }
    }
  }

  return { nextState, utterances };
}
