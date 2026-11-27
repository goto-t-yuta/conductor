import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserManager } from "../src/main/browser-manager.js";
import { ConductorController } from "../src/main/conductor-controller.js";
import {
  createTaskWorktree,
  evaluateWorktreeLandState,
  findOverlappingParentDirtyPaths,
  inspectTaskWorktree,
  landTaskWorktree,
  parsePorcelainStatusZ,
  pathsOverlap,
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

    // Guard against overlapping dirty file in parent working tree first
    fs.writeFileSync(path.join(repo, "shared.txt"), "local parent uncommitted edit\n", "utf8");
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
    expect(dirtyRes.message).toContain("shared.txt");
    // Parent stays on main, local edit is preserved, and worktree A still exists
    expect(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(fs.readFileSync(path.join(repo, "shared.txt"), "utf8")).toBe(
      "local parent uncommitted edit\n",
    );
    expect(fs.existsSync(wtA.worktreePath!)).toBe(true);

    // Restore overlapping parent edit and land A successfully
    git(repo, ["checkout", "--", "shared.txt"]);
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

  it("auto-detects worktree branch already merged into parent/base branch (even when parent is dirty) and cleans up safely", () => {
    const repo = initGitRepo();
    const worktreesDir = makeTempDir("conductor-wt-merged-");

    // Case 1: Merged into parent's current branch via --no-ff merge commit, AND parent repo has dirty WIP files
    const wt1 = createTaskWorktree({
      projectPath: repo,
      worktreesBaseDir: worktreesDir,
      taskId: "merged01",
      taskNumber: 1,
    });
    expect(wt1.created).toBe(true);
    fs.writeFileSync(path.join(wt1.worktreePath!, "merged-feature.ts"), "export const v = 1;\n", "utf8");
    git(wt1.worktreePath!, ["add", "merged-feature.ts"]);
    git(wt1.worktreePath!, ["commit", "-m", "Implement merged feature"]);

    // Manually merge worktreeBranch into main, then leave unrelated dirty file in parent repo
    git(repo, ["merge", "--no-ff", wt1.worktreeBranch!, "-m", "Merge task branch into main"]);
    fs.writeFileSync(path.join(repo, "unrelated-wip.txt"), "wip\n", "utf8");

    const eval1 = evaluateWorktreeLandState({
      parentPath: repo,
      worktreePath: wt1.worktreePath,
      worktreeBranch: wt1.worktreeBranch,
      baseBranch: wt1.baseBranch,
      baseCommit: wt1.baseCommit,
    });
    expect(eval1.alreadyMerged).toBe(true);
    expect(eval1.reason).toBe("merged_into_parent");

    const land1 = landTaskWorktree({
      parentPath: repo,
      worktreePath: wt1.worktreePath!,
      worktreeBranch: wt1.worktreeBranch!,
      baseBranch: wt1.baseBranch,
      baseCommit: wt1.baseCommit,
      taskTitle: "Merged Feature",
      taskNumber: 1,
      taskId: "merged01",
      mode: "feature-branch",
    });
    expect(land1.ok).toBe(true);
    expect(land1.action).toBe("landed");
    expect(land1.targetBranch).toBe("main");
    expect(fs.existsSync(wt1.worktreePath!)).toBe(false);
    expect(git(repo, ["branch", "--list", wt1.worktreeBranch!])).toBe("");
    // Parent repo dirty file stays untouched
    expect(fs.readFileSync(path.join(repo, "unrelated-wip.txt"), "utf8")).toBe("wip\n");
    fs.rmSync(path.join(repo, "unrelated-wip.txt"));

    // Case 2: Merged into baseBranch (main) while parent repo switched to another branch
    const wt2 = createTaskWorktree({
      projectPath: repo,
      worktreesBaseDir: worktreesDir,
      taskId: "merged02",
      taskNumber: 2,
    });
    fs.writeFileSync(path.join(wt2.worktreePath!, "base-merged.ts"), "export const b = 2;\n", "utf8");
    git(wt2.worktreePath!, ["add", "base-merged.ts"]);
    git(wt2.worktreePath!, ["commit", "-m", "Implement base-merged feature"]);
    git(repo, ["merge", "--ff-only", wt2.worktreeBranch!]);
    git(repo, ["checkout", "-b", "other-branch"]);
    fs.writeFileSync(path.join(repo, "other.txt"), "other\n", "utf8");
    git(repo, ["add", "other.txt"]);
    git(repo, ["commit", "-m", "Other branch commit"]);

    const eval2 = evaluateWorktreeLandState({
      parentPath: repo,
      worktreePath: wt2.worktreePath,
      worktreeBranch: wt2.worktreeBranch,
      baseBranch: wt2.baseBranch,
      baseCommit: wt2.baseCommit,
    });
    expect(eval2.alreadyMerged).toBe(true);
    expect(eval2.targetBranch).toBe("other-branch");

    // Also verify when other-branch does NOT contain wt2 (diverged from main before merge)
    git(repo, ["checkout", "-b", "diverged-branch", "HEAD~2"]);
    const eval2Diverged = evaluateWorktreeLandState({
      parentPath: repo,
      worktreePath: wt2.worktreePath,
      worktreeBranch: wt2.worktreeBranch,
      baseBranch: "main",
      baseCommit: wt2.baseCommit,
    });
    expect(eval2Diverged.alreadyMerged).toBe(true);
    expect(eval2Diverged.reason).toBe("merged_into_base");
    expect(eval2Diverged.targetBranch).toBe("main");

    // Land in per-task-pr mode also recognizes already-merged and cleans up!
    const land2 = landTaskWorktree({
      parentPath: repo,
      worktreePath: wt2.worktreePath!,
      worktreeBranch: wt2.worktreeBranch!,
      baseBranch: "main",
      baseCommit: wt2.baseCommit,
      taskTitle: "Base Merged Feature",
      taskNumber: 2,
      taskId: "merged02",
      mode: "per-task-pr",
    });
    expect(land2.ok).toBe(true);
    expect(land2.action).toBe("landed");
    expect(land2.targetBranch).toBe("main");
    expect(fs.existsSync(wt2.worktreePath!)).toBe(false);
    expect(git(repo, ["branch", "--list", wt2.worktreeBranch!])).toBe("");
  });

  it("handles no-diff worktree (worker edited parent repo directly, leaving parent dirty) and missing-dir cases safely", () => {
    const repo = initGitRepo();
    const worktreesDir = makeTempDir("conductor-wt-nodiff-");

    // Case 1: Worker edited parent repo directly -> parent is dirty, worktree has 0 commits & 0 uncommitted changes
    const wtNoDiff = createTaskWorktree({
      projectPath: repo,
      worktreesBaseDir: worktreesDir,
      taskId: "nodiff01",
      taskNumber: 1,
    });
    fs.writeFileSync(path.join(repo, "direct-parent-edit.txt"), "edited parent directly\n", "utf8");

    const landNoDiff = landTaskWorktree({
      parentPath: repo,
      worktreePath: wtNoDiff.worktreePath!,
      worktreeBranch: wtNoDiff.worktreeBranch!,
      baseBranch: wtNoDiff.baseBranch,
      baseCommit: wtNoDiff.baseCommit,
      taskTitle: "Direct Parent Edit Task",
      taskNumber: 1,
      taskId: "nodiff01",
      mode: "feature-branch",
    });
    expect(landNoDiff.ok).toBe(true);
    expect(landNoDiff.action).toBe("noop");
    expect(fs.existsSync(wtNoDiff.worktreePath!)).toBe(false);
    expect(git(repo, ["branch", "--list", wtNoDiff.worktreeBranch!])).toBe("");
    // Parent's direct edit is completely preserved
    expect(fs.readFileSync(path.join(repo, "direct-parent-edit.txt"), "utf8")).toBe(
      "edited parent directly\n",
    );
    fs.rmSync(path.join(repo, "direct-parent-edit.txt"));

    // Case 2: Worktree dir deleted externally AFTER branch was merged -> succeeds & cleans up branch
    const wtDeletedMerged = createTaskWorktree({
      projectPath: repo,
      worktreesBaseDir: worktreesDir,
      taskId: "delmerg1",
      taskNumber: 2,
    });
    fs.writeFileSync(path.join(wtDeletedMerged.worktreePath!, "gone-wt.txt"), "merged\n", "utf8");
    git(wtDeletedMerged.worktreePath!, ["add", "gone-wt.txt"]);
    git(wtDeletedMerged.worktreePath!, ["commit", "-m", "Commit before external wt removal"]);
    git(repo, ["merge", "--ff-only", wtDeletedMerged.worktreeBranch!]);
    git(repo, ["worktree", "remove", "--force", wtDeletedMerged.worktreePath!]);

    const landDeletedMerged = landTaskWorktree({
      parentPath: repo,
      worktreePath: wtDeletedMerged.worktreePath!,
      worktreeBranch: wtDeletedMerged.worktreeBranch!,
      baseBranch: wtDeletedMerged.baseBranch,
      baseCommit: wtDeletedMerged.baseCommit,
      taskTitle: "Externally removed merged WT",
      taskNumber: 2,
      taskId: "delmerg1",
      mode: "feature-branch",
    });
    expect(landDeletedMerged.ok).toBe(true);
    expect(landDeletedMerged.action).toBe("landed");
    expect(git(repo, ["branch", "--list", wtDeletedMerged.worktreeBranch!])).toBe("");

    // Case 3: Worktree dir deleted externally while branch STILL has unmerged commits -> must NOT falsely mark landed
    const wtDeletedUnmerged = createTaskWorktree({
      projectPath: repo,
      worktreesBaseDir: worktreesDir,
      taskId: "delunm01",
      taskNumber: 3,
    });
    fs.writeFileSync(path.join(wtDeletedUnmerged.worktreePath!, "unmerged.txt"), "keep\n", "utf8");
    git(wtDeletedUnmerged.worktreePath!, ["add", "unmerged.txt"]);
    git(wtDeletedUnmerged.worktreePath!, ["commit", "-m", "Unmerged commit"]);
    git(repo, ["worktree", "remove", "--force", wtDeletedUnmerged.worktreePath!]);

    const landDeletedUnmerged = landTaskWorktree({
      parentPath: repo,
      worktreePath: wtDeletedUnmerged.worktreePath!,
      worktreeBranch: wtDeletedUnmerged.worktreeBranch!,
      baseBranch: wtDeletedUnmerged.baseBranch,
      baseCommit: wtDeletedUnmerged.baseCommit,
      taskTitle: "Externally removed unmerged WT",
      taskNumber: 3,
      taskId: "delunm01",
      mode: "feature-branch",
    });
    expect(landDeletedUnmerged.ok).toBe(false);
    expect(landDeletedUnmerged.action).toBe("error");
    expect(git(repo, ["branch", "--list", wtDeletedUnmerged.worktreeBranch!])).not.toBe("");
    git(repo, ["branch", "-D", wtDeletedUnmerged.worktreeBranch!]);
  });

  it("parses porcelain -z status and detects exact, rename, D/F, and case-insensitive path overlaps", () => {
    const raw =
      "?? notes/local draft.txt\0 M src/app.ts\0R  src/renamed.ts\0src/old.ts\0UU conflict.txt\0";
    const entries = parsePorcelainStatusZ(raw);
    expect(entries).toEqual([
      { statusCode: "??", untracked: true, unmerged: false, path: "notes/local draft.txt" },
      { statusCode: " M", untracked: false, unmerged: false, path: "src/app.ts" },
      {
        statusCode: "R ",
        untracked: false,
        unmerged: false,
        path: "src/renamed.ts",
        originalPath: "src/old.ts",
      },
      { statusCode: "UU", untracked: false, unmerged: true, path: "conflict.txt" },
    ]);

    expect(pathsOverlap("src/a.ts", "src/a.ts")).toBe(true);
    expect(pathsOverlap("src/a.ts", "src/b.ts")).toBe(false);
    expect(pathsOverlap("dir/file.txt", "dir")).toBe(true);
    expect(pathsOverlap("dir", "dir/file.txt")).toBe(true);
    expect(pathsOverlap("dir2/file.txt", "dir")).toBe(false);
    expect(pathsOverlap("Src/App.ts", "src/app.ts", false)).toBe(false);
    expect(pathsOverlap("Src/App.ts", "src/app.ts", true)).toBe(true);

    const overlapRenameOld = findOverlappingParentDirtyPaths(entries, ["src/old.ts"]);
    expect(overlapRenameOld.overlappingPaths).toEqual(["src/old.ts"]);
    expect(overlapRenameOld.unmergedPaths).toEqual(["conflict.txt"]);

    const overlapCaseInsensitive = findOverlappingParentDirtyPaths(
      [{ statusCode: "??", untracked: true, unmerged: false, path: "Docs/Guide.md" }],
      ["docs/guide.md"],
      { caseInsensitive: true },
    );
    expect(overlapCaseInsensitive.overlappingPaths).toEqual(["Docs/Guide.md"]);
  });

  it("allows landing when parent repo has disjoint untracked, modified, or staged files without disturbing them", () => {
    const repo = initGitRepo();
    const worktreesDir = makeTempDir("conductor-wt-disjoint-");

    fs.writeFileSync(path.join(repo, "tracked-local.txt"), "original local\n", "utf8");
    fs.writeFileSync(path.join(repo, "staged-local.txt"), "original staged\n", "utf8");
    git(repo, ["add", "tracked-local.txt", "staged-local.txt"]);
    git(repo, ["commit", "-m", "add tracked files"]);

    // Case 1 (feature-branch mode): disjoint untracked (top-level + nested dir), modified, and staged changes
    const wt1 = createTaskWorktree({
      projectPath: repo,
      worktreesBaseDir: worktreesDir,
      taskId: "disj1111",
      taskNumber: 1,
    });
    expect(wt1.created).toBe(true);

    // Worker adds a new file under shared directory `nested/` and modifies README.md (left uncommitted in wt1 to verify worktree auto-commit still works)
    fs.mkdirSync(path.join(wt1.worktreePath!, "nested"), { recursive: true });
    fs.writeFileSync(path.join(wt1.worktreePath!, "nested", "from-task1.txt"), "task1\n", "utf8");
    fs.writeFileSync(path.join(wt1.worktreePath!, "README.md"), "# Updated by Task 1\n", "utf8");

    // Parent has disjoint untracked (top-level + sibling inside `nested/`), unstaged modified, staged modified, and staged new file
    fs.writeFileSync(path.join(repo, "untracked-wip.txt"), "keep untracked\n", "utf8");
    fs.mkdirSync(path.join(repo, "nested"), { recursive: true });
    fs.writeFileSync(path.join(repo, "nested", "local-only.txt"), "keep nested untracked\n", "utf8");
    fs.writeFileSync(path.join(repo, "tracked-local.txt"), "unstaged edit in parent\n", "utf8");
    fs.writeFileSync(path.join(repo, "staged-local.txt"), "staged edit in parent\n", "utf8");
    fs.writeFileSync(path.join(repo, "staged-new.txt"), "brand new staged file\n", "utf8");
    git(repo, ["add", "staged-local.txt", "staged-new.txt"]);

    const land1 = landTaskWorktree({
      parentPath: repo,
      worktreePath: wt1.worktreePath!,
      worktreeBranch: wt1.worktreeBranch!,
      baseBranch: wt1.baseBranch,
      baseCommit: wt1.baseCommit,
      taskTitle: "Disjoint Feature Branch",
      taskNumber: 1,
      taskId: "disj1111",
      mode: "feature-branch",
    });

    expect(land1.ok).toBe(true);
    expect(land1.action).toBe("landed");
    expect(land1.targetBranch).toBe("conductor/disjoint-feature-branch");
    expect(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("conductor/disjoint-feature-branch");
    expect(fs.existsSync(wt1.worktreePath!)).toBe(false);

    // Incoming changes landed cleanly
    expect(fs.readFileSync(path.join(repo, "nested", "from-task1.txt"), "utf8")).toBe("task1\n");
    expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toBe("# Updated by Task 1\n");

    // All parent disjoint untracked / modified / staged changes remain 100% intact
    expect(fs.readFileSync(path.join(repo, "untracked-wip.txt"), "utf8")).toBe("keep untracked\n");
    expect(fs.readFileSync(path.join(repo, "nested", "local-only.txt"), "utf8")).toBe(
      "keep nested untracked\n",
    );
    expect(fs.readFileSync(path.join(repo, "tracked-local.txt"), "utf8")).toBe(
      "unstaged edit in parent\n",
    );
    expect(fs.readFileSync(path.join(repo, "staged-local.txt"), "utf8")).toBe(
      "staged edit in parent\n",
    );
    expect(fs.readFileSync(path.join(repo, "staged-new.txt"), "utf8")).toBe(
      "brand new staged file\n",
    );
    const parentStatusAfter1 = git(repo, ["status", "--porcelain=v1", "-uall"]);
    expect(parentStatusAfter1).toContain("?? untracked-wip.txt");
    expect(parentStatusAfter1).toContain("?? nested/local-only.txt");
    expect(parentStatusAfter1).toContain(" M tracked-local.txt");
    expect(parentStatusAfter1).toContain("M  staged-local.txt");
    expect(parentStatusAfter1).toContain("A  staged-new.txt");

    // Case 2 (direct mode + rebase onto advanced parent HEAD): still lands cleanly preserving parent WIP
    const wt2 = createTaskWorktree({
      projectPath: repo,
      worktreesBaseDir: worktreesDir,
      taskId: "disj2222",
      taskNumber: 2,
    });
    fs.writeFileSync(path.join(wt2.worktreePath!, "from-task2.txt"), "task2 direct\n", "utf8");

    const land2 = landTaskWorktree({
      parentPath: repo,
      worktreePath: wt2.worktreePath!,
      worktreeBranch: wt2.worktreeBranch!,
      baseBranch: wt2.baseBranch,
      baseCommit: wt2.baseCommit,
      taskTitle: "Disjoint Direct",
      taskNumber: 2,
      taskId: "disj2222",
      mode: "direct",
    });
    expect(land2.ok).toBe(true);
    expect(land2.action).toBe("landed");
    expect(fs.readFileSync(path.join(repo, "from-task2.txt"), "utf8")).toBe("task2 direct\n");
    expect(fs.readFileSync(path.join(repo, "untracked-wip.txt"), "utf8")).toBe("keep untracked\n");
    expect(fs.readFileSync(path.join(repo, "tracked-local.txt"), "utf8")).toBe(
      "unstaged edit in parent\n",
    );
    expect(fs.readFileSync(path.join(repo, "staged-local.txt"), "utf8")).toBe(
      "staged edit in parent\n",
    );
  });

  it("blocks landing and reports conflicting paths when parent repo has overlapping untracked, modified, staged, or D/F files", () => {
    const repo = initGitRepo();
    const worktreesDir = makeTempDir("conductor-wt-overlap-");

    fs.writeFileSync(path.join(repo, "existing.txt"), "base existing\n", "utf8");
    git(repo, ["add", "existing.txt"]);
    git(repo, ["commit", "-m", "add existing.txt"]);
    const initialHead = git(repo, ["rev-parse", "HEAD"]);

    // Case 1: Overlapping untracked file (including nested inside an untracked directory)
    const wtUntracked = createTaskWorktree({
      projectPath: repo,
      worktreesBaseDir: worktreesDir,
      taskId: "ovuntr01",
      taskNumber: 1,
    });
    fs.mkdirSync(path.join(wtUntracked.worktreePath!, "sub"), { recursive: true });
    fs.writeFileSync(path.join(wtUntracked.worktreePath!, "sub", "collide.txt"), "from wt\n", "utf8");

    fs.mkdirSync(path.join(repo, "sub"), { recursive: true });
    fs.writeFileSync(path.join(repo, "sub", "collide.txt"), "parent untracked\n", "utf8");

    const resUntracked = landTaskWorktree({
      parentPath: repo,
      worktreePath: wtUntracked.worktreePath!,
      worktreeBranch: wtUntracked.worktreeBranch!,
      baseBranch: wtUntracked.baseBranch,
      baseCommit: wtUntracked.baseCommit,
      taskTitle: "Overlap Untracked",
      taskNumber: 1,
      taskId: "ovuntr01",
      mode: "feature-branch",
    });
    expect(resUntracked.ok).toBe(false);
    expect(resUntracked.action).toBe("error");
    expect(resUntracked.message).toContain("sub/collide.txt");
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(initialHead);
    expect(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(fs.readFileSync(path.join(repo, "sub", "collide.txt"), "utf8")).toBe("parent untracked\n");
    expect(fs.existsSync(wtUntracked.worktreePath!)).toBe(true);
    fs.rmSync(path.join(repo, "sub"), { recursive: true, force: true });

    // Case 2: Directory/file conflict (parent has untracked file `sub`, incoming adds `sub/collide.txt`)
    fs.writeFileSync(path.join(repo, "sub"), "parent file blocking dir\n", "utf8");
    const resDf = landTaskWorktree({
      parentPath: repo,
      worktreePath: wtUntracked.worktreePath!,
      worktreeBranch: wtUntracked.worktreeBranch!,
      baseBranch: wtUntracked.baseBranch,
      baseCommit: wtUntracked.baseCommit,
      taskTitle: "Overlap DF",
      taskNumber: 1,
      taskId: "ovuntr01",
      mode: "feature-branch",
    });
    expect(resDf.ok).toBe(false);
    expect(resDf.action).toBe("error");
    expect(resDf.message).toContain("sub");
    expect(fs.readFileSync(path.join(repo, "sub"), "utf8")).toBe("parent file blocking dir\n");
    fs.rmSync(path.join(repo, "sub"));
    removeTaskWorktree({
      parentPath: repo,
      worktreePath: wtUntracked.worktreePath,
      worktreeBranch: wtUntracked.worktreeBranch,
      deleteBranch: true,
    });

    // Case 3: Overlapping modified (unstaged) and staged tracked file
    const wtMod = createTaskWorktree({
      projectPath: repo,
      worktreesBaseDir: worktreesDir,
      taskId: "ovmod002",
      taskNumber: 2,
    });
    fs.writeFileSync(path.join(wtMod.worktreePath!, "existing.txt"), "wt edit\n", "utf8");

    // 3a: unstaged modified in parent
    fs.writeFileSync(path.join(repo, "existing.txt"), "parent unstaged edit\n", "utf8");
    const resMod = landTaskWorktree({
      parentPath: repo,
      worktreePath: wtMod.worktreePath!,
      worktreeBranch: wtMod.worktreeBranch!,
      baseBranch: wtMod.baseBranch,
      baseCommit: wtMod.baseCommit,
      taskTitle: "Overlap Modified",
      taskNumber: 2,
      taskId: "ovmod002",
      mode: "direct",
    });
    expect(resMod.ok).toBe(false);
    expect(resMod.action).toBe("error");
    expect(resMod.message).toContain("existing.txt");
    expect(fs.readFileSync(path.join(repo, "existing.txt"), "utf8")).toBe("parent unstaged edit\n");
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(initialHead);

    // 3b: staged modified in parent
    git(repo, ["add", "existing.txt"]);
    const resStaged = landTaskWorktree({
      parentPath: repo,
      worktreePath: wtMod.worktreePath!,
      worktreeBranch: wtMod.worktreeBranch!,
      baseBranch: wtMod.baseBranch,
      baseCommit: wtMod.baseCommit,
      taskTitle: "Overlap Staged",
      taskNumber: 2,
      taskId: "ovmod002",
      mode: "direct",
    });
    expect(resStaged.ok).toBe(false);
    expect(resStaged.action).toBe("error");
    expect(resStaged.message).toContain("existing.txt");
    expect(git(repo, ["diff", "--cached", "--name-only"])).toBe("existing.txt");
    expect(fs.readFileSync(path.join(repo, "existing.txt"), "utf8")).toBe("parent unstaged edit\n");

    // Cleanup
    git(repo, ["reset", "--hard", "HEAD"]);
    removeTaskWorktree({
      parentPath: repo,
      worktreePath: wtMod.worktreePath,
      worktreeBranch: wtMod.worktreeBranch,
      deleteBranch: true,
    });
  });

  it("keeps strict protection for untracked/uncommitted files inside the task worktree itself", () => {
    const repo = initGitRepo();
    const worktreesDir = makeTempDir("conductor-wt-strict-");

    const wt = createTaskWorktree({
      projectPath: repo,
      worktreesBaseDir: worktreesDir,
      taskId: "wtprot01",
      taskNumber: 1,
    });
    expect(wt.created).toBe(true);

    // Untracked file only inside worktree (never git-added by worker)
    fs.writeFileSync(path.join(wt.worktreePath!, "artifact.txt"), "important output\n", "utf8");

    // evaluateWorktreeLandState must NOT treat it as no_changes or alreadyMerged
    const evalState = evaluateWorktreeLandState({
      parentPath: repo,
      worktreePath: wt.worktreePath,
      worktreeBranch: wt.worktreeBranch,
      baseBranch: wt.baseBranch,
      baseCommit: wt.baseCommit,
    });
    expect(evalState.worktreeDirty).toBe(true);
    expect(evalState.noChanges).toBe(false);
    expect(evalState.alreadyMerged).toBe(false);

    // Landing must auto-commit and bring the worktree untracked file into parent repo
    const landRes = landTaskWorktree({
      parentPath: repo,
      worktreePath: wt.worktreePath!,
      worktreeBranch: wt.worktreeBranch!,
      baseBranch: wt.baseBranch,
      baseCommit: wt.baseCommit,
      taskTitle: "Preserve Worktree Artifact",
      taskNumber: 1,
      taskId: "wtprot01",
      mode: "direct",
    });
    expect(landRes.ok).toBe(true);
    expect(landRes.action).toBe("landed");
    expect(fs.readFileSync(path.join(repo, "artifact.txt"), "utf8")).toBe("important output\n");
  });
});
