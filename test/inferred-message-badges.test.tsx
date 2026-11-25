import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserManager } from "../src/main/browser-manager.js";
import type { CliTurnCallbacks, RunningCliTurn } from "../src/main/cli-agent-runner.js";
import { CodexAppServerClient, type CodexNotification } from "../src/main/codex-client.js";
import { ConductorController } from "../src/main/conductor-controller.js";
import {
  LocalMCPServer,
  conductorMCPTools,
  type MCPToolCallContext,
  type MCPToolResult,
} from "../src/main/local-mcp-server.js";
import { StateStore } from "../src/main/state-store.js";
import {
  createProjectMentionRef,
  createTaskMentionRef,
  mergeChatMessageMentionRefs,
  resolveMessageMentionBadges,
} from "../src/shared/mentions.js";
import type {
  AgentTask,
  AppSnapshot,
  ChatMessage,
  Project,
} from "../src/shared/types.js";
import { UnifiedChat } from "../src/renderer/components/UnifiedChat.js";

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

function makeProject(overrides: Partial<Project> & { id: string; name: string }): Project {
  return {
    path: `/Users/dev/Documents/${overrides.name}`,
    colorHex: "#3B82F6",
    gitBranch: "main",
    addedAt: "2026-11-20T00:00:00.000Z",
    ...overrides,
  };
}

function makeTask(
  overrides: Partial<AgentTask> & { id: string; taskNumber: number; title: string },
): AgentTask {
  return {
    summary: "",
    projectId: "proj-conductor",
    projectName: "conductor",
    projectPath: "/Users/dev/Documents/conductor",
    status: "running",
    provider: "codex",
    currentStep: "作業中...",
    workerThreadId: "thr-worker-1",
    activeTurnId: "turn-worker-1",
    previewURL: null,
    latestOutput: "",
    activities: [],
    createdAt: "2026-11-26T00:00:00.000Z",
    updatedAt: "2026-11-26T00:00:00.000Z",
    ...overrides,
  };
}

function createFakeBrowserManager() {
  const navigateCalls: Array<{ url: string; newTab?: boolean; projectId?: string | null }> = [];
  const manager = {
    getTabs: () => [],
    getActiveTabId: () => null,
    getActiveTab: () => null,
    isPickingElement: () => false,
    restore: () => {},
    navigate: async (url: string, newTab?: boolean, projectId?: string | null) => {
      navigateCalls.push({ url, newTab, projectId });
      return url;
    },
  } as unknown as BrowserManager;
  return { manager, navigateCalls };
}

function createFakeWorkerClient() {
  let seq = 0;
  const client = {
    label: "fake-worker",
    isConnected: () => true,
    onNotification: () => () => {},
    onDisconnect: () => () => {},
    stop: () => {},
    startThread: async () => {
      seq += 1;
      return `worker-thr-${seq}`;
    },
    startTurn: async () => {
      seq += 1;
      return `worker-turn-${seq}`;
    },
    steerTurn: async (opts: { expectedTurnId: string }) => opts.expectedTurnId,
    interruptTurn: async () => {},
  };
  return client as unknown as CodexAppServerClient;
}

function callMcp(
  controller: ConductorController,
  name: string,
  args: Record<string, unknown>,
  context?: MCPToolCallContext,
): Promise<MCPToolResult> {
  return (
    controller as unknown as {
      handleMCPToolCall: (
        n: string,
        a: Record<string, unknown>,
        c?: MCPToolCallContext,
      ) => Promise<MCPToolResult>;
    }
  ).handleMCPToolCall(name, args, context);
}

function emitOrchestratorNotification(
  controller: ConductorController,
  notification: CodexNotification,
): void {
  (
    controller as unknown as {
      handleOrchestratorNotification: (n: CodexNotification) => void;
    }
  ).handleOrchestratorNotification(notification);
}

function postJsonRpc(
  url: string,
  bearerToken: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body, "utf8"),
          Authorization: `Bearer ${bearerToken}`,
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data) as Record<string, unknown>);
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function renderUnifiedChat(
  messages: ChatMessage[],
  projects: Project[],
  tasks: AgentTask[],
): string {
  const snapshot: AppSnapshot = {
    projects,
    scanRoots: [],
    tasks,
    messages,
    activeChatSessionId: "sess-1",
    chatSessions: [
      {
        id: "sess-1",
        title: "Test Chat",
        preview: "",
        messageCount: messages.length,
        createdAt: "2026-11-26T00:00:00.000Z",
        updatedAt: "2026-11-26T00:00:00.000Z",
      },
    ],
    browserTabs: [],
    activeBrowserTabId: null,
    isPickingElement: false,
    showTaskSidebar: true,
    showBrowserPane: false,
    isConnected: true,
    connectionStatus: "Codex 利用可能",
    activeResponderCount: 0,
    providers: {
      codex: { id: "codex", label: "Codex", available: true, detail: "ok", models: [] },
      agy: { id: "agy", label: "AGY", available: false, detail: "", models: [] },
      claude: { id: "claude", label: "Claude", available: false, detail: "", models: [] },
    },
    chatProvider: "codex",
    workerProvider: "codex",
    models: [],
    chatModel: null,
    chatEffort: null,
    workerModel: null,
    workerEffort: null,
    defaultIntegrationMode: "feature-branch",
    autoLandOnComplete: true,
    preferredLanguage: "ja",
    lastErrorBanner: null,
  };

  return renderToStaticMarkup(
    <UnifiedChat
      snapshot={snapshot}
      composerText=""
      attachments={[]}
      onComposerTextChange={vi.fn()}
      onRemoveAttachment={vi.fn()}
      onAddAttachment={vi.fn()}
      onSend={vi.fn()}
      onStopMessage={vi.fn()}
      onStopAll={vi.fn()}
      onNewChat={vi.fn()}
      onSelectChatSession={vi.fn()}
      onDeleteChatSession={vi.fn()}
      onToggleSidebar={vi.fn()}
      onToggleBrowser={vi.fn()}
      rightPaneMode="browser"
      onToggleMarkdownViewer={vi.fn()}
      onAddProject={vi.fn()}
      onOpenUrl={vi.fn()}
      onOpenMarkdownFile={vi.fn()}
      onOpenImageAttachment={vi.fn()}
      onOpenTask={vi.fn()}
      onToggleElementPicker={vi.fn()}
      onCaptureScreenshot={vi.fn()}
      onAttachCurrentUrl={vi.fn()}
      onAttachConsoleErrors={vi.fn()}
      onPickLocalImages={vi.fn()}
      onPasteImage={vi.fn()}
      onReconnect={vi.fn()}
      onDismissError={vi.fn()}
      onSetChatProvider={vi.fn()}
      onSetWorkerProvider={vi.fn()}
      onSetChatModel={vi.fn()}
      onSetWorkerModel={vi.fn()}
    />,
  );
}

describe("Shared inferred mention merging & deduplication", () => {
  const projConductor = makeProject({
    id: "proj-conductor",
    name: "conductor",
    colorHex: "#3B82F6",
  });
  const projWeb = makeProject({
    id: "proj-web",
    name: "web_dashboard",
    colorHex: "#10B981",
  });
  const projects = [projConductor, projWeb];

  const task24 = makeTask({
    id: "task-24",
    taskNumber: 24,
    title: "Improve mention chip UX",
    projectId: projConductor.id,
    projectName: projConductor.name,
    projectPath: projConductor.path,
  });
  const task25 = makeTask({
    id: "task-25",
    taskNumber: 25,
    title: "Auto attach inferred badges",
    projectId: projConductor.id,
    projectName: projConductor.name,
    projectPath: projConductor.path,
  });
  const tasks = [task24, task25];

  it("upgrades an explicit standalone @project badge into a single inferred [T#] [project] badge without duplication", () => {
    const explicit = [createProjectMentionRef(projConductor)];
    const inferred = [createTaskMentionRef(task24, projects)];

    const badges = resolveMessageMentionBadges(
      "@conductor のメンションUXを改善して",
      projects,
      tasks,
      explicit,
      inferred,
    );

    expect(badges).toHaveLength(1);
    expect(badges[0]).toMatchObject({
      kind: "task",
      taskCode: "T24",
      projectName: "conductor",
      taskTitle: "Improve mention chip UX",
      isLiveTask: true,
      source: "inferred",
    });
  });

  it("does not duplicate an already-explicitly mentioned task and skips redundant inferred project refs", () => {
    const explicit = [createTaskMentionRef(task24, projects)];
    const mergedTask = mergeChatMessageMentionRefs(
      undefined,
      [createTaskMentionRef(task24, projects)],
      explicit,
    );
    expect(mergedTask.changed).toBe(false);
    expect(mergedTask.refs).toEqual([]);

    const mergedProj = mergeChatMessageMentionRefs(
      undefined,
      [createProjectMentionRef(projConductor)],
      explicit,
    );
    expect(mergedProj.changed).toBe(false);
    expect(mergedProj.refs).toEqual([]);
  });

  it("replaces an earlier inferred standalone project ref when a task in that same project is later linked", () => {
    const step1 = mergeChatMessageMentionRefs(undefined, [createProjectMentionRef(projConductor)]);
    expect(step1.changed).toBe(true);
    expect(step1.refs).toHaveLength(1);
    expect(step1.refs[0]?.kind).toBe("project");

    const step2 = mergeChatMessageMentionRefs(step1.refs, [
      createTaskMentionRef(task24, projects),
    ]);
    expect(step2.changed).toBe(true);
    expect(step2.refs).toHaveLength(1);
    expect(step2.refs[0]).toMatchObject({
      kind: "task",
      taskId: "task-24",
      taskNumber: 24,
      projectName: "conductor",
    });

    // Adding a second distinct task in the same project preserves both task refs
    const step3 = mergeChatMessageMentionRefs(step2.refs, [
      createTaskMentionRef(task25, projects),
    ]);
    expect(step3.changed).toBe(true);
    expect(step3.refs).toHaveLength(2);
    expect(step3.refs.map((r) => (r.kind === "task" ? r.taskNumber : null))).toEqual([24, 25]);
  });

  it("preserves unrelated explicit project badges alongside inferred task badges and handles deleted tasks", () => {
    const deletedTaskRef = {
      kind: "task" as const,
      taskId: "task-deleted-99",
      taskNumber: 99,
      taskTitle: "Archived task snapshot",
      projectId: projConductor.id,
      projectName: projConductor.name,
      projectPath: projConductor.path,
      projectColorHex: projConductor.colorHex,
    };

    const badges = resolveMessageMentionBadges(
      "@web_dashboard と比較して",
      projects,
      tasks,
      [createProjectMentionRef(projWeb)],
      [deletedTaskRef],
    );

    expect(badges).toHaveLength(2);
    expect(badges[0]).toMatchObject({
      kind: "project",
      projectName: "web_dashboard",
      source: "explicit",
    });
    expect(badges[1]).toMatchObject({
      kind: "task",
      taskCode: "T99",
      taskTitle: "Archived task snapshot",
      isLiveTask: false,
      source: "inferred",
    });
  });
});

describe("ConductorController automatic project/task badge attachment via MCP tools", () => {
  function setupController(options: {
    projects?: Project[];
    tasks?: AgentTask[];
    messages?: ChatMessage[];
  } = {}) {
    const storeDir = makeTempDir("conductor-inferred-store-");
    const store = new StateStore(storeDir);
    const snapshots: AppSnapshot[] = [];
    const { manager: browser } = createFakeBrowserManager();
    const controller = new ConductorController({
      store,
      browser,
      onSnapshot: (snap) => snapshots.push(snap),
      workerClient: createFakeWorkerClient(),
      cliWorkerRunner: {
        runAgyTurn: (_opts, _cb: CliTurnCallbacks): RunningCliTurn => ({ cancel: () => {} }),
        runClaudeTurn: (_opts, _cb: CliTurnCallbacks): RunningCliTurn => ({ cancel: () => {} }),
      },
    });

    const internal = controller as unknown as {
      projects: Project[];
      tasks: AgentTask[];
      nextTaskNumber: number;
      messages: ChatMessage[];
      responderLanes: Array<{
        threadId: string;
        activeTurnId: string | null;
        activeAssistantMessageId: string | null;
      }>;
      agyResponderLanes: Array<{
        laneId?: string;
        sessionId: string;
        activeAssistantMessageId: string | null;
        currentModel: string | null;
        currentEffort: string | null;
        cancelled: boolean;
        hasStreamedText: boolean;
        syncPromise: Promise<void> | null;
        pendingTools: Map<string, string>;
      }>;
      activeCliResponders: Map<string, RunningCliTurn>;
      syncActiveChatSession: (touch: boolean) => void;
    };

    if (options.projects) internal.projects = options.projects;
    if (options.tasks) {
      internal.tasks = options.tasks;
      internal.nextTaskNumber =
        Math.max(0, ...options.tasks.map((t) => t.taskNumber)) + 1;
    }
    if (options.messages) {
      internal.messages = options.messages;
      internal.syncActiveChatSession(false);
    }

    return { controller, store, snapshots, internal };
  }

  function makeUserAndAssistantPair(
    idx: number,
    userText: string,
    mentions?: ChatMessage["mentions"],
  ): { userMsg: ChatMessage; assistantMsg: ChatMessage } {
    const userMsg: ChatMessage = {
      id: `user-${idx}`,
      role: "user",
      text: userText,
      attachments: [],
      ...(mentions ? { mentions } : {}),
      toolChips: [],
      isStreaming: false,
      createdAt: `2026-11-26T01:0${idx}:00.000Z`,
    };
    const assistantMsg: ChatMessage = {
      id: `asst-${idx}`,
      role: "assistant",
      provider: "codex",
      text: "",
      attachments: [],
      toolChips: [],
      replyToMessageId: userMsg.id,
      isStreaming: true,
      createdAt: `2026-11-26T01:0${idx}:01.000Z`,
    };
    return { userMsg, assistantMsg };
  }

  it("attaches task badges to the originating user message for start_worker, send_to_worker, get_task_detail, update_task, stop_worker, create_task, and browser_open(task_id)", async () => {
    const projectDir = makeTempDir("conductor-proj-");
    const proj = makeProject({
      id: "proj-conductor",
      name: "conductor",
      path: projectDir,
      colorHex: "#3B82F6",
    });
    const existingTask = makeTask({
      id: "task-10",
      taskNumber: 10,
      title: "Existing worker task",
      projectId: proj.id,
      projectName: proj.name,
      projectPath: proj.path,
      status: "running",
      workerThreadId: "thr-10",
      activeTurnId: "turn-10",
    });

    const pair1 = makeUserAndAssistantPair(1, "新しい機能を実装して");
    const pair2 = makeUserAndAssistantPair(2, "さっきのタスクどうなってる？");
    const pair3 = makeUserAndAssistantPair(3, "追加でテストも書いて");
    const pair4 = makeUserAndAssistantPair(4, "タイトル更新して");
    const pair5 = makeUserAndAssistantPair(5, "ワーカー止めて");
    const pair6 = makeUserAndAssistantPair(6, "メモだけ登録して");
    const pair7 = makeUserAndAssistantPair(7, "プレビュー開いて");

    const { controller, store, snapshots, internal } = setupController({
      projects: [proj],
      tasks: [existingTask],
      messages: [
        pair1.userMsg,
        pair1.assistantMsg,
        pair2.userMsg,
        pair2.assistantMsg,
        pair3.userMsg,
        pair3.assistantMsg,
        pair4.userMsg,
        pair4.assistantMsg,
        pair5.userMsg,
        pair5.assistantMsg,
        pair6.userMsg,
        pair6.assistantMsg,
        pair7.userMsg,
        pair7.assistantMsg,
      ],
    });

    // 1. start_worker (creates new task T11)
    internal.responderLanes = [
      { threadId: "orch-1", activeTurnId: "t-1", activeAssistantMessageId: pair1.assistantMsg.id },
    ];
    const startRes = await callMcp(controller, "start_worker", {
      project_name: "conductor",
      title: "Auto badge feature",
      prompt: "Implement automatic badges",
    });
    expect(startRes.isError).toBeFalsy();
    const u1 = controller.getSnapshot().messages.find((m) => m.id === pair1.userMsg.id);
    expect(u1?.inferredMentions).toHaveLength(1);
    expect(u1?.inferredMentions?.[0]).toMatchObject({
      kind: "task",
      taskNumber: 11,
      taskTitle: "Auto badge feature",
      projectName: "conductor",
    });
    // Persisted immediately to disk
    const persistedAfterStart = store.load();
    expect(
      persistedAfterStart.messages.find((m) => m.id === pair1.userMsg.id)?.inferredMentions,
    ).toHaveLength(1);

    // 2. get_task_detail (read-only tool still persists & broadcasts badge!)
    const snapshotsBeforeDetail = snapshots.length;
    internal.responderLanes = [
      { threadId: "orch-1", activeTurnId: "t-2", activeAssistantMessageId: pair2.assistantMsg.id },
    ];
    const detailRes = await callMcp(controller, "get_task_detail", { task_id: "T10" });
    expect(detailRes.isError).toBeFalsy();
    expect(snapshots.length).toBeGreaterThan(snapshotsBeforeDetail);
    const u2 = controller.getSnapshot().messages.find((m) => m.id === pair2.userMsg.id);
    expect(u2?.inferredMentions).toEqual([
      expect.objectContaining({ kind: "task", taskId: "task-10", taskNumber: 10 }),
    ]);

    // 3. send_to_worker
    internal.responderLanes = [
      { threadId: "orch-1", activeTurnId: "t-3", activeAssistantMessageId: pair3.assistantMsg.id },
    ];
    const sendRes = await callMcp(controller, "send_to_worker", {
      task_id: "T10",
      prompt: "Please also add unit tests",
    });
    expect(sendRes.isError).toBeFalsy();
    const u3 = controller.getSnapshot().messages.find((m) => m.id === pair3.userMsg.id);
    expect(u3?.inferredMentions).toEqual([
      expect.objectContaining({ kind: "task", taskId: "task-10", taskNumber: 10 }),
    ]);

    // 4. update_task
    internal.responderLanes = [
      { threadId: "orch-1", activeTurnId: "t-4", activeAssistantMessageId: pair4.assistantMsg.id },
    ];
    const updateRes = await callMcp(controller, "update_task", {
      task_id: "T10",
      title: "Renamed worker task",
    });
    expect(updateRes.isError).toBeFalsy();
    const u4 = controller.getSnapshot().messages.find((m) => m.id === pair4.userMsg.id);
    expect(u4?.inferredMentions).toEqual([
      expect.objectContaining({
        kind: "task",
        taskId: "task-10",
        taskTitle: "Renamed worker task",
      }),
    ]);

    // 5. stop_worker
    internal.responderLanes = [
      { threadId: "orch-1", activeTurnId: "t-5", activeAssistantMessageId: pair5.assistantMsg.id },
    ];
    const stopRes = await callMcp(controller, "stop_worker", { task_id: "T10" });
    expect(stopRes.isError).toBeFalsy();
    const u5 = controller.getSnapshot().messages.find((m) => m.id === pair5.userMsg.id);
    expect(u5?.inferredMentions).toEqual([
      expect.objectContaining({ kind: "task", taskId: "task-10", taskNumber: 10 }),
    ]);

    // 6. create_task
    internal.responderLanes = [
      { threadId: "orch-1", activeTurnId: "t-6", activeAssistantMessageId: pair6.assistantMsg.id },
    ];
    const createRes = await callMcp(controller, "create_task", {
      title: "Queued memo task",
      project_name: "conductor",
    });
    expect(createRes.isError).toBeFalsy();
    const u6 = controller.getSnapshot().messages.find((m) => m.id === pair6.userMsg.id);
    expect(u6?.inferredMentions).toEqual([
      expect.objectContaining({
        kind: "task",
        taskNumber: 12,
        taskTitle: "Queued memo task",
        projectName: "conductor",
      }),
    ]);

    // 7. browser_open with task_id
    internal.responderLanes = [
      { threadId: "orch-1", activeTurnId: "t-7", activeAssistantMessageId: pair7.assistantMsg.id },
    ];
    const openNoTask = await callMcp(controller, "browser_open", { url: "http://localhost:3000" });
    expect(openNoTask.isError).toBeFalsy();
    expect(
      controller.getSnapshot().messages.find((m) => m.id === pair7.userMsg.id)?.inferredMentions,
    ).toBeUndefined();

    const openWithTask = await callMcp(controller, "browser_open", {
      url: "http://localhost:3000/preview",
      task_id: "T10",
    });
    expect(openWithTask.isError).toBeFalsy();
    const u7 = controller.getSnapshot().messages.find((m) => m.id === pair7.userMsg.id);
    expect(u7?.inferredMentions).toEqual([
      expect.objectContaining({ kind: "task", taskId: "task-10", taskNumber: 10 }),
    ]);
  });

  it("deduplicates against explicit @ mentions and does not attach badges when no responder is active", async () => {
    const proj = makeProject({ id: "proj-1", name: "conductor" });
    const task = makeTask({
      id: "task-24",
      taskNumber: 24,
      title: "Mention badges",
      projectId: proj.id,
      projectName: proj.name,
      projectPath: proj.path,
    });
    const pair = makeUserAndAssistantPair(
      1,
      "@T24 の詳細を確認して",
      [createTaskMentionRef(task, [proj])],
    );

    const { controller, snapshots, internal } = setupController({
      projects: [proj],
      tasks: [task],
      messages: [pair.userMsg, pair.assistantMsg],
    });

    internal.responderLanes = [
      { threadId: "orch-1", activeTurnId: "turn-1", activeAssistantMessageId: pair.assistantMsg.id },
    ];
    const before = snapshots.length;
    await callMcp(controller, "get_task_detail", { task_id: "T24" });
    expect(snapshots.length).toBe(before);
    expect(
      controller.getSnapshot().messages.find((m) => m.id === pair.userMsg.id)?.inferredMentions,
    ).toBeUndefined();

    // No active responders: should not attach to unrelated previous user messages
    const plainPair = makeUserAndAssistantPair(2, "過去のメッセージ");
    internal.messages = [plainPair.userMsg, plainPair.assistantMsg];
    internal.responderLanes = [];
    await callMcp(controller, "get_task_detail", { task_id: "T24" });
    expect(
      controller.getSnapshot().messages.find((m) => m.id === plainPair.userMsg.id)?.inferredMentions,
    ).toBeUndefined();
  });

  it("correlates parallel AGY and Claude responders accurately via LocalMCPServer HTTP context params", async () => {
    const projA = makeProject({ id: "proj-a", name: "conductor", colorHex: "#3B82F6" });
    const projB = makeProject({ id: "proj-b", name: "web_dashboard", colorHex: "#10B981" });
    const taskA = makeTask({
      id: "task-a",
      taskNumber: 21,
      title: "Conductor task",
      projectId: projA.id,
      projectName: projA.name,
      projectPath: projA.path,
    });
    const taskB = makeTask({
      id: "task-b",
      taskNumber: 22,
      title: "Dashboard task",
      projectId: projB.id,
      projectName: projB.name,
      projectPath: projB.path,
    });

    const pairA = makeUserAndAssistantPair(1, "conductor のタスク確認して");
    const pairB = makeUserAndAssistantPair(2, "dashboard のタスク確認して");

    const { controller, internal } = setupController({
      projects: [projA, projB],
      tasks: [taskA, taskB],
      messages: [pairA.userMsg, pairA.assistantMsg, pairB.userMsg, pairB.assistantMsg],
    });

    internal.agyResponderLanes = [
      {
        laneId: "lane-agy-1",
        sessionId: "sess-agy-1",
        activeAssistantMessageId: pairA.assistantMsg.id,
        currentModel: null,
        currentEffort: null,
        cancelled: false,
        hasStreamedText: false,
        syncPromise: null,
        pendingTools: new Map(),
      },
      {
        laneId: "lane-agy-2",
        sessionId: "sess-agy-2",
        activeAssistantMessageId: pairB.assistantMsg.id,
        currentModel: null,
        currentEffort: null,
        cancelled: false,
        hasStreamedText: false,
        syncPromise: null,
        pendingTools: new Map(),
      },
    ];

    const mcp = new LocalMCPServer(conductorMCPTools(), (name, args, ctx) =>
      callMcp(controller, name, args, ctx),
    );
    const baseUrl = await mcp.start();
    try {
      // Both parallel AGY lanes call get_task_detail concurrently over HTTP with ?lane=...
      await Promise.all([
        postJsonRpc(`${baseUrl}?lane=lane-agy-2`, mcp.bearerToken, {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "get_task_detail", arguments: { task_id: "T22" } },
        }),
        postJsonRpc(`${baseUrl}?lane=lane-agy-1`, mcp.bearerToken, {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "get_task_detail", arguments: { task_id: "T21" } },
        }),
      ]);

      const msgs = controller.getSnapshot().messages;
      expect(msgs.find((m) => m.id === pairA.userMsg.id)?.inferredMentions).toEqual([
        expect.objectContaining({ kind: "task", taskNumber: 21, projectName: "conductor" }),
      ]);
      expect(msgs.find((m) => m.id === pairB.userMsg.id)?.inferredMentions).toEqual([
        expect.objectContaining({ kind: "task", taskNumber: 22, projectName: "web_dashboard" }),
      ]);

      // Parallel Claude responders via ?assistantMessageId=...
      const pairC = makeUserAndAssistantPair(3, "Claudeターン1");
      const pairD = makeUserAndAssistantPair(4, "Claudeターン2");
      internal.messages = [...internal.messages, pairC.userMsg, pairC.assistantMsg, pairD.userMsg, pairD.assistantMsg];
      internal.syncActiveChatSession(false);
      internal.activeCliResponders.set(pairC.assistantMsg.id, { cancel: () => {} });
      internal.activeCliResponders.set(pairD.assistantMsg.id, { cancel: () => {} });

      await Promise.all([
        postJsonRpc(
          `${baseUrl}?assistantMessageId=${encodeURIComponent(pairD.assistantMsg.id)}`,
          mcp.bearerToken,
          {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "get_task_detail", arguments: { task_id: "T21" } },
          },
        ),
        postJsonRpc(
          `${baseUrl}?assistantMessageId=${encodeURIComponent(pairC.assistantMsg.id)}`,
          mcp.bearerToken,
          {
            jsonrpc: "2.0",
            id: 4,
            method: "tools/call",
            params: { name: "get_task_detail", arguments: { task_id: "T22" } },
          },
        ),
      ]);

      const afterClaude = controller.getSnapshot().messages;
      expect(afterClaude.find((m) => m.id === pairC.userMsg.id)?.inferredMentions).toEqual([
        expect.objectContaining({ kind: "task", taskNumber: 22 }),
      ]);
      expect(afterClaude.find((m) => m.id === pairD.userMsg.id)?.inferredMentions).toEqual([
        expect.objectContaining({ kind: "task", taskNumber: 21 }),
      ]);
    } finally {
      await mcp.stop();
    }
  });

  it("correlates parallel Codex responders via item/started and buffered item/completed events", async () => {
    const projA = makeProject({ id: "proj-a", name: "conductor" });
    const projB = makeProject({ id: "proj-b", name: "web_dashboard" });
    const taskA = makeTask({
      id: "task-31",
      taskNumber: 31,
      title: "Codex parallel A",
      projectId: projA.id,
      projectName: projA.name,
      projectPath: projA.path,
    });
    const taskB = makeTask({
      id: "task-32",
      taskNumber: 32,
      title: "Codex parallel B",
      projectId: projB.id,
      projectName: projB.name,
      projectPath: projB.path,
    });

    const pairA = makeUserAndAssistantPair(1, "Aの進捗");
    const pairB = makeUserAndAssistantPair(2, "Bの進捗");

    const { controller, internal } = setupController({
      projects: [projA, projB],
      tasks: [taskA, taskB],
      messages: [pairA.userMsg, pairA.assistantMsg, pairB.userMsg, pairB.assistantMsg],
    });

    internal.responderLanes = [
      { threadId: "codex-thr-a", activeTurnId: "turn-a", activeAssistantMessageId: pairA.assistantMsg.id },
      { threadId: "codex-thr-b", activeTurnId: "turn-b", activeAssistantMessageId: pairB.assistantMsg.id },
    ];

    // Case 1: item/started arrives BEFORE HTTP tools/call
    emitOrchestratorNotification(controller, {
      method: "item/started",
      threadId: "codex-thr-a",
      turnId: "turn-a",
      itemId: "item-a",
      params: {
        item: {
          id: "item-a",
          type: "mcpToolCall",
          server: "conductor",
          tool: "get_task_detail",
          arguments: { task_id: "T31" },
        },
      },
    });
    await callMcp(controller, "get_task_detail", { task_id: "T31" });
    expect(
      controller.getSnapshot().messages.find((m) => m.id === pairA.userMsg.id)?.inferredMentions,
    ).toEqual([expect.objectContaining({ kind: "task", taskNumber: 31 })]);
    expect(
      controller.getSnapshot().messages.find((m) => m.id === pairB.userMsg.id)?.inferredMentions,
    ).toBeUndefined();

    // Case 2: HTTP tools/call arrives BEFORE stdio item/started (race condition)
    const resB = await callMcp(controller, "get_task_detail", { task_id: "T32" });
    // Buffered until thread notification attributes it to codex-thr-b (no misattribution to pairA!)
    expect(
      controller.getSnapshot().messages.find((m) => m.id === pairA.userMsg.id)?.inferredMentions,
    ).toHaveLength(1);

    emitOrchestratorNotification(controller, {
      method: "item/completed",
      threadId: "codex-thr-b",
      turnId: "turn-b",
      itemId: "item-b",
      params: {
        item: {
          id: "item-b",
          type: "mcpToolCall",
          server: "conductor",
          tool: "get_task_detail",
          result: { content: [{ type: "text", text: resB.text }] },
          error: null,
        },
      },
    });

    expect(
      controller.getSnapshot().messages.find((m) => m.id === pairB.userMsg.id)?.inferredMentions,
    ).toEqual([expect.objectContaining({ kind: "task", taskNumber: 32 })]);
    expect(
      controller.getSnapshot().messages.find((m) => m.id === pairA.userMsg.id)?.inferredMentions,
    ).toEqual([expect.objectContaining({ kind: "task", taskNumber: 31 })]);
  });
});

describe("UnifiedChat UI rendering of Conductor-linked badges", () => {
  const projConductor = makeProject({
    id: "proj-conductor",
    name: "conductor",
    colorHex: "#3B82F6",
  });
  const projWeb = makeProject({
    id: "proj-web",
    name: "web_dashboard",
    colorHex: "#10B981",
  });
  const projects = [projConductor, projWeb];

  const task24 = makeTask({
    id: "task-24",
    taskNumber: 24,
    title: "Add badge support",
    projectId: projConductor.id,
    projectName: projConductor.name,
    projectPath: projConductor.path,
  });
  const tasks = [task24];

  it("renders Conductor-linked task badge above a plain user message bubble with no @ mention", () => {
    const messages: ChatMessage[] = [
      {
        id: "msg-plain-linked",
        role: "user",
        text: "バッジ自動表示の実装を進めて",
        attachments: [],
        inferredMentions: [createTaskMentionRef(task24, projects)],
        toolChips: [],
        isStreaming: false,
        createdAt: "2026-11-26T02:00:00.000Z",
      },
    ];

    const html = renderUnifiedChat(messages, projects, tasks);

    expect(html).toContain('data-testid="user-message-meta-chips"');
    expect(html).toContain('data-testid="user-message-mention-badge"');
    expect(html).toContain('data-mention-kind="task"');
    expect(html).toContain('data-mention-source="inferred"');
    expect(html).toContain('data-task-code="T24"');
    expect(html).toContain("<button");
    expect(html).toContain("conductor");
    expect(html).toContain("Add badge support");
  });

  it("deduplicates explicit @project and inferred task badge for the same project while preserving other explicit projects", () => {
    const messages: ChatMessage[] = [
      {
        id: "msg-explicit-and-inferred",
        role: "user",
        text: "@conductor と @web_dashboard の件を進めて",
        attachments: [],
        mentions: [
          createProjectMentionRef(projConductor),
          createProjectMentionRef(projWeb),
        ],
        inferredMentions: [createTaskMentionRef(task24, projects)],
        toolChips: [],
        isStreaming: false,
        createdAt: "2026-11-26T02:01:00.000Z",
      },
    ];

    const html = renderUnifiedChat(messages, projects, tasks);

    const badgeMatches = html.match(/data-testid="user-message-mention-badge"/g) ?? [];
    // Only 2 badges: [T24] [conductor] Add badge support + [web_dashboard] (no redundant standalone [conductor]!)
    expect(badgeMatches).toHaveLength(2);
    expect(html).toContain('data-task-code="T24"');
    expect(html).toContain('data-project-name="web_dashboard"');
    expect(html).not.toContain('data-project-name="conductor"');
  });
});
