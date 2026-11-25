import type { AgentProvider, ChatMessage, ToolActivityChip } from "../../shared/types.js";

export type QuestionStatus = "streaming" | "completed" | "error" | "pending";

export interface QuestionItem {
  /** Stable identifier (userMessageId when present, otherwise replyMessageId) */
  id: string;
  userMessageId: string | null;
  replyMessageId: string | null;
  /** Message ID to scroll to when clicked (replyMessageId, falling back to userMessageId) */
  targetMessageId: string;
  questionSnippet: string;
  status: QuestionStatus;
  isUnread: boolean;
  provider?: AgentProvider;
  latestToolLabel: string | null;
  hasRunningTool: boolean;
  replyPreview: string | null;
  /** Compact progress/preview line shown below the question snippet */
  detailLine: string;
  createdAt: string;
  updatedAt: string;
  /** 1-based chronological sequence number */
  sequenceNumber: number;
}

export interface QuestionSummary {
  totalCount: number;
  activeCount: number;
  unreadCount: number;
}

export interface UnreadUpdateResult {
  nextStreamingIds: Set<string>;
  nextUnreadIds: Set<string>;
  newlyCompletedIds: string[];
}

export function truncateSnippet(text: string, maxLength = 120): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

export function stripMarkdownForPreview(text: string): string {
  const cleaned = text
    .replace(/```[^\n]*\n?/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned;
}

export function formatQuestionTime(isoTimestamp: string): string {
  const ms = Date.parse(isoTimestamp);
  if (Number.isNaN(ms)) return "";
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

const WORKER_ACTION_TOOL_NAME_PATTERN =
  /^(?:[a-z0-9_.:/-]*[:./_-])?(?:start_worker|send_to_worker|create_task|stop_worker)$/;

const WORKER_ACTION_LABELS = new Set([
  "ワーカーを起動",
  "ワーカーへ追加指示",
  "タスクを作成",
  "ワーカーを停止",
  "start worker",
  "send to worker",
  "create task",
  "stop worker",
]);

function matchesWorkerActionToolName(rawName: string): boolean {
  const normalized = rawName.trim().toLowerCase();
  if (!normalized) return false;
  return WORKER_ACTION_TOOL_NAME_PATTERN.test(normalized);
}

function normalizeChipLabel(label: string): string {
  return label
    .trim()
    .replace(/(?:…|\.\.\.)+$/, "")
    .trim()
    .toLowerCase();
}

export function isWorkerActionToolChip(chip: ToolActivityChip): boolean {
  if (chip.toolName && matchesWorkerActionToolName(chip.toolName)) {
    return true;
  }
  const normalizedLabel = normalizeChipLabel(chip.label);
  if (!normalizedLabel) return false;
  if (WORKER_ACTION_LABELS.has(normalizedLabel)) {
    return true;
  }
  return matchesWorkerActionToolName(normalizedLabel);
}

export function isWorkerDispatchReply(reply: ChatMessage): boolean {
  const workerChips = reply.toolChips.filter(isWorkerActionToolChip);
  if (workerChips.length === 0) return false;
  if (
    !reply.isStreaming &&
    workerChips.every((chip) => chip.isError) &&
    isAssistantReplyError(reply)
  ) {
    return false;
  }
  return true;
}

export function isAssistantReplyError(reply: ChatMessage): boolean {
  if (reply.isStreaming) return false;
  const trimmed = reply.text.trim();
  if (
    trimmed.startsWith("エラーが発生しました") ||
    trimmed.startsWith("エラー:") ||
    trimmed.startsWith("Error:") ||
    trimmed.includes("\n\nエラー:") ||
    trimmed.includes("\n\nError:")
  ) {
    return true;
  }
  if (reply.toolChips.length > 0 && reply.toolChips.every((chip) => chip.isError)) {
    return true;
  }
  if (reply.toolChips.some((chip) => chip.isError) && trimmed.length === 0) {
    return true;
  }
  return false;
}

export function getLatestToolActivity(
  toolChips: readonly ToolActivityChip[],
): { label: string; isRunning: boolean } | null {
  if (toolChips.length === 0) return null;
  for (let i = toolChips.length - 1; i >= 0; i -= 1) {
    const chip = toolChips[i];
    if (!chip.isCompleted) {
      return { label: chip.label, isRunning: true };
    }
  }
  const last = toolChips[toolChips.length - 1];
  return { label: last.label, isRunning: false };
}

function withEllipsis(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return "";
  if (trimmed.endsWith("…") || trimmed.endsWith("...")) return trimmed;
  return `${trimmed}…`;
}

function buildQuestionSnippet(userMsg: ChatMessage | null, replyMsg: ChatMessage | null): string {
  if (userMsg) {
    const textSnippet = truncateSnippet(userMsg.text, 140);
    if (textSnippet) return textSnippet;
    if (userMsg.attachments.length > 0) {
      const labels = userMsg.attachments.map((a) => a.label).join(", ");
      return truncateSnippet(`添付: ${labels}`, 140);
    }
  }
  if (replyMsg?.replyToSnippet) {
    const snippet = truncateSnippet(replyMsg.replyToSnippet, 140);
    if (snippet) return snippet;
  }
  return "(質問)";
}

function buildDetailLine(params: {
  status: QuestionStatus;
  latestTool: { label: string; isRunning: boolean } | null;
  replyPreview: string | null;
  hasReasoning: boolean;
  timeLabel: string;
}): string {
  const { status, latestTool, replyPreview, hasReasoning, timeLabel } = params;

  if (status === "streaming") {
    if (latestTool?.isRunning) {
      return withEllipsis(latestTool.label);
    }
    if (replyPreview) {
      return replyPreview;
    }
    if (latestTool) {
      return latestTool.label;
    }
    if (hasReasoning) {
      return "思考中…";
    }
    return "応答を準備中…";
  }

  if (status === "pending") {
    return "応答待機中…";
  }

  if (replyPreview) {
    return replyPreview;
  }

  if (latestTool) {
    return latestTool.label;
  }

  if (status === "error") {
    return "エラーで終了しました";
  }

  return timeLabel || "回答完了";
}

function sortTier(item: QuestionItem): number {
  if (item.status === "streaming") return 0;
  if (item.isUnread) return 1;
  return 2;
}

function parseTimestampMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

export function deriveQuestionItems(
  messages: readonly ChatMessage[],
  unreadReplyIds?: ReadonlySet<string>,
): QuestionItem[] {
  const assistantByReplyTo = new Map<string, ChatMessage>();
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.replyToMessageId) {
      assistantByReplyTo.set(msg.replyToMessageId, msg);
    }
  }

  const pairedAssistantIds = new Set<string>();
  const rawItems: QuestionItem[] = [];
  let seq = 0;

  const pushItem = (userMsg: ChatMessage | null, replyMsg: ChatMessage | null) => {
    if (replyMsg && isWorkerDispatchReply(replyMsg)) return;
    const id = userMsg?.id ?? replyMsg?.id;
    if (!id) return;
    seq += 1;

    const status: QuestionStatus = !replyMsg
      ? "pending"
      : replyMsg.isStreaming
        ? "streaming"
        : isAssistantReplyError(replyMsg)
          ? "error"
          : "completed";

    const isUnread =
      status !== "streaming" &&
      status !== "pending" &&
      replyMsg !== null &&
      Boolean(unreadReplyIds?.has(replyMsg.id));

    const latestTool = replyMsg ? getLatestToolActivity(replyMsg.toolChips) : null;
    const cleanedReply = replyMsg ? stripMarkdownForPreview(replyMsg.text) : "";
    const replyPreview = cleanedReply ? truncateSnippet(cleanedReply, 110) : null;
    const createdAt = userMsg?.createdAt ?? replyMsg?.createdAt ?? "";
    const updatedAt = replyMsg?.createdAt ?? userMsg?.createdAt ?? "";
    const timeLabel = formatQuestionTime(updatedAt);

    rawItems.push({
      id,
      userMessageId: userMsg?.id ?? replyMsg?.replyToMessageId ?? null,
      replyMessageId: replyMsg?.id ?? null,
      targetMessageId: replyMsg?.id ?? userMsg!.id,
      questionSnippet: buildQuestionSnippet(userMsg, replyMsg),
      status,
      isUnread,
      provider: replyMsg?.provider,
      latestToolLabel: latestTool?.label ?? null,
      hasRunningTool: Boolean(latestTool?.isRunning),
      replyPreview,
      detailLine: buildDetailLine({
        status,
        latestTool,
        replyPreview,
        hasReasoning: Boolean(replyMsg?.reasoningSummary?.trim()),
        timeLabel,
      }),
      createdAt,
      updatedAt,
      sequenceNumber: seq,
    });
  };

  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (msg.role !== "user") continue;

    let reply: ChatMessage | null = assistantByReplyTo.get(msg.id) ?? null;
    if (!reply) {
      for (let j = i + 1; j < messages.length; j += 1) {
        const candidate = messages[j];
        if (candidate.role === "user") break;
        if (
          candidate.role === "assistant" &&
          !candidate.replyToMessageId &&
          !pairedAssistantIds.has(candidate.id)
        ) {
          reply = candidate;
          break;
        }
      }
    }

    if (reply) {
      pairedAssistantIds.add(reply.id);
    }

    pushItem(msg, reply);
  }

  // Include orphan assistant replies that explicitly carry replyToMessageId or replyToSnippet
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    if (pairedAssistantIds.has(msg.id)) continue;
    if (!msg.replyToMessageId && !msg.replyToSnippet) continue;
    pairedAssistantIds.add(msg.id);
    pushItem(null, msg);
  }

  return rawItems.sort((a, b) => {
    const tierDiff = sortTier(a) - sortTier(b);
    if (tierDiff !== 0) return tierDiff;
    const timeDiff = parseTimestampMs(b.createdAt) - parseTimestampMs(a.createdAt);
    if (timeDiff !== 0) return timeDiff;
    return b.sequenceNumber - a.sequenceNumber;
  });
}

export function summarizeQuestions(items: readonly QuestionItem[]): QuestionSummary {
  let activeCount = 0;
  let unreadCount = 0;
  for (const item of items) {
    if (item.status === "streaming") activeCount += 1;
    if (item.isUnread) unreadCount += 1;
  }
  return {
    totalCount: items.length,
    activeCount,
    unreadCount,
  };
}

export function reconcileUnreadReplies(params: {
  messages: readonly ChatMessage[];
  prevStreamingIds: ReadonlySet<string>;
  prevUnreadIds: ReadonlySet<string>;
  isMessageVisible: (messageId: string) => boolean;
}): UnreadUpdateResult {
  const { messages, prevStreamingIds, prevUnreadIds, isMessageVisible } = params;
  const nextStreamingIds = new Set<string>();
  const nextUnreadIds = new Set<string>();
  const newlyCompletedIds: string[] = [];

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;

    if (msg.isStreaming) {
      nextStreamingIds.add(msg.id);
      continue;
    }

    if (isWorkerDispatchReply(msg)) continue;

    if (prevUnreadIds.has(msg.id)) {
      nextUnreadIds.add(msg.id);
    }

    if (prevStreamingIds.has(msg.id)) {
      newlyCompletedIds.push(msg.id);
      if (!isMessageVisible(msg.id)) {
        nextUnreadIds.add(msg.id);
      }
    }
  }

  return {
    nextStreamingIds,
    nextUnreadIds,
    newlyCompletedIds,
  };
}
