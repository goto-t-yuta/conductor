import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { formatTaskCode } from "../shared/mentions.js";
import type { AgentProvider, AgentTask, ChatMessage, Project } from "../shared/types.js";

export type LaneMode = "new" | "reused" | "rotated";
export type LaneRotationReason = "turn_limit" | "idle_timeout" | "size_limit";

export interface OrchestratorLaneState {
  lastSyncedMessageId?: string | null;
  lastProjectsHash?: string | null;
  turnCount?: number;
  lastUsedAt?: number;
  createdAt?: number;
  cumulativeChars?: number;
  lastContextTokens?: number;
}

export interface LaneRotationPolicy {
  /** Rotate idle lane once turnCount reaches this threshold (well before context compaction). */
  maxTurns: number;
  /** Rotate idle lane once idle duration exceeds this threshold in milliseconds. */
  maxIdleMs: number;
  /** Rotate idle lane once accumulated prompt + output characters reach this threshold. */
  maxEstimatedChars: number;
  /** Rotate idle lane if a single turn's reported context size reaches this token threshold. */
  maxContextTokens: number;
}

export const DEFAULT_LANE_ROTATION_POLICY: Readonly<LaneRotationPolicy> = {
  maxTurns: 15,
  maxIdleMs: 2 * 60 * 60 * 1000, // 2 hours
  maxEstimatedChars: 160_000,
  maxContextTokens: 100_000,
};

export const DEFAULT_INITIAL_TRANSCRIPT_LIMIT = 10;
export const DEFAULT_REBIND_TRANSCRIPT_LIMIT = 24;
export const DEFAULT_DELTA_TRANSCRIPT_LIMIT = 10;
export const DEFAULT_COMPACT_FINISHED_TASKS_LIMIT = 5;
export const DEFAULT_DISCOVERED_PROJECTS_LIMIT = 30;

export interface LaneRotationDecision {
  rotate: boolean;
  reason: LaneRotationReason | null;
}

export interface OrchestratorTurnMetric {
  timestamp: string;
  provider: AgentProvider;
  laneId: string;
  laneMode: LaneMode;
  rotationReason: LaneRotationReason | null;
  turnCount: number;
  injectedChars: number;
  injectedTranscriptCount: number;
  projectsInjected: boolean;
  tasksInjectedCount: number;
  ttftMs: number | null;
  totalMs: number;
  usedSearchChatHistory: boolean;
}

export interface SearchChatHistoryParams {
  query?: string;
  role?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
  order?: string;
  maxCharsPerMessage?: number;
}

export interface SearchChatHistoryItem {
  index: number;
  id: string;
  role: ChatMessage["role"];
  provider?: AgentProvider;
  created_at: string;
  text: string;
  truncated: boolean;
  related_task_id?: string;
  mentions?: string[];
}

export interface SearchChatHistoryResult {
  total_messages_in_chat: number;
  total_matches: number;
  returned_count: number;
  offset: number;
  limit: number;
  has_more: boolean;
  order: "asc" | "desc";
  messages: SearchChatHistoryItem[];
}

export function createInitialLaneState(now = Date.now()): {
  lastSyncedMessageId: null;
  lastProjectsHash: null;
  turnCount: 0;
  lastUsedAt: 0;
  createdAt: number;
  cumulativeChars: 0;
} {
  return {
    lastSyncedMessageId: null,
    lastProjectsHash: null,
    turnCount: 0,
    lastUsedAt: 0,
    createdAt: now,
    cumulativeChars: 0,
  };
}

export function resolveLaneRotationPolicy(
  overrides?: Partial<LaneRotationPolicy>,
): LaneRotationPolicy {
  return {
    maxTurns: overrides?.maxTurns ?? DEFAULT_LANE_ROTATION_POLICY.maxTurns,
    maxIdleMs: overrides?.maxIdleMs ?? DEFAULT_LANE_ROTATION_POLICY.maxIdleMs,
    maxEstimatedChars:
      overrides?.maxEstimatedChars ?? DEFAULT_LANE_ROTATION_POLICY.maxEstimatedChars,
    maxContextTokens:
      overrides?.maxContextTokens ?? DEFAULT_LANE_ROTATION_POLICY.maxContextTokens,
  };
}

export function computeProjectsHash(
  projects: readonly Project[],
  topLimit = DEFAULT_DISCOVERED_PROJECTS_LIMIT,
): string {
  const top = projects.slice(0, topLimit);
  const payload =
    `${projects.length}\n` +
    top.map((p) => `${p.name}\0${p.path}\0${p.gitBranch ?? ""}`).join("\n");
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

const ACTIVE_TASK_STATUSES = new Set<AgentTask["status"]>([
  "running",
  "needs_review",
  "queued",
]);

/**
 * Selects a compact task list for Orchestrator live context:
 * - All active tasks (`running`, `needs_review`, `queued`)
 * - Up to `maxFinished` (default 5) most recent `done` / `failed` tasks (by `updatedAt` desc)
 */
export function selectCompactTasksForPrompt(
  tasks: readonly AgentTask[],
  maxFinished = DEFAULT_COMPACT_FINISHED_TASKS_LIMIT,
): AgentTask[] {
  if (tasks.length === 0) return [];
  const active: AgentTask[] = [];
  const finished: Array<{ task: AgentTask; index: number; updatedMs: number }> = [];

  for (let i = 0; i < tasks.length; i += 1) {
    const task = tasks[i]!;
    if (ACTIVE_TASK_STATUSES.has(task.status)) {
      active.push(task);
    } else {
      const parsedMs = Date.parse(task.updatedAt || task.createdAt || "");
      finished.push({
        task,
        index: i,
        updatedMs: Number.isFinite(parsedMs) ? parsedMs : 0,
      });
    }
  }

  finished.sort((a, b) => b.updatedMs - a.updatedMs || a.index - b.index);
  const recentFinished = finished.slice(0, Math.max(0, maxFinished)).map((entry) => entry.task);
  return [...active, ...recentFinished];
}

export function formatConversationMessageLine(m: ChatMessage): string {
  const who =
    m.role === "user"
      ? "User"
      : m.role === "taskEvent"
        ? "TaskEvent"
        : m.isStreaming
          ? "Conductor (in-progress)"
          : "Conductor";
  const mentionPrefix =
    m.role === "user" && Array.isArray(m.mentions) && m.mentions.length > 0
      ? `[${m.mentions
          .map((ref) =>
            ref.kind === "task"
              ? `@${formatTaskCode(ref.taskNumber)}${ref.projectName ? `(${ref.projectName})` : ""}`
              : `@${ref.projectName}`,
          )
          .join(", ")}] `
      : "";
  const body = m.text.trim().slice(0, 360) || "(working...)";
  return `${who}: ${mentionPrefix}${body}`;
}

export function selectConversationWindowForTurn(args: {
  messages: readonly ChatMessage[];
  isContinuation: boolean;
  lastSyncedMessageId?: string | null;
  currentUserMessageId?: string | null;
  currentAssistantMessageId?: string | null;
  maxInitialMessages?: number;
  maxDeltaMessages?: number;
}): { text: string; count: number } {
  const maxInitial = args.maxInitialMessages ?? DEFAULT_INITIAL_TRANSCRIPT_LIMIT;
  const maxDelta = args.maxDeltaMessages ?? DEFAULT_DELTA_TRANSCRIPT_LIMIT;

  // Consider only messages strictly prior to the current turn's user message (when present)
  let endIndex = args.messages.length;
  if (args.currentUserMessageId) {
    const userIdx = args.messages.findIndex((m) => m.id === args.currentUserMessageId);
    if (userIdx !== -1) {
      endIndex = userIdx;
    }
  }

  let startIndex = 0;
  let limit = maxInitial;

  if (args.isContinuation && args.lastSyncedMessageId) {
    const syncedIdx = args.messages.findIndex((m) => m.id === args.lastSyncedMessageId);
    if (syncedIdx !== -1) {
      startIndex = syncedIdx + 1;
      limit = maxDelta;
    }
  }

  if (startIndex >= endIndex) {
    return { text: "", count: 0 };
  }

  const eligible = args.messages
    .slice(startIndex, endIndex)
    .filter(
      (m) =>
        (m.role === "user" || m.role === "assistant" || m.role === "taskEvent") &&
        m.id !== args.currentUserMessageId &&
        m.id !== args.currentAssistantMessageId,
    )
    .slice(-limit);

  if (eligible.length === 0) {
    return { text: "", count: 0 };
  }

  return {
    text: eligible.map(formatConversationMessageLine).join("\n"),
    count: eligible.length,
  };
}

export function evaluateLaneRotation(
  lane: OrchestratorLaneState,
  now: number,
  policy: LaneRotationPolicy = DEFAULT_LANE_ROTATION_POLICY,
): LaneRotationDecision {
  const turnCount = lane.turnCount ?? 0;
  if (turnCount >= policy.maxTurns) {
    return { rotate: true, reason: "turn_limit" };
  }

  const referenceTime =
    lane.lastUsedAt && lane.lastUsedAt > 0 ? lane.lastUsedAt : (lane.createdAt ?? 0);
  if (referenceTime > 0 && now - referenceTime >= policy.maxIdleMs) {
    return { rotate: true, reason: "idle_timeout" };
  }

  const cumulativeChars = lane.cumulativeChars ?? 0;
  const lastContextTokens = lane.lastContextTokens ?? 0;
  if (
    cumulativeChars >= policy.maxEstimatedChars ||
    (lastContextTokens > 0 && lastContextTokens >= policy.maxContextTokens)
  ) {
    return { rotate: true, reason: "size_limit" };
  }

  return { rotate: false, reason: null };
}

function compareLaneRecencyDesc(a: OrchestratorLaneState, b: OrchestratorLaneState): number {
  const aUsed = a.lastUsedAt ?? 0;
  const bUsed = b.lastUsedAt ?? 0;
  if (bUsed !== aUsed) return bUsed - aUsed;
  const aCreated = a.createdAt ?? 0;
  const bCreated = b.createdAt ?? 0;
  return bCreated - aCreated;
}

/**
 * Selects the Most Recently Used (MRU) idle lane by `lastUsedAt` descending.
 */
export function selectMruIdleLane<T extends OrchestratorLaneState>(
  idleLanes: readonly T[],
): T | null {
  if (idleLanes.length === 0) return null;
  let best = idleLanes[0]!;
  for (let i = 1; i < idleLanes.length; i += 1) {
    const candidate = idleLanes[i]!;
    if (compareLaneRecencyDesc(candidate, best) < 0) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Evaluates all idle lanes against the rotation policy, returns expired idle lanes to discard,
 * and picks the MRU eligible idle lane (if any).
 */
export function partitionIdleLanesForAcquire<T extends OrchestratorLaneState>(
  lanes: readonly T[],
  isIdle: (lane: T) => boolean,
  now: number,
  policy: LaneRotationPolicy = DEFAULT_LANE_ROTATION_POLICY,
): {
  selected: T | null;
  expired: T[];
  rotationReason: LaneRotationReason | null;
} {
  const expired: Array<{ lane: T; reason: LaneRotationReason }> = [];
  const eligible: T[] = [];

  for (const lane of lanes) {
    if (!isIdle(lane)) continue;
    const decision = evaluateLaneRotation(lane, now, policy);
    if (decision.rotate && decision.reason) {
      expired.push({ lane, reason: decision.reason });
    } else {
      eligible.push(lane);
    }
  }

  let rotationReason: LaneRotationReason | null = null;
  if (expired.length > 0) {
    expired.sort((a, b) => compareLaneRecencyDesc(a.lane, b.lane));
    rotationReason = expired[0]!.reason;
  }

  return {
    selected: selectMruIdleLane(eligible),
    expired: expired.map((entry) => entry.lane),
    rotationReason,
  };
}

/**
 * Keeps all busy lanes and up to `maxIdleLanes` most recently used idle lanes.
 */
export function trimIdleLanesByMru<T extends OrchestratorLaneState>(
  lanes: readonly T[],
  isIdle: (lane: T) => boolean,
  maxIdleLanes: number,
): { kept: T[]; evicted: T[] } {
  const idle = lanes.filter(isIdle);
  if (idle.length <= maxIdleLanes) {
    return { kept: [...lanes], evicted: [] };
  }

  const rankedIdle = [...idle].sort(compareLaneRecencyDesc);
  const keepIdleSet = new Set(rankedIdle.slice(0, Math.max(0, maxIdleLanes)));
  const kept: T[] = [];
  const evicted: T[] = [];

  for (const lane of lanes) {
    if (!isIdle(lane) || keepIdleSet.has(lane)) {
      kept.push(lane);
    } else {
      evicted.push(lane);
    }
  }
  return { kept, evicted };
}

function formatMentionLabels(m: ChatMessage): string[] {
  const refs = [
    ...(Array.isArray(m.mentions) ? m.mentions : []),
    ...(Array.isArray(m.inferredMentions) ? m.inferredMentions : []),
  ];
  const labels = new Set<string>();
  for (const ref of refs) {
    if (ref.kind === "task") {
      labels.add(
        `@${formatTaskCode(ref.taskNumber)}${ref.projectName ? `(${ref.projectName})` : ""}`,
      );
    } else if (ref.projectName) {
      labels.add(`@${ref.projectName}`);
    }
  }
  return [...labels];
}

export function searchChatHistoryMessages(
  messages: readonly ChatMessage[],
  params: SearchChatHistoryParams = {},
): SearchChatHistoryResult {
  const query = (params.query ?? "").trim().toLowerCase();
  const rawRole = (params.role ?? "all").trim();
  const validRoles = new Set<string>(["all", "user", "assistant", "taskEvent", "system"]);
  const roleFilter = validRoles.has(rawRole) ? rawRole : "all";

  const sinceMs = params.since ? Date.parse(params.since) : Number.NaN;
  const untilMs = params.until ? Date.parse(params.until) : Number.NaN;
  const hasSince = Number.isFinite(sinceMs);
  const hasUntil = Number.isFinite(untilMs);

  const rawLimit = typeof params.limit === "number" && Number.isFinite(params.limit) ? params.limit : 20;
  const limit = Math.max(1, Math.min(50, Math.floor(rawLimit)));

  const rawOffset = typeof params.offset === "number" && Number.isFinite(params.offset) ? params.offset : 0;
  const offset = Math.max(0, Math.floor(rawOffset));

  const order: "asc" | "desc" = params.order === "asc" ? "asc" : "desc";

  const rawMaxChars =
    typeof params.maxCharsPerMessage === "number" && Number.isFinite(params.maxCharsPerMessage)
      ? params.maxCharsPerMessage
      : 800;
  const maxChars = Math.max(100, Math.min(4000, Math.floor(rawMaxChars)));

  const indexed: Array<{ index: number; message: ChatMessage; mentionLabels: string[] }> = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i]!;
    // Skip empty in-flight placeholder assistant messages
    if (m.isStreaming && !m.text.trim()) continue;
    if (roleFilter !== "all" && m.role !== roleFilter) continue;

    if (hasSince || hasUntil) {
      const msgMs = Date.parse(m.createdAt || "");
      if (!Number.isFinite(msgMs)) continue;
      if (hasSince && msgMs < sinceMs) continue;
      if (hasUntil && msgMs > untilMs) continue;
    }

    const mentionLabels = formatMentionLabels(m);
    if (query) {
      const attachmentText = Array.isArray(m.attachments)
        ? m.attachments.map((a) => `${a.label} ${a.url ?? ""}`).join(" ")
        : "";
      const haystack = `${m.text}\n${mentionLabels.join(" ")}\n${attachmentText}`.toLowerCase();
      if (!haystack.includes(query)) continue;
    }

    indexed.push({ index: i, message: m, mentionLabels });
  }

  if (order === "desc") {
    indexed.reverse();
  }

  const totalMatches = indexed.length;
  const page = indexed.slice(offset, offset + limit);

  const items: SearchChatHistoryItem[] = page.map(({ index, message, mentionLabels }) => {
    const rawText = message.text.trim();
    const truncated = rawText.length > maxChars;
    const text = truncated ? `${rawText.slice(0, maxChars)}…` : rawText;
    return {
      index,
      id: message.id,
      role: message.role,
      ...(message.provider ? { provider: message.provider } : {}),
      created_at: message.createdAt,
      text,
      truncated,
      ...(message.relatedTaskId ? { related_task_id: message.relatedTaskId } : {}),
      ...(mentionLabels.length > 0 ? { mentions: mentionLabels } : {}),
    };
  });

  return {
    total_messages_in_chat: messages.length,
    total_matches: totalMatches,
    returned_count: items.length,
    offset,
    limit,
    has_more: offset + items.length < totalMatches,
    order,
    messages: items,
  };
}

export const DEFAULT_METRICS_LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB

/**
 * Lightweight asynchronous JSONL metrics logger with simple size-based rotation.
 * All writes are queued asynchronously and failures are swallowed so chat execution is never affected.
 */
export class OrchestratorMetricsLogger {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    filePath: string,
    options: { maxBytes?: number } = {},
  ) {
    this.filePath = filePath;
    this.maxBytes = Math.max(1024, options.maxBytes ?? DEFAULT_METRICS_LOG_MAX_BYTES);
  }

  public getFilePath(): string {
    return this.filePath;
  }

  public record(metric: OrchestratorTurnMetric): void {
    const line = `${JSON.stringify(metric)}\n`;
    this.writeChain = this.writeChain
      .then(() => this.appendLineSafe(line))
      .catch(() => {
        // Never allow logging failures to impact chat execution
      });
  }

  public flush(): Promise<void> {
    return this.writeChain;
  }

  private async appendLineSafe(line: string): Promise<void> {
    try {
      const dir = path.dirname(this.filePath);
      await fs.promises.mkdir(dir, { recursive: true });

      const lineBytes = Buffer.byteLength(line, "utf8");
      try {
        const stat = await fs.promises.stat(this.filePath);
        if (stat.size + lineBytes > this.maxBytes) {
          const backupPath = `${this.filePath}.1`;
          await fs.promises.rm(backupPath, { force: true }).catch(() => {});
          await fs.promises.rename(this.filePath, backupPath).catch(() => {});
        }
      } catch {
        // File does not exist yet
      }

      await fs.promises.appendFile(this.filePath, line, "utf8");
    } catch {
      // Best-effort telemetry only
    }
  }
}
