import { spawn as spawnChildProcess, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";
import {
  clampTerminalDimensions,
  formatShellDisplayName,
  type TerminalBackendKind,
  type TerminalCloseResult,
  type TerminalCreateOptions,
  type TerminalCreateResult,
  type TerminalDataEvent,
  type TerminalExitEvent,
  type TerminalResizeResult,
  type TerminalSessionInfo,
  type TerminalWriteResult,
} from "../shared/terminal.js";
import { canonicalDirectory, enrichedEnvironment } from "./shell-env.js";

export interface NodePtyDisposable {
  dispose(): void;
}

export interface NodePtyProcessLike {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): NodePtyDisposable;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): NodePtyDisposable;
}

export interface NodePtyModuleLike {
  spawn(
    file: string,
    args: string[] | string,
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
    },
  ): NodePtyProcessLike;
}

export interface PtyHandle {
  backend: TerminalBackendKind;
  pid: number | null;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (exitCode: number | null, signal?: number | null) => void): void;
}

export interface TerminalSpawnRequest {
  shell: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
}

export interface TerminalManagerOptions {
  onData: (event: TerminalDataEvent) => void;
  onExit: (event: TerminalExitEvent) => void;
  defaultCwd?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  loadNodePty?: () => NodePtyModuleLike | null;
  spawnPythonPty?: (req: TerminalSpawnRequest) => PtyHandle | null;
  spawnPipeShell?: (req: TerminalSpawnRequest) => PtyHandle;
}

const PYTHON_PTY_BRIDGE_SCRIPT = `
import errno, fcntl, os, pty, select, signal, struct, sys, termios

def set_winsize(fd, rows, cols):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except Exception:
        pass

cols = max(2, int(sys.argv[1]))
rows = max(1, int(sys.argv[2]))
shell = sys.argv[3]
args = sys.argv[4:]

master_fd, slave_fd = pty.openpty()
set_winsize(slave_fd, rows, cols)

pid = os.fork()
if pid == 0:
    os.setsid()
    try:
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
    except Exception:
        pass
    os.dup2(slave_fd, 0)
    os.dup2(slave_fd, 1)
    os.dup2(slave_fd, 2)
    os.close(master_fd)
    if slave_fd > 2:
        os.close(slave_fd)
    try:
        os.close(3)
    except Exception:
        pass
    os.execv(shell, [shell] + args)

os.close(slave_fd)
stdin_open = True
ctrl_open = True
ctrl_buf = b""
stdin_fd = 0
stdout_fd = 1
ctrl_fd = 3

try:
    while True:
        watch = [master_fd]
        if stdin_open:
            watch.append(stdin_fd)
        if ctrl_open:
            watch.append(ctrl_fd)
        try:
            ready, _, _ = select.select(watch, [], [], 0.2)
        except InterruptedError:
            continue
        except (OSError, ValueError):
            break

        if master_fd in ready:
            try:
                chunk = os.read(master_fd, 4096)
            except OSError as e:
                if e.errno in (errno.EIO, errno.EBADF):
                    break
                raise
            if not chunk:
                break
            os.write(stdout_fd, chunk)

        if stdin_open and stdin_fd in ready:
            try:
                data = os.read(stdin_fd, 4096)
            except OSError:
                data = b""
            if not data:
                stdin_open = False
                try:
                    os.killpg(pid, signal.SIGHUP)
                except Exception:
                    pass
                break
            try:
                os.write(master_fd, data)
            except OSError:
                break

        if ctrl_open and ctrl_fd in ready:
            try:
                cdata = os.read(ctrl_fd, 1024)
            except OSError:
                cdata = b""
            if not cdata:
                ctrl_open = False
            else:
                ctrl_buf += cdata
                while b"\\n" in ctrl_buf:
                    line, ctrl_buf = ctrl_buf.split(b"\\n", 1)
                    parts = line.decode("utf-8", "ignore").strip().split()
                    if len(parts) == 3 and parts[0] == "R":
                        try:
                            r = max(1, int(parts[1]))
                            c = max(2, int(parts[2]))
                            set_winsize(master_fd, r, c)
                            try:
                                os.killpg(pid, signal.SIGWINCH)
                            except Exception:
                                pass
                        except Exception:
                            pass

        try:
            wpid, status = os.waitpid(pid, os.WNOHANG)
            if wpid == pid:
                while True:
                    r2, _, _ = select.select([master_fd], [], [], 0.02)
                    if not r2:
                        break
                    try:
                        rem = os.read(master_fd, 4096)
                        if not rem:
                            break
                        os.write(stdout_fd, rem)
                    except OSError:
                        break
                code = os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else (status >> 8)
                sys.exit(code if code >= 0 else 128 + abs(code))
        except ChildProcessError:
            sys.exit(0)
finally:
    try:
        os.close(master_fd)
    except Exception:
        pass
    try:
        os.killpg(pid, signal.SIGHUP)
    except Exception:
        pass
    try:
        _, status = os.waitpid(pid, 0)
        code = os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else (status >> 8)
        sys.exit(code if code >= 0 else 128 + abs(code))
    except Exception:
        sys.exit(0)
`;

function getModuleRequire(): NodeRequire {
  if (typeof require === "function") {
    return require;
  }
  return createRequire(import.meta.url);
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform !== "win32") {
      fs.accessSync(filePath, fs.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

export function resolveDefaultShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  checkExecutable: (filePath: string) => boolean = isExecutableFile,
): { shell: string; args: string[] } {
  if (platform === "win32") {
    const sysRoot = env.SystemRoot || env.WINDIR || "C:\\Windows";
    const psCandidates = [
      path.win32.join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ];
    for (const candidate of psCandidates) {
      if (checkExecutable(candidate)) {
        return { shell: candidate, args: [] };
      }
    }
    const comspec = env.COMSPEC?.trim();
    return { shell: comspec || "powershell.exe", args: [] };
  }

  const envShell = env.SHELL?.trim();
  const candidates = [
    ...(envShell ? [envShell] : []),
    "/bin/zsh",
    "/bin/bash",
    "/usr/bin/zsh",
    "/usr/bin/bash",
    "/bin/sh",
  ];

  let resolved = "/bin/sh";
  for (const candidate of candidates) {
    if (checkExecutable(candidate)) {
      resolved = candidate;
      break;
    }
  }

  const base = formatShellDisplayName(resolved).toLowerCase();
  const args = base === "zsh" || base === "bash" || base === "fish" ? ["-l"] : [];
  return { shell: resolved, args };
}

export function resolveTerminalCwd(
  requestedCwd?: string | null,
  fallbackCwd?: string | null,
): string {
  for (const candidate of [requestedCwd, fallbackCwd]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      const resolved = canonicalDirectory(candidate.trim());
      if (resolved) return resolved;
    }
  }

  try {
    const home = os.homedir();
    if (home && fs.existsSync(home) && fs.statSync(home).isDirectory()) {
      return home;
    }
  } catch {
    // ignore
  }
  return process.cwd();
}

export function buildTerminalEnvironment(
  platform: NodeJS.Platform = process.platform,
  baseEnv?: NodeJS.ProcessEnv,
): Record<string, string> {
  const sourceEnv: NodeJS.ProcessEnv =
    baseEnv ?? (platform === "win32" ? process.env : enrichedEnvironment());

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined) continue;
    if (key === "ELECTRON_RUN_AS_NODE") continue;
    result[key] = value;
  }

  result.TERM = "xterm-256color";
  result.COLORTERM = "truecolor";
  result.TERM_PROGRAM = "Conductor";
  return result;
}

/**
 * Ensures `node-pty`'s `spawn-helper` binary has executable permissions on POSIX.
 * pnpm / tarball extraction on macOS can leave `prebuilds/<platform>-<arch>/spawn-helper`
 * with mode 0644, causing `Error: posix_spawnp failed.` at runtime.
 */
export function ensureNodePtySpawnHelperExecutable(
  requireFn: NodeRequire = getModuleRequire(),
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): void {
  if (platform === "win32") return;
  try {
    const pkgJsonPath = requireFn.resolve("node-pty/package.json");
    const pkgDir = path.dirname(pkgJsonPath);
    const candidates = [
      path.join(pkgDir, "prebuilds", `${platform}-${arch}`, "spawn-helper"),
      path.join(pkgDir, "build", "Release", "spawn-helper"),
      path.join(pkgDir, "build", "Debug", "spawn-helper"),
    ];
    for (const helperPath of candidates) {
      try {
        const stat = fs.statSync(helperPath);
        if (stat.isFile() && (stat.mode & 0o111) === 0) {
          fs.chmodSync(helperPath, stat.mode | 0o755);
        }
      } catch {
        // candidate doesn't exist or isn't writable
      }
    }
  } catch {
    // node-pty not resolvable; caller will handle fallback
  }
}

function defaultLoadNodePty(): NodePtyModuleLike | null {
  try {
    const req = getModuleRequire();
    ensureNodePtySpawnHelperExecutable(req);
    const mod = req("node-pty") as NodePtyModuleLike;
    if (mod && typeof mod.spawn === "function") {
      return mod;
    }
    return null;
  } catch {
    return null;
  }
}

function createNodePtyHandle(mod: NodePtyModuleLike, req: TerminalSpawnRequest): PtyHandle {
  const proc = mod.spawn(req.shell, req.args, {
    name: "xterm-256color",
    cols: req.cols,
    rows: req.rows,
    cwd: req.cwd,
    env: req.env,
  });

  let dataDisposer: NodePtyDisposable | null = null;
  let exitDisposer: NodePtyDisposable | null = null;

  return {
    backend: "node-pty",
    pid: typeof proc.pid === "number" ? proc.pid : null,
    write: (data: string) => {
      proc.write(data);
    },
    resize: (cols: number, rows: number) => {
      proc.resize(cols, rows);
    },
    kill: () => {
      dataDisposer?.dispose();
      exitDisposer?.dispose();
      dataDisposer = null;
      exitDisposer = null;
      try {
        proc.kill();
      } catch {
        // ignore if already exited
      }
    },
    onData: (listener) => {
      dataDisposer?.dispose();
      dataDisposer = proc.onData(listener);
    },
    onExit: (listener) => {
      exitDisposer?.dispose();
      exitDisposer = proc.onExit(({ exitCode, signal }) => {
        listener(exitCode ?? null, signal ?? null);
      });
    },
  };
}

function resolvePython3Executable(): string | null {
  const candidates = ["/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"];
  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return "python3";
}

function defaultSpawnPythonPty(req: TerminalSpawnRequest): PtyHandle | null {
  if (process.platform === "win32") return null;
  const pythonBin = resolvePython3Executable();
  if (!pythonBin) return null;

  let child: ChildProcess;
  try {
    child = spawnChildProcess(
      pythonBin,
      ["-u", "-c", PYTHON_PTY_BRIDGE_SCRIPT, String(req.cols), String(req.rows), req.shell, ...req.args],
      {
        cwd: req.cwd,
        env: req.env,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
      },
    );
  } catch {
    return null;
  }

  const ctrlStream = child.stdio[3] as Writable | null;
  let dataListener: ((data: string) => void) | null = null;
  let exitListener: ((exitCode: number | null, signal?: number | null) => void) | null = null;
  let exited = false;

  const emitExit = (code: number | null) => {
    if (exited) return;
    exited = true;
    exitListener?.(code, null);
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    dataListener?.(chunk.toString("utf8"));
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    dataListener?.(chunk.toString("utf8"));
  });
  child.on("error", () => {
    emitExit(1);
  });
  child.on("exit", (code) => {
    emitExit(code);
  });

  return {
    backend: "python-pty",
    pid: child.pid ?? null,
    write: (data: string) => {
      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.write(data);
      }
    },
    resize: (cols: number, rows: number) => {
      if (ctrlStream && !ctrlStream.destroyed) {
        ctrlStream.write(`R ${rows} ${cols}\n`);
      }
    },
    kill: () => {
      try {
        ctrlStream?.end();
      } catch {
        // ignore
      }
      try {
        child.kill("SIGHUP");
      } catch {
        // ignore
      }
      setTimeout(() => {
        if (!exited) {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }
      }, 300).unref();
    },
    onData: (listener) => {
      dataListener = listener;
    },
    onExit: (listener) => {
      exitListener = listener;
    },
  };
}

function defaultSpawnPipeShell(req: TerminalSpawnRequest): PtyHandle {
  const pipeArgs =
    process.platform === "win32"
      ? req.args
      : req.args.includes("-i")
        ? req.args
        : [...req.args, "-i"];

  const child = spawnChildProcess(req.shell, pipeArgs, {
    cwd: req.cwd,
    env: req.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let dataListener: ((data: string) => void) | null = null;
  let exitListener: ((exitCode: number | null, signal?: number | null) => void) | null = null;
  let exited = false;

  const emitExit = (code: number | null) => {
    if (exited) return;
    exited = true;
    exitListener?.(code, null);
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    dataListener?.(chunk.toString("utf8"));
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    dataListener?.(chunk.toString("utf8"));
  });
  child.on("error", (err) => {
    dataListener?.(`\r\n${err.message}\r\n`);
    emitExit(1);
  });
  child.on("exit", (code) => {
    emitExit(code);
  });

  return {
    backend: "pipe",
    pid: child.pid ?? null,
    write: (data: string) => {
      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.write(data);
      }
    },
    resize: () => {
      // Pipe fallback does not support PTY window size ioctl
    },
    kill: () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      setTimeout(() => {
        if (!exited) {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }
      }, 300).unref();
    },
    onData: (listener) => {
      dataListener = listener;
    },
    onExit: (listener) => {
      exitListener = listener;
    },
  };
}

interface ManagedTerminalSession {
  info: TerminalSessionInfo;
  handle: PtyHandle;
  closed: boolean;
}

export class TerminalManager {
  private readonly sessions = new Map<string, ManagedTerminalSession>();
  private readonly onDataCallback: (event: TerminalDataEvent) => void;
  private readonly onExitCallback: (event: TerminalExitEvent) => void;
  private readonly defaultCwd?: string;
  private readonly platform: NodeJS.Platform;
  private readonly envOverride?: NodeJS.ProcessEnv;
  private readonly loadNodePty: () => NodePtyModuleLike | null;
  private readonly spawnPythonPty: (req: TerminalSpawnRequest) => PtyHandle | null;
  private readonly spawnPipeShell: (req: TerminalSpawnRequest) => PtyHandle;

  constructor(options: TerminalManagerOptions) {
    this.onDataCallback = options.onData;
    this.onExitCallback = options.onExit;
    this.defaultCwd = options.defaultCwd;
    this.platform = options.platform ?? process.platform;
    this.envOverride = options.env;
    this.loadNodePty = options.loadNodePty ?? defaultLoadNodePty;
    this.spawnPythonPty = options.spawnPythonPty ?? defaultSpawnPythonPty;
    this.spawnPipeShell = options.spawnPipeShell ?? defaultSpawnPipeShell;
  }

  create(options: TerminalCreateOptions = {}): TerminalCreateResult {
    const id = options.id?.trim() || `term-${crypto.randomUUID()}`;

    // Replace any stale session sharing the same ID cleanly
    if (this.sessions.has(id)) {
      this.close(id);
    }

    const { cols, rows } = clampTerminalDimensions(options.cols, options.rows);
    const cwd = resolveTerminalCwd(options.cwd, this.defaultCwd);
    const env = buildTerminalEnvironment(this.platform, this.envOverride);
    const { shell, args } = resolveDefaultShell(this.platform, env);
    const req: TerminalSpawnRequest = { shell, args, cwd, cols, rows, env };

    let handle: PtyHandle | null = null;
    const errors: string[] = [];

    // 1. Primary backend: node-pty native PTY
    try {
      const nodePty = this.loadNodePty();
      if (nodePty) {
        handle = createNodePtyHandle(nodePty, req);
      }
    } catch (err) {
      errors.push(`node-pty: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 2. POSIX fallback: python3 stdlib PTY bridge (real PTY with colors & TIOCSWINSZ resize)
    if (!handle && this.platform !== "win32") {
      try {
        handle = this.spawnPythonPty(req);
      } catch (err) {
        errors.push(`python-pty: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 3. Universal last-resort fallback: child_process pipe shell
    if (!handle) {
      try {
        handle = this.spawnPipeShell(req);
      } catch (err) {
        errors.push(`pipe: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (!handle) {
      return {
        ok: false,
        error: errors.join(" | ") || "Failed to spawn terminal shell.",
      };
    }

    const info: TerminalSessionInfo = {
      id,
      shell,
      shellName: formatShellDisplayName(shell),
      cwd,
      pid: handle.pid,
      backend: handle.backend,
      cols,
      rows,
    };

    const managed: ManagedTerminalSession = {
      info,
      handle,
      closed: false,
    };
    this.sessions.set(id, managed);

    handle.onData((data) => {
      if (managed.closed) return;
      this.onDataCallback({ sessionId: id, data });
    });

    handle.onExit((exitCode, signal) => {
      if (managed.closed) return;
      managed.closed = true;
      this.sessions.delete(id);
      this.onExitCallback({ sessionId: id, exitCode, signal: signal ?? null });
    });

    return { ok: true, session: info };
  }

  write(sessionId: string, data: string): TerminalWriteResult {
    const managed = this.sessions.get(sessionId);
    if (!managed || managed.closed) {
      return { ok: false, error: `Terminal session not found: ${sessionId}` };
    }
    try {
      managed.handle.write(data);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  resize(sessionId: string, cols: number, rows: number): TerminalResizeResult {
    const managed = this.sessions.get(sessionId);
    if (!managed || managed.closed) {
      return { ok: false, error: `Terminal session not found: ${sessionId}` };
    }
    const clamped = clampTerminalDimensions(cols, rows);
    try {
      managed.handle.resize(clamped.cols, clamped.rows);
      managed.info.cols = clamped.cols;
      managed.info.rows = clamped.rows;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  close(sessionId: string): TerminalCloseResult {
    const managed = this.sessions.get(sessionId);
    if (!managed) {
      return { ok: false };
    }
    managed.closed = true;
    this.sessions.delete(sessionId);
    try {
      managed.handle.kill();
    } catch {
      // ignore kill errors
    }
    return { ok: true };
  }

  disposeAll(): void {
    const ids = Array.from(this.sessions.keys());
    for (const id of ids) {
      this.close(id);
    }
  }

  getSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }
}
