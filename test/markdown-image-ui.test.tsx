import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { readLocalImageFile } from "../src/main/image-viewer.js";
import { MarkdownView } from "../src/renderer/components/MarkdownView.js";
import { MarkdownImageCache } from "../src/renderer/lib/markdown-image-cache.js";

describe("MarkdownView embedded image rendering", () => {
  it("renders remote https:// and inline data:image/* images directly with responsive max-w-full classes", () => {
    const md = [
      "![Remote](https://example.com/banner.png)",
      "",
      "![Inline](data:image/png;base64,iVBORw0KGgo=)",
    ].join("\n");

    const html = renderToStaticMarkup(
      <MarkdownView
        content={md}
        baseFilePath="/Users/dev/project/README.md"
        onOpenUrl={vi.fn()}
        onOpenImage={vi.fn()}
      />,
    );

    expect(html).toContain('src="https://example.com/banner.png"');
    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(html).toContain("max-w-full");
    expect(html).toContain("cursor-zoom-in");
    expect(html).not.toContain('data-testid="markdown-image-error"');
  });

  it("renders cached local relative, absolute, file://, and Japanese images as data URLs without broken paths", async () => {
    const repoReadme = path.resolve(process.cwd(), "README.md");
    const cache = new MarkdownImageCache();

    // Load a real documentation image from this repository using the main-process reader
    const realResult = await cache.load({
      target: "docs/images/conductor-overview.png",
      baseFilePath: repoReadme,
      cacheKey: path.resolve(process.cwd(), "docs/images/conductor-overview.png"),
      loader: async (target, base) => readLocalImageFile(target, base),
    });
    expect(realResult.ok).toBe(true);
    expect(realResult.dataUrl?.startsWith("data:image/png;base64,")).toBe(true);

    // Pre-warm cache for additional local path variants
    cache.set("/abs/path/shot.png", {
      dataUrl: "data:image/png;base64,ABS_IMG",
      filePath: "/abs/path/shot.png",
    });
    cache.set("/Users/dev/my folder/スクリーンショット.png", {
      dataUrl: "data:image/png;base64,FILE_URL_IMG",
      filePath: "/Users/dev/my folder/スクリーンショット.png",
    });
    cache.set(path.resolve(process.cwd(), "docs/images/日本語 画像.png"), {
      dataUrl: "data:image/png;base64,JP_REL_IMG",
      filePath: path.resolve(process.cwd(), "docs/images/日本語 画像.png"),
    });

    const md = [
      "![Overview](docs/images/conductor-overview.png)",
      "",
      "![Abs](/abs/path/shot.png)",
      "",
      "![FileUrl](file:///Users/dev/my%20folder/%E3%82%B9%E3%82%AF%E3%83%AA%E3%83%BC%E3%83%B3%E3%82%B7%E3%83%A7%E3%83%83%E3%83%88.png)",
      "",
      "![JapaneseRel](<docs/images/日本語 画像.png>)",
    ].join("\n");

    const html = renderToStaticMarkup(
      <MarkdownView
        content={md}
        baseFilePath={repoReadme}
        imageCache={cache}
        onOpenUrl={vi.fn()}
        onOpenImage={vi.fn()}
      />,
    );

    expect(html).toContain(realResult.dataUrl!);
    expect(html).toContain('src="data:image/png;base64,ABS_IMG"');
    expect(html).toContain('src="data:image/png;base64,FILE_URL_IMG"');
    expect(html).toContain('src="data:image/png;base64,JP_REL_IMG"');
    // Never emits raw file:// or unresolvable relative img src attributes
    expect(html).not.toContain('src="docs/images/');
    expect(html).not.toContain('src="file://');
    expect(html).not.toContain('src="/abs/path/');
  });

  it("renders a loading placeholder for uncached local images and clean fallback for invalid or baseless relative images", () => {
    const emptyCache = new MarkdownImageCache();

    // Uncached local image shows loading placeholder rather than broken <img src="docs/...">
    const loadingHtml = renderToStaticMarkup(
      <MarkdownView
        content="![Pending](docs/images/pending.png)"
        baseFilePath="/Users/dev/repo/README.md"
        imageCache={emptyCache}
        onOpenUrl={vi.fn()}
      />,
    );
    expect(loadingHtml).toContain('data-testid="markdown-image-loading"');
    expect(loadingHtml).toContain('data-markdown-image-path="/Users/dev/repo/docs/images/pending.png"');
    expect(loadingHtml).not.toContain("<img");

    // Relative image without baseFilePath falls back cleanly instead of requesting localhost
    const noBaseHtml = renderToStaticMarkup(
      <MarkdownView
        content="![MissingBase](./local.png)"
        imageCache={emptyCache}
        onOpenUrl={vi.fn()}
      />,
    );
    expect(noBaseHtml).toContain('data-testid="markdown-image-error"');
    expect(noBaseHtml).toContain("./local.png");
    expect(noBaseHtml).not.toContain("<img");

    // Disallowed scheme is blocked and rendered as fallback error
    const unsafeHtml = renderToStaticMarkup(
      <MarkdownView
        content="![Unsafe](javascript:alert(1))"
        baseFilePath="/Users/dev/repo/README.md"
        imageCache={emptyCache}
        onOpenUrl={vi.fn()}
      />,
    );
    expect(unsafeHtml).toContain('data-testid="markdown-image-error"');
    expect(unsafeHtml).not.toContain("javascript:");
  });
});
