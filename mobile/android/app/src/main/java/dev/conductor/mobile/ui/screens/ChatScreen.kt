package dev.conductor.mobile.ui.screens

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.AddComment
import androidx.compose.material.icons.filled.AddPhotoAlternate
import androidx.compose.material.icons.filled.AlternateEmail
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.WarningAmber
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
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
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import dev.conductor.mobile.data.AndroidImageAttachmentProcessor
import dev.conductor.mobile.data.ImageAttachmentLogic
import dev.conductor.mobile.model.ActiveMentionMode
import dev.conductor.mobile.model.ActiveMentionQuery
import dev.conductor.mobile.model.AgentTask
import dev.conductor.mobile.model.AppSnapshot
import dev.conductor.mobile.model.ChatAttachment
import dev.conductor.mobile.model.ChatMessage
import dev.conductor.mobile.model.DraftMentionChip
import dev.conductor.mobile.model.ExplicitMentionTarget
import dev.conductor.mobile.model.MentionAutocomplete
import dev.conductor.mobile.model.MentionSuggestion
import dev.conductor.mobile.model.PendingImageAttachment
import dev.conductor.mobile.model.Project
import dev.conductor.mobile.model.StreamTransportState
import dev.conductor.mobile.model.ToolActivityChip
import dev.conductor.mobile.ui.components.ConductorCard
import dev.conductor.mobile.ui.components.ConductorMarkdown
import dev.conductor.mobile.ui.components.MarkdownVariant
import dev.conductor.mobile.ui.components.MentionBadgeChip
import dev.conductor.mobile.ui.components.ProjectPill
import dev.conductor.mobile.ui.components.TaskCodeBadge
import dev.conductor.mobile.ui.components.TaskStatusBadge
import dev.conductor.mobile.ui.components.TaskStatusIcon
import dev.conductor.mobile.ui.components.formatProviderLabel
import dev.conductor.mobile.ui.components.parseConductorHexColor
import dev.conductor.mobile.ui.components.transportStatusColor
import dev.conductor.mobile.ui.theme.ConductorTheme

private data class PreviewImageRequest(
    val label: String,
    val bytes: ByteArray,
)

private data class ChatScrollObservation(
    val metrics: ChatScrollMetrics,
    val messageCount: Int,
    val isUserScrolling: Boolean,
    val isAnimatingScrollToBottom: Boolean,
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    snapshot: AppSnapshot?,
    transportState: StreamTransportState,
    composerText: String,
    selectedMentions: List<ExplicitMentionTarget>,
    pendingAttachments: List<PendingImageAttachment>,
    isProcessingImages: Boolean,
    isSending: Boolean,
    onComposerTextChange: (String) -> Unit,
    onAddMention: (ExplicitMentionTarget) -> Unit,
    onRemoveMention: (ExplicitMentionTarget) -> Unit,
    onPickImageUris: (List<Uri>) -> Unit,
    onRemoveAttachment: (String) -> Unit,
    getCachedAttachmentImage: (String) -> ByteArray?,
    loadAttachmentImage: suspend (String) -> ByteArray?,
    onSend: () -> Unit,
    onStopAll: () -> Unit,
    onStopMessage: (String) -> Unit,
    onNewChat: () -> Unit,
    onOpenTask: (String) -> Unit,
    listState: LazyListState = rememberLazyListState(),
    scrollSessionState: ChatScrollSessionState = rememberChatScrollSessionState(),
) {
    val colors = ConductorTheme.colors
    val messages = snapshot?.messages.orEmpty()
    val projects = snapshot?.projects.orEmpty()
    val tasks = snapshot?.tasks.orEmpty()
    val tasksById = remember(tasks) { tasks.associateBy { it.id } }
    val projectsById = remember(projects) { projects.associateBy { it.id } }
    val activeResponders = snapshot?.activeResponderCount ?: 0
    val coroutineScope = rememberCoroutineScope()
    var showMentionSheet by remember { mutableStateOf(false) }
    var previewImage by remember { mutableStateOf<PreviewImageRequest?>(null) }
    var isScrollingToBottom by remember { mutableStateOf(false) }
    var isProgrammaticScrolling by remember { mutableStateOf(false) }
    var hasHandledInitialCompositionEffect by remember { mutableStateOf(false) }

    // Synchronize cursor-aware TextFieldValue with hoisted composerText
    var composerValue by remember {
        mutableStateOf(
            TextFieldValue(
                text = composerText,
                selection = TextRange(composerText.length),
            ),
        )
    }
    var lastKnownExternalText by remember { mutableStateOf(composerText) }
    if (composerText != lastKnownExternalText) {
        lastKnownExternalText = composerText
        if (composerValue.text != composerText) {
            composerValue = TextFieldValue(
                text = composerText,
                selection = TextRange(composerText.length),
            )
        }
    }

    var dismissedMentionKey by remember { mutableStateOf<String?>(null) }
    val activeMention = remember(composerValue.text, composerValue.selection) {
        if (!composerValue.text.contains('@')) {
            null
        } else {
            MentionAutocomplete.detectActiveMention(
                text = composerValue.text,
                caretIndex = composerValue.selection.end,
            )
        }
    }
    val mentionSuggestionsResult = remember(activeMention, projects, tasks) {
        if (activeMention == null) {
            null
        } else {
            MentionAutocomplete.getMentionSuggestions(activeMention, projects, tasks)
        }
    }
    val mentionSuggestions = mentionSuggestionsResult?.suggestions.orEmpty()
    val scopedMentionProject = mentionSuggestionsResult?.scopedProject
    val showMentionAutocomplete = activeMention != null &&
        activeMention.key != dismissedMentionKey &&
        (mentionSuggestions.isNotEmpty() || activeMention.mode == ActiveMentionMode.PROJECT_TASKS)

    val draftMentionChips = remember(composerValue.text, projects, tasks, selectedMentions) {
        MentionAutocomplete.extractDraftMentionChips(
            text = composerValue.text,
            projects = projects,
            tasks = tasks,
            selectedMentions = selectedMentions,
        )
    }

    val handleComposerValueChange: (TextFieldValue) -> Unit = { nextValue ->
        val textChanged = nextValue.text != composerValue.text
        composerValue = nextValue
        if (textChanged) {
            dismissedMentionKey = null
            lastKnownExternalText = nextValue.text
            onComposerTextChange(nextValue.text)
        }
    }

    val handleSelectMentionSuggestion: (MentionSuggestion) -> Unit = { suggestion ->
        val currentQuery = activeMention
        if (currentQuery != null) {
            onAddMention(MentionAutocomplete.suggestionToExplicitMentionTarget(suggestion))
            val edit = MentionAutocomplete.removeActiveMentionQuery(composerValue.text, currentQuery)
            val postMention = MentionAutocomplete.detectActiveMention(edit.nextText, edit.nextCaret)
            dismissedMentionKey = postMention?.key
            composerValue = TextFieldValue(
                text = edit.nextText,
                selection = TextRange(edit.nextCaret),
                composition = null,
            )
            lastKnownExternalText = edit.nextText
            onComposerTextChange(edit.nextText)
        }
    }

    val handleScopeProjectTasks: (Project) -> Unit = { project ->
        val currentQuery = activeMention
        if (currentQuery != null) {
            val edit = MentionAutocomplete.applyProjectTaskScope(
                text = composerValue.text,
                query = currentQuery,
                projectName = project.name,
            )
            dismissedMentionKey = null
            composerValue = TextFieldValue(
                text = edit.nextText,
                selection = TextRange(edit.nextCaret),
                composition = null,
            )
            lastKnownExternalText = edit.nextText
            onComposerTextChange(edit.nextText)
        }
    }

    val handleRemoveDraftChip: (DraftMentionChip) -> Unit = { chip ->
        onRemoveMention(chip.removalTarget)
        val edit = MentionAutocomplete.removeResolvedInlineMentions(
            text = composerValue.text,
            target = chip.removalTarget,
            projects = projects,
            tasks = tasks,
            caretPos = composerValue.selection.end,
        )
        dismissedMentionKey = null
        if (edit.removedCount > 0) {
            composerValue = TextFieldValue(
                text = edit.nextText,
                selection = TextRange(edit.nextCaret),
                composition = null,
            )
            lastKnownExternalText = edit.nextText
            onComposerTextChange(edit.nextText)
        }
    }

    val fallbackDocPickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenMultipleDocuments(),
    ) { uris ->
        if (uris.isNotEmpty()) {
            onPickImageUris(uris)
        }
    }

    val photoPickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.PickMultipleVisualMedia(ImageAttachmentLogic.MAX_ATTACHMENTS),
    ) { uris ->
        if (uris.isNotEmpty()) {
            onPickImageUris(uris)
        }
    }

    val launchImagePicker: () -> Unit = {
        val launched = runCatching {
            photoPickerLauncher.launch(
                PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
            )
        }.isSuccess
        if (!launched) {
            runCatching {
                fallbackDocPickerLauncher.launch(arrayOf("image/*"))
            }
        }
    }

    val density = LocalDensity.current
    val bottomThresholdPx = remember(density) {
        with(density) { ChatScrollLogic.BOTTOM_THRESHOLD_DP.dp.roundToPx() }
    }
    val latestMessageCount by rememberUpdatedState(messages.size)
    val showScrollToBottom by remember(listState, bottomThresholdPx) {
        derivedStateOf {
            ChatScrollLogic.shouldShowScrollToBottomButton(
                metrics = listState.toChatScrollMetrics(),
                messageCount = latestMessageCount,
                isScrollingToBottom = isScrollingToBottom,
                thresholdPx = bottomThresholdPx,
            )
        }
    }

    LaunchedEffect(listState, bottomThresholdPx, scrollSessionState) {
        var wasUserScrolling = false
        snapshotFlow {
            val metrics = listState.toChatScrollMetrics()
            val userScrolling = listState.isScrollInProgress &&
                !isProgrammaticScrolling &&
                !isScrollingToBottom
            ChatScrollObservation(
                metrics = metrics,
                messageCount = latestMessageCount,
                isUserScrolling = userScrolling,
                isAnimatingScrollToBottom = isScrollingToBottom,
            )
        }
            .distinctUntilChanged()
            .collect { obs ->
                val nextPinned = ChatScrollLogic.resolvePinnedToBottomAfterScroll(
                    currentPinned = scrollSessionState.snapshot.isPinnedToBottom,
                    metrics = obs.metrics,
                    messageCount = obs.messageCount,
                    thresholdPx = bottomThresholdPx,
                    isUserScrolling = obs.isUserScrolling,
                    wasUserScrolling = wasUserScrolling,
                    isAnimatingScrollToBottom = obs.isAnimatingScrollToBottom,
                )
                wasUserScrolling = obs.isUserScrolling
                scrollSessionState.updatePinnedToBottom(nextPinned)
            }
    }

    val lastMessage = messages.lastOrNull()
    val lastMessageFingerprint = ChatScrollLogic.buildMessageContentFingerprint(lastMessage)
    val timelineSnapshot = remember(
        snapshot?.activeChatSessionId,
        messages.size,
        messages.firstOrNull()?.id,
        lastMessage?.id,
        lastMessage?.role,
        lastMessageFingerprint,
    ) {
        ChatTimelineSnapshot(
            sessionId = snapshot?.activeChatSessionId.orEmpty(),
            messageCount = messages.size,
            firstMessageId = messages.firstOrNull()?.id,
            lastMessageId = lastMessage?.id,
            lastMessageRole = lastMessage?.role,
            lastMessageContentFingerprint = lastMessageFingerprint,
        )
    }

    LaunchedEffect(timelineSnapshot, scrollSessionState) {
        val isCompositionEntry = !hasHandledInitialCompositionEffect
        hasHandledInitialCompositionEffect = true
        if (timelineSnapshot.messageCount <= 0) {
            isScrollingToBottom = false
        }
        val userScrolling = listState.isScrollInProgress &&
            !isProgrammaticScrolling &&
            !isScrollingToBottom
        val resolution = ChatScrollLogic.resolveScrollOnTimelineUpdate(
            previous = scrollSessionState.snapshot,
            current = timelineSnapshot,
            isCompositionEntry = isCompositionEntry,
            isUserScrolling = userScrolling,
            isAnimatingScrollToBottom = isScrollingToBottom,
        )
        scrollSessionState.apply(resolution.nextSession)
        if (resolution.shouldScrollToBottom && timelineSnapshot.messageCount > 0) {
            isProgrammaticScrolling = true
            try {
                listState.scrollToItem(timelineSnapshot.messageCount)
            } finally {
                isProgrammaticScrolling = false
            }
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(colors.canvas)
            .imePadding(),
    ) {
        // Desktop-aligned flat header: status dot + Conductor brand + provider pill + actions
        ChatHeaderBar(
            snapshot = snapshot,
            transportState = transportState,
            activeResponders = activeResponders,
            onStopAll = onStopAll,
            onNewChat = onNewChat,
        )

        // Error banner (if desktop reported one)
        val errorBanner = snapshot?.lastErrorBanner
        if (!errorBanner.isNullOrBlank()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(colors.roseBg)
                    .padding(horizontal = 14.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(
                    imageVector = Icons.Default.WarningAmber,
                    contentDescription = null,
                    tint = colors.rose,
                    modifier = Modifier.size(16.dp),
                )
                Text(
                    text = errorBanner,
                    fontSize = 12.sp,
                    color = colors.roseText,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
            }
            HorizontalDivider(thickness = 1.dp, color = colors.roseBorder)
        }

        // Message stream or welcome empty state, with floating scroll-to-bottom button
        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
        ) {
            if (messages.isEmpty()) {
                EmptyChatWelcome(
                    isSyncing = snapshot == null,
                    projectCount = projects.size,
                    modifier = Modifier.fillMaxSize(),
                )
            } else {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(start = 16.dp, top = 16.dp, end = 16.dp, bottom = 0.dp),
                    verticalArrangement = Arrangement.spacedBy(18.dp),
                ) {
                    items(messages, key = { it.id }) { msg ->
                        val linkedTask = msg.relatedTaskId?.let { tasksById[it] }
                        val linkedProject = linkedTask?.projectId?.let { projectsById[it] }
                        ChatMessageRow(
                            message = msg,
                            linkedTask = linkedTask,
                            linkedProjectColorHex = linkedProject?.colorHex,
                            getCachedAttachmentImage = getCachedAttachmentImage,
                            loadAttachmentImage = loadAttachmentImage,
                            onPreviewImage = { label, bytes ->
                                previewImage = PreviewImageRequest(label = label, bytes = bytes)
                            },
                            onStop = { onStopMessage(msg.id) },
                            onOpenTask = onOpenTask,
                        )
                    }
                    // Bottom anchor ensures animateScrollToItem reaches the very end even for tall messages
                    item(key = CHAT_BOTTOM_ANCHOR_KEY) {
                        Spacer(modifier = Modifier.height(1.dp))
                    }
                }
            }

            ScrollToBottomFloatingButton(
                visible = showScrollToBottom && !showMentionAutocomplete,
                onClick = {
                    val targetIndex = messages.size
                    if (targetIndex <= 0) return@ScrollToBottomFloatingButton
                    coroutineScope.launch {
                        isScrollingToBottom = true
                        try {
                            listState.animateScrollToItem(targetIndex)
                            scrollSessionState.updatePinnedToBottom(true)
                        } finally {
                            isScrollingToBottom = false
                        }
                    }
                },
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = 12.dp),
            )

            // Floating @mention autocomplete list directly above the composer (never occluded by IME)
            androidx.compose.animation.AnimatedVisibility(
                visible = showMentionAutocomplete,
                enter = fadeIn(animationSpec = tween(durationMillis = 120)) +
                    slideInVertically(animationSpec = tween(durationMillis = 140)) { it / 6 },
                exit = fadeOut(animationSpec = tween(durationMillis = 100)),
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp, vertical = 6.dp),
            ) {
                activeMention?.let { query ->
                    MentionAutocompletePopup(
                        query = query,
                        suggestions = mentionSuggestions,
                        scopedProject = scopedMentionProject,
                        onSelectSuggestion = handleSelectMentionSuggestion,
                        onScopeProjectTasks = handleScopeProjectTasks,
                        onDismiss = { dismissedMentionKey = query.key },
                    )
                }
            }
        }

        // Desktop-aligned floating rounded composer
        ChatComposerBar(
            composerValue = composerValue,
            draftMentionChips = draftMentionChips,
            pendingAttachments = pendingAttachments,
            isProcessingImages = isProcessingImages,
            isSending = isSending,
            onComposerValueChange = handleComposerValueChange,
            onOpenMentionPicker = { showMentionSheet = true },
            onRemoveDraftChip = handleRemoveDraftChip,
            onOpenImagePicker = launchImagePicker,
            onRemoveAttachment = onRemoveAttachment,
            onPreviewPendingAttachment = { att ->
                previewImage = PreviewImageRequest(label = att.label, bytes = att.previewBytes)
            },
            onSend = {
                dismissedMentionKey = null
                if (composerValue.text.isNotBlank() || pendingAttachments.isNotEmpty()) {
                    scrollSessionState.updatePinnedToBottom(true)
                }
                onSend()
            },
        )
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

    previewImage?.let { request ->
        ImagePreviewDialog(
            label = request.label,
            imageBytes = request.bytes,
            onDismiss = { previewImage = null },
        )
    }
}

@Composable
private fun ChatHeaderBar(
    snapshot: AppSnapshot?,
    transportState: StreamTransportState,
    activeResponders: Int,
    onStopAll: () -> Unit,
    onNewChat: () -> Unit,
) {
    val colors = ConductorTheme.colors
    Column(modifier = Modifier.background(colors.canvas)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(8.dp)
                    .clip(CircleShape)
                    .background(transportStatusColor(transportState)),
            )

            Text(
                text = "Conductor",
                fontSize = 15.sp,
                fontWeight = FontWeight.SemiBold,
                color = colors.textPrimary,
                maxLines = 1,
            )

            // Provider & transport status pill
            val transportLabel = when (transportState) {
                StreamTransportState.CONNECTED_SSE -> "Live"
                StreamTransportState.CONNECTED_POLLING -> "Polling"
                StreamTransportState.CONNECTING -> "接続中"
                StreamTransportState.ERROR -> "エラー"
                StreamTransportState.DISCONNECTED -> "未接続"
            }
            val providerLabel = snapshot?.chatProvider?.let { formatProviderLabel(it) }
            Surface(
                color = colors.surfaceSubtle,
                shape = RoundedCornerShape(99.dp),
                border = BorderStroke(1.dp, colors.borderSubtle),
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Icon(
                        imageVector = Icons.Default.Bolt,
                        contentDescription = null,
                        tint = colors.amber,
                        modifier = Modifier.size(12.dp),
                    )
                    if (providerLabel != null) {
                        Text(
                            text = providerLabel,
                            fontSize = 11.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = colors.indigoText,
                            maxLines = 1,
                        )
                        Text(
                            text = "·",
                            fontSize = 11.sp,
                            color = colors.textSubtle,
                        )
                    }
                    Text(
                        text = transportLabel,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Medium,
                        color = colors.textMuted,
                        maxLines = 1,
                    )
                }
            }

            Spacer(modifier = Modifier.weight(1f))

            if (activeResponders > 0) {
                Surface(
                    color = colors.indigoBg,
                    shape = RoundedCornerShape(99.dp),
                    border = BorderStroke(1.dp, colors.indigoBorder),
                ) {
                    Row(
                        modifier = Modifier
                            .clickable(onClick = onStopAll)
                            .padding(horizontal = 8.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(5.dp),
                    ) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(11.dp),
                            strokeWidth = 1.6.dp,
                            color = colors.indigo,
                        )
                        Text(
                            text = "${activeResponders}件",
                            fontSize = 11.sp,
                            fontWeight = FontWeight.Medium,
                            color = colors.indigoText,
                        )
                        Text(
                            text = "停止",
                            fontSize = 11.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = colors.roseText,
                        )
                    }
                }
            }

            IconButton(
                onClick = onNewChat,
                modifier = Modifier.size(34.dp),
            ) {
                Icon(
                    imageVector = Icons.Default.AddComment,
                    contentDescription = "新しいチャット",
                    tint = colors.textMuted,
                    modifier = Modifier.size(19.dp),
                )
            }
        }
        HorizontalDivider(thickness = 1.dp, color = colors.borderSubtle)
    }
}

@Composable
private fun EmptyChatWelcome(
    isSyncing: Boolean,
    projectCount: Int,
    modifier: Modifier = Modifier,
) {
    val colors = ConductorTheme.colors
    Box(
        modifier = modifier.padding(horizontal = 28.dp),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(54.dp)
                    .clip(RoundedCornerShape(16.dp))
                    .background(colors.indigoBg)
                    .border(1.dp, colors.indigoBorder, RoundedCornerShape(16.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = Icons.Default.AutoAwesome,
                    contentDescription = null,
                    tint = colors.indigo,
                    modifier = Modifier.size(26.dp),
                )
            }

            Text(
                text = if (isSyncing) "サーバーと同期中..." else "Conductor へようこそ",
                fontSize = 19.sp,
                fontWeight = FontWeight.SemiBold,
                color = colors.textPrimary,
                textAlign = TextAlign.Center,
            )

            Text(
                text = "複数のリポジトリやタスクを横断して指示できます。入力欄で @ を入力するか、下の @ ボタンからプロジェクトや T# タスクを指定できます。",
                fontSize = 13.sp,
                lineHeight = 20.sp,
                color = colors.textMuted,
                textAlign = TextAlign.Center,
            )

            if (!isSyncing) {
                Surface(
                    color = colors.surfaceSubtle,
                    shape = RoundedCornerShape(99.dp),
                    border = BorderStroke(1.dp, colors.borderSubtle),
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 5.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Box(
                            modifier = Modifier
                                .size(7.dp)
                                .clip(CircleShape)
                                .background(colors.emerald),
                        )
                        Text(
                            text = if (projectCount > 0) {
                                "${projectCount} 件のプロジェクトを接続中"
                            } else {
                                "プロジェクトをスキャン中..."
                            },
                            fontSize = 11.5.sp,
                            fontWeight = FontWeight.Medium,
                            color = colors.textSecondary,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ChatMessageRow(
    message: ChatMessage,
    linkedTask: AgentTask?,
    linkedProjectColorHex: String?,
    getCachedAttachmentImage: (String) -> ByteArray?,
    loadAttachmentImage: suspend (String) -> ByteArray?,
    onPreviewImage: (label: String, bytes: ByteArray) -> Unit,
    onStop: () -> Unit,
    onOpenTask: (String) -> Unit,
) {
    when (message.role) {
        "user" -> UserMessageItem(
            message = message,
            getCachedAttachmentImage = getCachedAttachmentImage,
            loadAttachmentImage = loadAttachmentImage,
            onPreviewImage = onPreviewImage,
        )
        "taskEvent" -> TaskEventCard(
            message = message,
            linkedTask = linkedTask,
            projectColorHex = linkedProjectColorHex,
            onOpenTask = onOpenTask,
        )

        "system" -> SystemMessageItem(message = message)
        else -> AssistantMessageItem(
            message = message,
            basePath = linkedTask?.worktreePath ?: linkedTask?.projectPath,
            onStop = onStop,
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun UserMessageItem(
    message: ChatMessage,
    getCachedAttachmentImage: (String) -> ByteArray?,
    loadAttachmentImage: suspend (String) -> ByteArray?,
    onPreviewImage: (label: String, bytes: ByteArray) -> Unit,
) {
    val colors = ConductorTheme.colors
    val allMentions = remember(message.mentions, message.inferredMentions) {
        (message.mentions + message.inferredMentions).distinctBy {
            "${it.kind}:${it.taskId ?: it.projectId ?: it.projectName}:${it.taskNumber}"
        }
    }
    val imageAttachments = remember(message.attachments) {
        message.attachments.filter { it.kind == "image" }
    }
    val otherAttachments = remember(message.attachments) {
        message.attachments.filter { it.kind != "image" }
    }

    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.End,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (allMentions.isNotEmpty() || otherAttachments.isNotEmpty()) {
            FlowRow(
                modifier = Modifier.widthIn(max = 320.dp),
                horizontalArrangement = Arrangement.spacedBy(5.dp, Alignment.End),
                verticalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                allMentions.forEach { ref ->
                    MentionBadgeChip(mention = ref)
                }
                otherAttachments.forEach { att ->
                    Surface(
                        color = colors.surfaceSubtle,
                        shape = RoundedCornerShape(8.dp),
                        border = BorderStroke(1.dp, colors.border),
                    ) {
                        Text(
                            text = att.label.ifBlank { att.kind },
                            fontSize = 11.sp,
                            color = colors.textSecondary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                        )
                    }
                }
            }
        }

        if (imageAttachments.isNotEmpty()) {
            FlowRow(
                modifier = Modifier.widthIn(max = 316.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                val single = imageAttachments.size == 1
                imageAttachments.forEach { att ->
                    RemoteAttachmentImageCard(
                        attachment = att,
                        isSingle = single,
                        getCachedAttachmentImage = getCachedAttachmentImage,
                        loadAttachmentImage = loadAttachmentImage,
                        onPreviewImage = onPreviewImage,
                    )
                }
            }
        }

        if (message.text.isNotBlank()) {
            // Desktop-aligned soft indigo tinted user bubble (bg-indigo-500/12 dark:bg-indigo-500/20)
            Surface(
                color = colors.userBubbleBg,
                shape = RoundedCornerShape(16.dp),
                border = BorderStroke(1.dp, colors.userBubbleBorder),
                modifier = Modifier.widthIn(max = 316.dp),
            ) {
                ConductorMarkdown(
                    markdown = message.text,
                    variant = MarkdownVariant.USER_BUBBLE,
                    textColor = colors.textPrimary,
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                )
            }
        }
    }
}

@Composable
private fun RemoteAttachmentImageCard(
    attachment: ChatAttachment,
    isSingle: Boolean,
    getCachedAttachmentImage: (String) -> ByteArray?,
    loadAttachmentImage: suspend (String) -> ByteArray?,
    onPreviewImage: (label: String, bytes: ByteArray) -> Unit,
) {
    val colors = ConductorTheme.colors
    val label = attachment.label.ifBlank { "Image" }
    var imageBytes by remember(attachment.id) { mutableStateOf(getCachedAttachmentImage(attachment.id)) }
    var bitmap by remember(attachment.id) { mutableStateOf<ImageBitmap?>(null) }
    var isLoading by remember(attachment.id) { mutableStateOf(imageBytes == null && attachment.id.isNotBlank()) }

    LaunchedEffect(attachment.id) {
        val current = imageBytes ?: run {
            if (attachment.id.isBlank()) {
                isLoading = false
                return@LaunchedEffect
            }
            isLoading = true
            val fetched = loadAttachmentImage(attachment.id)
            imageBytes = fetched
            isLoading = false
            fetched
        }
        if (current != null && bitmap == null) {
            val decoded = withContext(Dispatchers.Default) {
                AndroidImageAttachmentProcessor.decodeBitmapSafe(current, 512)?.asImageBitmap()
            }
            bitmap = decoded
        }
    }

    val cardWidth = if (isSingle) 172.dp else 104.dp
    val imageHeight = if (isSingle) 124.dp else 88.dp

    Surface(
        color = colors.surfaceSubtle,
        shape = RoundedCornerShape(12.dp),
        border = BorderStroke(1.dp, colors.border),
        modifier = Modifier
            .width(cardWidth)
            .clip(RoundedCornerShape(12.dp))
            .clickable(enabled = imageBytes != null) {
                imageBytes?.let { bytes -> onPreviewImage(label, bytes) }
            },
    ) {
        Column {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(imageHeight)
                    .background(colors.surfaceSecondary),
                contentAlignment = Alignment.Center,
            ) {
                val rendered = bitmap
                when {
                    rendered != null -> {
                        Image(
                            bitmap = rendered,
                            contentDescription = label,
                            contentScale = ContentScale.Crop,
                            modifier = Modifier.fillMaxSize(),
                        )
                    }

                    isLoading -> {
                        CircularProgressIndicator(
                            modifier = Modifier.size(18.dp),
                            strokeWidth = 2.dp,
                            color = colors.indigo,
                        )
                    }

                    else -> {
                        Icon(
                            imageVector = Icons.Default.Image,
                            contentDescription = label,
                            tint = colors.textSubtle,
                            modifier = Modifier.size(24.dp),
                        )
                    }
                }
            }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 7.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Icon(
                    imageVector = Icons.Default.Image,
                    contentDescription = null,
                    tint = colors.indigoText,
                    modifier = Modifier.size(11.dp),
                )
                Text(
                    text = label,
                    fontSize = 10.5.sp,
                    color = colors.textSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AssistantMessageItem(
    message: ChatMessage,
    basePath: String? = null,
    onStop: () -> Unit,
) {
    val colors = ConductorTheme.colors
    var showReasoning by remember(message.id) { mutableStateOf(false) }
    var expandTools by remember(message.id) { mutableStateOf(false) }

    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        // Desktop-aligned Conductor avatar mark + provider tag + streaming controls
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(22.dp)
                    .clip(RoundedCornerShape(6.dp))
                    .background(colors.indigoBg),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = Icons.Default.AutoAwesome,
                    contentDescription = null,
                    tint = colors.indigo,
                    modifier = Modifier.size(13.dp),
                )
            }

            Text(
                text = "Conductor",
                fontSize = 12.5.sp,
                fontWeight = FontWeight.SemiBold,
                color = colors.textSecondary,
            )

            if (!message.provider.isNullOrBlank()) {
                Text(
                    text = "· ${formatProviderLabel(message.provider)}",
                    fontSize = 12.sp,
                    color = colors.textSubtle,
                )
            }

            if (message.isStreaming) {
                CircularProgressIndicator(
                    modifier = Modifier.size(12.dp),
                    strokeWidth = 1.6.dp,
                    color = colors.indigo,
                )
                Spacer(modifier = Modifier.weight(1f))
                Surface(
                    color = colors.roseBg,
                    shape = RoundedCornerShape(6.dp),
                    border = BorderStroke(1.dp, colors.roseBorder),
                    modifier = Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .clickable(onClick = onStop),
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Icon(
                            imageVector = Icons.Default.Stop,
                            contentDescription = "停止",
                            tint = colors.rose,
                            modifier = Modifier.size(11.dp),
                        )
                        Text(
                            text = "停止",
                            fontSize = 11.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = colors.roseText,
                        )
                    }
                }
            }
        }

        // Collapsible reasoning summary (desktop parity)
        if (!message.reasoningSummary.isNullOrBlank()) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(
                    modifier = Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .clickable { showReasoning = !showReasoning }
                        .padding(vertical = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Icon(
                        imageVector = if (showReasoning) Icons.Default.ExpandMore else Icons.Default.ChevronRight,
                        contentDescription = null,
                        tint = colors.textSubtle,
                        modifier = Modifier.size(14.dp),
                    )
                    Text(
                        text = "思考プロセス",
                        fontSize = 11.5.sp,
                        fontWeight = FontWeight.Medium,
                        color = colors.textMuted,
                    )
                }
                if (showReasoning) {
                    Surface(
                        color = colors.surfaceSecondary,
                        shape = RoundedCornerShape(10.dp),
                        border = BorderStroke(1.dp, colors.borderSubtle),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(
                            text = message.reasoningSummary,
                            fontSize = 12.sp,
                            lineHeight = 18.sp,
                            color = colors.textMuted,
                            modifier = Modifier.padding(10.dp),
                        )
                    }
                }
            }
        }

        // Tool activity chips (collapsible summary when > 3 chips)
        if (message.toolChips.isNotEmpty()) {
            val collapsible = !message.isStreaming && message.toolChips.size > 3
            val displayedChips = if (collapsible && !expandTools) {
                message.toolChips.takeLast(2)
            } else {
                message.toolChips
            }
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                if (collapsible) {
                    val hiddenCount = message.toolChips.size - 2
                    Surface(
                        color = colors.surfaceSubtle,
                        shape = RoundedCornerShape(99.dp),
                        border = BorderStroke(1.dp, colors.border),
                        modifier = Modifier
                            .clip(RoundedCornerShape(99.dp))
                            .clickable { expandTools = !expandTools },
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 9.dp, vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            Icon(
                                imageVector = Icons.Default.CheckCircle,
                                contentDescription = null,
                                tint = colors.emerald,
                                modifier = Modifier.size(12.dp),
                            )
                            Text(
                                text = if (expandTools) "ツール履歴を折りたたむ" else "+${hiddenCount}件のツール実行",
                                fontSize = 11.sp,
                                fontWeight = FontWeight.Medium,
                                color = colors.textSecondary,
                            )
                        }
                    }
                }
                displayedChips.forEach { chip ->
                    ToolActivityPill(chip = chip)
                }
            }
        }

        // Rich Markdown body
        if (message.text.isNotBlank()) {
            ConductorMarkdown(
                markdown = message.text,
                variant = MarkdownVariant.DEFAULT,
                textColor = colors.textPrimary,
                basePath = basePath,
                modifier = Modifier.fillMaxWidth(),
            )
        } else if (message.isStreaming) {
            Text(
                text = "応答を準備中...",
                fontSize = 13.sp,
                color = colors.textSubtle,
            )
        }
    }
}

@Composable
private fun ToolActivityPill(chip: ToolActivityChip) {
    val colors = ConductorTheme.colors
    Surface(
        color = colors.surfaceSubtle,
        shape = RoundedCornerShape(99.dp),
        border = BorderStroke(1.dp, colors.borderSubtle),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 9.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            when {
                chip.isError -> Icon(
                    imageVector = Icons.Default.Cancel,
                    contentDescription = null,
                    tint = colors.rose,
                    modifier = Modifier.size(12.dp),
                )

                chip.isCompleted -> Icon(
                    imageVector = Icons.Default.CheckCircle,
                    contentDescription = null,
                    tint = colors.emerald,
                    modifier = Modifier.size(12.dp),
                )

                else -> CircularProgressIndicator(
                    modifier = Modifier.size(11.dp),
                    strokeWidth = 1.6.dp,
                    color = colors.indigo,
                )
            }
            Text(
                text = chip.label,
                fontSize = 11.sp,
                fontWeight = FontWeight.Medium,
                color = colors.textSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun TaskEventCard(
    message: ChatMessage,
    linkedTask: AgentTask?,
    projectColorHex: String?,
    onOpenTask: (String) -> Unit,
) {
    val colors = ConductorTheme.colors
    val isDone = linkedTask?.status == "done"
    val borderColor = if (isDone) colors.emeraldBorder else colors.indigoBorder
    val bgColor = if (isDone) {
        colors.emerald.copy(alpha = if (colors.isDark) 0.08f else 0.05f)
    } else {
        colors.indigo.copy(alpha = if (colors.isDark) 0.10f else 0.06f)
    }
    val dividerColor = if (isDone) colors.emerald.copy(alpha = 0.18f) else colors.indigo.copy(alpha = 0.18f)
    val targetTaskId = linkedTask?.id ?: message.relatedTaskId

    Surface(
        color = bgColor,
        shape = RoundedCornerShape(14.dp),
        border = BorderStroke(1.dp, borderColor),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(13.dp),
            verticalArrangement = Arrangement.spacedBy(9.dp),
        ) {
            // Task event header
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Icon(
                    imageVector = Icons.Default.Notifications,
                    contentDescription = null,
                    tint = if (isDone) colors.emerald else colors.indigo,
                    modifier = Modifier.size(15.dp),
                )
                if (linkedTask != null) {
                    TaskCodeBadge(taskNumber = linkedTask.taskNumber)
                    Text(
                        text = linkedTask.title,
                        fontSize = 12.5.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = colors.textPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    TaskStatusBadge(status = linkedTask.status)
                } else {
                    Text(
                        text = "タスク通知",
                        fontSize = 12.5.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = colors.textPrimary,
                        modifier = Modifier.weight(1f),
                    )
                }
            }

            if (linkedTask != null) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    ProjectPill(name = linkedTask.projectName, colorHex = projectColorHex)
                    if (linkedTask.isUnlandedWorktree && linkedTask.status != "running") {
                        Surface(
                            color = colors.amberBg,
                            shape = RoundedCornerShape(99.dp),
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

            HorizontalDivider(thickness = 1.dp, color = dividerColor)

            ConductorMarkdown(
                markdown = message.text,
                variant = MarkdownVariant.COMPACT,
                textColor = colors.textPrimary,
                basePath = linkedTask?.worktreePath ?: linkedTask?.projectPath,
            )

            if (targetTaskId != null) {
                Surface(
                    color = colors.card,
                    shape = RoundedCornerShape(8.dp),
                    border = BorderStroke(1.dp, colors.border),
                    modifier = Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .clickable { onOpenTask(targetTaskId) },
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        if (linkedTask != null) {
                            Text(
                                text = "T${linkedTask.taskNumber}",
                                fontFamily = FontFamily.Monospace,
                                fontSize = 11.sp,
                                fontWeight = FontWeight.SemiBold,
                                color = colors.indigoText,
                            )
                        }
                        Text(
                            text = "タスク詳細を開く",
                            fontSize = 11.5.sp,
                            fontWeight = FontWeight.Medium,
                            color = colors.textPrimary,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun SystemMessageItem(message: ChatMessage) {
    val colors = ConductorTheme.colors
    Box(
        modifier = Modifier.fillMaxWidth(),
        contentAlignment = Alignment.Center,
    ) {
        Surface(
            color = colors.surfaceSecondary,
            shape = RoundedCornerShape(10.dp),
            border = BorderStroke(1.dp, colors.borderSubtle),
        ) {
            ConductorMarkdown(
                markdown = message.text,
                variant = MarkdownVariant.COMPACT,
                textColor = colors.textMuted,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 7.dp),
            )
        }
    }
}

@Composable
private fun ChatComposerBar(
    composerValue: TextFieldValue,
    draftMentionChips: List<DraftMentionChip>,
    pendingAttachments: List<PendingImageAttachment>,
    isProcessingImages: Boolean,
    isSending: Boolean,
    onComposerValueChange: (TextFieldValue) -> Unit,
    onOpenMentionPicker: () -> Unit,
    onRemoveDraftChip: (DraftMentionChip) -> Unit,
    onOpenImagePicker: () -> Unit,
    onRemoveAttachment: (String) -> Unit,
    onPreviewPendingAttachment: (PendingImageAttachment) -> Unit,
    onSend: () -> Unit,
) {
    val colors = ConductorTheme.colors
    var isFocused by remember { mutableStateOf(false) }
    val composerText = composerValue.text
    val canSend = (composerText.isNotBlank() || pendingAttachments.isNotEmpty()) &&
        !isSending &&
        !isProcessingImages
    val canPickMoreImages = !isSending &&
        !isProcessingImages &&
        pendingAttachments.size < ImageAttachmentLogic.MAX_ATTACHMENTS

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.canvas),
    ) {
        HorizontalDivider(thickness = 1.dp, color = colors.borderSubtle)
        Surface(
            color = colors.composer,
            shape = RoundedCornerShape(16.dp),
            border = BorderStroke(
                width = 1.dp,
                color = if (isFocused) colors.indigo.copy(alpha = 0.65f) else colors.border,
            ),
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 10.dp),
        ) {
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                // Pending image attachment previews (desktop-aligned above mentions & text input)
                if (pendingAttachments.isNotEmpty() || isProcessingImages) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .horizontalScroll(rememberScrollState())
                            .padding(start = 10.dp, end = 10.dp, top = 10.dp, bottom = 2.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.Top,
                    ) {
                        pendingAttachments.forEach { att ->
                            PendingImagePreviewChip(
                                attachment = att,
                                onPreview = { onPreviewPendingAttachment(att) },
                                onRemove = { onRemoveAttachment(att.id) },
                            )
                        }
                        if (isProcessingImages) {
                            Surface(
                                color = colors.surfaceSubtle,
                                shape = RoundedCornerShape(10.dp),
                                border = BorderStroke(1.dp, colors.border),
                                modifier = Modifier.size(64.dp),
                            ) {
                                Box(contentAlignment = Alignment.Center) {
                                    CircularProgressIndicator(
                                        modifier = Modifier.size(18.dp),
                                        strokeWidth = 2.dp,
                                        color = colors.indigo,
                                    )
                                }
                            }
                        }
                    }
                }

                // Selected & inline resolved @mention chips inside composer (desktop DraftMentionContextBar parity)
                if (draftMentionChips.isNotEmpty()) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .horizontalScroll(rememberScrollState())
                            .padding(start = 10.dp, end = 10.dp, top = 8.dp),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        draftMentionChips.forEach { chip ->
                            DraftMentionChipItem(
                                chip = chip,
                                onRemove = { onRemoveDraftChip(chip) },
                            )
                        }
                    }
                }

                // Clean borderless input field
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(start = 14.dp, end = 14.dp, top = 11.dp, bottom = 6.dp),
                ) {
                    if (composerText.isEmpty()) {
                        Text(
                            text = if (pendingAttachments.isNotEmpty()) {
                                "画像について指示を入力（任意）..."
                            } else {
                                "Conductor に指示を送る... (@でメンション)"
                            },
                            fontSize = 14.sp,
                            color = colors.textSubtle,
                        )
                    }
                    BasicTextField(
                        value = composerValue,
                        onValueChange = onComposerValueChange,
                        textStyle = TextStyle(
                            color = colors.textPrimary,
                            fontSize = 14.sp,
                            lineHeight = 20.sp,
                        ),
                        cursorBrush = SolidColor(colors.indigo),
                        maxLines = 5,
                        modifier = Modifier
                            .fillMaxWidth()
                            .onFocusChanged { isFocused = it.isFocused },
                    )
                }

                // Bottom composer toolbar: image attach + @ mention pills on left, circular indigo send arrow on right
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(start = 10.dp, end = 10.dp, bottom = 8.dp, top = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        val hasImages = pendingAttachments.isNotEmpty()
                        Surface(
                            color = if (hasImages) colors.indigoBg else colors.surfaceSubtle,
                            shape = RoundedCornerShape(8.dp),
                            border = BorderStroke(
                                1.dp,
                                if (hasImages) colors.indigoBorder else colors.borderSubtle,
                            ),
                            modifier = Modifier
                                .clip(RoundedCornerShape(8.dp))
                                .clickable(enabled = canPickMoreImages, onClick = onOpenImagePicker)
                                .semantics { contentDescription = "画像を添付" },
                        ) {
                            Row(
                                modifier = Modifier.padding(horizontal = 9.dp, vertical = 5.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(4.dp),
                            ) {
                                if (isProcessingImages) {
                                    CircularProgressIndicator(
                                        modifier = Modifier.size(13.dp),
                                        strokeWidth = 1.8.dp,
                                        color = colors.indigo,
                                    )
                                } else {
                                    Icon(
                                        imageVector = Icons.Default.AddPhotoAlternate,
                                        contentDescription = null,
                                        tint = if (canPickMoreImages) {
                                            colors.indigoText
                                        } else {
                                            colors.textSubtle
                                        },
                                        modifier = Modifier.size(15.dp),
                                    )
                                }
                                Text(
                                    text = if (hasImages) {
                                        "画像 (${pendingAttachments.size})"
                                    } else {
                                        "画像"
                                    },
                                    fontSize = 11.5.sp,
                                    fontWeight = FontWeight.Medium,
                                    color = if (!canPickMoreImages) {
                                        colors.textSubtle
                                    } else if (hasImages) {
                                        colors.indigoText
                                    } else {
                                        colors.textSecondary
                                    },
                                )
                            }
                        }

                        Surface(
                            color = colors.surfaceSubtle,
                            shape = RoundedCornerShape(8.dp),
                            border = BorderStroke(1.dp, colors.borderSubtle),
                            modifier = Modifier
                                .clip(RoundedCornerShape(8.dp))
                                .clickable(onClick = onOpenMentionPicker),
                        ) {
                            Row(
                                modifier = Modifier.padding(horizontal = 9.dp, vertical = 5.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(4.dp),
                            ) {
                                Icon(
                                    imageVector = Icons.Default.AlternateEmail,
                                    contentDescription = "@メンション追加",
                                    tint = colors.indigoText,
                                    modifier = Modifier.size(14.dp),
                                )
                                Text(
                                    text = "メンション",
                                    fontSize = 11.5.sp,
                                    fontWeight = FontWeight.Medium,
                                    color = colors.textSecondary,
                                )
                            }
                        }
                    }

                    Box(
                        modifier = Modifier
                            .size(34.dp)
                            .clip(CircleShape)
                            .background(if (canSend) colors.indigoAction else colors.surfaceSubtle)
                            .clickable(enabled = canSend, onClick = onSend),
                        contentAlignment = Alignment.Center,
                    ) {
                        if (isSending) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(16.dp),
                                color = Color.White,
                                strokeWidth = 2.dp,
                            )
                        } else {
                            Icon(
                                imageVector = Icons.Default.ArrowUpward,
                                contentDescription = "送信",
                                tint = if (canSend) Color.White else colors.textSubtle,
                                modifier = Modifier.size(18.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PendingImagePreviewChip(
    attachment: PendingImageAttachment,
    onPreview: () -> Unit,
    onRemove: () -> Unit,
) {
    val colors = ConductorTheme.colors
    var thumbBitmap by remember(attachment.id) { mutableStateOf<ImageBitmap?>(null) }

    LaunchedEffect(attachment.id) {
        thumbBitmap = withContext(Dispatchers.Default) {
            AndroidImageAttachmentProcessor.decodeBitmapSafe(attachment.previewBytes, 240)?.asImageBitmap()
        }
    }

    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(3.dp),
        modifier = Modifier.width(68.dp),
    ) {
        Box(modifier = Modifier.size(64.dp)) {
            Surface(
                color = colors.surfaceSubtle,
                shape = RoundedCornerShape(10.dp),
                border = BorderStroke(1.dp, colors.border),
                modifier = Modifier
                    .fillMaxSize()
                    .clip(RoundedCornerShape(10.dp))
                    .clickable(onClick = onPreview),
            ) {
                val bmp = thumbBitmap
                if (bmp != null) {
                    Image(
                        bitmap = bmp,
                        contentDescription = attachment.label,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxSize(),
                    )
                } else {
                    Box(contentAlignment = Alignment.Center) {
                        Icon(
                            imageVector = Icons.Default.Image,
                            contentDescription = attachment.label,
                            tint = colors.textSubtle,
                            modifier = Modifier.size(22.dp),
                        )
                    }
                }
            }

            // Crisp circular remove badge at top-end
            Box(
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(3.dp)
                    .size(20.dp)
                    .clip(CircleShape)
                    .background(Color.Black.copy(alpha = 0.72f))
                    .clickable(onClick = onRemove)
                    .semantics { contentDescription = "画像を削除: ${attachment.label}" },
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = Icons.Default.Close,
                    contentDescription = null,
                    tint = Color.White,
                    modifier = Modifier.size(12.dp),
                )
            }
        }
        Text(
            text = attachment.label,
            fontSize = 10.sp,
            color = colors.textMuted,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

@Composable
private fun ImagePreviewDialog(
    label: String,
    imageBytes: ByteArray,
    onDismiss: () -> Unit,
) {
    var fullBitmap by remember(imageBytes) { mutableStateOf<ImageBitmap?>(null) }

    LaunchedEffect(imageBytes) {
        fullBitmap = withContext(Dispatchers.Default) {
            AndroidImageAttachmentProcessor.decodeBitmapSafe(imageBytes, 2048)?.asImageBitmap()
        }
    }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Black.copy(alpha = 0.92f))
                .clickable(onClick = onDismiss),
        ) {
            val bmp = fullBitmap
            if (bmp != null) {
                Image(
                    bitmap = bmp,
                    contentDescription = label,
                    contentScale = ContentScale.Fit,
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(horizontal = 16.dp, vertical = 64.dp),
                )
            } else {
                CircularProgressIndicator(
                    color = Color.White,
                    modifier = Modifier.align(Alignment.Center),
                )
            }

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .align(Alignment.TopCenter)
                    .background(Color.Black.copy(alpha = 0.55f))
                    .padding(horizontal = 16.dp, vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = label,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Medium,
                    color = Color.White,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Spacer(modifier = Modifier.width(12.dp))
                Box(
                    modifier = Modifier
                        .size(34.dp)
                        .clip(CircleShape)
                        .background(Color.White.copy(alpha = 0.16f))
                        .clickable(onClick = onDismiss),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = Icons.Default.Close,
                        contentDescription = "閉じる",
                        tint = Color.White,
                        modifier = Modifier.size(18.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun DraftMentionChipItem(
    chip: DraftMentionChip,
    onRemove: () -> Unit,
) {
    val colors = ConductorTheme.colors
    when (chip) {
        is DraftMentionChip.TaskChip -> {
            Surface(
                color = colors.indigoBg,
                shape = RoundedCornerShape(8.dp),
                border = BorderStroke(1.dp, colors.indigoBorder),
                modifier = Modifier.semantics {
                    contentDescription = "選択中のタスクメンション ${chip.taskCode} ${chip.taskTitle}"
                },
            ) {
                Row(
                    modifier = Modifier
                        .clickable(onClick = onRemove)
                        .padding(start = 6.dp, end = 7.dp, top = 4.dp, bottom = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                ) {
                    TaskCodeBadge(taskNumber = chip.taskNumber)
                    if (chip.projectName.isNotBlank()) {
                        ProjectPill(
                            name = chip.projectName,
                            colorHex = chip.projectColorHex,
                            showDot = false,
                            modifier = Modifier.widthIn(max = 96.dp),
                        )
                    }
                    if (chip.taskTitle.isNotBlank()) {
                        Text(
                            text = chip.taskTitle,
                            fontSize = 11.5.sp,
                            fontWeight = FontWeight.Medium,
                            color = colors.textPrimary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.widthIn(max = 150.dp),
                        )
                    }
                    Icon(
                        imageVector = Icons.Default.Close,
                        contentDescription = "${chip.taskCode} を削除",
                        tint = colors.textMuted,
                        modifier = Modifier.size(13.dp),
                    )
                }
            }
        }

        is DraftMentionChip.ProjectChip -> {
            Surface(
                color = colors.surfaceSubtle,
                shape = RoundedCornerShape(8.dp),
                border = BorderStroke(1.dp, colors.border),
                modifier = Modifier.semantics {
                    contentDescription = "選択中のプロジェクトメンション @${chip.projectName}"
                },
            ) {
                Row(
                    modifier = Modifier
                        .clickable(onClick = onRemove)
                        .padding(horizontal = 8.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                ) {
                    Box(
                        modifier = Modifier
                            .size(7.dp)
                            .clip(CircleShape)
                            .background(parseConductorHexColor(chip.projectColorHex)),
                    )
                    Text(
                        text = "@${chip.projectName}",
                        fontSize = 11.5.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = colors.textPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.widthIn(max = 160.dp),
                    )
                    Icon(
                        imageVector = Icons.Default.Close,
                        contentDescription = "@${chip.projectName} を削除",
                        tint = colors.textMuted,
                        modifier = Modifier.size(13.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun MentionAutocompletePopup(
    query: ActiveMentionQuery,
    suggestions: List<MentionSuggestion>,
    scopedProject: Project?,
    onSelectSuggestion: (MentionSuggestion) -> Unit,
    onScopeProjectTasks: (Project) -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = ConductorTheme.colors
    val popupListState = rememberLazyListState()
    LaunchedEffect(query.start, query.rawQuery, query.mode) {
        if (suggestions.isNotEmpty()) {
            popupListState.scrollToItem(0)
        }
    }

    val headerTitle = if (query.mode == ActiveMentionMode.PROJECT_TASKS) {
        "@${scopedProject?.name ?: query.projectQuery} のタスク"
    } else {
        "メンション候補"
    }

    Surface(
        color = colors.card,
        shape = RoundedCornerShape(14.dp),
        border = BorderStroke(1.dp, colors.borderStrong),
        shadowElevation = 8.dp,
        tonalElevation = 0.dp,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(max = 264.dp)
            .semantics { contentDescription = "メンション候補一覧" },
    ) {
        Column(modifier = Modifier.fillMaxWidth()) {
            // Compact desktop-aligned header bar
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(colors.surfaceSecondary)
                    .padding(start = 12.dp, end = 8.dp, top = 7.dp, bottom = 7.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Row(
                    modifier = Modifier.weight(1f),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(
                        text = headerTitle,
                        fontSize = 11.5.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = colors.textSecondary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    Surface(
                        color = colors.surfaceSubtle,
                        shape = RoundedCornerShape(99.dp),
                    ) {
                        Text(
                            text = "${suggestions.size}",
                            fontSize = 10.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = colors.textMuted,
                            modifier = Modifier.padding(horizontal = 6.dp, vertical = 1.dp),
                        )
                    }
                }
                Text(
                    text = if (query.mode == ActiveMentionMode.PROJECT_TASKS) "@project/T#" else "@project · @T#",
                    fontSize = 10.sp,
                    fontFamily = FontFamily.Monospace,
                    color = colors.textSubtle,
                    maxLines = 1,
                )
                Box(
                    modifier = Modifier
                        .size(24.dp)
                        .clip(CircleShape)
                        .clickable(onClick = onDismiss)
                        .semantics { contentDescription = "メンション候補を閉じる" },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = Icons.Default.Close,
                        contentDescription = null,
                        tint = colors.textMuted,
                        modifier = Modifier.size(14.dp),
                    )
                }
            }
            HorizontalDivider(thickness = 1.dp, color = colors.borderSubtle)

            if (suggestions.isEmpty()) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 18.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = if (query.mode == ActiveMentionMode.PROJECT_TASKS) {
                            "@${scopedProject?.name ?: query.projectQuery} に一致するタスクがありません"
                        } else {
                            "一致する候補がありません"
                        },
                        fontSize = 12.sp,
                        color = colors.textMuted,
                        textAlign = TextAlign.Center,
                    )
                }
            } else {
                LazyColumn(
                    state = popupListState,
                    modifier = Modifier.fillMaxWidth(),
                    contentPadding = PaddingValues(vertical = 4.dp),
                ) {
                    itemsIndexed(
                        items = suggestions,
                        key = { _, item -> item.id },
                    ) { index, suggestion ->
                        val prevKind = if (index > 0) suggestions[index - 1]::class else null
                        val showGroupDivider = query.mode == ActiveMentionMode.ALL &&
                            prevKind != null &&
                            prevKind != suggestion::class
                        if (showGroupDivider) {
                            HorizontalDivider(
                                thickness = 1.dp,
                                color = colors.borderSubtle,
                                modifier = Modifier.padding(vertical = 3.dp, horizontal = 12.dp),
                            )
                        }
                        when (suggestion) {
                            is MentionSuggestion.TaskSuggestion -> MentionTaskSuggestionRow(
                                suggestion = suggestion,
                                onClick = { onSelectSuggestion(suggestion) },
                            )

                            is MentionSuggestion.ProjectSuggestion -> MentionProjectSuggestionRow(
                                suggestion = suggestion,
                                onClick = { onSelectSuggestion(suggestion) },
                                onScopeTasks = { onScopeProjectTasks(suggestion.project) },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun MentionTaskSuggestionRow(
    suggestion: MentionSuggestion.TaskSuggestion,
    onClick: () -> Unit,
) {
    val colors = ConductorTheme.colors
    val task = suggestion.task
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 9.dp)
            .semantics {
                contentDescription = "タスク候補 ${suggestion.insertText} ${task.title}"
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        TaskStatusIcon(status = task.status)
        TaskCodeBadge(taskNumber = task.taskNumber)
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                text = task.title,
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                color = colors.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                if (task.projectName.isNotBlank()) {
                    ProjectPill(
                        name = task.projectName,
                        colorHex = suggestion.projectColorHex,
                        modifier = Modifier.widthIn(max = 120.dp),
                    )
                }
                if (suggestion.scopedProjectName != null) {
                    Text(
                        text = suggestion.insertText,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 10.sp,
                        color = colors.textSubtle,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
        TaskStatusBadge(status = task.status)
    }
}

@Composable
private fun MentionProjectSuggestionRow(
    suggestion: MentionSuggestion.ProjectSuggestion,
    onClick: () -> Unit,
    onScopeTasks: () -> Unit,
) {
    val colors = ConductorTheme.colors
    val project = suggestion.project
    val compactPath = remember(project.path) {
        MentionAutocomplete.compactProjectPath(project.path)
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 9.dp)
            .semantics {
                contentDescription = "プロジェクト候補 @${project.name}"
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(
            modifier = Modifier
                .size(8.dp)
                .clip(CircleShape)
                .background(parseConductorHexColor(project.colorHex)),
        )
        Icon(
            imageVector = Icons.Default.Folder,
            contentDescription = null,
            tint = colors.textSubtle,
            modifier = Modifier.size(15.dp),
        )
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(
                    text = "@${project.name}",
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = colors.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (!project.gitBranch.isNullOrBlank()) {
                    Surface(
                        color = colors.surfaceSubtle,
                        shape = RoundedCornerShape(4.dp),
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 5.dp, vertical = 1.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(3.dp),
                        ) {
                            Icon(
                                imageVector = Icons.Default.AccountTree,
                                contentDescription = null,
                                tint = colors.textSubtle,
                                modifier = Modifier.size(10.dp),
                            )
                            Text(
                                text = project.gitBranch,
                                fontFamily = FontFamily.Monospace,
                                fontSize = 9.5.sp,
                                color = colors.textMuted,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.widthIn(max = 84.dp),
                            )
                        }
                    }
                }
            }
            if (compactPath.isNotBlank()) {
                Text(
                    text = compactPath,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 10.5.sp,
                    color = colors.textSubtle,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (suggestion.taskCount > 0) {
            Surface(
                color = colors.indigoBg,
                shape = RoundedCornerShape(6.dp),
                border = BorderStroke(1.dp, colors.indigoBorder),
                modifier = Modifier
                    .clip(RoundedCornerShape(6.dp))
                    .clickable(onClick = onScopeTasks)
                    .semantics {
                        contentDescription = "@${project.name} のタスク一覧を表示"
                    },
            ) {
                Text(
                    text = "${suggestion.taskCount} タスク /",
                    fontSize = 10.5.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = colors.indigoText,
                    maxLines = 1,
                    modifier = Modifier.padding(horizontal = 7.dp, vertical = 4.dp),
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
    val colors = ConductorTheme.colors
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = colors.canvas,
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
                    fontSize = 16.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = colors.textPrimary,
                )
            }

            if (projects.isNotEmpty()) {
                item {
                    Text(
                        text = "PROJECTS",
                        fontSize = 10.5.sp,
                        fontWeight = FontWeight.SemiBold,
                        letterSpacing = 0.6.sp,
                        color = colors.textMuted,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }
                items(projects, key = { "p-${it.id}" }) { project ->
                    ConductorCard(
                        cornerRadius = 12.dp,
                        onClick = {
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
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            Box(
                                modifier = Modifier
                                    .size(9.dp)
                                    .clip(CircleShape)
                                    .background(parseConductorHexColor(project.colorHex)),
                            )
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    text = "@${project.name}",
                                    fontSize = 13.5.sp,
                                    fontWeight = FontWeight.SemiBold,
                                    color = colors.textPrimary,
                                )
                                if (project.path.isNotBlank()) {
                                    Text(
                                        text = project.path,
                                        fontSize = 11.sp,
                                        fontFamily = FontFamily.Monospace,
                                        color = colors.textMuted,
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
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = "TASKS",
                        fontSize = 10.5.sp,
                        fontWeight = FontWeight.SemiBold,
                        letterSpacing = 0.6.sp,
                        color = colors.textMuted,
                    )
                }
                items(tasks, key = { "t-${it.id}" }) { task ->
                    ConductorCard(
                        cornerRadius = 12.dp,
                        onClick = {
                            val colorHex = MentionAutocomplete.getProjectColorForTask(projects, task)
                            onSelect(
                                ExplicitMentionTarget(
                                    kind = "task",
                                    taskId = task.id,
                                    taskNumber = task.taskNumber,
                                    taskTitle = task.title,
                                    taskStatus = task.status,
                                    projectId = task.projectId,
                                    projectName = task.projectName,
                                    projectPath = task.projectPath,
                                    projectColorHex = colorHex,
                                ),
                            )
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 12.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            TaskCodeBadge(taskNumber = task.taskNumber)
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    text = task.title,
                                    fontSize = 13.sp,
                                    fontWeight = FontWeight.SemiBold,
                                    color = colors.textPrimary,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                Text(
                                    text = task.projectName,
                                    fontSize = 11.sp,
                                    color = colors.textMuted,
                                )
                            }
                            TaskStatusBadge(status = task.status)
                        }
                    }
                }
            }
        }
    }
}

private const val CHAT_BOTTOM_ANCHOR_KEY = "__chat_bottom_anchor__"

@Composable
private fun ScrollToBottomFloatingButton(
    visible: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = ConductorTheme.colors
    val interactionSource = remember { MutableInteractionSource() }
    val isPressed by interactionSource.collectIsPressedAsState()

    val containerColor = colors.card.copy(alpha = 0.96f)
    val borderColor = if (isPressed) {
        colors.indigo.copy(alpha = 0.55f)
    } else if (colors.isDark) {
        colors.borderStrong
    } else {
        colors.border
    }
    val iconTint = if (isPressed) colors.indigoText else colors.textSecondary

    AnimatedVisibility(
        visible = visible,
        enter = fadeIn(animationSpec = tween(durationMillis = 180)) +
            scaleIn(initialScale = 0.85f, animationSpec = tween(durationMillis = 180)) +
            slideInVertically(animationSpec = tween(durationMillis = 180)) { it / 2 },
        exit = fadeOut(animationSpec = tween(durationMillis = 150)) +
            scaleOut(targetScale = 0.85f, animationSpec = tween(durationMillis = 150)) +
            slideOutVertically(animationSpec = tween(durationMillis = 150)) { it / 2 },
        modifier = modifier,
    ) {
        Surface(
            onClick = onClick,
            shape = CircleShape,
            color = containerColor,
            border = BorderStroke(1.dp, borderColor),
            shadowElevation = 4.dp,
            tonalElevation = 0.dp,
            interactionSource = interactionSource,
            modifier = Modifier
                .size(40.dp)
                .semantics { contentDescription = "最新メッセージへ" },
        ) {
            Box(contentAlignment = Alignment.Center) {
                Icon(
                    imageVector = Icons.Default.ArrowDownward,
                    contentDescription = null,
                    tint = iconTint,
                    modifier = Modifier.size(19.dp),
                )
            }
        }
    }
}

internal fun parseHexColor(hex: String?): Color = parseConductorHexColor(hex)
