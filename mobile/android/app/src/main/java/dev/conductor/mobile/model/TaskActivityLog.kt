package dev.conductor.mobile.model

data class ToolCallCount(
    val name: String,
    val count: Int,
)

data class PartitionedTaskActivities(
    /** High-signal entries (error, message, important system, file) in reverse-chronological order (newest first). */
    val highSignal: List<WorkerActivityEntry>,
    /** Routine tool-call entries (command, reasoning, system_message) in chronological order (oldest first). */
    val toolActivities: List<WorkerActivityEntry>,
    /** Aggregated counts of routine tool calls, sorted by descending count (ties keep first-seen order). */
    val toolCounts: List<ToolCallCount>,
)

/**
 * Mirrors desktop `src/renderer/lib/activity-log.ts` so Android partitions task activities
 * into high-signal events and grouped routine tool execution logs identically to PC.
 */
object TaskActivityLog {
    private val defaultApiPrefixRegex = Regex("^default_api:")
    private val mcpConductorPrefixRegex = Regex("^mcp_+conductor_+")

    fun normalizeActivityToolName(title: String): String {
        val trimmed = title.trim()
        if (trimmed.isEmpty()) return "tool"
        if (trimmed.startsWith("$ ")) return "run_command"
        val cleaned = trimmed
            .replace(defaultApiPrefixRegex, "")
            .replace(mcpConductorPrefixRegex, "")
            .trim()
        if (cleaned.isEmpty()) return "tool"
        return if (cleaned.length > 32) "${cleaned.take(31)}…" else cleaned
    }

    fun isRoutineToolActivity(entry: WorkerActivityEntry): Boolean {
        if (entry.kind == "command" || entry.kind == "reasoning") {
            return true
        }
        if (entry.kind == "system" && entry.title.trim().equals("system_message", ignoreCase = true)) {
            return true
        }
        return false
    }

    fun countToolNames(names: List<String>): List<ToolCallCount> {
        val counts = LinkedHashMap<String, Pair<Int, Int>>() // name -> (count, firstIndex)
        names.forEachIndexed { idx, raw ->
            val name = raw.trim().ifEmpty { "tool" }
            val existing = counts[name]
            if (existing != null) {
                counts[name] = (existing.first + 1) to existing.second
            } else {
                counts[name] = 1 to idx
            }
        }
        return counts.entries
            .sortedWith(compareByDescending<Map.Entry<String, Pair<Int, Int>>> { it.value.first }.thenBy { it.value.second })
            .map { (name, meta) -> ToolCallCount(name = name, count = meta.first) }
    }

    fun partitionTaskActivities(activities: List<WorkerActivityEntry>): PartitionedTaskActivities {
        val highSignalChronological = mutableListOf<WorkerActivityEntry>()
        val toolActivities = mutableListOf<WorkerActivityEntry>()
        for (act in activities) {
            if (isRoutineToolActivity(act)) {
                toolActivities.add(act)
            } else {
                highSignalChronological.add(act)
            }
        }
        val toolCounts = countToolNames(toolActivities.map { normalizeActivityToolName(it.title) })
        return PartitionedTaskActivities(
            highSignal = highSignalChronological.asReversed(),
            toolActivities = toolActivities,
            toolCounts = toolCounts,
        )
    }

    fun formatToolLogSummary(
        totalCount: Int,
        toolCounts: List<ToolCallCount>,
        maxItems: Int = 4,
    ): String {
        if (toolCounts.isEmpty()) {
            return "ツール実行ログ（全 ${totalCount}件）"
        }
        val limit = maxItems.coerceAtLeast(1)
        val shown = toolCounts.take(limit).map { "${it.name} ×${it.count}" }.toMutableList()
        val remaining = toolCounts.size - shown.size
        if (remaining > 0) {
            shown.add("ほか ${remaining}種")
        }
        return "ツール実行ログ（全 ${totalCount}件: ${shown.joinToString(", ")}）"
    }
}
