import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROJECT_PALETTE, type Project, type ProjectSource } from "../shared/types.js";
import { canonicalDirectory, getGitBranch } from "./shell-env.js";

export interface DiscoveredProjectSeed {
  path: string;
  name?: string;
  source: ProjectSource;
  lastActiveAt: number; // epoch ms
}

const SKIP_HOME_DIRS = new Set([
  "Applications",
  "Backups",
  "Desktop",
  "Documents",
  "Downloads",
  "Library",
  "Movies",
  "Music",
  "Pictures",
  "Public",
  "Sites",
  "bin",
  "go",
  "tmp",
  "node_modules",
]);

const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "Cargo.toml",
  "Package.swift",
  "pyproject.toml",
  "go.mod",
];

function isProjectDirectory(dirPath: string, requireGitOnly: boolean): boolean {
  if (requireGitOnly) {
    return fs.existsSync(path.join(dirPath, ".git"));
  }
  return PROJECT_MARKERS.some((marker) => fs.existsSync(path.join(dirPath, marker)));
}

function directoryMtimeMs(dirPath: string): number {
  try {
    const gitHead = path.join(dirPath, ".git", "HEAD");
    if (fs.existsSync(gitHead)) {
      return Math.max(fs.statSync(gitHead).mtimeMs, fs.statSync(dirPath).mtimeMs);
    }
    return fs.statSync(dirPath).mtimeMs;
  } catch {
    return 0;
  }
}

export function scanLocalProjectSeeds(options?: {
  roots?: Array<{ dir: string; requireGitOnly: boolean }>;
  excludePaths?: string[];
}): DiscoveredProjectSeed[] {
  const home = os.homedir();
  const roots = options?.roots ?? [
    { dir: path.join(home, "Documents"), requireGitOnly: false },
    { dir: home, requireGitOnly: true },
  ];
  const excluded = new Set(
    (options?.excludePaths ?? [])
      .map((p) => canonicalDirectory(p))
      .filter((p): p is string => Boolean(p)),
  );
  excluded.add(canonicalDirectory(home) ?? home);

  const found = new Map<string, DiscoveredProjectSeed>();

  for (const root of roots) {
    if (!fs.existsSync(root.dir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      if (root.dir === home && SKIP_HOME_DIRS.has(entry.name)) continue;

      const fullPath = path.join(root.dir, entry.name);
      if (!isProjectDirectory(fullPath, root.requireGitOnly)) continue;

      const canonical = canonicalDirectory(fullPath);
      if (!canonical || excluded.has(canonical)) continue;

      const mtime = directoryMtimeMs(canonical);
      const prev = found.get(canonical);
      if (!prev || mtime > prev.lastActiveAt) {
        found.set(canonical, {
          path: canonical,
          name: path.basename(canonical),
          source: "workspace_scan",
          lastActiveAt: mtime,
        });
      }
    }
  }

  return [...found.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

export function mergeDiscoveredProjects(options: {
  existing: Project[];
  seeds: DiscoveredProjectSeed[];
  excludePaths?: string[];
  resolveGitBranchForTopN?: number;
}): Project[] {
  const home = canonicalDirectory(os.homedir()) ?? os.homedir();
  const excluded = new Set(
    (options.excludePaths ?? [])
      .map((p) => canonicalDirectory(p))
      .filter((p): p is string => Boolean(p)),
  );
  excluded.add(home);
  excluded.add("/");

  const byPath = new Map<string, Project>();
  for (const p of options.existing) {
    const canonical = canonicalDirectory(p.path);
    if (!canonical || excluded.has(canonical)) continue;
    byPath.set(canonical, { ...p, path: canonical });
  }

  for (const seed of options.seeds) {
    const canonical = canonicalDirectory(seed.path);
    if (!canonical || excluded.has(canonical)) continue;

    const existing = byPath.get(canonical);
    const seedIso = new Date(seed.lastActiveAt || Date.now()).toISOString();

    if (existing) {
      const existingTime = existing.lastActiveAt ? Date.parse(existing.lastActiveAt) : 0;
      const mergedSource: ProjectSource =
        existing.source === "manual"
          ? "manual"
          : seed.source === "codex_history"
            ? "codex_history"
            : existing.source ?? seed.source;
      byPath.set(canonical, {
        ...existing,
        source: mergedSource,
        lastActiveAt: seed.lastActiveAt > existingTime ? seedIso : existing.lastActiveAt ?? seedIso,
      });
    } else {
      const colorIndex = byPath.size % PROJECT_PALETTE.length;
      byPath.set(canonical, {
        id: crypto.randomUUID(),
        name: seed.name?.trim() || path.basename(canonical) || canonical,
        path: canonical,
        colorHex: PROJECT_PALETTE[colorIndex],
        gitBranch: null,
        addedAt: new Date().toISOString(),
        lastActiveAt: seedIso,
        source: seed.source,
      });
    }
  }

  // Sort: manual & codex_history boosted by recency, then workspace_scan by recency
  const sorted = [...byPath.values()].sort((a, b) => {
    const score = (p: Project) => {
      const t = p.lastActiveAt ? Date.parse(p.lastActiveAt) : Date.parse(p.addedAt);
      const sourceBoost =
        p.source === "manual"
          ? 1_000_000_000_000
          : p.source === "codex_history"
            ? 500_000_000_000
            : 0;
      return sourceBoost + (Number.isFinite(t) ? t : 0);
    };
    return score(b) - score(a);
  });

  const branchLimit = options.resolveGitBranchForTopN ?? 30;
  for (let i = 0; i < Math.min(branchLimit, sorted.length); i += 1) {
    if (!sorted[i].gitBranch) {
      sorted[i] = { ...sorted[i], gitBranch: getGitBranch(sorted[i].path) };
    }
  }

  return sorted;
}
