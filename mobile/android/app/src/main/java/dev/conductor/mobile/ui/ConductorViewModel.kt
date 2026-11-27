package dev.conductor.mobile.ui

import android.app.Application
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.conductor.mobile.BuildConfig
import dev.conductor.mobile.data.AndroidImageAttachmentProcessor
import dev.conductor.mobile.data.ApkInstallLaunchResult
import dev.conductor.mobile.data.ApkInstaller
import dev.conductor.mobile.data.AppUpdateClient
import dev.conductor.mobile.data.AttachmentByteCache
import dev.conductor.mobile.data.ConductorApiClient
import dev.conductor.mobile.data.ConnectionStore
import dev.conductor.mobile.data.ConnectionTestResult
import dev.conductor.mobile.data.ImageAttachmentLogic
import dev.conductor.mobile.data.ReleaseFetchResult
import dev.conductor.mobile.data.SseEvent
import dev.conductor.mobile.model.AppSnapshot
import dev.conductor.mobile.model.AppUpdateErrorCode
import dev.conductor.mobile.model.AppUpdateLogic
import dev.conductor.mobile.model.AppUpdateState
import dev.conductor.mobile.model.AppUpdateStatus
import dev.conductor.mobile.model.ConnectUriParser
import dev.conductor.mobile.model.ConnectionConfig
import dev.conductor.mobile.model.CurrentBuildInfo
import dev.conductor.mobile.model.ExplicitMentionTarget
import dev.conductor.mobile.model.GITHUB_LATEST_RELEASE_PAGE_URL
import dev.conductor.mobile.model.PendingImageAttachment
import dev.conductor.mobile.model.StreamTransportState
import dev.conductor.mobile.model.TaskDetailResponse
import dev.conductor.mobile.model.TaskStatusActions
import dev.conductor.mobile.model.ThemeMode
import dev.conductor.mobile.ui.components.ConductorImageLoader
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File

data class UiBanner(
    val id: Long,
    val message: String,
    val actionLabel: String? = null,
    val undoTaskId: String? = null,
    val undoStatus: String? = null,
)

data class ConductorUiState(
    val isLoaded: Boolean = false,
    val config: ConnectionConfig = ConnectionConfig(),
    val themeMode: ThemeMode = ThemeMode.SYSTEM,
    val groupTasksByProject: Boolean = false,
    val transportState: StreamTransportState = StreamTransportState.DISCONNECTED,
    val transportDetail: String = "未接続",
    val snapshot: AppSnapshot? = null,
    val composerText: String = "",
    val selectedMentions: List<ExplicitMentionTarget> = emptyList(),
    val pendingAttachments: List<PendingImageAttachment> = emptyList(),
    val isProcessingImages: Boolean = false,
    val isSending: Boolean = false,
    val selectedTaskId: String? = null,
    val selectedTaskDetail: TaskDetailResponse? = null,
    val isLoadingTaskDetail: Boolean = false,
    val updatingTaskIds: Set<String> = emptySet(),
    val landingTaskIds: Set<String> = emptySet(),
    val isTestingConnection: Boolean = false,
    val lastTestResult: ConnectionTestResult? = null,
    val pendingDeepLinkConfig: ConnectionConfig? = null,
    val banner: UiBanner? = null,
    val appUpdate: AppUpdateState = AppUpdateState(),
)

class ConductorViewModel(application: Application) : AndroidViewModel(application) {
    private val appContext = application.applicationContext
    private val store = ConnectionStore(appContext)
    private val api = ConductorApiClient()
    private val imageProcessor = AndroidImageAttachmentProcessor(appContext)
    private val attachmentImageCache = AttachmentByteCache()
    val imageLoader = ConductorImageLoader(api)

    private val currentBuildInfo = CurrentBuildInfo(
        versionName = BuildConfig.VERSION_NAME,
        versionCode = BuildConfig.VERSION_CODE,
        buildTag = BuildConfig.BUILD_TAG.takeIf { it.isNotBlank() },
        commitSha = BuildConfig.BUILD_COMMIT_SHA.takeIf { it.isNotBlank() },
        runNumber = BuildConfig.BUILD_RUN_NUMBER.takeIf { it > 0 },
    )
    private val updateClient = AppUpdateClient(
        userAgentVersion = BuildConfig.VERSION_NAME,
        supportedAbis = Build.SUPPORTED_ABIS.toList(),
    )

    private val _uiState = MutableStateFlow(
        ConductorUiState(
            appUpdate = AppUpdateState(currentBuild = currentBuildInfo),
        ),
    )
    val uiState: StateFlow<ConductorUiState> = _uiState.asStateFlow()

    private var streamJob: Job? = null
    private var streamingSyncJob: Job? = null
    private var updateCheckJob: Job? = null
    private var updateDownloadJob: Job? = null
    private var activeSyncConfig: ConnectionConfig? = null
    private var lastSnapshotReceivedAtMs: Long = 0L
    private var nextBannerId: Long = 1L
    private val reconnectSignal = MutableSharedFlow<Unit>(extraBufferCapacity = 1)

    init {
        viewModelScope.launch {
            store.themeModeFlow
                .distinctUntilChanged()
                .collect { mode ->
                    _uiState.update { it.copy(themeMode = mode) }
                }
        }
        viewModelScope.launch {
            store.groupTasksByProjectFlow
                .distinctUntilChanged()
                .collect { grouped ->
                    _uiState.update { it.copy(groupTasksByProject = grouped) }
                }
        }
        viewModelScope.launch {
            store.configFlow
                .distinctUntilChanged()
                .collect { saved ->
                    val prev = _uiState.value.config
                    _uiState.update { it.copy(isLoaded = true, config = saved) }
                    if (saved.isConfigured) {
                        if (saved != prev || streamJob?.isActive != true) {
                            startRealtimeSync(saved)
                        }
                    } else {
                        stopRealtimeSync()
                        _uiState.update {
                            it.copy(
                                transportState = StreamTransportState.DISCONNECTED,
                                transportDetail = "未接続",
                                snapshot = null,
                            )
                        }
                    }
                }
        }
        // Lightweight background check on startup (never disturbs user if offline/error)
        viewModelScope.launch {
            delay(1_200L)
            checkForUpdates(silent = true)
        }
    }

    fun setThemeMode(mode: ThemeMode) {
        _uiState.update { it.copy(themeMode = mode) }
        viewModelScope.launch {
            store.saveThemeMode(mode)
        }
    }

    fun toggleGroupTasksByProject() {
        val next = !_uiState.value.groupTasksByProject
        _uiState.update { it.copy(groupTasksByProject = next) }
        viewModelScope.launch {
            store.saveGroupTasksByProject(next)
        }
    }

    fun handleIncomingConnectUri(rawUri: String): Boolean {
        val parsed = ConnectUriParser.parse(rawUri) ?: run {
            showBanner("無効なリンク形式です（Step 2 の QR または接続 URI を使用してください）")
            return false
        }
        viewModelScope.launch {
            val sameConfig = parsed == _uiState.value.config
            store.save(parsed)
            _uiState.update {
                it.copy(
                    pendingDeepLinkConfig = parsed,
                    lastTestResult = null,
                )
            }
            showBanner("デスクトップとリンクしました (${parsed.serverUrl})")
            if (sameConfig) {
                startRealtimeSync(parsed)
            }
        }
        return true
    }

    fun consumePendingDeepLink() {
        _uiState.update { it.copy(pendingDeepLinkConfig = null) }
    }

    fun showMessage(message: String) {
        showBanner(message)
    }

    fun clearBanner(id: Long? = null) {
        _uiState.update { state ->
            if (id == null || state.banner?.id == id) state.copy(banner = null) else state
        }
    }

    private fun showBanner(
        message: String,
        actionLabel: String? = null,
        undoTaskId: String? = null,
        undoStatus: String? = null,
    ) {
        val id = nextBannerId++
        _uiState.update {
            it.copy(
                banner = UiBanner(
                    id = id,
                    message = message,
                    actionLabel = actionLabel,
                    undoTaskId = undoTaskId,
                    undoStatus = undoStatus,
                ),
            )
        }
    }

    fun testConnection(serverUrl: String, bearerToken: String) {
        val normalized = ConnectionConfig(
            serverUrl = ConnectUriParser.normalizeServerUrl(serverUrl),
            bearerToken = bearerToken.trim(),
        )
        viewModelScope.launch {
            _uiState.update { it.copy(isTestingConnection = true, lastTestResult = null) }
            val result = api.testConnection(normalized)
            _uiState.update {
                it.copy(
                    isTestingConnection = false,
                    lastTestResult = result,
                )
            }
        }
    }

    fun saveAndConnect(serverUrl: String, bearerToken: String) {
        val normalized = ConnectionConfig(
            serverUrl = ConnectUriParser.normalizeServerUrl(serverUrl),
            bearerToken = bearerToken.trim(),
        )
        if (!normalized.isConfigured) {
            showBanner("URL と Bearer Token を入力してください")
            return
        }
        viewModelScope.launch {
            val sameConfig = normalized == _uiState.value.config
            store.save(normalized)
            _uiState.update { it.copy(lastTestResult = null) }
            showBanner("接続設定を保存しました")
            if (sameConfig) {
                startRealtimeSync(normalized)
            }
        }
    }

    fun reconnect() {
        val cfg = _uiState.value.config
        if (!cfg.isConfigured) return
        startRealtimeSync(cfg)
        showBanner("再接続しています...")
    }

    fun onAppForegrounded() {
        resumePendingApkInstallIfPermitted()
        val cfg = _uiState.value.config
        if (!cfg.isConfigured) return
        val transport = _uiState.value.transportState
        val staleMs = System.currentTimeMillis() - lastSnapshotReceivedAtMs
        if (transport != StreamTransportState.CONNECTED_SSE || staleMs > 25_000L) {
            viewModelScope.launch {
                api.fetchSnapshot(cfg).onSuccess { snap ->
                    applyIncomingSnapshot(snap, fromSse = false)
                }
            }
            if (transport != StreamTransportState.CONNECTED_SSE) {
                nudgeRealtimeSync(cfg)
            }
        }
    }

    fun disconnect() {
        stopRealtimeSync()
        attachmentImageCache.clear()
        imageLoader.clear()
        viewModelScope.launch {
            store.clear()
            _uiState.update {
                it.copy(
                    snapshot = null,
                    selectedTaskId = null,
                    selectedTaskDetail = null,
                    updatingTaskIds = emptySet(),
                    landingTaskIds = emptySet(),
                    selectedMentions = emptyList(),
                    pendingAttachments = emptyList(),
                    isProcessingImages = false,
                    transportState = StreamTransportState.DISCONNECTED,
                    transportDetail = "切断済み",
                )
            }
            showBanner("接続を解除しました")
        }
    }

    private fun stopRealtimeSync() {
        streamJob?.cancel()
        streamJob = null
        streamingSyncJob?.cancel()
        streamingSyncJob = null
        activeSyncConfig = null
    }

    private fun nudgeRealtimeSync(config: ConnectionConfig) {
        if (streamJob?.isActive == true && activeSyncConfig == config) {
            reconnectSignal.tryEmit(Unit)
        } else {
            startRealtimeSync(config)
        }
    }

    private fun applyIncomingSnapshot(snap: AppSnapshot, fromSse: Boolean) {
        lastSnapshotReceivedAtMs = System.currentTimeMillis()
        _uiState.update { state ->
            state.copy(
                snapshot = snap,
                transportState = if (fromSse) StreamTransportState.CONNECTED_SSE else state.transportState,
                transportDetail = if (fromSse) "SSE リアルタイム接続中" else state.transportDetail,
            )
        }
        val hasStreaming = snap.activeResponderCount > 0 || snap.messages.any { it.isStreaming }
        if (hasStreaming) {
            val cfg = activeSyncConfig ?: _uiState.value.config
            if (cfg.isConfigured) {
                ensureStreamingSync(cfg)
            }
        } else {
            streamingSyncJob?.cancel()
            streamingSyncJob = null
        }
    }

    /**
     * Safety net while an assistant response is actively streaming:
     * if SSE stalls or is temporarily reconnecting, poll /api/snapshot so responses always appear promptly.
     */
    private fun ensureStreamingSync(config: ConnectionConfig) {
        if (streamingSyncJob?.isActive == true) return
        streamingSyncJob = viewModelScope.launch {
            while (isActive) {
                delay(1_500L)
                val current = _uiState.value.snapshot
                val stillStreaming = current == null ||
                    current.activeResponderCount > 0 ||
                    current.messages.any { it.isStreaming }
                if (!stillStreaming) break

                val sinceLastMs = System.currentTimeMillis() - lastSnapshotReceivedAtMs
                val sseConnected = _uiState.value.transportState == StreamTransportState.CONNECTED_SSE
                if (!sseConnected || sinceLastMs >= 2_500L) {
                    api.fetchSnapshot(config).onSuccess { snap ->
                        applyIncomingSnapshot(snap, fromSse = false)
                    }
                }
            }
            streamingSyncJob = null
        }
    }

    private fun startRealtimeSync(config: ConnectionConfig) {
        stopRealtimeSync()
        activeSyncConfig = config
        streamJob = viewModelScope.launch {
            var backoffMs = 1_000L
            while (isActive) {
                _uiState.update {
                    it.copy(
                        transportState = StreamTransportState.CONNECTING,
                        transportDetail = "接続中...",
                    )
                }

                var unauthorized = false
                var receivedSnapshotInSession = false
                // Server immediately pushes the initial snapshot on SSE connect,
                // avoiding a duplicate full /api/snapshot transfer before opening SSE.
                api.openSnapshotSse(config).collect { event ->
                    when (event) {
                        is SseEvent.Opened -> {
                            backoffMs = 1_000L
                            _uiState.update {
                                it.copy(
                                    transportState = StreamTransportState.CONNECTED_SSE,
                                    transportDetail = "SSE リアルタイム接続中",
                                )
                            }
                        }

                        is SseEvent.SnapshotReceived -> {
                            backoffMs = 1_000L
                            receivedSnapshotInSession = true
                            applyIncomingSnapshot(event.snapshot, fromSse = true)
                        }

                        is SseEvent.Disconnected -> {
                            unauthorized = event.unauthorized
                            _uiState.update {
                                it.copy(
                                    transportState = if (unauthorized) {
                                        StreamTransportState.ERROR
                                    } else {
                                        StreamTransportState.CONNECTED_POLLING
                                    },
                                    transportDetail = event.reason,
                                )
                            }
                        }
                    }
                }

                if (unauthorized) {
                    // Do not spin-retry on invalid Bearer token
                    break
                }

                // Fallback poll once before retrying SSE
                api.fetchSnapshot(config)
                    .onSuccess { snap ->
                        applyIncomingSnapshot(snap, fromSse = false)
                        _uiState.update {
                            it.copy(
                                transportState = StreamTransportState.CONNECTED_POLLING,
                                transportDetail = "ポーリング同期中（SSE 再接続待機）",
                            )
                        }
                    }
                    .onFailure { err ->
                        _uiState.update {
                            it.copy(
                                transportState = StreamTransportState.ERROR,
                                transportDetail = err.message ?: "再接続中...",
                            )
                        }
                    }

                val waitMs = if (receivedSnapshotInSession) 1_000L else backoffMs
                withTimeoutOrNull(waitMs) {
                    reconnectSignal.first()
                }
                backoffMs = (backoffMs * 2).coerceAtMost(8_000L)
            }
        }
    }

    // --- Chat Composer & Actions ---

    fun updateComposerText(text: String) {
        _uiState.update { it.copy(composerText = text) }
    }

    fun addMention(target: ExplicitMentionTarget) {
        _uiState.update { state ->
            if (state.selectedMentions.any { it.uniqueKey() == target.uniqueKey() }) {
                state
            } else {
                state.copy(selectedMentions = state.selectedMentions + target)
            }
        }
    }

    fun removeMention(target: ExplicitMentionTarget) {
        _uiState.update { state ->
            state.copy(
                selectedMentions = state.selectedMentions.filterNot {
                    it.uniqueKey() == target.uniqueKey()
                },
            )
        }
    }

    fun addImageUris(uris: List<Uri>) {
        if (uris.isEmpty()) return
        val existingCount = _uiState.value.pendingAttachments.size
        val remaining = ImageAttachmentLogic.MAX_ATTACHMENTS - existingCount
        if (remaining <= 0) {
            showBanner("画像は最大 ${ImageAttachmentLogic.MAX_ATTACHMENTS} 枚まで添付できます")
            return
        }
        val toProcess = uris.take(remaining)
        val truncated = uris.size > remaining

        viewModelScope.launch {
            _uiState.update { it.copy(isProcessingImages = true) }
            val added = mutableListOf<PendingImageAttachment>()
            var failureCount = 0
            toProcess.forEachIndexed { idx, uri ->
                val result = imageProcessor.processUri(
                    uri = uri,
                    fallbackIndex = existingCount + idx + 1,
                )
                result
                    .onSuccess { attachment ->
                        attachmentImageCache.put(attachment.id, attachment.previewBytes)
                        added.add(attachment)
                    }
                    .onFailure { err ->
                        Log.w("ConductorImage", "Failed to process image URI: $uri", err)
                        failureCount += 1
                    }
            }
            val bannerText = when {
                failureCount > 0 && added.isEmpty() -> "画像の読み込みに失敗しました"
                failureCount > 0 -> "${added.size}枚の画像を添付しました（${failureCount}枚は読み込み失敗）"
                truncated -> "画像は最大 ${ImageAttachmentLogic.MAX_ATTACHMENTS} 枚まで添付できます（先頭${added.size}枚を追加）"
                else -> null
            }
            _uiState.update { state ->
                state.copy(
                    pendingAttachments = state.pendingAttachments + added,
                    isProcessingImages = false,
                )
            }
            if (bannerText != null) {
                showBanner(bannerText)
            }
        }
    }

    fun removePendingAttachment(attachmentId: String) {
        _uiState.update { state ->
            state.copy(
                pendingAttachments = state.pendingAttachments.filterNot { it.id == attachmentId },
            )
        }
    }

    fun getCachedAttachmentImageBytes(attachmentId: String): ByteArray? =
        attachmentImageCache.get(attachmentId)

    suspend fun loadAttachmentImageBytes(attachmentId: String): ByteArray? {
        if (attachmentId.isBlank()) return null
        attachmentImageCache.get(attachmentId)?.let { return it }
        val cfg = _uiState.value.config
        if (!cfg.isConfigured) return null
        return api.fetchAttachmentImage(cfg, attachmentId)
            .onSuccess { bytes ->
                attachmentImageCache.put(attachmentId, bytes)
            }
            .getOrNull()
    }

    fun sendChatMessage() {
        val state = _uiState.value
        val text = state.composerText.trim()
        val pendingImages = state.pendingAttachments
        if ((text.isBlank() && pendingImages.isEmpty()) ||
            !state.config.isConfigured ||
            state.isSending ||
            state.isProcessingImages
        ) {
            return
        }
        val mentions = state.selectedMentions
        val cfg = state.config
        val chatAttachments = pendingImages.map { att ->
            attachmentImageCache.put(att.id, att.previewBytes)
            att.toChatAttachment()
        }
        _uiState.update {
            it.copy(
                composerText = "",
                selectedMentions = emptyList(),
                pendingAttachments = emptyList(),
                isSending = true,
            )
        }
        viewModelScope.launch {
            api.sendMessage(cfg, text, mentions, chatAttachments)
                .onSuccess { res ->
                    if (res.snapshot != null) {
                        applyIncomingSnapshot(res.snapshot, fromSse = false)
                    } else {
                        api.fetchSnapshot(cfg).onSuccess { snap ->
                            applyIncomingSnapshot(snap, fromSse = false)
                        }
                    }
                    ensureStreamingSync(cfg)
                    if (_uiState.value.transportState != StreamTransportState.CONNECTED_SSE) {
                        nudgeRealtimeSync(cfg)
                    }
                }
                .onFailure { err ->
                    _uiState.update {
                        it.copy(
                            composerText = text,
                            selectedMentions = mentions,
                            pendingAttachments = pendingImages,
                        )
                    }
                    showBanner("送信エラー: ${err.message}")
                }
            _uiState.update { it.copy(isSending = false) }
        }
    }

    fun stopChat(messageId: String? = null) {
        val cfg = _uiState.value.config
        if (!cfg.isConfigured) return
        viewModelScope.launch {
            api.stopChat(cfg, messageId)
                .onSuccess { res ->
                    res.snapshot?.let { applyIncomingSnapshot(it, fromSse = false) }
                }
                .onFailure { err ->
                    showBanner("停止エラー: ${err.message}")
                }
        }
    }

    fun startNewChat() {
        val cfg = _uiState.value.config
        if (!cfg.isConfigured) return
        viewModelScope.launch {
            api.newChat(cfg)
                .onSuccess { res ->
                    res.snapshot?.let { applyIncomingSnapshot(it, fromSse = false) }
                    _uiState.update {
                        it.copy(
                            selectedMentions = emptyList(),
                            pendingAttachments = emptyList(),
                        )
                    }
                    showBanner("新しいチャットを開始しました")
                }
                .onFailure { err ->
                    showBanner("新規チャット作成エラー: ${err.message}")
                }
        }
    }

    // --- Task Actions ---

    fun openTaskDetail(taskId: String) {
        _uiState.update {
            it.copy(
                selectedTaskId = taskId,
                selectedTaskDetail = null,
                isLoadingTaskDetail = true,
            )
        }
        refreshTaskDetail(taskId)
    }

    fun closeTaskDetail() {
        _uiState.update {
            it.copy(
                selectedTaskId = null,
                selectedTaskDetail = null,
                isLoadingTaskDetail = false,
            )
        }
    }

    fun refreshTaskDetail(taskId: String) {
        val cfg = _uiState.value.config
        if (!cfg.isConfigured) return
        viewModelScope.launch {
            api.getTaskDetail(cfg, taskId)
                .onSuccess { detail ->
                    if (_uiState.value.selectedTaskId == taskId) {
                        _uiState.update {
                            it.copy(selectedTaskDetail = detail, isLoadingTaskDetail = false)
                        }
                    }
                }
                .onFailure {
                    if (_uiState.value.selectedTaskId == taskId) {
                        _uiState.update { it.copy(isLoadingTaskDetail = false) }
                    }
                }
        }
    }

    fun updateTaskStatus(taskId: String, nextStatus: String, isUndo: Boolean = false) {
        val state = _uiState.value
        val cfg = state.config
        if (!cfg.isConfigured || taskId in state.updatingTaskIds || taskId in state.landingTaskIds) {
            return
        }
        val currentTask = state.snapshot?.tasks?.find { it.id == taskId }
            ?: state.selectedTaskDetail?.task?.takeIf { it.id == taskId }
        if (nextStatus == TaskStatusActions.STATUS_DONE && currentTask != null) {
            TaskStatusActions.getMarkDoneBlockedReason(currentTask)?.let { blockedReason ->
                showBanner(blockedReason)
                return
            }
        }
        val previousStatus = currentTask?.status

        viewModelScope.launch {
            _uiState.update { it.copy(updatingTaskIds = it.updatingTaskIds + taskId) }
            try {
                api.updateTaskStatus(cfg, taskId, nextStatus)
                    .onSuccess { res ->
                        val updatedTask = res.task
                        _uiState.update { current ->
                            val nextSnapshot = TaskStatusActions.applyTaskUpdate(
                                snapshot = current.snapshot,
                                taskId = taskId,
                                updatedTask = updatedTask,
                                fallbackStatus = nextStatus,
                            )
                            val nextDetail = if (current.selectedTaskId == taskId && current.selectedTaskDetail != null) {
                                val patchedTask = updatedTask
                                    ?: current.selectedTaskDetail.task?.copy(status = nextStatus)
                                current.selectedTaskDetail.copy(task = patchedTask)
                            } else {
                                current.selectedTaskDetail
                            }
                            current.copy(
                                snapshot = nextSnapshot,
                                selectedTaskDetail = nextDetail,
                            )
                        }
                        val feedback = TaskStatusActions.formatStatusFeedback(
                            task = updatedTask ?: currentTask,
                            nextStatus = nextStatus,
                            isUndo = isUndo,
                        )
                        if (!isUndo &&
                            nextStatus == TaskStatusActions.STATUS_DONE &&
                            previousStatus != null &&
                            previousStatus != TaskStatusActions.STATUS_DONE
                        ) {
                            showBanner(
                                message = feedback,
                                actionLabel = "元に戻す",
                                undoTaskId = taskId,
                                undoStatus = previousStatus,
                            )
                        } else {
                            showBanner(feedback)
                        }
                        if (_uiState.value.selectedTaskId == taskId) {
                            refreshTaskDetail(taskId)
                        }
                        if (_uiState.value.transportState != StreamTransportState.CONNECTED_SSE) {
                            api.fetchSnapshot(cfg).onSuccess { snap ->
                                applyIncomingSnapshot(snap, fromSse = false)
                            }
                        }
                    }
                    .onFailure { err ->
                        showBanner(err.message ?: "ステータス更新に失敗しました")
                    }
            } finally {
                _uiState.update { it.copy(updatingTaskIds = it.updatingTaskIds - taskId) }
            }
        }
    }

    fun stopTask(taskId: String) {
        val state = _uiState.value
        val cfg = state.config
        if (!cfg.isConfigured || taskId in state.updatingTaskIds || taskId in state.landingTaskIds) {
            return
        }
        viewModelScope.launch {
            _uiState.update { it.copy(updatingTaskIds = it.updatingTaskIds + taskId) }
            try {
                api.stopTask(cfg, taskId)
                    .onSuccess { res ->
                        _uiState.update { current ->
                            current.copy(
                                snapshot = TaskStatusActions.applyTaskUpdate(
                                    snapshot = current.snapshot,
                                    taskId = taskId,
                                    updatedTask = res.task,
                                    fallbackStatus = TaskStatusActions.REOPEN_TARGET_STATUS,
                                ),
                            )
                        }
                        showBanner("ワーカーを停止しました")
                        if (_uiState.value.selectedTaskId == taskId) {
                            refreshTaskDetail(taskId)
                        }
                    }
                    .onFailure { err ->
                        showBanner(err.message ?: "停止に失敗しました")
                    }
            } finally {
                _uiState.update { it.copy(updatingTaskIds = it.updatingTaskIds - taskId) }
            }
        }
    }

    fun landTask(taskId: String, createPr: Boolean = false) {
        val state = _uiState.value
        val cfg = state.config
        if (!cfg.isConfigured || taskId in state.updatingTaskIds || taskId in state.landingTaskIds) {
            return
        }
        viewModelScope.launch {
            _uiState.update { it.copy(landingTaskIds = it.landingTaskIds + taskId) }
            try {
                api.landTask(cfg, taskId, createPr)
                    .onSuccess { res ->
                        showBanner(res.message ?: "Land が完了しました")
                        api.fetchSnapshot(cfg).onSuccess { snap ->
                            applyIncomingSnapshot(snap, fromSse = false)
                        }
                        if (_uiState.value.selectedTaskId == taskId) {
                            refreshTaskDetail(taskId)
                        }
                    }
                    .onFailure { err ->
                        showBanner(err.message ?: "Land に失敗しました")
                    }
            } finally {
                _uiState.update { it.copy(landingTaskIds = it.landingTaskIds - taskId) }
            }
        }
    }

    // --- App Update (GitHub Releases standalone check + in-app APK install) ---

    fun checkForUpdates(silent: Boolean = false) {
        val currentUpdate = _uiState.value.appUpdate
        if (currentUpdate.status == AppUpdateStatus.DOWNLOADING) return
        if (updateCheckJob?.isActive == true) return

        updateCheckJob = viewModelScope.launch {
            if (!silent) {
                _uiState.update { state ->
                    state.copy(
                        appUpdate = state.appUpdate.copy(
                            status = AppUpdateStatus.CHECKING,
                            errorMessage = null,
                            errorCode = null,
                        ),
                    )
                }
            }

            when (val result = updateClient.fetchLatestRelease()) {
                is ReleaseFetchResult.Success -> {
                    val release = result.release
                    val hasUpdate = AppUpdateLogic.isUpdateAvailable(
                        current = currentBuildInfo,
                        latestTag = release.tagName,
                        latestTargetCommitish = result.targetCommitish,
                    )
                    val checkedAtMs = System.currentTimeMillis()
                    _uiState.update { state ->
                        val prev = state.appUpdate
                        val downloadedFile = prev.downloadedApkPath?.let(::File)
                        val keepDownloaded = downloadedFile != null &&
                            downloadedFile.isFile &&
                            prev.latestRelease?.tagName == release.tagName

                        state.copy(
                            appUpdate = prev.copy(
                                status = when {
                                    keepDownloaded -> AppUpdateStatus.DOWNLOADED
                                    hasUpdate -> AppUpdateStatus.AVAILABLE
                                    else -> AppUpdateStatus.UP_TO_DATE
                                },
                                lastCheckedAtMs = checkedAtMs,
                                latestRelease = release,
                                updateAvailable = hasUpdate,
                                downloadProgress = if (keepDownloaded) prev.downloadProgress else null,
                                downloadedApkPath = if (keepDownloaded) prev.downloadedApkPath else null,
                                needsUnknownSourcesPermission = if (keepDownloaded) {
                                    prev.needsUnknownSourcesPermission
                                } else {
                                    false
                                },
                                errorMessage = null,
                                errorCode = null,
                                bannerDismissedForTag = if (prev.bannerDismissedForTag == release.tagName) {
                                    prev.bannerDismissedForTag
                                } else {
                                    null
                                },
                            ),
                        )
                    }
                }

                is ReleaseFetchResult.Failure -> {
                    if (silent) return@launch
                    val checkedAtMs = System.currentTimeMillis()
                    _uiState.update { state ->
                        state.copy(
                            appUpdate = state.appUpdate.copy(
                                status = AppUpdateStatus.ERROR,
                                lastCheckedAtMs = checkedAtMs,
                                errorMessage = result.message,
                                errorCode = result.errorCode,
                            ),
                        )
                    }
                }
            }
        }
    }

    fun downloadAndInstallUpdate() {
        val currentUpdate = _uiState.value.appUpdate
        if (currentUpdate.status == AppUpdateStatus.DOWNLOADING) return

        val release = currentUpdate.latestRelease
        val asset = release?.apkAsset
        if (release == null || asset == null) {
            _uiState.update { state ->
                state.copy(
                    appUpdate = state.appUpdate.copy(
                        status = AppUpdateStatus.ERROR,
                        errorCode = AppUpdateErrorCode.NO_ASSET,
                        errorMessage = "このリリースにはインストール可能な Android APK が含まれていません。",
                    ),
                )
            }
            return
        }

        // Reuse already downloaded APK for the exact same release tag if present
        val existingPath = currentUpdate.downloadedApkPath
        if (existingPath != null && File(existingPath).isFile) {
            installDownloadedApk()
            return
        }

        updateDownloadJob?.cancel()
        updateDownloadJob = viewModelScope.launch {
            val initialTotal = asset.size.takeIf { it > 0L }
            _uiState.update { state ->
                state.copy(
                    appUpdate = state.appUpdate.copy(
                        status = AppUpdateStatus.DOWNLOADING,
                        downloadProgress = dev.conductor.mobile.model.AppUpdateDownloadProgress(
                            downloadedBytes = 0L,
                            totalBytes = initialTotal,
                            percent = if (initialTotal != null) 0 else null,
                        ),
                        downloadedApkPath = null,
                        needsUnknownSourcesPermission = false,
                        errorMessage = null,
                        errorCode = null,
                    ),
                )
            }

            try {
                val downloadResult = updateClient.downloadApk(
                    asset = asset,
                    updatesDir = ApkInstaller.updatesDirectory(appContext),
                    onProgress = { progress ->
                        _uiState.update { state ->
                            if (state.appUpdate.status != AppUpdateStatus.DOWNLOADING) {
                                state
                            } else {
                                state.copy(
                                    appUpdate = state.appUpdate.copy(downloadProgress = progress),
                                )
                            }
                        }
                    },
                )

                downloadResult
                    .onSuccess { apkFile ->
                        _uiState.update { state ->
                            state.copy(
                                appUpdate = state.appUpdate.copy(
                                    status = AppUpdateStatus.DOWNLOADED,
                                    downloadedApkPath = apkFile.absolutePath,
                                    errorMessage = null,
                                    errorCode = null,
                                ),
                            )
                        }
                        launchApkInstaller(apkFile)
                    }
                    .onFailure { err ->
                        _uiState.update { state ->
                            state.copy(
                                appUpdate = state.appUpdate.copy(
                                    status = AppUpdateStatus.ERROR,
                                    downloadProgress = null,
                                    errorCode = AppUpdateErrorCode.DOWNLOAD_FAILED,
                                    errorMessage = err.message ?: "APK のダウンロードに失敗しました。",
                                ),
                            )
                        }
                    }
            } catch (_: CancellationException) {
                _uiState.update { state ->
                    val nextStatus = if (state.appUpdate.updateAvailable) {
                        AppUpdateStatus.AVAILABLE
                    } else {
                        AppUpdateStatus.UP_TO_DATE
                    }
                    state.copy(
                        appUpdate = state.appUpdate.copy(
                            status = nextStatus,
                            downloadProgress = null,
                            errorMessage = null,
                            errorCode = null,
                        ),
                    )
                }
            }
        }
    }

    fun cancelUpdateDownload() {
        updateClient.cancelDownload()
        updateDownloadJob?.cancel()
        updateDownloadJob = null
    }

    fun installDownloadedApk() {
        val path = _uiState.value.appUpdate.downloadedApkPath
        val file = path?.let(::File)
        if (file == null || !file.isFile) {
            _uiState.update { state ->
                state.copy(
                    appUpdate = state.appUpdate.copy(
                        status = if (state.appUpdate.updateAvailable) {
                            AppUpdateStatus.AVAILABLE
                        } else {
                            AppUpdateStatus.IDLE
                        },
                        downloadedApkPath = null,
                        needsUnknownSourcesPermission = false,
                        errorCode = AppUpdateErrorCode.INSTALL_FAILED,
                        errorMessage = "ダウンロード済みの APK が見つかりませんでした。もう一度ダウンロードしてください。",
                    ),
                )
            }
            return
        }
        launchApkInstaller(file)
    }

    fun openUnknownAppSourcesSettings() {
        ApkInstaller.openUnknownAppSourcesSettings(appContext)
            .onFailure { err ->
                showBanner("設定画面を開けませんでした: ${err.message ?: "不明なエラー"}")
            }
    }

    fun openReleasePage(url: String? = null) {
        val target = url?.takeIf { it.startsWith("https://github.com/", ignoreCase = true) }
            ?: _uiState.value.appUpdate.latestRelease?.htmlUrl
            ?: GITHUB_LATEST_RELEASE_PAGE_URL
        ApkInstaller.openReleasePage(appContext, target)
            .onFailure { err ->
                showBanner("リリースページを開けませんでした: ${err.message ?: "不明なエラー"}")
            }
    }

    fun dismissUpdateBanner() {
        val tag = _uiState.value.appUpdate.latestRelease?.tagName ?: return
        _uiState.update { state ->
            state.copy(
                appUpdate = state.appUpdate.copy(bannerDismissedForTag = tag),
            )
        }
    }

    private fun launchApkInstaller(apkFile: File) {
        when (val result = ApkInstaller.launchInstaller(appContext, apkFile)) {
            is ApkInstallLaunchResult.Launched -> {
                _uiState.update { state ->
                    state.copy(
                        appUpdate = state.appUpdate.copy(
                            status = AppUpdateStatus.DOWNLOADED,
                            needsUnknownSourcesPermission = false,
                            errorMessage = null,
                            errorCode = null,
                        ),
                    )
                }
            }

            is ApkInstallLaunchResult.PermissionRequired -> {
                _uiState.update { state ->
                    state.copy(
                        appUpdate = state.appUpdate.copy(
                            status = AppUpdateStatus.DOWNLOADED,
                            needsUnknownSourcesPermission = true,
                            errorCode = AppUpdateErrorCode.INSTALL_PERMISSION_REQUIRED,
                            errorMessage = "APK をインストールするには「不明なアプリのインストール」を許可してください。",
                        ),
                    )
                }
                showBanner("「不明なアプリのインストール」を許可してからインストールしてください")
                ApkInstaller.openUnknownAppSourcesSettings(appContext)
            }

            is ApkInstallLaunchResult.Failed -> {
                _uiState.update { state ->
                    state.copy(
                        appUpdate = state.appUpdate.copy(
                            status = AppUpdateStatus.DOWNLOADED,
                            needsUnknownSourcesPermission = false,
                            errorCode = AppUpdateErrorCode.INSTALL_FAILED,
                            errorMessage = result.message,
                        ),
                    )
                }
            }
        }
    }

    private fun resumePendingApkInstallIfPermitted() {
        val update = _uiState.value.appUpdate
        if (!update.needsUnknownSourcesPermission) return
        if (!ApkInstaller.canRequestPackageInstalls(appContext)) return
        val file = update.downloadedApkPath?.let(::File) ?: return
        if (!file.isFile) return
        launchApkInstaller(file)
    }

    override fun onCleared() {
        stopRealtimeSync()
        updateCheckJob?.cancel()
        updateDownloadJob?.cancel()
        updateClient.close()
        imageLoader.clear()
        api.close()
        super.onCleared()
    }
}
