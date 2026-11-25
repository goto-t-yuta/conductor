import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ModelOption } from "../shared/types.js";
import { enrichedEnvironment, resolveCodexExecutable } from "./shell-env.js";

export interface CodexNotification {
  method: string;
  params: Record<string, unknown>;
  threadId: string | null;
  turnId: string | null;
  itemId: string | null;
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
        asString(params.conversationId) ??
        asString(asRecord(params.thread)?.id);
      const turnId = asString(params.turnId) ?? asString(asRecord(params.turn)?.id);
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
