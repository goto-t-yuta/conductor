package dev.conductor.mobile

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChatBubble
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat
import dev.conductor.mobile.ui.ConductorViewModel
import dev.conductor.mobile.ui.screens.ChatScreen
import dev.conductor.mobile.ui.screens.QrScannerScreen
import dev.conductor.mobile.ui.screens.SettingsScreen
import dev.conductor.mobile.ui.screens.SetupScreen
import dev.conductor.mobile.ui.screens.TasksScreen
import dev.conductor.mobile.ui.theme.ConductorTheme
import dev.conductor.mobile.ui.theme.resolveDarkTheme

private enum class MainTab(val label: String) {
    CHAT("Chat"),
    TASKS("Tasks"),
    SETTINGS("Settings"),
}

class MainActivity : ComponentActivity() {
    private val viewModel: ConductorViewModel by viewModels()
    private var hasStartedOnce = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handleIntent(intent)

        setContent {
            val state by viewModel.uiState.collectAsState()
            val isDark = resolveDarkTheme(state.themeMode)
            val view = LocalView.current
            if (!view.isInEditMode) {
                SideEffect {
                    val window = (view.context as? Activity)?.window ?: return@SideEffect
                    val controller = WindowCompat.getInsetsController(window, view)
                    controller.isAppearanceLightStatusBars = !isDark
                    controller.isAppearanceLightNavigationBars = !isDark
                }
            }

            ConductorTheme(themeMode = state.themeMode) {
                ConductorMobileApp(viewModel = viewModel)
            }
        }
    }

    override fun onStart() {
        super.onStart()
        if (hasStartedOnce) {
            viewModel.onAppForegrounded()
        } else {
            hasStartedOnce = true
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        val data = intent?.dataString ?: return
        if (data.startsWith("conductor://", ignoreCase = true)) {
            viewModel.handleIncomingConnectUri(data)
        }
    }
}

@Composable
private fun ConductorMobileApp(viewModel: ConductorViewModel) {
    val state by viewModel.uiState.collectAsState()
    val colors = ConductorTheme.colors
    val snackbarHostState = remember { SnackbarHostState() }
    var currentTab by rememberSaveable { mutableStateOf(MainTab.CHAT) }
    var showQrScanner by rememberSaveable { mutableStateOf(false) }

    LaunchedEffect(state.bannerMessage) {
        val msg = state.bannerMessage ?: return@LaunchedEffect
        snackbarHostState.showSnackbar(msg)
        viewModel.clearBanner()
    }

    if (showQrScanner) {
        QrScannerScreen(
            onQrCodeScanned = { rawPayload ->
                showQrScanner = false
                if (viewModel.handleIncomingConnectUri(rawPayload)) {
                    currentTab = MainTab.CHAT
                }
            },
            onClose = { showQrScanner = false },
        )
        return
    }

    if (!state.isLoaded) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(colors.canvas),
            contentAlignment = Alignment.Center,
        ) {
            CircularProgressIndicator(color = colors.indigo)
        }
        return
    }

    if (!state.config.isConfigured) {
        Scaffold(
            containerColor = colors.canvas,
            snackbarHost = { SnackbarHost(snackbarHostState) },
        ) { innerPadding ->
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(innerPadding)
                    .consumeWindowInsets(innerPadding),
            ) {
                SetupScreen(
                    initialConfig = state.config,
                    pendingDeepLink = state.pendingDeepLinkConfig,
                    themeMode = state.themeMode,
                    isTesting = state.isTestingConnection,
                    lastTestResult = state.lastTestResult,
                    onSelectThemeMode = viewModel::setThemeMode,
                    onConsumeDeepLink = viewModel::consumePendingDeepLink,
                    onOpenQrScanner = { showQrScanner = true },
                    onTestConnection = viewModel::testConnection,
                    onSaveAndConnect = viewModel::saveAndConnect,
                )
            }
        }
        return
    }

    val runningTaskCount = state.snapshot?.tasks?.count { it.status == "running" } ?: 0
    val navItemColors = NavigationBarItemDefaults.colors(
        selectedIconColor = colors.indigoText,
        selectedTextColor = colors.indigoText,
        indicatorColor = colors.indigoBg,
        unselectedIconColor = colors.textMuted,
        unselectedTextColor = colors.textMuted,
    )

    Scaffold(
        containerColor = colors.canvas,
        snackbarHost = { SnackbarHost(snackbarHostState) },
        bottomBar = {
            Column {
                HorizontalDivider(thickness = 1.dp, color = colors.borderSubtle)
                NavigationBar(
                    containerColor = colors.surfaceSecondary,
                    tonalElevation = 0.dp,
                ) {
                    NavigationBarItem(
                        selected = currentTab == MainTab.CHAT,
                        onClick = { currentTab = MainTab.CHAT },
                        colors = navItemColors,
                        icon = {
                            Icon(
                                imageVector = if (currentTab == MainTab.CHAT) {
                                    Icons.Filled.ChatBubble
                                } else {
                                    Icons.Outlined.ChatBubbleOutline
                                },
                                contentDescription = "Chat",
                            )
                        },
                        label = {
                            Text(
                                text = MainTab.CHAT.label,
                                fontSize = 11.sp,
                                fontWeight = if (currentTab == MainTab.CHAT) FontWeight.SemiBold else FontWeight.Medium,
                            )
                        },
                    )
                    NavigationBarItem(
                        selected = currentTab == MainTab.TASKS,
                        onClick = { currentTab = MainTab.TASKS },
                        colors = navItemColors,
                        icon = {
                            BadgedBox(
                                badge = {
                                    if (runningTaskCount > 0) {
                                        Badge(
                                            containerColor = colors.indigoAction,
                                            contentColor = Color.White,
                                        ) {
                                            Text("$runningTaskCount")
                                        }
                                    }
                                },
                            ) {
                                Icon(
                                    imageVector = if (currentTab == MainTab.TASKS) {
                                        Icons.Filled.Checklist
                                    } else {
                                        Icons.Outlined.Checklist
                                    },
                                    contentDescription = "Tasks",
                                )
                            }
                        },
                        label = {
                            Text(
                                text = MainTab.TASKS.label,
                                fontSize = 11.sp,
                                fontWeight = if (currentTab == MainTab.TASKS) FontWeight.SemiBold else FontWeight.Medium,
                            )
                        },
                    )
                    NavigationBarItem(
                        selected = currentTab == MainTab.SETTINGS,
                        onClick = { currentTab = MainTab.SETTINGS },
                        colors = navItemColors,
                        icon = {
                            Icon(
                                imageVector = if (currentTab == MainTab.SETTINGS) {
                                    Icons.Filled.Settings
                                } else {
                                    Icons.Outlined.Settings
                                },
                                contentDescription = "Settings",
                            )
                        },
                        label = {
                            Text(
                                text = MainTab.SETTINGS.label,
                                fontSize = 11.sp,
                                fontWeight = if (currentTab == MainTab.SETTINGS) FontWeight.SemiBold else FontWeight.Medium,
                            )
                        },
                    )
                }
            }
        },
    ) { innerPadding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .consumeWindowInsets(innerPadding),
        ) {
            when (currentTab) {
                MainTab.CHAT -> ChatScreen(
                    snapshot = state.snapshot,
                    transportState = state.transportState,
                    composerText = state.composerText,
                    selectedMentions = state.selectedMentions,
                    pendingAttachments = state.pendingAttachments,
                    isProcessingImages = state.isProcessingImages,
                    isSending = state.isSending,
                    onComposerTextChange = viewModel::updateComposerText,
                    onAddMention = viewModel::addMention,
                    onRemoveMention = viewModel::removeMention,
                    onPickImageUris = viewModel::addImageUris,
                    onRemoveAttachment = viewModel::removePendingAttachment,
                    getCachedAttachmentImage = viewModel::getCachedAttachmentImageBytes,
                    loadAttachmentImage = viewModel::loadAttachmentImageBytes,
                    onSend = viewModel::sendChatMessage,
                    onStopAll = { viewModel.stopChat(null) },
                    onStopMessage = { id -> viewModel.stopChat(id) },
                    onNewChat = viewModel::startNewChat,
                    onOpenTask = { taskId ->
                        viewModel.openTaskDetail(taskId)
                        currentTab = MainTab.TASKS
                    },
                )

                MainTab.TASKS -> TasksScreen(
                    snapshot = state.snapshot,
                    groupByProject = state.groupTasksByProject,
                    selectedTaskId = state.selectedTaskId,
                    selectedTaskDetail = state.selectedTaskDetail,
                    isLoadingDetail = state.isLoadingTaskDetail,
                    actionInProgress = state.taskActionInProgress,
                    onToggleGroupByProject = viewModel::toggleGroupTasksByProject,
                    onOpenTask = viewModel::openTaskDetail,
                    onCloseTask = viewModel::closeTaskDetail,
                    onMarkDone = { id -> viewModel.updateTaskStatus(id, "done") },
                    onReopen = { id -> viewModel.updateTaskStatus(id, "needs_review") },
                    onStopTask = viewModel::stopTask,
                    onLandTask = { id -> viewModel.landTask(id, createPr = false) },
                    onMentionTaskInChat = { target ->
                        viewModel.addMention(target)
                        currentTab = MainTab.CHAT
                    },
                )

                MainTab.SETTINGS -> SettingsScreen(
                    config = state.config,
                    themeMode = state.themeMode,
                    transportState = state.transportState,
                    transportDetail = state.transportDetail,
                    snapshot = state.snapshot,
                    isTesting = state.isTestingConnection,
                    lastTestResult = state.lastTestResult,
                    onSelectThemeMode = viewModel::setThemeMode,
                    onOpenQrScanner = { showQrScanner = true },
                    onReconnect = viewModel::reconnect,
                    onTestConnection = viewModel::testConnection,
                    onSaveConfig = viewModel::saveAndConnect,
                    onDisconnect = viewModel::disconnect,
                )
            }
        }
    }
}
