package dev.conductor.mobile.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AlternateEmail
import androidx.compose.material.icons.filled.CallMerge
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Replay
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.conductor.mobile.model.AgentTask
import dev.conductor.mobile.model.AppSnapshot
import dev.conductor.mobile.model.ExplicitMentionTarget
import dev.conductor.mobile.model.TaskDetailResponse
import dev.conductor.mobile.ui.theme.ConductorAmber
import dev.conductor.mobile.ui.theme.ConductorEmerald
import dev.conductor.mobile.ui.theme.ConductorIndigo
import dev.conductor.mobile.ui.theme.ConductorRed

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TasksScreen(
    snapshot: AppSnapshot?,
    selectedTaskId: String?,
    selectedTaskDetail: TaskDetailResponse?,
    isLoadingDetail: Boolean,
    actionInProgress: Boolean,
    onOpenTask: (String) -> Unit,
    onCloseTask: () -> Unit,
    onMarkDone: (String) -> Unit,
    onReopen: (String) -> Unit,
    onStopTask: (String) -> Unit,
    onLandTask: (String) -> Unit,
    onMentionTaskInChat: (ExplicitMentionTarget) -> Unit,
) {
    val tasks = snapshot?.tasks.orEmpty()
    val projectColorById = snapshot?.projects.orEmpty().associate { it.id to it.colorHex }

    val runningTasks = tasks.filter { it.status == "running" }
    val needsReviewTasks = tasks.filter {
        it.status == "needs_review" || it.status == "queued" || it.status == "failed"
    }
    val completedTasks = tasks.filter { it.status == "done" }

    val activeSheetTask = selectedTaskDetail?.task
        ?: tasks.find { it.id == selectedTaskId }

    Column(modifier = Modifier.fillMaxSize()) {
        TopAppBar(
            title = {
                Column {
                    Text(
                        text = "Agent Tasks",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                    )
                    Text(
                        text = "実行中 ${runningTasks.size} · レビュー待ち ${needsReviewTasks.size} · 完了 ${completedTasks.size}",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            },
        )

        HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.4f))

        if (tasks.isEmpty()) {
            Box(
                modifier = Modifier.fillMaxSize(),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = if (snapshot == null) "読み込み中..." else "タスクはまだありません",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(14.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                if (runningTasks.isNotEmpty()) {
                    item(key = "hdr-running") {
                        TaskGroupHeader(
                            title = "実行中 (Running)",
                            count = runningTasks.size,
                            color = ConductorIndigo,
                        )
                    }
                    items(runningTasks, key = { it.id }) { task ->
                        TaskCard(
                            task = task,
                            projectColorHex = projectColorById[task.projectId],
                            onClick = { onOpenTask(task.id) },
                        )
                    }
                }

                if (needsReviewTasks.isNotEmpty()) {
                    item(key = "hdr-review") {
                        TaskGroupHeader(
                            title = "レビュー待ち (Needs Review)",
                            count = needsReviewTasks.size,
                            color = ConductorAmber,
                        )
                    }
                    items(needsReviewTasks, key = { it.id }) { task ->
                        TaskCard(
                            task = task,
                            projectColorHex = projectColorById[task.projectId],
                            onClick = { onOpenTask(task.id) },
                        )
                    }
                }

                if (completedTasks.isNotEmpty()) {
                    item(key = "hdr-done") {
                        TaskGroupHeader(
                            title = "完了 (Completed)",
                            count = completedTasks.size,
                            color = ConductorEmerald,
                        )
                    }
                    items(completedTasks, key = { it.id }) { task ->
                        TaskCard(
                            task = task,
                            projectColorHex = projectColorById[task.projectId],
                            onClick = { onOpenTask(task.id) },
                        )
                    }
                }
            }
        }
    }

    if (selectedTaskId != null && activeSheetTask != null) {
        TaskDetailBottomSheet(
            task = activeSheetTask,
            detail = selectedTaskDetail,
            isLoadingDetail = isLoadingDetail,
            actionInProgress = actionInProgress,
            onDismiss = onCloseTask,
            onMarkDone = { onMarkDone(activeSheetTask.id) },
            onReopen = { onReopen(activeSheetTask.id) },
            onStopTask = { onStopTask(activeSheetTask.id) },
            onLandTask = { onLandTask(activeSheetTask.id) },
            onMentionInChat = {
                onMentionTaskInChat(
                    ExplicitMentionTarget(
                        kind = "task",
                        taskId = activeSheetTask.id,
                        taskNumber = activeSheetTask.taskNumber,
                        taskTitle = activeSheetTask.title,
                        taskStatus = activeSheetTask.status,
                        projectId = activeSheetTask.projectId,
                        projectName = activeSheetTask.projectName,
                    ),
                )
                onCloseTask()
            },
        )
    }
}

@Composable
private fun TaskGroupHeader(title: String, count: Int, color: Color) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 6.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(
            modifier = Modifier
                .size(8.dp)
                .clip(CircleShape)
                .background(color),
        )
        Text(
            text = "$title · $count",
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun TaskCard(
    task: AgentTask,
    projectColorHex: String?,
    onClick: () -> Unit,
) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        shape = RoundedCornerShape(14.dp),
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
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
                        .background(parseHexColor(projectColorHex)),
                )
                Text(
                    text = "T${task.taskNumber}",
                    style = MaterialTheme.typography.labelMedium,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.primary,
                )
                Text(
                    text = task.title,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                StatusPill(status = task.status)
            }

            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    text = task.projectName,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (!task.landStatus.isNullOrBlank()) {
                    Text(
                        text = "Land: ${task.landStatus}",
                        style = MaterialTheme.typography.labelSmall,
                        color = if (task.landStatus == "landed" || task.landStatus == "pushed") {
                            ConductorEmerald
                        } else {
                            ConductorAmber
                        },
                    )
                }
            }

            val stepOrSummary = task.currentStep?.takeIf { it.isNotBlank() } ?: task.summary
            if (stepOrSummary.isNotBlank()) {
                Text(
                    text = stepOrSummary,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun StatusPill(status: String) {
    val (label, color) = when (status) {
        "running" -> "実行中" to ConductorIndigo
        "needs_review" -> "レビュー待ち" to ConductorAmber
        "done" -> "完了" to ConductorEmerald
        "failed" -> "失敗" to ConductorRed
        else -> "待機" to Color.Gray
    }
    Surface(
        color = color.copy(alpha = 0.16f),
        shape = RoundedCornerShape(99.dp),
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.SemiBold,
            color = color,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun TaskDetailBottomSheet(
    task: AgentTask,
    detail: TaskDetailResponse?,
    isLoadingDetail: Boolean,
    actionInProgress: Boolean,
    onDismiss: () -> Unit,
    onMarkDone: () -> Unit,
    onReopen: () -> Unit,
    onStopTask: () -> Unit,
    onLandTask: () -> Unit,
    onMentionInChat: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 18.dp)
                .padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    text = "T${task.taskNumber}",
                    style = MaterialTheme.typography.labelLarge,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.primary,
                )
                StatusPill(status = task.status)
                Spacer(modifier = Modifier.weight(1f))
                Text(
                    text = task.projectName,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            Text(
                text = task.title,
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold,
            )

            if (task.summary.isNotBlank()) {
                Text(
                    text = task.summary,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            if (!task.currentStep.isNullOrBlank()) {
                Text(
                    text = "現在のステップ: ${task.currentStep}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.primary,
                )
            }

            // One-click action buttons
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (task.status == "running") {
                    Button(
                        onClick = onStopTask,
                        enabled = !actionInProgress,
                        colors = ButtonDefaults.buttonColors(containerColor = ConductorRed),
                    ) {
                        Icon(Icons.Default.Stop, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("Stop")
                    }
                }

                if (task.status != "running" && task.hasWorktree) {
                    Button(
                        onClick = onLandTask,
                        enabled = !actionInProgress,
                        colors = ButtonDefaults.buttonColors(containerColor = ConductorIndigo),
                    ) {
                        Icon(Icons.Default.CallMerge, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("Land")
                    }
                }

                if (task.status != "done") {
                    Button(
                        onClick = onMarkDone,
                        enabled = !actionInProgress,
                        colors = ButtonDefaults.buttonColors(containerColor = ConductorEmerald),
                    ) {
                        Icon(Icons.Default.Check, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("Done")
                    }
                } else {
                    OutlinedButton(
                        onClick = onReopen,
                        enabled = !actionInProgress,
                    ) {
                        Icon(Icons.Default.Replay, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("Reopen")
                    }
                }

                OutlinedButton(onClick = onMentionInChat) {
                    Icon(Icons.Default.AlternateEmail, contentDescription = null, modifier = Modifier.size(16.dp))
                    Spacer(modifier = Modifier.width(6.dp))
                    Text("チャットで参照")
                }
            }

            if (actionInProgress || isLoadingDetail) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                    Text(
                        text = if (actionInProgress) "処理を実行中..." else "詳細を読み込み中...",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            val wt = detail?.worktreeStatus
            if (wt != null && wt.hasWorktree) {
                Surface(
                    color = MaterialTheme.colorScheme.surfaceVariant,
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column(
                        modifier = Modifier.padding(12.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Text(
                            text = "Worktree",
                            style = MaterialTheme.typography.labelMedium,
                            fontWeight = FontWeight.Bold,
                        )
                        Text(
                            text = "Branch: ${wt.worktreeBranch ?: "-"} → ${wt.suggestedTargetBranch ?: wt.parentBranch ?: "-"}",
                            style = MaterialTheme.typography.bodySmall,
                            fontFamily = FontFamily.Monospace,
                        )
                        Text(
                            text = "Ahead commits: ${wt.aheadCommits} · Changed files: ${wt.changedFilesCount}",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }

            if (task.latestOutput.isNotBlank()) {
                Text(
                    text = "最新出力",
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.Bold,
                )
                Surface(
                    color = MaterialTheme.colorScheme.surfaceVariant,
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        text = task.latestOutput.take(2500),
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                        modifier = Modifier.padding(12.dp),
                    )
                }
            }

            val gitStatus = detail?.gitStatus
            if (!gitStatus.isNullOrBlank()) {
                Text(
                    text = "Git Status",
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.Bold,
                )
                Surface(
                    color = MaterialTheme.colorScheme.surfaceVariant,
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        text = gitStatus,
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                        modifier = Modifier.padding(12.dp),
                    )
                }
            }
        }
    }
}
