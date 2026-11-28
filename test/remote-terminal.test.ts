import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RemoteBridgeServer, type RemoteBridgeController } from "../src/main/remote-server.js";
import { RemoteTerminalService } from "../src/main/remote-terminal.js";
import type {
  NodePtyModuleLike,
  NodePtyProcessLike,
} from "../src/main/terminal-manager.js";
import type { AppSnapshot } from "../src/shared/types.js";

const activeServers: RemoteBridgeServer[] = [];
const activeServices: RemoteTerminalService[] = [];
const activeSockets: net.Socket[] = [];
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return fs.realpathSync(dir);
}

afterEach(async () => {
  while (activeSockets.length > 0) {
    try {
      activeSockets.pop()!.destroy();
    } catch {
      // ignore
    }
  }
  while (activeServers.length > 0) {
    await activeServers.pop()!.stop();
  }
  while (activeServices.length > 0) {
    activeServices.pop()!.disposeAll();
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

interface MockPtyInstance {
  proc: NodePtyProcessLike;
  emitData: (data: string) => void;
  emitExit: (exitCode: number, signal?: number) => void;
  writes: string[];
  resizes: Array<{ cols: number; rows: number }>;
  killed: boolean;
}

function createMockNodePty(): {
  mod: NodePtyModuleLike;
  spawned: Array<{
    file: string;
    args: string[] | string;
    options: Record<string, unknown>;
    instance: MockPtyInstance;
  }>;
} {
  const spawned: Array<{
    file: string;
    args: string[] | string;
    options: Record<string, unknown>;
    instance: MockPtyInstance;
  }> = [];
  let nextPid = 51000;

  const mod: NodePtyModuleLike = {
    spawn: (file, args, options) => {
      let dataCb: ((data: string) => void) | null = null;
      let exitCb: ((ev: { exitCode: number; signal?: number }) => void) | null = null;
      const writes: string[] = [];
      const resizes: Array<{ cols: number; rows: number }> = [];
      let killed = false;
      const pid = nextPid++;

      const proc: NodePtyProcessLike = {
        pid,
        write: (data) => {
          writes.push(data);
        },
        resize: (cols, rows) => {
          resizes.push({ cols, rows });
        },
        kill: () => {
          killed = true;
        },
        onData: (listener) => {
          dataCb = listener;
          return { dispose: () => { dataCb = null; } };
        },
        onExit: (listener) => {
          exitCb = listener;
          return { dispose: () => { exitCb = null; } };
        },
      };

      const instance: MockPtyInstance = {
        proc,
        emitData: (data) => dataCb?.(data),
        emitExit: (exitCode, signal) => exitCb?.({ exitCode, signal }),
        writes,
        resizes,
        get killed() {
          return killed;
        },
      };

      spawned.push({ file, args, options: options as Record<string, unknown>, instance });
      return proc;
    },
  };

  return { mod, spawned };
}

function createDummyController(): RemoteBridgeController {
  const snapshot: AppSnapshot = {
    projects: [],
    scanRoots: [],
    tasks: [],
    messages: [],
    activeChatSessionId: "s1",
    chatSessions: [],
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
    chatModel: "gpt-5.4",
    chatEffort: "low",
    workerModel: "gpt-5.4",
    workerEffort: "medium",
    defaultIntegrationMode: "feature-branch",
    autoLandOnComplete: true,
    preferredLanguage: "ja",
    lastErrorBanner: null,
  };

  return {
    getSnapshot: () => snapshot,
    sendMessage: async () => {},
    stopMessage: async () => {},
    stopAllResponders: async () => {},
    startFreshChat: async () => {},
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
  };
}

/**
 * Minimal RFC 6455 test client over net.Socket so tests verify exact wire framing
 * without adding external dependencies.
 */
class TestWsClient {
  private readonly socket: net.Socket;
  private buffer = Buffer.alloc(0);
  public readonly messages: Array<Record<string, unknown>> = [];
  private waiters: Array<() => void> = [];
  public closed = false;
  private closeWaiters: Array<() => void> = [];

  private constructor(socket: net.Socket, initialRemainder: Buffer) {
    this.socket = socket;
    activeSockets.push(socket);
    socket.on("error", () => {
      // ignore ECONNRESET during server teardown
    });
    socket.on("data", (chunk: Buffer) => this.onChunk(chunk));
    socket.on("close", () => {
      this.closed = true;
      for (const resolve of this.closeWaiters.splice(0)) resolve();
    });
    if (initialRemainder.length > 0) {
      this.onChunk(initialRemainder);
    }
  }

  static connect(options: {
    port: number;
    path: string;
    headers?: Record<string, string>;
  }): Promise<{ statusCode: number; client?: TestWsClient; rawHeader: string }> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port: options.port });
      const key = crypto.randomBytes(16).toString("base64");
      let headerBuf = Buffer.alloc(0);
      let settled = false;

      socket.once("connect", () => {
        const extraHeaders = Object.entries(options.headers ?? {})
          .map(([k, v]) => `${k}: ${v}\r\n`)
          .join("");
        const req =
          `GET ${options.path} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${options.port}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\n` +
          `Sec-WebSocket-Version: 13\r\n` +
          extraHeaders +
          "\r\n";
        socket.write(req);
      });

      const onData = (chunk: Buffer) => {
        headerBuf = Buffer.concat([headerBuf, chunk]);
        const idx = headerBuf.indexOf("\r\n\r\n");
        if (idx === -1) return;

        socket.off("data", onData);
        const rawHeader = headerBuf.subarray(0, idx).toString("utf8");
        const remainder = headerBuf.subarray(idx + 4);
        const statusMatch = /^HTTP\/1\.1\s+(\d+)/.exec(rawHeader);
        const statusCode = statusMatch ? Number(statusMatch[1]) : 0;

        settled = true;
        if (statusCode === 101) {
          resolve({
            statusCode,
            client: new TestWsClient(socket, remainder),
            rawHeader,
          });
        } else {
          socket.destroy();
          resolve({ statusCode, rawHeader });
        }
      };

      socket.on("data", onData);
      socket.once("error", (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });
  }

  public sendJson(payload: unknown): void {
    const data = Buffer.from(JSON.stringify(payload), "utf8");
    const mask = crypto.randomBytes(4);
    const len = data.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[0] = 0x81;
      header[1] = 0x80 | len;
    } else {
      header = Buffer.allocUnsafe(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    }
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i += 1) {
      masked[i] = data[i] ^ mask[i & 3];
    }
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  public close(): void {
    const mask = crypto.randomBytes(4);
    const header = Buffer.from([0x88, 0x80]);
    try {
      this.socket.end(Buffer.concat([header, mask]));
    } catch {
      this.socket.destroy();
    }
  }

  public async waitForMessage(
    predicate: (msg: Record<string, unknown>) => boolean,
    timeoutMs = 3_000,
  ): Promise<Record<string, unknown>> {
    const existing = this.messages.find(predicate);
    if (existing) return existing;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for WS message. Seen: ${JSON.stringify(this.messages)}`));
      }, timeoutMs);

      const check = () => {
        const match = this.messages.find(predicate);
        if (match) {
          clearTimeout(timer);
          resolve(match);
        } else {
          this.waiters.push(check);
        }
      };
      this.waiters.push(check);
    });
  }

  public async waitForClose(timeoutMs = 3_000): Promise<void> {
    if (this.closed) return;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for WS close")), timeoutMs);
      this.closeWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private onChunk(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const opcode = this.buffer[0] & 0x0f;
      let len = this.buffer[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        len = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (this.buffer.length < offset + len) return;
      const payload = this.buffer.subarray(offset, offset + len);
      this.buffer = this.buffer.subarray(offset + len);

      if (opcode === 0x1) {
        const parsed = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
        this.messages.push(parsed);
        for (const fn of this.waiters.splice(0)) fn();
      } else if (opcode === 0x8) {
        this.socket.end();
      }
    }
  }
}

async function httpJson(
  port: number,
  method: string,
  reqPath: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: reqPath,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            json: text ? (JSON.parse(text) as Record<string, unknown>) : {},
          });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe("RemoteTerminalService", () => {
  it("spawns in requested projectPath, buffers output with sequence numbers, and supports delta/full replay", () => {
    const projectDir = makeTempDir("remote-term-proj-");
    const mockPty = createMockNodePty();
    const service = new RemoteTerminalService({
      maxBufferChars: 1024,
      terminalManagerOptions: {
        loadNodePty: () => mockPty.mod,
      },
    });
    activeServices.push(service);

    const created = service.createSession({ projectPath: projectDir, cols: 90, rows: 30 });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.session.cwd).toBe(projectDir);
    expect(created.session.projectPath).toBe(projectDir);
    expect(created.session.cols).toBe(90);
    expect(created.session.rows).toBe(30);

    const ptyInstance = mockPty.spawned[0].instance;
    ptyInstance.emitData("line-1\r\n");
    ptyInstance.emitData("line-2\r\n");
    ptyInstance.emitData("line-3\r\n");

    const full = service.getReplay(created.session.id);
    expect(full).toEqual({
      replay: "line-1\r\nline-2\r\nline-3\r\n",
      seq: 3,
      replayMode: "full",
    });

    const delta = service.getReplay(created.session.id, 1);
    expect(delta).toEqual({
      replay: "line-2\r\nline-3\r\n",
      seq: 3,
      replayMode: "delta",
    });

    const upToDate = service.getReplay(created.session.id, 3);
    expect(upToDate).toEqual({
      replay: "",
      seq: 3,
      replayMode: "delta",
    });
  });

  it("caps output buffer size and falls back to full replay when afterSeq was evicted", () => {
    const mockPty = createMockNodePty();
    const service = new RemoteTerminalService({
      maxBufferChars: 1024,
      terminalManagerOptions: {
        loadNodePty: () => mockPty.mod,
      },
    });
    activeServices.push(service);

    const created = service.createSession({});
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // Defaults to home directory when projectPath is omitted
    expect(created.session.cwd).toBe(os.homedir());

    const pty = mockPty.spawned[0].instance;
    for (let i = 1; i <= 30; i += 1) {
      pty.emitData(`${"x".repeat(60)}-${i}\n`);
    }

    const replayAfterEvicted = service.getReplay(created.session.id, 1);
    expect(replayAfterEvicted).not.toBeNull();
    expect(replayAfterEvicted!.replayMode).toBe("full");
    expect(replayAfterEvicted!.replay.length).toBeLessThanOrEqual(1024);
    expect(replayAfterEvicted!.replay).toContain("-30\n");
    expect(replayAfterEvicted!.replay).not.toContain("-1\n");
  });
});

describe("RemoteBridgeServer terminal WebSocket & HTTP APIs", () => {
  it("enforces Bearer auth on /api/terminal/ws and supports live I/O, resize, reconnect replay, and project switch restart", async () => {
    const projA = makeTempDir("conductor-proj-a-");
    const projB = makeTempDir("conductor-proj-b-");
    const mockPty = createMockNodePty();
    const token = "secret-terminal-token-xyz";

    const server = new RemoteBridgeServer(createDummyController(), {
      port: 0,
      host: "127.0.0.1",
      token,
      detectNetwork: () => ({ tailscaleIp: null, magicDnsName: null, lanIp: "127.0.0.1" }),
      terminal: {
        terminalManagerOptions: {
          loadNodePty: () => mockPty.mod,
        },
      },
    });
    activeServers.push(server);
    await server.start();
    const port = server.getPort();

    // 1. Unauthorized WebSocket upgrade is rejected with 401
    const unauth = await TestWsClient.connect({
      port,
      path: "/api/terminal/ws",
    });
    expect(unauth.statusCode).toBe(401);

    // 2. Authenticated WebSocket connect with projectPath starts PTY in projA
    const conn1 = await TestWsClient.connect({
      port,
      path: `/api/terminal/ws?projectPath=${encodeURIComponent(projA)}&cols=72&rows=28`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(conn1.statusCode).toBe(101);
    const ws1 = conn1.client!;

    const ready1 = await ws1.waitForMessage((m) => m.type === "ready");
    const session1 = ready1.session as Record<string, unknown>;
    const sessionId1 = session1.id as string;
    expect(session1.cwd).toBe(projA);
    expect(session1.cols).toBe(72);
    expect(session1.rows).toBe(28);
    expect(ready1.recreated).toBe(false);

    // Send stdin + resize + ping
    ws1.sendJson({ type: "input", data: "ls -la\r" });
    ws1.sendJson({ type: "resize", cols: 88, rows: 34 });
    ws1.sendJson({ type: "ping", ts: 42 });

    const pong = await ws1.waitForMessage((m) => m.type === "pong");
    expect(pong.ts).toBe(42);
    expect(mockPty.spawned[0].instance.writes).toEqual(["ls -la\r"]);
    expect(mockPty.spawned[0].instance.resizes).toContainEqual({ cols: 88, rows: 34 });

    // Server streams live output
    mockPty.spawned[0].instance.emitData("$ ls -la\r\nREADME.md\r\n");
    const out1 = await ws1.waitForMessage((m) => m.type === "output");
    expect(out1.data).toBe("$ ls -la\r\nREADME.md\r\n");
    const lastSeq = out1.seq as number;

    // 3. Simulate mobile disconnect / backgrounding while PTY continues emitting output
    ws1.close();
    await ws1.waitForClose();
    mockPty.spawned[0].instance.emitData("package.json\r\n");
    mockPty.spawned[0].instance.emitData("src/\r\n");

    // Reconnect using query token + sessionId + afterSeq -> receives missed delta output!
    const conn2 = await TestWsClient.connect({
      port,
      path: `/api/terminal/ws?token=${encodeURIComponent(token)}&sessionId=${encodeURIComponent(sessionId1)}&afterSeq=${lastSeq}`,
    });
    expect(conn2.statusCode).toBe(101);
    const ws2 = conn2.client!;
    const ready2 = await ws2.waitForMessage((m) => m.type === "ready");
    expect((ready2.session as Record<string, unknown>).id).toBe(sessionId1);
    expect(ready2.replayMode).toBe("delta");
    expect(ready2.replay).toBe("package.json\r\nsrc/\r\n");
    expect(ready2.recreated).toBe(false);

    // Reconnect without afterSeq -> receives full recent buffer!
    const conn3 = await TestWsClient.connect({
      port,
      path: `/api/terminal/ws?sessionId=${encodeURIComponent(sessionId1)}`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(conn3.statusCode).toBe(101);
    const ws3 = conn3.client!;
    const ready3 = await ws3.waitForMessage((m) => m.type === "ready");
    expect(ready3.replayMode).toBe("full");
    expect(ready3.replay).toBe("$ ls -la\r\nREADME.md\r\npackage.json\r\nsrc/\r\n");
    ws3.close();

    // 4. Restart on same WebSocket with new projectPath switches cwd and kills old PTY
    ws2.sendJson({ type: "restart", projectPath: projB, cols: 64, rows: 24 });
    const readyAfterRestart = await ws2.waitForMessage(
      (m) => m.type === "ready" && (m.session as Record<string, unknown>).cwd === projB,
    );
    const session2 = readyAfterRestart.session as Record<string, unknown>;
    expect(session2.id).not.toBe(sessionId1);
    expect(session2.cwd).toBe(projB);
    expect(mockPty.spawned[0].instance.killed).toBe(true);

    // 5. Regenerating token disconnects active terminal WS clients
    server.setToken("rotated-token-999");
    await ws2.waitForClose();
  });

  it("supports REST endpoints for terminal sessions and runs a real shell command end-to-end", async () => {
    const projectDir = makeTempDir("conductor-real-shell-");
    const token = "real-shell-token-123";
    const server = new RemoteBridgeServer(createDummyController(), {
      port: 0,
      host: "127.0.0.1",
      token,
      detectNetwork: () => ({ tailscaleIp: null, magicDnsName: null, lanIp: "127.0.0.1" }),
    });
    activeServers.push(server);
    await server.start();
    const port = server.getPort();

    // Create via REST
    const created = await httpJson(port, "POST", "/api/terminal/sessions", token, {
      projectPath: projectDir,
      cols: 80,
      rows: 24,
    });
    expect(created.status).toBe(200);
    const session = created.json.session as Record<string, unknown>;
    const sessionId = session.id as string;
    expect(session.cwd).toBe(projectDir);

    // List sessions
    const listRes = await httpJson(port, "GET", "/api/terminal/sessions", token);
    expect(listRes.status).toBe(200);
    expect((listRes.json.sessions as unknown[]).length).toBe(1);

    // Attach via WebSocket and execute `pwd`
    const conn = await TestWsClient.connect({
      port,
      path: `/api/terminal/ws?sessionId=${encodeURIComponent(sessionId)}`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(conn.statusCode).toBe(101);
    const ws = conn.client!;
    await ws.waitForMessage((m) => m.type === "ready");

    ws.sendJson({ type: "input", data: "pwd && echo CONDUCTOR_OK\n" });

    // Wait until combined output contains both the real projectDir and marker
    let combined = "";
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      combined = ws.messages
        .map((m) => (m.type === "ready" ? String(m.replay ?? "") : m.type === "output" ? String(m.data ?? "") : ""))
        .join("");
      if (combined.includes(projectDir) && combined.includes("CONDUCTOR_OK")) {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(combined).toContain(projectDir);
    expect(combined).toContain("CONDUCTOR_OK");

    // Inspect buffer via REST GET /api/terminal/sessions/:id
    const detail = await httpJson(port, "GET", `/api/terminal/sessions/${encodeURIComponent(sessionId)}`, token);
    expect(detail.status).toBe(200);
    expect(String(detail.json.buffer)).toContain("CONDUCTOR_OK");

    // Resize via REST
    const resizeRes = await httpJson(
      port,
      "POST",
      `/api/terminal/sessions/${encodeURIComponent(sessionId)}/resize`,
      token,
      { cols: 100, rows: 40 },
    );
    expect(resizeRes.status).toBe(200);
    expect((resizeRes.json.session as Record<string, unknown>).cols).toBe(100);

    // Delete session via REST
    const delRes = await httpJson(
      port,
      "DELETE",
      `/api/terminal/sessions/${encodeURIComponent(sessionId)}`,
      token,
    );
    expect(delRes.status).toBe(200);
    ws.close();
  });
});
