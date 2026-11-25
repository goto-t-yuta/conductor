import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentTask, Project } from "../src/shared/types.js";
import { SettingsModal } from "../src/renderer/components/SettingsModal.js";
import { TaskInspectorModal } from "../src/renderer/components/TaskInspectorModal.js";
import { TaskCard } from "../src/renderer/components/TaskSidebar.js";

function findElementByTestId(
  node: unknown,
  testId: string,
): React.ReactElement<Record<string, unknown>> | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElementByTestId(child, testId);
      if (found) return found;
    }
    return null;
  }
  if (!React.isValidElement(node)) return null;
  const props = node.props as Record<string, unknown>;
  if (props["data-testid"] === testId) {
    return node as React.ReactElement<Record<string, unknown>>;
  }
  return findElementByTestId(props.children, testId);
}

const sampleProject: Project = {
  id: "proj-1",
  name: "agent_terminal_2",
  path: "/tmp/agent_terminal_2",
  colorHex: "#3B82F6",
  gitBranch: "conductor/add-worktree",
  addedAt: "2026-11-26T00:00:00.000Z",
};

const sampleWorktreeTask: AgentTask = {
  id: "task-wt-1",
  taskNumber: 1,
  title: "Implement worktree support",
  summary: "Isolated worktree execution",
  projectId: "proj-1",
  projectName: "agent_terminal_2",
  projectPath: "/tmp/agent_terminal_2",
  status: "needs_review",
  currentStep: "完了・確認待ち",
  workerThreadId: null,
  activeTurnId: null,
  previewURL: null,
  latestOutput: "",
  activities: [],
  worktreePath: "/tmp/conductor-data/worktrees/agent-terminal-2/task-wt1",
  worktreeBranch: "conductor/task-wt1",
  baseBranch: "main",
  baseCommit: "abc1234",
  landStatus: "unlanded",
  createdAt: "2026-11-26T00:00:00.000Z",
  updatedAt: "2026-11-26T00:00:00.000Z",
};

describe("Worktree & Settings UI", () => {
  it("renders SettingsModal with all integration modes, auto-land toggle, and per-project overrides", () => {
    const onSetAutoLand = vi.fn();
    const html = renderToStaticMarkup(
      <SettingsModal
        defaultIntegrationMode="feature-branch"
        autoLandOnComplete={true}
        projects={[
          sampleProject,
          { ...sampleProject, id: "proj-2", name: "api-server", integrationMode: "per-task-pr" },
        ]}
        onClose={vi.fn()}
        onSetDefaultIntegrationMode={vi.fn()}
        onSetAutoLandOnComplete={onSetAutoLand}
        onSetProjectIntegrationMode={vi.fn()}
      />,
    );

    expect(html).toContain('data-testid="integration-mode-feature-branch"');
    expect(html).toContain('data-testid="integration-mode-per-task-pr"');
    expect(html).toContain('data-testid="integration-mode-direct"');
    expect(html).toContain('data-testid="auto-land-toggle"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('data-testid="project-mode-proj-1"');
    expect(html).toContain('data-testid="project-mode-proj-2"');
    expect(html).toContain("conductor/add-worktree");

    const offHtml = renderToStaticMarkup(
      <SettingsModal
        defaultIntegrationMode="feature-branch"
        autoLandOnComplete={false}
        projects={[sampleProject]}
        onClose={vi.fn()}
        onSetDefaultIntegrationMode={vi.fn()}
        onSetAutoLandOnComplete={onSetAutoLand}
        onSetProjectIntegrationMode={vi.fn()}
      />,
    );
    expect(offHtml).toContain('aria-checked="false"');
  });

  it("renders worktree branch badge and one-click Land button on TaskCard with click isolation", () => {
    const onSelect = vi.fn();
    const onLand = vi.fn();

    const html = renderToStaticMarkup(
      <TaskCard
        task={sampleWorktreeTask}
        colorHex="#3B82F6"
        effectiveMode="feature-branch"
        parentBranch="main"
        isSelected={false}
        onSelect={onSelect}
        onOpenPreview={vi.fn()}
        onMention={vi.fn()}
        onUpdateStatus={vi.fn()}
        onStop={vi.fn()}
        onDelete={vi.fn()}
        onLand={onLand}
      />,
    );

    expect(html).toContain('data-testid="task-worktree-badge"');
    expect(html).toContain("conductor/task-wt1");
    expect(html).toContain('data-testid="task-quick-land"');
    expect(html).toContain(">Land<");

    // Verify stopPropagation & onLand click isolation
    const element = TaskCard({
      task: sampleWorktreeTask,
      colorHex: "#3B82F6",
      effectiveMode: "feature-branch",
      parentBranch: "main",
      isSelected: false,
      onSelect,
      onOpenPreview: vi.fn(),
      onMention: vi.fn(),
      onUpdateStatus: vi.fn(),
      onStop: vi.fn(),
      onDelete: vi.fn(),
      onLand,
    });

    const landBtn = findElementByTestId(element, "task-quick-land");
    expect(landBtn).not.toBeNull();
    const stopPropagation = vi.fn();
    (landBtn!.props.onClick as (e: { stopPropagation: () => void }) => void)({
      stopPropagation,
    });
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(onLand).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();

    // In per-task-pr mode, button shows Push/PR
    const prHtml = renderToStaticMarkup(
      <TaskCard
        task={sampleWorktreeTask}
        colorHex="#3B82F6"
        effectiveMode="per-task-pr"
        parentBranch="main"
        isSelected={false}
        onSelect={vi.fn()}
        onOpenPreview={vi.fn()}
        onMention={vi.fn()}
        onUpdateStatus={vi.fn()}
        onStop={vi.fn()}
        onDelete={vi.fn()}
        onLand={vi.fn()}
      />,
    );
    expect(prHtml).toContain("Push/PR");
  });

  it("renders conflict error feedback, AI conflict resolution button, and target branch badge in TaskInspectorModal", () => {
    const conflictTask: AgentTask = {
      ...sampleWorktreeTask,
      landStatus: "conflict",
      landError: "conductor/add-worktree へのリベースでコンフリクトが発生しました",
      conflictFiles: ["src/app.ts"],
    };

    const html = renderToStaticMarkup(
      <TaskInspectorModal
        task={conflictTask}
        project={sampleProject}
        projectColorHex="#3B82F6"
        defaultIntegrationMode="feature-branch"
        onClose={vi.fn()}
        onUpdateStatus={vi.fn()}
        onOpenPreviewUrl={vi.fn()}
        onMentionInChat={vi.fn()}
        onStopWorker={vi.fn()}
        onDelete={vi.fn()}
        onLandTask={vi.fn()}
        onResolveConflictWithAI={vi.fn()}
      />,
    );

    expect(html).toContain('data-testid="worktree-panel"');
    expect(html).toContain('data-testid="inspector-target-badge"');
    expect(html).toContain("Target: conductor/add-worktree");
    expect(html).toContain('data-testid="inspector-land-error"');
    expect(html).toContain("src/app.ts");
    expect(html).toContain('data-testid="inspector-land-btn"');
    expect(html).toContain('data-testid="inspector-ai-resolve-conflict-btn"');
    expect(html).toContain("AIでコンフリクト解消");

    // Must NOT render AI resolve button while task is running or when not in conflict state
    const runningConflictHtml = renderToStaticMarkup(
      <TaskInspectorModal
        task={{ ...conflictTask, status: "running" }}
        project={sampleProject}
        projectColorHex="#3B82F6"
        defaultIntegrationMode="feature-branch"
        onClose={vi.fn()}
        onUpdateStatus={vi.fn()}
        onOpenPreviewUrl={vi.fn()}
        onMentionInChat={vi.fn()}
        onStopWorker={vi.fn()}
        onDelete={vi.fn()}
        onLandTask={vi.fn()}
        onResolveConflictWithAI={vi.fn()}
      />,
    );
    expect(runningConflictHtml).not.toContain('data-testid="inspector-ai-resolve-conflict-btn"');

    const unlandedHtml = renderToStaticMarkup(
      <TaskInspectorModal
        task={sampleWorktreeTask}
        project={sampleProject}
        projectColorHex="#3B82F6"
        defaultIntegrationMode="feature-branch"
        onClose={vi.fn()}
        onUpdateStatus={vi.fn()}
        onOpenPreviewUrl={vi.fn()}
        onMentionInChat={vi.fn()}
        onStopWorker={vi.fn()}
        onDelete={vi.fn()}
        onLandTask={vi.fn()}
        onResolveConflictWithAI={vi.fn()}
      />,
    );
    expect(unlandedHtml).not.toContain('data-testid="inspector-ai-resolve-conflict-btn"');
  });
});
