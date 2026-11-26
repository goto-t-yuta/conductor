import React, { useMemo, useState } from "react";
import { BarChart3, Coins, Cpu, FolderKanban, Info, Layers, RotateCcw } from "lucide-react";
import type { AgentProvider, UsagePeriod, UsageRecord } from "../../shared/types.js";
import {
  formatTokenCount,
  formatUsdCost,
  summarizeUsage,
  type UsageBreakdownRow,
} from "../../shared/usage.js";

export interface UsagePanelProps {
  usageRecords: UsageRecord[];
  onClearUsage?: () => void;
  initialPeriod?: UsagePeriod;
  now?: Date;
}

const PERIOD_OPTIONS: ReadonlyArray<{ id: UsagePeriod; label: string }> = [
  { id: "today", label: "今日" },
  { id: "month", label: "今月" },
  { id: "all", label: "累計" },
];

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

function CostTag({ hasEstimated, hasExact }: { hasEstimated: boolean; hasExact: boolean }) {
  if (!hasEstimated && !hasExact) return null;
  if (hasExact && !hasEstimated) {
    return (
      <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-500/12 text-emerald-700 dark:text-emerald-300">
        実測
      </span>
    );
  }
  if (hasExact && hasEstimated) {
    return (
      <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-500/12 text-indigo-700 dark:text-indigo-300">
        実測+推定
      </span>
    );
  }
  return (
    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/12 text-amber-700 dark:text-amber-300">
      API換算推定
    </span>
  );
}

interface BreakdownTableProps {
  testId: string;
  title: string;
  icon: React.ReactNode;
  rows: UsageBreakdownRow[];
  showProviderBadge?: boolean;
  showDetailedTokens?: boolean;
}

const BreakdownTable: React.FC<BreakdownTableProps> = ({
  testId,
  title,
  icon,
  rows,
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
            <th className="text-left font-medium px-3 py-1.5">対象</th>
            <th className="text-right font-medium px-2 py-1.5 w-14">回数</th>
            {showDetailedTokens && (
              <th className="text-right font-medium px-2 py-1.5 hidden sm:table-cell">
                入力 / キャッシュ / 出力
              </th>
            )}
            <th className="text-right font-medium px-2 py-1.5 w-20">合計</th>
            <th className="text-right font-medium px-3 py-1.5 w-24">利用料 (USD)</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-200/70 dark:divide-zinc-800/70">
          {rows.map((row) => {
            const totalInput = row.inputTokens + row.cacheCreationInputTokens;
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
                        <span className={`w-1.5 h-1.5 rounded-full ${PROVIDER_DOT_COLORS[row.provider]}`} />
                        {row.provider === "codex"
                          ? "Codex"
                          : row.provider === "agy"
                            ? "AGY"
                            : "Claude"}
                      </span>
                    )}
                    {!showProviderBadge && row.provider && (
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 ${PROVIDER_DOT_COLORS[row.provider]}`}
                      />
                    )}
                    <span className="truncate" title={row.label}>
                      {row.label}
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
  onClearUsage,
  initialPeriod = "today",
  now,
}) => {
  const [period, setPeriod] = useState<UsagePeriod>(initialPeriod);
  const [confirmingReset, setConfirmingReset] = useState(false);

  const summary = useMemo(
    () => summarizeUsage(usageRecords, period, now),
    [usageRecords, period, now],
  );

  const totalInputWithCreate = summary.inputTokens + summary.cacheCreationInputTokens;
  const denom = Math.max(1, summary.totalTokens);
  const inputPct = Math.round((totalInputWithCreate / denom) * 100);
  const cachedPct = Math.round((summary.cachedInputTokens / denom) * 100);
  const outputPct = Math.max(0, 100 - inputPct - cachedPct);

  return (
    <div data-testid="usage-panel" className="space-y-5">
      {/* Period Selector */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          role="group"
          aria-label="集計期間"
          className="inline-flex items-center p-0.5 rounded-xl bg-zinc-100 dark:bg-zinc-900 border border-zinc-200/80 dark:border-zinc-800"
        >
          {PERIOD_OPTIONS.map((opt) => {
            const active = period === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                data-testid={`usage-period-${opt.id}`}
                aria-pressed={active}
                onClick={() => setPeriod(opt.id)}
                className={`px-3 py-1 rounded-lg text-[12px] font-medium transition-colors cursor-pointer ${
                  active
                    ? "bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-xs"
                    : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200"
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>

        <span className="text-[11.5px] text-zinc-500 dark:text-zinc-400 tabular-nums">
          {summary.turnCount.toLocaleString()} ターン記録済み
        </span>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* Card 1: Total Tokens */}
        <div
          data-testid="usage-total-tokens"
          className="p-3.5 rounded-xl bg-zinc-50/80 dark:bg-zinc-900/60 border border-zinc-200/80 dark:border-zinc-800 space-y-1"
        >
          <div className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400 flex items-center gap-1.5">
            <BarChart3 className="w-3.5 h-3.5 text-indigo-500" />
            <span>合計トークン</span>
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
              : "まだ記録がありません"}
          </div>
        </div>

        {/* Card 2: Input / Cached / Output Breakdown */}
        <div
          data-testid="usage-token-breakdown"
          className="p-3.5 rounded-xl bg-zinc-50/80 dark:bg-zinc-900/60 border border-zinc-200/80 dark:border-zinc-800 space-y-2"
        >
          <div className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
            入力 / キャッシュ / 出力
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
                入力
              </div>
              <div
                className="font-semibold text-zinc-800 dark:text-zinc-200"
                title={
                  summary.cacheCreationInputTokens > 0
                    ? `通常入力 ${summary.inputTokens.toLocaleString()} + キャッシュ書込 ${summary.cacheCreationInputTokens.toLocaleString()}`
                    : `${summary.inputTokens.toLocaleString()} tokens`
                }
              >
                {formatTokenCount(totalInputWithCreate)}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-zinc-400 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                キャッシュ
              </div>
              <div className="font-semibold text-zinc-800 dark:text-zinc-200">
                {formatTokenCount(summary.cachedInputTokens)}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-zinc-400 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                出力
              </div>
              <div
                className="font-semibold text-zinc-800 dark:text-zinc-200"
                title={
                  summary.reasoningTokens > 0
                    ? `推論トークン含む: ${summary.reasoningTokens.toLocaleString()}`
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
              <span>推定API利用料</span>
            </span>
            <CostTag
              hasEstimated={summary.hasEstimatedCost}
              hasExact={summary.hasExactCost}
            />
          </div>
          <div className="text-[22px] font-bold tracking-tight tabular-nums text-zinc-900 dark:text-zinc-100">
            {formatUsdCost(summary.costUsd, { estimated: summary.hasEstimatedCost })}
          </div>
          <div className="text-[11px] text-zinc-500 dark:text-zinc-400 tabular-nums">
            {summary.costMode === "mixed"
              ? `実測 ${formatUsdCost(summary.exactCostUsd)} / 推定 ${formatUsdCost(summary.estimatedCostUsd, { estimated: true })}`
              : summary.costMode === "exact"
                ? "CLI 実測値 (USD)"
                : summary.costMode === "estimated"
                  ? "API 従量課金換算 (USD)"
                  : "USD 換算"}
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
            この期間のトークン使用履歴はありません
          </p>
          <p className="text-[11.5px] text-zinc-400">
            チャット応答やプロジェクトワーカーが完了すると、プロバイダー・モデル・プロジェクト別に自動集計されます。
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <BreakdownTable
            testId="usage-table-provider"
            title="プロバイダー別"
            icon={<Layers className="w-3.5 h-3.5 text-indigo-500" />}
            rows={summary.byProvider}
            showDetailedTokens={true}
          />
          <BreakdownTable
            testId="usage-table-model"
            title="モデル別"
            icon={<Cpu className="w-3.5 h-3.5 text-emerald-500" />}
            rows={summary.byModel}
            showProviderBadge={true}
          />
          <BreakdownTable
            testId="usage-table-project"
            title="プロジェクト別"
            icon={<FolderKanban className="w-3.5 h-3.5 text-amber-500" />}
            rows={summary.byProject}
          />
        </div>
      )}

      {/* Subscription / CLI Note & Reset Action */}
      <div className="rounded-xl bg-zinc-50/80 dark:bg-zinc-900/50 border border-zinc-200/80 dark:border-zinc-800 p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-start gap-2 text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
          <Info className="w-3.5 h-3.5 text-indigo-500 shrink-0 mt-0.5" />
          <p>
            Codex / AGY / Claude のサブスクリプション・CLI プランでは、消費トークン数と API 従量課金相当の推定金額を表示します（Claude CLI が <code className="font-mono text-[10.5px]">total_cost_usd</code> を返したターンは実測値を使用します）。
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
                  リセット実行
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingReset(false)}
                  className="px-2.5 py-1 rounded-lg text-[11.5px] font-medium bg-zinc-200/80 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-300/80 dark:hover:bg-zinc-700 transition-colors cursor-pointer"
                >
                  キャンセル
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
                <span>履歴をリセット</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
