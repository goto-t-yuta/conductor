import path from "node:path";
import { pathToFileURL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  installMainWindowNavigationGuard,
  isAllowedMainWindowNavigation,
  isLocalHtmlFileUrl,
  shouldRouteBlockedUrlToInAppBrowser,
  type MainWindowNavigationEventLike,
  type MainWindowWebContentsLike,
} from "../src/main/main-window-guard.js";
import { shortTitleFromUrl } from "../src/main/shell-env.js";
import {
  handleMarkdownLinkClick,
  MarkdownView,
} from "../src/renderer/components/MarkdownView.js";
import { TaskInspectorModal } from "../src/renderer/components/TaskInspectorModal.js";
import { TaskEventCard } from "../src/renderer/components/UnifiedChat.js";
import { MarkdownImageCache } from "../src/renderer/lib/markdown-image-cache.js";
import {
  classifyLinkHref,
  isHtmlPathOrUrl,
  isImagePathOrUrl,
} from "../src/renderer/lib/markdown-utils.js";
import { t } from "../src/shared/i18n.js";
import type { AgentTask, ChatMessage } from "../src/shared/types.js";

describe("Local file:// link classification (markdown-utils)", () => {
  it("classifies local .html and .htm file:// URLs (with query, hash, spaces, and Japanese) as localHtml", () => {
    expect(isHtmlPathOrUrl("file:///Users/me/report.html")).toBe(true);
    expect(isHtmlPathOrUrl("file:///Users/me/REPORT.HTM#summary?tab=2")).toBe(true);
    expect(isHtmlPathOrUrl("file:///Users/me/report.md")).toBe(false);
    expect(isHtmlPathOrUrl("file:///Users/me/report.html.bak")).toBe(false);

    expect(classifyLinkHref("file:///Users/me/report.html")).toEqual({
      kind: "localHtml",
      url: "file:///Users/me/report.html",
      filePath: "/Users/me/report.html",
    });

    expect(classifyLinkHref("file:///Users/me/legacy.htm?v=1#chart")).toEqual({
      kind: "localHtml",
      url: "file:///Users/me/legacy.htm?v=1#chart",
      filePath: "/Users/me/legacy.htm",
    });

    expect(
      classifyLinkHref("file:///Users/me/Application%20Support/%E3%83%AC%E3%83%9D%E3%83%BC%E3%83%88.HTML"),
    ).toEqual({
      kind: "localHtml",
      url: "file:///Users/me/Application%20Support/%E3%83%AC%E3%83%9D%E3%83%BC%E3%83%88.HTML",
      filePath: "/Users/me/Application Support/レポート.HTML",
    });

    // Unencoded spaces inside angle-bracketed file:// URLs get safely percent-encoded
    expect(classifyLinkHref("file:///Users/me/my folder/report.html")).toEqual({
      kind: "localHtml",
      url: "file:///Users/me/my%20folder/report.html",
      filePath: "/Users/me/my folder/report.html",
    });

    // Relative and absolute local .html paths resolve cleanly into file:// URLs
    expect(classifyLinkHref("./out/report.html#top", "/Users/me/work/README.md")).toEqual({
      kind: "localHtml",
      url: "file:///Users/me/work/out/report.html#top",
      filePath: "/Users/me/work/out/report.html",
    });
    expect(classifyLinkHref("/Users/me/work/summary.htm")).toEqual({
      kind: "localHtml",
      url: "file:///Users/me/work/summary.htm",
      filePath: "/Users/me/work/summary.htm",
    });
  });

  it("classifies local image file:// URLs and paths as image while preserving .md and other file:// classification", () => {
    expect(isImagePathOrUrl("file:///Users/me/shot.png")).toBe(true);
    expect(isImagePathOrUrl("file:///Users/me/photo.JPEG?raw=1")).toBe(true);
    expect(isImagePathOrUrl("file:///Users/me/diagram.svg#layer1")).toBe(true);
    expect(isImagePathOrUrl("file:///Users/me/report.html")).toBe(false);

    expect(classifyLinkHref("file:///Users/me/my%20shots/ui.png")).toEqual({
      kind: "image",
      target: "file:///Users/me/my%20shots/ui.png",
      resolvedPath: "/Users/me/my shots/ui.png",
    });

    expect(classifyLinkHref("./shots/after.webp", "/Users/me/repo/README.md")).toEqual({
      kind: "image",
      target: "./shots/after.webp",
      baseFilePath: "/Users/me/repo/README.md",
      resolvedPath: "/Users/me/repo/shots/after.webp",
    });

    expect(classifyLinkHref("file:///Users/me/notes.md#L10")).toEqual({
      kind: "markdown",
      target: "file:///Users/me/notes.md#L10",
      hash: "L10",
    });

    expect(classifyLinkHref("https://example.com/report.html")).toEqual({
      kind: "web",
      url: "https://example.com/report.html",
    });

    expect(classifyLinkHref("file:///Users/me/src/index.ts#L10-L20")).toEqual({
      kind: "other",
      href: "file:///Users/me/src/index.ts#L10-L20",
    });
  });

  it("formats local file:// URL tab titles cleanly with shortTitleFromUrl", () => {
    expect(shortTitleFromUrl("file:///Users/me/reports/pv-surplus%20report.html")).toBe(
      "pv-surplus report.html",
    );
    expect(shortTitleFromUrl("http://localhost:5173/dashboard")).toBe("localhost:5173");
    expect(shortTitleFromUrl("https://example.com/docs")).toBe("example.com");
  });
});

describe("MarkdownView link click handling (handleMarkdownLinkClick & rendering)", () => {
  it("prevents default navigation and routes file:// .html/.htm links to onOpenUrl (right-pane In-App Browser)", () => {
    const preventDefault = vi.fn();
    const onOpenUrl = vi.fn();
    const onOpenMarkdownFile = vi.fn();
    const onOpenImage = vi.fn();

    const result = handleMarkdownLinkClick(
      { preventDefault },
      {
        href: "file:///Users/dev/reports/surplus-analysis.html#chart-1",
        linkText: "surplus-analysis.html",
        onOpenUrl,
        onOpenMarkdownFile,
        onOpenImage,
      },
    );

    expect(result.kind).toBe("localHtml");
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onOpenUrl).toHaveBeenCalledWith("file:///Users/dev/reports/surplus-analysis.html#chart-1");
    expect(onOpenMarkdownFile).not.toHaveBeenCalled();
    expect(onOpenImage).not.toHaveBeenCalled();

    // Also handles .htm links
    preventDefault.mockClear();
    onOpenUrl.mockClear();
    const htmResult = handleMarkdownLinkClick(
      { preventDefault },
      {
        href: "file:///Users/dev/reports/index.htm",
        onOpenUrl,
        onOpenMarkdownFile,
        onOpenImage,
      },
    );
    expect(htmResult.kind).toBe("localHtml");
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onOpenUrl).toHaveBeenCalledWith("file:///Users/dev/reports/index.htm");
  });

  it("routes file:// .md links to Markdown Viewer and file:// image links to Lightbox / Image Viewer", () => {
    const preventDefault = vi.fn();
    const onOpenUrl = vi.fn();
    const onOpenMarkdownFile = vi.fn();
    const onOpenImage = vi.fn();
    const imageCache = new MarkdownImageCache();
    imageCache.set("/Users/dev/shots/cached.png", {
      dataUrl: "data:image/png;base64,CACHED",
      filePath: "/Users/dev/shots/cached.png",
    });

    // .md file:// link
    handleMarkdownLinkClick(
      { preventDefault },
      {
        href: "file:///Users/dev/docs/spec.md#api",
        onOpenUrl,
        onOpenMarkdownFile,
        onOpenImage,
      },
    );
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onOpenMarkdownFile).toHaveBeenCalledWith("file:///Users/dev/docs/spec.md#api", undefined);
    expect(onOpenUrl).not.toHaveBeenCalled();

    // Cached image file:// link
    preventDefault.mockClear();
    handleMarkdownLinkClick(
      { preventDefault },
      {
        href: "file:///Users/dev/shots/cached.png",
        linkText: "Cached Preview",
        onOpenUrl,
        onOpenMarkdownFile,
        onOpenImage,
        imageCache,
      },
    );
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onOpenImage).toHaveBeenCalledWith({
      src: "data:image/png;base64,CACHED",
      alt: "Cached Preview",
      filePath: "/Users/dev/shots/cached.png",
    });
    expect(onOpenUrl).not.toHaveBeenCalled();

    // Uncached image file:// link passes resolved local path for disk load into Lightbox
    preventDefault.mockClear();
    onOpenImage.mockClear();
    handleMarkdownLinkClick(
      { preventDefault },
      {
        href: "file:///Users/dev/my%20shots/screen.png",
        linkText: "Screen Capture",
        onOpenUrl,
        onOpenMarkdownFile,
        onOpenImage,
        imageCache,
      },
    );
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onOpenImage).toHaveBeenCalledWith({
      src: "/Users/dev/my shots/screen.png",
      alt: "Screen Capture",
      filePath: "/Users/dev/my shots/screen.png",
    });
  });

  it("always prevents default navigation for unhandled file:// and relative links so the main window never navigates away", () => {
    const onOpenUrl = vi.fn();
    const onOpenMarkdownFile = vi.fn();
    const onOpenImage = vi.fn();

    for (const href of [
      "file:///Users/dev/src/index.ts#L10-L20",
      "file:///Users/dev/archive.pdf",
      "src/main/index.ts",
      "file:///Users/dev/README.md", // even when onOpenMarkdownFile is omitted
      "file:///Users/dev/pic.png", // even when onOpenImage is omitted
    ]) {
      const preventDefault = vi.fn();
      handleMarkdownLinkClick(
        { preventDefault },
        {
          href,
          onOpenUrl,
        },
      );
      expect(preventDefault, `expected preventDefault() for ${href}`).toHaveBeenCalledTimes(1);
    }

    expect(onOpenUrl).not.toHaveBeenCalled();
    expect(onOpenMarkdownFile).not.toHaveBeenCalled();
    expect(onOpenImage).not.toHaveBeenCalled();

    // mailto: is allowed through without blocking OS handler
    const mailtoPrevent = vi.fn();
    handleMarkdownLinkClick(
      { preventDefault: mailtoPrevent },
      { href: "mailto:dev@example.com", onOpenUrl },
    );
    expect(mailtoPrevent).not.toHaveBeenCalled();
  });

  it("renders local .html, .md, and image file:// links cleanly with localized tooltips in MarkdownView, TaskEventCard, and TaskInspectorModal", () => {
    const md = [
      "- [分析レポート](file:///Users/dev/reports/report.html)",
      "- [仕様書](file:///Users/dev/docs/spec.md)",
      "- [スクリーンショット](file:///Users/dev/shots/ui.png)",
    ].join("\n");

    const jaHtml = renderToStaticMarkup(
      <MarkdownView
        content={md}
        locale="ja"
        onOpenUrl={vi.fn()}
        onOpenMarkdownFile={vi.fn()}
        onOpenImage={vi.fn()}
      />,
    );
    expect(jaHtml).toContain('href="file:///Users/dev/reports/report.html"');
    expect(jaHtml).toContain(`title="${t("ja", "markdown.openHtmlInBrowserTitle")}"`);
    expect(jaHtml).toContain(`title="${t("ja", "markdown.openInViewerTitle")}"`);
    expect(jaHtml).toContain(`title="${t("ja", "markdown.imageZoomTitle")}"`);

    const enHtml = renderToStaticMarkup(
      <MarkdownView
        content={md}
        locale="en"
        onOpenUrl={vi.fn()}
        onOpenMarkdownFile={vi.fn()}
        onOpenImage={vi.fn()}
      />,
    );
    expect(enHtml).toContain(`title="${t("en", "markdown.openHtmlInBrowserTitle")}"`);

    const sampleTask: AgentTask = {
      id: "task-html-1",
      taskNumber: 42,
      title: "Generate HTML report",
      summary: "Built standalone HTML report.",
      projectId: "proj-1",
      projectName: "conductor",
      projectPath: "/Users/dev/conductor",
      status: "needs_review",
      provider: "agy",
      currentStep: null,
      workerThreadId: null,
      activeTurnId: null,
      previewURL: null,
      latestOutput: "完了しました: [report.html](file:///Users/dev/reports/report.html)",
      activities: [],
      createdAt: "2026-11-27T00:00:00.000Z",
      updatedAt: "2026-11-27T00:05:00.000Z",
    };

    const taskMsg: ChatMessage = {
      id: "msg-html-1",
      role: "taskEvent",
      relatedTaskId: sampleTask.id,
      text: sampleTask.latestOutput,
      attachments: [],
      toolChips: [],
      isStreaming: false,
      createdAt: "2026-11-27T00:05:00.000Z",
    };

    const cardHtml = renderToStaticMarkup(
      <TaskEventCard
        message={taskMsg}
        tasks={[sampleTask]}
        locale="ja"
        onOpenUrl={vi.fn()}
        onOpenMarkdownFile={vi.fn()}
        onOpenImage={vi.fn()}
        onOpenTask={vi.fn()}
      />,
    );
    expect(cardHtml).toContain('href="file:///Users/dev/reports/report.html"');
    expect(cardHtml).toContain(`title="${t("ja", "markdown.openHtmlInBrowserTitle")}"`);

    const inspectorHtml = renderToStaticMarkup(
      <TaskInspectorModal
        task={sampleTask}
        projectColorHex="#6366F1"
        locale="ja"
        onClose={vi.fn()}
        onUpdateStatus={vi.fn()}
        onOpenPreviewUrl={vi.fn()}
        onOpenMarkdownFile={vi.fn()}
        onOpenImage={vi.fn()}
        onMentionInChat={vi.fn()}
        onStopWorker={vi.fn()}
      />,
    );
    expect(inspectorHtml).toContain('href="file:///Users/dev/reports/report.html"');
    expect(inspectorHtml).toContain(`title="${t("ja", "markdown.openHtmlInBrowserTitle")}"`);
  });
});

describe("Electron MainWindow navigation guard (src/main/main-window-guard.ts)", () => {
  function createMockWebContents() {
    const listeners = new Map<
      "will-navigate" | "will-redirect",
      Array<(event: MainWindowNavigationEventLike, url: string) => void>
    >();
    let windowOpenHandler: ((details: { url: string }) => { action: "allow" | "deny" }) | null =
      null;

    const webContents: MainWindowWebContentsLike = {
      on(event, listener) {
        const list = listeners.get(event) ?? [];
        list.push(listener);
        listeners.set(event, list);
      },
      setWindowOpenHandler(handler) {
        windowOpenHandler = handler;
      },
    };

    return {
      webContents,
      emit(event: "will-navigate" | "will-redirect", url: string) {
        const preventDefault = vi.fn();
        for (const fn of listeners.get(event) ?? []) {
          fn({ preventDefault }, url);
        }
        return { preventDefault };
      },
      openWindow(url: string) {
        if (!windowOpenHandler) {
          throw new Error("setWindowOpenHandler was not registered");
        }
        return windowOpenHandler({ url });
      },
    };
  }

  it("identifies local .html/.htm file:// URLs accurately", () => {
    expect(isLocalHtmlFileUrl("file:///Users/dev/report.html")).toBe(true);
    expect(isLocalHtmlFileUrl("file:///Users/dev/report.HTM?a=1#top")).toBe(true);
    expect(isLocalHtmlFileUrl("file:///Users/dev/my%20report.html")).toBe(true);
    expect(isLocalHtmlFileUrl("file:///Users/dev/README.md")).toBe(false);
    expect(isLocalHtmlFileUrl("file:///Users/dev/shot.png")).toBe(false);
    expect(isLocalHtmlFileUrl("https://example.com/report.html")).toBe(false);
    expect(isLocalHtmlFileUrl("javascript:alert(1)")).toBe(false);
  });

  it("blocks file:// report.html and external URLs in production mode while allowing only the app renderer index.html", () => {
    const rendererHtmlPath = path.resolve("/Applications/Conductor.app/dist/renderer/index.html");
    const appEntryFileUrl = pathToFileURL(rendererHtmlPath).toString();
    const target = { rendererHtmlPath };

    // Only the exact app entry index.html (with optional query/hash) is allowed
    expect(isAllowedMainWindowNavigation(appEntryFileUrl, target)).toBe(true);
    expect(isAllowedMainWindowNavigation(`${appEntryFileUrl}#section`, target)).toBe(true);
    expect(isAllowedMainWindowNavigation(`${appEntryFileUrl}?reload=1`, target)).toBe(true);

    // Any other file:// URL (including another HTML file!) or external URL is blocked
    expect(isAllowedMainWindowNavigation("file:///Users/dev/report.html", target)).toBe(false);
    expect(
      isAllowedMainWindowNavigation(
        "file:///Applications/Conductor.app/dist/renderer/other.html",
        target,
      ),
    ).toBe(false);
    expect(isAllowedMainWindowNavigation("file:///Users/dev/index.html", target)).toBe(false);
    expect(isAllowedMainWindowNavigation("file:///Users/dev/shot.png", target)).toBe(false);
    expect(isAllowedMainWindowNavigation("https://example.com", target)).toBe(false);
    expect(isAllowedMainWindowNavigation("http://localhost:3000", target)).toBe(false);
    expect(isAllowedMainWindowNavigation("javascript:alert(1)", target)).toBe(false);
    expect(isAllowedMainWindowNavigation("data:text/html,<h1>x</h1>", target)).toBe(false);

    // Routing eligibility
    expect(shouldRouteBlockedUrlToInAppBrowser("file:///Users/dev/report.html", target)).toBe(true);
    expect(shouldRouteBlockedUrlToInAppBrowser("https://example.com", target)).toBe(true);
    expect(shouldRouteBlockedUrlToInAppBrowser(appEntryFileUrl, target)).toBe(false);
    expect(shouldRouteBlockedUrlToInAppBrowser("file:///Users/dev/secret.txt", target)).toBe(false);
    expect(shouldRouteBlockedUrlToInAppBrowser("javascript:alert(1)", target)).toBe(false);

    const mock = createMockWebContents();
    const onOpenInAppBrowser = vi.fn();
    installMainWindowNavigationGuard(mock.webContents, {
      rendererHtmlPath,
      onOpenInAppBrowser,
    });

    // App entry reload is allowed
    const allowedNav = mock.emit("will-navigate", appEntryFileUrl);
    expect(allowedNav.preventDefault).not.toHaveBeenCalled();
    expect(onOpenInAppBrowser).not.toHaveBeenCalled();

    // Accidental navigation to local report.html is prevented AND forwarded to In-App Browser
    const localHtmlNav = mock.emit("will-navigate", "file:///Users/dev/report.html");
    expect(localHtmlNav.preventDefault).toHaveBeenCalledTimes(1);
    expect(onOpenInAppBrowser).toHaveBeenCalledWith("file:///Users/dev/report.html");

    // Accidental navigation to external URL is prevented AND forwarded to In-App Browser
    onOpenInAppBrowser.mockClear();
    const externalNav = mock.emit("will-navigate", "https://example.com/docs");
    expect(externalNav.preventDefault).toHaveBeenCalledTimes(1);
    expect(onOpenInAppBrowser).toHaveBeenCalledWith("https://example.com/docs");

    // Accidental navigation to non-HTML local file is prevented and NOT opened in browser
    onOpenInAppBrowser.mockClear();
    const nonHtmlNav = mock.emit("will-navigate", "file:///Users/dev/index.ts");
    expect(nonHtmlNav.preventDefault).toHaveBeenCalledTimes(1);
    expect(onOpenInAppBrowser).not.toHaveBeenCalled();

    // will-redirect to external or local HTML is also blocked
    const redirectEv = mock.emit("will-redirect", "file:///Users/dev/report.html");
    expect(redirectEv.preventDefault).toHaveBeenCalledTimes(1);

    // setWindowOpenHandler ALWAYS denies new Electron windows and routes HTML/HTTP(S) to In-App Browser
    onOpenInAppBrowser.mockClear();
    expect(mock.openWindow("file:///Users/dev/report.html")).toEqual({ action: "deny" });
    expect(onOpenInAppBrowser).toHaveBeenCalledWith("file:///Users/dev/report.html");

    onOpenInAppBrowser.mockClear();
    expect(mock.openWindow("https://example.com/new")).toEqual({ action: "deny" });
    expect(onOpenInAppBrowser).toHaveBeenCalledWith("https://example.com/new");

    onOpenInAppBrowser.mockClear();
    expect(mock.openWindow("file:///Users/dev/secret.env")).toEqual({ action: "deny" });
    expect(onOpenInAppBrowser).not.toHaveBeenCalled();
  });

  it("blocks file:// and cross-origin URLs in dev mode while allowing same-origin Vite dev server URLs", () => {
    const devServerUrl = "http://localhost:5179";
    const mock = createMockWebContents();
    const onOpenInAppBrowser = vi.fn();

    installMainWindowNavigationGuard(mock.webContents, {
      devServerUrl,
      rendererHtmlPath: "/unused/index.html",
      onOpenInAppBrowser,
    });

    // Same-origin dev server URLs are allowed
    expect(mock.emit("will-navigate", "http://localhost:5179/").preventDefault).not.toHaveBeenCalled();
    expect(
      mock.emit("will-navigate", "http://localhost:5179/index.html?t=123").preventDefault,
    ).not.toHaveBeenCalled();

    // Different localhost port is blocked and routed to In-App Browser
    const otherPort = mock.emit("will-navigate", "http://localhost:3000/");
    expect(otherPort.preventDefault).toHaveBeenCalledTimes(1);
    expect(onOpenInAppBrowser).toHaveBeenCalledWith("http://localhost:3000/");

    // file:// .html is blocked and routed to In-App Browser
    onOpenInAppBrowser.mockClear();
    const fileHtml = mock.emit("will-navigate", "file:///tmp/report.html");
    expect(fileHtml.preventDefault).toHaveBeenCalledTimes(1);
    expect(onOpenInAppBrowser).toHaveBeenCalledWith("file:///tmp/report.html");
  });
});
