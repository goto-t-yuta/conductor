import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { AgyAcpClient } from "../src/main/agy-acp-client.js";
import type { BrowserManager } from "../src/main/browser-manager.js";
import type { CliTurnCallbacks, RunningCliTurn } from "../src/main/cli-agent-runner.js";
import type { CodexAppServerClient, CodexNotification } from "../src/main/codex-client.js";
import {
  ConductorController,
  buildOrchestratorDeveloperInstructions,
} from "../src/main/conductor-controller.js";
import { LocalMCPServer, conductorMCPTools } from "../src/main/local-mcp-server.js";
import {
  DEFAULT_LANE_ROTATION_POLICY,
  OrchestratorMetricsLogger,
  computeProjectsHash,
  evaluateLaneRotation,
  partitionIdleLanesForAcquire,
  searchChatHistoryMessages,
  selectCompactTasksForPrompt,
  selectConversationWindowForTurn,
  selectMruIdleLane,
  trimIdleLanesByMru,
  type OrchestratorLaneState,
  type OrchestratorTurnMetric,
} from "../src/main/orchestrator-lanes.js";
import { StateStore } from "../src/main/state-store.js";
import { getFriendlyToolLabel } from "../src/shared/i18n.js";
import type { AgentTask, ChatMessage, Project } from "../src/shared/types.js";

interface FakeRpcMessage {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

class FakeAcpChildProcess extends EventEmitter {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public killed = false;
  private stdinBuf = "";
  private readonly onMessage: (msg: FakeRpcMessage, proc: FakeAcpChildProcess) => void;

  constructor(onMessage: (msg: FakeRpcMessage, proc: FakeAcpChildProcess) => void) {
    super();
    this.onMessage = onMessage;
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => {
      this.stdinBuf += chunk;
      let idx = this.stdinBuf.indexOf("\n");
      while (idx !== -1) {
        const line = this.stdinBuf.slice(0, idx).trim();
        this.stdinBuf = this.stdinBuf.slice(idx + 1);
        if (line) {
          this.onMessage(JSON.parse(line) as FakeRpcMessage, this);
        }
        idx = this.stdinBuf.indexOf("\n");
      }
    });
  }

  public sendToClient(payload: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(payload)}\n`);
  }

  public kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.killed) return true;
    this.killed = true;
    queueMicrotask(() => {
      this.emit("exit", null, signal);
    });
    return true;
  }
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

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Timed out waiting for condition");
}

function makeMessage(
  overrides: Partial<ChatMessage> & { id: string; role: ChatMessage["role"]; text: string },
): ChatMessage {
  return {
    attachments: [],
    toolChips: [],
    isStreaming: false,
    createdAt: "2026-11-27T00:00:00.000Z",
    ...overrides,
  };
}

function makeProject(id: string, name: string, dirPath: string, gitBranch: string | null = "main"): Project {
  return {
    id,
    name,
    path: dirPath,
    colorHex: "#3B82F6",
    gitBranch,
    addedAt: "2026-11-27T00:00:00.000Z",
    source: "manual",
  };
}

function makeTask(
  taskNumber: number,
  status: AgentTask["status"],
  updatedAt: string,
): AgentTask {
  return {
    id: `task-${taskNumber}`,
    taskNumber,
    title: `Task ${taskNumber}`,
    summary: "",
    projectId: "p1",
    projectName: "demo",
    projectPath: "/tmp/demo",
    status,
    currentStep: null,
    workerThreadId: null,
    activeTurnId: null,
    previewURL: null,
    latestOutput: "",
    activities: [],
    createdAt: updatedAt,
    updatedAt,
  };
}

function readMetricsFile(baseDir: string): OrchestratorTurnMetric[] {
  const filePath = path.join(baseDir, "logs", "orchestrator-metrics.jsonl");
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as OrchestratorTurnMetric);
}

describe("orchestrator-lanes pure helpers", () => {
  it("hashes projects deterministically and detects changes", () => {
    const p1 = makeProject("1", "alpha", "/tmp/alpha", "main");
    const p2 = makeProject("2", "beta", "/tmp/beta", "dev");

    const h1 = computeProjectsHash([p1, p2]);
    const h1Again = computeProjectsHash([p1, p2]);
    expect(h1).toBe(h1Again);

    const hBranchChanged = computeProjectsHash([p1, { ...p2, gitBranch: "feature/x" }]);
    expect(hBranchChanged).not.toBe(h1);

    const hAdded = computeProjectsHash([p1, p2, makeProject("3", "gamma", "/tmp/gamma")]);
    expect(hAdded).not.toBe(h1);
  });

  it("compacts tasks to all active statuses plus up to 5 most recent done/failed tasks", () => {
    const tasks: AgentTask[] = [
      makeTask(1, "done", "2026-11-27T01:00:00.000Z"),
      makeTask(2, "failed", "2026-11-27T02:00:00.000Z"),
      makeTask(3, "done", "2026-11-27T03:00:00.000Z"),
      makeTask(4, "done", "2026-11-27T04:00:00.000Z"),
      makeTask(5, "failed", "2026-11-27T05:00:00.000Z"),
      makeTask(6, "done", "2026-11-27T06:00:00.000Z"),
      makeTask(7, "done", "2026-11-27T07:00:00.000Z"),
      makeTask(8, "running", "2026-11-27T00:10:00.000Z"),
      makeTask(9, "needs_review", "2026-11-27T00:20:00.000Z"),
      makeTask(10, "queued", "2026-11-27T00:30:00.000Z"),
    ];

    const selected = selectCompactTasksForPrompt(tasks, 5);
    expect(selected.map((t) => t.taskNumber)).toEqual([8, 9, 10, 7, 6, 5, 4, 3]);
  });

  it("builds full window on initial turn and delta-only window on continuation turns", () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", text: "First question" }),
      makeMessage({ id: "a1", role: "assistant", text: "First answer" }),
      makeMessage({ id: "te1", role: "taskEvent", text: "T1 completed" }),
      makeMessage({ id: "u2", role: "user", text: "Other lane question" }),
      makeMessage({ id: "a2", role: "assistant", text: "Other lane answer" }),
      makeMessage({ id: "u3", role: "user", text: "Current question" }),
      makeMessage({ id: "a3", role: "assistant", text: "", isStreaming: true }),
    ];

    // Initial turn: full window before u3 (5 messages)
    const initial = selectConversationWindowForTurn({
      messages,
      isContinuation: false,
      currentUserMessageId: "u3",
      currentAssistantMessageId: "a3",
    });
    expect(initial.count).toBe(5);
    expect(initial.text).toContain("First question");
    expect(initial.text).toContain("TaskEvent: T1 completed");
    expect(initial.text).not.toContain("Current question");

    // Continuation synced up to a1: only te1, u2, a2
    const delta = selectConversationWindowForTurn({
      messages,
      isContinuation: true,
      lastSyncedMessageId: "a1",
      currentUserMessageId: "u3",
      currentAssistantMessageId: "a3",
    });
    expect(delta.count).toBe(3);
    expect(delta.text).not.toContain("First question");
    expect(delta.text).toContain("TaskEvent: T1 completed");
    expect(delta.text).toContain("Other lane question");
    expect(delta.text).toContain("Other lane answer");

    // Continuation already synced up to a2: empty delta
    const emptyDelta = selectConversationWindowForTurn({
      messages,
      isContinuation: true,
      lastSyncedMessageId: "a2",
      currentUserMessageId: "u3",
      currentAssistantMessageId: "a3",
    });
    expect(emptyDelta.count).toBe(0);
    expect(emptyDelta.text).toBe("");
  });

  it("evaluates soft rotation by turnCount, idle timeout, and size limit", () => {
    const now = 10_000_000;
    expect(DEFAULT_LANE_ROTATION_POLICY.maxTurns).toBe(15);

    expect(
      evaluateLaneRotation({ turnCount: 14, lastUsedAt: now - 1000, cumulativeChars: 50_000 }, now),
    ).toEqual({ rotate: false, reason: null });

    expect(
      evaluateLaneRotation({ turnCount: 15, lastUsedAt: now - 1000, cumulativeChars: 10_000 }, now),
    ).toEqual({ rotate: true, reason: "turn_limit" });

    expect(
      evaluateLaneRotation(
        {
          turnCount: 3,
          lastUsedAt: now - DEFAULT_LANE_ROTATION_POLICY.maxIdleMs,
          cumulativeChars: 10_000,
        },
        now,
      ),
    ).toEqual({ rotate: true, reason: "idle_timeout" });

    expect(
      evaluateLaneRotation(
        {
          turnCount: 3,
          lastUsedAt: now - 1000,
          cumulativeChars: DEFAULT_LANE_ROTATION_POLICY.maxEstimatedChars,
        },
        now,
      ),
    ).toEqual({ rotate: true, reason: "size_limit" });
  });

  it("selects MRU idle lane, partitions expired lanes, and trims extra idle lanes by MRU", () => {
    interface TestLane extends OrchestratorLaneState {
      id: string;
      busy: boolean;
    }

    const now = 5_000_000;
    const lanes: TestLane[] = [
      { id: "older", busy: false, turnCount: 2, lastUsedAt: now - 50_000, cumulativeChars: 1000 },
      { id: "newest", busy: false, turnCount: 4, lastUsedAt: now - 5_000, cumulativeChars: 2000 },
      { id: "expired", busy: false, turnCount: 15, lastUsedAt: now - 1_000, cumulativeChars: 3000 },
      { id: "busy", busy: true, turnCount: 1, lastUsedAt: now - 100, cumulativeChars: 500 },
    ];

    expect(selectMruIdleLane(lanes.filter((l) => !l.busy && l.id !== "expired"))?.id).toBe("newest");

    const partitioned = partitionIdleLanesForAcquire(lanes, (l) => !l.busy, now);
    expect(partitioned.expired.map((l) => l.id)).toEqual(["expired"]);
    expect(partitioned.selected?.id).toBe("newest");
    expect(partitioned.rotationReason).toBe("turn_limit");

    const trimmed = trimIdleLanesByMru(lanes, (l) => !l.busy, 2);
    expect(trimmed.evicted.map((l) => l.id)).toEqual(["older"]);
    expect(trimmed.kept.map((l) => l.id)).toEqual(["newest", "expired", "busy"]);
  });

  it("searches chat history by keyword, role, date range, and pagination", () => {
    const messages: ChatMessage[] = [
      makeMessage({
        id: "m1",
        role: "user",
        text: "API の認証トークンを Redis に保存しよう",
        createdAt: "2026-11-27T01:00:00.000Z",
      }),
      makeMessage({
        id: "m2",
        role: "assistant",
        text: "了解しました。Redis TTL は 3600 秒で設定します。",
        createdAt: "2026-11-27T01:01:00.000Z",
      }),
      makeMessage({
        id: "m3",
        role: "taskEvent",
        text: "T12 Redis セッション実装が完了しました",
        createdAt: "2026-11-27T02:00:00.000Z",
        relatedTaskId: "t12",
      }),
      makeMessage({
        id: "m4",
        role: "user",
        text: "UI のダークモードも確認して",
        createdAt: "2026-11-27T03:00:00.000Z",
      }),
      makeMessage({
        id: "m5",
        role: "assistant",
        text: "",
        isStreaming: true,
        createdAt: "2026-11-27T03:01:00.000Z",
      }),
    ];

    const byKeyword = searchChatHistoryMessages(messages, { query: "redis" });
    expect(byKeyword.total_matches).toBe(3);
    expect(byKeyword.messages.map((m) => m.id)).toEqual(["m3", "m2", "m1"]);

    const byRoleAndOrder = searchChatHistoryMessages(messages, {
      query: "redis",
      role: "assistant",
      order: "asc",
    });
    expect(byRoleAndOrder.messages.map((m) => m.id)).toEqual(["m2"]);

    const byDateRange = searchChatHistoryMessages(messages, {
      since: "2026-11-27T01:30:00.000Z",
      until: "2026-11-27T03:00:00.000Z",
      order: "asc",
    });
    expect(byDateRange.messages.map((m) => m.id)).toEqual(["m3", "m4"]);

    const paged = searchChatHistoryMessages(messages, { limit: 2, offset: 1 });
    expect(paged.total_matches).toBe(4); // m5 empty streaming excluded
    expect(paged.returned_count).toBe(2);
    expect(paged.has_more).toBe(true);
    expect(paged.messages.map((m) => m.id)).toEqual(["m3", "m2"]);
  });

  it("writes JSONL metrics asynchronously and rotates when exceeding maxBytes", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-metrics-"));
    try {
      const logPath = path.join(tmpDir, "logs", "orchestrator-metrics.jsonl");
      const logger = new OrchestratorMetricsLogger(logPath, { maxBytes: 1024 });

      for (let i = 1; i <= 8; i += 1) {
        logger.record({
          timestamp: `2026-11-27T00:00:0${i}.000Z`,
          provider: "agy",
          laneId: `lane-${i}`,
          laneMode: i === 1 ? "new" : "reused",
          rotationReason: null,
          turnCount: i,
          injectedChars: 500,
          injectedTranscriptCount: 0,
          projectsInjected: i === 1,
          tasksInjectedCount: 2,
          ttftMs: 120,
          totalMs: 450,
          usedSearchChatHistory: i === 3,
        });
      }
      await logger.flush();

      const currentLines = fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as OrchestratorTurnMetric);
      expect(currentLines.length).toBeGreaterThan(0);
      expect(currentLines.at(-1)?.laneId).toBe("lane-8");
      expect(fs.existsSync(`${logPath}.1`)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("ConductorController delta context, soft rotation, MRU, search_chat_history & metrics", () => {
  it("includes search_chat_history in developer instructions, MCP tools, and friendly labels", () => {
    const instructions = buildOrchestratorDeveloperInstructions("ja");
    expect(instructions).toContain("search_chat_history");
    expect(conductorMCPTools().some((t) => t.name === "search_chat_history")).toBe(true);
    expect(getFriendlyToolLabel("search_chat_history", "ja")).toBe("チャット履歴を検索");
    expect(getFriendlyToolLabel("search_chat_history", "en")).toBe("Search chat history");
  });

  it("applies delta context injection, TaskEvent sync, projects hash re-injection, soft rotation (turn/idle/size), MRU selection, and metrics logging for AGY", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-agy-lanes-"));
    const projADir = path.join(tmpDir, "proj-a");
    const projBDir = path.join(tmpDir, "proj-b");
    fs.mkdirSync(projADir, { recursive: true });
    fs.mkdirSync(projBDir, { recursive: true });

    let fakeNow = Date.parse("2026-11-27T10:00:00.000Z");
    let sessionSeq = 0;
    const closedSessionIds: string[] = [];
    const promptHistory: Array<{ sessionId: string; text: string }> = [];
    let replyOverride = "OK";

    const fakeAgyClient = new AgyAcpClient("test-delta-agy", {
      resolveExecutable: () => "/fake/agy",
      spawnProcess: () => {
        const fake = new FakeAcpChildProcess((msg, proc) => {
          if (msg.method === "initialize") {
            proc.sendToClient({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: 1,
                agentCapabilities: {
                  loadSession: true,
                  sessionCapabilities: { resume: {}, close: {}, load: {} },
                },
              },
            });
            return;
          }
          if (msg.method === "session/new") {
            sessionSeq += 1;
            proc.sendToClient({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                sessionId: `agy-s-${sessionSeq}`,
                models: {
                  currentModelId: "gemini-3.8-flash-low",
                  availableModels: [
                    { modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
                  ],
                },
              },
            });
            return;
          }
          if (msg.method === "session/set_model") {
            proc.sendToClient({ jsonrpc: "2.0", id: msg.id, result: {} });
            return;
          }
          if (msg.method === "session/close") {
            closedSessionIds.push(String(msg.params?.sessionId ?? ""));
            proc.sendToClient({ jsonrpc: "2.0", id: msg.id, result: {} });
            return;
          }
          if (msg.method === "session/prompt") {
            const sid = String(msg.params?.sessionId ?? "");
            const blocks = (msg.params?.prompt as Array<{ text?: string }>) ?? [];
            const text = blocks[0]?.text ?? "";
            promptHistory.push({ sessionId: sid, text });
            const reply = replyOverride;
            setTimeout(() => {
              fakeNow += 50;
              proc.sendToClient({
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  sessionId: sid,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: reply },
                  },
                },
              });
              fakeNow += 100;
              proc.sendToClient({
                jsonrpc: "2.0",
                id: msg.id,
                result: { stopReason: "end_turn" },
              });
            }, 5);
          }
        });
        return fake as unknown as ChildProcessWithoutNullStreams;
      },
    });

    const mcp = new LocalMCPServer(conductorMCPTools(), async () => ({ text: "{}" }));
    const mcpUrl = await mcp.start();

    try {
      const store = new StateStore(tmpDir);
      const initial = store.load();
      store.save({ ...initial, chatProvider: "agy", chatModel: "gemini-3.8-flash-low" });

      const ctrl = new ConductorController({
        store,
        browser: createFakeBrowserManager(),
        onSnapshot: () => {},
        agyOrchestratorClient: fakeAgyClient,
        now: () => fakeNow,
        laneRotationPolicy: {
          maxTurns: 4,
          maxIdleMs: 2 * 60 * 60 * 1000,
          maxEstimatedChars: 12_000,
        },
      });

      const internals = ctrl as unknown as {
        mcpServer: LocalMCPServer;
        agyMcpConfig: { name: string; url: string; bearerToken: string };
        isConnected: boolean;
        providers: Record<string, unknown>;
        tasks: AgentTask[];
        messages: ChatMessage[];
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
          lastSyncedMessageId?: string | null;
          lastProjectsHash?: string | null;
          turnCount?: number;
          lastUsedAt?: number;
          createdAt?: number;
          cumulativeChars?: number;
        }>;
        syncActiveChatSession: (touch: boolean) => void;
        handleMCPToolCall: (
          name: string,
          args: Record<string, unknown>,
          ctx?: { assistantMessageId?: string },
        ) => Promise<{ text: string; isError?: boolean }>;
        orchestratorMetricsLogger: OrchestratorMetricsLogger;
      };

      internals.mcpServer = mcp;
      internals.agyMcpConfig = { name: "conductor", url: mcpUrl, bearerToken: mcp.bearerToken };
      internals.isConnected = true;
      internals.providers = {
        codex: { id: "codex", label: "Codex", available: false, detail: "", models: [] },
        agy: {
          id: "agy",
          label: "AGY",
          available: true,
          detail: "ACP 常駐接続済み",
          models: [
            {
              id: "gemini-3.8-flash-low",
              model: "gemini-3.8-flash-low",
              displayName: "Gemini 3.8 Flash (Low)",
              description: "",
              supportedEfforts: [],
              defaultEffort: "",
              isDefault: true,
            },
          ],
        },
        claude: { id: "claude", label: "Claude", available: false, detail: "", models: [] },
      };

      ctrl.registerProject(projADir, "proj-a");
      // Seed 7 finished tasks + 1 running task to verify compact task injection
      internals.tasks = [
        makeTask(1, "done", "2026-11-27T01:00:00.000Z"),
        makeTask(2, "done", "2026-11-27T02:00:00.000Z"),
        makeTask(3, "done", "2026-11-27T03:00:00.000Z"),
        makeTask(4, "done", "2026-11-27T04:00:00.000Z"),
        makeTask(5, "failed", "2026-11-27T05:00:00.000Z"),
        makeTask(6, "done", "2026-11-27T06:00:00.000Z"),
        makeTask(7, "done", "2026-11-27T07:00:00.000Z"),
        makeTask(8, "running", "2026-11-27T00:05:00.000Z"),
      ];

      // Seed prior chat message before Turn 1
      internals.messages.push(
        makeMessage({ id: "seed-u0", role: "user", text: "事前メモ: Redis を使う予定" }),
        makeMessage({ id: "seed-a0", role: "assistant", text: "了解しました。" }),
      );
      internals.syncActiveChatSession(false);

      // Turn 1: initial turn -> full Discovered projects + recent transcript + compact tasks (1 running + 5 recent finished = 6)
      await ctrl.sendMessage({ text: "ターン1の質問", attachments: [] });
      await waitFor(() => promptHistory.length === 1 && ctrl.getSnapshot().messages.every((m) => !m.isStreaming));
      expect(promptHistory[0]!.sessionId).toBe("agy-s-1");
      expect(promptHistory[0]!.text).toContain("Discovered projects");
      expect(promptHistory[0]!.text).toContain("proj-a");
      expect(promptHistory[0]!.text).toContain("[Recent Unified Chat Transcript]");
      expect(promptHistory[0]!.text).toContain("事前メモ: Redis を使う予定");
      expect(promptHistory[0]!.text).toContain("T8");
      expect(promptHistory[0]!.text).toContain("T7");
      expect(promptHistory[0]!.text).not.toContain("id=task-1 ");
      expect(promptHistory[0]!.text).not.toContain("id=task-2 ");

      // Turn 2: continuation without changes -> omits Discovered projects AND omits transcript!
      fakeNow += 5_000;
      await ctrl.sendMessage({ text: "ターン2の続き", attachments: [] });
      await waitFor(() => promptHistory.length === 2 && ctrl.getSnapshot().messages.every((m) => !m.isStreaming));
      expect(promptHistory[1]!.sessionId).toBe("agy-s-1");
      expect(promptHistory[1]!.text).not.toContain("Discovered projects");
      expect(promptHistory[1]!.text).not.toContain("[Recent Unified Chat Transcript]");
      expect(promptHistory[1]!.text.length).toBeLessThan(promptHistory[0]!.text.length);

      // Append a TaskEvent and another-lane exchange between Turn 2 and Turn 3
      internals.messages.push(
        makeMessage({ id: "te-mid", role: "taskEvent", text: "T8 のテストがパスしました" }),
        makeMessage({ id: "other-u", role: "user", text: "別レーンでの確認" }),
        makeMessage({ id: "other-a", role: "assistant", text: "別レーンの回答" }),
      );
      internals.syncActiveChatSession(true);

      // Turn 3: continuation with delta messages -> injects ONLY delta messages, still omits Discovered projects
      fakeNow += 5_000;
      await ctrl.sendMessage({ text: "ターン3で確認", attachments: [] });
      await waitFor(() => promptHistory.length === 3 && ctrl.getSnapshot().messages.every((m) => !m.isStreaming));
      expect(promptHistory[2]!.sessionId).toBe("agy-s-1");
      expect(promptHistory[2]!.text).not.toContain("Discovered projects");
      expect(promptHistory[2]!.text).toContain("[Recent Unified Chat Transcript]");
      expect(promptHistory[2]!.text).toContain("TaskEvent: T8 のテストがパスしました");
      expect(promptHistory[2]!.text).toContain("別レーンでの確認");
      expect(promptHistory[2]!.text).not.toContain("ターン1の質問");

      // Register a new project -> changes projects hash!
      ctrl.registerProject(projBDir, "proj-b");

      // Turn 4 (4th turn on agy-s-1): projects changed -> re-injects Discovered projects, omits transcript
      fakeNow += 5_000;
      await ctrl.sendMessage({ text: "ターン4で新プロジェクト確認", attachments: [] });
      await waitFor(() => promptHistory.length === 4 && ctrl.getSnapshot().messages.every((m) => !m.isStreaming));
      expect(promptHistory[3]!.sessionId).toBe("agy-s-1");
      expect(promptHistory[3]!.text).toContain("Discovered projects");
      expect(promptHistory[3]!.text).toContain("proj-b");
      expect(promptHistory[3]!.text).not.toContain("[Recent Unified Chat Transcript]");

      // Turn 5: agy-s-1 now has turnCount === 4 (>= maxTurns 4) -> soft rotation!
      fakeNow += 5_000;
      await ctrl.sendMessage({ text: "ターン5で自動ローテーション", attachments: [] });
      await waitFor(() => promptHistory.length === 5 && ctrl.getSnapshot().messages.every((m) => !m.isStreaming));
      expect(promptHistory[4]!.sessionId).toBe("agy-s-2");
      expect(closedSessionIds).toContain("agy-s-1");
      expect(promptHistory[4]!.text).toContain("Discovered projects");
      expect(promptHistory[4]!.text).toContain("[Recent Unified Chat Transcript]");

      // Turn 6: advance clock > 2h -> idle_timeout rotation!
      fakeNow += 2 * 60 * 60 * 1000 + 1000;
      await ctrl.sendMessage({ text: "2時間後のメッセージ", attachments: [] });
      await waitFor(() => promptHistory.length === 6 && ctrl.getSnapshot().messages.every((m) => !m.isStreaming));
      expect(promptHistory[5]!.sessionId).toBe("agy-s-3");
      expect(closedSessionIds).toContain("agy-s-2");
      expect(promptHistory[5]!.text).toContain("Discovered projects");

      // Turn 7: emit huge reply to trigger size_limit on the following turn
      replyOverride = "X".repeat(13_000);
      fakeNow += 5_000;
      await ctrl.sendMessage({ text: "大きな出力を返すターン", attachments: [] });
      await waitFor(() => promptHistory.length === 7 && ctrl.getSnapshot().messages.every((m) => !m.isStreaming));
      expect(promptHistory[6]!.sessionId).toBe("agy-s-3");

      replyOverride = "Short reply";
      fakeNow += 5_000;
      await ctrl.sendMessage({ text: "サイズ上限後のターン", attachments: [] });
      await waitFor(() => promptHistory.length === 8 && ctrl.getSnapshot().messages.every((m) => !m.isStreaming));
      expect(promptHistory[7]!.sessionId).toBe("agy-s-4");
      expect(closedSessionIds).toContain("agy-s-3");

      // Verify MRU selection when multiple idle AGY lanes exist
      const activeLane = internals.agyResponderLanes.find((l) => l.sessionId === "agy-s-4")!;
      activeLane.lastUsedAt = fakeNow - 10_000;
      internals.agyResponderLanes.unshift({
        laneId: "older-idle-lane",
        sessionId: "agy-older",
        activeAssistantMessageId: null,
        currentModel: "gemini-3.8-flash-low",
        currentEffort: null,
        cancelled: false,
        hasStreamedText: false,
        syncPromise: null,
        pendingTools: new Map(),
        turnCount: 1,
        lastUsedAt: fakeNow - 60_000,
        createdAt: fakeNow - 60_000,
        cumulativeChars: 500,
        lastSyncedMessageId: activeLane.lastSyncedMessageId,
        lastProjectsHash: activeLane.lastProjectsHash,
      });

      fakeNow += 1_000;
      await ctrl.sendMessage({ text: "MRU選択の確認", attachments: [] });
      await waitFor(() => promptHistory.length === 9 && ctrl.getSnapshot().messages.every((m) => !m.isStreaming));
      // Even though agy-older is first in array, MRU picks agy-s-4!
      expect(promptHistory[8]!.sessionId).toBe("agy-s-4");

      // Verify search_chat_history MCP handler directly
      const searchRes = await internals.handleMCPToolCall("search_chat_history", {
        query: "Redis",
        limit: 5,
      });
      const parsedSearch = JSON.parse(searchRes.text) as {
        total_matches: number;
        messages: Array<{ id: string; text: string }>;
      };
      expect(parsedSearch.total_matches).toBeGreaterThanOrEqual(1);
      expect(parsedSearch.messages.some((m) => m.id === "seed-u0")).toBe(true);

      // Flush and inspect JSONL metrics log
      await internals.orchestratorMetricsLogger.flush();
      const metrics = readMetricsFile(tmpDir);
      expect(metrics).toHaveLength(9);

      // Turn 1: new, projectsInjected=true, injectedTranscriptCount=2, tasksInjectedCount=6
      expect(metrics[0]).toMatchObject({
        provider: "agy",
        laneMode: "new",
        rotationReason: null,
        turnCount: 1,
        projectsInjected: true,
        injectedTranscriptCount: 2,
        tasksInjectedCount: 6,
        usedSearchChatHistory: false,
      });
      expect(metrics[0]!.ttftMs).toBeGreaterThanOrEqual(0);
      expect(metrics[0]!.totalMs).toBeGreaterThanOrEqual(metrics[0]!.ttftMs!);

      // Turn 2: reused, projectsInjected=false, injectedTranscriptCount=0
      expect(metrics[1]).toMatchObject({
        laneMode: "reused",
        rotationReason: null,
        turnCount: 2,
        projectsInjected: false,
        injectedTranscriptCount: 0,
      });

      // Turn 3: reused, delta 3 messages
      expect(metrics[2]).toMatchObject({
        laneMode: "reused",
        turnCount: 3,
        projectsInjected: false,
        injectedTranscriptCount: 3,
      });

      // Turn 4: reused, projects changed -> projectsInjected=true
      expect(metrics[3]).toMatchObject({
        laneMode: "reused",
        turnCount: 4,
        projectsInjected: true,
        injectedTranscriptCount: 0,
      });

      // Turn 5: rotated by turn_limit
      expect(metrics[4]).toMatchObject({
        laneMode: "rotated",
        rotationReason: "turn_limit",
        turnCount: 1,
        projectsInjected: true,
      });

      // Turn 6: rotated by idle_timeout
      expect(metrics[5]).toMatchObject({
        laneMode: "rotated",
        rotationReason: "idle_timeout",
        turnCount: 1,
      });

      // Turn 8: rotated by size_limit
      expect(metrics[7]).toMatchObject({
        laneMode: "rotated",
        rotationReason: "size_limit",
        turnCount: 1,
      });

      await ctrl.shutdown();
    } finally {
      await mcp.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("applies delta injection, MRU selection, soft rotation, and usedSearchChatHistory tracking for Codex and Claude lanes", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-codex-claude-lanes-"));
    const projDir = path.join(tmpDir, "repo-one");
    fs.mkdirSync(projDir, { recursive: true });

    let fakeNow = Date.parse("2026-11-27T12:00:00.000Z");

    // --- 1. Fake Codex Orchestrator Client ---
    let codexThreadSeq = 0;
    let codexTurnSeq = 0;
    const codexPrompts: Array<{ threadId: string; text: string }> = [];
    let codexNotifyHandler: ((n: CodexNotification) => void) | null = null;
    const fakeCodexClient = {
      onNotification: (cb: (n: CodexNotification) => void) => {
        codexNotifyHandler = cb;
      },
      onDisconnect: () => {},
      stop: () => {},
      startThread: async () => {
        codexThreadSeq += 1;
        return `codex-thr-${codexThreadSeq}`;
      },
      resumeThread: async (opts: { threadId: string }) => opts.threadId,
      startTurn: async (opts: { threadId: string; text: string }) => {
        codexTurnSeq += 1;
        const turnId = `turn-${codexTurnSeq}`;
        codexPrompts.push({ threadId: opts.threadId, text: opts.text });
        setTimeout(() => {
          fakeNow += 30;
          codexNotifyHandler?.({
            method: "turn/started",
            threadId: opts.threadId,
            turnId,
            itemId: null,
            params: {},
          });
          if (codexTurnSeq === 2) {
            codexNotifyHandler?.({
              method: "item/started",
              threadId: opts.threadId,
              turnId,
              itemId: "mcp-1",
              params: {
                item: {
                  id: "mcp-1",
                  type: "mcpToolCall",
                  server: "conductor",
                  tool: "search_chat_history",
                  arguments: { query: "履歴" },
                },
              },
            });
          }
          codexNotifyHandler?.({
            method: "item/agentMessage/delta",
            threadId: opts.threadId,
            turnId,
            itemId: null,
            params: { delta: `Codex reply #${codexTurnSeq}` },
          });
          fakeNow += 40;
          codexNotifyHandler?.({
            method: "turn/completed",
            threadId: opts.threadId,
            turnId,
            itemId: null,
            params: {},
          });
        }, 5);
        return turnId;
      },
      interruptTurn: async () => {},
    } as unknown as CodexAppServerClient;

    // --- 2. Fake Claude Orchestrator Runner ---
    let claudeSeq = 0;
    const claudeCalls: Array<{ sessionId: string | null | undefined; prompt: string }> = [];
    const fakeClaudeRunner = (
      opts: { prompt: string; sessionId?: string | null },
      callbacks: CliTurnCallbacks,
    ): RunningCliTurn => {
      claudeCalls.push({ sessionId: opts.sessionId, prompt: opts.prompt });
      const sid = opts.sessionId ?? `claude-s-${++claudeSeq}`;
      setTimeout(() => {
        fakeNow += 25;
        callbacks.onSessionId?.(sid);
        if (claudeCalls.length === 2) {
          callbacks.onToolEvent?.({
            id: "tool-hist-1",
            name: "mcp__conductor__search_chat_history",
            completed: true,
          });
        }
        callbacks.onTextDelta?.(`Claude reply #${claudeCalls.length}`);
        fakeNow += 35;
        callbacks.onComplete?.({ ok: true, finalText: `Claude reply #${claudeCalls.length}` });
      }, 5);
      return { cancel: () => {} };
    };

    try {
      const store = new StateStore(tmpDir);
      const initial = store.load();
      store.save({ ...initial, chatProvider: "codex", chatModel: "gpt-5.4" });

      const ctrl = new ConductorController({
        store,
        browser: createFakeBrowserManager(),
        onSnapshot: () => {},
        orchestratorClient: fakeCodexClient,
        claudeOrchestratorRunner: fakeClaudeRunner as unknown as typeof import("../src/main/cli-agent-runner.js").runClaudeTurn,
        now: () => fakeNow,
        laneRotationPolicy: { maxTurns: 2, maxIdleMs: 60_000, maxEstimatedChars: 100_000 },
      });

      const internals = ctrl as unknown as {
        isConnected: boolean;
        providers: Record<string, unknown>;
        responderLanes: Array<{
          threadId: string;
          activeTurnId: string | null;
          activeAssistantMessageId: string | null;
          turnCount?: number;
          lastUsedAt?: number;
          createdAt?: number;
          lastSyncedMessageId?: string | null;
          lastProjectsHash?: string | null;
        }>;
        claudeResponderLanes: Array<{
          laneId: string;
          sessionId: string | null;
          activeAssistantMessageId: string | null;
          turnCount?: number;
          lastUsedAt?: number;
          createdAt?: number;
          lastSyncedMessageId?: string | null;
          lastProjectsHash?: string | null;
        }>;
        orchestratorMetricsLogger: OrchestratorMetricsLogger;
      };

      internals.isConnected = true;
      internals.providers = {
        codex: { id: "codex", label: "Codex", available: true, detail: "接続済み", models: [] },
        agy: { id: "agy", label: "AGY", available: false, detail: "", models: [] },
        claude: { id: "claude", label: "Claude", available: true, detail: "利用可能", models: [] },
      };

      ctrl.registerProject(projDir, "repo-one");

      // Codex Turn 1 (new) -> full projects
      await ctrl.sendMessage({ text: "Codex Turn 1", attachments: [] });
      await waitFor(() => codexPrompts.length === 1 && ctrl.getSnapshot().messages.every((m) => !m.isStreaming));
      expect(codexPrompts[0]!.threadId).toBe("codex-thr-1");
      expect(codexPrompts[0]!.text).toContain("Discovered projects");

      // Seed an older idle Codex lane ahead in array -> MRU must still choose codex-thr-1
      internals.responderLanes.unshift({
        threadId: "codex-older",
        activeTurnId: null,
        activeAssistantMessageId: null,
        turnCount: 1,
        lastUsedAt: fakeNow - 30_000,
        createdAt: fakeNow - 30_000,
        lastSyncedMessageId: null,
        lastProjectsHash: null,
      });

      // Codex Turn 2 (reused MRU, invokes search_chat_history) -> delta omits projects & transcript
      fakeNow += 1_000;
      await ctrl.sendMessage({ text: "Codex Turn 2", attachments: [] });
      await waitFor(() => codexPrompts.length === 2 && ctrl.getSnapshot().messages.every((m) => !m.isStreaming));
      expect(codexPrompts[1]!.threadId).toBe("codex-thr-1");
      expect(codexPrompts[1]!.text).not.toContain("Discovered projects");
      expect(codexPrompts[1]!.text).not.toContain("[Recent Unified Chat Transcript]");

      // Remove codex-older so only codex-thr-1 (turnCount === 2 === maxTurns) remains -> Turn 3 rotates!
      internals.responderLanes = internals.responderLanes.filter((l) => l.threadId === "codex-thr-1");
      fakeNow += 1_000;
      await ctrl.sendMessage({ text: "Codex Turn 3 rotated", attachments: [] });
      await waitFor(() => codexPrompts.length === 3 && ctrl.getSnapshot().messages.every((m) => !m.isStreaming));
      expect(codexPrompts[2]!.threadId).toBe("codex-thr-2");
      expect(codexPrompts[2]!.text).toContain("Discovered projects");
      expect(codexPrompts[2]!.text).toContain("[Recent Unified Chat Transcript]");

      // --- Switch to Claude ---
      ctrl.setChatProvider("claude");

      // Claude Turn 1 (new) -> full projects & transcript
      fakeNow += 1_000;
      await ctrl.sendMessage({ text: "Claude Turn 1", attachments: [] });
      await waitFor(() => claudeCalls.length === 1 && ctrl.getSnapshot().messages.every((m) => !m.isStreaming));
      expect(claudeCalls[0]!.sessionId).toBeNull();
      expect(claudeCalls[0]!.prompt).toContain("Discovered projects");
      expect(claudeCalls[0]!.prompt).toContain("[Recent Unified Chat Transcript]");

      // Seed an older idle Claude lane ahead in array -> MRU must choose claude-s-1
      internals.claudeResponderLanes.unshift({
        laneId: "claude-older-lane",
        sessionId: "claude-older",
        activeAssistantMessageId: null,
        turnCount: 1,
        lastUsedAt: fakeNow - 20_000,
        createdAt: fakeNow - 20_000,
        lastSyncedMessageId: null,
        lastProjectsHash: null,
      });

      // Claude Turn 2 (reused MRU, calls search_chat_history) -> omits projects & transcript
      fakeNow += 1_000;
      await ctrl.sendMessage({ text: "Claude Turn 2", attachments: [] });
      await waitFor(() => claudeCalls.length === 2 && ctrl.getSnapshot().messages.every((m) => !m.isStreaming));
      expect(claudeCalls[1]!.sessionId).toBe("claude-s-1");
      expect(claudeCalls[1]!.prompt).not.toContain("Discovered projects");
      expect(claudeCalls[1]!.prompt).not.toContain("[Recent Unified Chat Transcript]");

      // Keep only claude-s-1 (turnCount === 2 === maxTurns) -> Turn 3 rotates to fresh Claude session!
      internals.claudeResponderLanes = internals.claudeResponderLanes.filter(
        (l) => l.sessionId === "claude-s-1",
      );
      fakeNow += 1_000;
      await ctrl.sendMessage({ text: "Claude Turn 3 rotated", attachments: [] });
      await waitFor(() => claudeCalls.length === 3 && ctrl.getSnapshot().messages.every((m) => !m.isStreaming));
      expect(claudeCalls[2]!.sessionId).toBeNull();
      expect(claudeCalls[2]!.prompt).toContain("Discovered projects");
      expect(claudeCalls[2]!.prompt).toContain("[Recent Unified Chat Transcript]");

      await internals.orchestratorMetricsLogger.flush();
      const metrics = readMetricsFile(tmpDir);
      expect(metrics).toHaveLength(6);

      // Codex metrics
      expect(metrics[0]).toMatchObject({
        provider: "codex",
        laneId: "codex-thr-1",
        laneMode: "new",
        turnCount: 1,
        projectsInjected: true,
        usedSearchChatHistory: false,
      });
      expect(metrics[1]).toMatchObject({
        provider: "codex",
        laneId: "codex-thr-1",
        laneMode: "reused",
        turnCount: 2,
        projectsInjected: false,
        usedSearchChatHistory: true,
      });
      expect(metrics[2]).toMatchObject({
        provider: "codex",
        laneId: "codex-thr-2",
        laneMode: "rotated",
        rotationReason: "turn_limit",
        turnCount: 1,
        projectsInjected: true,
      });

      // Claude metrics
      expect(metrics[3]).toMatchObject({
        provider: "claude",
        laneId: "claude-s-1",
        laneMode: "new",
        turnCount: 1,
        projectsInjected: true,
        usedSearchChatHistory: false,
      });
      expect(metrics[4]).toMatchObject({
        provider: "claude",
        laneId: "claude-s-1",
        laneMode: "reused",
        turnCount: 2,
        projectsInjected: false,
        usedSearchChatHistory: true,
      });
      expect(metrics[5]).toMatchObject({
        provider: "claude",
        laneId: "claude-s-2",
        laneMode: "rotated",
        rotationReason: "turn_limit",
        turnCount: 1,
        projectsInjected: true,
      });

      await ctrl.shutdown();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
