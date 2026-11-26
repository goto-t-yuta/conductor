import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  addExplicitMentionTarget,
  applyMentionSelection,
  buildExplicitMentionContextSection,
  detectActiveMention,
  extractMentionRefsForMessage,
  extractResolvedMentionChips,
  formatTaskCode,
  getMentionSuggestions,
  normalizeTaskNumbers,
  parseAndResolveMentions,
  removeActiveMentionQuery,
  removeExplicitMentionTarget,
  removeResolvedMentionChip,
  resolveMessageMentionBadges,
  suggestionToExplicitMentionTarget,
} from "../src/shared/mentions.js";
import type {
  AgentTask,
  ChatMessageMentionRef,
  ExplicitMentionTarget,
  Project,
} from "../src/shared/types.js";
import type { BrowserManager } from "../src/main/browser-manager.js";
import { ConductorController } from "../src/main/conductor-controller.js";
import { StateStore } from "../src/main/state-store.js";

function makeProject(overrides: Partial<Project> & { id: string; name: string }): Project {
  return {
    path: `/Users/dev/Documents/${overrides.name}`,
    colorHex: "#3B82F6",
    gitBranch: "main",
    addedAt: "2026-11-20T00:00:00.000Z",
    ...overrides,
  };
}

function makeTask(
  overrides: Partial<AgentTask> & { id: string; title: string; projectName: string },
): AgentTask {
  return {
    taskNumber: 1,
    summary: "",
    projectId: null,
    projectPath: `/Users/dev/Documents/${overrides.projectName}`,
    status: "queued",
    currentStep: null,
    workerThreadId: null,
    activeTurnId: null,
    previewURL: null,
    latestOutput: "",
    activities: [],
    createdAt: "2026-11-20T00:00:00.000Z",
    updatedAt: "2026-11-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("Sequential task numbers (T1, T2, ...)", () => {
  it("deterministically backfills legacy tasks oldest createdAt first while preserving array order", () => {
    const newest = makeTask({
      id: "task-newest",
      title: "Newest task",
      projectName: "agent_terminal_2",
      createdAt: "2026-11-25T12:00:00.000Z",
    });
    const middle = makeTask({
      id: "task-middle",
      title: "Middle task",
      projectName: "agent_terminal_2",
      createdAt: "2026-11-24T12:00:00.000Z",
    });
    const oldest = makeTask({
      id: "task-oldest",
      title: "Oldest task",
      projectName: "alpha",
      createdAt: "2026-11-23T12:00:00.000Z",
    });

    // Strip taskNumber to simulate pre-migration persisted state
    const legacy = [newest, middle, oldest].map(({ taskNumber: _ignored, ...rest }) => rest);
    const res = normalizeTaskNumbers(legacy);

    expect(res.changed).toBe(true);
    expect(res.nextTaskNumber).toBe(4);
    expect(res.tasks.map((t) => t.id)).toEqual(["task-newest", "task-middle", "task-oldest"]);
    expect(res.tasks.map((t) => formatTaskCode(t.taskNumber))).toEqual(["T3", "T2", "T1"]);
  });

  it("preserves monotonic nextTaskNumber and never reuses deleted numbers", () => {
    const t1 = makeTask({
      id: "t1",
      taskNumber: 1,
      title: "First",
      projectName: "alpha",
      createdAt: "2026-11-20T01:00:00.000Z",
    });
    const t3 = makeTask({
      id: "t3",
      taskNumber: 3,
      title: "Third",
      projectName: "alpha",
      createdAt: "2026-11-20T03:00:00.000Z",
    });
    // Suppose T2 and T4 were deleted, persisted nextTaskNumber is 5
    const res = normalizeTaskNumbers([t3, t1], 5);
    expect(res.changed).toBe(false);
    expect(res.nextTaskNumber).toBe(5);
    expect(res.tasks.map((t) => t.taskNumber)).toEqual([3, 1]);

    // A task missing a number should get 5 (not 2 or 4)
    const { taskNumber: _omitted, ...unnumbered } = makeTask({
      id: "t-new",
      title: "Unnumbered",
      projectName: "alpha",
      createdAt: "2026-11-20T05:00:00.000Z",
    });
    const res2 = normalizeTaskNumbers([unnumbered, t3, t1], 5);
    expect(res2.changed).toBe(true);
    expect(res2.tasks[0]?.taskNumber).toBe(5);
    expect(res2.nextTaskNumber).toBe(6);
  });

  it("backfills and persists task numbers via StateStore.load()", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-tasknum-"));
    try {
      const store = new StateStore(tmpDir);
      const legacyPayload = {
        projects: [],
        scanRoots: [],
        tasks: [
          {
            id: "b",
            title: "Later",
            summary: "",
            projectId: null,
            projectName: "demo",
            projectPath: null,
            status: "done",
            currentStep: null,
            workerThreadId: null,
            activeTurnId: null,
            previewURL: null,
            latestOutput: "",
            activities: [],
            createdAt: "2026-11-22T00:00:00.000Z",
            updatedAt: "2026-11-22T00:00:00.000Z",
          },
          {
            id: "a",
            title: "Earlier",
            summary: "",
            projectId: null,
            projectName: "demo",
            projectPath: null,
            status: "done",
            currentStep: null,
            workerThreadId: null,
            activeTurnId: null,
            previewURL: null,
            latestOutput: "",
            activities: [],
            createdAt: "2026-11-21T00:00:00.000Z",
            updatedAt: "2026-11-21T00:00:00.000Z",
          },
        ],
        messages: [],
        browserTabs: [],
        activeBrowserTabId: null,
        showTaskSidebar: true,
        showBrowserPane: true,
        chatModel: null,
        chatEffort: null,
        workerModel: null,
        workerEffort: null,
      };
      fs.writeFileSync(store.stateFile, JSON.stringify(legacyPayload), "utf8");

      const loaded = store.load();
      expect(loaded.nextTaskNumber).toBe(3);
      expect(loaded.tasks.find((t) => t.id === "a")?.taskNumber).toBe(1);
      expect(loaded.tasks.find((t) => t.id === "b")?.taskNumber).toBe(2);

      // Verify backfilled values were written back to disk
      const onDisk = JSON.parse(fs.readFileSync(store.stateFile, "utf8")) as {
        nextTaskNumber: number;
        tasks: Array<{ id: string; taskNumber: number }>;
      };
      expect(onDisk.nextTaskNumber).toBe(3);
      expect(onDisk.tasks.find((t) => t.id === "a")?.taskNumber).toBe(1);
      expect(onDisk.tasks.find((t) => t.id === "b")?.taskNumber).toBe(2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Chat @project, @T#, and @project/T# mention parsing & prompt resolution", () => {
  const projects: Project[] = [
    makeProject({ id: "p1", name: "agent_terminal", gitBranch: "main" }),
    makeProject({ id: "p2", name: "agent_terminal_2", gitBranch: "feat/mentions" }),
    ...Array.from({ length: 40 }, (_, i) =>
      makeProject({
        id: `p-extra-${i + 1}`,
        name: `project_${i + 1}`,
        gitBranch: i === 34 ? "release-35" : "main",
      }),
    ),
  ];

  const tasks: AgentTask[] = [
    makeTask({
      id: "uuid-task-1",
      taskNumber: 1,
      projectId: "p2",
      projectName: "agent_terminal_2",
      title: "Add mention autocomplete",
      summary: "Implement @project and @T# autocomplete",
      status: "running",
      currentStep: "Editing UnifiedChat.tsx",
    }),
    makeTask({
      id: "uuid-task-2",
      taskNumber: 2,
      projectId: "p-extra-35",
      projectName: "project_35",
      title: "Fix build pipeline",
      status: "needs_review",
      currentStep: "Waiting for review",
    }),
  ];

  it("resolves @project, @T#, @project/T#, longest-match project names, and Japanese prose without spaces", () => {
    const text =
      "@agent_terminal_2/T1を確認して、@project_35のブランチと@t2も確認して。contact dev@agent_terminal_2.example.com は無視。";
    const resolved = parseAndResolveMentions(text, projects, tasks);

    expect(resolved.projects.map((p) => p.name)).toEqual(["agent_terminal_2", "project_35"]);
    expect(resolved.tasks.map((t) => t.id)).toEqual(["uuid-task-1", "uuid-task-2"]);
    expect(resolved.unresolvedTaskCodes).toEqual([]);
    expect(resolved.mentions.map((m) => m.raw)).toEqual([
      "@agent_terminal_2/T1",
      "@project_35",
      "@t2",
    ]);
  });

  it("builds structured [Explicitly Mentioned Context] for projects beyond top 30 and tasks", () => {
    const section = buildExplicitMentionContextSection(
      "Check @project_35 and @agent_terminal_2/T1 and @T99",
      projects,
      tasks,
    );
    expect(section).not.toBeNull();
    expect(section).toContain("[Explicitly Mentioned Context]");
    expect(section).toContain('name="project_35"');
    expect(section).toContain('path="/Users/dev/Documents/project_35"');
    expect(section).toContain('branch="release-35"');
    expect(section).toContain("code=T1");
    expect(section).toContain("id=uuid-task-1");
    expect(section).toContain('title="Add mention autocomplete"');
    expect(section).toContain("status=running");
    expect(section).toContain('step="Editing UnifiedChat.tsx"');
    expect(section).toContain('summary="Implement @project and @T# autocomplete"');
    expect(section).toContain("- @T99");
  });

  it("returns null context section when message contains no explicit mentions", () => {
    expect(buildExplicitMentionContextSection("hello dev@example.com", projects, tasks)).toBeNull();
  });
});

describe("Autocomplete detection, filtering across all projects, and caret replacement", () => {
  const projects: Project[] = Array.from({ length: 42 }, (_, i) =>
    makeProject({
      id: `proj-${i + 1}`,
      name: i === 39 ? "zulu_deep_project" : `repo_${String(i + 1).padStart(2, "0")}`,
    }),
  );

  const tasks: AgentTask[] = [
    makeTask({
      id: "task-1",
      taskNumber: 1,
      projectId: "proj-40",
      projectName: "zulu_deep_project",
      title: "Build search index",
      status: "running",
    }),
    makeTask({
      id: "task-2",
      taskNumber: 2,
      projectId: "proj-1",
      projectName: "repo_01",
      title: "Update README",
      status: "done",
    }),
  ];

  it("searches across all discovered projects (not limited to top 30)", () => {
    const queryAll = detectActiveMention("@", 1);
    expect(queryAll).not.toBeNull();
    const { suggestions } = getMentionSuggestions(queryAll!, projects, tasks);
    const projectSuggestions = suggestions.filter((s) => s.kind === "project");
    expect(projectSuggestions.length).toBe(42);
    expect(projectSuggestions.some((s) => s.project.name === "zulu_deep_project")).toBe(true);

    const queryDeep = detectActiveMention("Check @zulu", 11);
    expect(queryDeep?.mode).toBe("all");
    const deepRes = getMentionSuggestions(queryDeep!, projects, tasks);
    expect(deepRes.suggestions[0]?.kind).toBe("project");
    expect(deepRes.suggestions[0]?.insertText).toBe("@zulu_deep_project");
  });

  it("narrows to project tasks when typing @<projectName>/ and inserts @<projectName>/T#", () => {
    const text = "Please inspect @zulu_deep_project/";
    const query = detectActiveMention(text, text.length);
    expect(query).not.toBeNull();
    expect(query?.mode).toBe("project_tasks");
    expect(query?.projectQuery).toBe("zulu_deep_project");

    const res = getMentionSuggestions(query!, projects, tasks);
    expect(res.scopedProject?.name).toBe("zulu_deep_project");
    expect(res.suggestions).toHaveLength(1);
    expect(res.suggestions[0]?.kind).toBe("task");
    expect(res.suggestions[0]?.insertText).toBe("@zulu_deep_project/T1");

    const applied = applyMentionSelection(text, query!, res.suggestions[0]!.insertText);
    expect(applied.nextText).toBe("Please inspect @zulu_deep_project/T1 ");
    expect(applied.nextCaret).toBe(applied.nextText.length);
  });

  it("replaces active mention mid-sentence without duplicating trailing whitespace", () => {
    const text = "Compare @T1 and @repo_01";
    const query = detectActiveMention(text, 11); // caret right after @T1
    expect(query).not.toBeNull();
    const applied = applyMentionSelection(text, query!, "@T2");
    expect(applied.nextText).toBe("Compare @T2 and @repo_01");
    expect(applied.nextCaret).toBe(11);
  });

  it("does not trigger autocomplete inside email addresses", () => {
    expect(detectActiveMention("alice@ex", 8)).toBeNull();
  });
});

describe("User message mention badge extraction & resolution", () => {
  const projects: Project[] = [
    makeProject({ id: "p1", name: "agent_terminal_2", colorHex: "#3B82F6" }),
    makeProject({ id: "p2", name: "alpha_api", colorHex: "#10B981" }),
  ];

  const tasks: AgentTask[] = [
    makeTask({
      id: "task-6",
      taskNumber: 6,
      projectId: "p1",
      projectName: "agent_terminal_2",
      title: "Fix tab completion for task mentions",
      status: "running",
    }),
    makeTask({
      id: "task-9",
      taskNumber: 9,
      projectId: "p2",
      projectName: "alpha_api",
      title: "Add healthcheck endpoint",
      status: "done",
    }),
  ];

  it("extracts deduplicated task and project mention refs without duplicating project for @project/T#", () => {
    const refs = extractMentionRefsForMessage(
      "@agent_terminal_2/T6 と @T6 と @alpha_api と @alpha_api を確認して @T999",
      projects,
      tasks,
    );

    expect(refs).toEqual([
      {
        kind: "task",
        taskId: "task-6",
        taskNumber: 6,
        taskTitle: "Fix tab completion for task mentions",
        taskStatus: "running",
        projectId: "p1",
        projectName: "agent_terminal_2",
        projectPath: "/Users/dev/Documents/agent_terminal_2",
        projectColorHex: "#3B82F6",
      },
      {
        kind: "project",
        projectId: "p2",
        projectName: "alpha_api",
        projectPath: "/Users/dev/Documents/alpha_api",
        projectColorHex: "#10B981",
      },
    ]);
  });

  it("resolves badges for legacy/restored history messages without persisted mentions", () => {
    const badges = resolveMessageMentionBadges(
      "@T6 と @alpha_api と @T9 を確認して",
      projects,
      tasks,
    );

    expect(badges).toHaveLength(3);
    expect(badges[0]).toMatchObject({
      kind: "task",
      taskCode: "T6",
      projectName: "agent_terminal_2",
      taskTitle: "Fix tab completion for task mentions",
      projectColorHex: "#3B82F6",
      isLiveTask: true,
    });
    expect(badges[1]).toMatchObject({
      kind: "project",
      projectName: "alpha_api",
      projectColorHex: "#10B981",
      isLiveProject: true,
    });
    expect(badges[2]).toMatchObject({
      kind: "task",
      taskCode: "T9",
      projectName: "alpha_api",
      taskTitle: "Add healthcheck endpoint",
      isLiveTask: true,
    });
  });

  it("preserves snapshotted task title and project name after deletion while refreshing live items", () => {
    const persisted: ChatMessageMentionRef[] = [
      {
        kind: "project",
        projectId: "p-removed",
        projectName: "archived_repo",
        projectPath: "/Users/dev/Documents/archived_repo",
        projectColorHex: "#F59E0B",
      },
      {
        kind: "task",
        taskId: "task-deleted",
        taskNumber: 4,
        taskTitle: "Deleted task title snapshot",
        taskStatus: "done",
        projectId: "p1",
        projectName: "agent_terminal_2",
        projectPath: "/Users/dev/Documents/agent_terminal_2",
        projectColorHex: "#3B82F6",
      },
      {
        kind: "task",
        taskId: "task-6",
        taskNumber: 6,
        taskTitle: "Old title before rename",
        taskStatus: "queued",
        projectId: "p1",
        projectName: "agent_terminal_2",
        projectPath: "/Users/dev/Documents/agent_terminal_2",
        projectColorHex: "#3B82F6",
      },
    ];

    const badges = resolveMessageMentionBadges(
      "@archived_repo の @T4 と @T6 を確認",
      projects,
      tasks,
      persisted,
    );

    expect(badges).toHaveLength(3);
    expect(badges[0]).toMatchObject({
      kind: "project",
      projectName: "archived_repo",
      projectColorHex: "#F59E0B",
      isLiveProject: false,
    });
    expect(badges[1]).toMatchObject({
      kind: "task",
      taskCode: "T4",
      projectName: "agent_terminal_2",
      taskTitle: "Deleted task title snapshot",
      isLiveTask: false,
    });
    // Live task title & status override stale snapshot values, and no duplicate T6 badge is appended
    expect(badges[2]).toMatchObject({
      kind: "task",
      taskCode: "T6",
      projectName: "agent_terminal_2",
      taskTitle: "Fix tab completion for task mentions",
      taskStatus: "running",
      isLiveTask: true,
    });
  });
});

describe("Draft resolved mention chips extraction & removal", () => {
  const projects: Project[] = [
    makeProject({ id: "p-short", name: "agent_terminal", colorHex: "#10B981" }),
    makeProject({ id: "p-main", name: "agent_terminal_2", colorHex: "#3B82F6" }),
    makeProject({ id: "p-web", name: "web_dashboard", colorHex: "#F59E0B" }),
  ];

  const tasks: AgentTask[] = [
    makeTask({
      id: "task-12",
      taskNumber: 12,
      projectId: "p-main",
      projectName: "agent_terminal_2",
      title: "Implement UI feedback for selected mentions",
      status: "running",
    }),
    makeTask({
      id: "task-13",
      taskNumber: 13,
      projectId: "p-web",
      projectName: "web_dashboard",
      title: "Refactor navbar responsive layout",
      status: "queued",
    }),
  ];

  it("extracts deduplicated chips in appearance order for @T#, @project/T#, and @project without duplicating project for @project/T#", () => {
    const chips = extractResolvedMentionChips(
      "@agent_terminal_2/T12 と @t12 と @web_dashboard と @T13 と @web_dashboard を確認して @T999 dev@agent_terminal_2.com",
      projects,
      tasks,
    );

    expect(chips).toHaveLength(3);
    expect(chips[0]).toMatchObject({
      key: "task:task-12",
      kind: "task",
      taskCode: "T12",
      projectName: "agent_terminal_2",
      projectColorHex: "#3B82F6",
      rawMentions: ["@agent_terminal_2/T12", "@t12"],
    });
    expect(chips[1]).toMatchObject({
      key: "project:p-web",
      kind: "project",
      projectName: "web_dashboard",
      projectColorHex: "#F59E0B",
      rawMentions: ["@web_dashboard"],
    });
    expect(chips[2]).toMatchObject({
      key: "task:task-13",
      kind: "task",
      taskCode: "T13",
      projectName: "web_dashboard",
      projectColorHex: "#F59E0B",
      rawMentions: ["@T13"],
    });
  });

  it("returns empty array when draft has no resolved mentions", () => {
    expect(extractResolvedMentionChips("", projects, tasks)).toEqual([]);
    expect(extractResolvedMentionChips("hello world", projects, tasks)).toEqual([]);
    expect(extractResolvedMentionChips("email user@agent_terminal_2.dev and @T999", projects, tasks)).toEqual([]);
    expect(extractResolvedMentionChips("@agent_terminal_2/T999", projects, tasks)).toEqual([]);
  });

  it("removes single and repeated task mentions from draft text with clean spacing and caret adjustment", () => {
    // Draft right after autocomplete insertion
    const r1 = removeResolvedMentionChip(
      "@T12 ",
      { kind: "task", taskId: "task-12" },
      projects,
      tasks,
      5,
    );
    expect(r1).toEqual({ nextText: "", nextCaret: 0, removedCount: 1 });

    // Mid-sentence mention with surrounding spaces collapses double space into one
    const r2 = removeResolvedMentionChip(
      "これを @T12 確認して",
      { kind: "task", taskId: "task-12" },
      projects,
      tasks,
      13,
    );
    expect(r2.nextText).toBe("これを 確認して");
    expect(r2.removedCount).toBe(1);
    expect(r2.nextCaret).toBe(8);

    // Repeated mentions across @T12 and @agent_terminal_2/T12 are all removed
    const r3 = removeResolvedMentionChip(
      "@T12 と @agent_terminal_2/T12 を比較して",
      { kind: "task", taskId: "task-12" },
      projects,
      tasks,
    );
    expect(r3.nextText).toBe("と を比較して");
    expect(r3.removedCount).toBe(2);

    // Preserves newlines when removing line-leading mention
    const r4 = removeResolvedMentionChip(
      "1行目\n@T12 確認して",
      { kind: "task", taskId: "task-12" },
      projects,
      tasks,
    );
    expect(r4.nextText).toBe("1行目\n確認して");
  });

  it("removes only the targeted project without touching @project/T# or prefix-similar projects", () => {
    const draft = "@agent_terminal_2/T12 と @agent_terminal_2 と @agent_terminal を確認";

    // Removing standalone project agent_terminal_2 keeps @agent_terminal_2/T12 and @agent_terminal
    const rProj = removeResolvedMentionChip(
      draft,
      { kind: "project", projectId: "p-main" },
      projects,
      tasks,
    );
    expect(rProj.nextText).toBe("@agent_terminal_2/T12 と と @agent_terminal を確認");
    expect(rProj.removedCount).toBe(1);

    // Removing prefix-shorter project agent_terminal leaves agent_terminal_2 intact
    const rShort = removeResolvedMentionChip(
      draft,
      { kind: "project", projectId: "p-short" },
      projects,
      tasks,
    );
    expect(rShort.nextText).toBe("@agent_terminal_2/T12 と @agent_terminal_2 と を確認");
    expect(rShort.removedCount).toBe(1);

    // Removing task T12 keeps standalone @agent_terminal_2 intact
    const rTask = removeResolvedMentionChip(
      draft,
      { kind: "task", taskId: "task-12" },
      projects,
      tasks,
    );
    expect(rTask.nextText).toBe("と @agent_terminal_2 と @agent_terminal を確認");
    expect(rTask.removedCount).toBe(1);
  });

  it("immediately surfaces resolved task chip after autocomplete Tab/Enter selection", () => {
    const draft = "確認して @T1";
    const query = detectActiveMention(draft, draft.length);
    expect(query).not.toBeNull();

    const { suggestions } = getMentionSuggestions(query!, projects, tasks);
    const t12Suggestion = suggestions.find((s) => s.kind === "task" && s.task.taskNumber === 12);
    expect(t12Suggestion).toBeDefined();

    const { nextText, nextCaret } = applyMentionSelection(draft, query!, t12Suggestion!.insertText);
    expect(nextText).toBe("確認して @T12 ");
    expect(detectActiveMention(nextText, nextCaret)).toBeNull();

    const chips = extractResolvedMentionChips(nextText, projects, tasks);
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({
      kind: "task",
      taskCode: "T12",
      projectName: "agent_terminal_2",
      projectColorHex: "#3B82F6",
    });
  });

  it("removes @query cleanly on autocomplete chip attachment without leaving @xxx in draft", () => {
    // At start of empty composer
    const q1 = detectActiveMention("@web", 4)!;
    expect(removeActiveMentionQuery("@web", q1)).toEqual({ nextText: "", nextCaret: 0 });

    // At end of draft (strips redundant space before @query)
    const draft2 = "確認して @T1";
    const q2 = detectActiveMention(draft2, draft2.length)!;
    const { suggestions } = getMentionSuggestions(q2, projects, tasks);
    const t12 = suggestions.find((s) => s.kind === "task" && s.task.taskNumber === 12)!;
    const selected = addExplicitMentionTarget([], suggestionToExplicitMentionTarget(t12));
    const removed2 = removeActiveMentionQuery(draft2, q2);

    expect(removed2).toEqual({ nextText: "確認して", nextCaret: 4 });
    expect(removed2.nextText).not.toContain("@");

    // Selected chip appears even though draft text has no @T12 token
    const chips = extractResolvedMentionChips(removed2.nextText, projects, tasks, selected);
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({
      kind: "task",
      taskCode: "T12",
      projectName: "agent_terminal_2",
      rawMentions: [],
    });

    // Mid-sentence collapses double horizontal spaces into one
    const draft3 = "これを @agent_terminal_2/T1 確認して";
    const q3 = detectActiveMention(draft3, draft3.indexOf(" 確認"))!;
    expect(removeActiveMentionQuery(draft3, q3)).toEqual({
      nextText: "これを 確認して",
      nextCaret: 4,
    });

    // Leading mention followed by text removes redundant leading space
    const draft4 = "@web ビルドを確認して";
    const q4 = detectActiveMention(draft4, 4)!;
    expect(removeActiveMentionQuery(draft4, q4)).toEqual({
      nextText: "ビルドを確認して",
      nextCaret: 0,
    });

    // Trailing spaces after @query at end of line are also cleaned up
    const draft5 = "確認して @web  ";
    const q5 = detectActiveMention(draft5, 9)!;
    expect(removeActiveMentionQuery(draft5, q5)).toEqual({
      nextText: "確認して",
      nextCaret: 4,
    });

    // Japanese prose with no preceding space
    const draft6 = "確認して@T12";
    const q6 = detectActiveMention(draft6, draft6.length)!;
    expect(removeActiveMentionQuery(draft6, q6)).toEqual({
      nextText: "確認して",
      nextCaret: 4,
    });
  });

  it("deduplicates and removes structured mention targets cleanly", () => {
    let list: ExplicitMentionTarget[] = [];
    list = addExplicitMentionTarget(list, {
      kind: "project",
      projectId: "p-main",
      projectName: "agent_terminal_2",
    });
    list = addExplicitMentionTarget(list, {
      kind: "project",
      projectId: "p-main",
      projectName: "agent_terminal_2",
    });
    list = addExplicitMentionTarget(list, { kind: "task", taskId: "task-12", taskNumber: 12 });
    list = addExplicitMentionTarget(list, { kind: "task", taskId: "task-12", taskNumber: 12 });
    expect(list).toHaveLength(2);

    // Merging structured mentions with manually typed inline @mentions deduplicates them
    const chips = extractResolvedMentionChips("@T12 と @web_dashboard を見て", projects, tasks, list);
    expect(chips.map((c) => c.key)).toEqual(["project:p-main", "task:task-12", "project:p-web"]);

    list = removeExplicitMentionTarget(list, { kind: "task", taskId: "task-12" });
    expect(list).toEqual([
      { kind: "project", projectId: "p-main", projectName: "agent_terminal_2" },
    ]);

    list = removeExplicitMentionTarget(list, { kind: "project", projectId: "p-main" });
    expect(list).toEqual([]);
  });

  it("builds [Explicitly Mentioned Context] and persisted refs from structured mentions without @xxx in text", () => {
    const explicitMentions: ExplicitMentionTarget[] = [
      { kind: "project", projectId: "p-web", projectName: "web_dashboard" },
      { kind: "task", taskId: "task-12", taskNumber: 12 },
    ];

    // Message body is completely clean (no @xxx tokens)
    const section = buildExplicitMentionContextSection(
      "このバグの原因を調べて修正して",
      projects,
      tasks,
      explicitMentions,
    );
    expect(section).not.toBeNull();
    expect(section).toContain("[Explicitly Mentioned Context]");
    expect(section).toContain('name="web_dashboard"');
    expect(section).toContain('path="/Users/dev/Documents/web_dashboard"');
    expect(section).toContain("code=T12");
    expect(section).toContain("id=task-12");
    expect(section).toContain('title="Implement UI feedback for selected mentions"');

    // Merges structured + manual inline mentions without duplicates
    const mergedSection = buildExplicitMentionContextSection(
      "@T12 と @T13 と @web_dashboard を確認して",
      projects,
      tasks,
      explicitMentions,
    );
    expect(mergedSection).not.toBeNull();
    expect((mergedSection!.match(/id=task-12/g) ?? []).length).toBe(1);
    expect((mergedSection!.match(/id=task-13/g) ?? []).length).toBe(1);
    expect((mergedSection!.match(/name="web_dashboard"/g) ?? []).length).toBe(1);

    // Persisted mention refs extracted cleanly from structured mentions even without @xxx in text
    const refs = extractMentionRefsForMessage(
      "このバグの原因を調べて修正して",
      projects,
      tasks,
      explicitMentions,
    );
    expect(refs).toEqual([
      {
        kind: "project",
        projectId: "p-web",
        projectName: "web_dashboard",
        projectPath: "/Users/dev/Documents/web_dashboard",
        projectColorHex: "#F59E0B",
      },
      {
        kind: "task",
        taskId: "task-12",
        taskNumber: 12,
        taskTitle: "Implement UI feedback for selected mentions",
        taskStatus: "running",
        projectId: "p-main",
        projectName: "agent_terminal_2",
        projectPath: "/Users/dev/Documents/agent_terminal_2",
        projectColorHex: "#3B82F6",
      },
    ]);
  });

  it("persists structured mentions on ChatMessage and injects them into ConductorController orchestrator prompts", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-structured-mentions-"));
    try {
      const store = new StateStore(tmpDir);
      const initial = store.load();
      store.save({
        ...initial,
        projects,
        tasks,
        nextTaskNumber: 14,
      });

      const fakeBrowser = {
        getTabs: () => [],
        getActiveTabId: () => null,
        getActiveTab: () => null,
        isPickingElement: () => false,
        restore: () => {},
      } as unknown as BrowserManager;

      const controller = new ConductorController({
        store,
        browser: fakeBrowser,
        onSnapshot: () => {},
      });

      // Prevent background turn dispatch from touching live CLIs while still testing sendMessage persistence
      const dispatched: Array<Record<string, unknown>> = [];
      (controller as unknown as { dispatchParallelResponderTurn: (args: Record<string, unknown>) => Promise<void> }).dispatchParallelResponderTurn =
        async (args) => {
          dispatched.push(args);
        };

      const explicitMentions: ExplicitMentionTarget[] = [
        { kind: "project", projectId: "p-web", projectName: "web_dashboard" },
        { kind: "task", taskId: "task-12", taskNumber: 12 },
      ];

      await controller.sendMessage({
        text: "テストを実行して結果を教えて",
        attachments: [],
        mentions: explicitMentions,
      });

      const snap = controller.getSnapshot();
      const userMsg = snap.messages.find((m) => m.role === "user");
      expect(userMsg).toBeDefined();
      expect(userMsg!.text).toBe("テストを実行して結果を教えて");
      expect(userMsg!.text).not.toContain("@");
      expect(userMsg!.mentions).toHaveLength(2);
      expect(userMsg!.mentions?.[0]).toMatchObject({
        kind: "project",
        projectId: "p-web",
        projectName: "web_dashboard",
      });
      expect(userMsg!.mentions?.[1]).toMatchObject({
        kind: "task",
        taskId: "task-12",
        taskNumber: 12,
      });

      // Verify persisted state on disk contains the structured mentions
      const reloaded = store.load();
      const persistedSession = reloaded.chatSessions?.find(
        (s) => s.id === snap.activeChatSessionId,
      );
      const persistedUserMsg = persistedSession?.messages.find((m) => m.role === "user");
      expect(persistedUserMsg?.mentions).toHaveLength(2);

      // Verify buildOrchestratorPrompt injects [Explicitly Mentioned Context] from structured mentions
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]?.explicitMentions).toEqual(explicitMentions);
      const prompt = (
        controller as unknown as {
          buildOrchestratorPrompt: (
            userText: string,
            attachments: unknown[],
            recentHistoryWindow: string,
            options?: { explicitMentions?: readonly ExplicitMentionTarget[] },
          ) => string;
        }
      ).buildOrchestratorPrompt("テストを実行して結果を教えて", [], "", { explicitMentions });

      expect(prompt).toContain("[Explicitly Mentioned Context]");
      expect(prompt).toContain('name="web_dashboard"');
      expect(prompt).toContain("id=task-12");
      expect(prompt).toContain("[Current User Message to Answer Now]\nテストを実行して結果を教えて");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves structured explicit mentions via projectPath matching and fallback snapshot metadata when live registry changes before send", () => {
    // 1. Suggestion target carries full fallback metadata
    const projQuery = detectActiveMention("@web_dashboard", 14)!;
    const projSug = getMentionSuggestions(projQuery, projects, tasks).suggestions.find(
      (s) => s.kind === "project" && s.project.id === "p-web",
    )!;
    const projTarget = suggestionToExplicitMentionTarget(projSug);
    expect(projTarget).toMatchObject({
      kind: "project",
      projectId: "p-web",
      projectName: "web_dashboard",
      projectPath: "/Users/dev/Documents/web_dashboard",
      projectColorHex: "#F59E0B",
    });

    const taskQuery = detectActiveMention("@T12", 4)!;
    const taskSug = getMentionSuggestions(taskQuery, projects, tasks).suggestions.find(
      (s) => s.kind === "task" && s.task.id === "task-12",
    )!;
    const taskTarget = suggestionToExplicitMentionTarget(taskSug);
    expect(taskTarget).toMatchObject({
      kind: "task",
      taskId: "task-12",
      taskNumber: 12,
      taskTitle: "Implement UI feedback for selected mentions",
      projectName: "agent_terminal_2",
      projectColorHex: "#3B82F6",
    });

    // 2. If projectId changed (re-registered) and name differed, projectPath still matches live project
    const reRegisteredProject = makeProject({
      id: "p-web-new-id",
      name: "web_dashboard_renamed",
      path: "/Users/dev/Documents/web_dashboard",
      colorHex: "#EC4899",
    });
    const matchedByPath = extractMentionRefsForMessage(
      "ビルドを確認して",
      [reRegisteredProject],
      [],
      [projTarget],
    );
    expect(matchedByPath).toEqual([
      {
        kind: "project",
        projectId: "p-web-new-id",
        projectName: "web_dashboard_renamed",
        projectPath: "/Users/dev/Documents/web_dashboard",
        projectColorHex: "#EC4899",
      },
    ]);

    // 3. Even if project & task were removed from live registry right before send, fallback metadata keeps badges intact
    const fallbackRefs = extractMentionRefsForMessage(
      "ログを確認して",
      [],
      [],
      [projTarget, taskTarget],
    );
    expect(fallbackRefs).toEqual([
      {
        kind: "project",
        projectId: "p-web",
        projectName: "web_dashboard",
        projectPath: "/Users/dev/Documents/web_dashboard",
        projectColorHex: "#F59E0B",
      },
      {
        kind: "task",
        taskId: "task-12",
        taskNumber: 12,
        taskTitle: "Implement UI feedback for selected mentions",
        taskStatus: "running",
        projectId: "p-main",
        projectName: "agent_terminal_2",
        projectPath: "/Users/dev/Documents/agent_terminal_2",
        projectColorHex: "#3B82F6",
      },
    ]);

    // 4. Removing a project target with projectId: null matches cleanly via projectName
    const afterRemove = removeExplicitMentionTarget(
      [{ kind: "project", projectId: null, projectName: "web_dashboard" }],
      { kind: "project", projectId: "p-web", projectName: "web_dashboard" },
    );
    expect(afterRemove).toEqual([]);
  });
});
