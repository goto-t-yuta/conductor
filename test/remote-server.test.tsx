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
  buildConductorLinkUri,
  buildRemoteSnapshot,
  detectTailscaleIpv4FromInterfaces,
  detectTailscaleNetwork,
  isTailscaleIpv4,
  parseConductorConnectUri,
  type RemoteBridgeController,
} from "../src/main/remote-server.js";
import { StateStore } from "../src/main/state-store.js";
import { buildQrSvgData } from "../src/renderer/components/QrCodeSvg.js";
import {
  RemoteAccessSettingsSection,
  SettingsModal,
} from "../src/renderer/components/SettingsModal.js";
import {
  ANDROID_APK_DOWNLOAD_URL,
  ANDROID_APK_FILENAME,
  ANDROID_RELEASES_PAGE_URL,
  resolvePairingEndpoints,
  resolvePairingTarget,
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
    expect(cliFallback.lanIp).toBe("192.168.1.42");

    // When Tailscale daemon reports BackendState !== "Running", ignore stale cached DNS/IP safely
    const stoppedDaemon = detectTailscaleNetwork({
      interfaces: fakeInterfaces,
      runTailscale: (args) => {
        if (args[0] === "status") {
          return JSON.stringify({
            BackendState: "Stopped",
            Self: {
              DNSName: "macbook-pro.tail1234.ts.net.",
              TailscaleIPs: ["100.121.247.7"],
            },
          });
        }
        return "100.121.247.7\n";
      },
    });
    expect(stoppedDaemon).toEqual({
      tailscaleIp: null,
      magicDnsName: null,
      lanIp: "192.168.1.42",
    });

    // When tailscale CLI throws or is missing, safely fall back to LAN without throwing
    const missingCli = detectTailscaleNetwork({
      interfaces: { en0: fakeInterfaces.en0 },
      runTailscale: () => {
        throw new Error("ENOENT: tailscale not found");
      },
    });
    expect(missingCli).toEqual({
      tailscaleIp: null,
      magicDnsName: null,
      lanIp: "192.168.1.42",
    });
  });

  it("resolves Tailscale IP, MagicDNS, and LAN pairing endpoints and builds conductor://link URIs", () => {
    const token = "secret-token-123";
    const linkUri = buildConductorLinkUri("http://100.121.247.7:4789", token);
    expect(linkUri).toBe(
      "conductor://link?url=http%3A%2F%2F100.121.247.7%3A4789&token=secret-token-123",
    );
    expect(parseConductorConnectUri(linkUri)).toEqual({
      url: "http://100.121.247.7:4789",
      token,
    });

    // Both Tailscale IP and MagicDNS + LAN available -> defaults to Tailscale IP
    const fullStatus = {
      port: 4789,
      token,
      tailscaleIp: "100.121.247.7",
      magicDnsName: "macbook-pro.taile00453.ts.net",
      lanIp: "192.168.1.42",
    };
    const fullEndpoints = resolvePairingEndpoints(fullStatus);
    expect(fullEndpoints).toEqual({
      tailscaleIpUrl: "http://100.121.247.7:4789",
      magicDnsUrl: "http://macbook-pro.taile00453.ts.net:4789",
      lanUrl: "http://192.168.1.42:4789",
      hasTailscale: true,
      hasBothTailscaleEndpoints: true,
      defaultTransport: "tailscale",
      defaultTailscaleAddressKind: "ip",
    });

    const defaultTarget = resolvePairingTarget(fullStatus);
    expect(defaultTarget.transport).toBe("tailscale");
    expect(defaultTarget.endpointKind).toBe("tailscale-ip");
    expect(defaultTarget.url).toBe("http://100.121.247.7:4789");
    expect(defaultTarget.linkUri).toBe(linkUri);

    const magicDnsTarget = resolvePairingTarget(fullStatus, {
      transport: "tailscale",
      tailscaleAddressKind: "magicdns",
    });
    expect(magicDnsTarget.endpointKind).toBe("tailscale-magicdns");
    expect(magicDnsTarget.url).toBe("http://macbook-pro.taile00453.ts.net:4789");
    expect(magicDnsTarget.linkUri).toBe(
      buildConductorLinkUri("http://macbook-pro.taile00453.ts.net:4789", token),
    );

    const lanTarget = resolvePairingTarget(fullStatus, { transport: "lan" });
    expect(lanTarget.endpointKind).toBe("lan");
    expect(lanTarget.url).toBe("http://192.168.1.42:4789");
    expect(lanTarget.linkUri).toBe(buildConductorLinkUri("http://192.168.1.42:4789", token));

    // Only MagicDNS available -> defaults to Tailscale MagicDNS
    const magicDnsOnly = resolvePairingTarget({
      port: 4789,
      token,
      tailscaleIp: null,
      magicDnsName: "macbook-pro.taile00453.ts.net",
      lanIp: "192.168.1.42",
    });
    expect(magicDnsOnly.transport).toBe("tailscale");
    expect(magicDnsOnly.endpointKind).toBe("tailscale-magicdns");
    expect(magicDnsOnly.url).toBe("http://macbook-pro.taile00453.ts.net:4789");

    // Tailscale unavailable -> defaults to LAN, while selecting Tailscale yields null linkUri
    const lanOnlyStatus = {
      port: 4789,
      token,
      tailscaleIp: null,
      magicDnsName: null,
      lanIp: "192.168.1.42",
    };
    const lanFallback = resolvePairingTarget(lanOnlyStatus);
    expect(lanFallback.transport).toBe("lan");
    expect(lanFallback.url).toBe("http://192.168.1.42:4789");
    expect(lanFallback.linkUri).toBe(buildConductorLinkUri("http://192.168.1.42:4789", token));

    const tailscaleUnavailable = resolvePairingTarget(lanOnlyStatus, { transport: "tailscale" });
    expect(tailscaleUnavailable.transport).toBe("tailscale");
    expect(tailscaleUnavailable.url).toBeNull();
    expect(tailscaleUnavailable.linkUri).toBeNull();
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

  it("projects lightweight remote snapshots, supports gzip, and returns snapshot on chat actions", async () => {
    const bigBase64 = `data:image/png;base64,${"A".repeat(200_000)}`;
    const hugeOutput = "x".repeat(8_000) + "FINAL_MARKER";
    const heavyTask = makeTask({
      id: "t-heavy",
      latestOutput: hugeOutput,
      workerPrompt: "P".repeat(50_000),
      activities: Array.from({ length: 40 }, (_, i) => ({
        id: `act-${i}`,
        kind: "command",
        title: `step ${i}`,
        detail: "D".repeat(2_000),
        timestamp: new Date().toISOString(),
      })),
    });

    let currentSnapshot: AppSnapshot = {
      ...makeSnapshot([heavyTask]),
      messages: [
        {
          id: "m-1",
          role: "user",
          text: "スクショを見て",
          attachments: [
            {
              id: "att-img",
              kind: "image",
              label: "capture.png",
              imagePath: "/tmp/capture.png",
              imageDataUrl: bigBase64,
              metadataText: "M".repeat(50_000),
            },
          ],
          toolChips: [],
          isStreaming: false,
          createdAt: new Date().toISOString(),
        },
      ],
      browserTabs: [
        {
          id: "tab-1",
          title: "Preview",
          url: "http://localhost:3000",
          isLoading: false,
          canGoBack: false,
          canGoForward: false,
          consoleErrorCount: 0,
          networkErrorCount: 0,
        },
      ],
      remoteAccessToken: "secret-should-not-be-in-snapshot",
    };

    const projected = buildRemoteSnapshot(currentSnapshot);
    const projectedJson = JSON.stringify(projected);
    expect(projectedJson.length).toBeLessThan(10_000);
    expect(projectedJson).not.toContain("AAAA");
    expect(projectedJson).not.toContain("secret-should-not-be-in-snapshot");
    expect(projectedJson).not.toContain("browserTabs");
    expect(projectedJson).toContain("FINAL_MARKER");
    const projTasks = projected.tasks as Array<{ activities: unknown[]; latestOutput: string }>;
    expect(projTasks[0].activities).toEqual([]);
    expect(projTasks[0].latestOutput.length).toBeLessThanOrEqual(3_000);

    const mock = createMockBridgeController([heavyTask]);
    const customController: RemoteBridgeController = {
      ...mock.controller,
      getSnapshot: () => currentSnapshot,
      sendMessage: async (payload) => {
        await mock.controller.sendMessage(payload);
        currentSnapshot = {
          ...currentSnapshot,
          activeResponderCount: 1,
          messages: [
            ...currentSnapshot.messages,
            {
              id: "m-user-2",
              role: "user",
              text: payload.text,
              attachments: payload.attachments,
              toolChips: [],
              isStreaming: false,
              createdAt: new Date().toISOString(),
            },
            {
              id: "m-asst-2",
              role: "assistant",
              provider: "codex",
              text: "",
              attachments: [],
              toolChips: [],
              isStreaming: true,
              createdAt: new Date().toISOString(),
            },
          ],
        };
      },
    };

    const server = new RemoteBridgeServer(customController, {
      host: "127.0.0.1",
      port: 0,
      token: "remote-opt-token-1234567890abcdef",
      sseThrottleMs: 120,
      detectNetwork: () => ({ tailscaleIp: null, magicDnsName: null, lanIp: "127.0.0.1" }),
    });
    activeServers.push(server);
    await server.start();
    const baseUrl = `http://127.0.0.1:${server.getPort()}`;
    const authHeaders = {
      Authorization: `Bearer ${server.getToken()}`,
      "Content-Type": "application/json",
    };

    // GET /api/snapshot returns gzip-compressed lightweight snapshot when accepted
    const snapRes = await fetch(`${baseUrl}/api/snapshot`, {
      headers: { Authorization: `Bearer ${server.getToken()}`, "Accept-Encoding": "gzip" },
    });
    expect(snapRes.status).toBe(200);
    expect(snapRes.headers.get("content-encoding")).toBe("gzip");
    const snapBody = (await snapRes.json()) as AppSnapshot & { remoteAccessToken?: string };
    expect(snapBody.remoteAccessToken).toBeUndefined();
    expect(snapBody.messages[0].attachments[0].imageDataUrl).toBeUndefined();

    // POST /api/chat/send immediately includes the updated lightweight snapshot
    const sendRes = await fetch(`${baseUrl}/api/chat/send`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ text: "こんにちは" }),
    });
    expect(sendRes.status).toBe(200);
    const sendJson = (await sendRes.json()) as { ok: boolean; snapshot?: AppSnapshot };
    expect(sendJson.ok).toBe(true);
    expect(sendJson.snapshot?.activeResponderCount).toBe(1);
    expect(sendJson.snapshot?.messages.map((m) => m.id)).toContain("m-asst-2");
  });

  it("deduplicates desktop-only updates and throttles rapid SSE streaming deltas while flushing completion immediately", async () => {
    const baseSnap = makeSnapshot([makeTask()]);
    let snap: AppSnapshot = {
      ...baseSnap,
      activeResponderCount: 1,
      messages: [
        {
          id: "m-stream",
          role: "assistant",
          provider: "codex",
          text: "",
          attachments: [],
          toolChips: [],
          isStreaming: true,
          createdAt: new Date().toISOString(),
        },
      ],
    };

    const mock = createMockBridgeController([makeTask()]);
    const server = new RemoteBridgeServer(
      { ...mock.controller, getSnapshot: () => snap },
      {
        host: "127.0.0.1",
        port: 0,
        token: "sse-throttle-token-1234567890abcd",
        sseThrottleMs: 120,
        detectNetwork: () => ({ tailscaleIp: null, magicDnsName: null, lanIp: "127.0.0.1" }),
      },
    );
    activeServers.push(server);
    await server.start();
    const baseUrl = `http://127.0.0.1:${server.getPort()}`;

    const parsedSnapshots = await new Promise<AppSnapshot[]>((resolve, reject) => {
      const received: AppSnapshot[] = [];
      let buffer = "";
      let pushedBursts = false;
      const req = http.get(
        `${baseUrl}/api/events?token=${encodeURIComponent(server.getToken())}`,
        (res) => {
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            buffer += chunk;
            const parts = buffer.split("\n\n");
            buffer = parts.pop() ?? "";
            for (const part of parts) {
              const dataLine = part
                .split("\n")
                .find((line) => line.startsWith("data: "));
              if (!dataLine) continue;
              const parsed = JSON.parse(dataLine.slice("data: ".length)) as AppSnapshot;
              received.push(parsed);

              if (!pushedBursts) {
                pushedBursts = true;
                // 1. Desktop-only change (browserTabs) should be deduplicated and NOT sent
                server.publishSnapshot({
                  ...snap,
                  browserTabs: [
                    {
                      id: "b1",
                      title: "Tab",
                      url: "https://example.com",
                      isLoading: true,
                      canGoBack: false,
                      canGoForward: false,
                      consoleErrorCount: 0,
                      networkErrorCount: 0,
                    },
                  ],
                });

                // 2. Rapid streaming text burst (10 deltas within same tick) should coalesce
                for (let i = 1; i <= 10; i++) {
                  snap = {
                    ...snap,
                    messages: [
                      {
                        ...snap.messages[0],
                        text: `chunk-${i}`,
                      },
                    ],
                  };
                  server.publishSnapshot(snap);
                }

                // 3. After throttle window delivers coalesced delta, send final completion
                setTimeout(() => {
                  snap = {
                    ...snap,
                    activeResponderCount: 0,
                    messages: [
                      {
                        ...snap.messages[0],
                        text: "final-answer",
                        isStreaming: false,
                      },
                    ],
                  };
                  server.publishSnapshot(snap);
                }, 180);
              } else if (parsed.activeResponderCount === 0 && parsed.messages[0]?.text === "final-answer") {
                req.destroy();
                resolve(received);
              }
            }
          });
        },
      );
      req.on("error", (err) => {
        if (received.every((s) => s.activeResponderCount !== 0)) reject(err);
      });
      setTimeout(() => {
        req.destroy();
        reject(new Error(`Timed out waiting for throttled SSE snapshots (got ${received.length})`));
      }, 3000);
    });

    // Initial + coalesced burst (1-2 frames, far fewer than 11) + final completion
    expect(parsedSnapshots.length).toBeLessThanOrEqual(4);
    expect(parsedSnapshots.length).toBeGreaterThanOrEqual(3);
    const last = parsedSnapshots[parsedSnapshots.length - 1];
    expect(last.activeResponderCount).toBe(0);
    expect(last.messages[0].text).toBe("final-answer");
    expect(last.messages[0].isStreaming).toBe(false);
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
      expect(started.tailscaleUrl).toBe("http://100.121.247.7:14789");
      expect(started.magicDnsUrl).toBe("http://mac.tail.ts.net:14789");
      expect(started.lanUrl).toBe("http://192.168.0.10:14789");
      expect(started.connectUri).toContain("conductor://connect?");
      expect(started.linkUri).toContain("conductor://link?");

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
    expect(enNoTailscaleHtml).toContain('data-testid="remote-access-qr-endpoint-selector"');
    expect(enNoTailscaleHtml).toContain('data-testid="remote-access-qr-endpoint-url"');
    expect(enNoTailscaleHtml).toContain("http://192.168.1.5:4789");
  });

  it("renders Tailscale IP, MagicDNS, LAN, and Tailscale-unavailable states in Step 2 QR pairing", () => {
    const token = "abcdef0123456789abcdef0123456789";
    const fullRemoteAccess = {
      enabled: true,
      running: true,
      port: 4789,
      token,
      bindHost: "0.0.0.0",
      tailscaleIp: "100.121.247.7",
      magicDnsName: "macbook-pro.taile00453.ts.net",
      lanIp: "192.168.1.5",
      url: "http://100.121.247.7:4789",
      tailscaleUrl: "http://100.121.247.7:4789",
      magicDnsUrl: "http://macbook-pro.taile00453.ts.net:4789",
      lanUrl: "http://192.168.1.5:4789",
      connectUri: buildConductorConnectUri("http://100.121.247.7:4789", token),
      linkUri: buildConductorLinkUri("http://100.121.247.7:4789", token),
      connectedClients: 1,
      error: null,
    };

    // 1. Default selects Tailscale IP and encodes conductor://link?... QR
    const tsIpHtml = renderToStaticMarkup(
      <RemoteAccessSettingsSection remoteAccess={fullRemoteAccess} locale="ja" />,
    );
    const tsIpQr = buildQrSvgData(buildConductorLinkUri("http://100.121.247.7:4789", token))!;
    expect(tsIpHtml).toContain('data-testid="remote-access-qr-endpoint-selector"');
    expect(tsIpHtml).toContain('data-testid="remote-access-qr-tailscale-variant"');
    expect(tsIpHtml).toContain('data-testid="remote-access-qr-endpoint-url"');
    expect(tsIpHtml).toContain("http://100.121.247.7:4789");
    expect(tsIpHtml).toContain(`d="${tsIpQr.pathD}"`);

    // 2. MagicDNS selection encodes MagicDNS URL in conductor://link?... QR
    const magicDnsHtml = renderToStaticMarkup(
      <RemoteAccessSettingsSection
        remoteAccess={fullRemoteAccess}
        locale="ja"
        initialPairingTransport="tailscale"
        initialTailscaleAddressKind="magicdns"
      />,
    );
    const magicDnsQr = buildQrSvgData(
      buildConductorLinkUri("http://macbook-pro.taile00453.ts.net:4789", token),
    )!;
    expect(magicDnsHtml).toContain("http://macbook-pro.taile00453.ts.net:4789");
    expect(magicDnsHtml).toContain(`d="${magicDnsQr.pathD}"`);
    expect(magicDnsHtml).not.toContain(`d="${tsIpQr.pathD}"`);

    // 3. LAN selection encodes LAN IP URL in conductor://link?... QR
    const lanHtml = renderToStaticMarkup(
      <RemoteAccessSettingsSection
        remoteAccess={fullRemoteAccess}
        locale="ja"
        initialPairingTransport="lan"
      />,
    );
    const lanQr = buildQrSvgData(buildConductorLinkUri("http://192.168.1.5:4789", token))!;
    expect(lanHtml).toContain("http://192.168.1.5:4789");
    expect(lanHtml).toContain(`d="${lanQr.pathD}"`);

    // 4. Tailscale tab selected when Tailscale is disconnected shows start hint & LAN switch button
    const disconnectedTsHtml = renderToStaticMarkup(
      <RemoteAccessSettingsSection
        remoteAccess={{
          ...fullRemoteAccess,
          tailscaleIp: null,
          magicDnsName: null,
          tailscaleUrl: null,
          magicDnsUrl: null,
          url: "http://192.168.1.5:4789",
        }}
        locale="ja"
        initialPairingTransport="tailscale"
      />,
    );
    expect(disconnectedTsHtml).toContain('data-testid="remote-access-qr-tailscale-unavailable"');
    expect(disconnectedTsHtml).toContain("Tailscale が未接続です");
    expect(disconnectedTsHtml).toContain("Tailscale を起動してログインしたあと");
    expect(disconnectedTsHtml).toContain('data-testid="remote-access-qr-switch-lan"');
    expect(disconnectedTsHtml).not.toContain('data-testid="remote-access-qr-pair"');
  });
});
