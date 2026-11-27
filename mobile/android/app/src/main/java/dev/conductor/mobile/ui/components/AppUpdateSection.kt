package dev.conductor.mobile.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.InstallMobile
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Security
import androidx.compose.material.icons.filled.SystemUpdate
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.conductor.mobile.model.AppUpdateLogic
import dev.conductor.mobile.model.AppUpdateState
import dev.conductor.mobile.model.AppUpdateStatus
import dev.conductor.mobile.ui.theme.ConductorTheme
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Non-intrusive, dismissible update notification strip shown when a newer release is detected
 * on startup while the user is browsing Chat or Tasks.
 */
@Composable
fun UpdateAvailableBanner(
    appUpdate: AppUpdateState,
    onOpenSettings: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val release = appUpdate.latestRelease ?: return
    val colors = ConductorTheme.colors
    val isDownloaded = appUpdate.status == AppUpdateStatus.DOWNLOADED
    val isDownloading = appUpdate.status == AppUpdateStatus.DOWNLOADING

    val containerBg = if (isDownloaded) colors.emeraldBg else colors.indigoBg
    val borderColor = if (isDownloaded) colors.emeraldBorder else colors.indigoBorder
    val accentColor = if (isDownloaded) colors.emeraldText else colors.indigoText

    val headline = when {
        isDownloaded -> "更新の準備完了: ${release.tagName}"
        isDownloading -> {
            val pct = appUpdate.downloadProgress?.percent
            if (pct != null) "アップデートをダウンロード中 ($pct%)" else "アップデートをダウンロード中..."
        }
        else -> "新しいバージョン: ${release.tagName}"
    }

    Surface(
        color = containerBg,
        shape = RoundedCornerShape(12.dp),
        border = BorderStroke(1.dp, borderColor),
        modifier = modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 12.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(
                imageVector = if (isDownloaded) Icons.Default.InstallMobile else Icons.Default.SystemUpdate,
                contentDescription = null,
                tint = accentColor,
                modifier = Modifier.size(16.dp),
            )
            Text(
                text = headline,
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
                color = colors.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            TextButton(
                onClick = onOpenSettings,
                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp),
            ) {
                Text(
                    text = if (isDownloaded) "更新" else "確認",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = accentColor,
                )
            }
            IconButton(
                onClick = onDismiss,
                modifier = Modifier.size(28.dp),
            ) {
                Icon(
                    imageVector = Icons.Default.Close,
                    contentDescription = "閉じる",
                    tint = colors.textMuted,
                    modifier = Modifier.size(15.dp),
                )
            }
        }
    }
}

/**
 * Settings / Setup card displaying current build version, GitHub Releases update check,
 * release notes summary, download progress, and in-app APK installer actions.
 */
@Composable
fun AppUpdateCard(
    appUpdate: AppUpdateState,
    onCheckForUpdates: () -> Unit,
    onDownloadAndInstall: () -> Unit,
    onCancelDownload: () -> Unit,
    onInstallDownloaded: () -> Unit,
    onOpenUnknownSourcesSettings: () -> Unit,
    onOpenReleasePage: (String?) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = ConductorTheme.colors
    val release = appUpdate.latestRelease
    val asset = release?.apkAsset
    val isChecking = appUpdate.status == AppUpdateStatus.CHECKING
    val isDownloading = appUpdate.status == AppUpdateStatus.DOWNLOADING
    val isDownloaded = appUpdate.status == AppUpdateStatus.DOWNLOADED
    val isAvailable = appUpdate.status == AppUpdateStatus.AVAILABLE
    val isUpToDate = appUpdate.status == AppUpdateStatus.UP_TO_DATE

    val statusBadge: Triple<String, Color, Color>? = when (appUpdate.status) {
        AppUpdateStatus.IDLE -> null
        AppUpdateStatus.CHECKING -> Triple("確認中", colors.amberBg, colors.amberText)
        AppUpdateStatus.AVAILABLE -> Triple("アップデートあり", colors.indigoBg, colors.indigoText)
        AppUpdateStatus.UP_TO_DATE -> Triple("最新", colors.emeraldBg, colors.emeraldText)
        AppUpdateStatus.DOWNLOADING -> Triple("ダウンロード中", colors.indigoBg, colors.indigoText)
        AppUpdateStatus.DOWNLOADED -> Triple("準備完了", colors.emeraldBg, colors.emeraldText)
        AppUpdateStatus.ERROR -> Triple("エラー", colors.roseBg, colors.roseText)
    }

    ConductorCard(
        modifier = modifier.fillMaxWidth(),
        cornerRadius = 14.dp,
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            // Card Header
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(7.dp),
            ) {
                Icon(
                    imageVector = Icons.Default.SystemUpdate,
                    contentDescription = null,
                    tint = colors.indigo,
                    modifier = Modifier.size(16.dp),
                )
                Text(
                    text = "アプリ更新",
                    fontSize = 13.5.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = colors.textPrimary,
                    modifier = Modifier.weight(1f),
                )
                if (statusBadge != null) {
                    Surface(
                        color = statusBadge.second,
                        shape = RoundedCornerShape(99.dp),
                    ) {
                        Text(
                            text = statusBadge.first,
                            fontSize = 10.5.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = statusBadge.third,
                            maxLines = 1,
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                        )
                    }
                }
            }

            // Version summary box
            Surface(
                color = colors.surfaceSecondary,
                shape = RoundedCornerShape(10.dp),
                border = BorderStroke(1.dp, colors.borderSubtle),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text(
                            text = "現在のバージョン",
                            fontSize = 11.5.sp,
                            color = colors.textMuted,
                        )
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            Text(
                                text = appUpdate.currentBuild.displayVersion,
                                fontFamily = FontFamily.Monospace,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.SemiBold,
                                color = colors.textPrimary,
                            )
                            Surface(
                                color = colors.surfaceSubtle,
                                shape = RoundedCornerShape(5.dp),
                            ) {
                                Text(
                                    text = "Build ${appUpdate.currentBuild.versionCode}",
                                    fontFamily = FontFamily.Monospace,
                                    fontSize = 10.sp,
                                    color = colors.textMuted,
                                    modifier = Modifier.padding(horizontal = 5.dp, vertical = 1.dp),
                                )
                            }
                        }
                    }

                    if (release != null) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Text(
                                text = "最新リリース",
                                fontSize = 11.5.sp,
                                color = colors.textMuted,
                            )
                            Text(
                                text = release.tagName,
                                fontFamily = FontFamily.Monospace,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.SemiBold,
                                color = if (appUpdate.updateAvailable) colors.indigoText else colors.textPrimary,
                            )
                        }
                    }

                    val checkedTimeLabel = formatCheckedTime(appUpdate.lastCheckedAtMs)
                    if (checkedTimeLabel != null) {
                        Text(
                            text = "最終確認: $checkedTimeLabel",
                            fontSize = 10.5.sp,
                            color = colors.textSubtle,
                        )
                    }
                }
            }

            // Up-to-date status banner
            if (isUpToDate) {
                Surface(
                    color = colors.emeraldBg,
                    shape = RoundedCornerShape(10.dp),
                    border = BorderStroke(1.dp, colors.emeraldBorder),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Icon(
                            imageVector = Icons.Default.CheckCircle,
                            contentDescription = null,
                            tint = colors.emerald,
                            modifier = Modifier.size(16.dp),
                        )
                        Text(
                            text = "最新バージョンです",
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Medium,
                            color = colors.emeraldText,
                        )
                    }
                }
            }

            // Update available / downloading / downloaded details
            if (release != null && (appUpdate.updateAvailable || isDownloading || isDownloaded)) {
                if (release.notesExcerpt.isNotBlank()) {
                    Surface(
                        color = colors.surfaceSecondary,
                        shape = RoundedCornerShape(10.dp),
                        border = BorderStroke(1.dp, colors.borderSubtle),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Column(
                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                            verticalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            Text(
                                text = "リリースノート概要",
                                fontSize = 10.5.sp,
                                fontWeight = FontWeight.SemiBold,
                                color = colors.textMuted,
                            )
                            Text(
                                text = release.notesExcerpt,
                                fontSize = 11.5.sp,
                                lineHeight = 16.5.sp,
                                color = colors.textSecondary,
                                maxLines = 6,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }

                if (asset != null) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text(
                            text = "APK ファイル",
                            fontSize = 11.5.sp,
                            color = colors.textMuted,
                        )
                        val sizeText = AppUpdateLogic.formatBytes(asset.size)
                        Text(
                            text = if (sizeText.isNotEmpty()) "${asset.name} ($sizeText)" else asset.name,
                            fontFamily = FontFamily.Monospace,
                            fontSize = 11.sp,
                            color = colors.textSecondary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                } else {
                    Surface(
                        color = colors.amberBg,
                        shape = RoundedCornerShape(10.dp),
                        border = BorderStroke(1.dp, colors.amberBorder),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Icon(
                                imageVector = Icons.Default.Warning,
                                contentDescription = null,
                                tint = colors.amber,
                                modifier = Modifier.size(16.dp),
                            )
                            Text(
                                text = "このリリースには Android 用 APK が添付されていません。リリースページを確認してください。",
                                fontSize = 11.5.sp,
                                lineHeight = 16.sp,
                                color = colors.amberText,
                            )
                        }
                    }
                }
            }

            // Download progress indicator
            if (isDownloading) {
                val progress = appUpdate.downloadProgress
                val downloadedStr = AppUpdateLogic.formatBytes(progress?.downloadedBytes ?: 0L)
                val totalStr = AppUpdateLogic.formatBytes(progress?.totalBytes)
                val progressText = when {
                    progress?.percent != null && totalStr.isNotEmpty() ->
                        "ダウンロード中 ${progress.percent}% ($downloadedStr / $totalStr)"
                    downloadedStr.isNotEmpty() ->
                        "ダウンロード中 ($downloadedStr)"
                    else ->
                        "APK をダウンロードしています..."
                }

                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        text = progressText,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Medium,
                        color = colors.indigoText,
                    )
                    if (progress?.percent != null) {
                        LinearProgressIndicator(
                            progress = { (progress.percent / 100f).coerceIn(0f, 1f) },
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(6.dp)
                                .clip(RoundedCornerShape(99.dp)),
                            color = colors.indigoAction,
                            trackColor = colors.surfaceSubtle,
                        )
                    } else {
                        LinearProgressIndicator(
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(6.dp)
                                .clip(RoundedCornerShape(99.dp)),
                            color = colors.indigoAction,
                            trackColor = colors.surfaceSubtle,
                        )
                    }
                }
            }

            // Downloaded / permission guidance box
            if (isDownloaded) {
                if (appUpdate.needsUnknownSourcesPermission) {
                    Surface(
                        color = colors.amberBg,
                        shape = RoundedCornerShape(10.dp),
                        border = BorderStroke(1.dp, colors.amberBorder),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Icon(
                                imageVector = Icons.Default.Security,
                                contentDescription = null,
                                tint = colors.amber,
                                modifier = Modifier.size(16.dp),
                            )
                            Text(
                                text = "上書きインストールには「不明なアプリのインストール」許可が必要です。OS 設定から許可してください。",
                                fontSize = 11.5.sp,
                                lineHeight = 16.5.sp,
                                color = colors.amberText,
                            )
                        }
                    }
                } else {
                    Surface(
                        color = colors.emeraldBg,
                        shape = RoundedCornerShape(10.dp),
                        border = BorderStroke(1.dp, colors.emeraldBorder),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Icon(
                                imageVector = Icons.Default.CheckCircle,
                                contentDescription = null,
                                tint = colors.emerald,
                                modifier = Modifier.size(16.dp),
                            )
                            Text(
                                text = "APK のダウンロードが完了しました。インストーラーから更新できます。",
                                fontSize = 11.5.sp,
                                lineHeight = 16.5.sp,
                                color = colors.emeraldText,
                            )
                        }
                    }
                }
            }

            // Error box (for check/download/install errors other than permission guidance)
            if (appUpdate.errorMessage != null && !appUpdate.needsUnknownSourcesPermission) {
                Surface(
                    color = colors.roseBg,
                    shape = RoundedCornerShape(10.dp),
                    border = BorderStroke(1.dp, colors.roseBorder),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Icon(
                            imageVector = Icons.Default.Error,
                            contentDescription = null,
                            tint = colors.rose,
                            modifier = Modifier.size(16.dp),
                        )
                        Text(
                            text = appUpdate.errorMessage,
                            fontSize = 12.sp,
                            lineHeight = 16.5.sp,
                            color = colors.roseText,
                        )
                    }
                }
            }

            // Action Buttons
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (isAvailable && asset != null) {
                    Button(
                        onClick = onDownloadAndInstall,
                        shape = RoundedCornerShape(10.dp),
                        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = colors.indigoAction,
                            contentColor = Color.White,
                        ),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Icon(
                            imageVector = Icons.Default.Download,
                            contentDescription = null,
                            modifier = Modifier.size(16.dp),
                        )
                        Spacer(modifier = Modifier.width(6.dp))
                        Text(
                            text = "アップデート（ダウンロードしてインストール）",
                            fontSize = 11.5.sp,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }

                if (isDownloading) {
                    OutlinedButton(
                        onClick = onCancelDownload,
                        shape = RoundedCornerShape(10.dp),
                        border = BorderStroke(1.dp, colors.borderStrong),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Icon(
                            imageVector = Icons.Default.Close,
                            contentDescription = null,
                            modifier = Modifier.size(15.dp),
                        )
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("ダウンロードをキャンセル", fontSize = 12.5.sp)
                    }
                }

                if (isDownloaded) {
                    if (appUpdate.needsUnknownSourcesPermission) {
                        Button(
                            onClick = onOpenUnknownSourcesSettings,
                            shape = RoundedCornerShape(10.dp),
                            colors = ButtonDefaults.buttonColors(
                                containerColor = colors.indigoAction,
                                contentColor = Color.White,
                            ),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Icon(
                                imageVector = Icons.Default.Security,
                                contentDescription = null,
                                modifier = Modifier.size(16.dp),
                            )
                            Spacer(modifier = Modifier.width(7.dp))
                            Text(
                                text = "不明なアプリのインストールを許可",
                                fontSize = 12.5.sp,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                        OutlinedButton(
                            onClick = onInstallDownloaded,
                            shape = RoundedCornerShape(10.dp),
                            border = BorderStroke(1.dp, colors.indigoBorder),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Icon(
                                imageVector = Icons.Default.InstallMobile,
                                contentDescription = null,
                                tint = colors.indigoText,
                                modifier = Modifier.size(15.dp),
                            )
                            Spacer(modifier = Modifier.width(6.dp))
                            Text("許可済みのためインストールを実行", fontSize = 12.sp, color = colors.indigoText)
                        }
                    } else {
                        Button(
                            onClick = onInstallDownloaded,
                            shape = RoundedCornerShape(10.dp),
                            colors = ButtonDefaults.buttonColors(
                                containerColor = colors.indigoAction,
                                contentColor = Color.White,
                            ),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Icon(
                                imageVector = Icons.Default.InstallMobile,
                                contentDescription = null,
                                modifier = Modifier.size(16.dp),
                            )
                            Spacer(modifier = Modifier.width(7.dp))
                            Text(
                                text = "インストールを実行",
                                fontSize = 12.5.sp,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                    }
                }

                if (!isDownloading) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        OutlinedButton(
                            onClick = onCheckForUpdates,
                            enabled = !isChecking,
                            shape = RoundedCornerShape(10.dp),
                            border = BorderStroke(1.dp, colors.borderStrong),
                            modifier = Modifier.weight(1f),
                        ) {
                            if (isChecking) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(14.dp),
                                    strokeWidth = 2.dp,
                                    color = colors.indigo,
                                )
                                Spacer(modifier = Modifier.width(6.dp))
                                Text("確認中...", fontSize = 12.sp)
                            } else {
                                Icon(
                                    imageVector = Icons.Default.Refresh,
                                    contentDescription = null,
                                    modifier = Modifier.size(14.dp),
                                )
                                Spacer(modifier = Modifier.width(5.dp))
                                Text("アップデートを確認", fontSize = 12.sp, maxLines = 1)
                            }
                        }

                        if (release != null || appUpdate.status == AppUpdateStatus.ERROR) {
                            OutlinedButton(
                                onClick = { onOpenReleasePage(release?.htmlUrl) },
                                shape = RoundedCornerShape(10.dp),
                                border = BorderStroke(1.dp, colors.borderStrong),
                            ) {
                                Icon(
                                    imageVector = Icons.AutoMirrored.Filled.OpenInNew,
                                    contentDescription = null,
                                    modifier = Modifier.size(14.dp),
                                )
                                Spacer(modifier = Modifier.width(5.dp))
                                Text("GitHub", fontSize = 12.sp, maxLines = 1)
                            }
                        }
                    }
                }
            }
        }
    }
}

private fun formatCheckedTime(timestampMs: Long?): String? {
    if (timestampMs == null || timestampMs <= 0L) return null
    val fmt = SimpleDateFormat("HH:mm", Locale.getDefault())
    return fmt.format(Date(timestampMs))
}
