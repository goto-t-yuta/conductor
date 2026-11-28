import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserManager } from "../src/main/browser-manager.js";
import type { RunningCliTurn } from "../src/main/cli-agent-runner.js";
import type { CodexAppServerClient } from "../src/main/codex-client.js";
import { ConductorController } from "../src/main/conductor-controller.js";
import type { MCPToolResult } from "../src/main/local-mcp-server.js";
import { StateStore } from "../src/main/state-store.js";
import {
  RUNNING_TASK_DONE_BLOCKED_REASON,
  UNLANDED_TASK_DONE_BLOCKED_REASON,
  canMarkTaskDone,
  getMarkTaskDoneBlockedReason,
  requiresLandBeforeDone,
  validateManualTaskStatusTransition,
} from "../src/shared/task-status.js";
import type { AgentTask, AgentTaskStatus, TaskLandStatus } from "../src/shared/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempStore(): StateStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-status-guard-"));
  tempDirs.push(dir);
  return new StateStore(dir);
}

function createFakeBrowserManager(): BrowserManager {
  return {
    getTabs: () => [],
    getActiveTabId: () => null,
    getActiveTab: () => null,
    isPickingElement: () => false,
    restore: () => {},
  } as unknown as BrowserManager;
}

function createFakeWorkerClient() {
  const interruptTurn = vi.fn().mockResolvedValue(undefined);
  const client = {
    label: "fake-worker",
    isConnected: () => true,
    onNotification: () => () => {},
    onDisconnect: () => () => {},
    stop: () => {},
    interruptTurn,
  } as unknown as CodexAppServerClient;
  return { client, interruptTurn };
}

function makeTask(
  overrides: Partial<AgentTask> & { id: string; taskNumber: number; title: string; status: AgentTaskStatus },
): AgentTask {
  return {
    summary: "",
    projectId: "proj-1",
    projectName: "agent_terminal_2",
    projectPath: "/tmp/agent_terminal_2",
    currentStep: null,
    workerThreadId: null,
    activeTurnId: null,
    previewURL: null,
    latestOutput: "",
    activities: [],
    createdAt: "2026-11-26T00:00:00.000Z",
    updatedAt: "2026-11-26T00:00:00.000Z",
    ...overrides,
  };
}

function createControllerWithTasks(tasks: AgentTask[]) {
  const store = createTempStore();
  const snapshots = vi.fn();
  const { client: workerClient, interruptTurn } = createFakeWorkerClient();
  const controller = new ConductorController({
    store,
    browser: createFakeBrowserManager(),
    onSnapshot: snapshots,
    workerClient,
  });

  // Populate live in-memory tasks after startup auto-resume prep so running tasks
  // reflect active in-flight workers rather than persisted pre-crash tasks.
  (controller as unknown as { tasks: AgentTask[]; nextTaskNumber: number }).tasks = tasks.map(
    (t) => ({ ...t }),
  );
  (controller as unknown as { nextTaskNumber: number }).nextTaskNumber =
    tasks.reduce((max, t) => Math.max(max, t.taskNumber), 0) + 1;
  snapshots.mockClear();

  return { controller, store, snapshots, interruptTurn };
}

describe("ConductorController task status transition guard", () => {
  it("rejects marking a running task as done without stopping its worker first", () => {
    const runningTask = makeTask({
      id: "task-running-1",
      taskNumber: 1,
      title: "Active worker task",
      status: "running",
      workerThreadId: "thr-1",
      activeTurnId: "turn-1",
      autoResumeOnStartup: false,
    });
    const { controller, snapshots } = createControllerWithTasks([runningTask]);

    const res = controller.updateTaskStatus(runningTask.id, "done");

    expect(res).toEqual({
      ok: false,
      error: RUNNING_TASK_DONE_BLOCKED_REASON,
    });
    const current = controller.getSnapshot().tasks.find((t) => t.id === runningTask.id);
    expect(current?.status).toBe("running");
    expect(snapshots).not.toHaveBeenCalled();
  });

  it("rejects marking a task as done while a live CLI worker or active turn is still registered", () => {
    const cliTask = makeTask({
      id: "task-cli-1",
      taskNumber: 1,
      title: "CLI worker task",
      status: "needs_review",
    });
    const codexTurnTask = makeTask({
      id: "task-codex-1",
      taskNumber: 2,
      title: "Codex active turn task",
      status: "needs_review",
      workerThreadId: "thr-2",
      activeTurnId: "turn-2",
    });
    const { controller } = createControllerWithTasks([cliTask, codexTurnTask]);

    const fakeCliTurn: RunningCliTurn = { cancel: vi.fn() };
    (controller as unknown as { activeCliWorkers: Map<string, RunningCliTurn> }).activeCliWorkers.set(
      cliTask.id,
      fakeCliTurn,
    );

    expect(controller.updateTaskStatus(cliTask.id, "done")).toEqual({
      ok: false,
      error: RUNNING_TASK_DONE_BLOCKED_REASON,
    });
    expect(controller.updateTaskStatus(codexTurnTask.id, "done")).toEqual({
      ok: false,
      error: RUNNING_TASK_DONE_BLOCKED_REASON,
    });

    expect(controller.getSnapshot().tasks.find((t) => t.id === cliTask.id)?.status).toBe("needs_review");
    expect(controller.getSnapshot().tasks.find((t) => t.id === codexTurnTask.id)?.status).toBe(
      "needs_review",
    );
  });

  it("allows marking a task as done after stopping its running worker", async () => {
    const runningTask = makeTask({
      id: "task-stop-then-done",
      taskNumber: 1,
      title: "Stoppable worker task",
      status: "running",
      workerThreadId: "thr-10",
      activeTurnId: "turn-10",
    });
    const { controller, interruptTurn } = createControllerWithTasks([runningTask]);

    // Blocked while running
    expect(controller.updateTaskStatus(runningTask.id, "done").ok).toBe(false);

    // Stop worker -> transitions to needs_review and clears activeTurnId
    await controller.stopTaskWorker(runningTask.id);
    expect(interruptTurn).toHaveBeenCalledWith("thr-10", "turn-10");
    expect(controller.getSnapshot().tasks.find((t) => t.id === runningTask.id)?.status).toBe(
      "needs_review",
    );

    // Now marking as done succeeds cleanly
    const res = controller.updateTaskStatus(runningTask.id, "done");
    expect(res).toEqual({ ok: true });
    expect(controller.getSnapshot().tasks.find((t) => t.id === runningTask.id)?.status).toBe("done");
  });

  it("preserves normal running -> needs_review/failed and done -> needs_review/running transitions", () => {
    const runningA = makeTask({
      id: "t-run-a",
      taskNumber: 1,
      title: "Running A",
      status: "running",
    });
    const runningB = makeTask({
      id: "t-run-b",
      taskNumber: 2,
      title: "Running B",
      status: "running",
    });
    const doneTask = makeTask({
      id: "t-done",
      taskNumber: 3,
      title: "Done task",
      status: "done",
    });
    const { controller } = createControllerWithTasks([runningA, runningB, doneTask]);

    expect(controller.updateTaskStatus(runningA.id, "needs_review")).toEqual({ ok: true });
    expect(controller.updateTaskStatus(runningB.id, "failed")).toEqual({ ok: true });

    // Reopen done -> needs_review, then resume -> running
    expect(controller.updateTaskStatus(doneTask.id, "needs_review")).toEqual({ ok: true });
    expect(controller.getSnapshot().tasks.find((t) => t.id === doneTask.id)?.status).toBe("needs_review");

    expect(controller.updateTaskStatus(doneTask.id, "done")).toEqual({ ok: true });
    expect(controller.updateTaskStatus(doneTask.id, "running")).toEqual({ ok: true });
    expect(controller.getSnapshot().tasks.find((t) => t.id === doneTask.id)?.status).toBe("running");
  });

  it("rejects MCP update_task transitioning a running task to done while still allowing metadata updates and non-done statuses", async () => {
    const runningTask = makeTask({
      id: "t-mcp-run",
      taskNumber: 7,
      title: "MCP running task",
      status: "running",
      workerThreadId: "thr-7",
      activeTurnId: "turn-7",
    });
    const { controller } = createControllerWithTasks([runningTask]);

    const callTool = (
      controller as unknown as {
        handleMCPToolCall: (name: string, args: Record<string, unknown>) => Promise<MCPToolResult>;
      }
    ).handleMCPToolCall.bind(controller);

    // Reject running -> done
    const blocked = await callTool("update_task", {
      task_id: "T7",
      status: "done",
      summary: "Should not apply",
    });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toBe(RUNNING_TASK_DONE_BLOCKED_REASON);
    const stillRunning = controller.getSnapshot().tasks.find((t) => t.id === runningTask.id);
    expect(stillRunning?.status).toBe("running");
    expect(stillRunning?.summary).toBe("");

    // Allow updating step/summary while still running
    const progressUpdate = await callTool("update_task", {
      task_id: "T7",
      current_step: "テスト実行中",
    });
    expect(progressUpdate.isError).toBeFalsy();
    expect(controller.getSnapshot().tasks.find((t) => t.id === runningTask.id)?.currentStep).toBe(
      "テスト実行中",
    );

    // Stop worker, then allow update_task to mark done
    await controller.stopTaskWorker(runningTask.id);
    const doneUpdate = await callTool("update_task", {
      task_id: "T7",
      status: "done",
      summary: "Stopped and completed",
    });
    expect(doneUpdate.isError).toBeFalsy();
    expect(controller.getSnapshot().tasks.find((t) => t.id === runningTask.id)?.status).toBe("done");
  });
});

function initTempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-land-guard-repo-"));
  tempDirs.push(dir);
  const git = (args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Test User"]);
  git(["config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(dir, "README.md"), "# Test Repo\n", "utf8");
  git(["add", "README.md"]);
  git(["commit", "-m", "initial commit"]);
  return dir;
}

describe("Shared task-status unlanded worktree Done guard", () => {
  it("allows marking non-worktree tasks as done", () => {
    const task = {
      status: "needs_review" as const,
      worktreePath: null,
      worktreeBranch: null,
      landStatus: undefined,
    };
    expect(requiresLandBeforeDone(task)).toBe(false);
    expect(getMarkTaskDoneBlockedReason(task)).toBeNull();
    expect(canMarkTaskDone(task)).toBe(true);
    expect(
      validateManualTaskStatusTransition({
        currentStatus: "needs_review",
        nextStatus: "done",
        worktreePath: null,
        worktreeBranch: null,
        landStatus: undefined,
      }),
    ).toEqual({ ok: true });
  });

  it("blocks marking worktree tasks with unlanded/landing/conflict/error or active worktree refs as done", () => {
    const blockedStatuses: Array<TaskLandStatus | undefined> = [
      "unlanded",
      "landing",
      "conflict",
      "error",
      undefined,
    ];

    for (const landStatus of blockedStatuses) {
      const wtTask = {
        status: "needs_review" as const,
        worktreePath: "/tmp/wt/task-1",
        worktreeBranch: "conductor/task-1",
        landStatus,
      };
      expect(requiresLandBeforeDone(wtTask)).toBe(true);
      expect(getMarkTaskDoneBlockedReason(wtTask)).toBe(UNLANDED_TASK_DONE_BLOCKED_REASON);
      expect(canMarkTaskDone(wtTask)).toBe(false);
      expect(
        validateManualTaskStatusTransition({
          currentStatus: "needs_review",
          nextStatus: "done",
          worktreePath: wtTask.worktreePath,
          worktreeBranch: wtTask.worktreeBranch,
          landStatus,
        }),
      ).toEqual({
        ok: false,
        error: UNLANDED_TASK_DONE_BLOCKED_REASON,
      });
    }

    // Even without worktreePath/worktreeBranch, explicit unlanded/conflict/error/landing landStatus blocks Done
    for (const landStatus of ["unlanded", "landing", "conflict", "error"] as const) {
      expect(
        requiresLandBeforeDone({ worktreePath: null, worktreeBranch: null, landStatus }),
      ).toBe(true);
    }
  });

  it("allows marking worktree tasks as done once landStatus is landed, pushed, or pr_created", () => {
    for (const landStatus of ["landed", "pushed", "pr_created"] as const) {
      const task = {
        status: "needs_review" as const,
        worktreePath: landStatus === "landed" ? null : "/tmp/wt/task-1",
        worktreeBranch: landStatus === "landed" ? null : "conductor/task-1",
        landStatus,
      };
      expect(requiresLandBeforeDone(task)).toBe(false);
      expect(getMarkTaskDoneBlockedReason(task)).toBeNull();
      expect(canMarkTaskDone(task)).toBe(true);
      expect(
        validateManualTaskStatusTransition({
          currentStatus: "needs_review",
          nextStatus: "done",
          worktreePath: task.worktreePath,
          worktreeBranch: task.worktreeBranch,
          landStatus,
        }),
      ).toEqual({ ok: true });
    }
  });

  it("prioritizes RUNNING_TASK_DONE_BLOCKED_REASON over unlanded worktree reason and allows reopening done tasks", () => {
    const runningUnlanded = {
      status: "running" as const,
      worktreePath: "/tmp/wt/running",
      worktreeBranch: "conductor/task-running",
      landStatus: "unlanded" as const,
    };
    expect(getMarkTaskDoneBlockedReason(runningUnlanded)).toBe(RUNNING_TASK_DONE_BLOCKED_REASON);
    expect(
      validateManualTaskStatusTransition({
        currentStatus: "running",
        nextStatus: "done",
        worktreePath: runningUnlanded.worktreePath,
        worktreeBranch: runningUnlanded.worktreeBranch,
        landStatus: runningUnlanded.landStatus,
      }),
    ).toEqual({
      ok: false,
      error: RUNNING_TASK_DONE_BLOCKED_REASON,
    });

    // Reopen done -> needs_review remains allowed
    expect(
      validateManualTaskStatusTransition({
        currentStatus: "done",
        nextStatus: "needs_review",
        worktreePath: null,
        worktreeBranch: null,
        landStatus: "landed",
      }),
    ).toEqual({ ok: true });
  });
});

describe("ConductorController unlanded worktree Done guard, cleanup, and noop land", () => {
  it("rejects IPC updateTaskStatus and MCP update_task transitioning unlanded worktree tasks to done", async () => {
    const unlandedTask = makeTask({
      id: "wt-unlanded",
      taskNumber: 10,
      title: "Unlanded feature",
      status: "needs_review",
      worktreePath: "/tmp/wt/unlanded",
      worktreeBranch: "conductor/task-wt10",
      landStatus: "unlanded",
    });
    const conflictTask = makeTask({
      id: "wt-conflict",
      taskNumber: 11,
      title: "Conflict feature",
      status: "needs_review",
      worktreePath: "/tmp/wt/conflict",
      worktreeBranch: "conductor/task-wt11",
      landStatus: "conflict",
      landError: "Merge conflict",
      conflictFiles: ["src/index.ts"],
    });
    const pushedTask = makeTask({
      id: "wt-pushed",
      taskNumber: 12,
      title: "Pushed PR feature",
      status: "needs_review",
      worktreePath: "/tmp/wt/pushed",
      worktreeBranch: "conductor/task-wt12",
      landStatus: "pushed",
    });
    const prTask = makeTask({
      id: "wt-pr",
      taskNumber: 13,
      title: "PR created feature",
      status: "needs_review",
      worktreePath: "/tmp/wt/pr",
      worktreeBranch: "conductor/task-wt13",
      landStatus: "pr_created",
      prUrl: "https://github.com/example/repo/pull/42",
    });

    const { controller, snapshots } = createControllerWithTasks([
      unlandedTask,
      conflictTask,
      pushedTask,
      prTask,
    ]);

    const callTool = (
      controller as unknown as {
        handleMCPToolCall: (name: string, args: Record<string, unknown>) => Promise<MCPToolResult>;
      }
    ).handleMCPToolCall.bind(controller);

    // IPC blocks unlanded and conflict
    expect(controller.updateTaskStatus(unlandedTask.id, "done")).toEqual({
      ok: false,
      error: UNLANDED_TASK_DONE_BLOCKED_REASON,
    });
    expect(controller.updateTaskStatus(conflictTask.id, "done")).toEqual({
      ok: false,
      error: UNLANDED_TASK_DONE_BLOCKED_REASON,
    });
    expect(snapshots).not.toHaveBeenCalled();

    // MCP blocks unlanded -> done, while allowing non-done updates
    const mcpBlocked = await callTool("update_task", {
      task_id: "T10",
      status: "done",
      summary: "Should not transition",
    });
    expect(mcpBlocked.isError).toBe(true);
    expect(mcpBlocked.text).toBe(UNLANDED_TASK_DONE_BLOCKED_REASON);
    expect(controller.getSnapshot().tasks.find((t) => t.id === unlandedTask.id)?.status).toBe(
      "needs_review",
    );

    const mcpFailed = await callTool("update_task", {
      task_id: "T10",
      status: "failed",
      summary: "Needs rework",
    });
    expect(mcpFailed.isError).toBeFalsy();
    expect(controller.getSnapshot().tasks.find((t) => t.id === unlandedTask.id)?.status).toBe(
      "failed",
    );

    // Pushed and pr_created tasks CAN transition to done via IPC and MCP
    expect(controller.updateTaskStatus(pushedTask.id, "done")).toEqual({ ok: true });
    expect(controller.getSnapshot().tasks.find((t) => t.id === pushedTask.id)?.status).toBe("done");

    const mcpPrDone = await callTool("update_task", {
      task_id: "T13",
      status: "done",
    });
    expect(mcpPrDone.isError).toBeFalsy();
    expect(controller.getSnapshot().tasks.find((t) => t.id === prTask.id)?.status).toBe("done");
  });

  it("clears worktree fields on cleanupTaskWorktree so discarded tasks can be marked done", async () => {
    const repo = initTempGitRepo();
    const store = createTempStore();
    const controller = new ConductorController({
      store,
      browser: createFakeBrowserManager(),
      onSnapshot: () => {},
    });
    const project = controller.registerProject(repo, "cleanup-repo")!;
    const task = makeTask({
      id: "task-discard-1",
      taskNumber: 20,
      title: "Discardable worktree task",
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      status: "needs_review",
    });
    (controller as unknown as { tasks: AgentTask[] }).tasks = [task];

    const provisioned = controller.provisionWorktreeForTask(task.id, project);
    expect(provisioned.created).toBe(true);

    // Simulate a conflict state before discarding
    (controller as unknown as { tasks: AgentTask[] }).tasks[0]!.landStatus = "conflict";
    (controller as unknown as { tasks: AgentTask[] }).tasks[0]!.landError = "Conflict on README.md";
    (controller as unknown as { tasks: AgentTask[] }).tasks[0]!.conflictFiles = ["README.md"];

    // Blocked before cleanup
    expect(controller.updateTaskStatus(task.id, "done")).toEqual({
      ok: false,
      error: UNLANDED_TASK_DONE_BLOCKED_REASON,
    });

    // Discard worktree
    const cleanupRes = await controller.cleanupTaskWorktree(task.id);
    expect(cleanupRes.ok).toBe(true);

    const afterCleanup = controller.getSnapshot().tasks.find((t) => t.id === task.id)!;
    expect(afterCleanup.worktreePath).toBeNull();
    expect(afterCleanup.worktreeBranch).toBeNull();
    expect(afterCleanup.landStatus).toBeUndefined();
    expect(afterCleanup.landError).toBeNull();
    expect(afterCleanup.conflictFiles).toBeUndefined();
    expect(requiresLandBeforeDone(afterCleanup)).toBe(false);

    // Marking as done now succeeds cleanly!
    expect(controller.updateTaskStatus(task.id, "done")).toEqual({ ok: true });
    expect(controller.getSnapshot().tasks.find((t) => t.id === task.id)?.status).toBe("done");
  });

  it("clears worktreePath and worktreeBranch and sets landStatus=landed on noop landTask", async () => {
    const repo = initTempGitRepo();
    const store = createTempStore();
    const controller = new ConductorController({
      store,
      browser: createFakeBrowserManager(),
      onSnapshot: () => {},
    });
    const project = controller.registerProject(repo, "noop-repo")!;
    const task = makeTask({
      id: "task-noop-1",
      taskNumber: 21,
      title: "No-op worktree task",
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      status: "needs_review",
    });
    (controller as unknown as { tasks: AgentTask[] }).tasks = [task];

    const provisioned = controller.provisionWorktreeForTask(task.id, project);
    expect(provisioned.created).toBe(true);

    // Blocked before land
    expect(controller.updateTaskStatus(task.id, "done")).toEqual({
      ok: false,
      error: UNLANDED_TASK_DONE_BLOCKED_REASON,
    });

    // Land with no changes -> noop -> cleans up worktree and unlocks Done cleanly
    const landRes = await controller.landTask(task.id);
    expect(landRes.ok).toBe(true);
    expect(landRes.action).toBe("noop");

    const afterLand = controller.getSnapshot().tasks.find((t) => t.id === task.id)!;
    expect(afterLand.landStatus).toBe("landed");
    expect(afterLand.worktreePath).toBeNull();
    expect(afterLand.worktreeBranch).toBeNull();
    expect(afterLand.status).toBe("done");
    expect(requiresLandBeforeDone(afterLand)).toBe(false);

    // Reopen and mark done again -> works cleanly without getting stuck
    expect(controller.updateTaskStatus(task.id, "needs_review")).toEqual({ ok: true });
    expect(controller.updateTaskStatus(task.id, "done")).toEqual({ ok: true });
  });

  it("auto-reconciles already-merged worktrees on syncTaskLandStatus, updateTaskStatus(done), and reconcileAllUnlandedTasks", () => {
    const repo = initTempGitRepo();
    const git = (cwd: string, args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();

    const store = createTempStore();
    const controller = new ConductorController({
      store,
      browser: createFakeBrowserManager(),
      onSnapshot: () => {},
    });
    const project = controller.registerProject(repo, "merged-sync-repo")!;

    const mergedErrorTask = makeTask({
      id: "task-merged-err",
      taskNumber: 30,
      title: "Already merged but stuck in error",
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      status: "needs_review",
    });
    const noDiffErrorTask = makeTask({
      id: "task-nodiff-err",
      taskNumber: 31,
      title: "No diff stuck in error",
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      status: "needs_review",
    });
    const batchMergedTask = makeTask({
      id: "task-batch-merged",
      taskNumber: 32,
      title: "Externally merged task for startup reconcile",
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      status: "needs_review",
    });
    (controller as unknown as { tasks: AgentTask[] }).tasks = [
      mergedErrorTask,
      noDiffErrorTask,
      batchMergedTask,
    ];

    const provMerged = controller.provisionWorktreeForTask(mergedErrorTask.id, project);
    fs.writeFileSync(path.join(provMerged.worktreePath!, "done.txt"), "already merged\n", "utf8");
    git(provMerged.worktreePath!, ["add", "done.txt"]);
    git(provMerged.worktreePath!, ["commit", "-m", "Add done.txt"]);
    git(repo, ["merge", "--ff-only", provMerged.worktreeBranch!]);

    const provNoDiff = controller.provisionWorktreeForTask(noDiffErrorTask.id, project);

    const provBatch = controller.provisionWorktreeForTask(batchMergedTask.id, project);
    fs.writeFileSync(path.join(provBatch.worktreePath!, "batch.txt"), "batch merged\n", "utf8");
    git(provBatch.worktreePath!, ["add", "batch.txt"]);
    git(provBatch.worktreePath!, ["commit", "-m", "Add batch.txt"]);
    git(repo, ["merge", "--no-ff", provBatch.worktreeBranch!, "-m", "Merge batch"]);

    // Simulate stale error/unlanded states
    const tasksRef = (controller as unknown as { tasks: AgentTask[] }).tasks;
    tasksRef[0]!.landStatus = "error";
    tasksRef[0]!.landError = "親リポジトリに未コミットの変更があります";
    tasksRef[1]!.landStatus = "error";
    tasksRef[1]!.landError = "親リポジトリに未コミットの変更があります";
    tasksRef[2]!.landStatus = "unlanded";

    // 1. Clicking Done directly on already-merged task auto-reconciles to landed & marks Done!
    expect(controller.updateTaskStatus(mergedErrorTask.id, "done")).toEqual({ ok: true });
    const afterMerged = controller.getSnapshot().tasks.find((t) => t.id === mergedErrorTask.id)!;
    expect(afterMerged.status).toBe("done");
    expect(afterMerged.landStatus).toBe("landed");
    expect(afterMerged.worktreePath).toBeNull();
    expect(afterMerged.worktreeBranch).toBeNull();
    expect(afterMerged.landError).toBeNull();
    expect(fs.existsSync(provMerged.worktreePath!)).toBe(false);

    // 2. syncTaskLandStatus on no-diff task stuck in error updates it to landed & cleans up worktree!
    const syncRes = controller.syncTaskLandStatus(noDiffErrorTask.id);
    expect(syncRes.ok).toBe(true);
    expect(syncRes.updated).toBe(true);
    expect(syncRes.landStatus).toBe("landed");
    expect(syncRes.reason).toBe("no_changes");
    const afterNoDiff = controller.getSnapshot().tasks.find((t) => t.id === noDiffErrorTask.id)!;
    expect(afterNoDiff.landStatus).toBe("landed");
    expect(afterNoDiff.worktreePath).toBeNull();
    expect(fs.existsSync(provNoDiff.worktreePath!)).toBe(false);
    expect(controller.updateTaskStatus(noDiffErrorTask.id, "done")).toEqual({ ok: true });

    // 3. reconcileAllUnlandedTasks catches externally merged task automatically
    const reconciledCount = controller.reconcileAllUnlandedTasks();
    expect(reconciledCount).toBe(1);
    const afterBatch = controller.getSnapshot().tasks.find((t) => t.id === batchMergedTask.id)!;
    expect(afterBatch.landStatus).toBe("landed");
    expect(afterBatch.worktreePath).toBeNull();
    expect(fs.existsSync(provBatch.worktreePath!)).toBe(false);
  });

  it("supports force Done for stuck unlanded tasks while still blocking running tasks and preserving unmerged worktrees", () => {
    const repo = initTempGitRepo();
    const store = createTempStore();
    const controller = new ConductorController({
      store,
      browser: createFakeBrowserManager(),
      onSnapshot: () => {},
    });
    const project = controller.registerProject(repo, "force-done-repo")!;

    const unmergedTask = makeTask({
      id: "task-force-unmerged",
      taskNumber: 40,
      title: "Unmerged worktree task",
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      status: "needs_review",
    });
    const runningTask = makeTask({
      id: "task-force-running",
      taskNumber: 41,
      title: "Running task",
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      status: "running",
      landStatus: "unlanded",
    });
    (controller as unknown as { tasks: AgentTask[] }).tasks = [unmergedTask, runningTask];

    const prov = controller.provisionWorktreeForTask(unmergedTask.id, project);
    fs.writeFileSync(path.join(prov.worktreePath!, "wip.ts"), "export const wip = true;\n", "utf8");

    // Normal Done is still blocked
    expect(controller.updateTaskStatus(unmergedTask.id, "done")).toEqual({
      ok: false,
      error: UNLANDED_TASK_DONE_BLOCKED_REASON,
    });

    // Force Done bypasses unlanded guard while preserving unmerged worktree on disk
    expect(controller.updateTaskStatus(unmergedTask.id, "done", { force: true })).toEqual({
      ok: true,
    });
    const afterForce = controller.getSnapshot().tasks.find((t) => t.id === unmergedTask.id)!;
    expect(afterForce.status).toBe("done");
    expect(fs.existsSync(prov.worktreePath!)).toBe(true);

    // Force Done MUST STILL block running tasks
    expect(controller.updateTaskStatus(runningTask.id, "done", { force: true })).toEqual({
      ok: false,
      error: RUNNING_TASK_DONE_BLOCKED_REASON,
    });
  });
});
