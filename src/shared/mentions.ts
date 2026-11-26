import type {
  AgentTask,
  ChatMessageMentionRef,
  ExplicitMentionTarget,
  Project,
} from "./types.js";

export function formatTaskCode(taskNumber: number): string {
  return `T${taskNumber}`;
}

function isValidTaskNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function parseTimestamp(iso: string | undefined): number {
  if (!iso) return Number.MAX_SAFE_INTEGER;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}

/**
 * Deterministically ensures every task has a unique positive integer `taskNumber`
 * and computes a monotonic `nextTaskNumber` counter that never collides with
 * existing numbers or decreases below a previously persisted counter.
 *
 * Tasks lacking a valid `taskNumber` are assigned sequentially oldest `createdAt` first.
 */
export function normalizeTaskNumbers(
  tasks: Array<Omit<AgentTask, "taskNumber"> & { taskNumber?: number }>,
  persistedNextTaskNumber?: number,
): { tasks: AgentTask[]; nextTaskNumber: number; changed: boolean } {
  const indexed = tasks.map((task, index) => ({ task, index }));
  // Sort oldest-first so if duplicate numbers ever existed, the oldest keeps it,
  // and missing numbers are backfilled deterministically oldest-first.
  const oldestFirst = [...indexed].sort((a, b) => {
    const timeDiff = parseTimestamp(a.task.createdAt) - parseTimestamp(b.task.createdAt);
    if (timeDiff !== 0) return timeDiff;
    // Tasks are prepended newest-first, so a larger original index is older.
    const idxDiff = b.index - a.index;
    if (idxDiff !== 0) return idxDiff;
    return a.task.id.localeCompare(b.task.id);
  });

  const usedNumbers = new Set<number>();
  const assignedByIndex = new Map<number, number>();
  const missing: typeof oldestFirst = [];
  let maxAssigned = 0;

  for (const entry of oldestFirst) {
    const existing = entry.task.taskNumber;
    if (isValidTaskNumber(existing) && !usedNumbers.has(existing)) {
      usedNumbers.add(existing);
      assignedByIndex.set(entry.index, existing);
      if (existing > maxAssigned) maxAssigned = existing;
    } else {
      missing.push(entry);
    }
  }

  let nextCounter = Math.max(
    1,
    maxAssigned + 1,
    isValidTaskNumber(persistedNextTaskNumber) ? persistedNextTaskNumber : 1,
  );

  let changed = false;
  for (const entry of missing) {
    while (usedNumbers.has(nextCounter)) {
      nextCounter += 1;
    }
    assignedByIndex.set(entry.index, nextCounter);
    usedNumbers.add(nextCounter);
    if (nextCounter > maxAssigned) maxAssigned = nextCounter;
    nextCounter += 1;
    changed = true;
  }

  const finalNextTaskNumber = Math.max(nextCounter, maxAssigned + 1, 1);
  if (!isValidTaskNumber(persistedNextTaskNumber) || persistedNextTaskNumber !== finalNextTaskNumber) {
    changed = true;
  }

  const normalizedTasks: AgentTask[] = tasks.map((task, index) => {
    const num = assignedByIndex.get(index)!;
    if (task.taskNumber === num) {
      return task as AgentTask;
    }
    changed = true;
    return {
      ...task,
      taskNumber: num,
    };
  });

  return {
    tasks: normalizedTasks,
    nextTaskNumber: finalNextTaskNumber,
    changed,
  };
}

// MARK: - Mention Parsing & Resolution

export type MentionKind = "project" | "task" | "project_task";

export interface ParsedMention {
  raw: string;
  start: number;
  end: number;
  kind: MentionKind;
  projectName?: string;
  taskNumber?: number;
  project?: Project;
  task?: AgentTask;
}

export interface ResolvedMentions {
  mentions: ParsedMention[];
  projects: Project[];
  tasks: AgentTask[];
  unresolvedTaskCodes: string[];
}

const EMAIL_LOCAL_CHAR_RE = /[A-Za-z0-9._+-]/;
const ASCII_TOKEN_CHAR_RE = /[A-Za-z0-9_-]/;
const HARD_BREAK_RE = /[\s@/,、。！？!?()[\]{}<>"'「」『』【】;:`]/;

function isValidMentionPrefix(text: string, atIndex: number): boolean {
  if (atIndex === 0) return true;
  const prev = text[atIndex - 1];
  return !EMAIL_LOCAL_CHAR_RE.test(prev);
}

function findProjectByName(projects: Project[], name: string): Project | undefined {
  const lower = name.toLowerCase();
  return projects.find((p) => p.name.toLowerCase() === lower);
}

function findTaskByNumber(tasks: AgentTask[], taskNumber: number): AgentTask | undefined {
  return tasks.find((t) => t.taskNumber === taskNumber);
}

/**
 * Parse and resolve `@<projectName>`, `@T<number>`, and `@<projectName>/T<number>`
 * mentions from a user chat message against the full project registry and task list.
 */
export function parseAndResolveMentions(
  text: string,
  projects: Project[],
  tasks: AgentTask[],
): ResolvedMentions {
  const mentions: ParsedMention[] = [];
  const resolvedProjectMap = new Map<string, Project>();
  const resolvedTaskMap = new Map<string, AgentTask>();
  const unresolvedTaskSet = new Set<string>();

  // Sort projects longest name first so `@my-app-v2` matches before `@my-app`.
  const projectsByLength = [...projects].sort((a, b) => b.name.length - a.name.length);

  let i = 0;
  while (i < text.length) {
    if (text[i] !== "@" || !isValidMentionPrefix(text, i)) {
      i += 1;
      continue;
    }

    const rest = text.slice(i + 1);

    // 1. Try `@<projectName>/T<number>` (exact known project prefix first, then generic token)
    let matchedProjectTask = false;
    for (const proj of projectsByLength) {
      const candidatePrefix = rest.slice(0, proj.name.length);
      if (candidatePrefix.toLowerCase() === proj.name.toLowerCase() && rest[proj.name.length] === "/") {
        const afterSlash = rest.slice(proj.name.length + 1);
        const taskMatch = afterSlash.match(/^[Tt](\d+)(?![A-Za-z0-9_/-])/);
        if (taskMatch) {
          const taskNumber = Number(taskMatch[1]);
          const fullLen = 1 + proj.name.length + 1 + taskMatch[0].length;
          const raw = text.slice(i, i + fullLen);
          const task = findTaskByNumber(tasks, taskNumber);
          mentions.push({
            raw,
            start: i,
            end: i + fullLen,
            kind: "project_task",
            projectName: proj.name,
            taskNumber,
            project: proj,
            task,
          });
          resolvedProjectMap.set(proj.id, proj);
          if (task) {
            resolvedTaskMap.set(task.id, task);
          } else {
            unresolvedTaskSet.add(raw);
          }
          i += fullLen;
          matchedProjectTask = true;
          break;
        }
      }
    }
    if (matchedProjectTask) continue;

    // Generic `@<unknownProject>/T<number>` fallback (e.g. project name not registered or task-only projectName)
    const genericProjTask = rest.match(/^([^\s@/,、。！？!?()[\]{}<>"'「」『』【】;:`]+)\/[Tt](\d+)(?![A-Za-z0-9_/-])/);
    if (genericProjTask) {
      const projToken = genericProjTask[1];
      const taskNumber = Number(genericProjTask[2]);
      const fullLen = 1 + genericProjTask[0].length;
      const raw = text.slice(i, i + fullLen);
      const project = findProjectByName(projects, projToken);
      const task = findTaskByNumber(tasks, taskNumber);
      mentions.push({
        raw,
        start: i,
        end: i + fullLen,
        kind: "project_task",
        projectName: project?.name ?? projToken,
        taskNumber,
        project,
        task,
      });
      if (project) resolvedProjectMap.set(project.id, project);
      if (task) {
        resolvedTaskMap.set(task.id, task);
      } else {
        unresolvedTaskSet.add(raw);
      }
      i += fullLen;
      continue;
    }

    // 2. Try `@T<number>`
    const taskOnlyMatch = rest.match(/^[Tt](\d+)(?![A-Za-z0-9_/-])/);
    if (taskOnlyMatch) {
      const taskNumber = Number(taskOnlyMatch[1]);
      const fullLen = 1 + taskOnlyMatch[0].length;
      const raw = text.slice(i, i + fullLen);
      const task = findTaskByNumber(tasks, taskNumber);
      mentions.push({
        raw,
        start: i,
        end: i + fullLen,
        kind: "task",
        taskNumber,
        task,
      });
      if (task) {
        resolvedTaskMap.set(task.id, task);
      } else {
        unresolvedTaskSet.add(raw);
      }
      i += fullLen;
      continue;
    }

    // 3. Try `@<projectName>` against all known projects (longest match first)
    let matchedProject = false;
    for (const proj of projectsByLength) {
      if (!proj.name) continue;
      const candidate = rest.slice(0, proj.name.length);
      if (candidate.toLowerCase() !== proj.name.toLowerCase()) continue;

      const nextChar = rest[proj.name.length];
      // Prevent matching `@app` inside `@apple` or `@app/foo`
      if (nextChar === "/") continue;
      if (
        nextChar !== undefined &&
        ASCII_TOKEN_CHAR_RE.test(proj.name[proj.name.length - 1]) &&
        ASCII_TOKEN_CHAR_RE.test(nextChar)
      ) {
        continue;
      }

      const fullLen = 1 + proj.name.length;
      const raw = text.slice(i, i + fullLen);
      mentions.push({
        raw,
        start: i,
        end: i + fullLen,
        kind: "project",
        projectName: proj.name,
        project: proj,
      });
      resolvedProjectMap.set(proj.id, proj);
      i += fullLen;
      matchedProject = true;
      break;
    }
    if (matchedProject) continue;

    i += 1;
  }

  return {
    mentions,
    projects: [...resolvedProjectMap.values()],
    tasks: [...resolvedTaskMap.values()],
    unresolvedTaskCodes: [...unresolvedTaskSet],
  };
}

function findProjectForExplicitTarget(
  projects: readonly Project[],
  target: Extract<ExplicitMentionTarget, { kind: "project" }>,
): Project | undefined {
  if (target.projectId) {
    const byId = projects.find((p) => p.id === target.projectId);
    if (byId) return byId;
  }
  if (target.projectPath) {
    const normalizedTargetPath = target.projectPath.replace(/\/+$/, "");
    const byPath = projects.find((p) => p.path.replace(/\/+$/, "") === normalizedTargetPath);
    if (byPath) return byPath;
  }
  if (target.projectName) {
    const lower = target.projectName.toLowerCase();
    return projects.find((p) => p.name.toLowerCase() === lower);
  }
  return undefined;
}

function findTaskForExplicitTarget(
  tasks: readonly AgentTask[],
  target: Extract<ExplicitMentionTarget, { kind: "task" }>,
): AgentTask | undefined {
  if (target.taskId) {
    const byId = tasks.find((t) => t.id === target.taskId);
    if (byId) return byId;
  }
  if (typeof target.taskNumber === "number" && Number.isInteger(target.taskNumber) && target.taskNumber > 0) {
    return tasks.find((t) => t.taskNumber === target.taskNumber);
  }
  return undefined;
}

/**
 * Adds a structured project/task mention target to a draft selection list (deduplicated).
 */
export function addExplicitMentionTarget(
  current: readonly ExplicitMentionTarget[],
  target: ExplicitMentionTarget,
): ExplicitMentionTarget[] {
  const alreadyPresent = current.some((item) => {
    if (item.kind !== target.kind) return false;
    if (item.kind === "task" && target.kind === "task") {
      return (
        item.taskId === target.taskId ||
        (target.taskNumber !== undefined && item.taskNumber === target.taskNumber)
      );
    }
    if (item.kind === "project" && target.kind === "project") {
      if (item.projectId && target.projectId && item.projectId === target.projectId) return true;
      if (
        item.projectName &&
        target.projectName &&
        item.projectName.toLowerCase() === target.projectName.toLowerCase()
      ) {
        return true;
      }
    }
    return false;
  });
  if (alreadyPresent) return [...current];
  return [...current, target];
}

/**
 * Removes a matching structured project/task mention target from a draft selection list.
 */
export function removeExplicitMentionTarget(
  current: readonly ExplicitMentionTarget[],
  target: MentionChipRemovalTarget,
): ExplicitMentionTarget[] {
  return current.filter((item) => {
    if (target.kind === "task") {
      if (item.kind !== "task") return true;
      if (item.taskId === target.taskId) return false;
      if (target.taskNumber !== undefined && item.taskNumber === target.taskNumber) return false;
      return true;
    }
    if (item.kind !== "project") return true;
    if (item.projectId && item.projectId === target.projectId) return false;
    if (
      target.projectName &&
      item.projectName &&
      item.projectName.toLowerCase() === target.projectName.toLowerCase()
    ) {
      return false;
    }
    return true;
  });
}

/**
 * Converts an autocomplete suggestion into a structured composer mention target.
 */
export function suggestionToExplicitMentionTarget(
  suggestion: MentionSuggestion,
): ExplicitMentionTarget {
  if (suggestion.kind === "task") {
    return {
      kind: "task",
      taskId: suggestion.task.id,
      taskNumber: suggestion.task.taskNumber,
      taskTitle: suggestion.task.title,
      taskStatus: suggestion.task.status,
      projectId: suggestion.task.projectId,
      projectName: suggestion.task.projectName,
      projectPath: suggestion.task.projectPath,
      projectColorHex: suggestion.projectColorHex,
    };
  }
  return {
    kind: "project",
    projectId: suggestion.project.id,
    projectName: suggestion.project.name,
    projectPath: suggestion.project.path,
    projectColorHex: suggestion.project.colorHex,
  };
}

/**
 * Formats the `[Explicitly Mentioned Context]` section injected into the
 * Conductor orchestrator prompt when the user attaches mention chips or uses
 * inline `@project`, `@T#`, or `@project/T#` tokens.
 */
export function buildExplicitMentionContextSection(
  userText: string,
  projects: Project[],
  tasks: AgentTask[],
  explicitMentions?: readonly ExplicitMentionTarget[],
): string | null {
  const resolvedProjectMap = new Map<string, Project>();
  const resolvedTaskMap = new Map<string, AgentTask>();
  const unresolvedTaskSet = new Set<string>();

  if (Array.isArray(explicitMentions)) {
    for (const target of explicitMentions) {
      if (target.kind === "project") {
        const proj = findProjectForExplicitTarget(projects, target);
        if (proj) {
          resolvedProjectMap.set(proj.id, proj);
        }
      } else if (target.kind === "task") {
        const task = findTaskForExplicitTarget(tasks, target);
        if (task) {
          resolvedTaskMap.set(task.id, task);
        } else if (typeof target.taskNumber === "number" && target.taskNumber > 0) {
          unresolvedTaskSet.add(`@${formatTaskCode(target.taskNumber)}`);
        }
      }
    }
  }

  const parsed = parseAndResolveMentions(userText, projects, tasks);
  for (const p of parsed.projects) {
    if (!resolvedProjectMap.has(p.id)) {
      resolvedProjectMap.set(p.id, p);
    }
  }
  for (const t of parsed.tasks) {
    if (!resolvedTaskMap.has(t.id)) {
      resolvedTaskMap.set(t.id, t);
    }
  }
  for (const raw of parsed.unresolvedTaskCodes) {
    unresolvedTaskSet.add(raw);
  }

  const resolvedProjects = [...resolvedProjectMap.values()];
  const resolvedTasks = [...resolvedTaskMap.values()];
  const unresolvedTaskCodes = [...unresolvedTaskSet];

  if (
    resolvedProjects.length === 0 &&
    resolvedTasks.length === 0 &&
    unresolvedTaskCodes.length === 0
  ) {
    return null;
  }

  const lines: string[] = ["[Explicitly Mentioned Context]"];

  if (resolvedProjects.length > 0) {
    lines.push("Explicitly mentioned projects:");
    for (const p of resolvedProjects) {
      lines.push(
        `- @${p.name} | name="${p.name}" | path="${p.path}"${p.gitBranch ? ` | branch="${p.gitBranch}"` : ""}`,
      );
    }
  }

  if (resolvedTasks.length > 0) {
    lines.push("Explicitly mentioned tasks:");
    for (const t of resolvedTasks) {
      const code = formatTaskCode(t.taskNumber);
      const taskPath = t.projectPath ?? findProjectForTask(projects, t)?.path ?? null;
      const parts = [
        `- @${code}`,
        `code=${code}`,
        `id=${t.id}`,
        `project="${t.projectName}"`,
        ...(taskPath ? [`path="${taskPath}"`] : []),
        `title="${t.title}"`,
        `status=${t.status}`,
        ...(t.currentStep ? [`step="${t.currentStep}"`] : []),
        ...(t.summary ? [`summary="${t.summary}"`] : []),
        ...(t.previewURL ? [`preview_url=${t.previewURL}`] : []),
      ];
      lines.push(parts.join(" | "));
    }
  }

  if (unresolvedTaskCodes.length > 0) {
    lines.push("Unresolved task mentions (not found in current task list):");
    for (const raw of unresolvedTaskCodes) {
      lines.push(`- ${raw}`);
    }
  }

  return lines.join("\n");
}

// MARK: - Message Mention Badge Extraction & Resolution

export type ResolvedMessageMentionBadgeSource = "explicit" | "inferred";

export type ResolvedMessageMentionBadge =
  | {
      key: string;
      kind: "project";
      projectId: string | null;
      projectName: string;
      projectPath: string | null;
      projectColorHex: string;
      isLiveProject: boolean;
      source?: ResolvedMessageMentionBadgeSource;
    }
  | {
      key: string;
      kind: "task";
      taskId: string;
      taskNumber: number;
      taskCode: string;
      taskTitle: string;
      taskStatus?: AgentTask["status"];
      projectId: string | null;
      projectName: string;
      projectPath: string | null;
      projectColorHex: string;
      isLiveTask: boolean;
      source?: ResolvedMessageMentionBadgeSource;
    };

export function createTaskMentionRef(
  task: AgentTask,
  projects: readonly Project[],
): Extract<ChatMessageMentionRef, { kind: "task" }> {
  const taskProject = findProjectForTask(projects, task);
  return {
    kind: "task",
    taskId: task.id,
    taskNumber: task.taskNumber,
    taskTitle: task.title,
    taskStatus: task.status,
    projectId: taskProject?.id ?? task.projectId,
    projectName: task.projectName || taskProject?.name || "",
    projectPath: task.projectPath ?? taskProject?.path ?? null,
    projectColorHex: taskProject?.colorHex ?? "#6366F1",
  };
}

export function createProjectMentionRef(
  project: Project,
): Extract<ChatMessageMentionRef, { kind: "project" }> {
  return {
    kind: "project",
    projectId: project.id,
    projectName: project.name,
    projectPath: project.path,
    projectColorHex: project.colorHex,
  };
}

function sameProjectRef(
  a: { projectId: string | null; projectName: string },
  b: { projectId: string | null; projectName: string },
): boolean {
  if (a.projectId && b.projectId && a.projectId === b.projectId) return true;
  const nameA = a.projectName.trim().toLowerCase();
  const nameB = b.projectName.trim().toLowerCase();
  return Boolean(nameA && nameB && nameA === nameB);
}

/**
 * Merges incoming Conductor-inferred project/task references into an existing
 * `inferredMentions` list while deduplicating against both existing inferred refs
 * and explicit user mentions.
 *
 * - Task refs already present in `explicitMentions` are skipped.
 * - Task refs already present in `existing` update their snapshot metadata in place.
 * - A new task ref supersedes any standalone inferred project ref for the same project.
 * - Standalone project refs are skipped if any task or project ref (explicit or inferred)
 *   already covers that project.
 */
export function mergeChatMessageMentionRefs(
  existing: readonly ChatMessageMentionRef[] | undefined,
  incoming: readonly ChatMessageMentionRef[],
  explicitMentions?: readonly ChatMessageMentionRef[],
): { refs: ChatMessageMentionRef[]; changed: boolean } {
  const result: ChatMessageMentionRef[] = Array.isArray(existing)
    ? existing.map((ref) => ({ ...ref }))
    : [];
  const explicit = Array.isArray(explicitMentions) ? explicitMentions : [];
  let changed = false;

  for (const ref of incoming) {
    if (ref.kind === "task") {
      const inExplicit = explicit.some(
        (e) => e.kind === "task" && (e.taskId === ref.taskId || e.taskNumber === ref.taskNumber),
      );
      if (inExplicit) continue;

      const existingIdx = result.findIndex(
        (r) => r.kind === "task" && (r.taskId === ref.taskId || r.taskNumber === ref.taskNumber),
      );
      if (existingIdx !== -1) {
        const prev = result[existingIdx]!;
        if (
          prev.kind === "task" &&
          (prev.taskTitle !== ref.taskTitle ||
            prev.taskStatus !== ref.taskStatus ||
            prev.projectId !== ref.projectId ||
            prev.projectName !== ref.projectName ||
            prev.projectPath !== ref.projectPath ||
            prev.projectColorHex !== ref.projectColorHex)
        ) {
          result[existingIdx] = { ...ref };
          changed = true;
        }
        continue;
      }

      const redundantProjIdx = result.findIndex(
        (r) => r.kind === "project" && sameProjectRef(r, ref),
      );
      if (redundantProjIdx !== -1) {
        result[redundantProjIdx] = { ...ref };
      } else {
        result.push({ ...ref });
      }
      changed = true;
      continue;
    }

    if (ref.kind === "project") {
      const coveredByExplicit = explicit.some((e) => sameProjectRef(e, ref));
      if (coveredByExplicit) continue;
      const coveredByExisting = result.some((r) => sameProjectRef(r, ref));
      if (coveredByExisting) continue;
      result.push({ ...ref });
      changed = true;
    }
  }

  return { refs: result, changed };
}

/**
 * Extracts a deduplicated snapshot of resolved project/task mentions referenced
 * in a user chat message (in appearance order) for persistence on `ChatMessage`.
 *
 * `@project/T#` emits only the task ref (since the task badge already displays
 * the project name alongside the task code and title), while standalone `@project`
 * emits a project ref.
 */
export function extractMentionRefsForMessage(
  text: string,
  projects: Project[],
  tasks: AgentTask[],
  explicitMentions?: readonly ExplicitMentionTarget[],
): ChatMessageMentionRef[] {
  const refs: ChatMessageMentionRef[] = [];
  const seenTaskIds = new Set<string>();
  const seenTaskNumbers = new Set<number>();
  const seenProjectIds = new Set<string>();
  const seenProjectNames = new Set<string>();

  const pushTaskRef = (task: AgentTask, explicitProject?: Project) => {
    if (seenTaskIds.has(task.id) || seenTaskNumbers.has(task.taskNumber)) return;
    seenTaskIds.add(task.id);
    seenTaskNumbers.add(task.taskNumber);
    const taskProject = explicitProject ?? findProjectForTask(projects, task);
    refs.push({
      kind: "task",
      taskId: task.id,
      taskNumber: task.taskNumber,
      taskTitle: task.title,
      taskStatus: task.status,
      projectId: taskProject?.id ?? task.projectId,
      projectName: task.projectName || taskProject?.name || "",
      projectPath: task.projectPath ?? taskProject?.path ?? null,
      projectColorHex: taskProject?.colorHex ?? "#6366F1",
    });
  };

  const pushProjectRef = (project: Project) => {
    const lowerName = project.name.toLowerCase();
    if (seenProjectIds.has(project.id) || seenProjectNames.has(lowerName)) return;
    seenProjectIds.add(project.id);
    seenProjectNames.add(lowerName);
    refs.push({
      kind: "project",
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      projectColorHex: project.colorHex,
    });
  };

  // 1. Resolve structured mention targets attached via chips first (preserving selection order)
  if (Array.isArray(explicitMentions)) {
    for (const target of explicitMentions) {
      if (target.kind === "task") {
        const task = findTaskForExplicitTarget(tasks, target);
        if (task) {
          pushTaskRef(task);
        } else if (
          typeof target.taskNumber === "number" &&
          Number.isInteger(target.taskNumber) &&
          target.taskNumber > 0
        ) {
          if (
            (target.taskId && seenTaskIds.has(target.taskId)) ||
            seenTaskNumbers.has(target.taskNumber)
          ) {
            continue;
          }
          if (target.taskId) seenTaskIds.add(target.taskId);
          seenTaskNumbers.add(target.taskNumber);
          const fallbackProject =
            (target.projectId ? projects.find((p) => p.id === target.projectId) : undefined) ??
            (target.projectName
              ? projects.find((p) => p.name.toLowerCase() === target.projectName!.toLowerCase())
              : undefined);
          refs.push({
            kind: "task",
            taskId: target.taskId,
            taskNumber: target.taskNumber,
            taskTitle: target.taskTitle ?? "",
            taskStatus: target.taskStatus,
            projectId: fallbackProject?.id ?? target.projectId ?? null,
            projectName: target.projectName || fallbackProject?.name || "",
            projectPath: target.projectPath ?? fallbackProject?.path ?? null,
            projectColorHex: fallbackProject?.colorHex ?? target.projectColorHex ?? "#6366F1",
          });
        }
      } else if (target.kind === "project") {
        const proj = findProjectForExplicitTarget(projects, target);
        if (proj) {
          pushProjectRef(proj);
        } else if (target.projectName?.trim()) {
          const projectName = target.projectName.trim();
          const lowerName = projectName.toLowerCase();
          if (
            (target.projectId && seenProjectIds.has(target.projectId)) ||
            seenProjectNames.has(lowerName)
          ) {
            continue;
          }
          if (target.projectId) seenProjectIds.add(target.projectId);
          seenProjectNames.add(lowerName);
          refs.push({
            kind: "project",
            projectId: target.projectId,
            projectName,
            projectPath: target.projectPath ?? null,
            projectColorHex: target.projectColorHex ?? "#6366F1",
          });
        }
      }
    }
  }

  // 2. Merge any inline `@project`, `@T#`, or `@project/T#` text mentions (deduplicated)
  const { mentions } = parseAndResolveMentions(text, projects, tasks);
  for (const m of mentions) {
    if (m.kind === "task" || m.kind === "project_task") {
      if (m.task) {
        pushTaskRef(m.task, m.project);
        continue;
      }

      if (m.kind === "project_task" && m.project) {
        pushProjectRef(m.project);
      }
      continue;
    }

    if (m.kind === "project" && m.project) {
      pushProjectRef(m.project);
    }
  }

  return refs;
}

/**
 * Resolves deduplicated display badges for all referenced projects and tasks on a
 * posted user chat message. Combines any persisted mention snapshot (keeping old
 * task titles / project names readable even after deletion), live resolution
 * via `parseAndResolveMentions` (so restored/legacy history messages also show badges),
 * and Conductor-inferred references linked while replying to the message.
 */
export function resolveMessageMentionBadges(
  text: string,
  projects: Project[],
  tasks: AgentTask[],
  persistedMentions?: readonly ChatMessageMentionRef[],
  inferredMentions?: readonly ChatMessageMentionRef[],
): ResolvedMessageMentionBadge[] {
  const badges: ResolvedMessageMentionBadge[] = [];
  const seenTaskIds = new Set<string>();
  const seenTaskNumbers = new Set<number>();
  const seenProjectIds = new Set<string>();
  const seenProjectNames = new Set<string>();

  const makeTaskBadge = (
    ref: {
      taskId: string;
      taskNumber: number;
      taskTitle: string;
      taskStatus?: AgentTask["status"];
      projectId: string | null;
      projectName: string;
      projectPath: string | null;
      projectColorHex: string;
    },
    isLiveTask: boolean,
    source: ResolvedMessageMentionBadgeSource,
  ): Extract<ResolvedMessageMentionBadge, { kind: "task" }> => ({
    key: `task:${ref.taskId || ref.taskNumber}`,
    kind: "task",
    taskId: ref.taskId,
    taskNumber: ref.taskNumber,
    taskCode: formatTaskCode(ref.taskNumber),
    taskTitle: ref.taskTitle,
    taskStatus: ref.taskStatus,
    projectId: ref.projectId,
    projectName: ref.projectName,
    projectPath: ref.projectPath,
    projectColorHex: ref.projectColorHex,
    isLiveTask,
    source,
  });

  const addTaskBadge = (
    ref: {
      taskId: string;
      taskNumber: number;
      taskTitle: string;
      taskStatus?: AgentTask["status"];
      projectId: string | null;
      projectName: string;
      projectPath: string | null;
      projectColorHex: string;
    },
    isLiveTask: boolean,
    source: ResolvedMessageMentionBadgeSource = "explicit",
  ) => {
    if ((ref.taskId && seenTaskIds.has(ref.taskId)) || seenTaskNumbers.has(ref.taskNumber)) return;
    if (ref.taskId) seenTaskIds.add(ref.taskId);
    seenTaskNumbers.add(ref.taskNumber);
    const badge = makeTaskBadge(ref, isLiveTask, source);

    if (source === "inferred") {
      // If a standalone project badge for the same project is already shown, upgrade it
      // in-place so `[T#] [project] <title>` isn't duplicated next to `[project]`.
      const standaloneProjectIdx = badges.findIndex(
        (existing) => existing.kind === "project" && sameProjectRef(existing, badge),
      );
      if (standaloneProjectIdx !== -1) {
        badges[standaloneProjectIdx] = badge;
        return;
      }
    }

    badges.push(badge);
  };

  const addProjectBadge = (
    ref: {
      projectId: string | null;
      projectName: string;
      projectPath: string | null;
      projectColorHex: string;
    },
    isLiveProject: boolean,
    source: ResolvedMessageMentionBadgeSource = "explicit",
  ) => {
    const lowerName = ref.projectName.toLowerCase();
    if (
      (ref.projectId && seenProjectIds.has(ref.projectId)) ||
      (lowerName && seenProjectNames.has(lowerName))
    ) {
      return;
    }
    if (source === "inferred") {
      // Skip standalone inferred project badge if any task/project badge already covers this project.
      if (badges.some((existing) => sameProjectRef(existing, ref))) {
        return;
      }
    }
    if (ref.projectId) seenProjectIds.add(ref.projectId);
    if (lowerName) seenProjectNames.add(lowerName);
    badges.push({
      key: `project:${ref.projectId ?? lowerName}`,
      kind: "project",
      projectId: ref.projectId,
      projectName: ref.projectName,
      projectPath: ref.projectPath,
      projectColorHex: ref.projectColorHex,
      isLiveProject,
      source,
    });
  };

  const hydrateMentionSnapshots = (
    snapshots: readonly ChatMessageMentionRef[] | undefined,
    source: ResolvedMessageMentionBadgeSource,
  ) => {
    if (!Array.isArray(snapshots)) return;
    for (const snap of snapshots) {
      if (snap.kind === "task") {
        const liveTask =
          tasks.find((t) => t.id === snap.taskId) ??
          tasks.find((t) => t.taskNumber === snap.taskNumber);
        if (liveTask) {
          const liveProject = findProjectForTask(projects, liveTask);
          addTaskBadge(
            {
              taskId: liveTask.id,
              taskNumber: liveTask.taskNumber,
              taskTitle: liveTask.title,
              taskStatus: liveTask.status,
              projectId: liveProject?.id ?? liveTask.projectId,
              projectName: liveTask.projectName || liveProject?.name || snap.projectName,
              projectPath: liveTask.projectPath ?? liveProject?.path ?? snap.projectPath,
              projectColorHex: liveProject?.colorHex ?? snap.projectColorHex ?? "#6366F1",
            },
            true,
            source,
          );
        } else {
          const liveProject =
            (snap.projectId ? projects.find((p) => p.id === snap.projectId) : undefined) ??
            projects.find((p) => p.name.toLowerCase() === snap.projectName.toLowerCase());
          addTaskBadge(
            {
              taskId: snap.taskId,
              taskNumber: snap.taskNumber,
              taskTitle: snap.taskTitle,
              taskStatus: snap.taskStatus,
              projectId: liveProject?.id ?? snap.projectId,
              projectName: liveProject?.name ?? snap.projectName,
              projectPath: liveProject?.path ?? snap.projectPath,
              projectColorHex: liveProject?.colorHex ?? snap.projectColorHex ?? "#6366F1",
            },
            false,
            source,
          );
        }
      } else if (snap.kind === "project") {
        const liveProject =
          (snap.projectId ? projects.find((p) => p.id === snap.projectId) : undefined) ??
          projects.find((p) => p.name.toLowerCase() === snap.projectName.toLowerCase());
        if (liveProject) {
          addProjectBadge(
            {
              projectId: liveProject.id,
              projectName: liveProject.name,
              projectPath: liveProject.path,
              projectColorHex: liveProject.colorHex,
            },
            true,
            source,
          );
        } else {
          addProjectBadge(
            {
              projectId: snap.projectId,
              projectName: snap.projectName,
              projectPath: snap.projectPath,
              projectColorHex: snap.projectColorHex || "#6366F1",
            },
            false,
            source,
          );
        }
      }
    }
  };

  // 1. Hydrate any persisted explicit mention snapshots first (preserving original order & deleted items),
  //    refreshing details from live state when the project/task still exists.
  hydrateMentionSnapshots(persistedMentions, "explicit");

  // 2. Resolve live explicit mentions from message text (handles restored/legacy messages without
  //    persisted snapshots as well as projects/tasks registered later).
  const parsedRefs = extractMentionRefsForMessage(text, projects, tasks);
  for (const ref of parsedRefs) {
    if (ref.kind === "task") {
      addTaskBadge(ref, true, "explicit");
    } else {
      addProjectBadge(ref, true, "explicit");
    }
  }

  // 3. Hydrate Conductor-inferred references linked while replying to this user message.
  hydrateMentionSnapshots(inferredMentions, "inferred");

  return badges;
}

// MARK: - Chat Input Autocomplete Engine

export interface ActiveMentionQuery {
  /** Index of the `@` character in the input text. */
  start: number;
  /** Caret index (end of the active mention query). */
  end: number;
  /** Raw text after `@` up to the caret. */
  rawQuery: string;
  /** `"all"` for `@...`, `"project_tasks"` for `@<projectName>/...`. */
  mode: "all" | "project_tasks";
  /** Project portion before `/` when `mode === "project_tasks"`. */
  projectQuery: string;
  /** Task filter portion after `/` when `mode === "project_tasks"`. */
  taskQuery: string;
}

export type MentionSuggestion =
  | {
      id: string;
      kind: "project";
      project: Project;
      taskCount: number;
      insertText: string;
    }
  | {
      id: string;
      kind: "task";
      task: AgentTask;
      projectColorHex: string;
      insertText: string;
      scopedProjectName?: string;
    };

/**
 * Detects whether the caret is currently positioned inside an active `@...` token.
 */
export function detectActiveMention(text: string, caretIndex: number): ActiveMentionQuery | null {
  const safeCaret = Math.max(0, Math.min(caretIndex, text.length));
  let idx = safeCaret - 1;

  while (idx >= 0) {
    const ch = text[idx];
    if (ch === "@") {
      if (!isValidMentionPrefix(text, idx)) return null;
      const rawQuery = text.slice(idx + 1, safeCaret);
      const slashIndex = rawQuery.indexOf("/");
      if (slashIndex !== -1) {
        const projectQuery = rawQuery.slice(0, slashIndex);
        const taskQuery = rawQuery.slice(slashIndex + 1);
        // Reject second slash
        if (taskQuery.includes("/")) return null;
        if (!projectQuery) return null;
        return {
          start: idx,
          end: safeCaret,
          rawQuery,
          mode: "project_tasks",
          projectQuery,
          taskQuery,
        };
      }
      return {
        start: idx,
        end: safeCaret,
        rawQuery,
        mode: "all",
        projectQuery: "",
        taskQuery: "",
      };
    }
    if (ch !== "/" && HARD_BREAK_RE.test(ch)) {
      return null;
    }
    idx -= 1;
  }

  return null;
}

export function findProjectForTask(
  projects: readonly Project[],
  task: AgentTask,
): Project | undefined {
  if (task.projectId) {
    const byId = projects.find((p) => p.id === task.projectId);
    if (byId) return byId;
  }
  const lowerName = task.projectName.toLowerCase();
  return projects.find((p) => p.name.toLowerCase() === lowerName);
}

export function getProjectColorForTask(projects: readonly Project[], task: AgentTask): string {
  return findProjectForTask(projects, task)?.colorHex ?? "#6366F1";
}

function projectColorForTask(projects: readonly Project[], task: AgentTask): string {
  return getProjectColorForTask(projects, task);
}

function taskBelongsToProject(task: AgentTask, project: Project): boolean {
  if (task.projectId && task.projectId === project.id) return true;
  if (task.projectPath && task.projectPath === project.path) return true;
  return task.projectName.toLowerCase() === project.name.toLowerCase();
}

function scoreTaskMatch(task: AgentTask, q: string): number {
  const code = formatTaskCode(task.taskNumber).toLowerCase();
  const numStr = String(task.taskNumber);
  const title = task.title.toLowerCase();
  const proj = task.projectName.toLowerCase();

  if (!q) {
    // Active tasks surface first
    if (task.status === "running") return 50;
    if (task.status === "needs_review") return 45;
    if (task.status === "queued") return 40;
    return 30;
  }

  if (code === q || numStr === q) return 1000;
  if (code.startsWith(q)) return 900;
  if (numStr.startsWith(q)) return 850;
  if (title.startsWith(q)) return 700;
  if (proj.startsWith(q)) return 650;
  if (title.includes(q)) return 550;
  if (proj.includes(q)) return 500;
  return -1;
}

function scoreProjectMatch(project: Project, q: string): number {
  const name = project.name.toLowerCase();
  const fullPath = project.path.toLowerCase();
  if (!q) return 100;
  if (name === q) return 950;
  if (name.startsWith(q)) return 800;
  if (name.includes(q)) return 600;
  if (fullPath.includes(q)) return 400;
  return -1;
}

/**
 * Returns ranked project and task suggestions across ALL discovered/registered
 * projects (not limited to top 30) and all tasks.
 */
export function getMentionSuggestions(
  query: ActiveMentionQuery,
  projects: Project[],
  tasks: AgentTask[],
): {
  suggestions: MentionSuggestion[];
  scopedProject: Project | null;
} {
  if (query.mode === "project_tasks") {
    const pq = query.projectQuery.toLowerCase();
    const scopedProject =
      projects.find((p) => p.name.toLowerCase() === pq) ??
      projects.find((p) => p.name.toLowerCase().startsWith(pq)) ??
      null;

    const candidateTasks = scopedProject
      ? tasks.filter((t) => taskBelongsToProject(t, scopedProject))
      : tasks.filter((t) => t.projectName.toLowerCase() === pq);

    const tq = query.taskQuery.trim().toLowerCase();
    const matched = candidateTasks
      .map((task) => ({ task, score: scoreTaskMatch(task, tq) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score || b.task.taskNumber - a.task.taskNumber);

    const projLabel = scopedProject?.name ?? query.projectQuery;
    const suggestions: MentionSuggestion[] = matched.map(({ task }) => ({
      id: `task:${projLabel}:${task.id}`,
      kind: "task",
      task,
      projectColorHex: scopedProject?.colorHex ?? projectColorForTask(projects, task),
      insertText: `@${projLabel}/${formatTaskCode(task.taskNumber)}`,
      scopedProjectName: projLabel,
    }));

    return { suggestions, scopedProject };
  }

  const q = query.rawQuery.trim().toLowerCase();
  const isTaskCodeQuery = /^t\d*$/i.test(q);

  // Count tasks per project for subtle UI hints
  const taskCounts = new Map<string, number>();
  for (const t of tasks) {
    const key = t.projectId ?? t.projectName.toLowerCase();
    taskCounts.set(key, (taskCounts.get(key) ?? 0) + 1);
  }

  const matchedTasks = tasks
    .map((task) => ({ task, score: scoreTaskMatch(task, q) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || b.task.taskNumber - a.task.taskNumber)
    .map<MentionSuggestion>(({ task }) => ({
      id: `task:${task.id}`,
      kind: "task",
      task,
      projectColorHex: projectColorForTask(projects, task),
      insertText: `@${formatTaskCode(task.taskNumber)}`,
    }));

  const matchedProjects = projects
    .map((project, index) => ({ project, index, score: scoreProjectMatch(project, q) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map<MentionSuggestion>(({ project }) => ({
      id: `project:${project.id}`,
      kind: "project",
      project,
      taskCount: taskCounts.get(project.id) ?? taskCounts.get(project.name.toLowerCase()) ?? 0,
      insertText: `@${project.name}`,
    }));

  // When query looks like `@T` or `@T1`, put tasks first; otherwise show tasks first if empty
  // or interleave cleanly (tasks first when matching task code, projects & tasks grouped clearly).
  const suggestions = isTaskCodeQuery
    ? [...matchedTasks, ...matchedProjects]
    : q.length === 0
      ? [...matchedTasks, ...matchedProjects]
      : [
          ...matchedTasks.filter((item) => scoreTaskMatch((item as { task: AgentTask }).task, q) >= 850),
          ...matchedProjects,
          ...matchedTasks.filter((item) => scoreTaskMatch((item as { task: AgentTask }).task, q) < 850),
        ];

  return { suggestions, scopedProject: null };
}

/**
 * Replaces the active `@...` token in `text` with `insertText` and appends a single
 * space unless whitespace already follows the caret. Returns updated text and caret index.
 */
export function applyMentionSelection(
  text: string,
  query: ActiveMentionQuery,
  insertText: string,
): { nextText: string; nextCaret: number } {
  const before = text.slice(0, query.start);
  const after = text.slice(query.end);
  const needsSpace = after.length === 0 || !/^\s/.test(after);
  const inserted = needsSpace ? `${insertText} ` : insertText;
  const nextText = `${before}${inserted}${after}`;
  const nextCaret = before.length + inserted.length;
  return { nextText, nextCaret };
}

/**
 * Removes the active `@query` token from draft text after attaching a structured
 * mention chip, cleaning up redundant horizontal spaces around the removed token.
 */
export function removeActiveMentionQuery(
  text: string,
  query: ActiveMentionQuery,
): { nextText: string; nextCaret: number } {
  const updated = removeSpanWithCleanSpacing(text, query.start, query.end, query.end);
  if (updated.nextText.trim().length === 0) {
    return { nextText: "", nextCaret: 0 };
  }
  return {
    nextText: updated.nextText,
    nextCaret: Math.max(0, Math.min(updated.nextCaret, updated.nextText.length)),
  };
}

// MARK: - Resolved Mention Chips & Draft Removal

export type ResolvedMentionChip =
  | {
      key: string;
      kind: "task";
      task: AgentTask;
      project: Project | null;
      projectName: string;
      projectColorHex: string;
      taskCode: string;
      rawMentions: string[];
    }
  | {
      key: string;
      kind: "project";
      project: Project;
      projectName: string;
      projectColorHex: string;
      rawMentions: string[];
    };

export type MentionChipRemovalTarget =
  | { kind: "task"; taskId: string; taskNumber?: number }
  | { kind: "project"; projectId: string; projectName?: string };

/**
 * Extracts deduplicated, display-ready resolved mention chips combining structured
 * composer selections (`selectedMentions`) and any inline `@` mentions in `text`.
 *
 * - Structured selections appear first in selection order.
 * - `@T#` and `@project/T#` that resolve to an existing task produce a single task chip
 *   (not an extra standalone project chip, since the task chip already displays its project).
 * - Standalone `@project` mentions that resolve to a known project produce a project chip.
 * - Repeated references across structured chips and inline text are deduplicated.
 */
export function extractResolvedMentionChips(
  text: string,
  projects: Project[],
  tasks: AgentTask[],
  selectedMentions?: readonly ExplicitMentionTarget[],
): ResolvedMentionChip[] {
  const hasSelected = Array.isArray(selectedMentions) && selectedMentions.length > 0;
  const hasInlineAt = Boolean(text && text.includes("@"));
  if (!hasSelected && !hasInlineAt) return [];

  const chipsByKey = new Map<string, ResolvedMentionChip>();

  const upsertTaskChip = (task: AgentTask, raw?: string, fallbackProject?: Project) => {
    const key = `task:${task.id}`;
    const existing = chipsByKey.get(key);
    if (existing) {
      if (raw && !existing.rawMentions.includes(raw)) {
        existing.rawMentions.push(raw);
      }
      return;
    }

    const taskProject = findProjectForTask(projects, task) ?? fallbackProject ?? null;
    const projectName = taskProject?.name ?? task.projectName ?? "";
    const projectColorHex = taskProject?.colorHex ?? "#6366F1";

    chipsByKey.set(key, {
      key,
      kind: "task",
      task,
      project: taskProject,
      projectName,
      projectColorHex,
      taskCode: formatTaskCode(task.taskNumber),
      rawMentions: raw ? [raw] : [],
    });
  };

  const upsertProjectChip = (project: Project, raw?: string) => {
    const key = `project:${project.id}`;
    const existing = chipsByKey.get(key);
    if (existing) {
      if (raw && !existing.rawMentions.includes(raw)) {
        existing.rawMentions.push(raw);
      }
      return;
    }

    chipsByKey.set(key, {
      key,
      kind: "project",
      project,
      projectName: project.name,
      projectColorHex: project.colorHex,
      rawMentions: raw ? [raw] : [],
    });
  };

  if (hasSelected) {
    for (const target of selectedMentions) {
      if (target.kind === "task") {
        const task = findTaskForExplicitTarget(tasks, target);
        if (task) upsertTaskChip(task);
      } else if (target.kind === "project") {
        const proj = findProjectForExplicitTarget(projects, target);
        if (proj) upsertProjectChip(proj);
      }
    }
  }

  if (hasInlineAt) {
    const resolved = parseAndResolveMentions(text, projects, tasks);
    for (const mention of resolved.mentions) {
      if ((mention.kind === "task" || mention.kind === "project_task") && mention.task) {
        upsertTaskChip(mention.task, mention.raw, mention.project);
      } else if (mention.kind === "project" && mention.project) {
        upsertProjectChip(mention.project, mention.raw);
      }
    }
  }

  return [...chipsByKey.values()];
}

const TRAILING_PUNCT_RE = /^[.,、。！？!?:;)\]}」』】]/;

function removeSpanWithCleanSpacing(
  text: string,
  start: number,
  end: number,
  caret: number,
): { nextText: string; nextCaret: number } {
  let cutStart = start;
  let cutEnd = end;

  const before = text.slice(0, start);
  const after = text.slice(end);
  const hasSpaceBefore = /[ \t]$/.test(before);
  const hasSpaceAfter = /^[ \t]/.test(after);
  const atLineStart = before.length === 0 || before.endsWith("\n");
  const atLineEnd = after.length === 0 || after.startsWith("\n");
  const onlySpacesUntilLineEnd = /^[ \t]+(?:\n|$)/.test(after);

  if (hasSpaceBefore && onlySpacesUntilLineEnd) {
    const leadingMatch = before.match(/[ \t]+$/);
    if (leadingMatch) cutStart -= leadingMatch[0].length;
    const trailingMatch = after.match(/^[ \t]+/);
    if (trailingMatch) cutEnd += trailingMatch[0].length;
  } else if (hasSpaceBefore && hasSpaceAfter) {
    cutEnd += 1;
  } else if (atLineStart && hasSpaceAfter) {
    const match = after.match(/^[ \t]+/);
    if (match) cutEnd += match[0].length;
  } else if (hasSpaceBefore && (atLineEnd || TRAILING_PUNCT_RE.test(after))) {
    const match = before.match(/[ \t]+$/);
    if (match) cutStart -= match[0].length;
  }

  const nextText = text.slice(0, cutStart) + text.slice(cutEnd);
  let nextCaret = caret;
  if (caret > cutEnd) {
    nextCaret = caret - (cutEnd - cutStart);
  } else if (caret > cutStart) {
    nextCaret = cutStart;
  }
  return { nextText, nextCaret };
}

/**
 * Removes all occurrences of a resolved task or project mention from draft text,
 * tidying surrounding horizontal spaces while preserving newlines and unrelated mentions.
 */
export function removeResolvedMentionChip(
  text: string,
  target: MentionChipRemovalTarget,
  projects: Project[],
  tasks: AgentTask[],
  caretPos: number = text.length,
): { nextText: string; nextCaret: number; removedCount: number } {
  const safeCaret = Math.max(0, Math.min(caretPos, text.length));
  const resolved = parseAndResolveMentions(text, projects, tasks);

  const matchingSpans = resolved.mentions.filter((m) => {
    if (target.kind === "task") {
      return (m.kind === "task" || m.kind === "project_task") && m.task?.id === target.taskId;
    }
    return m.kind === "project" && m.project?.id === target.projectId;
  });

  if (matchingSpans.length === 0) {
    return { nextText: text, nextCaret: safeCaret, removedCount: 0 };
  }

  let nextText = text;
  let nextCaret = safeCaret;
  // Remove right-to-left so earlier indices stay valid.
  for (let idx = matchingSpans.length - 1; idx >= 0; idx -= 1) {
    const span = matchingSpans[idx];
    const updated = removeSpanWithCleanSpacing(nextText, span.start, span.end, nextCaret);
    nextText = updated.nextText;
    nextCaret = updated.nextCaret;
  }

  if (nextText.trim().length === 0) {
    return { nextText: "", nextCaret: 0, removedCount: matchingSpans.length };
  }

  return {
    nextText,
    nextCaret: Math.max(0, Math.min(nextCaret, nextText.length)),
    removedCount: matchingSpans.length,
  };
}
