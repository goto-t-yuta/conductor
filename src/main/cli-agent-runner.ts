import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ModelOption, ProviderQuotaWindow } from "../shared/types.js";
import { normalizeRawTokenUsage, type NormalizedRawUsage } from "../shared/usage.js";
import {
  enrichedEnvironment,
  resolveAgyExecutable,
  resolveClaudeExecutable,
} from "./shell-env.js";

export type CliTurnUsage = NormalizedRawUsage;

export interface CliTurnCallbacks {
  onSessionId?: (sessionId: string) => void;
  onTextDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  onRateLimit?: (window: ProviderQuotaWindow) => void;
  onToolEvent?: (event: {
    id: string;
    name: string;
    detail?: string;
    completed: boolean;
    isError?: boolean;
  }) => void;
  onComplete?: (outcome: {
    ok: boolean;
    finalText: string;
    errorMessage?: string;
    interrupted?: boolean;
    usage?: CliTurnUsage;
  }) => void;
}

export interface RunningCliTurn {
  cancel(): void;
  waitForExit?: () => Promise<void>;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asNonNegNumber(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.max(0, v);
}

/**
 * Extracts normalized token usage & optional exact cost from an AGY `stream-json` event
 * (`result`, `usage`, `token_usage`, or `step_update`). Safely supports both camelCase and snake_case.
 */
export function extractAgyStreamJsonUsage(
  parsed: Record<string, unknown>,
): CliTurnUsage | null {
  const result = asRecord(parsed.result);
  const stepUpdate = asRecord(parsed.step_update);
  const candidates: Array<Record<string, unknown> | null> = [
    asRecord(result?.usage),
    asRecord(result?.token_usage),
    asRecord(result?.tokenUsage),
    asRecord(result?.usage_metadata),
    asRecord(result?.usageMetadata),
    asRecord(result?.stats),
    asRecord(result?.metrics),
    asRecord(parsed.usage),
    asRecord(parsed.token_usage),
    asRecord(parsed.tokenUsage),
    asRecord(parsed.usage_metadata),
    asRecord(parsed.usageMetadata),
    asRecord(stepUpdate?.usage),
    asRecord(stepUpdate?.token_usage),
    asRecord(stepUpdate?.tokenUsage),
    result,
  ];

  const topCost =
    asNonNegNumber(result?.total_cost_usd) ??
    asNonNegNumber(result?.totalCostUsd) ??
    asNonNegNumber(result?.cost_usd) ??
    asNonNegNumber(result?.costUsd) ??
    asNonNegNumber(parsed.total_cost_usd) ??
    asNonNegNumber(parsed.totalCostUsd) ??
    asNonNegNumber(parsed.cost_usd) ??
    asNonNegNumber(parsed.costUsd);

  const topModel =
    asString(result?.model) ??
    asString(parsed.model) ??
    asString(stepUpdate?.model) ??
    undefined;

  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = normalizeRawTokenUsage(candidate, "agy");
    if (normalized) {
      return {
        ...normalized,
        ...(normalized.costUsd === undefined && topCost !== null ? { costUsd: topCost } : {}),
        ...(normalized.model === undefined && topModel ? { model: topModel } : {}),
      };
    }
  }
  return null;
}

/**
 * Extracts normalized token usage, exact `total_cost_usd`, and resolved model ID
 * from a Claude Code `stream-json` `result` event.
 */
export function extractClaudeStreamJsonUsage(
  parsed: Record<string, unknown>,
  fallbackModel?: string | null,
): CliTurnUsage | null {
  const exactCost =
    asNonNegNumber(parsed.total_cost_usd) ??
    asNonNegNumber(parsed.totalCostUsd) ??
    asNonNegNumber(parsed.cost_usd) ??
    asNonNegNumber(parsed.costUsd);

  // Inspect modelUsage to resolve exact model ID (and serve as fallback token source)
  const modelUsage = asRecord(parsed.modelUsage);
  let resolvedModel: string | undefined;
  let aggInput = 0;
  let aggCached = 0;
  let aggCacheCreate = 0;
  let aggOutput = 0;
  let aggCost = 0;
  let bestScore = -1;

  if (modelUsage) {
    for (const [modelName, rawEntry] of Object.entries(modelUsage)) {
      const entry = normalizeRawTokenUsage(rawEntry, "claude");
      if (!entry) continue;
      aggInput += entry.inputTokens;
      aggCached += entry.cachedInputTokens;
      aggCacheCreate += entry.cacheCreationInputTokens;
      aggOutput += entry.outputTokens;
      if (entry.costUsd !== undefined) aggCost += entry.costUsd;

      const score =
        entry.costUsd !== undefined && entry.costUsd > 0
          ? entry.costUsd * 1_000_000
          : entry.inputTokens + entry.cachedInputTokens + entry.cacheCreationInputTokens + entry.outputTokens;
      if (score > bestScore) {
        bestScore = score;
        resolvedModel = modelName;
      }
    }
  }

  const normalizedDirect = normalizeRawTokenUsage(parsed.usage, "claude");
  const effectiveModel =
    resolvedModel ??
    normalizedDirect?.model ??
    (fallbackModel && fallbackModel.trim() ? fallbackModel.trim() : undefined);

  if (normalizedDirect) {
    const costUsd = exactCost ?? normalizedDirect.costUsd ?? (aggCost > 0 ? aggCost : undefined);
    return {
      ...normalizedDirect,
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(effectiveModel ? { model: effectiveModel } : {}),
    };
  }

  const totalAggTokens = aggInput + aggCached + aggCacheCreate + aggOutput;
  const costUsd = exactCost ?? (aggCost > 0 ? aggCost : undefined);
  if (totalAggTokens === 0 && (costUsd === undefined || costUsd === 0)) {
    return null;
  }

  return {
    inputTokens: aggInput,
    cachedInputTokens: aggCached,
    cacheCreationInputTokens: aggCacheCreate,
    outputTokens: aggOutput,
    reasoningTokens: 0,
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(effectiveModel ? { model: effectiveModel } : {}),
  };
}

/**
 * Extracts a normalized quota window from a Claude Code `stream-json` `rate_limit_event` payload.
 */
export function extractClaudeRateLimitEvent(
  parsed: Record<string, unknown>,
): ProviderQuotaWindow | null {
  if (asString(parsed.type) !== "rate_limit_event") return null;
  const info = asRecord(parsed.rate_limit_info ?? parsed.rateLimitInfo);
  if (!info) return null;

  const rawUtil = asNonNegNumber(info.utilization ?? info.used_percent ?? info.usedPercent);
  const status = (asString(info.status) ?? "").toLowerCase();
  let usedPercent: number | null = null;
  if (rawUtil !== null) {
    // Claude stream-json utilization is typically 0..1 (e.g. 0.42), though some variants may send 0..100
    const scaled = rawUtil <= 1 && info.utilization !== undefined ? rawUtil * 100 : rawUtil;
    usedPercent = Math.max(0, Math.round(scaled * 10) / 10);
  } else if (status === "rejected" || status === "rate_limited") {
    usedPercent = 100;
  }
  if (usedPercent === null) return null;

  const rateLimitType =
    asString(info.rateLimitType ?? info.rate_limit_type) ?? "primary";
  let windowDurationMins: number | null = null;
  if (rateLimitType === "five_hour") windowDurationMins = 300;
  else if (rateLimitType === "seven_day" || rateLimitType === "seven_day_opus" || rateLimitType === "seven_day_sonnet") {
    windowDurationMins = 10_080;
  } else if (rateLimitType === "monthly" || rateLimitType === "thirty_day") {
    windowDurationMins = 43_200;
  }

  const rawResets = info.resetsAt ?? info.resets_at;
  let resetsAt: string | null = null;
  if (typeof rawResets === "number" && Number.isFinite(rawResets) && rawResets > 0) {
    const ms = rawResets > 1_000_000_000_000 ? rawResets : rawResets * 1000;
    resetsAt = new Date(ms).toISOString();
  } else if (typeof rawResets === "string" && !Number.isNaN(Date.parse(rawResets))) {
    resetsAt = new Date(Date.parse(rawResets)).toISOString();
  }

  return {
    id: rateLimitType,
    windowDurationMins,
    usedPercent,
    remainingPercent: Math.max(0, Math.round((100 - usedPercent) * 10) / 10),
    resetsAt,
  };
}

export function defaultClaudeModels(): ModelOption[] {
  return [
    {
      id: "claude-sonnet",
      model: "sonnet",
      displayName: "Claude Sonnet (Latest)",
      description: "Fast & capable default Claude Code model",
      supportedEfforts: ["low", "medium", "high", "max"],
      defaultEffort: "medium",
      isDefault: true,
    },
    {
      id: "claude-opus",
      model: "opus",
      displayName: "Claude Opus (Latest)",
      description: "Deepest reasoning for complex tasks",
      supportedEfforts: ["low", "medium", "high", "max"],
      defaultEffort: "high",
      isDefault: false,
    },
    {
      id: "claude-haiku",
      model: "haiku",
      displayName: "Claude Haiku (Fast)",
      description: "Ultra-fast responses for rapid-fire chat",
      supportedEfforts: ["low", "medium", "high"],
      defaultEffort: "low",
      isDefault: false,
    },
  ];
}

export async function listAgyModels(): Promise<ModelOption[]> {
  const agyBin = resolveAgyExecutable();
  if (!agyBin) return [];
  return new Promise((resolve) => {
    execFile(
      agyBin,
      ["models"],
      { encoding: "utf8", timeout: 10_000, env: enrichedEnvironment() },
      (err, stdout) => {
        if (err || !stdout) {
          resolve(fallbackAgyModels());
          return;
        }
        const parsed: ModelOption[] = [];
        for (const rawLine of stdout.split("\n")) {
          const line = rawLine.trim();
          if (!line || line.startsWith("Fetching")) continue;
          const parts = line.split("\t");
          const id = parts[0]?.trim();
          const displayName = (parts[1] ?? id)?.trim();
          if (!id) continue;
          parsed.push({
            id,
            model: id,
            displayName,
            description: "",
            supportedEfforts: [],
            defaultEffort: "",
            isDefault: id === "gemini-3.8-flash-low" || id === "gemini-4-neon-high",
          });
        }
        resolve(parsed.length > 0 ? parsed : fallbackAgyModels());
      },
    );
  });
}

function fallbackAgyModels(): ModelOption[] {
  return [
    {
      id: "gemini-3.8-flash-low",
      model: "gemini-3.8-flash-low",
      displayName: "Gemini 3.8 Flash (Low)",
      description: "Fast responses",
      supportedEfforts: [],
      defaultEffort: "",
      isDefault: true,
    },
    {
      id: "gemini-4-neon-high",
      model: "gemini-4-neon-high",
      displayName: "Gemini 4 Neon (High)",
      description: "Deep coding",
      supportedEfforts: [],
      defaultEffort: "",
      isDefault: false,
    },
  ];
}

export function fastestAgyModel(models: ModelOption[]): string | null {
  for (const preferred of [
    "gemini-3.8-flash-low",
    "gemini-4-neon-low",
    "gemini-4-hydrogen-low",
    "gemini-3.8-flash-medium",
  ]) {
    if (models.some((m) => m.model === preferred)) return preferred;
  }
  return models[0]?.model ?? null;
}

export function strongestAgyModel(models: ModelOption[]): string | null {
  for (const preferred of [
    "gemini-4-neon-high",
    "gemini-4-hydrogen-high",
    "gemini-4-carbon-high",
    "gemini-3.8-flash-high",
  ]) {
    if (models.some((m) => m.model === preferred)) return preferred;
  }
  return models[0]?.model ?? null;
}

/**
 * Writes an isolated workspace plugin inside Conductor's userData directory so `agy`
 * automatically discovers our embedded Streamable HTTP MCP server without touching ~/.gemini.
 */
export function writeAgyOrchestratorMcpPlugin(
  baseDir: string,
  mcpUrl: string,
  bearerToken: string,
): void {
  const pluginDir = path.join(baseDir, ".agents", "plugins", "conductor");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "plugin.json"),
    JSON.stringify(
      {
        name: "conductor",
        version: "0.1.0",
        description: "Conductor orchestration, task management, and Chromium CDP tools",
      },
      null,
      2,
    ),
    "utf8",
  );
  const urlWithToken = `${mcpUrl}?token=${encodeURIComponent(bearerToken)}`;
  fs.writeFileSync(
    path.join(pluginDir, "mcp_config.json"),
    JSON.stringify(
      {
        mcpServers: {
          conductor: {
            url: urlWithToken,
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

/**
 * Writes a temporary MCP config file passed via `--mcp-config` to Claude Code.
 */
export function writeClaudeMcpConfig(
  baseDir: string,
  mcpUrl: string,
  bearerToken: string,
  filename = "claude-mcp.json",
): string {
  const configPath = path.join(baseDir, filename);
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        mcpServers: {
          conductor: {
            type: "http",
            url: mcpUrl,
            headers: {
              Authorization: `Bearer ${bearerToken}`,
            },
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  return configPath;
}

export function runAgyTurn(
  options: {
    cwd: string;
    prompt: string;
    model?: string | null;
    effort?: string | null;
    conversationId?: string | null;
    imagePaths?: string[];
  },
  callbacks: CliTurnCallbacks,
): RunningCliTurn {
  const agyBin = resolveAgyExecutable();
  if (!agyBin) {
    callbacks.onComplete?.({
      ok: false,
      finalText: "",
      errorMessage: "agy CLI が見つかりませんでした。`~/.local/bin/agy` を確認してください。",
    });
    return { cancel: () => {}, waitForExit: () => Promise.resolve() };
  }

  let effectivePrompt = options.prompt;
  if (options.imagePaths && options.imagePaths.length > 0) {
    effectivePrompt +=
      "\n\n[Attached local image files (inspect with read_file/view_file if needed)]\n" +
      options.imagePaths.map((p) => `- ${p}`).join("\n");
  }

  const args: string[] = [
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
  ];
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.effort) {
    args.push("--effort", options.effort);
  }
  if (options.conversationId) {
    args.push("--conversation", options.conversationId);
  }
  args.push(`-p=${effectivePrompt}`);

  const proc = spawn(agyBin, args, {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: enrichedEnvironment(),
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  let accumulatedText = "";
  let latestUsage: CliTurnUsage | undefined;
  let completed = false;
  let cancelled = false;
  let exited = false;
  let forceKillTimer: NodeJS.Timeout | null = null;
  let resolveExit!: () => void;
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  const markExited = () => {
    if (exited) return;
    exited = true;
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }
    resolveExit();
  };

  const finish = (outcome: {
    ok: boolean;
    finalText: string;
    errorMessage?: string;
    interrupted?: boolean;
    usage?: CliTurnUsage;
  }) => {
    if (completed) return;
    completed = true;
    callbacks.onComplete?.(outcome);
  };

  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk: string) => {
    stdoutBuf += chunk;
    let idx = stdoutBuf.indexOf("\n");
    while (idx !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (line) handleAgyLine(line);
      idx = stdoutBuf.indexOf("\n");
    }
  });

  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk: string) => {
    stderrBuf = (stderrBuf + chunk).slice(-3000);
  });

  proc.on("error", (err) => {
    markExited();
    finish({ ok: false, finalText: accumulatedText, errorMessage: err.message });
  });

  proc.on("exit", (code) => {
    markExited();
    if (stdoutBuf.trim()) handleAgyLine(stdoutBuf.trim());
    if (!completed) {
      if (cancelled) {
        finish({ ok: false, finalText: accumulatedText, interrupted: true, usage: latestUsage });
      } else if (code === 0) {
        finish({ ok: true, finalText: accumulatedText, usage: latestUsage });
      } else {
        finish({
          ok: false,
          finalText: accumulatedText,
          errorMessage: stderrBuf.trim() || `agy exited with code ${code ?? "null"}`,
          usage: latestUsage,
        });
      }
    }
  });

  function handleAgyLine(line: string): void {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = asRecord(JSON.parse(line));
    } catch {
      return;
    }
    if (!parsed) return;

    const eventType = asString(parsed.event);
    const convId = asString(parsed.conversation_id);
    if (convId) callbacks.onSessionId?.(convId);

    if (eventType === "step_update") {
      const update = asRecord(parsed.step_update);
      if (!update) return;
      const stepType = asString(update.step_type) ?? "";
      const state = asString(update.state) ?? "";
      const stepIndex = typeof update.step_index === "number" ? update.step_index : 0;

      if (stepType === "agent_response") {
        const delta = asString(update.text_delta);
        if (delta) {
          accumulatedText += delta;
          callbacks.onTextDelta?.(delta);
        }
        const thought = asString(update.thinking_delta) ?? asString(update.thought_delta);
        if (thought) {
          callbacks.onReasoningDelta?.(thought);
        }
      } else if (stepType && stepType !== "user_input") {
        const toolName =
          asString(update.tool_name) ??
          asString(asRecord(update.tool_call)?.name) ??
          stepType;
        const detail =
          asString(update.summary) ??
          asString(update.command) ??
          asString(update.path) ??
          undefined;
        callbacks.onToolEvent?.({
          id: `agy-step-${stepIndex}`,
          name: toolName,
          detail,
          completed: state === "DONE" || state === "ERROR" || state === "CANCELLED",
          isError: state === "ERROR",
        });
      }
      return;
    }

    if (eventType === "usage" || eventType === "token_usage") {
      const parsedUsage = extractAgyStreamJsonUsage(parsed);
      if (parsedUsage) latestUsage = parsedUsage;
      return;
    }

    if (eventType === "result") {
      const result = asRecord(parsed.result);
      const status = asString(result?.status) ?? "SUCCESS";
      const response = asString(result?.response) ?? accumulatedText;
      if (!accumulatedText && response) {
        accumulatedText = response;
        callbacks.onTextDelta?.(response);
      }
      const errMsg = asString(result?.error) ?? undefined;
      const resultUsage = extractAgyStreamJsonUsage(parsed) ?? latestUsage;
      finish({
        ok: status === "SUCCESS",
        finalText: accumulatedText || response,
        errorMessage: status === "SUCCESS" ? undefined : errMsg ?? `agy status: ${status}`,
        ...(resultUsage ? { usage: resultUsage } : {}),
      });
    }
  }

  return {
    cancel() {
      cancelled = true;
      if (!exited && !proc.killed) {
        proc.kill("SIGTERM");
        if (!forceKillTimer) {
          forceKillTimer = setTimeout(() => {
            forceKillTimer = null;
            if (!exited) {
              try {
                proc.kill("SIGKILL");
              } catch {
                // process already exited
              }
            }
          }, 1200);
          forceKillTimer.unref?.();
        }
      }
    },
    waitForExit: () => exitPromise,
  };
}

export function runClaudeTurn(
  options: {
    cwd: string;
    prompt: string;
    systemPrompt?: string;
    model?: string | null;
    effort?: string | null;
    sessionId?: string | null;
    mcpConfigPath?: string | null;
    imagePaths?: string[];
  },
  callbacks: CliTurnCallbacks,
): RunningCliTurn {
  const claudeBin = resolveClaudeExecutable();
  if (!claudeBin) {
    callbacks.onComplete?.({
      ok: false,
      finalText: "",
      errorMessage:
        "Claude Code CLI が見つかりませんでした。`claude` をインストールするか VS Code の Claude 拡張を確認してください。",
    });
    return { cancel: () => {}, waitForExit: () => Promise.resolve() };
  }

  let effectivePrompt = options.prompt;
  if (options.imagePaths && options.imagePaths.length > 0) {
    effectivePrompt +=
      "\n\n[Attached local image files (inspect with Read tool if needed)]\n" +
      options.imagePaths.map((p) => `- ${p}`).join("\n");
  }

  const args: string[] = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    "auto",
  ];
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.effort) {
    args.push("--effort", options.effort);
  }
  if (options.systemPrompt) {
    args.push("--append-system-prompt", options.systemPrompt);
  }
  if (options.mcpConfigPath) {
    args.push("--mcp-config", options.mcpConfigPath);
  }
  if (options.sessionId) {
    args.push("--resume", options.sessionId);
  }
  args.push(effectivePrompt);

  const proc = spawn(claudeBin, args, {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: enrichedEnvironment(),
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  let accumulatedText = "";
  let observedModel: string | null = options.model ?? null;
  let sawStreamText = false;
  let completed = false;
  let cancelled = false;
  let exited = false;
  let forceKillTimer: NodeJS.Timeout | null = null;
  let resolveExit!: () => void;
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const activeToolIds = new Set<string>();

  const markExited = () => {
    if (exited) return;
    exited = true;
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }
    resolveExit();
  };

  const finish = (outcome: {
    ok: boolean;
    finalText: string;
    errorMessage?: string;
    interrupted?: boolean;
    usage?: CliTurnUsage;
  }) => {
    if (completed) return;
    completed = true;
    callbacks.onComplete?.(outcome);
  };

  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk: string) => {
    stdoutBuf += chunk;
    let idx = stdoutBuf.indexOf("\n");
    while (idx !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (line) handleClaudeLine(line);
      idx = stdoutBuf.indexOf("\n");
    }
  });

  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk: string) => {
    stderrBuf = (stderrBuf + chunk).slice(-3000);
  });

  proc.on("error", (err) => {
    markExited();
    finish({ ok: false, finalText: accumulatedText, errorMessage: err.message });
  });

  proc.on("exit", (code) => {
    markExited();
    if (stdoutBuf.trim()) handleClaudeLine(stdoutBuf.trim());
    if (!completed) {
      if (cancelled) {
        finish({ ok: false, finalText: accumulatedText, interrupted: true });
      } else if (code === 0) {
        finish({ ok: true, finalText: accumulatedText });
      } else {
        finish({
          ok: false,
          finalText: accumulatedText,
          errorMessage: stderrBuf.trim() || `claude exited with code ${code ?? "null"}`,
        });
      }
    }
  });

  function handleClaudeLine(line: string): void {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = asRecord(JSON.parse(line));
    } catch {
      return;
    }
    if (!parsed) return;

    const sessionId = asString(parsed.session_id);
    if (sessionId) callbacks.onSessionId?.(sessionId);

    const type = asString(parsed.type);

    if (type === "stream_event") {
      const ev = asRecord(parsed.event);
      const evType = asString(ev?.type);
      if (evType === "content_block_delta") {
        const delta = asRecord(ev?.delta);
        const deltaType = asString(delta?.type);
        if (deltaType === "text_delta") {
          const text = asString(delta?.text);
          if (text) {
            sawStreamText = true;
            accumulatedText += text;
            callbacks.onTextDelta?.(text);
          }
        } else if (deltaType === "thinking_delta") {
          const thinking = asString(delta?.thinking);
          if (thinking) callbacks.onReasoningDelta?.(thinking);
        }
      }
      return;
    }

    if (type === "system") {
      const sysModel = asString(parsed.model);
      if (sysModel) observedModel = sysModel;
      return;
    }

    if (type === "assistant") {
      const message = asRecord(parsed.message);
      const msgModel = asString(message?.model);
      if (msgModel) observedModel = msgModel;
      const content = Array.isArray(message?.content) ? message.content : [];
      for (const rawBlock of content) {
        const block = asRecord(rawBlock);
        const blockType = asString(block?.type);
        if (blockType === "tool_use") {
          const id = asString(block?.id) ?? `claude-tool-${activeToolIds.size}`;
          const name = asString(block?.name) ?? "tool";
          activeToolIds.add(id);
          const input = asRecord(block?.input);
          const detail =
            asString(input?.command) ??
            asString(input?.file_path) ??
            asString(input?.url) ??
            asString(input?.title) ??
            undefined;
          callbacks.onToolEvent?.({ id, name, detail, completed: false });
        } else if (blockType === "text" && !sawStreamText) {
          const text = asString(block?.text);
          if (text) {
            accumulatedText += text;
            callbacks.onTextDelta?.(text);
          }
        }
      }
      // Reset per-message stream flag so subsequent assistant messages in a multi-step
      // or post-compaction turn still emit fallback text if stream_event deltas are absent.
      sawStreamText = false;
      return;
    }

    if (type === "user") {
      // Tool results arrive in synthetic user messages — mark those tool chips completed
      const message = asRecord(parsed.message);
      const content = Array.isArray(message?.content) ? message.content : [];
      for (const rawBlock of content) {
        const block = asRecord(rawBlock);
        if (asString(block?.type) === "tool_result") {
          const toolUseId = asString(block?.tool_use_id);
          if (toolUseId && activeToolIds.has(toolUseId)) {
            activeToolIds.delete(toolUseId);
            callbacks.onToolEvent?.({
              id: toolUseId,
              name: "tool",
              completed: true,
              isError: block?.is_error === true,
            });
          }
        }
      }
      return;
    }

    if (type === "rate_limit_event") {
      const rateLimitWindow = extractClaudeRateLimitEvent(parsed);
      if (rateLimitWindow) {
        callbacks.onRateLimit?.(rateLimitWindow);
      }
      return;
    }

    if (type === "result") {
      const isError = parsed.is_error === true;
      const resultText = asString(parsed.result) ?? accumulatedText;
      if (!accumulatedText && resultText && !isError) {
        accumulatedText = resultText;
        callbacks.onTextDelta?.(resultText);
      }
      const usage = extractClaudeStreamJsonUsage(parsed, observedModel) ?? undefined;
      finish({
        ok: !isError,
        finalText: accumulatedText || resultText,
        errorMessage: isError ? resultText || "Claude Code error" : undefined,
        ...(usage ? { usage } : {}),
      });
    }
  }

  return {
    cancel() {
      cancelled = true;
      if (!exited && !proc.killed) {
        proc.kill("SIGTERM");
        if (!forceKillTimer) {
          forceKillTimer = setTimeout(() => {
            forceKillTimer = null;
            if (!exited) {
              try {
                proc.kill("SIGKILL");
              } catch {
                // process already exited
              }
            }
          }, 1200);
          forceKillTimer.unref?.();
        }
      }
    },
    waitForExit: () => exitPromise,
  };
}
