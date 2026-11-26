import { t, type UiLocale } from "../../shared/i18n.js";
import type { ToolActivityChip, WorkerActivityEntry } from "../../shared/types.js";

export const DEFAULT_TOOL_CHIP_COLLAPSE_THRESHOLD = 2;
export const DEFAULT_MAX_BREAKDOWN_ITEMS = 4;

export interface ToolCallCount {
  name: string;
  count: number;
}

export interface PartitionedTaskActivities {
  /** High-signal entries (error, message, important system, file) in reverse-chronological order (newest first). */
  highSignal: WorkerActivityEntry[];
  /** Routine tool-call entries (command, reasoning, system_message) in chronological order (oldest first). */
  toolActivities: WorkerActivityEntry[];
  /** Aggregated counts of routine tool calls, sorted by descending count (ties keep first-seen order). */
  toolCounts: ToolCallCount[];
  /** Routine tool execution logs start collapsed by default. */
  defaultToolLogCollapsed: boolean;
}

export interface ToolChipDisplayPlan {
  /** Whether the collapsible summary pill should start collapsed by default. */
  shouldCollapseByDefault: boolean;
  /** Chips always shown inline (e.g., running chips while streaming, or all chips when below threshold). */
  visibleChips: ToolActivityChip[];
  /** Chips grouped inside the expandable summary pill. */
  collapsibleChips: ToolActivityChip[];
  /** Aggregated counts of collapsibleChips, sorted by descending count. */
  toolCounts: ToolCallCount[];
  /** Number of error chips inside collapsibleChips. */
  errorCount: number;
}

function stripToolNamePrefix(raw: string): string {
  return raw
    .trim()
    .replace(/^default_api:/, "")
    .replace(/^mcp_+conductor_+/, "");
}

/**
 * Normalizes a WorkerActivityEntry title into a concise, groupable tool name.
 * - Shell commands starting with "$ " (Codex commandExecution) group under "run_command".
 * - Strips known tool namespaces ("default_api:", "mcp__conductor__").
 * - Truncates unusually long freeform titles for compact summary badges.
 */
export function normalizeActivityToolName(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) return "tool";
  if (trimmed.startsWith("$ ")) {
    return "run_command";
  }
  const cleaned = stripToolNamePrefix(trimmed);
  if (!cleaned) return "tool";
  return cleaned.length > 32 ? `${cleaned.slice(0, 31)}…` : cleaned;
}

/**
 * Normalizes a chat ToolActivityChip into a groupable tool name.
 */
export function normalizeToolChipName(chip: Pick<ToolActivityChip, "toolName" | "label">): string {
  if (chip.toolName && chip.toolName.trim()) {
    const cleaned = stripToolNamePrefix(chip.toolName);
    switch (cleaned) {
      case "commandExecution":
        return "run_command";
      case "fileChange":
        return "file_change";
      case "webSearch":
        return "web_search";
      default:
        return cleaned.length > 32 ? `${cleaned.slice(0, 31)}…` : cleaned;
    }
  }
  return normalizeActivityToolName(chip.label);
}

/**
 * Classifies whether a task activity entry is a routine tool-call log that should be
 * grouped and collapsed by default, versus a high-signal event (error, message/report,
 * important system event, or file change summary) that stays immediately visible.
 */
export function isRoutineToolActivity(
  entry: Pick<WorkerActivityEntry, "kind" | "title">,
): boolean {
  if (entry.kind === "command" || entry.kind === "reasoning") {
    return true;
  }
  if (entry.kind === "system" && entry.title.trim().toLowerCase() === "system_message") {
    return true;
  }
  return false;
}

/**
 * Counts occurrences of tool names, sorted by descending frequency with first-seen tie-breaking.
 */
export function countToolNames(names: readonly string[]): ToolCallCount[] {
  const counts = new Map<string, { count: number; firstIndex: number }>();
  names.forEach((rawName, idx) => {
    const name = rawName.trim() || "tool";
    const existing = counts.get(name);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(name, { count: 1, firstIndex: idx });
    }
  });

  return Array.from(counts.entries())
    .sort((a, b) => b[1].count - a[1].count || a[1].firstIndex - b[1].firstIndex)
    .map(([name, meta]) => ({ name, count: meta.count }));
}

/**
 * Formats tool count breakdown such as:
 * "read_file ×14, edit_file ×5, run_command ×5"
 */
export function formatToolCountBreakdown(
  counts: readonly ToolCallCount[],
  locale: UiLocale = "ja",
  maxItems = DEFAULT_MAX_BREAKDOWN_ITEMS,
): string {
  if (counts.length === 0) return "";
  const limit = Math.max(1, maxItems);
  const shown = counts.slice(0, limit);
  const parts = shown.map((item) => `${item.name} ×${item.count}`);
  const remaining = counts.length - shown.length;
  if (remaining > 0) {
    parts.push(t(locale, "inspector.toolLogMoreTools", { count: remaining }));
  }
  return parts.join(", ");
}

/**
 * Partitions task activities into high-signal events (immediately visible, newest first)
 * and routine tool execution logs (chronological, collapsed by default with aggregated counts).
 */
export function partitionTaskActivities(
  activities: readonly WorkerActivityEntry[],
): PartitionedTaskActivities {
  const highSignalChronological: WorkerActivityEntry[] = [];
  const toolActivities: WorkerActivityEntry[] = [];

  for (const act of activities) {
    if (isRoutineToolActivity(act)) {
      toolActivities.push(act);
    } else {
      highSignalChronological.push(act);
    }
  }

  const toolCounts = countToolNames(
    toolActivities.map((act) => normalizeActivityToolName(act.title)),
  );

  return {
    highSignal: [...highSignalChronological].reverse(),
    toolActivities,
    toolCounts,
    defaultToolLogCollapsed: true,
  };
}

/**
 * Formats the compact toggle label for collapsed tool execution logs in TaskInspectorModal.
 * Example (ja): "ツール実行ログ（全 24件: read_file ×14, edit_file ×5, run_command ×5）"
 * Example (en): "Tool execution log (24 total: read_file ×14, edit_file ×5, run_command ×5)"
 */
export function formatToolLogSummary(
  totalCount: number,
  toolCounts: readonly ToolCallCount[],
  locale: UiLocale = "ja",
  maxItems = DEFAULT_MAX_BREAKDOWN_ITEMS,
): string {
  const breakdown = formatToolCountBreakdown(toolCounts, locale, maxItems);
  if (!breakdown) {
    return t(locale, "inspector.toolLogSummaryEmptyBreakdown", { count: totalCount });
  }
  return t(locale, "inspector.toolLogSummary", {
    count: totalCount,
    breakdown,
  });
}

/**
 * Determines how a chat assistant message's tool activity chips should be displayed:
 * - Completed message with > threshold (default 2) chips: collapse all chips behind a single
 *   compact expandable summary pill by default.
 * - Streaming message: always keep currently running (!isCompleted) chips visible; collapse
 *   completed chips once they exceed the threshold so the streaming response stays readable.
 * - Messages at or below threshold: show all chips inline without collapsing.
 */
export function buildToolChipDisplayPlan(
  toolChips: readonly ToolActivityChip[],
  options: { isStreaming: boolean; collapseThreshold?: number },
): ToolChipDisplayPlan {
  const threshold = options.collapseThreshold ?? DEFAULT_TOOL_CHIP_COLLAPSE_THRESHOLD;
  if (toolChips.length === 0) {
    return {
      shouldCollapseByDefault: false,
      visibleChips: [],
      collapsibleChips: [],
      toolCounts: [],
      errorCount: 0,
    };
  }

  if (!options.isStreaming) {
    if (toolChips.length > threshold) {
      const collapsibleChips = [...toolChips];
      return {
        shouldCollapseByDefault: true,
        visibleChips: [],
        collapsibleChips,
        toolCounts: countToolNames(collapsibleChips.map((chip) => normalizeToolChipName(chip))),
        errorCount: collapsibleChips.filter((chip) => chip.isError).length,
      };
    }

    return {
      shouldCollapseByDefault: false,
      visibleChips: [...toolChips],
      collapsibleChips: [],
      toolCounts: [],
      errorCount: 0,
    };
  }

  const runningChips: ToolActivityChip[] = [];
  const completedChips: ToolActivityChip[] = [];
  for (const chip of toolChips) {
    if (chip.isCompleted) {
      completedChips.push(chip);
    } else {
      runningChips.push(chip);
    }
  }

  if (completedChips.length > threshold) {
    return {
      shouldCollapseByDefault: true,
      visibleChips: runningChips,
      collapsibleChips: completedChips,
      toolCounts: countToolNames(completedChips.map((chip) => normalizeToolChipName(chip))),
      errorCount: completedChips.filter((chip) => chip.isError).length,
    };
  }

  return {
    shouldCollapseByDefault: false,
    visibleChips: [...toolChips],
    collapsibleChips: [],
    toolCounts: [],
    errorCount: 0,
  };
}

/**
 * Formats the compact expandable summary pill label for collapsed chat tool chips.
 */
export function formatToolChipsSummary(
  totalCount: number,
  toolCounts: readonly ToolCallCount[],
  errorCount: number,
  locale: UiLocale = "ja",
  maxItems = 3,
): string {
  const breakdown = formatToolCountBreakdown(toolCounts, locale, maxItems);
  const base = breakdown
    ? t(locale, "chat.toolChipsSummary", { count: totalCount, breakdown })
    : t(locale, "chat.toolChipsSummaryNoBreakdown", { count: totalCount });
  if (errorCount > 0) {
    return `${base}${t(locale, "chat.toolChipsErrorSuffix", { count: errorCount })}`;
  }
  return base;
}
