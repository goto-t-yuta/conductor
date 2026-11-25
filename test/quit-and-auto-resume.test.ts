import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BrowserManager } from "../src/main/browser-manager.js";
import type { CliTurnCallbacks, RunningCliTurn } from "../src/main/cli-agent-runner.js";
import type { CodexAppServerClient } from "../src/main/codex-client.js";
import { ConductorController } from "../src/main/conductor-controller.js";
import {
  MAX_QUIT_DIALOG_TASKS,
  QuitGuard,
  buildQuitConfirmationDialog,
  type QuitTaskSummary,
} from "../src/main/quit-guard.js";
import { StateStore } from "../src/main/state-store.js";
import {
  buildFallbackRerunPrompt,
  buildSessionResumePrompt,
  markTasksForAutoResumeOnShutdown,
  prepareTasksForStartupAutoResume,
} from "../src/main/task-auto-resume.js";
import type { AgentTask, Project } from "../src/shared/types.js";

function createFakeBrowserManager(): BrowserManager {
  return {
    getTabs: () => [],
    getActiveTabId: () => null,
    getActiveTab: () => null,
    isPickingElement: () => false,
    restore: () => {},
  } as unknown as BrowserManager;
}

function makeTask(overrides: Partial<AgentTask> & { id: string; taskNumber: number; title: string }): AgentTask {
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

function createFakeWorkerClient(overrides: {
  connected?: boolean;
  resumeThread?: (opts: Record<string, unknown>) => Promise<string>;
  startThread?: (opts: Record<string, unknown>) => Promise<string>;
  startTurn?: (opts: Record<string, unknown>) => Promise<string>;
  interruptTurn?: (threadId: string, turnId: string) => Promise<void>;
} = {}) {
  let seq = 0;
  const calls = {
    resumeThread: [] as Array<Record<string, unknown>>,
    startThread: [] as Array<Record<string, unknown>>,
    startTurn: [] as Array<Record<string, unknown>>,
    interruptTurn: [] as Array<{ threadId: string; turnId: string }>,
    stopped: 0,
  };

  const client = {
    label: "fake-worker",
    isConnected: () => overrides.connected ?? true,
    onNotification: () => () => {},
    onDisconnect: () => () => {},
    stop: () => {
      calls.stopped += 1;
    },
    resumeThread: async (opts: Record<string, unknown>) => {
      calls.resumeThread.push(opts);
      if (overrides.resumeThread) return overrides.resumeThread(opts);
      return String(opts.threadId);
    },
    startThread: async (opts: Record<string, unknown>) => {
      calls.startThread.push(opts);
      if (overrides.startThread) return overrides.startThread(opts);
      seq += 1;
      return `fresh-thr-${seq}`;
    },
    startTurn: async (opts: Record<string, unknown>) => {
      calls.startTurn.push(opts);
      if (overrides.startTurn) return overrides.startTurn(opts);
      seq += 1;
      return `turn-${seq}`;
    },
    interruptTurn: async (threadId: string, turnId: string) => {
      calls.interruptTurn.push({ threadId, turnId });
      if (overrides.interruptTurn) return overrides.interruptTurn(threadId, turnId);
    },
  };

  return {
    client: client as unknown as CodexAppServerClient,
    calls,
  };
}

function setControllerProviders(
  ctrl: ConductorController,
  avail: { codex?: boolean; agy?: boolean; claude?: boolean },
): void {
  (ctrl as unknown as Record<string, unknown>).isConnected = Boolean(
    avail.codex || avail.agy || avail.claude,
  );
  (ctrl as unknown as Record<string, unknown>).providers = {
    codex: {
      id: "codex",
      label: "Codex",
      available: Boolean(avail.codex),
      detail: avail.codex ? "接続済み" : "未検出",
      models: avail.codex
        ? [
            {
              id: "gpt-5.4",
              model: "gpt-5.4",
              displayName: "GPT-5.4",
              description: "",
              supportedEfforts: ["low", "medium", "high"],
              defaultEffort: "medium",
              isDefault: true,
            },
          ]
        : [],
    },
    agy: {
      id: "agy",
      label: "AGY",
      available: Boolean(avail.agy),
      detail: avail.agy ? "利用可能" : "未検出",
      models: avail.agy
        ? [
            {
              id: "gemini-4-neon-high",
              model: "gemini-4-neon-high",
              displayName: "Gemini 4 Neon (High)",
              description: "",
              supportedEfforts: [],
              defaultEffort: "",
              isDefault: true,
            },
          ]
        : [],
    },
    claude: {
      id: "claude",
      label: "Claude",
      available: Boolean(avail.claude),
      detail: avail.claude ? "利用可能" : "未検出",
      models: avail.claude
        ? [
            {
              id: "claude-sonnet",
              model: "sonnet",
              displayName: "Claude Sonnet",
              description: "",
              supportedEfforts: ["low", "medium", "high"],
              defaultEffort: "medium",
              isDefault: true,
            },
          ]
        : [],
    },
  };
}

describe("Quit confirmation dialog & QuitGuard", () => {
  it("formats up to 5 running task titles and summarizes overflow with +N", () => {
    const tasks: QuitTaskSummary[] = Array.from({ length: 7 }, (_, i) => ({
      id: `t-${i + 1}`,
      taskNumber: i + 1,
      projectName: `proj-${i + 1}`,
      title: `Task Title ${i + 1}`,
    }));

    const dialog = buildQuitConfirmationDialog(tasks);
    expect(dialog.type).toBe("warning");
    expect(dialog.cancelId).toBe(0);
    expect(dialog.defaultId).toBe(0);
    expect(dialog.buttons).toHaveLength(2);
    expect(dialog.message).toContain("7");
    expect(dialog.detail).toContain("自動");
    for (let i = 1; i <= MAX_QUIT_DIALOG_TASKS; i += 1) {
      expect(dialog.detail).toContain(`[T${i} · proj-${i}] Task Title ${i}`);
    }
    expect(dialog.detail).not.toContain("Task Title 6");
    expect(dialog.detail).toContain("+2");
  });

  it("skips dialog when no tasks are running, runs shutdown once, and lets confirmed quit proceed", async () => {
    const showConfirmationDialog = vi.fn().mockResolvedValue(true);
    const performShutdown = vi.fn().mockResolvedValue(undefined);
    let quitGuard!: QuitGuard;
    let reentrantPrevented = false;
    const quitApp = vi.fn(() => {
      const secondEvent = {
        preventDefault: () => {
          reentrantPrevented = true;
        },
      };
      void quitGuard.handleBeforeQuit(secondEvent);
    });

    quitGuard = new QuitGuard({
      getRunningTasks: () => [],
      showConfirmationDialog,
      performShutdown,
      quitApp,
    });

    const firstPrevent = vi.fn();
    await quitGuard.handleBeforeQuit({ preventDefault: firstPrevent });

    expect(firstPrevent).toHaveBeenCalledTimes(1);
    expect(showConfirmationDialog).not.toHaveBeenCalled();
    expect(performShutdown).toHaveBeenCalledTimes(1);
    expect(quitApp).toHaveBeenCalledTimes(1);
    expect(reentrantPrevented).toBe(false);
    expect(quitGuard.getState().isQuitConfirmed).toBe(true);
  });

  it("cancels quit safely without shutting down when user chooses Cancel", async () => {
    const running: QuitTaskSummary[] = [
      { id: "t1", taskNumber: 1, projectName: "app", title: "Fix login bug" },
    ];
    const showConfirmationDialog = vi.fn().mockResolvedValue(false);
    const performShutdown = vi.fn().mockResolvedValue(undefined);
    const quitApp = vi.fn();

    const guard = new QuitGuard({
      getRunningTasks: () => running,
      showConfirmationDialog,
      performShutdown,
      quitApp,
    });

    const prevent1 = vi.fn();
    await guard.handleBeforeQuit({ preventDefault: prevent1 });

    expect(prevent1).toHaveBeenCalledTimes(1);
    expect(showConfirmationDialog).toHaveBeenCalledTimes(1);
    expect(performShutdown).not.toHaveBeenCalled();
    expect(quitApp).not.toHaveBeenCalled();
    expect(guard.getState()).toEqual({
      isQuitConfirmed: false,
      isQuitDialogOpen: false,
      isShuttingDown: false,
    });

    // Subsequent quit attempt prompts again
    const prevent2 = vi.fn();
    await guard.handleBeforeQuit({ preventDefault: prevent2 });
    expect(showConfirmationDialog).toHaveBeenCalledTimes(2);
  });

  it("guards against re-entrancy while dialog is open and while shutting down", async () => {
    const running: QuitTaskSummary[] = [
      { id: "t1", taskNumber: 1, projectName: "app", title: "Run migration" },
    ];

    let resolveDialog!: (confirmed: boolean) => void;
    const showConfirmationDialog = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveDialog = resolve;
        }),
    );

    let resolveShutdown!: () => void;
    const performShutdown = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveShutdown = resolve;
        }),
    );

    let guard!: QuitGuard;
    const finalPrevent = vi.fn();
    const quitApp = vi.fn(() => {
      void guard.handleBeforeQuit({ preventDefault: finalPrevent });
    });

    guard = new QuitGuard({
      getRunningTasks: () => running,
      showConfirmationDialog,
      performShutdown,
      quitApp,
    });

    const p1 = guard.handleBeforeQuit({ preventDefault: vi.fn() });
    expect(guard.getState().isQuitDialogOpen).toBe(true);

    // Trigger Cmd+Q again while dialog is open — must NOT open a second dialog
    const dupPreventDuringDialog = vi.fn();
    const p2 = guard.handleBeforeQuit({ preventDefault: dupPreventDuringDialog });
    expect(dupPreventDuringDialog).toHaveBeenCalledTimes(1);
    expect(showConfirmationDialog).toHaveBeenCalledTimes(1);

    // User confirms quit -> shutdown begins
    resolveDialog(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(guard.getState().isShuttingDown).toBe(true);
    expect(performShutdown).toHaveBeenCalledTimes(1);

    // Trigger Cmd+Q again while shutdown is in progress — must NOT re-open dialog or double-shutdown
    const dupPreventDuringShutdown = vi.fn();
    const p3 = guard.handleBeforeQuit({ preventDefault: dupPreventDuringShutdown });
    expect(dupPreventDuringShutdown).toHaveBeenCalledTimes(1);
    expect(showConfirmationDialog).toHaveBeenCalledTimes(1);
    expect(performShutdown).toHaveBeenCalledTimes(1);

    resolveShutdown();
    await Promise.all([p1, p2, p3]);

    expect(quitApp).toHaveBeenCalledTimes(1);
    expect(finalPrevent).not.toHaveBeenCalled();
    expect(guard.getState().isQuitConfirmed).toBe(true);
  });
});

describe("Auto-resume pure state transitions & prompts", () => {
  it("marks only running (and pending-resume) tasks on shutdown and clears flags on startup load", () => {
    const tasks: AgentTask[] = [
      makeTask({ id: "running-1", taskNumber: 1, title: "Active task", status: "running" }),
      makeTask({ id: "done-1", taskNumber: 2, title: "Done task", status: "done" }),
      makeTask({ id: "review-1", taskNumber: 3, title: "Stopped task", status: "needs_review" }),
      makeTask({ id: "crashed-1", taskNumber: 4, title: "Already queued", status: "queued" }),
    ];

    const shutdownRes = markTasksForAutoResumeOnShutdown(tasks, [], "2026-11-26T01:00:00.000Z");
    expect(shutdownRes.markedTaskIds).toEqual(["running-1"]);
    const runningMarked = shutdownRes.tasks.find((t) => t.id === "running-1")!;
    expect(runningMarked.autoResumeOnStartup).toBe(true);
    expect(runningMarked.status).toBe("queued");
    expect(runningMarked.activeTurnId).toBeNull();
    expect(shutdownRes.tasks.find((t) => t.id === "done-1")?.autoResumeOnStartup).toBeUndefined();
    expect(shutdownRes.tasks.find((t) => t.id === "review-1")?.autoResumeOnStartup).toBeUndefined();

    // Simulate an additional task that was left `running` by an unclean crash
    const persistedWithCrash: AgentTask[] = [
      ...shutdownRes.tasks,
      makeTask({ id: "crash-2", taskNumber: 5, title: "Crash task", status: "running" }),
    ];

    const startupRes = prepareTasksForStartupAutoResume(persistedWithCrash);
    expect(startupRes.changed).toBe(true);
    expect(startupRes.resumeTaskIds).toEqual(["running-1", "crash-2"]);
    for (const id of ["running-1", "crash-2"]) {
      const prepared = startupRes.tasks.find((t) => t.id === id)!;
      expect(prepared.autoResumeOnStartup).toBe(false);
      expect(prepared.status).toBe("queued");
      expect(prepared.activeTurnId).toBeNull();
    }

    // Loading a second time does NOT re-trigger auto-resume (prevents infinite loops)
    const secondLoad = prepareTasksForStartupAutoResume(startupRes.tasks);
    expect(secondLoad.resumeTaskIds).toEqual([]);
    expect(secondLoad.changed).toBe(false);
  });

  it("builds clear session-resume and fallback-rerun prompts", () => {
    const task = makeTask({
      id: "t1",
      taskNumber: 1,
      title: "Build dashboard",
      workerPrompt: "Create the metrics dashboard with unit tests.",
      lastWorkerPrompt: "Also add dark mode support.",
      worktreeBranch: "conductor/t1-dashboard",
    });

    const resumePrompt = buildSessionResumePrompt(task);
    expect(resumePrompt).toContain("restarted");
    expect(resumePrompt).toContain("git status");
    expect(resumePrompt).toContain("conductor/t1-dashboard");

    const fallbackPrompt = buildFallbackRerunPrompt(task);
    expect(fallbackPrompt).toContain("Create the metrics dashboard with unit tests.");
    expect(fallbackPrompt).toContain("Also add dark mode support.");
    expect(fallbackPrompt).toContain("do not overwrite");
    expect(fallbackPrompt).toContain("conductor/t1-dashboard");
  });
});

describe("ConductorController shutdown persistence & startup auto-resume", () => {
  it("persists autoResumeOnStartup BEFORE killing CLI workers during shutdown and ignores shutdown interrupts", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-shutdown-resume-"));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-proj-"));
    try {
      const store = new StateStore(tmpDir);
      const project: Project = {
        id: "proj-1",
        name: "my-app",
        path: projectDir,
        colorHex: "#3B82F6",
        gitBranch: null,
        addedAt: "2026-11-26T00:00:00.000Z",
      };

      const cliCancelEvents: string[] = [];
      let capturedCallbacks: CliTurnCallbacks | null = null;
      const fakeWorker = createFakeWorkerClient();

      const ctrl = new ConductorController({
        store,
        browser: createFakeBrowserManager(),
        onSnapshot: () => {},
        workerClient: fakeWorker.client,
        cliWorkerRunner: {
          runAgyTurn: (_opts, callbacks): RunningCliTurn => {
            capturedCallbacks = callbacks;
            // Immediately report an AGY conversation ID so it gets persisted
            callbacks.onSessionId?.("agy-conv-77");
            return {
              cancel: () => {
                // Verify state.json ALREADY has autoResumeOnStartup: true BEFORE child process is cancelled!
                const onDiskBeforeCancel = new StateStore(tmpDir).load();
                const agyTaskOnDisk = onDiskBeforeCancel.tasks.find((t) => t.provider === "agy");
                expect(agyTaskOnDisk?.autoResumeOnStartup).toBe(true);
                cliCancelEvents.push("cancelled");
                // Simulate process exit firing onComplete(interrupted: true) during shutdown
                callbacks.onComplete?.({ ok: false, finalText: "", interrupted: true });
              },
            };
          },
        },
      });
      setControllerProviders(ctrl, { codex: true, agy: true });
      (ctrl as unknown as { projects: Project[] }).projects = [project];

      // Start an AGY worker via internal helper and a Codex running task + a manually stopped task
      const handleMCP = (
        ctrl as unknown as {
          handleMCPToolCall: (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>;
        }
      ).handleMCPToolCall.bind(ctrl);

      const agyStart = await handleMCP("start_worker", {
        project_name: "my-app",
        title: "AGY running task",
        prompt: "Implement feature X",
        provider: "agy",
      });
      expect(agyStart.isError).toBeFalsy();
      expect(capturedCallbacks).not.toBeNull();

      const codexStart = await handleMCP("start_worker", {
        project_name: "my-app",
        title: "Codex running task",
        prompt: "Fix bug Y",
        provider: "codex",
      });
      expect(codexStart.isError).toBeFalsy();

      const stoppedStart = await handleMCP("start_worker", {
        project_name: "my-app",
        title: "Manually stopped task",
        prompt: "Task Z",
        provider: "codex",
      });
      const stoppedTaskId = (JSON.parse(stoppedStart.text) as { task: { id: string } }).task.id;
      await ctrl.stopTaskWorker(stoppedTaskId);

      // Verify getRunningTasks only returns the 2 running tasks
      expect(ctrl.getRunningTasks().map((t) => t.title).sort()).toEqual([
        "AGY running task",
        "Codex running task",
      ]);

      // Clean shutdown
      await ctrl.shutdown();

      expect(cliCancelEvents).toEqual(["cancelled"]);
      expect(fakeWorker.calls.stopped).toBe(1);

      // Verify persisted state preserves autoResumeOnStartup: true for the 2 running tasks,
      // includes their workerThreadId + workerPrompt, and did NOT mark the manually stopped task.
      const saved = new StateStore(tmpDir).load();
      const savedAgy = saved.tasks.find((t) => t.title === "AGY running task")!;
      const savedCodex = saved.tasks.find((t) => t.title === "Codex running task")!;
      const savedStopped = saved.tasks.find((t) => t.title === "Manually stopped task")!;

      expect(savedAgy.autoResumeOnStartup).toBe(true);
      expect(savedAgy.workerThreadId).toBe("agy-conv-77");
      expect(savedAgy.workerPrompt).toBe("Implement feature X");
      expect(savedCodex.autoResumeOnStartup).toBe(true);
      expect(savedCodex.workerThreadId).toBe("fresh-thr-1");
      expect(savedCodex.workerPrompt).toBe("Fix bug Y");
      expect(savedStopped.autoResumeOnStartup).toBe(false);
      expect(savedStopped.status).toBe("needs_review");

      // No bogus interrupted chat banner was appended during shutdown
      expect(saved.messages.filter((m) => m.role === "taskEvent")).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("resumes Codex (existing thread + fallback + fresh), AGY (with resume-failure retry), Claude, and handles missing paths/providers gracefully", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-autoresume-"));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-proj-live-"));
    const missingDir = path.join(os.tmpdir(), `conductor-nonexistent-${Date.now()}`);

    try {
      const store = new StateStore(tmpDir);
      const project: Project = {
        id: "proj-live",
        name: "live-app",
        path: projectDir,
        colorHex: "#10B981",
        gitBranch: null,
        addedAt: "2026-11-26T00:00:00.000Z",
      };

      const persistedTasks: AgentTask[] = [
        // 1. Codex clean-shutdown task with resumable thread
        makeTask({
          id: "codex-resume",
          taskNumber: 1,
          title: "Codex resumable",
          projectId: project.id,
          projectName: project.name,
          projectPath: project.path,
          status: "queued",
          autoResumeOnStartup: true,
          provider: "codex",
          workerThreadId: "codex-thr-ok",
          workerPrompt: "Finish API refactor",
        }),
        // 2. Codex crash/unclean-exit task (still status=running, no autoResumeOnStartup flag) whose resumeThread fails -> fallback fresh thread
        makeTask({
          id: "codex-fallback",
          taskNumber: 2,
          title: "Codex fallback",
          projectId: project.id,
          projectName: project.name,
          projectPath: project.path,
          status: "running",
          provider: "codex",
          workerThreadId: "codex-thr-expired",
          workerPrompt: "Migrate database schema safely",
        }),
        // 3. Codex task with NO saved workerThreadId -> fresh thread with original prompt
        makeTask({
          id: "codex-no-thread",
          taskNumber: 3,
          title: "Codex fresh",
          projectId: project.id,
          projectName: project.name,
          projectPath: project.path,
          status: "queued",
          autoResumeOnStartup: true,
          provider: "codex",
          workerThreadId: null,
          workerPrompt: "Write integration tests",
        }),
        // 4. AGY task whose saved conversationId fails before output -> auto-retries without conversationId
        makeTask({
          id: "agy-retry",
          taskNumber: 4,
          title: "AGY auto-retry",
          projectId: project.id,
          projectName: project.name,
          projectPath: project.path,
          status: "queued",
          autoResumeOnStartup: true,
          provider: "agy",
          workerThreadId: "agy-conv-expired",
          workerPrompt: "Polish landing page styles",
        }),
        // 5. Claude task with saved sessionId -> resumes with sessionId
        makeTask({
          id: "claude-resume",
          taskNumber: 5,
          title: "Claude resumable",
          projectId: project.id,
          projectName: project.name,
          projectPath: project.path,
          status: "running",
          provider: "claude",
          workerThreadId: "claude-sess-5",
          workerPrompt: "Audit security headers",
        }),
        // 6. Task with missing project path -> fails gracefully without crashing startup
        makeTask({
          id: "missing-path",
          taskNumber: 6,
          title: "Deleted project task",
          projectId: "proj-deleted",
          projectName: "deleted-app",
          projectPath: missingDir,
          status: "queued",
          autoResumeOnStartup: true,
          provider: "codex",
          workerThreadId: "thr-dead",
          workerPrompt: "Should fail gracefully",
        }),
        // 7. Task whose provider is unavailable -> fails gracefully
        makeTask({
          id: "unavailable-provider",
          taskNumber: 7,
          title: "Claude disabled task",
          projectId: project.id,
          projectName: project.name,
          projectPath: project.path,
          status: "queued",
          autoResumeOnStartup: true,
          provider: "claude",
          workerThreadId: "claude-unavail",
          workerPrompt: "Won't run if claude unavailable",
        }),
        // 8. Completed task -> untouched
        makeTask({
          id: "already-done",
          taskNumber: 8,
          title: "Already done",
          projectId: project.id,
          projectName: project.name,
          projectPath: project.path,
          status: "done",
          provider: "codex",
          workerThreadId: "thr-done",
        }),
      ];

      // Remove task 7 from this first pass and test unavailable provider cleanly in a second pass below
      const pass1Tasks = persistedTasks.filter((t) => t.id !== "unavailable-provider");

      store.save({
        ...store.load(),
        projects: [project],
        tasks: pass1Tasks,
        nextTaskNumber: 9,
      });

      const fakeWorker = createFakeWorkerClient({
        resumeThread: async (opts) => {
          if (opts.threadId === "codex-thr-expired") {
            throw new Error("Thread expired");
          }
          return String(opts.threadId);
        },
      });

      const agyCalls: Array<{ conversationId?: string | null; prompt: string }> = [];
      const claudeCalls: Array<{ sessionId?: string | null; prompt: string }> = [];

      const ctrl = new ConductorController({
        store,
        browser: createFakeBrowserManager(),
        onSnapshot: () => {},
        workerClient: fakeWorker.client,
        cliWorkerRunner: {
          runAgyTurn: (opts, callbacks) => {
            agyCalls.push({ conversationId: opts.conversationId, prompt: opts.prompt });
            if (opts.conversationId === "agy-conv-expired") {
              // Fail immediately before producing output -> triggers fresh-session retry
              callbacks.onComplete?.({
                ok: false,
                finalText: "",
                errorMessage: "Conversation not found",
              });
            }
            return { cancel: () => {} };
          },
          runClaudeTurn: (opts) => {
            claudeCalls.push({ sessionId: opts.sessionId, prompt: opts.prompt });
            return { cancel: () => {} };
          },
        },
      });

      // Immediately after constructor/loadPersisted, state.json MUST have autoResumeOnStartup cleared
      // so a crash before resume can NEVER loop infinitely!
      const onDiskAfterLoad = new StateStore(tmpDir).load();
      for (const t of onDiskAfterLoad.tasks) {
        expect(t.autoResumeOnStartup).not.toBe(true);
        expect(t.status).not.toBe("running");
      }

      setControllerProviders(ctrl, { codex: true, agy: true, claude: true });

      // Trigger auto-resume
      await ctrl.resumePendingInterruptedTasks();

      const snap = ctrl.getSnapshot();

      // 1. Codex resumable task used resumeThread + continuation prompt
      expect(fakeWorker.calls.resumeThread.map((c) => c.threadId)).toEqual([
        "codex-thr-ok",
        "codex-thr-expired",
      ]);
      const codexResumedTask = snap.tasks.find((t) => t.id === "codex-resume")!;
      expect(codexResumedTask.status).toBe("running");
      expect(codexResumedTask.workerThreadId).toBe("codex-thr-ok");
      expect(codexResumedTask.currentStep).toContain("自動再開");
      const codexResumeTurn = fakeWorker.calls.startTurn.find((c) => c.threadId === "codex-thr-ok");
      expect(String(codexResumeTurn?.text)).toContain("restarted");
      expect(String(codexResumeTurn?.text)).toContain("git status");

      // 2. Codex fallback task fell back to fresh startThread with original prompt
      const codexFallbackTask = snap.tasks.find((t) => t.id === "codex-fallback")!;
      expect(codexFallbackTask.status).toBe("running");
      expect(codexFallbackTask.workerThreadId).not.toBe("codex-thr-expired");
      const codexFallbackTurn = fakeWorker.calls.startTurn.find(
        (c) => c.threadId === codexFallbackTask.workerThreadId,
      );
      expect(String(codexFallbackTurn?.text)).toContain("Migrate database schema safely");
      expect(String(codexFallbackTurn?.text)).toContain("do not overwrite");

      // 3. Codex no-thread task started a fresh thread with original prompt
      const codexFreshTask = snap.tasks.find((t) => t.id === "codex-no-thread")!;
      expect(codexFreshTask.status).toBe("running");
      const codexFreshTurn = fakeWorker.calls.startTurn.find(
        (c) => c.threadId === codexFreshTask.workerThreadId,
      );
      expect(String(codexFreshTurn?.text)).toContain("Write integration tests");

      // 4. AGY task tried saved conversationId, failed with no output, and auto-retried cleanly without conversationId
      expect(agyCalls).toHaveLength(2);
      expect(agyCalls[0]?.conversationId).toBe("agy-conv-expired");
      expect(agyCalls[1]?.conversationId).toBeNull();
      expect(agyCalls[1]?.prompt).toContain("Polish landing page styles");
      expect(agyCalls[1]?.prompt).toContain("do not overwrite");
      expect(snap.tasks.find((t) => t.id === "agy-retry")?.status).toBe("running");

      // 5. Claude task resumed with its saved sessionId
      expect(claudeCalls).toHaveLength(1);
      expect(claudeCalls[0]?.sessionId).toBe("claude-sess-5");
      expect(claudeCalls[0]?.prompt).toContain("restarted");
      expect(snap.tasks.find((t) => t.id === "claude-resume")?.status).toBe("running");

      // 6. Missing project directory task marked failed gracefully with clear error activity & chat event
      const missingTask = snap.tasks.find((t) => t.id === "missing-path")!;
      expect(missingTask.status).toBe("failed");
      expect(missingTask.autoResumeOnStartup).toBe(false);
      expect(missingTask.currentStep).toContain("失敗");
      expect(missingTask.activities.some((a) => a.kind === "error" && a.detail?.includes(missingDir))).toBe(true);

      // 8. Done task remained untouched
      expect(snap.tasks.find((t) => t.id === "already-done")?.status).toBe("done");

      // Chat feedback emitted for auto-resumed and failed tasks
      const taskEvents = snap.messages.filter((m) => m.role === "taskEvent");
      expect(taskEvents.some((m) => m.relatedTaskId === "codex-resume" && m.text.includes("自動再開しました"))).toBe(true);
      expect(taskEvents.some((m) => m.relatedTaskId === "missing-path" && m.text.includes("自動再開に失敗"))).toBe(true);

      // Calling resumePendingInterruptedTasks() again is a no-op (never loops)
      const turnCountBefore = fakeWorker.calls.startTurn.length;
      await ctrl.resumePendingInterruptedTasks();
      expect(fakeWorker.calls.startTurn.length).toBe(turnCountBefore);

      await ctrl.shutdown();

      // Also verify unavailable provider handling cleanly
      const store2 = new StateStore(fs.mkdtempSync(path.join(os.tmpdir(), "conductor-unavail-")));
      try {
        const unavailTask = persistedTasks.find((t) => t.id === "unavailable-provider")!;
        store2.save({
          ...store2.load(),
          projects: [project],
          tasks: [unavailTask],
          nextTaskNumber: 10,
        });
        const ctrl2 = new ConductorController({
          store: store2,
          browser: createFakeBrowserManager(),
          onSnapshot: () => {},
          workerClient: createFakeWorkerClient().client,
        });
        setControllerProviders(ctrl2, { codex: true, agy: false, claude: false });
        await ctrl2.resumePendingInterruptedTasks();
        const failed = ctrl2.getSnapshot().tasks.find((t) => t.id === "unavailable-provider")!;
        expect(failed.status).toBe("failed");
        expect(failed.autoResumeOnStartup).toBe(false);
        expect(failed.activities.some((a) => a.detail?.includes("Claude"))).toBe(true);
        await ctrl2.shutdown();
      } finally {
        fs.rmSync(store2.baseDir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
