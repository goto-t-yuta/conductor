package dev.conductor.mobile.model

import kotlinx.serialization.Serializable

@Serializable
data class HealthResponse(
    val ok: Boolean = false,
    val service: String = "",
    val version: String = "",
    val hostname: String = "",
    val tailscaleIp: String? = null,
    val magicDnsName: String? = null,
    val timestamp: String = "",
)

@Serializable
data class Project(
    val id: String,
    val name: String,
    val path: String = "",
    val colorHex: String = "#6366F1",
    val gitBranch: String? = null,
)

@Serializable
data class WorkerActivityEntry(
    val id: String = "",
    val kind: String = "system",
    val title: String = "",
    val detail: String? = null,
    val timestamp: String = "",
)

@Serializable
data class AgentTask(
    val id: String,
    val taskNumber: Int = 0,
    val title: String = "",
    val summary: String = "",
    val projectId: String? = null,
    val projectName: String = "General",
    val projectPath: String? = null,
    val status: String = "queued",
    val provider: String? = null,
    val currentStep: String? = null,
    val previewURL: String? = null,
    val latestOutput: String = "",
    val activities: List<WorkerActivityEntry> = emptyList(),
    val worktreePath: String? = null,
    val worktreeBranch: String? = null,
    val landStatus: String? = null,
    val landedBranch: String? = null,
    val prUrl: String? = null,
    val landError: String? = null,
    val createdAt: String = "",
    val updatedAt: String = "",
) {
    val hasWorktree: Boolean
        get() = !worktreePath.isNullOrBlank() || !worktreeBranch.isNullOrBlank()

    val isUnlandedWorktree: Boolean
        get() {
            if (landStatus in setOf("landed", "pushed", "pr_created")) return false
            return hasWorktree || landStatus in setOf("unlanded", "landing", "conflict", "error")
        }
}

@Serializable
data class TaskWorktreeStatus(
    val hasWorktree: Boolean = false,
    val worktreeExists: Boolean = false,
    val worktreePath: String? = null,
    val worktreeBranch: String? = null,
    val parentBranch: String? = null,
    val parentDirty: Boolean = false,
    val worktreeDirty: Boolean = false,
    val changedFilesCount: Int = 0,
    val aheadCommits: Int = 0,
    val diffSummary: String? = null,
    val effectiveMode: String = "feature-branch",
    val suggestedTargetBranch: String? = null,
    val ghAvailable: Boolean = false,
)

@Serializable
data class TaskDetailResponse(
    val ok: Boolean = false,
    val task: AgentTask? = null,
    val worktreeStatus: TaskWorktreeStatus? = null,
    val gitStatus: String? = null,
    val error: String? = null,
)

@Serializable
data class ApiActionResponse(
    val ok: Boolean = false,
    val message: String? = null,
    val error: String? = null,
    val action: String? = null,
    val prUrl: String? = null,
    val task: AgentTask? = null,
    val snapshot: AppSnapshot? = null,
)

@Serializable
data class ToolActivityChip(
    val id: String = "",
    val toolName: String? = null,
    val label: String = "",
    val detail: String? = null,
    val isCompleted: Boolean = false,
    val isError: Boolean = false,
)

@Serializable
data class ChatMessageMentionRef(
    val kind: String = "project",
    val projectId: String? = null,
    val projectName: String = "",
    val projectPath: String? = null,
    val projectColorHex: String = "#6366F1",
    val taskId: String? = null,
    val taskNumber: Int? = null,
    val taskTitle: String? = null,
    val taskStatus: String? = null,
) {
    fun displayLabel(): String =
        if (kind == "task" && taskNumber != null) {
            "@T$taskNumber"
        } else {
            "@${projectName.ifBlank { "Project" }}"
        }
}

@Serializable
data class ExplicitMentionTarget(
    val kind: String,
    val projectId: String? = null,
    val projectName: String? = null,
    val projectPath: String? = null,
    val projectColorHex: String? = null,
    val taskId: String? = null,
    val taskNumber: Int? = null,
    val taskTitle: String? = null,
    val taskStatus: String? = null,
) {
    fun uniqueKey(): String =
        if (kind == "task") "task:${taskId.orEmpty()}" else "project:${projectId ?: projectName.orEmpty()}"

    fun chipLabel(): String =
        if (kind == "task") {
            "@T${taskNumber ?: "?"} ${taskTitle.orEmpty()}".trim()
        } else {
            "@${projectName ?: "Project"}"
        }
}

@Serializable
data class ChatAttachment(
    val id: String = "",
    val kind: String = "browserURL",
    val label: String = "",
    val imagePath: String? = null,
    val imageDataUrl: String? = null,
    val url: String? = null,
    val metadataText: String? = null,
)

data class PendingImageAttachment(
    val id: String,
    val label: String,
    val mimeType: String,
    val imageDataUrl: String,
    val byteSize: Int,
    val previewBytes: ByteArray,
) {
    fun toChatAttachment(): ChatAttachment = ChatAttachment(
        id = id,
        kind = "image",
        label = label,
        imageDataUrl = imageDataUrl,
    )

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is PendingImageAttachment) return false
        return id == other.id &&
            label == other.label &&
            mimeType == other.mimeType &&
            imageDataUrl == other.imageDataUrl &&
            byteSize == other.byteSize &&
            previewBytes.contentEquals(other.previewBytes)
    }

    override fun hashCode(): Int {
        var result = id.hashCode()
        result = 31 * result + label.hashCode()
        result = 31 * result + mimeType.hashCode()
        result = 31 * result + imageDataUrl.hashCode()
        result = 31 * result + byteSize
        result = 31 * result + previewBytes.contentHashCode()
        return result
    }
}

@Serializable
data class ChatMessage(
    val id: String,
    val role: String,
    val provider: String? = null,
    val text: String = "",
    val reasoningSummary: String? = null,
    val attachments: List<ChatAttachment> = emptyList(),
    val mentions: List<ChatMessageMentionRef> = emptyList(),
    val inferredMentions: List<ChatMessageMentionRef> = emptyList(),
    val toolChips: List<ToolActivityChip> = emptyList(),
    val relatedTaskId: String? = null,
    val isStreaming: Boolean = false,
    val createdAt: String = "",
)

@Serializable
data class AppSnapshot(
    val projects: List<Project> = emptyList(),
    val tasks: List<AgentTask> = emptyList(),
    val messages: List<ChatMessage> = emptyList(),
    val activeChatSessionId: String = "",
    val isConnected: Boolean = false,
    val connectionStatus: String = "",
    val activeResponderCount: Int = 0,
    val chatProvider: String = "codex",
    val workerProvider: String = "codex",
    val chatModel: String? = null,
    val workerModel: String? = null,
    val lastErrorBanner: String? = null,
)

@Serializable
data class ChatSendRequest(
    val text: String,
    val explicitMentions: List<ExplicitMentionTarget> = emptyList(),
    val attachments: List<ChatAttachment> = emptyList(),
)

@Serializable
data class ChatStopRequest(
    val messageId: String? = null,
)

@Serializable
data class TaskStatusRequest(
    val status: String,
)

@Serializable
data class TaskLandRequest(
    val createPr: Boolean = false,
)

data class ConnectionConfig(
    val serverUrl: String = "",
    val bearerToken: String = "",
) {
    val isConfigured: Boolean
        get() = serverUrl.isNotBlank() && bearerToken.isNotBlank()
}

enum class StreamTransportState {
    DISCONNECTED,
    CONNECTING,
    CONNECTED_SSE,
    CONNECTED_POLLING,
    ERROR,
}

enum class ThemeMode(val storageValue: String, val label: String) {
    SYSTEM("system", "System"),
    LIGHT("light", "Light"),
    DARK("dark", "Dark"),
    ;

    companion object {
        fun fromStorageValue(raw: String?): ThemeMode =
            entries.firstOrNull { it.storageValue.equals(raw?.trim(), ignoreCase = true) } ?: SYSTEM
    }
}
