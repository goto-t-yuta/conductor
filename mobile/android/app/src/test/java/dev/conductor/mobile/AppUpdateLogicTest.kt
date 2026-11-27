package dev.conductor.mobile

import dev.conductor.mobile.model.AppUpdateLogic
import dev.conductor.mobile.model.CurrentBuildInfo
import dev.conductor.mobile.model.GitHubReleaseAssetDto
import dev.conductor.mobile.model.GitHubReleaseDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppUpdateLogicTest {

    @Test
    fun parseReleaseTagParsesCiTagsAndSemverTags() {
        val ciTag = AppUpdateLogic.parseReleaseTag("v0.1.0-6-75aab02")
        assertNotNull(ciTag)
        assertEquals(0, ciTag!!.major)
        assertEquals(1, ciTag.minor)
        assertEquals(0, ciTag.patch)
        assertEquals("0.1.0", ciTag.semver)
        assertEquals(6, ciTag.runNumber)
        assertEquals("75aab02", ciTag.commitSha)
        assertNull(ciTag.prerelease)

        val semver = AppUpdateLogic.parseReleaseTag("v1.4.2")
        assertNotNull(semver)
        assertEquals(1, semver!!.major)
        assertEquals(4, semver.minor)
        assertEquals(2, semver.patch)
        assertNull(semver.runNumber)
        assertNull(semver.commitSha)
        assertNull(semver.prerelease)

        val pre = AppUpdateLogic.parseReleaseTag("0.2.0-beta.2")
        assertNotNull(pre)
        assertEquals("0.2.0", pre!!.semver)
        assertEquals("beta.2", pre.prerelease)

        assertNull(AppUpdateLogic.parseReleaseTag(""))
        assertNull(AppUpdateLogic.parseReleaseTag("not-a-version"))
    }

    @Test
    fun compareReleaseVersionsHandlesSemverPrereleaseRunNumbersAndCommitSha() {
        // Semver upgrade & downgrade
        assertEquals(
            1,
            AppUpdateLogic.compareReleaseVersions(
                CurrentBuildInfo(versionName = "0.1.0", versionCode = 1),
                "v0.2.0",
            ),
        )
        assertEquals(
            -1,
            AppUpdateLogic.compareReleaseVersions(
                CurrentBuildInfo(versionName = "0.2.0", versionCode = 2),
                "v0.1.9",
            ),
        )

        // Semver prerelease ordering
        assertEquals(
            1,
            AppUpdateLogic.compareReleaseVersions(
                CurrentBuildInfo(versionName = "0.2.0-beta.1", versionCode = 1),
                "v0.2.0-beta.2",
            ),
        )
        assertEquals(
            1,
            AppUpdateLogic.compareReleaseVersions(
                CurrentBuildInfo(versionName = "0.2.0-beta.2", versionCode = 1),
                "v0.2.0",
            ),
        )

        // CI run number progression on same semver
        assertTrue(
            AppUpdateLogic.isUpdateAvailable(
                CurrentBuildInfo(
                    versionName = "0.1.0-6-75aab02",
                    versionCode = 6,
                    buildTag = "v0.1.0-6-75aab02",
                    commitSha = "75aab02",
                    runNumber = 6,
                ),
                "v0.1.0-7-abcdef1",
            ),
        )
        assertFalse(
            AppUpdateLogic.isUpdateAvailable(
                CurrentBuildInfo(
                    versionName = "0.1.0-7-abcdef1",
                    versionCode = 7,
                    buildTag = "v0.1.0-7-abcdef1",
                    commitSha = "abcdef1",
                    runNumber = 7,
                ),
                "v0.1.0-6-75aab02",
            ),
        )

        // Exact commit SHA match means already up to date (even for local dev build without runNumber)
        assertEquals(
            0,
            AppUpdateLogic.compareReleaseVersions(
                CurrentBuildInfo(
                    versionName = "0.1.0",
                    versionCode = 1,
                    commitSha = "75aab02",
                ),
                "v0.1.0-6-75aab02",
                latestTargetCommitish = "75aab02da79c2e84c8ed0feddeb30271568def7f",
            ),
        )

        // Legacy/local unnumbered 0.1.0 build with different commit sees CI release as update
        assertTrue(
            AppUpdateLogic.isUpdateAvailable(
                CurrentBuildInfo(
                    versionName = "0.1.0",
                    versionCode = 1,
                    commitSha = "1111111",
                ),
                "v0.1.0-6-75aab02",
            ),
        )

        // Falls back to versionCode when runNumber is not embedded in versionName
        assertFalse(
            AppUpdateLogic.isUpdateAvailable(
                CurrentBuildInfo(versionName = "0.1.0", versionCode = 6),
                "v0.1.0-6-75aab02",
            ),
        )
        assertTrue(
            AppUpdateLogic.isUpdateAvailable(
                CurrentBuildInfo(versionName = "0.1.0", versionCode = 6),
                "v0.1.0-7-abcdef1",
            ),
        )
    }

    @Test
    fun selectAndroidApkAssetPicksConductorApkAndEnforcesAllowedHosts() {
        val assets = listOf(
            GitHubReleaseAssetDto(
                name = "Conductor-0.1.0-mac-arm64.dmg",
                browserDownloadUrl = "https://github.com/goto-t-yuta/conductor/releases/download/v0.1.0-6-75aab02/Conductor-0.1.0-mac-arm64.dmg",
                size = 114_218_920L,
            ),
            GitHubReleaseAssetDto(
                name = "SHA256SUMS.txt",
                browserDownloadUrl = "https://github.com/goto-t-yuta/conductor/releases/download/v0.1.0-6-75aab02/SHA256SUMS.txt",
                size = 873L,
            ),
            GitHubReleaseAssetDto(
                name = "conductor-android.apk",
                browserDownloadUrl = "https://github.com/goto-t-yuta/conductor/releases/download/v0.1.0-6-75aab02/conductor-android.apk",
                size = 20_806_755L,
                contentType = "application/vnd.android.package-archive",
            ),
        )

        val selected = AppUpdateLogic.selectAndroidApkAsset(assets, listOf("arm64-v8a", "armeabi-v7a"))
        assertNotNull(selected)
        assertEquals("conductor-android.apk", selected!!.name)
        assertEquals(20_806_755L, selected.size)

        // Untrusted host must be rejected
        val untrusted = AppUpdateLogic.selectAndroidApkAsset(
            listOf(
                GitHubReleaseAssetDto(
                    name = "conductor-android.apk",
                    browserDownloadUrl = "https://evil.example.com/conductor-android.apk",
                    size = 1024L,
                ),
            ),
        )
        assertNull(untrusted)

        assertTrue(AppUpdateLogic.isAllowedDownloadUrl("https://github.com/goto-t-yuta/conductor/releases/download/v0.1.0/conductor-android.apk"))
        assertTrue(AppUpdateLogic.isAllowedDownloadUrl("https://objects.githubusercontent.com/github-production-release-asset-2e65be/file.apk"))
        assertFalse(AppUpdateLogic.isAllowedDownloadUrl("http://github.com/goto-t-yuta/conductor/releases/download/v0.1.0/conductor-android.apk"))
        assertFalse(AppUpdateLogic.isAllowedDownloadUrl("https://attacker.com/github.com/file.apk"))
    }

    @Test
    fun selectAndroidApkAssetPrefersMatchingAbiWhenSplitApksProvided() {
        val assets = listOf(
            GitHubReleaseAssetDto(
                name = "conductor-android-x86_64.apk",
                browserDownloadUrl = "https://github.com/goto-t-yuta/conductor/releases/download/v0.2.0/conductor-android-x86_64.apk",
                size = 18_000_000L,
            ),
            GitHubReleaseAssetDto(
                name = "conductor-android-arm64-v8a.apk",
                browserDownloadUrl = "https://github.com/goto-t-yuta/conductor/releases/download/v0.2.0/conductor-android-arm64-v8a.apk",
                size = 19_000_000L,
            ),
            GitHubReleaseAssetDto(
                name = "conductor-android-universal.apk",
                browserDownloadUrl = "https://github.com/goto-t-yuta/conductor/releases/download/v0.2.0/conductor-android-universal.apk",
                size = 25_000_000L,
            ),
        )

        val arm64Pick = AppUpdateLogic.selectAndroidApkAsset(assets, listOf("arm64-v8a", "armeabi-v7a"))
        assertEquals("conductor-android-arm64-v8a.apk", arm64Pick?.name)

        val fallbackUniversal = AppUpdateLogic.selectAndroidApkAsset(assets, listOf("armeabi-v7a"))
        assertEquals("conductor-android-universal.apk", fallbackUniversal?.name)
    }

    @Test
    fun extractReleaseNotesExcerptStripsMacOsGatekeeperAndChangelogFooter() {
        val rawBody = """
            > **macOS (unsigned build)**: After dragging `Conductor.app` to `/Applications`, run `xattr -cr /Applications/Conductor.app`.

            <!-- internal note -->
            ## What's Changed
            * Android版機能追加・UI改善 by @goto-t-yuta in [PR #8](https://github.com/goto-t-yuta/conductor/pull/8)


            **Full Changelog**: https://github.com/goto-t-yuta/conductor/compare/v0.1.0-5-a311c0f...v0.1.0-6-75aab02
        """.trimIndent()

        val excerpt = AppUpdateLogic.extractReleaseNotesExcerpt(rawBody)
        assertFalse(excerpt.contains("macOS (unsigned build)"))
        assertFalse(excerpt.contains("Full Changelog"))
        assertFalse(excerpt.contains("internal note"))
        assertTrue(excerpt.contains("What's Changed"))
        assertTrue(excerpt.contains("PR #8"))
        assertFalse(excerpt.contains("https://github.com"))
    }

    @Test
    fun toReleaseInfoAndHelpersWorkAsExpected() {
        val dto = GitHubReleaseDto(
            tagName = "v0.1.0-6-75aab02",
            name = "Conductor v0.1.0-6-75aab02",
            body = "## What's Changed\n* Fix bug",
            htmlUrl = "https://github.com/goto-t-yuta/conductor/releases/tag/v0.1.0-6-75aab02",
            publishedAt = "2026-11-27T04:38:44Z",
            assets = listOf(
                GitHubReleaseAssetDto(
                    name = "conductor-android.apk",
                    browserDownloadUrl = "https://github.com/goto-t-yuta/conductor/releases/download/v0.1.0-6-75aab02/conductor-android.apk",
                    size = 20_806_755L,
                ),
            ),
        )

        val info = AppUpdateLogic.toReleaseInfo(dto)
        assertNotNull(info)
        assertEquals("v0.1.0-6-75aab02", info!!.tagName)
        assertEquals("0.1.0", info.version)
        assertEquals("conductor-android.apk", info.apkAsset?.name)

        assertEquals("conductor-android.apk", AppUpdateLogic.sanitizeApkFileName("../evil/conductor-android.apk"))
        assertEquals("19.8 MB", AppUpdateLogic.formatBytes(20_806_755L))
        assertTrue(AppUpdateLogic.isValidApkHeader(byteArrayOf(0x50, 0x4B, 0x03, 0x04, 0x14)))
        assertFalse(AppUpdateLogic.isValidApkHeader("<html>404</html>".toByteArray()))
    }
}
