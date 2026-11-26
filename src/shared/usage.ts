import type { AgentProvider } from "./types.js";

export type UsageSource = "chat" | "worker";

export type UsagePeriod = "today" | "month" | "all";

export interface TokenUsage {
  /** Non-cached (fresh) input tokens. */
  inputTokens: number;
  /** Cached input tokens read from prompt cache. */
  cachedInputTokens: number;
  /** Input tokens written to prompt cache (e.g., Anthropic cache creation). */
  cacheCreationInputTokens?: number;
  /** Output tokens (including reasoning/thought tokens billed at output rate). */
  outputTokens: number;
  /** Reasoning / thought tokens (informational subset of outputTokens). */
  reasoningTokens?: number;
}

export interface UsageRecord extends TokenUsage {
  id: string;
  timestamp: string;
  source: UsageSource;
  provider: AgentProvider;
  model: string;
  projectName?: string | null;
  taskId?: string | null;
  costUsd: number;
  isEstimated: boolean;
  /** Number of turns represented by this record (defaults to 1; >1 when compacted). */
  turnCount?: number;
}

export interface NormalizedRawUsage extends TokenUsage {
  cacheCreationInputTokens: number;
  reasoningTokens: number;
  costUsd?: number;
  model?: string;
}

export interface ModelPricing {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  cacheCreationPerMillion?: number;
  outputPerMillion: number;
}

export interface UsageBreakdownRow {
  key: string;
  label: string;
  provider?: AgentProvider;
  turnCount: number;
  inputTokens: number;
  cacheCreationInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd: number;
  hasEstimatedCost: boolean;
  hasExactCost: boolean;
}

export type UsageCostMode = "none" | "exact" | "estimated" | "mixed";

export interface UsageSummary {
  period: UsagePeriod;
  turnCount: number;
  inputTokens: number;
  cacheCreationInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd: number;
  exactCostUsd: number;
  estimatedCostUsd: number;
  hasEstimatedCost: boolean;
  hasExactCost: boolean;
  costMode: UsageCostMode;
  byProvider: UsageBreakdownRow[];
  byModel: UsageBreakdownRow[];
  byProject: UsageBreakdownRow[];
}

export const MAX_USAGE_RECORDS = 2000;
export const COMPACT_RECENT_WINDOW = 1500;
export const GENERAL_CHAT_PROJECT_KEY = "__chat__";
export const GENERAL_CHAT_PROJECT_LABEL = "一般チャット";

export const PROVIDER_LABELS: Record<AgentProvider, string> = {
  codex: "Codex",
  agy: "AGY",
  claude: "Claude",
};

interface PricingRule {
  match: RegExp;
  pricing: ModelPricing;
}

const PRICING_RULES: Record<AgentProvider, PricingRule[]> = {
  codex: [
    {
      match: /gpt-5(?:\.\d+)?-nano/i,
      pricing: { inputPerMillion: 0.05, cachedInputPerMillion: 0.005, outputPerMillion: 0.4 },
    },
    {
      match: /gpt-5(?:\.\d+)?-mini/i,
      pricing: { inputPerMillion: 0.25, cachedInputPerMillion: 0.025, outputPerMillion: 2.0 },
    },
    {
      match: /gpt-5(?:\.\d+)?-codex|codex-mini/i,
      pricing: { inputPerMillion: 1.5, cachedInputPerMillion: 0.375, outputPerMillion: 6.0 },
    },
    {
      match: /gpt-5\.4/i,
      pricing: { inputPerMillion: 2.5, cachedInputPerMillion: 0.25, outputPerMillion: 15.0 },
    },
    {
      match: /gpt-5/i,
      pricing: { inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10.0 },
    },
    {
      match: /o[34]-mini/i,
      pricing: { inputPerMillion: 1.1, cachedInputPerMillion: 0.275, outputPerMillion: 4.4 },
    },
    {
      match: /\bo3\b|o3-/i,
      pricing: { inputPerMillion: 2.0, cachedInputPerMillion: 0.5, outputPerMillion: 8.0 },
    },
    {
      match: /gpt-4\.1-nano/i,
      pricing: { inputPerMillion: 0.1, cachedInputPerMillion: 0.025, outputPerMillion: 0.4 },
    },
    {
      match: /gpt-4\.1-mini/i,
      pricing: { inputPerMillion: 0.4, cachedInputPerMillion: 0.1, outputPerMillion: 1.6 },
    },
    {
      match: /gpt-4\.1/i,
      pricing: { inputPerMillion: 2.0, cachedInputPerMillion: 0.5, outputPerMillion: 8.0 },
    },
    {
      match: /gpt-4o-mini/i,
      pricing: { inputPerMillion: 0.15, cachedInputPerMillion: 0.075, outputPerMillion: 0.6 },
    },
    {
      match: /gpt-4o/i,
      pricing: { inputPerMillion: 2.5, cachedInputPerMillion: 1.25, outputPerMillion: 10.0 },
    },
  ],
  agy: [
    {
      match: /flash-lite/i,
      pricing: { inputPerMillion: 0.1, cachedInputPerMillion: 0.025, outputPerMillion: 0.4 },
    },
    {
      match: /flash/i,
      pricing: { inputPerMillion: 0.3, cachedInputPerMillion: 0.075, outputPerMillion: 2.5 },
    },
    {
      match: /gemini-4|neon|hydrogen|carbon|pro/i,
      pricing: { inputPerMillion: 1.25, cachedInputPerMillion: 0.3125, outputPerMillion: 10.0 },
    },
  ],
  claude: [
    {
      match: /opus-4(?:[.-][01]\b)|3-opus/i,
      pricing: {
        inputPerMillion: 15.0,
        cachedInputPerMillion: 1.5,
        cacheCreationPerMillion: 18.75,
        outputPerMillion: 75.0,
      },
    },
    {
      match: /opus/i,
      pricing: {
        inputPerMillion: 5.0,
        cachedInputPerMillion: 0.5,
        cacheCreationPerMillion: 6.25,
        outputPerMillion: 25.0,
      },
    },
    {
      match: /haiku-4|haiku-4\.5/i,
      pricing: {
        inputPerMillion: 1.0,
        cachedInputPerMillion: 0.1,
        cacheCreationPerMillion: 1.25,
        outputPerMillion: 5.0,
      },
    },
    {
      match: /haiku/i,
      pricing: {
        inputPerMillion: 0.8,
        cachedInputPerMillion: 0.08,
        cacheCreationPerMillion: 1.0,
        outputPerMillion: 4.0,
      },
    },
    {
      match: /sonnet/i,
      pricing: {
        inputPerMillion: 3.0,
        cachedInputPerMillion: 0.3,
        cacheCreationPerMillion: 3.75,
        outputPerMillion: 15.0,
      },
    },
  ],
};

const PROVIDER_FALLBACK_PRICING: Record<AgentProvider, ModelPricing> = {
  codex: { inputPerMillion: 1.5, cachedInputPerMillion: 0.375, outputPerMillion: 6.0 },
  agy: { inputPerMillion: 1.25, cachedInputPerMillion: 0.3125, outputPerMillion: 10.0 },
  claude: {
    inputPerMillion: 3.0,
    cachedInputPerMillion: 0.3,
    cacheCreationPerMillion: 3.75,
    outputPerMillion: 15.0,
  },
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonNegInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value));
}

function asNonNegNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, value);
}

function pickFirstInt(obj: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const val = asNonNegInt(obj[key]);
    if (val !== null) return val;
  }
  return null;
}

function pickFirstNumber(obj: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const val = asNonNegNumber(obj[key]);
    if (val !== null) return val;
  }
  return null;
}

function isValidProvider(value: unknown): value is AgentProvider {
  return value === "codex" || value === "agy" || value === "claude";
}

function isValidSource(value: unknown): value is UsageSource {
  return value === "chat" || value === "worker";
}

export function resolveModelPricing(
  provider: AgentProvider,
  model?: string | null,
): ModelPricing {
  const normalizedModel = (model ?? "").trim();
  if (normalizedModel) {
    for (const rule of PRICING_RULES[provider]) {
      if (rule.match.test(normalizedModel)) {
        return rule.pricing;
      }
    }
  }
  return PROVIDER_FALLBACK_PRICING[provider];
}

export function normalizeRawTokenUsage(
  raw: unknown,
  provider: AgentProvider,
): NormalizedRawUsage | null {
  const rec = asRecord(raw);
  if (!rec) return null;

  const inputDetails =
    asRecord(rec.input_tokens_details) ??
    asRecord(rec.inputTokensDetails) ??
    asRecord(rec.prompt_tokens_details) ??
    asRecord(rec.promptTokensDetails);
  const outputDetails =
    asRecord(rec.output_tokens_details) ??
    asRecord(rec.outputTokensDetails) ??
    asRecord(rec.completion_tokens_details) ??
    asRecord(rec.completionTokensDetails);

  const rawInput =
    pickFirstInt(rec, [
      "inputTokens",
      "input_tokens",
      "promptTokens",
      "prompt_tokens",
      "promptTokenCount",
      "prompt_token_count",
    ]) ?? 0;

  const rawCached =
    pickFirstInt(rec, [
      "cachedInputTokens",
      "cached_input_tokens",
      "cachedReadTokens",
      "cached_read_tokens",
      "cacheReadInputTokens",
      "cache_read_input_tokens",
      "cachedContentTokenCount",
      "cached_content_token_count",
      "cachedTokens",
      "cached_tokens",
    ]) ??
    (inputDetails ? pickFirstInt(inputDetails, ["cached_tokens", "cachedTokens"]) : null) ??
    0;

  const rawCacheCreate =
    pickFirstInt(rec, [
      "cacheCreationInputTokens",
      "cache_creation_input_tokens",
      "cachedWriteTokens",
      "cached_write_tokens",
      "cacheWriteInputTokens",
      "cache_write_input_tokens",
    ]) ?? 0;

  const rawOutput =
    pickFirstInt(rec, [
      "outputTokens",
      "output_tokens",
      "completionTokens",
      "completion_tokens",
      "candidatesTokenCount",
      "candidates_token_count",
    ]) ?? 0;

  const rawReasoning =
    pickFirstInt(rec, [
      "reasoningTokens",
      "reasoning_tokens",
      "reasoningOutputTokens",
      "reasoning_output_tokens",
      "thoughtTokens",
      "thought_tokens",
      "thoughtsTokenCount",
      "thoughts_token_count",
    ]) ??
    (outputDetails ? pickFirstInt(outputDetails, ["reasoning_tokens", "reasoningTokens"]) : null) ??
    0;

  const rawTotal =
    pickFirstInt(rec, [
      "totalTokens",
      "total_tokens",
      "totalTokenCount",
      "total_token_count",
    ]) ?? 0;

  const costObj = asRecord(rec.cost);
  const rawCost =
    pickFirstNumber(rec, [
      "totalCostUsd",
      "total_cost_usd",
      "costUsd",
      "cost_usd",
      "costUSD",
    ]) ??
    (costObj && (costObj.currency === undefined || costObj.currency === "USD")
      ? asNonNegNumber(costObj.amount)
      : null);

  // Determine whether rawInput already includes cached tokens
  let uncachedInput = rawInput;
  if (rawCached > 0) {
    if (provider === "claude") {
      // Anthropic reports input_tokens as non-cached input; cache read & write are additive.
      const looksInclusiveByTotal =
        rawTotal > 0 &&
        rawCacheCreate === 0 &&
        rawInput >= rawCached &&
        rawInput + rawOutput === rawTotal;
      uncachedInput = looksInclusiveByTotal ? rawInput - rawCached : rawInput;
    } else {
      const looksExclusiveByTotal =
        rawTotal > 0 &&
        (rawInput + rawCached + rawCacheCreate + rawOutput === rawTotal ||
          rawInput + rawCached + rawCacheCreate + rawOutput + rawReasoning === rawTotal);
      if (looksExclusiveByTotal) {
        uncachedInput = rawInput;
      } else if (rawInput >= rawCached) {
        uncachedInput = rawInput - rawCached;
      } else {
        uncachedInput = rawInput;
      }
    }
  }

  // Determine whether rawOutput already includes reasoning/thought tokens
  let effectiveOutput = rawOutput;
  if (rawReasoning > 0) {
    const geminiExplicitCandidates =
      rec.candidatesTokenCount !== undefined || rec.candidates_token_count !== undefined;
    const totalWithoutReasoning = uncachedInput + rawCached + rawCacheCreate + rawOutput;
    const looksExclusiveByTotal =
      rawTotal > 0 && totalWithoutReasoning + rawReasoning === rawTotal;

    if (geminiExplicitCandidates || looksExclusiveByTotal) {
      effectiveOutput = rawOutput + rawReasoning;
    } else if (rawOutput === 0) {
      effectiveOutput = rawReasoning;
    }
  }

  const totalTokens = uncachedInput + rawCached + rawCacheCreate + effectiveOutput;
  if (totalTokens === 0 && (rawCost === null || rawCost === 0)) {
    return null;
  }

  const model = typeof rec.model === "string" && rec.model.trim() ? rec.model.trim() : undefined;

  return {
    inputTokens: uncachedInput,
    cachedInputTokens: rawCached,
    cacheCreationInputTokens: rawCacheCreate,
    outputTokens: effectiveOutput,
    reasoningTokens: rawReasoning,
    ...(rawCost !== null ? { costUsd: rawCost } : {}),
    ...(model ? { model } : {}),
  };
}

export function getUsageTotalTokens(
  usage: Pick<TokenUsage, "inputTokens" | "cachedInputTokens" | "cacheCreationInputTokens" | "outputTokens">,
): number {
  return (
    Math.max(0, usage.inputTokens) +
    Math.max(0, usage.cachedInputTokens) +
    Math.max(0, usage.cacheCreationInputTokens ?? 0) +
    Math.max(0, usage.outputTokens)
  );
}

export function estimateUsageCostUsd(
  provider: AgentProvider,
  model: string | null | undefined,
  tokens: TokenUsage,
): number {
  const pricing = resolveModelPricing(provider, model);
  const cacheCreateRate = pricing.cacheCreationPerMillion ?? pricing.inputPerMillion * 1.25;
  const inputCost = (Math.max(0, tokens.inputTokens) / 1_000_000) * pricing.inputPerMillion;
  const cachedCost =
    (Math.max(0, tokens.cachedInputTokens) / 1_000_000) * pricing.cachedInputPerMillion;
  const cacheCreateCost =
    (Math.max(0, tokens.cacheCreationInputTokens ?? 0) / 1_000_000) * cacheCreateRate;
  const outputCost = (Math.max(0, tokens.outputTokens) / 1_000_000) * pricing.outputPerMillion;
  return inputCost + cachedCost + cacheCreateCost + outputCost;
}

export function createUsageRecord(input: {
  id?: string;
  timestamp?: string;
  source: UsageSource;
  provider: AgentProvider;
  model?: string | null;
  projectName?: string | null;
  taskId?: string | null;
  tokens: TokenUsage;
  exactCostUsd?: number | null;
}): UsageRecord | null {
  const inputTokens = Math.max(0, Math.round(input.tokens.inputTokens || 0));
  const cachedInputTokens = Math.max(0, Math.round(input.tokens.cachedInputTokens || 0));
  const cacheCreationInputTokens = Math.max(
    0,
    Math.round(input.tokens.cacheCreationInputTokens || 0),
  );
  const outputTokens = Math.max(0, Math.round(input.tokens.outputTokens || 0));
  const reasoningTokens = Math.max(0, Math.round(input.tokens.reasoningTokens || 0));
  const totalTokens = inputTokens + cachedInputTokens + cacheCreationInputTokens + outputTokens;

  const hasExactCost =
    typeof input.exactCostUsd === "number" &&
    Number.isFinite(input.exactCostUsd) &&
    input.exactCostUsd > 0;

  if (totalTokens === 0 && !hasExactCost) {
    return null;
  }

  const normalizedModel = (input.model ?? "").trim() || input.provider;
  const costUsd = hasExactCost
    ? input.exactCostUsd!
    : estimateUsageCostUsd(input.provider, normalizedModel, {
        inputTokens,
        cachedInputTokens,
        cacheCreationInputTokens,
        outputTokens,
        reasoningTokens,
      });

  const normalizedProject =
    typeof input.projectName === "string" && input.projectName.trim()
      ? input.projectName.trim()
      : null;

  return {
    id:
      input.id ??
      (typeof globalThis.crypto?.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `usage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    timestamp: input.timestamp ?? new Date().toISOString(),
    source: input.source,
    provider: input.provider,
    model: normalizedModel,
    projectName: normalizedProject,
    taskId: input.taskId ?? null,
    inputTokens,
    cachedInputTokens,
    ...(cacheCreationInputTokens > 0 ? { cacheCreationInputTokens } : {}),
    outputTokens,
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    costUsd,
    isEstimated: !hasExactCost,
    turnCount: 1,
  };
}

function localDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function normalizeUsageRecords(raw: unknown): UsageRecord[] {
  if (!Array.isArray(raw)) return [];
  const valid: UsageRecord[] = [];
  for (const item of raw) {
    const rec = asRecord(item);
    if (!rec) continue;
    if (!isValidProvider(rec.provider) || !isValidSource(rec.source)) continue;
    const timestamp =
      typeof rec.timestamp === "string" && !Number.isNaN(Date.parse(rec.timestamp))
        ? rec.timestamp
        : null;
    if (!timestamp) continue;

    const inputTokens = asNonNegInt(rec.inputTokens) ?? 0;
    const cachedInputTokens = asNonNegInt(rec.cachedInputTokens) ?? 0;
    const cacheCreationInputTokens = asNonNegInt(rec.cacheCreationInputTokens) ?? 0;
    const outputTokens = asNonNegInt(rec.outputTokens) ?? 0;
    const reasoningTokens = asNonNegInt(rec.reasoningTokens) ?? 0;
    const costUsd = asNonNegNumber(rec.costUsd) ?? 0;
    if (
      inputTokens + cachedInputTokens + cacheCreationInputTokens + outputTokens === 0 &&
      costUsd === 0
    ) {
      continue;
    }

    const turnCount = Math.max(1, asNonNegInt(rec.turnCount) ?? 1);
    const model =
      typeof rec.model === "string" && rec.model.trim() ? rec.model.trim() : rec.provider;
    const projectName =
      typeof rec.projectName === "string" && rec.projectName.trim()
        ? rec.projectName.trim()
        : null;
    const taskId = typeof rec.taskId === "string" && rec.taskId.trim() ? rec.taskId.trim() : null;

    valid.push({
      id: typeof rec.id === "string" && rec.id ? rec.id : `usage-${valid.length}`,
      timestamp,
      source: rec.source,
      provider: rec.provider,
      model,
      projectName,
      taskId,
      inputTokens,
      cachedInputTokens,
      ...(cacheCreationInputTokens > 0 ? { cacheCreationInputTokens } : {}),
      outputTokens,
      ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
      costUsd,
      isEstimated: rec.isEstimated !== false,
      turnCount,
    });
  }
  return compactUsageRecords(valid);
}

/**
 * Keeps the usage ledger lightweight while preserving exact daily / monthly / all-time totals:
 * recent turns stay per-turn, while older records beyond `maxRecords` are rolled up into
 * daily buckets grouped by (local date, source, provider, model, projectName, isEstimated).
 */
export function compactUsageRecords(
  records: readonly UsageRecord[],
  maxRecords = MAX_USAGE_RECORDS,
  keepRecent = COMPACT_RECENT_WINDOW,
): UsageRecord[] {
  if (records.length <= maxRecords) {
    return [...records];
  }

  const effectiveKeepRecent = Math.min(keepRecent, Math.max(0, maxRecords - 1));
  const splitIdx = Math.max(0, records.length - effectiveKeepRecent);
  const older = records.slice(0, splitIdx);
  const recent = records.slice(splitIdx);

  const buckets = new Map<string, UsageRecord>();
  for (const r of older) {
    const dt = new Date(r.timestamp);
    const dayKey = Number.isNaN(dt.getTime()) ? r.timestamp.slice(0, 10) : localDateKey(dt);
    const key = [
      dayKey,
      r.source,
      r.provider,
      r.model,
      r.projectName ?? "",
      r.isEstimated ? "est" : "exact",
    ].join("|");

    const existing = buckets.get(key);
    if (existing) {
      existing.inputTokens += r.inputTokens;
      existing.cachedInputTokens += r.cachedInputTokens;
      const nextCacheCreate =
        (existing.cacheCreationInputTokens ?? 0) + (r.cacheCreationInputTokens ?? 0);
      if (nextCacheCreate > 0) existing.cacheCreationInputTokens = nextCacheCreate;
      existing.outputTokens += r.outputTokens;
      const nextReasoning = (existing.reasoningTokens ?? 0) + (r.reasoningTokens ?? 0);
      if (nextReasoning > 0) existing.reasoningTokens = nextReasoning;
      existing.costUsd += r.costUsd;
      existing.turnCount = (existing.turnCount ?? 1) + (r.turnCount ?? 1);
      if (r.timestamp > existing.timestamp) {
        existing.timestamp = r.timestamp;
      }
    } else {
      buckets.set(key, {
        ...r,
        id: `rollup-${dayKey}-${buckets.size}`,
        taskId: null,
        turnCount: r.turnCount ?? 1,
      });
    }
  }

  const compacted = [...buckets.values(), ...recent];
  if (compacted.length > maxRecords) {
    return compacted.slice(compacted.length - maxRecords);
  }
  return compacted;
}

export function appendUsageRecord(
  records: readonly UsageRecord[],
  record: UsageRecord,
  maxRecords = MAX_USAGE_RECORDS,
): UsageRecord[] {
  return compactUsageRecords([...records, record], maxRecords);
}

export function filterUsageRecordsByPeriod(
  records: readonly UsageRecord[],
  period: UsagePeriod,
  now: Date = new Date(),
): UsageRecord[] {
  if (period === "all") return [...records];

  const targetYear = now.getFullYear();
  const targetMonth = now.getMonth();
  const targetDay = now.getDate();

  return records.filter((rec) => {
    const dt = new Date(rec.timestamp);
    if (Number.isNaN(dt.getTime())) return false;
    if (dt.getFullYear() !== targetYear || dt.getMonth() !== targetMonth) {
      return false;
    }
    if (period === "today") {
      return dt.getDate() === targetDay;
    }
    return true;
  });
}

function accumulateRow(
  map: Map<string, UsageBreakdownRow>,
  key: string,
  label: string,
  record: UsageRecord,
  provider?: AgentProvider,
): void {
  const turns = Math.max(1, record.turnCount ?? 1);
  const cacheCreate = record.cacheCreationInputTokens ?? 0;
  const reasoning = record.reasoningTokens ?? 0;
  const totalTokens = getUsageTotalTokens(record);

  const existing = map.get(key);
  if (existing) {
    existing.turnCount += turns;
    existing.inputTokens += record.inputTokens;
    existing.cacheCreationInputTokens += cacheCreate;
    existing.cachedInputTokens += record.cachedInputTokens;
    existing.outputTokens += record.outputTokens;
    existing.reasoningTokens += reasoning;
    existing.totalTokens += totalTokens;
    existing.costUsd += record.costUsd;
    existing.hasEstimatedCost = existing.hasEstimatedCost || record.isEstimated;
    existing.hasExactCost = existing.hasExactCost || !record.isEstimated;
  } else {
    map.set(key, {
      key,
      label,
      ...(provider ? { provider } : {}),
      turnCount: turns,
      inputTokens: record.inputTokens,
      cacheCreationInputTokens: cacheCreate,
      cachedInputTokens: record.cachedInputTokens,
      outputTokens: record.outputTokens,
      reasoningTokens: reasoning,
      totalTokens,
      costUsd: record.costUsd,
      hasEstimatedCost: record.isEstimated,
      hasExactCost: !record.isEstimated,
    });
  }
}

function sortBreakdownRows(rows: UsageBreakdownRow[]): UsageBreakdownRow[] {
  return rows.sort((a, b) => {
    if (b.costUsd !== a.costUsd) return b.costUsd - a.costUsd;
    if (b.totalTokens !== a.totalTokens) return b.totalTokens - a.totalTokens;
    return a.label.localeCompare(b.label);
  });
}

export function summarizeUsage(
  records: readonly UsageRecord[],
  period: UsagePeriod,
  now: Date = new Date(),
): UsageSummary {
  const filtered = filterUsageRecordsByPeriod(records, period, now);

  let turnCount = 0;
  let inputTokens = 0;
  let cacheCreationInputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let costUsd = 0;
  let exactCostUsd = 0;
  let estimatedCostUsd = 0;
  let hasEstimatedCost = false;
  let hasExactCost = false;

  const providerMap = new Map<string, UsageBreakdownRow>();
  const modelMap = new Map<string, UsageBreakdownRow>();
  const projectMap = new Map<string, UsageBreakdownRow>();

  for (const rec of filtered) {
    const turns = Math.max(1, rec.turnCount ?? 1);
    const cacheCreate = rec.cacheCreationInputTokens ?? 0;
    const reasoning = rec.reasoningTokens ?? 0;

    turnCount += turns;
    inputTokens += rec.inputTokens;
    cacheCreationInputTokens += cacheCreate;
    cachedInputTokens += rec.cachedInputTokens;
    outputTokens += rec.outputTokens;
    reasoningTokens += reasoning;
    costUsd += rec.costUsd;
    if (rec.isEstimated) {
      hasEstimatedCost = true;
      estimatedCostUsd += rec.costUsd;
    } else {
      hasExactCost = true;
      exactCostUsd += rec.costUsd;
    }

    accumulateRow(providerMap, rec.provider, PROVIDER_LABELS[rec.provider], rec, rec.provider);
    accumulateRow(modelMap, `${rec.provider}:${rec.model}`, rec.model, rec, rec.provider);

    const projectKey = rec.projectName ? `project:${rec.projectName}` : GENERAL_CHAT_PROJECT_KEY;
    const projectLabel = rec.projectName || GENERAL_CHAT_PROJECT_LABEL;
    accumulateRow(projectMap, projectKey, projectLabel, rec);
  }

  const totalTokens = inputTokens + cacheCreationInputTokens + cachedInputTokens + outputTokens;
  const costMode: UsageCostMode =
    !hasEstimatedCost && !hasExactCost
      ? "none"
      : hasEstimatedCost && hasExactCost
        ? "mixed"
        : hasExactCost
          ? "exact"
          : "estimated";

  return {
    period,
    turnCount,
    inputTokens,
    cacheCreationInputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    costUsd,
    exactCostUsd,
    estimatedCostUsd,
    hasEstimatedCost,
    hasExactCost,
    costMode,
    byProvider: sortBreakdownRows([...providerMap.values()]),
    byModel: sortBreakdownRows([...modelMap.values()]),
    byProject: sortBreakdownRows([...projectMap.values()]),
  };
}

export function summarizeAllUsagePeriods(
  records: readonly UsageRecord[],
  now: Date = new Date(),
): Record<UsagePeriod, UsageSummary> {
  return {
    today: summarizeUsage(records, "today", now),
    month: summarizeUsage(records, "month", now),
    all: summarizeUsage(records, "all", now),
  };
}

export function formatTokenCount(tokens: number): string {
  const safe = Math.max(0, Math.round(Number.isFinite(tokens) ? tokens : 0));
  if (safe >= 1_000_000_000) {
    return `${(safe / 1_000_000_000).toFixed(2)}B`;
  }
  if (safe >= 1_000_000) {
    return `${(safe / 1_000_000).toFixed(safe >= 10_000_000 ? 1 : 2)}M`;
  }
  if (safe >= 1_000) {
    return `${(safe / 1_000).toFixed(safe >= 100_000 ? 0 : 1)}K`;
  }
  return String(safe);
}

export function formatUsdCost(
  costUsd: number,
  options?: { estimated?: boolean; compact?: boolean },
): string {
  const safe = Math.max(0, Number.isFinite(costUsd) ? costUsd : 0);
  const prefix = options?.estimated && safe > 0 ? "~$" : "$";
  if (safe === 0) return "$0.00";
  if (safe < 0.01) {
    if (options?.compact) {
      return `${prefix}${safe < 0.001 ? "<0.001" : safe.toFixed(3)}`;
    }
    return `${prefix}${safe.toFixed(4)}`;
  }
  if (safe >= 100) {
    return `${prefix}${safe.toFixed(1)}`;
  }
  return `${prefix}${safe.toFixed(2)}`;
}
