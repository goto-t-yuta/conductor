import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgyAcpClient,
  extractAgyPromptUsage,
  parseAgySessionUpdate,
} from "../src/main/agy-acp-client.js";
import type { BrowserManager } from "../src/main/browser-manager.js";
import {
  extractAgyStreamJsonUsage,
  extractClaudeRateLimitEvent,
  extractClaudeStreamJsonUsage,
  type CliTurnCallbacks,
  type RunningCliTurn,
} from "../src/main/cli-agent-runner.js";
import {
  extractCodexRateLimitUpdate,
  extractCodexTokenUsage,
  parseCodexRateLimits,
  type CodexAppServerClient,
  type CodexNotification,
} from "../src/main/codex-client.js";
import { ConductorController } from "../src/main/conductor-controller.js";
import { StateStore } from "../src/main/state-store.js";
import { SettingsModal } from "../src/renderer/components/SettingsModal.js";
import { UnifiedChat } from "../src/renderer/components/UnifiedChat.js";
import { UsagePanel } from "../src/renderer/components/UsagePanel.js";
import type {
  AppSnapshot,
  Project,
  ProviderQuotasMap,
  UsageBudgetSettings,
  UsageRecord,
} from "../src/shared/types.js";
import {
  buildDailyUsageTrend,
  buildWeeklyUsageTrend,
  compactUsageRecords,
  createUsageRecord,
  DEFAULT_USAGE_BUDGETS,
  estimateUsageCostUsd,
  evaluateUsageBudget,
  formatTokenCount,
  formatUsagePercent,
  formatUsdCost,
  mergeProviderQuotaSnapshot,
  normalizeRawTokenUsage,
  normalizeUsageBudgetSettings,
  normalizeUsageRecords,
  resolveModelPricing,
  summarizeAllUsagePeriods,
  summarizeUsage,
} from "../src/shared/usage.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createFakeBrowserManager(): BrowserManager {
  return {
    getTabs: () => [],
    getActiveTabId: () => null,
    getActiveTab: () => null,
    isPickingElement: () => false,
    restore: () => {},
  } as unknown as BrowserManager;
}

describe("Shared usage normalization, pricing, compaction & aggregation (src/shared/usage.ts)", () => {
  it("normalizes Codex, AGY, and Claude token payloads across camelCase, snake_case, and Gemini formats", () => {
    // Codex: inputTokens includes cachedInputTokens; outputTokens includes reasoningOutputTokens
    expect(
      normalizeRawTokenUsage(
        {
          inputTokens: 1000,
          cachedInputTokens: 400,
          outputTokens: 250,
          reasoningOutputTokens: 80,
        },
        "codex",
      ),
    ).toEqual({
      inputTokens: 600,
      cachedInputTokens: 400,
      cacheCreationInputTokens: 0,
      outputTokens: 250,
      reasoningTokens: 80,
    });

    // Codex nested OpenAI details format
    expect(
      normalizeRawTokenUsage(
        {
          prompt_tokens: 2000,
          prompt_tokens_details: { cached_tokens: 1500 },
          completion_tokens: 300,
          completion_tokens_details: { reasoning_tokens: 120 },
        },
        "codex",
      ),
    ).toEqual({
      inputTokens: 500,
      cachedInputTokens: 1500,
      cacheCreationInputTokens: 0,
      outputTokens: 300,
      reasoningTokens: 120,
    });

    // AGY ACP camelCase with separate thoughtTokens revealed by totalTokens
    expect(
      normalizeRawTokenUsage(
        {
          inputTokens: 2000,
          cachedReadTokens: 1200,
          outputTokens: 300,
          thoughtTokens: 100,
          totalTokens: 2400,
        },
        "agy",
      ),
    ).toEqual({
      inputTokens: 800,
      cachedInputTokens: 1200,
      cacheCreationInputTokens: 0,
      outputTokens: 400,
      reasoningTokens: 100,
    });

    // AGY Gemini metadata style (candidatesTokenCount + thoughtsTokenCount)
    expect(
      normalizeRawTokenUsage(
        {
          promptTokenCount: 3000,
          cachedContentTokenCount: 2000,
          candidatesTokenCount: 250,
          thoughtsTokenCount: 150,
        },
        "agy",
      ),
    ).toEqual({
      inputTokens: 1000,
      cachedInputTokens: 2000,
      cacheCreationInputTokens: 0,
      outputTokens: 400,
      reasoningTokens: 150,
    });

    // Claude: input_tokens is already non-cached; cache_read & cache_creation are additive
    expect(
      normalizeRawTokenUsage(
        {
          input_tokens: 120,
          cache_read_input_tokens: 5000,
          cache_creation_input_tokens: 800,
          output_tokens: 350,
        },
        "claude",
      ),
    ).toEqual({
      inputTokens: 120,
      cachedInputTokens: 5000,
      cacheCreationInputTokens: 800,
      outputTokens: 350,
      reasoningTokens: 0,
    });

    // Empty / zero payloads return null
    expect(normalizeRawTokenUsage({}, "codex")).toBeNull();
    expect(normalizeRawTokenUsage({ inputTokens: 0, outputTokens: 0 }, "agy")).toBeNull();
    expect(normalizeRawTokenUsage(null, "claude")).toBeNull();
  });

  it("estimates USD cost via pricing table and distinguishes exact vs estimated records", () => {
    const sonnetPricing = resolveModelPricing("claude", "claude-sonnet-4-5-20250929");
    expect(sonnetPricing.inputPerMillion).toBe(3.0);
    expect(sonnetPricing.outputPerMillion).toBe(15.0);

    const flashPricing = resolveModelPricing("agy", "gemini-3.8-flash-low");
    expect(flashPricing.inputPerMillion).toBe(0.3);

    const estimated = estimateUsageCostUsd("codex", "gpt-5.4", {
      inputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    // 2.5 + 0.25 + 15.0 = 17.75
    expect(estimated).toBeCloseTo(17.75, 6);

    const exactRec = createUsageRecord({
      source: "chat",
      provider: "claude",
      model: "claude-sonnet-4-5",
      tokens: {
        inputTokens: 100,
        cachedInputTokens: 5000,
        cacheCreationInputTokens: 400,
        outputTokens: 200,
      },
      exactCostUsd: 0.0421,
    });
    expect(exactRec).not.toBeNull();
    expect(exactRec!.isEstimated).toBe(false);
    expect(exactRec!.costUsd).toBe(0.0421);

    const estRec = createUsageRecord({
      source: "worker",
      provider: "agy",
      model: "gemini-4-neon-high",
      projectName: "conductor",
      taskId: "task-1",
      tokens: {
        inputTokens: 100_000,
        cachedInputTokens: 200_000,
        outputTokens: 50_000,
      },
    });
    expect(estRec).not.toBeNull();
    expect(estRec!.isEstimated).toBe(true);
    // 0.1*1.25 + 0.2*0.3125 + 0.05*10 = 0.125 + 0.0625 + 0.5 = 0.6875
    expect(estRec!.costUsd).toBeCloseTo(0.6875, 6);
  });

  it("aggregates today, month, and all-time summaries with provider, model, and project breakdowns", () => {
    const now = new Date(2026, 10, 26, 14, 0, 0); // 2026-11-26 14:00 local
    const todayTs = new Date(2026, 10, 26, 10, 30, 0).toISOString();
    const earlierMonthTs = new Date(2026, 10, 5, 9, 0, 0).toISOString();
    const prevMonthTs = new Date(2026, 9, 20, 12, 0, 0).toISOString();

    const records: UsageRecord[] = [
      createUsageRecord({
        id: "r1",
        timestamp: todayTs,
        source: "chat",
        provider: "codex",
        model: "gpt-5.4",
        projectName: null,
        tokens: { inputTokens: 1000, cachedInputTokens: 500, outputTokens: 200 },
      })!,
      createUsageRecord({
        id: "r2",
        timestamp: todayTs,
        source: "worker",
        provider: "claude",
        model: "claude-sonnet-4-5",
        projectName: "conductor",
        taskId: "t1",
        tokens: {
          inputTokens: 500,
          cachedInputTokens: 4000,
          cacheCreationInputTokens: 500,
          outputTokens: 1000,
        },
        exactCostUsd: 0.025,
      })!,
      createUsageRecord({
        id: "r3",
        timestamp: earlierMonthTs,
        source: "worker",
        provider: "agy",
        model: "gemini-4-neon-high",
        projectName: "conductor",
        taskId: "t2",
        tokens: { inputTokens: 2000, cachedInputTokens: 1000, outputTokens: 500 },
      })!,
      createUsageRecord({
        id: "r4",
        timestamp: prevMonthTs,
        source: "worker",
        provider: "codex",
        model: "gpt-5-mini",
        projectName: "other-app",
        taskId: "t3",
        tokens: { inputTokens: 10_000, cachedInputTokens: 0, outputTokens: 2000 },
      })!,
    ];

    const allPeriods = summarizeAllUsagePeriods(records, now);

    // Today: r1 + r2
    expect(allPeriods.today.turnCount).toBe(2);
    expect(allPeriods.today.totalTokens).toBe(1700 + 6000);
    expect(allPeriods.today.costMode).toBe("mixed");
    expect(allPeriods.today.exactCostUsd).toBeCloseTo(0.025, 6);
    expect(allPeriods.today.byProvider.map((r) => r.key).sort()).toEqual(["claude", "codex"]);
    expect(allPeriods.today.byProject.map((r) => r.label).sort()).toEqual([
      "conductor",
      "一般チャット",
    ]);

    // This Month: r1 + r2 + r3
    expect(allPeriods.month.turnCount).toBe(3);
    expect(allPeriods.month.totalTokens).toBe(1700 + 6000 + 3500);
    expect(allPeriods.month.byProvider.map((r) => r.key).sort()).toEqual([
      "agy",
      "claude",
      "codex",
    ]);

    // All Time: r1 + r2 + r3 + r4
    expect(allPeriods.all.turnCount).toBe(4);
    expect(allPeriods.all.totalTokens).toBe(1700 + 6000 + 3500 + 12_000);
    expect(allPeriods.all.byProject.map((r) => r.label)).toContain("other-app");
    expect(allPeriods.all.byModel.length).toBe(4);
  });

  it("compacts older usage records into daily rollups while preserving exact totals", () => {
    const raw: UsageRecord[] = [];
    const baseDay = new Date(2026, 9, 10, 8, 0, 0);
    for (let i = 0; i < 30; i += 1) {
      raw.push(
        createUsageRecord({
          id: `r-${i}`,
          timestamp: new Date(baseDay.getTime() + i * 60_000).toISOString(),
          source: "worker",
          provider: "codex",
          model: "gpt-5.4",
          projectName: "demo",
          tokens: { inputTokens: 100, cachedInputTokens: 50, outputTokens: 25 },
        })!,
      );
    }

    const before = summarizeUsage(raw, "all");
    const compacted = compactUsageRecords(raw, 10, 5);
    const after = summarizeUsage(compacted, "all");

    expect(compacted.length).toBeLessThanOrEqual(10);
    expect(after.turnCount).toBe(before.turnCount);
    expect(after.totalTokens).toBe(before.totalTokens);
    expect(after.costUsd).toBeCloseTo(before.costUsd, 8);
  });

  it("formats token counts and USD costs cleanly", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(950)).toBe("950");
    expect(formatTokenCount(12_400)).toBe("12.4K");
    expect(formatTokenCount(1_250_000)).toBe("1.25M");

    expect(formatUsdCost(0)).toBe("$0.00");
    expect(formatUsdCost(0.0042, { estimated: true })).toBe("~$0.0042");
    expect(formatUsdCost(0.0042, { estimated: true, compact: true })).toBe("~$0.004");
    expect(formatUsdCost(1.234)).toBe("$1.23");
    expect(formatUsdCost(1.234, { estimated: true })).toBe("~$1.23");
    expect(formatUsagePercent(0)).toBe("0%");
    expect(formatUsagePercent(0.45)).toBe("0.5%");
    expect(formatUsagePercent(45)).toBe("45%");
    expect(formatUsagePercent(82.4)).toBe("82.4%");
    expect(formatUsagePercent(112.7)).toBe("113%");
  });

  it("computes local Monday-start weekly summaries across month boundaries, evaluates budgets, and builds daily/weekly trends", () => {
    // 2026-12-02 is Wednesday -> Monday of this week is 2026-11-30 (previous month!)
    const now = new Date(2026, 11, 2, 15, 0, 0);
    const monPrevMonthTs = new Date(2026, 10, 30, 10, 0, 0).toISOString(); // Nov 30 (in this week, NOT in Dec month)
    const sunPrevWeekTs = new Date(2026, 10, 29, 22, 0, 0).toISOString(); // Nov 29 (previous week)
    const todayTs = new Date(2026, 11, 2, 11, 0, 0).toISOString(); // Dec 2 (today, this week, this month)

    const records: UsageRecord[] = [
      createUsageRecord({
        id: "w1",
        timestamp: todayTs,
        source: "chat",
        provider: "codex",
        model: "gpt-5.4",
        tokens: { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 500_000 },
        exactCostUsd: 10.0,
      })!,
      createUsageRecord({
        id: "w2",
        timestamp: monPrevMonthTs,
        source: "worker",
        provider: "claude",
        model: "claude-sonnet-4-5",
        projectName: "conductor",
        tokens: { inputTokens: 500_000, cachedInputTokens: 0, outputTokens: 200_000 },
        exactCostUsd: 11.5,
      })!,
      createUsageRecord({
        id: "w3",
        timestamp: sunPrevWeekTs,
        source: "worker",
        provider: "agy",
        model: "gemini-4-neon-high",
        projectName: "conductor",
        tokens: { inputTokens: 300_000, cachedInputTokens: 0, outputTokens: 100_000 },
        exactCostUsd: 5.0,
      })!,
    ];

    const periods = summarizeAllUsagePeriods(records, now);
    expect(periods.today.turnCount).toBe(1);
    expect(periods.today.costUsd).toBeCloseTo(10.0, 6);
    // Week includes Dec 2 (10.0) + Nov 30 (11.5) = 21.5, excludes Nov 29
    expect(periods.week.turnCount).toBe(2);
    expect(periods.week.costUsd).toBeCloseTo(21.5, 6);
    expect(periods.week.totalTokens).toBe(1_500_000 + 700_000);
    // Month (Dec) includes only Dec 2
    expect(periods.month.turnCount).toBe(1);
    expect(periods.month.costUsd).toBeCloseTo(10.0, 6);
    expect(periods.all.turnCount).toBe(3);

    // Budget normalization & threshold evaluation (ok / warning >80% / exceeded >=100%)
    const defaults = normalizeUsageBudgetSettings(undefined);
    expect(defaults).toEqual(DEFAULT_USAGE_BUDGETS);

    const custom = normalizeUsageBudgetSettings({
      weekly: { unit: "usd", limit: 25 },
      monthly: { unit: "tokens", limit: 1_000_000 },
    });
    const weeklyEval = evaluateUsageBudget(periods.week.costUsd, periods.week.totalTokens, custom.weekly);
    expect(weeklyEval.percent).toBeCloseTo(86, 4);
    expect(weeklyEval.severity).toBe("warning");
    expect(weeklyEval.remaining).toBeCloseTo(3.5, 4);
    expect(weeklyEval.overage).toBe(0);

    const monthlyEval = evaluateUsageBudget(
      periods.month.costUsd,
      periods.month.totalTokens,
      custom.monthly,
    );
    expect(monthlyEval.unit).toBe("tokens");
    expect(monthlyEval.percent).toBeCloseTo(150, 4);
    expect(monthlyEval.barPercent).toBe(100);
    expect(monthlyEval.severity).toBe("exceeded");
    expect(monthlyEval.remaining).toBe(0);
    expect(monthlyEval.overage).toBe(500_000);

    const okEval = evaluateUsageBudget(5, 100_000, { unit: "usd", limit: 25 });
    expect(okEval.severity).toBe("ok");
    expect(okEval.percent).toBeCloseTo(20, 4);

    // Daily (14d) & Weekly (8w) trend buckets
    const daily = buildDailyUsageTrend(records, 14, now);
    expect(daily).toHaveLength(14);
    expect(daily.at(-1)?.isCurrent).toBe(true);
    expect(daily.at(-1)?.costUsd).toBeCloseTo(10.0, 6);
    expect(daily.at(-1)?.byProviderCostUsd.codex).toBeCloseTo(10.0, 6);
    expect(daily.at(-3)?.costUsd).toBeCloseTo(11.5, 6); // Nov 30
    expect(daily.at(-4)?.costUsd).toBeCloseTo(5.0, 6); // Nov 29

    const weekly = buildWeeklyUsageTrend(records, 8, now);
    expect(weekly).toHaveLength(8);
    expect(weekly.at(-1)?.isCurrent).toBe(true);
    expect(weekly.at(-1)?.costUsd).toBeCloseTo(21.5, 6);
    expect(weekly.at(-2)?.costUsd).toBeCloseTo(5.0, 6);
  });
});

describe("Provider usage event parsing (Codex / AGY / Claude)", () => {
  it("parses Codex thread/tokenUsage/updated, token_count, and turn/completed notifications", () => {
    const updated = extractCodexTokenUsage({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thr-1",
        tokenUsage: {
          total: {
            inputTokens: 2000,
            cachedInputTokens: 800,
            outputTokens: 300,
            reasoningOutputTokens: 100,
          },
          last: {
            inputTokens: 1000,
            cachedInputTokens: 400,
            outputTokens: 150,
            reasoningOutputTokens: 50,
          },
        },
      },
    });
    expect(updated?.total).toEqual({
      inputTokens: 1200,
      cachedInputTokens: 800,
      cacheCreationInputTokens: 0,
      outputTokens: 300,
      reasoningTokens: 100,
    });
    expect(updated?.last?.inputTokens).toBe(600);

    const legacyTokenCount = extractCodexTokenUsage({
      method: "token_count",
      params: {
        info: {
          last_token_usage: {
            input_tokens: 900,
            cached_input_tokens: 300,
            output_tokens: 200,
            reasoning_output_tokens: 40,
          },
        },
      },
    });
    expect(legacyTokenCount?.last).toEqual({
      inputTokens: 600,
      cachedInputTokens: 300,
      cacheCreationInputTokens: 0,
      outputTokens: 200,
      reasoningTokens: 40,
    });

    const turnCompleted = extractCodexTokenUsage({
      method: "turn/completed",
      params: {
        turn: {
          id: "turn-1",
          status: "completed",
          usage: {
            inputTokens: 500,
            cachedInputTokens: 100,
            outputTokens: 120,
            reasoningTokens: 30,
          },
        },
      },
    });
    expect(turnCompleted?.direct).toEqual({
      inputTokens: 400,
      cachedInputTokens: 100,
      cacheCreationInputTokens: 0,
      outputTokens: 120,
      reasoningTokens: 30,
    });
  });

  it("parses AGY ACP prompt usage, session usage_update, and stream-json result events", () => {
    const acpUsage = extractAgyPromptUsage({
      stopReason: "end_turn",
      usage: {
        inputTokens: 1500,
        cachedReadTokens: 1000,
        outputTokens: 250,
        thoughtTokens: 50,
        totalTokens: 1800,
      },
    });
    expect(acpUsage).toEqual({
      inputTokens: 500,
      cachedInputTokens: 1000,
      cacheCreationInputTokens: 0,
      outputTokens: 300,
      reasoningTokens: 50,
    });

    const updateParsed = parseAgySessionUpdate({
      sessionUpdate: "usage_update",
      usage: {
        input_tokens: 800,
        cached_input_tokens: 200,
        output_tokens: 150,
      },
    });
    expect(updateParsed).toEqual({
      kind: "usageUpdate",
      usage: {
        inputTokens: 600,
        cachedInputTokens: 200,
        cacheCreationInputTokens: 0,
        outputTokens: 150,
        reasoningTokens: 0,
      },
    });

    // stream-json result (snake_case inside result.usage)
    const streamSnake = extractAgyStreamJsonUsage({
      event: "result",
      result: {
        status: "SUCCESS",
        response: "Done",
        usage: {
          input_tokens: 4000,
          cached_input_tokens: 2500,
          output_tokens: 600,
        },
      },
    });
    expect(streamSnake).toEqual({
      inputTokens: 1500,
      cachedInputTokens: 2500,
      cacheCreationInputTokens: 0,
      outputTokens: 600,
      reasoningTokens: 0,
    });

    // stream-json result (camelCase at top level)
    const streamCamel = extractAgyStreamJsonUsage({
      event: "result",
      usage: {
        inputTokens: 2000,
        cachedInputTokens: 500,
        outputTokens: 400,
        reasoningTokens: 100,
      },
    });
    expect(streamCamel).toEqual({
      inputTokens: 1500,
      cachedInputTokens: 500,
      cacheCreationInputTokens: 0,
      outputTokens: 400,
      reasoningTokens: 100,
    });
  });

  it("parses Claude stream-json result events with usage, total_cost_usd, and modelUsage", () => {
    const parsed = extractClaudeStreamJsonUsage(
      {
        type: "result",
        subtype: "success",
        is_error: false,
        total_cost_usd: 0.0384,
        usage: {
          input_tokens: 250,
          cache_read_input_tokens: 12000,
          cache_creation_input_tokens: 1800,
          output_tokens: 450,
        },
        modelUsage: {
          "claude-sonnet-4-5-20250929": {
            inputTokens: 250,
            cacheReadInputTokens: 12000,
            cacheCreationInputTokens: 1800,
            outputTokens: 450,
            costUSD: 0.0384,
          },
        },
      },
      "sonnet",
    );

    expect(parsed).toEqual({
      inputTokens: 250,
      cachedInputTokens: 12000,
      cacheCreationInputTokens: 1800,
      outputTokens: 450,
      reasoningTokens: 0,
      costUsd: 0.0384,
      model: "claude-sonnet-4-5-20250929",
    });
  });

  it("parses Codex account/rateLimits/read, sparse rolling updates, and Claude rate_limit_event", () => {
    const fixedNow = new Date("2026-11-26T08:00:00.000Z");
    const codexSnap = parseCodexRateLimits(
      {
        rateLimits: {
          limitId: "codex",
          planType: "pro",
          primary: {
            usedPercent: 45,
            windowDurationMins: 10080,
            resetsAt: 1796054662,
          },
          secondary: {
            usedPercent: 18,
            windowDurationMins: 300,
            resetsAt: 1795700000,
          },
          credits: {
            hasCredits: true,
            unlimited: false,
            balance: "59818.99",
          },
        },
      },
      fixedNow,
    );
    expect(codexSnap).not.toBeNull();
    expect(codexSnap!.provider).toBe("codex");
    expect(codexSnap!.planType).toBe("pro");
    expect(codexSnap!.windows).toHaveLength(2);
    expect(codexSnap!.windows[0]).toMatchObject({
      id: "primary",
      windowDurationMins: 10080,
      usedPercent: 45,
      remainingPercent: 55,
    });
    expect(codexSnap!.credits?.balance).toBe("59818.99");

    // Sparse rolling notification omits planType & credits -> merge preserves them
    const rolling = extractCodexRateLimitUpdate(
      {
        method: "account/rateLimits/updated",
        params: {
          rateLimits: {
            primary: {
              usedPercent: 52,
              windowDurationMins: 10080,
              resetsAt: 1796054662,
            },
          },
        },
      },
      fixedNow,
    );
    expect(rolling).not.toBeNull();
    const merged = mergeProviderQuotaSnapshot(codexSnap!, rolling!);
    expect(merged.planType).toBe("pro");
    expect(merged.credits?.balance).toBe("59818.99");
    expect(merged.windows.find((w) => w.id === "primary")?.usedPercent).toBe(52);
    expect(merged.windows.find((w) => w.id === "secondary")?.usedPercent).toBe(18);

    // Claude rate_limit_event with fractional utilization
    const claudeWin = extractClaudeRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        rateLimitType: "seven_day",
        utilization: 0.84,
        resetsAt: 1796054662,
      },
    });
    expect(claudeWin).toMatchObject({
      id: "seven_day",
      windowDurationMins: 10080,
      usedPercent: 84,
      remainingPercent: 16,
    });
  });
});

describe("ConductorController & StateStore end-to-end usage ledger persistence", () => {
  it("records Codex orchestrator/worker turns, CLI worker turns, persists across reload, and resets cleanly", async () => {
    const dataDir = makeTempDir("conductor-usage-ctrl-");
    const projectDir = makeTempDir("conductor-usage-proj-");
    const store = new StateStore(dataDir);

    let workerNotifHandler: ((n: CodexNotification) => void) | null = null;
    const fakeWorkerClient = {
      label: "fake-worker",
      isConnected: () => true,
      onNotification: (fn: (n: CodexNotification) => void) => {
        workerNotifHandler = fn;
        return () => {};
      },
      onDisconnect: () => () => {},
      stop: () => {},
      startThread: async () => "worker-thr-1",
      startTurn: async () => "worker-turn-1",
    } as unknown as CodexAppServerClient;

    const fakeAgyClient = {
      isAvailable: () => true,
      isConnected: () => false,
      onSessionUpdate: () => () => {},
      onDisconnect: () => () => {},
      stop: () => {},
    } as unknown as AgyAcpClient;

    const controller = new ConductorController({
      store,
      browser: createFakeBrowserManager(),
      onSnapshot: () => {},
      agyOrchestratorClient: fakeAgyClient,
      workerClient: fakeWorkerClient,
      cliWorkerRunner: {
        runAgyTurn: (_opts, callbacks: CliTurnCallbacks): RunningCliTurn => {
          callbacks.onComplete?.({
            ok: true,
            finalText: "AGY done",
            usage: {
              inputTokens: 1000,
              cachedInputTokens: 2000,
              cacheCreationInputTokens: 0,
              outputTokens: 500,
              reasoningTokens: 100,
            },
          });
          return { cancel: vi.fn(), waitForExit: async () => {} };
        },
        runClaudeTurn: (_opts, callbacks: CliTurnCallbacks): RunningCliTurn => {
          callbacks.onComplete?.({
            ok: true,
            finalText: "Claude done",
            usage: {
              inputTokens: 300,
              cachedInputTokens: 8000,
              cacheCreationInputTokens: 600,
              outputTokens: 400,
              reasoningTokens: 0,
              costUsd: 0.0195,
              model: "claude-sonnet-4-5-20250929",
            },
          });
          return { cancel: vi.fn(), waitForExit: async () => {} };
        },
      },
    });

    (controller as unknown as Record<string, unknown>).isConnected = true;
    (controller as unknown as Record<string, unknown>).chatModel = "gpt-5.4";
    (controller as unknown as Record<string, unknown>).workerModel = "gpt-5.4";
    (controller as unknown as Record<string, unknown>).providers = {
      codex: { id: "codex", label: "Codex", available: true, detail: "ok", models: [] },
      agy: { id: "agy", label: "AGY", available: true, detail: "ok", models: [] },
      claude: { id: "claude", label: "Claude", available: true, detail: "ok", models: [] },
    };

    const project: Project = controller.registerProject(projectDir, "demo-app")!;

    // 1. Codex Orchestrator multi-step turn with duplicate notification dedup
    const internals = controller as unknown as {
      responderLanes: Array<{
        threadId: string;
        activeTurnId: string | null;
        activeAssistantMessageId: string | null;
        activeModel?: string | null;
      }>;
      handleOrchestratorNotification: (n: CodexNotification) => void;
      handleMCPToolCall: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    };
    internals.responderLanes = [
      {
        threadId: "orch-thr-1",
        activeTurnId: "orch-turn-1",
        activeAssistantMessageId: "msg-1",
        activeModel: "gpt-5.4",
      },
    ];

    // Step 1
    internals.handleOrchestratorNotification({
      method: "thread/tokenUsage/updated",
      threadId: "orch-thr-1",
      turnId: "orch-turn-1",
      itemId: null,
      params: {
        threadId: "orch-thr-1",
        tokenUsage: {
          total: { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 100 },
          last: { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 100 },
        },
      },
    });
    // Duplicate of Step 1 -> must NOT double-count
    internals.handleOrchestratorNotification({
      method: "thread/tokenUsage/updated",
      threadId: "orch-thr-1",
      turnId: "orch-turn-1",
      itemId: null,
      params: {
        threadId: "orch-thr-1",
        tokenUsage: {
          total: { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 100 },
          last: { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 100 },
        },
      },
    });
    // Step 2
    internals.handleOrchestratorNotification({
      method: "thread/tokenUsage/updated",
      threadId: "orch-thr-1",
      turnId: "orch-turn-1",
      itemId: null,
      params: {
        threadId: "orch-thr-1",
        tokenUsage: {
          total: { inputTokens: 2500, cachedInputTokens: 1400, outputTokens: 300 },
          last: { inputTokens: 1500, cachedInputTokens: 1000, outputTokens: 200 },
        },
      },
    });
    internals.handleOrchestratorNotification({
      method: "turn/completed",
      threadId: "orch-thr-1",
      turnId: "orch-turn-1",
      itemId: null,
      params: { threadId: "orch-thr-1", turn: { id: "orch-turn-1", status: "completed" } },
    });

    // 2. Codex Worker turn via start_worker + notifications
    await internals.handleMCPToolCall("start_worker", {
      project_name: project.name,
      title: "Codex work",
      prompt: "Do codex work",
      provider: "codex",
    });
    expect(workerNotifHandler).not.toBeNull();
    workerNotifHandler!({
      method: "token_count",
      threadId: "worker-thr-1",
      turnId: "worker-turn-1",
      itemId: null,
      params: {
        threadId: "worker-thr-1",
        info: {
          last_token_usage: {
            input_tokens: 3000,
            cached_input_tokens: 1000,
            output_tokens: 400,
          },
        },
      },
    });
    workerNotifHandler!({
      method: "turn/completed",
      threadId: "worker-thr-1",
      turnId: "worker-turn-1",
      itemId: null,
      params: { threadId: "worker-thr-1", turn: { id: "worker-turn-1", status: "completed" } },
    });

    // 3. AGY & Claude CLI worker turns
    await internals.handleMCPToolCall("start_worker", {
      project_name: project.name,
      title: "AGY work",
      prompt: "Do AGY work",
      provider: "agy",
    });
    await internals.handleMCPToolCall("start_worker", {
      project_name: project.name,
      title: "Claude work",
      prompt: "Do Claude work",
      provider: "claude",
    });

    const records = controller.getSnapshot().usageRecords ?? [];
    expect(records).toHaveLength(4);

    const codexChat = records.find((r) => r.provider === "codex" && r.source === "chat")!;
    expect(codexChat.inputTokens).toBe(1100); // 2500 - 1400
    expect(codexChat.cachedInputTokens).toBe(1400);
    expect(codexChat.outputTokens).toBe(300);
    expect(codexChat.isEstimated).toBe(true);

    const codexWorker = records.find((r) => r.provider === "codex" && r.source === "worker")!;
    expect(codexWorker.projectName).toBe("demo-app");
    expect(codexWorker.inputTokens).toBe(2000);
    expect(codexWorker.cachedInputTokens).toBe(1000);
    expect(codexWorker.outputTokens).toBe(400);

    const agyWorker = records.find((r) => r.provider === "agy")!;
    expect(agyWorker.isEstimated).toBe(true);
    expect(agyWorker.projectName).toBe("demo-app");

    const claudeWorker = records.find((r) => r.provider === "claude")!;
    expect(claudeWorker.isEstimated).toBe(false);
    expect(claudeWorker.costUsd).toBe(0.0195);
    expect(claudeWorker.model).toBe("claude-sonnet-4-5-20250929");

    // Persistence across reload
    const reloaded = new ConductorController({
      store,
      browser: createFakeBrowserManager(),
      onSnapshot: () => {},
    });
    expect(reloaded.getSnapshot().usageRecords).toHaveLength(4);

    // Reset clears records and persists empty array
    reloaded.clearUsageRecords();
    expect(reloaded.getSnapshot().usageRecords).toEqual([]);
    expect(normalizeUsageRecords(store.load().usageRecords)).toEqual([]);
  });

  it("persists editable usage budgets and captures live Codex & Claude provider quotas", async () => {
    const dataDir = makeTempDir("conductor-budget-ctrl-");
    const store = new StateStore(dataDir);

    let workerNotifHandler: ((n: CodexNotification) => void) | null = null;
    const fakeWorkerClient = {
      label: "fake-worker",
      isConnected: () => true,
      onNotification: (fn: (n: CodexNotification) => void) => {
        workerNotifHandler = fn;
        return () => {};
      },
      onDisconnect: () => () => {},
      stop: () => {},
      readAccountRateLimits: async () => ({
        provider: "codex" as const,
        status: "live" as const,
        planType: "pro",
        limitName: "codex",
        credits: { hasCredits: true, unlimited: false, balance: "50000" },
        windows: [
          {
            id: "primary",
            windowDurationMins: 10080,
            usedPercent: 45,
            remainingPercent: 55,
            resetsAt: "2026-12-01T10:00:00.000Z",
          },
        ],
        updatedAt: "2026-11-26T08:00:00.000Z",
      }),
    } as unknown as CodexAppServerClient;

    const controller = new ConductorController({
      store,
      browser: createFakeBrowserManager(),
      onSnapshot: () => {},
      workerClient: fakeWorkerClient,
    });

    const nextBudgets: UsageBudgetSettings = {
      weekly: { unit: "usd", limit: 40 },
      monthly: { unit: "tokens", limit: 15_000_000 },
    };
    controller.setUsageBudgets(nextBudgets);
    expect(controller.getSnapshot().usageBudgets).toEqual(nextBudgets);

    // Persists across reload
    const reloaded = new ConductorController({
      store,
      browser: createFakeBrowserManager(),
      onSnapshot: () => {},
    });
    expect(reloaded.getSnapshot().usageBudgets).toEqual(nextBudgets);

    // Refresh Codex official quota
    const quotas = await controller.refreshProviderQuotas();
    expect(quotas.codex?.planType).toBe("pro");
    expect(quotas.codex?.windows[0]?.usedPercent).toBe(45);

    // Rolling notification without threadId updates Codex quota
    expect(workerNotifHandler).not.toBeNull();
    workerNotifHandler!({
      method: "account/rateLimits/updated",
      threadId: null,
      turnId: null,
      itemId: null,
      params: {
        rateLimits: {
          primary: { usedPercent: 61, windowDurationMins: 10080 },
        },
      },
    });
    expect(controller.getSnapshot().providerQuotas?.codex?.windows[0]?.usedPercent).toBe(61);
    expect(controller.getSnapshot().providerQuotas?.codex?.planType).toBe("pro");
  });
});

describe("Usage UI (Header Pill, SettingsModal Usage Tab, UsagePanel)", () => {
  const now = new Date(2026, 10, 26, 15, 0, 0);
  const sampleRecords: UsageRecord[] = [
    createUsageRecord({
      id: "u1",
      timestamp: new Date(2026, 10, 26, 12, 0, 0).toISOString(),
      source: "worker",
      provider: "claude",
      model: "claude-sonnet-4-5",
      projectName: "conductor",
      tokens: {
        inputTokens: 1000,
        cachedInputTokens: 9000,
        cacheCreationInputTokens: 500,
        outputTokens: 1500,
      },
      exactCostUsd: 0.045,
    })!,
    createUsageRecord({
      id: "u2",
      timestamp: new Date(2026, 10, 26, 13, 0, 0).toISOString(),
      source: "chat",
      provider: "codex",
      model: "gpt-5.4",
      projectName: null,
      tokens: {
        inputTokens: 2000,
        cachedInputTokens: 3000,
        outputTokens: 500,
      },
    })!,
  ];

  it("renders UsagePanel with period selector, summary cards, provider/model/project tables, notice, and reset button", () => {
    const html = renderToStaticMarkup(
      <UsagePanel usageRecords={sampleRecords} onClearUsage={vi.fn()} now={now} />,
    );

    expect(html).toContain('data-testid="usage-period-today"');
    expect(html).toContain('data-testid="usage-period-week"');
    expect(html).toContain('data-testid="usage-period-month"');
    expect(html).toContain('data-testid="usage-period-all"');
    expect(html).toContain('data-testid="usage-budget-section"');
    expect(html).toContain('data-testid="usage-gauge-weekly"');
    expect(html).toContain('data-testid="usage-gauge-monthly"');
    expect(html).toContain('data-testid="usage-trend-section"');
    expect(html).toContain('data-testid="usage-trend-chart"');
    expect(html).toContain('data-testid="usage-total-tokens"');
    expect(html).toContain('data-testid="usage-token-breakdown"');
    expect(html).toContain('data-testid="usage-total-cost"');
    expect(html).toContain('data-testid="usage-table-provider"');
    expect(html).toContain('data-testid="usage-table-model"');
    expect(html).toContain('data-testid="usage-table-project"');
    expect(html).toContain("Codex");
    expect(html).toContain("Claude");
    expect(html).toContain("claude-sonnet-4-5");
    expect(html).toContain("gpt-5.4");
    expect(html).toContain("conductor");
    expect(html).toContain("一般チャット");
    expect(html).toContain("サブスクリプション");
    expect(html).toContain('data-testid="usage-reset-btn"');
    expect(html).toContain("履歴をリセット");
  });

  it("renders weekly/monthly gauge warning & exceeded states, inline limit editor, official provider quotas, and clean English i18n", () => {
    const heavyRecords: UsageRecord[] = [
      createUsageRecord({
        id: "h1",
        timestamp: new Date(2026, 10, 26, 11, 0, 0).toISOString(),
        source: "worker",
        provider: "claude",
        model: "claude-opus-4-5",
        projectName: "conductor",
        tokens: { inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 200_000 },
        exactCostUsd: 22.0, // 88% of $25 weekly -> warning
      })!,
      createUsageRecord({
        id: "h2",
        timestamp: new Date(2026, 10, 10, 11, 0, 0).toISOString(),
        source: "worker",
        provider: "codex",
        model: "gpt-5.4",
        projectName: "conductor",
        tokens: { inputTokens: 5_000_000, cachedInputTokens: 2_000_000, outputTokens: 1_000_000 },
        exactCostUsd: 90.0, // total month = 112.0 -> 112% of $100 monthly -> exceeded
      })!,
    ];

    const providerQuotas: ProviderQuotasMap = {
      codex: {
        provider: "codex",
        status: "live",
        planType: "pro",
        credits: { hasCredits: true, unlimited: false, balance: "59818" },
        windows: [
          {
            id: "primary",
            windowDurationMins: 10080,
            usedPercent: 45,
            remainingPercent: 55,
            resetsAt: "2026-12-01T10:00:00.000Z",
          },
        ],
        updatedAt: now.toISOString(),
      },
      claude: {
        provider: "claude",
        status: "live",
        windows: [
          {
            id: "seven_day",
            windowDurationMins: 10080,
            usedPercent: 85,
            remainingPercent: 15,
            resetsAt: "2026-12-03T00:00:00.000Z",
          },
        ],
        updatedAt: now.toISOString(),
      },
    };

    const jaHtml = renderToStaticMarkup(
      <UsagePanel
        usageRecords={heavyRecords}
        usageBudgets={{ weekly: { unit: "usd", limit: 25 }, monthly: { unit: "usd", limit: 100 } }}
        providerQuotas={providerQuotas}
        locale="ja"
        onUpdateBudgets={vi.fn()}
        onRefreshProviderQuotas={vi.fn()}
        defaultEditingBudgets={true}
        now={now}
      />,
    );
    expect(jaHtml).toContain('data-testid="usage-gauge-weekly" data-severity="warning"');
    expect(jaHtml).toContain('data-testid="usage-gauge-monthly" data-severity="exceeded"');
    expect(jaHtml).toContain("88%");
    expect(jaHtml).toContain("112%");
    expect(jaHtml).toContain("注意 (80%超)");
    expect(jaHtml).toContain("上限超過");
    expect(jaHtml).toContain('data-testid="usage-budget-editor"');
    expect(jaHtml).toContain('data-testid="usage-provider-quota-codex"');
    expect(jaHtml).toContain('data-testid="usage-provider-quota-claude"');
    expect(jaHtml).toContain("週次クォータ (7日間)");
    expect(jaHtml).toContain("残り 55%");

    const enHtml = renderToStaticMarkup(
      <UsagePanel
        usageRecords={heavyRecords}
        usageBudgets={{
          weekly: { unit: "tokens", limit: 2_000_000 },
          monthly: { unit: "usd", limit: 100 },
        }}
        providerQuotas={providerQuotas}
        locale="en"
        onUpdateBudgets={vi.fn()}
        onRefreshProviderQuotas={vi.fn()}
        onClearUsage={vi.fn()}
        defaultEditingBudgets={true}
        initialTrendGranularity="weekly"
        now={now}
      />,
    );
    expect(enHtml).toContain("Today");
    expect(enHtml).toContain("This Week");
    expect(enHtml).toContain("This Month");
    expect(enHtml).toContain("All Time");
    expect(enHtml).toContain("Weekly &amp; Monthly Quota");
    expect(enHtml).toContain("Official Provider Quotas / Rate Limits");
    expect(enHtml).toContain("Usage Trend");
    expect(enHtml).toContain("Weekly (8w)");
    expect(enHtml).not.toMatch(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/);
  });

  it("renders SettingsModal opened directly on the Usage tab", () => {
    const html = renderToStaticMarkup(
      <SettingsModal
        defaultIntegrationMode="feature-branch"
        projects={[]}
        initialTab="usage"
        usageRecords={sampleRecords}
        onClearUsage={vi.fn()}
        onClose={vi.fn()}
        onSetDefaultIntegrationMode={vi.fn()}
        onSetProjectIntegrationMode={vi.fn()}
      />,
    );

    expect(html).toContain('data-testid="settings-tab-general"');
    expect(html).toContain('data-testid="settings-tab-usage"');
    expect(html).toContain('data-testid="usage-panel"');
    expect(html).toContain("Usage / API利用料");
  });

  it("renders compact clickable usage pill in UnifiedChat header", () => {
    const todayRecord = createUsageRecord({
      id: "today-pill",
      timestamp: new Date().toISOString(),
      source: "chat",
      provider: "codex",
      model: "gpt-5.4",
      tokens: { inputTokens: 8000, cachedInputTokens: 4000, outputTokens: 1000 },
    })!;

    const snapshot: AppSnapshot = {
      projects: [],
      scanRoots: [],
      tasks: [],
      messages: [],
      activeChatSessionId: "s1",
      chatSessions: [],
      browserTabs: [],
      activeBrowserTabId: null,
      isPickingElement: false,
      showTaskSidebar: true,
      showBrowserPane: true,
      isConnected: true,
      connectionStatus: "Codex 利用可能",
      activeResponderCount: 0,
      providers: {
        codex: { id: "codex", label: "Codex", available: true, detail: "ok", models: [] },
        agy: { id: "agy", label: "AGY", available: false, detail: "", models: [] },
        claude: { id: "claude", label: "Claude", available: false, detail: "", models: [] },
      },
      chatProvider: "codex",
      workerProvider: "codex",
      models: [],
      chatModel: "gpt-5.4",
      chatEffort: "low",
      workerModel: "gpt-5.4",
      workerEffort: "medium",
      defaultIntegrationMode: "feature-branch",
      autoLandOnComplete: true,
      preferredLanguage: "ja",
      usageRecords: [todayRecord],
      lastErrorBanner: null,
    };

    const html = renderToStaticMarkup(
      <UnifiedChat
        snapshot={snapshot}
        composerText=""
        attachments={[]}
        onComposerTextChange={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onAddAttachment={vi.fn()}
        onSend={vi.fn()}
        onStopMessage={vi.fn()}
        onStopAll={vi.fn()}
        onNewChat={vi.fn()}
        onSelectChatSession={vi.fn()}
        onDeleteChatSession={vi.fn()}
        onToggleSidebar={vi.fn()}
        onToggleBrowser={vi.fn()}
        onToggleMarkdownViewer={vi.fn()}
        onAddProject={vi.fn()}
        onOpenUrl={vi.fn()}
        onOpenMarkdownFile={vi.fn()}
        onOpenTask={vi.fn()}
        onToggleElementPicker={vi.fn()}
        onCaptureScreenshot={vi.fn()}
        onAttachCurrentUrl={vi.fn()}
        onAttachConsoleErrors={vi.fn()}
        onPickLocalImages={vi.fn()}
        onPasteImage={vi.fn()}
        onReconnect={vi.fn()}
        onDismissError={vi.fn()}
        onSetChatProvider={vi.fn()}
        onSetWorkerProvider={vi.fn()}
        onSetChatModel={vi.fn()}
        onSetWorkerModel={vi.fn()}
        onOpenUsage={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(html).toContain('data-testid="open-usage-btn"');
    expect(html).toContain("13.0K");
    expect(html).toContain("~$0.04");
  });
});
