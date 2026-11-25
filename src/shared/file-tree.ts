export const DEFAULT_IGNORED_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  ".next",
  "__pycache__",
  ".DS_Store",
]);

export const MAX_TEXT_FILE_BYTES = 512 * 1024; // 512 KB

export type ProjectFileKind = "markdown" | "image" | "code" | "binary";

export interface ProjectFileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  extension: string;
  fileKind: ProjectFileKind | null;
  sizeBytes?: number;
}

export interface ListDirectoryResult {
  ok: boolean;
  dirPath: string;
  entries?: ProjectFileEntry[];
  error?: string;
}

export interface TextFileDocument {
  filePath: string;
  fileName: string;
  content: string;
  mtimeMs: number;
  sizeBytes: number;
  language: string;
}

export interface TextFileReadResult {
  ok: boolean;
  filePath: string;
  document?: TextFileDocument;
  isBinary?: boolean;
  isTooLarge?: boolean;
  sizeBytes?: number;
  error?: string;
}

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mkd", ".mdx"]);

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".svg",
  ".bmp",
  ".ico",
  ".avif",
]);

const KNOWN_BINARY_EXTENSIONS = new Set([
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".dmg",
  ".pkg",
  ".app",
  ".exe",
  ".msi",
  ".bin",
  ".dll",
  ".so",
  ".dylib",
  ".node",
  ".wasm",
  ".o",
  ".a",
  ".pyc",
  ".pyo",
  ".class",
  ".jar",
  ".war",
  ".mp3",
  ".wav",
  ".flac",
  ".ogg",
  ".m4a",
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".webm",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".sqlite",
  ".sqlite3",
  ".db",
  ".icns",
  ".psd",
  ".ai",
  ".sketch",
  ".fig",
  ".xls",
  ".xlsx",
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
]);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TSX",
  ".mts": "TypeScript",
  ".cts": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JSX",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".json": "JSON",
  ".jsonc": "JSONC",
  ".css": "CSS",
  ".scss": "SCSS",
  ".sass": "Sass",
  ".less": "Less",
  ".html": "HTML",
  ".htm": "HTML",
  ".xml": "XML",
  ".py": "Python",
  ".pyi": "Python",
  ".sh": "Shell",
  ".bash": "Bash",
  ".zsh": "Zsh",
  ".fish": "Fish",
  ".yml": "YAML",
  ".yaml": "YAML",
  ".toml": "TOML",
  ".ini": "INI",
  ".conf": "Config",
  ".cfg": "Config",
  ".env": "Env",
  ".txt": "Plain Text",
  ".log": "Log",
  ".csv": "CSV",
  ".tsv": "TSV",
  ".sql": "SQL",
  ".graphql": "GraphQL",
  ".gql": "GraphQL",
  ".rs": "Rust",
  ".go": "Go",
  ".java": "Java",
  ".kt": "Kotlin",
  ".kts": "Kotlin",
  ".swift": "Swift",
  ".c": "C",
  ".h": "C/C++ Header",
  ".cpp": "C++",
  ".cc": "C++",
  ".hpp": "C++ Header",
  ".cs": "C#",
  ".rb": "Ruby",
  ".php": "PHP",
  ".lua": "Lua",
  ".dart": "Dart",
  ".vue": "Vue",
  ".svelte": "Svelte",
  ".astro": "Astro",
  ".prisma": "Prisma",
  ".proto": "Protobuf",
  ".tf": "Terraform",
  ".hcl": "HCL",
  ".md": "Markdown",
  ".markdown": "Markdown",
  ".mdx": "MDX",
};

const LANGUAGE_BY_BASENAME: Record<string, string> = {
  dockerfile: "Dockerfile",
  makefile: "Makefile",
  justfile: "Justfile",
  gemfile: "Ruby",
  rakefile: "Ruby",
  procfile: "Procfile",
  license: "Plain Text",
  readme: "Plain Text",
  changelog: "Plain Text",
  ".gitignore": "Git Ignore",
  ".gitattributes": "Git Attributes",
  ".editorconfig": "EditorConfig",
  ".npmrc": "Config",
  ".nvmrc": "Config",
  ".env": "Env",
  ".eslintrc": "JSON",
  ".prettierrc": "JSON",
};

export function extractFileExtension(filePathOrName: string): string {
  const base = filePathOrName.split(/[/\\]/).pop() ?? filePathOrName;
  if (!base || base === "." || base === "..") return "";
  const dotIdx = base.lastIndexOf(".");
  if (dotIdx <= 0) return "";
  return base.slice(dotIdx).toLowerCase();
}

export function isDefaultIgnoredEntry(name: string): boolean {
  return DEFAULT_IGNORED_NAMES.has(name);
}

/**
 * Classifies a file path or filename into the viewer kind used by the unified right pane:
 * - "markdown": .md / .markdown / .mdown / .mkd / .mdx
 * - "image": .png / .jpg / .jpeg / .webp / .gif / .svg / .bmp / .ico / .avif
 * - "binary": known binary/archive/media/font/document formats
 * - "code": source code, config, and plain text files (safe-guarded at read time by size & binary check)
 */
export function classifyProjectFile(filePathOrName: string): ProjectFileKind {
  const ext = extractFileExtension(filePathOrName);
  if (ext && MARKDOWN_EXTENSIONS.has(ext)) {
    return "markdown";
  }
  if (ext && IMAGE_EXTENSIONS.has(ext)) {
    return "image";
  }
  if (ext && KNOWN_BINARY_EXTENSIONS.has(ext)) {
    return "binary";
  }
  return "code";
}

export function detectCodeLanguageLabel(filePathOrName: string): string {
  const base = (filePathOrName.split(/[/\\]/).pop() ?? filePathOrName).toLowerCase();
  if (LANGUAGE_BY_BASENAME[base]) {
    return LANGUAGE_BY_BASENAME[base];
  }
  if (base.startsWith(".env.")) {
    return "Env";
  }
  if (base.startsWith("dockerfile.")) {
    return "Dockerfile";
  }
  const ext = extractFileExtension(base);
  if (ext && LANGUAGE_BY_EXTENSION[ext]) {
    return LANGUAGE_BY_EXTENSION[ext];
  }
  return ext ? ext.slice(1).toUpperCase() : "Plain Text";
}

/**
 * Sorts directory entries directories-first, then alphabetically (case-insensitive with exact tie-break).
 */
export function sortDirectoryEntries(entries: readonly ProjectFileEntry[]): ProjectFileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    const lowerCmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    if (lowerCmp !== 0) return lowerCmp;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Heuristic binary detector inspecting the first `sampleLength` bytes of a file buffer.
 * Flags any NUL byte (0x00) or an abnormally high ratio (> 10%) of non-whitespace control bytes.
 */
export function isBufferLikelyBinary(buf: Uint8Array, sampleLength = 8192): boolean {
  const len = Math.min(buf.length, sampleLength);
  if (len === 0) return false;
  let suspicious = 0;
  for (let i = 0; i < len; i += 1) {
    const byte = buf[i];
    if (byte === 0) {
      return true;
    }
    // Control characters other than \b (8), \t (9), \n (10), \f (12), \r (13), ESC (27)
    if ((byte < 8 || byte === 11 || (byte > 13 && byte < 32 && byte !== 27)) && byte !== 0) {
      suspicious += 1;
    }
  }
  return suspicious / len > 0.1;
}

export interface FilteredFileTree {
  filteredByDir: Record<string, ProjectFileEntry[]>;
  autoExpandedDirs: Set<string>;
  matchCount: number;
}

/**
 * Filters loaded directory entries by a filename/path query while keeping ancestor directories
 * of any matching descendant visible and auto-expanded.
 */
export function filterFileTreeEntries(
  rootPath: string,
  entriesByDir: Readonly<Record<string, readonly ProjectFileEntry[]>>,
  query: string,
): FilteredFileTree {
  const q = query.trim().toLowerCase();
  if (!q) {
    const plain: Record<string, ProjectFileEntry[]> = {};
    for (const [dir, list] of Object.entries(entriesByDir)) {
      plain[dir] = [...list];
    }
    return { filteredByDir: plain, autoExpandedDirs: new Set(), matchCount: 0 };
  }

  const filteredByDir: Record<string, ProjectFileEntry[]> = {};
  const autoExpandedDirs = new Set<string>();
  let matchCount = 0;

  const visitDir = (dirPath: string, ancestorMatched: boolean): boolean => {
    const entries = entriesByDir[dirPath];
    if (!entries) return false;

    const kept: ProjectFileEntry[] = [];
    for (const entry of entries) {
      const selfMatches = entry.name.toLowerCase().includes(q);
      if (selfMatches) {
        matchCount += 1;
      }

      if (entry.isDirectory) {
        const childMatched = visitDir(entry.path, ancestorMatched || selfMatches);
        if (ancestorMatched || selfMatches || childMatched) {
          kept.push(entry);
          if (childMatched) {
            autoExpandedDirs.add(entry.path);
          }
        }
      } else if (ancestorMatched || selfMatches) {
        kept.push(entry);
      }
    }

    filteredByDir[dirPath] = kept;
    return kept.length > 0;
  };

  visitDir(rootPath, false);
  return { filteredByDir, autoExpandedDirs, matchCount };
}
