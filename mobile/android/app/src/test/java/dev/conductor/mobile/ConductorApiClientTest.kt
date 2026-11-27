package dev.conductor.mobile

import dev.conductor.mobile.data.ConductorApiClient
import dev.conductor.mobile.data.SseEvent
import dev.conductor.mobile.model.ChatAttachment
import dev.conductor.mobile.model.ConnectionConfig
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
}
