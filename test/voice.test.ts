import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserManager } from "../src/main/browser-manager.js";
import { ConductorController } from "../src/main/conductor-controller.js";
import { StateStore } from "../src/main/state-store.js";
import { VoiceTtsManager, type SpawnSayFn } from "../src/main/voice-tts.js";
import {
  DEFAULT_VOICE_READBACK_ENABLED,
  appendVoiceTranscript,
  collectVoiceReadbackUtterances,
  createInitialVoiceReadbackTracker,
  formatSpeechRecognitionError,
  formatTaskEventForSpeech,
  formatTextForSpeech,
  resolveSpeechLocale,
  resolveTtsLanguage,
} from "../src/shared/voice.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createFakeBrowserManager(): BrowserManager {
  return {
    getTabs: () => [],
    getActiveTabId: () => null,
    getActiveTab: () => null,
    isPickingElement: () => false,
    restore: () => {},
  } as unknown as BrowserManager;
}

interface FakeSayChild extends EventEmitter {
  killed: boolean;
  written: string;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  stdin: EventEmitter & { end: (chunk?: string) => void };
}

function createFakeSayChild(): FakeSayChild {
  const child = new EventEmitter() as FakeSayChild;
  child.killed = false;
  child.written = "";
  const stdin = new EventEmitter() as EventEmitter & { end: (chunk?: string) => void };
  stdin.end = (chunk?: string) => {
    if (chunk) child.written += chunk;
  };
  child.stdin = stdin;
  child.kill = (signal?: NodeJS.Signals | number) => {
    child.killed = true;
    child.emit("close", null, typeof signal === "string" ? signal : "SIGTERM");
    return true;
  };
  return child;
}

describe("Shared voice helpers (src/shared/voice.ts)", () => {
  it("strips Markdown formatting, fenced code blocks, file paths, and URLs in formatTextForSpeech", () => {
    const markdown = [
      "## 実装完了報告",
      "",
      "**音声入力**と_読み上げ_を `src/shared/voice.ts` および [UnifiedChat.tsx](file:///Users/yutagoto/Documents/conductor/src/renderer/components/UnifiedChat.tsx#L10-L20) に追加しました。",
      "",
      "```ts",
      "export function secretCode() {",
      "  return 'should not be spoken';",
      "}",
      "```",
      "",
      "- 詳細は [公式ドキュメント](https://example.com/docs/voice) を参照してください",
      "- ログ出力先: /Users/yutagoto/tmp/output.log と ~/Documents/conductor/state.json",
      "- Windows 例: C:\\Users\\dev\\conductor\\app.ts",
      "- 機能切替は ON/OFF で変更できます",
      "- `pnpm check` はすべて成功しました",
    ].join("\n");

    const spoken = formatTextForSpeech(markdown, { language: "ja", maxLength: 400 });

    expect(spoken).toContain("実装完了報告");
    expect(spoken).toContain("音声入力と読み上げを");
    expect(spoken).toContain("公式ドキュメント");
    expect(spoken).toContain("ON/OFF");
    expect(spoken).toContain("pnpm check");

    // Stripped elements must not leak into speech text
    expect(spoken).not.toContain("secretCode");
    expect(spoken).not.toContain("should not be spoken");
    expect(spoken).not.toContain("```");
    expect(spoken).not.toContain("**");
    expect(spoken).not.toContain("https://");
    expect(spoken).not.toContain("file://");
    expect(spoken).not.toContain("/Users/yutagoto");
    expect(spoken).not.toContain("src/shared/voice.ts");
    expect(spoken).not.toContain("~/Documents");
    expect(spoken).not.toContain("C:\\Users");
  });

  it("truncates long replies cleanly at sentence or word boundaries", () => {
    const longJa =
      "最初のテストはすべて成功しました。次にビルドを実行して問題がないことを確認しました。" +
      "さらに追加の長い補足説明がここに続きますが、読み上げでは長すぎるため自然に省略されるべきです。";

    const truncatedJa = formatTextForSpeech(longJa, { language: "ja", maxLength: 55 });
    expect(truncatedJa.length).toBeLessThanOrEqual(55);
    expect(truncatedJa).toBe("最初のテストはすべて成功しました。次にビルドを実行して問題がないことを確認しました。");

    const longEn =
      "First check passed cleanly. Second check verified all TypeScript types across main and renderer bundles. " +
      "Third paragraph adds lots of extra detail that exceeds the concise spoken readback limit.";
    const truncatedEn = formatTextForSpeech(longEn, { language: "en", maxLength: 115 });
    expect(truncatedEn.length).toBeLessThanOrEqual(115);
    expect(truncatedEn.endsWith(".")).toBe(true);
    expect(truncatedEn).not.toContain("Third paragraph");

    // Single very long sentence falls back to ellipsis
    const oneSentence = "This is a single very long English sentence without any punctuation breaks for testing clean word boundary truncation";
    const clipped = formatTextForSpeech(oneSentence, { language: "en", maxLength: 45 });
    expect(clipped.length).toBeLessThanOrEqual(45);
    expect(clipped.endsWith("…")).toBe(true);
  });

  it("formats concise TaskEvent completion and failure notices in Japanese and English", () => {
    const task48 = {
      id: "task-48",
      taskNumber: 48,
      title: "音声入力と読み上げの実装",
      status: "needs_review",
    };

    const jaNotice = formatTaskEventForSpeech(
      {
        relatedTaskId: "task-48",
        text: "**[T48 · conductor · AGY] 音声入力と読み上げの実装** — 完了（確認待ち）\n✅ 自動 Land 完了: main",
      },
      [task48],
      "ja",
    );
    expect(jaNotice).toBe("T48 が完了しました。音声入力と読み上げの実装");

    const enNotice = formatTaskEventForSpeech(
      {
        relatedTaskId: "task-48",
        text: "**[T48 · conductor] Voice input support** — 完了（確認待ち）\nDone.",
      },
      [{ id: "task-48", taskNumber: 48, title: "Voice input support", status: "done" }],
      "en",
    );
    expect(enNotice).toBe("T48 completed. Voice input support.");

    const failedJa = formatTaskEventForSpeech(
      {
        text: "**[T12 · demo] テスト修正** — 失敗\nVitest failed",
      },
      [],
      "ja",
    );
    expect(failedJa).toBe("T12 が失敗しました。テスト修正");

    // Startup auto-resume informational banner is skipped
    const resumeInfo = formatTaskEventForSpeech(
      {
        relatedTaskId: "task-48",
        text: "**[T48 · conductor · Codex] 音声入力** — 再起動後に自動再開しました（セッション継続）",
      },
      [task48],
      "ja",
    );
    expect(resumeInfo).toBeNull();
  });

  it("resolves speech locales, TTS languages, smart transcript joining, and friendly Fn×2 hints", () => {
    expect(resolveSpeechLocale("ja")).toBe("ja-JP");
    expect(resolveSpeechLocale("en")).toBe("en-US");
    expect(resolveSpeechLocale("auto", "en-GB")).toBe("en-US");
    expect(resolveSpeechLocale("auto", "ja-JP")).toBe("ja-JP");

    expect(resolveTtsLanguage("ja", "Hello")).toBe("ja");
    expect(resolveTtsLanguage("en", "こんにちは")).toBe("en");
    expect(resolveTtsLanguage("auto", "T48 が完了しました")).toBe("ja");
    expect(resolveTtsLanguage("auto", "T48 completed.")).toBe("en");

    expect(appendVoiceTranscript("", "こんにちは")).toBe("こんにちは");
    expect(appendVoiceTranscript("こんにちは", "テストです")).toBe("こんにちはテストです");
    expect(appendVoiceTranscript("Hello", "world")).toBe("Hello world");
    expect(appendVoiceTranscript("Hello ", "world")).toBe("Hello world");

    const networkJa = formatSpeechRecognitionError("network", "ja");
    expect(networkJa).toContain("Fn");
    const networkEn = formatSpeechRecognitionError("service-not-allowed", "en");
    expect(networkEn).toContain("Fn");
    const unsupportedJa = formatSpeechRecognitionError("unsupported", "ja");
    expect(unsupportedJa).toContain("Fn");
    expect(formatSpeechRecognitionError("aborted", "ja")).toBe("");
  });

  it("tracks readback state without replaying historical messages on load or toggle", () => {
    const initial = createInitialVoiceReadbackTracker();
    const historyMsg = {
      id: "m-old",
      role: "assistant" as const,
      text: "古い返信",
      isStreaming: false,
    };

    // Initial load: never speaks old history
    const step1 = collectVoiceReadbackUtterances(initial, {
      sessionId: "sess-1",
      messages: [historyMsg],
      tasks: [],
      preferredLanguage: "ja",
      readbackEnabled: true,
    });
    expect(step1.utterances).toEqual([]);

    // Assistant starts streaming: not spoken yet
    const streamingMsg = {
      id: "m-new",
      role: "assistant" as const,
      text: "作成中...",
      isStreaming: true,
    };
    const step2 = collectVoiceReadbackUtterances(step1.nextState, {
      sessionId: "sess-1",
      messages: [historyMsg, streamingMsg],
      tasks: [],
      preferredLanguage: "ja",
      readbackEnabled: true,
    });
    expect(step2.utterances).toEqual([]);

    // Assistant completes + TaskEvent arrives: both spoken concisely
    const completedMsg = {
      ...streamingMsg,
      text: "**完了しました** `src/shared/voice.ts` を追加しました。",
      isStreaming: false,
    };
    const taskEventMsg = {
      id: "m-task",
      role: "taskEvent" as const,
      relatedTaskId: "t-48",
      text: "**[T48 · conductor] 音声機能** — 完了（確認待ち）\nDone",
      isStreaming: false,
    };
    const step3 = collectVoiceReadbackUtterances(step2.nextState, {
      sessionId: "sess-1",
      messages: [historyMsg, completedMsg, taskEventMsg],
      tasks: [{ id: "t-48", taskNumber: 48, title: "音声機能", status: "needs_review" }],
      preferredLanguage: "ja",
      readbackEnabled: true,
    });
    expect(step3.utterances).toHaveLength(2);
    expect(step3.utterances[0]?.text).toContain("完了しました");
    expect(step3.utterances[0]?.text).not.toContain("src/shared/voice.ts");
    expect(step3.utterances[1]?.text).toBe("T48 が完了しました。音声機能");

    // Switching sessions never replays messages from the other session
    const step4 = collectVoiceReadbackUtterances(step3.nextState, {
      sessionId: "sess-2",
      messages: [{ id: "m-other", role: "assistant", text: "別セッション履歴", isStreaming: false }],
      tasks: [],
      preferredLanguage: "ja",
      readbackEnabled: true,
    });
    expect(step4.utterances).toEqual([]);
  });
});

describe("VoiceTtsManager (src/main/voice-tts.ts)", () => {
  it("uses macOS say with Kyoko for Japanese, default voice for English, and cancels prior child on new speak/stop", async () => {
    const spawned: Array<{ cmd: string; args: string[]; child: FakeSayChild }> = [];
    const spawnFn: SpawnSayFn = (cmd, args) => {
      const child = createFakeSayChild();
      spawned.push({ cmd, args, child });
      return child as unknown as ChildProcess;
    };

    const tts = new VoiceTtsManager({ platform: "darwin", spawnFn });

    const p1 = tts.speak({ text: "T48 が完了しました", language: "ja" });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.cmd).toBe("say");
    expect(spawned[0]?.args).toEqual(["-v", "Kyoko"]);
    expect(spawned[0]?.child.written).toContain("T48 が完了しました");
    expect(tts.isSpeaking()).toBe(true);

    // Starting a second utterance cleanly cancels the first process
    const p2 = tts.speak({ text: "Build succeeded", language: "en" });
    expect(spawned[0]?.child.killed).toBe(true);
    expect(await p1).toEqual({ ok: true, usedNativeSay: true, stopped: true });

    expect(spawned).toHaveLength(2);
    expect(spawned[1]?.args).toEqual([]);
    expect(spawned[1]?.child.written).toContain("Build succeeded");

    spawned[1]?.child.emit("close", 0, null);
    expect(await p2).toEqual({ ok: true, usedNativeSay: true });
    expect(tts.isSpeaking()).toBe(false);
  });

  it("signals Web Speech fallback on non-macOS platforms", async () => {
    const spawnFn = vi.fn();
    const tts = new VoiceTtsManager({
      platform: "linux",
      spawnFn: spawnFn as unknown as SpawnSayFn,
    });

    const result = await tts.speak({ text: "Hello", language: "en" });
    expect(result).toEqual({
      ok: false,
      usedNativeSay: false,
      fallbackToWebSpeech: true,
    });
    expect(spawnFn).not.toHaveBeenCalled();
  });
});

describe("StateStore & ConductorController voiceReadbackEnabled persistence", () => {
  it("defaults voiceReadbackEnabled to false and persists updates across reloads", () => {
    const dataDir = makeTempDir("conductor-voice-store-");
    const store = new StateStore(dataDir);

    expect(DEFAULT_VOICE_READBACK_ENABLED).toBe(false);
    expect(store.load().voiceReadbackEnabled).toBe(false);

    const controller = new ConductorController({
      store,
      browser: createFakeBrowserManager(),
      onSnapshot: () => {},
    });
    expect(controller.getSnapshot().voiceReadbackEnabled).toBe(false);

    controller.setVoiceReadbackEnabled(true);
    expect(controller.getSnapshot().voiceReadbackEnabled).toBe(true);
    expect(store.load().voiceReadbackEnabled).toBe(true);

    const reloaded = new ConductorController({
      store,
      browser: createFakeBrowserManager(),
      onSnapshot: () => {},
    });
    expect(reloaded.getSnapshot().voiceReadbackEnabled).toBe(true);
  });
});
