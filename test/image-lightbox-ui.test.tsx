import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChatComposer } from "../src/renderer/components/ChatComposer.js";
import { ImageLightboxModal } from "../src/renderer/components/ImageLightboxModal.js";
import { ImageViewerPane } from "../src/renderer/components/ImageViewerPane.js";
import { TaskInspectorModal } from "../src/renderer/components/TaskInspectorModal.js";
import { UnifiedChat } from "../src/renderer/components/UnifiedChat.js";
import {
  buildAttachmentFromMarkdownImage,
  buildImageTabFromAttachment,
  computeDragPanScroll,
  computeWheelZoomUpdate,
  extractImageFileName,
  formatZoomLabel,
  isImageOverflowingViewport,
  MAX_ZOOM,
  mergeLoadedImageIntoAttachment,
  MIN_ZOOM,
  resolveImageZoomCursorClass,
  shouldDismissLightboxOnBackdropClick,
  stepZoom,
  type ImageViewerTab,
} from "../src/renderer/lib/image-viewer.js";
import { t } from "../src/shared/i18n.js";
import type { AgentTask, AppSnapshot, ChatAttachment, ChatMessage, Project } from "../src/shared/types.js";

const JAPANESE_CHAR_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;

const SAMPLE_PROJECT: Project = {
  id: "proj-1",
  name: "conductor",
  path: "/workspace/conductor",
  colorHex: "#6366F1",
  gitBranch: "main",
  addedAt: "2026-11-27T00:00:00.000Z",
};

const SAMPLE_TASK: AgentTask = {
  id: "task-1",
  taskNumber: 1,
  title: "Verify image lightbox preview",
  summary: "Added centered lightbox with open-in-right-pane button.",
  projectId: SAMPLE_PROJECT.id,
  projectName: SAMPLE_PROJECT.name,
  projectPath: SAMPLE_PROJECT.path,
  status: "needs_review",
  provider: "agy",
  currentStep: null,
  workerThreadId: null,
  activeTurnId: null,
  previewURL: null,
  latestOutput: "![Updated UI](https://example.com/updated-ui.png)",
  activities: [],
  createdAt: "2026-11-27T00:00:00.000Z",
  updatedAt: "2026-11-27T00:05:00.000Z",
};

function makeSnapshot(messages: ChatMessage[]): AppSnapshot {
  return {
    projects: [SAMPLE_PROJECT],
    scanRoots: [],
    tasks: [SAMPLE_TASK],
    messages,
    activeChatSessionId: "sess-1",
    chatSessions: [
      {
        id: "sess-1",
        title: "Lightbox test",
        preview: "",
        messageCount: messages.length,
        createdAt: "2026-11-27T00:00:00.000Z",
        updatedAt: "2026-11-27T00:05:00.000Z",
      },
    ],
    browserTabs: [],
    activeBrowserTabId: null,
    isPickingElement: false,
    showTaskSidebar: true,
    showBrowserPane: false,
    isConnected: true,
    connectionStatus: "Codex ready",
    activeResponderCount: 0,
    providers: {
      codex: { id: "codex", label: "Codex", available: true, detail: "ok", models: [] },
      agy: { id: "agy", label: "AGY", available: true, detail: "ok", models: [] },
      claude: { id: "claude", label: "Claude", available: true, detail: "ok", models: [] },
    },
    chatProvider: "codex",
    workerProvider: "agy",
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

describe("Image lightbox helpers (src/renderer/lib/image-viewer.ts)", () => {
  it("ignores data: and blob: URLs in extractImageFileName while preserving local and http filenames", () => {
    expect(extractImageFileName("data:image/png;base64,iVBORw0KGgo=")).toBeNull();
    expect(extractImageFileName("blob:http://localhost:5179/abc-123")).toBeNull();
    expect(extractImageFileName("/tmp/screenshots/result-view.png")).toBe("result-view.png");
    expect(extractImageFileName("https://example.com/assets/hero%20banner.webp?v=2")).toBe(
      "hero banner.webp",
    );
  });

  it("builds attachments from Markdown images and merges disk-loaded data URLs when handing off to the right pane", () => {
    const fromMarkdown = buildAttachmentFromMarkdownImage({
      src: "data:image/png;base64,INLINE",
      alt: "UI キャプチャ",
      filePath: "/Users/dev/shots/ui-capture.png",
    });
    expect(fromMarkdown).toEqual({
      id: "md-image:/Users/dev/shots/ui-capture.png",
      kind: "image",
      label: "UI キャプチャ",
      imagePath: "/Users/dev/shots/ui-capture.png",
      imageDataUrl: "data:image/png;base64,INLINE",
    });

    const fallbackLabel = buildAttachmentFromMarkdownImage({
      src: "https://example.com/shots/preview.png",
    });
    expect(fallbackLabel.label).toBe("preview.png");

    // Inline data URL attachment without imagePath should not leak base64 into fileName
    const inlineOnly = buildImageTabFromAttachment({
      id: "att-inline",
      kind: "image",
      label: "Pasted Image",
      imageDataUrl: "data:image/png;base64,AAAA/BBBB",
    });
    expect(inlineOnly.tab.fileName).toBeNull();
    expect(inlineOnly.tab.label).toBe("Pasted Image");

    // Merging loaded lightbox data URL into a path-only attachment avoids reloading in the right pane
    const pathOnlyAttachment: ChatAttachment = {
      id: "att-disk",
      kind: "image",
      label: "diagram.png",
      imagePath: "/tmp/diagram.png",
    };
    const merged = mergeLoadedImageIntoAttachment(pathOnlyAttachment, {
      label: "diagram.png",
      src: "data:image/png;base64,DISK_LOADED",
      imagePath: "/private/tmp/diagram.png",
    });
    expect(merged.imageDataUrl).toBe("data:image/png;base64,DISK_LOADED");
    expect(merged.imagePath).toBe("/private/tmp/diagram.png");
  });
});

describe("ImageLightboxModal UI", () => {
  const sampleImage: ImageViewerTab = {
    id: "img-1",
    label: "更新後のダッシュボード",
    fileName: "dashboard-after.png",
    src: "data:image/png;base64,iVBORw0KGgo=",
    imagePath: "/Users/dev/conductor/shots/dashboard-after.png",
    sourceUrl: "http://localhost:5173/dashboard",
    isLoading: false,
    error: null,
  };

  it("renders centered modal with caption, filename, Open in Right Pane button, close button, and image in Japanese", () => {
    const html = renderToStaticMarkup(
      <ImageLightboxModal
        image={sampleImage}
        locale="ja"
        onClose={vi.fn()}
        onOpenInRightPane={vi.fn()}
        onOpenUrl={vi.fn()}
        onRevealInFinder={vi.fn()}
      />,
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('data-testid="image-lightbox-modal"');
    expect(html).toContain('data-testid="image-lightbox-title"');
    expect(html).toContain("更新後のダッシュボード");
    expect(html).toContain('data-testid="image-lightbox-filename"');
    expect(html).toContain("dashboard-after.png");
    expect(html).toContain('data-testid="image-lightbox-open-right-pane"');
    expect(html).toContain(t("ja", "image.lightboxOpenInRightPane"));
    expect(html).toContain('data-testid="image-lightbox-close"');
    expect(html).toContain('data-testid="image-lightbox-zoom-controls"');
    expect(html).toContain('data-testid="image-lightbox-fit"');
    expect(html).toContain('data-testid="image-lightbox-actual-size"');
    expect(html).toContain('data-testid="image-lightbox-zoom-out"');
    expect(html).toContain('data-testid="image-lightbox-zoom-label"');
    expect(html).toContain('data-testid="image-lightbox-zoom-in"');
    expect(html).toContain('data-testid="image-lightbox-viewport"');
    expect(html).toContain('data-testid="image-lightbox-img"');
    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(html).toContain("cursor-zoom-in");
    expect(html).toContain(t("ja", "image.fitTitle"));
    expect(html).toContain(t("ja", "image.actualSizeTitle"));
    expect(html).toContain(t("ja", "image.zoomOutTitle"));
    expect(html).toContain(t("ja", "image.zoomInTitle"));
    expect(html).toContain(t("ja", "image.dblClickActualSizeTitle"));
    expect(html).toContain(t("ja", "image.lightboxEscHint"));
    expect(html).toContain("/Users/dev/conductor/shots/dashboard-after.png");
  });

  it("renders cleanly in English with zero leaked Japanese characters", () => {
    const enImage: ImageViewerTab = {
      ...sampleImage,
      label: "Updated Dashboard",
    };
    const html = renderToStaticMarkup(
      <ImageLightboxModal
        image={enImage}
        locale="en"
        onClose={vi.fn()}
        onOpenInRightPane={vi.fn()}
        onOpenUrl={vi.fn()}
        onRevealInFinder={vi.fn()}
      />,
    );

    expect(html).toContain("Open in Right Pane");
    expect(html).toContain("Close image preview");
    expect(html).toContain("Press Esc or click outside to close");
    expect(html).toContain("Fit to pane (0)");
    expect(html).toContain("Actual size 100% (1)");
    expect(html).toContain("Zoom out (-)");
    expect(html).toContain("Zoom in (+)");
    expect(JAPANESE_CHAR_RE.test(html)).toBe(false);
  });

  it("renders loading and error states with retry button and disabled zoom controls cleanly", () => {
    const loadingHtml = renderToStaticMarkup(
      <ImageLightboxModal
        image={{ ...sampleImage, src: null, isLoading: true, error: null }}
        locale="ja"
        onClose={vi.fn()}
        onOpenInRightPane={vi.fn()}
      />,
    );
    expect(loadingHtml).toContain(t("ja", "image.loading"));
    expect(loadingHtml).not.toContain('data-testid="image-lightbox-img"');
    expect(loadingHtml).not.toContain('data-testid="image-lightbox-viewport"');
    expect(loadingHtml).toMatch(/data-testid="image-lightbox-fit"[^>]*disabled=""/);
    expect(loadingHtml).toMatch(/data-testid="image-lightbox-actual-size"[^>]*disabled=""/);
    expect(loadingHtml).toMatch(/data-testid="image-lightbox-zoom-out"[^>]*disabled=""/);
    expect(loadingHtml).toMatch(/data-testid="image-lightbox-zoom-in"[^>]*disabled=""/);

    const errorHtml = renderToStaticMarkup(
      <ImageLightboxModal
        image={{
          ...sampleImage,
          src: null,
          isLoading: false,
          error: "File not found",
        }}
        locale="ja"
        onClose={vi.fn()}
        onOpenInRightPane={vi.fn()}
        onRetryLoad={vi.fn()}
      />,
    );
    expect(errorHtml).toContain(t("ja", "image.errorHeading"));
    expect(errorHtml).toContain("File not found");
    expect(errorHtml).toContain(t("ja", "common.reload"));
    expect(errorHtml).toMatch(/data-testid="image-lightbox-zoom-in"[^>]*disabled=""/);
  });

  it("keeps zoom controls and tooltips aligned with the right-pane ImageViewerPane", () => {
    const lightboxHtml = renderToStaticMarkup(
      <ImageLightboxModal
        image={sampleImage}
        locale="ja"
        onClose={vi.fn()}
        onOpenInRightPane={vi.fn()}
      />,
    );
    const paneHtml = renderToStaticMarkup(
      <ImageViewerPane
        activeTab={sampleImage}
        locale="ja"
        onCloseActiveTab={vi.fn()}
        onRetryLoadTab={vi.fn()}
        onImageLoadError={vi.fn()}
        onOpenUrl={vi.fn()}
        onRevealInFinder={vi.fn()}
      />,
    );

    for (const key of [
      "image.fitTitle",
      "image.actualSizeTitle",
      "image.zoomOutTitle",
      "image.zoomOutAria",
      "image.zoomInTitle",
      "image.zoomInAria",
      "image.dblClickActualSizeTitle",
    ] as const) {
      expect(lightboxHtml).toContain(t("ja", key));
      expect(paneHtml).toContain(t("ja", key));
    }

    // Both start in Fit mode with zoom-in cursor
    expect(lightboxHtml).toContain(">Fit<");
    expect(paneHtml).toContain(">Fit<");
    expect(lightboxHtml).toContain(">100%<");
    expect(paneHtml).toContain(">100%<");
    expect(lightboxHtml).toContain("cursor-zoom-in");
    expect(paneHtml).toContain("cursor-zoom-in");
  });

  it("supports end-to-end zoom stepping, pinch zoom, drag-pan, backdrop guard, and Fit reset", () => {
    // 1. Start in Fit mode -> step zoom in -> 100% -> 125% -> clamp MAX_ZOOM -> step out -> clamp MIN_ZOOM
    let scale = 1;
    expect(formatZoomLabel("fit", scale)).toBe("Fit");
    scale = stepZoom(scale, "in");
    expect(scale).toBe(1.25);
    expect(formatZoomLabel("custom", scale)).toBe("125%");
    scale = stepZoom(MAX_ZOOM, "in");
    expect(scale).toBe(MAX_ZOOM);
    scale = stepZoom(MIN_ZOOM, "out");
    expect(scale).toBe(MIN_ZOOM);

    // 2. Trackpad pinch zoom from Fit mode transitions smoothly and anchors under cursor
    const pinched = computeWheelZoomUpdate({
      prevMode: "fit",
      prevScale: 0.5,
      deltaY: -69.3147, // ~2x zoom in -> 100%
      naturalWidth: 2000,
      naturalHeight: 1400,
      viewportWidth: 1000,
      viewportHeight: 700,
      scrollLeft: 0,
      scrollTop: 0,
      cursorX: 500,
      cursorY: 350,
    });
    expect(pinched).not.toBeNull();
    expect(pinched!.mode).toBe("custom");
    expect(pinched!.scale).toBeCloseTo(1, 2);

    // 3. Overflowing zoomed image exposes grab -> grabbing cursor and updates scroll on drag pan
    const overflowing = isImageOverflowingViewport({
      zoomMode: pinched!.mode,
      zoomScale: pinched!.scale,
      naturalSize: { width: 2000, height: 1400 },
      viewportWidth: 1000,
      viewportHeight: 700,
    });
    expect(overflowing).toBe(true);
    expect(
      resolveImageZoomCursorClass({
        zoomMode: "custom",
        isDraggingPan: false,
        isOverflowingViewport: overflowing,
      }),
    ).toBe("cursor-grab");
    expect(
      resolveImageZoomCursorClass({
        zoomMode: "custom",
        isDraggingPan: true,
        isOverflowingViewport: overflowing,
      }),
    ).toBe("cursor-grabbing");

    const panResult = computeDragPanScroll(
      {
        pointerId: 1,
        startX: 400,
        startY: 300,
        startScrollLeft: pinched!.scrollLeft,
        startScrollTop: pinched!.scrollTop,
        hasMoved: false,
      },
      280,
      210,
    );
    expect(panResult.hasMoved).toBe(true);
    expect(panResult.scrollLeft).toBeCloseTo(pinched!.scrollLeft + 120, 4);
    expect(panResult.scrollTop).toBeCloseTo(pinched!.scrollTop + 90, 4);

    // 4. Releasing a pan drag over the backdrop does not close the modal, while a clean backdrop click does
    expect(
      shouldDismissLightboxOnBackdropClick({
        isTargetBackdrop: true,
        pointerDownOrigin: "dialog",
        isDraggingPan: false,
        suppressNextBackdropClick: panResult.hasMoved,
      }),
    ).toBe(false);
    expect(
      shouldDismissLightboxOnBackdropClick({
        isTargetBackdrop: true,
        pointerDownOrigin: "backdrop",
        isDraggingPan: false,
        suppressNextBackdropClick: false,
      }),
    ).toBe(true);
  });

  it("uses lightbox-oriented tooltips/labels for image thumbnails in ChatComposer, UnifiedChat, and TaskInspectorModal", () => {
    const imgAttachment: ChatAttachment = {
      id: "att-1",
      kind: "image",
      label: "pasted-shot.png",
      imageDataUrl: "data:image/png;base64,AAAA",
    };

    const composerHtml = renderToStaticMarkup(
      <ChatComposer
        projects={[SAMPLE_PROJECT]}
        tasks={[SAMPLE_TASK]}
        attachments={[imgAttachment]}
        selectedMentions={[]}
        locale="ja"
        isBrowserTabActive={false}
        isPickingElement={false}
        browserErrorCount={0}
        voiceAutoSend={false}
        onAddMention={vi.fn()}
        onRemoveMention={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onOpenImageAttachment={vi.fn()}
        onSend={vi.fn()}
        onToggleElementPicker={vi.fn()}
        onCaptureScreenshot={vi.fn()}
        onAttachCurrentUrl={vi.fn()}
        onAttachConsoleErrors={vi.fn()}
        onPickLocalImages={vi.fn()}
        onPasteImage={vi.fn()}
      />,
    );
    expect(composerHtml).toContain(t("ja", "chat.openImageTitle", { label: "pasted-shot.png" }));
    expect(composerHtml).not.toContain("右ペインで画像を表示");

    const userMsg: ChatMessage = {
      id: "msg-u1",
      role: "user",
      text: "こちらの画像を確認してください",
      attachments: [imgAttachment],
      toolChips: [],
      isStreaming: false,
      createdAt: "2026-11-27T00:01:00.000Z",
    };
    const assistantMsg: ChatMessage = {
      id: "msg-a1",
      role: "assistant",
      text: "![Result](https://example.com/result.png)",
      attachments: [],
      toolChips: [],
      isStreaming: false,
      createdAt: "2026-11-27T00:02:00.000Z",
    };

    const chatHtml = renderToStaticMarkup(
      <UnifiedChat
        snapshot={makeSnapshot([userMsg, assistantMsg])}
        locale="ja"
        attachments={[]}
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
        onOpenMarkdownImage={vi.fn()}
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
    expect(chatHtml).toContain(t("ja", "chat.openImageTitle", { label: "pasted-shot.png" }));
    expect(chatHtml).toContain(t("ja", "markdown.imageZoomTitle"));
    expect(chatHtml).not.toContain("右ペインで画像を表示");

    const inspectorHtml = renderToStaticMarkup(
      <TaskInspectorModal
        task={SAMPLE_TASK}
        projectColorHex="#6366F1"
        locale="ja"
        onClose={vi.fn()}
        onUpdateStatus={vi.fn()}
        onOpenPreviewUrl={vi.fn()}
        onOpenImage={vi.fn()}
        onMentionInChat={vi.fn()}
        onStopWorker={vi.fn()}
      />,
    );
    expect(inspectorHtml).toContain('src="https://example.com/updated-ui.png"');
    expect(inspectorHtml).toContain(t("ja", "markdown.imageZoomTitle"));
  });
});
