package dev.conductor.mobile

import dev.conductor.mobile.data.ApiHttpException
import dev.conductor.mobile.data.ClassifiedImageSource
import dev.conductor.mobile.data.ClassifiedVideoSource
import dev.conductor.mobile.data.ConductorApiClient
import dev.conductor.mobile.data.ImageSourceClassifier
import dev.conductor.mobile.data.SseEvent
import dev.conductor.mobile.data.VideoPlaybackTarget
import dev.conductor.mobile.data.VideoSourceClassifier
import dev.conductor.mobile.model.ChatAttachment
import dev.conductor.mobile.model.ConnectionConfig
import dev.conductor.mobile.ui.components.ConductorImageLoader
import dev.conductor.mobile.ui.components.ConductorVideoPlaybackCoordinator
import dev.conductor.mobile.ui.components.VideoPlayerFormatting
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.BufferedReader
import java.io.ByteArrayOutputStream
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.zip.GZIPOutputStream

private class MiniHttpTestServer {
    private val serverSocket = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
    private val executor: ExecutorService = Executors.newCachedThreadPool()

    @Volatile
    private var running = true

    @Volatile
    var handler: (requestLine: String, headers: Map<String, String>, out: OutputStream, socket: Socket) -> Unit =
        { _, _, out, _ ->
            out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
            out.flush()
        }

    @Volatile
    var lastRequestBody: String = ""

    val baseUrl: String
        get() = "http://127.0.0.1:${serverSocket.localPort}"

    fun start() {
        executor.execute {
            while (running && !serverSocket.isClosed) {
                val socket = runCatching { serverSocket.accept() }.getOrNull() ?: break
                executor.execute {
                    socket.use { sock ->
                        runCatching {
                            val reader = BufferedReader(InputStreamReader(sock.getInputStream(), Charsets.UTF_8))
                            val requestLine = reader.readLine() ?: return@runCatching
                            val headers = mutableMapOf<String, String>()
                            var contentLength = 0
                            while (true) {
                                val line = reader.readLine() ?: break
                                if (line.isEmpty()) break
                                val idx = line.indexOf(':')
                                if (idx > 0) {
                                    val k = line.substring(0, idx).trim().lowercase()
                                    val v = line.substring(idx + 1).trim()
                                    headers[k] = v
                                    if (k == "content-length") {
                                        contentLength = v.toIntOrNull() ?: 0
                                    }
                                }
                            }
                            if (contentLength > 0) {
                                val buf = CharArray(contentLength)
                                var read = 0
                                while (read < contentLength) {
                                    val n = reader.read(buf, read, contentLength - read)
                                    if (n <= 0) break
                                    read += n
                                }
                                lastRequestBody = String(buf, 0, read)
                            } else {
                                lastRequestBody = ""
                            }
                            handler(requestLine, headers, sock.getOutputStream(), sock)
                        }
                    }
                }
            }
        }
    }

    fun stop() {
        running = false
        runCatching { serverSocket.close() }
        executor.shutdownNow()
    }
}

class ConductorApiClientTest {
    private lateinit var server: MiniHttpTestServer
    private val token = "test-secret-token-1234567890"

    @Before
    fun setUp() {
        server = MiniHttpTestServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.stop()
    }

    @Test
    fun sendMessageParsesImmediateSnapshotFromResponse() = runBlocking {
        var seenAuth: String? = null
        var seenRequestLine: String? = null
        server.handler = { reqLine, headers, out, _ ->
            seenRequestLine = reqLine
            seenAuth = headers["authorization"]
            val body = """
                {
                  "ok": true,
                  "snapshot": {
                    "activeChatSessionId": "sess-1",
                    "isConnected": true,
                    "connectionStatus": "Codex 利用可能",
                    "activeResponderCount": 1,
                    "messages": [
                      {"id": "u1", "role": "user", "text": "hello", "isStreaming": false},
                      {"id": "a1", "role": "assistant", "provider": "codex", "text": "", "isStreaming": true}
                    ]
                  }
                }
            """.trimIndent().toByteArray(Charsets.UTF_8)
            val head = "HTTP/1.1 200 OK\r\n" +
                "Content-Type: application/json; charset=utf-8\r\n" +
                "Content-Length: ${body.size}\r\n" +
                "Connection: close\r\n\r\n"
            out.write(head.toByteArray(Charsets.UTF_8))
            out.write(body)
            out.flush()
        }

        val client = ConductorApiClient()
        try {
            val result = client.sendMessage(
                config = ConnectionConfig(serverUrl = server.baseUrl, bearerToken = token),
                text = "hello",
                mentions = emptyList(),
            )
            assertTrue(result.isSuccess)
            assertEquals("Bearer $token", seenAuth)
            assertTrue(seenRequestLine?.startsWith("POST /api/chat/send ") == true)
            val body = result.getOrThrow()
            assertTrue(body.ok)
            assertNotNull(body.snapshot)
            assertEquals(1, body.snapshot?.activeResponderCount)
            assertEquals(2, body.snapshot?.messages?.size)
            assertEquals("hello", body.snapshot?.messages?.first()?.text)
        } finally {
            client.close()
        }
    }

    @Test
    fun fetchSnapshotTransparentlyDecodesGzipResponses() = runBlocking {
        server.handler = { _, _, out, _ ->
            val raw = """
                {
                  "activeChatSessionId": "sess-gz",
                  "isConnected": true,
                  "connectionStatus": "OK",
                  "activeResponderCount": 0,
                  "messages": [{"id": "m1", "role": "assistant", "text": "${"gzip-ok ".repeat(200)}", "isStreaming": false}]
                }
            """.trimIndent().toByteArray(Charsets.UTF_8)
            val gzOut = ByteArrayOutputStream()
            GZIPOutputStream(gzOut).use { it.write(raw) }
            val compressed = gzOut.toByteArray()
            val head = "HTTP/1.1 200 OK\r\n" +
                "Content-Type: application/json; charset=utf-8\r\n" +
                "Content-Encoding: gzip\r\n" +
                "Content-Length: ${compressed.size}\r\n" +
                "Connection: close\r\n\r\n"
            out.write(head.toByteArray(Charsets.UTF_8))
            out.write(compressed)
            out.flush()
        }

        val client = ConductorApiClient()
        try {
            val res = client.fetchSnapshot(ConnectionConfig(serverUrl = server.baseUrl, bearerToken = token))
            assertTrue(res.isSuccess)
            assertEquals("sess-gz", res.getOrThrow().activeChatSessionId)
            assertTrue(res.getOrThrow().messages.first().text.startsWith("gzip-ok"))
        } finally {
            client.close()
        }
    }

    @Test
    fun sseReadTimeoutDetectsStalledHalfOpenStreamInsteadOfHangingForever() = runBlocking {
        server.handler = { _, _, out, _ ->
            val head = "HTTP/1.1 200 OK\r\n" +
                "Content-Type: text/event-stream; charset=utf-8\r\n" +
                "Cache-Control: no-cache\r\n" +
                "Connection: keep-alive\r\n\r\n"
            out.write(head.toByteArray(Charsets.UTF_8))
            val initial = "event: snapshot\ndata: {\"activeChatSessionId\":\"s1\",\"isConnected\":true}\n\n"
            out.write(initial.toByteArray(Charsets.UTF_8))
            out.flush()
            // Keep socket open silently with no heartbeats to simulate half-open / stalled Tailscale stream
            runCatching { Thread.sleep(5_000) }
        }

        val client = ConductorApiClient(sseReadTimeoutMs = 450L)
        try {
            val events = client.openSnapshotSse(ConnectionConfig(serverUrl = server.baseUrl, bearerToken = token))
                .toList()
            assertTrue(events.any { it is SseEvent.Opened })
            assertTrue(events.any { it is SseEvent.SnapshotReceived })
            assertTrue(events.last() is SseEvent.Disconnected)
        } finally {
            client.close()
        }
    }

    @Test
    fun sseBurstDropsOldestSnapshotsAndNeverDropsLatestCompletedResponse() = runBlocking {
        server.handler = { _, _, out, _ ->
            val head = "HTTP/1.1 200 OK\r\n" +
                "Content-Type: text/event-stream; charset=utf-8\r\n" +
                "Cache-Control: no-cache\r\n" +
                "Connection: close\r\n\r\n"
            out.write(head.toByteArray(Charsets.UTF_8))
            for (i in 1..25) {
                val isFinal = i == 25
                val payload = """{"activeChatSessionId":"s1","activeResponderCount":${if (isFinal) 0 else 1},"messages":[{"id":"a1","role":"assistant","text":"msg-$i","isStreaming":${!isFinal}}]}"""
                out.write("event: snapshot\ndata: $payload\n\n".toByteArray(Charsets.UTF_8))
                out.flush()
            }
        }

        val client = ConductorApiClient(sseReadTimeoutMs = 5_000L)
        try {
            val snapshots = mutableListOf<String>()
            client.openSnapshotSse(ConnectionConfig(serverUrl = server.baseUrl, bearerToken = token))
                .collect { ev ->
                    if (ev is SseEvent.SnapshotReceived) {
                        // Simulate slow UI collector
                        delay(15)
                        snapshots.add(ev.snapshot.messages.firstOrNull()?.text.orEmpty())
                    }
                }
            assertTrue("Expected at least one snapshot", snapshots.isNotEmpty())
            assertEquals("msg-25", snapshots.last())
        } finally {
            client.close()
        }
    }

    @Test
    fun sseMalformedJsonEmitsDisconnectInsteadOfSilentlySwallowingError() = runBlocking {
        server.handler = { _, _, out, _ ->
            val head = "HTTP/1.1 200 OK\r\n" +
                "Content-Type: text/event-stream; charset=utf-8\r\n" +
                "Connection: close\r\n\r\n"
            out.write(head.toByteArray(Charsets.UTF_8))
            out.write("event: snapshot\ndata: {not-valid-json}\n\n".toByteArray(Charsets.UTF_8))
            out.flush()
        }

        val client = ConductorApiClient(sseReadTimeoutMs = 3_000L)
        try {
            val events = client.openSnapshotSse(ConnectionConfig(serverUrl = server.baseUrl, bearerToken = token))
                .take(3)
                .toList()
            val disconnect = events.filterIsInstance<SseEvent.Disconnected>().firstOrNull()
            assertNotNull(disconnect)
            assertTrue(disconnect!!.reason.contains("スナップショット解析エラー"))
        } finally {
            client.close()
        }
    }

    @Test
    fun sendMessageSerializesImageAttachmentsEvenWithEmptyText() = runBlocking {
        server.handler = { _, _, out, _ ->
            val body = """
                {
                  "ok": true,
                  "snapshot": {
                    "activeChatSessionId": "sess-img",
                    "isConnected": true,
                    "messages": [
                      {
                        "id": "u-img",
                        "role": "user",
                        "text": "(添付を参照してください)",
                        "attachments": [
                          {"id": "img-1", "kind": "image", "label": "shot.png"},
                          {"id": "img-2", "kind": "image", "label": "photo.jpg"}
                        ],
                        "isStreaming": false
                      }
                    ]
                  }
                }
            """.trimIndent().toByteArray(Charsets.UTF_8)
            val head = "HTTP/1.1 200 OK\r\n" +
                "Content-Type: application/json; charset=utf-8\r\n" +
                "Content-Length: ${body.size}\r\n" +
                "Connection: close\r\n\r\n"
            out.write(head.toByteArray(Charsets.UTF_8))
            out.write(body)
            out.flush()
        }

        val client = ConductorApiClient()
        try {
            val res = client.sendMessage(
                config = ConnectionConfig(serverUrl = server.baseUrl, bearerToken = token),
                text = "",
                mentions = emptyList(),
                attachments = listOf(
                    ChatAttachment(
                        id = "img-1",
                        kind = "image",
                        label = "shot.png",
                        imageDataUrl = "data:image/png;base64,iVBORw0KGgo=",
                    ),
                    ChatAttachment(
                        id = "img-2",
                        kind = "image",
                        label = "photo.jpg",
                        imageDataUrl = "data:image/jpeg;base64,/9j/4AAQ=",
                    ),
                ),
            )
            assertTrue(res.isSuccess)
            val sentBody = server.lastRequestBody
            assertTrue(sentBody.contains("\"kind\":\"image\""))
            assertTrue(sentBody.contains("\"label\":\"shot.png\""))
            assertTrue(sentBody.contains("\"imageDataUrl\":\"data:image/png;base64,iVBORw0KGgo=\""))
            assertTrue(sentBody.contains("\"label\":\"photo.jpg\""))
            assertEquals(2, res.getOrThrow().snapshot?.messages?.first()?.attachments?.size)
        } finally {
            client.close()
        }
    }

    @Test
    fun fetchAttachmentImageDownloadsAuthorizedBinaryPayloadAndHandles404() = runBlocking {
        val sampleBytes = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
        var seenAuth: String? = null
        var seenPath: String? = null

        server.handler = { reqLine, headers, out, _ ->
            seenPath = reqLine.split(" ").getOrNull(1)
            seenAuth = headers["authorization"]
            if (seenPath == "/api/attachments/att-42") {
                val head = "HTTP/1.1 200 OK\r\n" +
                    "Content-Type: image/png\r\n" +
                    "Content-Length: ${sampleBytes.size}\r\n" +
                    "Connection: close\r\n\r\n"
                out.write(head.toByteArray(Charsets.UTF_8))
                out.write(sampleBytes)
                out.flush()
            } else {
                val err = """{"ok":false,"error":"Attachment not found"}""".toByteArray(Charsets.UTF_8)
                val head = "HTTP/1.1 404 Not Found\r\n" +
                    "Content-Type: application/json\r\n" +
                    "Content-Length: ${err.size}\r\n" +
                    "Connection: close\r\n\r\n"
                out.write(head.toByteArray(Charsets.UTF_8))
                out.write(err)
                out.flush()
            }
        }

        val client = ConductorApiClient()
        try {
            val okRes = client.fetchAttachmentImage(
                config = ConnectionConfig(serverUrl = server.baseUrl, bearerToken = token),
                attachmentId = "att-42",
            )
            assertTrue(okRes.isSuccess)
            assertEquals("Bearer $token", seenAuth)
            assertEquals("/api/attachments/att-42", seenPath)
            assertArrayEquals(sampleBytes, okRes.getOrThrow())

            val missingRes = client.fetchAttachmentImage(
                config = ConnectionConfig(serverUrl = server.baseUrl, bearerToken = token),
                attachmentId = "missing",
            )
            assertTrue(missingRes.isFailure)
            assertTrue(missingRes.exceptionOrNull()?.message?.contains("Attachment not found") == true)
        } finally {
            client.close()
        }
    }

    @Test
    fun imageSourceClassifierDistinguishesLocalRemoteDataVideoAndInvalid() {
        assertEquals(
            ClassifiedImageSource.LocalPath("/Users/dev/Application Support/shot.png", null),
            ImageSourceClassifier.classify("/Users/dev/Application Support/shot.png"),
        )
        assertEquals(
            ClassifiedImageSource.LocalPath("file:///tmp/a.png", null),
            ImageSourceClassifier.classify("file:///tmp/a.png"),
        )
        assertEquals(
            ClassifiedImageSource.LocalPath("shots/ui.png", "/repo/wt"),
            ImageSourceClassifier.classify("shots/ui.png", "/repo/wt"),
        )
        assertTrue(ImageSourceClassifier.classify("shots/ui.png", null) is ClassifiedImageSource.Invalid)
        assertEquals(
            ClassifiedImageSource.RemoteUrl("https://example.com/a.png"),
            ImageSourceClassifier.classify("//example.com/a.png"),
        )
        assertTrue(ImageSourceClassifier.classify("data:image/png;base64,iVBORw==") is ClassifiedImageSource.DataUrl)
        assertTrue(ImageSourceClassifier.classify("/tmp/walkthrough.mp4") is ClassifiedImageSource.VideoMedia)
        assertTrue(ImageSourceClassifier.classify("javascript:alert(1)") is ClassifiedImageSource.Invalid)
        assertEquals(1, ConductorImageLoader.computeInSampleSize(1200, 800, 1600))
        assertEquals(2, ConductorImageLoader.computeInSampleSize(3200, 1800, 1600))
        assertEquals(4, ConductorImageLoader.computeInSampleSize(6400, 3600, 1600))
    }

    @Test
    fun fetchImageBytesAuthenticatesLocalMediaAndDoesNotLeakTokenToRemoteUrls() = runBlocking {
        val samplePng = java.util.Base64.getDecoder().decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        )
        val seenRequests = mutableListOf<Pair<String, String?>>()

        server.handler = { reqLine, headers, out, _ ->
            seenRequests.add(reqLine to headers["authorization"])
            val head = "HTTP/1.1 200 OK\r\n" +
                "Content-Type: image/png\r\n" +
                "Content-Length: ${samplePng.size}\r\n" +
                "Connection: close\r\n\r\n"
            out.write(head.toByteArray(Charsets.UTF_8))
            out.write(samplePng)
            out.flush()
        }

        val client = ConductorApiClient()
        val cfg = ConnectionConfig(serverUrl = server.baseUrl, bearerToken = token)
        try {
            // 1. Local path goes through /api/media/image with Bearer token
            val localRes = client.fetchImageBytes(
                config = cfg,
                rawSrc = "/Users/dev/Application Support/shot.png",
                basePath = "/Users/dev/repo",
            )
            assertTrue(localRes.isSuccess)
            assertEquals("image/png", localRes.getOrThrow().contentType)
            assertTrue(samplePng.contentEquals(localRes.getOrThrow().bytes))
            val (localReqLine, localAuth) = seenRequests[0]
            assertTrue(localReqLine.startsWith("GET /api/media/image?"))
            assertTrue(localReqLine.contains("path=%2FUsers%2Fdev%2FApplication%20Support%2Fshot.png"))
            assertTrue(localReqLine.contains("base=%2FUsers%2Fdev%2Frepo"))
            assertEquals("Bearer $token", localAuth)

            // 2. Remote HTTP URL does NOT receive Conductor Bearer token
            val remoteRes = client.fetchImageBytes(
                config = cfg,
                rawSrc = "${server.baseUrl}/public/banner.png",
            )
            assertTrue(remoteRes.isSuccess)
            val (remoteReqLine, remoteAuth) = seenRequests[1]
            assertTrue(remoteReqLine.startsWith("GET /public/banner.png "))
            assertEquals(null, remoteAuth)

            // 3. Inline base64 data URL decodes directly without HTTP call
            val dataRes = client.fetchImageBytes(
                config = null,
                rawSrc = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            )
            assertTrue(dataRes.isSuccess)
            assertTrue(samplePng.contentEquals(dataRes.getOrThrow().bytes))
            assertEquals(2, seenRequests.size)
        } finally {
            client.close()
        }
    }

    @Test
    fun updateTaskStatusParsesUpdatedTaskAndSurfacesConflictError() = runBlocking {
        var seenPath: String? = null
        var seenAuth: String? = null
        server.handler = { reqLine, headers, out, _ ->
            seenPath = reqLine.split(" ").getOrNull(1)
            seenAuth = headers["authorization"]
            if (seenPath == "/api/tasks/task-14/status") {
                val body = """
                    {
                      "ok": true,
                      "task": {
                        "id": "task-14",
                        "taskNumber": 14,
                        "title": "Fix OAuth redirect",
                        "projectName": "web-app",
                        "status": "done"
                      }
                    }
                """.trimIndent().toByteArray(Charsets.UTF_8)
                val head = "HTTP/1.1 200 OK\r\n" +
                    "Content-Type: application/json; charset=utf-8\r\n" +
                    "Content-Length: ${body.size}\r\n" +
                    "Connection: close\r\n\r\n"
                out.write(head.toByteArray(Charsets.UTF_8))
                out.write(body)
                out.flush()
            } else {
                val body = """
                    {"ok":false,"error":"実行中のタスクは直接完了にできません。先にワーカーを停止してください。"}
                """.trimIndent().toByteArray(Charsets.UTF_8)
                val head = "HTTP/1.1 409 Conflict\r\n" +
                    "Content-Type: application/json; charset=utf-8\r\n" +
                    "Content-Length: ${body.size}\r\n" +
                    "Connection: close\r\n\r\n"
                out.write(head.toByteArray(Charsets.UTF_8))
                out.write(body)
                out.flush()
            }
        }

        val client = ConductorApiClient()
        try {
            val okRes = client.updateTaskStatus(
                config = ConnectionConfig(serverUrl = server.baseUrl, bearerToken = token),
                taskId = "task-14",
                status = "done",
            )
            assertTrue(okRes.isSuccess)
            assertEquals("Bearer $token", seenAuth)
            assertEquals("/api/tasks/task-14/status", seenPath)
            assertTrue(server.lastRequestBody.contains("\"status\":\"done\""))
            val updated = okRes.getOrThrow().task
            assertNotNull(updated)
            assertEquals("done", updated?.status)
            assertEquals(14, updated?.taskNumber)

            val conflictRes = client.updateTaskStatus(
                config = ConnectionConfig(serverUrl = server.baseUrl, bearerToken = token),
                taskId = "task-running",
                status = "done",
            )
            assertTrue(conflictRes.isFailure)
            assertTrue(conflictRes.exceptionOrNull()?.message?.contains("実行中のタスク") == true)
        } finally {
            client.close()
        }
    }

    @Test
    fun staleChatSessionOnSendAndSelectReturnsApiHttpExceptionWithServerSnapshot() = runBlocking {
        server.handler = { reqLine, _, out, _ ->
            val path = reqLine.split(" ").getOrNull(1).orEmpty()
            val (statusLine, bodyText) = when (path) {
                "/api/chat/send" -> "HTTP/1.1 409 Conflict" to """
                    {
                      "ok": false,
                      "reason": "session_mismatch",
                      "error": "アクティブなチャットセッションが切り替わっています。",
                      "activeChatSessionId": "sess-latest",
                      "snapshot": {
                        "snapshotEpoch": "ep-2",
                        "snapshotVersion": 5,
                        "activeChatSessionId": "sess-latest",
                        "chatSessions": [
                          {"id": "sess-latest", "title": "Latest Chat", "messageCount": 2}
                        ],
                        "isConnected": true,
                        "messages": [{"id": "m-new", "role": "user", "text": "fresh", "isStreaming": false}]
                      }
                    }
                """.trimIndent()

                "/api/chat/session" -> "HTTP/1.1 404 Not Found" to """
                    {
                      "ok": false,
                      "reason": "session_not_found",
                      "error": "指定されたチャットセッションは存在しません。",
                      "activeChatSessionId": "sess-latest",
                      "snapshot": {
                        "snapshotEpoch": "ep-2",
                        "snapshotVersion": 6,
                        "activeChatSessionId": "sess-latest",
                        "chatSessions": [
                          {"id": "sess-latest", "title": "Latest Chat", "messageCount": 2}
                        ],
                        "isConnected": true
                      }
                    }
                """.trimIndent()

                else -> "HTTP/1.1 404 Not Found" to """{"ok":false,"error":"Not Found"}"""
            }
            val body = bodyText.toByteArray(Charsets.UTF_8)
            val head = "$statusLine\r\n" +
                "Content-Type: application/json; charset=utf-8\r\n" +
                "Content-Length: ${body.size}\r\n" +
                "Connection: close\r\n\r\n"
            out.write(head.toByteArray(Charsets.UTF_8))
            out.write(body)
            out.flush()
        }

        val client = ConductorApiClient()
        try {
            val sendRes = client.sendMessage(
                config = ConnectionConfig(serverUrl = server.baseUrl, bearerToken = token),
                text = "hello stale",
                mentions = emptyList(),
                chatSessionId = "sess-old-1707",
            )
            assertTrue(sendRes.isFailure)
            assertTrue(server.lastRequestBody.contains("\"chatSessionId\":\"sess-old-1707\""))
            val sendErr = sendRes.exceptionOrNull() as? ApiHttpException
            assertNotNull(sendErr)
            assertEquals(409, sendErr?.statusCode)
            assertEquals("session_mismatch", sendErr?.response?.reason)
            assertEquals("sess-latest", sendErr?.response?.snapshot?.activeChatSessionId)
            assertEquals(1, sendErr?.response?.snapshot?.chatSessions?.size)

            val selectRes = client.selectChatSession(
                config = ConnectionConfig(serverUrl = server.baseUrl, bearerToken = token),
                sessionId = "sess-deleted",
            )
            assertTrue(selectRes.isFailure)
            assertTrue(server.lastRequestBody.contains("\"sessionId\":\"sess-deleted\""))
            val selectErr = selectRes.exceptionOrNull() as? ApiHttpException
            assertNotNull(selectErr)
            assertEquals(404, selectErr?.statusCode)
            assertEquals("session_not_found", selectErr?.response?.reason)
            assertEquals("sess-latest", selectErr?.response?.snapshot?.activeChatSessionId)
            assertEquals("Latest Chat", selectErr?.response?.snapshot?.chatSessions?.firstOrNull()?.title)
        } finally {
            client.close()
        }
    }

    @Test
    fun videoSourceClassifierAndPlaybackTargetHandleLocalRemoteInlineAndSecurity() {
        assertEquals(
            ClassifiedVideoSource.LocalPath("/Users/dev/Application Support/demo.mp4", null),
            VideoSourceClassifier.classify("/Users/dev/Application Support/demo.mp4"),
        )
        assertEquals(
            ClassifiedVideoSource.LocalPath("recordings/ui.webm", "/repo/wt"),
            VideoSourceClassifier.classify("recordings/ui.webm", "/repo/wt"),
        )
        assertTrue(VideoSourceClassifier.classify("recordings/ui.webm", null) is ClassifiedVideoSource.Invalid)
        assertEquals(
            ClassifiedVideoSource.RemoteUrl("https://cdn.example.com/demo.mp4"),
            VideoSourceClassifier.classify("//cdn.example.com/demo.mp4"),
        )
        assertTrue(
            VideoSourceClassifier.classify("data:video/mp4;base64,AAAA") is ClassifiedVideoSource.DataUrl,
        )
        assertTrue(
            VideoSourceClassifier.classify("javascript:alert(1)") is ClassifiedVideoSource.Invalid,
        )
        assertEquals("MP4", VideoSourceClassifier.extractFormatBadge("/tmp/a.mp4?v=1"))
        assertEquals("WEBM", VideoSourceClassifier.extractFormatBadge("/tmp/a.WEBM"))
        assertEquals("MOV", VideoSourceClassifier.extractFormatBadge("/tmp/screen.mov#t=2"))
        assertEquals("VIDEO", VideoSourceClassifier.extractFormatBadge("https://example.com/stream"))

        val client = ConductorApiClient()
        val cfg = ConnectionConfig(serverUrl = "http://100.64.0.10:4789", bearerToken = token)
        try {
            // Local video resolves to /api/media/video with Authorization header
            val localTarget = client.resolveVideoPlaybackTarget(
                config = cfg,
                rawSrc = "/Users/dev/Application Support/demo.mp4",
                basePath = "/Users/dev/repo",
            ).getOrThrow() as VideoPlaybackTarget.HttpStream
            assertTrue(localTarget.requiresConductorAuth)
            assertEquals("Bearer $token", localTarget.headers["Authorization"])
            assertTrue(localTarget.url.startsWith("http://100.64.0.10:4789/api/media/video?"))
            assertTrue(localTarget.url.contains("path=%2FUsers%2Fdev%2FApplication%20Support%2Fdemo.mp4"))
            assertTrue(localTarget.url.contains("base=%2FUsers%2Fdev%2Frepo"))
            assertEquals("MP4", localTarget.formatBadge)

            // Remote HTTP video MUST NOT receive Conductor Bearer token
            val remoteTarget = client.resolveVideoPlaybackTarget(
                config = cfg,
                rawSrc = "https://example.com/public/clip.webm",
            ).getOrThrow() as VideoPlaybackTarget.HttpStream
            assertTrue(!remoteTarget.requiresConductorAuth)
            assertTrue(remoteTarget.headers.isEmpty())
            assertEquals("https://example.com/public/clip.webm", remoteTarget.url)
            assertEquals("WEBM", remoteTarget.formatBadge)

            // Inline data:video URL produces InlineData target even without server config
            val inlineTarget = client.resolveVideoPlaybackTarget(
                config = null,
                rawSrc = "data:video/mp4;base64,AAAA",
            ).getOrThrow() as VideoPlaybackTarget.InlineData
            assertEquals("video/mp4", inlineTarget.mimeType)
            assertEquals("AAAA", inlineTarget.base64Data)

            // Unconfigured connection rejects local video cleanly
            assertTrue(client.resolveVideoPlaybackTarget(null, "/tmp/demo.mp4").isFailure)
        } finally {
            client.close()
        }

        // Video formatting & coordinator helpers
        assertEquals(null, VideoPlayerFormatting.formatDurationMs(null))
        assertEquals(null, VideoPlayerFormatting.formatDurationMs(0L))
        assertEquals("0:09", VideoPlayerFormatting.formatDurationMs(9_000L))
        assertEquals("2:05", VideoPlayerFormatting.formatDurationMs(125_000L))
        assertEquals("1:01:05", VideoPlayerFormatting.formatDurationMs(3_665_000L))
        assertTrue(VideoPlayerFormatting.mapHttpErrorCode(401).contains("401"))
        assertTrue(VideoPlayerFormatting.mapHttpErrorCode(404).contains("404"))
        assertTrue(VideoPlayerFormatting.mapHttpErrorCode(416).contains("416"))

        val coordinator = ConductorVideoPlaybackCoordinator()
        assertEquals(null, coordinator.activeInlineKey.value)
        coordinator.activateInline("v1")
        assertEquals("v1", coordinator.activeInlineKey.value)
        coordinator.activateInline("v2")
        assertEquals("v2", coordinator.activeInlineKey.value)
        coordinator.deactivateInline("v1")
        assertEquals("v2", coordinator.activeInlineKey.value)
        coordinator.pauseAllInline()
        assertEquals(null, coordinator.activeInlineKey.value)
    }
}
