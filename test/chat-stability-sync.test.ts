import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseAgySessionUpdate } from "../src/main/agy-acp-client.js";
import type { BrowserManager } from "../src/main/browser-manager.js";
import type { CodexAppServerClient, CodexNotification } from "../src/main/codex-client.js";
import { ConductorController } from "../src/main/conductor-controller.js";
import { buildRemoteSnapshot, RemoteBridgeServer } from "../src/main/remote-server.js";
import { StateStore } from "../src/main/state-store.js";
import { reconcileAppSnapshot } from "../src/renderer/lib/snapshot-reconcile.js";
import {
  MAX_CHAT_SESSIONS,
  MAX_MESSAGES_PER_SESSION,
  capChatSessionsPreservingActive,
  normalizeChatSessions,
} from "../src/shared/chat-sessions.js";
import type { AppSnapshot, ChatMessage, ChatSession } from "../src/shared/types.js";

function createFakeBrowserManager(): BrowserManager {
  return {
    getTabs: () => [],
    getActiveTabId: () => null,
    getActiveTab: () => null,
    isPickingElement: () => false,
    restore: () => {},
  } as unknown as BrowserManager;
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

function makeSnapshot(overrides: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    snapshotEpoch: "epoch-1",
    snapshotVersion: 1,
    projects: [],
    scanRoots: [],
    tasks: [],
    messages: [],
    activeChatSessionId: "sess-1",
    chatSessions: [],
    browserTabs: [],
    activeBrowserTabId: null,
    isPickingElement: false,
    showTaskSidebar: true,
    showBrowserPane: true,
    isConnected: true,
    connectionStatus: "接続済み",
    activeResponderCount: 0,
    providers: {
      codex: { id: "codex", label: "Codex", available: true, detail: "ok", models: [] },
      agy: { id: "agy", label: "AGY", available: false, detail: "off", models: [] },
      claude: { id: "claude", label: "Claude", available: false, detail: "off", models: [] },
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
    ...overrides,
  };
}

class FakeCodexOrchestratorClient {
  private notificationListeners: Array<(n: CodexNotification) => void> = [];
  private disconnectListeners: Array<(reason: string) => void> = [];
  private threadSeq = 0;
  private turnSeq = 0;
  public readonly startedThreads: string[] = [];
  public readonly startedTurns: Array<{ threadId: string; turnId: string; text: string }> = [];
  public readonly interruptedTurns: Array<{ threadId: string; turnId: string }> = [];

  public onNotification(cb: (n: CodexNotification) => void): void {
    this.notificationListeners.push(cb);
  }

  public onDisconnect(cb: (reason: string) => void): void {
    this.disconnectListeners.push(cb);
  }

  public emitNotification(n: CodexNotification): void {
    for (const cb of this.notificationListeners) cb(n);
  }

  public emitDisconnect(reason: string): void {
    for (const cb of this.disconnectListeners) cb(reason);
  }

  public async startThread(): Promise<string> {
    this.threadSeq += 1;
    const tid = `codex-thread-${this.threadSeq}`;
    this.startedThreads.push(tid);
    return tid;
  }

  public async resumeThread(opts: { threadId: string }): Promise<string> {
    return opts.threadId;
  }

  public async startTurn(opts: { threadId: string; text: string }): Promise<string> {
    this.turnSeq += 1;
    const turnId = `codex-turn-${this.turnSeq}`;
    this.startedTurns.push({ threadId: opts.threadId, turnId, text: opts.text });
    return turnId;
  }

  public async interruptTurn(threadId: string, turnId: string): Promise<void> {
    this.interruptedTurns.push({ threadId, turnId });
  }

  public stop(): void {
    // no-op
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Timed out waiting for condition");
}

function wireConnectedCodexController(
  store: StateStore,
  fakeCodex: FakeCodexOrchestratorClient,
  onSnapshot: (s: AppSnapshot) => void = () => {},
): ConductorController {
  const controller = new ConductorController({
    store,
    browser: createFakeBrowserManager(),
    onSnapshot,
    orchestratorClient: fakeCodex as unknown as CodexAppServerClient,
  });
  const internal = controller as unknown as {
    isConnected: boolean;
    providers: AppSnapshot["providers"];
    chatProvider: "codex";
  };
  internal.isConnected = true;
  internal.chatProvider = "codex";
  internal.providers.codex.available = true;
  return controller;
}

describe("Snapshot reconciliation monotonic version guard", () => {
  it("rejects stale snapshots from the same epoch (e.g. getSnapshot resolving after onSnapshot)", () => {
    const newer = makeSnapshot({
      snapshotEpoch: "epoch-A",
      snapshotVersion: 12,
      messages: [
        makeMessage({ id: "u1", role: "user", text: "何を比較してたんやw" }),
        makeMessage({ id: "a1", role: "assistant", text: "完全にやらかしてましたw" }),
      ],
    });
    const stale = makeSnapshot({
      snapshotEpoch: "epoch-A",
      snapshotVersion: 9,
      messages: [makeMessage({ id: "u1", role: "user", text: "何を比較してたんやw" })],
    });

    const result = reconcileAppSnapshot(newer, stale);
    expect(result).toBe(newer);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]!.text).toBe("完全にやらかしてましたw");
  });

  it("accepts a snapshot from a new controller epoch even if version resets to 1", () => {
    const prev = makeSnapshot({
      snapshotEpoch: "epoch-old",
      snapshotVersion: 99,
      messages: [makeMessage({ id: "u1", role: "user", text: "old" })],
    });
    const restarted = makeSnapshot({
      snapshotEpoch: "epoch-new",
      snapshotVersion: 1,
      messages: [
        makeMessage({ id: "u1", role: "user", text: "old" }),
        makeMessage({ id: "a1", role: "assistant", text: "restored" }),
      ],
    });

    const result = reconcileAppSnapshot(prev, restarted);
    expect(result.snapshotEpoch).toBe("epoch-new");
    expect(result.messages).toHaveLength(2);
  });

  it("deduplicates duplicate message IDs defensively and handles missing toolChips/attachments", () => {
    const prev = makeSnapshot({
      snapshotEpoch: "epoch-A",
      snapshotVersion: 1,
      messages: [makeMessage({ id: "m1", role: "assistant", text: "v1" })],
    });
    const next = makeSnapshot({
      snapshotEpoch: "epoch-A",
      snapshotVersion: 2,
      messages: [
        makeMessage({ id: "m1", role: "assistant", text: "v1-dup" }),
        makeMessage({
          id: "m1",
          role: "assistant",
          text: "v2-final",
          attachments: undefined as unknown as ChatMessage["attachments"],
          toolChips: undefined as unknown as ChatMessage["toolChips"],
        }),
      ],
    });

    const result = reconcileAppSnapshot(prev, next);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.text).toBe("v2-final");
  });
});

describe("Codex orchestrator turn isolation, compaction safety & disconnect persistence", () => {
  it("ignores mismatched turn/completed (e.g. compaction turn) and preserves multi-agentMessage items", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-codex-turn-"));
    try {
      const store = new StateStore(tmpDir);
      const fakeCodex = new FakeCodexOrchestratorClient();
      const controller = wireConnectedCodexController(store, fakeCodex);

      await controller.sendMessage({ text: "何を比較してたんやw", attachments: [] });
      await waitFor(() => fakeCodex.startedTurns.length === 1);

      const { threadId, turnId } = fakeCodex.startedTurns[0]!;

      // First agentMessage chunk arrives via delta
      fakeCodex.emitNotification({
        method: "item/agentMessage/delta",
        threadId,
        turnId,
        itemId: "item-1",
        params: { delta: "完全にやらかしてましたw" },
      });

      // Simulate an auxiliary/compaction turn finishing on the SAME threadId with a different turnId
      fakeCodex.emitNotification({
        method: "turn/started",
        threadId,
        turnId: "compaction-turn-999",
        itemId: null,
        params: {},
      });
      fakeCodex.emitNotification({
        method: "turn/completed",
        threadId,
        turnId: "compaction-turn-999",
        itemId: null,
        params: {},
      });

      // Active turn must still be streaming and accept post-compaction chunks!
      let snap = controller.getSnapshot();
      const assistantMsg = snap.messages.find((m) => m.role === "assistant")!;
      expect(assistantMsg.isStreaming).toBe(true);
      expect(assistantMsg.text).toBe("完全にやらかしてましたw");

      // Second agentMessage arrives via item/completed only (without deltas) after compaction
      fakeCodex.emitNotification({
        method: "item/completed",
        threadId,
        turnId,
        itemId: "item-2",
        params: {
          item: {
            id: "item-2",
            type: "agentMessage",
            text: "比較対象を取り違えていました。正しくは別ファイルでした。",
          },
        },
      });

      // Completing item-1 (already streamed) must not duplicate item-1 text
      fakeCodex.emitNotification({
        method: "item/completed",
        threadId,
        turnId,
        itemId: "item-1",
        params: {
          item: {
            id: "item-1",
            type: "agentMessage",
            text: "完全にやらかしてましたw",
          },
        },
      });

      // Finally real turn completes
      fakeCodex.emitNotification({
        method: "turn/completed",
        threadId,
        turnId,
        itemId: null,
        params: {},
      });

      snap = controller.getSnapshot();
      const finalAssistant = snap.messages.find((m) => m.role === "assistant")!;
      expect(finalAssistant.isStreaming).toBe(false);
      expect(finalAssistant.text).toBe(
        "完全にやらかしてましたw\n\n比較対象を取り違えていました。正しくは別ファイルでした。",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("discards interrupted Codex lane on stopMessage so a late turn/completed never kills the next reply", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-codex-stop-"));
    try {
      const store = new StateStore(tmpDir);
      const fakeCodex = new FakeCodexOrchestratorClient();
      const controller = wireConnectedCodexController(store, fakeCodex);

      await controller.sendMessage({ text: "最初の質問", attachments: [] });
      await waitFor(() => fakeCodex.startedTurns.length === 1);
      const firstTurn = fakeCodex.startedTurns[0]!;
      const firstAssistantId = controller.getSnapshot().messages.find((m) => m.role === "assistant")!.id;

      // Stop first message, then immediately send second message
      await controller.stopMessage(firstAssistantId);
      await controller.sendMessage({ text: "2つ目の質問", attachments: [] });
      await waitFor(() => fakeCodex.startedTurns.length === 2);
      const secondTurn = fakeCodex.startedTurns[1]!;

      // Late turn/completed from the interrupted first turn arrives now
      fakeCodex.emitNotification({
        method: "turn/completed",
        threadId: firstTurn.threadId,
        turnId: firstTurn.turnId,
        itemId: null,
        params: {},
      });

      // Second reply continues streaming uninterrupted
      fakeCodex.emitNotification({
        method: "item/agentMessage/delta",
        threadId: secondTurn.threadId,
        turnId: secondTurn.turnId,
        itemId: "item-second",
        params: { delta: "2つ目の回答です" },
      });
      fakeCodex.emitNotification({
        method: "turn/completed",
        threadId: secondTurn.threadId,
        turnId: secondTurn.turnId,
        itemId: null,
        params: {},
      });

      const assistants = controller.getSnapshot().messages.filter((m) => m.role === "assistant");
      expect(assistants).toHaveLength(2);
      expect(assistants[0]!.text).toBe("停止しました。");
      expect(assistants[1]!.isStreaming).toBe(false);
      expect(assistants[1]!.text).toBe("2つ目の回答です");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("finalizes and persists streamed text when Codex orchestrator disconnects mid-turn", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-codex-disconnect-"));
    try {
      const store = new StateStore(tmpDir);
      const fakeCodex = new FakeCodexOrchestratorClient();
      const controller = wireConnectedCodexController(store, fakeCodex);

      await controller.sendMessage({ text: "テスト送信", attachments: [] });
      await waitFor(() => fakeCodex.startedTurns.length === 1);
      const { threadId, turnId } = fakeCodex.startedTurns[0]!;

      fakeCodex.emitNotification({
        method: "item/agentMessage/delta",
        threadId,
        turnId,
        itemId: "item-partial",
        params: { delta: "途中まで受信した返信" },
      });

      fakeCodex.emitDisconnect("process crashed");

      const snap = controller.getSnapshot();
      const assistant = snap.messages.find((m) => m.role === "assistant")!;
      expect(assistant.isStreaming).toBe(false);
      expect(assistant.text).toBe("途中まで受信した返信");

      // Reload from disk to confirm it was persisted
      const reloaded = store.load();
      const persistedAssistant = reloaded.messages.find((m) => m.role === "assistant")!;
      expect(persistedAssistant.text).toBe("途中まで受信した返信");
      expect(persistedAssistant.isStreaming).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("prevents duplicate threadId lanes when prewarmIdleLane races with sendMessage", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-codex-prewarm-race-"));
    try {
      const store = new StateStore(tmpDir);
      const fakeCodex = new FakeCodexOrchestratorClient();
      const controller = wireConnectedCodexController(store, fakeCodex);

      // First turn establishes saved codex backendSessionId
      await controller.sendMessage({ text: "1通目", attachments: [] });
      await waitFor(() => fakeCodex.startedTurns.length === 1);
      const first = fakeCodex.startedTurns[0]!;
      fakeCodex.emitNotification({
        method: "item/agentMessage/delta",
        threadId: first.threadId,
        turnId: first.turnId,
        itemId: "i1",
        params: { delta: "回答1" },
      });
      fakeCodex.emitNotification({
        method: "turn/completed",
        threadId: first.threadId,
        turnId: first.turnId,
        itemId: null,
        params: {},
      });

      // Detach lanes (like switching back to this session), then race prewarm + sendMessage
      const internal = controller as unknown as {
        detachOrchestratorLanes: () => void;
        prewarmIdleLane: () => Promise<void>;
        responderLanes: Array<{ threadId: string }>;
      };
      internal.detachOrchestratorLanes();
      const prewarmP = internal.prewarmIdleLane();
      const sendP = controller.sendMessage({ text: "2通目", attachments: [] });
      await Promise.all([prewarmP, sendP]);
      await waitFor(() => fakeCodex.startedTurns.length === 2);

      // Must never have duplicate threadId entries in responderLanes
      const threadIds = internal.responderLanes.map((l) => l.threadId);
      expect(new Set(threadIds).size).toBe(threadIds.length);

      const second = fakeCodex.startedTurns[1]!;
      fakeCodex.emitNotification({
        method: "item/agentMessage/delta",
        threadId: second.threadId,
        turnId: second.turnId,
        itemId: "i2",
        params: { delta: "回答2が欠けずに表示される" },
      });
      fakeCodex.emitNotification({
        method: "turn/completed",
        threadId: second.threadId,
        turnId: second.turnId,
        itemId: null,
        params: {},
      });

      const assistants = controller.getSnapshot().messages.filter((m) => m.role === "assistant");
      expect(assistants[1]!.isStreaming).toBe(false);
      expect(assistants[1]!.text).toBe("回答2が欠けずに表示される");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Session retention, active-session preservation & StateStore backup recovery", () => {
  it("retains more than 250 messages in a long session without truncating history", () => {
    expect(MAX_MESSAGES_PER_SESSION).toBeGreaterThanOrEqual(1000);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-long-chat-"));
    try {
      const store = new StateStore(tmpDir);
      const longMessages: ChatMessage[] = Array.from({ length: 400 }, (_, i) =>
        makeMessage({
          id: `msg-${i}`,
          role: i % 2 === 0 ? "user" : "assistant",
          text: `message-${i}`,
          createdAt: new Date(Date.UTC(2026, 10, 27, 0, i)).toISOString(),
        }),
      );
      const normalized = normalizeChatSessions({
        legacyMessages: longMessages,
        chatProvider: "codex",
      });
      expect(normalized.chatSessions[0]!.messages).toHaveLength(400);
      expect(normalized.chatSessions[0]!.messages[0]!.text).toBe("message-0");
      expect(normalized.chatSessions[0]!.messages[399]!.text).toBe("message-399");

      const base = store.load();
      store.save({
        ...base,
        messages: longMessages,
        chatSessions: normalized.chatSessions,
        activeChatSessionId: normalized.activeChatSessionId,
      });

      const reloaded = store.load();
      expect(reloaded.messages).toHaveLength(400);
      expect(reloaded.messages[0]!.id).toBe("msg-0");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("never evicts the active session when total sessions exceed MAX_CHAT_SESSIONS", () => {
    const sessions: ChatSession[] = Array.from({ length: MAX_CHAT_SESSIONS + 5 }, (_, i) => ({
      id: `sess-${i}`,
      title: `Session ${i}`,
      preview: `Preview ${i}`,
      messages: [makeMessage({ id: `m-${i}`, role: "user", text: `Hello ${i}` })],
      createdAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
    }));

    // sess-0 is the oldest session, yet currently active
    const capped = capChatSessionsPreservingActive(sessions, "sess-0", MAX_CHAT_SESSIONS);
    expect(capped).toHaveLength(MAX_CHAT_SESSIONS);
    expect(capped.some((s) => s.id === "sess-0")).toBe(true);
  });

  it("recovers chat history from state.json.bak if state.json becomes corrupted", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-state-backup-"));
    try {
      const store = new StateStore(tmpDir);
      const initial = store.load();
      const msg = makeMessage({ id: "keep-1", role: "user", text: "絶対に消えてほしくないメッセージ" });
      const normalized = normalizeChatSessions({ legacyMessages: [msg], chatProvider: "codex" });

      // Save twice so state.json.bak holds the previous valid state
      const stateV1 = {
        ...initial,
        messages: [msg],
        chatSessions: normalized.chatSessions,
        activeChatSessionId: normalized.activeChatSessionId,
      };
      store.save(stateV1);
      store.save(stateV1);
      expect(fs.existsSync(store.backupStateFile)).toBe(true);

      // Corrupt primary state.json
      fs.writeFileSync(store.stateFile, "{ truncated json ...", "utf8");

      const recovered = store.load();
      expect(recovered.messages).toHaveLength(1);
      expect(recovered.messages[0]!.text).toBe("絶対に消えてほしくないメッセージ");

      // Corrupted copy should be preserved on disk for diagnostics
      const files = fs.readdirSync(tmpDir);
      expect(files.some((f) => f.startsWith("state.json.corrupt."))).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent startFreshChat / selectChatSession calls cleanly", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-session-lock-"));
    try {
      const store = new StateStore(tmpDir);
      const fakeCodex = new FakeCodexOrchestratorClient();
      const controller = wireConnectedCodexController(store, fakeCodex);

      await controller.sendMessage({ text: "セッション1のメッセージ", attachments: [] });
      const firstSessionId = controller.getSnapshot().activeChatSessionId;

      // Fire startFreshChat and selectChatSession concurrently
      await Promise.all([
        controller.startFreshChat(),
        controller.selectChatSession(firstSessionId),
      ]);

      const snap = controller.getSnapshot();
      expect(snap.activeChatSessionId).toBe(firstSessionId);
      expect(snap.messages.some((m) => m.text === "セッション1のメッセージ")).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("AGY array content blocks & RemoteBridge snapshot versioning", () => {
  it("parses array-formatted content blocks in parseAgySessionUpdate", () => {
    const parsedMsg = parseAgySessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: [
        { type: "text", text: "完全に" },
        { type: "text", text: "やらかしてましたw" },
      ],
    });
    expect(parsedMsg).toEqual({ kind: "textDelta", text: "完全にやらかしてましたw" });

    const parsedThought = parseAgySessionUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: [{ type: "text", text: "思考ブロック" }],
    });
    expect(parsedThought).toEqual({ kind: "reasoningDelta", text: "思考ブロック" });
  });

  it("propagates snapshotEpoch/snapshotVersion in RemoteBridgeServer and mobile fallback HTML", async () => {
    const snap = makeSnapshot({ snapshotEpoch: "remote-epoch-1", snapshotVersion: 42 });
    const projected = buildRemoteSnapshot(snap);
    expect(projected.snapshotEpoch).toBe("remote-epoch-1");
    expect(projected.snapshotVersion).toBe(42);

    const server = new RemoteBridgeServer(
      {
        getSnapshot: () => snap,
        sendMessage: async () => {},
        stopMessage: async () => {},
        stopAllResponders: async () => {},
        startFreshChat: async () => {},
        selectChatSession: async () => {},
        updateTaskStatus: () => ({ ok: true }),
        stopTaskWorker: async () => {},
        landTask: async () => ({
          ok: true,
          mode: "feature-branch",
          action: "landed",
          message: "ok",
        }),
        getTaskGitStatus: () => null,
        getTaskWorktreeStatus: () => null,
      },
      { port: 0, token: "test-token-1234567890" },
    );
    await server.start();
    try {
      const port = server.getStatus().port;
      const htmlRes = await fetch(`http://127.0.0.1:${port}/`);
      const html = await htmlRes.text();
      expect(html).toContain("next.snapshotVersion < snapshot.snapshotVersion");
    } finally {
      await server.stop();
    }
  });
});
