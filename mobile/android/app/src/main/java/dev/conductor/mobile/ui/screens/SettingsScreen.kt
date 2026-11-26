package dev.conductor.mobile.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ContentPaste
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
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
import dev.conductor.mobile.data.ConnectionTestResult
import dev.conductor.mobile.model.AppSnapshot
import dev.conductor.mobile.model.ConnectUriParser
import dev.conductor.mobile.model.ConnectionConfig
import dev.conductor.mobile.model.StreamTransportState
import dev.conductor.mobile.ui.theme.ConductorAmber
import dev.conductor.mobile.ui.theme.ConductorEmerald
import dev.conductor.mobile.ui.theme.ConductorRed

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    config: ConnectionConfig,
    transportState: StreamTransportState,
    transportDetail: String,
    snapshot: AppSnapshot?,
    isTesting: Boolean,
    lastTestResult: ConnectionTestResult?,
    onOpenQrScanner: () -> Unit,
    onReconnect: () -> Unit,
    onTestConnection: (url: String, token: String) -> Unit,
    onSaveConfig: (url: String, token: String) -> Unit,
    onDisconnect: () -> Unit,
) {
    val clipboard = LocalClipboardManager.current
    var serverUrl by rememberSaveable { mutableStateOf(config.serverUrl) }
    var bearerToken by rememberSaveable { mutableStateOf(config.bearerToken) }
    var showToken by rememberSaveable { mutableStateOf(false) }

    LaunchedEffect(config) {
        serverUrl = config.serverUrl
        bearerToken = config.bearerToken
    }

    Column(modifier = Modifier.fillMaxSize()) {
        TopAppBar(
            title = {
                Text(
                    text = "Settings",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                )
            },
        )
        HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.4f))

        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            // Live Status Card
            Card(
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                shape = RoundedCornerShape(16.dp),
            ) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        val dotColor = when (transportState) {
                            StreamTransportState.CONNECTED_SSE -> ConductorEmerald
                            StreamTransportState.CONNECTED_POLLING,
                            StreamTransportState.CONNECTING -> ConductorAmber
                            StreamTransportState.ERROR -> ConductorRed
                            StreamTransportState.DISCONNECTED -> Color.Gray
                        }
                        Box(
                            modifier = Modifier
                                .size(10.dp)
                                .clip(CircleShape)
                                .background(dotColor),
                        )
                        Text(
                            text = "接続ステータス",
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.Bold,
                        )
                    }

                    Text(
                        text = transportDetail,
                        style = MaterialTheme.typography.bodyMedium,
                    )

                    if (snapshot != null) {
                        Text(
                            text = "Engine: ${snapshot.connectionStatus} · Projects: ${snapshot.projects.size} · Tasks: ${snapshot.tasks.size}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }

                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        OutlinedButton(onClick = onReconnect) {
                            Icon(Icons.Default.Refresh, contentDescription = null, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(6.dp))
                            Text("再接続")
                        }
                        Button(
                            onClick = onDisconnect,
                            colors = ButtonDefaults.buttonColors(containerColor = ConductorRed),
                        ) {
                            Text("切断")
                        }
                    }
                }
            }

            // Edit Server / Token Card
            Card(
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                shape = RoundedCornerShape(16.dp),
            ) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text(
                            text = "サーバー URL / Token 編集",
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.Bold,
                        )
                        OutlinedButton(
                            onClick = {
                                val clip = clipboard.getText()?.text.orEmpty()
                                val parsed = ConnectUriParser.parse(clip)
                                if (parsed != null) {
                                    serverUrl = parsed.serverUrl
                                    bearerToken = parsed.bearerToken
                                }
                            },
                        ) {
                            Icon(
                                Icons.Default.ContentPaste,
                                contentDescription = null,
                                modifier = Modifier.size(15.dp),
                            )
                            Spacer(modifier = Modifier.width(4.dp))
                            Text("URI 貼付")
                        }
                    }

                    OutlinedButton(
                        onClick = onOpenQrScanner,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Icon(
                            Icons.Default.QrCodeScanner,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp),
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("QRコードをスキャンしてリンク")
                    }

                    OutlinedTextField(
                        value = serverUrl,
                        onValueChange = { serverUrl = it },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        label = { Text("サーバー URL") },
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
                                    contentDescription = null,
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
                                CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                            } else {
                                Text("接続テスト")
                            }
                        }

                        Button(
                            onClick = { onSaveConfig(serverUrl, bearerToken) },
                            enabled = serverUrl.isNotBlank() && bearerToken.isNotBlank(),
                            modifier = Modifier.weight(1f),
                        ) {
                            Text("保存して再接続")
                        }
                    }
                }
            }
        }
    }
}
