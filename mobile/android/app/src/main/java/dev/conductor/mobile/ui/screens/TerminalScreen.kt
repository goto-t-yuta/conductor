package dev.conductor.mobile.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardReturn
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.DeleteSweep
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.RestartAlt
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.conductor.mobile.data.TerminalAnsiPalette
import dev.conductor.mobile.model.Project
import dev.conductor.mobile.model.TerminalConnectionState
import dev.conductor.mobile.model.TerminalRenderedLine
import dev.conductor.mobile.model.TerminalUiState
import dev.conductor.mobile.ui.components.parseConductorHexColor
import dev.conductor.mobile.ui.theme.ConductorAmber
import dev.conductor.mobile.ui.theme.ConductorEmerald
import dev.conductor.mobile.ui.theme.ConductorIndigo
import dev.conductor.mobile.ui.theme.ConductorIndigoAction
import dev.conductor.mobile.ui.theme.ConductorIndigoLight
import dev.conductor.mobile.ui.theme.ConductorRose
import dev.conductor.mobile.ui.theme.ConductorTheme
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

// Dedicated dark terminal surface tokens (always dark for legibility & ANSI contrast)
private val TermBg = Color(TerminalAnsiPalette.BACKGROUND_ARGB)
private val TermFg = Color(TerminalAnsiPalette.FOREGROUND_ARGB)
private val TermBarBg = Color(0xFF141821)
private val TermKeyBg = Color(0xFF1D2230)
private val TermKeyControlBg = Color(0xFF23293A)
private val TermBorder = Color(0xFF272D3D)
private val TermMuted = Color(0xFF9CA3AF)
private val TermSubtle = Color(0xFF6B7280)

private data class TerminalScrollObservation(
    val metrics: ChatScrollMetrics,
    val lineCount: Int,
    val isUserScrolling: Boolean,
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TerminalScreen(
    terminalState: TerminalUiState,
    projects: List<Project>,
    onEnsureConnected: () -> Unit,
    onSelectProject: (projectPath: String?, projectName: String?) -> Unit,
    onCommandInputChange: (String) -> Unit,
    onSubmitCommand: () -> Unit,
    onAuxKeyClick: (TerminalAuxKey) -> Unit,
    onClearOutput: () -> Unit,
    onRestartSession: () -> Unit,
    onReconnect: () -> Unit,
    onDimensionsChanged: (cols: Int, rows: Int) -> Unit,
    listState: LazyListState = rememberLazyListState(),
) {
    val coroutineScope = rememberCoroutineScope()
    val density = LocalDensity.current
    val textMeasurer = rememberTextMeasurer()

    var showProjectSheet by remember { mutableStateOf(false) }
    var isAutoFollow by remember { mutableStateOf(true) }
    var isProgrammaticScrolling by remember { mutableStateOf(false) }

    val lineTextStyle = remember {
        TextStyle(
            fontFamily = FontFamily.Monospace,
            fontSize = 12.5.sp,
            lineHeight = 17.5.sp,
            color = TermFg,
        )
    }

    val cellMetrics = remember(textMeasurer, lineTextStyle) {
        val sample = textMeasurer.measure(
            text = AnnotatedString("WWWWWWWWWW"),
            style = lineTextStyle,
        )
        val charWidth = (sample.size.width / 10f).coerceAtLeast(1f)
        val lineHeight = sample.size.height.toFloat().coerceAtLeast(1f)
        charWidth to lineHeight
    }

    LaunchedEffect(Unit) {
        onEnsureConnected()
    }

    val bottomThresholdPx = remember(density) {
        with(density) { TerminalScrollLogic.BOTTOM_THRESHOLD_DP.dp.roundToPx() }
    }
    val latestLineCount by rememberUpdatedState(terminalState.lines.size)

    // Track manual scrolling to pause/resume auto-follow
    LaunchedEffect(listState, bottomThresholdPx) {
        var wasUserScrolling = false
        snapshotFlow {
            val metrics = listState.toChatScrollMetrics()
            val userScrolling = listState.isScrollInProgress && !isProgrammaticScrolling
            TerminalScrollObservation(
                metrics = metrics,
                lineCount = latestLineCount,
                isUserScrolling = userScrolling,
            )
        }
            .distinctUntilChanged()
            .collect { obs ->
                val nextFollow = TerminalScrollLogic.resolveAutoFollowAfterScroll(
                    currentAutoFollow = isAutoFollow,
                    metrics = obs.metrics,
                    lineCount = obs.lineCount,
                    thresholdPx = bottomThresholdPx,
                    isUserScrolling = obs.isUserScrolling,
                    wasUserScrolling = wasUserScrolling,
                    isProgrammaticScrolling = isProgrammaticScrolling,
                )
                isAutoFollow = nextFollow
                wasUserScrolling = obs.isUserScrolling
            }
    }

    // Auto-scroll to latest line whenever output changes and follow mode is active
    LaunchedEffect(terminalState.outputVersion, terminalState.lines.size, isAutoFollow) {
        val count = terminalState.lines.size
        if (isAutoFollow && count > 0) {
            isProgrammaticScrolling = true
            try {
                listState.scrollToItem(index = count - 1, scrollOffset = Int.MAX_VALUE / 2)
            } finally {
                isProgrammaticScrolling = false
            }
        }
    }

    val currentProjectLabel = remember(
        terminalState.selectedProjectName,
        terminalState.selectedProjectPath,
        projects,
    ) {
        terminalState.selectedProjectName
            ?: projects.firstOrNull { it.path == terminalState.selectedProjectPath }?.name
            ?: "Home (~)"
    }

    val currentProjectColorHex = remember(terminalState.selectedProjectPath, projects) {
        projects.firstOrNull { it.path == terminalState.selectedProjectPath }?.colorHex
    }

    val compactCwd = remember(terminalState.session?.cwd, terminalState.selectedProjectPath) {
        TerminalScrollLogic.formatCompactCwd(
            terminalState.session?.cwd?.ifBlank { null } ?: terminalState.selectedProjectPath,
        )
    }

    val shellTag = remember(terminalState.session?.shellName) {
        terminalState.session?.shellName?.takeIf { it.isNotBlank() } ?: "shell"
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(TermBg)
            .imePadding(),
    ) {
        // --- Top Control Header ---
        TerminalTopBar(
            projectLabel = currentProjectLabel,
            projectColorHex = currentProjectColorHex,
            isHome = terminalState.selectedProjectPath.isNullOrBlank(),
            compactCwd = compactCwd,
            shellTag = shellTag,
            connectionState = terminalState.connectionState,
            onOpenProjectPicker = { showProjectSheet = true },
            onReconnect = onReconnect,
            onClear = {
                isAutoFollow = true
                onClearOutput()
            },
            onRestart = {
                isAutoFollow = true
                onRestartSession()
            },
        )

        HorizontalDivider(thickness = 1.dp, color = TermBorder)

        // --- Realtime Output Viewport ---
        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .background(TermBg)
                .onSizeChanged { size ->
                    val horizontalPadPx = with(density) { 20.dp.roundToPx() }
                    val verticalPadPx = with(density) { 16.dp.roundToPx() }
                    val availW = (size.width - horizontalPadPx).coerceAtLeast(0)
                    val availH = (size.height - verticalPadPx).coerceAtLeast(0)
                    val (cols, rows) = TerminalScrollLogic.computeTerminalGridSize(
                        viewportWidthPx = availW,
                        viewportHeightPx = availH,
                        charWidthPx = cellMetrics.first,
                        lineHeightPx = cellMetrics.second,
                    )
                    onDimensionsChanged(cols, rows)
                },
        ) {
            if (terminalState.lines.isEmpty() ||
                (terminalState.lines.size == 1 && terminalState.lines.first().spans.isEmpty())
            ) {
                TerminalEmptyOverlay(
                    connectionState = terminalState.connectionState,
                    statusDetail = terminalState.statusDetail,
                    onReconnect = onReconnect,
                )
            } else {
                SelectionContainer(modifier = Modifier.fillMaxSize()) {
                    LazyColumn(
                        state = listState,
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(horizontal = 10.dp, vertical = 8.dp),
                    ) {
                        items(
                            items = terminalState.lines,
                            key = { it.id },
                        ) { line ->
                            TerminalOutputLineRow(
                                line = line,
                                textStyle = lineTextStyle,
                            )
                        }
                        item(key = "__terminal_bottom_spacer__") {
                            Spacer(modifier = Modifier.height(6.dp))
                        }
                    }
                }
            }

            // Floating "Jump to latest output" button when user scrolled up
            androidx.compose.animation.AnimatedVisibility(
                visible = !isAutoFollow && terminalState.lines.isNotEmpty(),
                enter = fadeIn() + slideInVertically { it / 2 },
                exit = fadeOut() + slideOutVertically { it / 2 },
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .padding(end = 12.dp, bottom = 12.dp),
            ) {
                Surface(
                    onClick = {
                        isAutoFollow = true
                        coroutineScope.launch {
                            val lastIndex = (terminalState.lines.size - 1).coerceAtLeast(0)
                            isProgrammaticScrolling = true
                            try {
                                listState.animateScrollToItem(lastIndex)
                            } finally {
                                isProgrammaticScrolling = false
                            }
                        }
                    },
                    shape = RoundedCornerShape(99.dp),
                    color = TermBarBg.copy(alpha = 0.95f),
                    border = BorderStroke(1.dp, ConductorIndigo.copy(alpha = 0.6f)),
                    shadowElevation = 4.dp,
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 7.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(5.dp),
                    ) {
                        Icon(
                            imageVector = Icons.Default.ArrowDownward,
                            contentDescription = "最新出力へスクロール",
                            tint = ConductorIndigoLight,
                            modifier = Modifier.size(14.dp),
                        )
                        Text(
                            text = "最新出力へ",
                            fontSize = 11.5.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = TermFg,
                        )
                    }
                }
            }
        }

        // --- Inline Status Banner for Exited / Error states ---
        if (terminalState.connectionState == TerminalConnectionState.EXITED) {
            TerminalInlineBanner(
                message = buildString {
                    append("シェルプロセスが終了しました")
                    terminalState.session?.exitCode?.let { append(" (exit: $it)") }
                },
                accentColor = ConductorAmber,
                actionLabel = "再起動",
                onAction = {
                    isAutoFollow = true
                    onRestartSession()
                },
            )
        } else if (terminalState.connectionState == TerminalConnectionState.ERROR &&
            !terminalState.lastError.isNullOrBlank()
        ) {
            TerminalInlineBanner(
                message = terminalState.lastError,
                accentColor = ConductorRose,
                actionLabel = "再接続",
                onAction = onReconnect,
            )
        }

        HorizontalDivider(thickness = 1.dp, color = TermBorder)

        // --- Mobile Auxiliary Key Bar ---
        TerminalAuxKeyBar(
            keys = TerminalAuxKeys.defaultKeys,
            enabled = terminalState.connectionState == TerminalConnectionState.CONNECTED,
            onKeyClick = { key ->
                if (key.kind == TerminalAuxKeyKind.CONTROL) {
                    isAutoFollow = true
                }
                onAuxKeyClick(key)
            },
        )

        // --- Command Input Bar ---
        TerminalCommandInputBar(
            value = terminalState.commandInput,
            enabled = terminalState.connectionState == TerminalConnectionState.CONNECTED,
            onValueChange = onCommandInputChange,
            onSubmit = {
                isAutoFollow = true
                onSubmitCommand()
            },
        )
    }

    // --- Project / cwd Selection Bottom Sheet ---
    if (showProjectSheet) {
        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        val appColors = ConductorTheme.colors
        ModalBottomSheet(
            onDismissRequest = { showProjectSheet = false },
            sheetState = sheetState,
            containerColor = appColors.card,
            contentColor = appColors.textPrimary,
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp)
                    .padding(bottom = 24.dp),
            ) {
                Text(
                    text = "作業ディレクトリ (cwd) を選択",
                    fontSize = 15.5.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = appColors.textPrimary,
                )
                Text(
                    text = "切り替えると選択ディレクトリで新しいシェルを開始します",
                    fontSize = 12.sp,
                    color = appColors.textMuted,
                    modifier = Modifier.padding(top = 2.dp, bottom = 12.dp),
                )

                val isHomeSelected = terminalState.selectedProjectPath.isNullOrBlank()
                ProjectDirectoryOptionRow(
                    title = "Home (~)",
                    subtitle = "PC のホームディレクトリ",
                    badgeText = null,
                    dotColor = null,
                    selected = isHomeSelected,
                    onClick = {
                        showProjectSheet = false
                        isAutoFollow = true
                        onSelectProject(null, null)
                    },
                )

                if (projects.isNotEmpty()) {
                    Spacer(modifier = Modifier.height(6.dp))
                    HorizontalDivider(color = appColors.borderSubtle)
                    Spacer(modifier = Modifier.height(6.dp))
                    projects.forEach { project ->
                        val selected = terminalState.selectedProjectPath == project.path
                        ProjectDirectoryOptionRow(
                            title = project.name,
                            subtitle = TerminalScrollLogic.formatCompactCwd(project.path),
                            badgeText = project.gitBranch,
                            dotColor = parseConductorHexColor(project.colorHex),
                            selected = selected,
                            onClick = {
                                showProjectSheet = false
                                isAutoFollow = true
                                onSelectProject(project.path, project.name)
                            },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun TerminalTopBar(
    projectLabel: String,
    projectColorHex: String?,
    isHome: Boolean,
    compactCwd: String,
    shellTag: String,
    connectionState: TerminalConnectionState,
    onOpenProjectPicker: () -> Unit,
    onReconnect: () -> Unit,
    onClear: () -> Unit,
    onRestart: () -> Unit,
) {
    val (statusLabel, statusColor) = when (connectionState) {
        TerminalConnectionState.CONNECTED -> "接続中" to ConductorEmerald
        TerminalConnectionState.CONNECTING -> "接続中..." to ConductorAmber
        TerminalConnectionState.RECONNECTING -> "再接続中" to ConductorAmber
        TerminalConnectionState.EXITED -> "終了" to ConductorAmber
        TerminalConnectionState.ERROR -> "エラー" to ConductorRose
        TerminalConnectionState.DISCONNECTED -> "未接続" to TermSubtle
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(TermBarBg)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        // Project / cwd switcher pill
        Surface(
            onClick = onOpenProjectPicker,
            color = TermKeyBg,
            shape = RoundedCornerShape(10.dp),
            border = BorderStroke(1.dp, TermBorder),
            modifier = Modifier
                .weight(1f)
                .semantics { contentDescription = "プロジェクト切替" },
        ) {
            Row(
                modifier = Modifier.padding(horizontal = 9.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(7.dp),
            ) {
                if (isHome) {
                    Icon(
                        imageVector = Icons.Default.Terminal,
                        contentDescription = null,
                        tint = ConductorIndigoLight,
                        modifier = Modifier.size(15.dp),
                    )
                } else {
                    Box(
                        modifier = Modifier
                            .size(8.dp)
                            .clip(CircleShape)
                            .background(parseConductorHexColor(projectColorHex)),
                    )
                }
                Column(modifier = Modifier.weight(1f)) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(5.dp),
                    ) {
                        Text(
                            text = projectLabel,
                            fontSize = 12.5.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = TermFg,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false),
                        )
                        Text(
                            text = shellTag,
                            fontFamily = FontFamily.Monospace,
                            fontSize = 10.sp,
                            color = ConductorIndigoLight,
                            maxLines = 1,
                        )
                    }
                    Text(
                        text = compactCwd,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 10.sp,
                        color = TermMuted,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Icon(
                    imageVector = Icons.Default.ExpandMore,
                    contentDescription = null,
                    tint = TermMuted,
                    modifier = Modifier.size(16.dp),
                )
            }
        }

        // Connection status badge (tapping reconnects when not connected)
        val canTapReconnect = connectionState == TerminalConnectionState.DISCONNECTED ||
            connectionState == TerminalConnectionState.ERROR
        Surface(
            color = statusColor.copy(alpha = 0.14f),
            shape = RoundedCornerShape(99.dp),
            border = BorderStroke(1.dp, statusColor.copy(alpha = 0.35f)),
            modifier = if (canTapReconnect) {
                Modifier
                    .clip(RoundedCornerShape(99.dp))
                    .clickable(onClick = onReconnect)
            } else {
                Modifier
            },
        ) {
            Row(
                modifier = Modifier.padding(horizontal = 8.dp, vertical = 5.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                if (connectionState == TerminalConnectionState.CONNECTING ||
                    connectionState == TerminalConnectionState.RECONNECTING
                ) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(10.dp),
                        strokeWidth = 1.5.dp,
                        color = statusColor,
                    )
                } else {
                    Box(
                        modifier = Modifier
                            .size(7.dp)
                            .clip(CircleShape)
                            .background(statusColor),
                    )
                }
                Text(
                    text = statusLabel,
                    fontSize = 10.5.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = statusColor,
                    maxLines = 1,
                )
            }
        }

        // Clear button
        Surface(
            onClick = onClear,
            color = TermKeyBg,
            shape = RoundedCornerShape(8.dp),
            border = BorderStroke(1.dp, TermBorder),
            modifier = Modifier
                .size(36.dp)
                .semantics { contentDescription = "出力をクリア" },
        ) {
            Box(contentAlignment = Alignment.Center) {
                Icon(
                    imageVector = Icons.Default.DeleteSweep,
                    contentDescription = "出力をクリア",
                    tint = TermMuted,
                    modifier = Modifier.size(18.dp),
                )
            }
        }

        // Restart button
        Surface(
            onClick = onRestart,
            color = TermKeyBg,
            shape = RoundedCornerShape(8.dp),
            border = BorderStroke(1.dp, TermBorder),
            modifier = Modifier
                .size(36.dp)
                .semantics { contentDescription = "シェルを再起動" },
        ) {
            Box(contentAlignment = Alignment.Center) {
                Icon(
                    imageVector = Icons.Default.RestartAlt,
                    contentDescription = "シェルを再起動",
                    tint = TermFg,
                    modifier = Modifier.size(18.dp),
                )
            }
        }
    }
}

@Composable
private fun TerminalOutputLineRow(
    line: TerminalRenderedLine,
    textStyle: TextStyle,
) {
    val annotated = remember(line.id, line.spans) {
        if (line.spans.isEmpty()) {
            AnnotatedString(" ")
        } else {
            buildAnnotatedString {
                for (span in line.spans) {
                    val s = span.style
                    val baseFg = s.fgColorArgb?.let { Color(it) } ?: TermFg
                    val effectiveFg = if (s.dim) baseFg.copy(alpha = 0.65f) else baseFg
                    val bg = s.bgColorArgb?.let { Color(it) } ?: Color.Unspecified
                    val start = length
                    append(span.text)
                    val end = length
                    if (end > start) {
                        addStyle(
                            style = SpanStyle(
                                color = effectiveFg,
                                background = bg,
                                fontWeight = if (s.bold) FontWeight.Bold else null,
                                fontStyle = if (s.italic) FontStyle.Italic else null,
                                textDecoration = if (s.underline) TextDecoration.Underline else null,
                            ),
                            start = start,
                            end = end,
                        )
                    }
                }
            }
        }
    }

    Text(
        text = annotated,
        style = textStyle,
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun TerminalEmptyOverlay(
    connectionState: TerminalConnectionState,
    statusDetail: String,
    onReconnect: () -> Unit,
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (connectionState == TerminalConnectionState.CONNECTING ||
                connectionState == TerminalConnectionState.RECONNECTING
            ) {
                CircularProgressIndicator(
                    color = ConductorIndigoLight,
                    strokeWidth = 2.5.dp,
                    modifier = Modifier.size(28.dp),
                )
            } else {
                Icon(
                    imageVector = Icons.Default.Terminal,
                    contentDescription = null,
                    tint = TermSubtle,
                    modifier = Modifier.size(32.dp),
                )
            }
            Text(
                text = statusDetail,
                fontFamily = FontFamily.Monospace,
                fontSize = 12.5.sp,
                color = TermMuted,
            )
            if (connectionState == TerminalConnectionState.ERROR ||
                connectionState == TerminalConnectionState.DISCONNECTED
            ) {
                Surface(
                    onClick = onReconnect,
                    color = ConductorIndigoAction,
                    shape = RoundedCornerShape(8.dp),
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Icon(
                            imageVector = Icons.Default.Refresh,
                            contentDescription = null,
                            tint = Color.White,
                            modifier = Modifier.size(15.dp),
                        )
                        Text(
                            text = "再接続",
                            fontSize = 12.5.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = Color.White,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun TerminalInlineBanner(
    message: String,
    accentColor: Color,
    actionLabel: String,
    onAction: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(accentColor.copy(alpha = 0.12f))
            .padding(horizontal = 12.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = message,
            fontSize = 12.sp,
            color = accentColor,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Surface(
            onClick = onAction,
            color = accentColor.copy(alpha = 0.22f),
            shape = RoundedCornerShape(6.dp),
            border = BorderStroke(1.dp, accentColor.copy(alpha = 0.5f)),
        ) {
            Text(
                text = actionLabel,
                fontSize = 11.5.sp,
                fontWeight = FontWeight.SemiBold,
                color = TermFg,
                modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
            )
        }
    }
}

@Composable
private fun TerminalAuxKeyBar(
    keys: List<TerminalAuxKey>,
    enabled: Boolean,
    onKeyClick: (TerminalAuxKey) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(TermBarBg)
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 8.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        keys.forEach { key ->
            val bg = when {
                key.isDanger -> ConductorRose.copy(alpha = 0.18f)
                key.kind == TerminalAuxKeyKind.CONTROL -> TermKeyControlBg
                else -> TermKeyBg
            }
            val border = when {
                key.isDanger -> ConductorRose.copy(alpha = 0.45f)
                key.kind == TerminalAuxKeyKind.CONTROL -> ConductorIndigo.copy(alpha = 0.35f)
                else -> TermBorder
            }
            val textColor = when {
                !enabled && key.kind == TerminalAuxKeyKind.CONTROL -> TermSubtle
                key.isDanger -> Color(0xFFFDA4AF)
                key.kind == TerminalAuxKeyKind.CONTROL -> ConductorIndigoLight
                else -> TermFg
            }
            val clickable = enabled || key.kind == TerminalAuxKeyKind.INSERT

            Surface(
                onClick = { if (clickable) onKeyClick(key) },
                enabled = clickable,
                color = bg,
                shape = RoundedCornerShape(7.dp),
                border = BorderStroke(1.dp, border),
                modifier = Modifier.semantics { contentDescription = key.contentDescription },
            ) {
                Text(
                    text = key.label,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = textColor,
                    maxLines = 1,
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                )
            }
        }
    }
}

@Composable
private fun TerminalCommandInputBar(
    value: String,
    enabled: Boolean,
    onValueChange: (String) -> Unit,
    onSubmit: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(TermBarBg)
            .padding(start = 10.dp, end = 10.dp, top = 2.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            modifier = Modifier
                .weight(1f)
                .clip(RoundedCornerShape(10.dp))
                .background(TermBg)
                .border(1.dp, TermBorder, RoundedCornerShape(10.dp))
                .padding(horizontal = 10.dp, vertical = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "$",
                fontFamily = FontFamily.Monospace,
                fontSize = 13.5.sp,
                fontWeight = FontWeight.Bold,
                color = if (enabled) ConductorEmerald else TermSubtle,
            )
            Spacer(modifier = Modifier.width(8.dp))
            Box(modifier = Modifier.weight(1f)) {
                if (value.isEmpty()) {
                    Text(
                        text = if (enabled) "コマンドを入力 (例: ls -la, git status)" else "接続待機中...",
                        fontFamily = FontFamily.Monospace,
                        fontSize = 13.sp,
                        color = TermSubtle,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                BasicTextField(
                    value = value,
                    onValueChange = onValueChange,
                    enabled = enabled,
                    singleLine = true,
                    textStyle = TextStyle(
                        fontFamily = FontFamily.Monospace,
                        fontSize = 13.5.sp,
                        color = TermFg,
                    ),
                    cursorBrush = SolidColor(ConductorIndigoLight),
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                        keyboardType = KeyboardType.Ascii,
                        imeAction = ImeAction.Send,
                    ),
                    keyboardActions = KeyboardActions(
                        onSend = { if (enabled) onSubmit() },
                    ),
                    modifier = Modifier
                        .fillMaxWidth()
                        .semantics { contentDescription = "コマンド入力欄" },
                )
            }
        }

        Surface(
            onClick = { if (enabled) onSubmit() },
            enabled = enabled,
            color = if (enabled) ConductorIndigoAction else TermKeyBg,
            shape = RoundedCornerShape(10.dp),
            modifier = Modifier.semantics { contentDescription = "コマンドを実行" },
        ) {
            Box(
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 9.dp),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.KeyboardReturn,
                    contentDescription = "実行",
                    tint = if (enabled) Color.White else TermSubtle,
                    modifier = Modifier.size(19.dp),
                )
            }
        }
    }
}

@Composable
private fun ProjectDirectoryOptionRow(
    title: String,
    subtitle: String,
    badgeText: String?,
    dotColor: Color?,
    selected: Boolean,
    onClick: () -> Unit,
) {
    val colors = ConductorTheme.colors
    Surface(
        onClick = onClick,
        color = if (selected) colors.indigoBg else Color.Transparent,
        shape = RoundedCornerShape(10.dp),
        border = if (selected) BorderStroke(1.dp, colors.indigoBorder) else null,
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 2.dp),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (dotColor != null) {
                Box(
                    modifier = Modifier
                        .size(10.dp)
                        .clip(CircleShape)
                        .background(dotColor),
                )
            } else {
                Icon(
                    imageVector = if (title.startsWith("Home")) Icons.Default.Home else Icons.Default.Folder,
                    contentDescription = null,
                    tint = colors.indigoText,
                    modifier = Modifier.size(16.dp),
                )
            }
            Column(modifier = Modifier.weight(1f)) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(
                        text = title,
                        fontSize = 13.5.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = colors.textPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (!badgeText.isNullOrBlank()) {
                        Surface(
                            color = colors.surfaceSubtle,
                            shape = RoundedCornerShape(4.dp),
                        ) {
                            Text(
                                text = badgeText,
                                fontFamily = FontFamily.Monospace,
                                fontSize = 10.sp,
                                color = colors.textMuted,
                                maxLines = 1,
                                modifier = Modifier.padding(horizontal = 5.dp, vertical = 1.dp),
                            )
                        }
                    }
                }
                Text(
                    text = subtitle,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 11.sp,
                    color = colors.textMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (selected) {
                Icon(
                    imageVector = Icons.Default.Check,
                    contentDescription = "選択中",
                    tint = colors.indigoText,
                    modifier = Modifier.size(18.dp),
                )
            }
        }
    }
}
