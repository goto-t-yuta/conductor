import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildTerminalEnvironment,
  resolveDefaultShell,
  resolveTerminalCwd,
  TerminalManager,
  type NodePtyModuleLike,
  type NodePtyProcessLike,
  type PtyHandle,
} from "../src/main/terminal-manager.js";
import { TerminalOutputStore } from "../src/renderer/lib/terminal-session-store.js";
import {
  CONDUCTOR_TERMINAL_DARK_THEME,
  CONDUCTOR_TERMINAL_LIGHT_THEME,
  getConductorTerminalTheme,
} from "../src/renderer/lib/terminal-theme.js";
import {
  buildTerminalTabTitle,
  clampTerminalDimensions,
  formatShellDisplayName,
  type TerminalDataEvent,
  type TerminalExitEvent,
} from "../src/shared/terminal.js";

const tempDirs: string[] = [];
const managersToDispose: TerminalManager[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (managersToDispose.length > 0) {
    managersToDispose.pop()!.disposeAll();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
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
  let nextPid = 41000;

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
          return {
            dispose: () => {
              dataCb = null;
            },
          };
        },
        onExit: (listener) => {
          exitCb = listener;
          return {
            dispose: () => {
              exitCb = null;
            },
          };
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

describe("Shared terminal helpers (src/shared/terminal.ts)", () => {
  it("clamps terminal dimensions and formats shell names & numbered tab titles", () => {
    expect(clampTerminalDimensions(undefined, undefined)).toEqual({ cols: 80, rows: 24 });
    expect(clampTerminalDimensions(1, 0)).toEqual({ cols: 2, rows: 1 });
    expect(clampTerminalDimensions(999, 500)).toEqual({ cols: 500, rows: 200 });
    expect(clampTerminalDimensions(120.7, 36.4)).toEqual({ cols: 120, rows: 36 });

    expect(formatShellDisplayName("/bin/zsh")).toBe("zsh");
    expect(formatShellDisplayName("/usr/local/bin/bash")).toBe("bash");
    expect(formatShellDisplayName("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toBe(
      "powershell",
    );
    expect(formatShellDisplayName("")).toBe("shell");

    expect(buildTerminalTabTitle("zsh", 1)).toBe("zsh");
    expect(buildTerminalTabTitle("zsh", 2)).toBe("zsh #2");
    expect(buildTerminalTabTitle(null, 1, "ターミナル")).toBe("ターミナル");
    expect(buildTerminalTabTitle(null, 3, "Terminal")).toBe("Terminal #3");
  });
});

describe("Main-process TerminalManager (src/main/terminal-manager.ts)", () => {
  it("resolves default shell for macOS/Linux and Windows platforms", () => {
    const posixZsh = resolveDefaultShell(
      "darwin",
      { SHELL: "/bin/zsh" },
      (p) => p === "/bin/zsh",
    );
    expect(posixZsh).toEqual({ shell: "/bin/zsh", args: ["-l"] });

    const posixFallbackBash = resolveDefaultShell(
      "linux",
      { SHELL: "/nonexistent/fish" },
      (p) => p === "/bin/bash",
    );
    expect(posixFallbackBash).toEqual({ shell: "/bin/bash", args: ["-l"] });

    const posixSh = resolveDefaultShell("linux", {}, (p) => p === "/bin/sh");
    expect(posixSh).toEqual({ shell: "/bin/sh", args: [] });

    const winPs = resolveDefaultShell(
      "win32",
      { SystemRoot: "C:\\Windows", COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
      (p) => p.toLowerCase().endsWith("powershell.exe"),
    );
    expect(winPs.shell).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(winPs.args).toEqual([]);

    const winCmd = resolveDefaultShell(
      "win32",
      { COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
      () => false,
    );
    expect(winCmd).toEqual({ shell: "C:\\Windows\\System32\\cmd.exe", args: [] });
  });

  it("resolves initial cwd to project directory and falls back cleanly when invalid or omitted", () => {
    const projectDir = makeTempDir("conductor-term-proj-");
    const fallbackDir = makeTempDir("conductor-term-fallback-");

    expect(resolveTerminalCwd(projectDir, fallbackDir)).toBe(fs.realpathSync(projectDir));
    expect(resolveTerminalCwd("/definitely/does/not/exist/conductor", fallbackDir)).toBe(
      fs.realpathSync(fallbackDir),
    );
    expect(resolveTerminalCwd(null, null)).toBe(os.homedir());
  });

  it("builds terminal environment with xterm-256color, truecolor, and strips ELECTRON_RUN_AS_NODE", () => {
    const env = buildTerminalEnvironment("darwin", {
      PATH: "/usr/bin:/bin",
      HOME: "/Users/dev",
      ELECTRON_RUN_AS_NODE: "1",
    });
    expect(env.TERM).toBe("xterm-256color");
    expect(env.COLORTERM).toBe("truecolor");
    expect(env.TERM_PROGRAM).toBe("Conductor");
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it("manages multiple concurrent terminal sessions, I/O, resize, exit, and clean process teardown", () => {
    const dataEvents: TerminalDataEvent[] = [];
    const exitEvents: TerminalExitEvent[] = [];
    const projectDir = makeTempDir("conductor-term-multi-");
    const mock = createMockNodePty();

    const manager = new TerminalManager({
      onData: (ev) => dataEvents.push(ev),
      onExit: (ev) => exitEvents.push(ev),
      loadNodePty: () => mock.mod,
    });
    managersToDispose.push(manager);

    const s1 = manager.create({ id: "t-1", cwd: projectDir, cols: 100, rows: 30 });
    const s2 = manager.create({ id: "t-2", cwd: null, cols: 80, rows: 24 });

    expect(s1.ok).toBe(true);
    expect(s1.session?.id).toBe("t-1");
    expect(s1.session?.backend).toBe("node-pty");
    expect(s1.session?.cwd).toBe(fs.realpathSync(projectDir));
    expect(s2.ok).toBe(true);
    expect(s2.session?.cwd).toBe(os.homedir());
    expect(manager.getSessionIds().sort()).toEqual(["t-1", "t-2"]);

    // Write & resize
    expect(manager.write("t-1", "ls -la\r")).toEqual({ ok: true });
    expect(mock.spawned[0].instance.writes).toEqual(["ls -la\r"]);
    expect(manager.resize("t-1", 132, 42)).toEqual({ ok: true });
    expect(mock.spawned[0].instance.resizes).toEqual([{ cols: 132, rows: 42 }]);

    // Data event forwarding
    mock.spawned[0].instance.emitData("\x1b[32mhello\x1b[0m\r\n");
    expect(dataEvents).toEqual([{ sessionId: "t-1", data: "\x1b[32mhello\x1b[0m\r\n" }]);

    // Closing t-1 kills PTY and suppresses any further events from it
    expect(manager.close("t-1")).toEqual({ ok: true });
    expect(mock.spawned[0].instance.killed).toBe(true);
    expect(manager.hasSession("t-1")).toBe(false);
    expect(manager.write("t-1", "after-close").ok).toBe(false);

    mock.spawned[0].instance.emitData("ignored");
    mock.spawned[0].instance.emitExit(0);
    expect(dataEvents).toHaveLength(1);
    expect(exitEvents).toHaveLength(0);

    // Natural exit on t-2 emits exit event and cleans up session
    mock.spawned[1].instance.emitExit(130, 2);
    expect(exitEvents).toEqual([{ sessionId: "t-2", exitCode: 130, signal: 2 }]);
    expect(manager.hasSession("t-2")).toBe(false);
  });

  it("falls back from node-pty to python-pty and then to pipe backend when native PTY fails", () => {
    const dataEvents: TerminalDataEvent[] = [];
    const exitEvents: TerminalExitEvent[] = [];

    const makeFakeHandle = (backend: "python-pty" | "pipe"): PtyHandle => {
      let onDataCb: ((d: string) => void) | null = null;
      return {
        backend,
        pid: backend === "python-pty" ? 50001 : 50002,
        write: (d) => onDataCb?.(`echo:${d}`),
        resize: vi.fn(),
        kill: vi.fn(),
        onData: (cb) => {
          onDataCb = cb;
        },
        onExit: vi.fn(),
      };
    };

    // Case 1: node-pty fails -> python-pty succeeds
    const mgrPython = new TerminalManager({
      platform: "darwin",
      onData: (ev) => dataEvents.push(ev),
      onExit: (ev) => exitEvents.push(ev),
      loadNodePty: () => {
        throw new Error("ABI mismatch");
      },
      spawnPythonPty: () => makeFakeHandle("python-pty"),
      spawnPipeShell: () => makeFakeHandle("pipe"),
    });
    managersToDispose.push(mgrPython);

    const r1 = mgrPython.create({ id: "fallback-py" });
    expect(r1.ok).toBe(true);
    expect(r1.session?.backend).toBe("python-pty");
    mgrPython.write("fallback-py", "hi");
    expect(dataEvents).toEqual([{ sessionId: "fallback-py", data: "echo:hi" }]);

    // Case 2: both node-pty and python-pty unavailable -> pipe succeeds
    const mgrPipe = new TerminalManager({
      platform: "darwin",
      onData: (ev) => dataEvents.push(ev),
      onExit: (ev) => exitEvents.push(ev),
      loadNodePty: () => null,
      spawnPythonPty: () => null,
      spawnPipeShell: () => makeFakeHandle("pipe"),
    });
    managersToDispose.push(mgrPipe);

    const r2 = mgrPipe.create({ id: "fallback-pipe" });
    expect(r2.ok).toBe(true);
    expect(r2.session?.backend).toBe("pipe");
  });

  it("spawns a real interactive PTY session end-to-end, executes commands in project cwd, resizes, and cleans up", async () => {
    const projectDir = makeTempDir("conductor-real-pty-");
    const realProjectDir = fs.realpathSync(projectDir);
    let output = "";
    const exited: TerminalExitEvent[] = [];

    const manager = new TerminalManager({
      onData: (ev) => {
        if (ev.sessionId === "real-1") {
          output += ev.data;
        }
      },
      onExit: (ev) => exited.push(ev),
    });
    managersToDispose.push(manager);

    const created = manager.create({ id: "real-1", cwd: projectDir, cols: 90, rows: 24 });
    expect(created.ok).toBe(true);
    expect(created.session?.cwd).toBe(realProjectDir);
    expect(created.session?.pid).toBeTruthy();

    expect(manager.resize("real-1", 110, 32)).toEqual({ ok: true });
    expect(
      manager.write("real-1", "pwd && echo __CONDUCTOR_PTY_MARKER__ && exit 0\r"),
    ).toEqual({ ok: true });

    // Wait up to 4s for command output and exit
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && (!output.includes("__CONDUCTOR_PTY_MARKER__") || exited.length === 0)) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(output).toContain(realProjectDir);
    expect(output).toContain("__CONDUCTOR_PTY_MARKER__");
    expect(exited.length).toBeGreaterThanOrEqual(1);
    expect(exited[0].sessionId).toBe("real-1");
    expect(manager.hasSession("real-1")).toBe(false);
  });
});

describe("TerminalOutputStore & Conductor terminal theme helpers", () => {
  it("buffers output per session with bounded capacity and replays snapshots", () => {
    const store = new TerminalOutputStore(2048);
    const received: string[] = [];

    store.append("s1", "hello ");
    const unsub = store.subscribe("s1", (chunk) => received.push(chunk));
    store.append("s1", "world");

    expect(store.getSnapshot("s1")).toBe("hello world");
    expect(received).toEqual(["world"]);

    unsub();
    store.append("s1", "!");
    expect(received).toEqual(["world"]);
    expect(store.getSnapshot("s1")).toBe("hello world!");

    // Enforce bounded cap
    store.append("s1", "x".repeat(3000));
    expect(store.getSnapshot("s1").length).toBeLessThanOrEqual(2048);

    store.clearBuffer("s1");
    expect(store.getSnapshot("s1")).toBe("");

    store.delete("s1");
    expect(store.getSnapshot("s1")).toBe("");
  });

  it("returns distinct light and dark Conductor terminal palettes", () => {
    const dark = getConductorTerminalTheme(true);
    const light = getConductorTerminalTheme(false);
    expect(dark).toEqual(CONDUCTOR_TERMINAL_DARK_THEME);
    expect(light).toEqual(CONDUCTOR_TERMINAL_LIGHT_THEME);
    expect(dark.background).not.toBe(light.background);
    expect(dark.foreground).not.toBe(light.foreground);
  });
});
