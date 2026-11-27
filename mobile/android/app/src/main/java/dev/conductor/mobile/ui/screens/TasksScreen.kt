package dev.conductor.mobile.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.CallMerge
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.AlternateEmail
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Layers
import androidx.compose.material.icons.filled.Replay
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.WarningAmber
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.conductor.mobile.model.AgentTask
import dev.conductor.mobile.model.AppSnapshot
import dev.conductor.mobile.model.ExplicitMentionTarget
import dev.conductor.mobile.model.Project
import dev.conductor.mobile.model.TaskDetailResponse
import dev.conductor.mobile.model.TaskFiltering
import dev.conductor.mobile.model.TaskProjectGroup
import dev.conductor.mobile.ui.components.ConductorCard
import dev.conductor.mobile.ui.components.ConductorMarkdown
import dev.conductor.mobile.ui.components.MarkdownVariant
import dev.conductor.mobile.ui.components.ProjectPill
import dev.conductor.mobile.ui.components.ProviderPill
import dev.conductor.mobile.ui.components.TaskCodeBadge
import dev.conductor.mobile.ui.components.TaskStatusBadge
import dev.conductor.mobile.ui.components.TaskStatusIcon
import dev.conductor.mobile.ui.components.parseConductorHexColor
import dev.conductor.mobile.ui.theme.ConductorTheme

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TasksScreen(
    snapshot: AppSnapshot?,
    groupByProject: Boolean,
    selectedTaskId: String?,
    selectedTaskDetail: TaskDetailResponse?,
    isLoadingDetail: Boolean,
    actionInProgress: Boolean,
    onToggleGroupByProject: () -> Unit,
    onOpenTask: (String) -> Unit,
    onCloseTask: () -> Unit,
    onMarkDone: (String) -> Unit,
    onReopen: (String) -> Unit,
    onStopTask: (String) -> Unit,
    onLandTask: (String) -> Unit,
    onMentionTaskInChat: (ExplicitMentionTarget) -> Unit,
) {
    val colors = ConductorTheme.colors
    val allTasks = snapshot?.tasks.orEmpty()
    val projects = snapshot?.projects.orEmpty()
    val projectColorById = remember(projects) { projects.associate { it.id to it.colorHex } }

    var selectedProjectId by rememberSaveable { mutableStateOf<String?>(null) }
    var searchQuery by rememberSaveable { mutableStateOf("") }
    var completedExpanded by rememberSaveable { mutableStateOf(true) }
    var collapsedGroupKeys by remember { mutableStateOf<Set<String>>(emptySet()) }

    val quickProjects = remember(projects, allTasks, selectedProjectId) {
        TaskFiltering.quickFilterProjects(projects, allTasks, selectedProjectId)
    }

    val filteredTasks = remember(allTasks, selectedProjectId, searchQuery) {
        TaskFiltering.filterTasks(allTasks, selectedProjectId, searchQuery)
    }

    val partitioned = remember(filteredTasks) {
        TaskFiltering.partitionTasks(filteredTasks)
    }

    val activeGroups = remember(partitioned.activeTasks, projects) {
        TaskFiltering.groupByProject(partitioned.activeTasks, projects)
    }
    val completedGroups = remember(partitioned.completedTasks, projects) {
        TaskFiltering.groupByProject(partitioned.completedTasks, projects)
    }

    val runningTotal = allTasks.count { it.status == "running" }
    val reviewTotal = allTasks.count { it.status == "needs_review" }
    val doneTotal = allTasks.count { it.status == "done" }

    val activeSheetTask = selectedTaskDetail?.task ?: allTasks.find { it.id == selectedTaskId }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(colors.surfaceSecondary),
    ) {
        // Desktop-aligned Tasks header with running badge & project grouping toggle
        Column(modifier = Modifier.background(colors.canvas)) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(
                    imageVector = Icons.Default.Checklist,
                    contentDescription = null,
                    tint = colors.indigo,
                    modifier = Modifier.size(18.dp),
                )
                Text(
                    text = "Tasks",
                    fontSize = 15.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = colors.textPrimary,
                )
                if (runningTotal > 0) {
                    Surface(
                        color = colors.indigoBg,
                        shape = RoundedCornerShape(99.dp),
                    ) {
                        Text(
                            text = "$runningTotal",
                            fontSize = 11.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = colors.indigoText,
                            modifier = Modifier.padding(horizontal = 7.dp, vertical = 1.dp),
                        )
                    }
                }
                Text(
                    text = "確認待ち $reviewTotal · 完了 $doneTotal",
                    fontSize = 11.5.sp,
                    color = colors.textMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )

                // Group by project toggle pill (matches desktop TaskSidebar Layers button)
                Surface(
                    color = if (groupByProject) colors.indigoBg else colors.surfaceSubtle,
                    shape = RoundedCornerShape(8.dp),
                    border = BorderStroke(
                        1.dp,
                        if (groupByProject) colors.indigoBorder else colors.borderSubtle,
                    ),
                    modifier = Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .clickable(onClick = onToggleGroupByProject),
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 5.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Icon(
                            imageVector = Icons.Default.Layers,
                            contentDescription = "プロジェクト別グループ",
                            tint = if (groupByProject) colors.indigoText else colors.textMuted,
                            modifier = Modifier.size(14.dp),
                        )
                        Text(
                            text = "プロジェクト別",
                            fontSize = 11.sp,
                            fontWeight = FontWeight.Medium,
                            color = if (groupByProject) colors.indigoText else colors.textSecondary,
                        )
                    }
                }
            }

            // Search bar & quick project filter pills
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 16.dp, end = 16.dp, bottom = 10.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                TaskSearchField(
                    query = searchQuery,
                    onQueryChange = { searchQuery = it },
                )

                if (quickProjects.isNotEmpty()) {
                    ProjectFilterPillRow(
                        projects = quickProjects,
                        selectedProjectId = selectedProjectId,
                        onSelectProject = { nextId ->
                            selectedProjectId = if (selectedProjectId == nextId) null else nextId
                        },
                    )
                }
            }

            HorizontalDivider(thickness = 1.dp, color = colors.borderSubtle)
        }

        // Task list content
        if (allTasks.isEmpty()) {
            Box(
                modifier = Modifier.fillMaxSize(),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = if (snapshot == null) "読み込み中..." else "タスクはまだありません",
                    fontSize = 13.5.sp,
                    color = colors.textMuted,
                )
            }
        } else if (filteredTasks.isEmpty()) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(24.dp),
                contentAlignment = Alignment.Center,
            ) {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        text = "条件に一致するタスクがありません",
                        fontSize = 13.5.sp,
                        fontWeight = FontWeight.Medium,
                        color = colors.textSecondary,
                    )
                    if (searchQuery.isNotBlank() || selectedProjectId != null) {
                        Surface(
                            color = colors.card,
                            shape = RoundedCornerShape(8.dp),
                            border = BorderStroke(1.dp, colors.border),
                            modifier = Modifier
                                .clip(RoundedCornerShape(8.dp))
                                .clickable {
                                    searchQuery = ""
                                    selectedProjectId = null
                                },
                        ) {
                            Text(
                                text = "フィルタをクリア",
                                fontSize = 12.sp,
                                fontWeight = FontWeight.Medium,
                                color = colors.indigoText,
                                modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                            )
                        }
                    }
                }
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(horizontal = 14.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                // Active tasks section
                if (partitioned.activeTasks.isNotEmpty()) {
                    item(key = "sec-active") {
                        SectionHeading(
                            title = "アクティブ",
                            count = partitioned.activeTasks.size,
                            accentColor = colors.indigo,
                        )
                    }

                    if (groupByProject) {
                        activeGroups.forEach { group ->
                            val collapseKey = "active:${group.groupKey}"
                            val isExpanded = searchQuery.isNotBlank() || collapseKey !in collapsedGroupKeys
                            item(key = "grp-hdr-$collapseKey") {
                                ProjectGroupHeaderRow(
                                    group = group,
                                    isExpanded = isExpanded,
                                    onToggle = {
                                        collapsedGroupKeys = if (collapseKey in collapsedGroupKeys) {
                                            collapsedGroupKeys - collapseKey
                                        } else {
                                            collapsedGroupKeys + collapseKey
                                        }
                                    },
                                )
                            }
                            if (isExpanded) {
                                items(group.tasks, key = { "active-${it.id}" }) { task ->
                                    Box(modifier = Modifier.padding(start = 10.dp)) {
                                        TaskCard(
                                            task = task,
                                            projectColorHex = projectColorById[task.projectId],
                                            hideProjectPill = true,
                                            onClick = { onOpenTask(task.id) },
                                        )
                                    }
                                }
                            }
                        }
                    } else {
                        items(partitioned.activeTasks, key = { it.id }) { task ->
                            TaskCard(
                                task = task,
                                projectColorHex = projectColorById[task.projectId],
                                hideProjectPill = false,
                                onClick = { onOpenTask(task.id) },
                            )
                        }
                    }
                }

                // Completed tasks collapsible section
                if (partitioned.completedTasks.isNotEmpty()) {
                    item(key = "sec-done") {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(top = if (partitioned.activeTasks.isNotEmpty()) 6.dp else 0.dp)
                                .clip(RoundedCornerShape(8.dp))
                                .clickable { completedExpanded = !completedExpanded }
                                .padding(vertical = 4.dp, horizontal = 2.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            Icon(
                                imageVector = if (completedExpanded) Icons.Default.ExpandMore else Icons.Default.ChevronRight,
                                contentDescription = null,
                                tint = colors.textMuted,
                                modifier = Modifier.size(16.dp),
                            )
                            Box(
                                modifier = Modifier
                                    .size(7.dp)
                                    .clip(CircleShape)
                                    .background(colors.emerald),
                            )
                            Text(
                                text = "完了済み",
                                fontSize = 11.5.sp,
                                fontWeight = FontWeight.SemiBold,
                                color = colors.textMuted,
                            )
                            Surface(
                                color = colors.surfaceSubtle,
                                shape = RoundedCornerShape(99.dp),
                            ) {
                                Text(
                                    text = "${partitioned.completedTasks.size}",
                                    fontSize = 10.5.sp,
                                    fontWeight = FontWeight.Medium,
                                    color = colors.textMuted,
                                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 1.dp),
                                )
                            }
                        }
                    }

                    if (completedExpanded || searchQuery.isNotBlank()) {
                        if (groupByProject) {
                            completedGroups.forEach { group ->
                                val collapseKey = "done:${group.groupKey}"
                                val isExpanded = searchQuery.isNotBlank() || collapseKey !in collapsedGroupKeys
                                item(key = "grp-hdr-$collapseKey") {
                                    ProjectGroupHeaderRow(
                                        group = group,
                                        isExpanded = isExpanded,
                                        onToggle = {
                                            collapsedGroupKeys = if (collapseKey in collapsedGroupKeys) {
                                                collapsedGroupKeys - collapseKey
                                            } else {
                                                collapsedGroupKeys + collapseKey
                                            }
                                        },
                                    )
                                }
                                if (isExpanded) {
                                    items(group.tasks, key = { "done-${it.id}" }) { task ->
                                        Box(modifier = Modifier.padding(start = 10.dp)) {
                                            TaskCard(
                                                task = task,
                                                projectColorHex = projectColorById[task.projectId],
                                                hideProjectPill = true,
                                                onClick = { onOpenTask(task.id) },
                                            )
                                        }
                                    }
                                }
                            }
                        } else {
                            items(partitioned.completedTasks, key = { it.id }) { task ->
                                TaskCard(
                                    task = task,
                                    projectColorHex = projectColorById[task.projectId],
                                    hideProjectPill = false,
                                    onClick = { onOpenTask(task.id) },
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    if (selectedTaskId != null && activeSheetTask != null) {
        TaskDetailBottomSheet(
            task = activeSheetTask,
            projectColorHex = projectColorById[activeSheetTask.projectId],
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
                        projectColorHex = projectColorById[activeSheetTask.projectId],
                    ),
                )
                onCloseTask()
            },
        )
    }
}

@Composable
private fun TaskSearchField(
    query: String,
    onQueryChange: (String) -> Unit,
) {
    val colors = ConductorTheme.colors
    Surface(
        color = colors.surfaceSubtle,
        shape = RoundedCornerShape(10.dp),
        border = BorderStroke(1.dp, colors.borderSubtle),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(
                imageVector = Icons.Default.Search,
                contentDescription = null,
                tint = colors.textSubtle,
                modifier = Modifier.size(16.dp),
            )
            Box(modifier = Modifier.weight(1f)) {
                if (query.isEmpty()) {
                    Text(
                        text = "タスク・T#・プロジェクトを検索...",
                        fontSize = 12.5.sp,
                        color = colors.textSubtle,
                    )
                }
                BasicTextField(
                    value = query,
                    onValueChange = onQueryChange,
                    singleLine = true,
                    textStyle = TextStyle(
                        color = colors.textPrimary,
                        fontSize = 12.5.sp,
                    ),
                    cursorBrush = SolidColor(colors.indigo),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            if (query.isNotEmpty()) {
                Icon(
                    imageVector = Icons.Default.Close,
                    contentDescription = "クリア",
                    tint = colors.textMuted,
                    modifier = Modifier
                        .size(16.dp)
                        .clickable { onQueryChange("") },
                )
            }
        }
    }
}

@Composable
private fun ProjectFilterPillRow(
    projects: List<Project>,
    selectedProjectId: String?,
    onSelectProject: (String?) -> Unit,
) {
    val colors = ConductorTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        val allSelected = selectedProjectId == null
        Surface(
            color = if (allSelected) colors.textPrimary else colors.surfaceSubtle,
            shape = RoundedCornerShape(99.dp),
            modifier = Modifier
                .clip(RoundedCornerShape(99.dp))
                .clickable { onSelectProject(null) },
        ) {
            Text(
                text = "すべて",
                fontSize = 11.5.sp,
                fontWeight = FontWeight.Medium,
                color = if (allSelected) colors.canvas else colors.textSecondary,
                modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
            )
        }

        projects.forEach { project ->
            val selected = selectedProjectId == project.id
            Surface(
                color = if (selected) colors.indigoBg else colors.surfaceSubtle,
                shape = RoundedCornerShape(99.dp),
                border = BorderStroke(
                    1.dp,
                    if (selected) colors.indigo.copy(alpha = 0.55f) else Color.Transparent,
                ),
                modifier = Modifier
                    .clip(RoundedCornerShape(99.dp))
                    .clickable { onSelectProject(project.id) },
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                ) {
                    Box(
                        modifier = Modifier
                            .size(7.dp)
                            .clip(CircleShape)
                            .background(parseConductorHexColor(project.colorHex)),
                    )
                    Text(
                        text = project.name,
                        fontSize = 11.5.sp,
                        fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
                        color = if (selected) colors.textPrimary else colors.textSecondary,
                        maxLines = 1,
                    )
                }
            }
        }
    }
}

@Composable
private fun SectionHeading(
    title: String,
    count: Int,
    accentColor: Color,
) {
    val colors = ConductorTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 2.dp, horizontal = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(
            modifier = Modifier
                .size(7.dp)
                .clip(CircleShape)
                .background(accentColor),
        )
        Text(
            text = title,
            fontSize = 11.5.sp,
            fontWeight = FontWeight.SemiBold,
            color = colors.textMuted,
        )
        Surface(
            color = colors.surfaceSubtle,
            shape = RoundedCornerShape(99.dp),
        ) {
            Text(
                text = "$count",
                fontSize = 10.5.sp,
                fontWeight = FontWeight.Medium,
                color = colors.textMuted,
                modifier = Modifier.padding(horizontal = 6.dp, vertical = 1.dp),
            )
        }
    }
}

@Composable
private fun ProjectGroupHeaderRow(
    group: TaskProjectGroup,
    isExpanded: Boolean,
    onToggle: () -> Unit,
) {
    val colors = ConductorTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .clickable(onClick = onToggle)
            .padding(horizontal = 6.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(
            imageVector = if (isExpanded) Icons.Default.ExpandMore else Icons.Default.ChevronRight,
            contentDescription = null,
            tint = colors.textSubtle,
            modifier = Modifier.size(15.dp),
        )
        Box(
            modifier = Modifier
                .size(8.dp)
                .clip(CircleShape)
                .background(parseConductorHexColor(group.colorHex)),
        )
        Text(
            text = group.projectName,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            color = colors.textPrimary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (group.runningCount > 0) {
            Surface(
                color = colors.indigoBg,
                shape = RoundedCornerShape(99.dp),
            ) {
                Text(
                    text = "実行中 ${group.runningCount}",
                    fontSize = 10.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = colors.indigoText,
                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 1.dp),
                )
            }
        }
        if (group.needsReviewCount > 0) {
            Surface(
                color = colors.amberBg,
                shape = RoundedCornerShape(99.dp),
            ) {
                Text(
                    text = "確認 ${group.needsReviewCount}",
                    fontSize = 10.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = colors.amberText,
                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 1.dp),
                )
            }
        }
        Surface(
            color = colors.surfaceSubtle,
            shape = RoundedCornerShape(99.dp),
        ) {
            Text(
                text = "${group.tasks.size}",
                fontSize = 10.sp,
                fontWeight = FontWeight.Medium,
                color = colors.textMuted,
                modifier = Modifier.padding(horizontal = 6.dp, vertical = 1.dp),
            )
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TaskCard(
    task: AgentTask,
    projectColorHex: String?,
    hideProjectPill: Boolean,
    onClick: () -> Unit,
) {
    val colors = ConductorTheme.colors
    val isDone = task.status == "done"

    ConductorCard(
        containerColor = if (isDone) colors.cardMuted else colors.card,
        borderColor = colors.border,
        cornerRadius = 12.dp,
        onClick = onClick,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            // Row 1: Status icon + T# monospace badge + Project pill + Provider pill + Status badge
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                TaskStatusIcon(status = task.status)
                TaskCodeBadge(taskNumber = task.taskNumber)
                if (!hideProjectPill) {
                    ProjectPill(
                        name = task.projectName,
                        colorHex = projectColorHex,
                    )
                }
                if (!task.provider.isNullOrBlank()) {
                    ProviderPill(provider = task.provider)
                }
                Spacer(modifier = Modifier.weight(1f))
                TaskStatusBadge(status = task.status)
            }

            // Row 2: Task title
            Text(
                text = task.title,
                fontSize = 13.5.sp,
                lineHeight = 19.sp,
                fontWeight = FontWeight.SemiBold,
                color = if (isDone) colors.textSecondary else colors.textPrimary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )

            // Row 3: Git worktree / Land badges (desktop parity)
            if (!task.worktreeBranch.isNullOrBlank() || !task.landedBranch.isNullOrBlank()) {
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalArrangement = Arrangement.spacedBy(5.dp),
                ) {
                    when {
                        task.landStatus == "landed" && !task.landedBranch.isNullOrBlank() -> {
                            GitBranchBadge(
                                label = "Landed → ${task.landedBranch}",
                                bg = colors.emeraldBg,
                                fg = colors.emeraldText,
                            )
                        }

                        task.landStatus == "pr_created" -> {
                            GitBranchBadge(
                                label = "PR · ${task.worktreeBranch ?: "branch"}",
                                bg = colors.indigoBg,
                                fg = colors.indigoText,
                            )
                        }

                        task.landStatus == "pushed" -> {
                            GitBranchBadge(
                                label = "Pushed · ${task.worktreeBranch ?: "branch"}",
                                bg = colors.skyBg,
                                fg = colors.skyText,
                            )
                        }

                        !task.worktreeBranch.isNullOrBlank() -> {
                            val isErr = task.landStatus == "conflict" || task.landStatus == "error"
                            GitBranchBadge(
                                label = task.worktreeBranch,
                                bg = if (isErr) colors.roseBg else colors.surfaceSubtle,
                                fg = if (isErr) colors.roseText else colors.textSecondary,
                            )
                            if (task.isUnlandedWorktree && task.status != "running") {
                                Surface(
                                    color = colors.amberBg,
                                    shape = RoundedCornerShape(5.dp),
                                ) {
                                    Text(
                                        text = "未反映",
                                        fontSize = 10.sp,
                                        fontWeight = FontWeight.SemiBold,
                                        color = colors.amberText,
                                        modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                                    )
                                }
                            }
                        }
                    }
                }
            }

            // Land conflict / error strip
            if (!task.landError.isNullOrBlank() &&
                (task.landStatus == "conflict" || task.landStatus == "error")
            ) {
                Surface(
                    color = colors.roseBg,
                    shape = RoundedCornerShape(6.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(5.dp),
                    ) {
                        Icon(
                            imageVector = Icons.Default.WarningAmber,
                            contentDescription = null,
                            tint = colors.rose,
                            modifier = Modifier.size(12.dp),
                        )
                        Text(
                            text = task.landError,
                            fontSize = 10.5.sp,
                            color = colors.roseText,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }

            // Row 4: Current step or summary subtitle
            val subtitle = task.currentStep?.takeIf { it.isNotBlank() } ?: task.summary
            if (subtitle.isNotBlank()) {
                Text(
                    text = subtitle,
                    fontSize = 12.sp,
                    lineHeight = 17.sp,
                    color = colors.textMuted,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun GitBranchBadge(
    label: String,
    bg: Color,
    fg: Color,
) {
    Surface(
        color = bg,
        shape = RoundedCornerShape(5.dp),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Icon(
                imageVector = Icons.Default.AccountTree,
                contentDescription = null,
                tint = fg,
                modifier = Modifier.size(11.dp),
            )
            Text(
                text = label,
                fontFamily = FontFamily.Monospace,
                fontSize = 10.sp,
                fontWeight = FontWeight.Medium,
                color = fg,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun TaskDetailBottomSheet(
    task: AgentTask,
    projectColorHex: String?,
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
    val colors = ConductorTheme.colors
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = colors.canvas,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 18.dp)
                .padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            // Top badges row
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                TaskCodeBadge(taskNumber = task.taskNumber)
                ProjectPill(name = task.projectName, colorHex = projectColorHex)
                if (!task.provider.isNullOrBlank()) {
                    ProviderPill(provider = task.provider)
                }
                TaskStatusBadge(status = task.status)
            }

            Text(
                text = task.title,
                fontSize = 18.sp,
                lineHeight = 24.sp,
                fontWeight = FontWeight.SemiBold,
                color = colors.textPrimary,
            )

            if (!task.currentStep.isNullOrBlank()) {
                Surface(
                    color = colors.indigoBg,
                    shape = RoundedCornerShape(10.dp),
                    border = BorderStroke(1.dp, colors.indigoBorder),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        text = "現在のステップ: ${task.currentStep}",
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Medium,
                        color = colors.indigoText,
                        modifier = Modifier.padding(horizontal = 11.dp, vertical = 8.dp),
                    )
                }
            }

            if (task.summary.isNotBlank()) {
                ConductorMarkdown(
                    markdown = task.summary,
                    variant = MarkdownVariant.DEFAULT,
                    textColor = colors.textSecondary,
                )
            }

            // Action buttons row
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (task.status == "running") {
                    Button(
                        onClick = onStopTask,
                        enabled = !actionInProgress,
                        shape = RoundedCornerShape(10.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = colors.rose,
                            contentColor = Color.White,
                        ),
                    ) {
                        Icon(Icons.Default.Stop, contentDescription = null, modifier = Modifier.size(15.dp))
                        Spacer(modifier = Modifier.width(5.dp))
                        Text("停止", fontSize = 12.5.sp)
                    }
                }

                if (task.status != "running" && task.hasWorktree && task.landStatus != "landed") {
                    Button(
                        onClick = onLandTask,
                        enabled = !actionInProgress,
                        shape = RoundedCornerShape(10.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = colors.indigoAction,
                            contentColor = Color.White,
                        ),
                    ) {
                        Icon(Icons.AutoMirrored.Filled.CallMerge, contentDescription = null, modifier = Modifier.size(15.dp))
                        Spacer(modifier = Modifier.width(5.dp))
                        Text("Land", fontSize = 12.5.sp)
                    }
                }

                if (task.status != "done") {
                    Button(
                        onClick = onMarkDone,
                        enabled = !actionInProgress,
                        shape = RoundedCornerShape(10.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = colors.emerald,
                            contentColor = Color.White,
                        ),
                    ) {
                        Icon(Icons.Default.Check, contentDescription = null, modifier = Modifier.size(15.dp))
                        Spacer(modifier = Modifier.width(5.dp))
                        Text("完了にする", fontSize = 12.5.sp)
                    }
                } else {
                    OutlinedButton(
                        onClick = onReopen,
                        enabled = !actionInProgress,
                        shape = RoundedCornerShape(10.dp),
                        border = BorderStroke(1.dp, colors.borderStrong),
                    ) {
                        Icon(Icons.Default.Replay, contentDescription = null, modifier = Modifier.size(15.dp))
                        Spacer(modifier = Modifier.width(5.dp))
                        Text("再オープン", fontSize = 12.5.sp)
                    }
                }

                OutlinedButton(
                    onClick = onMentionInChat,
                    shape = RoundedCornerShape(10.dp),
                    border = BorderStroke(1.dp, colors.borderStrong),
                ) {
                    Icon(Icons.Default.AlternateEmail, contentDescription = null, modifier = Modifier.size(15.dp))
                    Spacer(modifier = Modifier.width(5.dp))
                    Text("チャットで参照", fontSize = 12.5.sp)
                }
            }

            if (actionInProgress || isLoadingDetail) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(15.dp),
                        strokeWidth = 1.8.dp,
                        color = colors.indigo,
                    )
                    Text(
                        text = if (actionInProgress) "処理を実行中..." else "詳細を読み込み中...",
                        fontSize = 12.sp,
                        color = colors.textMuted,
                    )
                }
            }

            val wt = detail?.worktreeStatus
            if (wt != null && wt.hasWorktree) {
                ConductorCard(
                    containerColor = colors.surfaceSecondary,
                    cornerRadius = 12.dp,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column(
                        modifier = Modifier.padding(12.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Text(
                            text = "GIT WORKTREE",
                            fontSize = 10.5.sp,
                            fontWeight = FontWeight.SemiBold,
                            letterSpacing = 0.5.sp,
                            color = colors.textMuted,
                        )
                        Text(
                            text = "${wt.worktreeBranch ?: "-"} → ${wt.suggestedTargetBranch ?: wt.parentBranch ?: "-"}",
                            fontSize = 12.sp,
                            fontFamily = FontFamily.Monospace,
                            color = colors.textPrimary,
                        )
                        Text(
                            text = "Ahead commits: ${wt.aheadCommits} · Changed files: ${wt.changedFilesCount}",
                            fontSize = 11.5.sp,
                            color = colors.textMuted,
                        )
                    }
                }
            }

            if (task.latestOutput.isNotBlank()) {
                Text(
                    text = "最新レポート・出力",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = colors.textSecondary,
                )
                ConductorCard(
                    containerColor = colors.surfaceSecondary,
                    cornerRadius = 12.dp,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    ConductorMarkdown(
                        markdown = task.latestOutput.take(3500),
                        variant = MarkdownVariant.COMPACT,
                        textColor = colors.textPrimary,
                        modifier = Modifier.padding(12.dp),
                    )
                }
            }

            val gitStatus = detail?.gitStatus
            if (!gitStatus.isNullOrBlank()) {
                Text(
                    text = "GIT STATUS",
                    fontSize = 11.sp,
                    fontWeight = FontWeight.SemiBold,
                    letterSpacing = 0.5.sp,
                    color = colors.textMuted,
                )
                ConductorCard(
                    containerColor = colors.codeBlockBg,
                    cornerRadius = 10.dp,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        text = gitStatus,
                        fontSize = 11.5.sp,
                        lineHeight = 17.sp,
                        fontFamily = FontFamily.Monospace,
                        color = colors.textPrimary,
                        modifier = Modifier.padding(12.dp),
                    )
                }
            }

            Spacer(modifier = Modifier.height(6.dp))
        }
    }
}
