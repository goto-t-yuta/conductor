import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserManager } from "../src/main/browser-manager.js";
import type { CliTurnCallbacks, RunningCliTurn } from "../src/main/cli-agent-runner.js";
import type { CodexAppServerClient } from "../src/main/codex-client.js";
import {
  ConductorController,
  WORKER_REPO_INSTRUCTION_FILES,
  buildOrchestratorDeveloperInstructions,
  buildWorkerDeveloperInstructions,
  buildWorkerRepoGuidelinesInstruction,
  findWorkerRepoInstructionFile,
} from "../src/main/conductor-controller.js";
import { conductorMCPTools, type MCPToolResult } from "../src/main/local-mcp-server.js";
import { StateStore } from "../src/main/state-store.js";
import type { Project } from "../src/shared/types.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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
  let seq = 0;
  const calls = {
    startThread: [] as Array<Record<string, unknown>>,
    startTurn: [] as Array<Record<string, unknown>>,
  };

  const client = {
    label: "fake-worker",
    isConnected: () => true,
    onNotification: () => () => {},
    onDisconnect: () => () => {},
    stop: () => {},
    startThread: async (opts: Record<string, unknown>) => {
      calls.startThread.push(opts);
      seq += 1;
      return `thr-${seq}`;
    },
    startTurn: async (opts: Record<string, unknown>) => {
      calls.startTurn.push(opts);
      seq += 1;
      return `turn-${seq}`;
    },
  };

  return {
    client: client as unknown as CodexAppServerClient,
    calls,
  };
}

function setProvidersAvailable(ctrl: ConductorController): void {
  (ctrl as unknown as Record<string, unknown>).isConnected = true;
  (ctrl as unknown as Record<string, unknown>).providers = {
    codex: {
      id: "codex",
      label: "Codex",
      available: true,
      detail: "ok",
      models: [
        {
          id: "gpt-5.4",
          model: "gpt-5.4",
          displayName: "GPT-5.4",
          description: "",
          supportedEfforts: ["low", "medium", "high"],
          defaultEffort: "medium",
          isDefault: true,
        },
      ],
    },
    agy: {
      id: "agy",
      label: "AGY",
      available: true,
      detail: "ok",
      models: [
        {
          id: "gemini-4-neon-high",
          model: "gemini-4-neon-high",
          displayName: "Gemini 4 Neon (High)",
          description: "",
          supportedEfforts: [],
          defaultEffort: "",
          isDefault: true,
        },
      ],
    },
    claude: {
      id: "claude",
      label: "Claude",
      available: true,
      detail: "ok",
      models: [
        {
          id: "claude-sonnet",
          model: "sonnet",
          displayName: "Claude Sonnet",
          description: "",
          supportedEfforts: ["low", "medium", "high"],
          defaultEffort: "medium",
          isDefault: true,
        },
      ],
    },
  };
}

async function callMcp(
  ctrl: ConductorController,
  name: string,
  args: Record<string, unknown>,
): Promise<MCPToolResult> {
  const internals = ctrl as unknown as {
    handleMCPToolCall: (n: string, a: Record<string, unknown>) => Promise<MCPToolResult>;
  };
  return internals.handleMCPToolCall(name, args);
}

describe("Worker repository guidelines auto-injection", () => {
  it("detects AGENTS.md first, then CLAUDE.md, then GEMINI.md, and returns null when absent", () => {
    expect(WORKER_REPO_INSTRUCTION_FILES).toEqual(["AGENTS.md", "CLAUDE.md", "GEMINI.md"]);

    const dirAll = makeTempDir("conductor-repo-all-");
    const secretBody = "SECRET_UNIQUE_GUIDELINE_BODY_DO_NOT_INLINE";
    fs.writeFileSync(path.join(dirAll, "AGENTS.md"), `# Agents\n${secretBody}\n`);
    fs.writeFileSync(path.join(dirAll, "CLAUDE.md"), "# Claude\n");
    fs.writeFileSync(path.join(dirAll, "GEMINI.md"), "# Gemini\n");

    const agentsPath = path.join(dirAll, "AGENTS.md");
    expect(findWorkerRepoInstructionFile(dirAll)).toBe(agentsPath);

    const agentsRule = buildWorkerRepoGuidelinesInstruction(dirAll);
    expect(agentsRule).not.toBeNull();
    expect(agentsRule).toContain("Repository Guidelines (REQUIRED):");
    expect(agentsRule).toContain(agentsPath);
    expect(agentsRule).toMatch(/BEFORE starting work/i);
    expect(agentsRule).toMatch(/deployment, verification, and operational rules/i);
    expect(agentsRule).toMatch(/completion criteria/i);
    expect(agentsRule).toMatch(/unless explicitly excluded/i);
    // Must not paste full file contents into prompt
    expect(agentsRule).not.toContain(secretBody);

    // CLAUDE.md only (even when GEMINI.md also exists)
    const dirClaude = makeTempDir("conductor-repo-claude-");
    const claudeBody = "CLAUDE_BODY_SHOULD_NOT_BE_INLINED";
    fs.writeFileSync(path.join(dirClaude, "CLAUDE.md"), claudeBody);
    fs.writeFileSync(path.join(dirClaude, "GEMINI.md"), "# Gemini\n");

    const claudePath = path.join(dirClaude, "CLAUDE.md");
    expect(findWorkerRepoInstructionFile(dirClaude)).toBe(claudePath);
    const claudeRule = buildWorkerRepoGuidelinesInstruction(dirClaude);
    expect(claudeRule).toContain(claudePath);
    expect(claudeRule).not.toContain(claudeBody);

    // GEMINI.md only
    const dirGemini = makeTempDir("conductor-repo-gemini-");
    fs.writeFileSync(path.join(dirGemini, "GEMINI.md"), "# Gemini\n");
    const geminiPath = path.join(dirGemini, "GEMINI.md");
    expect(findWorkerRepoInstructionFile(dirGemini)).toBe(geminiPath);
    expect(buildWorkerRepoGuidelinesInstruction(dirGemini)).toContain(geminiPath);

    // None present (and ignore directories with the same name)
    const dirEmpty = makeTempDir("conductor-repo-empty-");
    fs.mkdirSync(path.join(dirEmpty, "AGENTS.md"));
    expect(findWorkerRepoInstructionFile(dirEmpty)).toBeNull();
    expect(buildWorkerRepoGuidelinesInstruction(dirEmpty)).toBeNull();
  });

  it("falls back to projectPath when worktree cwd has no instruction file, while preferring cwd when present", () => {
    const projectDir = makeTempDir("conductor-repo-proj-");
    const worktreeDir = makeTempDir("conductor-repo-wt-");

    fs.writeFileSync(path.join(projectDir, "AGENTS.md"), "# Root AGENTS\n");

    // Worktree has no instruction file -> falls back to projectDir/AGENTS.md
    expect(findWorkerRepoInstructionFile(worktreeDir, projectDir)).toBe(
      path.join(projectDir, "AGENTS.md"),
    );

    // Worktree has CLAUDE.md -> prefers worktree's own file over fallbackDir
    fs.writeFileSync(path.join(worktreeDir, "CLAUDE.md"), "# Worktree CLAUDE\n");
    expect(findWorkerRepoInstructionFile(worktreeDir, projectDir)).toBe(
      path.join(worktreeDir, "CLAUDE.md"),
    );
  });

  it("injects concise repo guidelines into buildWorkerDeveloperInstructions only when a file exists", () => {
    const dirWithAgents = makeTempDir("conductor-dev-agents-");
    const agentsPath = path.join(dirWithAgents, "AGENTS.md");
    fs.writeFileSync(agentsPath, "Deploy to dev and verify live endpoint.\n");

    const withAgents = buildWorkerDeveloperInstructions({
      projectName: "pps-option-value",
      cwd: dirWithAgents,
      worktreeBranch: "conductor/task-1",
      preferredLanguage: "ja",
    });
    expect(withAgents).toContain("Repository Guidelines (REQUIRED):");
    expect(withAgents).toContain(agentsPath);
    expect(withAgents).not.toContain("Deploy to dev and verify live endpoint.");

    const dirWithout = makeTempDir("conductor-dev-none-");
    const withoutGuidelines = buildWorkerDeveloperInstructions({
      projectName: "plain-repo",
      cwd: dirWithout,
      preferredLanguage: "ja",
    });
    expect(withoutGuidelines).not.toContain("Repository Guidelines (REQUIRED):");
  });

  it("injects repo guidelines across start_worker for Codex, AGY, and Claude (AGENTS.md / CLAUDE.md / none)", async () => {
    const dataDir = makeTempDir("conductor-start-worker-data-");
    const agentsProjectDir = makeTempDir("conductor-start-worker-agents-");
    const claudeProjectDir = makeTempDir("conductor-start-worker-claude-");
    const emptyProjectDir = makeTempDir("conductor-start-worker-empty-");

    const agentsPath = path.join(agentsProjectDir, "AGENTS.md");
    const claudePath = path.join(claudeProjectDir, "CLAUDE.md");
    fs.writeFileSync(agentsPath, "DO_NOT_INLINE_AGENTS_CONTENT");
    fs.writeFileSync(claudePath, "DO_NOT_INLINE_CLAUDE_CONTENT");

    const store = new StateStore(dataDir);
    const fakeWorker = createFakeWorkerClient();
    const agyCalls: Array<{ cwd: string; prompt: string }> = [];
    const claudeCalls: Array<{ cwd: string; prompt: string; systemPrompt?: string }> = [];

    const controller = new ConductorController({
      store,
      browser: createFakeBrowserManager(),
      onSnapshot: () => {},
      workerClient: fakeWorker.client,
      cliWorkerRunner: {
        runAgyTurn: (opts, callbacks: CliTurnCallbacks): RunningCliTurn => {
          agyCalls.push({ cwd: opts.cwd, prompt: opts.prompt });
          callbacks.onSessionId?.(`agy-sess-${agyCalls.length}`);
          return { cancel: vi.fn(), waitForExit: async () => {} };
        },
        runClaudeTurn: (opts, callbacks: CliTurnCallbacks): RunningCliTurn => {
          claudeCalls.push({
            cwd: opts.cwd,
            prompt: opts.prompt,
            systemPrompt: opts.systemPrompt,
          });
          callbacks.onSessionId?.(`claude-sess-${claudeCalls.length}`);
          return { cancel: vi.fn(), waitForExit: async () => {} };
        },
      },
    });
    setProvidersAvailable(controller);

    const agentsProject: Project = controller.registerProject(agentsProjectDir, "proj-agents")!;
    const claudeProject: Project = controller.registerProject(claudeProjectDir, "proj-claude")!;
    const emptyProject: Project = controller.registerProject(emptyProjectDir, "proj-empty")!;

    // 1. Project with AGENTS.md -> Codex, AGY, Claude all receive path & rule without full file body
    await callMcp(controller, "start_worker", {
      project_name: agentsProject.name,
      title: "Codex AGENTS",
      prompt: "Implement feature",
      provider: "codex",
    });
    const codexAgentsInstr = String(fakeWorker.calls.startThread.at(-1)?.developerInstructions);
    expect(codexAgentsInstr).toContain("Repository Guidelines (REQUIRED):");
    expect(codexAgentsInstr).toContain(agentsPath);
    expect(codexAgentsInstr).not.toContain("DO_NOT_INLINE_AGENTS_CONTENT");

    await callMcp(controller, "start_worker", {
      project_name: agentsProject.name,
      title: "AGY AGENTS",
      prompt: "Implement feature",
      provider: "agy",
    });
    const agyAgentsPrompt = agyCalls.at(-1)?.prompt ?? "";
    expect(agyAgentsPrompt).toContain("Repository Guidelines (REQUIRED):");
    expect(agyAgentsPrompt).toContain(agentsPath);
    expect(agyAgentsPrompt).not.toContain("DO_NOT_INLINE_AGENTS_CONTENT");
    expect(agyAgentsPrompt.indexOf(agentsPath)).toBeLessThan(
      agyAgentsPrompt.indexOf("Implement feature"),
    );

    await callMcp(controller, "start_worker", {
      project_name: agentsProject.name,
      title: "Claude AGENTS",
      prompt: "Implement feature",
      provider: "claude",
    });
    const claudeAgentsSys = claudeCalls.at(-1)?.systemPrompt ?? "";
    expect(claudeAgentsSys).toContain("Repository Guidelines (REQUIRED):");
    expect(claudeAgentsSys).toContain(agentsPath);
    expect(claudeAgentsSys).not.toContain("DO_NOT_INLINE_AGENTS_CONTENT");

    // 2. Project with CLAUDE.md only -> Codex, AGY, Claude receive CLAUDE.md path
    await callMcp(controller, "start_worker", {
      project_name: claudeProject.name,
      title: "Codex CLAUDE",
      prompt: "Fix bug",
      provider: "codex",
    });
    expect(String(fakeWorker.calls.startThread.at(-1)?.developerInstructions)).toContain(claudePath);

    await callMcp(controller, "start_worker", {
      project_name: claudeProject.name,
      title: "AGY CLAUDE",
      prompt: "Fix bug",
      provider: "agy",
    });
    expect(agyCalls.at(-1)?.prompt).toContain(claudePath);

    await callMcp(controller, "start_worker", {
      project_name: claudeProject.name,
      title: "Claude CLAUDE",
      prompt: "Fix bug",
      provider: "claude",
    });
    expect(claudeCalls.at(-1)?.systemPrompt).toContain(claudePath);

    // 3. Project with none -> Codex, AGY, Claude receive NO Repository Guidelines section
    await callMcp(controller, "start_worker", {
      project_name: emptyProject.name,
      title: "Codex Empty",
      prompt: "Refactor",
      provider: "codex",
    });
    expect(String(fakeWorker.calls.startThread.at(-1)?.developerInstructions)).not.toContain(
      "Repository Guidelines (REQUIRED):",
    );

    await callMcp(controller, "start_worker", {
      project_name: emptyProject.name,
      title: "AGY Empty",
      prompt: "Refactor",
      provider: "agy",
    });
    expect(agyCalls.at(-1)?.prompt).not.toContain("Repository Guidelines (REQUIRED):");

    await callMcp(controller, "start_worker", {
      project_name: emptyProject.name,
      title: "Claude Empty",
      prompt: "Refactor",
      provider: "claude",
    });
    expect(claudeCalls.at(-1)?.systemPrompt).not.toContain("Repository Guidelines (REQUIRED):");
  });

  it("instructs the Orchestrator not to narrow repository AGENTS.md completion criteria in start_worker prompts", () => {
    const orchestratorInstructions = buildOrchestratorDeveloperInstructions();
    expect(orchestratorInstructions).toContain("AGENTS.md");
    expect(orchestratorInstructions).toMatch(/narrower completion criteria/i);
    expect(orchestratorInstructions).toMatch(/verification, deployment, or operational policy/i);

    const startWorkerTool = conductorMCPTools().find((t) => t.name === "start_worker");
    const promptDesc = String(
      ((startWorkerTool?.inputSchema as Record<string, unknown>)?.properties as Record<
        string,
        { description?: string }
      >)?.prompt?.description ?? "",
    );
    expect(promptDesc).toContain("AGENTS.md");
    expect(promptDesc).toMatch(/do not narrow or override/i);
  });
});
