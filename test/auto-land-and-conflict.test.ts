import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserManager } from "../src/main/browser-manager.js";
import type { CliTurnCallbacks, RunningCliTurn } from "../src/main/cli-agent-runner.js";
import type { CodexAppServerClient, CodexNotification } from "../src/main/codex-client.js";
import {
  ConductorController,
  MAX_AUTO_CONFLICT_RESOLVE_ATTEMPTS,
  buildConflictResolutionPrompt,
} from "../src/main/conductor-controller.js";
import { createTaskWorktree, landTaskWorktree } from "../src/main/git-worktree.js";
import { StateStore } from "../src/main/state-store.js";
import type { AgentTask, Project } from "../src/shared/types.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initGitRepo(branch = "main"): string {
  const dir = makeTempDir("conductor-autoland-repo-");
  git(dir, ["init", "-b", branch]);
  git(dir, ["config", "user.name", "Test User"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(dir, "shared.txt"), "base line\n", "utf8");
  git(dir, ["add", "shared.txt"]);
  git(dir, ["commit", "-m", "initial commit"]);
  return dir;
}

function makeFakeBrowser(): BrowserManager {
  return {
    getTabs: () => [],
    getActiveTabId: () => null,
    getActiveTab: () => null,
    isPickingElement: () => false,
    restore: () => {},
  } as unknown as BrowserManager;
}

function createFakeWorkerClient() {
  let turnSeq = 0;
  let threadSeq = 0;
  let notificationListener: ((n: CodexNotification) => void) | null = null;
  const calls = {
    startThread: [] as Array<Record<string, unknown>>,
    resumeThread: [] as Array<Record<string, unknown>>,
    startTurn: [] as Array<Record<string, unknown>>,
  };

  const client = {
    label: "fake-worker",
    isConnected: () => true,
    onNotification: (listener: (n: CodexNotification) => void) => {
      notificationListener = listener;
      return () => {
        if (notificationListener === listener) notificationListener = null;
      };
    },
    onDisconnect: () => () => {},
    stop: () => {},
    startThread: async (opts: Record<string, unknown>) => {
      calls.startThread.push(opts);
      threadSeq += 1;
      return `fresh-thread-${threadSeq}`;
    },
    resumeThread: async (opts: Record<string, unknown>) => {
      calls.resumeThread.push(opts);
      return String(opts.threadId);
    },
    startTurn: async (opts: Record<string, unknown>) => {
      calls.startTurn.push(opts);
      turnSeq += 1;
      return `turn-${turnSeq}`;
    },
    interruptTurn: async () => {},
  };

  return {
    client: client as unknown as CodexAppServerClient,
    calls,
    emitNotification: (n: CodexNotification) => notificationListener?.(n),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

function makeTaskFixture(
  project: Project,
  overrides: Partial<AgentTask> & { id: string; taskNumber: number; title: string },
): AgentTask {
  const now = new Date().toISOString();
  return {
    summary: "",
    projectId: project.id,
    projectName: project.name,
    projectPath: project.path,
    status: "running",
    provider: "agy",
    currentStep: "作業中...",
    workerThreadId: "session-orig-1",
    activeTurnId: null,
    previewURL: null,
    latestOutput: "Implemented feature cleanly.",
    activities: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("landTaskWorktree fast-forward compatibility & conflict parentHead", () => {
  it("skips rebase and fast-forwards cleanly when parentHead is already an ancestor after rebase resolution", () => {
    const repo = initGitRepo();
    const worktreesDir = makeTempDir("conductor-wt-");

    const wtA = createTaskWorktree({
      projectPath: repo,
      worktreesBaseDir: worktreesDir,
      taskId: "rebA1111",
      taskNumber: 1,
    });
    const wtB = createTaskWorktree({
      projectPath: repo,
      worktreesBaseDir: worktreesDir,
      taskId: "rebB2222",
      taskNumber: 2,
    });

    fs.writeFileSync(path.join(wtA.worktreePath!, "shared.txt"), "change from A\n", "utf8");
    fs.writeFileSync(path.join(wtB.worktreePath!, "shared.txt"), "change from B\n", "utf8");

    const landA = landTaskWorktree({
      parentPath: repo,
      worktreePath: wtA.worktreePath!,
      worktreeBranch: wtA.worktreeBranch!,
      baseBranch: wtA.baseBranch,
      baseCommit: wtA.baseCommit,
      taskTitle: "Task A",
      taskNumber: 1,
      taskId: "rebA1111",
      mode: "feature-branch",
    });
    expect(landA.ok).toBe(true);
    const parentHeadAfterA = git(repo, ["rev-parse", "HEAD"]);

    // First attempt to land B conflicts and returns exact parentHead SHA
    const conflictRes = landTaskWorktree({
      parentPath: repo,
      worktreePath: wtB.worktreePath!,
      worktreeBranch: wtB.worktreeBranch!,
      baseBranch: wtB.baseBranch,
      baseCommit: wtB.baseCommit,
      taskTitle: "Task B",
      taskNumber: 2,
      taskId: "rebB2222",
      mode: "feature-branch",
    });
    expect(conflictRes.ok).toBe(false);
    expect(conflictRes.action).toBe("conflict");
    expect(conflictRes.parentHead).toBe(parentHeadAfterA);
    expect(conflictRes.conflictFiles).toContain("shared.txt");

    // Simulate worker resolving conflict via git rebase <parentHead> inside the worktree
    try {
      git(wtB.worktreePath!, ["rebase", conflictRes.parentHead!]);
    } catch {
      // Expected rebase conflict pause
    }
    fs.writeFileSync(
      path.join(wtB.worktreePath!, "shared.txt"),
      "change from A\nchange from B\n",
      "utf8",
    );
    git(wtB.worktreePath!, ["add", "shared.txt"]);
    execFileSync("git", ["-C", wtB.worktreePath!, "rebase", "--continue"], {
      env: { ...process.env, GIT_EDITOR: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Re-running landTaskWorktree skips Step 5 rebase and fast-forwards directly
    const landB = landTaskWorktree({
      parentPath: repo,
      worktreePath: wtB.worktreePath!,
      worktreeBranch: wtB.worktreeBranch!,
      baseBranch: wtB.baseBranch,
      baseCommit: wtB.baseCommit,
      taskTitle: "Task B",
      taskNumber: 2,
      taskId: "rebB2222",
      mode: "feature-branch",
    });
    expect(landB.ok).toBe(true);
    expect(landB.action).toBe("landed");
    expect(fs.readFileSync(path.join(repo, "shared.txt"), "utf8")).toBe(
      "change from A\nchange from B\n",
    );
    expect(fs.existsSync(wtB.worktreePath!)).toBe(false);
  });

  it("skips rebase and fast-forwards cleanly when parentHead is already an ancestor after merge resolution", () => {
    const repo = initGitRepo();
    const worktreesDir = makeTempDir("conductor-wt-");

    const wtA = createTaskWorktree({
      projectPath: repo,
      worktreesBaseDir: worktreesDir,
      taskId: "mrgA1111",
      taskNumber: 1,
    });
    const wtB = createTaskWorktree({
      projectPath: repo,
      worktreesBaseDir: worktreesDir,
      taskId: "mrgB2222",
      taskNumber: 2,
    });

    fs.writeFileSync(path.join(wtA.worktreePath!, "shared.txt"), "merge A\n", "utf8");
    fs.writeFileSync(path.join(wtB.worktreePath!, "shared.txt"), "merge B\n", "utf8");

    const landA = landTaskWorktree({
      parentPath: repo,
      worktreePath: wtA.worktreePath!,
      worktreeBranch: wtA.worktreeBranch!,
      baseBranch: wtA.baseBranch,
      baseCommit: wtA.baseCommit,
      taskTitle: "Merge A",
      taskNumber: 1,
      taskId: "mrgA1111",
      mode: "direct",
    });
    expect(landA.ok).toBe(true);
    const parentHeadAfterA = git(repo, ["rev-parse", "HEAD"]);

    // First attempt conflicts
    const conflictRes = landTaskWorktree({
      parentPath: repo,
      worktreePath: wtB.worktreePath!,
      worktreeBranch: wtB.worktreeBranch!,
      baseBranch: wtB.baseBranch,
      baseCommit: wtB.baseCommit,
      taskTitle: "Merge B",
      taskNumber: 2,
      taskId: "mrgB2222",
      mode: "direct",
    });
    expect(conflictRes.ok).toBe(false);
    expect(conflictRes.action).toBe("conflict");
    expect(conflictRes.parentHead).toBe(parentHeadAfterA);

    // Simulate worker resolving conflict via git merge <parentHead> (creating a merge commit)
    try {
      git(wtB.worktreePath!, ["merge", conflictRes.parentHead!]);
    } catch {
      // Expected merge conflict
    }
    fs.writeFileSync(path.join(wtB.worktreePath!, "shared.txt"), "merge A\nmerge B\n", "utf8");
    git(wtB.worktreePath!, ["add", "shared.txt"]);
    git(wtB.worktreePath!, ["commit", "-m", "Resolve merge conflict keeping both A and B"]);

    // Verify merge commit actually has 2 parents (proving rebase was skipped instead of flattening)
    const parentsBeforeLand = git(wtB.worktreePath!, ["rev-list", "--parents", "-n", "1", "HEAD"])
      .split(" ")
      .slice(1);
    expect(parentsBeforeLand).toHaveLength(2);

    const landB = landTaskWorktree({
      parentPath: repo,
      worktreePath: wtB.worktreePath!,
      worktreeBranch: wtB.worktreeBranch!,
      baseBranch: wtB.baseBranch,
      baseCommit: wtB.baseCommit,
      taskTitle: "Merge B",
      taskNumber: 2,
      taskId: "mrgB2222",
      mode: "direct",
    });
    expect(landB.ok).toBe(true);
    expect(landB.action).toBe("landed");
    expect(landB.targetBranch).toBe("main");
    expect(fs.readFileSync(path.join(repo, "shared.txt"), "utf8")).toBe("merge A\nmerge B\n");
    expect(fs.existsSync(wtB.worktreePath!)).toBe(false);
  });
});

describe("Auto-Land on worker completion & AI conflict self-resolution", () => {
  it("persists autoLandOnComplete (defaulting to true) and auto-lands on successful CLI & Codex completion in feature-branch and direct modes", async () => {
    const repo = initGitRepo();
    const storeDir = makeTempDir("conductor-store-");
    const store = new StateStore(storeDir);

    const agyCalls: Array<{
      opts: { cwd: string; prompt: string; conversationId?: string | null };
      callbacks: CliTurnCallbacks;
    }> = [];
    const fakeCodex = createFakeWorkerClient();

    const controller = new ConductorController({
      store,
      browser: makeFakeBrowser(),
      onSnapshot: () => {},
      workerClient: fakeCodex.client,
      cliWorkerRunner: {
        runAgyTurn: (opts, callbacks): RunningCliTurn => {
          agyCalls.push({ opts, callbacks });
          return { cancel: () => {} };
        },
      },
    });

    // Default ON + persists toggle
    expect(controller.getSnapshot().autoLandOnComplete).toBe(true);
    controller.setAutoLandOnComplete(false);
    expect(controller.getSnapshot().autoLandOnComplete).toBe(false);
    const reloaded = new ConductorController({
      store,
      browser: makeFakeBrowser(),
      onSnapshot: () => {},
    });
    expect(reloaded.getSnapshot().autoLandOnComplete).toBe(false);
    controller.setAutoLandOnComplete(true);

    const project = controller.registerProject(repo, "auto-repo")!;
    expect(project).not.toBeNull();

    // 1. CLI (AGY) worker completion in feature-branch mode triggers Auto-Land
    const cliTask = makeTaskFixture(project, {
      id: "task-cli-1",
      taskNumber: 1,
      title: "Add Login Form",
      provider: "agy",
      status: "queued",
      latestOutput: "",
    });
    store.save({ ...store.load(), tasks: [cliTask] });

    const ctrl2 = new ConductorController({
      store,
      browser: makeFakeBrowser(),
      onSnapshot: () => {},
      workerClient: fakeCodex.client,
      cliWorkerRunner: {
        runAgyTurn: (opts, callbacks): RunningCliTurn => {
          agyCalls.push({ opts, callbacks });
          return { cancel: () => {} };
        },
      },
    });
    const provCli = ctrl2.provisionWorktreeForTask(cliTask.id, project);
    expect(provCli.created).toBe(true);
    fs.writeFileSync(path.join(provCli.worktreePath!, "login.ts"), "export const login = true;\n");

    await ctrl2.sendToTaskWorker(cliTask.id, "Implement login form");
    expect(agyCalls).toHaveLength(1);
    agyCalls[0]!.callbacks.onComplete?.({ ok: true, finalText: "Login form implemented." });

    await waitFor(
      () => ctrl2.getSnapshot().tasks.find((t) => t.id === cliTask.id)?.landStatus === "landed",
    );

    const afterCli = ctrl2.getSnapshot().tasks.find((t) => t.id === cliTask.id)!;
    expect(afterCli.status).toBe("needs_review");
    expect(afterCli.landStatus).toBe("landed");
    expect(afterCli.landedBranch).toBe("conductor/add-login-form");
    expect(afterCli.autoResolveConflictAttempts).toBeUndefined();
    expect(fs.readFileSync(path.join(repo, "login.ts"), "utf8")).toBe(
      "export const login = true;\n",
    );
    const cliEvent = ctrl2
      .getSnapshot()
      .messages.find((m) => m.role === "taskEvent" && m.relatedTaskId === cliTask.id);
    expect(cliEvent?.text).toContain("✅ 自動 Land 完了: conductor/add-login-form");

    // 2. Codex worker completion in direct mode also triggers Auto-Land
    ctrl2.setDefaultIntegrationMode("direct");
    const codexTask = makeTaskFixture(project, {
      id: "task-codex-2",
      taskNumber: 2,
      title: "Add Metrics",
      provider: "codex",
      status: "running",
      workerThreadId: "codex-thr-2",
      activeTurnId: "codex-turn-2",
      latestOutput: "Added metrics module.",
    });
    store.save({ ...store.load(), tasks: [...ctrl2.getSnapshot().tasks, codexTask] });
    const ctrl3 = new ConductorController({
      store,
      browser: makeFakeBrowser(),
      onSnapshot: () => {},
      workerClient: fakeCodex.client,
    });
    const provCodex = ctrl3.provisionWorktreeForTask(codexTask.id, project);
    expect(provCodex.created).toBe(true);
    fs.writeFileSync(path.join(provCodex.worktreePath!, "metrics.ts"), "export const m = 1;\n");

    fakeCodex.emitNotification({
      method: "turn/completed",
      threadId: "codex-thr-2",
      turnId: "codex-turn-2",
      itemId: null,
      params: { turn: { status: "completed" } },
    });

    await waitFor(
      () => ctrl3.getSnapshot().tasks.find((t) => t.id === codexTask.id)?.landStatus === "landed",
    );
    const afterCodex = ctrl3.getSnapshot().tasks.find((t) => t.id === codexTask.id)!;
    expect(afterCodex.status).toBe("needs_review");
    expect(afterCodex.landStatus).toBe("landed");
    expect(fs.readFileSync(path.join(repo, "metrics.ts"), "utf8")).toBe("export const m = 1;\n");
    const codexEvent = ctrl3
      .getSnapshot()
      .messages.find((m) => m.role === "taskEvent" && m.relatedTaskId === codexTask.id);
    expect(codexEvent?.text).toContain("✅ 自動 Land 完了:");
  });

  it("skips auto-land when mode is per-task-pr OR when autoLandOnComplete is false", async () => {
    const repo = initGitRepo();
    const storeDir = makeTempDir("conductor-store-skip-");
    const store = new StateStore(storeDir);

    const agyCalls: Array<{ callbacks: CliTurnCallbacks }> = [];
    const controller = new ConductorController({
      store,
      browser: makeFakeBrowser(),
      onSnapshot: () => {},
      cliWorkerRunner: {
        runAgyTurn: (_opts, callbacks): RunningCliTurn => {
          agyCalls.push({ callbacks });
          return { cancel: () => {} };
        },
      },
    });
    const project = controller.registerProject(repo, "skip-repo")!;

    // Case A: per-task-pr mode with autoLandOnComplete = true
    controller.setDefaultIntegrationMode("per-task-pr");
    controller.setAutoLandOnComplete(true);
    const prTask = makeTaskFixture(project, {
      id: "task-pr-1",
      taskNumber: 1,
      title: "PR Only Task",
      provider: "agy",
      status: "queued",
    });
    store.save({ ...store.load(), tasks: [prTask] });

    const ctrlA = new ConductorController({
      store,
      browser: makeFakeBrowser(),
      onSnapshot: () => {},
      cliWorkerRunner: {
        runAgyTurn: (_opts, callbacks): RunningCliTurn => {
          agyCalls.push({ callbacks });
          return { cancel: () => {} };
        },
      },
    });
    const provPr = ctrlA.provisionWorktreeForTask(prTask.id, project);
    fs.writeFileSync(path.join(provPr.worktreePath!, "pr-only.txt"), "stay in wt\n");
    await ctrlA.sendToTaskWorker(prTask.id, "Do PR task");
    agyCalls.at(-1)!.callbacks.onComplete?.({ ok: true, finalText: "Done PR task." });

    const afterPr = ctrlA.getSnapshot().tasks.find((t) => t.id === prTask.id)!;
    expect(afterPr.status).toBe("needs_review");
    expect(afterPr.landStatus).toBe("unlanded");
    expect(fs.existsSync(provPr.worktreePath!)).toBe(true);
    expect(fs.existsSync(path.join(repo, "pr-only.txt"))).toBe(false);

    // Case B: feature-branch mode with autoLandOnComplete = false
    ctrlA.setDefaultIntegrationMode("feature-branch");
    ctrlA.setAutoLandOnComplete(false);
    const offTask = makeTaskFixture(project, {
      id: "task-off-2",
      taskNumber: 2,
      title: "Manual Land Task",
      provider: "agy",
      status: "queued",
    });
    store.save({ ...store.load(), tasks: [offTask] });

    const ctrlB = new ConductorController({
      store,
      browser: makeFakeBrowser(),
      onSnapshot: () => {},
      cliWorkerRunner: {
        runAgyTurn: (_opts, callbacks): RunningCliTurn => {
          agyCalls.push({ callbacks });
          return { cancel: () => {} };
        },
      },
    });
    const provOff = ctrlB.provisionWorktreeForTask(offTask.id, project);
    fs.writeFileSync(path.join(provOff.worktreePath!, "manual.txt"), "wait for manual\n");
    await ctrlB.sendToTaskWorker(offTask.id, "Do manual task");
    agyCalls.at(-1)!.callbacks.onComplete?.({ ok: true, finalText: "Done manual task." });

    const afterOff = ctrlB.getSnapshot().tasks.find((t) => t.id === offTask.id)!;
    expect(afterOff.status).toBe("needs_review");
    expect(afterOff.landStatus).toBe("unlanded");
    expect(fs.existsSync(provOff.worktreePath!)).toBe(true);
    expect(fs.existsSync(path.join(repo, "manual.txt"))).toBe(false);
  });

  it("self-resolves a rebase conflict by resuming the worker session and auto-re-landing cleanly", async () => {
    const repo = initGitRepo();
    const storeDir = makeTempDir("conductor-store-resolve-");
    const store = new StateStore(storeDir);

    const agyRuns: Array<{
      opts: { cwd: string; prompt: string; conversationId?: string | null };
      callbacks: CliTurnCallbacks;
    }> = [];

    const setupCtrl = new ConductorController({
      store,
      browser: makeFakeBrowser(),
      onSnapshot: () => {},
    });
    const project = setupCtrl.registerProject(repo, "conflict-repo")!;
    setupCtrl.setPreferredLanguage("ja");

    // Task A and Task B both branch from initial commit and touch shared.txt
    const taskA = makeTaskFixture(project, {
      id: "task-a",
      taskNumber: 1,
      title: "Task A",
      provider: "agy",
      status: "queued",
      workerThreadId: "sess-a",
    });
    const taskB = makeTaskFixture(project, {
      id: "task-b",
      taskNumber: 2,
      title: "Task B",
      provider: "agy",
      status: "queued",
      workerThreadId: "sess-b",
    });
    store.save({ ...store.load(), tasks: [taskA, taskB] });

    const ctrl = new ConductorController({
      store,
      browser: makeFakeBrowser(),
      onSnapshot: () => {},
      cliWorkerRunner: {
        runAgyTurn: (opts, callbacks): RunningCliTurn => {
          agyRuns.push({ opts, callbacks });
          return { cancel: () => {} };
        },
      },
    });

    const provA = ctrl.provisionWorktreeForTask(taskA.id, project);
    const provB = ctrl.provisionWorktreeForTask(taskB.id, project);

    fs.writeFileSync(path.join(provA.worktreePath!, "shared.txt"), "from A\n", "utf8");
    fs.writeFileSync(path.join(provB.worktreePath!, "shared.txt"), "from B\n", "utf8");

    // Land Task A first via manual landTask
    const landARes = await ctrl.landTask(taskA.id);
    expect(landARes.ok).toBe(true);
    const parentHeadAfterA = git(repo, ["rev-parse", "HEAD"]);

    // Run Task B and complete -> triggers auto-land -> conflict -> auto-launches self-resolution turn 1/2!
    await ctrl.sendToTaskWorker(taskB.id, "Implement Task B");
    expect(agyRuns).toHaveLength(1);
    agyRuns[0]!.callbacks.onComplete?.({ ok: true, finalText: "Task B done." });

    await waitFor(() => agyRuns.length === 2);

    const resolveRun = agyRuns[1]!;
    expect(resolveRun.opts.cwd).toBe(provB.worktreePath);
    expect(resolveRun.opts.conversationId).toBe("sess-b");
    expect(resolveRun.opts.prompt).toContain("conductor/task-a");
    expect(resolveRun.opts.prompt).toContain(parentHeadAfterA);
    expect(resolveRun.opts.prompt).toContain("shared.txt");
    expect(resolveRun.opts.prompt).toContain("日本語");

    const midTaskB = ctrl.getSnapshot().tasks.find((t) => t.id === taskB.id)!;
    expect(midTaskB.status).toBe("running");
    expect(midTaskB.autoResolveConflictAttempts).toBe(1);
    expect(midTaskB.currentStep).toContain("コンフリクトを自力解消中... (1/2)");
    expect(
      midTaskB.activities.some((a) =>
        a.title.includes("自動Landでコンフリクト検出 → ワーカーが自力解消を実行"),
      ),
    ).toBe(true);

    // Simulate worker resolving the conflict via merge inside its isolated worktree
    try {
      git(provB.worktreePath!, ["merge", parentHeadAfterA]);
    } catch {
      // expected conflict
    }
    fs.writeFileSync(path.join(provB.worktreePath!, "shared.txt"), "from A\nfrom B\n", "utf8");
    git(provB.worktreePath!, ["add", "shared.txt"]);
    git(provB.worktreePath!, ["commit", "-m", "Resolved conflict keeping both A and B"]);

    // Complete self-resolution turn -> auto re-land succeeds!
    resolveRun.callbacks.onComplete?.({ ok: true, finalText: "コンフリクトを解消しました。" });

    await waitFor(
      () => ctrl.getSnapshot().tasks.find((t) => t.id === taskB.id)?.landStatus === "landed",
    );

    const finalTaskB = ctrl.getSnapshot().tasks.find((t) => t.id === taskB.id)!;
    expect(finalTaskB.status).toBe("needs_review");
    expect(finalTaskB.landStatus).toBe("landed");
    expect(finalTaskB.autoResolveConflictAttempts).toBeUndefined();
    expect(fs.readFileSync(path.join(repo, "shared.txt"), "utf8")).toBe("from A\nfrom B\n");
    expect(fs.existsSync(provB.worktreePath!)).toBe(false);

    const eventMsg = ctrl
      .getSnapshot()
      .messages.find((m) => m.role === "taskEvent" && m.relatedTaskId === taskB.id);
    expect(eventMsg?.text).toContain("✅ 自動 Land 完了: conductor/task-a");
  });

  it("caps auto conflict self-resolution at max 2 attempts without infinite looping, and supports manual resolveTaskConflictWithAI retry", async () => {
    const repo = initGitRepo();
    const storeDir = makeTempDir("conductor-store-cap-");
    const store = new StateStore(storeDir);

    const agyRuns: Array<{
      opts: { cwd: string; prompt: string; conversationId?: string | null };
      callbacks: CliTurnCallbacks;
    }> = [];

    const setupCtrl = new ConductorController({
      store,
      browser: makeFakeBrowser(),
      onSnapshot: () => {},
    });
    const project = setupCtrl.registerProject(repo, "cap-repo")!;

    const taskA = makeTaskFixture(project, {
      id: "cap-a",
      taskNumber: 1,
      title: "Cap A",
      provider: "agy",
      status: "queued",
    });
    const taskB = makeTaskFixture(project, {
      id: "cap-b",
      taskNumber: 2,
      title: "Cap B",
      provider: "agy",
      status: "queued",
      workerThreadId: "sess-cap-b",
    });
    store.save({ ...store.load(), tasks: [taskA, taskB] });

    const ctrl = new ConductorController({
      store,
      browser: makeFakeBrowser(),
      onSnapshot: () => {},
      cliWorkerRunner: {
        runAgyTurn: (opts, callbacks): RunningCliTurn => {
          agyRuns.push({ opts, callbacks });
          return { cancel: () => {} };
        },
      },
    });

    const provA = ctrl.provisionWorktreeForTask(taskA.id, project);
    const provB = ctrl.provisionWorktreeForTask(taskB.id, project);
    fs.writeFileSync(path.join(provA.worktreePath!, "shared.txt"), "alpha\n", "utf8");
    fs.writeFileSync(path.join(provB.worktreePath!, "shared.txt"), "beta\n", "utf8");
    await ctrl.landTask(taskA.id);
    const parentHeadAfterA = git(repo, ["rev-parse", "HEAD"]);

    // Initial worker finishes -> conflict -> triggers attempt 1/2
    await ctrl.sendToTaskWorker(taskB.id, "Implement Cap B");
    agyRuns[0]!.callbacks.onComplete?.({ ok: true, finalText: "Done." });
    await waitFor(() => agyRuns.length === 2);
    expect(ctrl.getSnapshot().tasks.find((t) => t.id === taskB.id)?.autoResolveConflictAttempts).toBe(
      1,
    );

    // Attempt 1 completes WITHOUT actually resolving conflict -> triggers attempt 2/2
    agyRuns[1]!.callbacks.onComplete?.({ ok: true, finalText: "Attempt 1 failed to integrate." });
    await waitFor(() => agyRuns.length === 3);
    expect(ctrl.getSnapshot().tasks.find((t) => t.id === taskB.id)?.autoResolveConflictAttempts).toBe(
      2,
    );
    expect(ctrl.getSnapshot().tasks.find((t) => t.id === taskB.id)?.currentStep).toContain("(2/2)");

    // Attempt 2 ALSO completes without resolving -> MUST stop retrying (no 4th run!)
    agyRuns[2]!.callbacks.onComplete?.({ ok: true, finalText: "Attempt 2 still conflicted." });
    await waitFor(
      () => ctrl.getSnapshot().tasks.find((t) => t.id === taskB.id)?.status === "needs_review",
    );

    // Give microtasks time to make sure no extra attempt fires
    await new Promise((r) => setTimeout(r, 50));
    expect(agyRuns).toHaveLength(1 + MAX_AUTO_CONFLICT_RESOLVE_ATTEMPTS);

    const exhaustedTask = ctrl.getSnapshot().tasks.find((t) => t.id === taskB.id)!;
    expect(exhaustedTask.status).toBe("needs_review");
    expect(exhaustedTask.landStatus).toBe("conflict");
    expect(exhaustedTask.conflictFiles).toContain("shared.txt");
    expect(exhaustedTask.landError).toBeTruthy();
    expect(fs.existsSync(provB.worktreePath!)).toBe(true);

    const exhaustedEvent = ctrl
      .getSnapshot()
      .messages.find((m) => m.role === "taskEvent" && m.relatedTaskId === taskB.id);
    expect(exhaustedEvent?.text).toContain("コンフリクト");
    expect(exhaustedEvent?.text).toContain("shared.txt");

    // Manual "AIでコンフリクト解消" resets counter and works even if autoLandOnComplete is OFF
    ctrl.setAutoLandOnComplete(false);
    const manualRes = await ctrl.resolveTaskConflictWithAI(taskB.id);
    expect(manualRes.ok).toBe(true);
    expect(agyRuns).toHaveLength(4);
    expect(ctrl.getSnapshot().tasks.find((t) => t.id === taskB.id)?.autoResolveConflictAttempts).toBe(
      1,
    );

    // Now resolve the conflict cleanly and complete the manually triggered run -> auto re-lands!
    try {
      git(provB.worktreePath!, ["merge", parentHeadAfterA]);
    } catch {
      // expected conflict
    }
    fs.writeFileSync(path.join(provB.worktreePath!, "shared.txt"), "alpha\nbeta\n", "utf8");
    git(provB.worktreePath!, ["add", "shared.txt"]);
    git(provB.worktreePath!, ["commit", "-m", "Manual AI trigger resolution"]);
    agyRuns[3]!.callbacks.onComplete?.({ ok: true, finalText: "Resolved." });

    await waitFor(
      () => ctrl.getSnapshot().tasks.find((t) => t.id === taskB.id)?.landStatus === "landed",
    );
    expect(fs.readFileSync(path.join(repo, "shared.txt"), "utf8")).toBe("alpha\nbeta\n");
  });

  it("stops cleanly and preserves conflict state when the self-resolution worker turn fails", async () => {
    const repo = initGitRepo();
    const storeDir = makeTempDir("conductor-store-fail-");
    const store = new StateStore(storeDir);

    const agyRuns: Array<{ callbacks: CliTurnCallbacks }> = [];

    const setupCtrl = new ConductorController({
      store,
      browser: makeFakeBrowser(),
      onSnapshot: () => {},
    });
    const project = setupCtrl.registerProject(repo, "fail-repo")!;
    const taskA = makeTaskFixture(project, {
      id: "fail-a",
      taskNumber: 1,
      title: "Fail A",
      provider: "agy",
      status: "queued",
    });
    const taskB = makeTaskFixture(project, {
      id: "fail-b",
      taskNumber: 2,
      title: "Fail B",
      provider: "agy",
      status: "queued",
    });
    store.save({ ...store.load(), tasks: [taskA, taskB] });

    const ctrl = new ConductorController({
      store,
      browser: makeFakeBrowser(),
      onSnapshot: () => {},
      cliWorkerRunner: {
        runAgyTurn: (_opts, callbacks): RunningCliTurn => {
          agyRuns.push({ callbacks });
          return { cancel: () => {} };
        },
      },
    });
    const provA = ctrl.provisionWorktreeForTask(taskA.id, project);
    const provB = ctrl.provisionWorktreeForTask(taskB.id, project);
    fs.writeFileSync(path.join(provA.worktreePath!, "shared.txt"), "A\n", "utf8");
    fs.writeFileSync(path.join(provB.worktreePath!, "shared.txt"), "B\n", "utf8");
    await ctrl.landTask(taskA.id);

    await ctrl.sendToTaskWorker(taskB.id, "Implement Fail B");
    agyRuns[0]!.callbacks.onComplete?.({ ok: true, finalText: "Done." });
    await waitFor(() => agyRuns.length === 2);

    // Emit streaming text first so resume-fallback doesn't fire, then fail the resolution turn
    agyRuns[1]!.callbacks.onTextDelta?.("Trying rebase...");
    agyRuns[1]!.callbacks.onComplete?.({
      ok: false,
      finalText: "",
      errorMessage: "Worker CLI crashed",
    });

    const afterFail = ctrl.getSnapshot().tasks.find((t) => t.id === taskB.id)!;
    expect(afterFail.status).toBe("needs_review");
    expect(afterFail.landStatus).toBe("conflict");
    expect(afterFail.conflictFiles).toContain("shared.txt");
    expect(fs.existsSync(provB.worktreePath!)).toBe(true);
    expect(agyRuns).toHaveLength(2);

    const failEvent = ctrl
      .getSnapshot()
      .messages.find((m) => m.role === "taskEvent" && m.relatedTaskId === taskB.id);
    expect(failEvent?.text).toContain("Worker CLI crashed");
  });

  it("does NOT trigger AI conflict self-resolution and never touches dirty parent repo on non-conflict errors", async () => {
    const repo = initGitRepo();
    const storeDir = makeTempDir("conductor-store-dirty-");
    const store = new StateStore(storeDir);

    const agyRuns: Array<{ callbacks: CliTurnCallbacks }> = [];

    const setupCtrl = new ConductorController({
      store,
      browser: makeFakeBrowser(),
      onSnapshot: () => {},
    });
    const project = setupCtrl.registerProject(repo, "dirty-repo")!;
    const task = makeTaskFixture(project, {
      id: "dirty-task-1",
      taskNumber: 1,
      title: "Clean Worker Task",
      provider: "agy",
      status: "queued",
    });
    store.save({ ...store.load(), tasks: [task] });

    const ctrl = new ConductorController({
      store,
      browser: makeFakeBrowser(),
      onSnapshot: () => {},
      cliWorkerRunner: {
        runAgyTurn: (_opts, callbacks): RunningCliTurn => {
          agyRuns.push({ callbacks });
          return { cancel: () => {} };
        },
      },
    });
    const prov = ctrl.provisionWorktreeForTask(task.id, project);
    fs.writeFileSync(path.join(prov.worktreePath!, "feature.ts"), "export const ok = 1;\n");

    // User has uncommitted WIP changes in the parent repo
    const userDirtyFile = path.join(repo, "user-wip.txt");
    fs.writeFileSync(userDirtyFile, "do not touch my wip\n", "utf8");

    await ctrl.sendToTaskWorker(task.id, "Add feature");
    expect(agyRuns).toHaveLength(1);
    agyRuns[0]!.callbacks.onComplete?.({ ok: true, finalText: "Feature done." });

    await waitFor(
      () => ctrl.getSnapshot().tasks.find((t) => t.id === task.id)?.landStatus === "error",
    );
    await new Promise((r) => setTimeout(r, 40));

    // Must NOT have launched any AI conflict resolution run
    expect(agyRuns).toHaveLength(1);

    const finalTask = ctrl.getSnapshot().tasks.find((t) => t.id === task.id)!;
    expect(finalTask.status).toBe("needs_review");
    expect(finalTask.landStatus).toBe("error");
    expect(finalTask.landError).toContain("未コミット");
    // Parent repo and user's dirty file remain 100% untouched
    expect(fs.readFileSync(userDirtyFile, "utf8")).toBe("do not touch my wip\n");
    expect(fs.existsSync(path.join(repo, "feature.ts"))).toBe(false);
    expect(fs.existsSync(prov.worktreePath!)).toBe(true);

    const errEvent = ctrl
      .getSnapshot()
      .messages.find((m) => m.role === "taskEvent" && m.relatedTaskId === task.id);
    expect(errEvent?.text).toContain("未コミット");
  });

  it("formats buildConflictResolutionPrompt with targetBranch, parentHead, conflictFiles, and language policy", () => {
    const prompt = buildConflictResolutionPrompt({
      taskTitle: "Add billing",
      worktreePath: "/tmp/wt/task-1",
      worktreeBranch: "conductor/task-1",
      targetBranch: "conductor/main-work",
      parentHead: "deadbeef12345678",
      conflictFiles: ["src/a.ts", "src/b.ts"],
      attempt: 1,
      preferredLanguage: "en",
    });

    expect(prompt).toContain("conductor/main-work");
    expect(prompt).toContain("deadbeef12345678");
    expect(prompt).toContain("src/a.ts");
    expect(prompt).toContain("src/b.ts");
    expect(prompt).toContain("git rebase deadbeef12345678");
    expect(prompt).toContain("git merge deadbeef12345678");
    expect(prompt).toContain("preserving BOTH");
    expect(prompt).toContain("Output Language (REQUIRED)");
    expect(prompt).toContain("clear English");
  });

  it("auto-marks task as landed when worktree has no diff (worker modified parent directly) or branch is already merged, even with dirty parent or autoLandOnComplete=false", async () => {
    const repo = initGitRepo();
    const storeDir = makeTempDir("conductor-store-reconcile-");
    const store = new StateStore(storeDir);

    const agyRuns: Array<{ callbacks: CliTurnCallbacks }> = [];
    const setupCtrl = new ConductorController({
      store,
      browser: makeFakeBrowser(),
      onSnapshot: () => {},
    });
    const project = setupCtrl.registerProject(repo, "reconcile-repo")!;

    const taskParentDirect = makeTaskFixture(project, {
      id: "task-parent-direct",
      taskNumber: 1,
      title: "Direct parent edit",
      provider: "agy",
      status: "queued",
    });
    const taskAlreadyMerged = makeTaskFixture(project, {
      id: "task-already-merged",
      taskNumber: 2,
      title: "Already merged manual off",
      provider: "agy",
      status: "queued",
    });
    store.save({ ...store.load(), tasks: [taskParentDirect, taskAlreadyMerged] });

    const ctrl = new ConductorController({
      store,
      browser: makeFakeBrowser(),
      onSnapshot: () => {},
      cliWorkerRunner: {
        runAgyTurn: (_opts, callbacks): RunningCliTurn => {
          agyRuns.push({ callbacks });
          return { cancel: () => {} };
        },
      },
    });

    // Task 1: Worker writes directly to parent repo (leaving parent dirty!) while worktree stays untouched
    const prov1 = ctrl.provisionWorktreeForTask(taskParentDirect.id, project);
    expect(prov1.created).toBe(true);
    fs.writeFileSync(path.join(repo, "parent-direct-file.txt"), "edited in parent\n", "utf8");

    await ctrl.sendToTaskWorker(taskParentDirect.id, "Edit parent directly");
    agyRuns[0]!.callbacks.onComplete?.({ ok: true, finalText: "Edited parent repo directly." });

    await waitFor(
      () => ctrl.getSnapshot().tasks.find((t) => t.id === taskParentDirect.id)?.landStatus === "landed",
    );
    const after1 = ctrl.getSnapshot().tasks.find((t) => t.id === taskParentDirect.id)!;
    expect(after1.status).toBe("needs_review");
    expect(after1.landStatus).toBe("landed");
    expect(after1.worktreePath).toBeNull();
    expect(after1.worktreeBranch).toBeNull();
    expect(fs.existsSync(prov1.worktreePath!)).toBe(false);
    // Done succeeds without getting stuck!
    expect(ctrl.updateTaskStatus(taskParentDirect.id, "done")).toEqual({ ok: true });

    // Clean parent file for Task 2 merge
    fs.rmSync(path.join(repo, "parent-direct-file.txt"));

    // Task 2: autoLandOnComplete = false, worker commits in worktree and merges into main before completing
    ctrl.setAutoLandOnComplete(false);
    const prov2 = ctrl.provisionWorktreeForTask(taskAlreadyMerged.id, project);
    expect(prov2.created).toBe(true);
    fs.writeFileSync(path.join(prov2.worktreePath!, "merged-in-turn.ts"), "export const x = 42;\n");
    git(prov2.worktreePath!, ["add", "merged-in-turn.ts"]);
    git(prov2.worktreePath!, ["commit", "-m", "Add merged-in-turn.ts"]);
    git(repo, ["merge", "--ff-only", prov2.worktreeBranch!]);

    await ctrl.sendToTaskWorker(taskAlreadyMerged.id, "Commit and merge");
    agyRuns[1]!.callbacks.onComplete?.({ ok: true, finalText: "Merged to main." });

    const after2 = ctrl.getSnapshot().tasks.find((t) => t.id === taskAlreadyMerged.id)!;
    expect(after2.status).toBe("needs_review");
    expect(after2.landStatus).toBe("landed");
    expect(after2.worktreePath).toBeNull();
    expect(after2.worktreeBranch).toBeNull();
    expect(fs.existsSync(prov2.worktreePath!)).toBe(false);
    expect(ctrl.updateTaskStatus(taskAlreadyMerged.id, "done")).toEqual({ ok: true });
  });
});
