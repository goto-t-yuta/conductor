import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserManager } from "../src/main/browser-manager.js";
import type { CodexAppServerClient } from "../src/main/codex-client.js";
import { ConductorController } from "../src/main/conductor-controller.js";
import {
  DataDirectoryLock,
  formatDataDirectoryLockConflictMessage,
  resolveConductorUserDataPath,
} from "../src/main/instance-lock.js";
import { buildRemoteSnapshot, RemoteBridgeServer } from "../src/main/remote-server.js";
import { mergePersistedStates, StateStore } from "../src/main/state-store.js";
import type { AgentTask, AppSnapshot, ChatMessage, ChatSession } from "../src/shared/types.js";

const tempDirs: string[] = [];
const activeServers: RemoteBridgeServer[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (activeServers.length > 0) {
    const srv = activeServers.pop()!;
    await srv.stop();
  }
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

class MinimalCodexClient {
  public onNotification(): void {}
  public onDisconnect(): void {}
  public async startThread(): Promise<string> {
    return "thread-1";
  }
  public async resumeThread(opts: { threadId: string }): Promise<string> {
    return opts.threadId;
  }
  public async startTurn(): Promise<string> {
    return "turn-1";
  }
  public async interruptTurn(): Promise<void> {}
  public stop(): void {}
}

function makeTask(overrides: Partial<AgentTask> & { id: string; taskNumber: number; title: string }): AgentTask {
  return {
    summary: "",
    projectId: "proj-1",
    projectName: "conductor",
    projectPath: "/tmp/conductor",
    status: "done",
    currentStep: null,
    workerThreadId: null,
    activeTurnId: null,
    previewURL: null,
    latestOutput: "",
    activities: [],
    createdAt: "2026-11-27T08:00:00.000Z",
    updatedAt: "2026-11-27T08:07:00.000Z",
    ...overrides,
  };
}

function makeMessage(
  overrides: Partial<ChatMessage> & { id: string; role: ChatMessage["role"]; text: string },
): ChatMessage {
  return {
    attachments: [],
    toolChips: [],
    isStreaming: false,
    createdAt: "2026-11-27T08:07:00.000Z",
    ...overrides,
  };
}

function wireController(store: StateStore): ConductorController {
  const ctrl = new ConductorController({
    store,
    browser: createFakeBrowserManager(),
    onSnapshot: () => {},
    orchestratorClient: new MinimalCodexClient() as unknown as CodexAppServerClient,
  });
  const internal = ctrl as unknown as {
    isConnected: boolean;
    providers: AppSnapshot["providers"];
    chatProvider: "codex";
  };
  internal.isConnected = true;
  internal.chatProvider = "codex";
  internal.providers.codex.available = true;
  return ctrl;
}

describe("Single-instance & dev/prod userData isolation (instance-lock)", () => {
  it("isolates dev userData into Conductor-Dev while keeping packaged prod in Conductor", () => {
    const appDataDir = "/Users/tester/Library/Application Support";

    expect(
      resolveConductorUserDataPath({
        appDataDir,
        isPackaged: true,
        env: {},
      }),
    ).toEqual({
      userDataDir: path.join(appDataDir, "Conductor"),
      mode: "prod",
    });

    expect(
      resolveConductorUserDataPath({
        appDataDir,
        isPackaged: false,
        env: {},
      }),
    ).toEqual({
      userDataDir: path.join(appDataDir, "Conductor-Dev"),
      mode: "dev",
    });

    expect(
      resolveConductorUserDataPath({
        appDataDir,
        isPackaged: true,
        env: { CONDUCTOR_DEV_SERVER_URL: "http://127.0.0.1:5179" },
      }),
    ).toEqual({
      userDataDir: path.join(appDataDir, "Conductor-Dev"),
      mode: "dev",
    });

    expect(
      resolveConductorUserDataPath({
        appDataDir,
        isPackaged: false,
        env: { CONDUCTOR_USE_PROD_USER_DATA: "1" },
      }),
    ).toEqual({
      userDataDir: path.join(appDataDir, "Conductor"),
      mode: "prod",
    });

    expect(
      resolveConductorUserDataPath({
        appDataDir,
        isPackaged: false,
        env: { CONDUCTOR_USER_DATA_DIR: "/tmp/custom-conductor-dir" },
      }),
    ).toEqual({
      userDataDir: path.resolve("/tmp/custom-conductor-dir"),
      mode: "custom",
    });
  });

  it("blocks concurrent acquisition by a second live PID and reclaims stale locks from dead PIDs", () => {
    const dataDir = makeTempDir("conductor-lock-");
    const alivePids = new Set<number>([64608, 70001]);

    const lockA = new DataDirectoryLock(dataDir, {
      pid: 64608,
      instanceId: "inst-prod",
      isPackaged: true,
      execPath: "/Applications/Conductor.app/Contents/MacOS/Conductor",
      mode: "prod",
      isProcessAlive: (pid) => alivePids.has(pid),
    });

    const resA = lockA.acquire();
    expect(resA.ok).toBe(true);
    expect(fs.existsSync(lockA.lockPath)).toBe(true);

    // Second live process targeting the same data directory MUST be rejected
    const lockB = new DataDirectoryLock(dataDir, {
      pid: 70001,
      instanceId: "inst-dev",
      isPackaged: false,
      execPath: "/path/to/electron",
      mode: "dev",
      isProcessAlive: (pid) => alivePids.has(pid),
    });

    const resB = lockB.acquire();
    expect(resB.ok).toBe(false);
    if (!resB.ok) {
      expect(resB.existingOwner?.pid).toBe(64608);
      const msg = formatDataDirectoryLockConflictMessage(dataDir, resB.existingOwner);
      expect(msg).toContain("PID 64608");
      expect(msg).toContain("state.json");
    }

    // Releasing an unacquired lock must NOT remove lockA's file
    lockB.release();
    expect(lockA.readOwner()?.instanceId).toBe("inst-prod");

    // Simulate process 64608 crashing (PID no longer alive) without releasing lock
    alivePids.delete(64608);
    const resBRetry = lockB.acquire();
    expect(resBRetry.ok).toBe(true);
    if (resBRetry.ok) {
      expect(resBRetry.reclaimedStale).toBe(true);
    }
    expect(lockB.readOwner()?.pid).toBe(70001);

    // Clean release removes the lock file
    lockB.release();
    expect(fs.existsSync(lockB.lockPath)).toBe(false);
  });

  it("wires app.requestSingleInstanceLock(), second-instance, and DataDirectoryLock in src/main/index.ts", () => {
    const mainEntry = fs.readFileSync(
      path.resolve(process.cwd(), "src/main/index.ts"),
      "utf8",
    );
    expect(mainEntry).toContain("resolveConductorUserDataPath");
    expect(mainEntry).toContain('app.setPath("userData"');
    expect(mainEntry).toContain("app.requestSingleInstanceLock()");
    expect(mainEntry).toContain('app.on("second-instance"');
    expect(mainEntry).toContain("new DataDirectoryLock(");
    expect(mainEntry).toContain("dataDirectoryLock?.release()");
  });
});

describe("StateStore conflict detection & non-destructive merge (no stale rollback)", () => {
  it("prevents a stale in-memory process (17:07 T119) from overwriting newer disk tasks (22:26-23:11 T120-T122) and sessions", () => {
    const dataDir = makeTempDir("conductor-stale-overwrite-");

    // 1. Seed initial 17:07 state (up to T119, Session A)
    const seedStore = new StateStore(dataDir, { writerId: "seed" });
    const baseState = seedStore.load();
    const t119 = makeTask({
      id: "task-119",
      taskNumber: 119,
      title: "T119 既存タスク",
      createdAt: "2026-11-27T08:00:00.000Z",
      updatedAt: "2026-11-27T08:07:00.000Z",
    });
    const sessionA: ChatSession = {
      id: "sess-1707",
      title: "17:07 チャット",
      preview: "元の会話",
      messages: [
        makeMessage({
          id: "m-1707-u",
          role: "user",
          text: "元の会話",
          createdAt: "2026-11-27T08:05:00.000Z",
        }),
      ],
      createdAt: "2026-11-27T08:05:00.000Z",
      updatedAt: "2026-11-27T08:07:00.000Z",
      provider: "codex",
      backendSessionIds: {},
    };
    seedStore.save({
      ...baseState,
      tasks: [t119],
      nextTaskNumber: 120,
      chatSessions: [sessionA],
      activeChatSessionId: sessionA.id,
      messages: sessionA.messages,
    });

    // 2. Old process A loads state at 17:07
    const storeA = new StateStore(dataDir, { writerId: "old-proc-64608" });
    const stateA = storeA.load();
    expect(stateA.tasks).toHaveLength(1);
    expect(stateA.tasks[0]!.taskNumber).toBe(119);

    // 3. Newer process B runs at 22:26-23:11 and saves acme-web / conductor / pulse-api tasks + new Session B
    const storeB = new StateStore(dataDir, { writerId: "new-proc-2226" });
    const stateB = storeB.load();
    const t120 = makeTask({
      id: "task-120",
      taskNumber: 120,
      title: "acme-web task",
      projectName: "acme-web",
      createdAt: "2026-11-27T13:26:00.000Z",
      updatedAt: "2026-11-27T13:35:00.000Z",
    });
    const t121 = makeTask({
      id: "task-121",
      taskNumber: 121,
      title: "conductor task",
      projectName: "conductor",
      createdAt: "2026-11-27T13:45:00.000Z",
      updatedAt: "2026-11-27T13:55:00.000Z",
    });
    const t122 = makeTask({
      id: "task-122",
      taskNumber: 122,
      title: "pulse-api task",
      projectName: "pulse-api",
      createdAt: "2026-11-27T14:00:00.000Z",
      updatedAt: "2026-11-27T14:11:00.000Z",
    });
    const sessionB: ChatSession = {
      id: "sess-2311",
      title: "23:11 の最新チャット",
      preview: "最新タスクを実行しました",
      messages: [
        makeMessage({
          id: "m-2311-u",
          role: "user",
          text: "pulse-api を進めて",
          createdAt: "2026-11-27T14:05:00.000Z",
        }),
        makeMessage({
          id: "m-2311-a",
          role: "assistant",
          text: "最新タスクを実行しました",
          createdAt: "2026-11-27T14:11:00.000Z",
        }),
      ],
      createdAt: "2026-11-27T14:05:00.000Z",
      updatedAt: "2026-11-27T14:11:00.000Z",
      provider: "agy",
      backendSessionIds: { agy: "agy-2311" },
    };

    const saveB = storeB.save({
      ...stateB,
      tasks: [t122, t121, t120, t119],
      nextTaskNumber: 123,
      chatSessions: [sessionB, sessionA],
      activeChatSessionId: sessionB.id,
      messages: sessionB.messages,
    });
    expect(saveB.ok).toBe(true);
    expect(saveB.mergedExternalChanges).toBe(false);

    // 4. Stale process A attempts to save its old in-memory state (only T119 + Session A)
    const saveA = storeA.save({
      ...stateA,
      showBrowserPane: false,
    });
    expect(saveA.ok).toBe(true);
    expect(saveA.mergedExternalChanges).toBe(true);
    expect(saveA.revision).toBeGreaterThan(saveB.revision);

    // 5. Disk MUST retain ALL tasks (T119..T122), nextTaskNumber >= 123, AND Session B!
    const reloaded = new StateStore(dataDir).load();
    const taskNumbers = reloaded.tasks.map((t) => t.taskNumber).sort((a, b) => a - b);
    expect(taskNumbers).toEqual([119, 120, 121, 122]);
    expect(reloaded.nextTaskNumber).toBeGreaterThanOrEqual(123);
    expect(reloaded.chatSessions?.map((s) => s.id)).toContain("sess-2311");
    expect(reloaded.chatSessions?.map((s) => s.id)).toContain("sess-1707");
    // Because stale process A did not send a newer chat message, newer Session B stays active
    expect(reloaded.activeChatSessionId).toBe("sess-2311");
  });

  it("allows intentional deletions in the same process without resurrecting deleted tasks or sessions", () => {
    const dataDir = makeTempDir("conductor-single-delete-");
    const store = new StateStore(dataDir, { writerId: "single-proc" });
    const initial = store.load();
    const t1 = makeTask({ id: "t1", taskNumber: 1, title: "Keep" });
    const t2 = makeTask({ id: "t2", taskNumber: 2, title: "Delete Me" });

    store.save({ ...initial, tasks: [t1, t2], nextTaskNumber: 3 });

    // Same store deletes t2 intentionally (no external write occurred)
    const saveAfterDelete = store.save({ ...initial, tasks: [t1], nextTaskNumber: 3 });
    expect(saveAfterDelete.ok).toBe(true);
    expect(saveAfterDelete.mergedExternalChanges).toBe(false);

    const reloaded = new StateStore(dataDir).load();
    expect(reloaded.tasks.map((t) => t.id)).toEqual(["t1"]);
  });

  it("merges messages within the same session preferring finalized text over streaming partials", () => {
    const baseStore = new StateStore(makeTempDir("conductor-merge-msg-"));
    const def = baseStore.load();
    const diskSession: ChatSession = {
      id: "sess-shared",
      title: "Shared",
      preview: "Final answer",
      messages: [
        makeMessage({ id: "u1", role: "user", text: "Question", createdAt: "2026-11-27T10:00:00.000Z" }),
        makeMessage({
          id: "a1",
          role: "assistant",
          text: "Complete finalized answer",
          isStreaming: false,
          createdAt: "2026-11-27T10:00:05.000Z",
        }),
      ],
      createdAt: "2026-11-27T10:00:00.000Z",
      updatedAt: "2026-11-27T10:00:05.000Z",
    };
    const incomingSession: ChatSession = {
      id: "sess-shared",
      title: "Shared",
      preview: "Partial...",
      messages: [
        makeMessage({ id: "u1", role: "user", text: "Question", createdAt: "2026-11-27T10:00:00.000Z" }),
        makeMessage({
          id: "a1",
          role: "assistant",
          text: "Partial",
          isStreaming: true,
          createdAt: "2026-11-27T10:00:05.000Z",
        }),
        makeMessage({ id: "u2", role: "user", text: "Follow-up", createdAt: "2026-11-27T10:01:00.000Z" }),
      ],
      createdAt: "2026-11-27T10:00:00.000Z",
      updatedAt: "2026-11-27T10:01:00.000Z",
    };

    const merged = mergePersistedStates(
      { ...def, chatSessions: [diskSession], activeChatSessionId: "sess-shared", messages: diskSession.messages },
      { ...def, chatSessions: [incomingSession], activeChatSessionId: "sess-shared", messages: incomingSession.messages },
      { preferDiskScalars: true },
    );

    const sess = merged.chatSessions!.find((s) => s.id === "sess-shared")!;
    expect(sess.messages.map((m) => m.id)).toEqual(["u1", "a1", "u2"]);
    expect(sess.messages[1]!.text).toBe("Complete finalized answer");
    expect(sess.messages[1]!.isStreaming).toBe(false);
  });
});

describe("RemoteBridgeServer & ConductorController stale chatSessionId consistency", () => {
  it("rejects stale/non-existent chatSessionId on /api/chat/session and /api/chat/send with latest snapshot without corrupting state", async () => {
    const dataDir = makeTempDir("conductor-remote-session-sync-");
    const token = "secret-sync-token-1234567890";

    // Seed Process A with Session A (17:07) and T119
    const storeA = new StateStore(dataDir, { writerId: "proc-A" });
    const seed = storeA.load();
    const sessionA: ChatSession = {
      id: "sess-old-1707",
      title: "17:07 session",
      preview: "old msg",
      messages: [makeMessage({ id: "m-old", role: "user", text: "old msg", createdAt: "2026-11-27T08:05:00.000Z" })],
      createdAt: "2026-11-27T08:05:00.000Z",
      updatedAt: "2026-11-27T08:07:00.000Z",
    };
    const t119 = makeTask({ id: "t119", taskNumber: 119, title: "Old T119" });
    storeA.save({
      ...seed,
      tasks: [t119],
      nextTaskNumber: 120,
      chatSessions: [sessionA],
      activeChatSessionId: sessionA.id,
      messages: sessionA.messages,
    });

    const controllerA = wireController(storeA);
    const server = new RemoteBridgeServer(controllerA, { port: 0, token });
    await server.start();
    activeServers.push(server);
    const baseUrl = `http://127.0.0.1:${server.getPort()}`;

    // Meanwhile, external Process B updates state.json with T120 + new Session B!
    const storeB = new StateStore(dataDir, { writerId: "proc-B" });
    const stateB = storeB.load();
    const t120 = makeTask({
      id: "t120",
      taskNumber: 120,
      title: "New T120 acme-web",
      projectName: "acme-web",
      createdAt: "2026-11-27T13:30:00.000Z",
      updatedAt: "2026-11-27T13:40:00.000Z",
    });
    const sessionB: ChatSession = {
      id: "sess-new-2311",
      title: "23:11 session",
      preview: "latest msg",
      messages: [makeMessage({ id: "m-new", role: "user", text: "latest msg", createdAt: "2026-11-27T14:11:00.000Z" })],
      createdAt: "2026-11-27T14:00:00.000Z",
      updatedAt: "2026-11-27T14:11:00.000Z",
    };
    storeB.save({
      ...stateB,
      tasks: [t120, t119],
      nextTaskNumber: 121,
      chatSessions: [sessionB, sessionA],
      activeChatSessionId: sessionB.id,
      messages: sessionB.messages,
    });

    // 1. Mobile tries to send a message referencing cached old session `sess-old-1707`
    // Server MUST sync from disk first, see `sess-new-2311` is active, reject with 409 + latest snapshot,
    // and NOT overwrite state.json or drop T120!
    const sendMismatchRes = await fetch(`${baseUrl}/api/chat/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: "モバイルから古いセッションへ送信",
        chatSessionId: "sess-old-1707",
        attachments: [],
      }),
    });
    expect(sendMismatchRes.status).toBe(409);
    const mismatchBody = (await sendMismatchRes.json()) as {
      ok: boolean;
      reason: string;
      activeChatSessionId: string;
      snapshot: { activeChatSessionId: string; tasks: Array<{ taskNumber: number }>; chatSessions: Array<{ id: string }> };
    };
    expect(mismatchBody.ok).toBe(false);
    expect(mismatchBody.reason).toBe("session_mismatch");
    expect(mismatchBody.activeChatSessionId).toBe("sess-new-2311");
    expect(mismatchBody.snapshot.tasks.map((t) => t.taskNumber).sort((a, b) => a - b)).toEqual([119, 120]);
    expect(mismatchBody.snapshot.chatSessions.map((s) => s.id)).toContain("sess-new-2311");

    // Verify disk state still intact and no stray message was appended
    const diskAfterMismatch = new StateStore(dataDir).load();
    expect(diskAfterMismatch.tasks.map((t) => t.taskNumber).sort((a, b) => a - b)).toEqual([119, 120]);
    expect(diskAfterMismatch.activeChatSessionId).toBe("sess-new-2311");
    expect(diskAfterMismatch.messages.some((m) => m.text.includes("モバイルから古いセッション"))).toBe(false);

    // 2. Mobile tries to open a non-existent / deleted session via POST /api/chat/session
    const missingSessionRes = await fetch(`${baseUrl}/api/chat/session`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionId: "sess-deleted-999" }),
    });
    expect(missingSessionRes.status).toBe(404);
    const missingBody = (await missingSessionRes.json()) as {
      ok: boolean;
      reason: string;
      activeChatSessionId: string;
      snapshot: { activeChatSessionId: string; chatSessions: Array<{ id: string }> };
    };
    expect(missingBody.ok).toBe(false);
    expect(missingBody.reason).toBe("session_not_found");
    expect(missingBody.activeChatSessionId).toBe("sess-new-2311");
    expect(missingBody.snapshot.activeChatSessionId).toBe("sess-new-2311");

    // 3. Mobile tries to send to a non-existent session -> 409 session_not_found with latest snapshot
    const sendMissingRes = await fetch(`${baseUrl}/api/chat/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: "消えたセッションへ送信",
        chatSessionId: "sess-deleted-999",
        attachments: [],
      }),
    });
    expect(sendMissingRes.status).toBe(409);
    const sendMissingBody = (await sendMissingRes.json()) as { ok: boolean; reason: string };
    expect(sendMissingBody.ok).toBe(false);
    expect(sendMissingBody.reason).toBe("session_not_found");

    // 4. Mobile switches explicitly to valid existing `sess-old-1707` -> 200 OK
    const validSwitchRes = await fetch(`${baseUrl}/api/chat/session`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionId: "sess-old-1707" }),
    });
    expect(validSwitchRes.status).toBe(200);
    const validSwitchBody = (await validSwitchRes.json()) as {
      ok: boolean;
      activeChatSessionId: string;
    };
    expect(validSwitchBody.ok).toBe(true);
    expect(validSwitchBody.activeChatSessionId).toBe("sess-old-1707");

    // 5. Mobile sends with matching `chatSessionId` -> 200 OK and T120 is still preserved!
    const validSendRes = await fetch(`${baseUrl}/api/chat/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: "同期後の正常送信",
        chatSessionId: "sess-old-1707",
        attachments: [],
      }),
    });
    expect(validSendRes.status).toBe(200);
    const diskFinal = new StateStore(dataDir).load();
    expect(diskFinal.tasks.map((t) => t.taskNumber).sort((a, b) => a - b)).toEqual([119, 120]);
    expect(diskFinal.messages.some((m) => m.text === "同期後の正常送信")).toBe(true);

    await controllerA.shutdown();
  });

  it("includes all active/retained chatSessions (beyond 20) in buildRemoteSnapshot", () => {
    const sessions = Array.from({ length: 30 }, (_, i) => ({
      id: `sess-${i}`,
      title: `Session ${i}`,
      preview: `Preview ${i}`,
      messageCount: 1,
      createdAt: "2026-11-27T00:00:00.000Z",
      updatedAt: "2026-11-27T00:00:00.000Z",
    }));
    const projected = buildRemoteSnapshot({
      projects: [],
      scanRoots: [],
      tasks: [],
      messages: [],
      activeChatSessionId: "sess-29",
      chatSessions: sessions,
      browserTabs: [],
      activeBrowserTabId: null,
      isPickingElement: false,
      showTaskSidebar: true,
      showBrowserPane: true,
      isConnected: true,
      connectionStatus: "ok",
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
    });
    const remoteSessions = projected.chatSessions as Array<{ id: string }>;
    expect(remoteSessions).toHaveLength(30);
    expect(remoteSessions.some((s) => s.id === "sess-29")).toBe(true);
  });
});
