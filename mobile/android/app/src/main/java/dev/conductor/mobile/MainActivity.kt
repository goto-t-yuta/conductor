package dev.conductor.mobile

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChatBubble
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import dev.conductor.mobile.ui.ConductorViewModel
import dev.conductor.mobile.ui.screens.ChatScreen
import dev.conductor.mobile.ui.screens.QrScannerScreen
import dev.conductor.mobile.ui.screens.SettingsScreen
import dev.conductor.mobile.ui.screens.SetupScreen
import dev.conductor.mobile.ui.screens.TasksScreen
import dev.conductor.mobile.ui.theme.ConductorTheme

private enum class MainTab(val label: String) {
    CHAT("Chat"),
    TASKS("Tasks"),
    SETTINGS("Settings"),
}

class MainActivity : ComponentActivity() {
    private val viewModel: ConductorViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handleIntent(intent)

        setContent {
            ConductorTheme {
                ConductorMobileApp(viewModel = viewModel)
            }
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
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        return
    }

    if (!state.config.isConfigured) {
        Scaffold(
            snackbarHost = { SnackbarHost(snackbarHostState) },
        ) { innerPadding ->
            Box(modifier = Modifier.padding(innerPadding)) {
                SetupScreen(
                    initialConfig = state.config,
                    pendingDeepLink = state.pendingDeepLinkConfig,
                    isTesting = state.isTestingConnection,
                    lastTestResult = state.lastTestResult,
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

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        bottomBar = {
            NavigationBar {
                NavigationBarItem(
                    selected = currentTab == MainTab.CHAT,
                    onClick = { currentTab = MainTab.CHAT },
                    icon = { Icon(Icons.Default.ChatBubble, contentDescription = "Chat") },
                    label = { Text(MainTab.CHAT.label) },
                )
                NavigationBarItem(
                    selected = currentTab == MainTab.TASKS,
                    onClick = { currentTab = MainTab.TASKS },
                    icon = {
                        BadgedBox(
                            badge = {
                                if (runningTaskCount > 0) {
                                    Badge { Text("$runningTaskCount") }
                                }
                            },
                        ) {
                            Icon(Icons.Default.Checklist, contentDescription = "Tasks")
                        }
                    },
                    label = { Text(MainTab.TASKS.label) },
                )
                NavigationBarItem(
                    selected = currentTab == MainTab.SETTINGS,
                    onClick = { currentTab = MainTab.SETTINGS },
                    icon = { Icon(Icons.Default.Settings, contentDescription = "Settings") },
                    label = { Text(MainTab.SETTINGS.label) },
                )
            }
        },
    ) { innerPadding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding),
        ) {
            when (currentTab) {
                MainTab.CHAT -> ChatScreen(
                    snapshot = state.snapshot,
                    transportState = state.transportState,
                    composerText = state.composerText,
                    selectedMentions = state.selectedMentions,
                    isSending = state.isSending,
                    onComposerTextChange = viewModel::updateComposerText,
                    onAddMention = viewModel::addMention,
                    onRemoveMention = viewModel::removeMention,
                    onSend = viewModel::sendChatMessage,
                    onStopAll = { viewModel.stopChat(null) },
                    onStopMessage = { id -> viewModel.stopChat(id) },
                    onNewChat = viewModel::startNewChat,
                )

                MainTab.TASKS -> TasksScreen(
                    snapshot = state.snapshot,
                    selectedTaskId = state.selectedTaskId,
                    selectedTaskDetail = state.selectedTaskDetail,
                    isLoadingDetail = state.isLoadingTaskDetail,
                    actionInProgress = state.taskActionInProgress,
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
                    transportState = state.transportState,
                    transportDetail = state.transportDetail,
                    snapshot = state.snapshot,
                    isTesting = state.isTestingConnection,
                    lastTestResult = state.lastTestResult,
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
