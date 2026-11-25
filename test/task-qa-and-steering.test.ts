import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserManager } from "../src/main/browser-manager.js";
import type { CliTurnCallbacks, RunningCliTurn } from "../src/main/cli-agent-runner.js";
import { CodexAppServerClient, type CodexNotification } from "../src/main/codex-client.js";
import {
  ConductorController,
  buildOrchestratorDeveloperInstructions,
} from "../src/main/conductor-controller.js";
import { conductorMCPTools, type MCPToolResult } from "../src/main/local-mcp-server.js";
import { StateStore } from "../src/main/state-store.js";
import {
  getGitDiffStat,
  readRecentAgyTranscriptExcerpt,
  resolveAgyTranscriptPath,
} from "../src/main/task-inspection.js";
import type { AgentTask, Project } from "../src/shared/types.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

function createFakeWorkerClient(overrides: {
  steerTurn?: (opts: {
    threadId: string;
    expectedTurnId: string;
    text: string;
    imagePaths?: string[];
  }) => Promise<string>;
  startTurn?: (opts: Record<string, unknown>) => Promise<string>;
  interruptTurn?: (threadId: string, turnId: string) => Promise<void>;
} = {}) {
  let seq = 0;
  let notificationListener: ((n: CodexNotification) => void) | null = null;
  const calls = {
    steerTurn: [] as Array<Record<string, unknown>>,
    startTurn: [] as Array<Record<string, unknown>>,
    interruptTurn: [] as Array<{ threadId: string; turnId: string }>,
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
    steerTurn: async (opts: {
      threadId: string;
      expectedTurnId: string;
      text: string;
      imagePaths?: string[];
    }) => {
      calls.steerTurn.push(opts);
      if (overrides.steerTurn) return overrides.steerTurn(opts);
      return opts.expectedTurnId;
    },
    startTurn: async (opts: Record<string, unknown>) => {
      calls.startTurn.push(opts);
      if (overrides.startTurn) return overrides.startTurn(opts);
      seq += 1;
      return `new-turn-${seq}`;
    },
    interruptTurn: async (threadId: string, turnId: string) => {
      calls.interruptTurn.push({ threadId, turnId });
      if (overrides.interruptTurn) return overrides.interruptTurn(threadId, turnId);
    },
  };

  return {
    client: client as unknown as CodexAppServerClient,
    calls,
    emitNotification: (n: CodexNotification) => notificationListener?.(n),
  };
}

function makeTask(
  overrides: Partial<AgentTask> & { id: string; taskNumber: number; title: string },
): AgentTask {
  return {
    summary: "",
    projectId: "proj-1",
    projectName: "demo-app",
    projectPath: "/tmp/demo-app",
    status: "running",
    provider: "codex",
    currentStep: "作業中...",
    workerThreadId: "thr-1",
    activeTurnId: "turn-1",
    previewURL: null,
    latestOutput: "",
    activities: [],
    createdAt: "2026-11-26T00:00:00.000Z",
    updatedAt: "2026-11-26T00:00:00.000Z",
    ...overrides,
  };
}

function callMcp(
  controller: ConductorController,
  name: string,
  args: Record<string, unknown>,
): Promise<MCPToolResult> {
  return (
    controller as unknown as {
      handleMCPToolCall: (n: string, a: Record<string, unknown>) => Promise<MCPToolResult>;
    }
  ).handleMCPToolCall(name, args);
}

describe("Orchestrator read-only Q&A instructions & MCP tool metadata", () => {
  it("explicitly routes task questions to get_task_detail and reserves send_to_worker for steering/follow-ups", () => {
    const instructions = buildOrchestratorDeveloperInstructions();
    expect(instructions).toContain("get_task_detail");
    expect(instructions).toContain("NEVER call `send_to_worker` just to ask a question");
    expect(instructions).toContain("NEVER wait or poll for a running task to finish");
    expect(instructions).toContain("steer");

    const tools = conductorMCPTools();
    const getDetail = tools.find((t) => t.name === "get_task_detail");
    const sendToWorker = tools.find((t) => t.name === "send_to_worker");

    expect(getDetail?.description).toMatch(/read-only/i);
    expect(getDetail?.description).toMatch(/non-blocking/i);
    expect(getDetail?.description).toMatch(/never `send_to_worker`/i);
    expect(sendToWorker?.description).toMatch(/steer/i);
    expect(sendToWorker?.description).toMatch(/never use this for read-only questions/i);
  });
});

describe("Non-blocking read-only get_task_detail enrichment", () => {
  it("reads git diff stat, truncates long prompts, preserves 20 recent activities, and parses AGY transcript tail", async () => {
    const storeDir = makeTempDir("conductor-detail-store-");
    const repoDir = makeTempDir("conductor-detail-repo-");
    const brainBaseDir = makeTempDir("conductor-detail-brain-");

    // Initialize a real temporary git repo with tracked modification + untracked file
    execFileSync("/usr/bin/git", ["-C", repoDir, "init"], { stdio: "ignore" });
    execFileSync("/usr/bin/git", ["-C", repoDir, "config", "user.email", "test@example.com"], {
      stdio: "ignore",
    });
    execFileSync("/usr/bin/git", ["-C", repoDir, "config", "user.name", "Tester"], {
      stdio: "ignore",
    });
    fs.writeFileSync(path.join(repoDir, "app.ts"), "export const v = 1;\n", "utf8");
    execFileSync("/usr/bin/git", ["-C", repoDir, "add", "app.ts"], { stdio: "ignore" });
    execFileSync("/usr/bin/git", ["-C", repoDir, "commit", "-m", "initial"], { stdio: "ignore" });

    // Modify tracked file and create an untracked file
    fs.writeFileSync(
      path.join(repoDir, "app.ts"),
      "export const v = 2;\nexport const extra = true;\n",
      "utf8",
    );
    fs.writeFileSync(path.join(repoDir, "notes.txt"), "draft\n", "utf8");

    // Prepare a synthetic AGY transcript.jsonl (with large padding so tail-only slicing is exercised)
    const convId = "conv-agy-123";
    const transcriptFile = path.join(brainBaseDir, convId, ".system_generated", "logs", "transcript.jsonl");
    fs.mkdirSync(path.dirname(transcriptFile), { recursive: true });
    const paddingLine = JSON.stringify({
      step_index: 0,
      type: "USER_INPUT",
      status: "DONE",
      content: "P".repeat(30_000),
    });
    const plannerLine = JSON.stringify({
      step_index: 5,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      thinking: "Analyzing TypeScript compiler errors in app.ts",
      tool_calls: [{ name: "edit_file", args: { Path: `\"${path.join(repoDir, "app.ts")}\"` } }],
    });
    const errorLine = JSON.stringify({
      step_index: 6,
      type: "GENERIC",
      status: "ERROR",
      content: "Command exited with code 1: TS2322 Type string is not assignable to number",
    });
    fs.writeFileSync(
      transcriptFile,
      [paddingLine, "{malformed-json", plannerLine, errorLine].join("\n") + "\n",
      "utf8",
    );

    // Direct helper checks (including path-traversal protection)
    expect(resolveAgyTranscriptPath("../escape", brainBaseDir)).toBeNull();
    expect(resolveAgyTranscriptPath(convId, brainBaseDir)).toBe(transcriptFile);
    expect(getGitDiffStat(repoDir)).toContain("app.ts");
    expect(getGitDiffStat(repoDir)).toContain("notes.txt");

    const excerpt = readRecentAgyTranscriptExcerpt(transcriptFile, { tailBytes: 4096 });
    expect(excerpt).toContain("Analyzing TypeScript compiler errors in app.ts");
    expect(excerpt).toContain("edit_file");
    expect(excerpt).toContain("TS2322");

    const longPrompt = "A".repeat(2500);
    const activities = Array.from({ length: 25 }, (_, i) => ({
      id: `act-${i + 1}`,
      kind: "command" as const,
      title: `Step ${i + 1}`,
      detail: `detail-${i + 1}`,
      timestamp: "2026-11-26T00:00:00.000Z",
    }));

    const task = makeTask({
      id: "task-agy-1",
      taskNumber: 12,
      title: "Live AGY task",
      projectPath: repoDir,
      worktreePath: repoDir,
      provider: "agy",
      status: "running",
      workerThreadId: convId,
      activeTurnId: null,
      workerPrompt: longPrompt,
      lastWorkerPrompt: "Focus on fixing TS2322 first",
      latestOutput: "",
      activities,
    });

    const controller = new ConductorController({
      store: new StateStore(storeDir),
      browser: createFakeBrowserManager(),
      onSnapshot: () => {},
      workerClient: createFakeWorkerClient().client,
      agyBrainBaseDir: brainBaseDir,
    });

    (controller as unknown as { tasks: AgentTask[] }).tasks = [task];
    (controller as unknown as { activeCliWorkers: Map<string, RunningCliTurn> }).activeCliWorkers.set(
      task.id,
      { cancel: () => {} },
    );

    const res = await callMcp(controller, "get_task_detail", { task_id: "T12" });
    expect(res.isError).toBeFalsy();
    const detail = JSON.parse(res.text) as Record<string, unknown>;

    expect(detail.is_worker_active).toBe(true);
    expect(detail.worktree_path).toBe(repoDir);
    expect(String(detail.worker_prompt)).toContain("[truncated 500 chars]");
    expect(detail.last_worker_prompt).toBe("Focus on fixing TS2322 first");
    expect(String(detail.git_status)).toContain("app.ts");
    expect(String(detail.git_diff_stat)).toContain("app.ts");
    expect(String(detail.git_diff_stat)).toContain("notes.txt");
    expect(detail.transcript_path).toBe(transcriptFile);
    expect(String(detail.recent_transcript_excerpt)).toContain("Analyzing TypeScript compiler errors");
    expect(String(detail.recent_transcript_excerpt)).toContain("TS2322");

    const recentActivities = detail.recent_activities as Array<{ title: string; detail: string }>;
    expect(recentActivities).toHaveLength(20);
    expect(recentActivities[0]).toMatchObject({ title: "Step 6", detail: "detail-6" });
    expect(recentActivities[19]).toMatchObject({ title: "Step 25", detail: "detail-25" });

    // When CLI worker is no longer active, is_worker_active becomes false
    (controller as unknown as { activeCliWorkers: Map<string, RunningCliTurn> }).activeCliWorkers.delete(
      task.id,
    );
    const idleRes = await callMcp(controller, "get_task_detail", { task_id: "T12" });
    expect((JSON.parse(idleRes.text) as { is_worker_active: boolean }).is_worker_active).toBe(false);
  });
});

describe("CodexAppServerClient.steerTurn & Codex send_to_worker steering", () => {
  it("sends turn/steer RPC with threadId, expectedTurnId, and text input and parses turnId", async () => {
    const client = new CodexAppServerClient("test-steer");
    const sentPayloads: Array<Record<string, unknown>> = [];

    (client as unknown as { proc: unknown }).proc = {
      stdin: {
        writable: true,
        write: (raw: string) => {
          const parsed = JSON.parse(raw.trim()) as Record<string, unknown>;
          sentPayloads.push(parsed);
          // Immediately simulate JSON-RPC response from codex app-server
          (client as unknown as { handleLine: (line: string) => void }).handleLine(
            JSON.stringify({
              id: parsed.id,
              result: { turnId: "turn-steered-42" },
            }),
          );
          return true;
        },
      },
    };

    const turnId = await client.steerTurn({
      threadId: "thr-99",
      expectedTurnId: "turn-42",
      text: "Switch to PostgreSQL instead of SQLite",
    });

    expect(turnId).toBe("turn-steered-42");
    expect(sentPayloads).toHaveLength(1);
    expect(sentPayloads[0]).toMatchObject({
      method: "turn/steer",
      params: {
        threadId: "thr-99",
        expectedTurnId: "turn-42",
        input: [
          {
            type: "text",
            text: "Switch to PostgreSQL instead of SQLite",
            text_elements: [],
          },
        ],
      },
    });
  });

  it("steers a running Codex worker in-place and falls back cleanly when steerTurn fails", async () => {
    const storeDir = makeTempDir("conductor-codex-steer-");
    const fakeWorker = createFakeWorkerClient({
      steerTurn: async (opts) => {
        if (opts.expectedTurnId === "turn-fail-steer") {
          throw new Error("activeTurnNotSteerable");
        }
        return opts.expectedTurnId;
      },
    });

    const controller = new ConductorController({
      store: new StateStore(storeDir),
      browser: createFakeBrowserManager(),
      onSnapshot: () => {},
      workerClient: fakeWorker.client,
    });

    const runningTask = makeTask({
      id: "codex-live",
      taskNumber: 1,
      title: "Codex live steer",
      status: "running",
      provider: "codex",
      workerThreadId: "thr-live",
      activeTurnId: "turn-live-1",
      workerPrompt: "Build REST API",
      latestOutput: "Working on endpoints...",
    });
    const fallbackTask = makeTask({
      id: "codex-fallback",
      taskNumber: 2,
      title: "Codex fallback steer",
      status: "running",
      provider: "codex",
      workerThreadId: "thr-fb",
      activeTurnId: "turn-fail-steer",
      workerPrompt: "Refactor auth",
    });
    const idleTask = makeTask({
      id: "codex-idle",
      taskNumber: 3,
      title: "Codex idle follow-up",
      status: "needs_review",
      provider: "codex",
      workerThreadId: "thr-idle",
      activeTurnId: null,
      workerPrompt: "Add tests",
    });

    (controller as unknown as { tasks: AgentTask[] }).tasks = [runningTask, fallbackTask, idleTask];

    // 1. Live in-place steer succeeds
    const steerRes = await callMcp(controller, "send_to_worker", {
      task_id: "T1",
      prompt: "Use Zod for request validation",
    });
    expect(steerRes.isError).toBeFalsy();
    expect(JSON.parse(steerRes.text)).toMatchObject({
      status: "steered",
      provider: "codex",
      task_id: "codex-live",
      turn_id: "turn-live-1",
    });
    expect(fakeWorker.calls.steerTurn).toHaveLength(1);
    expect(fakeWorker.calls.startTurn).toHaveLength(0);
    const updatedLive = controller.getSnapshot().tasks.find((t) => t.id === "codex-live")!;
    expect(updatedLive.currentStep).toBe("ステア指示を反映中...");
    expect(updatedLive.workerPrompt).toBe("Build REST API");
    expect(updatedLive.lastWorkerPrompt).toBe("Use Zod for request validation");
    expect(updatedLive.latestOutput).toBe("Working on endpoints...");
    expect(updatedLive.activities.some((a) => a.title.includes("Steered worker"))).toBe(true);

    // 2. Steer fails -> interrupts still-active turn and falls back to startTurn; stale turn/completed is ignored
    const fbRes = await callMcp(controller, "send_to_worker", {
      task_id: "T2",
      prompt: "Actually keep OAuth only",
    });
    expect(fbRes.isError).toBeFalsy();
    expect(JSON.parse(fbRes.text)).toMatchObject({
      status: "sent",
      provider: "codex",
      task_id: "codex-fallback",
      turn_id: "new-turn-1",
    });
    expect(fakeWorker.calls.interruptTurn).toEqual([
      { threadId: "thr-fb", turnId: "turn-fail-steer" },
    ]);
    expect(fakeWorker.calls.startTurn).toHaveLength(1);

    // Emit stale turn/completed for the old interrupted turnId — MUST NOT clobber new-turn-1!
    fakeWorker.emitNotification({
      method: "turn/completed",
      threadId: "thr-fb",
      turnId: "turn-fail-steer",
      itemId: null,
      params: { turn: { id: "turn-fail-steer", status: "interrupted" } },
    });
    const afterStaleNotif = controller.getSnapshot().tasks.find((t) => t.id === "codex-fallback")!;
    expect(afterStaleNotif.status).toBe("running");
    expect(afterStaleNotif.activeTurnId).toBe("new-turn-1");

    // 3. Idle Codex task uses startTurn directly without calling steerTurn
    const idleRes = await callMcp(controller, "send_to_worker", {
      task_id: "T3",
      prompt: "Also cover edge cases",
    });
    expect(idleRes.isError).toBeFalsy();
    expect(JSON.parse(idleRes.text)).toMatchObject({
      status: "sent",
      provider: "codex",
      task_id: "codex-idle",
    });
    expect(fakeWorker.calls.steerTurn).toHaveLength(2); // unchanged from T1 + T2
    expect(fakeWorker.calls.startTurn).toHaveLength(2);
  });
});

describe("CLI worker live steering & generation guard (AGY & Claude)", () => {
  it("supersedes a running AGY worker cleanly, waits for exit, and ignores stale callbacks", async () => {
    const storeDir = makeTempDir("conductor-cli-steer-store-");
    const projectDir = makeTempDir("conductor-cli-steer-proj-");

    const project: Project = {
      id: "proj-agy",
      name: "agy-app",
      path: projectDir,
      colorHex: "#3B82F6",
      gitBranch: null,
      addedAt: "2026-11-26T00:00:00.000Z",
    };

    const events: string[] = [];
    const agyRuns: Array<{
      opts: { prompt: string; conversationId?: string | null };
      callbacks: CliTurnCallbacks;
      cancel: ReturnType<typeof vi.fn>;
      resolveExit: () => void;
    }> = [];

    const controller = new ConductorController({
      store: new StateStore(storeDir),
      browser: createFakeBrowserManager(),
      onSnapshot: () => {},
      workerClient: createFakeWorkerClient().client,
      cliWorkerRunner: {
        runAgyTurn: (opts, callbacks): RunningCliTurn => {
          let resolveExit!: () => void;
          const exitPromise = new Promise<void>((resolve) => {
            resolveExit = resolve;
          });
          const runIdx = agyRuns.length + 1;
          events.push(`spawn-${runIdx}`);
          const cancel = vi.fn(() => {
            events.push(`cancel-${runIdx}`);
            // Simulate async process exit 15ms after SIGTERM
            setTimeout(() => {
              events.push(`exit-${runIdx}`);
              resolveExit();
            }, 15);
          });
          agyRuns.push({
            opts: { prompt: opts.prompt, conversationId: opts.conversationId },
            callbacks,
            cancel,
            resolveExit,
          });
          return {
            cancel,
            waitForExit: () => exitPromise,
          };
        },
      },
    });
    (controller as unknown as { projects: Project[] }).projects = [project];

    // Kick off initial AGY worker
    const startRes = await callMcp(controller, "start_worker", {
      project_name: "agy-app",
      title: "Build chart widget",
      prompt: "Create a bar chart component",
      provider: "agy",
    });
    expect(startRes.isError).toBeFalsy();
    const taskId = (JSON.parse(startRes.text) as { task: { id: string } }).task.id;
    expect(agyRuns).toHaveLength(1);

    // Emit session ID from run 1
    agyRuns[0]!.callbacks.onSessionId?.("agy-conv-001");
    expect(controller.getSnapshot().tasks.find((t) => t.id === taskId)?.workerThreadId).toBe(
      "agy-conv-001",
    );

    // Steer while run 1 is still active!
    const steerRes = await callMcp(controller, "send_to_worker", {
      task_id: taskId,
      prompt: "Make it a line chart instead",
    });
    expect(steerRes.isError).toBeFalsy();
    expect(JSON.parse(steerRes.text)).toMatchObject({
      status: "steered",
      provider: "agy",
      task_id: taskId,
    });

    // Verify clean ordering: run 1 cancelled & exited BEFORE run 2 spawned!
    expect(agyRuns[0]!.cancel).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["spawn-1", "cancel-1", "exit-1", "spawn-2"]);
    expect(agyRuns).toHaveLength(2);
    expect(agyRuns[1]!.opts.conversationId).toBe("agy-conv-001");
    expect(agyRuns[1]!.opts.prompt).toContain("LIVE STEER");
    expect(agyRuns[1]!.opts.prompt).toContain("Make it a line chart instead");

    const steeredTask = controller.getSnapshot().tasks.find((t) => t.id === taskId)!;
    expect(steeredTask.status).toBe("running");
    expect(steeredTask.currentStep).toBe("ステア指示を反映中...");
    expect(steeredTask.activities.some((a) => a.title === "Steered worker (AGY)")).toBe(true);

    // Now fire late/stale callbacks from the cancelled run 1!
    agyRuns[0]!.callbacks.onSessionId?.("stale-session-999");
    agyRuns[0]!.callbacks.onTextDelta?.("STALE OUTPUT FROM OLD WORKER");
    agyRuns[0]!.callbacks.onToolEvent?.({
      id: "stale-tool",
      name: "stale_cmd",
      completed: true,
      isError: true,
    });
    agyRuns[0]!.callbacks.onComplete?.({
      ok: false,
      finalText: "stale crash",
      errorMessage: "SIGTERM crash",
    });

    // State and activeCliWorkers MUST be completely unaffected by run 1's late callbacks
    const afterStale = controller.getSnapshot().tasks.find((t) => t.id === taskId)!;
    expect(afterStale.status).toBe("running");
    expect(afterStale.workerThreadId).toBe("agy-conv-001");
    expect(afterStale.latestOutput).toBe("");
    expect(afterStale.activities.some((a) => a.title === "stale_cmd")).toBe(false);
    expect(
      (controller as unknown as { activeCliWorkers: Map<string, RunningCliTurn> }).activeCliWorkers.has(
        taskId,
      ),
    ).toBe(true);

    // Now run 2 produces output and completes cleanly
    agyRuns[1]!.callbacks.onTextDelta?.("Implemented line chart successfully.");
    agyRuns[1]!.callbacks.onComplete?.({
      ok: true,
      finalText: "Implemented line chart successfully.",
    });

    const finished = controller.getSnapshot().tasks.find((t) => t.id === taskId)!;
    expect(finished.status).toBe("needs_review");
    expect(finished.latestOutput).toContain("Implemented line chart successfully.");
    expect(
      (controller as unknown as { activeCliWorkers: Map<string, RunningCliTurn> }).activeCliWorkers.has(
        taskId,
      ),
    ).toBe(false);
  });

  it("preserves original workerPrompt context when steering a CLI worker before sessionId is emitted", async () => {
    const storeDir = makeTempDir("conductor-claude-steer-store-");
    const projectDir = makeTempDir("conductor-claude-steer-proj-");

    const project: Project = {
      id: "proj-claude",
      name: "claude-app",
      path: projectDir,
      colorHex: "#10B981",
      gitBranch: null,
      addedAt: "2026-11-26T00:00:00.000Z",
    };

    const claudeCalls: Array<{
      prompt: string;
      sessionId?: string | null;
      systemPrompt?: string;
    }> = [];
    const cancelSpy = vi.fn();

    const controller = new ConductorController({
      store: new StateStore(storeDir),
      browser: createFakeBrowserManager(),
      onSnapshot: () => {},
      workerClient: createFakeWorkerClient().client,
      cliWorkerRunner: {
        runClaudeTurn: (opts, callbacks): RunningCliTurn => {
          claudeCalls.push({
            prompt: opts.prompt,
            sessionId: opts.sessionId,
            systemPrompt: opts.systemPrompt,
          });
          // Intentionally DO NOT emit onSessionId on run 1
          return {
            cancel: () => {
              cancelSpy();
              // Fire synchronous interrupted completion during cancel — must be ignored!
              callbacks.onComplete?.({ ok: false, finalText: "", interrupted: true });
            },
            waitForExit: () => Promise.resolve(),
          };
        },
      },
    });
    (controller as unknown as { projects: Project[] }).projects = [project];

    const startRes = await callMcp(controller, "start_worker", {
      project_name: "claude-app",
      title: "Migrate styles",
      prompt: "Migrate CSS modules to Tailwind across src/components",
      provider: "claude",
    });
    const taskId = (JSON.parse(startRes.text) as { task: { id: string } }).task.id;

    // Steer before run 1 emitted any session_id
    const steerRes = await callMcp(controller, "send_to_worker", {
      task_id: taskId,
      prompt: "Skip legacy/ folder for now",
    });
    expect(steerRes.isError).toBeFalsy();
    expect(JSON.parse(steerRes.text)).toMatchObject({
      status: "steered",
      provider: "claude",
      task_id: taskId,
    });
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(claudeCalls).toHaveLength(2);
    expect(claudeCalls[1]!.sessionId).toBeNull();
    expect(claudeCalls[1]!.prompt).toContain("Migrate CSS modules to Tailwind across src/components");
    expect(claudeCalls[1]!.prompt).toContain("Skip legacy/ folder for now");
    expect(claudeCalls[1]!.systemPrompt).toContain("claude-app");
    expect(controller.getSnapshot().tasks.find((t) => t.id === taskId)?.status).toBe("running");
  });
});
