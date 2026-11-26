import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TaskInspectorModal } from "../src/renderer/components/TaskInspectorModal.js";
import { MessageToolChips } from "../src/renderer/components/UnifiedChat.js";
import {
  buildToolChipDisplayPlan,
  countToolNames,
  formatToolChipsSummary,
  formatToolCountBreakdown,
  formatToolLogSummary,
  isRoutineToolActivity,
  normalizeActivityToolName,
  normalizeToolChipName,
  partitionTaskActivities,
} from "../src/renderer/lib/activity-log.js";
import type { AgentTask, ToolActivityChip, WorkerActivityEntry } from "../src/shared/types.js";

const JAPANESE_CHAR_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;

function makeActivity(
  overrides: Partial<WorkerActivityEntry> & { id: string; kind: WorkerActivityEntry["kind"]; title: string },
): WorkerActivityEntry {
  return {
    detail: null,
    timestamp: "2026-11-26T00:00:00.000Z",
    ...overrides,
  };
}

function makeToolChip(
  overrides: Partial<ToolActivityChip> & { id: string; label: string },
): ToolActivityChip {
  return {
    detail: null,
    isCompleted: true,
    isError: false,
    ...overrides,
  };
}

function makeTaskWithNoisyActivities(): AgentTask {
  const activities: WorkerActivityEntry[] = [
    makeActivity({
      id: "sys-start",
      kind: "system",
      title: "AGY worker started in conductor (conductor/task-1)",
      detail: "Improve log readability",
      timestamp: "2026-11-26T00:00:01.000Z",
    }),
    ...Array.from({ length: 14 }, (_, idx) =>
      makeActivity({
        id: `read-${idx + 1}`,
        kind: "command",
        title: "read_file",
        detail: `src/file-${idx + 1}.ts`,
        timestamp: `2026-11-26T00:01:${String(idx).padStart(2, "0")}.000Z`,
      }),
    ),
    ...Array.from({ length: 5 }, (_, idx) =>
      makeActivity({
        id: `edit-${idx + 1}`,
        kind: "command",
        title: "edit_file",
        detail: `edited src/file-${idx + 1}.ts`,
        timestamp: `2026-11-26T00:02:${String(idx).padStart(2, "0")}.000Z`,
      }),
    ),
    ...Array.from({ length: 5 }, (_, idx) =>
      makeActivity({
        id: `run-${idx + 1}`,
        kind: "command",
        title: "run_command",
        detail: `pnpm test --run ${idx + 1}`,
        timestamp: `2026-11-26T00:03:${String(idx).padStart(2, "0")}.000Z`,
      }),
    ),
    makeActivity({
      id: "err-1",
      kind: "error",
      title: "Land conflict (aborted cleanly)",
      detail: "CONFLICT in src/renderer/components/TaskInspectorModal.tsx",
      timestamp: "2026-11-26T00:04:00.000Z",
    }),
    makeActivity({
      id: "msg-1",
      kind: "message",
      title: "Worker 報告",
      detail: "すべてのテストが通過しました。",
      timestamp: "2026-11-26T00:05:00.000Z",
    }),
  ];

  return {
    id: "task-noisy-1",
    taskNumber: 12,
    title: "Collapse noisy tool execution logs",
    summary: "Collapsed routine tool calls by default.",
    projectId: "proj-1",
    projectName: "conductor",
    projectPath: "/workspace/conductor",
    status: "needs_review",
    provider: "agy",
    currentStep: "完了・確認待ち",
    workerThreadId: null,
    activeTurnId: null,
    previewURL: null,
    latestOutput: "### 完了レポート\n\nツール実行ログをデフォルトで折りたたむようにしました。",
    activities,
    createdAt: "2026-11-26T00:00:00.000Z",
    updatedAt: "2026-11-26T00:05:00.000Z",
  };
}

describe("activity-log pure helpers", () => {
  it("normalizes activity and chip tool names across providers", () => {
    expect(normalizeActivityToolName("read_file")).toBe("read_file");
    expect(normalizeActivityToolName("default_api:edit_file")).toBe("edit_file");
    expect(normalizeActivityToolName("mcp__conductor__list_tasks")).toBe("list_tasks");
    expect(normalizeActivityToolName("$ pnpm test --run")).toBe("run_command");
    expect(normalizeActivityToolName("   ")).toBe("tool");

    expect(
      normalizeToolChipName({ toolName: "commandExecution", label: "$ git status" }),
    ).toBe("run_command");
    expect(
      normalizeToolChipName({ toolName: "fileChange", label: "Files updated (2)" }),
    ).toBe("file_change");
    expect(
      normalizeToolChipName({ toolName: "webSearch", label: "Web: vitest" }),
    ).toBe("web_search");
    expect(
      normalizeToolChipName({ toolName: "mcp__conductor__get_task_detail", label: "タスク詳細を取得" }),
    ).toBe("get_task_detail");
    expect(normalizeToolChipName({ label: "$ pnpm check" })).toBe("run_command");
  });

  it("classifies routine tool-call entries vs high-signal entries", () => {
    expect(isRoutineToolActivity({ kind: "command", title: "read_file" })).toBe(true);
    expect(isRoutineToolActivity({ kind: "command", title: "edit_file" })).toBe(true);
    expect(isRoutineToolActivity({ kind: "command", title: "write_file" })).toBe(true);
    expect(isRoutineToolActivity({ kind: "command", title: "run_command" })).toBe(true);
    expect(isRoutineToolActivity({ kind: "command", title: "update_steps" })).toBe(true);
    expect(isRoutineToolActivity({ kind: "command", title: "system_message" })).toBe(true);
    expect(isRoutineToolActivity({ kind: "command", title: "$ git status" })).toBe(true);
    expect(isRoutineToolActivity({ kind: "reasoning", title: "Thinking" })).toBe(true);
    expect(isRoutineToolActivity({ kind: "system", title: "system_message" })).toBe(true);

    expect(isRoutineToolActivity({ kind: "error", title: "Auto-land error" })).toBe(false);
    expect(isRoutineToolActivity({ kind: "message", title: "Worker 報告" })).toBe(false);
    expect(
      isRoutineToolActivity({ kind: "system", title: "Auto-land completed → main" }),
    ).toBe(false);
    expect(
      isRoutineToolActivity({ kind: "system", title: "AGY worker started in conductor" }),
    ).toBe(false);
    expect(isRoutineToolActivity({ kind: "file", title: "Modified 3 file(s)" })).toBe(false);
  });

  it("counts tool names sorted by descending frequency and formats localized breakdowns", () => {
    const counts = countToolNames([
      "edit_file",
      "read_file",
      "run_command",
      "read_file",
      "read_file",
      "edit_file",
      "write_file",
      "update_steps",
      "system_message",
    ]);

    expect(counts).toEqual([
      { name: "read_file", count: 3 },
      { name: "edit_file", count: 2 },
      { name: "run_command", count: 1 },
      { name: "write_file", count: 1 },
      { name: "update_steps", count: 1 },
      { name: "system_message", count: 1 },
    ]);

    expect(formatToolCountBreakdown(counts, "ja", 3)).toBe(
      "read_file ×3, edit_file ×2, run_command ×1, 他 3種",
    );
    expect(formatToolCountBreakdown(counts, "en", 3)).toBe(
      "read_file ×3, edit_file ×2, run_command ×1, +3 more",
    );
  });

  it("partitions task activities with default collapsed tool logs and chronological tool order", () => {
    const task = makeTaskWithNoisyActivities();
    const partitioned = partitionTaskActivities(task.activities);

    expect(partitioned.defaultToolLogCollapsed).toBe(true);
    expect(partitioned.highSignal.map((a) => a.id)).toEqual(["msg-1", "err-1", "sys-start"]);
    expect(partitioned.toolActivities).toHaveLength(24);
    expect(partitioned.toolActivities[0]?.id).toBe("read-1");
    expect(partitioned.toolActivities[23]?.id).toBe("run-5");
    expect(partitioned.toolCounts).toEqual([
      { name: "read_file", count: 14 },
      { name: "edit_file", count: 5 },
      { name: "run_command", count: 5 },
    ]);

    expect(formatToolLogSummary(24, partitioned.toolCounts, "ja")).toBe(
      "ツール実行ログ（全 24件: read_file ×14, edit_file ×5, run_command ×5）",
    );
    expect(formatToolLogSummary(24, partitioned.toolCounts, "en")).toBe(
      "Tool execution log (24 total: read_file ×14, edit_file ×5, run_command ×5)",
    );
  });

  it("builds tool chip display plans for completed and streaming assistant messages", () => {
    const twoCompleted: ToolActivityChip[] = [
      makeToolChip({ id: "c1", toolName: "read_file", label: "read_file" }),
      makeToolChip({ id: "c2", toolName: "edit_file", label: "edit_file" }),
    ];

    const smallPlan = buildToolChipDisplayPlan(twoCompleted, { isStreaming: false });
    expect(smallPlan.shouldCollapseByDefault).toBe(false);
    expect(smallPlan.visibleChips).toHaveLength(2);
    expect(smallPlan.collapsibleChips).toHaveLength(0);

    const fourCompleted: ToolActivityChip[] = [
      makeToolChip({ id: "c1", toolName: "read_file", label: "read_file" }),
      makeToolChip({ id: "c2", toolName: "read_file", label: "read_file" }),
      makeToolChip({ id: "c3", toolName: "edit_file", label: "edit_file" }),
      makeToolChip({ id: "c4", toolName: "run_command", label: "$ pnpm test", isError: true }),
    ];

    const completedCollapsed = buildToolChipDisplayPlan(fourCompleted, { isStreaming: false });
    expect(completedCollapsed.shouldCollapseByDefault).toBe(true);
    expect(completedCollapsed.visibleChips).toHaveLength(0);
    expect(completedCollapsed.collapsibleChips).toHaveLength(4);
    expect(completedCollapsed.errorCount).toBe(1);
    expect(completedCollapsed.toolCounts).toEqual([
      { name: "read_file", count: 2 },
      { name: "edit_file", count: 1 },
      { name: "run_command", count: 1 },
    ]);
    expect(
      formatToolChipsSummary(
        completedCollapsed.collapsibleChips.length,
        completedCollapsed.toolCounts,
        completedCollapsed.errorCount,
        "ja",
      ),
    ).toBe("ツール実行 4件（read_file ×2, edit_file ×1, run_command ×1） · 1件エラー");
    expect(
      formatToolChipsSummary(
        completedCollapsed.collapsibleChips.length,
        completedCollapsed.toolCounts,
        completedCollapsed.errorCount,
        "en",
      ),
    ).toBe("4 tool calls (read_file ×2, edit_file ×1, run_command ×1) · 1 error(s)");

    // While streaming, currently running chips stay visible even when completed chips collapse
    const streamingMixed: ToolActivityChip[] = [
      ...fourCompleted,
      makeToolChip({
        id: "c5",
        toolName: "run_command",
        label: "$ pnpm build",
        isCompleted: false,
      }),
    ];
    const streamingPlan = buildToolChipDisplayPlan(streamingMixed, { isStreaming: true });
    expect(streamingPlan.shouldCollapseByDefault).toBe(true);
    expect(streamingPlan.visibleChips.map((c) => c.id)).toEqual(["c5"]);
    expect(streamingPlan.collapsibleChips).toHaveLength(4);

    // While streaming with only running chips (even > 2), do not collapse running chips
    const streamingOnlyRunning: ToolActivityChip[] = [
      makeToolChip({ id: "r1", label: "read_file", isCompleted: false }),
      makeToolChip({ id: "r2", label: "edit_file", isCompleted: false }),
      makeToolChip({ id: "r3", label: "run_command", isCompleted: false }),
    ];
    const streamingRunningPlan = buildToolChipDisplayPlan(streamingOnlyRunning, {
      isStreaming: true,
    });
    expect(streamingRunningPlan.shouldCollapseByDefault).toBe(false);
    expect(streamingRunningPlan.visibleChips).toHaveLength(3);
  });
});

describe("TaskInspectorModal tool execution log collapsing UI", () => {
  it("renders latestOutput and high-signal activities immediately while collapsing routine tool logs by default", () => {
    const task = makeTaskWithNoisyActivities();
    const html = renderToStaticMarkup(
      <TaskInspectorModal
        task={task}
        projectColorHex="#3B82F6"
        locale="ja"
        onClose={vi.fn()}
        onUpdateStatus={vi.fn()}
        onOpenPreviewUrl={vi.fn()}
        onMentionInChat={vi.fn()}
        onStopWorker={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    // Latest output and high-signal events are immediately visible
    expect(html).toContain('data-testid="inspector-latest-output"');
    expect(html).toContain("ツール実行ログをデフォルトで折りたたむようにしました。");
    expect(html).toContain('data-testid="inspector-high-signal-activities"');
    expect(html).toContain("Worker 報告");
    expect(html).toContain("Land conflict (aborted cleanly)");
    expect(html).toContain("AGY worker started in conductor (conductor/task-1)");

    // Tool execution log is collapsed by default with compact summary toggle
    expect(html).toContain('data-testid="inspector-tool-log-toggle"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(
      "ツール実行ログ（全 24件: read_file ×14, edit_file ×5, run_command ×5）",
    );
    expect(html).not.toContain('data-testid="inspector-tool-log-list"');
    expect(html).not.toContain("src/file-14.ts");
  });

  it("renders the full chronological tool log when expanded", () => {
    const task = makeTaskWithNoisyActivities();
    const html = renderToStaticMarkup(
      <TaskInspectorModal
        task={task}
        projectColorHex="#3B82F6"
        locale="ja"
        defaultToolLogExpanded={true}
        onClose={vi.fn()}
        onUpdateStatus={vi.fn()}
        onOpenPreviewUrl={vi.fn()}
        onMentionInChat={vi.fn()}
        onStopWorker={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('data-testid="inspector-tool-log-list"');
    expect(html).toContain("src/file-1.ts");
    expect(html).toContain("pnpm test --run 5");

    // Chronological order: first read_file (#1) appears before last run_command (#24)
    expect(html.indexOf("src/file-1.ts")).toBeLessThan(html.indexOf("pnpm test --run 5"));
  });

  it("renders clean English summary with zero Japanese characters when locale is en", () => {
    const baseTask = makeTaskWithNoisyActivities();
    const enTask: AgentTask = {
      ...baseTask,
      latestOutput: "### Summary\n\nCollapsed routine tool execution logs.",
      activities: baseTask.activities.filter((a) => a.id !== "msg-1"),
    };

    const html = renderToStaticMarkup(
      <TaskInspectorModal
        task={enTask}
        projectColorHex="#3B82F6"
        locale="en"
        onClose={vi.fn()}
        onUpdateStatus={vi.fn()}
        onOpenPreviewUrl={vi.fn()}
        onMentionInChat={vi.fn()}
        onStopWorker={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(html).toContain(
      "Tool execution log (24 total: read_file ×14, edit_file ×5, run_command ×5)",
    );
    expect(html).not.toMatch(JAPANESE_CHAR_RE);
  });
});

describe("UnifiedChat MessageToolChips collapsing UI", () => {
  it("collapses > 2 completed tool chips into a single compact expandable pill by default", () => {
    const chips: ToolActivityChip[] = [
      makeToolChip({ id: "1", toolName: "read_file", label: "read_file · a.ts" }),
      makeToolChip({ id: "2", toolName: "read_file", label: "read_file · b.ts" }),
      makeToolChip({ id: "3", toolName: "edit_file", label: "edit_file · a.ts" }),
      makeToolChip({ id: "4", toolName: "run_command", label: "$ pnpm test" }),
    ];

    const collapsedHtml = renderToStaticMarkup(
      <MessageToolChips toolChips={chips} isStreaming={false} locale="ja" />,
    );
    expect(collapsedHtml).toContain('data-testid="message-tool-chips-toggle"');
    expect(collapsedHtml).toContain('aria-expanded="false"');
    expect(collapsedHtml).toContain("ツール実行 4件（read_file ×2, edit_file ×1, run_command ×1）");
    expect(collapsedHtml).not.toContain('data-testid="message-tool-chips-expanded"');
    expect(collapsedHtml).not.toContain("read_file · a.ts");

    const expandedHtml = renderToStaticMarkup(
      <MessageToolChips
        toolChips={chips}
        isStreaming={false}
        locale="ja"
        defaultExpanded={true}
      />,
    );
    expect(expandedHtml).toContain('aria-expanded="true"');
    expect(expandedHtml).toContain('data-testid="message-tool-chips-expanded"');
    expect(expandedHtml).toContain("read_file · a.ts");
    expect(expandedHtml).toContain("$ pnpm test");
  });

  it("keeps <= 2 completed chips inline and keeps running chips visible while streaming", () => {
    const smallChips: ToolActivityChip[] = [
      makeToolChip({ id: "1", toolName: "list_tasks", label: "タスク一覧を確認" }),
      makeToolChip({ id: "2", toolName: "start_worker", label: "ワーカーを起動" }),
    ];
    const smallHtml = renderToStaticMarkup(
      <MessageToolChips toolChips={smallChips} isStreaming={false} locale="ja" />,
    );
    expect(smallHtml).not.toContain('data-testid="message-tool-chips-toggle"');
    expect(smallHtml).toContain("タスク一覧を確認");
    expect(smallHtml).toContain("ワーカーを起動");

    const streamingChips: ToolActivityChip[] = [
      makeToolChip({ id: "1", toolName: "read_file", label: "read_file · 1" }),
      makeToolChip({ id: "2", toolName: "read_file", label: "read_file · 2" }),
      makeToolChip({ id: "3", toolName: "edit_file", label: "edit_file · 1" }),
      makeToolChip({
        id: "4",
        toolName: "run_command",
        label: "$ pnpm check",
        isCompleted: false,
      }),
    ];
    const streamingHtml = renderToStaticMarkup(
      <MessageToolChips toolChips={streamingChips} isStreaming={true} locale="en" />,
    );
    expect(streamingHtml).toContain('data-testid="message-tool-chips-toggle"');
    expect(streamingHtml).toContain("3 tool calls (read_file ×2, edit_file ×1)");
    expect(streamingHtml).toContain("$ pnpm check");
    expect(streamingHtml).not.toMatch(JAPANESE_CHAR_RE);
  });
});
