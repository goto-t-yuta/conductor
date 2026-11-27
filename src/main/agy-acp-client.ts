import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ModelOption } from "../shared/types.js";
import { normalizeRawTokenUsage, type NormalizedRawUsage } from "../shared/usage.js";
import { enrichedEnvironment, resolveAgyExecutable } from "./shell-env.js";

export interface AgyAcpMcpServerConfig {
  name: string;
  url: string;
  bearerToken: string;
}

export interface AgyAcpSessionUpdate {
  sessionId: string;
  updateType: string;
  raw: Record<string, unknown>;
}

export interface AgyAcpSessionInfo {
  sessionId: string;
  availableModels: ModelOption[];
  currentModelId: string | null;
  currentThoughtLevel: string | null;
}

export interface AgyAcpPromptResult {
  stopReason: string;
  usage?: Record<string, unknown>;
  normalizedUsage?: NormalizedRawUsage;
}

export type ParsedAgySessionUpdate =
  | { kind: "textDelta"; text: string }
  | { kind: "reasoningDelta"; text: string }
  | {
      kind: "toolEvent";
      id: string;
      name: string | null;
      detail?: string;
      completed: boolean;
      isError: boolean;
    }
  | {
      kind: "configOptionUpdate";
      modelValue: string | null;
      thoughtLevel: string | null;
    }
  | {
      kind: "usageUpdate";
      usage: NormalizedRawUsage;
    }
  | { kind: "other"; updateType: string };

export interface AgyAcpClientOptions {
  spawnProcess?: (
    command: string,
    args: string[],
    options: { cwd?: string; env: NodeJS.ProcessEnv },
  ) => ChildProcessWithoutNullStreams;
  resolveExecutable?: () => string | null;
  requestTimeoutMs?: number;
}

interface PendingRpc {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
}

const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function extractAgyPromptUsage(
  res: Record<string, unknown> | null | undefined,
): NormalizedRawUsage | null {
  if (!res) return null;
  const meta = asRecord(res._meta);
  const rawUsage =
    asRecord(res.usage) ??
    asRecord(res.tokenUsage) ??
    asRecord(res.token_usage) ??
    asRecord(res.usageMetadata) ??
    asRecord(res.usage_metadata) ??
    asRecord(meta?.usage) ??
    asRecord(meta?.tokenUsage) ??
    asRecord(meta?.token_usage);

  if (!rawUsage) return null;

  const merged: Record<string, unknown> = { ...rawUsage };
  if (
    merged.cost === undefined &&
    merged.costUsd === undefined &&
    merged.cost_usd === undefined &&
    merged.totalCostUsd === undefined &&
    merged.total_cost_usd === undefined
  ) {
    if (res.cost !== undefined) merged.cost = res.cost;
    else if (res.total_cost_usd !== undefined) merged.total_cost_usd = res.total_cost_usd;
    else if (res.totalCostUsd !== undefined) merged.totalCostUsd = res.totalCostUsd;
    else if (res.costUsd !== undefined) merged.costUsd = res.costUsd;
    else if (res.cost_usd !== undefined) merged.cost_usd = res.cost_usd;
  }
  if (merged.model === undefined && typeof res.model === "string") {
    merged.model = res.model;
  }
  return normalizeRawTokenUsage(merged, "agy");
}

function guessImageMimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".png":
    default:
      return "image/png";
  }
}

export function extractAgyToolDetail(
  update: Record<string, unknown>,
): string | undefined {
  const input = asRecord(update.rawInput) ?? asRecord(update.args);
  const fromInput =
    asString(input?.toolSummary) ??
    asString(input?.command) ??
    asString(input?.file_path) ??
    asString(input?.path) ??
    asString(input?.url) ??
    asString(input?.query) ??
    asString(input?.target) ??
    asString(input?.title) ??
    asString(input?.project_name);
  if (fromInput) return fromInput;
  const title = asString(update.title);
  if (title && !title.startsWith("Run ")) return title;
  return undefined;
}

function extractAgyContentText(update: Record<string, unknown>): string {
  if (Array.isArray(update.content)) {
    const parts: string[] = [];
    for (const rawBlock of update.content) {
      const block = asRecord(rawBlock);
      const text = asString(block?.text);
      if (text) parts.push(text);
    }
    if (parts.length > 0) {
      return parts.join("");
    }
  }
  const content = asRecord(update.content);
  return asString(content?.text) ?? asString(update.text) ?? "";
}

export function parseAgySessionUpdate(
  update: Record<string, unknown>,
): ParsedAgySessionUpdate {
  const updateType = asString(update.sessionUpdate) ?? "";

  if (updateType === "agent_message_chunk") {
    const text = extractAgyContentText(update);
    if (text) {
      return { kind: "textDelta", text };
    }
    return { kind: "other", updateType };
  }

  if (updateType === "agent_thought_chunk") {
    const text = extractAgyContentText(update);
    if (text) {
      return { kind: "reasoningDelta", text };
    }
    return { kind: "other", updateType };
  }

  if (updateType === "tool_call" || updateType === "tool_call_update") {
    const id = asString(update.toolCallId) ?? asString(update.id) ?? "";
    const name =
      asString(update.name) ??
      asString(update.toolName) ??
      null;
    const status = (asString(update.status) ?? "").toLowerCase();
    const isError = status === "failed" || status === "error";
    const completed =
      status === "completed" ||
      status === "failed" ||
      status === "error" ||
      status === "cancelled";
    const detail = extractAgyToolDetail(update);
    return {
      kind: "toolEvent",
      id,
      name,
      detail,
      completed,
      isError,
    };
  }

  if (updateType === "config_option_update") {
    const options = Array.isArray(update.configOptions) ? update.configOptions : [];
    let modelValue: string | null = null;
    let thoughtLevel: string | null = null;
    for (const rawOpt of options) {
      const opt = asRecord(rawOpt);
      const id = asString(opt?.id) ?? asString(opt?.category);
      const val = asString(opt?.currentValue);
      if (id === "model") modelValue = val;
      if (id === "thought_level") thoughtLevel = val;
    }
    return { kind: "configOptionUpdate", modelValue, thoughtLevel };
  }

  if (updateType === "usage_update" || updateType === "token_usage") {
    const usage =
      extractAgyPromptUsage(update) ?? normalizeRawTokenUsage(update, "agy");
    if (usage) {
      return { kind: "usageUpdate", usage };
    }
    return { kind: "other", updateType };
  }

  return { kind: "other", updateType };
}

export function parseAgyAvailableModels(rawModels: unknown): ModelOption[] {
  const modelsRec = asRecord(rawModels);
  const list = Array.isArray(modelsRec?.availableModels)
    ? modelsRec.availableModels
    : [];
  const parsed: ModelOption[] = [];
  for (const raw of list) {
    const item = asRecord(raw);
    const id = asString(item?.modelId) ?? asString(item?.id);
    if (!id) continue;
    const displayName = asString(item?.name) ?? id;
    parsed.push({
      id,
      model: id,
      displayName,
      description: asString(item?.description) ?? "",
      supportedEfforts: [],
      defaultEffort: "",
      isDefault: id === "gemini-3.8-flash-low" || id === "gemini-4-neon-high",
    });
  }
  return parsed;
}

/**
 * Resident stdio JSON-RPC 2.0 client for `agy acp`.
 * Keeps a single long-lived `agy acp` process running so multiple concurrent
 * Orchestrator sessions can answer rapid-fire / parallel questions without
 * per-turn process startup latency.
 */
export class AgyAcpClient {
  public readonly label: string;
  private readonly spawnProcess: NonNullable<AgyAcpClientOptions["spawnProcess"]>;
  private readonly resolveExecutable: NonNullable<AgyAcpClientOptions["resolveExecutable"]>;
  private readonly requestTimeoutMs: number;

  private proc: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  private stderrTail = "";
  private nextId = 1;
  private pending = new Map<number, PendingRpc>();
  private connected = false;
  private intentionalStop = false;
  private connectPromise: Promise<void> | null = null;
  private connectedAtMs = 0;
  private lastUptimeMs = 0;
  private cachedModels: ModelOption[] = [];
  private sessionResumeSupported = false;

  private updateListeners = new Set<(update: AgyAcpSessionUpdate) => void>();
  private disconnectListeners = new Set<(reason: string) => void>();

  constructor(label = "orchestrator", options: AgyAcpClientOptions = {}) {
    this.label = label;
    this.spawnProcess =
      options.spawnProcess ??
      ((command, args, spawnOpts) =>
        spawn(command, args, {
          cwd: spawnOpts.cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: spawnOpts.env,
        }));
    this.resolveExecutable = options.resolveExecutable ?? resolveAgyExecutable;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 45_000;
  }

  public isAvailable(): boolean {
    return this.resolveExecutable() !== null;
  }

  public isConnected(): boolean {
    return this.connected && this.proc !== null;
  }

  public getUptimeMs(): number {
    if (this.connected && this.connectedAtMs > 0) {
      return Math.max(0, Date.now() - this.connectedAtMs);
    }
    return this.lastUptimeMs;
  }

  public getCachedModels(): ModelOption[] {
    return this.cachedModels;
  }

  public supportsSessionResume(): boolean {
    return this.sessionResumeSupported;
  }

  public onSessionUpdate(listener: (update: AgyAcpSessionUpdate) => void): () => void {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  public onDisconnect(listener: (reason: string) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  public async connect(options?: { cwd?: string }): Promise<void> {
    if (this.isConnected()) return;
    if (this.connectPromise) return this.connectPromise;

    const promise = this.doConnect(options);
    this.connectPromise = promise;
    try {
      await promise;
    } finally {
      if (this.connectPromise === promise) {
        this.connectPromise = null;
      }
    }
  }

  private async doConnect(options?: { cwd?: string }): Promise<void> {
    const agyBin = this.resolveExecutable();
    if (!agyBin) {
      throw new Error("agy CLI が見つかりませんでした。`~/.local/bin/agy` を確認してください。");
    }

    this.intentionalStop = false;
    const proc = this.spawnProcess(agyBin, ["acp", "--dangerously-skip-permissions"], {
      cwd: options?.cwd,
      env: enrichedEnvironment(),
    });

    this.proc = proc;
    this.stdoutBuffer = "";
    this.stderrTail = "";
    this.connected = false;

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      if (this.proc !== proc) return;
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
      if (this.proc !== proc) return;
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });

    proc.on("exit", (code, signal) => {
      if (this.proc !== proc) return;
      const wasConnected = this.connected;
      const wasIntentional = this.intentionalStop;
      this.lastUptimeMs =
        this.connectedAtMs > 0 ? Math.max(0, Date.now() - this.connectedAtMs) : 0;
      this.connected = false;
      this.proc = null;
      this.connectedAtMs = 0;
      const tail = this.stderrTail.trim();
      const reason = `AGY ACP (${this.label}) exited (code=${code ?? "null"}, signal=${signal ?? "null"})${tail ? `: ${tail}` : ""}`;
      this.rejectAllPending(new Error(reason));
      if (wasConnected && !wasIntentional) {
        for (const listener of this.disconnectListeners) {
          try {
            listener(reason);
          } catch {
            // isolate subscriber errors
          }
        }
      }
    });

    proc.on("error", (err) => {
      if (this.proc !== proc) return;
      const wasConnected = this.connected;
      const wasIntentional = this.intentionalStop;
      this.lastUptimeMs =
        this.connectedAtMs > 0 ? Math.max(0, Date.now() - this.connectedAtMs) : 0;
      this.connected = false;
      this.proc = null;
      this.connectedAtMs = 0;
      this.rejectAllPending(err);
      if (wasConnected && !wasIntentional) {
        const reason = `AGY ACP (${this.label}) error: ${err.message}`;
        for (const listener of this.disconnectListeners) {
          try {
            listener(reason);
          } catch {
            // isolate subscriber errors
          }
        }
      }
    });

    try {
      const initRes = asRecord(
        await this.request(
          "initialize",
          {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: {
              name: "conductor-electron",
              version: "0.1.0",
            },
          },
          Math.max(this.requestTimeoutMs, 60_000),
        ),
      );
      if (this.proc !== proc) {
        throw new Error(`AGY ACP (${this.label}) stopped during initialization`);
      }
      const caps = asRecord(initRes?.agentCapabilities);
      const sessCaps = asRecord(caps?.sessionCapabilities) ?? asRecord(caps?.session_capabilities);
      this.sessionResumeSupported = Boolean(sessCaps && sessCaps.resume !== undefined);
      this.connected = true;
      this.connectedAtMs = Date.now();
    } catch (err) {
      if (this.proc === proc) {
        this.intentionalStop = true;
        this.connected = false;
        this.proc = null;
        this.connectedAtMs = 0;
        if (!proc.killed) {
          try {
            proc.kill("SIGTERM");
          } catch {
            // ignore
          }
        }
      }
      throw err;
    }
  }

  public stop(): void {
    this.intentionalStop = true;
    this.connected = false;
    this.connectedAtMs = 0;
    this.connectPromise = null;
    const proc = this.proc;
    this.proc = null;
    this.rejectAllPending(new Error(`AGY ACP (${this.label}) stopped`));
    if (proc) {
      try {
        if (proc.stdin.writable) {
          proc.stdin.end();
        }
      } catch {
        // ignore
      }
      if (!proc.killed) {
        try {
          proc.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
    }
  }

  public async createSession(options: {
    cwd: string;
    mcpServers?: AgyAcpMcpServerConfig[];
    systemPromptAppend?: string;
  }): Promise<AgyAcpSessionInfo> {
    const mcpServers = (options.mcpServers ?? []).map((srv) => ({
      name: srv.name,
      type: "http",
      url: srv.url,
      headers: [
        {
          name: "Authorization",
          value: `Bearer ${srv.bearerToken}`,
        },
      ],
    }));

    const params: Record<string, unknown> = {
      cwd: options.cwd,
      mcpServers,
    };
    if (options.systemPromptAppend) {
      params._meta = {
        antigravity: {
          systemPrompt: {
            append: options.systemPromptAppend,
          },
        },
      };
    }

    const res = asRecord(await this.request("session/new", params, this.requestTimeoutMs));
    return this.parseSessionResponse(res, "session/new");
  }

  public async resumeSession(options: {
    sessionId: string;
    cwd: string;
    mcpServers?: AgyAcpMcpServerConfig[];
    systemPromptAppend?: string;
  }): Promise<AgyAcpSessionInfo> {
    if (!this.sessionResumeSupported) {
      throw new Error("AGY ACP server does not support session/resume");
    }
    const mcpServers = (options.mcpServers ?? []).map((srv) => ({
      name: srv.name,
      type: "http",
      url: srv.url,
      headers: [
        {
          name: "Authorization",
          value: `Bearer ${srv.bearerToken}`,
        },
      ],
    }));

    const params: Record<string, unknown> = {
      sessionId: options.sessionId,
      cwd: options.cwd,
      mcpServers,
    };
    if (options.systemPromptAppend) {
      params._meta = {
        antigravity: {
          systemPrompt: {
            append: options.systemPromptAppend,
          },
        },
      };
    }

    const res = asRecord(
      await this.request("session/resume", params, Math.min(this.requestTimeoutMs, 15_000)),
    );
    return this.parseSessionResponse(res, "session/resume", options.sessionId);
  }

  private parseSessionResponse(
    res: Record<string, unknown> | null,
    method: string,
    fallbackSessionId?: string,
  ): AgyAcpSessionInfo {
    const sessionId = asString(res?.sessionId) ?? fallbackSessionId ?? null;
    if (!sessionId) {
      throw new Error(`AGY ACP ${method} response missing sessionId`);
    }

    const availableModels = parseAgyAvailableModels(res?.models);
    if (availableModels.length > 0) {
      this.cachedModels = availableModels;
    }

    const modelsRec = asRecord(res?.models);
    const currentModelId = asString(modelsRec?.currentModelId);
    let currentThoughtLevel: string | null = null;
    const configOptions = Array.isArray(res?.configOptions) ? res.configOptions : [];
    for (const rawOpt of configOptions) {
      const opt = asRecord(rawOpt);
      if (asString(opt?.id) === "thought_level" || asString(opt?.category) === "thought_level") {
        currentThoughtLevel = asString(opt?.currentValue);
      }
    }

    return {
      sessionId,
      availableModels,
      currentModelId,
      currentThoughtLevel,
    };
  }

  public async setModel(sessionId: string, modelId: string): Promise<void> {
    await this.request("session/set_model", { sessionId, modelId }, this.requestTimeoutMs);
  }

  public async setEffort(sessionId: string, effort: string): Promise<void> {
    await this.request(
      "session/set_config_option",
      { sessionId, configId: "thought_level", value: effort },
      this.requestTimeoutMs,
    );
  }

  public async prompt(options: {
    sessionId: string;
    text: string;
    imagePaths?: string[];
  }): Promise<AgyAcpPromptResult> {
    const blocks: Array<Record<string, unknown>> = [];
    const fallbackImagePaths: string[] = [];

    for (const imgPath of options.imagePaths ?? []) {
      try {
        const stat = fs.statSync(imgPath);
        if (stat.isFile() && stat.size <= MAX_INLINE_IMAGE_BYTES) {
          const data = fs.readFileSync(imgPath).toString("base64");
          blocks.push({
            type: "image",
            data,
            mimeType: guessImageMimeType(imgPath),
          });
        } else {
          fallbackImagePaths.push(imgPath);
        }
      } catch {
        fallbackImagePaths.push(imgPath);
      }
    }

    let text = options.text;
    if (fallbackImagePaths.length > 0) {
      text +=
        "\n\n[Attached local image files (inspect with read_file if needed)]\n" +
        fallbackImagePaths.map((p) => `- ${p}`).join("\n");
    }

    blocks.unshift({ type: "text", text });

    // No short timeout on session/prompt because turns with tool execution can run for minutes.
    const res = asRecord(
      await this.request(
        "session/prompt",
        {
          sessionId: options.sessionId,
          prompt: blocks,
        },
        0,
      ),
    );

    const rawUsage =
      asRecord(res?.usage) ??
      asRecord(res?.tokenUsage) ??
      asRecord(res?.token_usage) ??
      asRecord(asRecord(res?._meta)?.usage) ??
      undefined;
    const normalizedUsage = extractAgyPromptUsage(res) ?? undefined;

    return {
      stopReason: asString(res?.stopReason) ?? "end_turn",
      usage: rawUsage,
      ...(normalizedUsage ? { normalizedUsage } : {}),
    };
  }

  public cancelSession(sessionId: string): void {
    if (!this.isConnected()) return;
    try {
      this.sendRaw({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId },
      });
    } catch {
      // ignore write errors if process already died
    }
  }

  public async closeSession(sessionId: string): Promise<void> {
    if (!this.isConnected()) return;
    try {
      await this.request("session/close", { sessionId }, 10_000);
    } catch {
      // non-fatal if session already closed or process disconnected
    }
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    if (!this.proc) {
      return Promise.reject(new Error(`AGY ACP (${this.label}) is not connected`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`AGY ACP RPC timeout: ${method}`));
            }, timeoutMs)
          : null;

      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.sendRaw({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private sendRaw(payload: Record<string, unknown>): void {
    if (!this.proc || !this.proc.stdin.writable) {
      throw new Error(`AGY ACP (${this.label}) stdin is not writable`);
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

    // Response to a client request
    if (typeof parsed.id === "number" && parsed.method === undefined) {
      const pending = this.pending.get(parsed.id);
      if (!pending) return;
      if (pending.timer) clearTimeout(pending.timer);
      this.pending.delete(parsed.id);
      const errObj = asRecord(parsed.error);
      if (errObj) {
        const msg = asString(errObj.message) ?? "Unknown ACP RPC error";
        pending.reject(new Error(`AGY ACP RPC error (${pending.method}): ${msg}`));
      } else {
        pending.resolve(parsed.result);
      }
      return;
    }

    // Server-initiated request
    if (parsed.id !== undefined && typeof parsed.method === "string") {
      this.handleServerRequest(parsed.id, parsed.method, asRecord(parsed.params) ?? {});
      return;
    }

    // Server notification
    if (typeof parsed.method === "string") {
      if (parsed.method === "session/update") {
        const params = asRecord(parsed.params) ?? {};
        const sessionId = asString(params.sessionId);
        const update = asRecord(params.update);
        if (!sessionId || !update) return;
        const event: AgyAcpSessionUpdate = {
          sessionId,
          updateType: asString(update.sessionUpdate) ?? "",
          raw: update,
        };
        for (const listener of this.updateListeners) {
          try {
            listener(event);
          } catch {
            // isolate subscriber errors
          }
        }
      }
    }
  }

  private handleServerRequest(
    id: unknown,
    method: string,
    params: Record<string, unknown>,
  ): void {
    if (method === "session/request_permission") {
      const options = Array.isArray(params.options) ? params.options : [];
      let chosenOptionId: string | null = null;
      for (const raw of options) {
        const opt = asRecord(raw);
        const kind = (asString(opt?.kind) ?? "").toLowerCase();
        const optId = asString(opt?.optionId) ?? asString(opt?.id);
        if (optId && kind.startsWith("allow")) {
          chosenOptionId = optId;
          break;
        }
      }
      if (!chosenOptionId && options.length > 0) {
        const first = asRecord(options[0]);
        chosenOptionId = asString(first?.optionId) ?? asString(first?.id);
      }
      try {
        this.sendRaw({
          jsonrpc: "2.0",
          id,
          result: chosenOptionId
            ? { outcome: { outcome: "selected", optionId: chosenOptionId } }
            : { outcome: { outcome: "cancelled" } },
        });
      } catch {
        // ignore
      }
      return;
    }

    try {
      this.sendRaw({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unsupported ACP server request: ${method}` },
      });
    } catch {
      // ignore
    }
  }

  private rejectAllPending(error: Error): void {
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }
}
