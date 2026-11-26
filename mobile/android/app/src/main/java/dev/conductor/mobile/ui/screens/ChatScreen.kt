package dev.conductor.mobile.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.AddComment
import androidx.compose.material.icons.filled.AlternateEmail
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.AssistChip
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.conductor.mobile.model.AgentTask
import dev.conductor.mobile.model.AppSnapshot
import dev.conductor.mobile.model.ChatMessage
import dev.conductor.mobile.model.ExplicitMentionTarget
import dev.conductor.mobile.model.Project
import dev.conductor.mobile.model.StreamTransportState
import dev.conductor.mobile.ui.theme.ConductorAmber
import dev.conductor.mobile.ui.theme.ConductorEmerald
import dev.conductor.mobile.ui.theme.ConductorIndigo
import dev.conductor.mobile.ui.theme.ConductorRed

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    snapshot: AppSnapshot?,
    transportState: StreamTransportState,
    composerText: String,
    selectedMentions: List<ExplicitMentionTarget>,
    isSending: Boolean,
    onComposerTextChange: (String) -> Unit,
    onAddMention: (ExplicitMentionTarget) -> Unit,
    onRemoveMention: (ExplicitMentionTarget) -> Unit,
    onSend: () -> Unit,
    onStopAll: () -> Unit,
    onStopMessage: (String) -> Unit,
    onNewChat: () -> Unit,
) {
    val messages = snapshot?.messages.orEmpty()
    val projects = snapshot?.projects.orEmpty()
    val tasks = snapshot?.tasks.orEmpty()
    val activeResponders = snapshot?.activeResponderCount ?: 0
    val listState = rememberLazyListState()
    var showMentionSheet by remember { mutableStateOf(false) }

    LaunchedEffect(messages.size, messages.lastOrNull()?.text?.length) {
        if (messages.isNotEmpty()) {
            listState.animateScrollToItem(messages.lastIndex)
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .imePadding(),
    ) {
        TopAppBar(
            title = {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Box(
                        modifier = Modifier
                            .size(10.dp)
                            .clip(CircleShape)
                            .background(transportDotColor(transportState)),
                    )
                    Column {
                        Text(
                            text = "Conductor Chat",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold,
                        )
                        Text(
                            text = buildSubtitle(snapshot, transportState),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            },
            actions = {
                if (activeResponders > 0) {
                    TextButton(onClick = onStopAll) {
                        Icon(
                            imageVector = Icons.Default.Stop,
                            contentDescription = "すべて停止",
                            tint = ConductorRed,
                            modifier = Modifier.size(16.dp),
                        )
                        Spacer(modifier = Modifier.width(4.dp))
                        Text("停止", color = ConductorRed)
                    }
                }
                IconButton(onClick = onNewChat) {
                    Icon(
                        imageVector = Icons.Default.AddComment,
                        contentDescription = "新しいチャット",
                    )
                }
            },
        )

        HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.4f))

        // Message stream
        if (messages.isEmpty()) {
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .padding(24.dp),
                contentAlignment = Alignment.Center,
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        text = if (snapshot == null) "サーバーから同期中..." else "メッセージはまだありません",
                        style = MaterialTheme.typography.titleSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(modifier = Modifier.height(6.dp))
                    Text(
                        text = "@ ボタンでプロジェクトやタスクを指定して指示を送れます。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        } else {
            LazyColumn(
                state = listState,
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth(),
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(messages, key = { it.id }) { msg ->
                    ChatMessageItem(
                        message = msg,
                        onStop = { onStopMessage(msg.id) },
                    )
                }
            }
        }

        // Composer section
        Surface(
            color = MaterialTheme.colorScheme.surface,
            tonalElevation = 2.dp,
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 10.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                if (selectedMentions.isNotEmpty()) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        selectedMentions.forEach { mention ->
                            InputChip(
                                selected = true,
                                onClick = { onRemoveMention(mention) },
                                label = {
                                    Text(
                                        text = mention.chipLabel(),
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                },
                                trailingIcon = {
                                    Icon(
                                        imageVector = Icons.Default.Close,
                                        contentDescription = "削除",
                                        modifier = Modifier.size(14.dp),
                                    )
                                },
                            )
                        }
                    }
                }

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.Bottom,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    IconButton(onClick = { showMentionSheet = true }) {
                        Icon(
                            imageVector = Icons.Default.AlternateEmail,
                            contentDescription = "@メンション追加",
                            tint = MaterialTheme.colorScheme.primary,
                        )
                    }

                    OutlinedTextField(
                        value = composerText,
                        onValueChange = onComposerTextChange,
                        modifier = Modifier.weight(1f),
                        placeholder = { Text("Conductor に指示を送る...") },
                        maxLines = 4,
                        shape = RoundedCornerShape(16.dp),
                    )

                    FilledIconButton(
                        onClick = onSend,
                        enabled = composerText.isNotBlank() && !isSending,
                        colors = IconButtonDefaults.filledIconButtonColors(
                            containerColor = ConductorIndigo,
                            contentColor = Color.White,
                        ),
                    ) {
                        if (isSending) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(18.dp),
                                color = Color.White,
                                strokeWidth = 2.dp,
                            )
                        } else {
                            Icon(
                                imageVector = Icons.AutoMirrored.Filled.Send,
                                contentDescription = "送信",
                            )
                        }
                    }
                }
            }
        }
    }

    if (showMentionSheet) {
        MentionPickerSheet(
            projects = projects,
            tasks = tasks,
            onDismiss = { showMentionSheet = false },
            onSelect = { target ->
                onAddMention(target)
                showMentionSheet = false
            },
        )
    }
}

@Composable
private fun ChatMessageItem(
    message: ChatMessage,
    onStop: () -> Unit,
) {
    val isUser = message.role == "user"
    val isSystem = message.role == "system" || message.role == "taskEvent"

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = when {
            isUser -> Arrangement.End
            isSystem -> Arrangement.Center
            else -> Arrangement.Start
        },
    ) {
        val bgColor = when {
            isUser -> ConductorIndigo
            isSystem -> MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.7f)
            else -> MaterialTheme.colorScheme.surface
        }
        val textColor = when {
            isUser -> Color.White
            isSystem -> MaterialTheme.colorScheme.onSurfaceVariant
            else -> MaterialTheme.colorScheme.onSurface
        }

        Surface(
            color = bgColor,
            shape = RoundedCornerShape(
                topStart = 16.dp,
                topEnd = 16.dp,
                bottomStart = if (isUser) 16.dp else 4.dp,
                bottomEnd = if (isUser) 4.dp else 16.dp,
            ),
            tonalElevation = if (isUser) 0.dp else 1.dp,
            modifier = Modifier.widthIn(max = if (isSystem) 340.dp else 310.dp),
        ) {
            Column(
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 9.dp),
                verticalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                // Header / streaming indicator / mentions
                if (!isUser && !isSystem) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Text(
                            text = (message.provider ?: "conductor").uppercase(),
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.primary,
                        )
                        if (message.isStreaming) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(11.dp),
                                strokeWidth = 1.8.dp,
                            )
                            Text(
                                text = "応答中...",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Spacer(modifier = Modifier.weight(1f))
                            Text(
                                text = "停止",
                                style = MaterialTheme.typography.labelSmall,
                                fontWeight = FontWeight.SemiBold,
                                color = ConductorRed,
                                modifier = Modifier.clickable(onClick = onStop),
                            )
                        }
                    }
                }

                if (message.mentions.isNotEmpty()) {
                    Row(
                        modifier = Modifier.horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        message.mentions.forEach { ref ->
                            Surface(
                                color = if (isUser) {
                                    Color.White.copy(alpha = 0.2f)
                                } else {
                                    MaterialTheme.colorScheme.primaryContainer
                                },
                                shape = RoundedCornerShape(99.dp),
                            ) {
                                Text(
                                    text = ref.displayLabel(),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = if (isUser) Color.White else MaterialTheme.colorScheme.onPrimaryContainer,
                                    modifier = Modifier.padding(horizontal = 7.dp, vertical = 2.dp),
                                )
                            }
                        }
                    }
                }

                if (message.toolChips.isNotEmpty()) {
                    Row(
                        modifier = Modifier.horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        message.toolChips.takeLast(4).forEach { chip ->
                            AssistChip(
                                onClick = {},
                                label = {
                                    Text(
                                        text = chip.label,
                                        style = MaterialTheme.typography.labelSmall,
                                        maxLines = 1,
                                    )
                                },
                            )
                        }
                    }
                }

                Text(
                    text = message.text.ifBlank { if (message.isStreaming) "思考中..." else "" },
                    style = if (isSystem) {
                        MaterialTheme.typography.bodySmall
                    } else {
                        MaterialTheme.typography.bodyMedium
                    },
                    color = textColor,
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MentionPickerSheet(
    projects: List<Project>,
    tasks: List<AgentTask>,
    onDismiss: () -> Unit,
    onSelect: (ExplicitMentionTarget) -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
    ) {
        LazyColumn(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp),
            contentPadding = PaddingValues(bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            item {
                Text(
                    text = "@ メンションを追加",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                )
            }

            if (projects.isNotEmpty()) {
                item {
                    Text(
                        text = "プロジェクト",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                items(projects, key = { "p-${it.id}" }) { project ->
                    Surface(
                        color = MaterialTheme.colorScheme.surfaceVariant,
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable {
                                onSelect(
                                    ExplicitMentionTarget(
                                        kind = "project",
                                        projectId = project.id,
                                        projectName = project.name,
                                        projectPath = project.path,
                                        projectColorHex = project.colorHex,
                                    ),
                                )
                            },
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            Box(
                                modifier = Modifier
                                    .size(10.dp)
                                    .clip(CircleShape)
                                    .background(parseHexColor(project.colorHex)),
                            )
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    text = "@${project.name}",
                                    style = MaterialTheme.typography.bodyMedium,
                                    fontWeight = FontWeight.SemiBold,
                                )
                                if (project.path.isNotBlank()) {
                                    Text(
                                        text = project.path,
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                            }
                        }
                    }
                }
            }

            if (tasks.isNotEmpty()) {
                item {
                    Spacer(modifier = Modifier.height(6.dp))
                    Text(
                        text = "タスク",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                items(tasks, key = { "t-${it.id}" }) { task ->
                    Surface(
                        color = MaterialTheme.colorScheme.surfaceVariant,
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable {
                                onSelect(
                                    ExplicitMentionTarget(
                                        kind = "task",
                                        taskId = task.id,
                                        taskNumber = task.taskNumber,
                                        taskTitle = task.title,
                                        taskStatus = task.status,
                                        projectId = task.projectId,
                                        projectName = task.projectName,
                                    ),
                                )
                            },
                    ) {
                        Column(
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                            verticalArrangement = Arrangement.spacedBy(2.dp),
                        ) {
                            Text(
                                text = "@T${task.taskNumber} ${task.title}",
                                style = MaterialTheme.typography.bodyMedium,
                                fontWeight = FontWeight.SemiBold,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                text = "${task.projectName} · ${task.status}",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
        }
    }
}

private fun transportDotColor(state: StreamTransportState): Color = when (state) {
    StreamTransportState.CONNECTED_SSE -> ConductorEmerald
    StreamTransportState.CONNECTED_POLLING, StreamTransportState.CONNECTING -> ConductorAmber
    StreamTransportState.ERROR -> ConductorRed
    StreamTransportState.DISCONNECTED -> Color.Gray
}

private fun buildSubtitle(snapshot: AppSnapshot?, state: StreamTransportState): String {
    val transport = when (state) {
        StreamTransportState.CONNECTED_SSE -> "Live SSE"
        StreamTransportState.CONNECTED_POLLING -> "Polling"
        StreamTransportState.CONNECTING -> "接続中..."
        StreamTransportState.ERROR -> "接続エラー"
        StreamTransportState.DISCONNECTED -> "未接続"
    }
    val provider = snapshot?.chatProvider?.uppercase()
    return if (provider != null) "$transport · $provider" else transport
}

internal fun parseHexColor(hex: String?): Color {
    if (hex.isNullOrBlank()) return ConductorIndigo
    return runCatching {
        Color(android.graphics.Color.parseColor(hex))
    }.getOrDefault(ConductorIndigo)
}
