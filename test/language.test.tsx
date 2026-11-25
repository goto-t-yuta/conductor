import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgyAcpClient } from "../src/main/agy-acp-client.js";
import type { BrowserManager } from "../src/main/browser-manager.js";
import type { CliTurnCallbacks, RunningCliTurn } from "../src/main/cli-agent-runner.js";
import type { CodexAppServerClient } from "../src/main/codex-client.js";
import {
  ConductorController,
  buildOrchestratorDeveloperInstructions,
  buildWorkerDeveloperInstructions,
} from "../src/main/conductor-controller.js";
import { conductorMCPTools, type MCPToolResult } from "../src/main/local-mcp-server.js";
import { StateStore } from "../src/main/state-store.js";
import {
  LanguageSettingsSection,
  SettingsModal,
} from "../src/renderer/components/SettingsModal.js";
import {
  DEFAULT_PREFERRED_LANGUAGE,
  LANGUAGE_OPTIONS,
  buildOrchestratorLanguageInstruction,
  buildOrchestratorLiveLanguageLine,
  buildWorkerLanguageInstruction,
  getLanguageOption,
  isValidPreferredLanguage,
  type PreferredLanguage,
} from "../src/shared/language.js";
import type { AgentTask, AppSnapshot, Project } from "../src/shared/types.js";

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
  resumeThread?: (opts: Record<string, unknown>) => Promise<string>;
} = {}) {
  let seq = 0;
  const calls = {
    startThread: [] as Array<Record<string, unknown>>,
    resumeThread: [] as Array<Record<string, unknown>>,
    startTurn: [] as Array<Record<string, unknown>>,
    steerTurn: [] as Array<Record<string, unknown>>,
    interruptTurn: [] as Array<{ threadId: string; turnId: string }>,
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
    resumeThread: async (opts: Record<string, unknown>) => {
      calls.resumeThread.push(opts);
      if (overrides.resumeThread) return overrides.resumeThread(opts);
      return String(opts.threadId);
    },
    startTurn: async (opts: Record<string, unknown>) => {
      calls.startTurn.push(opts);
      seq += 1;
      return `turn-${seq}`;
    },
    steerTurn: async (opts: Record<string, unknown>) => {
      calls.steerTurn.push(opts);
      return String(opts.expectedTurnId);
    },
    interruptTurn: async (threadId: string, turnId: string) => {
      calls.interruptTurn.push({ threadId, turnId });
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
  return (
    ctrl as unknown as {
      handleMCPToolCall: (n: string, a: Record<string, unknown>) => Promise<MCPToolResult>;
    }
  ).handleMCPToolCall(name, args);
}

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

describe("Shared language helpers (src/shared/language.ts)", () => {
  it("validates PreferredLanguage values and defaults to ja", () => {
    expect(DEFAULT_PREFERRED_LANGUAGE).toBe("ja");
    expect(isValidPreferredLanguage("ja")).toBe(true);
    expect(isValidPreferredLanguage("en")).toBe(true);
    expect(isValidPreferredLanguage("auto")).toBe(true);

    expect(isValidPreferredLanguage("fr")).toBe(false);
    expect(isValidPreferredLanguage("")).toBe(false);
    expect(isValidPreferredLanguage(null)).toBe(false);
    expect(isValidPreferredLanguage(undefined)).toBe(false);
    expect(isValidPreferredLanguage(42)).toBe(false);
  });

  it("exposes UI options for ja, en, and auto with expected labels and descriptions", () => {
    expect(LANGUAGE_OPTIONS.map((o) => o.id)).toEqual(["ja", "en", "auto"]);
    expect(getLanguageOption("ja").label).toBe("日本語");
    expect(getLanguageOption("en").label).toBe("English");
    expect(getLanguageOption("auto").label).toBe("自動 (Auto)");
    for (const opt of LANGUAGE_OPTIONS) {
      expect(opt.description.length).toBeGreaterThan(10);
    }
  });

  it("builds explicit Orchestrator language instructions for ja, en, and auto", () => {
    const ja = buildOrchestratorLanguageInstruction("ja");
    expect(ja).toContain("Japanese");
    expect(ja).toContain("日本語");
    expect(ja).toContain("`title`");
    expect(ja).toContain("`summary`");
    expect(ja).toContain("`current_step`");
    expect(ja).toContain("`start_worker`");
    expect(ja).toContain("`create_task`");
    expect(ja).toContain("`update_task`");

    const en = buildOrchestratorLanguageInstruction("en");
    expect(en).toContain("English");
    expect(en).toContain("`title`");
    expect(en).toContain("`summary`");
    expect(en).toContain("`current_step`");
    expect(en).toContain("`start_worker`");

    const auto = buildOrchestratorLanguageInstruction("auto");
    expect(auto).toMatch(/match the user's input language/i);
    expect(auto).toContain("`title`");
    expect(auto).toContain("`summary`");
    expect(auto).toContain("`current_step`");
  });

  it("builds compact live-context language lines for ja, en, and auto", () => {
    expect(buildOrchestratorLiveLanguageLine("ja")).toContain("Japanese (ja)");
    expect(buildOrchestratorLiveLanguageLine("en")).toContain("English (en)");
    expect(buildOrchestratorLiveLanguageLine("auto")).toContain("Auto (auto)");
  });

  it("builds worker language instructions for ja, en, and auto", () => {
    const ja = buildWorkerLanguageInstruction("ja");
    expect(ja).toContain("Japanese");
    expect(ja).toContain("日本語");
    expect(ja).toMatch(/completion reports/i);
    expect(ja).toMatch(/file paths/i);

    const en = buildWorkerLanguageInstruction("en");
    expect(en).toContain("English");
    expect(en).toMatch(/completion reports/i);
    expect(en).toMatch(/CLI commands/i);

    const auto = buildWorkerLanguageInstruction("auto");
    expect(auto).toMatch(/match the language/i);
    expect(auto).toMatch(/completion reports/i);
  });

  it("embeds configured output language guidance in MCP tool schemas", () => {
    const tools = conductorMCPTools();
    for (const toolName of ["create_task", "update_task", "start_worker"]) {
      const tool = tools.find((t) => t.name === toolName);
      const props = (tool?.inputSchema as { properties?: Record<string, { description?: string }> })
        ?.properties;
      expect(props?.title?.description).toMatch(/configured output language/i);
      expect(props?.summary?.description).toMatch(/configured output language/i);
    }
  });
});

describe("StateStore & ConductorController language persistence and enforcement", () => {
  it("defaults preferredLanguage to ja, persists updates, and falls back on invalid values", () => {
    const dataDir = makeTempDir("conductor-lang-store-");
    const store = new StateStore(dataDir);

    const initial = store.load();
    expect(initial.preferredLanguage).toBe("ja");

    store.save({ ...initial, preferredLanguage: "en" });
    expect(store.load().preferredLanguage).toBe("en");

    store.save({ ...initial, preferredLanguage: "auto" });
    expect(store.load().preferredLanguage).toBe("auto");

    // Corrupt preferredLanguage on disk -> falls back safely to "ja"
    const raw = JSON.parse(fs.readFileSync(store.stateFile, "utf8")) as Record<string, unknown>;
    raw.preferredLanguage = "invalid-locale";
    fs.writeFileSync(store.stateFile, JSON.stringify(raw), "utf8");
    expect(store.load().preferredLanguage).toBe("ja");
  });

  it("updates snapshot, persists, injects live context, and refreshes idle lanes on setPreferredLanguage", () => {
    const dataDir = makeTempDir("conductor-lang-ctrl-");
    const store = new StateStore(dataDir);
    const snapshots: AppSnapshot[] = [];
    const closedAgySessions: string[] = [];

    const fakeAgyClient = {
      isAvailable: () => true,
      isConnected: () => false,
      onSessionUpdate: () => () => {},
      onDisconnect: () => () => {},
      closeSession: async (sid: string) => {
        closedAgySessions.push(sid);
      },
      stop: () => {},
    } as unknown as AgyAcpClient;

    const controller = new ConductorController({
      store,
      browser: createFakeBrowserManager(),
      onSnapshot: (snap) => snapshots.push(snap),
      agyOrchestratorClient: fakeAgyClient,
    });

    expect(controller.getSnapshot().preferredLanguage).toBe("ja");

    // Seed one idle and one active lane for both Codex and AGY
    const internals = controller as unknown as {
      responderLanes: Array<{
        threadId: string;
        activeTurnId: string | null;
        activeAssistantMessageId: string | null;
      }>;
      agyResponderLanes: Array<{
        sessionId: string;
        activeAssistantMessageId: string | null;
        currentModel: string | null;
        currentEffort: string | null;
        cancelled: boolean;
        hasStreamedText: boolean;
        syncPromise: Promise<void> | null;
        pendingTools: Map<string, string>;
      }>;
      buildOrchestratorPrompt: (
        userText: string,
        attachments: unknown[],
        history: string,
      ) => string;
    };
    internals.responderLanes = [
      { threadId: "codex-idle", activeTurnId: null, activeAssistantMessageId: null },
      { threadId: "codex-busy", activeTurnId: "t-1", activeAssistantMessageId: "msg-1" },
    ];
    internals.agyResponderLanes = [
      {
        sessionId: "agy-idle",
        activeAssistantMessageId: null,
        currentModel: null,
        currentEffort: null,
        cancelled: false,
        hasStreamedText: false,
        syncPromise: null,
        pendingTools: new Map(),
      },
      {
        sessionId: "agy-busy",
        activeAssistantMessageId: "msg-2",
        currentModel: null,
        currentEffort: null,
        cancelled: false,
        hasStreamedText: false,
        syncPromise: null,
        pendingTools: new Map(),
      },
    ];

    expect(internals.buildOrchestratorPrompt("hello", [], "")).toContain("Japanese (ja)");

    // Invalid language is ignored
    controller.setPreferredLanguage("zz" as PreferredLanguage);
    expect(controller.getSnapshot().preferredLanguage).toBe("ja");

    // Valid change persists, broadcasts, updates live prompt, and drops ONLY idle lanes
    controller.setPreferredLanguage("en");
    expect(controller.getSnapshot().preferredLanguage).toBe("en");
    expect(snapshots.at(-1)?.preferredLanguage).toBe("en");
    expect(internals.buildOrchestratorPrompt("hello", [], "")).toContain("English (en)");
    expect(internals.responderLanes.map((l) => l.threadId)).toEqual(["codex-busy"]);
    expect(internals.agyResponderLanes.map((l) => l.sessionId)).toEqual(["agy-busy"]);
    expect(closedAgySessions).toEqual(["agy-idle"]);

    // Reload from StateStore preserves preferredLanguage
    const reloaded = new ConductorController({
      store,
      browser: createFakeBrowserManager(),
      onSnapshot: () => {},
    });
    expect(reloaded.getSnapshot().preferredLanguage).toBe("en");

    // Developer instructions helper respects explicit language argument
    expect(buildOrchestratorDeveloperInstructions("ja")).toContain("日本語");
    expect(buildOrchestratorDeveloperInstructions("en")).toContain("English");
    expect(buildOrchestratorDeveloperInstructions("auto")).toMatch(/match the user's input language/i);
    expect(
      buildWorkerDeveloperInstructions({
        projectName: "demo",
        cwd: "/tmp/demo",
        worktreeBranch: "conductor/t1",
        preferredLanguage: "ja",
      }),
    ).toContain(buildWorkerLanguageInstruction("ja"));
  });

  it("injects worker language instructions across start_worker, send_to_worker, and auto-resume for Codex, AGY, and Claude", async () => {
    const dataDir = makeTempDir("conductor-lang-workers-");
    const projectDir = makeTempDir("conductor-lang-proj-");
    const store = new StateStore(dataDir);
    const fakeWorker = createFakeWorkerClient({
      resumeThread: async (opts) => {
        if (opts.threadId === "thr-stale") {
          throw new Error("stale thread");
        }
        return String(opts.threadId);
      },
    });

    const agyCalls: Array<{ prompt: string; conversationId?: string | null }> = [];
    const claudeCalls: Array<{ prompt: string; systemPrompt?: string; sessionId?: string | null }> =
      [];

    const controller = new ConductorController({
      store,
      browser: createFakeBrowserManager(),
      onSnapshot: () => {},
      workerClient: fakeWorker.client,
      cliWorkerRunner: {
        runAgyTurn: (opts, callbacks: CliTurnCallbacks): RunningCliTurn => {
          agyCalls.push({ prompt: opts.prompt, conversationId: opts.conversationId });
          callbacks.onSessionId?.(opts.conversationId ?? `agy-sess-${agyCalls.length}`);
          return { cancel: vi.fn(), waitForExit: async () => {} };
        },
        runClaudeTurn: (opts, callbacks: CliTurnCallbacks): RunningCliTurn => {
          claudeCalls.push({
            prompt: opts.prompt,
            systemPrompt: opts.systemPrompt,
            sessionId: opts.sessionId,
          });
          callbacks.onSessionId?.(opts.sessionId ?? `claude-sess-${claudeCalls.length}`);
          return { cancel: vi.fn(), waitForExit: async () => {} };
        },
      },
    });
    setProvidersAvailable(controller);
    const project: Project = controller.registerProject(projectDir, "demo-proj")!;
    const jaWorkerRule = buildWorkerLanguageInstruction("ja");
    const enWorkerRule = buildWorkerLanguageInstruction("en");

    // 1. start_worker (ja): Codex, AGY, Claude
    await callMcp(controller, "start_worker", {
      project_name: project.name,
      title: "Codex タスク",
      prompt: "Add feature A",
      provider: "codex",
    });
    expect(String(fakeWorker.calls.startThread.at(-1)?.developerInstructions)).toContain(
      jaWorkerRule,
    );

    await callMcp(controller, "start_worker", {
      project_name: project.name,
      title: "AGY タスク",
      prompt: "Add feature B",
      provider: "agy",
    });
    expect(agyCalls.at(-1)?.prompt).toContain(jaWorkerRule);

    await callMcp(controller, "start_worker", {
      project_name: project.name,
      title: "Claude タスク",
      prompt: "Add feature C",
      provider: "claude",
    });
    expect(claudeCalls.at(-1)?.systemPrompt).toContain(jaWorkerRule);

    // Switch language to English and verify follow-up / steer / auto-resume use English instruction
    controller.setPreferredLanguage("en");

    const tasks = controller.getSnapshot().tasks;
    const codexTask = tasks.find((t) => t.provider === "codex")!;
    const agyTask = tasks.find((t) => t.provider === "agy")!;
    const claudeTask = tasks.find((t) => t.provider === "claude")!;

    // 2. send_to_worker (en): Codex running steer + Codex idle follow-up
    await callMcp(controller, "send_to_worker", {
      task_id: codexTask.id,
      prompt: "Also add unit tests",
    });
    expect(String(fakeWorker.calls.steerTurn.at(-1)?.text)).toContain(enWorkerRule);

    // Mark codex task idle and send follow-up
    (controller as unknown as { tasks: AgentTask[] }).tasks = controller
      .getSnapshot()
      .tasks.map((t) =>
        t.id === codexTask.id ? { ...t, status: "needs_review", activeTurnId: null } : t,
      );
    await callMcp(controller, "send_to_worker", {
      task_id: codexTask.id,
      prompt: "Fix lint warning",
    });
    expect(String(fakeWorker.calls.startTurn.at(-1)?.text)).toContain(enWorkerRule);

    // 3. send_to_worker (en): AGY (resumed session) & Claude (resumed session)
    await callMcp(controller, "send_to_worker", {
      task_id: agyTask.id,
      prompt: "Refine UI spacing",
    });
    expect(agyCalls.at(-1)?.prompt).toContain(enWorkerRule);

    await callMcp(controller, "send_to_worker", {
      task_id: claudeTask.id,
      prompt: "Update README",
    });
    expect(claudeCalls.at(-1)?.systemPrompt).toContain(enWorkerRule);

    // 4. resumePendingInterruptedTasks (en): Codex resume, Codex fallback start, AGY, Claude
    const now = new Date().toISOString();
    const resumeTasks: AgentTask[] = [
      {
        id: "res-codex-ok",
        taskNumber: 101,
        title: "Resume Codex OK",
        summary: "",
        projectId: project.id,
        projectName: project.name,
        projectPath: project.path,
        status: "queued",
        provider: "codex",
        autoResumeOnStartup: true,
        workerPrompt: "Work 1",
        currentStep: null,
        workerThreadId: "thr-ok",
        activeTurnId: null,
        previewURL: null,
        latestOutput: "",
        activities: [],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "res-codex-fb",
        taskNumber: 102,
        title: "Resume Codex Fallback",
        summary: "",
        projectId: project.id,
        projectName: project.name,
        projectPath: project.path,
        status: "queued",
        provider: "codex",
        autoResumeOnStartup: true,
        workerPrompt: "Work 2",
        currentStep: null,
        workerThreadId: "thr-stale",
        activeTurnId: null,
        previewURL: null,
        latestOutput: "",
        activities: [],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "res-agy",
        taskNumber: 103,
        title: "Resume AGY",
        summary: "",
        projectId: project.id,
        projectName: project.name,
        projectPath: project.path,
        status: "queued",
        provider: "agy",
        autoResumeOnStartup: true,
        workerPrompt: "Work 3",
        currentStep: null,
        workerThreadId: "agy-saved",
        activeTurnId: null,
        previewURL: null,
        latestOutput: "",
        activities: [],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "res-claude",
        taskNumber: 104,
        title: "Resume Claude",
        summary: "",
        projectId: project.id,
        projectName: project.name,
        projectPath: project.path,
        status: "queued",
        provider: "claude",
        autoResumeOnStartup: true,
        workerPrompt: "Work 4",
        currentStep: null,
        workerThreadId: "claude-saved",
        activeTurnId: null,
        previewURL: null,
        latestOutput: "",
        activities: [],
        createdAt: now,
        updatedAt: now,
      },
    ];
    (controller as unknown as { tasks: AgentTask[] }).tasks = resumeTasks;
    (controller as unknown as { pendingAutoResumeTaskIds: string[] }).pendingAutoResumeTaskIds =
      resumeTasks.map((t) => t.id);

    await controller.resumePendingInterruptedTasks();

    expect(
      fakeWorker.calls.resumeThread.some(
        (c) => c.threadId === "thr-ok" && String(c.developerInstructions).includes(enWorkerRule),
      ),
    ).toBe(true);
    expect(String(fakeWorker.calls.startThread.at(-1)?.developerInstructions)).toContain(
      enWorkerRule,
    );
    expect(agyCalls.at(-1)?.prompt).toContain(enWorkerRule);
    expect(claudeCalls.at(-1)?.systemPrompt).toContain(enWorkerRule);
  });
});

describe("SettingsModal Output Language UI", () => {
  it("renders all language options and invokes onChangePreferredLanguage when clicked", () => {
    const onChangePreferredLanguage = vi.fn();

    const html = renderToStaticMarkup(
      <SettingsModal
        defaultIntegrationMode="feature-branch"
        preferredLanguage="ja"
        projects={[]}
        onClose={vi.fn()}
        onSetDefaultIntegrationMode={vi.fn()}
        onSetProjectIntegrationMode={vi.fn()}
        onChangePreferredLanguage={onChangePreferredLanguage}
      />,
    );

    expect(html).toContain("言語設定 / Output Language");
    expect(html).toContain('data-testid="preferred-language-ja"');
    expect(html).toContain('data-testid="preferred-language-en"');
    expect(html).toContain('data-testid="preferred-language-auto"');
    expect(html).toContain('data-testid="preferred-language-ja" aria-pressed="true"');
    expect(html).toContain('data-testid="preferred-language-en" aria-pressed="false"');
    expect(html).toContain("日本語");
    expect(html).toContain("English");
    expect(html).toContain("自動 (Auto)");

    // Verify click handler wiring on LanguageSettingsSection React tree
    const tree = LanguageSettingsSection({
      preferredLanguage: "ja",
      onChangePreferredLanguage,
    });

    const enBtn = findElementByTestId(tree, "preferred-language-en");
    expect(enBtn).not.toBeNull();
    (enBtn!.props.onClick as () => void)();
    expect(onChangePreferredLanguage).toHaveBeenCalledWith("en");

    const autoBtn = findElementByTestId(tree, "preferred-language-auto");
    expect(autoBtn).not.toBeNull();
    (autoBtn!.props.onClick as () => void)();
    expect(onChangePreferredLanguage).toHaveBeenCalledWith("auto");
  });
});
