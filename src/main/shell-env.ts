import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function resolveCodexExecutable(): string | null {
  const home = os.homedir();
  const candidates = [
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    path.join(home, ".local/bin/codex"),
    path.join(home, ".cargo/bin/codex"),
  ];

  const nvmDir = path.join(home, ".nvm/versions/node");
  if (fs.existsSync(nvmDir)) {
    try {
      const versions = fs.readdirSync(nvmDir).sort().reverse();
      for (const v of versions) {
        candidates.push(path.join(nvmDir, v, "bin/codex"));
      }
    } catch {
      // ignore
    }
  }

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }

  try {
    const out = execFileSync("/bin/zsh", ["-lc", "command -v codex"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    if (out && fs.existsSync(out)) {
      return out;
    }
  } catch {
    // ignore
  }
  return null;
}

export function resolveAgyExecutable(): string | null {
  const home = os.homedir();
  const candidates = [
    path.join(home, ".local/bin/agy"),
    "/opt/homebrew/bin/agy",
    "/usr/local/bin/agy",
  ];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  try {
    const out = execFileSync("/bin/zsh", ["-lc", "command -v agy"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    if (out && fs.existsSync(out)) return out;
  } catch {
    // ignore
  }
  return null;
}

export function resolveClaudeExecutable(): string | null {
  const home = os.homedir();
  const candidates = [
    path.join(home, ".local/bin/claude"),
    path.join(home, ".claude/local/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];

  // Also check VS Code's shared ms-vscode.vscode-claude-sdk extension bundle
  const vscodeExtDir = path.join(home, ".vscode/extensions");
  if (fs.existsSync(vscodeExtDir)) {
    try {
      const dirs = fs
        .readdirSync(vscodeExtDir)
        .filter((d) => d.startsWith("ms-vscode.vscode-claude-sdk-"))
        .sort()
        .reverse();
      for (const dir of dirs) {
        candidates.push(
          path.join(
            vscodeExtDir,
            dir,
            "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude",
          ),
          path.join(
            vscodeExtDir,
            dir,
            "node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64/claude",
          ),
        );
      }
    } catch {
      // ignore
    }
  }

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }

  try {
    const out = execFileSync("/bin/zsh", ["-lc", "command -v claude"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    if (out && fs.existsSync(out)) return out;
  } catch {
    // ignore
  }
  return null;
}

export function resolveGhExecutable(): string | null {
  const home = os.homedir();
  const candidates = [
    "/opt/homebrew/bin/gh",
    "/usr/local/bin/gh",
    path.join(home, ".local/bin/gh"),
  ];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  try {
    const out = execFileSync("/bin/zsh", ["-lc", "command -v gh"], {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
    if (out && fs.existsSync(out)) return out;
  } catch {
    // ignore
  }
  return null;
}

export function enrichedEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const home = os.homedir();
  const existing = (process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(":");
  const prefixes = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    path.join(home, ".local/bin"),
    path.join(home, ".cargo/bin"),
  ];
  const nvmDir = path.join(home, ".nvm/versions/node");
  if (fs.existsSync(nvmDir)) {
    try {
      const latest = fs.readdirSync(nvmDir).sort().at(-1);
      if (latest) {
        prefixes.push(path.join(nvmDir, latest, "bin"));
      }
    } catch {
      // ignore
    }
  }
  const merged: string[] = [];
  for (const dir of [...prefixes, ...existing]) {
    if (dir && !merged.includes(dir)) {
      merged.push(dir);
    }
  }
  return {
    ...process.env,
    PATH: merged.join(":"),
    ...extra,
  };
}

export function canonicalDirectory(inputPath: string): string | null {
  const expanded = inputPath.startsWith("~")
    ? path.join(os.homedir(), inputPath.slice(1))
    : inputPath;
  try {
    const stat = fs.statSync(expanded);
    if (!stat.isDirectory()) return null;
    return fs.realpathSync(expanded);
  } catch {
    return null;
  }
}

export function getGitBranch(dir: string): string | null {
  try {
    const out = execFileSync("/usr/bin/git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export function getGitStatusSummary(dir: string): string | null {
  try {
    const out = execFileSync("/usr/bin/git", ["-C", dir, "status", "--short"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || "(clean working tree)";
  } catch {
    return null;
  }
}

export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^(https?|file|about|chrome):\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/.*)?$/i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  if (trimmed.includes(".") && !trimmed.includes(" ")) {
    return `https://${trimmed}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

export function shortTitleFromUrl(urlString: string): string {
  if (!urlString) return "New Tab";
  try {
    const u = new URL(urlString);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname || urlString;
  } catch {
    return urlString;
  }
}
