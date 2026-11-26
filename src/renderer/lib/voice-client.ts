import type { VoiceSpeakRequest, VoiceSpeakResult } from "../../shared/voice.js";

export interface BrowserSpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

export interface BrowserSpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: BrowserSpeechRecognitionAlternative;
}

export interface BrowserSpeechRecognitionResultList {
  readonly length: number;
  [index: number]: BrowserSpeechRecognitionResult;
}

export interface BrowserSpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: BrowserSpeechRecognitionResultList;
}

export interface BrowserSpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message?: string;
}

export interface BrowserSpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: ((this: BrowserSpeechRecognition, ev: Event) => unknown) | null;
  onend: ((this: BrowserSpeechRecognition, ev: Event) => unknown) | null;
  onerror: ((this: BrowserSpeechRecognition, ev: BrowserSpeechRecognitionErrorEvent) => unknown) | null;
  onresult: ((this: BrowserSpeechRecognition, ev: BrowserSpeechRecognitionEvent) => unknown) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

interface SpeechWindow extends Window {
  SpeechRecognition?: BrowserSpeechRecognitionConstructor;
  webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
}

export function getSpeechRecognitionConstructor(): BrowserSpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as SpeechWindow;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function speakWithWebSpeech(
  request: VoiceSpeakRequest,
  isCancelled: () => boolean,
): Promise<VoiceSpeakResult> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      resolve({ ok: false, usedNativeSay: false, error: "speechSynthesis unavailable" });
      return;
    }

    const synth = window.speechSynthesis;
    try {
      synth.cancel();
    } catch {
      // ignore
    }

    if (isCancelled()) {
      resolve({ ok: true, usedNativeSay: false, stopped: true });
      return;
    }

    const utterance = new SpeechSynthesisUtterance(request.text);
    utterance.lang = request.language === "en" ? "en-US" : "ja-JP";

    let settled = false;
    const finish = (result: VoiceSpeakResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    utterance.onend = () => {
      finish({ ok: true, usedNativeSay: false, stopped: isCancelled() });
    };
    utterance.onerror = (ev) => {
      if (isCancelled() || ev.error === "canceled" || ev.error === "interrupted") {
        finish({ ok: true, usedNativeSay: false, stopped: true });
      } else {
        finish({ ok: false, usedNativeSay: false, error: ev.error || "speechSynthesis error" });
      }
    };

    try {
      synth.speak(utterance);
    } catch (err) {
      finish({
        ok: false,
        usedNativeSay: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/**
 * Speaks text using the Electron main-process OS-standard TTS (macOS `say`),
 * transparently falling back to `window.speechSynthesis` on non-macOS or when `say` fails.
 */
export async function speakTextWithFallback(
  request: VoiceSpeakRequest,
  isCancelled: () => boolean = () => false,
): Promise<VoiceSpeakResult> {
  const cleanText = request.text.trim();
  if (!cleanText || isCancelled()) {
    return { ok: true, stopped: isCancelled() };
  }

  const api = typeof window !== "undefined" ? window.conductor : undefined;
  if (api?.voiceSpeak) {
    try {
      const result = await api.voiceSpeak({
        text: cleanText,
        language: request.language,
      });
      if (isCancelled() || result.stopped) {
        return { ok: true, usedNativeSay: result.usedNativeSay, stopped: true };
      }
      if (result.ok) {
        return result;
      }
      if (!result.fallbackToWebSpeech) {
        return result;
      }
    } catch {
      // Fall through to Web Speech API fallback
    }
  }

  if (isCancelled()) {
    return { ok: true, stopped: true };
  }
  return speakWithWebSpeech({ text: cleanText, language: request.language }, isCancelled);
}

/**
 * Immediately cancels any active OS-standard or Web Speech synthesis playback.
 */
export async function stopAllVoicePlayback(): Promise<void> {
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // ignore
    }
  }
  const api = typeof window !== "undefined" ? window.conductor : undefined;
  if (api?.voiceStop) {
    try {
      await api.voiceStop();
    } catch {
      // ignore
    }
  }
}
