import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyProjectFile,
  detectCodeLanguageLabel,
  extractFileExtension,
  isBufferLikelyBinary,
  isDefaultIgnoredEntry,
  MAX_TEXT_FILE_BYTES,
  PROJECT_FILE_TREE_IPC_CHANNELS,
  sortDirectoryEntries,
  type ListDirectoryResult,
  type ProjectFileEntry,
  type TextFileReadResult,
} from "../shared/file-tree.js";

export interface IpcMainHandleLike {
  handle: (
    channel: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    listener: (event: any, ...args: any[]) => unknown,
  ) => void;
}

function expandHome(raw: string): string {
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return raw;
}

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  const rel = path.relative(rootPath, targetPath);
  if (rel === "") return true;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function resolveSafeAbsolutePath(
  input: string,
  rootPath?: string,
): { ok: true; resolvedPath: string; resolvedRoot: string | null } | { ok: false; error: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: "パスが空です。" };
  }
  if (trimmed.includes("\0")) {
    return { ok: false, error: "不正なパスです。" };
  }

  const expanded = expandHome(trimmed);
  if (!path.isAbsolute(expanded)) {
    return { ok: false, error: "絶対パスを指定してください。" };
  }

  const resolvedPath = path.resolve(expanded);

  let resolvedRoot: string | null = null;
  if (rootPath !== undefined && rootPath !== null && rootPath.trim().length > 0) {
    const trimmedRoot = rootPath.trim();
    if (trimmedRoot.includes("\0")) {
      return { ok: false, error: "不正なルートパスです。" };
    }
    const expandedRoot = expandHome(trimmedRoot);
    if (!path.isAbsolute(expandedRoot)) {
      return { ok: false, error: "ルートパスには絶対パスを指定してください。" };
    }
    resolvedRoot = path.resolve(expandedRoot);
    if (!isWithinRoot(resolvedPath, resolvedRoot)) {
      return { ok: false, error: "プロジェクトフォルダ外のパスにはアクセスできません。" };
    }
  }

  return { ok: true, resolvedPath, resolvedRoot };
}

export function listProjectDirectory(
  dirPath: string,
  options?: { rootPath?: string; includeIgnored?: boolean },
): ListDirectoryResult {
  const safe = resolveSafeAbsolutePath(dirPath, options?.rootPath);
  if (!safe.ok) {
    return { ok: false, dirPath, error: safe.error };
  }

  const targetDir = safe.resolvedPath;
  const includeIgnored = Boolean(options?.includeIgnored);

  let realDir: string;
  try {
    realDir = fs.realpathSync(targetDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return { ok: false, dirPath: targetDir, error: "ディレクトリが見つかりません。" };
    }
    return {
      ok: false,
      dirPath: targetDir,
      error: `ディレクトリにアクセスできません: ${(err as Error).message}`,
    };
  }

  if (safe.resolvedRoot) {
    try {
      const realRoot = fs.realpathSync(safe.resolvedRoot);
      if (!isWithinRoot(realDir, realRoot)) {
        return {
          ok: false,
          dirPath: targetDir,
          error: "プロジェクトフォルダ外のリンク先ディレクトリにはアクセスできません。",
        };
      }
    } catch {
      return {
        ok: false,
        dirPath: targetDir,
        error: "プロジェクトルートディレクトリにアクセスできません。",
      };
    }
  }

  let dirStat: fs.Stats;
  try {
    dirStat = fs.statSync(realDir);
  } catch (err) {
    return {
      ok: false,
      dirPath: targetDir,
      error: `ディレクトリ情報を取得できません: ${(err as Error).message}`,
    };
  }

  if (!dirStat.isDirectory()) {
    return { ok: false, dirPath: targetDir, error: "指定されたパスはディレクトリではありません。" };
  }

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(realDir, { withFileTypes: true });
  } catch (err) {
    return {
      ok: false,
      dirPath: targetDir,
      error: `ディレクトリ一覧の読み込みに失敗しました: ${(err as Error).message}`,
    };
  }

  const entries: ProjectFileEntry[] = [];

  for (const dirent of dirents) {
    const name = dirent.name;
    if (!includeIgnored && isDefaultIgnoredEntry(name)) {
      continue;
    }

    const entryPath = path.join(targetDir, name);
    let isDirectory = dirent.isDirectory();
    let isFile = dirent.isFile();
    let sizeBytes: number | undefined;

    if (dirent.isSymbolicLink()) {
      try {
        const linkedStat = fs.statSync(entryPath);
        isDirectory = linkedStat.isDirectory();
        isFile = linkedStat.isFile();
        if (isFile) {
          sizeBytes = linkedStat.size;
        }
      } catch {
        // Broken symlink: skip gracefully
        continue;
      }
    } else if (isFile) {
      try {
        sizeBytes = fs.statSync(entryPath).size;
      } catch {
        sizeBytes = undefined;
      }
    }

    if (!isDirectory && !isFile) {
      // Skip sockets, FIFOs, block/char devices
      continue;
    }

    entries.push({
      name,
      path: entryPath,
      isDirectory,
      extension: isDirectory ? "" : extractFileExtension(name),
      fileKind: isDirectory ? null : classifyProjectFile(name),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    });
  }

  return {
    ok: true,
    dirPath: targetDir,
    entries: sortDirectoryEntries(entries),
  };
}

export function readLocalTextFile(
  filePath: string,
  options?: { rootPath?: string; maxBytes?: number },
): TextFileReadResult {
  const safe = resolveSafeAbsolutePath(filePath, options?.rootPath);
  if (!safe.ok) {
    return { ok: false, filePath, error: safe.error };
  }

  const targetPath = safe.resolvedPath;
  const maxBytes = options?.maxBytes ?? MAX_TEXT_FILE_BYTES;

  let realPath: string;
  try {
    realPath = fs.realpathSync(targetPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return { ok: false, filePath: targetPath, error: "ファイルが見つかりません。" };
    }
    return {
      ok: false,
      filePath: targetPath,
      error: `ファイルにアクセスできません: ${(err as Error).message}`,
    };
  }

  if (safe.resolvedRoot) {
    try {
      const realRoot = fs.realpathSync(safe.resolvedRoot);
      if (!isWithinRoot(realPath, realRoot)) {
        return {
          ok: false,
          filePath: targetPath,
          error: "プロジェクトフォルダ外のリンク先ファイルにはアクセスできません。",
        };
      }
    } catch {
      return {
        ok: false,
        filePath: targetPath,
        error: "プロジェクトルートディレクトリにアクセスできません。",
      };
    }
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(realPath);
  } catch (err) {
    return {
      ok: false,
      filePath: targetPath,
      error: `ファイル情報の取得に失敗しました: ${(err as Error).message}`,
    };
  }

  if (!stat.isFile()) {
    return { ok: false, filePath: targetPath, error: "指定されたパスは通常のファイルではありません。" };
  }

  if (stat.size > maxBytes) {
    const kb = Math.round(stat.size / 1024);
    const limitKb = Math.round(maxBytes / 1024);
    return {
      ok: false,
      filePath: targetPath,
      isTooLarge: true,
      sizeBytes: stat.size,
      error: `ファイルサイズが大きすぎます (${kb} KB / 上限 ${limitKb} KB)。`,
    };
  }

  try {
    const buf = fs.readFileSync(realPath);
    if (isBufferLikelyBinary(buf)) {
      return {
        ok: false,
        filePath: targetPath,
        isBinary: true,
        sizeBytes: stat.size,
        error: "バイナリファイルのためテキストとして表示できません。",
      };
    }

    const fileName = path.basename(targetPath);
    const content = buf.toString("utf8");
    return {
      ok: true,
      filePath: targetPath,
      document: {
        filePath: targetPath,
        fileName,
        content,
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
        language: detectCodeLanguageLabel(fileName),
      },
    };
  } catch (err) {
    return {
      ok: false,
      filePath: targetPath,
      error: `ファイルの読み込みに失敗しました: ${(err as Error).message}`,
    };
  }
}

export function registerProjectFileTreeIpcHandlers(ipc: IpcMainHandleLike): void {
  ipc.handle(
    PROJECT_FILE_TREE_IPC_CHANNELS.listDir,
    (_e, dirPath: string, options?: { rootPath?: string; includeIgnored?: boolean }) =>
      listProjectDirectory(dirPath, options),
  );
  ipc.handle(
    PROJECT_FILE_TREE_IPC_CHANNELS.readTextFile,
    (_e, filePath: string, options?: { rootPath?: string }) =>
      readLocalTextFile(filePath, options),
  );
}
