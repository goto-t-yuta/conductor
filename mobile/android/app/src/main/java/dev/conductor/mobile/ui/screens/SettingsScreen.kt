package dev.conductor.mobile.ui.screens

import androidx.compose.foundation.BorderStroke
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
import androidx.compose.material.icons.filled.Contrast
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
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
import dev.conductor.mobile.model.AppSnapshot
import dev.conductor.mobile.model.ConnectUriParser
import dev.conductor.mobile.model.ConnectionConfig
import dev.conductor.mobile.model.StreamTransportState
import dev.conductor.mobile.model.ThemeMode
import dev.conductor.mobile.ui.components.ConductorCard
import dev.conductor.mobile.ui.components.ThemeModeSelector
import dev.conductor.mobile.ui.components.transportStatusColor
import dev.conductor.mobile.ui.theme.ConductorTheme

@Composable
fun SettingsScreen(
    config: ConnectionConfig,
    themeMode: ThemeMode,
    transportState: StreamTransportState,
    transportDetail: String,
    snapshot: AppSnapshot?,
    isTesting: Boolean,
    lastTestResult: ConnectionTestResult?,
    onSelectThemeMode: (ThemeMode) -> Unit,
    onOpenQrScanner: () -> Unit,
    onReconnect: () -> Unit,
    onTestConnection: (url: String, token: String) -> Unit,
    onSaveConfig: (url: String, token: String) -> Unit,
    onDisconnect: () -> Unit,
) {
    val colors = ConductorTheme.colors
    val clipboard = LocalClipboardManager.current
    var serverUrl by rememberSaveable { mutableStateOf(config.serverUrl) }
    var bearerToken by rememberSaveable { mutableStateOf(config.bearerToken) }
    var showToken by rememberSaveable { mutableStateOf(false) }

    LaunchedEffect(config) {
        serverUrl = config.serverUrl
        bearerToken = config.bearerToken
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

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(colors.surfaceSecondary),
    ) {
        // Desktop-aligned flat header
        Column(modifier = Modifier.background(colors.canvas)) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(
                    imageVector = Icons.Default.Settings,
                    contentDescription = null,
                    tint = colors.indigo,
                    modifier = Modifier.size(18.dp),
                )
                Text(
                    text = "Settings",
                    fontSize = 15.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = colors.textPrimary,
                )
            }
            HorizontalDivider(thickness = 1.dp, color = colors.borderSubtle)
        }

        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            // Appearance / Theme Switcher Card
            ConductorCard(
                modifier = Modifier.fillMaxWidth(),
                cornerRadius = 14.dp,
            ) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(7.dp),
                    ) {
                        Icon(
                            imageVector = Icons.Default.Contrast,
                            contentDescription = null,
                            tint = colors.indigo,
                            modifier = Modifier.size(16.dp),
                        )
                        Text(
                            text = "テーマ・外観",
                            fontSize = 13.5.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = colors.textPrimary,
                        )
                    }

                    Text(
                        text = "デスクトップ版 Conductor と統一された配色を System / Light / Dark から選択できます。",
                        fontSize = 12.sp,
                        lineHeight = 17.sp,
                        color = colors.textMuted,
                    )

                    ThemeModeSelector(
                        selectedMode = themeMode,
                        onSelectMode = onSelectThemeMode,
                    )
                }
            }

            // Connection Status Card
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
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Box(
                            modifier = Modifier
                                .size(9.dp)
                                .clip(CircleShape)
                                .background(transportStatusColor(transportState)),
                        )
                        Text(
                            text = "接続ステータス",
                            fontSize = 13.5.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = colors.textPrimary,
                            modifier = Modifier.weight(1f),
                        )
                        val (statusText, statusBg, statusFg) = when (transportState) {
                            StreamTransportState.CONNECTED_SSE -> Triple("Live SSE", colors.emeraldBg, colors.emeraldText)
                            StreamTransportState.CONNECTED_POLLING -> Triple("Polling", colors.amberBg, colors.amberText)
                            StreamTransportState.CONNECTING -> Triple("接続中", colors.amberBg, colors.amberText)
                            StreamTransportState.ERROR -> Triple("エラー", colors.roseBg, colors.roseText)
                            StreamTransportState.DISCONNECTED -> Triple("未接続", colors.surfaceSubtle, colors.textMuted)
                        }
                        Surface(
                            color = statusBg,
                            shape = RoundedCornerShape(99.dp),
                        ) {
                            Text(
                                text = statusText,
                                fontSize = 10.5.sp,
                                fontWeight = FontWeight.SemiBold,
                                color = statusFg,
                                modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                            )
                        }
                    }

                    Text(
                        text = transportDetail,
                        fontSize = 13.sp,
                        color = colors.textSecondary,
                    )

                    if (snapshot != null) {
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            StatPill(label = "Projects", value = "${snapshot.projects.size}")
                            StatPill(label = "Tasks", value = "${snapshot.tasks.size}")
                            if (snapshot.connectionStatus.isNotBlank()) {
                                StatPill(label = "Engine", value = snapshot.connectionStatus)
                            }
                        }
                    }

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        OutlinedButton(
                            onClick = onReconnect,
                            shape = RoundedCornerShape(10.dp),
                            border = BorderStroke(1.dp, colors.borderStrong),
                            modifier = Modifier.weight(1f),
                        ) {
                            Icon(Icons.Default.Refresh, contentDescription = null, modifier = Modifier.size(15.dp))
                            Spacer(modifier = Modifier.width(6.dp))
                            Text("再接続", fontSize = 12.5.sp)
                        }
                        Button(
                            onClick = onDisconnect,
                            shape = RoundedCornerShape(10.dp),
                            colors = ButtonDefaults.buttonColors(
                                containerColor = colors.rose,
                                contentColor = Color.White,
                            ),
                            modifier = Modifier.weight(1f),
                        ) {
                            Text("切断", fontSize = 12.5.sp)
                        }
                    }
                }
            }

            // Edit Server / Token Card
            ConductorCard(
                modifier = Modifier.fillMaxWidth(),
                cornerRadius = 14.dp,
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
                            text = "サーバー URL / Token",
                            fontSize = 13.5.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = colors.textPrimary,
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
                            shape = RoundedCornerShape(8.dp),
                            border = BorderStroke(1.dp, colors.borderStrong),
                        ) {
                            Icon(
                                Icons.Default.ContentPaste,
                                contentDescription = null,
                                modifier = Modifier.size(14.dp),
                            )
                            Spacer(modifier = Modifier.width(5.dp))
                            Text("URI 貼付", fontSize = 11.5.sp)
                        }
                    }

                    OutlinedButton(
                        onClick = onOpenQrScanner,
                        shape = RoundedCornerShape(10.dp),
                        border = BorderStroke(1.dp, colors.indigoBorder),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Icon(
                            Icons.Default.QrCodeScanner,
                            contentDescription = null,
                            tint = colors.indigoText,
                            modifier = Modifier.size(17.dp),
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = "QRコードをスキャンしてリンク",
                            fontSize = 12.5.sp,
                            color = colors.indigoText,
                        )
                    }

                    OutlinedTextField(
                        value = serverUrl,
                        onValueChange = { serverUrl = it },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        shape = RoundedCornerShape(10.dp),
                        colors = fieldColors,
                        label = { Text("サーバー URL", fontSize = 12.sp) },
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
                                    contentDescription = null,
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
                            onClick = { onSaveConfig(serverUrl, bearerToken) },
                            enabled = serverUrl.isNotBlank() && bearerToken.isNotBlank(),
                            shape = RoundedCornerShape(10.dp),
                            colors = ButtonDefaults.buttonColors(
                                containerColor = colors.indigoAction,
                                contentColor = Color.White,
                            ),
                            modifier = Modifier.weight(1f),
                        ) {
                            Text("保存して再接続", fontSize = 12.5.sp)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun StatPill(label: String, value: String) {
    val colors = ConductorTheme.colors
    Surface(
        color = colors.surfaceSubtle,
        shape = RoundedCornerShape(7.dp),
        border = BorderStroke(1.dp, colors.borderSubtle),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = label,
                fontSize = 10.5.sp,
                color = colors.textMuted,
            )
            Text(
                text = value,
                fontSize = 10.5.sp,
                fontWeight = FontWeight.SemiBold,
                color = colors.textPrimary,
            )
        }
    }
}
