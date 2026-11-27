import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  MAX_CHAT_SESSIONS,
  MAX_MESSAGES_PER_SESSION,
  capChatSessionsPreservingActive,
  deriveChatSessionPreview,
  deriveChatSessionTitle,
  extractBackendSessionIdsFromMessages,
  normalizeChatSessions,
  sanitizeChatMessages,
} from "../shared/chat-sessions.js";
import { DEFAULT_PREFERRED_LANGUAGE, isValidPreferredLanguage } from "../shared/language.js";
import { normalizeTaskNumbers } from "../shared/mentions.js";
import type {
  AgentTask,
  ChatMessage,
  ChatSession,
  ChatSessionBackendIds,
  PersistedState,
  Project,
  UsageRecord,
} from "../shared/types.js";
import {
  DEFAULT_USAGE_BUDGETS,
  normalizeUsageBudgetSettings,
  normalizeUsageRecords,
} from "../shared/usage.js";
import { DEFAULT_VOICE_READBACK_ENABLED } from "../shared/voice.js";
import { defaultIsProcessAlive } from "./instance-lock.js";

const DEFAULT_REMOTE_ACCESS_PORT = 4789;
const STATE_LOCK_MAX_WAIT_MS = 800;
const STATE_LOCK_POLL_MS = 10;
const STATE_LOCK_STALE_MS = 10_000;

function generateRemoteAccessToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

function normalizeRemoteAccessPort(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (Number.isInteger(num) && num >= 1 && num <= 65535) {
    return num;
  }
  return DEFAULT_REMOTE_ACCESS_PORT;
}

function parseIsoMs(iso: string | undefined | null): number {
  if (!iso || typeof iso !== "string") return 0;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function readFileStatSig(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch {
    return null;
  }
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // fallback busy wait
    }
  }
}

const DEFAULT_STATE: PersistedState = {
  stateRevision: 0,
  projects: [],
  scanRoots: [],
  tasks: [],
  nextTaskNumber: 1,
  messages: [],
  chatSessions: [],
  activeChatSessionId: null,
  browserTabs: [],
  activeBrowserTabId: null,
  showTaskSidebar: true,
  showBrowserPane: true,
  chatModel: null,
  chatEffort: null,
  workerModel: null,
  workerEffort: null,
  defaultIntegrationMode: "feature-branch",
  autoLandOnComplete: true,
  preferredLanguage: DEFAULT_PREFERRED_LANGUAGE,
  voiceReadbackEnabled: DEFAULT_VOICE_READBACK_ENABLED,
  remoteAccessEnabled: false,
  remoteAccessPort: DEFAULT_REMOTE_ACCESS_PORT,
  remoteAccessToken: "",
  usageRecords: [],
  usageBudgets: DEFAULT_USAGE_BUDGETS,
};

export interface SaveStateResult {
  ok: boolean;
  state: PersistedState;
  revision: number;
  mergedExternalChanges: boolean;
  error?: string;
}

function pickPreferredTask(
  diskTask: AgentTask,
  incomingTask: AgentTask,
  preferDiskOnTie: boolean,
): AgentTask {
  const diskMs = parseIsoMs(diskTask.updatedAt) || parseIsoMs(diskTask.createdAt);
  const incomingMs = parseIsoMs(incomingTask.updatedAt) || parseIsoMs(incomingTask.createdAt);
  if (diskMs !== incomingMs) {
    return diskMs > incomingMs ? diskTask : incomingTask;
  }
  const diskActivities = Array.isArray(diskTask.activities) ? diskTask.activities.length : 0;
  const incomingActivities = Array.isArray(incomingTask.activities)
    ? incomingTask.activities.length
    : 0;
  if (diskActivities !== incomingActivities) {
    return diskActivities > incomingActivities ? diskTask : incomingTask;
  }
  const diskOutputLen = typeof diskTask.latestOutput === "string" ? diskTask.latestOutput.length : 0;
  const incomingOutputLen =
    typeof incomingTask.latestOutput === "string" ? incomingTask.latestOutput.length : 0;
  if (diskOutputLen !== incomingOutputLen) {
    return diskOutputLen > incomingOutputLen ? diskTask : incomingTask;
  }
  return preferDiskOnTie ? diskTask : incomingTask;
}

function mergeTasks(
  diskTasks: readonly AgentTask[],
  incomingTasks: readonly AgentTask[],
  diskNextTaskNumber: number | undefined,
  incomingNextTaskNumber: number | undefined,
  preferDiskOnTie: boolean,
): { tasks: AgentTask[]; nextTaskNumber: number } {
  const mergedById = new Map<string, AgentTask>();
  const orderedIds: string[] = [];

  for (const task of diskTasks) {
    if (!task?.id) continue;
    mergedById.set(task.id, task);
    orderedIds.push(task.id);
  }

  for (const task of incomingTasks) {
    if (!task?.id) continue;
    const existing = mergedById.get(task.id);
    if (!existing) {
      mergedById.set(task.id, task);
      orderedIds.unshift(task.id);
    } else {
      mergedById.set(task.id, pickPreferredTask(existing, task, preferDiskOnTie));
    }
  }

  // Keep tasks ordered newest-first by createdAt (matching controller prepend order)
  const mergedList = orderedIds
    .map((id) => mergedById.get(id)!)
    .sort((a, b) => {
      const timeDiff = parseIsoMs(b.createdAt) - parseIsoMs(a.createdAt);
      if (timeDiff !== 0) return timeDiff;
      return (b.taskNumber ?? 0) - (a.taskNumber ?? 0);
    });

  const maxCounter = Math.max(
    typeof diskNextTaskNumber === "number" ? diskNextTaskNumber : 1,
    typeof incomingNextTaskNumber === "number" ? incomingNextTaskNumber : 1,
  );
  const normalized = normalizeTaskNumbers(mergedList, maxCounter);
  return {
    tasks: normalized.tasks,
    nextTaskNumber: normalized.nextTaskNumber,
  };
}

function mergeProjects(
  diskProjects: readonly Project[],
  incomingProjects: readonly Project[],
  preferDiskOnTie: boolean,
): Project[] {
  const byId = new Map<string, Project>();
  const idByNormalizedPath = new Map<string, string>();

  const upsert = (proj: Project, isIncoming: boolean) => {
    if (!proj?.id) return;
    const normPath = proj.path ? path.resolve(proj.path) : "";
    const mappedId = (normPath && idByNormalizedPath.get(normPath)) || proj.id;
    const existing = byId.get(mappedId) ?? byId.get(proj.id);
    if (!existing) {
      byId.set(proj.id, proj);
      if (normPath) idByNormalizedPath.set(normPath, proj.id);
      return;
    }
    const existingMs = parseIsoMs(existing.lastActiveAt) || parseIsoMs(existing.addedAt);
    const candidateMs = parseIsoMs(proj.lastActiveAt) || parseIsoMs(proj.addedAt);
    const winner =
      candidateMs > existingMs
        ? proj
        : candidateMs < existingMs
          ? existing
          : isIncoming && !preferDiskOnTie
            ? proj
            : existing;
    byId.set(existing.id, { ...existing, ...winner, id: existing.id });
    if (normPath) idByNormalizedPath.set(normPath, existing.id);
  };

  for (const p of diskProjects) upsert(p, false);
  for (const p of incomingProjects) upsert(p, true);
  return [...byId.values()];
}

function mergeUniqueStrings(a: readonly string[], b: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of [...a, ...b]) {
    if (typeof item !== "string" || !item.trim()) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function pickPreferredChatMessage(
  diskMsg: ChatMessage,
  incomingMsg: ChatMessage,
  preferDiskOnTie: boolean,
): ChatMessage {
  if (diskMsg.isStreaming !== incomingMsg.isStreaming) {
    // Non-streaming finalized message always supersedes a streaming partial one
    return diskMsg.isStreaming ? incomingMsg : diskMsg;
  }
  const diskTextLen = typeof diskMsg.text === "string" ? diskMsg.text.length : 0;
  const incomingTextLen = typeof incomingMsg.text === "string" ? incomingMsg.text.length : 0;
  if (diskTextLen !== incomingTextLen) {
    return diskTextLen > incomingTextLen ? diskMsg : incomingMsg;
  }
  const diskExtras = (diskMsg.toolChips?.length ?? 0) + (diskMsg.attachments?.length ?? 0);
  const incomingExtras =
    (incomingMsg.toolChips?.length ?? 0) + (incomingMsg.attachments?.length ?? 0);
  if (diskExtras !== incomingExtras) {
    return diskExtras > incomingExtras ? diskMsg : incomingMsg;
  }
  return preferDiskOnTie ? diskMsg : incomingMsg;
}

function mergeChatMessageLists(
  diskMessages: readonly ChatMessage[],
  incomingMessages: readonly ChatMessage[],
  preferDiskOnTie: boolean,
): ChatMessage[] {
  const byId = new Map<string, { msg: ChatMessage; firstSeenOrder: number }>();
  let seq = 0;

  for (const msg of diskMessages) {
    if (!msg?.id) continue;
    byId.set(msg.id, { msg, firstSeenOrder: seq++ });
  }
  for (const msg of incomingMessages) {
    if (!msg?.id) continue;
    const existing = byId.get(msg.id);
    if (!existing) {
      byId.set(msg.id, { msg, firstSeenOrder: seq++ });
    } else {
      existing.msg = pickPreferredChatMessage(existing.msg, msg, preferDiskOnTie);
    }
  }

  const combined = [...byId.values()]
    .sort((a, b) => {
      const timeDiff = parseIsoMs(a.msg.createdAt) - parseIsoMs(b.msg.createdAt);
      if (timeDiff !== 0) return timeDiff;
      return a.firstSeenOrder - b.firstSeenOrder;
    })
    .map((entry) => entry.msg);

  return sanitizeChatMessages(combined).slice(-MAX_MESSAGES_PER_SESSION);
}

function mergeBackendSessionIds(
  diskIds: ChatSessionBackendIds | undefined,
  incomingIds: ChatSessionBackendIds | undefined,
  preferDisk: boolean,
): ChatSessionBackendIds {
  const primary = preferDisk ? diskIds : incomingIds;
  const secondary = preferDisk ? incomingIds : diskIds;
  const merged: ChatSessionBackendIds = {};
  for (const key of ["codex", "agy", "claude"] as const) {
    const val = primary?.[key] ?? secondary?.[key];
    if (val) {
      merged[key] = val;
    }
  }
  return merged;
}

function mergeChatSessionPair(
  diskSession: ChatSession,
  incomingSession: ChatSession,
  preferDiskOnTie: boolean,
): ChatSession {
  const diskUpdatedMs = parseIsoMs(diskSession.updatedAt) || parseIsoMs(diskSession.createdAt);
  const incomingUpdatedMs =
    parseIsoMs(incomingSession.updatedAt) || parseIsoMs(incomingSession.createdAt);
  const preferDisk =
    diskUpdatedMs > incomingUpdatedMs ||
    (diskUpdatedMs === incomingUpdatedMs && preferDiskOnTie);

  const mergedMessages = mergeChatMessageLists(
    diskSession.messages ?? [],
    incomingSession.messages ?? [],
    preferDisk,
  );
  const diskCreatedMs = parseIsoMs(diskSession.createdAt);
  const incomingCreatedMs = parseIsoMs(incomingSession.createdAt);
  const createdAt =
    diskCreatedMs && incomingCreatedMs
      ? diskCreatedMs <= incomingCreatedMs
        ? diskSession.createdAt
        : incomingSession.createdAt
      : diskSession.createdAt || incomingSession.createdAt;
  const updatedAt =
    diskUpdatedMs >= incomingUpdatedMs ? diskSession.updatedAt : incomingSession.updatedAt;

  const mergedBackend = extractBackendSessionIdsFromMessages(
    mergedMessages,
    mergeBackendSessionIds(
      diskSession.backendSessionIds,
      incomingSession.backendSessionIds,
      preferDisk,
    ),
  );

  return {
    id: diskSession.id,
    title: deriveChatSessionTitle(mergedMessages),
    preview: deriveChatSessionPreview(mergedMessages),
    messages: mergedMessages,
    createdAt,
    updatedAt,
    provider: preferDisk
      ? diskSession.provider ?? incomingSession.provider
      : incomingSession.provider ?? diskSession.provider,
    backendSessionIds: mergedBackend,
  };
}

function mergeUsageRecords(
  diskRecords: readonly UsageRecord[],
  incomingRecords: readonly UsageRecord[],
): UsageRecord[] {
  const byId = new Map<string, UsageRecord>();
  for (const r of diskRecords) {
    if (r?.id) byId.set(r.id, r);
  }
  for (const r of incomingRecords) {
    if (r?.id && !byId.has(r.id)) {
      byId.set(r.id, r);
    }
  }
  return normalizeUsageRecords([...byId.values()]);
}

/**
 * Non-destructively merges a newer/external on-disk `PersistedState` with an in-memory
 * `incoming` state so an older process can never roll back tasks, projects, chat sessions,
 * or messages created by another process.
 */
export function mergePersistedStates(
  disk: PersistedState,
  incoming: PersistedState,
  options?: { preferDiskScalars?: boolean },
): PersistedState {
  const preferDisk = options?.preferDiskScalars ?? true;

  const mergedTasks = mergeTasks(
    Array.isArray(disk.tasks) ? disk.tasks : [],
    Array.isArray(incoming.tasks) ? incoming.tasks : [],
    disk.nextTaskNumber,
    incoming.nextTaskNumber,
    preferDisk,
  );

  const mergedProjects = mergeProjects(
    Array.isArray(disk.projects) ? disk.projects : [],
    Array.isArray(incoming.projects) ? incoming.projects : [],
    preferDisk,
  );

  const mergedScanRoots = mergeUniqueStrings(
    Array.isArray(disk.scanRoots) ? disk.scanRoots : [],
    Array.isArray(incoming.scanRoots) ? incoming.scanRoots : [],
  );

  const diskChatsNorm = normalizeChatSessions({
    chatSessions: disk.chatSessions,
    activeChatSessionId: disk.activeChatSessionId,
    legacyMessages: disk.messages,
    chatProvider: disk.chatProvider,
  });
  const incomingChatsNorm = normalizeChatSessions({
    chatSessions: incoming.chatSessions,
    activeChatSessionId: incoming.activeChatSessionId,
    legacyMessages: incoming.messages,
    chatProvider: incoming.chatProvider,
  });

  const sessionsById = new Map<string, ChatSession>();
  for (const session of diskChatsNorm.chatSessions) {
    sessionsById.set(session.id, session);
  }
  for (const session of incomingChatsNorm.chatSessions) {
    const existing = sessionsById.get(session.id);
    if (!existing) {
      // Avoid keeping redundant empty draft sessions from a stale writer when disk already has sessions
      if (session.messages.length === 0 && sessionsById.size > 0 && preferDisk) {
        continue;
      }
      sessionsById.set(session.id, session);
    } else {
      sessionsById.set(session.id, mergeChatSessionPair(existing, session, preferDisk));
    }
  }

  const diskActive = sessionsById.get(diskChatsNorm.activeChatSessionId);
  const incomingActive = sessionsById.get(incomingChatsNorm.activeChatSessionId);

  let resolvedActiveId = diskChatsNorm.activeChatSessionId;
  if (incomingActive && diskActive) {
    const diskActiveMs = parseIsoMs(diskActive.updatedAt) || parseIsoMs(diskActive.createdAt);
    const incomingActiveMs =
      parseIsoMs(incomingActive.updatedAt) || parseIsoMs(incomingActive.createdAt);
    if (incomingActiveMs > diskActiveMs) {
      resolvedActiveId = incomingActive.id;
    } else if (diskActiveMs > incomingActiveMs) {
      resolvedActiveId = diskActive.id;
    } else {
      resolvedActiveId = preferDisk ? diskActive.id : incomingActive.id;
    }
  } else if (incomingActive && !diskActive) {
    resolvedActiveId = incomingActive.id;
  } else if (diskActive) {
    resolvedActiveId = diskActive.id;
  }

  const mergedChatSessions = capChatSessionsPreservingActive(
    [...sessionsById.values()],
    resolvedActiveId,
    MAX_CHAT_SESSIONS,
  );
  const activeSession =
    mergedChatSessions.find((s) => s.id === resolvedActiveId) ?? mergedChatSessions[0]!;

  const mergedUsage = mergeUsageRecords(
    Array.isArray(disk.usageRecords) ? disk.usageRecords : [],
    Array.isArray(incoming.usageRecords) ? incoming.usageRecords : [],
  );

  const scalarSource = preferDisk ? disk : incoming;
  const scalarFallback = preferDisk ? incoming : disk;

  const browserTabs =
    Array.isArray(scalarSource.browserTabs) && scalarSource.browserTabs.length > 0
      ? scalarSource.browserTabs
      : Array.isArray(scalarFallback.browserTabs)
        ? scalarFallback.browserTabs
        : [];
  const activeBrowserTabId =
    scalarSource.activeBrowserTabId ?? scalarFallback.activeBrowserTabId ?? null;

  return {
    ...DEFAULT_STATE,
    ...scalarFallback,
    ...scalarSource,
    projects: mergedProjects,
    scanRoots: mergedScanRoots,
    tasks: mergedTasks.tasks,
    nextTaskNumber: mergedTasks.nextTaskNumber,
    chatSessions: mergedChatSessions,
    activeChatSessionId: activeSession.id,
    messages: activeSession.messages,
    browserTabs,
    activeBrowserTabId,
    usageRecords: mergedUsage,
    usageBudgets: normalizeUsageBudgetSettings(
      scalarSource.usageBudgets ?? scalarFallback.usageBudgets,
    ),
    stateRevision: Math.max(
      typeof disk.stateRevision === "number" ? disk.stateRevision : 0,
      typeof incoming.stateRevision === "number" ? incoming.stateRevision : 0,
    ),
  };
}

export class StateStore {
  public readonly baseDir: string;
  public readonly stateFile: string;
  public readonly backupStateFile: string;
  public readonly lockFile: string;
  public readonly attachmentsDir: string;
  public readonly worktreesDir: string;
  public readonly writerId: string;

  private lastKnownRevision = 0;
  private lastKnownStatSig: string | null = null;
  private lastKnownContentHash: string | null = null;
  private hasSyncedWithDisk = false;

  constructor(baseDir: string, options?: { writerId?: string }) {
    this.baseDir = baseDir;
    this.stateFile = path.join(baseDir, "state.json");
    this.backupStateFile = path.join(baseDir, "state.json.bak");
    this.lockFile = path.join(baseDir, "state.json.lock");
    this.attachmentsDir = path.join(baseDir, "attachments");
    this.worktreesDir = path.join(baseDir, "worktrees");
    this.writerId =
      options?.writerId?.trim() || `pid-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    fs.mkdirSync(this.baseDir, { recursive: true });
    fs.mkdirSync(this.attachmentsDir, { recursive: true });
    fs.mkdirSync(this.worktreesDir, { recursive: true });
  }

  public getLastKnownRevision(): number {
    return this.lastKnownRevision;
  }

  private parseRawState(raw: string): {
    state: PersistedState;
    needsSave: boolean;
    contentHash: string;
  } {
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Persisted state root must be a JSON object");
    }
    const rawTasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    const normalized = normalizeTaskNumbers(rawTasks, parsed.nextTaskNumber);
    const normalizedChats = normalizeChatSessions({
      chatSessions: parsed.chatSessions,
      activeChatSessionId: parsed.activeChatSessionId,
      legacyMessages: parsed.messages,
      chatProvider: parsed.chatProvider,
    });
    const activeChat = normalizedChats.chatSessions.find(
      (s) => s.id === normalizedChats.activeChatSessionId,
    );
    const existingToken =
      typeof parsed.remoteAccessToken === "string" ? parsed.remoteAccessToken.trim() : "";
    const hasValidToken = existingToken.length >= 16;
    const remoteAccessToken = hasValidToken ? existingToken : generateRemoteAccessToken();
    const stateRevision =
      typeof parsed.stateRevision === "number" &&
      Number.isInteger(parsed.stateRevision) &&
      parsed.stateRevision >= 0
        ? parsed.stateRevision
        : 0;
    const state: PersistedState = {
      ...DEFAULT_STATE,
      ...parsed,
      stateRevision,
      ...(typeof parsed.stateUpdatedAt === "string" ? { stateUpdatedAt: parsed.stateUpdatedAt } : {}),
      ...(typeof parsed.stateWriterId === "string" ? { stateWriterId: parsed.stateWriterId } : {}),
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      scanRoots: Array.isArray(parsed.scanRoots) ? parsed.scanRoots : [],
      tasks: normalized.tasks,
      nextTaskNumber: normalized.nextTaskNumber,
      messages: activeChat ? activeChat.messages : [],
      chatSessions: normalizedChats.chatSessions,
      activeChatSessionId: normalizedChats.activeChatSessionId,
      browserTabs: Array.isArray(parsed.browserTabs) ? parsed.browserTabs : [],
      autoLandOnComplete:
        typeof parsed.autoLandOnComplete === "boolean" ? parsed.autoLandOnComplete : true,
      preferredLanguage: isValidPreferredLanguage(parsed.preferredLanguage)
        ? parsed.preferredLanguage
        : DEFAULT_PREFERRED_LANGUAGE,
      voiceReadbackEnabled:
        typeof parsed.voiceReadbackEnabled === "boolean"
          ? parsed.voiceReadbackEnabled
          : DEFAULT_VOICE_READBACK_ENABLED,
      remoteAccessEnabled:
        typeof parsed.remoteAccessEnabled === "boolean" ? parsed.remoteAccessEnabled : false,
      remoteAccessPort: normalizeRemoteAccessPort(parsed.remoteAccessPort),
      remoteAccessToken,
      usageRecords: normalizeUsageRecords(parsed.usageRecords),
      usageBudgets: normalizeUsageBudgetSettings(parsed.usageBudgets),
    };
    return {
      state,
      needsSave: normalized.changed || normalizedChats.changed || !hasValidToken,
      contentHash: sha256(raw),
    };
  }

  private parseStateFile(filePath: string): {
    state: PersistedState;
    needsSave: boolean;
    contentHash: string;
    statSig: string | null;
  } {
    const raw = fs.readFileSync(filePath, "utf8");
    const statSig = readFileStatSig(filePath);
    const parsed = this.parseRawState(raw);
    return {
      ...parsed,
      statSig,
    };
  }

  private recordKnownDiskState(
    revision: number,
    statSig: string | null,
    contentHash: string | null,
  ): void {
    this.lastKnownRevision = Math.max(0, revision);
    this.lastKnownStatSig = statSig;
    this.lastKnownContentHash = contentHash;
    this.hasSyncedWithDisk = true;
  }

  private withStateFileLock<T>(fn: () => T): T {
    const token = `${this.writerId}:${crypto.randomUUID().slice(0, 8)}`;
    const payload = JSON.stringify({
      pid: process.pid,
      token,
      createdAt: Date.now(),
    });
    const deadline = Date.now() + STATE_LOCK_MAX_WAIT_MS;
    let locked = false;

    while (Date.now() <= deadline) {
      try {
        const fd = fs.openSync(this.lockFile, "wx", 0o600);
        try {
          fs.writeFileSync(fd, payload, "utf8");
        } finally {
          fs.closeSync(fd);
        }
        locked = true;
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | null)?.code;
        if (code !== "EEXIST") {
          break;
        }
        // Check whether existing lock is stale (dead PID or expired)
        let shouldRemoveStale = false;
        try {
          const raw = fs.readFileSync(this.lockFile, "utf8");
          const parsed = JSON.parse(raw) as { pid?: number; createdAt?: number };
          const pidDead =
            typeof parsed.pid === "number" &&
            parsed.pid !== process.pid &&
            !defaultIsProcessAlive(parsed.pid);
          const expired =
            typeof parsed.createdAt === "number" &&
            Date.now() - parsed.createdAt > STATE_LOCK_STALE_MS;
          if (pidDead || expired) {
            shouldRemoveStale = true;
          }
        } catch {
          try {
            const stat = fs.statSync(this.lockFile);
            if (Date.now() - stat.mtimeMs > STATE_LOCK_STALE_MS) {
              shouldRemoveStale = true;
            }
          } catch {
            // Lock already disappeared
            continue;
          }
        }

        if (shouldRemoveStale) {
          try {
            fs.unlinkSync(this.lockFile);
          } catch {
            // ignore race
          }
          continue;
        }

        sleepSync(STATE_LOCK_POLL_MS);
      }
    }

    try {
      return fn();
    } finally {
      if (locked) {
        try {
          const raw = fs.readFileSync(this.lockFile, "utf8");
          if (raw.includes(token)) {
            fs.unlinkSync(this.lockFile);
          }
        } catch {
          // ignore cleanup error
        }
      }
    }
  }

  /**
   * Fast O(1) stat check indicating whether `state.json` on disk differs from
   * the version last loaded or written by this `StateStore` instance.
   */
  public hasExternalChange(): boolean {
    const currentSig = readFileStatSig(this.stateFile);
    if (!this.hasSyncedWithDisk) {
      return currentSig !== null;
    }
    return currentSig !== this.lastKnownStatSig;
  }

  /**
   * Reads `state.json` if and only if another writer modified it since our last
   * `load()` or `save()`. Returns `null` on the hot path when unchanged.
   */
  public loadIfExternallyChanged(): PersistedState | null {
    if (!this.hasExternalChange()) {
      return null;
    }
    if (!fs.existsSync(this.stateFile)) {
      return null;
    }
    try {
      const { state, contentHash, statSig } = this.parseStateFile(this.stateFile);
      if (this.hasSyncedWithDisk && contentHash === this.lastKnownContentHash) {
        this.lastKnownStatSig = statSig;
        return null;
      }
      this.recordKnownDiskState(state.stateRevision ?? 0, statSig, contentHash);
      return state;
    } catch {
      return null;
    }
  }

  load(): PersistedState {
    const primaryExists = fs.existsSync(this.stateFile);
    if (primaryExists) {
      try {
        const { state, needsSave, contentHash, statSig } = this.parseStateFile(this.stateFile);
        this.recordKnownDiskState(state.stateRevision ?? 0, statSig, contentHash);
        if (needsSave) {
          return this.save(state).state;
        }
        return state;
      } catch {
        // Preserve the unreadable state file before falling back to backup so user history is never silently lost
        try {
          const corruptPath = `${this.stateFile}.corrupt.${Date.now()}`;
          fs.copyFileSync(this.stateFile, corruptPath);
        } catch {
          // best-effort backup of corrupted file
        }
      }
    }

    if (fs.existsSync(this.backupStateFile)) {
      try {
        const { state } = this.parseStateFile(this.backupStateFile);
        this.recordKnownDiskState(state.stateRevision ?? 0, null, null);
        return this.save(state).state;
      } catch {
        // fall through to default state
      }
    }

    this.recordKnownDiskState(0, null, null);
    return {
      ...DEFAULT_STATE,
      remoteAccessToken: generateRemoteAccessToken(),
    };
  }

  save(state: PersistedState): SaveStateResult {
    return this.withStateFileLock(() => {
      let stateToWrite: PersistedState = state;
      let mergedExternalChanges = false;
      let baseRevision = this.lastKnownRevision;
      let diskHasValidPrimary = false;

      const currentDiskSig = readFileStatSig(this.stateFile);
      if (currentDiskSig !== null) {
        const statDiffers = !this.hasSyncedWithDisk || currentDiskSig !== this.lastKnownStatSig;
        if (statDiffers) {
          try {
            const diskParsed = this.parseStateFile(this.stateFile);
            diskHasValidPrimary = true;
            const diskRev = diskParsed.state.stateRevision ?? 0;
            const diskWriterId = diskParsed.state.stateWriterId;
            const contentChanged = diskParsed.contentHash !== this.lastKnownContentHash;
            const isExternal =
              contentChanged &&
              (!this.hasSyncedWithDisk ||
                diskWriterId !== this.writerId ||
                diskRev > this.lastKnownRevision);

            if (isExternal) {
              const diskUpdatedMs = parseIsoMs(diskParsed.state.stateUpdatedAt);
              const incomingUpdatedMs = parseIsoMs(state.stateUpdatedAt);
              const preferDiskScalars =
                diskRev > this.lastKnownRevision ||
                (diskWriterId !== undefined &&
                  diskWriterId !== this.writerId &&
                  diskUpdatedMs > incomingUpdatedMs);

              stateToWrite = mergePersistedStates(diskParsed.state, state, {
                preferDiskScalars,
              });
              mergedExternalChanges = true;
              baseRevision = Math.max(this.lastKnownRevision, diskRev);
            } else {
              baseRevision = Math.max(this.lastKnownRevision, diskRev);
            }
          } catch {
            // Existing state.json on disk is corrupted; do not overwrite state.json.bak with corrupted data
            diskHasValidPrimary = false;
          }
        } else {
          diskHasValidPrimary = true;
        }
      }

      const nextRevision =
        Math.max(
          baseRevision,
          typeof stateToWrite.stateRevision === "number" ? stateToWrite.stateRevision : 0,
        ) + 1;

      const finalState: PersistedState = {
        ...stateToWrite,
        stateRevision: nextRevision,
        stateUpdatedAt: new Date().toISOString(),
        stateWriterId: this.writerId,
      };

      const tmp = `${this.stateFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
      const serialized = JSON.stringify(finalState, null, 2);
      const contentHash = sha256(serialized);

      try {
        const fd = fs.openSync(tmp, "w", 0o600);
        try {
          fs.writeFileSync(fd, serialized, "utf8");
          try {
            fs.fsyncSync(fd);
          } catch {
            // best-effort fsync
          }
        } finally {
          fs.closeSync(fd);
        }

        if (diskHasValidPrimary && fs.existsSync(this.stateFile)) {
          try {
            fs.copyFileSync(this.stateFile, this.backupStateFile);
          } catch {
            // best-effort backup of previous valid state
          }
        }
        fs.renameSync(tmp, this.stateFile);

        const nextStatSig = readFileStatSig(this.stateFile);
        this.recordKnownDiskState(nextRevision, nextStatSig, contentHash);
        return {
          ok: true,
          state: finalState,
          revision: nextRevision,
          mergedExternalChanges,
        };
      } catch (err) {
        try {
          if (fs.existsSync(tmp)) {
            fs.unlinkSync(tmp);
          }
        } catch {
          // ignore cleanup errors
        }
        return {
          ok: false,
          state: finalState,
          revision: this.lastKnownRevision,
          mergedExternalChanges,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });
  }

  savePngBuffer(buffer: Buffer, prefix = "capture"): { imagePath: string; imageDataUrl: string } {
    return this.saveImageBuffer(buffer, "image/png", prefix);
  }

  saveImageBuffer(
    buffer: Buffer,
    mimeType = "image/png",
    prefix = "capture",
  ): { imagePath: string; imageDataUrl: string } {
    const normalized = mimeType.trim().toLowerCase();
    const { ext, canonicalMime } =
      normalized === "image/jpeg" || normalized === "image/jpg"
        ? { ext: ".jpg", canonicalMime: "image/jpeg" }
        : normalized === "image/webp"
          ? { ext: ".webp", canonicalMime: "image/webp" }
          : normalized === "image/gif"
            ? { ext: ".gif", canonicalMime: "image/gif" }
            : { ext: ".png", canonicalMime: "image/png" };
    const name = `${prefix}-${crypto.randomUUID().slice(0, 8)}${ext}`;
    const imagePath = path.join(this.attachmentsDir, name);
    fs.writeFileSync(imagePath, buffer);
    const imageDataUrl = `data:${canonicalMime};base64,${buffer.toString("base64")}`;
    return { imagePath, imageDataUrl };
  }

  imageFileToDataUrl(filePath: string): string | undefined {
    try {
      const ext = path.extname(filePath).toLowerCase();
      const mime =
        ext === ".jpg" || ext === ".jpeg"
          ? "image/jpeg"
          : ext === ".webp"
            ? "image/webp"
            : ext === ".gif"
              ? "image/gif"
              : "image/png";
      const buf = fs.readFileSync(filePath);
      return `data:${mime};base64,${buf.toString("base64")}`;
    } catch {
      return undefined;
    }
  }
}
