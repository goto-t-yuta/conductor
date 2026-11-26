import { spawn, type ChildProcess } from "node:child_process";
import type { VoiceSpeakRequest, VoiceSpeakResult } from "../shared/voice.js";

export type SpawnSayFn = (
  command: string,
  args: string[],
  options: { stdio: ["pipe", "ignore", "ignore"] },
) => ChildProcess;

export interface VoiceTtsManagerOptions {
  platform?: NodeJS.Platform;
  japaneseVoice?: string;
  englishVoice?: string | null;
  spawnFn?: SpawnSayFn;
}

/**
 * Lightweight OS-standard TTS runner for the Electron main process.
 * Uses macOS native `say` with clean child-process cancellation when a new
 * utterance starts or the user clicks Stop. Non-macOS platforms signal the
 * renderer to use `window.speechSynthesis`.
 */
export class VoiceTtsManager {
  private readonly platform: NodeJS.Platform;
  private readonly japaneseVoice: string;
  private readonly englishVoice: string | null;
  private readonly spawnFn: SpawnSayFn;
  private activeProcess: ChildProcess | null = null;
  private activeGeneration = 0;

  constructor(options: VoiceTtsManagerOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.japaneseVoice = options.japaneseVoice ?? "Kyoko";
    this.englishVoice = options.englishVoice ?? null;
    this.spawnFn =
      options.spawnFn ??
      ((command, args, spawnOpts) =>
        spawn(command, args, {
          ...spawnOpts,
          windowsHide: true,
        }));
  }

  public isSpeaking(): boolean {
    return this.activeProcess !== null;
  }

  public stop(): void {
    this.activeGeneration += 1;
    const proc = this.activeProcess;
    this.activeProcess = null;
    if (!proc) return;
    try {
      proc.kill("SIGTERM");
    } catch {
      // ignore if already exited
    }
  }

  public buildSayArgs(language: "ja" | "en"): string[] {
    if (language === "ja" && this.japaneseVoice) {
      return ["-v", this.japaneseVoice];
    }
    if (language === "en" && this.englishVoice) {
      return ["-v", this.englishVoice];
    }
    return [];
  }

  public async speak(request: VoiceSpeakRequest): Promise<VoiceSpeakResult> {
    const cleanText = (request.text ?? "").trim();
    if (!cleanText) {
      this.stop();
      return { ok: true, usedNativeSay: false };
    }

    // Always cancel any in-flight utterance cleanly before starting the next one
    this.stop();

    if (this.platform !== "darwin") {
      return {
        ok: false,
        usedNativeSay: false,
        fallbackToWebSpeech: true,
      };
    }

    const generation = this.activeGeneration;
    const language = request.language === "en" ? "en" : "ja";
    const primaryArgs = this.buildSayArgs(language);

    const primaryResult = await this.runSayProcess(cleanText, primaryArgs, generation);
    // If a specific voice failed (e.g. voice not installed on this macOS image), retry with default system voice
    if (
      !primaryResult.ok &&
      !primaryResult.stopped &&
      primaryArgs.length > 0 &&
      this.activeGeneration === generation
    ) {
      return this.runSayProcess(cleanText, [], generation);
    }

    return primaryResult;
  }

  private runSayProcess(
    text: string,
    args: string[],
    generation: number,
  ): Promise<VoiceSpeakResult> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: VoiceSpeakResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      let child: ChildProcess;
      try {
        child = this.spawnFn("say", args, {
          stdio: ["pipe", "ignore", "ignore"],
        });
      } catch (err) {
        finish({
          ok: false,
          usedNativeSay: false,
          fallbackToWebSpeech: true,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      if (this.activeGeneration !== generation) {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
        finish({ ok: true, usedNativeSay: true, stopped: true });
        return;
      }

      this.activeProcess = child;

      child.once("error", (err) => {
        if (this.activeProcess === child) {
          this.activeProcess = null;
        }
        if (this.activeGeneration !== generation) {
          finish({ ok: true, usedNativeSay: true, stopped: true });
          return;
        }
        finish({
          ok: false,
          usedNativeSay: false,
          fallbackToWebSpeech: true,
          error: err.message,
        });
      });

      child.once("close", (code, signal) => {
        if (this.activeProcess === child) {
          this.activeProcess = null;
        }
        if (this.activeGeneration !== generation || signal === "SIGTERM" || signal === "SIGKILL") {
          finish({ ok: true, usedNativeSay: true, stopped: true });
          return;
        }
        if (code === 0) {
          finish({ ok: true, usedNativeSay: true });
        } else {
          finish({
            ok: false,
            usedNativeSay: false,
            fallbackToWebSpeech: true,
            error: `say exited with code ${String(code)}`,
          });
        }
      });

      try {
        child.stdin?.on("error", () => {
          // ignore EPIPE if killed mid-write
        });
        child.stdin?.end(`${text}\n`, "utf8");
      } catch {
        // ignore write errors when process terminates immediately
      }
    });
  }
}
