package dev.conductor.mobile.data

import dev.conductor.mobile.model.AppUpdateDownloadProgress
import dev.conductor.mobile.model.AppUpdateErrorCode
import dev.conductor.mobile.model.AppUpdateLogic
import dev.conductor.mobile.model.AppUpdateReleaseAsset
import dev.conductor.mobile.model.AppUpdateReleaseInfo
import dev.conductor.mobile.model.GITHUB_LATEST_RELEASE_PAGE_URL
import dev.conductor.mobile.model.GITHUB_RELEASES_API_URL
import dev.conductor.mobile.model.GitHubReleaseDto
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.coroutineContext

sealed interface ReleaseFetchResult {
    data class Success(
        val release: AppUpdateReleaseInfo,
        val targetCommitish: String?,
        val fromCache: Boolean = false,
    ) : ReleaseFetchResult

    data class Failure(
        val errorCode: AppUpdateErrorCode,
        val message: String,
    ) : ReleaseFetchResult
}

class AppUpdateClient(
    private val releasesApiUrl: String = GITHUB_RELEASES_API_URL,
    private val fallbackReleasePageUrl: String = GITHUB_LATEST_RELEASE_PAGE_URL,
    private val userAgentVersion: String = "0.1.0",
    private val supportedAbis: List<String> = emptyList(),
    private val urlValidator: (String) -> Boolean = AppUpdateLogic::isAllowedDownloadUrl,
    apiTimeoutMs: Long = 15_000L,
    downloadReadTimeoutMs: Long = 60_000L,
) {
    @OptIn(ExperimentalSerializationApi::class)
    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        coerceInputValues = true
        explicitNulls = false
    }

    private val apiClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(apiTimeoutMs, TimeUnit.MILLISECONDS)
        .readTimeout(apiTimeoutMs, TimeUnit.MILLISECONDS)
        .callTimeout(apiTimeoutMs + 5_000L, TimeUnit.MILLISECONDS)
        .retryOnConnectionFailure(true)
        .followRedirects(true)
        .build()

    private val downloadClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(apiTimeoutMs, TimeUnit.MILLISECONDS)
        .readTimeout(downloadReadTimeoutMs, TimeUnit.MILLISECONDS)
        .retryOnConnectionFailure(true)
        .followRedirects(true)
        .followSslRedirects(true)
        .build()

    @Volatile
    private var cachedEtag: String? = null

    @Volatile
    private var cachedRelease: ReleaseFetchResult.Success? = null

    @Volatile
    private var activeDownloadCall: Call? = null

    suspend fun fetchLatestRelease(): ReleaseFetchResult = withContext(Dispatchers.IO) {
        val reqBuilder = Request.Builder()
            .url(releasesApiUrl)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header("User-Agent", "Conductor-Android/$userAgentVersion")
            .get()

        val etag = cachedEtag
        val cached = cachedRelease
        if (!etag.isNullOrBlank() && cached != null) {
            reqBuilder.header("If-None-Match", etag)
        }

        try {
            apiClient.newCall(reqBuilder.build()).execute().use { res ->
                if (res.code == 304 && cached != null) {
                    return@withContext cached.copy(fromCache = true)
                }

                if (!res.isSuccessful) {
                    return@withContext mapHttpError(
                        statusCode = res.code,
                        rateLimitRemaining = res.header("X-RateLimit-Remaining"),
                    )
                }

                val body = res.body?.string().orEmpty()
                val dto = runCatching { json.decodeFromString<GitHubReleaseDto>(body) }
                    .getOrElse { err ->
                        return@withContext ReleaseFetchResult.Failure(
                            errorCode = AppUpdateErrorCode.NETWORK,
                            message = "リリース情報の解析に失敗しました (${err.message ?: "不明な形式"})",
                        )
                    }

                val info = AppUpdateLogic.toReleaseInfo(
                    dto = dto,
                    supportedAbis = supportedAbis,
                    fallbackReleasePageUrl = fallbackReleasePageUrl,
                    urlValidator = urlValidator,
                ) ?: return@withContext ReleaseFetchResult.Failure(
                    errorCode = AppUpdateErrorCode.NO_RELEASE,
                    message = "公開されているリリースのタグ情報が取得できませんでした。",
                )

                val result = ReleaseFetchResult.Success(
                    release = info,
                    targetCommitish = dto.targetCommitish,
                    fromCache = false,
                )
                cachedEtag = res.header("ETag")
                cachedRelease = result
                result
            }
        } catch (ce: CancellationException) {
            throw ce
        } catch (_: UnknownHostException) {
            ReleaseFetchResult.Failure(
                errorCode = AppUpdateErrorCode.NETWORK,
                message = "GitHub に接続できません。インターネット接続を確認してください。",
            )
        } catch (_: SocketTimeoutException) {
            ReleaseFetchResult.Failure(
                errorCode = AppUpdateErrorCode.NETWORK,
                message = "アップデート確認がタイムアウトしました。時間をおいて再試行してください。",
            )
        } catch (err: Exception) {
            ReleaseFetchResult.Failure(
                errorCode = AppUpdateErrorCode.NETWORK,
                message = "アップデート確認に失敗しました: ${err.message ?: "ネットワークエラー"}",
            )
        }
    }

    suspend fun downloadApk(
        asset: AppUpdateReleaseAsset,
        updatesDir: File,
        onProgress: (AppUpdateDownloadProgress) -> Unit,
    ): Result<File> = withContext(Dispatchers.IO) {
        if (!urlValidator(asset.downloadUrl)) {
            return@withContext Result.failure(
                IOException("許可されていないダウンロード URL のため中止しました。"),
            )
        }

        if (!updatesDir.exists() && !updatesDir.mkdirs()) {
            return@withContext Result.failure(
                IOException("APK 保存用ディレクトリの作成に失敗しました。"),
            )
        }

        val safeName = AppUpdateLogic.sanitizeApkFileName(asset.name)
        val destFile = File(updatesDir, safeName)
        val partFile = File(updatesDir, "$safeName.part")

        val request = Request.Builder()
            .url(asset.downloadUrl)
            .header("User-Agent", "Conductor-Android/$userAgentVersion")
            .header("Accept", "application/octet-stream")
            .get()
            .build()

        val call = downloadClient.newCall(request)
        activeDownloadCall = call

        try {
            val initialTotal = asset.size.takeIf { it > 0L }
            onProgress(
                AppUpdateDownloadProgress(
                    downloadedBytes = 0L,
                    totalBytes = initialTotal,
                    percent = if (initialTotal != null) 0 else null,
                ),
            )

            call.execute().use { res ->
                if (!res.isSuccessful) {
                    throw IOException("APK のダウンロードに失敗しました (HTTP ${res.code})")
                }
                val finalUrl = res.request.url.toString()
                if (!urlValidator(finalUrl)) {
                    throw IOException("リダイレクト先 URL が許可ドメイン外のため中止しました。")
                }

                val body = res.body ?: throw IOException("ダウンロード応答が空です。")
                val headerTotal = body.contentLength().takeIf { it > 0L }
                val totalBytes = headerTotal ?: initialTotal

                if (partFile.exists()) {
                    partFile.delete()
                }

                var downloadedBytes = 0L
                var lastEmitAtMs = 0L
                var lastPercent = -1
                val magicHeader = ByteArray(4)
                var magicRead = 0

                body.byteStream().use { input ->
                    FileOutputStream(partFile).use { output ->
                        val buffer = ByteArray(16 * 1024)
                        while (true) {
                            coroutineContext.ensureActive()
                            val read = input.read(buffer)
                            if (read <= 0) break

                            if (magicRead < 4) {
                                val toCopy = minOf(4 - magicRead, read)
                                System.arraycopy(buffer, 0, magicHeader, magicRead, toCopy)
                                magicRead += toCopy
                            }

                            output.write(buffer, 0, read)
                            downloadedBytes += read

                            val now = System.currentTimeMillis()
                            val percent = totalBytes?.takeIf { it > 0L }?.let { total ->
                                ((downloadedBytes * 100L) / total).toInt().coerceIn(0, 100)
                            }
                            if (now - lastEmitAtMs >= 80L || (percent != null && percent != lastPercent)) {
                                lastEmitAtMs = now
                                lastPercent = percent ?: -1
                                onProgress(
                                    AppUpdateDownloadProgress(
                                        downloadedBytes = downloadedBytes,
                                        totalBytes = totalBytes,
                                        percent = percent,
                                    ),
                                )
                            }
                        }
                        output.flush()
                    }
                }

                if (downloadedBytes <= 0L || !AppUpdateLogic.isValidApkHeader(magicHeader, magicRead)) {
                    partFile.delete()
                    throw IOException("ダウンロードしたファイルが有効な APK ではありません。")
                }

                // Clean up stale APKs in cache/updates/ before finalizing
                updatesDir.listFiles()?.forEach { existing ->
                    if (existing.isFile &&
                        existing.name != partFile.name &&
                        existing.name.endsWith(".apk", ignoreCase = true)
                    ) {
                        existing.delete()
                    }
                }
                if (destFile.exists()) {
                    destFile.delete()
                }
                if (!partFile.renameTo(destFile)) {
                    partFile.copyTo(destFile, overwrite = true)
                    partFile.delete()
                }

                val finalTotal = totalBytes ?: downloadedBytes
                onProgress(
                    AppUpdateDownloadProgress(
                        downloadedBytes = downloadedBytes,
                        totalBytes = finalTotal,
                        percent = 100,
                    ),
                )
                Result.success(destFile)
            }
        } catch (ce: CancellationException) {
            partFile.delete()
            throw ce
        } catch (err: Exception) {
            partFile.delete()
            val message = when (err) {
                is UnknownHostException -> "ダウンロード中にネットワーク接続が失われました。"
                is SocketTimeoutException -> "APK のダウンロードがタイムアウトしました。"
                else -> err.message?.takeIf { it.isNotBlank() } ?: "APK のダウンロードに失敗しました。"
            }
            Result.failure(IOException(message, err))
        } finally {
            if (activeDownloadCall === call) {
                activeDownloadCall = null
            }
        }
    }

    fun cancelDownload() {
        activeDownloadCall?.cancel()
    }

    fun close() {
        cancelDownload()
        apiClient.connectionPool.evictAll()
        downloadClient.connectionPool.evictAll()
    }

    private fun mapHttpError(statusCode: Int, rateLimitRemaining: String?): ReleaseFetchResult.Failure =
        when {
            statusCode == 404 -> ReleaseFetchResult.Failure(
                errorCode = AppUpdateErrorCode.NO_RELEASE,
                message = "公開されているリリースが見つかりません (HTTP 404)。",
            )
            statusCode == 429 || (statusCode == 403 && rateLimitRemaining == "0") ->
                ReleaseFetchResult.Failure(
                    errorCode = AppUpdateErrorCode.RATE_LIMIT,
                    message = "GitHub API のレート制限に達しました。しばらく待ってから再試行してください。",
                )
            else -> ReleaseFetchResult.Failure(
                errorCode = AppUpdateErrorCode.NETWORK,
                message = "GitHub API エラー (HTTP $statusCode) が発生しました。",
            )
        }
}
