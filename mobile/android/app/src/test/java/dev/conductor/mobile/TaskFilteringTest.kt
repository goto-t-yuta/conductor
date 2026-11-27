package dev.conductor.mobile

import dev.conductor.mobile.model.AgentTask
import dev.conductor.mobile.model.Project
import dev.conductor.mobile.model.TaskFiltering
import org.junit.Assert.assertEquals
import org.junit.Test

class TaskFilteringTest {
    private val projects = listOf(
        Project(id = "p1", name = "conductor", colorHex = "#6366F1"),
        Project(id = "p2", name = "web-app", colorHex = "#10B981"),
        Project(id = "p3", name = "unused-repo", colorHex = "#F59E0B"),
    )

    private val tasks = listOf(
        AgentTask(
            id = "t1",
            taskNumber = 12,
            title = "Refresh Android UI theme",
            projectId = "p1",
            projectName = "conductor",
            status = "running",
            worktreeBranch = "conductor/task-12",
        ),
        AgentTask(
            id = "t2",
            taskNumber = 14,
            title = "Fix OAuth redirect",
            projectId = "p2",
            projectName = "web-app",
            status = "needs_review",
        ),
        AgentTask(
            id = "t3",
            taskNumber = 9,
            title = "Add dark mode toggle",
            projectId = "p1",
            projectName = "conductor",
            status = "done",
        ),
    )

    @Test
    fun filtersByProjectAndSearchQueryIncludingTaskCode() {
        val byProject = TaskFiltering.filterTasks(tasks, selectedProjectId = "p1", query = "")
        assertEquals(listOf("t1", "t3"), byProject.map { it.id })

        val byCode = TaskFiltering.filterTasks(tasks, selectedProjectId = null, query = "T14")
        assertEquals(listOf("t2"), byCode.map { it.id })

        val byBranch = TaskFiltering.filterTasks(tasks, selectedProjectId = null, query = "task-12")
        assertEquals(listOf("t1"), byBranch.map { it.id })
    }

    @Test
    fun partitionsActiveAndCompletedAndGroupsByProject() {
        val partitioned = TaskFiltering.partitionTasks(tasks)
        assertEquals(listOf("t1", "t2"), partitioned.activeTasks.map { it.id })
        assertEquals(listOf("t3"), partitioned.completedTasks.map { it.id })

        val groups = TaskFiltering.groupByProject(tasks, projects)
        assertEquals(2, groups.size)
        assertEquals("conductor", groups[0].projectName)
        assertEquals(1, groups[0].runningCount)
        assertEquals(0, groups[0].needsReviewCount)
        assertEquals("web-app", groups[1].projectName)
        assertEquals(1, groups[1].needsReviewCount)
    }

    @Test
    fun returnsOnlyQuickFilterProjectsWithTasksOrActiveSelection() {
        val quick = TaskFiltering.quickFilterProjects(projects, tasks, selectedProjectId = null)
        assertEquals(listOf("p1", "p2"), quick.map { it.id })
    }
}
