import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HIDDEN_BROWSER_BOUNDS,
  areBrowserBoundsEqual,
  createBrowserBoundsDispatcher,
  normalizeBrowserBounds,
} from "../src/shared/browser-bounds.js";
import type { AppSnapshot, BrowserBounds, BrowserTab, ChatMessage } from "../src/shared/types.js";
import {
  hideBrowserBounds,
  syncBrowserBounds,
} from "../src/renderer/lib/browser-bounds-client.js";
import {
  areRightPaneWorkspaceStatesEqual,
  createEmptyRightPaneWorkspaceState,
  reconcileWorkspaceState,
} from "../src/renderer/lib/right-pane-tabs.js";
import { reconcileAppSnapshot } from "../src/renderer/lib/snapshot-reconcile.js";
import { ConductorController } from "../src/main/conductor-controller.js";
import type { BrowserManager } from "../src/main/browser-manager.js";
import { StateStore } from "../src/main/state-store.js";

function makeMessage(overrides: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    role: "assistant",
    text: "Hello world",
    attachments: [],
    toolChips: [],
    isStreaming: false,
    createdAt: "2026-11-26T00:00:00.000Z",
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    projects: [
      {
        id: "proj-1",
        name: "conductor",
        path: "/tmp/conductor",
        colorHex: "#3B82F6",
        gitBranch: "main",
        addedAt: "2026-11-26T00:00:00.000Z",
      },
    ],
    scanRoots: [],
    tasks: [
      {
        id: "task-1",
        taskNumber: 1,
        title: "Fix idle CPU",
        summary: "Audit renderer",
        projectId: "proj-1",
        projectName: "conductor",
        projectPath: "/tmp/conductor",
        status: "done",
        currentStep: null,
        workerThreadId: null,
        activeTurnId: null,
        previewURL: null,
        latestOutput: "Done",
        activities: [],
        createdAt: "2026-11-26T00:00:00.000Z",
        updatedAt: "2026-11-26T00:01:00.000Z",
      },
    ],
    messages: [
      makeMessage({ id: "m1", role: "user", text: "Hi" }),
      makeMessage({ id: "m2", role: "assistant", text: "Hello!" }),
    ],
    activeChatSessionId: "sess-1",
    chatSessions: [
      {
        id: "sess-1",
        title: "Hi",
        preview: "Hello!",
        messageCount: 2,
        createdAt: "2026-11-26T00:00:00.000Z",
        updatedAt: "2026-11-26T00:01:00.000Z",
      },
    ],
    browserTabs: [
      {
        id: "tab-1",
        title: "Local App",
        url: "http://localhost:3000",
        projectId: "proj-1",
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        consoleErrorCount: 0,
        networkErrorCount: 0,
      },
    ],
    activeBrowserTabId: "tab-1",
    isPickingElement: false,
    showTaskSidebar: true,
    showBrowserPane: true,
    isConnected: true,
    connectionStatus: "Codex 利用可能",
    activeResponderCount: 0,
    providers: {
      codex: { id: "codex", label: "Codex", available: true, detail: "ready", models: [] },
      agy: { id: "agy", label: "AGY", available: false, detail: "n/a", models: [] },
      claude: { id: "claude", label: "Claude", available: false, detail: "n/a", models: [] },
    },
    chatProvider: "codex",
    workerProvider: "codex",
    models: [],
    chatModel: "gpt-5",
    chatEffort: "low",
    workerModel: "gpt-5",
    workerEffort: "medium",
    defaultIntegrationMode: "feature-branch",
    autoLandOnComplete: true,
    preferredLanguage: "ja",
    voiceReadbackEnabled: false,
    remoteAccessEnabled: false,
    remoteAccessPort: 4789,
    remoteAccessToken: "0123456789abcdef0123456789abcdef",
    usageRecords: [],
    lastErrorBanner: null,
    ...overrides,
  };
}

describe("browser-bounds normalization and deduplication", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("normalizes sub-pixel coordinates and canonicalizes hidden/tiny bounds", () => {
    expect(
      normalizeBrowserBounds({ x: 100.4, y: 44.6, width: 519.8, height: 820.2, visible: true }),
    ).toEqual({
      x: 100,
      y: 45,
      width: 520,
      height: 820,
      visible: true,
    });

    expect(
      normalizeBrowserBounds({ x: 50, y: 60, width: 400, height: 300, visible: false }),
    ).toEqual(HIDDEN_BROWSER_BOUNDS);

    expect(
      normalizeBrowserBounds({ x: 50, y: 60, width: 10, height: 300, visible: true }),
    ).toEqual(HIDDEN_BROWSER_BOUNDS);
  });

  it("compares browser bounds by normalized values", () => {
    const a: BrowserBounds = { x: 10.2, y: 20.4, width: 400.1, height: 600.4, visible: true };
    const b: BrowserBounds = { x: 9.8, y: 20.1, width: 400.4, height: 599.9, visible: true };
    const c: BrowserBounds = { x: 11, y: 20, width: 400, height: 600, visible: true };

    expect(areBrowserBoundsEqual(a, b)).toBe(true);
    expect(areBrowserBoundsEqual(a, c)).toBe(false);
    expect(
      areBrowserBoundsEqual(
        { x: 10, y: 20, width: 300, height: 400, visible: false },
        HIDDEN_BROWSER_BOUNDS,
      ),
    ).toBe(true);
  });

  it("deduplicates consecutive identical browserSetBounds dispatches", () => {
    const send = vi.fn();
    const dispatcher = createBrowserBoundsDispatcher(send);

    expect(dispatcher.dispatch({ x: 10, y: 20, width: 500, height: 700, visible: true })).toBe(
      true,
    );
    expect(
      dispatcher.dispatch({ x: 10.2, y: 19.9, width: 500.1, height: 699.8, visible: true }),
    ).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);

    expect(dispatcher.dispatch({ x: 10, y: 20, width: 520, height: 700, visible: true })).toBe(
      true,
    );
    expect(send).toHaveBeenCalledTimes(2);

    expect(dispatcher.dispatch({ x: 0, y: 0, width: 0, height: 0, visible: false })).toBe(true);
    expect(dispatcher.dispatch({ x: 99, y: 99, width: 400, height: 400, visible: false })).toBe(
      false,
    );
    expect(send).toHaveBeenCalledTimes(3);

    dispatcher.reset();
    expect(dispatcher.dispatch({ x: 0, y: 0, width: 0, height: 0, visible: false })).toBe(true);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it("deduplicates renderer syncBrowserBounds per browserSetBounds function reference", () => {
    const mockSend1 = vi.fn();
    (globalThis as { window?: unknown }).window = {
      conductor: { browserSetBounds: mockSend1 },
    };

    expect(hideBrowserBounds()).toBe(true);
    expect(hideBrowserBounds()).toBe(false);
    expect(syncBrowserBounds({ x: 12, y: 40, width: 500, height: 700, visible: true })).toBe(true);
    expect(syncBrowserBounds({ x: 12.1, y: 40.2, width: 499.9, height: 700.1, visible: true })).toBe(
      false,
    );
    expect(mockSend1).toHaveBeenCalledTimes(2);

    // Replacing mock function starts clean without leaking stale deduplication state
    const mockSend2 = vi.fn();
    (globalThis as { window?: unknown }).window = {
      conductor: { browserSetBounds: mockSend2 },
    };
    expect(syncBrowserBounds({ x: 12, y: 40, width: 500, height: 700, visible: true })).toBe(true);
    expect(mockSend2).toHaveBeenCalledTimes(1);
  });
});

describe("reconcileAppSnapshot structural sharing", () => {
  it("returns the exact previous snapshot reference when an IPC-cloned snapshot is identical", () => {
    const prev = makeSnapshot();
    const cloned = structuredClone(prev);

    const reconciled = reconcileAppSnapshot(prev, cloned);
    expect(reconciled).toBe(prev);
  });

  it("preserves untouched message references when only a streaming message updates", () => {
    const prev = makeSnapshot({
      messages: [
        makeMessage({ id: "m1", role: "user", text: "Question 1" }),
        makeMessage({ id: "m2", role: "assistant", text: "Answer 1" }),
        makeMessage({ id: "m3", role: "assistant", text: "Streaming...", isStreaming: true }),
      ],
    });

    const incoming = structuredClone(prev);
    incoming.messages[2].text = "Streaming... more tokens";

    const reconciled = reconcileAppSnapshot(prev, incoming);
    expect(reconciled).not.toBe(prev);
    expect(reconciled.messages).not.toBe(prev.messages);
    // Untouched historical messages keep exact identity for React.memo
    expect(reconciled.messages[0]).toBe(prev.messages[0]);
    expect(reconciled.messages[1]).toBe(prev.messages[1]);
    expect(reconciled.messages[2]).not.toBe(prev.messages[2]);
    expect(reconciled.messages[2].text).toBe("Streaming... more tokens");
    // Unchanged slices keep exact identity too
    expect(reconciled.projects).toBe(prev.projects);
    expect(reconciled.tasks).toBe(prev.tasks);
    expect(reconciled.browserTabs).toBe(prev.browserTabs);
    expect(reconciled.providers).toBe(prev.providers);
  });

  it("preserves messages/tasks/projects references when only browserTabs changes", () => {
    const prev = makeSnapshot();
    const incoming = structuredClone(prev);
    incoming.browserTabs[0].isLoading = true;

    const reconciled = reconcileAppSnapshot(prev, incoming);
    expect(reconciled).not.toBe(prev);
    expect(reconciled.browserTabs).not.toBe(prev.browserTabs);
    expect(reconciled.browserTabs[0].isLoading).toBe(true);
    expect(reconciled.messages).toBe(prev.messages);
    expect(reconciled.tasks).toBe(prev.tasks);
    expect(reconciled.projects).toBe(prev.projects);
  });
});

describe("reconcileWorkspaceState referential stability", () => {
  it("returns the exact same workspace state reference when inputs produce no state change", () => {
    const snap = makeSnapshot();
    const initial = reconcileWorkspaceState(createEmptyRightPaneWorkspaceState(), {
      browserTabs: snap.browserTabs,
      mdTabs: [],
      imageTabs: [],
      codeTabs: [],
      projects: snap.projects,
      tasks: snap.tasks,
    });

    // Re-reconcile with cloned arrays (as happens on every IPC snapshot)
    const cloned = structuredClone(snap);
    const second = reconcileWorkspaceState(initial, {
      browserTabs: cloned.browserTabs,
      mdTabs: [],
      imageTabs: [],
      codeTabs: [],
      projects: cloned.projects,
      tasks: cloned.tasks,
    });

    expect(areRightPaneWorkspaceStatesEqual(initial, second)).toBe(true);
    expect(second).toBe(initial);
  });
});

describe("ConductorController.notifyBrowserChanged throttling and persist skipping", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("coalesces transient browser notifications without writing state.json", () => {
    vi.useFakeTimers();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-cpu-test-"));
    tempDirs.push(dir);
    const store = new StateStore(dir);
    const saveSpy = vi.spyOn(store, "save");

    const tabs: BrowserTab[] = [
      {
        id: "tab-1",
        title: "App",
        url: "http://localhost:3000",
        projectId: null,
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        consoleErrorCount: 0,
        networkErrorCount: 0,
      },
    ];
    const fakeBrowser = {
      restore: vi.fn(),
      getTabs: () => tabs,
      getActiveTabId: () => "tab-1",
      isPickingElement: () => false,
    } as unknown as BrowserManager;

    const snapshots: AppSnapshot[] = [];
    const controller = new ConductorController({
      store,
      browser: fakeBrowser,
      onSnapshot: (s) => snapshots.push(s),
    });

    saveSpy.mockClear();
    snapshots.length = 0;

    // Rapid transient updates (e.g., loading/console error bursts)
    controller.notifyBrowserChanged({ persist: false });
    controller.notifyBrowserChanged({ persist: false });
    controller.notifyBrowserChanged({ persist: false });

    expect(saveSpy).not.toHaveBeenCalled();
    expect(snapshots).toHaveLength(0);

    vi.advanceTimersByTime(60);
    expect(snapshots).toHaveLength(1);
    expect(saveSpy).not.toHaveBeenCalled();

    // Persistent update writes once; repeating with identical tab metadata skips redundant disk write
    tabs[0].title = "Updated Title";
    controller.notifyBrowserChanged({ persist: true });
    expect(saveSpy).toHaveBeenCalledTimes(1);

    controller.notifyBrowserChanged({ persist: true });
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });
});
