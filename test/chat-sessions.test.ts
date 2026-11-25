import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { AgyAcpClient } from "../src/main/agy-acp-client.js";
import type { BrowserManager } from "../src/main/browser-manager.js";
import { ConductorController } from "../src/main/conductor-controller.js";
import { LocalMCPServer, conductorMCPTools } from "../src/main/local-mcp-server.js";
import { StateStore } from "../src/main/state-store.js";
import {
  DEFAULT_CHAT_TITLE,
  deriveChatSessionPreview,
  deriveChatSessionTitle,
  normalizeChatSessions,
} from "../src/shared/chat-sessions.js";
import type { ChatMessage } from "../src/shared/types.js";

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

function makeMessage(overrides: Partial<ChatMessage> & { id: string; role: ChatMessage["role"]; text: string }): ChatMessage {
  return {
    attachments: [],
    toolChips: [],
    isStreaming: false,
    createdAt: "2026-11-26T00:00:00.000Z",
    ...overrides,
  };
}

describe("chat session helpers & StateStore migration", () => {
  it("derives clean titles and previews from messages", () => {
    expect(deriveChatSessionTitle([])).toBe(DEFAULT_CHAT_TITLE);
    expect(deriveChatSessionPreview([])).toBe("");

    const msgs: ChatMessage[] = [
      makeMessage({
        id: "u1",
        role: "user",
        text: "  ログイン画面のバリデーションエラーを直してほしい   ",
      }),
      makeMessage({
        id: "a1",
        role: "assistant",
        provider: "agy",
        responderThreadId: "agy-sess-42",
        text: "修正方針を確認してワーカーを起動しました。\nテストも実行します。",
      }),
    ];

    expect(deriveChatSessionTitle(msgs)).toBe("ログイン画面のバリデーションエラーを直してほしい");
    expect(deriveChatSessionPreview(msgs)).toBe("修正方針を確認してワーカーを起動しました。 テストも実行します。");
  });

  it("migrates legacy flat messages in state.json into a persistent ChatSession", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-migrate-chat-"));
    try {
      const legacyState = {
        projects: [],
        scanRoots: [],
        tasks: [],
        messages: [
          makeMessage({
            id: "legacy-u1",
            role: "user",
            text: "以前のチャット履歴を保持して",
            createdAt: "2026-11-25T10:00:00.000Z",
          }),
          makeMessage({
            id: "legacy-a1",
            role: "assistant",
            provider: "agy",
            responderThreadId: "legacy-agy-sid-99",
            text: "承知しました！",
            createdAt: "2026-11-25T10:00:05.000Z",
          }),
        ],
        browserTabs: [],
        activeBrowserTabId: null,
        showTaskSidebar: true,
        showBrowserPane: true,
        chatProvider: "agy",
        chatModel: "gemini-3.8-flash-low",
        chatEffort: null,
        workerModel: null,
        workerEffort: null,
      };
      fs.writeFileSync(path.join(tmpDir, "state.json"), JSON.stringify(legacyState, null, 2), "utf8");

      const store = new StateStore(tmpDir);
      const loaded = store.load();

      expect(loaded.chatSessions).toHaveLength(1);
      expect(loaded.activeChatSessionId).toBe(loaded.chatSessions![0]!.id);
      expect(loaded.chatSessions![0]!.title).toBe("以前のチャット履歴を保持して");
      expect(loaded.chatSessions![0]!.preview).toBe("承知しました！");
      expect(loaded.chatSessions![0]!.messages).toHaveLength(2);
      expect(loaded.chatSessions![0]!.backendSessionIds?.agy).toBe("legacy-agy-sid-99");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("normalizes empty state to a single active empty session", () => {
    const res = normalizeChatSessions({ chatProvider: "codex" });
    expect(res.chatSessions).toHaveLength(1);
    expect(res.activeChatSessionId).toBe(res.chatSessions[0]!.id);
    expect(res.chatSessions[0]!.title).toBe(DEFAULT_CHAT_TITLE);
    expect(res.chatSessions[0]!.messages).toEqual([]);
  });
});

describe("ConductorController persistent chat sessions & orchestrator resume", () => {
  it("preserves previous chats on New Chat, restores UI + AGY ACP session via session/resume, survives restart, and falls back with context rebind if resume fails", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-chat-sessions-"));
    let sessionSeq = 0;
    const resumedSessionIds: string[] = [];
    const promptHistory: Array<{ sessionId: string; text: string }> = [];
    let failResumeForSessionId: string | null = null;

    const makeFakeAgyClient = () =>
      new AgyAcpClient("test-sessions", {
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
            if (msg.method === "session/resume") {
              const sid = String(msg.params?.sessionId ?? "");
              resumedSessionIds.push(sid);
              if (failResumeForSessionId === sid) {
                proc.sendToClient({
                  jsonrpc: "2.0",
                  id: msg.id,
                  error: { code: -32000, message: `Session not found: ${sid}` },
                });
                return;
              }
              proc.sendToClient({
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  sessionId: sid,
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
            if (msg.method === "session/set_model" || msg.method === "session/close") {
              proc.sendToClient({ jsonrpc: "2.0", id: msg.id, result: {} });
              return;
            }
            if (msg.method === "session/prompt") {
              const sid = String(msg.params?.sessionId ?? "");
              const blocks = (msg.params?.prompt as Array<{ text?: string }>) ?? [];
              const text = blocks[0]?.text ?? "";
              promptHistory.push({ sessionId: sid, text });
              setTimeout(() => {
                proc.sendToClient({
                  jsonrpc: "2.0",
                  method: "session/update",
                  params: {
                    sessionId: sid,
                    update: {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: `Reply from ${sid}` },
                    },
                  },
                });
                proc.sendToClient({
                  jsonrpc: "2.0",
                  id: msg.id,
                  result: { stopReason: "end_turn" },
                });
              }, 10);
            }
          });
          return fake as unknown as ChildProcessWithoutNullStreams;
        },
      });

    const wireController = (controller: ConductorController, mcp: LocalMCPServer, mcpUrl: string) => {
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
          detail: "ACP 常駐接続済み (1 models)",
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
    };

    const mcp = new LocalMCPServer(conductorMCPTools(), async () => ({ text: "{}" }));
    const mcpUrl = await mcp.start();

    try {
      const store = new StateStore(tmpDir);
      const initial = store.load();
      store.save({ ...initial, chatProvider: "agy", chatModel: "gemini-3.8-flash-low" });

      const agyClient1 = makeFakeAgyClient();
      const ctrl1 = new ConductorController({
        store,
        browser: createFakeBrowserManager(),
        onSnapshot: () => {},
        agyOrchestratorClient: agyClient1,
      });
      wireController(ctrl1, mcp, mcpUrl);

      // 1. Send message in Chat 1
      await ctrl1.sendMessage({ text: "プロジェクトAの認証バグを調査して", attachments: [] });
      await waitFor(() => {
        const msgs = ctrl1.getSnapshot().messages;
        return msgs.length === 2 && msgs.every((m) => !m.isStreaming);
      });

      const snap1 = ctrl1.getSnapshot();
      const chat1Id = snap1.activeChatSessionId;
      const chat1AgySessionId = snap1.messages[1]!.responderThreadId!;
      expect(chat1AgySessionId).toBe("agy-s-1");
      expect(snap1.chatSessions).toHaveLength(1);
      expect(snap1.chatSessions[0]!.title).toBe("プロジェクトAの認証バグを調査して");

      // 2. Start Fresh Chat -> MUST preserve Chat 1 in history!
      await ctrl1.startFreshChat();
      const snapAfterNew = ctrl1.getSnapshot();
      const chat2Id = snapAfterNew.activeChatSessionId;
      expect(chat2Id).not.toBe(chat1Id);
      expect(snapAfterNew.messages).toHaveLength(0);
      expect(snapAfterNew.chatSessions).toHaveLength(2);
      expect(snapAfterNew.chatSessions.some((s) => s.id === chat1Id && s.messageCount === 2)).toBe(true);

      // Calling startFreshChat again while already empty does NOT create duplicate empty chats
      await ctrl1.startFreshChat();
      expect(ctrl1.getSnapshot().chatSessions).toHaveLength(2);
      expect(ctrl1.getSnapshot().activeChatSessionId).toBe(chat2Id);

      // 3. Send message in Chat 2
      await ctrl1.sendMessage({ text: "ダークモードのCSSを調整して", attachments: [] });
      await waitFor(() => {
        const msgs = ctrl1.getSnapshot().messages;
        return msgs.length === 2 && msgs.every((m) => !m.isStreaming);
      });
      const chat2AgySessionId = ctrl1.getSnapshot().messages[1]!.responderThreadId!;
      expect(chat2AgySessionId).not.toBe(chat1AgySessionId);

      // 4. Switch back to Chat 1 -> restores UI messages AND calls session/resume with Chat 1's AGY sessionId!
      await ctrl1.selectChatSession(chat1Id);
      const snapRestored = ctrl1.getSnapshot();
      expect(snapRestored.activeChatSessionId).toBe(chat1Id);
      expect(snapRestored.messages).toHaveLength(2);
      expect(snapRestored.messages[0]!.text).toBe("プロジェクトAの認証バグを調査して");

      await waitFor(() => resumedSessionIds.includes(chat1AgySessionId));

      // Follow-up message in restored Chat 1 runs on the SAME resumed AGY sessionId!
      await ctrl1.sendMessage({ text: "続きの修正も進めて", attachments: [] });
      await waitFor(() => {
        const msgs = ctrl1.getSnapshot().messages;
        return msgs.length === 4 && msgs.every((m) => !m.isStreaming);
      });
      expect(ctrl1.getSnapshot().messages[3]!.responderThreadId).toBe(chat1AgySessionId);
      expect(promptHistory.at(-1)?.sessionId).toBe(chat1AgySessionId);

      await ctrl1.shutdown();

      // 5. Simulate full app restart with a fresh controller reading the same StateStore
      // Also simulate that Chat 1's old AGY sessionId is expired on the restarted backend -> tests clean rebind fallback!
      failResumeForSessionId = chat1AgySessionId;
      const agyClient2 = makeFakeAgyClient();
      const ctrl2 = new ConductorController({
        store: new StateStore(tmpDir),
        browser: createFakeBrowserManager(),
        onSnapshot: () => {},
        agyOrchestratorClient: agyClient2,
      });
      wireController(ctrl2, mcp, mcpUrl);

      const snapReloaded = ctrl2.getSnapshot();
      expect(snapReloaded.activeChatSessionId).toBe(chat1Id);
      expect(snapReloaded.messages).toHaveLength(4);
      expect(snapReloaded.chatSessions).toHaveLength(2);

      // Sending a message after backend session expiry falls back cleanly to a new session WITH restored context header
      await ctrl2.sendMessage({ text: "再起動後の確認メッセージ", attachments: [] });
      await waitFor(() => {
        const msgs = ctrl2.getSnapshot().messages;
        return msgs.length === 6 && msgs.every((m) => !m.isStreaming);
      });

      const lastPrompt = promptHistory.at(-1);
      expect(lastPrompt?.sessionId).not.toBe(chat1AgySessionId);
      expect(lastPrompt?.text).toContain("[Restored Chat Session Context");
      expect(lastPrompt?.text).toContain("プロジェクトAの認証バグを調査して");

      // Saved backendSessionIds.agy is updated to the fresh rebound sessionId
      const persistedAfterRebind = new StateStore(tmpDir).load();
      const persistedChat1 = persistedAfterRebind.chatSessions?.find((s) => s.id === chat1Id);
      expect(persistedChat1?.backendSessionIds?.agy).toBe(lastPrompt?.sessionId);

      // 6. Deleting a non-active chat session removes only that session
      await ctrl2.deleteChatSession(chat2Id);
      expect(ctrl2.getSnapshot().chatSessions).toHaveLength(1);
      expect(ctrl2.getSnapshot().activeChatSessionId).toBe(chat1Id);

      // Deleting the last remaining active session leaves a clean empty session
      await ctrl2.deleteChatSession(chat1Id);
      expect(ctrl2.getSnapshot().chatSessions).toHaveLength(1);
      expect(ctrl2.getSnapshot().messages).toHaveLength(0);
      expect(ctrl2.getSnapshot().activeChatSessionId).not.toBe(chat1Id);

      await ctrl2.shutdown();
    } finally {
      await mcp.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
