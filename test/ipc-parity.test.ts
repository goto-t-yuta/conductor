import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { registerProjectFileTreeIpcHandlers } from "../src/main/project-files.js";
import {
  formatFileTreeIpcError,
  PROJECT_FILE_TREE_IPC_CHANNELS,
  type ListDirectoryResult,
  type TextFileReadResult,
} from "../src/shared/file-tree.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const KNOWN_CHANNEL_CONSTANTS: Record<string, string> = {
  "PROJECT_FILE_TREE_IPC_CHANNELS.listDir": PROJECT_FILE_TREE_IPC_CHANNELS.listDir,
  "PROJECT_FILE_TREE_IPC_CHANNELS.readTextFile": PROJECT_FILE_TREE_IPC_CHANNELS.readTextFile,
};

function parseSourceFile(relPath: string): ts.SourceFile {
  const fullPath = path.join(repoRoot, relPath);
  const content = fs.readFileSync(fullPath, "utf8");
  return ts.createSourceFile(fullPath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function resolveChannelExpr(expr: ts.Expression | undefined, sf: ts.SourceFile): string | null {
  if (!expr) return null;
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text;
  }
  const text = expr.getText(sf).trim();
  if (text in KNOWN_CHANNEL_CONSTANTS) {
    return KNOWN_CHANNEL_CONSTANTS[text];
  }
  return null;
}

function collectCallChannels(
  sf: ts.SourceFile,
  matcher: (calleeText: string) => boolean,
): string[] {
  const channels: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const calleeText = node.expression.getText(sf).trim();
      if (matcher(calleeText)) {
        const channel = resolveChannelExpr(node.arguments[0], sf);
        if (!channel) {
          throw new Error(
            `Could not statically resolve IPC channel argument in ${sf.fileName}: ${node.getText(sf)}`,
          );
        }
        channels.push(channel);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return channels;
}

describe("IPC handler registration & preload channel parity", () => {
  it("registers fs:list-dir and fs:read-text-file via registerProjectFileTreeIpcHandlers and executes end-to-end", () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();

    registerProjectFileTreeIpcHandlers({
      handle: (channel, listener) => {
        expect(handlers.has(channel)).toBe(false);
        handlers.set(channel, listener);
      },
    });

    expect(Array.from(handlers.keys()).sort()).toEqual(["fs:list-dir", "fs:read-text-file"]);

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-ipc-fs-"));
    try {
      fs.mkdirSync(path.join(tmpRoot, "src"));
      const filePath = path.join(tmpRoot, "src", "hello.ts");
      fs.writeFileSync(filePath, "export const answer = 42;\n", "utf8");

      const listHandler = handlers.get("fs:list-dir")!;
      const listResult = listHandler({}, tmpRoot, { rootPath: tmpRoot }) as ListDirectoryResult;
      expect(listResult.ok).toBe(true);
      expect(listResult.entries?.map((e) => e.name)).toEqual(["src"]);

      const readHandler = handlers.get("fs:read-text-file")!;
      const readResult = readHandler({}, filePath, { rootPath: tmpRoot }) as TextFileReadResult;
      expect(readResult.ok).toBe(true);
      expect(readResult.document?.fileName).toBe("hello.ts");
      expect(readResult.document?.content).toBe("export const answer = 42;\n");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("maintains 100% channel parity between src/preload/index.ts and src/main/index.ts with no duplicates", () => {
    const mainSf = parseSourceFile("src/main/index.ts");
    const preloadSf = parseSourceFile("src/preload/index.ts");

    // Direct ipcMain.handle(...) registrations in src/main/index.ts
    const directMainHandles = collectCallChannels(mainSf, (callee) => callee === "ipcMain.handle");

    // Verify registerProjectFileTreeIpcHandlers(ipcMain) is invoked inside registerIpcHandlers()
    let callsFileTreeRegistration = false;
    let registerIpcCalledBeforeCreateWindow = false;

    const visitMain = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === "registerIpcHandlers") {
        const bodyText = node.getText(mainSf);
        if (bodyText.includes("registerProjectFileTreeIpcHandlers(ipcMain)")) {
          callsFileTreeRegistration = true;
        }
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(mainSf).includes("app.whenReady().then")
      ) {
        const blockText = node.getText(mainSf);
        const registerPos = blockText.indexOf("registerIpcHandlers()");
        const createWindowPos = blockText.indexOf("createWindow()");
        registerIpcCalledBeforeCreateWindow =
          registerPos !== -1 && createWindowPos !== -1 && registerPos < createWindowPos;
      }
      ts.forEachChild(node, visitMain);
    };
    visitMain(mainSf);

    expect(callsFileTreeRegistration).toBe(true);
    expect(registerIpcCalledBeforeCreateWindow).toBe(true);

    // Collect runtime-registered file-tree channels from registerProjectFileTreeIpcHandlers
    const fileTreeHandles: string[] = [];
    registerProjectFileTreeIpcHandlers({
      handle: (channel) => {
        fileTreeHandles.push(channel);
      },
    });

    const allMainHandles = [...directMainHandles, ...fileTreeHandles];
    const preloadInvokes = collectCallChannels(
      preloadSf,
      (callee) => callee === "ipcRenderer.invoke",
    );

    // No duplicate ipcMain.handle registrations (duplicates throw at runtime in Electron)
    const mainDuplicates = allMainHandles.filter((ch, idx) => allMainHandles.indexOf(ch) !== idx);
    expect(mainDuplicates).toEqual([]);

    // Explicit guard for file tree & markdown write channels
    expect(allMainHandles).toContain("fs:list-dir");
    expect(allMainHandles).toContain("fs:read-text-file");
    expect(allMainHandles).toContain("markdown:write-file");
    expect(preloadInvokes).toContain("fs:list-dir");
    expect(preloadInvokes).toContain("fs:read-text-file");
    expect(preloadInvokes).toContain("markdown:write-file");

    // Exact 1:1 parity between preload ipcRenderer.invoke and main ipcMain.handle
    const mainSet = new Set(allMainHandles);
    const preloadSet = new Set(preloadInvokes);
    const missingInMain = [...preloadSet].filter((ch) => !mainSet.has(ch));
    const unusedInPreload = [...mainSet].filter((ch) => !preloadSet.has(ch));

    expect(missingInMain).toEqual([]);
    expect(unusedInPreload).toEqual([]);

    // Main -> Renderer push event channel parity
    const mainEvents = new Set(
      collectCallChannels(mainSf, (callee) => callee === "sendToRenderer"),
    );
    const preloadOnEvents = new Set(
      collectCallChannels(preloadSf, (callee) => callee === "ipcRenderer.on"),
    );
    const preloadOffEvents = new Set(
      collectCallChannels(preloadSf, (callee) => callee === "ipcRenderer.off"),
    );

    expect([...preloadOnEvents].sort()).toEqual([...mainEvents].sort());
    expect([...preloadOffEvents].sort()).toEqual([...preloadOnEvents].sort());
  });

  it("formats stale main-process IPC handler errors with a restart guidance message", () => {
    const staleErr = new Error(
      "Error invoking remote method 'fs:list-dir': Error: No handler registered for 'fs:list-dir'",
    );
    const formatted = formatFileTreeIpcError(staleErr, "fallback");
    expect(formatted).toContain("fs:list-dir");
    expect(formatted).toContain("再起動");

    expect(formatFileTreeIpcError(new Error("EACCES: permission denied"), "fallback")).toBe(
      "EACCES: permission denied",
    );
    expect(formatFileTreeIpcError(null, "fallback")).toBe("fallback");
  });
});
