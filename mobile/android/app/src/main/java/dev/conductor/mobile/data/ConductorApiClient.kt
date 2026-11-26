package dev.conductor.mobile.data

import dev.conductor.mobile.model.ApiActionResponse
import dev.conductor.mobile.model.AppSnapshot
import dev.conductor.mobile.model.ChatSendRequest
import dev.conductor.mobile.model.ChatStopRequest
import dev.conductor.mobile.model.ConnectUriParser
import dev.conductor.mobile.model.ConnectionConfig
import dev.conductor.mobile.model.ExplicitMentionTarget
import dev.conductor.mobile.model.HealthResponse
import dev.conductor.mobile.model.TaskDetailResponse
import dev.conductor.mobile.model.TaskLandRequest
import dev.conductor.mobile.model.TaskStatusRequest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.io.IOException
import java.util.concurrent.TimeUnit

sealed interface SseEvent {
    data object Opened : SseEvent
    data class SnapshotReceived(val snapshot: AppSnapshot) : SseEvent
    data class Disconnected(val reason: String, val unauthorized: Boolean = false) : SseEvent
}

data class ConnectionTestResult(
    val ok: Boolean,
    val health: HealthResponse? = null,
    val snapshot: AppSnapshot? = null,
    val message: String,
)

class ConductorApiClient {
    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        coerceInputValues = true
    }

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    private val restClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()

    private val sseClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS) // infinite read for SSE stream
        .pingInterval(25, TimeUnit.SECONDS)
        .build()

    private fun baseUrl(config: ConnectionConfig): String =
        ConnectUriParser.normalizeServerUrl(config.serverUrl)

    private fun authRequestBuilder(config: ConnectionConfig, path: String): Request.Builder =
        Request.Builder()
            .url("${baseUrl(config)}$path")
            .header("Authorization", "Bearer ${config.bearerToken.trim()}")

    suspend fun checkHealth(serverUrl: String): Result<HealthResponse> = withContext(Dispatchers.IO) {
        runCatching {
            val normalized = ConnectUriParser.normalizeServerUrl(serverUrl)
            require(normalized.isNotBlank()) { "サーバー URL を入力してください" }
            val req = Request.Builder().url("$normalized/api/health").get().build()
            restClient.newCall(req).execute().use { res ->
                val body = res.body?.string().orEmpty()
                if (!res.isSuccessful) {
                    throw IOException("HTTP ${res.code}: $body")
                }
                json.decodeFromString<HealthResponse>(body)
            }
        }
    }

    suspend fun fetchSnapshot(config: ConnectionConfig): Result<AppSnapshot> =
        withContext(Dispatchers.IO) {
            runCatching {
                val req = authRequestBuilder(config, "/api/snapshot").get().build()
                restClient.newCall(req).execute().use { res ->
                    val body = res.body?.string().orEmpty()
                    if (res.code == 401) {
                        throw SecurityException("認証エラー (401): Bearer Token を確認してください")
                    }
                    if (!res.isSuccessful) {
                        throw IOException(extractError(body, "HTTP ${res.code}"))
                    }
                    json.decodeFromString<AppSnapshot>(body)
                }
            }
        }

    suspend fun testConnection(config: ConnectionConfig): ConnectionTestResult {
        val healthResult = checkHealth(config.serverUrl)
        val health = healthResult.getOrElse { err ->
            return ConnectionTestResult(
                ok = false,
                message = "サーバーに到達できません: ${err.message ?: "ネットワークエラー"}",
            )
        }
        val snapResult = fetchSnapshot(config)
        val snap = snapResult.getOrElse { err ->
            return ConnectionTestResult(
                ok = false,
                health = health,
                message = err.message ?: "スナップショット取得に失敗しました",
            )
        }
        val hostLabel = health.hostname.ifBlank { health.tailscaleIp ?: config.serverUrl }
        return ConnectionTestResult(
            ok = true,
            health = health,
            snapshot = snap,
            message = "接続成功 ($hostLabel · Projects: ${snap.projects.size}, Tasks: ${snap.tasks.size})",
        )
    }

    fun openSnapshotSse(config: ConnectionConfig): Flow<SseEvent> = callbackFlow {
        val request = authRequestBuilder(config, "/api/events")
            .header("Accept", "text/event-stream")
            .get()
            .build()

        val listener = object : EventSourceListener() {
            override fun onOpen(eventSource: EventSource, response: Response) {
                trySend(SseEvent.Opened)
            }

            override fun onEvent(
                eventSource: EventSource,
                id: String?,
                type: String?,
                data: String,
            ) {
                if (type == null || type == "snapshot") {
                    runCatching { json.decodeFromString<AppSnapshot>(data) }
                        .onSuccess { trySend(SseEvent.SnapshotReceived(it)) }
                }
            }

            override fun onClosed(eventSource: EventSource) {
                trySend(SseEvent.Disconnected("SSE ストリームが終了しました"))
                close()
            }

            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                val unauthorized = response?.code == 401
                val reason = when {
                    unauthorized -> "認証エラー (401): Bearer Token が無効です"
                    response != null -> "HTTP ${response.code}"
                    else -> t?.message ?: "SSE 接続が切断されました"
                }
                trySend(SseEvent.Disconnected(reason, unauthorized = unauthorized))
                close()
            }
        }

        val source = EventSources.createFactory(sseClient).newEventSource(request, listener)
        awaitClose {
            source.cancel()
        }
    }

    suspend fun sendMessage(
        config: ConnectionConfig,
        text: String,
        mentions: List<ExplicitMentionTarget>,
    ): Result<Unit> = postAction(
        config = config,
        path = "/api/chat/send",
        payload = json.encodeToString(ChatSendRequest(text = text, explicitMentions = mentions)),
    ).map { Unit }

    suspend fun stopChat(config: ConnectionConfig, messageId: String? = null): Result<Unit> =
        postAction(
            config = config,
            path = "/api/chat/stop",
            payload = json.encodeToString(ChatStopRequest(messageId = messageId)),
        ).map { Unit }

    suspend fun newChat(config: ConnectionConfig): Result<Unit> =
        postAction(config = config, path = "/api/chat/new", payload = "{}").map { Unit }

    suspend fun getTaskDetail(config: ConnectionConfig, taskId: String): Result<TaskDetailResponse> =
        withContext(Dispatchers.IO) {
            runCatching {
                val req = authRequestBuilder(config, "/api/tasks/$taskId").get().build()
                restClient.newCall(req).execute().use { res ->
                    val body = res.body?.string().orEmpty()
                    if (!res.isSuccessful) {
                        throw IOException(extractError(body, "HTTP ${res.code}"))
                    }
                    json.decodeFromString<TaskDetailResponse>(body)
                }
            }
        }

    suspend fun updateTaskStatus(
        config: ConnectionConfig,
        taskId: String,
        status: String,
    ): Result<ApiActionResponse> = postAction(
        config = config,
        path = "/api/tasks/$taskId/status",
        payload = json.encodeToString(TaskStatusRequest(status = status)),
    )

    suspend fun stopTask(config: ConnectionConfig, taskId: String): Result<ApiActionResponse> =
        postAction(config = config, path = "/api/tasks/$taskId/stop", payload = "{}")

    suspend fun landTask(
        config: ConnectionConfig,
        taskId: String,
        createPr: Boolean = false,
    ): Result<ApiActionResponse> = postAction(
        config = config,
        path = "/api/tasks/$taskId/land",
        payload = json.encodeToString(TaskLandRequest(createPr = createPr)),
    )

    private suspend fun postAction(
        config: ConnectionConfig,
        path: String,
        payload: String,
    ): Result<ApiActionResponse> = withContext(Dispatchers.IO) {
        runCatching {
            val req = authRequestBuilder(config, path)
                .post(payload.toRequestBody(jsonMediaType))
                .build()
            restClient.newCall(req).execute().use { res ->
                val body = res.body?.string().orEmpty()
                val parsed = runCatching { json.decodeFromString<ApiActionResponse>(body) }.getOrNull()
                if (!res.isSuccessful) {
                    val errMsg = parsed?.error ?: parsed?.message ?: "HTTP ${res.code}"
                    throw IOException(errMsg)
                }
                parsed ?: ApiActionResponse(ok = true)
            }
        }
    }

    private fun extractError(body: String, fallback: String): String {
        val parsed = runCatching { json.decodeFromString<ApiActionResponse>(body) }.getOrNull()
        return parsed?.error ?: parsed?.message ?: fallback
    }
}
