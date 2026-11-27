package dev.conductor.mobile.data

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File

sealed interface ApkInstallLaunchResult {
    data object Launched : ApkInstallLaunchResult
    data object PermissionRequired : ApkInstallLaunchResult
    data class Failed(val message: String) : ApkInstallLaunchResult
}

object ApkInstaller {
    private const val APK_MIME_TYPE = "application/vnd.android.package-archive"
    private const val UPDATES_SUBDIR = "updates"

    fun updatesDirectory(context: Context): File = File(context.cacheDir, UPDATES_SUBDIR)

    fun canRequestPackageInstalls(context: Context): Boolean =
        runCatching { context.packageManager.canRequestPackageInstalls() }.getOrDefault(false)

    fun launchInstaller(context: Context, apkFile: File): ApkInstallLaunchResult {
        if (!apkFile.isFile || apkFile.length() <= 0L) {
            return ApkInstallLaunchResult.Failed("ダウンロード済みの APK ファイルが見つかりません。")
        }

        if (!canRequestPackageInstalls(context)) {
            return ApkInstallLaunchResult.PermissionRequired
        }

        return runCatching {
            val authority = "${context.packageName}.fileprovider"
            val apkUri = FileProvider.getUriForFile(context, authority, apkFile)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(apkUri, APK_MIME_TYPE)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            context.startActivity(intent)
            ApkInstallLaunchResult.Launched
        }.getOrElse { err ->
            ApkInstallLaunchResult.Failed(
                "パッケージインストーラーを起動できませんでした: ${err.message ?: "不明なエラー"}",
            )
        }
    }

    fun openUnknownAppSourcesSettings(context: Context): Result<Unit> = runCatching {
        val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
            data = Uri.parse("package:${context.packageName}")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
    }

    fun openReleasePage(context: Context, url: String): Result<Unit> = runCatching {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
    }
}
