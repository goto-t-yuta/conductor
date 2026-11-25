import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { AgyAcpClient, parseAgySessionUpdate } from "../src/main/agy-acp-client.js";
import type { BrowserManager } from "../src/main/browser-manager.js";
import { ConductorController } from "../src/main/conductor-controller.js";
import { LocalMCPServer, conductorMCPTools } from "../src/main/local-mcp-server.js";
import { resolveAgyExecutable } from "../src/main/shell-env.js";
import { StateStore } from "../src/main/state-store.js";
import type { AppSnapshot } from "../src/shared/types.js";

interface FakeRpcMessage {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

class FakeAcpChildProcess extends EventEmitter {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public killed = false;
  public readonly received: FakeRpcMessage[] = [];
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
          const parsed = JSON.parse(line) as FakeRpcMessage;
          this.received.push(parsed);
          this.onMessage(parsed, this);
        }
        idx = this.stdinBuf.indexOf("\n");
      }
    });
  }

  public sendToClient(payload: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(payload)}\n`);
  }

  public crash(code = 1, stderrText = "simulated crash"): void {
    if (stderrText) this.stderr.write(stderrText);
    this.killed = true;
    this.emit("exit", code, null);
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

describe("AgyAcpClient unit tests", () => {
  it("parses ACP session/update notifications cleanly", () => {
    expect(
      parseAgySessionUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      }),
    ).toEqual({ kind: "textDelta", text: "hello" });

    expect(
      parseAgySessionUpdate({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking..." },
      }),
    ).toEqual({ kind: "reasoningDelta", text: "thinking..." });

    expect(
      parseAgySessionUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        name: "mcp_conductor_list_tasks",
        status: "in_progress",
        rawInput: { toolSummary: "Checking tasks" },
      }),
    ).toEqual({
      kind: "toolEvent",
      id: "call_1",
      name: "mcp_conductor_list_tasks",
      detail: "Checking tasks",
      completed: false,
      isError: false,
    });

    expect(
      parseAgySessionUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        name: "mcp_conductor_list_tasks",
        status: "failed",
      }),
    ).toEqual({
      kind: "toolEvent",
      id: "call_1",
      name: "mcp_conductor_list_tasks",
      detail: undefined,
      completed: true,
      isError: true,
    });
  });

  it("handles initialize, MCP config, model/effort switching, parallel prompts, cancel, permission requests, and crash respawn", async () => {
    let spawnCount = 0;
    let sessionSeq = 0;
    const spawnedProcs: FakeAcpChildProcess[] = [];
    const inflightPrompts = new Map<string, { id: number; proc: FakeAcpChildProcess }>();
    const permissionResponses: FakeRpcMessage[] = [];

    const client = new AgyAcpClient("test", {
      resolveExecutable: () => "/fake/agy",
      spawnProcess: (_cmd, args) => {
        expect(args).toEqual(["acp", "--dangerously-skip-permissions"]);
        spawnCount += 1;
        const fake = new FakeAcpChildProcess((msg, proc) => {
          if (msg.method === undefined && msg.id === 999) {
            permissionResponses.push(msg);
            return;
          }
          if (msg.method === "initialize") {
            proc.sendToClient({
              jsonrpc: "2.0",
              id: msg.id,
              result: { protocolVersion: 1, agentInfo: { name: "Fake ACP", version: "1.0.0" } },
            });
            return;
          }
          if (msg.method === "session/new") {
            sessionSeq += 1;
            proc.sendToClient({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                sessionId: `sess-${sessionSeq}`,
                models: {
                  currentModelId: "gemini-4-neon-high",
                  availableModels: [
                    { modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
                    { modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
                  ],
                },
                configOptions: [
                  { id: "thought_level", category: "thought_level", currentValue: "high" },
                ],
              },
            });
            return;
          }
          if (msg.method === "session/set_model" || msg.method === "session/set_config_option") {
            proc.sendToClient({ jsonrpc: "2.0", id: msg.id, result: {} });
            return;
          }
          if (msg.method === "session/close") {
            proc.sendToClient({ jsonrpc: "2.0", id: msg.id, result: {} });
            return;
          }
          if (msg.method === "session/cancel") {
            const sid = String(msg.params?.sessionId ?? "");
            const active = inflightPrompts.get(sid);
            if (active) {
              inflightPrompts.delete(sid);
              active.proc.sendToClient({
                jsonrpc: "2.0",
                id: active.id,
                result: { stopReason: "cancelled" },
              });
            }
            return;
          }
          if (msg.method === "session/prompt") {
            const sid = String(msg.params?.sessionId ?? "");
            const promptBlocks = (msg.params?.prompt as Array<{ text?: string }>) ?? [];
            const text = promptBlocks[0]?.text ?? "";
            if (text === "HANG_FOR_CANCEL") {
              inflightPrompts.set(sid, { id: msg.id!, proc });
              return;
            }
            // Emit a permission request once to verify auto-approval
            if (text === "REQ_PERM") {
              proc.sendToClient({
                jsonrpc: "2.0",
                id: 999,
                method: "session/request_permission",
                params: {
                  sessionId: sid,
                  options: [
                    { optionId: "deny_1", kind: "reject_once" },
                    { optionId: "allow_1", kind: "allow_once" },
                  ],
                },
              });
            }
            setTimeout(() => {
              proc.sendToClient({
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  sessionId: sid,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: `reply:${sid}:${text}` },
                  },
                },
              });
              proc.sendToClient({
                jsonrpc: "2.0",
                id: msg.id,
                result: { stopReason: "end_turn" },
              });
            }, 15);
          }
        });
        spawnedProcs.push(fake);
        return fake as unknown as ChildProcessWithoutNullStreams;
      },
    });

    const updatesBySession = new Map<string, string>();
    client.onSessionUpdate((u) => {
      const parsed = parseAgySessionUpdate(u.raw);
      if (parsed.kind === "textDelta") {
        updatesBySession.set(u.sessionId, (updatesBySession.get(u.sessionId) ?? "") + parsed.text);
      }
    });

    const disconnects: string[] = [];
    client.onDisconnect((reason) => disconnects.push(reason));

    // Coalesced concurrent connects spawn only 1 process
    await Promise.all([client.connect({ cwd: "/tmp" }), client.connect({ cwd: "/tmp" })]);
    expect(spawnCount).toBe(1);
    expect(client.isConnected()).toBe(true);

    // Create two sessions with MCP config and system prompt append
    const [s1, s2] = await Promise.all([
      client.createSession({
        cwd: "/tmp",
        mcpServers: [{ name: "conductor", url: "http://127.0.0.1:9999/mcp", bearerToken: "secret" }],
        systemPromptAppend: "You are Conductor.",
      }),
      client.createSession({
        cwd: "/tmp",
        mcpServers: [{ name: "conductor", url: "http://127.0.0.1:9999/mcp", bearerToken: "secret" }],
        systemPromptAppend: "You are Conductor.",
      }),
    ]);

    expect(s1.availableModels.length).toBe(2);
    const sessionNewReq = spawnedProcs[0].received.find((m) => m.method === "session/new");
    expect(sessionNewReq?.params?.mcpServers).toEqual([
      {
        name: "conductor",
        type: "http",
        url: "http://127.0.0.1:9999/mcp",
        headers: [{ name: "Authorization", value: "Bearer secret" }],
      },
    ]);
    expect(sessionNewReq?.params?._meta).toEqual({
      antigravity: { systemPrompt: { append: "You are Conductor." } },
    });

    // Model + effort switching
    await client.setModel(s1.sessionId, "gemini-3.8-flash-low");
    await client.setEffort(s1.sessionId, "medium");
    expect(spawnedProcs[0].received.some((m) => m.method === "session/set_model")).toBe(true);
    expect(spawnedProcs[0].received.some((m) => m.method === "session/set_config_option")).toBe(true);

    // Parallel prompts on the same resident process
    const [r1, r2] = await Promise.all([
      client.prompt({ sessionId: s1.sessionId, text: "REQ_PERM" }),
      client.prompt({ sessionId: s2.sessionId, text: "SECOND" }),
    ]);
    expect(r1.stopReason).toBe("end_turn");
    expect(r2.stopReason).toBe("end_turn");
    expect(updatesBySession.get(s1.sessionId)).toBe(`reply:${s1.sessionId}:REQ_PERM`);
    expect(updatesBySession.get(s2.sessionId)).toBe(`reply:${s2.sessionId}:SECOND`);
    expect(permissionResponses).toHaveLength(1);
    expect(permissionResponses[0].result).toEqual({
      outcome: { outcome: "selected", optionId: "allow_1" },
    });

    // Cancellation
    const cancelProm = client.prompt({ sessionId: s1.sessionId, text: "HANG_FOR_CANCEL" });
    await waitFor(() => inflightPrompts.has(s1.sessionId));
    client.cancelSession(s1.sessionId);
    const cancelRes = await cancelProm;
    expect(cancelRes.stopReason).toBe("cancelled");

    // Unexpected crash triggers disconnect & allows clean respawn
    spawnedProcs[0].crash(137, "OOM killed");
    expect(client.isConnected()).toBe(false);
    expect(disconnects).toHaveLength(1);
    expect(disconnects[0]).toContain("OOM killed");

    await client.connect({ cwd: "/tmp" });
    expect(spawnCount).toBe(2);
    expect(client.isConnected()).toBe(true);

    // Intentional stop does NOT fire disconnect listener
    client.stop();
    await new Promise((r) => setTimeout(r, 20));
    expect(client.isConnected()).toBe(false);
    expect(disconnects).toHaveLength(1);
  });
});

describe("ConductorController resident AGY ACP orchestration", () => {
  it("supports lazy startup, rapid-fire parallel questions, model switching, cancel, crash recovery, and provider-change shutdown", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-agy-ctrl-"));
    let spawnCount = 0;
    let sessionSeq = 0;
    let crashNextPromptOnce = false;
    const spawnedProcs: FakeAcpChildProcess[] = [];
    const inflight = new Map<string, { id: number; proc: FakeAcpChildProcess; timer?: NodeJS.Timeout }>();
    const setModelCalls: Array<{ sessionId: string; modelId: string }> = [];
    const setEffortCalls: Array<{ sessionId: string; value: string }> = [];

    const agyClient = new AgyAcpClient("test-orchestrator", {
      resolveExecutable: () => "/fake/agy",
      spawnProcess: () => {
        spawnCount += 1;
        const fake = new FakeAcpChildProcess((msg, proc) => {
          if (msg.method === "initialize") {
            proc.sendToClient({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
            return;
          }
          if (msg.method === "session/new") {
            sessionSeq += 1;
            proc.sendToClient({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                sessionId: `agy-sess-${sessionSeq}`,
                models: {
                  currentModelId: "gemini-4-neon-high",
                  availableModels: [
                    { modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
                    { modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
                  ],
                },
              },
            });
            return;
          }
          if (msg.method === "session/set_model") {
            setModelCalls.push({
              sessionId: String(msg.params?.sessionId),
              modelId: String(msg.params?.modelId),
            });
            proc.sendToClient({ jsonrpc: "2.0", id: msg.id, result: {} });
            return;
          }
          if (msg.method === "session/set_config_option") {
            setEffortCalls.push({
              sessionId: String(msg.params?.sessionId),
              value: String(msg.params?.value),
            });
            proc.sendToClient({ jsonrpc: "2.0", id: msg.id, result: {} });
            return;
          }
          if (msg.method === "session/close") {
            proc.sendToClient({ jsonrpc: "2.0", id: msg.id, result: {} });
            return;
          }
          if (msg.method === "session/cancel") {
            const sid = String(msg.params?.sessionId ?? "");
            const entry = inflight.get(sid);
            if (entry) {
              if (entry.timer) clearTimeout(entry.timer);
              inflight.delete(sid);
              entry.proc.sendToClient({
                jsonrpc: "2.0",
                id: entry.id,
                result: { stopReason: "cancelled" },
              });
            }
            return;
          }
          if (msg.method === "session/prompt") {
            const sid = String(msg.params?.sessionId ?? "");
            const blocks = (msg.params?.prompt as Array<{ text?: string }>) ?? [];
            const fullText = blocks[0]?.text ?? "";
            if (crashNextPromptOnce) {
              crashNextPromptOnce = false;
              proc.crash(1, "boom before tokens");
              return;
            }
            const currentMessageSection =
              fullText.split("[Current User Message to Answer Now]").at(-1) ?? fullText;
            if (currentMessageSection.includes("WAIT_FOR_STOP")) {
              inflight.set(sid, { id: msg.id!, proc });
              return;
            }
            const tag = currentMessageSection.includes("ALPHA")
              ? "ALPHA"
              : currentMessageSection.includes("BETA")
                ? "BETA"
                : "OTHER";
            const timer = setTimeout(() => {
              inflight.delete(sid);
              proc.sendToClient({
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  sessionId: sid,
                  update: {
                    sessionUpdate: "tool_call",
                    toolCallId: `tool-${tag}`,
                    name: "mcp_conductor_list_tasks",
                    status: "in_progress",
                  },
                },
              });
              proc.sendToClient({
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  sessionId: sid,
                  update: {
                    sessionUpdate: "tool_call_update",
                    toolCallId: `tool-${tag}`,
                    name: "mcp_conductor_list_tasks",
                    status: "completed",
                  },
                },
              });
              proc.sendToClient({
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  sessionId: sid,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: `Answered ${tag} via ${sid}` },
                  },
                },
              });
              proc.sendToClient({
                jsonrpc: "2.0",
                id: msg.id,
                result: { stopReason: "end_turn" },
              });
            }, 30);
            inflight.set(sid, { id: msg.id!, proc, timer });
          }
        });
        spawnedProcs.push(fake);
        return fake as unknown as ChildProcessWithoutNullStreams;
      },
    });

    const snapshots: AppSnapshot[] = [];
    const store = new StateStore(tmpDir);
    // Start persisted on "claude" so AGY starts lazily (not spawned at startup)
    const initial = store.load();
    store.save({ ...initial, chatProvider: "claude", workerProvider: "claude" });

    const controller = new ConductorController({
      store,
      browser: createFakeBrowserManager(),
      onSnapshot: (snap) => {
        snapshots.push(snap);
      },
      agyOrchestratorClient: agyClient,
    });

    try {
      // Seed MCP server & provider availability directly without touching real Codex/Claude binaries
      const mcp = new LocalMCPServer(conductorMCPTools(), async () => ({ text: "{}" }));
      const mcpUrl = await mcp.start();
      try {
        (controller as unknown as Record<string, unknown>).mcpServer = mcp;
        (controller as unknown as Record<string, unknown>).agyMcpConfig = {
          name: "conductor",
          url: mcpUrl,
          bearerToken: mcp.bearerToken,
        };
        (controller as unknown as Record<string, unknown>).isConnected = true;
        (controller as unknown as Record<string, unknown>).providers = {
          codex: { id: "codex", label: "Codex", available: false, detail: "", models: [] },
          agy: {
            id: "agy",
            label: "AGY",
            available: true,
            detail: "利用可能 (2 models · ACP待機)",
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
              {
                id: "gemini-4-neon-high",
                model: "gemini-4-neon-high",
                displayName: "Gemini 4 Neon (High)",
                description: "",
                supportedEfforts: [],
                defaultEffort: "",
                isDefault: false,
              },
            ],
          },
          claude: { id: "claude", label: "Claude", available: true, detail: "", models: [] },
        };

        // 1. Lazy: still 0 agy acp processes while on Claude
        expect(spawnCount).toBe(0);

        // 2. Switching to AGY eagerly spawns 1 resident process and prewarms 1 idle lane
        controller.setChatProvider("agy");
        await waitFor(() => agyClient.isConnected() && sessionSeq >= 1);
        expect(spawnCount).toBe(1);
        expect(snapshots.at(-1)?.chatProvider).toBe("agy");
        expect(snapshots.at(-1)?.chatModel).toBe("gemini-3.8-flash-low");

        // 3. Rapid-fire parallel questions share the SINGLE resident process across 2 sessions
        await Promise.all([
          controller.sendMessage({ text: "Question ALPHA", attachments: [] }),
          controller.sendMessage({ text: "Question BETA", attachments: [] }),
        ]);

        await waitFor(() => {
          const snap = controller.getSnapshot();
          const assistants = snap.messages.filter((m) => m.role === "assistant");
          return assistants.length === 2 && assistants.every((m) => !m.isStreaming);
        });

        const snapAfterParallel = controller.getSnapshot();
        const [a1, a2] = snapAfterParallel.messages.filter((m) => m.role === "assistant");
        expect(spawnCount).toBe(1); // still 1 single resident agy acp process!
        expect(a1.text).toContain("Answered ALPHA");
        expect(a2.text).toContain("Answered BETA");
        expect(a1.responderThreadId).not.toBe(a2.responderThreadId);
        expect(a1.toolChips[0]?.label).toBe("タスク一覧を確認");
        expect(a1.toolChips[0]?.isCompleted).toBe(true);
        expect(snapAfterParallel.activeResponderCount).toBe(0);

        // 4. Model & effort switching updates idle lanes and subsequent turns
        controller.setChatModel("gemini-4-neon-high", "xhigh");
        await waitFor(
          () =>
            setModelCalls.some((c) => c.modelId === "gemini-4-neon-high") &&
            setEffortCalls.some((c) => c.value === "xhigh"),
        );

        // 5. Stop/cancel an in-flight AGY message cleanly
        await controller.sendMessage({ text: "WAIT_FOR_STOP", attachments: [] });
        await waitFor(() => inflight.size === 1);
        const streamingMsg = controller
          .getSnapshot()
          .messages.find((m) => m.role === "assistant" && m.isStreaming);
        expect(streamingMsg).toBeDefined();
        await controller.stopMessage(streamingMsg!.id);
        const stoppedMsg = controller
          .getSnapshot()
          .messages.find((m) => m.id === streamingMsg!.id);
        expect(stoppedMsg?.isStreaming).toBe(false);
        expect(stoppedMsg?.text).toBe("停止しました。");

        // 6. Crash recovery: crash right when prompt starts -> transparent respawn & retry
        crashNextPromptOnce = true;
        await controller.sendMessage({ text: "Question ALPHA after crash", attachments: [] });
        await waitFor(() => {
          const assistants = controller.getSnapshot().messages.filter((m) => m.role === "assistant");
          const last = assistants.at(-1);
          return Boolean(last && !last.isStreaming);
        });
        const recoveredMsg = controller
          .getSnapshot()
          .messages.filter((m) => m.role === "assistant")
          .at(-1);
        expect(spawnCount).toBe(2); // respawned cleanly!
        expect(recoveredMsg?.text).toContain("Answered ALPHA");

        // 7. Provider change away from AGY gracefully shuts down the resident process
        controller.setChatProvider("claude");
        await waitFor(() => !agyClient.isConnected());
        expect(spawnedProcs[1].killed).toBe(true);
      } finally {
        await controller.shutdown();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("AgyAcpClient live smoke test", () => {
  it("runs two parallel sessions with MCP on a single resident agy acp process", async () => {
    if (!resolveAgyExecutable()) return;

    let mcpCalls = 0;
    const mcp = new LocalMCPServer(
      [
        {
          name: "ping_probe",
          description: "Returns a deterministic pong token",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      async () => {
        mcpCalls += 1;
        return { text: "PONG_ACP_LIVE" };
      },
    );
    const mcpUrl = await mcp.start();
    const client = new AgyAcpClient("vitest-live");
    const texts = new Map<string, string>();
    client.onSessionUpdate((u) => {
      const parsed = parseAgySessionUpdate(u.raw);
      if (parsed.kind === "textDelta") {
        texts.set(u.sessionId, (texts.get(u.sessionId) ?? "") + parsed.text);
      }
    });

    try {
      await client.connect({ cwd: os.tmpdir() });
      const mcpConfig = [{ name: "conductor", url: mcpUrl, bearerToken: mcp.bearerToken }];
      const [s1, s2] = await Promise.all([
        client.createSession({ cwd: os.tmpdir(), mcpServers: mcpConfig }),
        client.createSession({ cwd: os.tmpdir(), mcpServers: mcpConfig }),
      ]);
      expect(s1.availableModels.length).toBeGreaterThan(0);

      await Promise.all([
        client.setModel(s1.sessionId, "gemini-3.8-flash-low"),
        client.setModel(s2.sessionId, "gemini-3.8-flash-low"),
      ]);

      const [r1, r2] = await Promise.all([
        client.prompt({
          sessionId: s1.sessionId,
          text: "Call ping_probe tool and reply with its exact output.",
        }),
        client.prompt({
          sessionId: s2.sessionId,
          text: "Reply with just the single word PARALLEL_OK.",
        }),
      ]);

      expect(r1.stopReason).toBe("end_turn");
      expect(r2.stopReason).toBe("end_turn");
      expect(mcpCalls).toBeGreaterThanOrEqual(1);
      expect(texts.get(s1.sessionId) ?? "").toContain("PONG_ACP_LIVE");
      expect((texts.get(s2.sessionId) ?? "").toUpperCase()).toContain("PARALLEL_OK");

      await Promise.all([
        client.closeSession(s1.sessionId),
        client.closeSession(s2.sessionId),
      ]);
    } finally {
      client.stop();
      await mcp.stop();
    }
  }, 45_000);
});
