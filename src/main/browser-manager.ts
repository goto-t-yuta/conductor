import crypto from "node:crypto";
import { BrowserWindow, WebContentsView, shell } from "electron";
import {
  areBrowserBoundsEqual,
  HIDDEN_BROWSER_BOUNDS,
  normalizeBrowserBounds,
} from "../shared/browser-bounds.js";
import type {
  BrowserBounds,
  BrowserConsoleEntry,
  BrowserNetworkError,
  BrowserTab,
  ChatAttachment,
} from "../shared/types.js";
import { normalizeUrl, shortTitleFromUrl } from "./shell-env.js";
import type { StateStore } from "./state-store.js";

interface ManagedTab {
  meta: BrowserTab;
  view: WebContentsView;
  debuggerAttached: boolean;
  consoleEntries: BrowserConsoleEntry[];
  networkErrors: BrowserNetworkError[];
  requestMeta: Map<string, { url: string; method: string }>;
}

const PICKER_PREFIX = "__CONDUCTOR_PICKER__:";

const ELEMENT_PICKER_SCRIPT = `
(() => {
  if (window.__conductorPicker) {
    window.__conductorPicker.disable();
  }
  const overlay = document.createElement('div');
  overlay.id = '__conductor_picker_overlay';
  overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #4F46E5;background:rgba(79,70,229,0.14);border-radius:4px;transition:all 50ms ease;display:none;';
  const badge = document.createElement('div');
  badge.id = '__conductor_picker_badge';
  badge.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;background:#1E1B4B;color:#FFFFFF;font:600 11px/1.3 -apple-system,BlinkMacSystemFont,monospace;padding:3px 7px;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,0.3);display:none;';
  document.documentElement.appendChild(overlay);
  document.documentElement.appendChild(badge);

  function buildSelector(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 4) {
      let part = cur.tagName.toLowerCase();
      if (cur.classList && cur.classList.length > 0) {
        part += '.' + Array.from(cur.classList).slice(0, 2).map(c => CSS.escape(c)).join('.');
      }
      parts.unshift(part);
      if (cur.parentElement && cur.parentElement.id) {
        parts.unshift('#' + CSS.escape(cur.parentElement.id));
        break;
      }
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  let currentTarget = null;
  function onMove(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === overlay || el === badge) return;
    currentTarget = el;
    const r = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.left = r.left + 'px';
    overlay.style.top = r.top + 'px';
    overlay.style.width = r.width + 'px';
    overlay.style.height = r.height + 'px';
    badge.style.display = 'block';
    badge.textContent = buildSelector(el) + ' (' + Math.round(r.width) + 'x' + Math.round(r.height) + ')';
    badge.style.left = Math.max(8, Math.min(window.innerWidth - 220, r.left)) + 'px';
    badge.style.top = Math.max(8, r.top - 24) + 'px';
  }

  function cleanup() {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    overlay.remove();
    badge.remove();
    delete window.__conductorPicker;
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
      console.debug('${PICKER_PREFIX}' + JSON.stringify({ type: 'cancelled' }));
    }
  }

  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const el = currentTarget || e.target;
    const r = el.getBoundingClientRect();
    const cs = window.getComputedStyle(el);
    const stylesSummary = [
      'color:' + cs.color,
      'bg:' + cs.backgroundColor,
      'font:' + cs.fontSize + ' ' + cs.fontWeight,
      'display:' + cs.display,
      'padding:' + cs.padding
    ].join('; ');
    const payload = {
      type: 'picked',
      selector: buildSelector(el),
      tagName: el.tagName.toLowerCase(),
      textSnippet: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 240),
      outerHTMLSnippet: (el.outerHTML || '').slice(0, 900),
      pageURL: window.location.href,
      pageTitle: document.title || '',
      rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
      stylesSummary
    };
    cleanup();
    console.debug('${PICKER_PREFIX}' + JSON.stringify(payload));
  }

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.__conductorPicker = { disable: cleanup };
})();
`;

export type BrowserTabsChangeReason = "persistent" | "transient";

export class BrowserManager {
  private readonly win: BrowserWindow;
  private readonly store: StateStore;
  private readonly onTabsChanged: (reason?: BrowserTabsChangeReason) => void;
  private readonly onElementPicked: (attachment: ChatAttachment) => void;

  private tabs = new Map<string, ManagedTab>();
  private tabOrder: string[] = [];
  private activeTabId: string | null = null;
  private attachedView: WebContentsView | null = null;
  private lastBounds: BrowserBounds = HIDDEN_BROWSER_BOUNDS;
  private lastAppliedView: WebContentsView | null = null;
  private lastAppliedBounds: BrowserBounds | null = null;
  private pickingElement = false;

  constructor(options: {
    window: BrowserWindow;
    store: StateStore;
    onTabsChanged: (reason?: BrowserTabsChangeReason) => void;
    onElementPicked: (attachment: ChatAttachment) => void;
  }) {
    this.win = options.window;
    this.store = options.store;
    this.onTabsChanged = options.onTabsChanged;
    this.onElementPicked = options.onElementPicked;
  }

  public restore(
    savedTabs: Array<{ id: string; title: string; url: string; projectId?: string | null }>,
    savedActiveId: string | null,
  ): void {
    if (savedTabs.length === 0) {
      this.activeTabId = null;
      this.detachCurrentView();
      return;
    }
    for (const st of savedTabs) {
      this.createTab(st.url, st.id, st.title, false, st.projectId ?? null);
    }
    const chosen = savedActiveId && this.tabs.has(savedActiveId) ? savedActiveId : this.tabOrder[0] ?? null;
    if (chosen) {
      this.selectTab(chosen);
    }
  }

  public getTabs(): BrowserTab[] {
    return this.tabOrder
      .map((id) => this.tabs.get(id)?.meta)
      .filter((t): t is BrowserTab => Boolean(t));
  }

  public getActiveTabId(): string | null {
    return this.activeTabId;
  }

  public getActiveTab(): BrowserTab | null {
    if (!this.activeTabId) return null;
    return this.tabs.get(this.activeTabId)?.meta ?? null;
  }

  public isPickingElement(): boolean {
    return this.pickingElement;
  }

  public setBounds(bounds: BrowserBounds): void {
    const normalized = normalizeBrowserBounds(bounds);
    if (areBrowserBoundsEqual(this.lastBounds, normalized)) {
      if (!normalized.visible && !this.attachedView) {
        return;
      }
      const activeView = this.activeManaged()?.view ?? null;
      if (
        normalized.visible &&
        this.attachedView === activeView &&
        this.lastAppliedView === activeView &&
        areBrowserBoundsEqual(this.lastAppliedBounds, normalized)
      ) {
        return;
      }
    }
    this.lastBounds = normalized;
    this.syncAttachedView();
  }

  public createTab(
    rawUrl = "",
    fixedId?: string,
    fixedTitle?: string,
    activate = true,
    projectId?: string | null,
  ): string {
    const id = fixedId ?? crypto.randomUUID();
    const url = rawUrl ? normalizeUrl(rawUrl) : "";
    const view = new WebContentsView({
      webPreferences: {
        partition: "persist:conductor-browser",
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    const meta: BrowserTab = {
      id,
      title: fixedTitle || (url ? shortTitleFromUrl(url) : "New Tab"),
      url,
      projectId: projectId ?? null,
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      consoleErrorCount: 0,
      networkErrorCount: 0,
    };

    const managed: ManagedTab = {
      meta,
      view,
      debuggerAttached: false,
      consoleEntries: [],
      networkErrors: [],
      requestMeta: new Map(),
    };

    this.wireWebContentsEvents(managed);
    this.tabs.set(id, managed);
    this.tabOrder.push(id);

    if (url) {
      void view.webContents.loadURL(url).catch(() => {
        // load error surfaced via did-fail-load
      });
    }

    if (activate) {
      this.selectTab(id);
    } else {
      this.onTabsChanged();
    }
    return id;
  }

  public selectTab(tabId: string): void {
    if (!this.tabs.has(tabId)) return;
    const changed = this.activeTabId !== tabId;
    if (this.pickingElement) {
      void this.setElementPicker(false);
    }
    this.activeTabId = tabId;
    this.syncAttachedView();
    if (changed) {
      this.onTabsChanged("persistent");
    }
  }

  public closeTab(tabId: string): void {
    const managed = this.tabs.get(tabId);
    if (!managed) return;

    const closedProjectId = managed.meta.projectId ?? null;
    const sameProjectBefore = this.tabOrder.filter(
      (id) => (this.tabs.get(id)?.meta.projectId ?? null) === closedProjectId,
    );
    const sameProjectIdx = sameProjectBefore.indexOf(tabId);

    const idx = this.tabOrder.indexOf(tabId);
    if (idx !== -1) this.tabOrder.splice(idx, 1);
    this.tabs.delete(tabId);

    if (this.attachedView === managed.view) {
      this.detachCurrentView();
    }
    try {
      if (managed.debuggerAttached && managed.view.webContents.debugger.isAttached()) {
        managed.view.webContents.debugger.detach();
      }
      managed.view.webContents.close();
    } catch {
      // ignore close errors
    }

    if (this.activeTabId === tabId) {
      const sameProjectRemaining = this.tabOrder.filter(
        (id) => (this.tabs.get(id)?.meta.projectId ?? null) === closedProjectId,
      );
      if (sameProjectRemaining.length > 0) {
        const nextIdx = Math.min(Math.max(0, sameProjectIdx), sameProjectRemaining.length - 1);
        this.activeTabId = sameProjectRemaining[nextIdx] ?? sameProjectRemaining[0] ?? null;
      } else {
        // Do not hijack another project's browser tabs or spawn an orphan blank tab.
        this.activeTabId = null;
      }
    }
    this.syncAttachedView();
    this.onTabsChanged();
  }

  public async navigate(
    rawUrl: string,
    newTab = false,
    projectId?: string | null,
  ): Promise<string> {
    const url = normalizeUrl(rawUrl);
    if (!url) return "";

    if (this.pickingElement) {
      await this.setElementPicker(false);
    }

    const hasExplicitProject = projectId !== undefined;
    const targetProjectId = hasExplicitProject
      ? (projectId ?? null)
      : (this.activeManaged()?.meta.projectId ?? null);

    if (newTab) {
      this.createTab(url, undefined, undefined, true, targetProjectId);
      return url;
    }

    const active = this.activeManaged();
    const canReuseActive =
      Boolean(active) &&
      (!hasExplicitProject || (active!.meta.projectId ?? null) === targetProjectId);

    let targetManaged: ManagedTab | null = canReuseActive ? active : null;

    if (!targetManaged && hasExplicitProject) {
      // Prefer reusing an empty "New Tab" in the target project rather than clobbering another project's tab.
      for (const id of this.tabOrder) {
        const candidate = this.tabs.get(id);
        if (
          candidate &&
          (candidate.meta.projectId ?? null) === targetProjectId &&
          !candidate.meta.url
        ) {
          targetManaged = candidate;
          this.activeTabId = candidate.meta.id;
          break;
        }
      }
    }

    if (!targetManaged) {
      this.createTab(url, undefined, undefined, true, targetProjectId);
      return url;
    }

    targetManaged.meta.url = url;
    targetManaged.meta.title = shortTitleFromUrl(url);
    targetManaged.consoleEntries = [];
    targetManaged.networkErrors = [];
    targetManaged.meta.consoleErrorCount = 0;
    targetManaged.meta.networkErrorCount = 0;
    this.syncAttachedView();
    this.onTabsChanged();

    await targetManaged.view.webContents.loadURL(url).catch(() => {
      // ignore navigation interruption errors
    });
    return url;
  }

  public goBack(): void {
    const wc = this.activeManaged()?.view.webContents;
    if (wc?.navigationHistory.canGoBack()) {
      wc.navigationHistory.goBack();
    }
  }

  public goForward(): void {
    const wc = this.activeManaged()?.view.webContents;
    if (wc?.navigationHistory.canGoForward()) {
      wc.navigationHistory.goForward();
    }
  }

  public reloadOrStop(): void {
    const wc = this.activeManaged()?.view.webContents;
    if (!wc) return;
    if (wc.isLoading()) {
      wc.stop();
    } else {
      wc.reload();
    }
  }

  public toggleDevTools(): void {
    const wc = this.activeManaged()?.view.webContents;
    if (!wc) return;
    if (wc.isDevToolsOpened()) {
      wc.closeDevTools();
    } else {
      wc.openDevTools({ mode: "detach" });
    }
  }

  public openExternal(): void {
    const url = this.activeManaged()?.meta.url;
    if (url) {
      void shell.openExternal(url);
    }
  }

  public async setElementPicker(enabled: boolean): Promise<void> {
    const managed = this.activeManaged();
    if (!managed || !managed.meta.url) {
      if (this.pickingElement) {
        this.pickingElement = false;
        this.onTabsChanged("transient");
      }
      return;
    }
    if (this.pickingElement !== enabled) {
      this.pickingElement = enabled;
      this.onTabsChanged("transient");
    }
    try {
      if (enabled) {
        await managed.view.webContents.executeJavaScript(ELEMENT_PICKER_SCRIPT, true);
      } else {
        await managed.view.webContents.executeJavaScript(
          "window.__conductorPicker && window.__conductorPicker.disable();",
          true,
        );
      }
    } catch {
      if (this.pickingElement) {
        this.pickingElement = false;
        this.onTabsChanged("transient");
      }
    }
  }

  public async captureViewportAttachment(): Promise<ChatAttachment | null> {
    const managed = this.activeManaged();
    if (!managed || !managed.meta.url) return null;
    try {
      const img = await managed.view.webContents.capturePage();
      const png = img.toPNG();
      if (png.length === 0) return null;
      const saved = this.store.savePngBuffer(png, "browser");
      return {
        id: crypto.randomUUID(),
        kind: "image",
        label: `Screenshot: ${managed.meta.title.slice(0, 24)}`,
        imagePath: saved.imagePath,
        imageDataUrl: saved.imageDataUrl,
        url: managed.meta.url,
        metadataText: `[Attached Chromium viewport screenshot of "${managed.meta.title}" (${managed.meta.url})]`,
      };
    } catch {
      return null;
    }
  }

  public getConsoleErrorsAttachment(): ChatAttachment | null {
    const managed = this.activeManaged();
    if (!managed) return null;
    const errors = managed.consoleEntries.filter((e) => e.level === "error" || e.level === "warning");
    const netErrors = managed.networkErrors;
    if (errors.length === 0 && netErrors.length === 0) return null;

    const lines: string[] = [
      `[Browser Errors on ${managed.meta.title} (${managed.meta.url})]`,
    ];
    if (errors.length > 0) {
      lines.push("Console:");
      for (const e of errors.slice(-20)) {
        lines.push(`- [${e.level}] ${e.text}${e.source ? ` (${e.source}:${e.line ?? 0})` : ""}`);
      }
    }
    if (netErrors.length > 0) {
      lines.push("Network:");
      for (const n of netErrors.slice(-15)) {
        lines.push(`- ${n.method} ${n.url} -> ${n.status ?? n.errorText}`);
      }
    }
    return {
      id: crypto.randomUUID(),
      kind: "consoleErrors",
      label: `Errors (${errors.length + netErrors.length})`,
      url: managed.meta.url,
      metadataText: lines.join("\n"),
    };
  }

  // MARK: - Agent CDP Browser Automation APIs

  public async agentSnapshot(): Promise<Record<string, unknown>> {
    const managed = this.activeManaged();
    if (!managed || !managed.meta.url) {
      return {
        active_url: "",
        active_title: "",
        note: "No page open in the In-App Browser yet. Use browser_open(url) first.",
        tabs: this.getTabs().map((t) => ({ id: t.id, title: t.title, url: t.url })),
      };
    }

    const script = `
      (() => {
        const selectors = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [contenteditable="true"]';
        const nodes = Array.from(document.querySelectorAll(selectors));
        const interactive = [];
        let refCounter = 1;
        for (const el of nodes) {
          const r = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          if (r.width < 2 || r.height < 2 || style.visibility === 'hidden' || style.display === 'none') continue;
          if (r.bottom < 0 || r.top > window.innerHeight + 600) continue;
          const ref = 'e' + (refCounter++);
          el.setAttribute('data-conductor-ref', ref);
          const tag = el.tagName.toLowerCase();
          const type = el.getAttribute('type') || undefined;
          const name = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
          const val = (tag === 'input' || tag === 'textarea' || tag === 'select') ? String(el.value ?? '').slice(0, 80) : undefined;
          const href = tag === 'a' ? (el.getAttribute('href') || '').slice(0, 120) : undefined;
          interactive.push({ ref, tag, type, name, value: val, href });
          if (interactive.length >= 80) break;
        }
        const text = ((document.body && document.body.innerText) ? document.body.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 3500);
        return {
          url: window.location.href,
          title: document.title || '',
          viewport: { width: window.innerWidth, height: window.innerHeight, scrollY: Math.round(window.scrollY) },
          interactive,
          visibleText: text
        };
      })()
    `;

    const result = (await managed.view.webContents.executeJavaScript(script, true)) as Record<string, unknown>;
    return {
      ...result,
      consoleErrorCount: managed.meta.consoleErrorCount,
      networkErrorCount: managed.meta.networkErrorCount,
      tabs: this.getTabs().map((t) => ({
        id: t.id,
        title: t.title,
        url: t.url,
        active: t.id === this.activeTabId,
      })),
    };
  }

  public async agentClick(target: string): Promise<Record<string, unknown>> {
    const managed = this.activeManaged();
    if (!managed || !managed.meta.url) {
      throw new Error("No active page in In-App Browser");
    }
    this.ensureDebugger(managed);
    const pt = await this.locateAndScrollTarget(managed, target);
    const dbg = managed.view.webContents.debugger;
    await dbg.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: pt.x,
      y: pt.y,
    });
    await dbg.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: pt.x,
      y: pt.y,
      button: "left",
      clickCount: 1,
    });
    await dbg.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: pt.x,
      y: pt.y,
      button: "left",
      clickCount: 1,
    });
    return { clicked: target, x: pt.x, y: pt.y, tag: pt.tag, text: pt.text };
  }

  public async agentType(
    target: string,
    text: string,
    clear = true,
    submit = false,
  ): Promise<Record<string, unknown>> {
    const managed = this.activeManaged();
    if (!managed || !managed.meta.url) {
      throw new Error("No active page in In-App Browser");
    }
    this.ensureDebugger(managed);
    await this.agentClick(target);

    const dbg = managed.view.webContents.debugger;
    if (clear) {
      // Select all + Backspace via CDP so React/Vue controlled inputs update cleanly
      await dbg.sendCommand("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "a",
        code: "KeyA",
        modifiers: 4, // Meta on macOS
        windowsVirtualKeyCode: 65,
      });
      await dbg.sendCommand("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "a",
        code: "KeyA",
        modifiers: 4,
        windowsVirtualKeyCode: 65,
      });
      await dbg.sendCommand("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
      });
      await dbg.sendCommand("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
      });
    }

    await dbg.sendCommand("Input.insertText", { text });

    if (submit) {
      await this.agentPressKey("Enter");
    }
    return { typed: text.length, target, submitted: submit };
  }

  public async agentPressKey(key: string): Promise<Record<string, unknown>> {
    const managed = this.activeManaged();
    if (!managed || !managed.meta.url) {
      throw new Error("No active page in In-App Browser");
    }
    this.ensureDebugger(managed);
    const keyMap: Record<string, { code: string; vk: number; text?: string }> = {
      Enter: { code: "Enter", vk: 13, text: "\r" },
      Escape: { code: "Escape", vk: 27 },
      Tab: { code: "Tab", vk: 9 },
      Backspace: { code: "Backspace", vk: 8 },
      ArrowDown: { code: "ArrowDown", vk: 40 },
      ArrowUp: { code: "ArrowUp", vk: 38 },
      ArrowLeft: { code: "ArrowLeft", vk: 37 },
      ArrowRight: { code: "ArrowRight", vk: 39 },
      Space: { code: "Space", vk: 32, text: " " },
    };
    const spec = keyMap[key] ?? { code: key, vk: 0, text: key.length === 1 ? key : undefined };
    const dbg = managed.view.webContents.debugger;
    await dbg.sendCommand("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code: spec.code,
      text: spec.text,
      windowsVirtualKeyCode: spec.vk,
    });
    await dbg.sendCommand("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code: spec.code,
      windowsVirtualKeyCode: spec.vk,
    });
    return { pressed: key };
  }

  public async agentScroll(deltaY = 500): Promise<Record<string, unknown>> {
    const managed = this.activeManaged();
    if (!managed || !managed.meta.url) {
      throw new Error("No active page in In-App Browser");
    }
    this.ensureDebugger(managed);
    const dbg = managed.view.webContents.debugger;
    await dbg.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: Math.max(100, Math.round(this.lastBounds.width / 2)),
      y: Math.max(100, Math.round(this.lastBounds.height / 2)),
      deltaX: 0,
      deltaY,
    });
    return { scrolled: deltaY };
  }

  public getDiagnostics(): Record<string, unknown> {
    const managed = this.activeManaged();
    if (!managed) {
      return { url: "", console: [], networkErrors: [] };
    }
    return {
      url: managed.meta.url,
      title: managed.meta.title,
      console: managed.consoleEntries.slice(-30),
      networkErrors: managed.networkErrors.slice(-25),
    };
  }

  public destroyAll(): void {
    this.detachCurrentView();
    for (const managed of this.tabs.values()) {
      try {
        if (managed.debuggerAttached && managed.view.webContents.debugger.isAttached()) {
          managed.view.webContents.debugger.detach();
        }
        managed.view.webContents.close();
      } catch {
        // ignore
      }
    }
    this.tabs.clear();
    this.tabOrder = [];
  }

  // MARK: - Internals

  private activeManaged(): ManagedTab | null {
    if (!this.activeTabId) return null;
    return this.tabs.get(this.activeTabId) ?? null;
  }

  private detachCurrentView(): void {
    if (this.attachedView) {
      try {
        this.win.contentView.removeChildView(this.attachedView);
      } catch {
        // ignore
      }
      this.attachedView = null;
    }
    this.lastAppliedView = null;
    this.lastAppliedBounds = null;
  }

  private syncAttachedView(): void {
    const managed = this.activeManaged();
    const shouldShow =
      this.lastBounds.visible &&
      this.lastBounds.width > 10 &&
      this.lastBounds.height > 10 &&
      Boolean(managed?.meta.url);

    if (!shouldShow || !managed) {
      this.detachCurrentView();
      return;
    }

    let viewChanged = false;
    if (this.attachedView !== managed.view) {
      this.detachCurrentView();
      this.win.contentView.addChildView(managed.view);
      this.attachedView = managed.view;
      viewChanged = true;
    }

    if (
      viewChanged ||
      this.lastAppliedView !== managed.view ||
      !areBrowserBoundsEqual(this.lastAppliedBounds, this.lastBounds)
    ) {
      managed.view.setBounds({
        x: this.lastBounds.x,
        y: this.lastBounds.y,
        width: this.lastBounds.width,
        height: this.lastBounds.height,
      });
      this.lastAppliedView = managed.view;
      this.lastAppliedBounds = this.lastBounds;
    }
  }

  private wireWebContentsEvents(managed: ManagedTab): void {
    const wc = managed.view.webContents;

    wc.setWindowOpenHandler(({ url }) => {
      if (url && /^https?:\/\//i.test(url)) {
        this.createTab(url, undefined, undefined, true, managed.meta.projectId ?? null);
      }
      return { action: "deny" };
    });

    const syncMeta = () => {
      const prevUrl = managed.meta.url;
      const prevTitle = managed.meta.title;
      const prevLoading = managed.meta.isLoading;
      const prevCanGoBack = managed.meta.canGoBack;
      const prevCanGoForward = managed.meta.canGoForward;

      const currentUrl = wc.getURL();
      if (currentUrl) managed.meta.url = currentUrl;
      const currentTitle = wc.getTitle();
      if (currentTitle) {
        managed.meta.title = currentTitle;
      } else if (currentUrl) {
        managed.meta.title = shortTitleFromUrl(currentUrl);
      }
      managed.meta.isLoading = wc.isLoading();
      managed.meta.canGoBack = wc.navigationHistory.canGoBack();
      managed.meta.canGoForward = wc.navigationHistory.canGoForward();

      const persistentChanged =
        managed.meta.url !== prevUrl || managed.meta.title !== prevTitle;
      const transientChanged =
        managed.meta.isLoading !== prevLoading ||
        managed.meta.canGoBack !== prevCanGoBack ||
        managed.meta.canGoForward !== prevCanGoForward;

      if (persistentChanged) {
        this.onTabsChanged("persistent");
      } else if (transientChanged) {
        this.onTabsChanged("transient");
      }
    };

    wc.on("did-start-loading", () => {
      if (!managed.meta.isLoading) {
        managed.meta.isLoading = true;
        this.onTabsChanged("transient");
      }
    });
    wc.on("did-stop-loading", syncMeta);
    wc.on("did-navigate", () => {
      const hadErrors =
        managed.meta.consoleErrorCount > 0 || managed.meta.networkErrorCount > 0;
      managed.consoleEntries = [];
      managed.networkErrors = [];
      managed.meta.consoleErrorCount = 0;
      managed.meta.networkErrorCount = 0;
      syncMeta();
      if (hadErrors) {
        this.onTabsChanged("transient");
      }
      this.ensureDebugger(managed);
    });
    wc.on("did-navigate-in-page", syncMeta);
    wc.on("page-title-updated", syncMeta);

    // Intercept Orca-style picker console message cleanly
    wc.on("console-message", (_event, _level, message) => {
      if (!message.startsWith(PICKER_PREFIX)) return;
      const jsonStr = message.slice(PICKER_PREFIX.length);
      if (this.pickingElement) {
        this.pickingElement = false;
        this.onTabsChanged("transient");
      }
      try {
        const parsed = JSON.parse(jsonStr) as {
          type?: string;
          selector?: string;
          tagName?: string;
          textSnippet?: string;
          outerHTMLSnippet?: string;
          pageURL?: string;
          pageTitle?: string;
          rect?: { x: number; y: number; width: number; height: number };
          stylesSummary?: string;
        };
        if (parsed.type !== "picked") return;
        void this.handlePickedElement(managed, parsed);
      } catch {
        // ignore
      }
    });

    this.ensureDebugger(managed);
  }

  private async handlePickedElement(
    managed: ManagedTab,
    payload: {
      selector?: string;
      tagName?: string;
      textSnippet?: string;
      outerHTMLSnippet?: string;
      pageURL?: string;
      pageTitle?: string;
      rect?: { x: number; y: number; width: number; height: number };
      stylesSummary?: string;
    },
  ): Promise<void> {
    let imagePath: string | undefined;
    let imageDataUrl: string | undefined;
    try {
      const r = payload.rect;
      const cropRect =
        r && r.width > 4 && r.height > 4
          ? {
              x: Math.max(0, Math.round(r.x - 16)),
              y: Math.max(0, Math.round(r.y - 16)),
              width: Math.max(16, Math.round(r.width + 32)),
              height: Math.max(16, Math.round(r.height + 32)),
            }
          : undefined;
      const img = await managed.view.webContents.capturePage(cropRect);
      const png = img.toPNG();
      if (png.length > 0) {
        const saved = this.store.savePngBuffer(png, "element");
        imagePath = saved.imagePath;
        imageDataUrl = saved.imageDataUrl;
      }
    } catch {
      // screenshot optional
    }

    const selector = payload.selector ?? "element";
    const tagName = payload.tagName ?? "div";
    const meta = [
      "[Browser Element Picked]",
      `Page: ${payload.pageTitle ?? ""} (${payload.pageURL ?? managed.meta.url})`,
      `Selector: ${selector}`,
      `Tag: <${tagName}>`,
      `Text: ${payload.textSnippet ?? ""}`,
      `Styles: ${payload.stylesSummary ?? ""}`,
      "HTML:",
      "```html",
      payload.outerHTMLSnippet ?? "",
      "```",
    ].join("\n");

    this.onElementPicked({
      id: crypto.randomUUID(),
      kind: "browserElement",
      label: `<${tagName}> ${selector.slice(0, 26)}`,
      imagePath,
      imageDataUrl,
      url: payload.pageURL ?? managed.meta.url,
      metadataText: meta,
    });
  }

  private ensureDebugger(managed: ManagedTab): void {
    const dbg = managed.view.webContents.debugger;
    if (managed.debuggerAttached && dbg.isAttached()) return;
    try {
      if (!dbg.isAttached()) {
        dbg.attach("1.3");
      }
      managed.debuggerAttached = true;
      void dbg.sendCommand("Runtime.enable").catch(() => {});
      void dbg.sendCommand("Network.enable").catch(() => {});

      dbg.removeAllListeners("message");
      dbg.on("message", (_event, method, params: Record<string, unknown>) => {
        this.handleCDPMessage(managed, method, params);
      });
      dbg.once("detach", () => {
        managed.debuggerAttached = false;
      });
    } catch {
      managed.debuggerAttached = false;
    }
  }

  private handleCDPMessage(
    managed: ManagedTab,
    method: string,
    params: Record<string, unknown>,
  ): void {
    if (method === "Runtime.consoleAPICalled") {
      const type = String(params.type ?? "log");
      if (type !== "error" && type !== "warning") return;
      const args = Array.isArray(params.args) ? params.args : [];
      const text = args
        .map((a) => {
          const rec = a as Record<string, unknown>;
          if (typeof rec.value === "string") return rec.value;
          if (typeof rec.description === "string") return rec.description;
          return JSON.stringify(rec.value ?? "");
        })
        .join(" ")
        .slice(0, 600);
      if (text.startsWith(PICKER_PREFIX)) return;

      managed.consoleEntries.push({
        id: crypto.randomUUID(),
        level: type === "error" ? "error" : "warning",
        text,
        timestamp: new Date().toISOString(),
      });
      if (managed.consoleEntries.length > 60) {
        managed.consoleEntries.splice(0, managed.consoleEntries.length - 60);
      }
      if (type === "error") {
        const nextCount = managed.consoleEntries.filter((e) => e.level === "error").length;
        if (nextCount !== managed.meta.consoleErrorCount) {
          managed.meta.consoleErrorCount = nextCount;
          this.onTabsChanged("transient");
        }
      }
      return;
    }

    if (method === "Runtime.exceptionThrown") {
      const details = (params.exceptionDetails ?? {}) as Record<string, unknown>;
      const exception = (details.exception ?? {}) as Record<string, unknown>;
      const text = String(exception.description ?? details.text ?? "Uncaught exception").slice(0, 600);
      managed.consoleEntries.push({
        id: crypto.randomUUID(),
        level: "error",
        text,
        source: typeof details.url === "string" ? details.url : undefined,
        line: typeof details.lineNumber === "number" ? details.lineNumber : undefined,
        timestamp: new Date().toISOString(),
      });
      if (managed.consoleEntries.length > 60) {
        managed.consoleEntries.splice(0, managed.consoleEntries.length - 60);
      }
      const nextCount = managed.consoleEntries.filter((e) => e.level === "error").length;
      if (nextCount !== managed.meta.consoleErrorCount) {
        managed.meta.consoleErrorCount = nextCount;
        this.onTabsChanged("transient");
      }
      return;
    }

    if (method === "Network.requestWillBeSent") {
      const reqId = String(params.requestId ?? "");
      const req = (params.request ?? {}) as Record<string, unknown>;
      if (reqId && typeof req.url === "string") {
        managed.requestMeta.set(reqId, {
          url: req.url,
          method: String(req.method ?? "GET"),
        });
        if (managed.requestMeta.size > 300) {
          const firstKey = managed.requestMeta.keys().next().value;
          if (firstKey) managed.requestMeta.delete(firstKey);
        }
      }
      return;
    }

    if (method === "Network.responseReceived") {
      const response = (params.response ?? {}) as Record<string, unknown>;
      const status = typeof response.status === "number" ? response.status : 0;
      if (status >= 400) {
        const reqId = String(params.requestId ?? "");
        const reqInfo = managed.requestMeta.get(reqId);
        managed.networkErrors.push({
          id: crypto.randomUUID(),
          url: String(response.url ?? reqInfo?.url ?? ""),
          method: reqInfo?.method ?? "GET",
          status,
          errorText: String(response.statusText ?? `HTTP ${status}`),
          timestamp: new Date().toISOString(),
        });
        if (managed.networkErrors.length > 50) {
          managed.networkErrors.splice(0, managed.networkErrors.length - 50);
        }
        const nextCount = managed.networkErrors.length;
        if (nextCount !== managed.meta.networkErrorCount) {
          managed.meta.networkErrorCount = nextCount;
          this.onTabsChanged("transient");
        }
      }
      return;
    }

    if (method === "Network.loadingFailed") {
      if (params.canceled === true) return;
      const reqId = String(params.requestId ?? "");
      const reqInfo = managed.requestMeta.get(reqId);
      managed.networkErrors.push({
        id: crypto.randomUUID(),
        url: reqInfo?.url ?? "",
        method: reqInfo?.method ?? "GET",
        status: null,
        errorText: String(params.errorText ?? "Network error"),
        timestamp: new Date().toISOString(),
      });
      if (managed.networkErrors.length > 50) {
        managed.networkErrors.splice(0, managed.networkErrors.length - 50);
      }
      const nextCount = managed.networkErrors.length;
      if (nextCount !== managed.meta.networkErrorCount) {
        managed.meta.networkErrorCount = nextCount;
        this.onTabsChanged("transient");
      }
    }
  }

  private async locateAndScrollTarget(
    managed: ManagedTab,
    target: string,
  ): Promise<{ x: number; y: number; tag: string; text: string }> {
    const isRef = /^e\d+$/.test(target.trim());
    const escapedTarget = JSON.stringify(target.trim());
    const script = `
      (() => {
        const target = ${escapedTarget};
        const el = ${isRef}
          ? document.querySelector('[data-conductor-ref="' + target + '"]')
          : document.querySelector(target);
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        const r = el.getBoundingClientRect();
        return {
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          tag: el.tagName.toLowerCase(),
          text: (el.innerText || el.value || '').trim().slice(0, 80)
        };
      })()
    `;
    const pt = (await managed.view.webContents.executeJavaScript(script, true)) as {
      x: number;
      y: number;
      tag: string;
      text: string;
    } | null;
    if (!pt) {
      throw new Error(`Element not found for target: ${target}. Run browser_snapshot first to inspect refs.`);
    }
    return pt;
  }
}
