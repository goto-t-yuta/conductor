package dev.conductor.mobile.model

import kotlinx.serialization.Serializable

enum class TerminalConnectionState {
    DISCONNECTED,
    CONNECTING,
    CONNECTED,
    RECONNECTING,
    EXITED,
    ERROR,
}

@Serializable
data class TerminalSessionInfo(
    val id: String = "",
    val cwd: String = "",
    val requestedCwd: String? = null,
    val projectPath: String? = null,
    val shell: String = "",
    val shellName: String = "shell",
    val pid: Int? = null,
    val backend: String = "",
    val cols: Int = 80,
    val rows: Int = 24,
    val status: String = "running",
    val exitCode: Int? = null,
    val signal: Int? = null,
    val createdAt: String = "",
    val lastActivityAt: String = "",
    val bufferChars: Int = 0,
)

@Serializable
data class TerminalServerMessage(
    val type: String = "",
    val session: TerminalSessionInfo? = null,
    val replay: String = "",
    val replayMode: String = "full",
    val recreated: Boolean = false,
    val sessionId: String? = null,
    val data: String = "",
    val seq: Long = 0L,
    val exitCode: Int? = null,
    val signal: Int? = null,
    val message: String? = null,
    val ts: Long? = null,
)

@Serializable
data class TerminalClientMessage(
    val type: String,
    val data: String? = null,
    val cols: Int? = null,
    val rows: Int? = null,
    val projectPath: String? = null,
    val ts: Long? = null,
)

data class TerminalSpanStyle(
    val fgColorArgb: Long? = null,
    val bgColorArgb: Long? = null,
    val bold: Boolean = false,
    val dim: Boolean = false,
    val italic: Boolean = false,
    val underline: Boolean = false,
) {
    companion object {
        val Default = TerminalSpanStyle()
    }
}

data class TerminalStyledSpan(
    val text: String,
    val style: TerminalSpanStyle = TerminalSpanStyle.Default,
)

data class TerminalRenderedLine(
    val id: Long,
    val spans: List<TerminalStyledSpan>,
) {
    fun plainText(): String = spans.joinToString(separator = "") { it.text }
}

data class TerminalUiState(
    val connectionState: TerminalConnectionState = TerminalConnectionState.DISCONNECTED,
    val statusDetail: String = "未接続",
    val session: TerminalSessionInfo? = null,
    val selectedProjectPath: String? = null,
    val selectedProjectName: String? = null,
    val lines: List<TerminalRenderedLine> = emptyList(),
    val outputVersion: Long = 0L,
    val commandInput: String = "",
    val lastError: String? = null,
    val cols: Int = 64,
    val rows: Int = 24,
)
