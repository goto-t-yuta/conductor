import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeChatSessions } from "../shared/chat-sessions.js";
import { DEFAULT_PREFERRED_LANGUAGE, isValidPreferredLanguage } from "../shared/language.js";
import { normalizeTaskNumbers } from "../shared/mentions.js";
import type { PersistedState } from "../shared/types.js";
import { normalizeUsageRecords } from "../shared/usage.js";
import { DEFAULT_VOICE_READBACK_ENABLED } from "../shared/voice.js";

const DEFAULT_REMOTE_ACCESS_PORT = 4789;

function generateRemoteAccessToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

function normalizeRemoteAccessPort(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (Number.isInteger(num) && num >= 1 && num <= 65535) {
    return num;
  }
  return DEFAULT_REMOTE_ACCESS_PORT;
}

const DEFAULT_STATE: PersistedState = {
  projects: [],
  scanRoots: [],
  tasks: [],
  nextTaskNumber: 1,
  messages: [],
  chatSessions: [],
  activeChatSessionId: null,
  browserTabs: [],
  activeBrowserTabId: null,
  showTaskSidebar: true,
  showBrowserPane: true,
  chatModel: null,
  chatEffort: null,
  workerModel: null,
  workerEffort: null,
  defaultIntegrationMode: "feature-branch",
  autoLandOnComplete: true,
  preferredLanguage: DEFAULT_PREFERRED_LANGUAGE,
  voiceReadbackEnabled: DEFAULT_VOICE_READBACK_ENABLED,
  remoteAccessEnabled: false,
  remoteAccessPort: DEFAULT_REMOTE_ACCESS_PORT,
  remoteAccessToken: "",
  usageRecords: [],
};

export class StateStore {
  public readonly baseDir: string;
  public readonly stateFile: string;
  public readonly attachmentsDir: string;
  public readonly worktreesDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.stateFile = path.join(baseDir, "state.json");
    this.attachmentsDir = path.join(baseDir, "attachments");
    this.worktreesDir = path.join(baseDir, "worktrees");
    fs.mkdirSync(this.baseDir, { recursive: true });
    fs.mkdirSync(this.attachmentsDir, { recursive: true });
    fs.mkdirSync(this.worktreesDir, { recursive: true });
  }

  load(): PersistedState {
    try {
      if (!fs.existsSync(this.stateFile)) {
        return {
          ...DEFAULT_STATE,
          remoteAccessToken: generateRemoteAccessToken(),
        };
      }
      const raw = fs.readFileSync(this.stateFile, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      const rawTasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
      const normalized = normalizeTaskNumbers(rawTasks, parsed.nextTaskNumber);
      const normalizedChats = normalizeChatSessions({
        chatSessions: parsed.chatSessions,
        activeChatSessionId: parsed.activeChatSessionId,
        legacyMessages: parsed.messages,
        chatProvider: parsed.chatProvider,
      });
      const activeChat = normalizedChats.chatSessions.find(
        (s) => s.id === normalizedChats.activeChatSessionId,
      );
      const existingToken =
        typeof parsed.remoteAccessToken === "string" ? parsed.remoteAccessToken.trim() : "";
      const hasValidToken = existingToken.length >= 16;
      const remoteAccessToken = hasValidToken ? existingToken : generateRemoteAccessToken();
      const state: PersistedState = {
        ...DEFAULT_STATE,
        ...parsed,
        projects: Array.isArray(parsed.projects) ? parsed.projects : [],
        scanRoots: Array.isArray(parsed.scanRoots) ? parsed.scanRoots : [],
        tasks: normalized.tasks,
        nextTaskNumber: normalized.nextTaskNumber,
        messages: activeChat ? activeChat.messages : [],
        chatSessions: normalizedChats.chatSessions,
        activeChatSessionId: normalizedChats.activeChatSessionId,
        browserTabs: Array.isArray(parsed.browserTabs) ? parsed.browserTabs : [],
        autoLandOnComplete:
          typeof parsed.autoLandOnComplete === "boolean" ? parsed.autoLandOnComplete : true,
        preferredLanguage: isValidPreferredLanguage(parsed.preferredLanguage)
          ? parsed.preferredLanguage
          : DEFAULT_PREFERRED_LANGUAGE,
        voiceReadbackEnabled:
          typeof parsed.voiceReadbackEnabled === "boolean"
            ? parsed.voiceReadbackEnabled
            : DEFAULT_VOICE_READBACK_ENABLED,
        remoteAccessEnabled:
          typeof parsed.remoteAccessEnabled === "boolean" ? parsed.remoteAccessEnabled : false,
        remoteAccessPort: normalizeRemoteAccessPort(parsed.remoteAccessPort),
        remoteAccessToken,
        usageRecords: normalizeUsageRecords(parsed.usageRecords),
      };
      if (normalized.changed || normalizedChats.changed || !hasValidToken) {
        this.save(state);
      }
      return state;
    } catch {
      return {
        ...DEFAULT_STATE,
        remoteAccessToken: generateRemoteAccessToken(),
      };
    }
  }

  save(state: PersistedState): void {
    const tmp = `${this.stateFile}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
      fs.renameSync(tmp, this.stateFile);
    } catch {
      // ignore transient disk errors
    }
  }

  savePngBuffer(buffer: Buffer, prefix = "capture"): { imagePath: string; imageDataUrl: string } {
    const name = `${prefix}-${crypto.randomUUID().slice(0, 8)}.png`;
    const imagePath = path.join(this.attachmentsDir, name);
    fs.writeFileSync(imagePath, buffer);
    const imageDataUrl = `data:image/png;base64,${buffer.toString("base64")}`;
    return { imagePath, imageDataUrl };
  }

  imageFileToDataUrl(filePath: string): string | undefined {
    try {
      const ext = path.extname(filePath).toLowerCase();
      const mime =
        ext === ".jpg" || ext === ".jpeg"
          ? "image/jpeg"
          : ext === ".webp"
            ? "image/webp"
            : ext === ".gif"
              ? "image/gif"
              : "image/png";
      const buf = fs.readFileSync(filePath);
      return `data:${mime};base64,${buf.toString("base64")}`;
    } catch {
      return undefined;
    }
  }
}
