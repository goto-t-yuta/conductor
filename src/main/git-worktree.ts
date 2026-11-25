import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
  IntegrationMode,
  LandTaskResult,
  TaskWorktreeStatus,
} from "../shared/types.js";
import { canonicalDirectory, enrichedEnvironment, resolveGhExecutable } from "./shell-env.js";

const VALID_INTEGRATION_MODES: readonly IntegrationMode[] = [
  "feature-branch",
  "per-task-pr",
  "direct",
];

export function isValidIntegrationMode(value: unknown): value is IntegrationMode {
  return typeof value === "string" && VALID_INTEGRATION_MODES.includes(value as IntegrationMode);
}

interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runGit(cwd: string, args: string[], timeoutMs = 30_000): ExecResult {
  try {
    const stdout = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: timeoutMs,
      env: enrichedEnvironment({ GIT_TERMINAL_PROMPT: "0" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout: stdout.trimEnd(), stderr: "", exitCode: 0 };
  } catch (err: unknown) {
    const e = err as {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      status?: number;
      message?: string;
    };
    const stdout = typeof e.stdout === "string" ? e.stdout : e.stdout?.toString("utf8") ?? "";
    const stderr =
      typeof e.stderr === "string"
        ? e.stderr
        : e.stderr?.toString("utf8") ?? e.message ?? "git command failed";
    return {
      ok: false,
      stdout: stdout.trimEnd(),
      stderr: stderr.trim(),
      exitCode: typeof e.status === "number" ? e.status : 1,
    };
  }
}

function runGh(cwd: string, args: string[], timeoutMs = 30_000): ExecResult {
  const ghPath = resolveGhExecutable();
  if (!ghPath) {
    return { ok: false, stdout: "", stderr: "gh CLI not found", exitCode: 127 };
  }
  try {
    const stdout = execFileSync(ghPath, args, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      env: enrichedEnvironment({ GH_PROMPT_DISABLED: "1" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout: stdout.trim(), stderr: "", exitCode: 0 };
  } catch (err: unknown) {
    const e = err as {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      status?: number;
      message?: string;
    };
    const stdout = typeof e.stdout === "string" ? e.stdout : e.stdout?.toString("utf8") ?? "";
    const stderr =
      typeof e.stderr === "string"
        ? e.stderr
        : e.stderr?.toString("utf8") ?? e.message ?? "gh command failed";
    return {
      ok: false,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode: typeof e.status === "number" ? e.status : 1,
    };
  }
}

export function slugifyForBranch(text: string, fallback: string): string {
  const ascii = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return ascii || fallback;
}

export function readProjectIntegrationModeConfig(projectPath: string | null | undefined): IntegrationMode | null {
  if (!projectPath) return null;
  const configPath = path.join(projectPath, ".conductor.json");
  try {
    if (!fs.existsSync(configPath)) return null;
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (isValidIntegrationMode(parsed.integrationMode)) {
      return parsed.integrationMode;
    }
    return null;
  } catch {
    return null;
  }
}

export function resolveEffectiveIntegrationMode(options: {
  projectMode?: IntegrationMode | null;
  projectPath?: string | null;
  globalDefault: IntegrationMode;
}): IntegrationMode {
  if (isValidIntegrationMode(options.projectMode)) {
    return options.projectMode;
  }
  const fileConfig = readProjectIntegrationModeConfig(options.projectPath);
  if (fileConfig) {
    return fileConfig;
  }
  return isValidIntegrationMode(options.globalDefault) ? options.globalDefault : "feature-branch";
}

function getRepoRoot(dir: string): string | null {
  const inside = runGit(dir, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") return null;
  const top = runGit(dir, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || !top.stdout.trim()) return null;
  return canonicalDirectory(top.stdout.trim()) ?? top.stdout.trim();
}

function getCurrentBranch(dir: string): string | null {
  const res = runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!res.ok) return null;
  const name = res.stdout.trim();
  if (!name || name === "HEAD") return null;
  return name;
}

export function getGitHeadCommit(dir: string): string | null {
  return getHeadCommit(dir);
}

function getHeadCommit(dir: string): string | null {
  const res = runGit(dir, ["rev-parse", "--verify", "HEAD"]);
  if (!res.ok) return null;
  const sha = res.stdout.trim();
  return sha || null;
}

function branchExists(repoRoot: string, branchName: string): boolean {
  return runGit(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]).ok;
}

function remoteBranchExists(repoRoot: string, remote: string, branchName: string): boolean {
  return runGit(repoRoot, ["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${branchName}`]).ok;
}

function getPorcelainStatus(dir: string): string[] {
  const res = runGit(dir, ["status", "--porcelain"]);
  if (!res.ok || !res.stdout.trim()) return [];
  return res.stdout.split("\n").filter((line) => line.trim().length > 0);
}

function isRepoInProgressOperation(repoRoot: string): string | null {
  const gitDirRes = runGit(repoRoot, ["rev-parse", "--git-dir"]);
  if (!gitDirRes.ok) return null;
  const rawGitDir = gitDirRes.stdout.trim();
  const gitDir = path.isAbsolute(rawGitDir) ? rawGitDir : path.join(repoRoot, rawGitDir);

  if (fs.existsSync(path.join(gitDir, "rebase-merge")) || fs.existsSync(path.join(gitDir, "rebase-apply"))) {
    return "rebase";
  }
  if (fs.existsSync(path.join(gitDir, "MERGE_HEAD"))) {
    return "merge";
  }
  if (fs.existsSync(path.join(gitDir, "CHERRY_PICK_HEAD"))) {
    return "cherry-pick";
  }
  return null;
}

export function isProtectedDefaultBranch(repoRoot: string, branchName: string | null): boolean {
  if (!branchName) return true;
  if (branchName === "main" || branchName === "master") return true;

  const originHead = runGit(repoRoot, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead.ok) {
    const ref = originHead.stdout.trim();
    const defaultName = ref.startsWith("origin/") ? ref.slice("origin/".length) : ref;
    if (defaultName && branchName === defaultName) {
      return true;
    }
  }
  return false;
}

export function computeFeatureBranchName(
  repoRoot: string,
  taskTitle: string,
  taskNumber: number,
  taskId: string,
): string {
  const fallback = `task-${taskNumber > 0 ? taskNumber : taskId.slice(0, 6)}`;
  const slug = slugifyForBranch(taskTitle, fallback);
  const baseName = `conductor/${slug}`;
  if (!branchExists(repoRoot, baseName)) {
    return baseName;
  }
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${baseName}-${i}`;
    if (!branchExists(repoRoot, candidate)) {
      return candidate;
    }
  }
  return `${baseName}-${taskId.slice(0, 6)}`;
}

function pickUniqueTaskBranch(repoRoot: string, shortId: string): string {
  const base = `conductor/task-${shortId}`;
  if (!branchExists(repoRoot, base)) return base;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base}-${i}`;
    if (!branchExists(repoRoot, candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

function pickUniqueWorktreePath(worktreesBaseDir: string, projectName: string, shortId: string): string {
  const projectSlug = slugifyForBranch(projectName, "project");
  const projectDir = path.join(worktreesBaseDir, projectSlug);
  fs.mkdirSync(projectDir, { recursive: true });
  const base = path.join(projectDir, `task-${shortId}`);
  if (!fs.existsSync(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base}-${i}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export interface CreateWorktreeResult {
  created: boolean;
  reason?: "not_git_repo" | "no_commits" | "worktree_add_failed";
  error?: string;
  cwd: string;
  repoRoot?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  baseBranch?: string | null;
  baseCommit?: string;
}

export function createTaskWorktree(options: {
  projectPath: string;
  projectName?: string;
  worktreesBaseDir: string;
  taskId: string;
  taskNumber?: number;
}): CreateWorktreeResult {
  const canonicalProject = canonicalDirectory(options.projectPath) ?? options.projectPath;
  const repoRoot = getRepoRoot(canonicalProject);
  if (!repoRoot) {
    return { created: false, reason: "not_git_repo", cwd: canonicalProject };
  }

  const baseCommit = getHeadCommit(repoRoot);
  if (!baseCommit) {
    return { created: false, reason: "no_commits", cwd: canonicalProject };
  }

  const baseBranch = getCurrentBranch(repoRoot);
  const shortId = options.taskId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toLowerCase() || "wt";
  const worktreeBranch = pickUniqueTaskBranch(repoRoot, shortId);
  const projectLabel = options.projectName || path.basename(repoRoot);
  const worktreePath = pickUniqueWorktreePath(options.worktreesBaseDir, projectLabel, shortId);

  const addRes = runGit(repoRoot, ["worktree", "add", "-b", worktreeBranch, worktreePath, baseCommit]);
  if (!addRes.ok) {
    return {
      created: false,
      reason: "worktree_add_failed",
      error: addRes.stderr || "git worktree add failed",
      cwd: canonicalProject,
    };
  }

  const canonicalWt = canonicalDirectory(worktreePath) ?? worktreePath;
  const relSubpath = path.relative(repoRoot, canonicalProject);
  const worktreeCwd =
    relSubpath && !relSubpath.startsWith("..") && !path.isAbsolute(relSubpath)
      ? path.join(canonicalWt, relSubpath)
      : canonicalWt;

  return {
    created: true,
    cwd: fs.existsSync(worktreeCwd) ? worktreeCwd : canonicalWt,
    repoRoot,
    worktreePath: canonicalWt,
    worktreeBranch,
    baseBranch,
    baseCommit,
  };
}

export function removeTaskWorktree(options: {
  parentPath: string | null | undefined;
  worktreePath: string | null | undefined;
  worktreeBranch?: string | null;
  deleteBranch?: boolean;
}): { ok: boolean; error?: string } {
  const { parentPath, worktreePath, worktreeBranch, deleteBranch = true } = options;
  const repoRoot = parentPath ? getRepoRoot(parentPath) : null;

  if (worktreePath) {
    if (repoRoot) {
      runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
    }
    if (fs.existsSync(worktreePath)) {
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    if (repoRoot) {
      runGit(repoRoot, ["worktree", "prune"]);
    }
  }

  if (deleteBranch && repoRoot && worktreeBranch && branchExists(repoRoot, worktreeBranch)) {
    const current = getCurrentBranch(repoRoot);
    if (current !== worktreeBranch) {
      runGit(repoRoot, ["branch", "-D", worktreeBranch]);
    }
  }

  return { ok: true };
}

function commitWorktreeChangesIfDirty(
  worktreePath: string,
  taskTitle: string,
): { ok: boolean; committed: boolean; commitHash?: string; error?: string } {
  const dirtyLines = getPorcelainStatus(worktreePath);
  if (dirtyLines.length === 0) {
    return { ok: true, committed: false };
  }

  const addRes = runGit(worktreePath, ["add", "-A"]);
  if (!addRes.ok) {
    return { ok: false, committed: false, error: addRes.stderr || "git add -A failed" };
  }

  const diffCached = runGit(worktreePath, ["diff", "--cached", "--quiet"]);
  if (diffCached.ok) {
    // Nothing actually staged
    return { ok: true, committed: false };
  }

  const configArgs: string[] = [];
  if (!runGit(worktreePath, ["config", "--get", "user.name"]).stdout.trim()) {
    configArgs.push("-c", "user.name=Conductor");
  }
  if (!runGit(worktreePath, ["config", "--get", "user.email"]).stdout.trim()) {
    configArgs.push("-c", "user.email=conductor@local");
  }

  const commitMessage = taskTitle.trim() || "Conductor task changes";
  const commitRes = runGit(worktreePath, [...configArgs, "commit", "-m", commitMessage]);
  if (!commitRes.ok) {
    return {
      ok: false,
      committed: false,
      error: commitRes.stderr || commitRes.stdout || "git commit failed",
    };
  }

  const head = getHeadCommit(worktreePath) ?? undefined;
  return { ok: true, committed: true, commitHash: head };
}

function getConflictedFiles(dir: string): string[] {
  const unmerged = runGit(dir, ["diff", "--name-only", "--diff-filter=U"]);
  if (unmerged.ok && unmerged.stdout.trim()) {
    return unmerged.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const porcelain = getPorcelainStatus(dir);
  const files: string[] = [];
  for (const line of porcelain) {
    const code = line.slice(0, 2);
    if (code.includes("U") || code === "AA" || code === "DD") {
      files.push(line.slice(3).trim());
    }
  }
  return files;
}

function countCommitsAhead(dir: string, baseRef: string | null | undefined): number {
  if (!baseRef) return 0;
  const res = runGit(dir, ["rev-list", "--count", `${baseRef}..HEAD`]);
  if (!res.ok) return 0;
  const parsed = Number.parseInt(res.stdout.trim(), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getDefaultRemote(dir: string): string | null {
  const res = runGit(dir, ["remote"]);
  if (!res.ok || !res.stdout.trim()) return null;
  const remotes = res.stdout
    .split("\n")
    .map((r) => r.trim())
    .filter(Boolean);
  if (remotes.includes("origin")) return "origin";
  return remotes[0] ?? null;
}

export function inspectTaskWorktree(options: {
  parentPath: string | null;
  worktreePath: string | null | undefined;
  worktreeBranch: string | null | undefined;
  baseCommit: string | null | undefined;
  taskTitle: string;
  taskNumber: number;
  taskId: string;
  effectiveMode: IntegrationMode;
}): TaskWorktreeStatus {
  const hasWorktree = Boolean(options.worktreePath && options.worktreeBranch);
  const worktreeExists = Boolean(options.worktreePath && fs.existsSync(options.worktreePath));
  const repoRoot = options.parentPath ? getRepoRoot(options.parentPath) : null;
  const parentBranch = repoRoot ? getCurrentBranch(repoRoot) : null;
  const parentDirty = repoRoot ? getPorcelainStatus(repoRoot).length > 0 : false;
  const ghAvailable = Boolean(resolveGhExecutable());

  let suggestedTargetBranch: string | null = null;
  if (options.effectiveMode === "per-task-pr") {
    suggestedTargetBranch = options.worktreeBranch ?? null;
  } else if (options.effectiveMode === "direct") {
    suggestedTargetBranch = parentBranch;
  } else if (repoRoot) {
    if (isProtectedDefaultBranch(repoRoot, parentBranch)) {
      suggestedTargetBranch = computeFeatureBranchName(
        repoRoot,
        options.taskTitle,
        options.taskNumber,
        options.taskId,
      );
    } else {
      suggestedTargetBranch = parentBranch;
    }
  }

  if (!worktreeExists || !options.worktreePath) {
    return {
      hasWorktree,
      worktreeExists: false,
      worktreePath: options.worktreePath ?? null,
      worktreeBranch: options.worktreeBranch ?? null,
      parentBranch,
      parentDirty,
      worktreeDirty: false,
      changedFilesCount: 0,
      aheadCommits: 0,
      diffSummary: null,
      effectiveMode: options.effectiveMode,
      suggestedTargetBranch,
      ghAvailable,
    };
  }

  const statusLines = getPorcelainStatus(options.worktreePath);
  const worktreeDirty = statusLines.length > 0;
  const baseRef = options.baseCommit || (repoRoot ? getHeadCommit(repoRoot) : null);
  const aheadCommits = countCommitsAhead(options.worktreePath, baseRef);

  const summaryParts: string[] = [];
  if (aheadCommits > 0 && baseRef) {
    const logRes = runGit(options.worktreePath, ["log", "--oneline", `${baseRef}..HEAD`]);
    if (logRes.ok && logRes.stdout.trim()) {
      summaryParts.push(`Commits (${aheadCommits}):\n${logRes.stdout.trim()}`);
    }
  }
  if (worktreeDirty) {
    summaryParts.push(`Uncommitted (${statusLines.length}):\n${statusLines.join("\n")}`);
  }
  if (summaryParts.length === 0) {
    summaryParts.push("(no changes yet)");
  }

  return {
    hasWorktree,
    worktreeExists: true,
    worktreePath: options.worktreePath,
    worktreeBranch: options.worktreeBranch ?? null,
    parentBranch,
    parentDirty,
    worktreeDirty,
    changedFilesCount: statusLines.length,
    aheadCommits,
    diffSummary: summaryParts.join("\n\n"),
    effectiveMode: options.effectiveMode,
    suggestedTargetBranch,
    ghAvailable,
  };
}

export interface LandTaskWorktreeOptions {
  parentPath: string;
  worktreePath: string;
  worktreeBranch: string;
  baseBranch?: string | null;
  baseCommit?: string | null;
  taskTitle: string;
  taskSummary?: string;
  taskNumber: number;
  taskId: string;
  mode: IntegrationMode;
  createPr?: boolean;
}

export function landTaskWorktree(options: LandTaskWorktreeOptions): LandTaskResult {
  const {
    parentPath,
    worktreePath,
    worktreeBranch,
    baseBranch,
    baseCommit,
    taskTitle,
    taskSummary,
    taskNumber,
    taskId,
    mode,
    createPr = false,
  } = options;

  const repoRoot = getRepoRoot(parentPath);
  if (!repoRoot) {
    return {
      ok: false,
      mode,
      action: "error",
      message: "親ディレクトリが Git リポジトリではありません。",
    };
  }

  if (!fs.existsSync(worktreePath)) {
    return {
      ok: false,
      mode,
      action: "error",
      message: `Worktree が見つかりません: ${worktreePath}`,
    };
  }

  // Ensure worktree is not already stuck in a git operation
  const wtOp = isRepoInProgressOperation(worktreePath);
  if (wtOp) {
    return {
      ok: false,
      mode,
      action: "error",
      message: `Worktree が ${wtOp} の途中状態です。先に解決または中断してください。`,
    };
  }

  // 1. Cleanly stage & commit any uncommitted work inside the task worktree
  const commitStep = commitWorktreeChangesIfDirty(worktreePath, taskTitle);
  if (!commitStep.ok) {
    return {
      ok: false,
      mode,
      action: "error",
      message: `Worktree の変更コミットに失敗しました: ${commitStep.error}`,
    };
  }

  // 2. Per-Task PR mode: never touch parent repo; push branch & optionally open PR
  if (mode === "per-task-pr") {
    const aheadOfBase = baseCommit ? countCommitsAhead(worktreePath, baseCommit) : 1;
    if (aheadOfBase === 0) {
      return {
        ok: true,
        mode,
        action: "noop",
        targetBranch: worktreeBranch,
        commitHash: getHeadCommit(worktreePath),
        message: "コミット差分がないため Push をスキップしました。",
      };
    }

    const remote = getDefaultRemote(worktreePath) ?? getDefaultRemote(repoRoot);
    if (!remote) {
      return {
        ok: false,
        mode,
        action: "error",
        targetBranch: worktreeBranch,
        message:
          "Git remote が設定されていないため Push できません（ブランチと Worktree は保持されています）。",
      };
    }

    const pushRes = runGit(worktreePath, ["push", "-u", remote, worktreeBranch], 60_000);
    if (!pushRes.ok) {
      return {
        ok: false,
        mode,
        action: "error",
        targetBranch: worktreeBranch,
        message: `ブランチの Push に失敗しました: ${pushRes.stderr || pushRes.stdout}`,
      };
    }

    const headCommit = getHeadCommit(worktreePath);
    if (createPr && resolveGhExecutable()) {
      const existingPr = runGh(worktreePath, [
        "pr",
        "view",
        worktreeBranch,
        "--json",
        "url",
        "--jq",
        ".url",
      ]);
      if (existingPr.ok && existingPr.stdout.startsWith("http")) {
        return {
          ok: true,
          mode,
          action: "pr_created",
          targetBranch: worktreeBranch,
          commitHash: headCommit,
          prUrl: existingPr.stdout,
          message: `ブランチ ${worktreeBranch} を Push し、既存の PR を関連付けました。`,
        };
      }

      const prArgs = [
        "pr",
        "create",
        "--head",
        worktreeBranch,
        "--title",
        taskTitle.trim() || worktreeBranch,
        "--body",
        taskSummary?.trim() || `Task #${taskNumber}: ${taskTitle}`,
      ];
      if (baseBranch && remoteBranchExists(repoRoot, remote, baseBranch)) {
        prArgs.push("--base", baseBranch);
      }

      const prRes = runGh(worktreePath, prArgs, 60_000);
      if (prRes.ok) {
        const urlMatch = prRes.stdout.match(/https?:\/\/\S+/);
        const prUrl = urlMatch ? urlMatch[0] : prRes.stdout || null;
        return {
          ok: true,
          mode,
          action: "pr_created",
          targetBranch: worktreeBranch,
          commitHash: headCommit,
          prUrl,
          message: `ブランチ ${worktreeBranch} を Push し、PR を作成しました。`,
        };
      }

      return {
        ok: true,
        mode,
        action: "pushed",
        targetBranch: worktreeBranch,
        commitHash: headCommit,
        message: `ブランチ ${worktreeBranch} を ${remote} へ Push しました（PR 自動作成はスキップ: ${prRes.stderr || "gh error"}）。`,
      };
    }

    return {
      ok: true,
      mode,
      action: "pushed",
      targetBranch: worktreeBranch,
      commitHash: headCommit,
      message: `ブランチ ${worktreeBranch} を ${remote} へ Push しました。`,
    };
  }

  // 3. feature-branch / direct modes: guard parent repo state before touching anything
  const parentOp = isRepoInProgressOperation(repoRoot);
  if (parentOp) {
    return {
      ok: false,
      mode,
      action: "error",
      message: `親リポジトリが ${parentOp} の途中状態です。先に解消してから Land してください。`,
    };
  }

  const parentDirtyLines = getPorcelainStatus(repoRoot);
  if (parentDirtyLines.length > 0) {
    return {
      ok: false,
      mode,
      action: "error",
      message: `親リポジトリに未コミットの変更（${parentDirtyLines.length}件）があります。先にコミットまたはスタッシュしてから Land してください。`,
    };
  }

  const parentBranch = getCurrentBranch(repoRoot);
  const parentHead = getHeadCommit(repoRoot);
  if (!parentHead) {
    return {
      ok: false,
      mode,
      action: "error",
      message: "親リポジトリに HEAD コミットがありません。",
    };
  }

  if (mode === "direct" && !parentBranch) {
    return {
      ok: false,
      mode,
      action: "error",
      message: "親リポジトリが detached HEAD 状態です。direct モードで Land する前にブランチをチェックアウトしてください。",
    };
  }

  const needsCreateFeatureBranch =
    mode === "feature-branch" && isProtectedDefaultBranch(repoRoot, parentBranch);
  const targetBranch = needsCreateFeatureBranch
    ? computeFeatureBranchName(repoRoot, taskTitle, taskNumber, taskId)
    : parentBranch!;

  // 4. Detect no-op (no commits on task branch compared to baseCommit or parentHead)
  const aheadOfBase = baseCommit ? countCommitsAhead(worktreePath, baseCommit) : 1;
  const aheadOfParent = countCommitsAhead(worktreePath, parentHead);
  if (aheadOfBase === 0 || aheadOfParent === 0) {
    removeTaskWorktree({
      parentPath: repoRoot,
      worktreePath,
      worktreeBranch,
      deleteBranch: true,
    });
    return {
      ok: true,
      mode,
      action: "noop",
      targetBranch: parentBranch,
      commitHash: parentHead,
      message: "取り込む新しい変更がありませんでした。Worktree をクリーンアップしました。",
    };
  }

  // 5. Rebase task branch inside the isolated worktree onto parentHead BEFORE modifying parent repo.
  //    If parentHead is ALREADY an ancestor of worktree HEAD (e.g. after AI/manual rebase or merge resolution),
  //    skip rebase and proceed straight to fast-forward in Step 6.
  const isParentAlreadyAncestor = runGit(worktreePath, [
    "merge-base",
    "--is-ancestor",
    parentHead,
    "HEAD",
  ]).ok;

  if (!isParentAlreadyAncestor) {
    const hasBaseAncestor =
      Boolean(baseCommit) &&
      runGit(worktreePath, ["merge-base", "--is-ancestor", baseCommit!, "HEAD"]).ok;

    const rebaseArgs = hasBaseAncestor
      ? ["rebase", "--onto", parentHead, baseCommit!]
      : ["rebase", parentHead];

    const rebaseRes = runGit(worktreePath, rebaseArgs);
    if (!rebaseRes.ok) {
      const conflictFiles = getConflictedFiles(worktreePath);
      // Abort cleanly so neither worktree nor parent repo is left in a broken state
      runGit(worktreePath, ["rebase", "--abort"]);
      const fileList = conflictFiles.length > 0 ? ` (${conflictFiles.join(", ")})` : "";
      return {
        ok: false,
        mode,
        action: "conflict",
        targetBranch,
        parentHead,
        conflictFiles,
        message: `${targetBranch} へのリベースでコンフリクトが発生したため安全に中断しました${fileList}。親リポジトリは変更されていません。`,
      };
    }
  }

  // 6. Now parent repo can cleanly switch/create feature branch and fast-forward
  if (needsCreateFeatureBranch) {
    const checkoutRes = runGit(repoRoot, ["checkout", "-b", targetBranch]);
    if (!checkoutRes.ok) {
      return {
        ok: false,
        mode,
        action: "error",
        targetBranch,
        message: `作業ブランチ ${targetBranch} の作成に失敗しました: ${checkoutRes.stderr}`,
      };
    }
  }

  const ffTarget = getHeadCommit(worktreePath) ?? worktreeBranch;
  const ffRes = runGit(repoRoot, ["merge", "--ff-only", ffTarget]);
  if (!ffRes.ok) {
    // Roll back newly created feature branch if ff somehow failed
    if (needsCreateFeatureBranch && parentBranch) {
      runGit(repoRoot, ["checkout", parentBranch]);
      runGit(repoRoot, ["branch", "-D", targetBranch]);
    }
    return {
      ok: false,
      mode,
      action: "error",
      targetBranch,
      message: `親リポジトリへのマージ (fast-forward) に失敗しました: ${ffRes.stderr || ffRes.stdout}`,
    };
  }

  const landedCommit = getHeadCommit(repoRoot);

  // 7. Clean up the task's worktree and temporary task branch
  removeTaskWorktree({
    parentPath: repoRoot,
    worktreePath,
    worktreeBranch,
    deleteBranch: true,
  });

  return {
    ok: true,
    mode,
    action: "landed",
    targetBranch,
    commitHash: landedCommit,
    message: needsCreateFeatureBranch
      ? `新しい作業ブランチ ${targetBranch} を作成し、変更を取り込みました。`
      : `${targetBranch} へ変更を取り込みました。`,
  };
}
