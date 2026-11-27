package dev.conductor.mobile

import dev.conductor.mobile.data.TerminalWebSocketClient
import dev.conductor.mobile.data.TerminalWsEvent
import dev.conductor.mobile.model.ConnectionConfig
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.BufferedReader
import java.io.InputStream
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.Executors

private class MiniWebSocketTestServer {
    private val serverSocket = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
    private val executor = Executors.newCachedThreadPool()

    @Volatile
    private var running = true

    @Volatile
    var rejectAuth: Boolean = false

    @Volatile
    var lastAuthHeader: String? = null

    @Volatile
    var lastRequestLine: String? = null

    val receivedClientMessages = mutableListOf<String>()

    val baseUrl: String
        get() = "http://127.0.0.1:${serverSocket.localPort}"

    fun start() {
        executor.execute {
            while (running && !serverSocket.isClosed) {
                val sock = runCatching { serverSocket.accept() }.getOrNull() ?: break
                executor.execute {
                    sock.use { socket ->
                        runCatching {
                            val input = socket.getInputStream()
                            val output = socket.getOutputStream()
                            val reader = BufferedReader(InputStreamReader(input, Charsets.UTF_8))
                            val reqLine = reader.readLine() ?: return@runCatching
                            lastRequestLine = reqLine
                            val headers = mutableMapOf<String, String>()
                            while (true) {
                                val line = reader.readLine() ?: break
                                if (line.isEmpty()) break
                                val idx = line.indexOf(':')
                                if (idx > 0) {
                                    headers[line.substring(0, idx).trim().lowercase()] =
                                        line.substring(idx + 1).trim()
                                }
                            }
                            lastAuthHeader = headers["authorization"]

                            if (rejectAuth) {
                                val body = """{"ok":false,"error":"Unauthorized"}"""
                                val resp = "HTTP/1.1 401 Unauthorized\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n$body"
                                output.write(resp.toByteArray(Charsets.UTF_8))
                                output.flush()
                                return@runCatching
                            }

                            val key = headers["sec-websocket-key"] ?: return@runCatching
                            val sha1 = MessageDigest.getInstance("SHA-1")
                                .digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray(Charsets.UTF_8))
                            val accept = Base64.getEncoder().encodeToString(sha1)
                            val upgrade = "HTTP/1.1 101 Switching Protocols\r\n" +
                                "Upgrade: websocket\r\n" +
                                "Connection: Upgrade\r\n" +
                                "Sec-WebSocket-Accept: $accept\r\n\r\n"
                            output.write(upgrade.toByteArray(Charsets.UTF_8))
                            output.flush()

                            // Send initial ready message with replay buffer
                            sendTextFrame(
                                output,
                                """{"type":"ready","session":{"id":"term-1","cwd":"/Users/dev/conductor","shellName":"zsh","cols":72,"rows":24,"status":"running"},"replay":"% pwd\r\n/Users/dev/conductor\r\n","seq":5,"replayMode":"full","recreated":false}""",
                            )

                            // Read one masked text frame from client and reply with output
                            val clientText = readClientTextFrame(input)
                            if (clientText != null) {
                                synchronized(receivedClientMessages) {
                                    receivedClientMessages.add(clientText)
                                }
                                sendTextFrame(
                                    output,
                                    """{"type":"output","sessionId":"term-1","data":"README.md\r\n","seq":6}""",
                                )
                            }
                            Thread.sleep(300)
                        }
                    }
                }
            }
        }
    }

    private fun sendTextFrame(out: OutputStream, text: String) {
        val bytes = text.toByteArray(Charsets.UTF_8)
        val header = when {
            bytes.size < 126 -> byteArrayOf(0x81.toByte(), bytes.size.toByte())
            else -> byteArrayOf(
                0x81.toByte(),
                126,
                ((bytes.size shr 8) and 0xFF).toByte(),
                (bytes.size and 0xFF).toByte(),
            )
        }
        out.write(header)
        out.write(bytes)
        out.flush()
    }

    private fun readClientTextFrame(input: InputStream): String? {
        val b0 = input.read()
        val b1 = input.read()
        if (b0 < 0 || b1 < 0) return null
        val masked = (b1 and 0x80) != 0
        var len = b1 and 0x7F
        if (len == 126) {
            len = (input.read() shl 8) or input.read()
        }
        val mask = if (masked) ByteArray(4) { input.read().toByte() } else null
        val payload = ByteArray(len)
        var read = 0
        while (read < len) {
            val n = input.read(payload, read, len - read)
            if (n <= 0) break
            read += n
        }
        if (mask != null) {
            for (i in 0 until len) {
                payload[i] = (payload[i].toInt() xor mask[i and 3].toInt()).toByte()
            }
        }
        return String(payload, Charsets.UTF_8)
    }

    fun stop() {
        running = false
        runCatching { serverSocket.close() }
        executor.shutdownNow()
    }
}

class TerminalWebSocketClientTest {
    private lateinit var server: MiniWebSocketTestServer
    private val token = "term-ws-secret-token"

    @Before
    fun setUp() {
        server = MiniWebSocketTestServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.stop()
    }

    @Test
    fun buildsProperWsAndWssUrlsWithQueryParams() {
        val client = TerminalWebSocketClient()
        try {
            val wsUrl = client.buildTerminalWsUrl(
                config = ConnectionConfig("http://100.64.0.2:4789/", token),
                sessionId = "term-9",
                projectPath = "/Users/dev/my app",
                cols = 80,
                rows = 24,
                afterSeq = 12L,
            )
            assertTrue(wsUrl.startsWith("ws://100.64.0.2:4789/api/terminal/ws?"))
            assertTrue(wsUrl.contains("sessionId=term-9"))
            assertTrue(wsUrl.contains("projectPath=%2FUsers%2Fdev%2Fmy%20app"))
            assertTrue(wsUrl.contains("cols=80"))
            assertTrue(wsUrl.contains("rows=24"))
            assertTrue(wsUrl.contains("afterSeq=12"))

            val wssUrl = client.buildTerminalWsUrl(
                config = ConnectionConfig("https://mac.tailnet.ts.net", token),
            )
            assertEquals("wss://mac.tailnet.ts.net/api/terminal/ws", wssUrl)
        } finally {
            client.close()
        }
    }

    @Test
    fun connectsAuthenticatesReceivesReplayAndExchangesCommands() = runBlocking {
        val client = TerminalWebSocketClient()
        val cfg = ConnectionConfig(server.baseUrl, token)
        try {
            val handle = client.connect(
                config = cfg,
                projectPath = "/Users/dev/conductor",
                cols = 72,
                rows = 24,
            )
            val ready = withTimeout(5_000) {
                handle.events.filterIsInstance<TerminalWsEvent.Ready>().first()
            }
            assertEquals("term-1", ready.session.id)
            assertEquals("zsh", ready.session.shellName)
            assertTrue(ready.replay.contains("/Users/dev/conductor"))
            assertEquals("Bearer $token", server.lastAuthHeader)

            assertTrue(handle.sendInput("ls\r"))
            val output = withTimeout(5_000) {
                handle.events.filterIsInstance<TerminalWsEvent.Output>().first()
            }
            assertEquals("README.md\r\n", output.data)
            assertEquals(6L, output.seq)
            assertTrue(server.receivedClientMessages.first().contains("\"type\":\"input\""))

            handle.disconnect()
        } finally {
            client.close()
        }
    }

    @Test
    fun surfacesUnauthorizedFlagOn401Handshake() = runBlocking {
        server.rejectAuth = true
        val client = TerminalWebSocketClient()
        try {
            val handle = client.connect(ConnectionConfig(server.baseUrl, "wrong"))
            val disconnect = withTimeout(5_000) {
                handle.events.filterIsInstance<TerminalWsEvent.Disconnected>().first()
            }
            assertTrue(disconnect.unauthorized)
            assertTrue(disconnect.reason.contains("401"))
        } finally {
            client.close()
        }
    }
}
