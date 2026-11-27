package dev.conductor.mobile.data

import dev.conductor.mobile.model.ApiActionResponse
import dev.conductor.mobile.model.AppSnapshot
import dev.conductor.mobile.model.ChatAttachment
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
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.io.IOException
import java.net.URLEncoder
import java.util.Base64
import java.util.concurrent.TimeUnit

sealed interface ClassifiedImageSource {
    data class RemoteUrl(val url: String) : ClassifiedImageSource
    data class DataUrl(val mimeType: String, val base64Data: String) : ClassifiedImageSource
    data class LocalPath(val path: String, val basePath: String? = null) : ClassifiedImageSource
    data class VideoMedia(val path: String) : ClassifiedImageSource
    data class Invalid(val reason: String) : ClassifiedImageSource
}

data class FetchedImageBytes(
    val bytes: ByteArray,
    val contentType: String?,
    val sourceLabel: String,
)

object ImageSourceClassifier {
    private val windowsDriveRegex = Regex("""^[A-Za-z]:[\\/]""")
    private val urlSchemeRegex = Regex("""^[A-Za-z][A-Za-z0-9+.-]*:""")
    private val dataImageBase64Regex = Regex("""^data:(image/[a-zA-Z0-9.+-]+);base64,(.+)$""", RegexOption.DOT_MATCHES_ALL)
    private val videoExtRegex = Regex("""\.(?:mp4|webm|mov)(?:[?#].*)?$""", RegexOption.IGNORE_CASE)

    fun isVideoPathOrUrl(raw: String?): Boolean {
        val trimmed = raw?.trim().orEmpty()
        if (trimmed.isEmpty()) return false
        if (trimmed.startsWith("data:video/", ignoreCase = true)) return true
        return videoExtRegex.containsMatchIn(trimmed)
    }

    fun classify(rawSrc: String?, basePath: String? = null): ClassifiedImageSource {
        val trimmed = rawSrc?.trim().orEmpty()
        if (trimmed.isEmpty()) {
            return ClassifiedImageSource.Invalid("画像パスが空です")
        }
        if (isVideoPathOrUrl(trimmed)) {
            return ClassifiedImageSource.VideoMedia(trimmed)
        }
        if (trimmed.startsWith("http://", ignoreCase = true) ||
            trimmed.startsWith("https://", ignoreCase = true)
        ) {
            return ClassifiedImageSource.RemoteUrl(trimmed)
        }
        if (trimmed.startsWith("//") && trimmed.length > 2 && trimmed[2] != '/') {
            return ClassifiedImageSource.RemoteUrl("https:$trimmed")
        }
        val dataMatch = dataImageBase64Regex.matchEntire(trimmed)
        if (dataMatch != null) {
            return ClassifiedImageSource.DataUrl(
                mimeType = dataMatch.groupValues[1].lowercase(),
                base64Data = dataMatch.groupValues[2].replace(Regex("\\s+"), ""),
            )
        }
        if (trimmed.startsWith("file://", ignoreCase = true)) {
            return ClassifiedImageSource.LocalPath(path = trimmed, basePath = basePath?.trim()?.ifBlank { null })
        }
        val isWinDrive = windowsDriveRegex.containsMatchIn(trimmed)
        if (!isWinDrive && urlSchemeRegex.containsMatchIn(trimmed)) {
            return ClassifiedImageSource.Invalid("未対応の画像 URL スキームです")
        }
        if (trimmed.startsWith("/") ||
            trimmed.startsWith("~/") ||
            trimmed.startsWith("~\\") ||
            isWinDrive
        ) {
            return ClassifiedImageSource.LocalPath(path = trimmed, basePath = basePath?.trim()?.ifBlank { null })
        }
        val cleanBase = basePath?.trim()?.ifBlank { null }
        if (cleanBase != null) {
            return ClassifiedImageSource.LocalPath(path = trimmed, basePath = cleanBase)
        }
        return ClassifiedImageSource.Invalid("相対パスの画像を解決できません")
    }

    fun extractDisplayFileName(rawSrc: String): String {
        val cleaned = rawSrc.trim().substringBefore('#').substringBefore('?')
        val last = cleaned.substringAfterLast('/').substringAfterLast('\\')
        return last.ifBlank { cleaned }
    }
}

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

class ConductorApiClient(
    restConnectTimeoutMs: Long = 8_000L,
    restReadTimeoutMs: Long = 25_000L,
    restWriteTimeoutMs: Long = 15_000L,
    landReadTimeoutMs: Long = 60_000L,
    sseReadTimeoutMs: Long = 40_000L,
) {
    @OptIn(ExperimentalSerializationApi::class)
    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        coerceInputValues = true
        encodeDefaults = true
        explicitNulls = false
    }

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    private val restClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(restConnectTimeoutMs, TimeUnit.MILLISECONDS)
        .readTimeout(restReadTimeoutMs, TimeUnit.MILLISECONDS)
        .writeTimeout(restWriteTimeoutMs, TimeUnit.MILLISECONDS)
        .callTimeout(restReadTimeoutMs + restConnectTimeoutMs, TimeUnit.MILLISECONDS)
        .retryOnConnectionFailure(true)
        .protocols(listOf(Protocol.HTTP_1_1))
        .build()

    private val uploadClient: OkHttpClient = restClient.newBuilder()
        .writeTimeout(60_000L, TimeUnit.MILLISECONDS)
        .readTimeout(45_000L, TimeUnit.MILLISECONDS)
        .callTimeout(110_000L, TimeUnit.MILLISECONDS)
        .build()

    private val landClient: OkHttpClient = restClient.newBuilder()
        .readTimeout(landReadTimeoutMs, TimeUnit.MILLISECONDS)
        .callTimeout(landReadTimeoutMs + restConnectTimeoutMs, TimeUnit.MILLISECONDS)
        .build()

    // Dedicated client for fetching remote & companion-server media images.
    private val mediaClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(restConnectTimeoutMs, TimeUnit.MILLISECONDS)
        .readTimeout(30_000L, TimeUnit.MILLISECONDS)
        .callTimeout(40_000L, TimeUnit.MILLISECONDS)
        .retryOnConnectionFailure(true)
        .followRedirects(true)
        .build()

    // Server sends `: ping\n\n` every 15s; a finite readTimeout detects half-open/stalled sockets
    // after network switches or sleep instead of hanging indefinitely.
    private val sseClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(restConnectTimeoutMs, TimeUnit.MILLISECONDS)
        .readTimeout(sseReadTimeoutMs, TimeUnit.MILLISECONDS)
        .retryOnConnectionFailure(true)
        .protocols(listOf(Protocol.HTTP_1_1))
        .build()

    fun close() {
        restClient.connectionPool.evictAll()
        mediaClient.connectionPool.evictAll()
        sseClient.connectionPool.evictAll()
    }

    fun buildMediaImageUrl(
        config: ConnectionConfig,
        localPath: String,
        basePath: String? = null,
    ): String {
        val base = baseUrl(config)
        val parsed = "$base/api/media/image".toHttpUrlOrNull()
            ?: throw IllegalArgumentException("サーバー URL が不正です: $base")
        val builder = parsed.newBuilder()
            .addQueryParameter("path", localPath)
        if (!basePath.isNullOrBlank()) {
            builder.addQueryParameter("base", basePath)
        }
        return builder.build().toString()
    }

    suspend fun fetchImageBytes(
        config: ConnectionConfig?,
        rawSrc: String,
        basePath: String? = null,
    ): Result<FetchedImageBytes> = withContext(Dispatchers.IO) {
        runCatching {
            when (val classified = ImageSourceClassifier.classify(rawSrc, basePath)) {
                is ClassifiedImageSource.Invalid -> throw IOException(classified.reason)
                is ClassifiedImageSource.VideoMedia -> throw IOException("動画ファイルは画像として表示できません")
                is ClassifiedImageSource.DataUrl -> {
                    val bytes = Base64.getDecoder().decode(classified.base64Data)
                    if (bytes.isEmpty()) throw IOException("画像データが空です")
                    if (bytes.size > MAX_IMAGE_BYTES) throw IOException("画像サイズが大きすぎます (上限 30MB)")
                    FetchedImageBytes(
                        bytes = bytes,
                        contentType = classified.mimeType,
                        sourceLabel = "inline-image",
                    )
                }

                is ClassifiedImageSource.RemoteUrl -> {
                    val req = Request.Builder()
                        .url(classified.url)
                        .get()
                        .build()
                    executeImageRequest(req, classified.url)
                }

                is ClassifiedImageSource.LocalPath -> {
                    if (config == null || !config.isConfigured) {
                        throw IOException("サーバー未接続のためローカル画像を読み込めません")
                    }
                    val url = buildMediaImageUrl(
                        config = config,
                        localPath = classified.path,
                        basePath = classified.basePath,
                    )
                    val req = Request.Builder()
                        .url(url)
                        .header("Authorization", "Bearer ${config.bearerToken.trim()}")
                        .get()
                        .build()
                    executeImageRequest(req, classified.path)
                }
            }
        }
    }

    private fun executeImageRequest(req: Request, sourceLabel: String): FetchedImageBytes {
        mediaClient.newCall(req).execute().use { res ->
            val contentType = res.header("Content-Type")?.substringBefore(';')?.trim()?.lowercase()
            if (!res.isSuccessful) {
                val errBody = res.body?.string().orEmpty()
                val msg = when (res.code) {
                    401 -> "認証エラー (401)"
                    403 -> extractError(errBody, "アクセスが拒否されました (403)")
                    404 -> extractError(errBody, "画像ファイルが見つかりません (404)")
                    413 -> extractError(errBody, "画像サイズが大きすぎます (413)")
                    else -> extractError(errBody, "HTTP ${res.code}")
                }
                throw IOException(msg)
            }
            val contentLength = res.body?.contentLength() ?: -1L
            if (contentLength > MAX_IMAGE_BYTES) {
                throw IOException("画像サイズが大きすぎます (上限 30MB)")
            }
            val bytes = res.body?.bytes() ?: throw IOException("画像データが空です")
            if (bytes.isEmpty()) {
                throw IOException("画像データが空です")
            }
            if (bytes.size > MAX_IMAGE_BYTES) {
                throw IOException("画像サイズが大きすぎます (上限 30MB)")
            }
            return FetchedImageBytes(
                bytes = bytes,
                contentType = contentType,
                sourceLabel = sourceLabel,
            )
        }
    }

    companion object {
        private const val MAX_IMAGE_BYTES = 30 * 1024 * 1024 // 30 MB
    }

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
            .header("Cache-Control", "no-cache")
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
                        .onFailure { err ->
                            trySend(
                                SseEvent.Disconnected(
                                    reason = "スナップショット解析エラー: ${err.message ?: "不明な形式"}",
                                ),
                            )
                            eventSource.cancel()
                            close()
                        }
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
    }.buffer(capacity = 4, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    suspend fun sendMessage(
        config: ConnectionConfig,
        text: String,
        mentions: List<ExplicitMentionTarget>,
        attachments: List<ChatAttachment> = emptyList(),
    ): Result<ApiActionResponse> = postAction(
        config = config,
        path = "/api/chat/send",
        payload = json.encodeToString(
            ChatSendRequest(
                text = text,
                explicitMentions = mentions,
                attachments = attachments,
            ),
        ),
        client = if (attachments.isNotEmpty()) uploadClient else restClient,
    )

    suspend fun fetchAttachmentImage(
        config: ConnectionConfig,
        attachmentId: String,
    ): Result<ByteArray> = withContext(Dispatchers.IO) {
        runCatching {
            val encodedId = URLEncoder.encode(attachmentId.trim(), "UTF-8").replace("+", "%20")
            val req = authRequestBuilder(config, "/api/attachments/$encodedId")
                .header("Accept", "image/*")
                .get()
                .build()
            restClient.newCall(req).execute().use { res ->
                if (!res.isSuccessful) {
                    val errBody = res.body?.string().orEmpty()
                    throw IOException(extractError(errBody, "HTTP ${res.code}"))
                }
                val bytes = res.body?.bytes() ?: throw IOException("画像データが空です")
                if (bytes.isEmpty()) {
                    throw IOException("画像データが空です")
                }
                bytes
            }
        }
    }

    suspend fun stopChat(config: ConnectionConfig, messageId: String? = null): Result<ApiActionResponse> =
        postAction(
            config = config,
            path = "/api/chat/stop",
            payload = json.encodeToString(ChatStopRequest(messageId = messageId)),
        )

    suspend fun newChat(config: ConnectionConfig): Result<ApiActionResponse> =
        postAction(config = config, path = "/api/chat/new", payload = "{}")

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
        client = landClient,
    )

    private suspend fun postAction(
        config: ConnectionConfig,
        path: String,
        payload: String,
        client: OkHttpClient = restClient,
    ): Result<ApiActionResponse> = withContext(Dispatchers.IO) {
        runCatching {
            val req = authRequestBuilder(config, path)
                .post(payload.toRequestBody(jsonMediaType))
                .build()
            client.newCall(req).execute().use { res ->
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
