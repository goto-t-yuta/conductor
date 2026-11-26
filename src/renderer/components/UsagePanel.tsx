import React, { useEffect, useMemo, useState } from "react";
import {
  Activity,
  BarChart3,
  Coins,
  Cpu,
  FolderKanban,
  Gauge,
  Info,
  Layers,
  Pencil,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { t, type UiLocale } from "../../shared/i18n.js";
import type {
  AgentProvider,
  ProviderQuotaSnapshot,
  ProviderQuotasMap,
  ProviderQuotaWindow,
  UsageBudgetSettings,
  UsageBudgetStatus,
  UsageBudgetUnit,
  UsagePeriod,
  UsageQuotaSeverity,
  UsageRecord,
  UsageTrendGranularity,
} from "../../shared/types.js";
import {
  buildDailyUsageTrend,
  buildWeeklyUsageTrend,
  classifyQuotaSeverity,
  DEFAULT_TOKEN_BUDGET_LIMITS,
  DEFAULT_USAGE_BUDGETS,
  DEFAULT_USD_BUDGET_LIMITS,
  evaluateUsageBudget,
  formatBudgetValue,
  formatTokenCount,
  formatUsagePercent,
  formatUsdCost,
  GENERAL_CHAT_PROJECT_KEY,
  normalizeUsageBudgetSettings,
  PROVIDER_LABELS,
  summarizeAllUsagePeriods,
  type UsageBreakdownRow,
} from "../../shared/usage.js";

export interface UsagePanelProps {
  usageRecords: UsageRecord[];
  usageBudgets?: UsageBudgetSettings;
  providerQuotas?: ProviderQuotasMap;
  locale?: UiLocale;
  onClearUsage?: () => void;
  onUpdateBudgets?: (budgets: UsageBudgetSettings) => void;
  onRefreshProviderQuotas?: () => void | Promise<unknown>;
  initialPeriod?: UsagePeriod;
  initialTrendGranularity?: UsageTrendGranularity;
  defaultEditingBudgets?: boolean;
  now?: Date;
}

const PERIOD_IDS: readonly UsagePeriod[] = ["today", "week", "month", "all"];

const PROVIDER_BADGE_STYLES: Record<AgentProvider, string> = {
  codex: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 border-emerald-500/25",
  agy: "bg-indigo-500/12 text-indigo-700 dark:text-indigo-300 border-indigo-500/25",
  claude: "bg-amber-500/12 text-amber-700 dark:text-amber-300 border-amber-500/25",
};

const PROVIDER_DOT_COLORS: Record<AgentProvider, string> = {
  codex: "bg-emerald-500",
  agy: "bg-indigo-500",
  claude: "bg-amber-500",
};

const SEVERITY_BAR_CLASSES: Record<UsageQuotaSeverity, string> = {
  ok: "bg-indigo-500",
  warning: "bg-amber-500",
  exceeded: "bg-rose-500",
};

const SEVERITY_TEXT_CLASSES: Record<UsageQuotaSeverity, string> = {
  ok: "text-indigo-600 dark:text-indigo-400",
  warning: "text-amber-600 dark:text-amber-400",
  exceeded: "text-rose-600 dark:text-rose-400",
};

const SEVERITY_BADGE_CLASSES: Record<UsageQuotaSeverity, string> = {
  ok: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  warning: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  exceeded: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
};

function getPeriodLabel(period: UsagePeriod, locale: UiLocale): string {
  switch (period) {
    case "today":
      return t(locale, "usage.periodToday");
    case "week":
      return t(locale, "usage.periodWeek");
    case "month":
      return t(locale, "usage.periodMonth");
    case "all":
      return t(locale, "usage.periodAll");
  }
}

function getSeverityLabel(severity: UsageQuotaSeverity, locale: UiLocale): string {
  switch (severity) {
    case "exceeded":
      return t(locale, "usage.statusExceeded");
    case "warning":
      return t(locale, "usage.statusWarning");
    case "ok":
      return t(locale, "usage.statusOk");
  }
}

function formatQuotaWindowLabel(window: ProviderQuotaWindow, locale: UiLocale): string {
  const mins = window.windowDurationMins;
  if (mins !== null && mins > 0) {
    if (mins >= 9_900 && mins <= 10_260) {
      return t(locale, "usage.windowWeekly");
    }
    if (mins >= 40_000 && mins <= 45_000) {
      return t(locale, "usage.windowMonthly");
    }
    if (mins >= 290 && mins <= 310) {
      return t(locale, "usage.windowFiveHour");
    }
    if (mins >= 1_400 && mins <= 1_480) {
      return t(locale, "usage.windowDaily");
    }
    if (mins >= 2_880) {
      return t(locale, "usage.windowDays", { days: Math.round(mins / 1_440) });
    }
    return t(locale, "usage.windowHours", { hours: Math.max(1, Math.round(mins / 60)) });
  }
  const lower = window.id.toLowerCase();
  if (lower.includes("seven_day") || lower.includes("week")) {
    return t(locale, "usage.windowWeekly");
  }
  if (lower.includes("month") || lower.includes("thirty_day")) {
    return t(locale, "usage.windowMonthly");
  }
  if (lower.includes("five_hour")) {
    return t(locale, "usage.windowFiveHour");
  }
  if (lower === "secondary") {
    return t(locale, "usage.windowSecondary");
  }
  return t(locale, "usage.windowPrimary");
}

function formatResetDateTime(iso: string | null, locale: UiLocale): string | null {
  if (!iso) return null;
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(locale === "ja" ? "ja-JP" : "en-US", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(dt);
  } catch {
    return iso.slice(0, 16).replace("T", " ");
  }
}

function CostTag({
  hasEstimated,
  hasExact,
  locale,
}: {
  hasEstimated: boolean;
  hasExact: boolean;
  locale: UiLocale;
}) {
  if (!hasEstimated && !hasExact) return null;
  if (hasExact && !hasEstimated) {
    return (
      <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-500/12 text-emerald-700 dark:text-emerald-300">
        {t(locale, "usage.costTagExact")}
      </span>
    );
  }
  if (hasExact && hasEstimated) {
    return (
      <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-500/12 text-indigo-700 dark:text-indigo-300">
        {t(locale, "usage.costTagMixed")}
      </span>
    );
  }
  return (
    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/12 text-amber-700 dark:text-amber-300">
      {t(locale, "usage.costTagEstimated")}
    </span>
  );
}

interface BudgetGaugeCardProps {
  testId: string;
  label: string;
  resetHint: string;
  status: UsageBudgetStatus;
  hasEstimatedCost: boolean;
  locale: UiLocale;
}

const BudgetGaugeCard: React.FC<BudgetGaugeCardProps> = ({
  testId,
  label,
  resetHint,
  status,
  hasEstimatedCost,
  locale,
}) => {
  const usedFormatted = formatBudgetValue(status.used, status.unit, {
    estimated: status.unit === "usd" ? hasEstimatedCost : false,
  });
  const limitFormatted = formatBudgetValue(status.limit, status.unit);
  const deltaText =
    status.overage > 0
      ? t(locale, "usage.overageLabel", {
          value: formatBudgetValue(status.overage, status.unit),
        })
      : t(locale, "usage.remainingLabel", {
          value: formatBudgetValue(status.remaining, status.unit),
        });

  return (
    <div
      data-testid={testId}
      data-severity={status.severity}
      className={`p-3.5 rounded-xl border space-y-2 transition-colors ${
        status.severity === "exceeded"
          ? "bg-rose-500/6 border-rose-500/35 dark:border-rose-500/40"
          : status.severity === "warning"
            ? "bg-amber-500/6 border-amber-500/35 dark:border-amber-500/40"
            : "bg-zinc-50/80 dark:bg-zinc-900/60 border-zinc-200/80 dark:border-zinc-800"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11.5px] font-semibold text-zinc-800 dark:text-zinc-200 truncate">
            {label}
          </div>
          <div className="text-[10px] text-zinc-400 truncate">{resetHint}</div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span
            className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
              SEVERITY_BADGE_CLASSES[status.severity]
            }`}
          >
            {getSeverityLabel(status.severity, locale)}
          </span>
          <span
            className={`text-[15px] font-bold tabular-nums ${
              SEVERITY_TEXT_CLASSES[status.severity]
            }`}
          >
            {formatUsagePercent(status.percent)}
          </span>
        </div>
      </div>

      {/* Progress Bar with 80% warning tick */}
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(status.percent)}
        className="relative h-2.5 w-full rounded-full bg-zinc-200/90 dark:bg-zinc-800 overflow-hidden"
      >
        <div
          className={`h-full rounded-full transition-all duration-300 ${
            SEVERITY_BAR_CLASSES[status.severity]
          }`}
          style={{ width: `${status.barPercent}%` }}
        />
        <span
          aria-hidden="true"
          className="absolute top-0 bottom-0 w-px bg-zinc-400/60 dark:bg-zinc-500/60"
          style={{ left: "80%" }}
        />
      </div>

      <div className="flex items-center justify-between gap-2 text-[11px] tabular-nums">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">
          {t(locale, "usage.usedOfLimit", {
            used: usedFormatted,
            limit: limitFormatted,
          })}
        </span>
        <span
          className={`font-semibold ${
            status.overage > 0
              ? "text-rose-600 dark:text-rose-400"
              : "text-zinc-500 dark:text-zinc-400"
          }`}
        >
          {deltaText}
        </span>
      </div>
    </div>
  );
};

interface BreakdownTableProps {
  testId: string;
  title: string;
  icon: React.ReactNode;
  rows: UsageBreakdownRow[];
  totalCostUsd: number;
  totalTokens: number;
  locale: UiLocale;
  showProviderBadge?: boolean;
  showDetailedTokens?: boolean;
}

const BreakdownTable: React.FC<BreakdownTableProps> = ({
  testId,
  title,
  icon,
  rows,
  totalCostUsd,
  totalTokens,
  locale,
  showProviderBadge = false,
  showDetailedTokens = false,
}) => (
  <section data-testid={testId} className="space-y-2">
    <h4 className="text-[12px] font-semibold text-zinc-800 dark:text-zinc-200 flex items-center gap-1.5">
      {icon}
      <span>{title}</span>
    </h4>
    <div className="rounded-xl border border-zinc-200/90 dark:border-zinc-800 overflow-hidden bg-zinc-50/50 dark:bg-zinc-900/40">
      <table className="w-full text-[11.5px] border-collapse">
        <thead>
          <tr className="border-b border-zinc-200/80 dark:border-zinc-800 text-[10.5px] text-zinc-500 dark:text-zinc-400 bg-zinc-100/70 dark:bg-zinc-900/70">
            <th className="text-left font-medium px-3 py-1.5">{t(locale, "usage.colTarget")}</th>
            <th className="text-right font-medium px-2 py-1.5 w-14">
              {t(locale, "usage.colCount")}
            </th>
            {showDetailedTokens && (
              <th className="text-right font-medium px-2 py-1.5 hidden sm:table-cell">
                {t(locale, "usage.colBreakdown")}
              </th>
            )}
            <th className="text-right font-medium px-2 py-1.5 w-20">
              {t(locale, "usage.colTotal")}
            </th>
            <th className="text-right font-medium px-2 py-1.5 w-20 hidden sm:table-cell">
              {t(locale, "usage.colShare")}
            </th>
            <th className="text-right font-medium px-3 py-1.5 w-24">
              {t(locale, "usage.colCost")}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-200/70 dark:divide-zinc-800/70">
          {rows.map((row) => {
            const totalInput = row.inputTokens + row.cacheCreationInputTokens;
            const displayLabel =
              row.key === GENERAL_CHAT_PROJECT_KEY
                ? t(locale, "usage.generalChat")
                : row.label;
            const shareRatio =
              totalCostUsd > 0
                ? row.costUsd / totalCostUsd
                : totalTokens > 0
                  ? row.totalTokens / totalTokens
                  : 0;
            const sharePct = Math.min(100, Math.max(0, shareRatio * 100));
            return (
              <tr
                key={row.key}
                className="hover:bg-zinc-100/60 dark:hover:bg-zinc-800/40 transition-colors"
              >
                <td className="px-3 py-2 font-medium text-zinc-900 dark:text-zinc-100 max-w-[220px]">
                  <div className="flex items-center gap-1.5 min-w-0">
                    {showProviderBadge && row.provider && (
                      <span
                        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-semibold shrink-0 ${
                          PROVIDER_BADGE_STYLES[row.provider]
                        }`}
                      >
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${PROVIDER_DOT_COLORS[row.provider]}`}
                        />
                        {PROVIDER_LABELS[row.provider]}
                      </span>
                    )}
                    {!showProviderBadge && row.provider && (
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 ${PROVIDER_DOT_COLORS[row.provider]}`}
                      />
                    )}
                    <span className="truncate" title={displayLabel}>
                      {displayLabel}
                    </span>
                  </div>
                </td>
                <td className="px-2 py-2 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
                  {row.turnCount.toLocaleString()}
                </td>
                {showDetailedTokens && (
                  <td className="px-2 py-2 text-right tabular-nums text-[11px] text-zinc-500 dark:text-zinc-400 hidden sm:table-cell">
                    {formatTokenCount(totalInput)} / {formatTokenCount(row.cachedInputTokens)} /{" "}
                    {formatTokenCount(row.outputTokens)}
                  </td>
                )}
                <td
                  className="px-2 py-2 text-right tabular-nums font-medium text-zinc-800 dark:text-zinc-200"
                  title={`${row.totalTokens.toLocaleString()} tokens`}
                >
                  {formatTokenCount(row.totalTokens)}
                </td>
                <td className="px-2 py-2 text-right tabular-nums hidden sm:table-cell">
                  <div className="flex items-center justify-end gap-1.5">
                    <div className="w-10 h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          row.provider ? PROVIDER_DOT_COLORS[row.provider] : "bg-indigo-500"
                        }`}
                        style={{ width: `${Math.max(sharePct > 0 ? 4 : 0, sharePct)}%` }}
                      />
                    </div>
                    <span className="text-[10.5px] text-zinc-500 dark:text-zinc-400 w-9 text-right">
                      {formatUsagePercent(sharePct)}
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2 text-right tabular-nums font-semibold text-zinc-900 dark:text-zinc-100">
                  {formatUsdCost(row.costUsd, { estimated: row.hasEstimatedCost })}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  </section>
);

export const UsagePanel: React.FC<UsagePanelProps> = ({
  usageRecords,
  usageBudgets,
  providerQuotas,
  locale = "ja",
  onClearUsage,
  onUpdateBudgets,
  onRefreshProviderQuotas,
  initialPeriod = "today",
  initialTrendGranularity = "daily",
  defaultEditingBudgets = false,
  now,
}) => {
  const [period, setPeriod] = useState<UsagePeriod>(initialPeriod);
  const [trendGranularity, setTrendGranularity] =
    useState<UsageTrendGranularity>(initialTrendGranularity);
  const [trendMetric, setTrendMetric] = useState<"cost" | "tokens">("cost");
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [refreshingQuotas, setRefreshingQuotas] = useState(false);

  const normalizedBudgets = useMemo(
    () => normalizeUsageBudgetSettings(usageBudgets),
    [usageBudgets],
  );
  const [editingBudgets, setEditingBudgets] = useState(defaultEditingBudgets);
  const [weeklyUnitDraft, setWeeklyUnitDraft] = useState<UsageBudgetUnit>(
    normalizedBudgets.weekly.unit,
  );
  const [weeklyLimitDraft, setWeeklyLimitDraft] = useState(
    String(normalizedBudgets.weekly.limit),
  );
  const [monthlyUnitDraft, setMonthlyUnitDraft] = useState<UsageBudgetUnit>(
    normalizedBudgets.monthly.unit,
  );
  const [monthlyLimitDraft, setMonthlyLimitDraft] = useState(
    String(normalizedBudgets.monthly.limit),
  );
  const [budgetValidationError, setBudgetValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (!editingBudgets) {
      setWeeklyUnitDraft(normalizedBudgets.weekly.unit);
      setWeeklyLimitDraft(String(normalizedBudgets.weekly.limit));
      setMonthlyUnitDraft(normalizedBudgets.monthly.unit);
      setMonthlyLimitDraft(String(normalizedBudgets.monthly.limit));
    }
  }, [normalizedBudgets, editingBudgets]);

  const allPeriods = useMemo(
    () => summarizeAllUsagePeriods(usageRecords, now),
    [usageRecords, now],
  );
  const summary = allPeriods[period];

  const weeklyStatus = useMemo(
    () =>
      evaluateUsageBudget(
        allPeriods.week.costUsd,
        allPeriods.week.totalTokens,
        normalizedBudgets.weekly,
      ),
    [allPeriods.week.costUsd, allPeriods.week.totalTokens, normalizedBudgets.weekly],
  );
  const monthlyStatus = useMemo(
    () =>
      evaluateUsageBudget(
        allPeriods.month.costUsd,
        allPeriods.month.totalTokens,
        normalizedBudgets.monthly,
      ),
    [allPeriods.month.costUsd, allPeriods.month.totalTokens, normalizedBudgets.monthly],
  );

  const trendBuckets = useMemo(
    () =>
      trendGranularity === "daily"
        ? buildDailyUsageTrend(usageRecords, 14, now)
        : buildWeeklyUsageTrend(usageRecords, 8, now),
    [usageRecords, trendGranularity, now],
  );

  const maxTrendValue = useMemo(() => {
    let maxVal = 0;
    for (const b of trendBuckets) {
      const v = trendMetric === "cost" ? b.costUsd : b.totalTokens;
      if (v > maxVal) maxVal = v;
    }
    return maxVal;
  }, [trendBuckets, trendMetric]);

  const liveProviderQuotas = useMemo(() => {
    const list: ProviderQuotaSnapshot[] = [];
    for (const p of ["codex", "claude", "agy"] as const) {
      const snap = providerQuotas?.[p];
      if (snap && snap.status === "live" && snap.windows.length > 0) {
        list.push(snap);
      }
    }
    return list;
  }, [providerQuotas]);

  const totalInputWithCreate = summary.inputTokens + summary.cacheCreationInputTokens;
  const denom = Math.max(1, summary.totalTokens);
  const inputPct = Math.round((totalInputWithCreate / denom) * 100);
  const cachedPct = Math.round((summary.cachedInputTokens / denom) * 100);
  const outputPct = Math.max(0, 100 - inputPct - cachedPct);

  const handleToggleUnit = (scope: "weekly" | "monthly", nextUnit: UsageBudgetUnit) => {
    if (scope === "weekly") {
      if (weeklyUnitDraft === nextUnit) return;
      setWeeklyUnitDraft(nextUnit);
      setWeeklyLimitDraft(
        String(
          nextUnit === "tokens"
            ? DEFAULT_TOKEN_BUDGET_LIMITS.weekly
            : DEFAULT_USD_BUDGET_LIMITS.weekly,
        ),
      );
    } else {
      if (monthlyUnitDraft === nextUnit) return;
      setMonthlyUnitDraft(nextUnit);
      setMonthlyLimitDraft(
        String(
          nextUnit === "tokens"
            ? DEFAULT_TOKEN_BUDGET_LIMITS.monthly
            : DEFAULT_USD_BUDGET_LIMITS.monthly,
        ),
      );
    }
    setBudgetValidationError(null);
  };

  const handleSaveBudgets = () => {
    const wNum = Number(weeklyLimitDraft.trim());
    const mNum = Number(monthlyLimitDraft.trim());
    if (!Number.isFinite(wNum) || wNum <= 0 || !Number.isFinite(mNum) || mNum <= 0) {
      setBudgetValidationError(t(locale, "usage.limitValidationError"));
      return;
    }
    const next = normalizeUsageBudgetSettings({
      weekly: { unit: weeklyUnitDraft, limit: wNum },
      monthly: { unit: monthlyUnitDraft, limit: mNum },
    });
    setBudgetValidationError(null);
    onUpdateBudgets?.(next);
    setEditingBudgets(false);
  };

  const handleResetDefaultBudgets = () => {
    setWeeklyUnitDraft(DEFAULT_USAGE_BUDGETS.weekly.unit);
    setWeeklyLimitDraft(String(DEFAULT_USAGE_BUDGETS.weekly.limit));
    setMonthlyUnitDraft(DEFAULT_USAGE_BUDGETS.monthly.unit);
    setMonthlyLimitDraft(String(DEFAULT_USAGE_BUDGETS.monthly.limit));
    setBudgetValidationError(null);
    onUpdateBudgets?.({
      weekly: { ...DEFAULT_USAGE_BUDGETS.weekly },
      monthly: { ...DEFAULT_USAGE_BUDGETS.monthly },
    });
    setEditingBudgets(false);
  };

  const handleRefreshQuotas = async () => {
    if (!onRefreshProviderQuotas || refreshingQuotas) return;
    setRefreshingQuotas(true);
    try {
      await onRefreshProviderQuotas();
    } finally {
      setRefreshingQuotas(false);
    }
  };

  return (
    <div data-testid="usage-panel" className="space-y-5">
      {/* Period Summary Strip (Today / This Week / This Month / All Time) */}
      <div className="space-y-2">
        <div
          role="group"
          aria-label={t(locale, "usage.periodAria")}
          data-testid="usage-period-summary-grid"
          className="grid grid-cols-2 sm:grid-cols-4 gap-2.5"
        >
          {PERIOD_IDS.map((pid) => {
            const active = period === pid;
            const pSum = allPeriods[pid];
            return (
              <button
                key={pid}
                type="button"
                data-testid={`usage-period-${pid}`}
                aria-pressed={active}
                onClick={() => setPeriod(pid)}
                className={`text-left p-3 rounded-xl border transition-all cursor-pointer space-y-1 ${
                  active
                    ? "bg-indigo-500/10 border-indigo-500/60 ring-1 ring-indigo-500/30"
                    : "bg-zinc-50/70 dark:bg-zinc-900/50 border-zinc-200/80 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700"
                }`}
              >
                <div className="flex items-center justify-between gap-1">
                  <span
                    className={`text-[11px] font-semibold ${
                      active
                        ? "text-indigo-700 dark:text-indigo-300"
                        : "text-zinc-500 dark:text-zinc-400"
                    }`}
                  >
                    {getPeriodLabel(pid, locale)}
                  </span>
                  <span className="text-[10px] text-zinc-400 tabular-nums">
                    {t(locale, "usage.requestsCount", {
                      count: pSum.turnCount.toLocaleString(),
                    })}
                  </span>
                </div>
                <div className="text-[16px] font-bold tracking-tight tabular-nums text-zinc-900 dark:text-zinc-100">
                  {formatUsdCost(pSum.costUsd, { estimated: pSum.hasEstimatedCost })}
                </div>
                <div className="text-[10.5px] text-zinc-500 dark:text-zinc-400 tabular-nums">
                  {formatTokenCount(pSum.totalTokens)} tokens
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Weekly & Monthly Consumption Gauges (Configurable Budget / Quota Limits) */}
      <section data-testid="usage-budget-section" className="space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-[12px] font-semibold text-zinc-800 dark:text-zinc-200 flex items-center gap-1.5">
            <Gauge className="w-3.5 h-3.5 text-indigo-500" />
            <span>{t(locale, "usage.quotaSectionTitle")}</span>
          </h4>
          {onUpdateBudgets && (
            <button
              type="button"
              data-testid="usage-budget-edit-btn"
              onClick={() => {
                setBudgetValidationError(null);
                setEditingBudgets((v) => !v);
              }}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:border-indigo-500/50 cursor-pointer"
            >
              <Pencil className="w-3 h-3" />
              <span>{t(locale, "usage.editLimitsBtn")}</span>
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <BudgetGaugeCard
            testId="usage-gauge-weekly"
            label={t(locale, "usage.weeklyLimitLabel")}
            resetHint={t(locale, "usage.weeklyResetHint")}
            status={weeklyStatus}
            hasEstimatedCost={allPeriods.week.hasEstimatedCost}
            locale={locale}
          />
          <BudgetGaugeCard
            testId="usage-gauge-monthly"
            label={t(locale, "usage.monthlyLimitLabel")}
            resetHint={t(locale, "usage.monthlyResetHint")}
            status={monthlyStatus}
            hasEstimatedCost={allPeriods.month.hasEstimatedCost}
            locale={locale}
          />
        </div>

        {/* Inline Limit Editor */}
        {editingBudgets && (
          <div
            data-testid="usage-budget-editor"
            className="p-3.5 rounded-xl bg-zinc-50 dark:bg-zinc-900/70 border border-indigo-500/35 space-y-3"
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Weekly Limit Input */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label
                    htmlFor="usage-budget-weekly-input"
                    className="text-[11px] font-semibold text-zinc-700 dark:text-zinc-300"
                  >
                    {t(locale, "usage.weeklyLimitLabel")}
                  </label>
                  <div className="inline-flex rounded-md bg-zinc-200/70 dark:bg-zinc-800 p-0.5 text-[10px]">
                    <button
                      type="button"
                      data-testid="usage-budget-weekly-unit-usd"
                      onClick={() => handleToggleUnit("weekly", "usd")}
                      className={`px-1.5 py-0.5 rounded font-medium cursor-pointer ${
                        weeklyUnitDraft === "usd"
                          ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-xs"
                          : "text-zinc-500 dark:text-zinc-400"
                      }`}
                    >
                      {t(locale, "usage.unitUsd")}
                    </button>
                    <button
                      type="button"
                      data-testid="usage-budget-weekly-unit-tokens"
                      onClick={() => handleToggleUnit("weekly", "tokens")}
                      className={`px-1.5 py-0.5 rounded font-medium cursor-pointer ${
                        weeklyUnitDraft === "tokens"
                          ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-xs"
                          : "text-zinc-500 dark:text-zinc-400"
                      }`}
                    >
                      {t(locale, "usage.unitTokens")}
                    </button>
                  </div>
                </div>
                <input
                  id="usage-budget-weekly-input"
                  data-testid="usage-budget-weekly-input"
                  type="number"
                  min={weeklyUnitDraft === "tokens" ? 1 : 0.01}
                  step={weeklyUnitDraft === "tokens" ? 100000 : 1}
                  value={weeklyLimitDraft}
                  placeholder={
                    weeklyUnitDraft === "tokens"
                      ? t(locale, "usage.limitInputPlaceholderTokens")
                      : t(locale, "usage.limitInputPlaceholderUsd")
                  }
                  onChange={(e) => {
                    setWeeklyLimitDraft(e.target.value);
                    setBudgetValidationError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveBudgets();
                  }}
                  className="w-full px-2.5 py-1.5 rounded-lg text-[12px] font-mono bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-700 outline-none focus:border-indigo-500/60"
                />
              </div>

              {/* Monthly Limit Input */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label
                    htmlFor="usage-budget-monthly-input"
                    className="text-[11px] font-semibold text-zinc-700 dark:text-zinc-300"
                  >
                    {t(locale, "usage.monthlyLimitLabel")}
                  </label>
                  <div className="inline-flex rounded-md bg-zinc-200/70 dark:bg-zinc-800 p-0.5 text-[10px]">
                    <button
                      type="button"
                      data-testid="usage-budget-monthly-unit-usd"
                      onClick={() => handleToggleUnit("monthly", "usd")}
                      className={`px-1.5 py-0.5 rounded font-medium cursor-pointer ${
                        monthlyUnitDraft === "usd"
                          ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-xs"
                          : "text-zinc-500 dark:text-zinc-400"
                      }`}
                    >
                      {t(locale, "usage.unitUsd")}
                    </button>
                    <button
                      type="button"
                      data-testid="usage-budget-monthly-unit-tokens"
                      onClick={() => handleToggleUnit("monthly", "tokens")}
                      className={`px-1.5 py-0.5 rounded font-medium cursor-pointer ${
                        monthlyUnitDraft === "tokens"
                          ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-xs"
                          : "text-zinc-500 dark:text-zinc-400"
                      }`}
                    >
                      {t(locale, "usage.unitTokens")}
                    </button>
                  </div>
                </div>
                <input
                  id="usage-budget-monthly-input"
                  data-testid="usage-budget-monthly-input"
                  type="number"
                  min={monthlyUnitDraft === "tokens" ? 1 : 0.01}
                  step={monthlyUnitDraft === "tokens" ? 500000 : 5}
                  value={monthlyLimitDraft}
                  placeholder={
                    monthlyUnitDraft === "tokens"
                      ? t(locale, "usage.limitInputPlaceholderTokens")
                      : t(locale, "usage.limitInputPlaceholderUsd")
                  }
                  onChange={(e) => {
                    setMonthlyLimitDraft(e.target.value);
                    setBudgetValidationError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveBudgets();
                  }}
                  className="w-full px-2.5 py-1.5 rounded-lg text-[12px] font-mono bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-700 outline-none focus:border-indigo-500/60"
                />
              </div>
            </div>

            {budgetValidationError && (
              <div className="text-[11px] text-rose-600 dark:text-rose-400 font-medium">
                {budgetValidationError}
              </div>
            )}

            <div className="flex items-center justify-between gap-2 pt-0.5">
              <button
                type="button"
                data-testid="usage-budget-reset-defaults-btn"
                onClick={handleResetDefaultBudgets}
                className="text-[11px] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 underline cursor-pointer"
              >
                {t(locale, "usage.resetDefaultsBtn")}
              </button>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setBudgetValidationError(null);
                    setEditingBudgets(false);
                  }}
                  className="px-2.5 py-1 rounded-lg text-[11.5px] font-medium bg-zinc-200/80 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-300/80 dark:hover:bg-zinc-700 cursor-pointer"
                >
                  {t(locale, "common.cancel")}
                </button>
                <button
                  type="button"
                  data-testid="usage-budget-save-btn"
                  onClick={handleSaveBudgets}
                  className="px-3 py-1 rounded-lg text-[11.5px] font-medium bg-indigo-500 text-white hover:bg-indigo-600 cursor-pointer"
                >
                  {t(locale, "usage.saveLimitsBtn")}
                </button>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Official Provider Quotas / Rate Limits (Codex live RPC & Claude rate_limit_event) */}
      {(liveProviderQuotas.length > 0 || onRefreshProviderQuotas) && (
        <section data-testid="usage-provider-quotas" className="space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-[12px] font-semibold text-zinc-800 dark:text-zinc-200 flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
              <span>{t(locale, "usage.providerQuotasTitle")}</span>
            </h4>
            {onRefreshProviderQuotas && (
              <button
                type="button"
                data-testid="usage-refresh-quotas-btn"
                disabled={refreshingQuotas}
                onClick={() => void handleRefreshQuotas()}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200/70 dark:hover:bg-zinc-800 disabled:opacity-50 cursor-pointer"
              >
                <RefreshCw className={`w-3 h-3 ${refreshingQuotas ? "animate-spin" : ""}`} />
                <span>
                  {refreshingQuotas
                    ? t(locale, "usage.refreshingQuotas")
                    : t(locale, "usage.refreshQuotasBtn")}
                </span>
              </button>
            )}
          </div>

          {liveProviderQuotas.length > 0 && (
            <div className="space-y-2.5">
              {liveProviderQuotas.map((quota) => (
                <div
                  key={quota.provider}
                  data-testid={`usage-provider-quota-${quota.provider}`}
                  className="p-3.5 rounded-xl bg-zinc-50/80 dark:bg-zinc-900/60 border border-zinc-200/80 dark:border-zinc-800 space-y-2.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10.5px] font-semibold ${
                          PROVIDER_BADGE_STYLES[quota.provider]
                        }`}
                      >
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${PROVIDER_DOT_COLORS[quota.provider]}`}
                        />
                        {PROVIDER_LABELS[quota.provider]}
                      </span>
                      {quota.planType && (
                        <span className="px-1.5 py-0.5 rounded bg-zinc-200/80 dark:bg-zinc-800 text-[10px] font-semibold uppercase text-zinc-600 dark:text-zinc-300">
                          {quota.planType}
                        </span>
                      )}
                    </div>
                    {quota.credits && (quota.credits.unlimited || quota.credits.hasCredits) && (
                      <span className="text-[10.5px] text-zinc-500 dark:text-zinc-400 tabular-nums">
                        {quota.credits.unlimited
                          ? t(locale, "usage.creditsUnlimited")
                          : quota.credits.balance
                            ? t(locale, "usage.creditsBalance", {
                                balance: Number.isFinite(Number(quota.credits.balance))
                                  ? Math.round(Number(quota.credits.balance)).toLocaleString()
                                  : quota.credits.balance,
                              })
                            : null}
                      </span>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {quota.windows.map((win) => {
                      const severity = classifyQuotaSeverity(win.usedPercent);
                      const resetText = formatResetDateTime(win.resetsAt, locale);
                      return (
                        <div key={win.id} className="space-y-1.5">
                          <div className="flex items-center justify-between gap-2 text-[11px]">
                            <span className="font-medium text-zinc-700 dark:text-zinc-300">
                              {formatQuotaWindowLabel(win, locale)}
                            </span>
                            <span
                              className={`font-semibold tabular-nums ${SEVERITY_TEXT_CLASSES[severity]}`}
                            >
                              {t(locale, "usage.usedPercent", {
                                pct: formatUsagePercent(win.usedPercent),
                              })}
                            </span>
                          </div>
                          <div className="h-2 w-full rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
                            <div
                              className={`h-full rounded-full ${SEVERITY_BAR_CLASSES[severity]}`}
                              style={{
                                width: `${Math.min(100, Math.max(0, win.usedPercent))}%`,
                              }}
                            />
                          </div>
                          <div className="flex items-center justify-between gap-2 text-[10.5px] text-zinc-500 dark:text-zinc-400 tabular-nums">
                            <span>
                              {t(locale, "usage.remainingPercent", {
                                pct: formatUsagePercent(win.remainingPercent),
                              })}
                            </span>
                            {resetText && (
                              <span>{t(locale, "usage.resetsAt", { time: resetText })}</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          <p className="text-[10.5px] text-zinc-400 leading-relaxed">
            {t(locale, "usage.providerQuotaFallbackNote")}
          </p>
        </section>
      )}

      {/* Recent Daily / Weekly Usage Trend Chart */}
      <section data-testid="usage-trend-section" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-[12px] font-semibold text-zinc-800 dark:text-zinc-200 flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5 text-indigo-500" />
            <span>{t(locale, "usage.trendTitle")}</span>
          </h4>
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="inline-flex items-center p-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200/80 dark:border-zinc-800 text-[10.5px]">
              <button
                type="button"
                data-testid="usage-trend-daily"
                aria-pressed={trendGranularity === "daily"}
                onClick={() => setTrendGranularity("daily")}
                className={`px-2 py-0.5 rounded-md font-medium cursor-pointer transition-colors ${
                  trendGranularity === "daily"
                    ? "bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-xs"
                    : "text-zinc-500 dark:text-zinc-400"
                }`}
              >
                {t(locale, "usage.trendDaily")}
              </button>
              <button
                type="button"
                data-testid="usage-trend-weekly"
                aria-pressed={trendGranularity === "weekly"}
                onClick={() => setTrendGranularity("weekly")}
                className={`px-2 py-0.5 rounded-md font-medium cursor-pointer transition-colors ${
                  trendGranularity === "weekly"
                    ? "bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-xs"
                    : "text-zinc-500 dark:text-zinc-400"
                }`}
              >
                {t(locale, "usage.trendWeekly")}
              </button>
            </div>

            <div className="inline-flex items-center p-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200/80 dark:border-zinc-800 text-[10.5px]">
              <button
                type="button"
                data-testid="usage-trend-metric-cost"
                aria-pressed={trendMetric === "cost"}
                onClick={() => setTrendMetric("cost")}
                className={`px-2 py-0.5 rounded-md font-medium cursor-pointer transition-colors ${
                  trendMetric === "cost"
                    ? "bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-xs"
                    : "text-zinc-500 dark:text-zinc-400"
                }`}
              >
                {t(locale, "usage.trendMetricCost")}
              </button>
              <button
                type="button"
                data-testid="usage-trend-metric-tokens"
                aria-pressed={trendMetric === "tokens"}
                onClick={() => setTrendMetric("tokens")}
                className={`px-2 py-0.5 rounded-md font-medium cursor-pointer transition-colors ${
                  trendMetric === "tokens"
                    ? "bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-xs"
                    : "text-zinc-500 dark:text-zinc-400"
                }`}
              >
                {t(locale, "usage.trendMetricTokens")}
              </button>
            </div>
          </div>
        </div>

        <div
          data-testid="usage-trend-chart"
          className="p-3.5 rounded-xl bg-zinc-50/80 dark:bg-zinc-900/60 border border-zinc-200/80 dark:border-zinc-800 space-y-2.5"
        >
          <div className="flex items-center justify-between gap-2 text-[10.5px] text-zinc-500 dark:text-zinc-400">
            <div className="flex items-center gap-3">
              {(["codex", "agy", "claude"] as const).map((p) => (
                <span key={p} className="inline-flex items-center gap-1">
                  <span className={`w-2 h-2 rounded-full ${PROVIDER_DOT_COLORS[p]}`} />
                  <span>{PROVIDER_LABELS[p]}</span>
                </span>
              ))}
            </div>
            {maxTrendValue > 0 && (
              <span className="tabular-nums">
                {t(locale, "usage.trendMaxLabel", {
                  value:
                    trendMetric === "cost"
                      ? formatUsdCost(maxTrendValue, { compact: true })
                      : formatTokenCount(maxTrendValue),
                })}
              </span>
            )}
          </div>

          {maxTrendValue === 0 ? (
            <div className="h-24 flex items-center justify-center text-[11.5px] text-zinc-400">
              {t(locale, "usage.trendEmpty")}
            </div>
          ) : (
            <div className="flex items-end gap-1.5 h-28 pt-2">
              {trendBuckets.map((bucket) => {
                const value = trendMetric === "cost" ? bucket.costUsd : bucket.totalTokens;
                const totalHeightPct = maxTrendValue > 0 ? (value / maxTrendValue) * 100 : 0;
                const barHeightPct = value > 0 ? Math.max(6, totalHeightPct) : 0;
                const providerValues =
                  trendMetric === "cost" ? bucket.byProviderCostUsd : bucket.byProviderTokens;
                const denomBucket = Math.max(1e-9, value);
                const rangeLabel =
                  bucket.startDateKey === bucket.endDateKey
                    ? bucket.startDateKey
                    : `${bucket.startDateKey} – ${bucket.endDateKey}`;
                const tooltip = `${rangeLabel}: ${formatUsdCost(bucket.costUsd)} · ${formatTokenCount(bucket.totalTokens)} tokens · ${t(locale, "usage.requestsCount", { count: bucket.turnCount })}`;

                return (
                  <div
                    key={bucket.key}
                    data-testid={`usage-trend-bar-${bucket.key}`}
                    title={tooltip}
                    className="flex-1 min-w-0 h-full flex flex-col items-center justify-end gap-1"
                  >
                    <div className="w-full flex-1 flex items-end justify-center">
                      {value > 0 ? (
                        <div
                          className="w-full max-w-[26px] rounded-t-md overflow-hidden flex flex-col-reverse bg-zinc-200/70 dark:bg-zinc-800"
                          style={{ height: `${barHeightPct}%` }}
                        >
                          {(["codex", "agy", "claude"] as const).map((p) => {
                            const pv = providerValues[p];
                            if (pv <= 0) return null;
                            return (
                              <div
                                key={p}
                                className={`w-full ${PROVIDER_DOT_COLORS[p]}`}
                                style={{ height: `${(pv / denomBucket) * 100}%` }}
                              />
                            );
                          })}
                        </div>
                      ) : (
                        <div className="w-full max-w-[26px] h-[2px] rounded-full bg-zinc-200/70 dark:bg-zinc-800/80" />
                      )}
                    </div>
                    <span
                      className={`text-[9.5px] tabular-nums truncate max-w-full ${
                        bucket.isCurrent
                          ? "font-semibold text-indigo-600 dark:text-indigo-400"
                          : "text-zinc-400"
                      }`}
                    >
                      {bucket.label}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* Active Period Detail Header & KPI Cards */}
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-[12px] font-semibold text-zinc-800 dark:text-zinc-200">
            {getPeriodLabel(period, locale)}
          </h4>
          <span className="text-[11.5px] text-zinc-500 dark:text-zinc-400 tabular-nums">
            {t(locale, "usage.turnsRecorded", { count: summary.turnCount.toLocaleString() })}
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {/* Card 1: Total Tokens */}
          <div
            data-testid="usage-total-tokens"
            className="p-3.5 rounded-xl bg-zinc-50/80 dark:bg-zinc-900/60 border border-zinc-200/80 dark:border-zinc-800 space-y-1"
          >
            <div className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400 flex items-center gap-1.5">
              <BarChart3 className="w-3.5 h-3.5 text-indigo-500" />
              <span>{t(locale, "usage.totalTokens")}</span>
            </div>
            <div
              className="text-[22px] font-bold tracking-tight tabular-nums text-zinc-900 dark:text-zinc-100"
              title={`${summary.totalTokens.toLocaleString()} tokens`}
            >
              {formatTokenCount(summary.totalTokens)}
            </div>
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400 tabular-nums">
              {summary.totalTokens > 0
                ? `${summary.totalTokens.toLocaleString()} tokens`
                : t(locale, "usage.noRecordsYet")}
            </div>
          </div>

          {/* Card 2: Input / Cached / Output Breakdown */}
          <div
            data-testid="usage-token-breakdown"
            className="p-3.5 rounded-xl bg-zinc-50/80 dark:bg-zinc-900/60 border border-zinc-200/80 dark:border-zinc-800 space-y-2"
          >
            <div className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
              {t(locale, "usage.tokenBreakdown")}
            </div>
            <div className="h-1.5 w-full rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden flex">
              {summary.totalTokens > 0 && (
                <>
                  <div className="bg-indigo-500 h-full" style={{ width: `${inputPct}%` }} />
                  <div className="bg-emerald-500 h-full" style={{ width: `${cachedPct}%` }} />
                  <div className="bg-amber-500 h-full" style={{ width: `${outputPct}%` }} />
                </>
              )}
            </div>
            <div className="grid grid-cols-3 gap-1 text-[11px] tabular-nums">
              <div>
                <div className="text-[10px] text-zinc-400 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
                  {t(locale, "usage.inputLabel")}
                </div>
                <div
                  className="font-semibold text-zinc-800 dark:text-zinc-200"
                  title={
                    summary.cacheCreationInputTokens > 0
                      ? t(locale, "usage.inputWithCacheCreateTitle", {
                          input: summary.inputTokens.toLocaleString(),
                          cacheCreate: summary.cacheCreationInputTokens.toLocaleString(),
                        })
                      : `${summary.inputTokens.toLocaleString()} tokens`
                  }
                >
                  {formatTokenCount(totalInputWithCreate)}
                </div>
              </div>
              <div>
                <div className="text-[10px] text-zinc-400 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  {t(locale, "usage.cachedLabel")}
                </div>
                <div className="font-semibold text-zinc-800 dark:text-zinc-200">
                  {formatTokenCount(summary.cachedInputTokens)}
                </div>
              </div>
              <div>
                <div className="text-[10px] text-zinc-400 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                  {t(locale, "usage.outputLabel")}
                </div>
                <div
                  className="font-semibold text-zinc-800 dark:text-zinc-200"
                  title={
                    summary.reasoningTokens > 0
                      ? t(locale, "usage.outputWithReasoningTitle", {
                          reasoning: summary.reasoningTokens.toLocaleString(),
                        })
                      : `${summary.outputTokens.toLocaleString()} tokens`
                  }
                >
                  {formatTokenCount(summary.outputTokens)}
                </div>
              </div>
            </div>
          </div>

          {/* Card 3: Estimated API Cost (USD) */}
          <div
            data-testid="usage-total-cost"
            className="p-3.5 rounded-xl bg-zinc-50/80 dark:bg-zinc-900/60 border border-zinc-200/80 dark:border-zinc-800 space-y-1"
          >
            <div className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400 flex items-center justify-between gap-1.5">
              <span className="flex items-center gap-1.5">
                <Coins className="w-3.5 h-3.5 text-amber-500" />
                <span>{t(locale, "usage.estimatedCostTitle")}</span>
              </span>
              <CostTag
                hasEstimated={summary.hasEstimatedCost}
                hasExact={summary.hasExactCost}
                locale={locale}
              />
            </div>
            <div className="text-[22px] font-bold tracking-tight tabular-nums text-zinc-900 dark:text-zinc-100">
              {formatUsdCost(summary.costUsd, { estimated: summary.hasEstimatedCost })}
            </div>
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400 tabular-nums">
              {summary.costMode === "mixed"
                ? t(locale, "usage.costDetailMixed", {
                    exact: formatUsdCost(summary.exactCostUsd),
                    estimated: formatUsdCost(summary.estimatedCostUsd, { estimated: true }),
                  })
                : summary.costMode === "exact"
                  ? t(locale, "usage.costDetailExact")
                  : summary.costMode === "estimated"
                    ? t(locale, "usage.costDetailEstimated")
                    : t(locale, "usage.costDetailNone")}
            </div>
          </div>
        </div>
      </div>

      {/* Breakdown Tables or Empty State */}
      {summary.turnCount === 0 ? (
        <div
          data-testid="usage-empty-state"
          className="rounded-xl border border-dashed border-zinc-200 dark:border-zinc-800 p-6 text-center space-y-1"
        >
          <p className="text-[12.5px] font-medium text-zinc-600 dark:text-zinc-300">
            {t(locale, "usage.emptyTitle")}
          </p>
          <p className="text-[11.5px] text-zinc-400">{t(locale, "usage.emptyDesc")}</p>
        </div>
      ) : (
        <div className="space-y-4">
          <BreakdownTable
            testId="usage-table-provider"
            title={t(locale, "usage.tableProvider")}
            icon={<Layers className="w-3.5 h-3.5 text-indigo-500" />}
            rows={summary.byProvider}
            totalCostUsd={summary.costUsd}
            totalTokens={summary.totalTokens}
            locale={locale}
            showDetailedTokens={true}
          />
          <BreakdownTable
            testId="usage-table-model"
            title={t(locale, "usage.tableModel")}
            icon={<Cpu className="w-3.5 h-3.5 text-emerald-500" />}
            rows={summary.byModel}
            totalCostUsd={summary.costUsd}
            totalTokens={summary.totalTokens}
            locale={locale}
            showProviderBadge={true}
          />
          <BreakdownTable
            testId="usage-table-project"
            title={t(locale, "usage.tableProject")}
            icon={<FolderKanban className="w-3.5 h-3.5 text-amber-500" />}
            rows={summary.byProject}
            totalCostUsd={summary.costUsd}
            totalTokens={summary.totalTokens}
            locale={locale}
          />
        </div>
      )}

      {/* Subscription / CLI Note & Reset Action */}
      <div className="rounded-xl bg-zinc-50/80 dark:bg-zinc-900/50 border border-zinc-200/80 dark:border-zinc-800 p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-start gap-2 text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
          <Info className="w-3.5 h-3.5 text-indigo-500 shrink-0 mt-0.5" />
          <p>
            {t(locale, "usage.subscriptionNoteBeforeCode")}
            <code className="font-mono text-[10.5px]">total_cost_usd</code>
            {t(locale, "usage.subscriptionNoteAfterCode")}
          </p>
        </div>

        {onClearUsage && (
          <div className="flex items-center gap-1.5 shrink-0 self-end sm:self-center">
            {confirmingReset ? (
              <>
                <button
                  type="button"
                  data-testid="usage-reset-confirm-btn"
                  onClick={() => {
                    onClearUsage();
                    setConfirmingReset(false);
                  }}
                  className="px-2.5 py-1 rounded-lg text-[11.5px] font-medium bg-rose-500 text-white hover:bg-rose-600 transition-colors cursor-pointer"
                >
                  {t(locale, "usage.resetConfirmBtn")}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingReset(false)}
                  className="px-2.5 py-1 rounded-lg text-[11.5px] font-medium bg-zinc-200/80 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-300/80 dark:hover:bg-zinc-700 transition-colors cursor-pointer"
                >
                  {t(locale, "common.cancel")}
                </button>
              </>
            ) : (
              <button
                type="button"
                data-testid="usage-reset-btn"
                disabled={usageRecords.length === 0}
                onClick={() => setConfirmingReset(true)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11.5px] font-medium border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:text-rose-600 dark:hover:text-rose-400 hover:border-rose-300 dark:hover:border-rose-500/40 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" />
                <span>{t(locale, "usage.resetBtn")}</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
