package dev.conductor.mobile.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.conductor.mobile.data.ConductorApiClient
import dev.conductor.mobile.data.ConnectionStore
import dev.conductor.mobile.data.ConnectionTestResult
import dev.conductor.mobile.data.SseEvent
import dev.conductor.mobile.model.AppSnapshot
import dev.conductor.mobile.model.ConnectUriParser
import dev.conductor.mobile.model.ConnectionConfig
import dev.conductor.mobile.model.ExplicitMentionTarget
import dev.conductor.mobile.model.StreamTransportState
import dev.conductor.mobile.model.TaskDetailResponse
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

data class ConductorUiState(
    val isLoaded: Boolean = false,
    val config: ConnectionConfig = ConnectionConfig(),
    val transportState: StreamTransportState = StreamTransportState.DISCONNECTED,
    val transportDetail: String = "未接続",
    val snapshot: AppSnapshot? = null,
    val composerText: String = "",
    val selectedMentions: List<ExplicitMentionTarget> = emptyList(),
    val isSending: Boolean = false,
    val selectedTaskId: String? = null,
    val selectedTaskDetail: TaskDetailResponse? = null,
    val isLoadingTaskDetail: Boolean = false,
    val taskActionInProgress: Boolean = false,
    val isTestingConnection: Boolean = false,
    val lastTestResult: ConnectionTestResult? = null,
    val pendingDeepLinkConfig: ConnectionConfig? = null,
    val bannerMessage: String? = null,
)

class ConductorViewModel(application: Application) : AndroidViewModel(application) {
    private val store = ConnectionStore(application.applicationContext)
    private val api = ConductorApiClient()

    private val _uiState = MutableStateFlow(ConductorUiState())
    val uiState: StateFlow<ConductorUiState> = _uiState.asStateFlow()

    private var streamJob: Job? = null
    private var streamingSyncJob: Job? = null
    private var activeSyncConfig: ConnectionConfig? = null
    private var lastSnapshotReceivedAtMs: Long = 0L
    private val reconnectSignal = MutableSharedFlow<Unit>(extraBufferCapacity = 1)

    init {
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
    }

    fun handleIncomingConnectUri(rawUri: String): Boolean {
        val parsed = ConnectUriParser.parse(rawUri) ?: run {
            _uiState.update {
                it.copy(bannerMessage = "無効なリンク形式です（Step 2 の QR または接続 URI を使用してください）")
            }
            return false
        }
        viewModelScope.launch {
            val sameConfig = parsed == _uiState.value.config
            store.save(parsed)
            _uiState.update {
                it.copy(
                    pendingDeepLinkConfig = parsed,
                    lastTestResult = null,
                    bannerMessage = "デスクトップとリンクしました (${parsed.serverUrl})",
                )
            }
            if (sameConfig) {
                startRealtimeSync(parsed)
            }
        }
        return true
    }

    fun consumePendingDeepLink() {
        _uiState.update { it.copy(pendingDeepLinkConfig = null) }
    }

    fun clearBanner() {
        _uiState.update { it.copy(bannerMessage = null) }
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
            _uiState.update { it.copy(bannerMessage = "URL と Bearer Token を入力してください") }
            return
        }
        viewModelScope.launch {
            val sameConfig = normalized == _uiState.value.config
            store.save(normalized)
            _uiState.update { it.copy(lastTestResult = null, bannerMessage = "接続設定を保存しました") }
            if (sameConfig) {
                startRealtimeSync(normalized)
            }
        }
    }

    fun reconnect() {
        val cfg = _uiState.value.config
        if (!cfg.isConfigured) return
        startRealtimeSync(cfg)
        _uiState.update { it.copy(bannerMessage = "再接続しています...") }
    }

    fun onAppForegrounded() {
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
        viewModelScope.launch {
            store.clear()
            _uiState.update {
                it.copy(
                    snapshot = null,
                    selectedTaskId = null,
                    selectedTaskDetail = null,
                    selectedMentions = emptyList(),
                    transportState = StreamTransportState.DISCONNECTED,
                    transportDetail = "切断済み",
                    bannerMessage = "接続を解除しました",
                )
            }
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

    fun sendChatMessage() {
        val state = _uiState.value
        val text = state.composerText.trim()
        if (text.isBlank() || !state.config.isConfigured || state.isSending) return
        val mentions = state.selectedMentions
        val cfg = state.config
        _uiState.update { it.copy(composerText = "", selectedMentions = emptyList(), isSending = true) }
        viewModelScope.launch {
            api.sendMessage(cfg, text, mentions)
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
                            bannerMessage = "送信エラー: ${err.message}",
                        )
                    }
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
                    _uiState.update { it.copy(bannerMessage = "停止エラー: ${err.message}") }
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
                        it.copy(selectedMentions = emptyList(), bannerMessage = "新しいチャットを開始しました")
                    }
                }
                .onFailure { err ->
                    _uiState.update { it.copy(bannerMessage = "新規チャット作成エラー: ${err.message}") }
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

    fun updateTaskStatus(taskId: String, nextStatus: String) {
        val cfg = _uiState.value.config
        if (!cfg.isConfigured || _uiState.value.taskActionInProgress) return
        viewModelScope.launch {
            _uiState.update { it.copy(taskActionInProgress = true) }
            api.updateTaskStatus(cfg, taskId, nextStatus)
                .onSuccess {
                    val label = if (nextStatus == "done") "タスクを完了にしました" else "タスクを再オープンしました"
                    _uiState.update { it.copy(bannerMessage = label) }
                    refreshTaskDetail(taskId)
                }
                .onFailure { err ->
                    _uiState.update { it.copy(bannerMessage = err.message ?: "ステータス更新に失敗しました") }
                }
            _uiState.update { it.copy(taskActionInProgress = false) }
        }
    }

    fun stopTask(taskId: String) {
        val cfg = _uiState.value.config
        if (!cfg.isConfigured || _uiState.value.taskActionInProgress) return
        viewModelScope.launch {
            _uiState.update { it.copy(taskActionInProgress = true) }
            api.stopTask(cfg, taskId)
                .onSuccess {
                    _uiState.update { it.copy(bannerMessage = "ワーカーを停止しました") }
                    refreshTaskDetail(taskId)
                }
                .onFailure { err ->
                    _uiState.update { it.copy(bannerMessage = err.message ?: "停止に失敗しました") }
                }
            _uiState.update { it.copy(taskActionInProgress = false) }
        }
    }

    fun landTask(taskId: String, createPr: Boolean = false) {
        val cfg = _uiState.value.config
        if (!cfg.isConfigured || _uiState.value.taskActionInProgress) return
        viewModelScope.launch {
            _uiState.update { it.copy(taskActionInProgress = true) }
            api.landTask(cfg, taskId, createPr)
                .onSuccess { res ->
                    _uiState.update { it.copy(bannerMessage = res.message ?: "Land が完了しました") }
                    refreshTaskDetail(taskId)
                }
                .onFailure { err ->
                    _uiState.update { it.copy(bannerMessage = err.message ?: "Land に失敗しました") }
                }
            _uiState.update { it.copy(taskActionInProgress = false) }
        }
    }

    override fun onCleared() {
        stopRealtimeSync()
        api.close()
        super.onCleared()
    }
}
