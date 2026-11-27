import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import type { Duplex } from "node:stream";
import zlib from "node:zlib";
import {
  getMimeTypeForImagePath,
  inspectLocalImageFile,
  MAX_IMAGE_FILE_BYTES,
  type LocalImageErrorCode,
} from "./image-viewer.js";
import {
  inspectLocalVideoFile,
  parseHttpByteRange,
  type LocalVideoErrorCode,
} from "./media-viewer.js";
import {
  RemoteTerminalService,
  type RemoteTerminalServiceOptions,
} from "./remote-terminal.js";
import { RemoteWebSocketConnection, writeHttpUpgradeError } from "./remote-websocket.js";
import {
  buildConductorConnectUri,
  buildConductorLinkUri,
  parseConductorConnectUri,
} from "../shared/remote-access.js";
import type {
  AgentTask,
  AgentTaskStatus,
  AppSnapshot,
  ChatAttachment,
  ExplicitMentionTarget,
  LandTaskResult,
  RemoteAccessStatus,
  SendMessagePayload,
  SyncTaskLandStatusResult,
  TaskStatusUpdateOptions,
  TaskStatusUpdateResult,
  TaskWorktreeStatus,
} from "../shared/types.js";

export { buildConductorConnectUri, buildConductorLinkUri, parseConductorConnectUri };

export const DEFAULT_REMOTE_ACCESS_PORT = 4789;
const MAX_JSON_BODY_BYTES = 25 * 1024 * 1024; // 25 MiB (supports multi-image base64 uploads)
const MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MiB decoded per image
const MAX_REMOTE_ATTACHMENTS = 10;
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_SSE_THROTTLE_MS = 200;
const SSE_MAX_BACKPRESSURE_BYTES = 512 * 1024; // 512 KiB
const REMOTE_TASK_OUTPUT_MAX_CHARS = 3_000;
const REMOTE_TASK_ACTIVITY_TITLE_MAX_CHARS = 140;
const REMOTE_TASK_ACTIVITY_DETAIL_MAX_CHARS = 200;
const REMOTE_TOOL_DETAIL_MAX_CHARS = 300;
const REMOTE_REASONING_MAX_CHARS = 4_000;
const GZIP_MIN_BYTES = 1_024;
const SERVER_KEEP_ALIVE_TIMEOUT_MS = 65_000;
const SERVER_HEADERS_TIMEOUT_MS = 70_000;

const VALID_TASK_STATUSES: ReadonlySet<AgentTaskStatus> = new Set([
  "queued",
  "running",
  "needs_review",
  "done",
  "failed",
]);

export interface TailscaleNetworkInfo {
  tailscaleIp: string | null;
  magicDnsName: string | null;
  lanIp: string | null;
}

export interface RemoteBridgeController {
  getSnapshot(): AppSnapshot;
  syncExternalState?(): boolean;
  sendMessage(payload: SendMessagePayload): Promise<void>;
  stopMessage(messageId: string): Promise<void>;
  stopAllResponders(): Promise<void>;
  startFreshChat(): Promise<void>;
  selectChatSession?(sessionId: string): Promise<boolean | void>;
  saveRemoteImageAttachment?(args: {
    buffer: Buffer;
    mimeType: string;
    label?: string;
  }): { imagePath: string; imageDataUrl: string };
  getAttachmentImage?(attachmentId: string): { buffer: Buffer; mimeType: string } | null;
  updateTaskStatus(
    taskId: string,
    status: AgentTaskStatus,
    options?: TaskStatusUpdateOptions,
  ): TaskStatusUpdateResult;
  stopTaskWorker(taskId: string): Promise<void>;
  landTask(taskId: string, options?: { createPr?: boolean }): Promise<LandTaskResult>;
  syncTaskLandStatus?(taskId: string): SyncTaskLandStatusResult;
  getTaskGitStatus(taskId: string): string | null;
  getTaskWorktreeStatus(taskId: string): TaskWorktreeStatus | null;
}

export interface RemoteBridgeServerOptions {
  port?: number;
  host?: string;
  token?: string;
  detectNetwork?: () => TailscaleNetworkInfo;
  onClientsChanged?: (count: number) => void;
  sseThrottleMs?: number;
  sseHeartbeatIntervalMs?: number;
  terminal?: RemoteTerminalServiceOptions;
}

export function generateRemoteAccessToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

export function normalizeRemoteAccessPort(
  value: unknown,
  fallback = DEFAULT_REMOTE_ACCESS_PORT,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
    return parsed;
  }
  return fallback;
}

/**
 * Checks whether an IPv4 address lies within Tailscale's CGNAT range (100.64.0.0/10),
 * i.e. 100.64.0.0 through 100.127.255.255.
 */
export function isTailscaleIpv4(ip: string): boolean {
  const trimmed = ip.trim();
  const parts = trimmed.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : -1));
  if (nums.some((n) => n < 0 || n > 255)) return false;
  return nums[0] === 100 && nums[1] >= 64 && nums[1] <= 127;
}

function isIpv4Family(family: string | number): boolean {
  return family === "IPv4" || family === 4;
}

export function detectTailscaleIpv4FromInterfaces(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string | null {
  const candidates: Array<{ name: string; address: string; priority: number }> = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    if (!entries) continue;
    const lowerName = name.toLowerCase();
    const priority =
      lowerName.includes("tailscale") ? 0 : lowerName.startsWith("utun") ? 1 : 2;
    for (const info of entries) {
      if (info.internal || !isIpv4Family(info.family)) continue;
      if (isTailscaleIpv4(info.address)) {
        candidates.push({ name, address: info.address, priority });
      }
    }
  }
  candidates.sort((a, b) => a.priority - b.priority);
  return candidates[0]?.address ?? null;
}

export function detectLanIpv4FromInterfaces(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string | null {
  const candidates: Array<{ address: string; priority: number }> = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    if (!entries) continue;
    const lowerName = name.toLowerCase();
    const priority = lowerName === "en0" ? 0 : lowerName.startsWith("en") ? 1 : 2;
    for (const info of entries) {
      if (info.internal || !isIpv4Family(info.family)) continue;
      if (!isTailscaleIpv4(info.address)) {
        candidates.push({ address: info.address, priority });
      }
    }
  }
  candidates.sort((a, b) => a.priority - b.priority);
  return candidates[0]?.address ?? null;
}

function defaultRunTailscaleCli(args: string[]): string | null {
  const candidates = [
    "tailscale",
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    ...(process.platform === "win32"
      ? ["C:\\Program Files\\Tailscale\\tailscale.exe"]
      : []),
  ];
  for (const bin of candidates) {
    try {
      const out = execFileSync(bin, args, {
        encoding: "utf8",
        timeout: 1500,
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (typeof out === "string" && out.trim()) {
        return out.trim();
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

export function detectTailscaleNetwork(options?: {
  interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  runTailscale?: (args: string[]) => string | null;
}): TailscaleNetworkInfo {
  const interfaces = options?.interfaces ?? os.networkInterfaces();
  const rawRunTailscale = options?.runTailscale ?? defaultRunTailscaleCli;
  const safeRunTailscale = (args: string[]): string | null => {
    try {
      const out = rawRunTailscale(args);
      return typeof out === "string" && out.trim() ? out.trim() : null;
    } catch {
      return null;
    }
  };

  let tailscaleIp = detectTailscaleIpv4FromInterfaces(interfaces);
  let magicDnsName: string | null = null;
  const lanIp = detectLanIpv4FromInterfaces(interfaces);
  let tailscaleExplicitlyDisconnected = false;

  const statusRaw = safeRunTailscale(["status", "--json"]);
  if (statusRaw) {
    try {
      const parsed = JSON.parse(statusRaw) as {
        BackendState?: unknown;
        TailscaleIPs?: unknown;
        Self?: { DNSName?: unknown; TailscaleIPs?: unknown };
      };
      const backendState =
        typeof parsed.BackendState === "string" ? parsed.BackendState.trim() : "";
      if (backendState && backendState.toLowerCase() !== "running") {
        // Tailscale daemon is installed but stopped / logged out — avoid returning stale data
        tailscaleExplicitlyDisconnected = true;
        tailscaleIp = null;
        magicDnsName = null;
      } else {
        const dnsRaw = typeof parsed.Self?.DNSName === "string" ? parsed.Self.DNSName.trim() : "";
        const cleanedDns = dnsRaw.replace(/\.+$/, "");
        if (cleanedDns && cleanedDns.includes(".")) {
          magicDnsName = cleanedDns;
        }
        if (!tailscaleIp) {
          const ipList = [
            ...(Array.isArray(parsed.Self?.TailscaleIPs) ? parsed.Self.TailscaleIPs : []),
            ...(Array.isArray(parsed.TailscaleIPs) ? parsed.TailscaleIPs : []),
          ];
          for (const candidate of ipList) {
            if (typeof candidate === "string" && isTailscaleIpv4(candidate)) {
              tailscaleIp = candidate.trim();
              break;
            }
          }
        }
      }
    } catch {
      // ignore malformed CLI output
    }
  }

  if (!tailscaleIp && !tailscaleExplicitlyDisconnected) {
    const ipOut = safeRunTailscale(["ip", "-4"]);
    if (ipOut) {
      for (const line of ipOut.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (isTailscaleIpv4(trimmed)) {
          tailscaleIp = trimmed;
          break;
        }
      }
    }
  }

  return { tailscaleIp, magicDnsName, lanIp };
}

function timingSafeTokenEquals(expected: string, actual: string | null | undefined): boolean {
  if (!expected || !actual) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function resolveTaskByIdOrCode(tasks: AgentTask[], idOrCode: string): AgentTask | undefined {
  const exact = tasks.find((t) => t.id === idOrCode);
  if (exact) return exact;
  const match = /^t(\d+)$/i.exec(idOrCode.trim());
  if (match) {
    const num = Number(match[1]);
    return tasks.find((t) => t.taskNumber === num);
  }
  return undefined;
}

function sanitizeMentions(raw: unknown): ExplicitMentionTarget[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ExplicitMentionTarget[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (rec.kind === "project") {
      out.push({
        kind: "project",
        projectId: typeof rec.projectId === "string" ? rec.projectId : null,
        ...(typeof rec.projectName === "string" ? { projectName: rec.projectName } : {}),
        ...(typeof rec.projectPath === "string" || rec.projectPath === null
          ? { projectPath: rec.projectPath as string | null }
          : {}),
        ...(typeof rec.projectColorHex === "string"
          ? { projectColorHex: rec.projectColorHex }
          : {}),
      });
    } else if (rec.kind === "task" && typeof rec.taskId === "string" && rec.taskId.trim()) {
      out.push({
        kind: "task",
        taskId: rec.taskId.trim(),
        ...(typeof rec.taskNumber === "number" ? { taskNumber: rec.taskNumber } : {}),
        ...(typeof rec.taskTitle === "string" ? { taskTitle: rec.taskTitle } : {}),
        ...(typeof rec.taskStatus === "string" &&
        VALID_TASK_STATUSES.has(rec.taskStatus as AgentTaskStatus)
          ? { taskStatus: rec.taskStatus as AgentTaskStatus }
          : {}),
        ...(typeof rec.projectId === "string" || rec.projectId === null
          ? { projectId: rec.projectId as string | null }
          : {}),
        ...(typeof rec.projectName === "string" ? { projectName: rec.projectName } : {}),
        ...(typeof rec.projectPath === "string" || rec.projectPath === null
          ? { projectPath: rec.projectPath as string | null }
          : {}),
        ...(typeof rec.projectColorHex === "string"
          ? { projectColorHex: rec.projectColorHex }
          : {}),
      });
    }
  }
  return out;
}

const IMAGE_DATA_URL_RE = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i;

export function parseImageDataUrl(
  dataUrl: string,
  maxBytes = MAX_REMOTE_IMAGE_BYTES,
): { ok: true; mimeType: string; buffer: Buffer } | { ok: false; error: string } {
  const trimmed = dataUrl.trim();
  const match = IMAGE_DATA_URL_RE.exec(trimmed);
  if (!match) {
    return {
      ok: false,
      error: "Invalid imageDataUrl format (expected base64 png/jpeg/webp/gif data URL)",
    };
  }
  const rawMime = match[1].toLowerCase();
  const mimeType = rawMime === "image/jpg" ? "image/jpeg" : rawMime;
  const cleanedBase64 = match[2].replace(/\s+/g, "");
  if (!cleanedBase64) {
    return { ok: false, error: "Empty image payload" };
  }
  const buffer = Buffer.from(cleanedBase64, "base64");
  if (buffer.length === 0) {
    return { ok: false, error: "Empty image payload" };
  }
  if (buffer.length > maxBytes) {
    return {
      ok: false,
      error: `Image attachment exceeds size limit (${Math.round(maxBytes / (1024 * 1024))}MB)`,
    };
  }
  return { ok: true, mimeType, buffer };
}

function readAttachmentImageFromSnapshot(
  snapshot: AppSnapshot,
  attachmentId: string,
): { buffer: Buffer; mimeType: string } | null {
  for (let i = snapshot.messages.length - 1; i >= 0; i -= 1) {
    const msg = snapshot.messages[i];
    const att = (msg.attachments ?? []).find((a) => a.id === attachmentId && a.kind === "image");
    if (!att) continue;
    if (att.imagePath) {
      const mimeType = getMimeTypeForImagePath(att.imagePath);
      if (mimeType) {
        try {
          const stat = fs.statSync(att.imagePath);
          if (stat.isFile() && stat.size <= MAX_IMAGE_FILE_BYTES) {
            return { buffer: fs.readFileSync(att.imagePath), mimeType };
          }
        } catch {
          // fall back to imageDataUrl if present
        }
      }
    }
    if (att.imageDataUrl) {
      const parsed = parseImageDataUrl(att.imageDataUrl, MAX_IMAGE_FILE_BYTES);
      if (parsed.ok) {
        return { buffer: parsed.buffer, mimeType: parsed.mimeType };
      }
    }
    return null;
  }
  return null;
}

function sanitizeAttachments(
  raw: unknown,
  saveImage?: RemoteBridgeController["saveRemoteImageAttachment"],
): { ok: true; attachments: ChatAttachment[] } | { ok: false; status: number; error: string } {
  if (!Array.isArray(raw)) return { ok: true, attachments: [] };
  if (raw.length > MAX_REMOTE_ATTACHMENTS) {
    return {
      ok: false,
      status: 400,
      error: `Too many attachments (max ${MAX_REMOTE_ATTACHMENTS})`,
    };
  }
  const validKinds = new Set([
    "image",
    "browserElement",
    "browserURL",
    "taskRef",
    "consoleErrors",
  ]);
  const out: ChatAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const kind = typeof rec.kind === "string" && validKinds.has(rec.kind) ? rec.kind : null;
    if (!kind) continue;
    const id = typeof rec.id === "string" && rec.id.trim() ? rec.id.trim() : crypto.randomUUID();
    const label =
      typeof rec.label === "string" && rec.label.trim() ? rec.label.trim() : kind;

    if (kind === "image") {
      if (typeof rec.imageDataUrl !== "string" || !rec.imageDataUrl.trim()) {
        return {
          ok: false,
          status: 400,
          error: "Image attachment requires imageDataUrl",
        };
      }
      const parsed = parseImageDataUrl(rec.imageDataUrl);
      if (!parsed.ok) {
        return {
          ok: false,
          status: parsed.error.includes("exceeds size limit") ? 413 : 400,
          error: parsed.error,
        };
      }
      const saved = saveImage?.({
        buffer: parsed.buffer,
        mimeType: parsed.mimeType,
        label,
      });
      const normalizedDataUrl =
        saved?.imageDataUrl ??
        `data:${parsed.mimeType};base64,${parsed.buffer.toString("base64")}`;
      out.push({
        id,
        kind: "image",
        label,
        ...(saved?.imagePath ? { imagePath: saved.imagePath } : {}),
        imageDataUrl: normalizedDataUrl,
        ...(typeof rec.metadataText === "string" ? { metadataText: rec.metadataText } : {}),
      });
      continue;
    }

    out.push({
      id,
      kind: kind as ChatAttachment["kind"],
      label,
      ...(typeof rec.url === "string" ? { url: rec.url } : {}),
      ...(typeof rec.metadataText === "string" ? { metadataText: rec.metadataText } : {}),
    });
  }
  return { ok: true, attachments: out };
}

/**
 * Projects a desktop AppSnapshot into a compact, mobile-safe payload.
 * Strips multi-MB base64 screenshot data URLs, desktop-only browser/usage/model catalogs,
 * and verbose worker histories (full task details remain available via GET /api/tasks/:id).
 */
export function buildRemoteSnapshot(snapshot: AppSnapshot): Record<string, unknown> {
  const tasks = (snapshot.tasks ?? []).map((t) => {
    const rawActivities = Array.isArray(t.activities) ? t.activities : [];
    const lastAct = rawActivities.length > 0 ? rawActivities[rawActivities.length - 1] : null;
    const latestActivity = lastAct
      ? {
          id: lastAct.id,
          kind: lastAct.kind,
          title:
            typeof lastAct.title === "string" &&
            lastAct.title.length > REMOTE_TASK_ACTIVITY_TITLE_MAX_CHARS
              ? `${lastAct.title.slice(0, REMOTE_TASK_ACTIVITY_TITLE_MAX_CHARS)}…`
              : lastAct.title ?? "",
          detail:
            typeof lastAct.detail === "string" && lastAct.detail.length > 0
              ? lastAct.detail.length > REMOTE_TASK_ACTIVITY_DETAIL_MAX_CHARS
                ? `${lastAct.detail.slice(0, REMOTE_TASK_ACTIVITY_DETAIL_MAX_CHARS)}…`
                : lastAct.detail
              : null,
          timestamp: lastAct.timestamp,
        }
      : null;
    const rawOutput = typeof t.latestOutput === "string" ? t.latestOutput : "";
    return {
      id: t.id,
      taskNumber: t.taskNumber,
      title: t.title,
      summary: t.summary,
      projectId: t.projectId,
      projectName: t.projectName,
      projectPath: t.projectPath,
      status: t.status,
      ...(t.provider ? { provider: t.provider } : {}),
      currentStep: t.currentStep,
      previewURL: t.previewURL,
      latestOutput:
        rawOutput.length > REMOTE_TASK_OUTPUT_MAX_CHARS
          ? rawOutput.slice(-REMOTE_TASK_OUTPUT_MAX_CHARS)
          : rawOutput,
      outputLength: rawOutput.length,
      activities: [],
      activityCount: rawActivities.length,
      ...(latestActivity ? { latestActivity } : {}),
      ...(t.worktreePath !== undefined ? { worktreePath: t.worktreePath } : {}),
      ...(t.worktreeBranch !== undefined ? { worktreeBranch: t.worktreeBranch } : {}),
      ...(t.baseBranch !== undefined ? { baseBranch: t.baseBranch } : {}),
      ...(t.landStatus !== undefined ? { landStatus: t.landStatus } : {}),
      ...(t.landedBranch !== undefined ? { landedBranch: t.landedBranch } : {}),
      ...(t.landedCommit !== undefined ? { landedCommit: t.landedCommit } : {}),
      ...(t.prUrl !== undefined ? { prUrl: t.prUrl } : {}),
      ...(t.landError !== undefined ? { landError: t.landError } : {}),
      ...(t.conflictFiles && t.conflictFiles.length > 0 ? { conflictFiles: t.conflictFiles } : {}),
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  });

  const messages = (snapshot.messages ?? []).map((m) => ({
    id: m.id,
    role: m.role,
    ...(m.provider ? { provider: m.provider } : {}),
    text: m.text,
    ...(m.reasoningSummary
      ? {
          reasoningSummary:
            m.reasoningSummary.length > REMOTE_REASONING_MAX_CHARS
              ? m.reasoningSummary.slice(-REMOTE_REASONING_MAX_CHARS)
              : m.reasoningSummary,
        }
      : {}),
    attachments: (m.attachments ?? []).map((att) => ({
      id: att.id,
      kind: att.kind,
      label: att.label,
      ...(att.imagePath ? { imagePath: att.imagePath } : {}),
      ...(att.url ? { url: att.url } : {}),
    })),
    ...(m.mentions && m.mentions.length > 0 ? { mentions: m.mentions } : {}),
    ...(m.inferredMentions && m.inferredMentions.length > 0
      ? { inferredMentions: m.inferredMentions }
      : {}),
    toolChips: (m.toolChips ?? []).slice(-12).map((chip) => ({
      id: chip.id,
      ...(chip.toolName ? { toolName: chip.toolName } : {}),
      label: chip.label,
      detail:
        chip.detail && chip.detail.length > REMOTE_TOOL_DETAIL_MAX_CHARS
          ? `${chip.detail.slice(0, REMOTE_TOOL_DETAIL_MAX_CHARS)}…`
          : chip.detail,
      isCompleted: chip.isCompleted,
      isError: chip.isError,
    })),
    ...(m.relatedTaskId ? { relatedTaskId: m.relatedTaskId } : {}),
    ...(m.replyToMessageId ? { replyToMessageId: m.replyToMessageId } : {}),
    ...(m.replyToSnippet ? { replyToSnippet: m.replyToSnippet } : {}),
    isStreaming: m.isStreaming,
    createdAt: m.createdAt,
  }));

  return {
    ...(snapshot.snapshotEpoch ? { snapshotEpoch: snapshot.snapshotEpoch } : {}),
    ...(typeof snapshot.snapshotVersion === "number"
      ? { snapshotVersion: snapshot.snapshotVersion }
      : {}),
    projects: snapshot.projects ?? [],
    tasks,
    messages,
    activeChatSessionId: snapshot.activeChatSessionId,
    chatSessions: snapshot.chatSessions ?? [],
    isConnected: snapshot.isConnected,
    connectionStatus: snapshot.connectionStatus,
    activeResponderCount: snapshot.activeResponderCount,
    chatProvider: snapshot.chatProvider,
    workerProvider: snapshot.workerProvider,
    chatModel: snapshot.chatModel,
    chatEffort: snapshot.chatEffort,
    workerModel: snapshot.workerModel,
    workerEffort: snapshot.workerEffort,
    defaultIntegrationMode: snapshot.defaultIntegrationMode,
    autoLandOnComplete: snapshot.autoLandOnComplete,
    preferredLanguage: snapshot.preferredLanguage,
    lastErrorBanner: snapshot.lastErrorBanner,
  };
}

function computeSnapshotPriorityKey(snapshot: AppSnapshot): string {
  const msgs = snapshot.messages ?? [];
  const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
  const taskSig = (snapshot.tasks ?? [])
    .map(
      (t) =>
        `${t.id}:${t.status}:${t.landStatus ?? ""}:${t.title}:${Array.isArray(t.activities) ? t.activities.length : 0}`,
    )
    .join("|");
  const sessionSig = (snapshot.chatSessions ?? [])
    .map((s) => `${s.id}:${s.messageCount}`)
    .join("|");
  return [
    snapshot.activeChatSessionId ?? "",
    String(msgs.length),
    lastMsg ? `${lastMsg.id}:${lastMsg.isStreaming ? "1" : "0"}` : "",
    String(snapshot.activeResponderCount ?? 0),
    snapshot.isConnected ? "1" : "0",
    snapshot.lastErrorBanner ?? "",
    taskSig,
    sessionSig,
  ].join("\0");
}

interface SseClientState {
  res: http.ServerResponse;
  waitingDrain: boolean;
  pendingFrame: string | null;
  lastSentJson: string | null;
  cleanup: () => void;
}

interface TerminalWsClientState {
  ws: RemoteWebSocketConnection;
  sessionId: string | null;
  projectPath: string | null;
  unsubscribe: () => void;
  cleanup: () => void;
}

/**
 * Tailscale-ready HTTP + SSE + WebSocket Remote Bridge server for Conductor.
 * Exposes authenticated JSON/SSE endpoints wired directly to ConductorController,
 * real-time PTY terminal WebSocket/HTTP APIs, plus a mobile-friendly Web UI fallback at `GET /`.
 */
export class RemoteBridgeServer {
  private readonly controller: RemoteBridgeController;
  private readonly detectNetworkFn: () => TailscaleNetworkInfo;
  private readonly onClientsChanged?: (count: number) => void;
  private readonly sseThrottleMs: number;
  private readonly sseHeartbeatIntervalMs: number;
  private readonly remoteTerminal: RemoteTerminalService;

  private server: http.Server | null = null;
  private host: string;
  private configuredPort: number;
  private actualPort: number | null = null;
  private token: string;
  private lastError: string | null = null;
  private networkInfo: TailscaleNetworkInfo;
  private readonly sseClients = new Set<SseClientState>();
  private readonly terminalWsClients = new Set<TerminalWsClientState>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private sseThrottleTimer: NodeJS.Timeout | null = null;
  private pendingSnapshot: AppSnapshot | null = null;
  private lastPublishedAt = 0;
  private lastPublishedPriorityKey = "";

  constructor(controller: RemoteBridgeController, options: RemoteBridgeServerOptions = {}) {
    this.controller = controller;
    this.host = options.host ?? "0.0.0.0";
    this.configuredPort =
      options.port === 0 ? 0 : normalizeRemoteAccessPort(options.port, DEFAULT_REMOTE_ACCESS_PORT);
    this.token =
      options.token && options.token.trim().length > 0
        ? options.token.trim()
        : generateRemoteAccessToken();
    this.detectNetworkFn = options.detectNetwork ?? (() => detectTailscaleNetwork());
    this.onClientsChanged = options.onClientsChanged;
    this.sseThrottleMs = Math.max(0, options.sseThrottleMs ?? DEFAULT_SSE_THROTTLE_MS);
    this.sseHeartbeatIntervalMs = Math.max(
      1_000,
      options.sseHeartbeatIntervalMs ?? SSE_HEARTBEAT_INTERVAL_MS,
    );
    this.remoteTerminal = new RemoteTerminalService(options.terminal);
    this.networkInfo = options.detectNetwork
      ? this.safeDetectNetwork()
      : {
          tailscaleIp: detectTailscaleIpv4FromInterfaces(),
          magicDnsName: null,
          lanIp: detectLanIpv4FromInterfaces(),
        };
  }

  public isRunning(): boolean {
    return this.server !== null && this.actualPort !== null;
  }

  public getPort(): number {
    return this.actualPort ?? this.configuredPort;
  }

  public getToken(): string {
    return this.token;
  }

  public setToken(token: string): void {
    const trimmed = token.trim();
    if (!trimmed) return;
    this.token = trimmed;
    // Disconnect existing SSE and terminal WebSocket clients authenticated with the old token
    if (this.sseClients.size > 0) {
      for (const client of [...this.sseClients]) {
        try {
          client.res.end();
        } catch {
          // ignore
        }
        client.cleanup();
      }
      this.sseClients.clear();
      this.onClientsChanged?.(0);
    }
    this.closeAllTerminalWsClients(4001, "Token regenerated");
  }

  public refreshNetwork(): TailscaleNetworkInfo {
    this.networkInfo = this.safeDetectNetwork();
    return this.networkInfo;
  }

  public getStatus(enabled?: boolean): RemoteAccessStatus {
    const running = this.isRunning();
    const port = this.actualPort ?? this.configuredPort;
    const { tailscaleIp, magicDnsName, lanIp } = this.networkInfo;
    const tailscaleUrl = tailscaleIp && port > 0 ? `http://${tailscaleIp}:${port}` : null;
    const magicDnsUrl = magicDnsName && port > 0 ? `http://${magicDnsName}:${port}` : null;
    const lanUrl = lanIp && port > 0 ? `http://${lanIp}:${port}` : null;
    const preferredHost = tailscaleIp ?? magicDnsName ?? lanIp ?? "127.0.0.1";
    const url = port > 0 ? `http://${preferredHost}:${port}` : null;
    const connectUri = url && this.token ? buildConductorConnectUri(url, this.token) : null;
    const linkUri = url && this.token ? buildConductorLinkUri(url, this.token) : null;

    return {
      enabled: enabled ?? running,
      running,
      port,
      token: this.token,
      bindHost: running ? this.host : null,
      tailscaleIp,
      magicDnsName,
      lanIp,
      url,
      tailscaleUrl,
      magicDnsUrl,
      lanUrl,
      connectUri,
      linkUri,
      connectedClients: this.sseClients.size,
      error: this.lastError,
    };
  }

  public async start(config?: {
    port?: number;
    host?: string;
    token?: string;
  }): Promise<RemoteAccessStatus> {
    if (config?.token && config.token.trim()) {
      this.token = config.token.trim();
    }
    const nextPort =
      config?.port === 0
        ? 0
        : config?.port !== undefined
          ? normalizeRemoteAccessPort(config.port, DEFAULT_REMOTE_ACCESS_PORT)
          : this.configuredPort;
    const nextHost = config?.host ?? this.host;

    if (this.server && this.configuredPort === nextPort && this.host === nextHost) {
      this.refreshNetwork();
      return this.getStatus(true);
    }

    if (this.server) {
      await this.stop();
    }

    this.configuredPort = nextPort;
    this.host = nextHost;
    this.lastError = null;
    this.refreshNetwork();

    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    server.on("upgrade", (req, socket, head) => {
      this.handleUpgrade(req, socket, head);
    });
    server.keepAliveTimeout = SERVER_KEEP_ALIVE_TIMEOUT_MS;
    server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS;
    server.requestTimeout = 0;

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.configuredPort, this.host, () => {
          server.off("error", reject);
          resolve();
        });
      });

      const addr = server.address() as AddressInfo | null;
      this.server = server;
      this.actualPort = addr?.port ?? this.configuredPort;
      this.lastError = null;

      server.on("error", (err: NodeJS.ErrnoException) => {
        this.lastError = this.formatServerError(err);
      });

      this.startHeartbeat();
    } catch (err) {
      try {
        server.close();
      } catch {
        // ignore
      }
      this.server = null;
      this.actualPort = null;
      this.lastError = this.formatServerError(err as NodeJS.ErrnoException);
    }

    return this.getStatus(true);
  }

  public async stop(): Promise<RemoteAccessStatus> {
    this.stopHeartbeat();
    this.clearSseThrottleTimer();
    this.pendingSnapshot = null;

    const hadClients = this.sseClients.size > 0;
    for (const client of [...this.sseClients]) {
      try {
        client.res.end();
      } catch {
        // ignore
      }
      client.cleanup();
    }
    if (hadClients) {
      this.sseClients.clear();
      this.onClientsChanged?.(0);
    }
    this.closeAllTerminalWsClients(1001, "Server stopping");
    this.remoteTerminal.disposeAll();

    const srv = this.server;
    this.server = null;
    this.actualPort = null;
    this.lastError = null;

    if (srv) {
      await new Promise<void>((resolve) => {
        srv.close(() => resolve());
        srv.closeAllConnections?.();
      });
    }

    return this.getStatus(false);
  }

  public publishSnapshot(snapshot: AppSnapshot): void {
    if (this.sseClients.size === 0) return;
    const priorityKey = computeSnapshotPriorityKey(snapshot);
    const now = Date.now();
    const elapsed = now - this.lastPublishedAt;

    if (
      this.sseThrottleMs === 0 ||
      priorityKey !== this.lastPublishedPriorityKey ||
      elapsed >= this.sseThrottleMs
    ) {
      this.flushSnapshotNow(snapshot, priorityKey);
      return;
    }

    this.pendingSnapshot = snapshot;
    if (!this.sseThrottleTimer) {
      const waitMs = Math.max(10, this.sseThrottleMs - elapsed);
      this.sseThrottleTimer = setTimeout(() => {
        this.sseThrottleTimer = null;
        const queued = this.pendingSnapshot;
        this.pendingSnapshot = null;
        if (queued && this.sseClients.size > 0) {
          this.flushSnapshotNow(queued, computeSnapshotPriorityKey(queued));
        }
      }, waitMs);
      this.sseThrottleTimer.unref?.();
    }
  }

  private clearSseThrottleTimer(): void {
    if (this.sseThrottleTimer) {
      clearTimeout(this.sseThrottleTimer);
      this.sseThrottleTimer = null;
    }
  }

  private flushSnapshotNow(snapshot: AppSnapshot, priorityKey: string): void {
    this.clearSseThrottleTimer();
    this.pendingSnapshot = null;
    if (this.sseClients.size === 0) return;

    const json = JSON.stringify(buildRemoteSnapshot(snapshot));
    this.lastPublishedPriorityKey = priorityKey;
    this.lastPublishedAt = Date.now();

    const frame = `event: snapshot\ndata: ${json}\n\n`;
    for (const client of [...this.sseClients]) {
      if (client.lastSentJson === json) {
        continue;
      }
      this.writeSseFrame(client, frame, json);
    }
  }

  private writeSseFrame(client: SseClientState, frame: string, jsonPayload: string | null): void {
    const res = client.res;
    if (res.writableEnded || res.destroyed) {
      client.cleanup();
      return;
    }
    if (res.writableLength > SSE_MAX_BACKPRESSURE_BYTES) {
      try {
        res.destroy();
      } catch {
        // ignore
      }
      client.cleanup();
      return;
    }
    if (client.waitingDrain) {
      if (jsonPayload !== null) {
        client.pendingFrame = frame;
        client.lastSentJson = jsonPayload;
      }
      return;
    }
    try {
      const canContinue = res.write(frame);
      if (jsonPayload !== null) {
        client.lastSentJson = jsonPayload;
      }
      if (!canContinue) {
        client.waitingDrain = true;
      }
    } catch {
      client.cleanup();
    }
  }

  private safeDetectNetwork(): TailscaleNetworkInfo {
    try {
      return this.detectNetworkFn();
    } catch {
      return { tailscaleIp: null, magicDnsName: null, lanIp: null };
    }
  }

  private formatServerError(err: NodeJS.ErrnoException | Error): string {
    const code = "code" in err ? err.code : undefined;
    if (code === "EADDRINUSE") {
      return `ポート ${this.configuredPort} は既に使用中です。別のポート番号を設定してください。`;
    }
    if (code === "EACCES") {
      return `ポート ${this.configuredPort} のバインド権限がありません（1024以上のポートを推奨）。`;
    }
    return err.message || String(err);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.sseClients.size > 0) {
        for (const client of [...this.sseClients]) {
          if (client.res.writableEnded || client.res.destroyed) {
            client.cleanup();
            continue;
          }
          if (client.res.writableLength > SSE_MAX_BACKPRESSURE_BYTES) {
            try {
              client.res.destroy();
            } catch {
              // ignore
            }
            client.cleanup();
            continue;
          }
          if (client.waitingDrain) {
            // Data is already draining on the socket; skip redundant ping
            continue;
          }
          this.writeSseFrame(client, ": ping\n\n", null);
        }
      }
      if (this.terminalWsClients.size > 0) {
        for (const wsClient of [...this.terminalWsClients]) {
          if (!wsClient.ws.isOpen()) {
            wsClient.cleanup();
            continue;
          }
          wsClient.ws.sendPing();
        }
      }
    }, this.sseHeartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private removeSseClient(client: SseClientState): void {
    if (this.sseClients.delete(client)) {
      if (this.sseClients.size === 0) {
        this.clearSseThrottleTimer();
        this.pendingSnapshot = null;
      }
      this.onClientsChanged?.(this.sseClients.size);
    }
  }

  private applyCorsHeaders(res: http.ServerResponse): void {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Range, If-None-Match, If-Range");
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Content-Range, Accept-Ranges, Content-Length, Content-Type, ETag",
    );
  }

  private sendJson(
    res: http.ServerResponse,
    statusCode: number,
    payload: unknown,
    req?: http.IncomingMessage,
  ): void {
    this.applyCorsHeaders(res);
    const body = JSON.stringify(payload);
    const rawBuf = Buffer.from(body, "utf8");
    const acceptEncoding = typeof req?.headers["accept-encoding"] === "string"
      ? req.headers["accept-encoding"]
      : "";
    if (rawBuf.length >= GZIP_MIN_BYTES && /\bgzip\b/i.test(acceptEncoding)) {
      const compressed = zlib.gzipSync(rawBuf, { level: zlib.constants.Z_BEST_SPEED });
      res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Encoding": "gzip",
        Vary: "Accept-Encoding",
        "Content-Length": compressed.length,
        "Cache-Control": "no-store",
      });
      res.end(compressed);
      return;
    }
    res.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": rawBuf.length,
      "Cache-Control": "no-store",
    });
    res.end(rawBuf);
  }

  private computeMediaCookieValue(): string {
    return crypto
      .createHmac("sha256", this.token)
      .update("conductor-remote-media-cookie-v1")
      .digest("hex");
  }

  private hasValidMediaCookie(req: http.IncomingMessage): boolean {
    const cookieHeader = req.headers.cookie;
    if (typeof cookieHeader !== "string" || !cookieHeader.trim()) return false;
    const expected = this.computeMediaCookieValue();
    for (const part of cookieHeader.split(";")) {
      const eqIdx = part.indexOf("=");
      if (eqIdx <= 0) continue;
      const name = part.slice(0, eqIdx).trim();
      if (name !== "conductor_remote_media") continue;
      const value = part.slice(eqIdx + 1).trim();
      if (timingSafeTokenEquals(expected, value)) {
        return true;
      }
    }
    return false;
  }

  private isAuthorized(req: http.IncomingMessage, parsedUrl: URL, allowQueryToken: boolean): boolean {
    const authHeader = req.headers.authorization;
    if (typeof authHeader === "string") {
      const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
      if (match && timingSafeTokenEquals(this.token, match[1].trim())) {
        return true;
      }
    }
    if (allowQueryToken) {
      const queryToken = parsedUrl.searchParams.get("token");
      if (timingSafeTokenEquals(this.token, queryToken)) {
        return true;
      }
    }
    return false;
  }

  private async readJsonBody(
    req: http.IncomingMessage,
  ): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; status: number; error: string }> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;

      const finish = (
        result:
          | { ok: true; data: Record<string, unknown> }
          | { ok: false; status: number; error: string },
      ) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      req.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_JSON_BODY_BYTES) {
          finish({ ok: false, status: 413, error: "Request body too large" });
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      req.on("error", () => {
        finish({ ok: false, status: 400, error: "Failed to read request body" });
      });

      req.on("aborted", () => {
        finish({ ok: false, status: 499, error: "Request aborted" });
      });

      req.on("close", () => {
        if (!req.complete) {
          finish({ ok: false, status: 499, error: "Request closed prematurely" });
        }
      });

      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        if (!raw) {
          finish({ ok: true, data: {} });
          return;
        }
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            finish({ ok: false, status: 400, error: "JSON body must be an object" });
            return;
          }
          finish({ ok: true, data: parsed as Record<string, unknown> });
        } catch {
          finish({ ok: false, status: 400, error: "Invalid JSON body" });
        }
      });
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const parsedUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = parsedUrl.pathname;

    if (method === "OPTIONS") {
      this.applyCorsHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

    // Mobile-friendly Web UI fallback
    if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      const html = renderMobileFallbackHtml();
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": Buffer.byteLength(html, "utf8"),
        "Cache-Control": "no-store",
      });
      res.end(html);
      return;
    }

    // Unauthenticated health check for reachability testing
    if (method === "GET" && pathname === "/api/health") {
      this.sendJson(res, 200, {
        ok: true,
        service: "conductor-remote-bridge",
        version: "0.1.0",
        hostname: os.hostname(),
        tailscaleIp: this.networkInfo.tailscaleIp,
        magicDnsName: this.networkInfo.magicDnsName,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Clearing the mobile web media cookie does not require an active token
    if (method === "DELETE" && pathname === "/api/media/session") {
      this.applyCorsHeaders(res);
      res.setHeader(
        "Set-Cookie",
        "conductor_remote_media=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0",
      );
      this.sendJson(res, 200, { ok: true }, req);
      return;
    }

    // All other /api/* endpoints require authentication
    if (pathname.startsWith("/api/")) {
      const allowQueryToken = method === "GET" && pathname === "/api/events";
      const allowMediaCookie =
        (method === "GET" || method === "HEAD") &&
        (pathname === "/api/media/image" ||
          pathname === "/api/media/video" ||
          /^\/api\/attachments\/[^/]+$/.test(pathname));
      if (
        !this.isAuthorized(req, parsedUrl, allowQueryToken) &&
        !(allowMediaCookie && this.hasValidMediaCookie(req))
      ) {
        this.sendJson(res, 401, { ok: false, error: "Unauthorized" });
        return;
      }

      try {
        await this.handleAuthenticatedApi(method, pathname, parsedUrl, req, res);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!res.headersSent) {
          this.sendJson(res, 500, { ok: false, error: message });
        }
      }
      return;
    }

    this.sendJson(res, 404, { ok: false, error: "Not Found" });
  }

  private async handleAuthenticatedApi(
    method: string,
    pathname: string,
    parsedUrl: URL,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (method === "GET" && pathname === "/api/snapshot") {
      this.controller.syncExternalState?.();
      this.sendJson(res, 200, buildRemoteSnapshot(this.controller.getSnapshot()), req);
      return;
    }

    if (method === "GET" && pathname === "/api/events") {
      this.handleSseStream(req, res);
      return;
    }

    const attachmentMatch = /^\/api\/attachments\/([^/]+)$/.exec(pathname);
    if (attachmentMatch && (method === "GET" || method === "HEAD")) {
      let attachmentId = "";
      try {
        attachmentId = decodeURIComponent(attachmentMatch[1]).trim();
      } catch {
        this.sendJson(res, 400, { ok: false, error: "Invalid attachment ID" }, req);
        return;
      }
      if (!attachmentId) {
        this.sendJson(res, 400, { ok: false, error: "Invalid attachment ID" }, req);
        return;
      }
      const resolved =
        this.controller.getAttachmentImage?.(attachmentId) ??
        readAttachmentImageFromSnapshot(this.controller.getSnapshot(), attachmentId);
      if (!resolved) {
        this.sendJson(res, 404, { ok: false, error: "Attachment not found" }, req);
        return;
      }
      this.applyCorsHeaders(res);
      res.writeHead(200, {
        "Content-Type": resolved.mimeType,
        "Content-Length": resolved.buffer.length,
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      });
      if (method === "HEAD") {
        res.end();
      } else {
        res.end(resolved.buffer);
      }
      return;
    }

    if (method === "POST" && pathname === "/api/media/session") {
      this.applyCorsHeaders(res);
      res.setHeader(
        "Set-Cookie",
        `conductor_remote_media=${this.computeMediaCookieValue()}; HttpOnly; SameSite=Strict; Path=/api`,
      );
      this.sendJson(res, 200, { ok: true }, req);
      return;
    }

    if ((method === "GET" || method === "HEAD") && pathname === "/api/media/image") {
      this.handleLocalImageMedia(method, parsedUrl, req, res);
      return;
    }

    if ((method === "GET" || method === "HEAD") && pathname === "/api/media/video") {
      this.handleLocalVideoMedia(method, parsedUrl, req, res);
      return;
    }

    if (method === "POST" && pathname === "/api/chat/send") {
      this.controller.syncExternalState?.();
      const parsed = await this.readJsonBody(req);
      if (!parsed.ok) {
        this.sendJson(res, parsed.status, { ok: false, error: parsed.error }, req);
        return;
      }
      const text = typeof parsed.data.text === "string" ? parsed.data.text : "";
      const sanitizedAttachments = sanitizeAttachments(
        parsed.data.attachments,
        this.controller.saveRemoteImageAttachment
          ? (args) => this.controller.saveRemoteImageAttachment!(args)
          : undefined,
      );
      if (!sanitizedAttachments.ok) {
        this.sendJson(
          res,
          sanitizedAttachments.status,
          { ok: false, error: sanitizedAttachments.error },
          req,
        );
        return;
      }
      const attachments = sanitizedAttachments.attachments;
      const explicitMentions = sanitizeMentions(
        parsed.data.explicitMentions ?? parsed.data.mentions,
      );
      if (!text.trim() && attachments.length === 0) {
        this.sendJson(res, 400, { ok: false, error: "text or attachments is required" }, req);
        return;
      }

      const requestedSessionId =
        typeof parsed.data.chatSessionId === "string"
          ? parsed.data.chatSessionId.trim()
          : typeof parsed.data.sessionId === "string"
            ? parsed.data.sessionId.trim()
            : "";
      if (requestedSessionId) {
        const currentSnap = this.controller.getSnapshot();
        const serverActiveId = currentSnap.activeChatSessionId?.trim() ?? "";
        if (serverActiveId && requestedSessionId !== serverActiveId) {
          const existsOnServer = (currentSnap.chatSessions ?? []).some(
            (s) => s.id === requestedSessionId,
          );
          this.sendJson(
            res,
            409,
            {
              ok: false,
              reason: existsOnServer ? "session_mismatch" : "session_not_found",
              error: existsOnServer
                ? "アクティブなチャットセッションが切り替わっています。最新セッションに同期してから再送信してください。"
                : "指定されたチャットセッションは存在しません。最新のセッション一覧に同期しました。",
              activeChatSessionId: serverActiveId,
              snapshot: buildRemoteSnapshot(currentSnap),
            },
            req,
          );
          return;
        }
      }

      await this.controller.sendMessage({
        text,
        attachments,
        ...(explicitMentions && explicitMentions.length > 0 ? { mentions: explicitMentions } : {}),
      });
      this.sendJson(
        res,
        200,
        { ok: true, snapshot: buildRemoteSnapshot(this.controller.getSnapshot()) },
        req,
      );
      return;
    }

    if (method === "POST" && pathname === "/api/chat/stop") {
      const parsed = await this.readJsonBody(req);
      if (!parsed.ok) {
        this.sendJson(res, parsed.status, { ok: false, error: parsed.error }, req);
        return;
      }
      const messageId =
        typeof parsed.data.messageId === "string" ? parsed.data.messageId.trim() : "";
      if (messageId) {
        await this.controller.stopMessage(messageId);
      } else {
        await this.controller.stopAllResponders();
      }
      this.sendJson(
        res,
        200,
        { ok: true, snapshot: buildRemoteSnapshot(this.controller.getSnapshot()) },
        req,
      );
      return;
    }

    if (method === "POST" && pathname === "/api/chat/new") {
      this.controller.syncExternalState?.();
      await this.controller.startFreshChat();
      this.sendJson(
        res,
        200,
        { ok: true, snapshot: buildRemoteSnapshot(this.controller.getSnapshot()) },
        req,
      );
      return;
    }

    if (method === "POST" && pathname === "/api/chat/session") {
      this.controller.syncExternalState?.();
      const parsed = await this.readJsonBody(req);
      if (!parsed.ok) {
        this.sendJson(res, parsed.status, { ok: false, error: parsed.error }, req);
        return;
      }
      const sessionId =
        typeof parsed.data.sessionId === "string" ? parsed.data.sessionId.trim() : "";
      if (!sessionId) {
        this.sendJson(res, 400, { ok: false, error: "sessionId is required" }, req);
        return;
      }

      const beforeSnap = this.controller.getSnapshot();
      const knownSessions = beforeSnap.chatSessions ?? [];
      if (
        knownSessions.length > 0 &&
        beforeSnap.activeChatSessionId !== sessionId &&
        !knownSessions.some((s) => s.id === sessionId)
      ) {
        this.sendJson(
          res,
          404,
          {
            ok: false,
            reason: "session_not_found",
            error: "指定されたチャットセッションは存在しません。最新のセッション一覧に同期しました。",
            activeChatSessionId: beforeSnap.activeChatSessionId,
            snapshot: buildRemoteSnapshot(beforeSnap),
          },
          req,
        );
        return;
      }

      const selected = this.controller.selectChatSession
        ? await this.controller.selectChatSession(sessionId)
        : true;
      const afterSnap = this.controller.getSnapshot();
      if (selected === false) {
        this.sendJson(
          res,
          404,
          {
            ok: false,
            reason: "session_not_found",
            error: "指定されたチャットセッションは存在しません。最新のセッション一覧に同期しました。",
            activeChatSessionId: afterSnap.activeChatSessionId,
            snapshot: buildRemoteSnapshot(afterSnap),
          },
          req,
        );
        return;
      }

      this.sendJson(
        res,
        200,
        {
          ok: true,
          activeChatSessionId: afterSnap.activeChatSessionId,
          snapshot: buildRemoteSnapshot(afterSnap),
        },
        req,
      );
      return;
    }

    // /api/tasks/:id and /api/tasks/:id/(status|stop|land|sync-land)
    const taskActionMatch =
      /^\/api\/tasks\/([^/]+)(?:\/(status|stop|land|sync-land))?$/.exec(pathname);
    if (taskActionMatch) {
      this.controller.syncExternalState?.();
      const rawTaskId = decodeURIComponent(taskActionMatch[1]);
      const action = taskActionMatch[2] ?? null;
      const snapshot = this.controller.getSnapshot();
      const task = resolveTaskByIdOrCode(snapshot.tasks, rawTaskId);

      if (!task) {
        this.sendJson(res, 404, { ok: false, error: "Task not found" });
        return;
      }

      if (method === "GET" && !action) {
        const skipGitParam = parsedUrl.searchParams.get("skipGit")?.trim().toLowerCase();
        const includeGitParam = parsedUrl.searchParams.get("includeGit")?.trim().toLowerCase();
        const skipGit =
          skipGitParam === "1" ||
          skipGitParam === "true" ||
          includeGitParam === "0" ||
          includeGitParam === "false";
        const worktreeStatus = skipGit ? null : this.controller.getTaskWorktreeStatus(task.id);
        const gitStatus = skipGit ? null : this.controller.getTaskGitStatus(task.id);
        this.sendJson(
          res,
          200,
          {
            ok: true,
            task,
            worktreeStatus,
            gitStatus,
          },
          req,
        );
        return;
      }

      if (method === "POST" && action === "status") {
        const parsed = await this.readJsonBody(req);
        if (!parsed.ok) {
          this.sendJson(res, parsed.status, { ok: false, error: parsed.error });
          return;
        }
        const status = typeof parsed.data.status === "string" ? parsed.data.status.trim() : "";
        const force = parsed.data.force === true;
        if (!VALID_TASK_STATUSES.has(status as AgentTaskStatus)) {
          this.sendJson(res, 400, {
            ok: false,
            error: "Invalid status. Expected queued | running | needs_review | done | failed",
          });
          return;
        }
        const result = this.controller.updateTaskStatus(
          task.id,
          status as AgentTaskStatus,
          force ? { force: true } : undefined,
        );
        if (!result.ok) {
          this.sendJson(res, 409, { ok: false, error: result.error ?? "Status update blocked" });
          return;
        }
        const updatedTask =
          this.controller.getSnapshot().tasks.find((t) => t.id === task.id) ?? task;
        this.sendJson(res, 200, { ok: true, task: updatedTask });
        return;
      }

      if (method === "POST" && action === "stop") {
        await this.controller.stopTaskWorker(task.id);
        const updatedTask =
          this.controller.getSnapshot().tasks.find((t) => t.id === task.id) ?? task;
        this.sendJson(res, 200, { ok: true, task: updatedTask });
        return;
      }

      if (method === "POST" && action === "land") {
        const parsed = await this.readJsonBody(req);
        if (!parsed.ok) {
          this.sendJson(res, parsed.status, { ok: false, error: parsed.error });
          return;
        }
        const createPr = typeof parsed.data.createPr === "boolean" ? parsed.data.createPr : false;
        const result = await this.controller.landTask(task.id, { createPr });
        this.sendJson(res, result.ok ? 200 : 409, result);
        return;
      }

      if (method === "POST" && action === "sync-land") {
        const syncResult = this.controller.syncTaskLandStatus
          ? this.controller.syncTaskLandStatus(task.id)
          : {
              ok: false,
              updated: false,
              reason: "error" as const,
              message: "Land status sync is not supported",
            };
        const updatedTask =
          this.controller.getSnapshot().tasks.find((t) => t.id === task.id) ?? task;
        this.sendJson(res, syncResult.ok ? 200 : 409, {
          ...syncResult,
          task: updatedTask,
        });
        return;
      }

      this.sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
      return;
    }

    if (method === "GET" && pathname === "/api/terminal/sessions") {
      this.sendJson(res, 200, { ok: true, sessions: this.remoteTerminal.listSessions() }, req);
      return;
    }

    if (method === "POST" && pathname === "/api/terminal/sessions") {
      const parsed = await this.readJsonBody(req);
      if (!parsed.ok) {
        this.sendJson(res, parsed.status, { ok: false, error: parsed.error }, req);
        return;
      }
      const projectPath =
        typeof parsed.data.projectPath === "string" ? parsed.data.projectPath : null;
      const cwd = typeof parsed.data.cwd === "string" ? parsed.data.cwd : null;
      const cols = typeof parsed.data.cols === "number" ? parsed.data.cols : undefined;
      const rows = typeof parsed.data.rows === "number" ? parsed.data.rows : undefined;
      const id = typeof parsed.data.id === "string" ? parsed.data.id : undefined;

      const created = this.remoteTerminal.createSession({
        id,
        projectPath,
        cwd,
        cols,
        rows,
      });
      if (!created.ok) {
        this.sendJson(res, 500, { ok: false, error: created.error }, req);
        return;
      }
      this.sendJson(res, 200, { ok: true, session: created.session }, req);
      return;
    }

    const terminalSessionMatch =
      /^\/api\/terminal\/sessions\/([^/]+)(?:\/(input|resize|close))?$/.exec(pathname);
    if (terminalSessionMatch) {
      let sessionId = "";
      try {
        sessionId = decodeURIComponent(terminalSessionMatch[1]).trim();
      } catch {
        this.sendJson(res, 400, { ok: false, error: "Invalid session ID" }, req);
        return;
      }
      const action = terminalSessionMatch[2] ?? null;

      if (!sessionId) {
        this.sendJson(res, 400, { ok: false, error: "Invalid session ID" }, req);
        return;
      }

      if (method === "GET" && !action) {
        const session = this.remoteTerminal.getSession(sessionId);
        if (!session) {
          this.sendJson(res, 404, { ok: false, error: "Terminal session not found" }, req);
          return;
        }
        const afterSeqRaw = parsedUrl.searchParams.get("afterSeq");
        const afterSeq =
          afterSeqRaw !== null && /^\d+$/.test(afterSeqRaw.trim())
            ? Number(afterSeqRaw.trim())
            : undefined;
        const replay = this.remoteTerminal.getReplay(sessionId, afterSeq);
        this.sendJson(
          res,
          200,
          {
            ok: true,
            session,
            buffer: replay?.replay ?? "",
            seq: replay?.seq ?? 0,
            replayMode: replay?.replayMode ?? "full",
          },
          req,
        );
        return;
      }

      if (method === "POST" && action === "input") {
        const parsed = await this.readJsonBody(req);
        if (!parsed.ok) {
          this.sendJson(res, parsed.status, { ok: false, error: parsed.error }, req);
          return;
        }
        const data = typeof parsed.data.data === "string" ? parsed.data.data : "";
        if (!data) {
          this.sendJson(res, 400, { ok: false, error: "data is required" }, req);
          return;
        }
        const result = this.remoteTerminal.write(sessionId, data);
        if (!result.ok) {
          const statusCode = result.error?.includes("not found") ? 404 : 409;
          this.sendJson(res, statusCode, { ok: false, error: result.error }, req);
          return;
        }
        this.sendJson(res, 200, { ok: true }, req);
        return;
      }

      if (method === "POST" && action === "resize") {
        const parsed = await this.readJsonBody(req);
        if (!parsed.ok) {
          this.sendJson(res, parsed.status, { ok: false, error: parsed.error }, req);
          return;
        }
        const cols = typeof parsed.data.cols === "number" ? parsed.data.cols : Number(parsed.data.cols);
        const rows = typeof parsed.data.rows === "number" ? parsed.data.rows : Number(parsed.data.rows);
        if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
          this.sendJson(res, 400, { ok: false, error: "cols and rows must be numbers" }, req);
          return;
        }
        const result = this.remoteTerminal.resize(sessionId, cols, rows);
        if (!result.ok) {
          const statusCode = result.error.includes("not found") ? 404 : 400;
          this.sendJson(res, statusCode, { ok: false, error: result.error }, req);
          return;
        }
        this.sendJson(res, 200, { ok: true, session: result.session }, req);
        return;
      }

      if ((method === "DELETE" && !action) || (method === "POST" && action === "close")) {
        const result = this.remoteTerminal.closeSession(sessionId);
        if (!result.ok) {
          this.sendJson(res, 404, { ok: false, error: "Terminal session not found" }, req);
          return;
        }
        this.sendJson(res, 200, { ok: true }, req);
        return;
      }

      this.sendJson(res, 405, { ok: false, error: "Method Not Allowed" }, req);
      return;
    }

    this.sendJson(res, 404, { ok: false, error: "Not Found" });
  }

  private mapMediaErrorToHttpStatus(errorCode: LocalImageErrorCode | LocalVideoErrorCode): number {
    switch (errorCode) {
      case "invalid":
        return 400;
      case "forbidden":
        return 403;
      case "not_found":
        return 404;
      case "too_large":
        return 413;
      case "io_error":
        return 500;
    }
  }

  private handleLocalImageMedia(
    method: string,
    parsedUrl: URL,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const rawPath = parsedUrl.searchParams.get("path")?.trim() ?? "";
    const rawBase = parsedUrl.searchParams.get("base")?.trim() || undefined;
    if (!rawPath) {
      this.sendJson(res, 400, { ok: false, error: "path query parameter is required" }, req);
      return;
    }

    const inspected = inspectLocalImageFile(rawPath, rawBase);
    if (!inspected.ok) {
      this.sendJson(
        res,
        this.mapMediaErrorToHttpStatus(inspected.errorCode),
        { ok: false, error: inspected.error },
        req,
      );
      return;
    }

    const etag = `"${inspected.sizeBytes}-${Math.trunc(inspected.mtimeMs)}"`;
    this.applyCorsHeaders(res);

    const commonHeaders: http.OutgoingHttpHeaders = {
      "Content-Type": inspected.mimeType,
      "Content-Disposition": "inline",
      "Cache-Control": "private, max-age=300",
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    };

    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, commonHeaders);
      res.end();
      return;
    }

    res.writeHead(200, {
      ...commonHeaders,
      "Content-Length": inspected.sizeBytes,
    });

    if (method === "HEAD") {
      res.end();
      return;
    }

    const stream = fs.createReadStream(inspected.realPath);
    stream.on("error", () => {
      if (!res.headersSent) {
        this.sendJson(res, 500, { ok: false, error: "Failed to stream image file" }, req);
      } else {
        res.destroy();
      }
    });
    res.on("close", () => {
      if (!stream.destroyed) {
        stream.destroy();
      }
    });
    stream.pipe(res);
  }

  private handleLocalVideoMedia(
    method: string,
    parsedUrl: URL,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const rawPath = parsedUrl.searchParams.get("path")?.trim() ?? "";
    const rawBase = parsedUrl.searchParams.get("base")?.trim() || undefined;
    if (!rawPath) {
      this.sendJson(res, 400, { ok: false, error: "path query parameter is required" }, req);
      return;
    }

    const inspected = inspectLocalVideoFile(rawPath, rawBase);
    if (!inspected.ok) {
      this.sendJson(
        res,
        this.mapMediaErrorToHttpStatus(inspected.errorCode),
        { ok: false, error: inspected.error },
        req,
      );
      return;
    }

    const fileSize = inspected.sizeBytes;
    const etag = `"${fileSize}-${Math.trunc(inspected.mtimeMs)}"`;
    this.applyCorsHeaders(res);

    const commonHeaders: http.OutgoingHttpHeaders = {
      "Content-Type": inspected.playbackContentType,
      "Accept-Ranges": "bytes",
      "Content-Disposition": "inline",
      "Cache-Control": "private, max-age=300",
      ETag: etag,
      Vary: "Range",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    };

    const rawRangeHeader = typeof req.headers.range === "string" ? req.headers.range.trim() : "";
    const rawIfRange = typeof req.headers["if-range"] === "string" ? req.headers["if-range"].trim() : "";
    const ifRangeAllowsPartial = !rawIfRange || rawIfRange === etag;

    if (!rawRangeHeader && req.headers["if-none-match"] === etag) {
      res.writeHead(304, commonHeaders);
      res.end();
      return;
    }

    const parsedRange =
      rawRangeHeader && ifRangeAllowsPartial
        ? parseHttpByteRange(rawRangeHeader, fileSize)
        : null;

    if (parsedRange === "invalid") {
      res.writeHead(416, {
        ...commonHeaders,
        "Content-Range": `bytes */${fileSize}`,
        "Content-Length": 0,
      });
      res.end();
      return;
    }

    if (parsedRange) {
      const { start, end } = parsedRange;
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        ...commonHeaders,
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Content-Length": chunkSize,
      });
      if (method === "HEAD") {
        res.end();
        return;
      }
      const stream = fs.createReadStream(inspected.realPath, { start, end });
      stream.on("error", () => {
        if (!res.headersSent) {
          this.sendJson(res, 500, { ok: false, error: "Failed to stream video file" }, req);
        } else {
          res.destroy();
        }
      });
      res.on("close", () => {
        if (!stream.destroyed) {
          stream.destroy();
        }
      });
      stream.pipe(res);
      return;
    }

    res.writeHead(200, {
      ...commonHeaders,
      "Content-Length": fileSize,
    });
    if (method === "HEAD" || fileSize === 0) {
      res.end();
      return;
    }

    const stream = fs.createReadStream(inspected.realPath);
    stream.on("error", () => {
      if (!res.headersSent) {
        this.sendJson(res, 500, { ok: false, error: "Failed to stream video file" }, req);
      } else {
        res.destroy();
      }
    });
    res.on("close", () => {
      if (!stream.destroyed) {
        stream.destroy();
      }
    });
    stream.pipe(res);
  }

  private handleSseStream(req: http.IncomingMessage, res: http.ServerResponse): void {
    req.socket?.setNoDelay(true);
    req.socket?.setKeepAlive(true, this.sseHeartbeatIntervalMs);
    res.setTimeout(0);

    this.applyCorsHeaders(res);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    let cleaned = false;
    const onDrain = () => {
      client.waitingDrain = false;
      const nextFrame = client.pendingFrame;
      client.pendingFrame = null;
      if (nextFrame !== null && !cleaned) {
        this.writeSseFrame(client, nextFrame, client.lastSentJson);
      }
    };

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      client.pendingFrame = null;
      res.off("drain", onDrain);
      res.off("close", cleanup);
      res.off("error", cleanup);
      req.off("error", cleanup);
      this.removeSseClient(client);
    };

    const client: SseClientState = {
      res,
      waitingDrain: false,
      pendingFrame: null,
      lastSentJson: null,
      cleanup,
    };

    res.on("drain", onDrain);
    res.on("close", cleanup);
    res.on("error", cleanup);
    req.on("error", cleanup);

    this.sseClients.add(client);

    // Send initial snapshot immediately before notifying onClientsChanged,
    // so the subsequent desktop broadcast deduplicates against client.lastSentJson.
    try {
      this.controller.syncExternalState?.();
      const snapshot = this.controller.getSnapshot();
      const json = JSON.stringify(buildRemoteSnapshot(snapshot));
      const frame = `event: snapshot\ndata: ${json}\n\n`;
      this.writeSseFrame(client, frame, json);
    } catch {
      cleanup();
      try {
        res.end();
      } catch {
        // ignore
      }
      return;
    }

    if (!cleaned) {
      this.onClientsChanged?.(this.sseClients.size);
    }
  }

  private closeAllTerminalWsClients(code: number, reason: string): void {
    for (const client of [...this.terminalWsClients]) {
      try {
        client.ws.close(code, reason);
      } catch {
        // ignore
      }
      client.cleanup();
    }
    this.terminalWsClients.clear();
  }

  private handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    } catch {
      writeHttpUpgradeError(socket, 400, "Bad Request");
      return;
    }

    if (parsedUrl.pathname !== "/api/terminal/ws") {
      writeHttpUpgradeError(socket, 404, "Not Found");
      return;
    }

    if (!this.isAuthorized(req, parsedUrl, true)) {
      writeHttpUpgradeError(
        socket,
        401,
        "Unauthorized",
        JSON.stringify({ ok: false, error: "Unauthorized" }),
      );
      return;
    }

    this.handleTerminalWebSocket(req, socket, head, parsedUrl);
  }

  private handleTerminalWebSocket(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    parsedUrl: URL,
  ): void {
    const parseOptionalInt = (raw: string | null): number | undefined => {
      if (raw === null) return undefined;
      const trimmed = raw.trim();
      if (!/^\d+$/.test(trimmed)) return undefined;
      return Number(trimmed);
    };

    const initialSessionId = parsedUrl.searchParams.get("sessionId")?.trim() || null;
    const initialProjectPath = parsedUrl.searchParams.get("projectPath")?.trim() || null;
    const initialCwd = parsedUrl.searchParams.get("cwd")?.trim() || null;
    const initialCols = parseOptionalInt(parsedUrl.searchParams.get("cols"));
    const initialRows = parseOptionalInt(parsedUrl.searchParams.get("rows"));
    const initialAfterSeq = parseOptionalInt(parsedUrl.searchParams.get("afterSeq"));

    let clientState: TerminalWsClientState | null = null;
    let cleaned = false;

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (clientState) {
        clientState.unsubscribe();
        clientState.unsubscribe = () => {};
        this.terminalWsClients.delete(clientState);
      }
    };

    const attachSession = (
      ws: RemoteWebSocketConnection,
      options: {
        sessionId?: string | null;
        projectPath?: string | null;
        cwd?: string | null;
        cols?: number;
        rows?: number;
        afterSeq?: number;
        forceCreate?: boolean;
      },
    ) => {
      if (!clientState || !ws.isOpen()) return;
      clientState.unsubscribe();
      clientState.unsubscribe = () => {};

      const resolved = options.forceCreate
        ? (() => {
            const created = this.remoteTerminal.createSession({
              projectPath: options.projectPath,
              cwd: options.cwd,
              cols: options.cols,
              rows: options.rows,
            });
            return created.ok
              ? { ok: true as const, session: created.session, recreated: false }
              : created;
          })()
        : this.remoteTerminal.getOrCreateSession({
            sessionId: options.sessionId,
            projectPath: options.projectPath,
            cwd: options.cwd,
            cols: options.cols,
            rows: options.rows,
          });

      if (!resolved.ok) {
        ws.sendJson({ type: "error", message: resolved.error });
        return;
      }

      const session = resolved.session;
      clientState.sessionId = session.id;
      clientState.projectPath = session.projectPath;

      const replay = this.remoteTerminal.getReplay(
        session.id,
        resolved.recreated ? undefined : options.afterSeq,
      );

      clientState.unsubscribe = this.remoteTerminal.subscribe(session.id, {
        onData: (ev) => {
          ws.sendJson({
            type: "output",
            sessionId: ev.sessionId,
            data: ev.data,
            seq: ev.seq,
          });
        },
        onExit: (ev) => {
          ws.sendJson({
            type: "exit",
            sessionId: ev.sessionId,
            exitCode: ev.exitCode,
            signal: ev.signal,
          });
        },
      });

      ws.sendJson({
        type: "ready",
        session,
        replay: replay?.replay ?? "",
        seq: replay?.seq ?? 0,
        replayMode: replay?.replayMode ?? "full",
        recreated: resolved.recreated,
      });
    };

    const ws = RemoteWebSocketConnection.acceptUpgrade(req, socket, head, {
      onMessage: (text) => {
        if (!clientState) return;
        let msg: Record<string, unknown>;
        try {
          const parsed = JSON.parse(text) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            ws?.sendJson({ type: "error", message: "Message must be a JSON object" });
            return;
          }
          msg = parsed as Record<string, unknown>;
        } catch {
          ws?.sendJson({ type: "error", message: "Invalid JSON message" });
          return;
        }

        const type = typeof msg.type === "string" ? msg.type.trim() : "";
        if (type === "ping") {
          ws?.sendJson({
            type: "pong",
            ts: typeof msg.ts === "number" ? msg.ts : Date.now(),
          });
          return;
        }

        if (type === "input") {
          const data = typeof msg.data === "string" ? msg.data : "";
          const sid = clientState.sessionId;
          if (!sid) {
            ws?.sendJson({ type: "error", message: "No active terminal session" });
            return;
          }
          if (!data) return;
          const res = this.remoteTerminal.write(sid, data);
          if (!res.ok) {
            ws?.sendJson({ type: "error", message: res.error ?? "Failed to write to terminal" });
          }
          return;
        }

        if (type === "resize") {
          const sid = clientState.sessionId;
          const cols = typeof msg.cols === "number" ? msg.cols : Number(msg.cols);
          const rows = typeof msg.rows === "number" ? msg.rows : Number(msg.rows);
          if (!sid || !Number.isFinite(cols) || !Number.isFinite(rows)) {
            return;
          }
          const res = this.remoteTerminal.resize(sid, cols, rows);
          if (!res.ok) {
            ws?.sendJson({ type: "error", message: res.error });
          }
          return;
        }

        if (type === "restart") {
          const prevSessionId = clientState.sessionId;
          const hasExplicitProjectPath = Object.prototype.hasOwnProperty.call(msg, "projectPath");
          const nextProjectPath = hasExplicitProjectPath
            ? typeof msg.projectPath === "string" && msg.projectPath.trim().length > 0
              ? msg.projectPath.trim()
              : null
            : clientState.projectPath;
          const nextCwd =
            typeof msg.cwd === "string" && msg.cwd.trim().length > 0 ? msg.cwd.trim() : null;
          const cols =
            typeof msg.cols === "number" && Number.isFinite(msg.cols) ? msg.cols : undefined;
          const rows =
            typeof msg.rows === "number" && Number.isFinite(msg.rows) ? msg.rows : undefined;

          clientState.unsubscribe();
          clientState.unsubscribe = () => {};
          if (prevSessionId) {
            this.remoteTerminal.closeSession(prevSessionId);
          }

          if (ws) {
            attachSession(ws, {
              projectPath: nextProjectPath,
              cwd: nextCwd,
              cols,
              rows,
              forceCreate: true,
            });
          }
          return;
        }

        if (type === "close") {
          const sid = clientState.sessionId;
          clientState.unsubscribe();
          clientState.unsubscribe = () => {};
          clientState.sessionId = null;
          if (sid) {
            this.remoteTerminal.closeSession(sid);
            ws?.sendJson({
              type: "exit",
              sessionId: sid,
              exitCode: 0,
              signal: null,
            });
          }
          return;
        }

        ws?.sendJson({ type: "error", message: `Unknown message type: ${type || "(empty)"}` });
      },
      onClose: () => {
        cleanup();
      },
    });

    if (!ws) {
      return;
    }

    clientState = {
      ws,
      sessionId: null,
      projectPath: initialProjectPath,
      unsubscribe: () => {},
      cleanup,
    };
    this.terminalWsClients.add(clientState);

    attachSession(ws, {
      sessionId: initialSessionId,
      projectPath: initialProjectPath,
      cwd: initialCwd,
      cols: initialCols,
      rows: initialRows,
      afterSeq: initialAfterSeq,
      forceCreate: false,
    });
  }
}

export function renderMobileFallbackHtml(): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" />
  <title>Conductor Remote</title>
  <style>
    :root {
      --bg: #0f1115;
      --surface: #161a22;
      --surface2: #1f2430;
      --surface3: #12151c;
      --border: #2a3040;
      --border-soft: rgba(148, 163, 184, 0.16);
      --text: #f4f4f6;
      --text-secondary: #d4d8e2;
      --muted: #9ca3af;
      --accent: #6366f1;
      --accent-soft: rgba(99, 102, 241, 0.16);
      --accent-border: rgba(99, 102, 241, 0.36);
      --ok: #10b981;
      --ok-soft: rgba(16, 185, 129, 0.15);
      --ok-border: rgba(16, 185, 129, 0.35);
      --warn: #f59e0b;
      --warn-soft: rgba(245, 158, 11, 0.16);
      --warn-border: rgba(245, 158, 11, 0.36);
      --err: #ef4444;
      --err-soft: rgba(239, 68, 68, 0.15);
      --err-border: rgba(239, 68, 68, 0.36);
      --sky: #38bdf8;
      --sky-soft: rgba(56, 189, 248, 0.15);
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0; padding: 0; height: 100%; width: 100%;
      background: var(--bg); color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Hiragino Sans", sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    body { display: flex; flex-direction: column; overflow: hidden; }
    header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 14px; background: var(--surface);
      border-bottom: 1px solid var(--border); gap: 8px; flex-shrink: 0;
    }
    .brand { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 15px; min-width: 0; }
    .dot { width: 9px; height: 9px; border-radius: 99px; background: var(--muted); display: inline-block; flex-shrink: 0; }
    .dot.live { background: var(--ok); box-shadow: 0 0 8px var(--ok); }
    .dot.warn { background: var(--warn); }
    .dot.err { background: var(--err); }
    .spinner {
      width: 13px; height: 13px; border-radius: 99px;
      border: 2px solid rgba(165, 180, 252, 0.25);
      border-top-color: #818cf8;
      animation: spin 0.8s linear infinite;
      display: inline-block; flex-shrink: 0;
    }
    .live-pulse {
      width: 7px; height: 7px; border-radius: 99px; background: #818cf8;
      display: inline-block; flex-shrink: 0;
      animation: pulse 1.3s ease-in-out infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.85); } }
    .btn {
      border: 1px solid var(--border); background: var(--surface2); color: var(--text);
      border-radius: 10px; padding: 7px 11px; font-size: 12.5px; font-weight: 600;
      cursor: pointer; display: inline-flex; align-items: center; gap: 5px;
      white-space: nowrap;
    }
    .btn.sm { padding: 5px 9px; font-size: 11.5px; border-radius: 8px; }
    .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    .btn.danger { background: var(--err-soft); border-color: var(--err-border); color: #fca5a5; }
    .btn.ok { background: var(--ok-soft); border-color: var(--ok-border); color: #6ee7b7; }
    .btn.warn { background: var(--warn-soft); border-color: var(--warn-border); color: #fcd34d; }
    .btn:disabled { opacity: .45; cursor: not-allowed; }
    .tabs {
      display: flex; background: var(--surface); border-top: 1px solid var(--border);
      padding-bottom: env(safe-area-inset-bottom, 0px); flex-shrink: 0;
    }
    .tab {
      flex: 1; padding: 11px 6px; text-align: center; font-size: 12.5px; font-weight: 600;
      color: var(--muted); background: none; border: none; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center; gap: 5px;
    }
    .tab.active { color: #a5b4fc; border-top: 2px solid var(--accent); }
    .tab-badge {
      background: var(--accent); color: #fff; font-size: 10px; font-weight: 700;
      padding: 1px 6px; border-radius: 99px; line-height: 1.4;
    }
    main { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; position: relative; }
    .view { display: none; flex: 1; min-height: 0; overflow: hidden; flex-direction: column; }
    .view.active { display: flex; }
    .scroll {
      flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch;
      padding: 12px 14px; display: flex; flex-direction: column; gap: 10px;
    }
    .scroll > *, .sheet-body > * { flex-shrink: 0; }
    .msg {
      max-width: 92%; padding: 10px 12px; border-radius: 14px;
      font-size: 13.5px; line-height: 1.55; word-break: break-word;
    }
    .msg.user { align-self: flex-end; background: var(--accent); color: #fff; border-bottom-right-radius: 4px; white-space: pre-wrap; }
    .msg.assistant { align-self: flex-start; background: var(--surface2); border: 1px solid var(--border); border-bottom-left-radius: 4px; width: 100%; max-width: 96%; }
    .msg.system, .msg.taskEvent {
      align-self: stretch; max-width: 100%; background: var(--surface);
      border: 1px solid var(--border); font-size: 12.5px; color: var(--text-secondary);
    }
    .msg.taskEvent.clickable { cursor: pointer; border-color: var(--accent-border); }
    .meta { font-size: 11px; color: var(--muted); margin-bottom: 5px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .chip {
      display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600;
      padding: 2px 8px; border-radius: 99px; background: var(--accent-soft); color: #c7d2fe;
      max-width: 100%;
    }
    .chip.code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; border-radius: 6px; border: 1px solid var(--accent-border); }
    .chip.neutral { background: rgba(148,163,184,0.14); color: var(--text-secondary); }
    .chip.running { background: var(--accent-soft); color: #a5b4fc; border: 1px solid var(--accent-border); }
    .chip.needs_review { background: var(--warn-soft); color: #fcd34d; border: 1px solid var(--warn-border); }
    .chip.done { background: var(--ok-soft); color: #6ee7b7; border: 1px solid var(--ok-border); }
    .chip.failed { background: var(--err-soft); color: #fca5a5; border: 1px solid var(--err-border); }
    .chip.queued { background: rgba(148,163,184,0.15); color: var(--muted); }
    .chip.warn { background: var(--warn-soft); color: #fcd34d; border: 1px solid var(--warn-border); }
    .chip.ok { background: var(--ok-soft); color: #6ee7b7; border: 1px solid var(--ok-border); }
    .chip.err { background: var(--err-soft); color: #fca5a5; border: 1px solid var(--err-border); }
    .composer-wrap {
      border-top: 1px solid var(--border); background: var(--surface); padding: 8px 10px;
      display: flex; flex-direction: column; gap: 6px; flex-shrink: 0;
    }
    .mentions-bar { display: flex; flex-wrap: wrap; gap: 6px; }
    .composer { display: flex; gap: 6px; align-items: flex-end; }
    textarea, input {
      width: 100%; background: var(--bg); color: var(--text);
      border: 1px solid var(--border); border-radius: 10px;
      padding: 9px 11px; font-size: 14px; font-family: inherit; outline: none;
    }
    textarea:focus, input:focus { border-color: var(--accent); }
    .tasks-toolbar {
      padding: 10px 14px; background: var(--surface); border-bottom: 1px solid var(--border);
      display: flex; flex-direction: column; gap: 8px; flex-shrink: 0;
    }
    .pill-row { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 2px; }
    .pill-row::-webkit-scrollbar { display: none; }
    .filter-pill {
      border: 1px solid var(--border); background: var(--surface2); color: var(--muted);
      border-radius: 99px; padding: 4px 10px; font-size: 11.5px; font-weight: 600;
      cursor: pointer; white-space: nowrap; display: inline-flex; align-items: center; gap: 5px;
    }
    .filter-pill.active { background: var(--accent-soft); border-color: var(--accent-border); color: #e0e7ff; }
    .card {
      background: var(--surface); border: 1px solid var(--border); border-radius: 14px;
      padding: 12px; display: flex; flex-direction: column; gap: 7px;
    }
    .card.task-card { cursor: pointer; transition: border-color 0.15s ease; }
    .card.task-card:active { border-color: var(--accent); }
    .card.task-card.running { border-color: var(--accent-border); }
    .task-title { font-size: 14px; font-weight: 650; line-height: 1.4; color: var(--text); word-break: break-word; }
    .task-step-line {
      font-size: 12px; color: var(--text-secondary); display: flex; align-items: center; gap: 6px;
      line-height: 1.4; word-break: break-word;
    }
    .task-preview-line {
      font-size: 11.5px; color: var(--muted); line-height: 1.45;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
      word-break: break-word;
    }
    .group-title {
      font-size: 11.5px; font-weight: 700; color: var(--muted);
      letter-spacing: .04em; margin-top: 4px; display: flex; align-items: center; gap: 6px;
    }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    .row-left { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
    .toast {
      position: fixed; top: 58px; left: 14px; right: 14px; z-index: 80;
      background: #1e293b; border: 1px solid var(--border); color: var(--text);
      padding: 10px 12px; border-radius: 10px; font-size: 12.5px; display: none;
      box-shadow: 0 10px 25px rgba(0,0,0,0.4);
    }
    .modal-bg {
      position: fixed; inset: 0; background: rgba(0,0,0,.7); z-index: 50;
      display: none; align-items: flex-end; justify-content: center;
    }
    .modal-bg.open { display: flex; }
    .sheet {
      width: 100%; max-width: 680px; max-height: 92vh; height: 88vh;
      background: var(--surface); border-top-left-radius: 18px; border-top-right-radius: 18px;
      border-top: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden;
    }
    .sheet.compact { height: auto; max-height: 75vh; }
    .sheet-header {
      padding: 12px 14px; border-bottom: 1px solid var(--border);
      background: var(--surface); display: flex; flex-direction: column; gap: 8px; flex-shrink: 0;
    }
    .sheet-body {
      flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch;
      padding: 14px; display: flex; flex-direction: column; gap: 12px;
      padding-bottom: calc(20px + env(safe-area-inset-bottom, 0px));
    }
    .section-label {
      font-size: 11px; font-weight: 700; color: var(--muted); text-transform: uppercase;
      letter-spacing: 0.05em; display: flex; align-items: center; justify-content: space-between; gap: 8px;
    }
    .step-banner {
      background: var(--accent-soft); border: 1px solid var(--accent-border);
      border-radius: 12px; padding: 10px 12px; display: flex; flex-direction: column; gap: 5px;
    }
    .step-banner.error { background: var(--err-soft); border-color: var(--err-border); }
    .step-banner.done { background: var(--ok-soft); border-color: var(--ok-border); }
    .step-banner-main { display: flex; align-items: center; gap: 8px; font-size: 12.5px; font-weight: 600; color: #e0e7ff; }
    .step-banner.error .step-banner-main { color: #fecaca; }
    .step-banner.done .step-banner-main { color: #a7f3d0; }
    .step-banner-sub { font-size: 11px; color: var(--muted); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .panel-box {
      background: var(--surface3); border: 1px solid var(--border); border-radius: 12px;
      padding: 12px; display: flex; flex-direction: column; gap: 8px;
    }
    .activity-item {
      border-radius: 10px; border: 1px solid var(--border); padding: 9px 11px;
      background: var(--surface2); display: flex; flex-direction: column; gap: 5px;
    }
    .activity-item.error { background: var(--err-soft); border-color: var(--err-border); }
    .activity-item.message { background: rgba(99, 102, 241, 0.09); border-color: var(--accent-border); }
    .activity-item.system { background: rgba(56, 189, 248, 0.08); border-color: rgba(56, 189, 248, 0.25); }
    .activity-item.file { background: rgba(16, 185, 129, 0.08); border-color: rgba(16, 185, 129, 0.25); }
    .activity-head {
      display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;
      font-size: 12px; font-weight: 600; color: var(--text); word-break: break-word;
    }
    .activity-time { font-size: 10.5px; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; flex-shrink: 0; }
    .tool-log-box {
      border: 1px solid var(--border); border-radius: 12px; background: var(--surface3); overflow: hidden;
    }
    .tool-log-toggle {
      width: 100%; background: none; border: none; color: var(--text-secondary);
      padding: 10px 12px; display: flex; align-items: center; justify-content: space-between; gap: 8px;
      font-size: 12px; font-weight: 600; cursor: pointer; text-align: left;
    }
    .tool-log-toggle:hover { background: rgba(255,255,255,0.03); }
    .tool-log-list {
      border-top: 1px solid var(--border); max-height: 360px; overflow-y: auto; -webkit-overflow-scrolling: touch;
    }
    .tool-log-item {
      padding: 9px 11px; border-bottom: 1px solid var(--border-soft);
      display: flex; flex-direction: column; gap: 4px;
    }
    .tool-log-item:last-child { border-bottom: none; }
    .tool-log-title {
      display: flex; align-items: flex-start; gap: 6px; font-size: 11.5px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--text);
      word-break: break-word;
    }
    .tool-log-idx { color: var(--muted); font-size: 10.5px; flex-shrink: 0; }
    pre {
      margin: 0; background: var(--bg); border: 1px solid var(--border); border-radius: 9px;
      padding: 9px 10px; font-size: 11.5px; line-height: 1.5;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      overflow-x: auto; white-space: pre-wrap; word-break: break-word; color: var(--text-secondary);
    }
    .md-body { display: flex; flex-direction: column; gap: 8px; white-space: normal; }
    .md-text { white-space: pre-wrap; word-break: break-word; }
    .md-code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px; background: rgba(0,0,0,.28); padding: 1px 5px; border-radius: 5px;
    }
    .media-card {
      background: var(--bg); border: 1px solid var(--border); border-radius: 12px;
      overflow: hidden; margin-top: 4px; margin-bottom: 4px; max-width: 100%;
    }
    .media-img-wrap { position: relative; background: #090b10; display: flex; justify-content: center; cursor: zoom-in; }
    .media-img {
      display: block; max-width: 100%; max-height: 300px; width: auto; height: auto; object-fit: contain;
    }
    .media-video {
      display: block; width: 100%; max-height: 280px; background: #000;
    }
    .media-footer {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 7px 10px; background: var(--surface); border-top: 1px solid var(--border);
      font-size: 11.5px; color: var(--muted);
    }
    .media-caption { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1; }
    .media-caption-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); font-weight: 500; }
    .media-badge {
      font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 6px;
      background: var(--accent-soft); color: #c7d2fe; flex-shrink: 0;
    }
    .media-btn {
      border: 1px solid var(--border); background: var(--surface2); color: var(--text);
      border-radius: 7px; padding: 4px 8px; font-size: 11px; font-weight: 600;
      cursor: pointer; flex-shrink: 0;
    }
    .media-error {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 9px 10px; border-radius: 10px;
      background: rgba(239,68,68,.12); border: 1px solid rgba(239,68,68,.35);
      color: #fca5a5; font-size: 12px;
    }
    .att-grid { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
    .att-thumb {
      width: 112px; height: 84px; object-fit: cover; border-radius: 9px;
      border: 1px solid var(--border); background: #090b10; cursor: zoom-in;
    }
    .lightbox-bg {
      position: fixed; inset: 0; z-index: 90; background: rgba(6,8,12,.94);
      display: none; flex-direction: column;
    }
    .lightbox-bg.open { display: flex; }
    .lightbox-head {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      padding: 12px 14px; background: rgba(15,17,21,.9); border-bottom: 1px solid var(--border);
    }
    .lightbox-title {
      font-size: 13.5px; font-weight: 600; color: var(--text);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;
    }
    .lightbox-stage {
      flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center;
      padding: 12px; overflow: hidden;
    }
    .lightbox-stage img {
      max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 8px;
    }
    .lightbox-stage video {
      max-width: 100%; max-height: 100%; width: 100%; background: #000; border-radius: 8px;
    }
    .detail-pre { max-height: 180px; overflow-y: auto; font-size: 11px; }
    .md { font-size: 13.5px; line-height: 1.6; color: var(--text); word-break: break-word; }
    .md > *:first-child { margin-top: 0; }
    .md > *:last-child { margin-bottom: 0; }
    .md h1, .md h2, .md h3, .md h4 { margin: 12px 0 6px; line-height: 1.35; color: var(--text); }
    .md h1 { font-size: 17px; border-bottom: 1px solid var(--border); padding-bottom: 4px; }
    .md h2 { font-size: 15.5px; border-bottom: 1px solid var(--border-soft); padding-bottom: 3px; }
    .md h3 { font-size: 14px; }
    .md p { margin: 6px 0; }
    .md ul, .md ol { margin: 6px 0; padding-left: 20px; }
    .md li { margin: 3px 0; }
    .md blockquote {
      margin: 8px 0; padding: 6px 10px; border-left: 3px solid var(--accent);
      background: rgba(99, 102, 241, 0.08); border-radius: 0 8px 8px 0; color: var(--text-secondary);
    }
    .md code {
      background: rgba(148,163,184,0.16); padding: 1px 5px; border-radius: 5px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
    }
    .md pre { margin: 8px 0; }
    .md pre code { background: none; padding: 0; font-size: 11.5px; }
    .md a { color: #93c5fd; text-decoration: underline; word-break: break-all; }
    .md hr { border: none; border-top: 1px solid var(--border); margin: 10px 0; }
    .md-table-wrap { overflow-x: auto; margin: 8px 0; border: 1px solid var(--border); border-radius: 8px; }
    .md table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .md th, .md td { padding: 6px 8px; border-bottom: 1px solid var(--border-soft); text-align: left; }
    .md th { background: var(--surface2); font-weight: 600; }
    .md-media-card {
      margin: 8px 0; border: 1px solid var(--border); border-radius: 10px;
      overflow: hidden; background: var(--bg);
    }
    .md-media-card img {
      display: block; width: 100%; max-height: 320px; object-fit: contain;
      background: #090b10; cursor: zoom-in;
    }
    .md-media-card video {
      display: block; width: 100%; max-height: 340px; background: #000;
    }
    .md-media-caption {
      padding: 6px 10px; font-size: 11px; color: var(--muted);
      border-top: 1px solid var(--border-soft); word-break: break-all;
    }
    .md-media-loading {
      padding: 12px; font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 8px;
    }
    .tool-chips-row { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 6px; }
    .tool-chip {
      font-size: 11px; padding: 2px 7px; border-radius: 99px;
      background: rgba(148,163,184,0.12); border: 1px solid var(--border);
      color: var(--text-secondary); display: inline-flex; align-items: center; gap: 4px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .tool-chip.err { background: var(--err-soft); border-color: var(--err-border); color: #fca5a5; }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <span id="connDot" class="dot"></span>
      <span>Conductor Remote</span>
    </div>
    <div style="display:flex;gap:6px;">
      <button id="stopAllBtn" class="btn sm danger" style="display:none;" onclick="stopAll()">停止</button>
      <button id="newChatBtn" class="btn sm" style="display:none;" onclick="newChat()">新規</button>
    </div>
  </header>

  <div id="toast" class="toast"></div>

  <main>
    <!-- Auth / Connect View -->
    <section id="view-auth" class="view active">
      <div class="scroll">
        <div class="card">
          <div style="font-size:15px;font-weight:700;">Conductor に接続</div>
          <div style="font-size:12.5px;color:var(--muted);">
            デスクトップの Conductor 設定 → Remote Access に表示されている Bearer Token または <code>conductor://connect?...</code> URI を貼り付けてください。
          </div>
          <label style="font-size:12px;color:var(--muted);">接続 URI (任意・一括貼り付け)</label>
          <input id="uriInput" placeholder="conductor://connect?url=...&token=..." oninput="handleUriPaste(this.value)" />
          <label style="font-size:12px;color:var(--muted);">Bearer Token</label>
          <input id="tokenInput" type="password" placeholder="トークンを入力" />
          <button class="btn primary" style="justify-content:center;padding:11px;" onclick="connectWithToken()">接続する</button>
        </div>
      </div>
    </section>

    <!-- Chat View -->
    <section id="view-chat" class="view">
      <div id="chatScroll" class="scroll"></div>
      <div class="composer-wrap">
        <div id="selectedMentions" class="mentions-bar"></div>
        <div class="composer">
          <button class="btn" onclick="openMentionSheet()">@</button>
          <textarea id="composerInput" rows="1" placeholder="メッセージを入力..."></textarea>
          <button class="btn primary" onclick="sendChat()">送信</button>
        </div>
      </div>
    </section>

    <!-- Tasks View -->
    <section id="view-tasks" class="view">
      <div class="tasks-toolbar">
        <input id="taskSearchInput" placeholder="タスク名・T#・プロジェクトを検索..." oninput="setTaskSearch(this.value)" style="padding:7px 10px;font-size:13px;" />
        <div id="taskProjectPills" class="pill-row"></div>
      </div>
      <div id="tasksScroll" class="scroll"></div>
    </section>

    <!-- Settings View -->
    <section id="view-settings" class="view">
      <div class="scroll">
        <div class="card">
          <div style="font-size:14px;font-weight:700;">接続ステータス</div>
          <div id="settingsStatus" style="font-size:12.5px;color:var(--muted);">未接続</div>
          <div class="row" style="margin-top:6px;">
            <button class="btn" onclick="reconnect()">再接続</button>
            <button class="btn danger" onclick="disconnect()">切断 / トークン変更</button>
          </div>
        </div>
      </div>
    </section>
  </main>

  <nav id="bottomNav" class="tabs" style="display:none;">
    <button class="tab active" data-tab="chat" onclick="switchTab('chat')">チャット</button>
    <button class="tab" data-tab="tasks" onclick="switchTab('tasks')">タスク <span id="tasksTabBadge" class="tab-badge" style="display:none;"></span></button>
    <button class="tab" data-tab="settings" onclick="switchTab('settings')">設定</button>
  </nav>

  <!-- Mention Picker Modal -->
  <div id="mentionModal" class="modal-bg" onclick="closeMentionSheet()">
    <div class="sheet compact" onclick="event.stopPropagation()">
      <div class="sheet-header">
        <div class="row">
          <strong>@ メンションを追加</strong>
          <button class="btn sm" onclick="closeMentionSheet()">閉じる</button>
        </div>
      </div>
      <div class="sheet-body">
        <div id="mentionList" style="display:flex;flex-direction:column;gap:6px;"></div>
      </div>
    </div>
  </div>

  <!-- Task Detail Modal -->
  <div id="taskModal" class="modal-bg" onclick="closeTaskSheet()">
    <div id="taskSheetShell" class="sheet" onclick="event.stopPropagation()"></div>
  </div>

  <!-- Media Lightbox Modal (Image & Video) -->
  <div id="mediaLightbox" class="lightbox-bg" onclick="closeMediaLightbox()">
    <div class="lightbox-head" onclick="event.stopPropagation()">
      <div id="mediaLightboxTitle" class="lightbox-title">メディア</div>
      <button class="btn sm" onclick="closeMediaLightbox()">閉じる</button>
    </div>
    <div id="mediaLightboxStage" class="lightbox-stage" onclick="event.stopPropagation()"></div>
  </div>

  <script>
    const TOKEN_KEY = "conductor_remote_token";
    let token = localStorage.getItem(TOKEN_KEY) || "";
    let snapshot = null;
    let eventSource = null;
    let pollTimer = null;
    let openTaskPollTimer = null;
    let taskDetailThrottleTimer = null;
    let currentTab = "chat";
    let selectedMentions = [];
    let openTaskId = null;
    let activeLightboxSourceVideo = null;
    let taskSearchQuery = "";
    let selectedProjectFilter = null;
    const taskDetailCache = new Map();
    const taskUiPrefs = new Map();
    const mediaBlobCache = new Map();
    const mediaInFlight = new Map();

    function esc(s) {
      return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }

    function escAttr(s) {
      return esc(s);
    }

    function isVideoSrc(raw) {
      const t = String(raw || "").trim();
      if (!t) return false;
      if (/^data:video\\//i.test(t)) return true;
      const cleaned = t.split("#")[0].split("?")[0];
      return /\\.(?:mp4|webm|mov)$/i.test(cleaned);
    }

    function extractMediaFileName(raw) {
      const cleaned = String(raw || "").trim().split("#")[0].split("?")[0];
      const parts = cleaned.split(/[/\\\\]/);
      return parts[parts.length - 1] || cleaned || "media";
    }

    function extractVideoFormatBadge(raw) {
      const cleaned = String(raw || "").trim().split("#")[0].split("?")[0].toLowerCase();
      if (cleaned.endsWith(".mp4")) return "MP4";
      if (cleaned.endsWith(".webm")) return "WEBM";
      if (cleaned.endsWith(".mov")) return "MOV";
      return "VIDEO";
    }

    function resolveMediaUrl(rawSrc, basePath, isVideo) {
      const trimmed = String(rawSrc || "").trim();
      if (!trimmed) return { ok: false, error: "メディアパスが空です" };
      if (/^https?:\\/\\//i.test(trimmed)) return { ok: true, url: trimmed };
      if (/^\\/\\/[^/]/.test(trimmed)) return { ok: true, url: "https:" + trimmed };
      if (isVideo ? /^data:video\\/[a-z0-9.+-]+/i.test(trimmed) : /^data:image\\/[a-z0-9.+-]+/i.test(trimmed)) {
        return { ok: true, url: trimmed };
      }
      const isWinDrive = /^[a-zA-Z]:[\\\\/]/.test(trimmed);
      if (!isWinDrive && !/^file:\\/\\//i.test(trimmed) && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
        return { ok: false, error: "未対応の URL スキームです" };
      }
      const isLocalAbs = /^file:\\/\\//i.test(trimmed) || trimmed.startsWith("/") || trimmed.startsWith("~/") || trimmed.startsWith("~\\\\") || isWinDrive;
      const cleanBase = typeof basePath === "string" && basePath.trim() ? basePath.trim() : "";
      if (!isLocalAbs && !cleanBase) {
        return { ok: false, error: "相対パスのメディアを解決できません" };
      }
      const endpoint = isVideo ? "/api/media/video" : "/api/media/image";
      const params = new URLSearchParams({ path: trimmed });
      if (cleanBase) params.set("base", cleanBase);
      return { ok: true, url: endpoint + "?" + params.toString() };
    }

    function parseHtmlAttrs(attrBody) {
      const attrs = {};
      const re = /([a-zA-Z_:][\\w:.-]*)\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\\\`]+))/g;
      let m;
      while ((m = re.exec(attrBody)) !== null) {
        attrs[m[1].toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? "").trim();
      }
      return attrs;
    }

    function findDestEnd(text, openParenIdx) {
      let i = openParenIdx + 1;
      const n = text.length;
      while (i < n && /\\s/.test(text[i])) i++;
      if (i >= n) return -1;
      if (text[i] === "<") {
        const closeAngle = text.indexOf(">", i + 1);
        if (closeAngle < 0) return -1;
        let j = closeAngle + 1;
        while (j < n && text[j] !== ")" && text[j] !== "\\n") j++;
        return j < n && text[j] === ")" ? j : -1;
      }
      let depth = 0;
      let quote = null;
      while (i < n) {
        const ch = text[i];
        if (ch === "\\n") return -1;
        if (quote) {
          if (ch === "\\\\" && i + 1 < n) { i += 2; continue; }
          if (ch === quote) quote = null;
        } else if (ch === "\\\\" && i + 1 < n) {
          i += 2; continue;
        } else if (ch === '"' || ch === "'") {
          quote = ch;
        } else if (ch === "(") {
          depth++;
        } else if (ch === ")") {
          if (depth === 0) return i;
          depth--;
        }
        i++;
      }
      return -1;
    }

    function splitDestAndTitle(rawInner) {
      const trimmed = rawInner.trim();
      if (trimmed.startsWith("<")) {
        const closeAngle = trimmed.indexOf(">");
        if (closeAngle > 1) {
          return trimmed.slice(1, closeAngle).trim();
        }
      }
      const m = /^(.*?\\S)\\s+(?:"[^"\\r\\n]*"|'[^'\\r\\n]*')$/.exec(trimmed);
      return (m ? m[1] : trimmed).trim();
    }

    function renderVideoCardHtml(alt, rawSrc, basePath, poster) {
      const label = (alt || "").trim() || extractMediaFileName(rawSrc);
      const badge = extractVideoFormatBadge(rawSrc);
      const resolved = resolveMediaUrl(rawSrc, basePath, true);
      if (!resolved.ok) {
        return '<div class="media-error" data-testid="mobile-video-error"><span>' +
          esc(label) + ": " + esc(resolved.error) + "</span></div>";
      }
      const posterAttr = poster ? ' poster="' + escAttr(poster) + '"' : "";
      return '<div class="media-card video-card" data-media-type="video">' +
        '<video class="media-video" controls playsinline preload="metadata" src="' + escAttr(resolved.url) + '"' +
        posterAttr + ' data-caption="' + escAttr(label) + '" data-badge="' + escAttr(badge) + '" data-raw-src="' + escAttr(rawSrc) + '"' +
        ' onerror="handleMediaError(this, \\'video\\')"></video>' +
        '<div class="media-footer">' +
          '<div class="media-caption">' +
            '<span class="media-badge">' + esc(badge) + "</span>" +
            '<span class="media-caption-text" title="' + escAttr(label) + '">' + esc(label) + "</span>" +
          "</div>" +
          '<button type="button" class="media-btn" onclick="openVideoLightboxFromBtn(this)">全画面</button>' +
        "</div>" +
      "</div>";
    }

    function renderImageCardHtml(alt, rawSrc, basePath) {
      const label = (alt || "").trim() || extractMediaFileName(rawSrc);
      const resolved = resolveMediaUrl(rawSrc, basePath, false);
      if (!resolved.ok) {
        return '<div class="media-error" data-testid="mobile-image-error"><span>' +
          esc(label) + ": " + esc(resolved.error) + "</span></div>";
      }
      return '<div class="media-card image-card" data-media-type="image">' +
        '<div class="media-img-wrap" onclick="openImageLightboxFromCard(this)">' +
          '<img class="media-img" loading="lazy" src="' + escAttr(resolved.url) + '" alt="' + escAttr(label) + '"' +
          ' onerror="handleMediaError(this, \\'image\\')" />' +
        "</div>" +
        '<div class="media-footer">' +
          '<div class="media-caption"><span class="media-caption-text">' + esc(label) + "</span></div>" +
          '<button type="button" class="media-btn" onclick="openImageLightboxFromBtn(this)">拡大</button>' +
        "</div>" +
      "</div>";
    }

    function renderInlineChunkWithMedia(chunk, basePath) {
      const out = [];
      let textBuf = "";
      let i = 0;
      const n = chunk.length;

      function flushText() {
        if (!textBuf) return;
        const trimmed = textBuf;
        if (trimmed.trim()) {
          out.push('<div class="md-text">' + renderInlineTextFormatting(trimmed) + "</div>");
        }
        textBuf = "";
      }

      while (i < n) {
        if (chunk[i] === "\`") {
          const end = chunk.indexOf("\`", i + 1);
          if (end > i + 1) {
            textBuf += chunk.slice(i, end + 1);
            i = end + 1;
            continue;
          }
        }

        if (chunk[i] === "!" && i + 1 < n && chunk[i + 1] === "[") {
          const closeBracket = chunk.indexOf("]", i + 2);
          if (closeBracket > i + 1 && closeBracket + 1 < n && chunk[closeBracket + 1] === "(") {
            const closeParen = findDestEnd(chunk, closeBracket + 1);
            if (closeParen > closeBracket + 2) {
              const alt = chunk.slice(i + 2, closeBracket);
              const rawDest = splitDestAndTitle(chunk.slice(closeBracket + 2, closeParen));
              if (rawDest) {
                flushText();
                out.push(
                  isVideoSrc(rawDest)
                    ? renderVideoCardHtml(alt, rawDest, basePath, null)
                    : renderImageCardHtml(alt, rawDest, basePath),
                );
                i = closeParen + 1;
                continue;
              }
            }
          }
        }

        if (chunk[i] === "<" && /^<video\\b/i.test(chunk.slice(i))) {
          const slice = chunk.slice(i);
          const videoMatch = /^<video\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/video>)/i.exec(slice);
          if (videoMatch) {
            const attrs = parseHtmlAttrs(videoMatch[1] || "");
            let src = attrs.src || "";
            if (!src && videoMatch[2]) {
              const sourceMatch = /<source\\b([^>]*?)\\/?>/i.exec(videoMatch[2]);
              if (sourceMatch) {
                const sAttrs = parseHtmlAttrs(sourceMatch[1] || "");
                src = sAttrs.src || "";
              }
            }
            if (src) {
              flushText();
              const label = attrs["aria-label"] || attrs.title || attrs.alt || "";
              out.push(renderVideoCardHtml(label, src, basePath, attrs.poster || null));
              i += videoMatch[0].length;
              continue;
            }
          }
        }

        if (chunk[i] === "<" && /^<img\\b/i.test(chunk.slice(i))) {
          const slice = chunk.slice(i);
          const imgMatch = /^<img\\b([^>]*?)\\/?>/i.exec(slice);
          if (imgMatch) {
            const attrs = parseHtmlAttrs(imgMatch[1] || "");
            if (attrs.src) {
              flushText();
              out.push(
                isVideoSrc(attrs.src)
                  ? renderVideoCardHtml(attrs.alt || attrs.title || "", attrs.src, basePath, null)
                  : renderImageCardHtml(attrs.alt || attrs.title || "", attrs.src, basePath),
              );
              i += imgMatch[0].length;
              continue;
            }
          }
        }

        textBuf += chunk[i];
        i++;
      }

      flushText();
      return out.join("");
    }

    function renderInlineTextFormatting(text) {
      const parts = String(text || "").split(/(\`[^\`]+\`)/g);
      return parts.map((part, idx) => {
        if (idx % 2 === 1) {
          return '<code class="md-code">' + esc(part.slice(1, -1)) + "</code>";
        }
        return esc(part);
      }).join("");
    }

    function renderMarkdownRichHtml(markdown, basePath) {
      const raw = String(markdown || "");
      if (!raw) return "";
      const lines = raw.replace(/\\r\\n/g, "\\n").split("\\n");
      const out = [];
      let textLines = [];
      let i = 0;

      function flushProse() {
        if (textLines.length === 0) return;
        const joined = textLines.join("\\n");
        textLines = [];
        const rendered = renderInlineChunkWithMedia(joined, basePath);
        if (rendered) out.push(rendered);
      }

      while (i < lines.length) {
        const fenceMatch = /^\\s*(\`{3,}|~{3,})\\s*([A-Za-z0-9_+#.\\-]*)\\s*$/.exec(lines[i]);
        if (fenceMatch) {
          flushProse();
          const marker = fenceMatch[1];
          const ch = marker[0];
          const len = marker.length;
          i++;
          const codeLines = [];
          while (i < lines.length) {
            const ct = lines[i].trim();
            if (ct.length >= len && ct.split("").every((c) => c === ch)) {
              i++;
              break;
            }
            codeLines.push(lines[i]);
            i++;
          }
          out.push("<pre>" + esc(codeLines.join("\\n")) + "</pre>");
          continue;
        }
        textLines.push(lines[i]);
        i++;
      }
      flushProse();
      return '<div class="md-body">' + out.join("") + "</div>";
    }

    function handleMediaError(el, kind) {
      const card = el.closest(".media-card");
      if (!card) return;
      const caption = el.getAttribute("data-caption") || el.getAttribute("alt") || (kind === "video" ? "動画" : "画像");
      const badge = el.getAttribute("data-badge") || "VIDEO";
      const src = el.getAttribute("src") || "";
      card.innerHTML = '<div class="media-error"><span>' +
        esc(caption) + " の読み込みに失敗しました</span>" +
        '<button type="button" class="media-btn" data-retry-kind="' + escAttr(kind) + '" data-retry-src="' + escAttr(src) + '" data-retry-caption="' + escAttr(caption) + '" data-retry-badge="' + escAttr(badge) + '" onclick="retryMediaCard(this)">再試行</button>' +
      "</div>";
    }

    function retryMediaCard(btn) {
      const card = btn.closest(".media-card");
      const kind = btn.getAttribute("data-retry-kind") || "image";
      const src = btn.getAttribute("data-retry-src") || "";
      const caption = btn.getAttribute("data-retry-caption") || "";
      const badge = btn.getAttribute("data-retry-badge") || "VIDEO";
      if (!card || !src) return;
      const sep = src.includes("?") ? "&" : "?";
      const busted = src + sep + "_r=" + Date.now();
      if (kind === "video") {
        card.innerHTML = '<video class="media-video" controls playsinline preload="metadata" src="' + escAttr(busted) + '"' +
          ' data-caption="' + escAttr(caption) + '" data-badge="' + escAttr(badge) + '" onerror="handleMediaError(this, \\'video\\')"></video>' +
          '<div class="media-footer"><div class="media-caption"><span class="media-badge">' + esc(badge) + '</span>' +
          '<span class="media-caption-text">' + esc(caption) + '</span></div>' +
          '<button type="button" class="media-btn" onclick="openVideoLightboxFromBtn(this)">全画面</button></div>';
      } else {
        card.innerHTML = '<div class="media-img-wrap" onclick="openImageLightboxFromCard(this)">' +
          '<img class="media-img" src="' + escAttr(busted) + '" alt="' + escAttr(caption) + '" onerror="handleMediaError(this, \\'image\\')" />' +
          '</div><div class="media-footer"><div class="media-caption"><span class="media-caption-text">' + esc(caption) + '</span></div>' +
          '<button type="button" class="media-btn" onclick="openImageLightboxFromBtn(this)">拡大</button></div>';
      }
    }

    function openImageLightbox(src, title) {
      if (!src) return;
      activeLightboxSourceVideo = null;
      document.getElementById("mediaLightboxTitle").textContent = title || "画像";
      document.getElementById("mediaLightboxStage").innerHTML =
        '<img src="' + escAttr(src) + '" alt="' + escAttr(title || "画像") + '" />';
      document.getElementById("mediaLightbox").classList.add("open");
    }

    function openImageLightboxFromCard(wrap) {
      const img = wrap && wrap.querySelector("img");
      if (img) openImageLightbox(img.src, img.alt);
    }

    function openImageLightboxFromBtn(btn) {
      const card = btn && btn.closest(".media-card");
      const img = card && card.querySelector("img");
      if (img) openImageLightbox(img.src, img.alt);
    }

    function openVideoLightboxFromBtn(btn) {
      const card = btn && btn.closest(".media-card");
      const srcVideo = card && card.querySelector("video");
      if (!srcVideo) return;
      const startTime = Number.isFinite(srcVideo.currentTime) ? srcVideo.currentTime : 0;
      try { srcVideo.pause(); } catch {}
      activeLightboxSourceVideo = srcVideo;
      const caption = srcVideo.getAttribute("data-caption") || "動画";
      document.getElementById("mediaLightboxTitle").textContent = caption;
      const stage = document.getElementById("mediaLightboxStage");
      stage.innerHTML = '<video id="lightboxVideoEl" controls playsinline autoplay src="' + escAttr(srcVideo.currentSrc || srcVideo.src) + '"></video>';
      const modalVideo = document.getElementById("lightboxVideoEl");
      if (modalVideo && startTime > 0) {
        modalVideo.addEventListener("loadedmetadata", () => {
          try { modalVideo.currentTime = startTime; } catch {}
        }, { once: true });
      }
      document.getElementById("mediaLightbox").classList.add("open");
    }

    function closeMediaLightbox() {
      const modalVideo = document.getElementById("lightboxVideoEl");
      if (modalVideo) {
        const endTime = Number.isFinite(modalVideo.currentTime) ? modalVideo.currentTime : 0;
        try { modalVideo.pause(); } catch {}
        if (activeLightboxSourceVideo && endTime > 0) {
          try { activeLightboxSourceVideo.currentTime = endTime; } catch {}
        }
        modalVideo.removeAttribute("src");
        try { modalVideo.load(); } catch {}
      }
      activeLightboxSourceVideo = null;
      document.getElementById("mediaLightboxStage").innerHTML = "";
      document.getElementById("mediaLightbox").classList.remove("open");
    }

    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        const lb = document.getElementById("mediaLightbox");
        if (lb && lb.classList.contains("open")) {
          closeMediaLightbox();
        }
      }
    });

    function statusLabel(status) {
      if (status === "running") return "実行中";
      if (status === "needs_review") return "確認待ち";
      if (status === "done") return "完了";
      if (status === "failed") return "エラー";
      return "待機";
    }

    function formatShortTime(iso) {
      if (!iso) return "";
      try {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return "";
        return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0");
      } catch {
        return "";
      }
    }
    function showToast(msg) {
      const el = document.getElementById("toast");
      el.textContent = msg;
      el.style.display = "block";
      clearTimeout(el._t);
      el._t = setTimeout(() => { el.style.display = "none"; }, 3500);
    }

    function handleUriPaste(val) {
      const trimmed = val.trim();
      if (!trimmed.toLowerCase().startsWith("conductor://")) return;
      try {
        const u = new URL(trimmed);
        const t = u.searchParams.get("token");
        if (t) {
          document.getElementById("tokenInput").value = t;
          showToast("トークンを読み込みました");
        }
      } catch {}
    }

    async function apiFetch(path, options = {}) {
      const headers = Object.assign({}, options.headers || {}, {
        Authorization: "Bearer " + token,
      });
      if (options.body && !headers["Content-Type"]) {
        headers["Content-Type"] = "application/json";
      }
      const res = await fetch(path, Object.assign({ credentials: "same-origin" }, options, { headers }));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data.error || data.message || ("HTTP " + res.status));
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return data;
    }

    function buildTaskMarkdownBasePath(task) {
      if (!task) return "";
      const dir = (task.worktreePath || task.projectPath || "").trim();
      if (!dir) return "";
      return dir.replace(/[/\\\\]+$/, "") + "/__task_report__.md";
    }

    function isVideoPath(src) {
      return /\\.(?:mp4|webm|mov)(?:[?#].*)?$/i.test(String(src || "").trim());
    }

    function isRemoteHttpUrl(src) {
      const s = String(src || "").trim();
      return /^https?:\\/\\//i.test(s) || (s.startsWith("//") && !s.startsWith("///"));
    }

    function buildProtectedMediaEndpoint(src, basePath, isVideo) {
      const endpoint = isVideo ? "/api/media/video" : "/api/media/image";
      const params = new URLSearchParams();
      params.set("path", src);
      if (basePath) params.set("base", basePath);
      return endpoint + "?" + params.toString();
    }

    function renderMediaEmbed(alt, rawSrc, basePath) {
      const src = String(rawSrc || "").trim().replace(/^<|>$/g, "");
      if (!src) return "";
      return isVideoSrc(src)
        ? renderVideoCardHtml(alt, src, basePath, null)
        : renderImageCardHtml(alt, src, basePath);
    }

    function hydrateProtectedMedia(root) {
      if (!root || !token) return;
      const nodes = root.querySelectorAll("[data-auth-media-wrap]");
      nodes.forEach((wrap) => {
        const authUrl = wrap.getAttribute("data-auth-src");
        const kind = wrap.getAttribute("data-auth-media-wrap");
        const caption = wrap.getAttribute("data-caption") || "";
        const alt = wrap.getAttribute("data-alt") || "";
        if (!authUrl) return;
        const applyLoaded = (blobUrl) => {
          if (!wrap.isConnected) return;
          wrap.removeAttribute("data-auth-media-wrap");
          if (kind === "video") {
            wrap.innerHTML = '<video controls playsinline src="' + esc(blobUrl) + '"></video>' +
              '<div class="md-media-caption">' + esc(caption) + "</div>";
          } else {
            wrap.innerHTML = '<img src="' + esc(blobUrl) + '" alt="' + esc(caption) + '" onclick="openImageLightbox(this.src, this.alt)" />' +
              (alt ? '<div class="md-media-caption">' + esc(alt) + "</div>" : "");
          }
        };
        if (mediaBlobCache.has(authUrl)) {
          applyLoaded(mediaBlobCache.get(authUrl));
          return;
        }
        let promise = mediaInFlight.get(authUrl);
        if (!promise) {
          promise = fetch(authUrl, { headers: { Authorization: "Bearer " + token } })
            .then((res) => {
              if (!res.ok) throw new Error("HTTP " + res.status);
              return res.blob();
            })
            .then((blob) => {
              const objUrl = URL.createObjectURL(blob);
              mediaBlobCache.set(authUrl, objUrl);
              return objUrl;
            })
            .finally(() => { mediaInFlight.delete(authUrl); });
          mediaInFlight.set(authUrl, promise);
        }
        promise.then(applyLoaded).catch(() => {
          if (!wrap.isConnected) return;
          wrap.removeAttribute("data-auth-media-wrap");
          wrap.innerHTML = '<div class="md-media-caption" style="color:#fca5a5;">メディアを読み込めませんでした: ' + esc(caption) + "</div>";
        });
      });
    }

    function openLightbox(src, caption) {
      openImageLightbox(src, caption);
    }

    function closeLightbox() {
      closeMediaLightbox();
    }

    function renderInlineMd(raw, basePath) {
      const tokens = [];
      let text = String(raw || "");
      // Extract inline code first
      text = text.replace(/\`([^\`]+)\`/g, (_, code) => {
        const idx = tokens.length;
        tokens.push("<code>" + esc(code) + "</code>");
        return "\\u0000T" + idx + "\\u0000";
      });
      // Extract HTML <video> tags
      text = text.replace(/<video\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/video>)/gi, (full, attrBody, inner) => {
        const attrs = parseHtmlAttrs(attrBody || "");
        let src = attrs.src || "";
        if (!src && inner) {
          const sourceMatch = /<source\\b([^>]*?)\\/?>/i.exec(inner);
          if (sourceMatch) {
            const sAttrs = parseHtmlAttrs(sourceMatch[1] || "");
            src = sAttrs.src || "";
          }
        }
        if (!src) return full;
        const idx = tokens.length;
        const label = attrs["aria-label"] || attrs.title || attrs.alt || "";
        tokens.push(renderVideoCardHtml(label, src, basePath, attrs.poster || null));
        return "\\u0000T" + idx + "\\u0000";
      });
      // Extract HTML <img> tags
      text = text.replace(/<img\\b([^>]*?)\\/?>/gi, (full, attrBody) => {
        const attrs = parseHtmlAttrs(attrBody || "");
        if (!attrs.src) return full;
        const idx = tokens.length;
        tokens.push(
          isVideoSrc(attrs.src)
            ? renderVideoCardHtml(attrs.alt || attrs.title || "", attrs.src, basePath, null)
            : renderImageCardHtml(attrs.alt || attrs.title || "", attrs.src, basePath),
        );
        return "\\u0000T" + idx + "\\u0000";
      });
      // Extract Markdown images/videos (including angle-bracket paths with spaces)
      text = text.replace(/!\\[([^\\]]*)\\]\\((<[^>]+>|[^)\\s]+)(?:\\s+"[^"]*")?\\)/g, (_, alt, src) => {
        const idx = tokens.length;
        tokens.push(renderMediaEmbed(alt, src, basePath));
        return "\\u0000T" + idx + "\\u0000";
      });
      // Extract links
      text = text.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)\\s]+)\\)/g, (_, label, url) => {
        const idx = tokens.length;
        tokens.push('<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + "</a>");
        return "\\u0000T" + idx + "\\u0000";
      });
      let html = esc(text);
      html = html.replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>");
      html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");
      html = html.replace(/(^|[^*])\\*([^*\\n]+)\\*/g, "$1<em>$2</em>");
      html = html.replace(/\\u0000T(\\d+)\\u0000/g, (_, idx) => tokens[Number(idx)] || "");
      return html;
    }

    function renderMarkdown(mdText, basePath) {
      const lines = String(mdText || "").replace(/\\r\\n/g, "\\n").split("\\n");
      const out = [];
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();
        if (!trimmed) { i += 1; continue; }
        // Fenced code block
        if (trimmed.startsWith("\`\`\`")) {
          const lang = trimmed.slice(3).trim();
          const buf = [];
          i += 1;
          while (i < lines.length && !lines[i].trim().startsWith("\`\`\`")) {
            buf.push(lines[i]);
            i += 1;
          }
          if (i < lines.length) i += 1;
          out.push("<pre>" + (lang ? '<div style="font-size:10px;color:var(--muted);margin-bottom:4px;">' + esc(lang) + "</div>" : "") + "<code>" + esc(buf.join("\\n")) + "</code></pre>");
          continue;
        }
        // Heading
        const hMatch = /^(#{1,4})\\s+(.+)$/.exec(trimmed);
        if (hMatch) {
          const lvl = hMatch[1].length;
          out.push("<h" + lvl + ">" + renderInlineMd(hMatch[2], basePath) + "</h" + lvl + ">");
          i += 1;
          continue;
        }
        // Horizontal rule
        if (/^([-*_]){3,}$/.test(trimmed)) {
          out.push("<hr />");
          i += 1;
          continue;
        }
        // Standalone image line
        const imgLine = /^!\\[([^\\]]*)\\]\\((<[^>]+>|[^)\\s]+)(?:\\s+"[^"]*")?\\)$/.exec(trimmed);
        if (imgLine) {
          out.push(renderMediaEmbed(imgLine[1], imgLine[2], basePath));
          i += 1;
          continue;
        }
        // Table
        if (trimmed.includes("|") && i + 1 < lines.length && /^\\|?\\s*:?-+:?\\s*(\\|\\s*:?-+:?\\s*)+\\|?$/.test(lines[i + 1].trim())) {
          const splitCells = (row) => row.trim().replace(/^\\|/, "").replace(/\\|$/, "").split("|").map((c) => c.trim());
          const headers = splitCells(trimmed);
          i += 2;
          const rows = [];
          while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
            rows.push(splitCells(lines[i]));
            i += 1;
          }
          out.push(
            '<div class="md-table-wrap"><table><thead><tr>' +
            headers.map((h) => "<th>" + renderInlineMd(h, basePath) + "</th>").join("") +
            "</tr></thead><tbody>" +
            rows.map((r) => "<tr>" + headers.map((_, ci) => "<td>" + renderInlineMd(r[ci] || "", basePath) + "</td>").join("") + "</tr>").join("") +
            "</tbody></table></div>"
          );
          continue;
        }
        // Blockquote
        if (trimmed.startsWith(">")) {
          const qLines = [];
          while (i < lines.length && lines[i].trim().startsWith(">")) {
            qLines.push(lines[i].trim().replace(/^>\\s?/, ""));
            i += 1;
          }
          out.push("<blockquote>" + qLines.map((l) => renderInlineMd(l, basePath)).join("<br />") + "</blockquote>");
          continue;
        }
        // Unordered list
        if (/^[-*+]\\s+/.test(trimmed)) {
          const items = [];
          while (i < lines.length && /^\\s*[-*+]\\s+/.test(lines[i])) {
            const itemText = lines[i].replace(/^\\s*[-*+]\\s+/, "");
            const checkMatch = /^\\[([ xX])\\]\\s+(.*)$/.exec(itemText);
            if (checkMatch) {
              const mark = checkMatch[1].toLowerCase() === "x" ? "☑ " : "☐ ";
              items.push("<li>" + mark + renderInlineMd(checkMatch[2], basePath) + "</li>");
            } else {
              items.push("<li>" + renderInlineMd(itemText, basePath) + "</li>");
            }
            i += 1;
          }
          out.push("<ul>" + items.join("") + "</ul>");
          continue;
        }
        // Ordered list
        if (/^\\d+\\.\\s+/.test(trimmed)) {
          const items = [];
          while (i < lines.length && /^\\s*\\d+\\.\\s+/.test(lines[i])) {
            items.push("<li>" + renderInlineMd(lines[i].replace(/^\\s*\\d+\\.\\s+/, ""), basePath) + "</li>");
            i += 1;
          }
          out.push("<ol>" + items.join("") + "</ol>");
          continue;
        }
        // Paragraph
        const pLines = [];
        while (
          i < lines.length &&
          lines[i].trim() &&
          !lines[i].trim().startsWith("\`\`\`") &&
          !/^(#{1,4})\\s+/.test(lines[i].trim()) &&
          !lines[i].trim().startsWith(">") &&
          !/^[-*+]\\s+/.test(lines[i].trim()) &&
          !/^\\d+\\.\\s+/.test(lines[i].trim()) &&
          !/^!\\[([^\\]]*)\\]\\((<[^>]+>|[^)\\s]+)(?:\\s+"[^"]*")?\\)$/.test(lines[i].trim())
        ) {
          pLines.push(lines[i]);
          i += 1;
        }
        out.push("<p>" + pLines.map((l) => renderInlineMd(l, basePath)).join("<br />") + "</p>");
      }
      return '<div class="md">' + out.join("") + "</div>";
    }

    function normalizeActivityToolName(title) {
      const trimmed = String(title || "").trim();
      if (!trimmed) return "tool";
      if (trimmed.startsWith("$ ")) return "run_command";
      const cleaned = trimmed.replace(/^default_api:/, "").replace(/^mcp_+conductor_+/, "");
      if (!cleaned) return "tool";
      return cleaned.length > 32 ? (cleaned.slice(0, 31) + "…") : cleaned;
    }

    function isRoutineToolActivity(act) {
      if (!act) return false;
      if (act.kind === "command" || act.kind === "reasoning") return true;
      if (act.kind === "system" && String(act.title || "").trim().toLowerCase() === "system_message") return true;
      return false;
    }

    function partitionTaskActivities(activities) {
      const highSignal = [];
      const toolActivities = [];
      for (const act of (activities || [])) {
        if (isRoutineToolActivity(act)) toolActivities.push(act);
        else highSignal.push(act);
      }
      const countsMap = new Map();
      toolActivities.forEach((act, idx) => {
        const name = normalizeActivityToolName(act.title);
        const cur = countsMap.get(name);
        if (cur) cur.count += 1;
        else countsMap.set(name, { name, count: 1, firstIdx: idx });
      });
      const toolCounts = Array.from(countsMap.values()).sort((a, b) => (b.count - a.count) || (a.firstIdx - b.firstIdx));
      return {
        highSignal: highSignal.slice().reverse(),
        toolActivities,
        toolCounts,
      };
    }

    function formatToolLogSummary(totalCount, toolCounts) {
      const shown = toolCounts.slice(0, 4).map((c) => c.name + " ×" + c.count);
      const more = toolCounts.length - shown.length;
      if (more > 0) shown.push("ほか " + more + "種");
      if (shown.length === 0) return "ツール実行ログ（全 " + totalCount + "件）";
      return "ツール実行ログ（全 " + totalCount + "件: " + shown.join(", ") + "）";
    }

    function mergeTaskForDisplay(snapTask, detailTask) {
      if (!snapTask && !detailTask) return null;
      if (!detailTask) {
        const fallbackActs = snapTask.latestActivity ? [snapTask.latestActivity] : [];
        return Object.assign({}, snapTask, {
          activities: (snapTask.activities && snapTask.activities.length > 0) ? snapTask.activities : fallbackActs,
        });
      }
      if (!snapTask) return detailTask;
      const snapTime = Date.parse(snapTask.updatedAt || "") || 0;
      const detailTime = Date.parse(detailTask.updatedAt || "") || 0;
      const detailOutput = String(detailTask.latestOutput || "");
      const snapOutput = String(snapTask.latestOutput || "");
      const snapOutputLen = typeof snapTask.outputLength === "number" ? snapTask.outputLength : snapOutput.length;
      const useDetailOutput = detailOutput.length > 0 && (
        detailTime >= snapTime ||
        (detailOutput.length >= snapOutputLen && detailOutput.endsWith(snapOutput))
      );
      const mergedActivities = (detailTask.activities && detailTask.activities.length > 0)
        ? detailTask.activities
        : (snapTask.latestActivity ? [snapTask.latestActivity] : []);
      return Object.assign({}, detailTask, snapTask, {
        latestOutput: useDetailOutput ? detailOutput : (snapOutput || detailOutput),
        activities: mergedActivities,
      });
    }

    async function connectWithToken() {
      const input = document.getElementById("tokenInput").value.trim();
      if (!input) { showToast("トークンを入力してください"); return; }
      token = input;
      try {
        const snap = await apiFetch("/api/snapshot");
        await apiFetch("/api/media/session", { method: "POST" }).catch(() => {});
        localStorage.setItem(TOKEN_KEY, token);
        applySnapshot(snap);
        enterApp();
        startStream();
      } catch (err) {
        showToast("接続エラー: " + err.message);
      }
    }

    function enterApp() {
      document.getElementById("view-auth").classList.remove("active");
      document.getElementById("bottomNav").style.display = "flex";
      document.getElementById("newChatBtn").style.display = "inline-flex";
      switchTab(currentTab);
    }

    function disconnect() {
      stopStream();
      closeMediaLightbox();
      closeTaskSheet();
      fetch("/api/media/session", { method: "DELETE", credentials: "same-origin" }).catch(() => {});
      localStorage.removeItem(TOKEN_KEY);
      token = "";
      snapshot = null;
      taskDetailCache.clear();
      document.getElementById("chatScroll").innerHTML = "";
      document.getElementById("bottomNav").style.display = "none";
      document.getElementById("newChatBtn").style.display = "none";
      document.getElementById("stopAllBtn").style.display = "none";
      document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
      document.getElementById("view-auth").classList.add("active");
      setDot("off");
    }

    function setDot(mode) {
      const dot = document.getElementById("connDot");
      dot.className = "dot" + (mode === "live" ? " live" : mode === "warn" ? " warn" : mode === "err" ? " err" : "");
    }

    function stopStream() {
      if (eventSource) { eventSource.close(); eventSource = null; }
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    function startStream() {
      stopStream();
      setDot("warn");
      const url = "/api/events?token=" + encodeURIComponent(token);
      eventSource = new EventSource(url);
      eventSource.addEventListener("snapshot", (ev) => {
        setDot("live");
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        try { applySnapshot(JSON.parse(ev.data)); } catch {}
      });
      eventSource.onerror = () => {
        setDot("warn");
        if (!pollTimer) {
          pollTimer = setInterval(async () => {
            try { applySnapshot(await apiFetch("/api/snapshot")); } catch {}
          }, 3000);
        }
      };
    }

    function reconnect() {
      if (!token) return;
      startStream();
      showToast("再接続しました");
    }

    function switchTab(tab) {
      currentTab = tab;
      document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
      document.getElementById("view-" + tab).classList.add("active");
      document.querySelectorAll(".tab").forEach((b) => {
        b.classList.toggle("active", b.dataset.tab === tab);
      });
    }

    function setTaskSearch(val) {
      taskSearchQuery = val || "";
      renderTasks();
    }

    function setProjectFilter(projectId) {
      selectedProjectFilter = selectedProjectFilter === projectId ? null : projectId;
      renderTasks();
    }

    function applySnapshot(next) {
      if (!next || typeof next !== "object") return;
      if (
        snapshot &&
        snapshot.snapshotEpoch &&
        next.snapshotEpoch &&
        snapshot.snapshotEpoch === next.snapshotEpoch &&
        typeof snapshot.snapshotVersion === "number" &&
        typeof next.snapshotVersion === "number" &&
        next.snapshotVersion < snapshot.snapshotVersion
      ) {
        return;
      }
      const prevTasksById = new Map(((snapshot && snapshot.tasks) || []).map((t) => [t.id, t]));
      snapshot = next;
      const streaming = (snapshot.activeResponderCount || 0) > 0;
      document.getElementById("stopAllBtn").style.display = streaming ? "inline-flex" : "none";
      const runningCount = ((snapshot && snapshot.tasks) || []).filter((t) => t.status === "running").length;
      const badge = document.getElementById("tasksTabBadge");
      if (badge) {
        badge.style.display = runningCount > 0 ? "inline-block" : "none";
        badge.textContent = String(runningCount);
      }
      renderChat();
      renderTasks();
      renderSettings();
      if (openTaskId) {
        const prevTask = prevTasksById.get(openTaskId);
        const nextTask = ((snapshot && snapshot.tasks) || []).find((t) => t.id === openTaskId);
        renderTaskSheet(openTaskId);
        if (nextTask) {
          const cached = taskDetailCache.get(openTaskId);
          const statusChanged = Boolean(prevTask && (prevTask.status !== nextTask.status || prevTask.landStatus !== nextTask.landStatus));
          const detailTask = cached && cached.task;
          const cachedActCount = detailTask && Array.isArray(detailTask.activities) ? detailTask.activities.length : -1;
          const nextActCount = typeof nextTask.activityCount === "number" ? nextTask.activityCount : -1;
          const nextOutLen = typeof nextTask.outputLength === "number" ? nextTask.outputLength : (nextTask.latestOutput || "").length;
          const cachedOutLen = detailTask && detailTask.latestOutput ? detailTask.latestOutput.length : 0;
          const needsDetailRefresh =
            !cached ||
            statusChanged ||
            (nextActCount >= 0 && nextActCount !== cachedActCount) ||
            (nextOutLen > cachedOutLen) ||
            (detailTask && nextTask.updatedAt && nextTask.updatedAt !== detailTask.updatedAt);
          if (statusChanged) {
            fetchTaskDetail(openTaskId, { skipGit: false, silent: true });
          } else if (needsDetailRefresh) {
            scheduleTaskDetailRefresh(openTaskId, { skipGit: true });
          }
        }
      }
    }

    function buildChatMessageHtml(m, tasksById) {
      const mentions = (m.mentions || []).map((ref) =>
        '<span class="chip">@' + esc(ref.kind === "task" ? ("T" + ref.taskNumber) : ref.projectName) + "</span>"
      ).join("");
      const stopBtn = m.isStreaming
        ? ' <button class="btn sm danger" style="padding:2px 7px;font-size:11px;" onclick="stopMsg(\\'' + esc(m.id) + '\\')">停止</button>'
        : "";
      const toolChipsHtml = (m.toolChips && m.toolChips.length > 0)
        ? '<div class="tool-chips-row">' + m.toolChips.map((c) =>
            '<span class="tool-chip' + (c.isError ? " err" : "") + '">' +
            (!c.isCompleted ? '<span class="spinner" style="width:10px;height:10px;border-width:1.5px;"></span>' : (c.isError ? "✕" : "✓")) +
            " " + esc(c.label) + "</span>"
          ).join("") + "</div>"
        : "";
      const linkedTask = m.relatedTaskId ? tasksById.get(m.relatedTaskId) : null;
      const meta = m.role === "assistant"
        ? '<div class="meta"><span>' + esc(m.provider || "conductor") + "</span>" + (m.isStreaming ? '<span style="color:#a5b4fc;">● 応答中...</span>' : "") + stopBtn + "</div>"
        : m.role === "taskEvent"
          ? '<div class="meta">' +
            (linkedTask ? ('<span class="chip code">T' + esc(linkedTask.taskNumber) + '</span><span class="chip ' + esc(linkedTask.status) + '">' + esc(statusLabel(linkedTask.status)) + "</span>") : "") +
            (m.relatedTaskId ? '<span style="color:#a5b4fc;margin-left:auto;">詳細を開く →</span>' : "") +
            "</div>"
          : (mentions ? '<div class="meta">' + mentions + "</div>" : "");
      const imgAtts = (m.attachments || []).filter((a) => a.kind === "image" && a.id);
      const attHtml = imgAtts.length > 0
        ? '<div class="att-grid">' + imgAtts.map((a) => {
            const url = "/api/attachments/" + encodeURIComponent(a.id);
            const label = a.label || "Image";
            return '<img class="att-thumb" loading="lazy" src="' + escAttr(url) + '" alt="' + escAttr(label) + '" onclick="openImageLightbox(this.src, this.alt)" />';
          }).join("") + "</div>"
        : "";
      const basePath = linkedTask ? buildTaskMarkdownBasePath(linkedTask) : "";
      const bodyText = m.text || (m.isStreaming ? "..." : "");
      const bodyHtml = m.role === "user"
        ? esc(bodyText)
        : renderMarkdown(bodyText, basePath);
      return meta + attHtml + toolChipsHtml + bodyHtml;
    }

    function renderChat() {
      const el = document.getElementById("chatScroll");
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
      const msgs = (snapshot && snapshot.messages) || [];
      const tasksById = new Map(((snapshot && snapshot.tasks) || []).map((t) => [t.id, t]));
      if (msgs.length === 0) {
        if (!el.querySelector("[data-empty-chat]")) {
          el.innerHTML = '<div data-empty-chat="1" style="text-align:center;color:var(--muted);margin-top:40px;font-size:13px;">メッセージはまだありません</div>';
        }
        return;
      }
      const emptyEl = el.querySelector("[data-empty-chat]");
      if (emptyEl) emptyEl.remove();

      const existingNodes = new Map();
      for (const child of Array.from(el.children)) {
        const id = child.getAttribute("data-msg-id");
        if (id) existingNodes.set(id, child);
      }

      const activeIds = new Set();
      msgs.forEach((m, idx) => {
        activeIds.add(m.id);
        const linkedTask = m.relatedTaskId ? tasksById.get(m.relatedTaskId) : null;
        const basePath = linkedTask ? buildTaskMarkdownBasePath(linkedTask) : "";
        const isClickableTask = m.role === "taskEvent" && Boolean(m.relatedTaskId);
        const sig = JSON.stringify([
          m.role,
          m.provider || "",
          m.isStreaming ? 1 : 0,
          m.text || "",
          basePath,
          linkedTask ? linkedTask.status : "",
          (m.attachments || []).map((a) => a.id),
          (m.mentions || []).length,
          (m.toolChips || []).map((c) => c.id + ":" + (c.isCompleted ? 1 : 0) + ":" + (c.isError ? 1 : 0)),
        ]);
        let node = existingNodes.get(m.id);
        if (!node) {
          node = document.createElement("div");
          node.setAttribute("data-msg-id", m.id);
        }
        node.className = "msg " + m.role + (isClickableTask ? " clickable" : "");
        node.onclick = isClickableTask ? () => openTaskFromChat(m.relatedTaskId) : null;
        if (node.getAttribute("data-render-sig") !== sig) {
          node.setAttribute("data-render-sig", sig);
          node.innerHTML = buildChatMessageHtml(m, tasksById);
          hydrateProtectedMedia(node);
        }
        const currentAtIdx = el.children[idx];
        if (currentAtIdx !== node) {
          el.insertBefore(node, currentAtIdx || null);
        }
      });

      for (const [id, node] of existingNodes.entries()) {
        if (!activeIds.has(id)) node.remove();
      }
      if (nearBottom) el.scrollTop = el.scrollHeight;
    }

    function openTaskFromChat(taskId) {
      switchTab("tasks");
      openTaskSheet(taskId);
    }

    function renderSelectedMentions() {
      const el = document.getElementById("selectedMentions");
      el.innerHTML = selectedMentions.map((m, i) => {
        const label = m.kind === "task" ? ("@T" + (m.taskNumber || "?") + " " + (m.taskTitle || "")) : ("@" + (m.projectName || "Project"));
        return '<span class="chip">' + esc(label) + ' <span style="cursor:pointer;" onclick="removeMention(' + i + ')">×</span></span>';
      }).join("");
    }

    function removeMention(i) {
      selectedMentions.splice(i, 1);
      renderSelectedMentions();
    }

    function openMentionSheet() {
      if (!snapshot) return;
      const list = document.getElementById("mentionList");
      const items = [];
      for (const p of (snapshot.projects || [])) {
        items.push('<button class="btn" style="justify-content:flex-start;" onclick="addProjectMention(\\'' + esc(p.id) + '\\')">' +
          '<span class="dot" style="background:' + esc(p.colorHex || "#6366f1") + '"></span>@' + esc(p.name) + "</button>");
      }
      for (const t of (snapshot.tasks || [])) {
        items.push('<button class="btn" style="justify-content:flex-start;" onclick="addTaskMention(\\'' + esc(t.id) + '\\')">@T' +
          esc(t.taskNumber) + " " + esc(t.title) + "</button>");
      }
      list.innerHTML = items.join("") || '<div style="color:var(--muted);font-size:12.5px;">候補がありません</div>';
      document.getElementById("mentionModal").classList.add("open");
    }

    function closeMentionSheet() {
      document.getElementById("mentionModal").classList.remove("open");
    }

    function addProjectMention(projectId) {
      const p = (snapshot.projects || []).find((x) => x.id === projectId);
      if (p && !selectedMentions.some((m) => m.kind === "project" && m.projectId === p.id)) {
        selectedMentions.push({ kind: "project", projectId: p.id, projectName: p.name, projectPath: p.path, projectColorHex: p.colorHex });
        renderSelectedMentions();
      }
      closeMentionSheet();
    }

    function addTaskMention(taskId) {
      const t = (snapshot.tasks || []).find((x) => x.id === taskId);
      if (t && !selectedMentions.some((m) => m.kind === "task" && m.taskId === t.id)) {
        selectedMentions.push({ kind: "task", taskId: t.id, taskNumber: t.taskNumber, taskTitle: t.title, projectId: t.projectId, projectName: t.projectName });
        renderSelectedMentions();
      }
      closeMentionSheet();
    }

    async function sendChat() {
      const input = document.getElementById("composerInput");
      const text = input.value.trim();
      if (!text) return;
      const mentionsToSend = selectedMentions.slice();
      input.value = "";
      selectedMentions = [];
      renderSelectedMentions();
      try {
        const payload = { text, explicitMentions: mentionsToSend, attachments: [] };
        if (snapshot && snapshot.activeChatSessionId) {
          payload.chatSessionId = snapshot.activeChatSessionId;
        }
        const res = await apiFetch("/api/chat/send", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        if (res && res.snapshot) applySnapshot(res.snapshot);
      } catch (err) {
        input.value = text;
        selectedMentions = mentionsToSend;
        renderSelectedMentions();
        if (err && err.data && err.data.snapshot) {
          applySnapshot(err.data.snapshot);
        }
        showToast("送信エラー: " + err.message);
      }
    }

    async function stopMsg(id) {
      try {
        const res = await apiFetch("/api/chat/stop", { method: "POST", body: JSON.stringify({ messageId: id }) });
        if (res && res.snapshot) applySnapshot(res.snapshot);
      }
      catch (err) { showToast(err.message); }
    }

    async function stopAll() {
      try {
        const res = await apiFetch("/api/chat/stop", { method: "POST", body: JSON.stringify({}) });
        if (res && res.snapshot) applySnapshot(res.snapshot);
      }
      catch (err) { showToast(err.message); }
    }

    async function newChat() {
      try {
        const res = await apiFetch("/api/chat/new", { method: "POST", body: JSON.stringify({}) });
        if (res && res.snapshot) applySnapshot(res.snapshot);
      }
      catch (err) { showToast(err.message); }
    }

    function renderTasks() {
      const el = document.getElementById("tasksScroll");
      const pillsEl = document.getElementById("taskProjectPills");
      const tasks = (snapshot && snapshot.tasks) || [];
      const projects = (snapshot && snapshot.projects) || [];
      const projectById = new Map(projects.map((p) => [p.id, p]));
      const usedProjectIds = new Set(tasks.map((t) => t.projectId).filter(Boolean));
      const quickProjects = projects.filter((p) => usedProjectIds.has(p.id) || p.id === selectedProjectFilter);

      if (pillsEl) {
        if (quickProjects.length === 0) {
          pillsEl.innerHTML = "";
        } else {
          pillsEl.innerHTML =
            '<button class="filter-pill' + (!selectedProjectFilter ? " active" : "") + '" onclick="setProjectFilter(null)">すべて</button>' +
            quickProjects.map((p) =>
              '<button class="filter-pill' + (selectedProjectFilter === p.id ? " active" : "") + '" onclick="setProjectFilter(\\'' + esc(p.id) + '\\')">' +
              '<span class="dot" style="width:7px;height:7px;background:' + esc(p.colorHex || "#6366f1") + '"></span>' + esc(p.name) + "</button>"
            ).join("");
        }
      }

      const q = taskSearchQuery.trim().toLowerCase();
      const filtered = tasks.filter((t) => {
        if (selectedProjectFilter && t.projectId !== selectedProjectFilter) return false;
        if (!q) return true;
        const hay = ("t" + t.taskNumber + " " + (t.title || "") + " " + (t.projectName || "") + " " + (t.currentStep || "") + " " + (t.summary || "")).toLowerCase();
        return hay.includes(q);
      });

      const running = filtered.filter((t) => t.status === "running");
      const review = filtered.filter((t) => t.status === "needs_review" || t.status === "queued" || t.status === "failed");
      const done = filtered.filter((t) => t.status === "done");

      const renderCard = (t) => {
        const proj = projectById.get(t.projectId);
        const projColor = (proj && proj.colorHex) || "#6366f1";
        const actCount = typeof t.activityCount === "number" ? t.activityCount : ((t.activities || []).length);
        const stepText = t.currentStep || (t.latestActivity && t.latestActivity.title) || "";
        const outputSnippet = (t.latestOutput || "").replace(/\\s+/g, " ").trim().slice(0, 140);
        const landBadge = t.landStatus === "landed" && t.landedBranch
          ? '<span class="chip ok">Landed → ' + esc(t.landedBranch) + "</span>"
          : (t.worktreeBranch ? '<span class="chip neutral">' + esc(t.worktreeBranch) + "</span>" : "");
        return '<div class="card task-card ' + esc(t.status) + '" data-task-id="' + esc(t.id) + '" onclick="openTaskSheet(\\'' + esc(t.id) + '\\')">' +
          '<div class="row">' +
            '<div class="row-left">' +
              (t.status === "running" ? '<span class="spinner"></span>' : "") +
              '<span class="chip code">T' + esc(t.taskNumber) + "</span>" +
              '<span class="chip neutral"><span class="dot" style="width:6px;height:6px;background:' + esc(projColor) + '"></span>' + esc(t.projectName || "General") + "</span>" +
              (t.provider ? '<span class="chip neutral">' + esc(t.provider.toUpperCase()) + "</span>" : "") +
            "</div>" +
            '<span class="chip ' + esc(t.status) + '">' + esc(statusLabel(t.status)) + "</span>" +
          "</div>" +
          '<div class="task-title">' + esc(t.title) + "</div>" +
          (landBadge || actCount > 0
            ? '<div class="row-left">' + landBadge + (actCount > 0 ? '<span class="chip neutral">ログ ' + esc(actCount) + "件</span>" : "") + "</div>"
            : "") +
          (stepText
            ? '<div class="task-step-line">' + (t.status === "running" ? '<span class="live-pulse"></span>' : "") + "<span>" + esc(stepText) + "</span></div>"
            : "") +
          (outputSnippet
            ? '<div class="task-preview-line">' + esc(outputSnippet) + "</div>"
            : (t.summary ? '<div class="task-preview-line">' + esc(t.summary) + "</div>" : "")) +
          "</div>";
      };

      const section = (title, arr) => {
        if (arr.length === 0) return "";
        return '<div class="group-title">' + esc(title) + ' <span class="chip neutral" style="padding:1px 6px;font-size:10px;">' + arr.length + "</span></div>" + arr.map(renderCard).join("");
      };
      el.innerHTML = section("実行中", running) + section("確認待ち / その他", review) + section("完了", done) ||
        '<div style="text-align:center;color:var(--muted);margin-top:40px;font-size:13px;">' + (tasks.length === 0 ? "タスクはありません" : "条件に一致するタスクがありません") + "</div>";
    }

    function scheduleTaskDetailRefresh(taskId, opts = {}) {
      if (taskDetailThrottleTimer) return;
      taskDetailThrottleTimer = setTimeout(() => {
        taskDetailThrottleTimer = null;
        if (openTaskId === taskId) {
          fetchTaskDetail(taskId, Object.assign({ silent: true }, opts));
        }
      }, 700);
    }

    function startOpenTaskPolling(taskId) {
      stopOpenTaskPolling();
      openTaskPollTimer = setInterval(() => {
        if (openTaskId !== taskId) { stopOpenTaskPolling(); return; }
        const snapTask = ((snapshot && snapshot.tasks) || []).find((x) => x.id === taskId);
        const cached = taskDetailCache.get(taskId);
        const merged = mergeTaskForDisplay(snapTask, cached && cached.task);
        if (!merged || merged.status !== "running") return;
        const ageMs = cached && cached.fetchedAt ? (Date.now() - cached.fetchedAt) : 999999;
        if (ageMs >= 2200) {
          fetchTaskDetail(taskId, { skipGit: true, silent: true });
        }
      }, 2500);
    }

    function stopOpenTaskPolling() {
      if (openTaskPollTimer) { clearInterval(openTaskPollTimer); openTaskPollTimer = null; }
      if (taskDetailThrottleTimer) { clearTimeout(taskDetailThrottleTimer); taskDetailThrottleTimer = null; }
    }

    async function fetchTaskDetail(taskId, options = {}) {
      const skipGit = Boolean(options.skipGit);
      const silent = Boolean(options.silent);
      const prev = taskDetailCache.get(taskId) || {};
      if (!silent) {
        taskDetailCache.set(taskId, Object.assign({}, prev, { isLoading: true }));
        if (openTaskId === taskId) renderTaskSheet(taskId);
      }
      try {
        const suffix = skipGit ? "?skipGit=1" : "";
        const detail = await apiFetch("/api/tasks/" + encodeURIComponent(taskId) + suffix);
        const latestPrev = taskDetailCache.get(taskId) || {};
        taskDetailCache.set(taskId, {
          task: detail.task || latestPrev.task || null,
          worktreeStatus: skipGit ? (latestPrev.worktreeStatus || null) : (detail.worktreeStatus || null),
          gitStatus: skipGit ? (latestPrev.gitStatus || null) : (detail.gitStatus || null),
          fetchedAt: Date.now(),
          isLoading: false,
        });
        if (openTaskId === taskId) renderTaskSheet(taskId);
      } catch (err) {
        const latestPrev = taskDetailCache.get(taskId) || {};
        taskDetailCache.set(taskId, Object.assign({}, latestPrev, { isLoading: false }));
        if (!silent) showToast("タスク詳細の取得に失敗: " + err.message);
        if (openTaskId === taskId) renderTaskSheet(taskId);
      }
    }

    async function openTaskSheet(taskId) {
      openTaskId = taskId;
      document.getElementById("taskModal").classList.add("open");
      renderTaskSheet(taskId);
      startOpenTaskPolling(taskId);
      await fetchTaskDetail(taskId, { skipGit: false, silent: false });
    }

    function closeTaskSheet() {
      openTaskId = null;
      stopOpenTaskPolling();
      const shell = document.getElementById("taskSheetShell");
      if (shell) shell._lastHtml = "";
      document.getElementById("taskModal").classList.remove("open");
    }

    function toggleTaskToolLog(taskId) {
      const prefs = taskUiPrefs.get(taskId) || { toolLogExpanded: null };
      const snapTask = ((snapshot && snapshot.tasks) || []).find((x) => x.id === taskId);
      const cached = taskDetailCache.get(taskId);
      const t = mergeTaskForDisplay(snapTask, cached && cached.task);
      const defaultExpanded = Boolean(t && t.status === "running" && !(t.latestOutput || "").trim());
      const current = prefs.toolLogExpanded === null ? defaultExpanded : prefs.toolLogExpanded;
      prefs.toolLogExpanded = !current;
      taskUiPrefs.set(taskId, prefs);
      if (openTaskId === taskId) renderTaskSheet(taskId);
    }

    function manualRefreshOpenTask() {
      if (!openTaskId) return;
      fetchTaskDetail(openTaskId, { skipGit: false, silent: false });
    }

    function renderTaskSheet(taskId) {
      const snapTask = ((snapshot && snapshot.tasks) || []).find((x) => x.id === taskId);
      const cached = taskDetailCache.get(taskId);
      const t = mergeTaskForDisplay(snapTask, cached && cached.task);
      if (!t) return;

      const shell = document.getElementById("taskSheetShell");
      const prevBodyEl = shell.querySelector(".sheet-body");
      const prevScrollTop = prevBodyEl ? prevBodyEl.scrollTop : 0;

      const isRunning = t.status === "running";
      const isDone = t.status === "done";
      const isFailed = t.status === "failed";
      const hasWorktree = Boolean(t.worktreePath || t.worktreeBranch);
      const isUnlanded = !(t.landStatus === "landed" || t.landStatus === "pushed" || t.landStatus === "pr_created") &&
        (hasWorktree || t.landStatus === "unlanded" || t.landStatus === "landing" || t.landStatus === "conflict" || t.landStatus === "error");
      const basePath = buildTaskMarkdownBasePath(t);
      const activities = Array.isArray(t.activities) ? t.activities : [];
      const totalActCount = Math.max(activities.length, typeof t.activityCount === "number" ? t.activityCount : 0);
      const partitioned = partitionTaskActivities(activities);
      const prefs = taskUiPrefs.get(taskId) || { toolLogExpanded: null };
      const hasOutput = Boolean((t.latestOutput || "").trim());
      const toolLogExpanded = prefs.toolLogExpanded === null
        ? (isRunning && !hasOutput)
        : prefs.toolLogExpanded;

      const wt = cached && cached.worktreeStatus;
      const gitStatus = cached && cached.gitStatus;
      const isLoading = Boolean(cached && cached.isLoading);

      const stepBannerHtml = (t.currentStep || isRunning)
        ? '<div class="step-banner' + (isFailed ? " error" : isDone ? " done" : "") + '">' +
            '<div class="step-banner-main">' +
              (isRunning ? '<span class="spinner"></span>' : "") +
              "<span>" + esc(t.currentStep || (isRunning ? "ワーカー実行中..." : statusLabel(t.status))) + "</span>" +
            "</div>" +
            '<div class="step-banner-sub">' +
              (isRunning ? '<span>● リアルタイム同期中</span>' : "") +
              (totalActCount > 0 ? ("<span>アクティビティ " + esc(totalActCount) + "件</span>") : "") +
              (t.updatedAt ? ("<span>更新 " + esc(formatShortTime(t.updatedAt)) + "</span>") : "") +
            "</div>" +
          "</div>"
        : "";

      const actionsHtml =
        '<div class="row-left">' +
          (isRunning ? '<button class="btn sm danger" onclick="taskStop(\\'' + esc(t.id) + '\\')">ワーカー停止</button>' : "") +
          (!isRunning && (hasWorktree || isUnlanded) && t.landStatus !== "landed" ? '<button class="btn sm primary" onclick="taskLand(\\'' + esc(t.id) + '\\')">Land</button>' : "") +
          (!isRunning && isUnlanded ? '<button class="btn sm" onclick="taskSyncLand(\\'' + esc(t.id) + '\\')">状態再確認</button>' : "") +
          (!isDone ? (!isRunning && isUnlanded
            ? '<button class="btn sm warn" onclick="taskStatus(\\'' + esc(t.id) + '\\', \\'done\\', true)">強制完了</button>'
            : (!isRunning ? '<button class="btn sm ok" onclick="taskStatus(\\'' + esc(t.id) + '\\', \\'done\\', false)">完了にする</button>' : ""))
            : '<button class="btn sm" onclick="taskStatus(\\'' + esc(t.id) + '\\', \\'needs_review\\', false)">再オープン</button>') +
          '<button class="btn sm" onclick="mentionTaskFromSheet(\\'' + esc(t.id) + '\\')">@ チャットで参照</button>' +
        "</div>";

      const outputSectionHtml = hasOutput
        ? '<div class="section-label"><span>' + (isRunning ? "ストリーミング出力" : "最新出力・完了レポート") + "</span>" +
            (isRunning ? '<span class="row-left" style="font-size:10.5px;color:#a5b4fc;text-transform:none;"><span class="live-pulse"></span>更新中</span>' : "") +
          "</div>" +
          '<div class="panel-box" data-testid="mobile-task-output">' + renderMarkdown(t.latestOutput, basePath) + "</div>"
        : (isRunning
            ? '<div class="section-label"><span>最新出力</span><span style="font-size:10.5px;color:#a5b4fc;text-transform:none;">出力待機中</span></div>' +
              '<div class="panel-box" style="color:var(--muted);font-size:12.5px;">' +
                '<div class="row-left"><span class="spinner"></span><span>エージェントが作業を進めています。ツール実行ログや出力が届き次第ここに表示されます。</span></div>' +
              "</div>"
            : "");

      const highSignalIcon = (kind) => {
        if (kind === "error") return "⚠";
        if (kind === "message") return "💬";
        if (kind === "file") return "📄";
        return "ℹ";
      };

      const activitySectionHtml = (activities.length > 0 || isLoading)
        ? '<div class="section-label"><span>アクティビティログ (' + esc(totalActCount) + "件)</span>" +
            (isLoading ? '<span class="row-left" style="font-size:10.5px;text-transform:none;"><span class="spinner" style="width:10px;height:10px;"></span>同期中</span>' : "") +
          "</div>" +
          (partitioned.highSignal.length > 0
            ? '<div style="display:flex;flex-direction:column;gap:7px;" data-testid="mobile-high-signal-activities">' +
              partitioned.highSignal.map((act) =>
                '<div class="activity-item ' + esc(act.kind || "system") + '">' +
                  '<div class="activity-head"><span>' + highSignalIcon(act.kind) + " " + esc(act.title) + "</span>" +
                    (act.timestamp ? '<span class="activity-time">' + esc(formatShortTime(act.timestamp)) + "</span>" : "") +
                  "</div>" +
                  (act.detail ? '<pre class="detail-pre">' + esc(act.detail) + "</pre>" : "") +
                "</div>"
              ).join("") +
              "</div>"
            : "") +
          (partitioned.toolActivities.length > 0
            ? '<div class="tool-log-box" data-testid="mobile-tool-log-section">' +
                '<button type="button" class="tool-log-toggle" onclick="toggleTaskToolLog(\\'' + esc(t.id) + '\\')">' +
                  '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">⌘ ' + esc(formatToolLogSummary(partitioned.toolActivities.length, partitioned.toolCounts)) + "</span>" +
                  '<span style="flex-shrink:0;">' + (toolLogExpanded ? "▾" : "▸") + "</span>" +
                "</button>" +
                (toolLogExpanded
                  ? '<div class="tool-log-list" data-testid="mobile-tool-log-list">' +
                    partitioned.toolActivities.map((act, idx) =>
                      '<div class="tool-log-item">' +
                        '<div class="tool-log-title">' +
                          '<span class="tool-log-idx">#' + (idx + 1) + "</span>" +
                          '<span style="flex:1;">' + esc(act.title) + "</span>" +
                          (act.timestamp ? '<span class="activity-time">' + esc(formatShortTime(act.timestamp)) + "</span>" : "") +
                        "</div>" +
                        (act.detail ? '<pre class="detail-pre">' + esc(act.detail) + "</pre>" : "") +
                      "</div>"
                    ).join("") +
                    "</div>"
                  : "") +
              "</div>"
            : "")
        : "";

      const linksHtml = (t.previewURL || t.prUrl)
        ? '<div class="row-left">' +
            (t.previewURL ? '<a class="btn sm primary" style="text-decoration:none;" href="' + esc(t.previewURL) + '" target="_blank" rel="noopener noreferrer">プレビューを開く ↗</a>' : "") +
            (t.prUrl ? '<a class="btn sm" style="text-decoration:none;" href="' + esc(t.prUrl) + '" target="_blank" rel="noopener noreferrer">PR を開く ↗</a>' : "") +
          "</div>"
        : "";

      const worktreeHtml = (wt && wt.hasWorktree) || t.worktreeBranch || t.landError
        ? '<div class="section-label"><span>Git Worktree</span></div>' +
          '<div class="panel-box">' +
            '<div class="row-left">' +
              (t.worktreeBranch ? '<span class="chip code">' + esc(t.worktreeBranch) + "</span>" : "") +
              (t.landStatus ? '<span class="chip ' + (t.landStatus === "landed" ? "ok" : (t.landStatus === "conflict" || t.landStatus === "error" ? "err" : "warn")) + '">Land: ' + esc(t.landStatus) + "</span>" : "") +
              (wt && wt.worktreeExists ? '<span class="chip neutral">+' + esc(wt.aheadCommits) + " commits · " + esc(wt.changedFilesCount) + " changed</span>" : "") +
            "</div>" +
            (t.landError ? '<div style="font-size:12px;color:#fca5a5;">⚠ ' + esc(t.landError) + "</div>" : "") +
            (wt && wt.diffSummary ? '<pre class="detail-pre">' + esc(wt.diffSummary) + "</pre>" : "") +
          "</div>"
        : "";

      const gitStatusHtml = gitStatus && !(wt && wt.diffSummary)
        ? '<div class="section-label"><span>Git Status</span></div><pre class="detail-pre">' + esc(gitStatus) + "</pre>"
        : "";

      const nextHtml =
        '<div class="sheet-header">' +
          '<div class="row">' +
            '<div class="row-left">' +
              '<span class="chip code">T' + esc(t.taskNumber) + "</span>" +
              '<span class="chip neutral">' + esc(t.projectName || "General") + "</span>" +
              (t.provider ? '<span class="chip neutral">' + esc(t.provider.toUpperCase()) + "</span>" : "") +
              '<span class="chip ' + esc(t.status) + '">' + esc(statusLabel(t.status)) + "</span>" +
            "</div>" +
            '<div style="display:flex;gap:6px;flex-shrink:0;">' +
              '<button class="btn sm" onclick="manualRefreshOpenTask()" title="最新情報を再取得">' + (isLoading ? '<span class="spinner" style="width:11px;height:11px;"></span>' : "↻") + "</button>" +
              '<button class="btn sm" onclick="closeTaskSheet()">閉じる</button>' +
            "</div>" +
          "</div>" +
          '<div style="font-size:15px;font-weight:700;line-height:1.35;word-break:break-word;">' + esc(t.title) + "</div>" +
        "</div>" +
        '<div class="sheet-body">' +
          stepBannerHtml +
          (t.summary ? ('<div class="panel-box">' + renderMarkdown(t.summary, basePath) + "</div>") : "") +
          actionsHtml +
          linksHtml +
          outputSectionHtml +
          activitySectionHtml +
          worktreeHtml +
          gitStatusHtml +
        "</div>";

      if (shell._lastHtml === nextHtml) return;
      shell._lastHtml = nextHtml;
      shell.innerHTML = nextHtml;

      const newBodyEl = shell.querySelector(".sheet-body");
      if (newBodyEl && prevScrollTop > 0) {
        newBodyEl.scrollTop = prevScrollTop;
      }
      hydrateProtectedMedia(shell);
    }

    function mentionTaskFromSheet(taskId) {
      addTaskMention(taskId);
      closeTaskSheet();
      switchTab("chat");
    }

    async function taskStatus(id, status, force) {
      try {
        await apiFetch("/api/tasks/" + encodeURIComponent(id) + "/status", { method: "POST", body: JSON.stringify({ status, force: Boolean(force) }) });
        showToast("ステータスを更新しました");
        if (openTaskId === id) {
          if (status === "done") closeTaskSheet();
          else await fetchTaskDetail(id, { skipGit: false, silent: true });
        }
      } catch (err) {
        showToast(err.message);
      }
    }

    async function taskSyncLand(id) {
      try {
        const res = await apiFetch("/api/tasks/" + encodeURIComponent(id) + "/sync-land", { method: "POST", body: JSON.stringify({}) });
        showToast(res.message || "Land 状態を確認しました");
        if (openTaskId === id) {
          await fetchTaskDetail(id, { skipGit: false, silent: false });
        }
      } catch (err) {
        showToast(err.message);
      }
    }

    async function taskStop(id) {
      try {
        await apiFetch("/api/tasks/" + encodeURIComponent(id) + "/stop", { method: "POST", body: JSON.stringify({}) });
        showToast("ワーカーを停止しました");
        if (openTaskId === id) {
          await fetchTaskDetail(id, { skipGit: false, silent: true });
        }
      } catch (err) {
        showToast(err.message);
      }
    }

    async function taskLand(id) {
      try {
        const res = await apiFetch("/api/tasks/" + encodeURIComponent(id) + "/land", { method: "POST", body: JSON.stringify({}) });
        showToast(res.message || "Land 完了");
        if (openTaskId === id) {
          await fetchTaskDetail(id, { skipGit: false, silent: false });
        }
      } catch (err) {
        showToast(err.message);
      }
    }

    function renderSettings() {
      const el = document.getElementById("settingsStatus");
      if (!snapshot) return;
      el.textContent = "接続済み · " + (snapshot.connectionStatus || "") +
        " · Projects: " + (snapshot.projects || []).length +
        " · Tasks: " + (snapshot.tasks || []).length;
    }

    // Auto-extract token from URL query/hash if present
    (function boot() {
      const params = new URLSearchParams(location.search);
      const urlToken = params.get("token");
      if (urlToken) {
        token = urlToken;
        localStorage.setItem(TOKEN_KEY, token);
        history.replaceState({}, "", "/");
      }
      if (token) {
        document.getElementById("tokenInput").value = token;
        connectWithToken();
      }
    })();
  </script>
</body>
</html>`;
}
