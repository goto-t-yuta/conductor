package dev.conductor.mobile.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ContentPaste
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.conductor.mobile.data.ConnectionTestResult
import dev.conductor.mobile.model.AppUpdateState
import dev.conductor.mobile.model.ConnectUriParser
import dev.conductor.mobile.model.ConnectionConfig
import dev.conductor.mobile.model.ThemeMode
import dev.conductor.mobile.ui.components.AppUpdateCard
import dev.conductor.mobile.ui.components.ConductorCard
import dev.conductor.mobile.ui.components.ThemeModeSelector
import dev.conductor.mobile.ui.theme.ConductorTheme

@Composable
fun SetupScreen(
    initialConfig: ConnectionConfig,
    pendingDeepLink: ConnectionConfig?,
    themeMode: ThemeMode,
    isTesting: Boolean,
    lastTestResult: ConnectionTestResult?,
    appUpdate: AppUpdateState,
    onSelectThemeMode: (ThemeMode) -> Unit,
    onCheckForUpdates: () -> Unit,
    onDownloadAndInstallUpdate: () -> Unit,
    onCancelUpdateDownload: () -> Unit,
    onInstallDownloadedApk: () -> Unit,
    onOpenUnknownSourcesSettings: () -> Unit,
    onOpenReleasePage: (String?) -> Unit,
    onConsumeDeepLink: () -> Unit,
    onOpenQrScanner: () -> Unit,
    onTestConnection: (url: String, token: String) -> Unit,
    onSaveAndConnect: (url: String, token: String) -> Unit,
) {
    val colors = ConductorTheme.colors
    val clipboard = LocalClipboardManager.current
    var uriDraft by rememberSaveable { mutableStateOf("") }
    var serverUrl by rememberSaveable { mutableStateOf(initialConfig.serverUrl) }
    var bearerToken by rememberSaveable { mutableStateOf(initialConfig.bearerToken) }
    var showToken by rememberSaveable { mutableStateOf(false) }
    var parseFeedback by rememberSaveable { mutableStateOf<String?>(null) }

    LaunchedEffect(pendingDeepLink) {
        if (pendingDeepLink != null) {
            serverUrl = pendingDeepLink.serverUrl
            bearerToken = pendingDeepLink.bearerToken
            parseFeedback = "ディープリンクから接続情報を読み込みました"
            onConsumeDeepLink()
        }
    }

    fun applyConnectUri(raw: String) {
        uriDraft = raw
        val parsed = ConnectUriParser.parse(raw)
        if (parsed != null) {
            serverUrl = parsed.serverUrl
            bearerToken = parsed.bearerToken
            parseFeedback = "URI を解析しました (${parsed.serverUrl})"
        } else if (raw.isNotBlank()) {
            parseFeedback = "有効な conductor://connect?url=...&token=... 形式ではありません"
        } else {
            parseFeedback = null
        }
    }

    val fieldColors = OutlinedTextFieldDefaults.colors(
        focusedBorderColor = colors.indigo,
        unfocusedBorderColor = colors.border,
        focusedContainerColor = colors.surfaceSecondary,
        unfocusedContainerColor = colors.surfaceSecondary,
        focusedTextColor = colors.textPrimary,
        unfocusedTextColor = colors.textPrimary,
        focusedLabelColor = colors.indigoText,
        unfocusedLabelColor = colors.textMuted,
        cursorColor = colors.indigo,
    )

    Surface(
        modifier = Modifier.fillMaxSize(),
        color = colors.canvas,
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .imePadding()
                .padding(horizontal = 20.dp, vertical = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            // Brand header matching desktop Conductor's refined identity
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Box(
                    modifier = Modifier
                        .size(44.dp)
                        .clip(RoundedCornerShape(13.dp))
                        .background(colors.indigoBg)
                        .border(1.dp, colors.indigoBorder, RoundedCornerShape(13.dp)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = Icons.Default.AutoAwesome,
                        contentDescription = null,
                        tint = colors.indigo,
                        modifier = Modifier.size(22.dp),
                    )
                }
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = "Conductor",
                        fontSize = 22.sp,
                        fontWeight = FontWeight.SemiBold,
                        letterSpacing = (-0.3).sp,
                        color = colors.textPrimary,
                    )
                    Text(
                        text = "Desktop Remote Companion",
                        fontSize = 12.sp,
                        color = colors.textMuted,
                    )
                }
            }

            Text(
                text = "Mac 上の Conductor と Tailscale 経由で接続します。デスクトップの「設定 → リモートアクセス」から Step 2 の QR コードをスキャンするだけで自動接続できます。",
                fontSize = 13.sp,
                lineHeight = 20.sp,
                color = colors.textSecondary,
            )

            // Compact theme toggle right on pairing screen
            ThemeModeSelector(
                selectedMode = themeMode,
                onSelectMode = onSelectThemeMode,
            )

            // Primary QR Code Scan Card (desktop indigo accent tint + 1dp border)
            ConductorCard(
                containerColor = colors.indigoBg,
                borderColor = colors.indigoBorder,
                cornerRadius = 14.dp,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Text(
                        text = "QRコードでかんたんリンク（推奨）",
                        fontSize = 13.5.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = colors.textPrimary,
                    )
                    Text(
                        text = "デスクトップの Step 2 QR コードを読み取ると、URL と認証トークンが自動保存されて即座に接続します。",
                        fontSize = 12.sp,
                        lineHeight = 18.sp,
                        color = colors.textSecondary,
                    )
                    Button(
                        onClick = onOpenQrScanner,
                        shape = RoundedCornerShape(10.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = colors.indigoAction,
                            contentColor = Color.White,
                        ),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Icon(
                            imageVector = Icons.Default.QrCodeScanner,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp),
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("QRコードをスキャンしてリンク", fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
            }

            // One-paste URI Card
            ConductorCard(
                modifier = Modifier.fillMaxWidth(),
                cornerRadius = 14.dp,
            ) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text(
                            text = "一括貼り付け (URI)",
                            fontSize = 13.5.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = colors.textPrimary,
                        )
                        OutlinedButton(
                            onClick = {
                                val text = clipboard.getText()?.text.orEmpty()
                                if (text.isNotBlank()) {
                                    applyConnectUri(text)
                                }
                            },
                            shape = RoundedCornerShape(8.dp),
                            border = BorderStroke(1.dp, colors.borderStrong),
                        ) {
                            Icon(
                                imageVector = Icons.Default.ContentPaste,
                                contentDescription = null,
                                modifier = Modifier.size(14.dp),
                            )
                            Spacer(modifier = Modifier.width(5.dp))
                            Text("貼り付け", fontSize = 11.5.sp)
                        }
                    }

                    OutlinedTextField(
                        value = uriDraft,
                        onValueChange = { applyConnectUri(it) },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        shape = RoundedCornerShape(10.dp),
                        colors = fieldColors,
                        label = { Text("conductor://connect?url=...&token=...", fontSize = 12.sp) },
                        leadingIcon = {
                            Icon(
                                Icons.Default.Link,
                                contentDescription = null,
                                tint = colors.textMuted,
                            )
                        },
                    )

                    if (parseFeedback != null) {
                        Text(
                            text = parseFeedback.orEmpty(),
                            fontSize = 12.sp,
                            color = colors.indigoText,
                        )
                    }
                }
            }

            // Manual Fields Card
            ConductorCard(
                modifier = Modifier.fillMaxWidth(),
                cornerRadius = 14.dp,
            ) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(
                        text = "手動で接続先を設定",
                        fontSize = 13.5.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = colors.textPrimary,
                    )

                    OutlinedTextField(
                        value = serverUrl,
                        onValueChange = { serverUrl = it },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        shape = RoundedCornerShape(10.dp),
                        colors = fieldColors,
                        label = { Text("Tailscale サーバー URL", fontSize = 12.sp) },
                        placeholder = { Text("http://100.x.x.x:4789", color = colors.textSubtle) },
                    )

                    OutlinedTextField(
                        value = bearerToken,
                        onValueChange = { bearerToken = it },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        shape = RoundedCornerShape(10.dp),
                        colors = fieldColors,
                        label = { Text("Bearer Token", fontSize = 12.sp) },
                        visualTransformation = if (showToken) {
                            VisualTransformation.None
                        } else {
                            PasswordVisualTransformation()
                        },
                        trailingIcon = {
                            IconButton(onClick = { showToken = !showToken }) {
                                Icon(
                                    imageVector = if (showToken) {
                                        Icons.Default.VisibilityOff
                                    } else {
                                        Icons.Default.Visibility
                                    },
                                    contentDescription = if (showToken) "隠す" else "表示",
                                    tint = colors.textMuted,
                                )
                            }
                        },
                    )

                    if (lastTestResult != null) {
                        Surface(
                            color = if (lastTestResult.ok) colors.emeraldBg else colors.roseBg,
                            shape = RoundedCornerShape(10.dp),
                            border = BorderStroke(
                                1.dp,
                                if (lastTestResult.ok) colors.emeraldBorder else colors.roseBorder,
                            ),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Row(
                                modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                Icon(
                                    imageVector = if (lastTestResult.ok) {
                                        Icons.Default.CheckCircle
                                    } else {
                                        Icons.Default.Error
                                    },
                                    contentDescription = null,
                                    tint = if (lastTestResult.ok) colors.emerald else colors.rose,
                                    modifier = Modifier.size(16.dp),
                                )
                                Text(
                                    text = lastTestResult.message,
                                    fontSize = 12.sp,
                                    color = if (lastTestResult.ok) colors.emeraldText else colors.roseText,
                                )
                            }
                        }
                    }

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        OutlinedButton(
                            onClick = { onTestConnection(serverUrl, bearerToken) },
                            enabled = !isTesting && serverUrl.isNotBlank() && bearerToken.isNotBlank(),
                            shape = RoundedCornerShape(10.dp),
                            border = BorderStroke(1.dp, colors.borderStrong),
                            modifier = Modifier.weight(1f),
                        ) {
                            if (isTesting) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(15.dp),
                                    strokeWidth = 2.dp,
                                    color = colors.indigo,
                                )
                            } else {
                                Text("接続テスト", fontSize = 12.5.sp)
                            }
                        }

                        Button(
                            onClick = { onSaveAndConnect(serverUrl, bearerToken) },
                            enabled = serverUrl.isNotBlank() && bearerToken.isNotBlank(),
                            shape = RoundedCornerShape(10.dp),
                            colors = ButtonDefaults.buttonColors(
                                containerColor = colors.indigoAction,
                                contentColor = Color.White,
                            ),
                            modifier = Modifier.weight(1f),
                        ) {
                            Text("保存して接続", fontSize = 12.5.sp)
                        }
                    }
                }
            }

            Text(
                text = "ヒント: Tailscale アプリがこの Android 端末と Mac の両方で ON になっていることを確認してください。",
                fontSize = 11.5.sp,
                lineHeight = 16.sp,
                color = colors.textMuted,
            )

            AppUpdateCard(
                appUpdate = appUpdate,
                onCheckForUpdates = onCheckForUpdates,
                onDownloadAndInstall = onDownloadAndInstallUpdate,
                onCancelDownload = onCancelUpdateDownload,
                onInstallDownloaded = onInstallDownloadedApk,
                onOpenUnknownSourcesSettings = onOpenUnknownSourcesSettings,
                onOpenReleasePage = onOpenReleasePage,
            )

            Spacer(modifier = Modifier.height(8.dp))
        }
    }
}
