import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserManager } from "../src/main/browser-manager.js";
import { ConductorController } from "../src/main/conductor-controller.js";
import {
  DEFAULT_REMOTE_ACCESS_PORT,
  RemoteBridgeServer,
  buildConductorConnectUri,
  detectTailscaleIpv4FromInterfaces,
  detectTailscaleNetwork,
  isTailscaleIpv4,
  parseConductorConnectUri,
  type RemoteBridgeController,
} from "../src/main/remote-server.js";
import { StateStore } from "../src/main/state-store.js";
import { buildQrSvgData } from "../src/renderer/components/QrCodeSvg.js";
import { SettingsModal } from "../src/renderer/components/SettingsModal.js";
import {
  ANDROID_APK_DOWNLOAD_URL,
  ANDROID_APK_FILENAME,
  ANDROID_RELEASES_PAGE_URL,
} from "../src/shared/remote-access.js";
import { validateManualTaskStatusTransition } from "../src/shared/task-status.js";
import type {
  AgentTask,
  AgentTaskStatus,
  AppSnapshot,
  LandTaskResult,
  SendMessagePayload,
  TaskWorktreeStatus,
} from "../src/shared/types.js";

const activeServers: RemoteBridgeServer[] = [];
const tempDirs: string[] = [];

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

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  const now = new Date().toISOString();
  return {
    id: "task-1",
    taskNumber: 1,
    title: "Test Task",
    summary: "Summary text",
    projectId: "proj-1",
    projectName: "conductor",
    projectPath: "/tmp/conductor",
    status: "needs_review",
    currentStep: "レビュー待ち",
    workerThreadId: null,
    activeTurnId: null,
    previewURL: null,
    latestOutput: "All tests passed.",
    activities: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeSnapshot(tasks: AgentTask[]): AppSnapshot {
  return {
    projects: [
      {
        id: "proj-1",
        name: "conductor",
        path: "/tmp/conductor",
        colorHex: "#3B82F6",
        gitBranch: "main",
        addedAt: new Date().toISOString(),
      },
    ],
    scanRoots: [],
    tasks,
    messages: [],
    activeChatSessionId: "session-1",
    chatSessions: [],
    browserTabs: [],
    activeBrowserTabId: null,
    isPickingElement: false,
    showTaskSidebar: true,
    showBrowserPane: true,
    isConnected: true,
    connectionStatus: "Codex 利用可能",
    activeResponderCount: 0,
    providers: {
      codex: { id: "codex", label: "Codex", available: true, detail: "ok", models: [] },
      agy: { id: "agy", label: "AGY", available: false, detail: "off", models: [] },
      claude: { id: "claude", label: "Claude", available: false, detail: "off", models: [] },
    },
    chatProvider: "codex",
    workerProvider: "codex",
    models: [],
    chatModel: "gpt-5.4",
    chatEffort: "low",
    workerModel: "gpt-5.4",
    workerEffort: "medium",
    defaultIntegrationMode: "feature-branch",
    autoLandOnComplete: true,
    preferredLanguage: "ja",
    lastErrorBanner: null,
  };
}

function createMockBridgeController(initialTasks: AgentTask[] = []) {
  let tasks = [...initialTasks];
  const calls = {
    sendMessage: [] as SendMessagePayload[],
    stopMessage: [] as string[],
    stopAllResponders: 0,
    startFreshChat: 0,
    stopTaskWorker: [] as string[],
    landTask: [] as Array<{ taskId: string; createPr?: boolean }>,
  };

  let nextLandResult: LandTaskResult = {
    ok: true,
    mode: "feature-branch",
    action: "landed",
    targetBranch: "main",
    message: "Landed cleanly",
  };

  const controller: RemoteBridgeController = {
    getSnapshot: () => makeSnapshot(tasks),
    sendMessage: async (payload) => {
      calls.sendMessage.push(payload);
    },
    stopMessage: async (messageId) => {
      calls.stopMessage.push(messageId);
    },
    stopAllResponders: async () => {
      calls.stopAllResponders += 1;
    },
    startFreshChat: async () => {
      calls.startFreshChat += 1;
    },
    updateTaskStatus: (taskId: string, status: AgentTaskStatus) => {
      const task = tasks.find((t) => t.id === taskId);
      if (!task) return { ok: false, error: "Task not found" };
      const check = validateManualTaskStatusTransition({
        currentStatus: task.status,
        nextStatus: status,
        hasActiveWorker: task.status === "running",
        worktreePath: task.worktreePath,
        worktreeBranch: task.worktreeBranch,
        landStatus: task.landStatus,
      });
      if (!check.ok) {
        return { ok: false, error: check.error };
      }
      tasks = tasks.map((t) => (t.id === taskId ? { ...t, status } : t));
      return { ok: true };
    },
    stopTaskWorker: async (taskId: string) => {
      calls.stopTaskWorker.push(taskId);
      tasks = tasks.map((t) => (t.id === taskId ? { ...t, status: "needs_review" } : t));
    },
    landTask: async (taskId: string, options?: { createPr?: boolean }) => {
      calls.landTask.push({ taskId, createPr: options?.createPr });
      if (nextLandResult.ok) {
        tasks = tasks.map((t) =>
          t.id === taskId ? { ...t, landStatus: "landed", worktreePath: null, worktreeBranch: null } : t,
        );
      }
      return nextLandResult;
    },
    getTaskGitStatus: (taskId: string) => (tasks.some((t) => t.id === taskId) ? "M src/app.ts" : null),
    getTaskWorktreeStatus: (taskId: string): TaskWorktreeStatus | null =>
      tasks.some((t) => t.id === taskId)
        ? {
            hasWorktree: true,
            worktreeExists: true,
            worktreePath: "/tmp/wt",
            worktreeBranch: "conductor/t1",
            parentBranch: "main",
            parentDirty: false,
            worktreeDirty: false,
            changedFilesCount: 1,
            aheadCommits: 1,
            diffSummary: "1 file changed",
            effectiveMode: "feature-branch",
            suggestedTargetBranch: "main",
            ghAvailable: true,
          }
        : null,
  };

  return {
    controller,
    calls,
    setLandResult: (res: LandTaskResult) => {
      nextLandResult = res;
    },
  };
}

describe("Tailscale IP detection & connect URI helpers", () => {
  it("recognizes RFC 6598 Tailscale CGNAT IPv4 addresses (100.64.0.0/10)", () => {
    expect(isTailscaleIpv4("100.64.0.1")).toBe(true);
    expect(isTailscaleIpv4("100.100.100.100")).toBe(true);
    expect(isTailscaleIpv4("100.121.247.7")).toBe(true);
    expect(isTailscaleIpv4("100.127.255.254")).toBe(true);

    expect(isTailscaleIpv4("100.63.255.255")).toBe(false);
    expect(isTailscaleIpv4("100.128.0.1")).toBe(false);
    expect(isTailscaleIpv4("192.168.1.10")).toBe(false);
    expect(isTailscaleIpv4("10.0.0.1")).toBe(false);
    expect(isTailscaleIpv4("127.0.0.1")).toBe(false);
    expect(isTailscaleIpv4("not-an-ip")).toBe(false);
    expect(isTailscaleIpv4("100.64.0.999")).toBe(false);
  });

  it("extracts Tailscale IPv4 from network interfaces and falls back to tailscale CLI + MagicDNS", () => {
    const fakeInterfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
      lo0: [
        {
          address: "127.0.0.1",
          netmask: "255.0.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: true,
          cidr: "127.0.0.1/8",
        },
      ],
      en0: [
        {
          address: "192.168.1.42",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "aa:bb:cc:dd:ee:ff",
          internal: false,
          cidr: "192.168.1.42/24",
        },
      ],
      utun4: [
        {
          address: "100.121.247.7",
          netmask: "255.192.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "100.121.247.7/10",
        },
      ],
    };

    expect(detectTailscaleIpv4FromInterfaces(fakeInterfaces)).toBe("100.121.247.7");

    const net = detectTailscaleNetwork({
      interfaces: fakeInterfaces,
      runTailscale: (args) => {
        if (args[0] === "status") {
          return JSON.stringify({
            Self: { DNSName: "macbook-pro.tail1234.ts.net." },
          });
        }
        return null;
      },
    });
    expect(net).toEqual({
      tailscaleIp: "100.121.247.7",
      magicDnsName: "macbook-pro.tail1234.ts.net",
      lanIp: "192.168.1.42",
    });

    // CLI fallback when interfaces do not expose utun yet
    const cliFallback = detectTailscaleNetwork({
      interfaces: { en0: fakeInterfaces.en0 },
      runTailscale: (args) => {
        if (args[0] === "ip") return "100.99.88.77\n";
        if (args[0] === "status") return JSON.stringify({ Self: { DNSName: "studio.ts.net." } });
        return null;
      },
    });
    expect(cliFallback.tailscaleIp).toBe("100.99.88.77");
    expect(cliFallback.magicDnsName).toBe("studio.ts.net");
  });

  it("round-trips conductor://connect, conductor://link, and JSON pairing payloads cleanly", () => {
    const uri = buildConductorConnectUri("http://100.121.247.7:4789", "secret-token-123");
    expect(uri.startsWith("conductor://connect?")).toBe(true);
    expect(parseConductorConnectUri(uri)).toEqual({
      url: "http://100.121.247.7:4789",
      token: "secret-token-123",
    });
    expect(
      parseConductorConnectUri(
        "conductor://link?url=http%3A%2F%2F100.121.247.7%3A4789%2F&token=link-token-999",
      ),
    ).toEqual({
      url: "http://100.121.247.7:4789",
      token: "link-token-999",
    });
    expect(
      parseConductorConnectUri(
        JSON.stringify({ url: "http://100.64.0.9:4789/", token: "json-tok" }),
      ),
    ).toEqual({
      url: "http://100.64.0.9:4789",
      token: "json-tok",
    });
    expect(parseConductorConnectUri("https://example.com")).toBeNull();
    expect(parseConductorConnectUri("conductor://other?url=http://100.64.0.1:4789&token=abc")).toBeNull();
    expect(parseConductorConnectUri("conductor://connect?url=http://100.64.0.1:4789")).toBeNull();
    expect(parseConductorConnectUri("{invalid-json}")).toBeNull();
  });

  it("uses the direct latest Android APK download URL matching release.yml", () => {
    expect(ANDROID_APK_FILENAME).toBe("conductor-android.apk");
    expect(ANDROID_APK_DOWNLOAD_URL).toBe(
      "https://github.com/goto-t-yuta/conductor/releases/latest/download/conductor-android.apk",
    );
    expect(ANDROID_RELEASES_PAGE_URL).toBe(
      "https://github.com/goto-t-yuta/conductor/releases/latest",
    );

    const releaseWorkflow = fs.readFileSync(
      path.resolve(process.cwd(), ".github/workflows/release.yml"),
      "utf8",
    );
    expect(releaseWorkflow).toContain(`release/${ANDROID_APK_FILENAME}`);
  });

  it("generates deterministic offline SVG QR data for APK download and pairing URIs", () => {
    const downloadQr = buildQrSvgData(ANDROID_APK_DOWNLOAD_URL);
    expect(downloadQr).not.toBeNull();
    expect(downloadQr!.moduleCount).toBeGreaterThanOrEqual(21);
    expect(downloadQr!.viewBoxSize).toBe(downloadQr!.moduleCount + 4);
    expect(downloadQr!.pathD.length).toBeGreaterThan(20);

    const pairUri = buildConductorConnectUri("http://100.121.247.7:4789", "abcdef0123456789");
    const pairQr = buildQrSvgData(pairUri);
    expect(pairQr).not.toBeNull();
    expect(pairQr!.pathD).not.toBe(downloadQr!.pathD);

    expect(buildQrSvgData("   ")).toBeNull();
  });
});

describe("RemoteBridgeServer HTTP & SSE API", () => {
  async function startTestServer(tasks: AgentTask[] = []) {
    const mock = createMockBridgeController(tasks);
    const server = new RemoteBridgeServer(mock.controller, {
      host: "127.0.0.1",
      port: 0,
      token: "test-bearer-token-0123456789abcdef",
      detectNetwork: () => ({
        tailscaleIp: "100.121.247.7",
        magicDnsName: "macbook.taile00453.ts.net",
        lanIp: "192.168.1.50",
      }),
    });
    activeServers.push(server);
    const status = await server.start();
    expect(status.running).toBe(true);
    const baseUrl = `http://127.0.0.1:${server.getPort()}`;
    return { server, mock, baseUrl, token: server.getToken() };
  }

  it("serves mobile Web UI fallback at GET / and unauthenticated GET /api/health", async () => {
    const { baseUrl } = await startTestServer();

    const uiRes = await fetch(`${baseUrl}/`);
    expect(uiRes.status).toBe(200);
    expect(uiRes.headers.get("content-type")).toContain("text/html");
    const html = await uiRes.text();
    expect(html).toContain("Conductor Remote");

    const healthRes = await fetch(`${baseUrl}/api/health`);
    expect(healthRes.status).toBe(200);
    const health = (await healthRes.json()) as Record<string, unknown>;
    expect(health.ok).toBe(true);
    expect(health.service).toBe("conductor-remote-bridge");
    expect(health.tailscaleIp).toBe("100.121.247.7");
    expect(health.magicDnsName).toBe("macbook.taile00453.ts.net");
  });

  it("enforces Bearer token auth on /api/* endpoints and rejects query tokens on REST routes", async () => {
    const { server, baseUrl, token } = await startTestServer([makeTask()]);

    // Missing Authorization -> 401
    const noAuth = await fetch(`${baseUrl}/api/snapshot`);
    expect(noAuth.status).toBe(401);

    // Wrong token -> 401
    const badAuth = await fetch(`${baseUrl}/api/snapshot`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(badAuth.status).toBe(401);

    // Query token is NOT accepted for /api/snapshot (only /api/events SSE)
    const queryOnRest = await fetch(`${baseUrl}/api/snapshot?token=${token}`);
    expect(queryOnRest.status).toBe(401);

    // Valid Bearer token -> 200
    const okRes = await fetch(`${baseUrl}/api/snapshot`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(okRes.status).toBe(200);
    const snap = (await okRes.json()) as AppSnapshot;
    expect(snap.tasks).toHaveLength(1);
    expect(snap.tasks[0].id).toBe("task-1");

    // Token rotation immediately invalidates old token
    server.setToken("rotated-token-abcdef0123456789");
    const oldTokenRes = await fetch(`${baseUrl}/api/snapshot`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(oldTokenRes.status).toBe(401);

    const newTokenRes = await fetch(`${baseUrl}/api/snapshot`, {
      headers: { Authorization: "Bearer rotated-token-abcdef0123456789" },
    });
    expect(newTokenRes.status).toBe(200);
  });

  it("streams initial and live AppSnapshot updates via SSE at GET /api/events", async () => {
    const { server, baseUrl, token } = await startTestServer([makeTask()]);

    // Reject invalid SSE token
    const badSse = await fetch(`${baseUrl}/api/events?token=invalid`);
    expect(badSse.status).toBe(401);

    // Connect with ?token= and receive initial + pushed snapshots
    const receivedFrames = await new Promise<string[]>((resolve, reject) => {
      const frames: string[] = [];
      let buffer = "";
      const req = http.get(`${baseUrl}/api/events?token=${encodeURIComponent(token)}`, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Unexpected SSE status ${res.statusCode}`));
          return;
        }
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            if (part.includes("event: snapshot")) {
              frames.push(part);
              if (frames.length === 1) {
                // Push a live update
                server.publishSnapshot(
                  makeSnapshot([makeTask({ title: "Updated Live Task" })]),
                );
              } else if (frames.length >= 2) {
                req.destroy();
                resolve(frames);
              }
            }
          }
        });
      });
      req.on("error", (err) => {
        if (frames.length < 2) reject(err);
      });
      setTimeout(() => {
        req.destroy();
        reject(new Error(`Timed out waiting for SSE frames (got ${frames.length})`));
      }, 3000);
    });

    expect(receivedFrames).toHaveLength(2);
    expect(receivedFrames[0]).toContain("Test Task");
    expect(receivedFrames[1]).toContain("Updated Live Task");
  });

  it("handles POST /api/chat/send, /api/chat/stop, and /api/chat/new", async () => {
    const { mock, baseUrl, token } = await startTestServer();
    const authHeaders = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    // Empty message rejected with 400
    const emptyRes = await fetch(`${baseUrl}/api/chat/send`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ text: "   ", attachments: [] }),
    });
    expect(emptyRes.status).toBe(400);

    // Send with text + explicitMentions + attachments
    const sendRes = await fetch(`${baseUrl}/api/chat/send`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        text: "テストを実行して",
        explicitMentions: [{ kind: "project", projectId: "proj-1", projectName: "conductor" }],
        attachments: [{ id: "att-1", kind: "browserURL", label: "Preview", url: "http://localhost:3000" }],
      }),
    });
    expect(sendRes.status).toBe(200);
    expect(mock.calls.sendMessage).toHaveLength(1);
    expect(mock.calls.sendMessage[0].text).toBe("テストを実行して");
    expect(mock.calls.sendMessage[0].mentions).toEqual([
      { kind: "project", projectId: "proj-1", projectName: "conductor" },
    ]);
    expect(mock.calls.sendMessage[0].attachments).toHaveLength(1);

    // Stop specific message
    const stopOne = await fetch(`${baseUrl}/api/chat/stop`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ messageId: "msg-42" }),
    });
    expect(stopOne.status).toBe(200);
    expect(mock.calls.stopMessage).toEqual(["msg-42"]);

    // Stop all responders
    const stopAll = await fetch(`${baseUrl}/api/chat/stop`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({}),
    });
    expect(stopAll.status).toBe(200);
    expect(mock.calls.stopAllResponders).toBe(1);

    // New chat
    const newChat = await fetch(`${baseUrl}/api/chat/new`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({}),
    });
    expect(newChat.status).toBe(200);
    expect(mock.calls.startFreshChat).toBe(1);
  });

  it("handles task inspection, guarded status transitions, stop, and land endpoints", async () => {
    const runningTask = makeTask({ id: "t-run", taskNumber: 1, status: "running" });
    const unlandedTask = makeTask({
      id: "t-wt",
      taskNumber: 2,
      status: "needs_review",
      worktreePath: "/tmp/wt-2",
      worktreeBranch: "conductor/t2",
      landStatus: "unlanded",
    });
    const { mock, baseUrl, token } = await startTestServer([runningTask, unlandedTask]);
    const authHeaders = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    // GET /api/tasks/:id works by UUID and by T# code
    const detailRes = await fetch(`${baseUrl}/api/tasks/T2`, { headers: authHeaders });
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      ok: boolean;
      task: AgentTask;
      gitStatus: string;
      worktreeStatus: TaskWorktreeStatus;
    };
    expect(detail.task.id).toBe("t-wt");
    expect(detail.gitStatus).toBe("M src/app.ts");
    expect(detail.worktreeStatus.hasWorktree).toBe(true);

    // Guard: running task cannot be marked done (409)
    const runningDone = await fetch(`${baseUrl}/api/tasks/t-run/status`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ status: "done" }),
    });
    expect(runningDone.status).toBe(409);

    // Stop running worker -> transitions to needs_review -> then Done succeeds
    const stopRes = await fetch(`${baseUrl}/api/tasks/t-run/stop`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({}),
    });
    expect(stopRes.status).toBe(200);
    expect(mock.calls.stopTaskWorker).toEqual(["t-run"]);

    const doneAfterStop = await fetch(`${baseUrl}/api/tasks/t-run/status`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ status: "done" }),
    });
    expect(doneAfterStop.status).toBe(200);

    // Reopen done -> needs_review
    const reopenRes = await fetch(`${baseUrl}/api/tasks/t-run/status`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ status: "needs_review" }),
    });
    expect(reopenRes.status).toBe(200);

    // Guard: unlanded worktree task cannot be marked done before Land (409)
    const unlandedDone = await fetch(`${baseUrl}/api/tasks/t-wt/status`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ status: "done" }),
    });
    expect(unlandedDone.status).toBe(409);

    // Land task -> 200 -> then Done succeeds
    const landRes = await fetch(`${baseUrl}/api/tasks/t-wt/land`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ createPr: false }),
    });
    expect(landRes.status).toBe(200);
    expect(mock.calls.landTask).toEqual([{ taskId: "t-wt", createPr: false }]);

    const doneAfterLand = await fetch(`${baseUrl}/api/tasks/t-wt/status`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ status: "done" }),
    });
    expect(doneAfterLand.status).toBe(200);

    // Unknown task -> 404
    const missing = await fetch(`${baseUrl}/api/tasks/does-not-exist`, { headers: authHeaders });
    expect(missing.status).toBe(404);
  });
});

describe("StateStore, ConductorController & SettingsModal Remote Access integration", () => {
  it("persists remote access settings and toggles live server cleanly", async () => {
    const dataDir = makeTempDir("conductor-remote-ctrl-");
    const store = new StateStore(dataDir);
    const initialState = store.load();
    expect(initialState.remoteAccessEnabled).toBe(false);
    expect(initialState.remoteAccessPort).toBe(DEFAULT_REMOTE_ACCESS_PORT);
    expect((initialState.remoteAccessToken ?? "").length).toBeGreaterThanOrEqual(32);

    const controller = new ConductorController({
      store,
      browser: createFakeBrowserManager(),
      onSnapshot: () => {},
      detectRemoteNetwork: () => ({
        tailscaleIp: "100.121.247.7",
        magicDnsName: "mac.tail.ts.net",
        lanIp: "192.168.0.10",
      }),
    });

    try {
      const snapBefore = controller.getSnapshot();
      expect(snapBefore.remoteAccessEnabled).toBe(false);
      expect(snapBefore.remoteAccess?.running).toBe(false);

      // Use high ephemeral-ish port for test stability
      const portStatus = await controller.setRemoteAccessPort(14789);
      expect(portStatus.port).toBe(14789);
      expect(portStatus.running).toBe(false);

      const started = await controller.setRemoteAccessEnabled(true);
      expect(started.enabled).toBe(true);
      expect(started.running).toBe(true);
      expect(started.url).toBe("http://100.121.247.7:14789");
      expect(started.magicDnsUrl).toBe("http://mac.tail.ts.net:14789");
      expect(started.connectUri).toContain("conductor://connect?");

      const prevToken = started.token;
      const rotated = controller.regenerateRemoteAccessToken();
      expect(rotated.token).not.toBe(prevToken);

      // Verify persisted on disk
      const persisted = store.load();
      expect(persisted.remoteAccessEnabled).toBe(true);
      expect(persisted.remoteAccessPort).toBe(14789);
      expect(persisted.remoteAccessToken).toBe(rotated.token);

      const stopped = await controller.setRemoteAccessEnabled(false);
      expect(stopped.enabled).toBe(false);
      expect(stopped.running).toBe(false);
    } finally {
      await controller.shutdown();
    }
  });

  it("renders Remote Access controls in SettingsModal", () => {
    const html = renderToStaticMarkup(
      <SettingsModal
        defaultIntegrationMode="feature-branch"
        preferredLanguage="ja"
        remoteAccess={{
          enabled: true,
          running: true,
          port: 4789,
          token: "abcdef0123456789abcdef0123456789",
          bindHost: "0.0.0.0",
          tailscaleIp: "100.121.247.7",
          magicDnsName: "macbook-pro.taile00453.ts.net",
          lanIp: "192.168.1.5",
          url: "http://100.121.247.7:4789",
          magicDnsUrl: "http://macbook-pro.taile00453.ts.net:4789",
          connectUri:
            "conductor://connect?url=http%3A%2F%2F100.121.247.7%3A4789&token=abcdef0123456789abcdef0123456789",
          connectedClients: 2,
          error: null,
        }}
        projects={[]}
        onClose={vi.fn()}
        onSetDefaultIntegrationMode={vi.fn()}
        onSetProjectIntegrationMode={vi.fn()}
      />,
    );

    expect(html).toContain('data-testid="remote-access-section"');
    expect(html).toContain('data-testid="remote-access-qr-panel"');
    expect(html).toContain('data-testid="remote-access-qr-download"');
    expect(html).toContain('data-testid="remote-access-qr-pair"');
    expect(html).toContain(
      `href="${ANDROID_APK_DOWNLOAD_URL}"`,
    );
    expect(html).toContain(ANDROID_APK_DOWNLOAD_URL);
    expect(html).toContain('data-testid="remote-access-releases-link"');
    expect(html).toContain(`href="${ANDROID_RELEASES_PAGE_URL}"`);
    expect(html).toContain("GitHub Releases ページを開く");
    expect(html).toContain("100.121.247.7");
    expect(html).toContain("macbook-pro.taile00453.ts.net");
    expect(html).toContain("http://100.121.247.7:4789");
    expect(html).toContain("稼働中 · SSE 2台");
    expect(html).toContain("conductor://connect?");
    expect(html).toContain('data-testid="remote-access-regenerate-token"');
    expect(html).not.toContain('data-testid="remote-access-qr-enable-btn"');
    expect(html).not.toContain('data-testid="remote-access-qr-tailscale-warning"');
  });

  it("shows one-click enable CTA when Remote Bridge is stopped and Tailscale warning when IP is missing", () => {
    const disabledHtml = renderToStaticMarkup(
      <SettingsModal
        defaultIntegrationMode="feature-branch"
        preferredLanguage="ja"
        remoteAccess={{
          enabled: false,
          running: false,
          port: 4789,
          token: "abcdef0123456789abcdef0123456789",
          bindHost: null,
          tailscaleIp: null,
          magicDnsName: null,
          lanIp: "192.168.1.5",
          url: "http://192.168.1.5:4789",
          magicDnsUrl: null,
          connectUri:
            "conductor://connect?url=http%3A%2F%2F192.168.1.5%3A4789&token=abcdef0123456789abcdef0123456789",
          connectedClients: 0,
          error: null,
        }}
        projects={[]}
        onClose={vi.fn()}
        onSetDefaultIntegrationMode={vi.fn()}
        onSetProjectIntegrationMode={vi.fn()}
      />,
    );

    // Step 1 download QR is always available
    expect(disabledHtml).toContain('data-testid="remote-access-qr-download"');
    // Step 2 shows one-click enable CTA instead of pairing QR
    expect(disabledHtml).toContain('data-testid="remote-access-qr-enable-btn"');
    expect(disabledHtml).not.toContain('data-testid="remote-access-qr-pair"');

    // English locale + running without Tailscale IP shows English UI and warning
    const enNoTailscaleHtml = renderToStaticMarkup(
      <SettingsModal
        defaultIntegrationMode="feature-branch"
        preferredLanguage="en"
        remoteAccess={{
          enabled: true,
          running: true,
          port: 4789,
          token: "abcdef0123456789abcdef0123456789",
          bindHost: "0.0.0.0",
          tailscaleIp: null,
          magicDnsName: null,
          lanIp: "192.168.1.5",
          url: "http://192.168.1.5:4789",
          magicDnsUrl: null,
          connectUri:
            "conductor://connect?url=http%3A%2F%2F192.168.1.5%3A4789&token=abcdef0123456789abcdef0123456789",
          connectedClients: 0,
          error: null,
        }}
        projects={[]}
        onClose={vi.fn()}
        onSetDefaultIntegrationMode={vi.fn()}
        onSetProjectIntegrationMode={vi.fn()}
      />,
    );

    expect(enNoTailscaleHtml).toContain("Android Quick Setup (QR Code)");
    expect(enNoTailscaleHtml).toContain("Download Android App");
    expect(enNoTailscaleHtml).toContain("Open GitHub Releases page");
    expect(enNoTailscaleHtml).toContain(`href="${ANDROID_APK_DOWNLOAD_URL}"`);
    expect(enNoTailscaleHtml).toContain("Link with Desktop (Pairing)");
    expect(enNoTailscaleHtml).toContain('data-testid="remote-access-qr-pair"');
    expect(enNoTailscaleHtml).toContain('data-testid="remote-access-qr-tailscale-warning"');
  });
});
