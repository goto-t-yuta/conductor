package dev.conductor.mobile

import dev.conductor.mobile.data.AppUpdateClient
import dev.conductor.mobile.data.ReleaseFetchResult
import dev.conductor.mobile.model.AppUpdateDownloadProgress
import dev.conductor.mobile.model.AppUpdateErrorCode
import dev.conductor.mobile.model.AppUpdateReleaseAsset
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.nio.file.Files
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

private class UpdateHttpTestServer {
    private val serverSocket = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
    private val executor: ExecutorService = Executors.newCachedThreadPool()

    @Volatile
    private var running = true

    @Volatile
    var handler: (requestLine: String, headers: Map<String, String>, out: OutputStream) -> Unit =
        { _, _, out ->
            out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
            out.flush()
        }

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
                            while (true) {
                                val line = reader.readLine() ?: break
                                if (line.isEmpty()) break
                                val idx = line.indexOf(':')
                                if (idx > 0) {
                                    headers[line.substring(0, idx).trim().lowercase()] =
                                        line.substring(idx + 1).trim()
                                }
                            }
                            handler(requestLine, headers, sock.getOutputStream())
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

class AppUpdateClientTest {
    private lateinit var server: UpdateHttpTestServer
    private lateinit var tempDir: File

    @Before
    fun setUp() {
        server = UpdateHttpTestServer()
        server.start()
        tempDir = Files.createTempDirectory("conductor-update-test").toFile()
    }

    @After
    fun tearDown() {
        server.stop()
        tempDir.deleteRecursively()
    }

    @Test
    fun fetchLatestReleaseParsesJsonAndUsesEtagCacheOn304() = runBlocking {
        var callCount = 0
        var seenIfNoneMatch: String? = null
        server.handler = { _, headers, out ->
            callCount += 1
            seenIfNoneMatch = headers["if-none-match"]
            if (callCount == 1) {
                val body = """
                    {
                      "tag_name": "v0.1.0-6-75aab02",
                      "name": "Conductor v0.1.0-6-75aab02",
                      "html_url": "https://github.com/goto-t-yuta/conductor/releases/tag/v0.1.0-6-75aab02",
                      "published_at": "2026-11-27T04:38:44Z",
                      "target_commitish": "75aab02da79c2e84c8ed0feddeb30271568def7f",
                      "body": "## What's Changed\n* Android updater support",
                      "assets": [
                        {
                          "name": "conductor-android.apk",
                          "size": 123456,
                          "content_type": "application/vnd.android.package-archive",
                          "browser_download_url": "${server.baseUrl}/downloads/conductor-android.apk"
                        }
                      ]
                    }
                """.trimIndent().toByteArray(Charsets.UTF_8)
                val head = "HTTP/1.1 200 OK\r\n" +
                    "Content-Type: application/json; charset=utf-8\r\n" +
                    "ETag: W/\"release-etag-6\"\r\n" +
                    "Content-Length: ${body.size}\r\n" +
                    "Connection: close\r\n\r\n"
                out.write(head.toByteArray(Charsets.UTF_8))
                out.write(body)
                out.flush()
            } else {
                val head = "HTTP/1.1 304 Not Modified\r\nConnection: close\r\n\r\n"
                out.write(head.toByteArray(Charsets.UTF_8))
                out.flush()
            }
        }

        val client = AppUpdateClient(
            releasesApiUrl = "${server.baseUrl}/releases/latest",
            urlValidator = { it.startsWith(server.baseUrl) },
        )
        try {
            val first = client.fetchLatestRelease()
            assertTrue(first is ReleaseFetchResult.Success)
            val ok1 = first as ReleaseFetchResult.Success
            assertFalse(ok1.fromCache)
            assertEquals("v0.1.0-6-75aab02", ok1.release.tagName)
            assertEquals("conductor-android.apk", ok1.release.apkAsset?.name)

            val second = client.fetchLatestRelease()
            assertTrue(second is ReleaseFetchResult.Success)
            val ok2 = second as ReleaseFetchResult.Success
            assertTrue(ok2.fromCache)
            assertEquals("W/\"release-etag-6\"", seenIfNoneMatch)
            assertEquals("v0.1.0-6-75aab02", ok2.release.tagName)
        } finally {
            client.close()
        }
    }

    @Test
    fun fetchLatestReleaseMaps404AndRateLimitErrors() = runBlocking {
        server.handler = { reqLine, _, out ->
            val path = reqLine.split(" ").getOrNull(1)
            val resp = when (path) {
                "/404" -> "HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"
                "/ratelimit" -> "HTTP/1.1 403 Forbidden\r\nX-RateLimit-Remaining: 0\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"
                else -> "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"
            }
            out.write(resp.toByteArray(Charsets.UTF_8))
            out.flush()
        }

        val notFoundClient = AppUpdateClient(releasesApiUrl = "${server.baseUrl}/404")
        val rateLimitClient = AppUpdateClient(releasesApiUrl = "${server.baseUrl}/ratelimit")
        try {
            val r404 = notFoundClient.fetchLatestRelease()
            assertTrue(r404 is ReleaseFetchResult.Failure)
            assertEquals(AppUpdateErrorCode.NO_RELEASE, (r404 as ReleaseFetchResult.Failure).errorCode)

            val r403 = rateLimitClient.fetchLatestRelease()
            assertTrue(r403 is ReleaseFetchResult.Failure)
            assertEquals(AppUpdateErrorCode.RATE_LIMIT, (r403 as ReleaseFetchResult.Failure).errorCode)
        } finally {
            notFoundClient.close()
            rateLimitClient.close()
        }
    }

    @Test
    fun downloadApkStreamsProgressValidatesZipHeaderAndCleansStaleApks() = runBlocking {
        val fakeApkBytes = ByteArray(64 * 1024) { idx -> (idx % 251).toByte() }.apply {
            this[0] = 0x50 // P
            this[1] = 0x4B // K
            this[2] = 0x03
            this[3] = 0x04
        }

        server.handler = { reqLine, _, out ->
            val path = reqLine.split(" ").getOrNull(1)
            if (path == "/good.apk") {
                val head = "HTTP/1.1 200 OK\r\n" +
                    "Content-Type: application/vnd.android.package-archive\r\n" +
                    "Content-Length: ${fakeApkBytes.size}\r\n" +
                    "Connection: close\r\n\r\n"
                out.write(head.toByteArray(Charsets.UTF_8))
                out.write(fakeApkBytes)
                out.flush()
            } else {
                val html = "<html>Not an APK</html>".toByteArray(Charsets.UTF_8)
                val head = "HTTP/1.1 200 OK\r\n" +
                    "Content-Type: text/html\r\n" +
                    "Content-Length: ${html.size}\r\n" +
                    "Connection: close\r\n\r\n"
                out.write(head.toByteArray(Charsets.UTF_8))
                out.write(html)
                out.flush()
            }
        }

        val updatesDir = File(tempDir, "updates").apply { mkdirs() }
        val staleApk = File(updatesDir, "old-version.apk").apply { writeText("stale") }

        val client = AppUpdateClient(
            releasesApiUrl = "${server.baseUrl}/releases/latest",
            urlValidator = { it.startsWith(server.baseUrl) },
        )
        try {
            val progressEvents = mutableListOf<AppUpdateDownloadProgress>()
            val goodResult = client.downloadApk(
                asset = AppUpdateReleaseAsset(
                    name = "conductor-android.apk",
                    downloadUrl = "${server.baseUrl}/good.apk",
                    size = fakeApkBytes.size.toLong(),
                    contentType = "application/vnd.android.package-archive",
                ),
                updatesDir = updatesDir,
                onProgress = { progressEvents.add(it) },
            )
            assertTrue(goodResult.isSuccess)
            val savedFile = goodResult.getOrThrow()
            assertTrue(savedFile.isFile)
            assertEquals("conductor-android.apk", savedFile.name)
            assertArrayEquals(fakeApkBytes, savedFile.readBytes())
            assertFalse("Stale APK should be removed", staleApk.exists())
            assertNotNull(progressEvents.lastOrNull())
            assertEquals(100, progressEvents.last().percent)

            // Invalid APK payload (HTML page) should fail and leave no .part file
            val badResult = client.downloadApk(
                asset = AppUpdateReleaseAsset(
                    name = "bad.apk",
                    downloadUrl = "${server.baseUrl}/bad.apk",
                    size = 24L,
                    contentType = "application/vnd.android.package-archive",
                ),
                updatesDir = updatesDir,
                onProgress = {},
            )
            assertTrue(badResult.isFailure)
            assertFalse(File(updatesDir, "bad.apk").exists())
            assertFalse(File(updatesDir, "bad.apk.part").exists())
        } finally {
            client.close()
        }
    }
}
