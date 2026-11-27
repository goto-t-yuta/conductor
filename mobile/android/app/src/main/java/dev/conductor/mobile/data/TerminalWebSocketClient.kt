package dev.conductor.mobile.data

import dev.conductor.mobile.model.ConnectUriParser
import dev.conductor.mobile.model.ConnectionConfig
import dev.conductor.mobile.model.TerminalClientMessage
import dev.conductor.mobile.model.TerminalServerMessage
import dev.conductor.mobile.model.TerminalSessionInfo
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

sealed interface TerminalWsEvent {
    data object Opened : TerminalWsEvent
    data class Ready(
        val session: TerminalSessionInfo,
        val replay: String,
        val seq: Long,
        val replayMode: String,
        val recreated: Boolean,
    ) : TerminalWsEvent
    data class Output(
        val sessionId: String,
        val data: String,
        val seq: Long,
    ) : TerminalWsEvent
    data class Exit(
        val sessionId: String,
        val exitCode: Int?,
        val signal: Int?,
    ) : TerminalWsEvent
    data class ServerError(val message: String) : TerminalWsEvent
    data class Disconnected(
        val reason: String,
        val unauthorized: Boolean = false,
        val normalClose: Boolean = false,
    ) : TerminalWsEvent
}

interface TerminalConnectionHandle {
    val events: Flow<TerminalWsEvent>
    fun sendInput(data: String): Boolean
    fun sendResize(cols: Int, rows: Int): Boolean
    fun sendRestart(projectPath: String?, cols: Int, rows: Int): Boolean
    fun sendClose(): Boolean
    fun disconnect()
}

class TerminalWebSocketClient(
    connectTimeoutMs: Long = 8_000L,
    pingIntervalSeconds: Long = 20L,
) {
    @OptIn(ExperimentalSerializationApi::class)
    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        coerceInputValues = true
        encodeDefaults = false
        explicitNulls = false
    }

    private val wsClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(connectTimeoutMs, TimeUnit.MILLISECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .writeTimeout(15_000L, TimeUnit.MILLISECONDS)
        .pingInterval(pingIntervalSeconds, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .protocols(listOf(Protocol.HTTP_1_1))
        .build()

    fun buildTerminalWsUrl(
        config: ConnectionConfig,
        sessionId: String? = null,
        projectPath: String? = null,
        cols: Int? = null,
        rows: Int? = null,
        afterSeq: Long? = null,
    ): String {
        val base = ConnectUriParser.normalizeServerUrl(config.serverUrl)
        val httpUrl = "$base/api/terminal/ws".toHttpUrlOrNull()
            ?: throw IllegalArgumentException("サーバー URL が不正です: $base")
        val builder = httpUrl.newBuilder()
        if (!sessionId.isNullOrBlank()) {
            builder.addQueryParameter("sessionId", sessionId.trim())
        }
        if (!projectPath.isNullOrBlank()) {
            builder.addQueryParameter("projectPath", projectPath.trim())
        }
        if (cols != null && cols > 0) {
            builder.addQueryParameter("cols", cols.toString())
        }
        if (rows != null && rows > 0) {
            builder.addQueryParameter("rows", rows.toString())
        }
        if (afterSeq != null && afterSeq >= 0L) {
            builder.addQueryParameter("afterSeq", afterSeq.toString())
        }
        val built = builder.build().toString()
        return when {
            built.startsWith("https://", ignoreCase = true) -> "wss://" + built.substring(8)
            built.startsWith("http://", ignoreCase = true) -> "ws://" + built.substring(7)
            else -> built
        }
    }

    fun connect(
        config: ConnectionConfig,
        sessionId: String? = null,
        projectPath: String? = null,
        cols: Int? = null,
        rows: Int? = null,
        afterSeq: Long? = null,
    ): TerminalConnectionHandle {
        val wsUrl = buildTerminalWsUrl(
            config = config,
            sessionId = sessionId,
            projectPath = projectPath,
            cols = cols,
            rows = rows,
            afterSeq = afterSeq,
        )
        val request = Request.Builder()
            .url(wsUrl)
            .header("Authorization", "Bearer ${config.bearerToken.trim()}")
            .build()

        val eventsChannel = Channel<TerminalWsEvent>(capacity = Channel.UNLIMITED)

        var webSocket: WebSocket? = null
        val disconnectedEmitted = AtomicBoolean(false)

        fun emitDisconnect(reason: String, unauthorized: Boolean = false, normalClose: Boolean = false) {
            if (!disconnectedEmitted.compareAndSet(false, true)) return
            eventsChannel.trySend(
                TerminalWsEvent.Disconnected(
                    reason = reason,
                    unauthorized = unauthorized,
                    normalClose = normalClose,
                ),
            )
            eventsChannel.close()
        }

        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                eventsChannel.trySend(TerminalWsEvent.Opened)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val msg = runCatching { json.decodeFromString<TerminalServerMessage>(text) }.getOrNull()
                    ?: return
                when (msg.type) {
                    "ready" -> {
                        val session = msg.session ?: return
                        eventsChannel.trySend(
                            TerminalWsEvent.Ready(
                                session = session,
                                replay = msg.replay,
                                seq = msg.seq,
                                replayMode = msg.replayMode,
                                recreated = msg.recreated,
                            ),
                        )
                    }
                    "output" -> {
                        eventsChannel.trySend(
                            TerminalWsEvent.Output(
                                sessionId = msg.sessionId.orEmpty(),
                                data = msg.data,
                                seq = msg.seq,
                            ),
                        )
                    }
                    "exit" -> {
                        eventsChannel.trySend(
                            TerminalWsEvent.Exit(
                                sessionId = msg.sessionId.orEmpty(),
                                exitCode = msg.exitCode,
                                signal = msg.signal,
                            ),
                        )
                    }
                    "error" -> {
                        eventsChannel.trySend(
                            TerminalWsEvent.ServerError(msg.message ?: "ターミナルエラーが発生しました"),
                        )
                    }
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                val unauthorized = code == 4001
                val displayReason = when {
                    unauthorized -> "認証トークンが更新されました。再設定してください。"
                    reason.isNotBlank() -> reason
                    code == 1000 -> "接続を終了しました"
                    else -> "接続が切断されました (code $code)"
                }
                emitDisconnect(
                    reason = displayReason,
                    unauthorized = unauthorized,
                    normalClose = code == 1000,
                )
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                val unauthorized = response?.code == 401
                val reason = when {
                    unauthorized -> "認証エラー (401): Bearer Token を確認してください"
                    response != null -> "HTTP ${response.code}"
                    else -> t.message ?: "WebSocket 接続が切断されました"
                }
                emitDisconnect(reason = reason, unauthorized = unauthorized)
            }
        }

        webSocket = wsClient.newWebSocket(request, listener)

        return object : TerminalConnectionHandle {
            override val events: Flow<TerminalWsEvent> = eventsChannel.receiveAsFlow()

            override fun sendInput(data: String): Boolean {
                val payload = json.encodeToString(TerminalClientMessage(type = "input", data = data))
                return webSocket?.send(payload) == true
            }

            override fun sendResize(cols: Int, rows: Int): Boolean {
                val payload = json.encodeToString(
                    TerminalClientMessage(type = "resize", cols = cols, rows = rows),
                )
                return webSocket?.send(payload) == true
            }

            override fun sendRestart(projectPath: String?, cols: Int, rows: Int): Boolean {
                // Explicit empty string tells server to reset cwd to Home directory
                val payload = json.encodeToString(
                    TerminalClientMessage(
                        type = "restart",
                        projectPath = projectPath?.trim() ?: "",
                        cols = cols,
                        rows = rows,
                    ),
                )
                return webSocket?.send(payload) == true
            }

            override fun sendClose(): Boolean {
                val payload = json.encodeToString(TerminalClientMessage(type = "close"))
                return webSocket?.send(payload) == true
            }

            override fun disconnect() {
                disconnectedEmitted.set(true)
                runCatching { webSocket?.close(1000, "Client disconnect") }
                eventsChannel.close()
            }
        }
    }

    fun close() {
        wsClient.dispatcher.executorService.shutdown()
        wsClient.connectionPool.evictAll()
    }
}
