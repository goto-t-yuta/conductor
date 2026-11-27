import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
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
  TaskStatusUpdateResult,
  TaskWorktreeStatus,
} from "../shared/types.js";

export { buildConductorConnectUri, buildConductorLinkUri, parseConductorConnectUri };

export const DEFAULT_REMOTE_ACCESS_PORT = 4789;
const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024; // 2 MiB
const SSE_HEARTBEAT_INTERVAL_MS = 20_000;

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
  sendMessage(payload: SendMessagePayload): Promise<void>;
  stopMessage(messageId: string): Promise<void>;
  stopAllResponders(): Promise<void>;
  startFreshChat(): Promise<void>;
  selectChatSession?(sessionId: string): Promise<void>;
  updateTaskStatus(taskId: string, status: AgentTaskStatus): TaskStatusUpdateResult;
  stopTaskWorker(taskId: string): Promise<void>;
  landTask(taskId: string, options?: { createPr?: boolean }): Promise<LandTaskResult>;
  getTaskGitStatus(taskId: string): string | null;
  getTaskWorktreeStatus(taskId: string): TaskWorktreeStatus | null;
}

export interface RemoteBridgeServerOptions {
  port?: number;
  host?: string;
  token?: string;
  detectNetwork?: () => TailscaleNetworkInfo;
  onClientsChanged?: (count: number) => void;
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

function sanitizeAttachments(raw: unknown): ChatAttachment[] {
  if (!Array.isArray(raw)) return [];
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
    out.push({
      id: typeof rec.id === "string" && rec.id ? rec.id : crypto.randomUUID(),
      kind: kind as ChatAttachment["kind"],
      label: typeof rec.label === "string" ? rec.label : kind,
      ...(typeof rec.imagePath === "string" ? { imagePath: rec.imagePath } : {}),
      ...(typeof rec.imageDataUrl === "string" ? { imageDataUrl: rec.imageDataUrl } : {}),
      ...(typeof rec.url === "string" ? { url: rec.url } : {}),
      ...(typeof rec.metadataText === "string" ? { metadataText: rec.metadataText } : {}),
    });
  }
  return out;
}

/**
 * Tailscale-ready HTTP + SSE Remote Bridge server for Conductor.
 * Exposes authenticated JSON/SSE endpoints wired directly to ConductorController,
 * plus a mobile-friendly Web UI fallback at `GET /`.
 */
export class RemoteBridgeServer {
  private readonly controller: RemoteBridgeController;
  private readonly detectNetworkFn: () => TailscaleNetworkInfo;
  private readonly onClientsChanged?: (count: number) => void;

  private server: http.Server | null = null;
  private host: string;
  private configuredPort: number;
  private actualPort: number | null = null;
  private token: string;
  private lastError: string | null = null;
  private networkInfo: TailscaleNetworkInfo;
  private readonly sseClients = new Set<http.ServerResponse>();
  private heartbeatTimer: NodeJS.Timeout | null = null;

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
    // Disconnect existing SSE clients authenticated with the old token
    if (this.sseClients.size > 0) {
      for (const client of this.sseClients) {
        try {
          client.end();
        } catch {
          // ignore
        }
      }
      this.sseClients.clear();
      this.onClientsChanged?.(0);
    }
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

    for (const client of this.sseClients) {
      try {
        client.end();
      } catch {
        // ignore
      }
    }
    if (this.sseClients.size > 0) {
      this.sseClients.clear();
      this.onClientsChanged?.(0);
    }

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
    const frame = `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
    for (const client of [...this.sseClients]) {
      if (client.writableEnded || client.destroyed) {
        this.removeSseClient(client);
        continue;
      }
      try {
        client.write(frame);
      } catch {
        this.removeSseClient(client);
      }
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
      if (this.sseClients.size === 0) return;
      for (const client of [...this.sseClients]) {
        if (client.writableEnded || client.destroyed) {
          this.removeSseClient(client);
          continue;
        }
        try {
          client.write(": ping\n\n");
        } catch {
          this.removeSseClient(client);
        }
      }
    }, SSE_HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private removeSseClient(res: http.ServerResponse): void {
    if (this.sseClients.delete(res)) {
      this.onClientsChanged?.(this.sseClients.size);
    }
  }

  private applyCorsHeaders(res: http.ServerResponse): void {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  }

  private sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
    this.applyCorsHeaders(res);
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body, "utf8"),
      "Cache-Control": "no-store",
    });
    res.end(body);
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

    // All other /api/* endpoints require authentication
    if (pathname.startsWith("/api/")) {
      const allowQueryToken = method === "GET" && pathname === "/api/events";
      if (!this.isAuthorized(req, parsedUrl, allowQueryToken)) {
        this.sendJson(res, 401, { ok: false, error: "Unauthorized" });
        return;
      }

      try {
        await this.handleAuthenticatedApi(method, pathname, req, res);
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
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (method === "GET" && pathname === "/api/snapshot") {
      this.sendJson(res, 200, this.controller.getSnapshot());
      return;
    }

    if (method === "GET" && pathname === "/api/events") {
      this.handleSseStream(req, res);
      return;
    }

    if (method === "POST" && pathname === "/api/chat/send") {
      const parsed = await this.readJsonBody(req);
      if (!parsed.ok) {
        this.sendJson(res, parsed.status, { ok: false, error: parsed.error });
        return;
      }
      const text = typeof parsed.data.text === "string" ? parsed.data.text : "";
      const attachments = sanitizeAttachments(parsed.data.attachments);
      const explicitMentions = sanitizeMentions(
        parsed.data.explicitMentions ?? parsed.data.mentions,
      );
      if (!text.trim() && attachments.length === 0) {
        this.sendJson(res, 400, { ok: false, error: "text or attachments is required" });
        return;
      }
      await this.controller.sendMessage({
        text,
        attachments,
        ...(explicitMentions && explicitMentions.length > 0 ? { mentions: explicitMentions } : {}),
      });
      this.sendJson(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && pathname === "/api/chat/stop") {
      const parsed = await this.readJsonBody(req);
      if (!parsed.ok) {
        this.sendJson(res, parsed.status, { ok: false, error: parsed.error });
        return;
      }
      const messageId =
        typeof parsed.data.messageId === "string" ? parsed.data.messageId.trim() : "";
      if (messageId) {
        await this.controller.stopMessage(messageId);
      } else {
        await this.controller.stopAllResponders();
      }
      this.sendJson(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && pathname === "/api/chat/new") {
      await this.controller.startFreshChat();
      this.sendJson(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && pathname === "/api/chat/session") {
      const parsed = await this.readJsonBody(req);
      if (!parsed.ok) {
        this.sendJson(res, parsed.status, { ok: false, error: parsed.error });
        return;
      }
      const sessionId =
        typeof parsed.data.sessionId === "string" ? parsed.data.sessionId.trim() : "";
      if (!sessionId) {
        this.sendJson(res, 400, { ok: false, error: "sessionId is required" });
        return;
      }
      if (this.controller.selectChatSession) {
        await this.controller.selectChatSession(sessionId);
      }
      this.sendJson(res, 200, { ok: true });
      return;
    }

    // /api/tasks/:id and /api/tasks/:id/(status|stop|land)
    const taskActionMatch = /^\/api\/tasks\/([^/]+)(?:\/(status|stop|land))?$/.exec(pathname);
    if (taskActionMatch) {
      const rawTaskId = decodeURIComponent(taskActionMatch[1]);
      const action = taskActionMatch[2] ?? null;
      const snapshot = this.controller.getSnapshot();
      const task = resolveTaskByIdOrCode(snapshot.tasks, rawTaskId);

      if (!task) {
        this.sendJson(res, 404, { ok: false, error: "Task not found" });
        return;
      }

      if (method === "GET" && !action) {
        const worktreeStatus = this.controller.getTaskWorktreeStatus(task.id);
        const gitStatus = this.controller.getTaskGitStatus(task.id);
        this.sendJson(res, 200, {
          ok: true,
          task,
          worktreeStatus,
          gitStatus,
        });
        return;
      }

      if (method === "POST" && action === "status") {
        const parsed = await this.readJsonBody(req);
        if (!parsed.ok) {
          this.sendJson(res, parsed.status, { ok: false, error: parsed.error });
          return;
        }
        const status = typeof parsed.data.status === "string" ? parsed.data.status.trim() : "";
        if (!VALID_TASK_STATUSES.has(status as AgentTaskStatus)) {
          this.sendJson(res, 400, {
            ok: false,
            error: "Invalid status. Expected queued | running | needs_review | done | failed",
          });
          return;
        }
        const result = this.controller.updateTaskStatus(task.id, status as AgentTaskStatus);
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

      this.sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
      return;
    }

    this.sendJson(res, 404, { ok: false, error: "Not Found" });
  }

  private handleSseStream(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.applyCorsHeaders(res);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    this.sseClients.add(res);
    this.onClientsChanged?.(this.sseClients.size);

    // Send initial snapshot immediately
    try {
      const snapshot = this.controller.getSnapshot();
      res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
    } catch {
      this.removeSseClient(res);
      res.end();
      return;
    }

    req.on("close", () => {
      this.removeSseClient(res);
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
      --surface: #171a22;
      --surface2: #1f2430;
      --border: #2a3040;
      --text: #f4f4f6;
      --muted: #9ca3af;
      --accent: #6366f1;
      --accent-soft: rgba(99, 102, 241, 0.16);
      --ok: #10b981;
      --warn: #f59e0b;
      --err: #ef4444;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0; padding: 0; height: 100%;
      background: var(--bg); color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    body { display: flex; flex-direction: column; overflow: hidden; }
    header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 14px; background: var(--surface);
      border-bottom: 1px solid var(--border); gap: 8px;
    }
    .brand { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 15px; }
    .dot { width: 9px; height: 9px; border-radius: 99px; background: var(--muted); display: inline-block; }
    .dot.live { background: var(--ok); box-shadow: 0 0 8px var(--ok); }
    .dot.warn { background: var(--warn); }
    .dot.err { background: var(--err); }
    .btn {
      border: 1px solid var(--border); background: var(--surface2); color: var(--text);
      border-radius: 10px; padding: 7px 11px; font-size: 12.5px; font-weight: 600;
      cursor: pointer; display: inline-flex; align-items: center; gap: 5px;
    }
    .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    .btn.danger { background: rgba(239,68,68,.16); border-color: rgba(239,68,68,.4); color: #fca5a5; }
    .btn.ok { background: rgba(16,185,129,.16); border-color: rgba(16,185,129,.4); color: #6ee7b7; }
    .btn:disabled { opacity: .45; }
    .tabs {
      display: flex; background: var(--surface); border-top: 1px solid var(--border);
      padding-bottom: env(safe-area-inset-bottom, 0px);
    }
    .tab {
      flex: 1; padding: 11px 6px; text-align: center; font-size: 12.5px; font-weight: 600;
      color: var(--muted); background: none; border: none; cursor: pointer;
    }
    .tab.active { color: #a5b4fc; border-top: 2px solid var(--accent); }
    main { flex: 1; overflow: hidden; display: flex; flex-direction: column; position: relative; }
    .view { display: none; flex: 1; overflow: hidden; flex-direction: column; }
    .view.active { display: flex; }
    .scroll { flex: 1; overflow-y: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
    .msg {
      max-width: 90%; padding: 10px 12px; border-radius: 14px;
      font-size: 14px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
    }
    .msg.user { align-self: flex-end; background: var(--accent); color: #fff; border-bottom-right-radius: 4px; }
    .msg.assistant { align-self: flex-start; background: var(--surface2); border: 1px solid var(--border); border-bottom-left-radius: 4px; }
    .msg.system, .msg.taskEvent { align-self: center; max-width: 96%; background: var(--surface); border: 1px solid var(--border); font-size: 12px; color: var(--muted); }
    .meta { font-size: 11px; color: var(--muted); margin-bottom: 4px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .chip {
      display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600;
      padding: 2px 7px; border-radius: 99px; background: var(--accent-soft); color: #c7d2fe;
    }
    .composer-wrap {
      border-top: 1px solid var(--border); background: var(--surface); padding: 8px 10px;
      display: flex; flex-direction: column; gap: 6px;
    }
    .mentions-bar { display: flex; flex-wrap: wrap; gap: 6px; }
    .composer { display: flex; gap: 6px; align-items: flex-end; }
    textarea, input {
      width: 100%; background: var(--bg); color: var(--text);
      border: 1px solid var(--border); border-radius: 10px;
      padding: 9px 11px; font-size: 14px; font-family: inherit; outline: none;
    }
    textarea:focus, input:focus { border-color: var(--accent); }
    .card {
      background: var(--surface); border: 1px solid var(--border); border-radius: 14px;
      padding: 12px; display: flex; flex-direction: column; gap: 6px;
    }
    .group-title { font-size: 11.5px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; margin-top: 4px; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    .toast {
      position: fixed; top: 58px; left: 14px; right: 14px; z-index: 60;
      background: #1e293b; border: 1px solid var(--border); color: var(--text);
      padding: 10px 12px; border-radius: 10px; font-size: 12.5px; display: none;
    }
    .modal-bg {
      position: fixed; inset: 0; background: rgba(0,0,0,.65); z-index: 50;
      display: none; align-items: flex-end; justify-content: center;
    }
    .modal-bg.open { display: flex; }
    .sheet {
      width: 100%; max-width: 640px; max-height: 82vh; overflow-y: auto;
      background: var(--surface); border-top-left-radius: 18px; border-top-right-radius: 18px;
      border-top: 1px solid var(--border); padding: 16px; display: flex; flex-direction: column; gap: 10px;
    }
    pre {
      margin: 0; background: var(--bg); border: 1px solid var(--border); border-radius: 10px;
      padding: 10px; font-size: 11.5px; overflow-x: auto; white-space: pre-wrap; word-break: break-word;
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <span id="connDot" class="dot"></span>
      <span>Conductor Remote</span>
    </div>
    <div style="display:flex;gap:6px;">
      <button id="stopAllBtn" class="btn danger" style="display:none;" onclick="stopAll()">停止</button>
      <button id="newChatBtn" class="btn" style="display:none;" onclick="newChat()">新規</button>
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
    <button class="tab" data-tab="tasks" onclick="switchTab('tasks')">タスク</button>
    <button class="tab" data-tab="settings" onclick="switchTab('settings')">設定</button>
  </nav>

  <!-- Mention Picker Modal -->
  <div id="mentionModal" class="modal-bg" onclick="closeMentionSheet()">
    <div class="sheet" onclick="event.stopPropagation()">
      <div class="row">
        <strong>@ メンションを追加</strong>
        <button class="btn" onclick="closeMentionSheet()">閉じる</button>
      </div>
      <div id="mentionList" style="display:flex;flex-direction:column;gap:6px;"></div>
    </div>
  </div>

  <!-- Task Detail Modal -->
  <div id="taskModal" class="modal-bg" onclick="closeTaskSheet()">
    <div id="taskSheetBody" class="sheet" onclick="event.stopPropagation()"></div>
  </div>

  <script>
    const TOKEN_KEY = "conductor_remote_token";
    let token = localStorage.getItem(TOKEN_KEY) || "";
    let snapshot = null;
    let eventSource = null;
    let pollTimer = null;
    let currentTab = "chat";
    let selectedMentions = [];
    let openTaskId = null;

    function esc(s) {
      return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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
      const res = await fetch(path, Object.assign({}, options, { headers }));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || data.message || ("HTTP " + res.status));
      }
      return data;
    }

    async function connectWithToken() {
      const input = document.getElementById("tokenInput").value.trim();
      if (!input) { showToast("トークンを入力してください"); return; }
      token = input;
      try {
        const snap = await apiFetch("/api/snapshot");
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
      localStorage.removeItem(TOKEN_KEY);
      token = "";
      snapshot = null;
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
        try { applySnapshot(JSON.parse(ev.data)); } catch {}
      });
      eventSource.onerror = () => {
        setDot("warn");
        if (!pollTimer) {
          pollTimer = setInterval(async () => {
            try { applySnapshot(await apiFetch("/api/snapshot")); } catch {}
          }, 4000);
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

    function applySnapshot(next) {
      snapshot = next;
      const streaming = (snapshot.activeResponderCount || 0) > 0;
      document.getElementById("stopAllBtn").style.display = streaming ? "inline-flex" : "none";
      renderChat();
      renderTasks();
      renderSettings();
      if (openTaskId) renderTaskSheet(openTaskId);
    }

    function renderChat() {
      const el = document.getElementById("chatScroll");
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
      const msgs = (snapshot && snapshot.messages) || [];
      if (msgs.length === 0) {
        el.innerHTML = '<div style="text-align:center;color:var(--muted);margin-top:40px;font-size:13px;">メッセージはまだありません</div>';
        return;
      }
      el.innerHTML = msgs.map((m) => {
        const mentions = (m.mentions || []).map((ref) =>
          '<span class="chip">@' + esc(ref.kind === "task" ? ("T" + ref.taskNumber) : ref.projectName) + "</span>"
        ).join("");
        const stopBtn = m.isStreaming
          ? ' <button class="btn danger" style="padding:2px 7px;font-size:11px;" onclick="stopMsg(\\'' + esc(m.id) + '\\')">停止</button>'
          : "";
        const meta = m.role === "assistant"
          ? '<div class="meta"><span>' + esc(m.provider || "conductor") + "</span>" + (m.isStreaming ? "<span>● 応答中...</span>" : "") + stopBtn + "</div>"
          : (mentions ? '<div class="meta">' + mentions + "</div>" : "");
        return '<div class="msg ' + esc(m.role) + '">' + meta + esc(m.text || (m.isStreaming ? "..." : "")) + "</div>";
      }).join("");
      if (nearBottom) el.scrollTop = el.scrollHeight;
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
        await apiFetch("/api/chat/send", {
          method: "POST",
          body: JSON.stringify({ text, explicitMentions: mentionsToSend, attachments: [] }),
        });
      } catch (err) {
        showToast("送信エラー: " + err.message);
      }
    }

    async function stopMsg(id) {
      try { await apiFetch("/api/chat/stop", { method: "POST", body: JSON.stringify({ messageId: id }) }); }
      catch (err) { showToast(err.message); }
    }

    async function stopAll() {
      try { await apiFetch("/api/chat/stop", { method: "POST", body: JSON.stringify({}) }); }
      catch (err) { showToast(err.message); }
    }

    async function newChat() {
      try { await apiFetch("/api/chat/new", { method: "POST", body: JSON.stringify({}) }); }
      catch (err) { showToast(err.message); }
    }

    function renderTasks() {
      const el = document.getElementById("tasksScroll");
      const tasks = (snapshot && snapshot.tasks) || [];
      const running = tasks.filter((t) => t.status === "running");
      const review = tasks.filter((t) => t.status === "needs_review" || t.status === "queued" || t.status === "failed");
      const done = tasks.filter((t) => t.status === "done");
      const section = (title, arr) => {
        if (arr.length === 0) return "";
        return '<div class="group-title">' + esc(title) + " (" + arr.length + ")</div>" + arr.map((t) =>
          '<div class="card" style="cursor:pointer;" onclick="openTaskSheet(\\'' + esc(t.id) + '\\')">' +
          '<div class="row"><strong>T' + esc(t.taskNumber) + " · " + esc(t.title) + '</strong><span class="chip">' + esc(t.status) + "</span></div>" +
          '<div style="font-size:12px;color:var(--muted);">' + esc(t.projectName || "General") + (t.currentStep ? (" · " + esc(t.currentStep)) : "") + "</div>" +
          "</div>"
        ).join("");
      };
      el.innerHTML = section("実行中", running) + section("レビュー待ち / その他", review) + section("完了", done) ||
        '<div style="text-align:center;color:var(--muted);margin-top:40px;font-size:13px;">タスクはありません</div>';
    }

    async function openTaskSheet(taskId) {
      openTaskId = taskId;
      document.getElementById("taskModal").classList.add("open");
      renderTaskSheet(taskId);
      try {
        const detail = await apiFetch("/api/tasks/" + encodeURIComponent(taskId));
        if (openTaskId === taskId) renderTaskSheet(taskId, detail);
      } catch {}
    }

    function closeTaskSheet() {
      openTaskId = null;
      document.getElementById("taskModal").classList.remove("open");
    }

    function renderTaskSheet(taskId, detail) {
      const t = (detail && detail.task) || ((snapshot && snapshot.tasks) || []).find((x) => x.id === taskId);
      if (!t) return;
      const body = document.getElementById("taskSheetBody");
      const isRunning = t.status === "running";
      const isDone = t.status === "done";
      const hasWorktree = Boolean(t.worktreePath || t.worktreeBranch);
      body.innerHTML =
        '<div class="row"><strong>T' + esc(t.taskNumber) + " · " + esc(t.title) + '</strong><button class="btn" onclick="closeTaskSheet()">閉じる</button></div>' +
        '<div class="meta"><span class="chip">' + esc(t.status) + "</span><span>" + esc(t.projectName || "General") + "</span>" +
        (t.landStatus ? ('<span class="chip">Land: ' + esc(t.landStatus) + "</span>") : "") + "</div>" +
        (t.summary ? ('<div style="font-size:13px;">' + esc(t.summary) + "</div>") : "") +
        '<div class="row">' +
          (isRunning ? '<button class="btn danger" onclick="taskStop(\\'' + esc(t.id) + '\\')">ワーカー停止</button>' : "") +
          (!isRunning && hasWorktree ? '<button class="btn primary" onclick="taskLand(\\'' + esc(t.id) + '\\')">Land</button>' : "") +
          (!isDone ? '<button class="btn ok" onclick="taskStatus(\\'' + esc(t.id) + '\\', \\'done\\')">Done</button>'
                   : '<button class="btn" onclick="taskStatus(\\'' + esc(t.id) + '\\', \\'needs_review\\')">Reopen</button>') +
        "</div>" +
        (t.latestOutput ? ('<div style="font-size:12px;color:var(--muted);">最新出力</div><pre>' + esc(t.latestOutput) + "</pre>") : "") +
        (detail && detail.gitStatus ? ('<div style="font-size:12px;color:var(--muted);">Git Status</div><pre>' + esc(detail.gitStatus) + "</pre>") : "");
    }

    async function taskStatus(id, status) {
      try {
        await apiFetch("/api/tasks/" + encodeURIComponent(id) + "/status", { method: "POST", body: JSON.stringify({ status }) });
        showToast("ステータスを更新しました");
      } catch (err) {
        showToast(err.message);
      }
    }

    async function taskStop(id) {
      try {
        await apiFetch("/api/tasks/" + encodeURIComponent(id) + "/stop", { method: "POST", body: JSON.stringify({}) });
        showToast("ワーカーを停止しました");
      } catch (err) {
        showToast(err.message);
      }
    }

    async function taskLand(id) {
      try {
        const res = await apiFetch("/api/tasks/" + encodeURIComponent(id) + "/land", { method: "POST", body: JSON.stringify({}) });
        showToast(res.message || "Land 完了");
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
