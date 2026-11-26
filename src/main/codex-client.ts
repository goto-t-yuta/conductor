import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  ModelOption,
  ProviderQuotaCredits,
  ProviderQuotaSnapshot,
  ProviderQuotaWindow,
} from "../shared/types.js";
import { normalizeRawTokenUsage, type NormalizedRawUsage } from "../shared/usage.js";
import { enrichedEnvironment, resolveCodexExecutable } from "./shell-env.js";

export interface CodexNotification {
  method: string;
  params: Record<string, unknown>;
  threadId: string | null;
  turnId: string | null;
  itemId: string | null;
}

export interface CodexExtractedTokenUsage {
  total: NormalizedRawUsage | null;
  last: NormalizedRawUsage | null;
  direct: NormalizedRawUsage | null;
}

export interface CodexMCPConfig {
  serverName: string;
  url: string;
  bearerTokenEnvVar: string;
  bearerToken: string;
}

interface PendingRpc {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function extractCodexTokenUsage(
  notification: Pick<CodexNotification, "method" | "params">,
): CodexExtractedTokenUsage | null {
  const { method, params } = notification;
  const isUsageMethod =
    method === "thread/tokenUsage/updated" ||
    method === "token_count" ||
    method === "codex/event/token_count" ||
    method === "turn/completed";
  if (!isUsageMethod) return null;

  const turn = asRecord(params.turn);
  const msg = asRecord(params.msg);
  const container =
    asRecord(params.tokenUsage) ??
    asRecord(params.token_usage) ??
    asRecord(params.info) ??
    asRecord(msg?.info) ??
    asRecord(turn?.tokenUsage) ??
    asRecord(turn?.token_usage) ??
    asRecord(turn?.usage) ??
    asRecord(params.usage) ??
    (method === "turn/completed" ? null : params);

  if (!container) return null;

  const rawTotal =
    asRecord(container.total) ??
    asRecord(container.total_token_usage) ??
    asRecord(container.totalTokenUsage);
  const rawLast =
    asRecord(container.last) ??
    asRecord(container.last_token_usage) ??
    asRecord(container.lastTokenUsage);

  const total = rawTotal ? normalizeRawTokenUsage(rawTotal, "codex") : null;
  const last = rawLast ? normalizeRawTokenUsage(rawLast, "codex") : null;
  const direct = !total && !last ? normalizeRawTokenUsage(container, "codex") : null;

  if (!total && !last && !direct) return null;
  return { total, last, direct };
}

function asFiniteNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const parsed = Number(v);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeResetTimestamp(raw: unknown): string | null {
  if (typeof raw === "string" && raw.trim()) {
    const parsedMs = Date.parse(raw);
    if (!Number.isNaN(parsedMs)) {
      return new Date(parsedMs).toISOString();
    }
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) {
      const ms = numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
      return new Date(ms).toISOString();
    }
    return null;
  }
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    const ms = raw > 1_000_000_000_000 ? raw : raw * 1000;
    return new Date(ms).toISOString();
  }
  return null;
}

function parseCodexRateLimitWindow(id: string, raw: unknown): ProviderQuotaWindow | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const usedRaw = asFiniteNumber(rec.usedPercent ?? rec.used_percent);
  if (usedRaw === null) return null;
  const usedPercent = Math.max(0, Math.round(usedRaw * 10) / 10);
  const remainingPercent = Math.max(0, Math.round((100 - usedPercent) * 10) / 10);
  const durationMins = asFiniteNumber(
    rec.windowDurationMins ?? rec.window_minutes ?? rec.windowMinutes,
  );
  const resetsAt = normalizeResetTimestamp(rec.resetsAt ?? rec.resets_at);
  return {
    id,
    windowDurationMins: durationMins !== null && durationMins > 0 ? Math.round(durationMins) : null,
    usedPercent,
    remainingPercent,
    resetsAt,
  };
}

function parseCodexCredits(raw: unknown): ProviderQuotaCredits | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  if (typeof rec.hasCredits !== "boolean" && typeof rec.has_credits !== "boolean") {
    return null;
  }
  const hasCredits = Boolean(rec.hasCredits ?? rec.has_credits);
  const unlimited = Boolean(rec.unlimited);
  const balance =
    typeof rec.balance === "string"
      ? rec.balance
      : typeof rec.balance === "number" && Number.isFinite(rec.balance)
        ? String(rec.balance)
        : null;
  return { hasCredits, unlimited, balance };
}

/**
 * Parses a Codex `account/rateLimits/read` response or `RateLimitSnapshot` payload
 * into a normalized `ProviderQuotaSnapshot`.
 */
export function parseCodexRateLimits(
  raw: unknown,
  now: Date = new Date(),
): ProviderQuotaSnapshot | null {
  const root = asRecord(raw);
  if (!root) return null;

  const byLimitId = asRecord(root.rateLimitsByLimitId ?? root.rate_limits_by_limit_id);
  const snapshot =
    asRecord(root.rateLimits) ??
    asRecord(root.rate_limits) ??
    (byLimitId ? asRecord(byLimitId.codex) ?? asRecord(Object.values(byLimitId)[0]) : null) ??
    root;

  const windows: ProviderQuotaWindow[] = [];
  const primary = parseCodexRateLimitWindow("primary", snapshot.primary);
  if (primary) windows.push(primary);
  const secondary = parseCodexRateLimitWindow("secondary", snapshot.secondary);
  if (secondary) windows.push(secondary);

  const planType = asString(snapshot.planType ?? snapshot.plan_type);
  const limitName =
    asString(snapshot.limitName ?? snapshot.limit_name) ??
    asString(snapshot.limitId ?? snapshot.limit_id);
  const credits = parseCodexCredits(snapshot.credits);

  if (windows.length === 0 && !planType && !credits) {
    return null;
  }

  return {
    provider: "codex",
    status: "live",
    planType: planType ?? null,
    limitName: limitName ?? null,
    credits,
    windows,
    updatedAt: now.toISOString(),
  };
}

export function extractCodexRateLimitUpdate(
  notification: Pick<CodexNotification, "method" | "params">,
  now: Date = new Date(),
): ProviderQuotaSnapshot | null {
  const { method, params } = notification;
  if (method === "account/rateLimits/updated") {
    return parseCodexRateLimits(params, now);
  }
  if (method === "token_count" || method === "codex/event/token_count") {
    const msg = asRecord(params.msg);
    const info = asRecord(params.info) ?? asRecord(msg?.info);
    const rateLimits =
      params.rateLimits ??
      params.rate_limits ??
      msg?.rate_limits ??
      msg?.rateLimits ??
      info?.rate_limits ??
      info?.rateLimits;
    if (rateLimits) {
      return parseCodexRateLimits({ rateLimits }, now);
    }
  }
  return null;
}

export class CodexAppServerClient {
  public readonly label: string;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  private stderrTail = "";
  private nextId = 1;
  private pending = new Map<number, PendingRpc>();
  private connected = false;
  private notificationListeners = new Set<(n: CodexNotification) => void>();
  private disconnectListeners = new Set<(reason: string) => void>();

  constructor(label: string) {
    this.label = label;
  }

  public isConnected(): boolean {
    return this.connected && this.proc !== null;
  }

  public onNotification(listener: (n: CodexNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  public onDisconnect(listener: (reason: string) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  public async connect(mcpConfig?: CodexMCPConfig): Promise<void> {
    if (this.isConnected()) return;

    const codexBin = resolveCodexExecutable();
    if (!codexBin) {
      throw new Error("codex CLI が見つかりませんでした。`codex` をインストールして PATH に通してください。");
    }

    const args = ["app-server"];
    const extraEnv: Record<string, string> = {};
    if (mcpConfig) {
      args.push(
        "-c",
        `mcp_servers.${mcpConfig.serverName}.url="${mcpConfig.url}"`,
        "-c",
        `mcp_servers.${mcpConfig.serverName}.bearer_token_env_var="${mcpConfig.bearerTokenEnvVar}"`,
      );
      extraEnv[mcpConfig.bearerTokenEnvVar] = mcpConfig.bearerToken;
    }

    const proc = spawn(codexBin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: enrichedEnvironment(extraEnv),
    });

    this.proc = proc;
    this.stdoutBuffer = "";
    this.stderrTail = "";

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      this.stdoutBuffer += chunk;
      let idx = this.stdoutBuffer.indexOf("\n");
      while (idx !== -1) {
        const line = this.stdoutBuffer.slice(0, idx).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
        if (line) {
          this.handleLine(line);
        }
        idx = this.stdoutBuffer.indexOf("\n");
      }
    });

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });

    proc.on("exit", (code, signal) => {
      const wasConnected = this.connected;
      this.connected = false;
      this.proc = null;
      const reason = `Codex app-server (${this.label}) exited (code=${code ?? "null"}, signal=${signal ?? "null"}): ${this.stderrTail.trim()}`;
      this.rejectAllPending(new Error(reason));
      if (wasConnected) {
        for (const listener of this.disconnectListeners) {
          listener(reason);
        }
      }
    });

    proc.on("error", (err) => {
      this.connected = false;
      this.proc = null;
      this.rejectAllPending(err);
    });

    await this.request(
      "initialize",
      {
        clientInfo: {
          name: "conductor-electron",
          title: "Conductor",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      },
      60_000,
    );
    this.sendRaw({ method: "initialized" });
    this.connected = true;
  }

  public stop(): void {
    this.connected = false;
    const proc = this.proc;
    this.proc = null;
    this.rejectAllPending(new Error("Codex client stopped"));
    if (proc && !proc.killed) {
      proc.kill("SIGTERM");
    }
  }

  public async listModels(): Promise<ModelOption[]> {
    const models: ModelOption[] = [];
    let cursor: string | null = null;
    do {
      const params: Record<string, unknown> = { includeHidden: false };
      if (cursor) params.cursor = cursor;
      const res = asRecord(await this.request("model/list", params));
      const data = Array.isArray(res?.data) ? res.data : [];
      for (const raw of data) {
        const item = asRecord(raw);
        const modelName = asString(item?.model);
        if (!item || !modelName || item.hidden === true) continue;
        const effortsRaw = Array.isArray(item.supportedReasoningEfforts)
          ? item.supportedReasoningEfforts
          : [];
        const supportedEfforts = effortsRaw
          .map((e) => asString(asRecord(e)?.reasoningEffort))
          .filter((e): e is string => Boolean(e));
        models.push({
          id: asString(item.id) ?? modelName,
          model: modelName,
          displayName: asString(item.displayName) ?? modelName,
          description: asString(item.description) ?? "",
          supportedEfforts,
          defaultEffort: asString(item.defaultReasoningEffort) ?? supportedEfforts[0] ?? "medium",
          isDefault: item.isDefault === true,
        });
      }
      cursor = asString(res?.nextCursor);
    } while (cursor);
    return models;
  }

  public async listRecentThreadCwds(limit = 150): Promise<Array<{ cwd: string; updatedAtMs: number }>> {
    const byCwd = new Map<string, number>();
    let cursor: string | null = null;
    let fetched = 0;

    while (fetched < limit) {
      const pageSize = Math.min(50, limit - fetched);
      const params: Record<string, unknown> = {
        limit: pageSize,
        sortKey: "updated_at",
        sortDirection: "desc",
        archived: false,
      };
      if (cursor) params.cursor = cursor;

      const res = asRecord(await this.request("thread/list", params, 20_000));
      const data = Array.isArray(res?.data) ? res.data : [];
      for (const raw of data) {
        const item = asRecord(raw);
        const cwd = asString(item?.cwd);
        if (!cwd) continue;
        const rawUpdated = typeof item?.updatedAt === "number" ? item.updatedAt : 0;
        const updatedMs = rawUpdated > 1_000_000_000_000 ? rawUpdated : rawUpdated * 1000;
        const prev = byCwd.get(cwd) ?? 0;
        if (updatedMs >= prev) {
          byCwd.set(cwd, updatedMs);
        }
      }
      fetched += data.length;
      cursor = asString(res?.nextCursor);
      if (!cursor || data.length === 0) break;
    }

    return [...byCwd.entries()]
      .map(([cwd, updatedAtMs]) => ({ cwd, updatedAtMs }))
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }

  public async startThread(options: {
    cwd: string;
    model?: string | null;
    developerInstructions?: string;
  }): Promise<string> {
    const params: Record<string, unknown> = {
      cwd: options.cwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    };
    if (options.model) params.model = options.model;
    if (options.developerInstructions) params.developerInstructions = options.developerInstructions;
    const res = asRecord(await this.request("thread/start", params));
    const threadId = asString(asRecord(res?.thread)?.id);
    if (!threadId) throw new Error("thread/start response missing thread.id");
    return threadId;
  }

  public async resumeThread(options: {
    threadId: string;
    cwd: string;
    model?: string | null;
    developerInstructions?: string;
  }): Promise<string> {
    const params: Record<string, unknown> = {
      threadId: options.threadId,
      cwd: options.cwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    };
    if (options.model) params.model = options.model;
    if (options.developerInstructions) params.developerInstructions = options.developerInstructions;
    const res = asRecord(await this.request("thread/resume", params));
    const threadId = asString(asRecord(res?.thread)?.id) ?? options.threadId;
    if (!threadId) throw new Error("thread/resume response missing thread.id");
    return threadId;
  }

  public async startTurn(options: {
    threadId: string;
    text: string;
    imagePaths?: string[];
    model?: string | null;
    effort?: string | null;
  }): Promise<string> {
    const input: Array<Record<string, unknown>> = [];
    if (options.text) {
      input.push({ type: "text", text: options.text, text_elements: [] });
    }
    for (const imgPath of options.imagePaths ?? []) {
      input.push({ type: "localImage", path: imgPath });
    }
    const params: Record<string, unknown> = {
      threadId: options.threadId,
      input,
      summary: "auto",
    };
    if (options.model) params.model = options.model;
    if (options.effort) params.effort = options.effort;
    const res = asRecord(await this.request("turn/start", params));
    const turnId = asString(asRecord(res?.turn)?.id);
    if (!turnId) throw new Error("turn/start response missing turn.id");
    return turnId;
  }

  public async steerTurn(options: {
    threadId: string;
    expectedTurnId: string;
    text: string;
    imagePaths?: string[];
  }): Promise<string> {
    const input: Array<Record<string, unknown>> = [];
    if (options.text) {
      input.push({ type: "text", text: options.text, text_elements: [] });
    }
    for (const imgPath of options.imagePaths ?? []) {
      input.push({ type: "localImage", path: imgPath });
    }
    const params: Record<string, unknown> = {
      threadId: options.threadId,
      expectedTurnId: options.expectedTurnId,
      input,
    };
    const res = asRecord(await this.request("turn/steer", params));
    const turnId =
      asString(res?.turnId) ?? asString(asRecord(res?.turn)?.id) ?? options.expectedTurnId;
    return turnId;
  }

  public async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId });
  }

  public async readAccountRateLimits(): Promise<ProviderQuotaSnapshot | null> {
    const res = await this.request(
      "account/rateLimits/read",
      { excludeResetCreditDetails: true },
      15_000,
    );
    return parseCodexRateLimits(res);
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = 45_000): Promise<unknown> {
    if (!this.proc) {
      return Promise.reject(new Error(`Codex app-server (${this.label}) is not connected`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex RPC timeout: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.sendRaw({ id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private sendRaw(payload: Record<string, unknown>): void {
    if (!this.proc || !this.proc.stdin.writable) {
      throw new Error("Codex app-server stdin is not writable");
    }
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`, "utf8");
  }

  private handleLine(line: string): void {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = asRecord(JSON.parse(line));
    } catch {
      return;
    }
    if (!parsed) return;

    // Client request response
    if (typeof parsed.id === "number" && parsed.method === undefined) {
      const pending = this.pending.get(parsed.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(parsed.id);
      const errObj = asRecord(parsed.error);
      if (errObj) {
        const msg = asString(errObj.message) ?? "Unknown RPC error";
        pending.reject(new Error(`Codex RPC error (${pending.method}): ${msg}`));
      } else {
        pending.resolve(parsed.result);
      }
      return;
    }

    // Server-initiated request
    if (parsed.id !== undefined && typeof parsed.method === "string") {
      this.handleServerRequest(parsed.id, parsed.method);
      return;
    }

    // Server notification
    if (typeof parsed.method === "string") {
      const params = asRecord(parsed.params) ?? {};
      const threadId =
        asString(params.threadId) ??
        asString(params.thread_id) ??
        asString(params.conversationId) ??
        asString(params.conversation_id) ??
        asString(asRecord(params.thread)?.id);
      const turnId =
        asString(params.turnId) ??
        asString(params.turn_id) ??
        asString(asRecord(params.turn)?.id);
      const itemId =
        asString(params.itemId) ??
        asString(params.callId) ??
        asString(asRecord(params.item)?.id);

      const notif: CodexNotification = {
        method: parsed.method,
        params,
        threadId,
        turnId,
        itemId,
      };
      for (const listener of this.notificationListeners) {
        try {
          listener(notif);
        } catch {
          // isolate subscriber errors
        }
      }
    }
  }

  private handleServerRequest(id: unknown, method: string): void {
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "execCommandApproval":
      case "applyPatchApproval":
        this.sendRaw({ id, result: { decision: "accept" } });
        break;
      default:
        this.sendRaw({
          id,
          error: { code: -32601, message: `Unsupported server request: ${method}` },
        });
    }
  }

  private rejectAllPending(error: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }
}
