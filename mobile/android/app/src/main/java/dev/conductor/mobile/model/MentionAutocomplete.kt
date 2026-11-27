package dev.conductor.mobile.model

enum class ActiveMentionMode {
    ALL,
    PROJECT_TASKS,
}

data class ActiveMentionQuery(
    val start: Int,
    val end: Int,
    val rawQuery: String,
    val mode: ActiveMentionMode,
    val projectQuery: String = "",
    val taskQuery: String = "",
) {
    val key: String
        get() = "$start:$rawQuery"
}

sealed interface MentionSuggestion {
    val id: String
    val insertText: String

    data class ProjectSuggestion(
        override val id: String,
        val project: Project,
        val taskCount: Int,
        override val insertText: String,
    ) : MentionSuggestion

    data class TaskSuggestion(
        override val id: String,
        val task: AgentTask,
        val projectColorHex: String,
        override val insertText: String,
        val scopedProjectName: String? = null,
    ) : MentionSuggestion
}

data class MentionSuggestionsResult(
    val suggestions: List<MentionSuggestion>,
    val scopedProject: Project? = null,
)

data class MentionEditResult(
    val nextText: String,
    val nextCaret: Int,
    val removedCount: Int = 0,
)

data class ParsedInlineMention(
    val raw: String,
    val start: Int,
    val end: Int,
    val kind: String,
    val projectName: String? = null,
    val taskNumber: Int? = null,
    val project: Project? = null,
    val task: AgentTask? = null,
)

sealed interface DraftMentionChip {
    val key: String
    val projectName: String
    val projectColorHex: String
    val removalTarget: ExplicitMentionTarget

    data class ProjectChip(
        override val key: String,
        val projectId: String?,
        override val projectName: String,
        val projectPath: String?,
        override val projectColorHex: String,
        override val removalTarget: ExplicitMentionTarget,
        val rawMentions: List<String> = emptyList(),
    ) : DraftMentionChip

    data class TaskChip(
        override val key: String,
        val taskId: String?,
        val taskNumber: Int,
        val taskCode: String,
        val taskTitle: String,
        val taskStatus: String?,
        val projectId: String?,
        override val projectName: String,
        override val projectColorHex: String,
        override val removalTarget: ExplicitMentionTarget,
        val rawMentions: List<String> = emptyList(),
    ) : DraftMentionChip
}

/**
 * Pure Kotlin mention detection, filtering, resolution, and text-editing engine
 * aligned with desktop Conductor's `src/shared/mentions.ts`.
 */
object MentionAutocomplete {
    const val DEFAULT_PROJECT_COLOR_HEX = "#6366F1"

    private val emailLocalCharRegex = Regex("[A-Za-z0-9._+-]")
    private val asciiTokenCharRegex = Regex("[A-Za-z0-9_-]")
    private val hardBreakRegex = Regex("""[\s@/,、。！？!?()\[\]{}<>"'「」『』【】;:`]""")
    private val taskCodePrefixRegex = Regex("""^[Tt](\d+)(?![A-Za-z0-9_/-])""")
    private val genericProjectTaskRegex = Regex(
        """^([^\s@/,、。！？!?()\[\]{}<>"'「」『』【】;:`]+)/[Tt](\d+)(?![A-Za-z0-9_/-])""",
    )
    private val taskCodeQueryRegex = Regex("^t\\d*$", RegexOption.IGNORE_CASE)
    private val trailingPunctRegex = Regex("""^[.,、。！？!?:;)\]}」』】]""")
    private val trailingSpacesRegex = Regex("[ \\t]+$")
    private val leadingSpacesRegex = Regex("^[ \\t]+")
    private val onlySpacesUntilLineEndRegex = Regex("^[ \\t]+(?:\\n|$)")
    private val macHomeDirRegex = Regex("^/Users/[^/]+")

    fun formatTaskCode(taskNumber: Int): String = "T$taskNumber"

    private fun isValidMentionPrefix(text: String, atIndex: Int): Boolean {
        if (atIndex <= 0) return true
        val prev = text[atIndex - 1].toString()
        return !emailLocalCharRegex.matches(prev)
    }

    /**
     * Detects whether the caret is currently positioned inside an active `@...`
     * or `@<projectName>/...` mention token.
     */
    fun detectActiveMention(text: String, caretIndex: Int): ActiveMentionQuery? {
        if (text.isEmpty() || !text.contains('@')) return null
        val safeCaret = caretIndex.coerceIn(0, text.length)
        var idx = safeCaret - 1

        while (idx >= 0) {
            val ch = text[idx]
            if (ch == '@') {
                if (!isValidMentionPrefix(text, idx)) return null
                val rawQuery = text.substring(idx + 1, safeCaret)
                val slashIndex = rawQuery.indexOf('/')
                if (slashIndex != -1) {
                    val projectQuery = rawQuery.substring(0, slashIndex)
                    val taskQuery = rawQuery.substring(slashIndex + 1)
                    if (taskQuery.contains('/') || projectQuery.isEmpty()) return null
                    return ActiveMentionQuery(
                        start = idx,
                        end = safeCaret,
                        rawQuery = rawQuery,
                        mode = ActiveMentionMode.PROJECT_TASKS,
                        projectQuery = projectQuery,
                        taskQuery = taskQuery,
                    )
                }
                return ActiveMentionQuery(
                    start = idx,
                    end = safeCaret,
                    rawQuery = rawQuery,
                    mode = ActiveMentionMode.ALL,
                )
            }
            if (ch != '/' && hardBreakRegex.matches(ch.toString())) {
                return null
            }
            idx -= 1
        }
        return null
    }

    fun findProjectForTask(projects: List<Project>, task: AgentTask): Project? {
        if (!task.projectId.isNullOrBlank()) {
            projects.firstOrNull { it.id == task.projectId }?.let { return it }
        }
        val lowerName = task.projectName.lowercase()
        if (lowerName.isNotEmpty()) {
            projects.firstOrNull { it.name.lowercase() == lowerName }?.let { return it }
        }
        return null
    }

    fun getProjectColorForTask(projects: List<Project>, task: AgentTask): String =
        findProjectForTask(projects, task)?.colorHex?.takeIf { it.isNotBlank() }
            ?: DEFAULT_PROJECT_COLOR_HEX

    private fun taskBelongsToProject(task: AgentTask, project: Project, projectLowerName: String): Boolean {
        if (!task.projectId.isNullOrBlank() && task.projectId == project.id) return true
        if (!task.projectPath.isNullOrBlank() && task.projectPath == project.path) return true
        return task.projectName.lowercase() == projectLowerName
    }

    private fun scoreTaskMatch(task: AgentTask, queryLower: String): Int {
        if (queryLower.isEmpty()) {
            return when (task.status) {
                "running" -> 50
                "needs_review" -> 45
                "queued" -> 40
                else -> 30
            }
        }
        val lowerCode = "t${task.taskNumber}"
        val numStr = task.taskNumber.toString()
        val lowerTitle = task.title.lowercase()
        val lowerProjectName = task.projectName.lowercase()

        return when {
            lowerCode == queryLower || numStr == queryLower -> 1000
            lowerCode.startsWith(queryLower) -> 900
            numStr.startsWith(queryLower) -> 850
            lowerTitle.startsWith(queryLower) -> 700
            lowerProjectName.startsWith(queryLower) -> 650
            lowerTitle.contains(queryLower) -> 550
            lowerProjectName.contains(queryLower) -> 500
            else -> -1
        }
    }

    private fun scoreProjectMatch(project: Project, queryLower: String): Int {
        if (queryLower.isEmpty()) return 100
        val lowerName = project.name.lowercase()
        val lowerPath = project.path.lowercase()
        return when {
            lowerName == queryLower -> 950
            lowerName.startsWith(queryLower) -> 800
            lowerName.contains(queryLower) -> 600
            lowerPath.contains(queryLower) -> 400
            else -> -1
        }
    }

    /**
     * Returns ranked project and task suggestions matching desktop Conductor's
     * `getMentionSuggestions` across all projects and tasks.
     */
    fun getMentionSuggestions(
        query: ActiveMentionQuery,
        projects: List<Project>,
        tasks: List<AgentTask>,
    ): MentionSuggestionsResult {
        val projectById = HashMap<String, Project>(projects.size)
        val projectByLowerName = HashMap<String, Project>(projects.size)
        for (p in projects) {
            projectById.putIfAbsent(p.id, p)
            val lower = p.name.lowercase()
            if (lower.isNotEmpty()) projectByLowerName.putIfAbsent(lower, p)
        }

        fun colorForTask(task: AgentTask): String {
            task.projectId?.let { id ->
                projectById[id]?.colorHex?.takeIf { it.isNotBlank() }?.let { return it }
            }
            val lower = task.projectName.lowercase()
            if (lower.isNotEmpty()) {
                projectByLowerName[lower]?.colorHex?.takeIf { it.isNotBlank() }?.let { return it }
            }
            return DEFAULT_PROJECT_COLOR_HEX
        }

        if (query.mode == ActiveMentionMode.PROJECT_TASKS) {
            val pq = query.projectQuery.lowercase()
            val scopedProject = projectByLowerName[pq]
                ?: projects.firstOrNull { it.name.lowercase().startsWith(pq) }
            val scopedLowerName = scopedProject?.name?.lowercase() ?: pq
            val tq = query.taskQuery.trim().lowercase()

            val matched = tasks.mapNotNull { task ->
                val belongs = if (scopedProject != null) {
                    taskBelongsToProject(task, scopedProject, scopedLowerName)
                } else {
                    task.projectName.lowercase() == pq
                }
                if (!belongs) return@mapNotNull null
                val score = scoreTaskMatch(task, tq)
                if (score >= 0) task to score else null
            }.sortedWith(
                compareByDescending<Pair<AgentTask, Int>> { it.second }
                    .thenByDescending { it.first.taskNumber },
            )

            val projLabel = scopedProject?.name ?: query.projectQuery
            val suggestions = matched.map { (task, _) ->
                MentionSuggestion.TaskSuggestion(
                    id = "task:$projLabel:${task.id}",
                    task = task,
                    projectColorHex = scopedProject?.colorHex?.takeIf { it.isNotBlank() }
                        ?: colorForTask(task),
                    insertText = "@$projLabel/${formatTaskCode(task.taskNumber)}",
                    scopedProjectName = projLabel,
                )
            }
            return MentionSuggestionsResult(
                suggestions = suggestions,
                scopedProject = scopedProject,
            )
        }

        val q = query.rawQuery.trim().lowercase()
        val isTaskCodeQuery = taskCodeQueryRegex.matches(q)

        val taskCountsByProjectKey = HashMap<String, Int>()
        for (task in tasks) {
            val key = task.projectId?.takeIf { it.isNotBlank() } ?: task.projectName.lowercase()
            taskCountsByProjectKey[key] = (taskCountsByProjectKey[key] ?: 0) + 1
        }

        val scoredTasks = tasks.mapNotNull { task ->
            val score = scoreTaskMatch(task, q)
            if (score >= 0) task to score else null
        }.sortedWith(
            compareByDescending<Pair<AgentTask, Int>> { it.second }
                .thenByDescending { it.first.taskNumber },
        )

        val scoredProjects = projects.mapIndexedNotNull { index, project ->
            val score = scoreProjectMatch(project, q)
            if (score >= 0) Triple(project, score, index) else null
        }.sortedWith(
            compareByDescending<Triple<Project, Int, Int>> { it.second }
                .thenBy { it.third },
        )

        fun toTaskSuggestion(task: AgentTask): MentionSuggestion.TaskSuggestion =
            MentionSuggestion.TaskSuggestion(
                id = "task:${task.id}",
                task = task,
                projectColorHex = colorForTask(task),
                insertText = "@${formatTaskCode(task.taskNumber)}",
            )

        val matchedProjects = scoredProjects.map { (project, _, _) ->
            val lower = project.name.lowercase()
            MentionSuggestion.ProjectSuggestion(
                id = "project:${project.id}",
                project = project,
                taskCount = taskCountsByProjectKey[project.id] ?: taskCountsByProjectKey[lower] ?: 0,
                insertText = "@${project.name}",
            )
        }

        val suggestions: List<MentionSuggestion> = if (isTaskCodeQuery || q.isEmpty()) {
            scoredTasks.map { toTaskSuggestion(it.first) } + matchedProjects
        } else {
            val highPriorityTasks = mutableListOf<MentionSuggestion>()
            val regularTasks = mutableListOf<MentionSuggestion>()
            for ((task, score) in scoredTasks) {
                val suggestion = toTaskSuggestion(task)
                if (score >= 850) {
                    highPriorityTasks.add(suggestion)
                } else {
                    regularTasks.add(suggestion)
                }
            }
            highPriorityTasks + matchedProjects + regularTasks
        }

        return MentionSuggestionsResult(
            suggestions = suggestions,
            scopedProject = null,
        )
    }

    fun suggestionToExplicitMentionTarget(suggestion: MentionSuggestion): ExplicitMentionTarget =
        when (suggestion) {
            is MentionSuggestion.TaskSuggestion -> ExplicitMentionTarget(
                kind = "task",
                taskId = suggestion.task.id,
                taskNumber = suggestion.task.taskNumber,
                taskTitle = suggestion.task.title,
                taskStatus = suggestion.task.status,
                projectId = suggestion.task.projectId,
                projectName = suggestion.task.projectName,
                projectPath = suggestion.task.projectPath,
                projectColorHex = suggestion.projectColorHex,
            )

            is MentionSuggestion.ProjectSuggestion -> ExplicitMentionTarget(
                kind = "project",
                projectId = suggestion.project.id,
                projectName = suggestion.project.name,
                projectPath = suggestion.project.path,
                projectColorHex = suggestion.project.colorHex,
            )
        }

    fun addExplicitMentionTarget(
        current: List<ExplicitMentionTarget>,
        target: ExplicitMentionTarget,
    ): List<ExplicitMentionTarget> {
        val alreadyPresent = current.any { matchesMentionTarget(it, target) }
        return if (alreadyPresent) current else current + target
    }

    fun removeExplicitMentionTarget(
        current: List<ExplicitMentionTarget>,
        target: ExplicitMentionTarget,
    ): List<ExplicitMentionTarget> = current.filterNot { matchesMentionTarget(it, target) }

    fun matchesMentionTarget(a: ExplicitMentionTarget, b: ExplicitMentionTarget): Boolean {
        if (a.kind != b.kind) return false
        return if (a.kind == "task") {
            (!a.taskId.isNullOrBlank() && a.taskId == b.taskId) ||
                (a.taskNumber != null && a.taskNumber > 0 && a.taskNumber == b.taskNumber)
        } else {
            (!a.projectId.isNullOrBlank() && a.projectId == b.projectId) ||
                (!a.projectName.isNullOrBlank() &&
                    !b.projectName.isNullOrBlank() &&
                    a.projectName.equals(b.projectName, ignoreCase = true))
        }
    }

    /**
     * Replaces the active `@...` token with [insertText], optionally appending a single
     * space unless whitespace already follows the caret.
     */
    fun applyMentionSelection(
        text: String,
        query: ActiveMentionQuery,
        insertText: String,
        appendSpace: Boolean = true,
    ): MentionEditResult {
        val safeStart = query.start.coerceIn(0, text.length)
        val safeEnd = query.end.coerceIn(safeStart, text.length)
        val before = text.substring(0, safeStart)
        val after = text.substring(safeEnd)
        val needsSpace = appendSpace && (after.isEmpty() || !after[0].isWhitespace())
        val inserted = if (needsSpace) "$insertText " else insertText
        val nextText = "$before$inserted$after"
        val nextCaret = before.length + inserted.length
        return MentionEditResult(nextText = nextText, nextCaret = nextCaret)
    }

    /**
     * Replaces the active `@...` token with `@<projectName>/` (no trailing space) so the
     * user immediately transitions into `PROJECT_TASKS` autocomplete mode for that project.
     */
    fun applyProjectTaskScope(
        text: String,
        query: ActiveMentionQuery,
        projectName: String,
    ): MentionEditResult = applyMentionSelection(
        text = text,
        query = query,
        insertText = "@$projectName/",
        appendSpace = false,
    )

    /**
     * Removes the active `@query` token after attaching a structured mention chip,
     * cleaning up redundant horizontal spaces around the removed token.
     */
    fun removeActiveMentionQuery(text: String, query: ActiveMentionQuery): MentionEditResult {
        val safeStart = query.start.coerceIn(0, text.length)
        val safeEnd = query.end.coerceIn(safeStart, text.length)
        val updated = removeSpanWithCleanSpacing(text, safeStart, safeEnd, safeEnd)
        if (updated.nextText.trim().isEmpty()) {
            return MentionEditResult(nextText = "", nextCaret = 0, removedCount = 1)
        }
        return updated.copy(
            nextCaret = updated.nextCaret.coerceIn(0, updated.nextText.length),
            removedCount = 1,
        )
    }

    /**
     * Parses inline `@<projectName>`, `@T<number>`, and `@<projectName>/T<number>` mentions
     * against the known project and task lists (longest project name first).
     */
    fun parseAndResolveMentions(
        text: String,
        projects: List<Project>,
        tasks: List<AgentTask>,
    ): List<ParsedInlineMention> {
        if (text.isEmpty() || !text.contains('@')) return emptyList()

        val mentions = mutableListOf<ParsedInlineMention>()
        val projectByLowerName = HashMap<String, Project>(projects.size)
        for (p in projects) {
            val lower = p.name.lowercase()
            if (lower.isNotEmpty()) projectByLowerName.putIfAbsent(lower, p)
        }
        val projectsByLength = projects
            .map { it to it.name.lowercase() }
            .sortedByDescending { it.first.name.length }

        val taskByNumber = HashMap<Int, AgentTask>(tasks.size)
        for (t in tasks) {
            if (t.taskNumber > 0) taskByNumber.putIfAbsent(t.taskNumber, t)
        }

        var i = 0
        while (i < text.length) {
            val nextAt = text.indexOf('@', i)
            if (nextAt == -1) break
            i = nextAt
            if (!isValidMentionPrefix(text, i)) {
                i += 1
                continue
            }

            val rest = text.substring(i + 1)
            val restLower = rest.lowercase()

            // 1. Known `@<projectName>/T<number>`
            var matchedProjectTask = false
            for ((proj, lowerName) in projectsByLength) {
                val projLen = proj.name.length
                if (projLen == 0 || rest.length <= projLen || rest[projLen] != '/') continue
                if (restLower.startsWith(lowerName)) {
                    val afterSlash = rest.substring(projLen + 1)
                    val taskMatch = taskCodePrefixRegex.find(afterSlash)
                    if (taskMatch != null) {
                        val taskNumber = taskMatch.groupValues[1].toIntOrNull()
                        val fullLen = 1 + projLen + 1 + taskMatch.value.length
                        val raw = text.substring(i, i + fullLen)
                        val task = taskNumber?.let { taskByNumber[it] }
                        mentions.add(
                            ParsedInlineMention(
                                raw = raw,
                                start = i,
                                end = i + fullLen,
                                kind = "project_task",
                                projectName = proj.name,
                                taskNumber = taskNumber,
                                project = proj,
                                task = task,
                            ),
                        )
                        i += fullLen
                        matchedProjectTask = true
                        break
                    }
                }
            }
            if (matchedProjectTask) continue

            // 1b. Generic `@<unknownProject>/T<number>`
            val genericMatch = genericProjectTaskRegex.find(rest)
            if (genericMatch != null) {
                val projToken = genericMatch.groupValues[1]
                val taskNumber = genericMatch.groupValues[2].toIntOrNull()
                val fullLen = 1 + genericMatch.value.length
                val raw = text.substring(i, i + fullLen)
                val project = projectByLowerName[projToken.lowercase()]
                val task = taskNumber?.let { taskByNumber[it] }
                mentions.add(
                    ParsedInlineMention(
                        raw = raw,
                        start = i,
                        end = i + fullLen,
                        kind = "project_task",
                        projectName = project?.name ?: projToken,
                        taskNumber = taskNumber,
                        project = project,
                        task = task,
                    ),
                )
                i += fullLen
                continue
            }

            // 2. `@T<number>`
            val taskOnlyMatch = taskCodePrefixRegex.find(rest)
            if (taskOnlyMatch != null) {
                val taskNumber = taskOnlyMatch.groupValues[1].toIntOrNull()
                val fullLen = 1 + taskOnlyMatch.value.length
                val raw = text.substring(i, i + fullLen)
                val task = taskNumber?.let { taskByNumber[it] }
                mentions.add(
                    ParsedInlineMention(
                        raw = raw,
                        start = i,
                        end = i + fullLen,
                        kind = "task",
                        taskNumber = taskNumber,
                        task = task,
                    ),
                )
                i += fullLen
                continue
            }

            // 3. `@<projectName>` (longest match first)
            var matchedProject = false
            for ((proj, lowerName) in projectsByLength) {
                val projLen = proj.name.length
                if (projLen == 0 || rest.length < projLen) continue
                if (!restLower.startsWith(lowerName)) continue

                val nextChar = if (rest.length > projLen) rest[projLen] else null
                if (nextChar == '/') continue
                if (nextChar != null &&
                    asciiTokenCharRegex.matches(proj.name[projLen - 1].toString()) &&
                    asciiTokenCharRegex.matches(nextChar.toString())
                ) {
                    continue
                }

                val fullLen = 1 + projLen
                val raw = text.substring(i, i + fullLen)
                mentions.add(
                    ParsedInlineMention(
                        raw = raw,
                        start = i,
                        end = i + fullLen,
                        kind = "project",
                        projectName = proj.name,
                        project = proj,
                    ),
                )
                i += fullLen
                matchedProject = true
                break
            }
            if (matchedProject) continue

            i += 1
        }

        return mentions
    }

    /**
     * Combines structured `selectedMentions` and any inline `@...` mentions in `text`
     * into deduplicated display chips matching desktop's `extractResolvedMentionChips`.
     */
    fun extractDraftMentionChips(
        text: String,
        projects: List<Project>,
        tasks: List<AgentTask>,
        selectedMentions: List<ExplicitMentionTarget>,
    ): List<DraftMentionChip> {
        val hasSelected = selectedMentions.isNotEmpty()
        val hasInlineAt = text.contains('@')
        if (!hasSelected && !hasInlineAt) return emptyList()

        val chipsByKey = LinkedHashMap<String, DraftMentionChip>()

        fun upsertTaskChip(task: AgentTask, raw: String? = null, fallbackProject: Project? = null) {
            val key = "task:${task.id}"
            val existing = chipsByKey[key] as? DraftMentionChip.TaskChip
            if (existing != null) {
                if (raw != null && raw !in existing.rawMentions) {
                    chipsByKey[key] = existing.copy(rawMentions = existing.rawMentions + raw)
                }
                return
            }
            val taskProject = findProjectForTask(projects, task) ?: fallbackProject
            val projectName = taskProject?.name ?: task.projectName
            val projectColorHex = taskProject?.colorHex?.takeIf { it.isNotBlank() }
                ?: DEFAULT_PROJECT_COLOR_HEX
            chipsByKey[key] = DraftMentionChip.TaskChip(
                key = key,
                taskId = task.id,
                taskNumber = task.taskNumber,
                taskCode = formatTaskCode(task.taskNumber),
                taskTitle = task.title,
                taskStatus = task.status,
                projectId = taskProject?.id ?: task.projectId,
                projectName = projectName,
                projectColorHex = projectColorHex,
                removalTarget = ExplicitMentionTarget(
                    kind = "task",
                    taskId = task.id,
                    taskNumber = task.taskNumber,
                    taskTitle = task.title,
                    taskStatus = task.status,
                    projectId = taskProject?.id ?: task.projectId,
                    projectName = projectName,
                    projectPath = task.projectPath ?: taskProject?.path,
                    projectColorHex = projectColorHex,
                ),
                rawMentions = if (raw != null) listOf(raw) else emptyList(),
            )
        }

        fun upsertProjectChip(project: Project, raw: String? = null) {
            val key = "project:${project.id}"
            val existing = chipsByKey[key] as? DraftMentionChip.ProjectChip
            if (existing != null) {
                if (raw != null && raw !in existing.rawMentions) {
                    chipsByKey[key] = existing.copy(rawMentions = existing.rawMentions + raw)
                }
                return
            }
            val colorHex = project.colorHex.takeIf { it.isNotBlank() } ?: DEFAULT_PROJECT_COLOR_HEX
            chipsByKey[key] = DraftMentionChip.ProjectChip(
                key = key,
                projectId = project.id,
                projectName = project.name,
                projectPath = project.path,
                projectColorHex = colorHex,
                removalTarget = ExplicitMentionTarget(
                    kind = "project",
                    projectId = project.id,
                    projectName = project.name,
                    projectPath = project.path,
                    projectColorHex = colorHex,
                ),
                rawMentions = if (raw != null) listOf(raw) else emptyList(),
            )
        }

        for (target in selectedMentions) {
            if (target.kind == "task") {
                val liveTask = tasks.firstOrNull { task ->
                    (!target.taskId.isNullOrBlank() && task.id == target.taskId) ||
                        (target.taskNumber != null && target.taskNumber > 0 && task.taskNumber == target.taskNumber)
                }
                if (liveTask != null) {
                    upsertTaskChip(liveTask)
                } else {
                    val taskNum = target.taskNumber ?: 0
                    val key = "task:${target.taskId?.takeIf { it.isNotBlank() } ?: taskNum}"
                    if (!chipsByKey.containsKey(key)) {
                        chipsByKey[key] = DraftMentionChip.TaskChip(
                            key = key,
                            taskId = target.taskId,
                            taskNumber = taskNum,
                            taskCode = if (taskNum > 0) formatTaskCode(taskNum) else "T?",
                            taskTitle = target.taskTitle.orEmpty(),
                            taskStatus = target.taskStatus,
                            projectId = target.projectId,
                            projectName = target.projectName.orEmpty(),
                            projectColorHex = target.projectColorHex?.takeIf { it.isNotBlank() }
                                ?: DEFAULT_PROJECT_COLOR_HEX,
                            removalTarget = target,
                        )
                    }
                }
            } else if (target.kind == "project") {
                val liveProject = projects.firstOrNull { proj ->
                    (!target.projectId.isNullOrBlank() && proj.id == target.projectId) ||
                        (!target.projectPath.isNullOrBlank() &&
                            proj.path.trimEnd('/') == target.projectPath.trimEnd('/')) ||
                        (!target.projectName.isNullOrBlank() &&
                            proj.name.equals(target.projectName, ignoreCase = true))
                }
                if (liveProject != null) {
                    upsertProjectChip(liveProject)
                } else {
                    val name = target.projectName?.takeIf { it.isNotBlank() } ?: "Project"
                    val key = "project:${target.projectId?.takeIf { it.isNotBlank() } ?: name.lowercase()}"
                    if (!chipsByKey.containsKey(key)) {
                        chipsByKey[key] = DraftMentionChip.ProjectChip(
                            key = key,
                            projectId = target.projectId,
                            projectName = name,
                            projectPath = target.projectPath,
                            projectColorHex = target.projectColorHex?.takeIf { it.isNotBlank() }
                                ?: DEFAULT_PROJECT_COLOR_HEX,
                            removalTarget = target,
                        )
                    }
                }
            }
        }

        if (hasInlineAt) {
            val resolved = parseAndResolveMentions(text, projects, tasks)
            for (mention in resolved) {
                if ((mention.kind == "task" || mention.kind == "project_task") && mention.task != null) {
                    upsertTaskChip(mention.task, mention.raw, mention.project)
                } else if (mention.kind == "project" && mention.project != null) {
                    upsertProjectChip(mention.project, mention.raw)
                }
            }
        }

        return chipsByKey.values.toList()
    }

    /**
     * Removes all inline `@...` occurrences matching [target] from draft text with clean spacing.
     */
    fun removeResolvedInlineMentions(
        text: String,
        target: ExplicitMentionTarget,
        projects: List<Project>,
        tasks: List<AgentTask>,
        caretPos: Int = text.length,
    ): MentionEditResult {
        val safeCaret = caretPos.coerceIn(0, text.length)
        if (!text.contains('@')) {
            return MentionEditResult(nextText = text, nextCaret = safeCaret, removedCount = 0)
        }
        val resolved = parseAndResolveMentions(text, projects, tasks)
        val matchingSpans = resolved.filter { m ->
            if (target.kind == "task") {
                (m.kind == "task" || m.kind == "project_task") && m.task != null && (
                    (!target.taskId.isNullOrBlank() && m.task.id == target.taskId) ||
                        (target.taskNumber != null && m.task.taskNumber == target.taskNumber)
                    )
            } else {
                m.kind == "project" && m.project != null && (
                    (!target.projectId.isNullOrBlank() && m.project.id == target.projectId) ||
                        (!target.projectName.isNullOrBlank() &&
                            m.project.name.equals(target.projectName, ignoreCase = true))
                    )
            }
        }
        if (matchingSpans.isEmpty()) {
            return MentionEditResult(nextText = text, nextCaret = safeCaret, removedCount = 0)
        }

        var nextText = text
        var nextCaret = safeCaret
        for (idx in matchingSpans.lastIndex downTo 0) {
            val span = matchingSpans[idx]
            val updated = removeSpanWithCleanSpacing(nextText, span.start, span.end, nextCaret)
            nextText = updated.nextText
            nextCaret = updated.nextCaret
        }
        if (nextText.trim().isEmpty()) {
            return MentionEditResult(nextText = "", nextCaret = 0, removedCount = matchingSpans.size)
        }
        return MentionEditResult(
            nextText = nextText,
            nextCaret = nextCaret.coerceIn(0, nextText.length),
            removedCount = matchingSpans.size,
        )
    }

    fun compactProjectPath(fullPath: String): String {
        if (fullPath.isBlank()) return ""
        val normalized = macHomeDirRegex.replaceFirst(fullPath, "~")
        val parts = normalized.split('/')
        if (parts.size <= 3) return normalized
        return "${parts.first()}/…/${parts.takeLast(2).joinToString("/")}"
    }

    private fun removeSpanWithCleanSpacing(
        text: String,
        start: Int,
        end: Int,
        caret: Int,
    ): MentionEditResult {
        var cutStart = start
        var cutEnd = end

        val before = text.substring(0, start)
        val after = text.substring(end)
        val hasSpaceBefore = before.endsWith(' ') || before.endsWith('\t')
        val hasSpaceAfter = after.startsWith(' ') || after.startsWith('\t')
        val atLineStart = before.isEmpty() || before.endsWith('\n')
        val atLineEnd = after.isEmpty() || after.startsWith('\n')
        val onlySpacesUntilLineEnd = onlySpacesUntilLineEndRegex.containsMatchIn(after)

        if (hasSpaceBefore && onlySpacesUntilLineEnd) {
            trailingSpacesRegex.find(before)?.let { cutStart -= it.value.length }
            leadingSpacesRegex.find(after)?.let { cutEnd += it.value.length }
        } else if (hasSpaceBefore && hasSpaceAfter) {
            cutEnd += 1
        } else if (atLineStart && hasSpaceAfter) {
            leadingSpacesRegex.find(after)?.let { cutEnd += it.value.length }
        } else if (hasSpaceBefore && (atLineEnd || trailingPunctRegex.containsMatchIn(after))) {
            trailingSpacesRegex.find(before)?.let { cutStart -= it.value.length }
        }

        val nextText = text.substring(0, cutStart) + text.substring(cutEnd)
        val nextCaret = when {
            caret > cutEnd -> caret - (cutEnd - cutStart)
            caret > cutStart -> cutStart
            else -> caret
        }
        return MentionEditResult(nextText = nextText, nextCaret = nextCaret)
    }
}
