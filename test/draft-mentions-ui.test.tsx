import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentTask,
  AppSnapshot,
  ChatAttachment,
  ExplicitMentionTarget,
  Project,
} from "../src/shared/types.js";
import {
  addExplicitMentionTarget,
  extractResolvedMentionChips,
  removeExplicitMentionTarget,
  removeResolvedMentionChip,
} from "../src/shared/mentions.js";
import { DraftMentionContextBar } from "../src/renderer/components/MentionChips.js";
import { UnifiedChat } from "../src/renderer/components/UnifiedChat.js";

const SAMPLE_PROJECTS: Project[] = [
  {
    id: "proj-1",
    name: "agent_terminal_2",
    path: "/Users/dev/Documents/agent_terminal_2",
    colorHex: "#3B82F6",
    gitBranch: "main",
    addedAt: "2026-11-20T00:00:00.000Z",
  },
  {
    id: "proj-2",
    name: "web_dashboard",
    path: "/Users/dev/Documents/web_dashboard",
    colorHex: "#10B981",
    gitBranch: "dev",
    addedAt: "2026-11-20T00:00:00.000Z",
  },
];

const SAMPLE_TASKS: AgentTask[] = [
  {
    id: "task-12",
    taskNumber: 12,
    title: "UI feedback for selected mentions above the chat input with a very long title",
    summary: "",
    projectId: "proj-1",
    projectName: "agent_terminal_2",
    projectPath: "/Users/dev/Documents/agent_terminal_2",
    status: "running",
    currentStep: null,
    workerThreadId: null,
    activeTurnId: null,
    previewURL: null,
    latestOutput: "",
    activities: [],
    createdAt: "2026-11-25T00:00:00.000Z",
    updatedAt: "2026-11-25T00:00:00.000Z",
  },
];

function makeSnapshot(): AppSnapshot {
  return {
    projects: SAMPLE_PROJECTS,
    scanRoots: [],
    tasks: SAMPLE_TASKS,
    messages: [],
    activeChatSessionId: "sess-1",
    chatSessions: [
      {
        id: "sess-1",
        title: "Test Chat",
        preview: "",
        messageCount: 0,
        createdAt: "2026-11-26T00:00:00.000Z",
        updatedAt: "2026-11-26T00:00:00.000Z",
      },
    ],
    browserTabs: [],
    activeBrowserTabId: null,
    isPickingElement: false,
    showTaskSidebar: true,
    showBrowserPane: false,
    isConnected: true,
    connectionStatus: "Codex 利用可能",
    activeResponderCount: 0,
    providers: {
      codex: { id: "codex", label: "Codex", available: true, detail: "ok", models: [] },
      agy: { id: "agy", label: "AGY", available: false, detail: "", models: [] },
      claude: { id: "claude", label: "Claude", available: false, detail: "", models: [] },
    },
    chatProvider: "codex",
    workerProvider: "codex",
    models: [],
    chatModel: null,
    chatEffort: null,
    workerModel: null,
    workerEffort: null,
    defaultIntegrationMode: "feature-branch",
    autoLandOnComplete: true,
    preferredLanguage: "ja",
    lastErrorBanner: null,
  };
}

function renderUnifiedChatWithDraft(
  composerText: string,
  attachments: ChatAttachment[] = [],
  selectedMentions: ExplicitMentionTarget[] = [],
): string {
  return renderToStaticMarkup(
    <UnifiedChat
      snapshot={makeSnapshot()}
      composerText={composerText}
      attachments={attachments}
      selectedMentions={selectedMentions}
      onComposerTextChange={vi.fn()}
      onAddMention={vi.fn()}
      onRemoveMention={vi.fn()}
      onRemoveAttachment={vi.fn()}
      onAddAttachment={vi.fn()}
      onSend={vi.fn()}
      onStopMessage={vi.fn()}
      onStopAll={vi.fn()}
      onNewChat={vi.fn()}
      onSelectChatSession={vi.fn()}
      onDeleteChatSession={vi.fn()}
      onToggleSidebar={vi.fn()}
      onToggleBrowser={vi.fn()}
      rightPaneMode="browser"
      onToggleMarkdownViewer={vi.fn()}
      onAddProject={vi.fn()}
      onOpenUrl={vi.fn()}
      onOpenMarkdownFile={vi.fn()}
      onOpenImageAttachment={vi.fn()}
      onOpenTask={vi.fn()}
      onToggleElementPicker={vi.fn()}
      onCaptureScreenshot={vi.fn()}
      onAttachCurrentUrl={vi.fn()}
      onAttachConsoleErrors={vi.fn()}
      onPickLocalImages={vi.fn()}
      onPasteImage={vi.fn()}
      onReconnect={vi.fn()}
      onDismissError={vi.fn()}
      onSetChatProvider={vi.fn()}
      onSetWorkerProvider={vi.fn()}
      onSetChatModel={vi.fn()}
      onSetWorkerModel={vi.fn()}
    />,
  );
}

function findElementByTestId(
  node: unknown,
  testId: string,
): React.ReactElement<Record<string, unknown>> | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElementByTestId(child, testId);
      if (found) return found;
    }
    return null;
  }
  if (!React.isValidElement(node)) return null;
  const props = node.props as Record<string, unknown>;
  if (props["data-testid"] === testId) {
    return node as React.ReactElement<Record<string, unknown>>;
  }
  return findElementByTestId(props.children, testId);
}

describe("DraftMentionContextBar & UnifiedChat live mention feedback UI", () => {
  it("hides the context bar when draft contains no resolved mentions", () => {
    expect(renderUnifiedChatWithDraft("")).not.toContain('data-testid="draft-mention-context-bar"');
    expect(renderUnifiedChatWithDraft("普通のメッセージ dev@agent_terminal_2.com @T999")).not.toContain(
      'data-testid="draft-mention-context-bar"',
    );
  });

  it("renders deduplicated task and project chips above the chat input textarea with pill badges, title, tooltips, and remove buttons", () => {
    const html = renderUnifiedChatWithDraft(
      "@T12 と @agent_terminal_2/T12 と @web_dashboard と @web_dashboard を確認して",
    );

    expect(html).toContain('data-testid="draft-mention-context-bar"');

    // Context bar appears before the textarea in DOM order
    const barIndex = html.indexOf('data-testid="draft-mention-context-bar"');
    const textareaIndex = html.indexOf("<textarea");
    expect(barIndex).toBeGreaterThan(-1);
    expect(textareaIndex).toBeGreaterThan(barIndex);

    // Deduplicated task chip for T12
    const taskChipMatches = html.match(/data-testid="draft-mention-chip-task-12"/g) ?? [];
    expect(taskChipMatches).toHaveLength(1);
    expect(html).toContain("T12");
    expect(html).toContain("agent_terminal_2");
    expect(html).toContain("UI feedback for selected mentions above the chat input with a very long title");
    expect(html).toContain(
      'title="T12 · agent_terminal_2: UI feedback for selected mentions above the chat input with a very long title"',
    );
    expect(html).toContain('data-testid="draft-mention-remove-task-12"');

    // Deduplicated project chip for web_dashboard with full path tooltip
    const projChipMatches = html.match(/data-testid="draft-mention-chip-project-proj-2"/g) ?? [];
    expect(projChipMatches).toHaveLength(1);
    expect(html).toContain("web_dashboard");
    expect(html).toContain('title="/Users/dev/Documents/web_dashboard"');
    expect(html).toContain('data-testid="draft-mention-remove-project-proj-2"');
  });

  it("invokes onRemoveChip when clicking the remove button and strips the mention cleanly from draft text", () => {
    let draft = "@T12 と @web_dashboard を確認して";
    const chips = extractResolvedMentionChips(draft, SAMPLE_PROJECTS, SAMPLE_TASKS);
    expect(chips).toHaveLength(2);

    const onRemoveChip = vi.fn((chip: (typeof chips)[number]) => {
      const target =
        chip.kind === "task"
          ? ({ kind: "task", taskId: chip.task.id } as const)
          : ({ kind: "project", projectId: chip.project.id } as const);
      draft = removeResolvedMentionChip(draft, target, SAMPLE_PROJECTS, SAMPLE_TASKS).nextText;
    });

    const tree = DraftMentionContextBar({ chips, onRemoveChip });
    const removeTaskBtn = findElementByTestId(tree, "draft-mention-remove-task-12");
    expect(removeTaskBtn).not.toBeNull();
    (removeTaskBtn!.props.onClick as () => void)();

    expect(onRemoveChip).toHaveBeenCalledTimes(1);
    expect(draft).toBe("と @web_dashboard を確認して");

    const remainingChips = extractResolvedMentionChips(draft, SAMPLE_PROJECTS, SAMPLE_TASKS);
    expect(remainingChips).toHaveLength(1);
    expect(remainingChips[0]?.kind).toBe("project");

    const tree2 = DraftMentionContextBar({ chips: remainingChips, onRemoveChip });
    const removeProjBtn = findElementByTestId(tree2, "draft-mention-remove-project-proj-2");
    expect(removeProjBtn).not.toBeNull();
    (removeProjBtn!.props.onClick as () => void)();

    expect(draft).toBe("と を確認して");
    expect(extractResolvedMentionChips(draft, SAMPLE_PROJECTS, SAMPLE_TASKS)).toEqual([]);
  });

  it("renders cleanly below attachment thumbnails and directly above the textarea when both are present", () => {
    const html = renderUnifiedChatWithDraft("@T12 を見て", [
      {
        id: "att-1",
        kind: "image",
        label: "screenshot.png",
        imageDataUrl: "data:image/png;base64,AAAA",
      },
    ]);

    const attIndex = html.indexOf("screenshot.png");
    const barIndex = html.indexOf('data-testid="draft-mention-context-bar"');
    const textareaIndex = html.indexOf("<textarea");
    expect(attIndex).toBeGreaterThan(-1);
    expect(barIndex).toBeGreaterThan(attIndex);
    expect(textareaIndex).toBeGreaterThan(barIndex);
  });

  it("renders structured selectedMentions chips above a clean textarea containing no raw @xxx tokens", () => {
    const selectedMentions: ExplicitMentionTarget[] = [
      { kind: "task", taskId: "task-12", taskNumber: 12 },
      { kind: "project", projectId: "proj-2", projectName: "web_dashboard" },
    ];
    const html = renderUnifiedChatWithDraft("ビルドエラーの原因を調べて", [], selectedMentions);

    expect(html).toContain('data-testid="draft-mention-context-bar"');
    expect(html).toContain('data-testid="draft-mention-chip-task-12"');
    expect(html).toContain('data-testid="draft-mention-chip-project-proj-2"');
    // Textarea contains clean text with zero raw @xxx tokens
    const textareaMatch = html.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/);
    expect(textareaMatch?.[1]).toBe("ビルドエラーの原因を調べて");
    expect(textareaMatch?.[1]).not.toContain("@");
  });

  it("removes a structured chip without mutating clean draft text when clicking ×", () => {
    let selectedMentions: ExplicitMentionTarget[] = [];
    selectedMentions = addExplicitMentionTarget(selectedMentions, {
      kind: "task",
      taskId: "task-12",
      taskNumber: 12,
    });
    selectedMentions = addExplicitMentionTarget(selectedMentions, {
      kind: "project",
      projectId: "proj-2",
      projectName: "web_dashboard",
    });

    const draft = "変更を確認して";
    const chips = extractResolvedMentionChips(draft, SAMPLE_PROJECTS, SAMPLE_TASKS, selectedMentions);
    expect(chips).toHaveLength(2);

    const onRemoveChip = vi.fn((chip: (typeof chips)[number]) => {
      const target =
        chip.kind === "task"
          ? ({ kind: "task", taskId: chip.task.id } as const)
          : ({ kind: "project", projectId: chip.project.id } as const);
      selectedMentions = removeExplicitMentionTarget(selectedMentions, target);
    });

    const tree = DraftMentionContextBar({ chips, onRemoveChip });
    const removeTaskBtn = findElementByTestId(tree, "draft-mention-remove-task-12");
    expect(removeTaskBtn).not.toBeNull();
    (removeTaskBtn!.props.onClick as () => void)();

    expect(selectedMentions).toEqual([
      { kind: "project", projectId: "proj-2", projectName: "web_dashboard" },
    ]);
    expect(draft).toBe("変更を確認して");
    expect(
      extractResolvedMentionChips(draft, SAMPLE_PROJECTS, SAMPLE_TASKS, selectedMentions),
    ).toHaveLength(1);
  });
});
