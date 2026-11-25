import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserManager } from "../src/main/browser-manager.js";
import { ConductorController } from "../src/main/conductor-controller.js";
import {
  createTaskWorktree,
  inspectTaskWorktree,
  landTaskWorktree,
  removeTaskWorktree,
  resolveEffectiveIntegrationMode,
} from "../src/main/git-worktree.js";
import { StateStore } from "../src/main/state-store.js";

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

function initGitRepo(options?: { withInitialCommit?: boolean; branch?: string }): string {
  const dir = makeTempDir("conductor-repo-");
  const branch = options?.branch ?? "main";
  git(dir, ["init", "-b", branch]);
  git(dir, ["config", "user.name", "Test User"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  if (options?.withInitialCommit !== false) {
    fs.writeFileSync(path.join(dir, "README.md"), "# Initial Repo\n", "utf8");
    git(dir, ["add", "README.md"]);
    git(dir, ["commit", "-m", "initial commit"]);
  }
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

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Git Worktree Parallel Execution & Incremental Landing", () => {
  it("runs parallel worktrees A and B from main, auto-creates conductor/<slug> on A land, and rebases & lands B cleanly", () => {
    const repo = initGitRepo();
    const worktreesDir = makeTempDir("conductor-wt-");
    const m0 = git(repo, ["rev-parse", "HEAD"]);

    // Start Task A & Task B in parallel from main (M0)
    const wtA = createTaskWorktree({
      projectPath: repo,
      projectName: "demo-app",
      worktreesBaseDir: worktreesDir,
      taskId: "aaaa1111-0000-0000-0000-000000000001",
      taskNumber: 1,
    });
    const wtB = createTaskWorktree({
      projectPath: repo,
      projectName: "demo-app",
      worktreesBaseDir: worktreesDir,
      taskId: "bbbb2222-0000-0000-0000-000000000002",
      taskNumber: 2,
    });

    expect(wtA.created).toBe(true);
    expect(wtB.created).toBe(true);
    expect(wtA.worktreePath).not.toBe(wtB.worktreePath);
    expect(wtA.worktreeBranch).toBe("conductor/task-aaaa1111");
    expect(wtB.worktreeBranch).toBe("conductor/task-bbbb2222");
    expect(wtA.baseBranch).toBe("main");
    expect(wtA.baseCommit).toBe(m0);
    expect(wtB.baseCommit).toBe(m0);

    // Parent repo must stay completely clean (no untracked worktree files)
    expect(git(repo, ["status", "--porcelain"])).toBe("");

    // Worker A writes fileA.txt (leave uncommitted to verify auto-stage & commit on land!)
    fs.writeFileSync(path.join(wtA.worktreePath!, "fileA.txt"), "hello from A\n", "utf8");

    // Worker B writes and commits fileB.txt in parallel
    fs.writeFileSync(path.join(wtB.worktreePath!, "fileB.txt"), "hello from B\n", "utf8");
    git(wtB.worktreePath!, ["add", "fileB.txt"]);
    git(wtB.worktreePath!, ["commit", "-m", "Add fileB"]);

    // Verify inspectTaskWorktree reports dirty A and ahead B
    const statusA = inspectTaskWorktree({
      parentPath: repo,
      worktreePath: wtA.worktreePath,
      worktreeBranch: wtA.worktreeBranch,
      baseCommit: wtA.baseCommit,
      taskTitle: "Add Auth Flow",
      taskNumber: 1,
      taskId: "aaaa1111",
      effectiveMode: "feature-branch",
    });
    expect(statusA.worktreeDirty).toBe(true);
    expect(statusA.changedFilesCount).toBe(1);
    expect(statusA.suggestedTargetBranch).toBe("conductor/add-auth-flow");

    // Land Task A in feature-branch mode -> auto-creates conductor/add-auth-flow from main
    const landA = landTaskWorktree({
      parentPath: repo,
      worktreePath: wtA.worktreePath!,
      worktreeBranch: wtA.worktreeBranch!,
      baseBranch: wtA.baseBranch,
      baseCommit: wtA.baseCommit,
      taskTitle: "Add Auth Flow",
      taskNumber: 1,
      taskId: "aaaa1111",
      mode: "feature-branch",
    });

    expect(landA.ok).toBe(true);
    expect(landA.action).toBe("landed");
    expect(landA.targetBranch).toBe("conductor/add-auth-flow");
    expect(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("conductor/add-auth-flow");
    expect(fs.readFileSync(path.join(repo, "fileA.txt"), "utf8")).toBe("hello from A\n");
    expect(fs.existsSync(path.join(repo, "fileB.txt"))).toBe(false);
    // main remains untouched at M0
    expect(git(repo, ["rev-parse", "main"])).toBe(m0);
    // Worktree A and temporary task branch cleaned up
    expect(fs.existsSync(wtA.worktreePath!)).toBe(false);
    expect(git(repo, ["branch", "--list", wtA.worktreeBranch!])).toBe("");

    // Now Land Task B -> should rebase onto A1 and advance conductor/add-auth-flow
    const landB = landTaskWorktree({
      parentPath: repo,
      worktreePath: wtB.worktreePath!,
      worktreeBranch: wtB.worktreeBranch!,
      baseBranch: wtB.baseBranch,
      baseCommit: wtB.baseCommit,
      taskTitle: "Add Metrics Panel",
      taskNumber: 2,
      taskId: "bbbb2222",
      mode: "feature-branch",
    });

    expect(landB.ok).toBe(true);
    expect(landB.action).toBe("landed");
    expect(landB.targetBranch).toBe("conductor/add-auth-flow");
    expect(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("conductor/add-auth-flow");
    expect(fs.readFileSync(path.join(repo, "fileA.txt"), "utf8")).toBe("hello from A\n");
    expect(fs.readFileSync(path.join(repo, "fileB.txt"), "utf8")).toBe("hello from B\n");
    // Linear history: M0 -> A1 -> B1'
    expect(git(repo, ["rev-list", "--count", `main..conductor/add-auth-flow`])).toBe("2");
    expect(fs.existsSync(wtB.worktreePath!)).toBe(false);
    expect(git(repo, ["branch", "--list", wtB.worktreeBranch!])).toBe("");
    expect(git(repo, ["status", "--porcelain"])).toBe("");
  });

  it("detects rebase conflict, aborts cleanly without breaking parent repo or worktree, and guards dirty parent", () => {
    const repo = initGitRepo();
    const worktreesDir = makeTempDir("conductor-wt-");
    fs.writeFileSync(path.join(repo, "shared.txt"), "line 1\n", "utf8");
    git(repo, ["add", "shared.txt"]);
    git(repo, ["commit", "-m", "add shared.txt"]);

    const wtA = createTaskWorktree({
      projectPath: repo,
      worktreesBaseDir: worktreesDir,
      taskId: "conf1111",
      taskNumber: 1,
    });
    const wtB = createTaskWorktree({
      projectPath: repo,
      worktreesBaseDir: worktreesDir,
      taskId: "conf2222",
      taskNumber: 2,
    });

    // Both A and B edit shared.txt conflictingly
    fs.writeFileSync(path.join(wtA.worktreePath!, "shared.txt"), "from task A\n", "utf8");
    fs.writeFileSync(path.join(wtB.worktreePath!, "shared.txt"), "from task B\n", "utf8");

    // Guard against dirty parent working tree first
    fs.writeFileSync(path.join(repo, "dirty.txt"), "uncommitted\n", "utf8");
    const dirtyRes = landTaskWorktree({
      parentPath: repo,
      worktreePath: wtA.worktreePath!,
      worktreeBranch: wtA.worktreeBranch!,
      baseBranch: wtA.baseBranch,
      baseCommit: wtA.baseCommit,
      taskTitle: "Task A",
      taskNumber: 1,
      taskId: "conf1111",
      mode: "feature-branch",
    });
    expect(dirtyRes.ok).toBe(false);
    expect(dirtyRes.action).toBe("error");
    expect(dirtyRes.message).toContain("未コミット");
    // Parent stays on main and worktree A still exists
    expect(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(fs.existsSync(wtA.worktreePath!)).toBe(true);

    // Clean parent and land A successfully
    fs.rmSync(path.join(repo, "dirty.txt"));
    const landA = landTaskWorktree({
      parentPath: repo,
      worktreePath: wtA.worktreePath!,
      worktreeBranch: wtA.worktreeBranch!,
      baseBranch: wtA.baseBranch,
      baseCommit: wtA.baseCommit,
      taskTitle: "Task A",
      taskNumber: 1,
      taskId: "conf1111",
      mode: "feature-branch",
    });
    expect(landA.ok).toBe(true);
    const parentHeadAfterA = git(repo, ["rev-parse", "HEAD"]);

    // Land B -> must conflict and abort cleanly
    const landB = landTaskWorktree({
      parentPath: repo,
      worktreePath: wtB.worktreePath!,
      worktreeBranch: wtB.worktreeBranch!,
      baseBranch: wtB.baseBranch,
      baseCommit: wtB.baseCommit,
      taskTitle: "Task B",
      taskNumber: 2,
      taskId: "conf2222",
      mode: "feature-branch",
    });

    expect(landB.ok).toBe(false);
    expect(landB.action).toBe("conflict");
    expect(landB.conflictFiles).toContain("shared.txt");
    // Parent repo is completely untouched and clean
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(parentHeadAfterA);
    expect(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("conductor/task-a");
    expect(git(repo, ["status", "--porcelain"])).toBe("");
    // Worktree B is also cleanly restored (not stuck mid-rebase)
    expect(fs.existsSync(wtB.worktreePath!)).toBe(true);
    expect(git(wtB.worktreePath!, ["status", "--porcelain"])).toBe("");
    expect(fs.readFileSync(path.join(wtB.worktreePath!, "shared.txt"), "utf8")).toBe(
      "from task B\n",
    );

    // Cleanup B
    removeTaskWorktree({
      parentPath: repo,
      worktreePath: wtB.worktreePath,
      worktreeBranch: wtB.worktreeBranch,
      deleteBranch: true,
    });
  });

  it("lands directly onto main in direct mode and cleans up worktree", () => {
    const repo = initGitRepo();
    const worktreesDir = makeTempDir("conductor-wt-");

    const wt = createTaskWorktree({
      projectPath: repo,
      worktreesBaseDir: worktreesDir,
      taskId: "dir12345",
      taskNumber: 1,
    });
    expect(wt.created).toBe(true);

    fs.writeFileSync(path.join(wt.worktreePath!, "direct.txt"), "direct land\n", "utf8");

    const res = landTaskWorktree({
      parentPath: repo,
      worktreePath: wt.worktreePath!,
      worktreeBranch: wt.worktreeBranch!,
      baseBranch: wt.baseBranch,
      baseCommit: wt.baseCommit,
      taskTitle: "Direct hotfix",
      taskNumber: 1,
      taskId: "dir12345",
      mode: "direct",
    });

    expect(res.ok).toBe(true);
    expect(res.action).toBe("landed");
    expect(res.targetBranch).toBe("main");
    expect(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(fs.readFileSync(path.join(repo, "direct.txt"), "utf8")).toBe("direct land\n");
    expect(fs.existsSync(wt.worktreePath!)).toBe(false);
    expect(git(repo, ["branch", "--list", wt.worktreeBranch!])).toBe("");
  });

  it("pushes task branch to remote without merging into parent repo in per-task-pr mode", () => {
    const bareRemote = makeTempDir("conductor-remote-");
    git(bareRemote, ["init", "--bare"]);

    const repo = initGitRepo();
    git(repo, ["remote", "add", "origin", bareRemote]);
    git(repo, ["push", "-u", "origin", "main"]);
    const m0 = git(repo, ["rev-parse", "HEAD"]);

    const worktreesDir = makeTempDir("conductor-wt-");
    const wt = createTaskWorktree({
      projectPath: repo,
      worktreesBaseDir: worktreesDir,
      taskId: "pr123456",
      taskNumber: 3,
    });
    expect(wt.created).toBe(true);

    fs.writeFileSync(path.join(wt.worktreePath!, "pr-feature.txt"), "PR content\n", "utf8");

    const res = landTaskWorktree({
      parentPath: repo,
      worktreePath: wt.worktreePath!,
      worktreeBranch: wt.worktreeBranch!,
      baseBranch: wt.baseBranch,
      baseCommit: wt.baseCommit,
      taskTitle: "PR feature",
      taskNumber: 3,
      taskId: "pr123456",
      mode: "per-task-pr",
      createPr: false,
    });

    expect(res.ok).toBe(true);
    expect(res.action).toBe("pushed");
    expect(res.targetBranch).toBe("conductor/task-pr123456");
    // Parent repo is NOT merged and stays on main at M0
    expect(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(m0);
    expect(fs.existsSync(path.join(repo, "pr-feature.txt"))).toBe(false);
    // Remote bare repo received the branch!
    const remoteRef = git(bareRemote, ["rev-parse", `refs/heads/${wt.worktreeBranch!}`]);
    expect(remoteRef).toBe(res.commitHash);
    // Worktree & branch are kept intact in per-task-pr mode
    expect(fs.existsSync(wt.worktreePath!)).toBe(true);
  });

  it("detects no-op worktree cleanly and falls back gracefully for non-git or zero-commit repos", () => {
    const worktreesDir = makeTempDir("conductor-wt-");

    // 1. Non-git directory fallback
    const plainDir = makeTempDir("conductor-plain-");
    const nonGitRes = createTaskWorktree({
      projectPath: plainDir,
      worktreesBaseDir: worktreesDir,
      taskId: "nongit01",
    });
    expect(nonGitRes.created).toBe(false);
    expect(nonGitRes.reason).toBe("not_git_repo");
    expect(nonGitRes.cwd).toBe(fs.realpathSync(plainDir));

    // 2. Git repo with zero commits fallback
    const emptyRepo = initGitRepo({ withInitialCommit: false });
    const emptyRes = createTaskWorktree({
      projectPath: emptyRepo,
      worktreesBaseDir: worktreesDir,
      taskId: "empty001",
    });
    expect(emptyRes.created).toBe(false);
    expect(emptyRes.reason).toBe("no_commits");
    expect(emptyRes.cwd).toBe(fs.realpathSync(emptyRepo));

    // 3. No-op land on valid git repo with no changes
    const validRepo = initGitRepo();
    const wt = createTaskWorktree({
      projectPath: validRepo,
      worktreesBaseDir: worktreesDir,
      taskId: "noop1234",
    });
    expect(wt.created).toBe(true);
    const noopRes = landTaskWorktree({
      parentPath: validRepo,
      worktreePath: wt.worktreePath!,
      worktreeBranch: wt.worktreeBranch!,
      baseBranch: wt.baseBranch,
      baseCommit: wt.baseCommit,
      taskTitle: "No-op task",
      taskNumber: 1,
      taskId: "noop1234",
      mode: "feature-branch",
    });
    expect(noopRes.ok).toBe(true);
    expect(noopRes.action).toBe("noop");
    expect(git(validRepo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(fs.existsSync(wt.worktreePath!)).toBe(false);
  });

  it("resolves integration mode priority (UI override > .conductor.json > global default) and integrates with ConductorController", async () => {
    const repo = initGitRepo();
    fs.writeFileSync(
      path.join(repo, ".conductor.json"),
      JSON.stringify({ integrationMode: "direct" }),
      "utf8",
    );
    git(repo, ["add", ".conductor.json"]);
    git(repo, ["commit", "-m", "add project config"]);

    expect(
      resolveEffectiveIntegrationMode({
        projectMode: undefined,
        projectPath: repo,
        globalDefault: "feature-branch",
      }),
    ).toBe("direct");

    expect(
      resolveEffectiveIntegrationMode({
        projectMode: "per-task-pr",
        projectPath: repo,
        globalDefault: "feature-branch",
      }),
    ).toBe("per-task-pr");

    // End-to-end ConductorController test: settings persistence, provisioning, landing, and deletion cleanup
    const dataDir = makeTempDir("conductor-store-");
    const store = new StateStore(dataDir);
    const controller = new ConductorController({
      store,
      browser: makeFakeBrowser(),
      onSnapshot: () => {},
    });

    expect(controller.getSnapshot().defaultIntegrationMode).toBe("feature-branch");
    controller.setDefaultIntegrationMode("per-task-pr");
    expect(controller.getSnapshot().defaultIntegrationMode).toBe("per-task-pr");

    const project = controller.registerProject(repo, "config-repo")!;
    expect(project).not.toBeNull();
    // .conductor.json specifies "direct"
    expect(controller.getEffectiveIntegrationModeForProject(project.id, project.path)).toBe(
      "direct",
    );
    // UI override takes precedence over .conductor.json
    controller.setProjectIntegrationMode(project.id, "feature-branch");
    expect(controller.getEffectiveIntegrationModeForProject(project.id, project.path)).toBe(
      "feature-branch",
    );

    // Reload persisted state in a new controller instance
    const reloadedController = new ConductorController({
      store,
      browser: makeFakeBrowser(),
      onSnapshot: () => {},
    });
    expect(reloadedController.getSnapshot().defaultIntegrationMode).toBe("per-task-pr");
    const reloadedProj = reloadedController.getSnapshot().projects.find((p) => p.id === project.id);
    expect(reloadedProj?.integrationMode).toBe("feature-branch");

    // Create a task via StateStore / controller and test deleteTask cleans up orphaned worktree
    const task = {
      id: "task-del-1",
      taskNumber: 1,
      title: "Temporary Task",
      summary: "",
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      status: "needs_review" as const,
      currentStep: null,
      workerThreadId: null,
      activeTurnId: null,
      previewURL: null,
      latestOutput: "",
      activities: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.save({ ...store.load(), tasks: [task] });

    const ctrl2 = new ConductorController({
      store,
      browser: makeFakeBrowser(),
      onSnapshot: () => {},
    });
    const provisioned = ctrl2.provisionWorktreeForTask(task.id, reloadedProj!);
    expect(provisioned.created).toBe(true);
    expect(fs.existsSync(provisioned.worktreePath!)).toBe(true);

    // Delete task should remove the orphaned worktree and temporary task branch
    await ctrl2.deleteTask(task.id);
    expect(fs.existsSync(provisioned.worktreePath!)).toBe(false);
    expect(git(repo, ["branch", "--list", provisioned.worktreeBranch!])).toBe("");
  });
});
