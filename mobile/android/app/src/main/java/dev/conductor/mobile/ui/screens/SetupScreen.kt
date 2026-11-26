package dev.conductor.mobile.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ContentPaste
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import dev.conductor.mobile.data.ConnectionTestResult
import dev.conductor.mobile.model.ConnectUriParser
import dev.conductor.mobile.model.ConnectionConfig
import dev.conductor.mobile.ui.theme.ConductorEmerald
import dev.conductor.mobile.ui.theme.ConductorRed

@Composable
fun SetupScreen(
    initialConfig: ConnectionConfig,
    pendingDeepLink: ConnectionConfig?,
    isTesting: Boolean,
    lastTestResult: ConnectionTestResult?,
    onConsumeDeepLink: () -> Unit,
    onTestConnection: (url: String, token: String) -> Unit,
    onSaveAndConnect: (url: String, token: String) -> Unit,
) {
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

    Surface(
        modifier = Modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background,
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .imePadding()
                .padding(horizontal = 20.dp, vertical = 32.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Spacer(modifier = Modifier.height(12.dp))

            Text(
                text = "Conductor Mobile",
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.Bold,
            )
            Text(
                text = "Mac 上の Conductor と Tailscale 経由で接続します。デスクトップの「設定 → リモートアクセス」を ON にして、表示された URI または URL・トークンを入力してください。",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            // One-paste URI Card
            Card(
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                shape = RoundedCornerShape(16.dp),
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
                            text = "一括貼り付け (conductor://connect)",
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.SemiBold,
                        )
                        OutlinedButton(
                            onClick = {
                                val text = clipboard.getText()?.text.orEmpty()
                                if (text.isNotBlank()) {
                                    applyConnectUri(text)
                                }
                            },
                        ) {
                            Icon(
                                imageVector = Icons.Default.ContentPaste,
                                contentDescription = null,
                                modifier = Modifier.size(16.dp),
                            )
                            Spacer(modifier = Modifier.size(6.dp))
                            Text("貼り付け")
                        }
                    }

                    OutlinedTextField(
                        value = uriDraft,
                        onValueChange = { applyConnectUri(it) },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        label = { Text("conductor://connect?url=...&token=...") },
                        leadingIcon = { Icon(Icons.Default.Link, contentDescription = null) },
                    )

                    if (parseFeedback != null) {
                        Text(
                            text = parseFeedback.orEmpty(),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.primary,
                        )
                    }
                }
            }

            // Manual Fields Card
            Card(
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                shape = RoundedCornerShape(16.dp),
            ) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(
                        text = "接続先設定",
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                    )

                    OutlinedTextField(
                        value = serverUrl,
                        onValueChange = { serverUrl = it },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        label = { Text("Tailscale サーバー URL") },
                        placeholder = { Text("http://100.x.x.x:4789") },
                    )

                    OutlinedTextField(
                        value = bearerToken,
                        onValueChange = { bearerToken = it },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        label = { Text("Bearer Token") },
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
                                )
                            }
                        },
                    )

                    if (lastTestResult != null) {
                        Row(
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
                                tint = if (lastTestResult.ok) ConductorEmerald else ConductorRed,
                                modifier = Modifier.size(18.dp),
                            )
                            Text(
                                text = lastTestResult.message,
                                style = MaterialTheme.typography.bodySmall,
                                color = if (lastTestResult.ok) ConductorEmerald else ConductorRed,
                            )
                        }
                    }

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        OutlinedButton(
                            onClick = { onTestConnection(serverUrl, bearerToken) },
                            enabled = !isTesting && serverUrl.isNotBlank() && bearerToken.isNotBlank(),
                            modifier = Modifier.weight(1f),
                        ) {
                            if (isTesting) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(16.dp),
                                    strokeWidth = 2.dp,
                                )
                            } else {
                                Text("接続テスト")
                            }
                        }

                        Button(
                            onClick = { onSaveAndConnect(serverUrl, bearerToken) },
                            enabled = serverUrl.isNotBlank() && bearerToken.isNotBlank(),
                            modifier = Modifier.weight(1f),
                        ) {
                            Text("保存して接続")
                        }
                    }
                }
            }

            Text(
                text = "ヒント: Tailscale アプリがこの Android 端末と Mac の両方で ON になっていることを確認してください。",
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Default,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
