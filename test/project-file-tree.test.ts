import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listProjectDirectory, readLocalTextFile } from "../src/main/project-files.js";
import {
  classifyProjectFile,
  DEFAULT_IGNORED_NAMES,
  detectCodeLanguageLabel,
  filterFileTreeEntries,
  isBufferLikelyBinary,
  MAX_TEXT_FILE_BYTES,
  sortDirectoryEntries,
  type ProjectFileEntry,
} from "../src/shared/file-tree.js";
import type { Project } from "../src/shared/types.js";
import {
  activateTabInWorkspace,
  buildProjectSwitcherItems,
  closeTabInWorkspace,
  createEmptyRightPaneWorkspaceState,
  getActiveUnifiedTab,
  getProjectUnifiedTabs,
  makeBrowserUnifiedTabId,
  makeCodeUnifiedTabId,
  makeMarkdownUnifiedTabId,
  parseUnifiedTabId,
  reconcileWorkspaceState,
  serializeRightPaneWorkspace,
  type CodeViewerTab,
  type MarkdownViewerTab,
} from "../src/renderer/lib/right-pane-tabs.js";

describe("Project File Tree classification & helpers", () => {
  it("classifies markdown, image, code/text, and binary files accurately", () => {
    // Markdown
    expect(classifyProjectFile("README.md")).toBe("markdown");
    expect(classifyProjectFile("/repo/docs/guide.markdown")).toBe("markdown");
    expect(classifyProjectFile("spec.MDX")).toBe("markdown");

    // Image
    expect(classifyProjectFile("logo.png")).toBe("image");
    expect(classifyProjectFile("photo.JPG")).toBe("image");
    expect(classifyProjectFile("banner.jpeg")).toBe("image");
    expect(classifyProjectFile("hero.webp")).toBe("image");
    expect(classifyProjectFile("anim.gif")).toBe("image");
    expect(classifyProjectFile("icon.svg")).toBe("image");

    // Code / text / config / extensionless
    expect(classifyProjectFile("index.ts")).toBe("code");
    expect(classifyProjectFile("App.tsx")).toBe("code");
    expect(classifyProjectFile("script.js")).toBe("code");
    expect(classifyProjectFile("Component.jsx")).toBe("code");
    expect(classifyProjectFile("package.json")).toBe("code");
    expect(classifyProjectFile("styles.css")).toBe("code");
    expect(classifyProjectFile("index.html")).toBe("code");
    expect(classifyProjectFile("main.py")).toBe("code");
    expect(classifyProjectFile("deploy.sh")).toBe("code");
    expect(classifyProjectFile("config.yml")).toBe("code");
    expect(classifyProjectFile("docker-compose.yaml")).toBe("code");
    expect(classifyProjectFile("Cargo.toml")).toBe("code");
    expect(classifyProjectFile("notes.txt")).toBe("code");
    expect(classifyProjectFile("Dockerfile")).toBe("code");
    expect(classifyProjectFile("Makefile")).toBe("code");
    expect(classifyProjectFile(".gitignore")).toBe("code");
    expect(classifyProjectFile(".env.local")).toBe("code");

    // Known binaries
    expect(classifyProjectFile("archive.zip")).toBe("binary");
    expect(classifyProjectFile("manual.pdf")).toBe("binary");
    expect(classifyProjectFile("module.wasm")).toBe("binary");
    expect(classifyProjectFile("video.mp4")).toBe("binary");
  });

  it("detects human-readable language labels for code and dotfiles", () => {
    expect(detectCodeLanguageLabel("src/App.tsx")).toBe("TSX");
    expect(detectCodeLanguageLabel("src/main.ts")).toBe("TypeScript");
    expect(detectCodeLanguageLabel("server.py")).toBe("Python");
    expect(detectCodeLanguageLabel("Dockerfile")).toBe("Dockerfile");
    expect(detectCodeLanguageLabel(".env.production")).toBe("Env");
    expect(detectCodeLanguageLabel(".gitignore")).toBe("Git Ignore");
  });

  it("sorts directories first and then alphabetically (case-insensitive)", () => {
    const unsorted: ProjectFileEntry[] = [
      { name: "zeta.ts", path: "/p/zeta.ts", isDirectory: false, extension: ".ts", fileKind: "code" },
      { name: "src", path: "/p/src", isDirectory: true, extension: "", fileKind: null },
      { name: "Alpha.md", path: "/p/Alpha.md", isDirectory: false, extension: ".md", fileKind: "markdown" },
      { name: "docs", path: "/p/docs", isDirectory: true, extension: "", fileKind: null },
      { name: "Assets", path: "/p/Assets", isDirectory: true, extension: "", fileKind: null },
      { name: "beta.json", path: "/p/beta.json", isDirectory: false, extension: ".json", fileKind: "code" },
    ];

    const sorted = sortDirectoryEntries(unsorted);
    expect(sorted.map((e) => e.name)).toEqual([
      "Assets",
      "docs",
      "src",
      "Alpha.md",
      "beta.json",
      "zeta.ts",
    ]);
  });

  it("filters loaded tree entries while preserving ancestor folders of nested matches", () => {
    const entriesByDir: Record<string, ProjectFileEntry[]> = {
      "/proj": [
        { name: "src", path: "/proj/src", isDirectory: true, extension: "", fileKind: null },
        { name: "docs", path: "/proj/docs", isDirectory: true, extension: "", fileKind: null },
        { name: "README.md", path: "/proj/README.md", isDirectory: false, extension: ".md", fileKind: "markdown" },
      ],
      "/proj/src": [
        { name: "App.tsx", path: "/proj/src/App.tsx", isDirectory: false, extension: ".tsx", fileKind: "code" },
        { name: "utils.ts", path: "/proj/src/utils.ts", isDirectory: false, extension: ".ts", fileKind: "code" },
      ],
      "/proj/docs": [
        { name: "guide.md", path: "/proj/docs/guide.md", isDirectory: false, extension: ".md", fileKind: "markdown" },
      ],
    };

    const res = filterFileTreeEntries("/proj", entriesByDir, "app.t");
    expect(res.filteredByDir["/proj"].map((e) => e.name)).toEqual(["src"]);
    expect(res.filteredByDir["/proj/src"].map((e) => e.name)).toEqual(["App.tsx"]);
    expect(res.autoExpandedDirs.has("/proj/src")).toBe(true);
    expect(res.autoExpandedDirs.has("/proj/docs")).toBe(false);
    expect(res.matchCount).toBe(1);
  });

  it("detects binary buffers with NUL bytes or heavy control characters", () => {
    expect(isBufferLikelyBinary(Buffer.from("const x = 1;\nconsole.log(x);\n", "utf8"))).toBe(false);
    expect(isBufferLikelyBinary(Buffer.from("日本語のテキスト\tタブ\r\n", "utf8"))).toBe(false);
    expect(isBufferLikelyBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]))).toBe(true);
  });
});

describe("Project File Tree main-process FS service", () => {
  it("lists directories sorted dirs-first, filters noisy entries by default, and enforces rootPath safety", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-file-tree-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-outside-"));
    try {
      // Create noisy ignored directories/files
      for (const ignored of DEFAULT_IGNORED_NAMES) {
        const p = path.join(tmpRoot, ignored);
        if (ignored === ".DS_Store") {
          fs.writeFileSync(p, "junk");
        } else {
          fs.mkdirSync(p);
        }
      }

      // Create normal folders and files
      fs.mkdirSync(path.join(tmpRoot, "src"));
      fs.mkdirSync(path.join(tmpRoot, "Assets"));
      fs.writeFileSync(path.join(tmpRoot, "README.md"), "# Hello\n", "utf8");
      fs.writeFileSync(path.join(tmpRoot, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      fs.writeFileSync(path.join(tmpRoot, "index.ts"), "export const ok = true;\n", "utf8");

      // Broken symlink should be skipped gracefully
      fs.symlinkSync(path.join(tmpRoot, "non-existent-target"), path.join(tmpRoot, "broken-link.ts"));

      const listed = listProjectDirectory(tmpRoot, { rootPath: tmpRoot });
      expect(listed.ok).toBe(true);
      expect(listed.entries?.map((e) => e.name)).toEqual([
        "Assets",
        "src",
        "index.ts",
        "logo.png",
        "README.md",
      ]);
      expect(listed.entries?.find((e) => e.name === "README.md")?.fileKind).toBe("markdown");
      expect(listed.entries?.find((e) => e.name === "logo.png")?.fileKind).toBe("image");
      expect(listed.entries?.find((e) => e.name === "index.ts")?.fileKind).toBe("code");
      expect(listed.entries?.find((e) => e.name === "src")?.isDirectory).toBe(true);
      expect(listed.entries?.find((e) => e.name === "src")?.fileKind).toBeNull();

      // With includeIgnored: true, ignored directories are included
      const withIgnored = listProjectDirectory(tmpRoot, { rootPath: tmpRoot, includeIgnored: true });
      expect(withIgnored.ok).toBe(true);
      expect(withIgnored.entries?.some((e) => e.name === "node_modules")).toBe(true);
      expect(withIgnored.entries?.some((e) => e.name === ".git")).toBe(true);

      // Path traversal outside rootPath is blocked
      const traversal = listProjectDirectory(path.join(tmpRoot, ".."), { rootPath: tmpRoot });
      expect(traversal.ok).toBe(false);

      // Symlink escaping rootPath is blocked
      fs.symlinkSync(outsideDir, path.join(tmpRoot, "escape-link"));
      const symlinkEscape = listProjectDirectory(path.join(tmpRoot, "escape-link"), {
        rootPath: tmpRoot,
      });
      expect(symlinkEscape.ok).toBe(false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("reads text/code files safely, rejects binary payloads, and enforces 512KB size guard", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-read-text-"));
    try {
      const codeFile = path.join(tmpRoot, "hello.ts");
      fs.writeFileSync(codeFile, "export function greet() {\n  return 'hi';\n}\n", "utf8");

      const okRes = readLocalTextFile(codeFile, { rootPath: tmpRoot });
      expect(okRes.ok).toBe(true);
      expect(okRes.document?.fileName).toBe("hello.ts");
      expect(okRes.document?.language).toBe("TypeScript");
      expect(okRes.document?.content).toContain("return 'hi'");

      // Binary check
      const binFile = path.join(tmpRoot, "data.bin");
      fs.writeFileSync(binFile, Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]));
      const binRes = readLocalTextFile(binFile, { rootPath: tmpRoot });
      expect(binRes.ok).toBe(false);
      expect(binRes.isBinary).toBe(true);

      // Size guard (> 512KB)
      const largeFile = path.join(tmpRoot, "huge.txt");
      fs.writeFileSync(largeFile, "a".repeat(MAX_TEXT_FILE_BYTES + 1024), "utf8");
      const largeRes = readLocalTextFile(largeFile, { rootPath: tmpRoot });
      expect(largeRes.ok).toBe(false);
      expect(largeRes.isTooLarge).toBe(true);

      // Missing file
      const missingRes = readLocalTextFile(path.join(tmpRoot, "missing.ts"), { rootPath: tmpRoot });
      expect(missingRes.ok).toBe(false);

      // Path outside rootPath
      const outsideRes = readLocalTextFile(path.join(tmpRoot, "../etc/hosts"), {
        rootPath: tmpRoot,
      });
      expect(outsideRes.ok).toBe(false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("Unified tab state integration with code tabs", () => {
  const PROJECTS: Project[] = [
    {
      id: "proj-a",
      name: "conductor",
      path: "/Users/dev/conductor",
      colorHex: "#3B82F6",
      gitBranch: "main",
      addedAt: "2026-11-26T00:00:00.000Z",
    },
  ];

  const makeCodeTab = (filePath: string): CodeViewerTab => ({
    filePath,
    fileName: filePath.split("/").pop() ?? filePath,
    document: {
      filePath,
      fileName: filePath.split("/").pop() ?? filePath,
      content: "export const a = 1;\n",
      mtimeMs: 1700000000000,
      sizeBytes: 20,
      language: "TypeScript",
    },
    error: null,
    isLoading: false,
    lastReloadedAt: 1700000000000,
  });

  const makeMdTab = (filePath: string): MarkdownViewerTab => ({
    filePath,
    fileName: filePath.split("/").pop() ?? filePath,
    document: {
      filePath,
      fileName: filePath.split("/").pop() ?? filePath,
      content: "# Doc\n",
      mtimeMs: 1700000000000,
      sizeBytes: 6,
    },
    error: null,
    isLoading: false,
    lastReloadedAt: 1700000000000,
  });

  it("integrates code tabs alongside browser and markdown tabs in the unified workspace", () => {
    const codeTab = makeCodeTab("/Users/dev/conductor/src/index.ts");
    const mdTab = makeMdTab("/Users/dev/conductor/README.md");

    const codeUnifiedId = makeCodeUnifiedTabId(codeTab.filePath);
    expect(parseUnifiedTabId(codeUnifiedId)).toEqual({
      kind: "code",
      rawId: codeTab.filePath,
    });

    let state = createEmptyRightPaneWorkspaceState("proj-a");
    state = activateTabInWorkspace(state, makeMarkdownUnifiedTabId(mdTab.filePath), "proj-a");
    state = activateTabInWorkspace(state, codeUnifiedId, "proj-a");

    const sources = {
      browserTabs: [],
      mdTabs: [mdTab],
      imageTabs: [],
      codeTabs: [codeTab],
      projects: PROJECTS,
    };

    state = reconcileWorkspaceState(state, sources);

    const tabs = getProjectUnifiedTabs(state, "proj-a", sources);
    expect(tabs.map((t) => t.kind)).toEqual(["markdown", "code"]);
    expect(getActiveUnifiedTab(state, sources)?.id).toBe(codeUnifiedId);

    const switcher = buildProjectSwitcherItems(state, sources);
    expect(switcher.withTabs[0].tabCount).toBe(2);
    expect(switcher.withTabs[0].markdownCount).toBe(1);
    expect(switcher.withTabs[0].codeCount).toBe(1);

    // Closing active code tab falls back cleanly to adjacent markdown tab
    const closed = closeTabInWorkspace(state, codeUnifiedId);
    expect(closed.nextActiveTabId).toBe(makeMarkdownUnifiedTabId(mdTab.filePath));

    // Transient code tabs are omitted during persistence serialization
    const withBrowser = activateTabInWorkspace(state, makeBrowserUnifiedTabId("bt-1"), "proj-a");
    const serialized = serializeRightPaneWorkspace(withBrowser, [mdTab]);
    expect(serialized.workspaces["proj-a"]?.tabOrder).toEqual([
      makeMarkdownUnifiedTabId(mdTab.filePath),
      makeBrowserUnifiedTabId("bt-1"),
    ]);
  });
});
