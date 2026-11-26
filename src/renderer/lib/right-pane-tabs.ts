import { findProjectForTask, parseAndResolveMentions } from "../../shared/mentions.js";
import type {
  AgentTask,
  BrowserTab,
  ChatMessage,
  ExplicitMentionTarget,
  MarkdownDocument,
  Project,
  TextFileDocument,
} from "../../shared/types.js";
import type { ImageViewerTab } from "./image-viewer.js";

export interface MarkdownExternalChange {
  kind: "changed" | "deleted";
  document?: MarkdownDocument;
  detectedAt: number;
  message?: string;
}

export interface MarkdownViewerTab {
  filePath: string;
  fileName: string;
  document: MarkdownDocument | null;
  draftContent?: string | null;
  isDirty?: boolean;
  isSaving?: boolean;
  saveError?: string | null;
  lastSavedAt?: number | null;
  externalChange?: MarkdownExternalChange | null;
  viewMode?: "rendered" | "raw";
  error: string | null;
  deletedOnDisk?: boolean;
  isLoading: boolean;
  lastReloadedAt: number | null;
}

export interface CodeViewerTab {
  filePath: string;
  fileName: string;
  document: TextFileDocument | null;
  error: string | null;
  isBinary?: boolean;
  isTooLarge?: boolean;
  isLoading: boolean;
  lastReloadedAt: number | null;
}

export const GENERAL_PROJECT_SCOPE = "__general__" as const;
export const RIGHT_PANE_WORKSPACE_STORAGE_KEY = "conductor:rightPaneWorkspace:v1";

export type ProjectScopeKey = string;
export type UnifiedRightPaneTabKind = "browser" | "markdown" | "image" | "code";

export type UnifiedRightPaneTab =
  | {
      id: string;
      kind: "browser";
      projectScope: ProjectScopeKey;
      title: string;
      subtitle: string;
      isLoading: boolean;
      hasError: boolean;
      browserTab: BrowserTab;
    }
  | {
      id: string;
      kind: "markdown";
      projectScope: ProjectScopeKey;
      title: string;
      subtitle: string;
      isLoading: boolean;
      hasError: boolean;
      markdownTab: MarkdownViewerTab;
    }
  | {
      id: string;
      kind: "image";
      projectScope: ProjectScopeKey;
      title: string;
      subtitle: string;
      isLoading: boolean;
      hasError: boolean;
      imageTab: ImageViewerTab;
    }
  | {
      id: string;
      kind: "code";
      projectScope: ProjectScopeKey;
      title: string;
      subtitle: string;
      isLoading: boolean;
      hasError: boolean;
      codeTab: CodeViewerTab;
    };

export interface ProjectWorkspaceTabsState {
  tabOrder: string[];
  activeTabId: string | null;
}

export interface RightPaneWorkspaceState {
  activeProjectScope: ProjectScopeKey;
  workspaces: Record<ProjectScopeKey, ProjectWorkspaceTabsState>;
  tabProjects: Record<string, ProjectScopeKey>;
}

export interface PersistedRightPaneWorkspace {
  activeProjectScope: ProjectScopeKey;
  workspaces: Record<ProjectScopeKey, ProjectWorkspaceTabsState>;
  tabProjects: Record<string, ProjectScopeKey>;
  openMarkdownFiles: Array<{ filePath: string; projectScope: ProjectScopeKey }>;
}

export interface ProjectSwitcherItem {
  scopeKey: ProjectScopeKey;
  project: Project | null;
  name: string;
  path: string | null;
  colorHex: string;
  tabCount: number;
  browserCount: number;
  markdownCount: number;
  imageCount: number;
  codeCount?: number;
  isActive: boolean;
  isGeneral: boolean;
}

export interface RightPaneTabSources {
  browserTabs: readonly BrowserTab[];
  mdTabs: readonly MarkdownViewerTab[];
  imageTabs: readonly ImageViewerTab[];
  codeTabs?: readonly CodeViewerTab[];
  projects: readonly Project[];
  tasks?: readonly AgentTask[];
  pendingMarkdownPaths?: ReadonlySet<string>;
}

// MARK: - Unified Tab ID Helpers

export function makeBrowserUnifiedTabId(browserTabId: string): string {
  return `browser:${browserTabId}`;
}

export function makeMarkdownUnifiedTabId(filePath: string): string {
  return `markdown:${filePath}`;
}

export function makeImageUnifiedTabId(imageTabId: string): string {
  return `image:${imageTabId}`;
}

export function makeCodeUnifiedTabId(filePath: string): string {
  return `code:${filePath}`;
}

export function parseUnifiedTabId(
  tabId: string,
): { kind: UnifiedRightPaneTabKind; rawId: string } | null {
  if (tabId.startsWith("browser:")) {
    return { kind: "browser", rawId: tabId.slice("browser:".length) };
  }
  if (tabId.startsWith("markdown:")) {
    return { kind: "markdown", rawId: tabId.slice("markdown:".length) };
  }
  if (tabId.startsWith("image:")) {
    return { kind: "image", rawId: tabId.slice("image:".length) };
  }
  if (tabId.startsWith("code:")) {
    return { kind: "code", rawId: tabId.slice("code:".length) };
  }
  return null;
}

// MARK: - Project Scope Helpers

export function toProjectScopeKey(
  projectId: string | null | undefined,
  projects?: readonly Project[],
): ProjectScopeKey {
  if (!projectId || projectId === GENERAL_PROJECT_SCOPE) {
    return GENERAL_PROJECT_SCOPE;
  }
  if (projects && !projects.some((p) => p.id === projectId)) {
    return GENERAL_PROJECT_SCOPE;
  }
  return projectId;
}

export function scopeKeyToBrowserProjectId(scopeKey: ProjectScopeKey): string | null {
  return scopeKey === GENERAL_PROJECT_SCOPE ? null : scopeKey;
}

export function createEmptyRightPaneWorkspaceState(
  initialScope: ProjectScopeKey = GENERAL_PROJECT_SCOPE,
): RightPaneWorkspaceState {
  return {
    activeProjectScope: initialScope,
    workspaces: {},
    tabProjects: {},
  };
}

// MARK: - Project Inference Helpers

export function normalizePathForMatch(pathOrFileUrl: string): string {
  let cleaned = pathOrFileUrl.trim();
  if (!cleaned) return "";

  if (/^file:\/\//i.test(cleaned)) {
    cleaned = cleaned.replace(/^file:\/\//i, "");
    // Strip localhost host if present: file://localhost/Users/...
    if (/^localhost\//i.test(cleaned)) {
      cleaned = cleaned.slice("localhost".length);
    }
    const hashIdx = cleaned.indexOf("#");
    if (hashIdx !== -1) cleaned = cleaned.slice(0, hashIdx);
    const queryIdx = cleaned.indexOf("?");
    if (queryIdx !== -1) cleaned = cleaned.slice(0, queryIdx);
    try {
      cleaned = decodeURIComponent(cleaned);
    } catch {
      // keep raw path if malformed escape sequence
    }
    // Windows file:///C:/... -> C:/...
    if (/^\/[a-zA-Z]:\//.test(cleaned)) {
      cleaned = cleaned.slice(1);
    }
  } else {
    const hashIdx = cleaned.indexOf("#");
    if (hashIdx !== -1) cleaned = cleaned.slice(0, hashIdx);
    const queryIdx = cleaned.indexOf("?");
    if (queryIdx !== -1) cleaned = cleaned.slice(0, queryIdx);
  }

  cleaned = cleaned.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (cleaned.length > 1 && cleaned.endsWith("/")) {
    cleaned = cleaned.replace(/\/+$/, "");
  }
  return cleaned;
}

function isPathWithinDirectory(filePath: string, dirPath: string): boolean {
  if (!filePath || !dirPath) return false;
  if (filePath === dirPath) return true;
  const prefix = dirPath.endsWith("/") ? dirPath : `${dirPath}/`;
  return filePath.startsWith(prefix);
}

/**
 * Infers the owning registered Project for a local file path (or `file://` URL)
 * by matching the longest `project.path` prefix. Also checks task `worktreePath`
 * prefixes when `tasks` are supplied so files inside a task's worktree map cleanly
 * to the task's project.
 */
export function inferProjectFromFilePath(
  filePath: string,
  projects: readonly Project[],
  tasks?: readonly AgentTask[],
): Project | null {
  const normalizedFile = normalizePathForMatch(filePath);
  if (!normalizedFile) return null;

  let bestProject: Project | null = null;
  let bestLen = -1;

  for (const project of projects) {
    const normalizedProj = normalizePathForMatch(project.path);
    if (!normalizedProj) continue;
    if (isPathWithinDirectory(normalizedFile, normalizedProj) && normalizedProj.length > bestLen) {
      bestProject = project;
      bestLen = normalizedProj.length;
    }
  }

  if (tasks && tasks.length > 0) {
    for (const task of tasks) {
      if (!task.worktreePath) continue;
      const normalizedWt = normalizePathForMatch(task.worktreePath);
      if (!normalizedWt) continue;
      if (isPathWithinDirectory(normalizedFile, normalizedWt) && normalizedWt.length > bestLen) {
        const taskProj = findProjectForTask(projects, task);
        if (taskProj) {
          bestProject = taskProj;
          bestLen = normalizedWt.length;
        }
      }
    }
  }

  return bestProject;
}

export function inferProjectFromTask(
  task: AgentTask | null | undefined,
  projects: readonly Project[],
): Project | null {
  if (!task) return null;
  return findProjectForTask(projects, task) ?? null;
}

const ASCII_TOKEN_CHAR_RE = /[A-Za-z0-9_-]/;

function isWordBoundaryBefore(text: string, index: number, firstChar: string): boolean {
  if (index === 0) return true;
  if (!ASCII_TOKEN_CHAR_RE.test(firstChar)) return true;
  const prev = text[index - 1];
  if (ASCII_TOKEN_CHAR_RE.test(prev)) return false;
  // Avoid matching email domain part like user@project.com
  if (prev === "@" && index >= 2 && /[A-Za-z0-9._+-]/.test(text[index - 2])) {
    return false;
  }
  return true;
}

function isWordBoundaryAfter(text: string, endIndex: number, lastChar: string): boolean {
  if (endIndex >= text.length) return true;
  if (!ASCII_TOKEN_CHAR_RE.test(lastChar)) return true;
  const next = text[endIndex];
  return !ASCII_TOKEN_CHAR_RE.test(next);
}

/**
 * Resolves a registered Project mentioned in a user chat input:
 * 1. Structured explicit mention targets (attached via composer chips).
 * 2. Explicit `@<projectName>`, `@T#`, or `@<projectName>/T#` mentions via `parseAndResolveMentions`.
 * 3. Fallback: unambiguous plain-text match of a registered project name (longest-match
 *    span masking so `my-app-v2` doesn't collide with `my-app`). Returns `null` if 0 or >=2
 *    distinct projects match in plain text.
 */
export function resolveProjectFromChatText(
  text: string,
  projects: readonly Project[],
  tasks: readonly AgentTask[],
  explicitMentions?: readonly ExplicitMentionTarget[],
): Project | null {
  if (projects.length === 0) return null;

  // 0. Structured mention chips take highest priority
  if (Array.isArray(explicitMentions)) {
    for (const target of explicitMentions) {
      if (target.kind === "project") {
        if (target.projectId) {
          const byId = projects.find((p) => p.id === target.projectId);
          if (byId) return byId;
        }
        if (target.projectName) {
          const lower = target.projectName.toLowerCase();
          const byName = projects.find((p) => p.name.toLowerCase() === lower);
          if (byName) return byName;
        }
      } else if (target.kind === "task") {
        const liveTask =
          tasks.find((t) => t.id === target.taskId) ??
          (target.taskNumber !== undefined
            ? tasks.find((t) => t.taskNumber === target.taskNumber)
            : undefined);
        if (liveTask) {
          const taskProject = findProjectForTask(projects, liveTask);
          if (taskProject) return taskProject;
        }
      }
    }
  }

  if (!text.trim()) return null;

  // 1. Explicit @mentions in text
  if (text.includes("@")) {
    const resolved = parseAndResolveMentions(text, [...projects], [...tasks]);
    for (const mention of resolved.mentions) {
      if (mention.project) {
        return mention.project;
      }
      if (mention.task) {
        const taskProject = findProjectForTask(projects, mention.task);
        if (taskProject) return taskProject;
      }
    }
  }

  // 2. Unambiguous plain-text project name match
  const lowerText = text.toLowerCase();
  const sortedProjects = [...projects]
    .filter((p) => p.name.trim().length >= 2)
    .sort((a, b) => b.name.length - a.name.length);

  const matchedProjectIds = new Set<string>();
  const matchedProjects: Project[] = [];
  const claimedSpans: Array<[number, number]> = [];

  const overlapsClaimed = (start: number, end: number): boolean =>
    claimedSpans.some(([s, e]) => start < e && end > s);

  for (const project of sortedProjects) {
    const needle = project.name.toLowerCase();
    let searchFrom = 0;
    while (searchFrom <= lowerText.length - needle.length) {
      const idx = lowerText.indexOf(needle, searchFrom);
      if (idx === -1) break;
      const end = idx + needle.length;
      searchFrom = idx + 1;

      if (overlapsClaimed(idx, end)) continue;
      if (
        !isWordBoundaryBefore(text, idx, project.name[0]) ||
        !isWordBoundaryAfter(text, end, project.name[project.name.length - 1])
      ) {
        continue;
      }

      claimedSpans.push([idx, end]);
      if (!matchedProjectIds.has(project.id)) {
        matchedProjectIds.add(project.id);
        matchedProjects.push(project);
      }
      break;
    }
  }

  return matchedProjects.length === 1 ? matchedProjects[0] : null;
}

/**
 * Infers the owning registered Project from a ChatMessage (checking relatedTaskId,
 * persisted mention snapshots, and message text mentions).
 */
export function inferProjectFromMessage(
  message: ChatMessage | null | undefined,
  projects: readonly Project[],
  tasks: readonly AgentTask[],
): Project | null {
  if (!message || projects.length === 0) return null;

  if (message.relatedTaskId) {
    const task = tasks.find((t) => t.id === message.relatedTaskId);
    const taskProj = inferProjectFromTask(task, projects);
    if (taskProj) return taskProj;
  }

  if (Array.isArray(message.mentions)) {
    for (const ref of message.mentions) {
      if (ref.projectId) {
        const byId = projects.find((p) => p.id === ref.projectId);
        if (byId) return byId;
      }
      if (ref.projectName) {
        const byName = projects.find(
          (p) => p.name.toLowerCase() === ref.projectName.toLowerCase(),
        );
        if (byName) return byName;
      }
      if (ref.kind === "task") {
        const liveTask =
          tasks.find((t) => t.id === ref.taskId) ??
          tasks.find((t) => t.taskNumber === ref.taskNumber);
        const taskProj = inferProjectFromTask(liveTask, projects);
        if (taskProj) return taskProj;
      }
    }
  }

  return resolveProjectFromChatText(message.text, projects, tasks);
}

export function inferScopeForFile(
  filePath: string,
  projects: readonly Project[],
  tasks: readonly AgentTask[],
  fallbackScope: ProjectScopeKey,
): ProjectScopeKey {
  const matched = inferProjectFromFilePath(filePath, projects, tasks);
  if (matched) return matched.id;
  return toProjectScopeKey(fallbackScope, projects);
}

export function filterRecentFilesForProject(
  recentFiles: readonly string[],
  scopeKey: ProjectScopeKey,
  projects: readonly Project[],
  tasks?: readonly AgentTask[],
): string[] {
  if (scopeKey === GENERAL_PROJECT_SCOPE) {
    return recentFiles.filter((fp) => inferProjectFromFilePath(fp, projects, tasks) === null);
  }
  return recentFiles.filter((fp) => inferProjectFromFilePath(fp, projects, tasks)?.id === scopeKey);
}

// MARK: - Workspace State Reconciliation & Transitions

function dedupeOrder(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Reconciles the unified right-pane workspace state against live browser tabs,
 * markdown tabs, image tabs, and registered projects.
 * - Preserves per-project mixed tab ordering and active tab selection.
 * - Automatically registers newly created browser/markdown/image tabs in their project scope.
 * - Removes closed/disappeared tabs and selects an adjacent tab within the same project.
 * - Migrates tabs from deleted projects gracefully to `GENERAL_PROJECT_SCOPE`.
 */
export function reconcileWorkspaceState(
  state: RightPaneWorkspaceState,
  sources: RightPaneTabSources,
): RightPaneWorkspaceState {
  const { browserTabs, mdTabs, imageTabs, codeTabs = [], projects, tasks, pendingMarkdownPaths } = sources;
  const validProjectIds = new Set(projects.map((p) => p.id));

  const resolveValidScope = (raw: string | null | undefined): ProjectScopeKey => {
    if (!raw || raw === GENERAL_PROJECT_SCOPE) return GENERAL_PROJECT_SCOPE;
    return validProjectIds.has(raw) ? raw : GENERAL_PROJECT_SCOPE;
  };

  // Map every live tab ID to its authoritative project scope
  const liveTabScope = new Map<string, ProjectScopeKey>();

  for (const bt of browserTabs) {
    const id = makeBrowserUnifiedTabId(bt.id);
    const scope = bt.projectId
      ? resolveValidScope(bt.projectId)
      : resolveValidScope(state.tabProjects[id]);
    liveTabScope.set(id, scope);
  }

  for (const mt of mdTabs) {
    const id = makeMarkdownUnifiedTabId(mt.filePath);
    const existing = state.tabProjects[id];
    const scope = existing
      ? resolveValidScope(existing)
      : (inferProjectFromFilePath(mt.filePath, projects, tasks)?.id ?? GENERAL_PROJECT_SCOPE);
    liveTabScope.set(id, scope);
  }

  if (pendingMarkdownPaths) {
    for (const filePath of pendingMarkdownPaths) {
      const id = makeMarkdownUnifiedTabId(filePath);
      if (liveTabScope.has(id)) continue;
      const existing = state.tabProjects[id];
      const scope = existing
        ? resolveValidScope(existing)
        : (inferProjectFromFilePath(filePath, projects, tasks)?.id ?? GENERAL_PROJECT_SCOPE);
      liveTabScope.set(id, scope);
    }
  }

  for (const it of imageTabs) {
    const id = makeImageUnifiedTabId(it.id);
    const existing = state.tabProjects[id];
    const inferred =
      !existing && it.imagePath
        ? inferProjectFromFilePath(it.imagePath, projects, tasks)?.id
        : undefined;
    const scope = resolveValidScope(existing ?? inferred);
    liveTabScope.set(id, scope);
  }

  for (const ct of codeTabs) {
    const id = makeCodeUnifiedTabId(ct.filePath);
    const existing = state.tabProjects[id];
    const scope = existing
      ? resolveValidScope(existing)
      : (inferProjectFromFilePath(ct.filePath, projects, tasks)?.id ?? GENERAL_PROJECT_SCOPE);
    liveTabScope.set(id, scope);
  }

  const nextActiveProjectScope = resolveValidScope(state.activeProjectScope);

  // Build updated per-project tab orders preserving existing relative order
  const nextWorkspaces: Record<ProjectScopeKey, ProjectWorkspaceTabsState> = {};
  const placedTabIds = new Set<string>();

  // First pass: preserve order from existing workspaces (migrating deleted project scopes to General)
  for (const [rawScope, ws] of Object.entries(state.workspaces)) {
    const scope = resolveValidScope(rawScope);
    if (!nextWorkspaces[scope]) {
      nextWorkspaces[scope] = { tabOrder: [], activeTabId: null };
    }
    const target = nextWorkspaces[scope];

    for (const tabId of ws.tabOrder) {
      if (liveTabScope.get(tabId) === scope && !placedTabIds.has(tabId)) {
        target.tabOrder.push(tabId);
        placedTabIds.add(tabId);
      }
    }

    if (
      !target.activeTabId &&
      ws.activeTabId &&
      liveTabScope.get(ws.activeTabId) === scope
    ) {
      target.activeTabId = ws.activeTabId;
    }
  }

  // Second pass: append any live tabs not yet placed into their scope's tabOrder
  for (const [tabId, scope] of liveTabScope.entries()) {
    if (placedTabIds.has(tabId)) continue;
    if (!nextWorkspaces[scope]) {
      nextWorkspaces[scope] = { tabOrder: [], activeTabId: null };
    }
    nextWorkspaces[scope].tabOrder.push(tabId);
    placedTabIds.add(tabId);
  }

  // Third pass: ensure activeTabId is valid for every workspace that has tabs
  for (const [scope, ws] of Object.entries(nextWorkspaces)) {
    ws.tabOrder = dedupeOrder(ws.tabOrder);
    if (ws.tabOrder.length === 0) {
      ws.activeTabId = null;
      continue;
    }
    if (!ws.activeTabId || !ws.tabOrder.includes(ws.activeTabId)) {
      // Pick adjacent tab based on previous active index if available
      const prevWs = state.workspaces[scope];
      if (prevWs?.activeTabId) {
        const prevIdx = prevWs.tabOrder.indexOf(prevWs.activeTabId);
        if (prevIdx >= 0) {
          ws.activeTabId =
            ws.tabOrder[Math.min(prevIdx, ws.tabOrder.length - 1)] ?? ws.tabOrder[0];
          continue;
        }
      }
      ws.activeTabId = ws.tabOrder[0];
    }
  }

  // Remove empty non-active workspaces to keep state clean
  for (const scope of Object.keys(nextWorkspaces)) {
    if (nextWorkspaces[scope].tabOrder.length === 0) {
      delete nextWorkspaces[scope];
    }
  }

  const nextTabProjects: Record<string, ProjectScopeKey> = {};
  for (const [tabId, scope] of liveTabScope.entries()) {
    nextTabProjects[tabId] = scope;
  }

  return {
    activeProjectScope: nextActiveProjectScope,
    workspaces: nextWorkspaces,
    tabProjects: nextTabProjects,
  };
}

/**
 * Inserts (or moves) a unified tab into `projectScope`, marks it active in that scope,
 * and optionally switches `activeProjectScope` to `projectScope` (default: true).
 */
export function activateTabInWorkspace(
  state: RightPaneWorkspaceState,
  tabId: string,
  projectScope: ProjectScopeKey,
  options?: { switchProject?: boolean },
): RightPaneWorkspaceState {
  const prevScope = state.tabProjects[tabId];
  const nextWorkspaces: Record<ProjectScopeKey, ProjectWorkspaceTabsState> = {
    ...state.workspaces,
  };

  // If the tab moved from another scope, remove it from the old scope
  if (prevScope && prevScope !== projectScope && nextWorkspaces[prevScope]) {
    const oldWs = nextWorkspaces[prevScope];
    const oldIdx = oldWs.tabOrder.indexOf(tabId);
    const filtered = oldWs.tabOrder.filter((id) => id !== tabId);
    if (filtered.length === 0) {
      delete nextWorkspaces[prevScope];
    } else {
      const nextOldActive =
        oldWs.activeTabId === tabId
          ? (filtered[Math.min(Math.max(0, oldIdx), filtered.length - 1)] ?? filtered[0])
          : oldWs.activeTabId;
      nextWorkspaces[prevScope] = { tabOrder: filtered, activeTabId: nextOldActive };
    }
  }

  const currentWs = nextWorkspaces[projectScope] ?? { tabOrder: [], activeTabId: null };
  const nextOrder = currentWs.tabOrder.includes(tabId)
    ? currentWs.tabOrder
    : [...currentWs.tabOrder, tabId];

  nextWorkspaces[projectScope] = {
    tabOrder: nextOrder,
    activeTabId: tabId,
  };

  return {
    activeProjectScope:
      options?.switchProject === false ? state.activeProjectScope : projectScope,
    workspaces: nextWorkspaces,
    tabProjects: {
      ...state.tabProjects,
      [tabId]: projectScope,
    },
  };
}

export function selectTabInWorkspace(
  state: RightPaneWorkspaceState,
  tabId: string,
): RightPaneWorkspaceState {
  const scope = state.tabProjects[tabId] ?? state.activeProjectScope;
  return activateTabInWorkspace(state, tabId, scope, { switchProject: true });
}

export function closeTabInWorkspace(
  state: RightPaneWorkspaceState,
  tabId: string,
): { nextState: RightPaneWorkspaceState; nextActiveTabId: string | null } {
  const scope = state.tabProjects[tabId] ?? state.activeProjectScope;
  const ws = state.workspaces[scope];
  const nextTabProjects = { ...state.tabProjects };
  delete nextTabProjects[tabId];

  if (!ws) {
    return {
      nextState: {
        ...state,
        tabProjects: nextTabProjects,
      },
      nextActiveTabId: null,
    };
  }

  const idx = ws.tabOrder.indexOf(tabId);
  const nextOrder = ws.tabOrder.filter((id) => id !== tabId);
  const nextWorkspaces = { ...state.workspaces };
  let nextActive: string | null = ws.activeTabId;

  if (nextOrder.length === 0) {
    delete nextWorkspaces[scope];
    nextActive = null;
  } else {
    if (ws.activeTabId === tabId) {
      nextActive = nextOrder[Math.min(Math.max(0, idx), nextOrder.length - 1)] ?? nextOrder[0];
    }
    nextWorkspaces[scope] = {
      tabOrder: nextOrder,
      activeTabId: nextActive,
    };
  }

  return {
    nextState: {
      ...state,
      workspaces: nextWorkspaces,
      tabProjects: nextTabProjects,
    },
    nextActiveTabId: nextActive,
  };
}

export function switchActiveProjectScope(
  state: RightPaneWorkspaceState,
  nextScope: ProjectScopeKey,
): RightPaneWorkspaceState {
  if (state.activeProjectScope === nextScope) return state;
  return {
    ...state,
    activeProjectScope: nextScope,
  };
}

// MARK: - Selectors

export function getProjectUnifiedTabs(
  state: RightPaneWorkspaceState,
  scopeKey: ProjectScopeKey,
  sources: Pick<RightPaneTabSources, "browserTabs" | "mdTabs" | "imageTabs" | "codeTabs">,
): UnifiedRightPaneTab[] {
  const browserById = new Map(sources.browserTabs.map((t) => [makeBrowserUnifiedTabId(t.id), t]));
  const mdById = new Map(sources.mdTabs.map((t) => [makeMarkdownUnifiedTabId(t.filePath), t]));
  const imageById = new Map(sources.imageTabs.map((t) => [makeImageUnifiedTabId(t.id), t]));
  const codeById = new Map(
    (sources.codeTabs ?? []).map((t) => [makeCodeUnifiedTabId(t.filePath), t]),
  );

  const ws = state.workspaces[scopeKey];
  const orderedIds = ws?.tabOrder ?? [];
  const result: UnifiedRightPaneTab[] = [];

  for (const id of orderedIds) {
    const bt = browserById.get(id);
    if (bt) {
      result.push({
        id,
        kind: "browser",
        projectScope: scopeKey,
        title: bt.title || "New Tab",
        subtitle: bt.url || "New Tab",
        isLoading: bt.isLoading,
        hasError: bt.consoleErrorCount + bt.networkErrorCount > 0,
        browserTab: bt,
      });
      continue;
    }

    const mt = mdById.get(id);
    if (mt) {
      result.push({
        id,
        kind: "markdown",
        projectScope: scopeKey,
        title: mt.fileName,
        subtitle: mt.filePath,
        isLoading: mt.isLoading,
        hasError: Boolean(mt.error),
        markdownTab: mt,
      });
      continue;
    }

    const it = imageById.get(id);
    if (it) {
      result.push({
        id,
        kind: "image",
        projectScope: scopeKey,
        title: it.label,
        subtitle: it.imagePath || it.fileName || it.label,
        isLoading: it.isLoading,
        hasError: Boolean(it.error),
        imageTab: it,
      });
      continue;
    }

    const ct = codeById.get(id);
    if (ct) {
      result.push({
        id,
        kind: "code",
        projectScope: scopeKey,
        title: ct.fileName,
        subtitle: ct.filePath,
        isLoading: ct.isLoading,
        hasError: Boolean(ct.error),
        codeTab: ct,
      });
    }
  }

  return result;
}

export function getActiveUnifiedTab(
  state: RightPaneWorkspaceState,
  sources: Pick<RightPaneTabSources, "browserTabs" | "mdTabs" | "imageTabs" | "codeTabs">,
): UnifiedRightPaneTab | null {
  const tabs = getProjectUnifiedTabs(state, state.activeProjectScope, sources);
  if (tabs.length === 0) return null;
  const activeId = state.workspaces[state.activeProjectScope]?.activeTabId;
  return tabs.find((t) => t.id === activeId) ?? tabs[0] ?? null;
}

export function buildProjectSwitcherItems(
  state: RightPaneWorkspaceState,
  sources: Pick<RightPaneTabSources, "browserTabs" | "mdTabs" | "imageTabs" | "codeTabs" | "projects">,
  query = "",
): {
  withTabs: ProjectSwitcherItem[];
  others: ProjectSwitcherItem[];
  all: ProjectSwitcherItem[];
} {
  const q = query.trim().toLowerCase();

  const makeItem = (scopeKey: ProjectScopeKey, project: Project | null): ProjectSwitcherItem => {
    const tabs = getProjectUnifiedTabs(state, scopeKey, sources);
    let browserCount = 0;
    let markdownCount = 0;
    let imageCount = 0;
    let codeCount = 0;
    for (const tab of tabs) {
      if (tab.kind === "browser") browserCount += 1;
      else if (tab.kind === "markdown") markdownCount += 1;
      else if (tab.kind === "image") imageCount += 1;
      else if (tab.kind === "code") codeCount += 1;
    }
    return {
      scopeKey,
      project,
      name: project ? project.name : "General",
      path: project ? project.path : null,
      colorHex: project ? project.colorHex : "#71717A",
      tabCount: tabs.length,
      browserCount,
      markdownCount,
      imageCount,
      codeCount,
      isActive: state.activeProjectScope === scopeKey,
      isGeneral: project === null,
    };
  };

  const rawItems: ProjectSwitcherItem[] = [
    ...sources.projects.map((p) => makeItem(p.id, p)),
    makeItem(GENERAL_PROJECT_SCOPE, null),
  ];

  const filtered = q
    ? rawItems.filter(
        (item) =>
          item.name.toLowerCase().includes(q) ||
          (item.path ? item.path.toLowerCase().includes(q) : false),
      )
    : rawItems;

  const withTabs = filtered
    .filter((item) => item.tabCount > 0)
    .sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      if (a.isGeneral !== b.isGeneral) return a.isGeneral ? 1 : -1;
      return b.tabCount - a.tabCount || a.name.localeCompare(b.name);
    });

  const others = filtered
    .filter((item) => item.tabCount === 0)
    .sort((a, b) => {
      if (a.isGeneral !== b.isGeneral) return a.isGeneral ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

  return {
    withTabs,
    others,
    all: [...withTabs, ...others],
  };
}

// MARK: - Persistence Helpers

export function serializeRightPaneWorkspace(
  state: RightPaneWorkspaceState,
  mdTabs: readonly MarkdownViewerTab[],
): PersistedRightPaneWorkspace {
  const openMarkdownFiles = mdTabs.map((tab) => ({
    filePath: tab.filePath,
    projectScope:
      state.tabProjects[makeMarkdownUnifiedTabId(tab.filePath)] ?? GENERAL_PROJECT_SCOPE,
  }));

  // Strip transient image & code tab entries from persisted workspaces so localStorage stays lean
  const isTransientTabId = (id: string) => id.startsWith("image:") || id.startsWith("code:");
  const workspaces: Record<ProjectScopeKey, ProjectWorkspaceTabsState> = {};
  for (const [scope, ws] of Object.entries(state.workspaces)) {
    const persistableOrder = ws.tabOrder.filter((id) => !isTransientTabId(id));
    if (persistableOrder.length === 0) continue;
    const activeTabId =
      ws.activeTabId && persistableOrder.includes(ws.activeTabId)
        ? ws.activeTabId
        : persistableOrder[0];
    workspaces[scope] = { tabOrder: persistableOrder, activeTabId };
  }

  const tabProjects: Record<string, ProjectScopeKey> = {};
  for (const [tabId, scope] of Object.entries(state.tabProjects)) {
    if (!isTransientTabId(tabId)) {
      tabProjects[tabId] = scope;
    }
  }

  return {
    activeProjectScope: state.activeProjectScope,
    workspaces,
    tabProjects,
    openMarkdownFiles,
  };
}

export function deserializeRightPaneWorkspace(raw: unknown): {
  state: RightPaneWorkspaceState;
  openMarkdownFiles: Array<{ filePath: string; projectScope: ProjectScopeKey }>;
} {
  if (!raw || typeof raw !== "object") {
    return { state: createEmptyRightPaneWorkspaceState(), openMarkdownFiles: [] };
  }
  const obj = raw as Record<string, unknown>;
  const activeProjectScope =
    typeof obj.activeProjectScope === "string" && obj.activeProjectScope.length > 0
      ? obj.activeProjectScope
      : GENERAL_PROJECT_SCOPE;

  const workspaces: Record<ProjectScopeKey, ProjectWorkspaceTabsState> = {};
  if (obj.workspaces && typeof obj.workspaces === "object") {
    for (const [scope, val] of Object.entries(obj.workspaces as Record<string, unknown>)) {
      if (!val || typeof val !== "object") continue;
      const ws = val as Record<string, unknown>;
      const tabOrder = Array.isArray(ws.tabOrder)
        ? dedupeOrder(ws.tabOrder.filter((id): id is string => typeof id === "string" && id.length > 0))
        : [];
      const activeTabId =
        typeof ws.activeTabId === "string" && tabOrder.includes(ws.activeTabId)
          ? ws.activeTabId
          : (tabOrder[0] ?? null);
      if (tabOrder.length > 0) {
        workspaces[scope] = { tabOrder, activeTabId };
      }
    }
  }

  const tabProjects: Record<string, ProjectScopeKey> = {};
  if (obj.tabProjects && typeof obj.tabProjects === "object") {
    for (const [tabId, scope] of Object.entries(obj.tabProjects as Record<string, unknown>)) {
      if (typeof scope === "string" && scope.length > 0) {
        tabProjects[tabId] = scope;
      }
    }
  }

  const openMarkdownFiles: Array<{ filePath: string; projectScope: ProjectScopeKey }> = [];
  if (Array.isArray(obj.openMarkdownFiles)) {
    const seen = new Set<string>();
    for (const entry of obj.openMarkdownFiles) {
      if (!entry || typeof entry !== "object") continue;
      const rec = entry as Record<string, unknown>;
      if (typeof rec.filePath === "string" && rec.filePath.length > 0 && !seen.has(rec.filePath)) {
        seen.add(rec.filePath);
        const scope =
          typeof rec.projectScope === "string" && rec.projectScope.length > 0
            ? rec.projectScope
            : GENERAL_PROJECT_SCOPE;
        openMarkdownFiles.push({ filePath: rec.filePath, projectScope: scope });
        tabProjects[makeMarkdownUnifiedTabId(rec.filePath)] = scope;
      }
    }
  }

  return {
    state: {
      activeProjectScope,
      workspaces,
      tabProjects,
    },
    openMarkdownFiles,
  };
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function getBrowserStorage(): StorageLike | null {
  const g = globalThis as unknown as { localStorage?: StorageLike };
  return g.localStorage ?? null;
}

export function loadRightPaneWorkspaceFromStorage(): {
  state: RightPaneWorkspaceState;
  openMarkdownFiles: Array<{ filePath: string; projectScope: ProjectScopeKey }>;
} {
  try {
    const storage = getBrowserStorage();
    if (!storage) {
      return { state: createEmptyRightPaneWorkspaceState(), openMarkdownFiles: [] };
    }
    const raw = storage.getItem(RIGHT_PANE_WORKSPACE_STORAGE_KEY);
    if (!raw) {
      return { state: createEmptyRightPaneWorkspaceState(), openMarkdownFiles: [] };
    }
    return deserializeRightPaneWorkspace(JSON.parse(raw));
  } catch {
    return { state: createEmptyRightPaneWorkspaceState(), openMarkdownFiles: [] };
  }
}

export function saveRightPaneWorkspaceToStorage(
  state: RightPaneWorkspaceState,
  mdTabs: readonly MarkdownViewerTab[],
): void {
  try {
    const storage = getBrowserStorage();
    if (!storage) return;
    const serialized = serializeRightPaneWorkspace(state, mdTabs);
    storage.setItem(RIGHT_PANE_WORKSPACE_STORAGE_KEY, JSON.stringify(serialized));
  } catch {
    // ignore storage quota errors
  }
}
