package dev.conductor.mobile.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.net.URI
import java.util.Locale

const val GITHUB_REPO_OWNER = "goto-t-yuta"
const val GITHUB_REPO_NAME = "conductor"
const val GITHUB_RELEASES_API_URL =
    "https://api.github.com/repos/$GITHUB_REPO_OWNER/$GITHUB_REPO_NAME/releases/latest"
const val GITHUB_LATEST_RELEASE_PAGE_URL =
    "https://github.com/$GITHUB_REPO_OWNER/$GITHUB_REPO_NAME/releases/latest"

enum class AppUpdateStatus {
    IDLE,
    CHECKING,
    AVAILABLE,
    UP_TO_DATE,
    DOWNLOADING,
    DOWNLOADED,
    ERROR,
}

enum class AppUpdateErrorCode {
    NETWORK,
    RATE_LIMIT,
    NO_RELEASE,
    NO_ASSET,
    DOWNLOAD_FAILED,
    INSTALL_PERMISSION_REQUIRED,
    INSTALL_FAILED,
}

data class CurrentBuildInfo(
    val versionName: String,
    val versionCode: Int,
    val buildTag: String? = null,
    val commitSha: String? = null,
    val runNumber: Int? = null,
) {
    val displayVersion: String
        get() {
            val tag = buildTag?.trim().orEmpty()
            if (tag.isNotEmpty()) return tag
            val trimmed = versionName.trim()
            if (trimmed.isEmpty()) return "v0.0.0"
            return if (trimmed.startsWith("v", ignoreCase = true)) trimmed else "v$trimmed"
        }
}

data class ParsedReleaseTag(
    val raw: String,
    val major: Int,
    val minor: Int,
    val patch: Int,
    val semver: String,
    val runNumber: Int? = null,
    val commitSha: String? = null,
    val prerelease: String? = null,
)

@Serializable
data class GitHubReleaseAssetDto(
    val name: String = "",
    @SerialName("browser_download_url")
    val browserDownloadUrl: String = "",
    val size: Long = 0L,
    @SerialName("content_type")
    val contentType: String? = null,
)

@Serializable
data class GitHubReleaseDto(
    @SerialName("tag_name")
    val tagName: String = "",
    val name: String? = null,
    val body: String? = null,
    @SerialName("html_url")
    val htmlUrl: String? = null,
    @SerialName("published_at")
    val publishedAt: String? = null,
    @SerialName("target_commitish")
    val targetCommitish: String? = null,
    val draft: Boolean = false,
    val prerelease: Boolean = false,
    val assets: List<GitHubReleaseAssetDto> = emptyList(),
)

data class AppUpdateReleaseAsset(
    val name: String,
    val downloadUrl: String,
    val size: Long,
    val contentType: String,
)

data class AppUpdateReleaseInfo(
    val tagName: String,
    val version: String,
    val name: String,
    val body: String,
    val notesExcerpt: String,
    val htmlUrl: String,
    val publishedAt: String?,
    val apkAsset: AppUpdateReleaseAsset?,
    val allAssetsCount: Int,
)

data class AppUpdateDownloadProgress(
    val downloadedBytes: Long,
    val totalBytes: Long?,
    val percent: Int?,
)

data class AppUpdateState(
    val status: AppUpdateStatus = AppUpdateStatus.IDLE,
    val currentBuild: CurrentBuildInfo = CurrentBuildInfo(versionName = "0.1.0", versionCode = 1),
    val lastCheckedAtMs: Long? = null,
    val latestRelease: AppUpdateReleaseInfo? = null,
    val updateAvailable: Boolean = false,
    val downloadProgress: AppUpdateDownloadProgress? = null,
    val downloadedApkPath: String? = null,
    val needsUnknownSourcesPermission: Boolean = false,
    val errorMessage: String? = null,
    val errorCode: AppUpdateErrorCode? = null,
    val bannerDismissedForTag: String? = null,
) {
    val shouldShowTopBanner: Boolean
        get() = updateAvailable &&
            latestRelease != null &&
            bannerDismissedForTag != latestRelease.tagName &&
            status in setOf(
                AppUpdateStatus.AVAILABLE,
                AppUpdateStatus.DOWNLOADING,
                AppUpdateStatus.DOWNLOADED,
            )

    val hasAttentionBadge: Boolean
        get() = updateAvailable ||
            status == AppUpdateStatus.DOWNLOADING ||
            status == AppUpdateStatus.DOWNLOADED
}

object AppUpdateLogic {
    private val ciTagRegex = Regex(
        """^v?(\d+)\.(\d+)\.(\d+)-(\d+)-([0-9a-f]{7,40})(?:\+.*)?$""",
        RegexOption.IGNORE_CASE,
    )
    private val semverTagRegex = Regex(
        """^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9a-z.-]+))?(?:\+([0-9a-z.-]+))?$""",
        RegexOption.IGNORE_CASE,
    )
    private val shaRegex = Regex("""^[0-9a-f]{7,40}$""", RegexOption.IGNORE_CASE)
    private val digitsOnlyRegex = Regex("""^\d+$""")
    private val htmlCommentRegex = Regex("""<!--[\s\S]*?-->""")
    private val markdownLinkRegex = Regex("""\[([^\]]+)]\(https?://[^)]+\)""")
    private val multipleBlankLinesRegex = Regex("""\n{3,}""")
    private val fullChangelogLineRegex = Regex("""^\*\*Full Changelog\*\*:""", RegexOption.IGNORE_CASE)
    private val macOsGatekeeperLineRegex = Regex(
        """^>\s*\*\*macOS\s*\(unsigned build\)\*\*:.*$""",
        RegexOption.IGNORE_CASE,
    )
    private val unsafeFileNameCharsRegex = Regex("""[<>:"/\\|?*\u0000-\u001F]""")

    private val allowedDownloadHosts = setOf(
        "github.com",
        "objects.githubusercontent.com",
        "release-assets.githubusercontent.com",
        "github-releases.githubusercontent.com",
        "codeload.github.com",
    )

    fun parseReleaseTag(rawTagOrVersion: String?): ParsedReleaseTag? {
        val trimmed = rawTagOrVersion?.trim().orEmpty()
        if (trimmed.isEmpty()) return null

        val ciMatch = ciTagRegex.matchEntire(trimmed)
        if (ciMatch != null) {
            val major = ciMatch.groupValues[1].toIntOrNull() ?: return null
            val minor = ciMatch.groupValues[2].toIntOrNull() ?: return null
            val patch = ciMatch.groupValues[3].toIntOrNull() ?: return null
            val runNumber = ciMatch.groupValues[4].toIntOrNull()
            val commitSha = ciMatch.groupValues[5].lowercase(Locale.ROOT)
            return ParsedReleaseTag(
                raw = trimmed,
                major = major,
                minor = minor,
                patch = patch,
                semver = "$major.$minor.$patch",
                runNumber = runNumber,
                commitSha = commitSha,
                prerelease = null,
            )
        }

        val semverMatch = semverTagRegex.matchEntire(trimmed)
        if (semverMatch != null) {
            val major = semverMatch.groupValues[1].toIntOrNull() ?: return null
            val minor = semverMatch.groupValues[2].toIntOrNull() ?: return null
            val patch = semverMatch.groupValues[3].toIntOrNull() ?: return null
            val prerelease = semverMatch.groupValues[4]
                .takeIf { it.isNotBlank() }
                ?.lowercase(Locale.ROOT)
            return ParsedReleaseTag(
                raw = trimmed,
                major = major,
                minor = minor,
                patch = patch,
                semver = "$major.$minor.$patch",
                runNumber = null,
                commitSha = null,
                prerelease = prerelease,
            )
        }

        return null
    }

    private fun comparePrerelease(a: String?, b: String?): Int {
        if (a == b) return 0
        if (a == null) return 1
        if (b == null) return -1

        val aParts = a.split('.')
        val bParts = b.split('.')
        val len = maxOf(aParts.size, bParts.size)
        for (i in 0 until len) {
            val aPart = aParts.getOrNull(i) ?: return -1
            val bPart = bParts.getOrNull(i) ?: return 1
            if (aPart == bPart) continue

            val aNum = if (digitsOnlyRegex.matches(aPart)) aPart.toLongOrNull() else null
            val bNum = if (digitsOnlyRegex.matches(bPart)) bPart.toLongOrNull() else null
            return when {
                aNum != null && bNum != null -> aNum.compareTo(bNum)
                aNum != null -> -1
                bNum != null -> 1
                else -> aPart.compareTo(bPart)
            }
        }
        return 0
    }

    private fun normalizeSha(sha: String?): String? {
        val cleaned = sha?.trim()?.lowercase(Locale.ROOT).orEmpty()
        return cleaned.takeIf { shaRegex.matches(it) }
    }

    private fun shasMatch(a: String?, b: String?): Boolean {
        if (a == null || b == null) return false
        val minLen = minOf(a.length, b.length)
        if (minLen < 7) return false
        return a.startsWith(b.substring(0, minLen)) || b.startsWith(a.substring(0, minLen))
    }

    private fun resolveCurrentParsed(current: CurrentBuildInfo): ParsedReleaseTag? {
        val base = parseReleaseTag(current.buildTag) ?: parseReleaseTag(current.versionName) ?: return null
        val commitSha = normalizeSha(current.commitSha) ?: base.commitSha
        val runNumber = current.runNumber?.takeIf { it > 0 }
            ?: base.runNumber
            ?: current.versionCode.takeIf { it > 1 }
        return base.copy(
            commitSha = commitSha,
            runNumber = runNumber,
        )
    }

    /**
     * Compares [latestTag] against [current].
     * Returns:
     *  - `1`  if [latestTag] is newer than [current] (update available)
     *  - `0`  if [latestTag] matches [current]
     *  - `-1` if [current] is newer than [latestTag]
     */
    fun compareReleaseVersions(
        current: CurrentBuildInfo,
        latestTag: String,
        latestTargetCommitish: String? = null,
    ): Int {
        val parsedCurrent = resolveCurrentParsed(current)
        val parsedLatest = parseReleaseTag(latestTag)

        if (parsedLatest == null) {
            val currentNorm = (current.buildTag?.takeIf { it.isNotBlank() } ?: current.versionName)
                .trim()
                .lowercase(Locale.ROOT)
            val latestNorm = latestTag.trim().lowercase(Locale.ROOT)
            return if (latestNorm.isEmpty() || currentNorm == latestNorm) 0 else 1
        }

        if (parsedCurrent == null) return 1

        // 1. Compare core semver: major.minor.patch
        if (parsedLatest.major != parsedCurrent.major) {
            return if (parsedLatest.major > parsedCurrent.major) 1 else -1
        }
        if (parsedLatest.minor != parsedCurrent.minor) {
            return if (parsedLatest.minor > parsedCurrent.minor) 1 else -1
        }
        if (parsedLatest.patch != parsedCurrent.patch) {
            return if (parsedLatest.patch > parsedCurrent.patch) 1 else -1
        }

        // 2. Compare standard SemVer prerelease (e.g. 0.2.0-beta.1 vs 0.2.0)
        val preCmp = comparePrerelease(parsedLatest.prerelease, parsedCurrent.prerelease)
        if (preCmp != 0) return if (preCmp > 0) 1 else -1

        // 3. Same semver core & prerelease — compare CI build metadata (commitSha & runNumber)
        val latestSha = parsedLatest.commitSha ?: normalizeSha(latestTargetCommitish)
        val currentSha = parsedCurrent.commitSha
        if (shasMatch(currentSha, latestSha)) {
            return 0
        }

        val latestRun = parsedLatest.runNumber
        val currentRun = parsedCurrent.runNumber
        if (latestRun != null && currentRun != null) {
            return when {
                latestRun > currentRun -> 1
                latestRun < currentRun -> -1
                else -> 0
            }
        }

        // Local/legacy unnumbered build (e.g. 0.1.0, versionCode=1) vs numbered CI release with different SHA
        if (latestRun != null && currentRun == null) {
            return 1
        }

        return 0
    }

    fun isUpdateAvailable(
        current: CurrentBuildInfo,
        latestTag: String,
        latestTargetCommitish: String? = null,
    ): Boolean = compareReleaseVersions(current, latestTag, latestTargetCommitish) > 0

    fun isAllowedDownloadUrl(rawUrl: String): Boolean {
        val uri = runCatching { URI(rawUrl.trim()) }.getOrNull() ?: return false
        if (!uri.scheme.equals("https", ignoreCase = true)) return false
        val host = uri.host?.lowercase(Locale.ROOT) ?: return false
        return host in allowedDownloadHosts ||
            host.endsWith(".githubusercontent.com") ||
            host.endsWith(".github.com")
    }

    fun selectAndroidApkAsset(
        assets: List<GitHubReleaseAssetDto>,
        supportedAbis: List<String> = emptyList(),
        urlValidator: (String) -> Boolean = ::isAllowedDownloadUrl,
    ): AppUpdateReleaseAsset? {
        if (assets.isEmpty()) return null
        val normalizedAbis = supportedAbis.map { it.trim().lowercase(Locale.ROOT) }.filter { it.isNotEmpty() }

        var bestAsset: GitHubReleaseAssetDto? = null
        var bestScore = -1

        for (asset in assets) {
            val name = asset.name.trim()
            val downloadUrl = asset.browserDownloadUrl.trim()
            if (name.isEmpty() || downloadUrl.isEmpty()) continue
            if (!urlValidator(downloadUrl)) continue

            val score = scoreAndroidApkAsset(name, normalizedAbis)
            if (score > bestScore) {
                bestScore = score
                bestAsset = asset
            }
        }

        val winner = bestAsset ?: return null
        return AppUpdateReleaseAsset(
            name = winner.name.trim(),
            downloadUrl = winner.browserDownloadUrl.trim(),
            size = winner.size.coerceAtLeast(0L),
            contentType = winner.contentType?.trim()?.ifEmpty { null }
                ?: "application/vnd.android.package-archive",
        )
    }

    private fun scoreAndroidApkAsset(name: String, supportedAbis: List<String>): Int {
        val lower = name.lowercase(Locale.ROOT)
        if (!lower.endsWith(".apk")) return -1

        val abiScore = when {
            lower.contains("universal") -> 80
            lower.contains("arm64-v8a") || lower.contains("arm64") || lower.contains("aarch64") ->
                scoreForAbi("arm64-v8a", supportedAbis)
            lower.contains("armeabi-v7a") || lower.contains("armeabi") ->
                scoreForAbi("armeabi-v7a", supportedAbis)
            lower.contains("x86_64") || lower.contains("amd64") ->
                scoreForAbi("x86_64", supportedAbis)
            Regex("""(?:^|[-_.])x86(?:[-_.]|$)""").containsMatchIn(lower) ->
                scoreForAbi("x86", supportedAbis)
            else -> 90 // Universal / single APK (e.g. conductor-android.apk)
        }
        if (abiScore < 0) return -1

        var bonus = 0
        if (lower == "conductor-android.apk") bonus += 40
        if (lower.contains("conductor")) bonus += 15
        if (lower.contains("android")) bonus += 10
        if (lower.contains("release")) bonus += 5
        return abiScore + bonus
    }

    private fun scoreForAbi(assetAbi: String, supportedAbis: List<String>): Int {
        if (supportedAbis.isEmpty()) return 60
        val index = supportedAbis.indexOf(assetAbi)
        if (index < 0) return -1
        return (110 - index * 10).coerceAtLeast(50)
    }

    fun toReleaseInfo(
        dto: GitHubReleaseDto,
        supportedAbis: List<String> = emptyList(),
        fallbackReleasePageUrl: String = GITHUB_LATEST_RELEASE_PAGE_URL,
        urlValidator: (String) -> Boolean = ::isAllowedDownloadUrl,
    ): AppUpdateReleaseInfo? {
        val tagName = dto.tagName.trim()
        if (tagName.isEmpty()) return null

        val parsed = parseReleaseTag(tagName)
        val htmlUrl = dto.htmlUrl?.trim()
            ?.takeIf { it.startsWith("https://", ignoreCase = true) }
            ?: fallbackReleasePageUrl
        val body = dto.body.orEmpty()
        return AppUpdateReleaseInfo(
            tagName = tagName,
            version = parsed?.semver ?: tagName.removePrefix("v").removePrefix("V"),
            name = dto.name?.trim()?.ifEmpty { null } ?: tagName,
            body = body,
            notesExcerpt = extractReleaseNotesExcerpt(body),
            htmlUrl = htmlUrl,
            publishedAt = dto.publishedAt?.trim()?.ifEmpty { null },
            apkAsset = selectAndroidApkAsset(dto.assets, supportedAbis, urlValidator),
            allAssetsCount = dto.assets.size,
        )
    }

    fun extractReleaseNotesExcerpt(body: String?, maxChars: Int = 380): String {
        if (body.isNullOrBlank()) return ""

        val cleaned = body
            .replace("\r\n", "\n")
            .replace(htmlCommentRegex, "")
            .replace(markdownLinkRegex, "$1")
            .split('\n')
            .map { it.trimEnd() }
            .filterNot { line ->
                val trimmed = line.trim()
                fullChangelogLineRegex.containsMatchIn(trimmed) ||
                    macOsGatekeeperLineRegex.matches(trimmed)
            }
            .joinToString("\n")
            .replace(multipleBlankLinesRegex, "\n\n")
            .trim()

        if (cleaned.isEmpty() || cleaned.length <= maxChars) return cleaned
        val sliced = cleaned.substring(0, maxChars)
        val lastBreak = maxOf(sliced.lastIndexOf('\n'), sliced.lastIndexOf(' '))
        val cut = if (lastBreak > (maxChars * 0.6).toInt()) {
            sliced.substring(0, lastBreak)
        } else {
            sliced
        }
        return "${cut.trimEnd()}…"
    }

    fun sanitizeApkFileName(rawName: String): String {
        val base = rawName.substringAfterLast('/').substringAfterLast('\\')
            .replace(unsafeFileNameCharsRegex, "_")
            .trim()
        if (base.isEmpty()) return "conductor-android.apk"
        return if (base.endsWith(".apk", ignoreCase = true)) base else "$base.apk"
    }

    fun formatBytes(bytes: Long?): String {
        if (bytes == null || bytes < 0L) return ""
        if (bytes < 1024L) return "$bytes B"
        val kb = bytes / 1024.0
        if (kb < 1024.0) return String.format(Locale.US, "%.1f KB", kb)
        val mb = kb / 1024.0
        if (mb < 1024.0) return String.format(Locale.US, "%.1f MB", mb)
        val gb = mb / 1024.0
        return String.format(Locale.US, "%.2f GB", gb)
    }

    fun isValidApkHeader(headerBytes: ByteArray, length: Int = headerBytes.size): Boolean {
        if (length < 4) return false
        // APK files are ZIP archives starting with local file header signature PK\x03\x04
        return headerBytes[0] == 0x50.toByte() &&
            headerBytes[1] == 0x4B.toByte() &&
            headerBytes[2] == 0x03.toByte() &&
            headerBytes[3] == 0x04.toByte()
    }
}
