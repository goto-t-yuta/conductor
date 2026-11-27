package dev.conductor.mobile.model

data class TaskProjectGroup(
    val groupKey: String,
    val projectId: String?,
    val projectName: String,
    val colorHex: String,
    val tasks: List<AgentTask>,
    val runningCount: Int,
    val needsReviewCount: Int,
)

data class PartitionedTasks(
    val activeTasks: List<AgentTask>,
    val completedTasks: List<AgentTask>,
)

object TaskFiltering {
    fun filterTasks(
        tasks: List<AgentTask>,
        selectedProjectId: String?,
        query: String,
    ): List<AgentTask> {
        val normalizedQuery = query.trim().lowercase()
        return tasks.filter { task ->
            val matchesProject = selectedProjectId == null || task.projectId == selectedProjectId
            if (!matchesProject) return@filter false
            if (normalizedQuery.isEmpty()) return@filter true

            val code = "t${task.taskNumber}"
            code.contains(normalizedQuery) ||
                "@$code".contains(normalizedQuery) ||
                task.title.lowercase().contains(normalizedQuery) ||
                task.projectName.lowercase().contains(normalizedQuery) ||
                task.summary.lowercase().contains(normalizedQuery) ||
                (task.currentStep?.lowercase()?.contains(normalizedQuery) == true) ||
                (task.worktreeBranch?.lowercase()?.contains(normalizedQuery) == true)
        }
    }

    fun partitionTasks(tasks: List<AgentTask>): PartitionedTasks {
        val active = mutableListOf<AgentTask>()
        val completed = mutableListOf<AgentTask>()
        for (task in tasks) {
            if (task.status == "done") {
                completed.add(task)
            } else {
                active.add(task)
            }
        }
        // Keep running tasks prioritized, then needs_review/failed, then queued
        val sortedActive = active.sortedBy { statusSortPriority(it.status) }
        return PartitionedTasks(activeTasks = sortedActive, completedTasks = completed)
    }

    fun groupByProject(
        tasks: List<AgentTask>,
        projects: List<Project>,
    ): List<TaskProjectGroup> {
        if (tasks.isEmpty()) return emptyList()
        val projectById = projects.associateBy { it.id }
        val projectByName = projects.associateBy { it.name.lowercase() }

        val grouped = LinkedHashMap<String, MutableList<AgentTask>>()
        for (task in tasks) {
            val resolvedProject = task.projectId?.let { projectById[it] }
                ?: projectByName[task.projectName.lowercase()]
            val key = resolvedProject?.id?.let { "id:$it" }
                ?: "name:${task.projectName.ifBlank { "General" }.lowercase()}"
            grouped.getOrPut(key) { mutableListOf() }.add(task)
        }

        return grouped.map { (key, groupTasks) ->
            val sample = groupTasks.first()
            val resolvedProject = sample.projectId?.let { projectById[it] }
                ?: projectByName[sample.projectName.lowercase()]
            TaskProjectGroup(
                groupKey = key,
                projectId = resolvedProject?.id ?: sample.projectId,
                projectName = resolvedProject?.name ?: sample.projectName.ifBlank { "General" },
                colorHex = resolvedProject?.colorHex ?: "#6366F1",
                tasks = groupTasks,
                runningCount = groupTasks.count { it.status == "running" },
                needsReviewCount = groupTasks.count { it.status == "needs_review" },
            )
        }
    }

    fun quickFilterProjects(
        projects: List<Project>,
        tasks: List<AgentTask>,
        selectedProjectId: String?,
    ): List<Project> {
        val activeIds = buildSet {
            tasks.mapNotNullTo(this) { it.projectId }
            if (selectedProjectId != null) add(selectedProjectId)
        }
        return projects.filter { it.id in activeIds }
    }

    private fun statusSortPriority(status: String): Int = when (status) {
        "running" -> 0
        "needs_review" -> 1
        "failed" -> 2
        "queued" -> 3
        else -> 4
    }
}
