import { describe, expect, it } from "vitest";
import type { AgentTask, BrowserTab, ChatMessage, Project } from "../src/shared/types.js";
import type { ImageViewerTab } from "../src/renderer/lib/image-viewer.js";
import {
  activateTabInWorkspace,
  buildProjectSwitcherItems,
  closeTabInWorkspace,
  createEmptyRightPaneWorkspaceState,
  deserializeRightPaneWorkspace,
  filterRecentFilesForProject,
  GENERAL_PROJECT_SCOPE,
  getActiveUnifiedTab,
  getProjectUnifiedTabs,
  inferProjectFromFilePath,
  inferProjectFromMessage,
  inferProjectFromTask,
  makeBrowserUnifiedTabId,
  makeImageUnifiedTabId,
  makeMarkdownUnifiedTabId,
  reconcileWorkspaceState,
  resolveProjectFromChatText,
  selectTabInWorkspace,
  serializeRightPaneWorkspace,
  switchActiveProjectScope,
  type MarkdownViewerTab,
} from "../src/renderer/lib/right-pane-tabs.js";

const PROJECTS: Project[] = [
  {
    id: "proj-root",
    name: "workspace",
    path: "/Users/dev/work",
    colorHex: "#6366F1",
    gitBranch: "main",
    addedAt: "2026-11-20T00:00:00.000Z",
  },
  {
    id: "proj-a",
    name: "agent_terminal_2",
    path: "/Users/dev/work/agent_terminal_2",
    colorHex: "#3B82F6",
    gitBranch: "main",
    addedAt: "2026-11-20T00:00:00.000Z",
  },
  {
    id: "proj-b",
    name: "my-app",
    path: "/Users/dev/work/my-app",
    colorHex: "#10B981",
    gitBranch: "dev",
    addedAt: "2026-11-20T00:00:00.000Z",
  },
  {
    id: "proj-b2",
    name: "my-app-v2",
    path: "/Users/dev/work/my-app-v2",
    colorHex: "#F59E0B",
    gitBranch: "main",
    addedAt: "2026-11-20T00:00:00.000Z",
  },
];

const TASKS: AgentTask[] = [
  {
    id: "task-10",
    taskNumber: 10,
    title: "Implement unified right pane",
    summary: "",
    projectId: "proj-a",
    projectName: "agent_terminal_2",
    projectPath: "/Users/dev/work/agent_terminal_2",
    worktreePath: "/Users/dev/.conductor/worktrees/task-10",
    status: "running",
    currentStep: null,
    workerThreadId: null,
    activeTurnId: null,
    previewURL: "http://localhost:5173",
    latestOutput: "",
    activities: [],
    createdAt: "2026-11-25T00:00:00.000Z",
    updatedAt: "2026-11-25T00:00:00.000Z",
  },
  {
    id: "task-20",
    taskNumber: 20,
    title: "Fix checkout button",
    summary: "",
    projectId: null,
    projectName: "my-app",
    projectPath: "/Users/dev/work/my-app",
    status: "needs_review",
    currentStep: null,
    workerThreadId: null,
    activeTurnId: null,
    previewURL: "http://localhost:3000",
    latestOutput: "",
    activities: [],
    createdAt: "2026-11-25T01:00:00.000Z",
    updatedAt: "2026-11-25T01:00:00.000Z",
  },
];

function makeBrowserTab(id: string, title: string, url: string, projectId?: string | null): BrowserTab {
  return {
    id,
    title,
    url,
    projectId: projectId ?? null,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    consoleErrorCount: 0,
    networkErrorCount: 0,
  };
}

function makeMdTab(filePath: string): MarkdownViewerTab {
  const fileName = filePath.split("/").pop() ?? filePath;
  return {
    filePath,
    fileName,
    document: {
      filePath,
      fileName,
      content: `# ${fileName}`,
      mtimeMs: 1700000000000,
      sizeBytes: 32,
    },
    error: null,
    isLoading: false,
    lastReloadedAt: 1700000000000,
  };
}

function makeImageTab(id: string, label: string, imagePath?: string): ImageViewerTab {
  return {
    id,
    label,
    fileName: imagePath ? imagePath.split("/").pop() ?? null : null,
    src: "data:image/png;base64,AAAA",
    imagePath,
    isLoading: false,
    error: null,
  };
}

describe("Right-pane project inference", () => {
  it("infers owning project by longest project.path prefix, file:// URL, and worktree path", () => {
    // Nested project beats parent workspace path
    expect(
      inferProjectFromFilePath("/Users/dev/work/agent_terminal_2/README.md", PROJECTS)?.id,
    ).toBe("proj-a");

    // Prefix boundary safety: /Users/dev/work/my-app-v2 must not match /Users/dev/work/my-app
    expect(
      inferProjectFromFilePath("/Users/dev/work/my-app-v2/docs/guide.md", PROJECTS)?.id,
    ).toBe("proj-b2");

    // file:// URL with percent-encoded spaces and heading anchor
    expect(
      inferProjectFromFilePath(
        "file:///Users/dev/work/my-app/docs/release%20notes.md#v2",
        PROJECTS,
      )?.id,
    ).toBe("proj-b");

    // Worktree path resolves to task's project
    expect(
      inferProjectFromFilePath(
        "/Users/dev/.conductor/worktrees/task-10/PLAN.md",
        PROJECTS,
        TASKS,
      )?.id,
    ).toBe("proj-a");

    // Unrelated path returns null (caller falls back to active scope / General)
    expect(inferProjectFromFilePath("/tmp/scratch.md", PROJECTS, TASKS)).toBeNull();
  });

  it("infers project from task (by projectId or case-insensitive projectName)", () => {
    expect(inferProjectFromTask(TASKS[0], PROJECTS)?.id).toBe("proj-a");
    expect(inferProjectFromTask(TASKS[1], PROJECTS)?.id).toBe("proj-b");
    expect(inferProjectFromTask(null, PROJECTS)).toBeNull();
  });

  it("resolves chat mentions (@project, @T#, @project/T#) and unambiguous plain-text matches", () => {
    // Explicit @project mention
    expect(resolveProjectFromChatText("@agent_terminal_2 のUIを確認して", PROJECTS, TASKS)?.id).toBe(
      "proj-a",
    );

    // Explicit @T# task mention resolves to task's project
    expect(resolveProjectFromChatText("@T10 の進捗どう？", PROJECTS, TASKS)?.id).toBe("proj-a");
    expect(resolveProjectFromChatText("@my-app/T20 を確認", PROJECTS, TASKS)?.id).toBe("proj-b");

    // Unambiguous plain-text match in Japanese & English
    expect(resolveProjectFromChatText("agent_terminal_2の右ペインを修正して", PROJECTS, TASKS)?.id).toBe(
      "proj-a",
    );
    expect(resolveProjectFromChatText("Check my-app-v2 deployment", PROJECTS, TASKS)?.id).toBe(
      "proj-b2",
    );

    // Ambiguous plain-text matching two distinct projects returns null
    expect(
      resolveProjectFromChatText("agent_terminal_2 と my-app を比較して", PROJECTS, TASKS),
    ).toBeNull();

    // Email address should not falsely trigger plain-text project match
    expect(resolveProjectFromChatText("contact dev@my-app.com please", PROJECTS, TASKS)).toBeNull();

    // Unrelated message returns null
    expect(resolveProjectFromChatText("こんにちは、今日の予定を教えて", PROJECTS, TASKS)).toBeNull();
  });

  it("infers project from structured explicitMentions even when chat text has no @xxx or is empty", () => {
    // Structured project mention with clean text
    expect(
      resolveProjectFromChatText("右ペインのレイアウトを直して", PROJECTS, TASKS, [
        { kind: "project", projectId: "proj-b", projectName: "my-app" },
      ])?.id,
    ).toBe("proj-b");

    // Structured task mention resolves to the task's owning project
    expect(
      resolveProjectFromChatText("進捗を教えて", PROJECTS, TASKS, [
        { kind: "task", taskId: "task-10", taskNumber: 10 },
      ])?.id,
    ).toBe("proj-a");

    // Empty text (e.g. screenshot attachment + structured mention chip) still resolves
    expect(
      resolveProjectFromChatText("", PROJECTS, TASKS, [
        { kind: "task", taskId: "task-20", taskNumber: 20 },
      ])?.id,
    ).toBe("proj-b");

    // Structured mention takes precedence over plain-text mention of another project
    expect(
      resolveProjectFromChatText("my-app と比較して", PROJECTS, TASKS, [
        { kind: "project", projectId: "proj-a", projectName: "agent_terminal_2" },
      ])?.id,
    ).toBe("proj-a");
  });

  it("infers project from ChatMessage using relatedTaskId, persisted mentions, or text", () => {
    const taskEventMsg: ChatMessage = {
      id: "m1",
      role: "taskEvent",
      text: "Completed task",
      attachments: [],
      toolChips: [],
      relatedTaskId: "task-10",
      isStreaming: false,
      createdAt: "2026-11-26T00:00:00.000Z",
    };
    expect(inferProjectFromMessage(taskEventMsg, PROJECTS, TASKS)?.id).toBe("proj-a");

    const mentionedMsg: ChatMessage = {
      id: "m2",
      role: "user",
      text: "Check this screenshot",
      attachments: [],
      mentions: [
        {
          kind: "project",
          projectId: "proj-b",
          projectName: "my-app",
          projectPath: "/Users/dev/work/my-app",
          projectColorHex: "#10B981",
        },
      ],
      toolChips: [],
      isStreaming: false,
      createdAt: "2026-11-26T00:00:00.000Z",
    };
    expect(inferProjectFromMessage(mentionedMsg, PROJECTS, TASKS)?.id).toBe("proj-b");
  });

  it("filters recent Markdown files per project scope", () => {
    const recent = [
      "/Users/dev/work/agent_terminal_2/README.md",
      "/Users/dev/work/my-app/NOTES.md",
      "/tmp/outside.md",
    ];
    expect(filterRecentFilesForProject(recent, "proj-a", PROJECTS)).toEqual([
      "/Users/dev/work/agent_terminal_2/README.md",
    ]);
    expect(filterRecentFilesForProject(recent, GENERAL_PROJECT_SCOPE, PROJECTS)).toEqual([
      "/tmp/outside.md",
    ]);
  });
});

describe("Unified project-scoped tab workspace state", () => {
  it("keeps mixed Browser, Markdown, and Image tabs per project and remembers active tab per project", () => {
    const btA = makeBrowserTab("b-a1", "Dev App A", "http://localhost:5173", "proj-a");
    const btB = makeBrowserTab("b-b1", "Dev App B", "http://localhost:3000", "proj-b");
    const mdA = makeMdTab("/Users/dev/work/agent_terminal_2/SPEC.md");
    const imgA = makeImageTab("img-1", "Screenshot");

    let state = createEmptyRightPaneWorkspaceState("proj-a");
    state = activateTabInWorkspace(state, makeBrowserUnifiedTabId(btA.id), "proj-a");
    state = activateTabInWorkspace(state, makeMarkdownUnifiedTabId(mdA.filePath), "proj-a");
    state = activateTabInWorkspace(state, makeImageUnifiedTabId(imgA.id), "proj-a");
    state = activateTabInWorkspace(state, makeBrowserUnifiedTabId(btB.id), "proj-b", {
      switchProject: false,
    });

    const sources = {
      browserTabs: [btA, btB],
      mdTabs: [mdA],
      imageTabs: [imgA],
      projects: PROJECTS,
    };

    state = reconcileWorkspaceState(state, sources);

    // Project A has mixed tabs in insertion order with Image active
    const tabsA = getProjectUnifiedTabs(state, "proj-a", sources);
    expect(tabsA.map((t) => t.kind)).toEqual(["browser", "markdown", "image"]);
    expect(getActiveUnifiedTab(state, sources)?.id).toBe(makeImageUnifiedTabId("img-1"));

    // Select Markdown tab in Project A, then switch to Project B
    state = selectTabInWorkspace(state, makeMarkdownUnifiedTabId(mdA.filePath));
    expect(getActiveUnifiedTab(state, sources)?.kind).toBe("markdown");

    state = switchActiveProjectScope(state, "proj-b");
    expect(state.activeProjectScope).toBe("proj-b");
    expect(getActiveUnifiedTab(state, sources)?.id).toBe(makeBrowserUnifiedTabId("b-b1"));

    // Switch back to Project A: remembers Markdown tab was active!
    state = switchActiveProjectScope(state, "proj-a");
    expect(getActiveUnifiedTab(state, sources)?.kind).toBe("markdown");
  });

  it("closes active tab to adjacent mixed tab and never hijacks another project when closing the last tab", () => {
    const btA = makeBrowserTab("b-a1", "App A", "http://localhost:5173", "proj-a");
    const btB = makeBrowserTab("b-b1", "App B", "http://localhost:3000", "proj-b");
    const mdA = makeMdTab("/Users/dev/work/agent_terminal_2/README.md");

    let state = createEmptyRightPaneWorkspaceState("proj-a");
    state = activateTabInWorkspace(state, makeBrowserUnifiedTabId("b-a1"), "proj-a");
    state = activateTabInWorkspace(state, makeMarkdownUnifiedTabId(mdA.filePath), "proj-a");
    state = activateTabInWorkspace(state, makeBrowserUnifiedTabId("b-b1"), "proj-b", {
      switchProject: false,
    });

    // Close active Markdown tab in proj-a -> falls back to adjacent Browser tab in proj-a
    const afterCloseMd = closeTabInWorkspace(state, makeMarkdownUnifiedTabId(mdA.filePath));
    expect(afterCloseMd.nextActiveTabId).toBe(makeBrowserUnifiedTabId("b-a1"));
    expect(afterCloseMd.nextState.activeProjectScope).toBe("proj-a");

    // Close last remaining tab (Browser tab) in proj-a -> activeTabId becomes null, stays on proj-a, proj-b untouched
    const afterCloseBrowser = closeTabInWorkspace(
      afterCloseMd.nextState,
      makeBrowserUnifiedTabId("b-a1"),
    );
    expect(afterCloseBrowser.nextActiveTabId).toBeNull();
    expect(afterCloseBrowser.nextState.activeProjectScope).toBe("proj-a");
    expect(afterCloseBrowser.nextState.workspaces["proj-b"]?.tabOrder).toEqual([
      makeBrowserUnifiedTabId("b-b1"),
    ]);

    const activeAfter = getActiveUnifiedTab(afterCloseBrowser.nextState, {
      browserTabs: [btB],
      mdTabs: [],
      imageTabs: [],
    });
    expect(activeAfter).toBeNull();
    expect(btA.id).toBe("b-a1");
  });

  it("migrates tabs to General when a project is removed", () => {
    const bt = makeBrowserTab("b-1", "Docs", "https://example.com", "proj-b");
    let state = createEmptyRightPaneWorkspaceState("proj-b");
    state = activateTabInWorkspace(state, makeBrowserUnifiedTabId("b-1"), "proj-b");

    const remainingProjects = PROJECTS.filter((p) => p.id !== "proj-b");
    const reconciled = reconcileWorkspaceState(state, {
      browserTabs: [bt],
      mdTabs: [],
      imageTabs: [],
      projects: remainingProjects,
    });

    expect(reconciled.activeProjectScope).toBe(GENERAL_PROJECT_SCOPE);
    expect(reconciled.workspaces[GENERAL_PROJECT_SCOPE]?.tabOrder).toEqual([
      makeBrowserUnifiedTabId("b-1"),
    ]);
  });

  it("pins projects with open tabs at the top of the project switcher and filters by search", () => {
    const btA = makeBrowserTab("b-a1", "App A", "http://localhost:5173", "proj-a");
    const mdA = makeMdTab("/Users/dev/work/agent_terminal_2/README.md");
    const btGen = makeBrowserTab("b-g1", "GitHub", "https://github.com", null);

    let state = createEmptyRightPaneWorkspaceState("proj-a");
    state = activateTabInWorkspace(state, makeBrowserUnifiedTabId(btA.id), "proj-a");
    state = activateTabInWorkspace(state, makeMarkdownUnifiedTabId(mdA.filePath), "proj-a");
    state = activateTabInWorkspace(state, makeBrowserUnifiedTabId(btGen.id), GENERAL_PROJECT_SCOPE, {
      switchProject: false,
    });

    const items = buildProjectSwitcherItems(state, {
      browserTabs: [btA, btGen],
      mdTabs: [mdA],
      imageTabs: [],
      projects: PROJECTS,
    });

    expect(items.withTabs.map((i) => i.scopeKey)).toEqual(["proj-a", GENERAL_PROJECT_SCOPE]);
    expect(items.withTabs[0].tabCount).toBe(2);
    expect(items.withTabs[0].browserCount).toBe(1);
    expect(items.withTabs[0].markdownCount).toBe(1);
    expect(items.others.map((i) => i.scopeKey)).toEqual(["proj-b", "proj-b2", "proj-root"]);

    const searched = buildProjectSwitcherItems(
      state,
      {
        browserTabs: [btA, btGen],
        mdTabs: [mdA],
        imageTabs: [],
        projects: PROJECTS,
      },
      "my-app",
    );
    expect(searched.withTabs).toEqual([]);
    expect(searched.others.map((i) => i.name)).toEqual(["my-app", "my-app-v2"]);
  });

  it("serializes and deserializes workspace state cleanly while omitting transient image tabs", () => {
    const mdA = makeMdTab("/Users/dev/work/agent_terminal_2/README.md");
    let state = createEmptyRightPaneWorkspaceState("proj-a");
    state = activateTabInWorkspace(state, makeBrowserUnifiedTabId("b-1"), "proj-a");
    state = activateTabInWorkspace(state, makeMarkdownUnifiedTabId(mdA.filePath), "proj-a");
    state = activateTabInWorkspace(state, makeImageUnifiedTabId("img-transient"), "proj-a");

    const serialized = serializeRightPaneWorkspace(state, [mdA]);
    expect(serialized.activeProjectScope).toBe("proj-a");
    expect(serialized.openMarkdownFiles).toEqual([
      { filePath: mdA.filePath, projectScope: "proj-a" },
    ]);
    expect(serialized.workspaces["proj-a"]?.tabOrder).toEqual([
      makeBrowserUnifiedTabId("b-1"),
      makeMarkdownUnifiedTabId(mdA.filePath),
    ]);

    const restored = deserializeRightPaneWorkspace(serialized);
    expect(restored.state.activeProjectScope).toBe("proj-a");
    expect(restored.state.workspaces["proj-a"]?.tabOrder).toEqual([
      makeBrowserUnifiedTabId("b-1"),
      makeMarkdownUnifiedTabId(mdA.filePath),
    ]);
    expect(restored.openMarkdownFiles).toEqual([
      { filePath: mdA.filePath, projectScope: "proj-a" },
    ]);
  });
});
