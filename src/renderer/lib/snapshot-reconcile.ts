import type {
  AgentProvider,
  AgentTask,
  AppSnapshot,
  BrowserTab,
  ChatAttachment,
  ChatMessage,
  ChatMessageMentionRef,
  ChatSessionSummary,
  ModelOption,
  Project,
  ProviderQuotaSnapshot,
  ProviderQuotasMap,
  ProviderStatus,
  RemoteAccessStatus,
  ToolActivityChip,
  UsageBudgetSettings,
  UsageRecord,
  WorkerActivityEntry,
} from "../../shared/types.js";

function areStringArraysEqual(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function areAttachmentsEqual(
  a: readonly ChatAttachment[] | undefined,
  b: readonly ChatAttachment[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return (a?.length ?? 0) === (b?.length ?? 0);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.kind !== y.kind ||
      x.label !== y.label ||
      x.imagePath !== y.imagePath ||
      x.imageDataUrl !== y.imageDataUrl ||
      x.url !== y.url ||
      x.metadataText !== y.metadataText
    ) {
      return false;
    }
  }
  return true;
}

function areToolChipsEqual(
  a: readonly ToolActivityChip[] | undefined,
  b: readonly ToolActivityChip[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return (a?.length ?? 0) === (b?.length ?? 0);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.toolName !== y.toolName ||
      x.label !== y.label ||
      x.detail !== y.detail ||
      x.isCompleted !== y.isCompleted ||
      x.isError !== y.isError
    ) {
      return false;
    }
  }
  return true;
}

function areMentionRefsEqual(
  a: readonly ChatMessageMentionRef[] | undefined,
  b: readonly ChatMessageMentionRef[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (
      x.kind !== y.kind ||
      x.projectId !== y.projectId ||
      x.projectName !== y.projectName ||
      x.projectPath !== y.projectPath ||
      x.projectColorHex !== y.projectColorHex
    ) {
      return false;
    }
    if (x.kind === "task" && y.kind === "task") {
      if (
        x.taskId !== y.taskId ||
        x.taskNumber !== y.taskNumber ||
        x.taskTitle !== y.taskTitle ||
        x.taskStatus !== y.taskStatus
      ) {
        return false;
      }
    }
  }
  return true;
}

export function areChatMessagesEqual(a: ChatMessage, b: ChatMessage): boolean {
  if (a === b) return true;
  return (
    a.id === b.id &&
    a.role === b.role &&
    a.provider === b.provider &&
    a.text === b.text &&
    a.reasoningSummary === b.reasoningSummary &&
    a.relatedTaskId === b.relatedTaskId &&
    a.replyToMessageId === b.replyToMessageId &&
    a.replyToSnippet === b.replyToSnippet &&
    a.responderThreadId === b.responderThreadId &&
    a.responderTurnId === b.responderTurnId &&
    a.isStreaming === b.isStreaming &&
    a.createdAt === b.createdAt &&
    areToolChipsEqual(a.toolChips, b.toolChips) &&
    areAttachmentsEqual(a.attachments, b.attachments) &&
    areMentionRefsEqual(a.mentions, b.mentions) &&
    areMentionRefsEqual(a.inferredMentions, b.inferredMentions)
  );
}

function areActivitiesEqual(
  a: readonly WorkerActivityEntry[],
  b: readonly WorkerActivityEntry[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.kind !== y.kind ||
      x.title !== y.title ||
      x.detail !== y.detail ||
      x.timestamp !== y.timestamp
    ) {
      return false;
    }
  }
  return true;
}

export function areAgentTasksEqual(a: AgentTask, b: AgentTask): boolean {
  if (a === b) return true;
  return (
    a.id === b.id &&
    a.taskNumber === b.taskNumber &&
    a.title === b.title &&
    a.summary === b.summary &&
    a.projectId === b.projectId &&
    a.projectName === b.projectName &&
    a.projectPath === b.projectPath &&
    a.status === b.status &&
    a.provider === b.provider &&
    a.autoResumeOnStartup === b.autoResumeOnStartup &&
    a.workerPrompt === b.workerPrompt &&
    a.lastWorkerPrompt === b.lastWorkerPrompt &&
    a.workerModel === b.workerModel &&
    a.workerEffort === b.workerEffort &&
    a.currentStep === b.currentStep &&
    a.workerThreadId === b.workerThreadId &&
    a.activeTurnId === b.activeTurnId &&
    a.previewURL === b.previewURL &&
    a.latestOutput === b.latestOutput &&
    a.worktreePath === b.worktreePath &&
    a.worktreeBranch === b.worktreeBranch &&
    a.baseBranch === b.baseBranch &&
    a.baseCommit === b.baseCommit &&
    a.landStatus === b.landStatus &&
    a.landedBranch === b.landedBranch &&
    a.landedCommit === b.landedCommit &&
    a.prUrl === b.prUrl &&
    a.landError === b.landError &&
    a.conflictParentHead === b.conflictParentHead &&
    a.conflictTargetBranch === b.conflictTargetBranch &&
    a.autoResolveConflictAttempts === b.autoResolveConflictAttempts &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt &&
    areStringArraysEqual(a.conflictFiles, b.conflictFiles) &&
    areActivitiesEqual(a.activities, b.activities)
  );
}

export function areProjectsEqual(a: Project, b: Project): boolean {
  if (a === b) return true;
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.path === b.path &&
    a.colorHex === b.colorHex &&
    a.gitBranch === b.gitBranch &&
    a.integrationMode === b.integrationMode &&
    a.addedAt === b.addedAt &&
    a.lastActiveAt === b.lastActiveAt &&
    a.source === b.source
  );
}

export function areBrowserTabsEqual(a: BrowserTab, b: BrowserTab): boolean {
  if (a === b) return true;
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.url === b.url &&
    a.projectId === b.projectId &&
    a.isLoading === b.isLoading &&
    a.canGoBack === b.canGoBack &&
    a.canGoForward === b.canGoForward &&
    a.consoleErrorCount === b.consoleErrorCount &&
    a.networkErrorCount === b.networkErrorCount
  );
}

function areChatSessionSummariesEqual(a: ChatSessionSummary, b: ChatSessionSummary): boolean {
  if (a === b) return true;
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.preview === b.preview &&
    a.messageCount === b.messageCount &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt &&
    a.provider === b.provider
  );
}

function areModelOptionsEqual(a: ModelOption, b: ModelOption): boolean {
  if (a === b) return true;
  return (
    a.id === b.id &&
    a.model === b.model &&
    a.displayName === b.displayName &&
    a.description === b.description &&
    a.defaultEffort === b.defaultEffort &&
    a.isDefault === b.isDefault &&
    areStringArraysEqual(a.supportedEfforts, b.supportedEfforts)
  );
}

function areUsageRecordsEqual(a: UsageRecord, b: UsageRecord): boolean {
  if (a === b) return true;
  return (
    a.id === b.id &&
    a.timestamp === b.timestamp &&
    a.provider === b.provider &&
    a.model === b.model &&
    a.source === b.source &&
    a.projectName === b.projectName &&
    a.taskId === b.taskId &&
    a.inputTokens === b.inputTokens &&
    a.cachedInputTokens === b.cachedInputTokens &&
    a.cacheCreationInputTokens === b.cacheCreationInputTokens &&
    a.outputTokens === b.outputTokens &&
    a.reasoningTokens === b.reasoningTokens &&
    a.costUsd === b.costUsd &&
    a.isEstimated === b.isEstimated &&
    a.turnCount === b.turnCount
  );
}

function areUsageBudgetsEqual(
  a: UsageBudgetSettings | undefined,
  b: UsageBudgetSettings | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.weekly.unit === b.weekly.unit &&
    a.weekly.limit === b.weekly.limit &&
    a.monthly.unit === b.monthly.unit &&
    a.monthly.limit === b.monthly.limit
  );
}

function areProviderQuotaSnapshotsEqual(
  a: ProviderQuotaSnapshot | undefined,
  b: ProviderQuotaSnapshot | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (
    a.provider !== b.provider ||
    a.status !== b.status ||
    a.planType !== b.planType ||
    a.limitName !== b.limitName ||
    a.updatedAt !== b.updatedAt ||
    a.note !== b.note ||
    a.windows.length !== b.windows.length
  ) {
    return false;
  }
  if (a.credits !== b.credits) {
    if (!a.credits || !b.credits) return false;
    if (
      a.credits.hasCredits !== b.credits.hasCredits ||
      a.credits.unlimited !== b.credits.unlimited ||
      a.credits.balance !== b.credits.balance
    ) {
      return false;
    }
  }
  for (let i = 0; i < a.windows.length; i += 1) {
    const wa = a.windows[i];
    const wb = b.windows[i];
    if (
      wa.id !== wb.id ||
      wa.windowDurationMins !== wb.windowDurationMins ||
      wa.usedPercent !== wb.usedPercent ||
      wa.remainingPercent !== wb.remainingPercent ||
      wa.resetsAt !== wb.resetsAt
    ) {
      return false;
    }
  }
  return true;
}

function areProviderQuotasMapEqual(
  a: ProviderQuotasMap | undefined,
  b: ProviderQuotasMap | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    areProviderQuotaSnapshotsEqual(a.codex, b.codex) &&
    areProviderQuotaSnapshotsEqual(a.agy, b.agy) &&
    areProviderQuotaSnapshotsEqual(a.claude, b.claude)
  );
}

function areRemoteAccessEqual(
  a: RemoteAccessStatus | undefined,
  b: RemoteAccessStatus | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.enabled === b.enabled &&
    a.running === b.running &&
    a.port === b.port &&
    a.token === b.token &&
    a.bindHost === b.bindHost &&
    a.tailscaleIp === b.tailscaleIp &&
    a.magicDnsName === b.magicDnsName &&
    a.lanIp === b.lanIp &&
    a.url === b.url &&
    a.tailscaleUrl === b.tailscaleUrl &&
    a.magicDnsUrl === b.magicDnsUrl &&
    a.lanUrl === b.lanUrl &&
    a.connectUri === b.connectUri &&
    a.linkUri === b.linkUri &&
    a.connectedClients === b.connectedClients &&
    a.error === b.error
  );
}

function reconcileKeyedArray<T extends { id: string }>(
  prev: T[],
  next: T[],
  isEqual: (a: T, b: T) => boolean,
): T[] {
  if (prev === next) return prev;
  if (prev.length === 0 && next.length === 0) return prev;

  // Defensively deduplicate incoming items with identical IDs (keeping the latest entry)
  // so React keys never collide or glitch in chat/task lists.
  let dedupedNext = next;
  const seenIndex = new Map<string, number>();
  let hasDuplicates = false;
  for (let i = 0; i < next.length; i += 1) {
    const id = next[i].id;
    if (seenIndex.has(id)) {
      hasDuplicates = true;
      break;
    }
    seenIndex.set(id, i);
  }
  if (hasDuplicates) {
    const lastIndexById = new Map<string, number>();
    for (let i = 0; i < next.length; i += 1) {
      lastIndexById.set(next[i].id, i);
    }
    dedupedNext = next.filter((item, idx) => lastIndexById.get(item.id) === idx);
  }

  const prevById = new Map<string, T>();
  for (const item of prev) {
    prevById.set(item.id, item);
  }

  let allSame = prev.length === dedupedNext.length;
  const result = new Array<T>(dedupedNext.length);

  for (let i = 0; i < dedupedNext.length; i += 1) {
    const nextItem = dedupedNext[i];
    const prevItem = prevById.get(nextItem.id);
    if (prevItem && isEqual(prevItem, nextItem)) {
      result[i] = prevItem;
      if (allSame && prev[i] !== prevItem) {
        allSame = false;
      }
    } else {
      result[i] = nextItem;
      allSame = false;
    }
  }

  return allSame ? prev : result;
}

function reconcileProviderStatus(prev: ProviderStatus, next: ProviderStatus): ProviderStatus {
  const models = reconcileKeyedArray(prev.models, next.models, areModelOptionsEqual);
  if (
    prev.id === next.id &&
    prev.label === next.label &&
    prev.available === next.available &&
    prev.detail === next.detail &&
    models === prev.models
  ) {
    return prev;
  }
  return models === next.models ? next : { ...next, models };
}

function reconcileProviders(
  prev: Record<AgentProvider, ProviderStatus>,
  next: Record<AgentProvider, ProviderStatus>,
): Record<AgentProvider, ProviderStatus> {
  if (prev === next) return prev;
  const codex = reconcileProviderStatus(prev.codex, next.codex);
  const agy = reconcileProviderStatus(prev.agy, next.agy);
  const claude = reconcileProviderStatus(prev.claude, next.claude);
  if (codex === prev.codex && agy === prev.agy && claude === prev.claude) {
    return prev;
  }
  return { codex, agy, claude };
}

/**
 * Reconciles an incoming IPC-deserialized `AppSnapshot` with the previous snapshot
 * via structural sharing so unchanged messages, tasks, projects, browser tabs, and
 * top-level arrays preserve referential identity (preventing unnecessary React
 * re-renders and Markdown/Mermaid re-parsing across untouched history items).
 */
export function reconcileAppSnapshot(
  prev: AppSnapshot | null,
  next: AppSnapshot,
): AppSnapshot {
  if (!next) return prev as AppSnapshot;
  if (!prev || prev === next) return next;

  // Reject stale out-of-order snapshots from the same controller instance
  // (e.g., an initial getSnapshot() promise resolving after a newer onSnapshot push).
  if (
    prev.snapshotEpoch &&
    next.snapshotEpoch &&
    prev.snapshotEpoch === next.snapshotEpoch &&
    typeof prev.snapshotVersion === "number" &&
    typeof next.snapshotVersion === "number" &&
    next.snapshotVersion < prev.snapshotVersion
  ) {
    return prev;
  }

  const projects = reconcileKeyedArray(prev.projects, next.projects, areProjectsEqual);
  const scanRoots = areStringArraysEqual(prev.scanRoots, next.scanRoots)
    ? prev.scanRoots
    : next.scanRoots;
  const tasks = reconcileKeyedArray(prev.tasks, next.tasks, areAgentTasksEqual);
  const messages = reconcileKeyedArray(prev.messages, next.messages, areChatMessagesEqual);
  const chatSessions = reconcileKeyedArray(
    prev.chatSessions,
    next.chatSessions,
    areChatSessionSummariesEqual,
  );
  const browserTabs = reconcileKeyedArray(
    prev.browserTabs,
    next.browserTabs,
    areBrowserTabsEqual,
  );
  const providers = reconcileProviders(prev.providers, next.providers);
  const models = reconcileKeyedArray(prev.models, next.models, areModelOptionsEqual);
  const remoteAccess = areRemoteAccessEqual(prev.remoteAccess, next.remoteAccess)
    ? prev.remoteAccess
    : next.remoteAccess;
  const usageRecords =
    prev.usageRecords && next.usageRecords
      ? reconcileKeyedArray(prev.usageRecords, next.usageRecords, areUsageRecordsEqual)
      : prev.usageRecords === next.usageRecords
        ? prev.usageRecords
        : next.usageRecords;
  const usageBudgets = areUsageBudgetsEqual(prev.usageBudgets, next.usageBudgets)
    ? prev.usageBudgets
    : next.usageBudgets;
  const providerQuotas = areProviderQuotasMapEqual(prev.providerQuotas, next.providerQuotas)
    ? prev.providerQuotas
    : next.providerQuotas;

  const unchanged =
    prev.snapshotEpoch === next.snapshotEpoch &&
    projects === prev.projects &&
    scanRoots === prev.scanRoots &&
    tasks === prev.tasks &&
    messages === prev.messages &&
    prev.activeChatSessionId === next.activeChatSessionId &&
    chatSessions === prev.chatSessions &&
    browserTabs === prev.browserTabs &&
    prev.activeBrowserTabId === next.activeBrowserTabId &&
    prev.isPickingElement === next.isPickingElement &&
    prev.showTaskSidebar === next.showTaskSidebar &&
    prev.showBrowserPane === next.showBrowserPane &&
    prev.isConnected === next.isConnected &&
    prev.connectionStatus === next.connectionStatus &&
    prev.activeResponderCount === next.activeResponderCount &&
    providers === prev.providers &&
    prev.chatProvider === next.chatProvider &&
    prev.workerProvider === next.workerProvider &&
    models === prev.models &&
    prev.chatModel === next.chatModel &&
    prev.chatEffort === next.chatEffort &&
    prev.workerModel === next.workerModel &&
    prev.workerEffort === next.workerEffort &&
    prev.defaultIntegrationMode === next.defaultIntegrationMode &&
    prev.autoLandOnComplete === next.autoLandOnComplete &&
    prev.preferredLanguage === next.preferredLanguage &&
    prev.voiceReadbackEnabled === next.voiceReadbackEnabled &&
    prev.remoteAccessEnabled === next.remoteAccessEnabled &&
    prev.remoteAccessPort === next.remoteAccessPort &&
    prev.remoteAccessToken === next.remoteAccessToken &&
    remoteAccess === prev.remoteAccess &&
    usageRecords === prev.usageRecords &&
    usageBudgets === prev.usageBudgets &&
    providerQuotas === prev.providerQuotas &&
    prev.lastErrorBanner === next.lastErrorBanner;

  if (unchanged) {
    return prev;
  }

  return {
    ...next,
    projects,
    scanRoots,
    tasks,
    messages,
    chatSessions,
    browserTabs,
    providers,
    models,
    remoteAccess,
    usageRecords,
    usageBudgets,
    providerQuotas,
  };
}
