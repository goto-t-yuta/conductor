package dev.conductor.mobile

import dev.conductor.mobile.model.ActiveMentionMode
import dev.conductor.mobile.model.AgentTask
import dev.conductor.mobile.model.DraftMentionChip
import dev.conductor.mobile.model.ExplicitMentionTarget
import dev.conductor.mobile.model.MentionAutocomplete
import dev.conductor.mobile.model.MentionSuggestion
import dev.conductor.mobile.model.Project
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MentionAutocompleteTest {
    private val projects = listOf(
        Project(
            id = "p1",
            name = "conductor",
            path = "/Users/dev/Documents/projects/conductor",
            colorHex = "#6366F1",
            gitBranch = "main",
        ),
        Project(
            id = "p2",
            name = "conductor_docs",
            path = "/Users/dev/Documents/projects/conductor_docs",
            colorHex = "#10B981",
            gitBranch = "feat/guide",
        ),
        Project(
            id = "p3",
            name = "web_dashboard",
            path = "/Users/dev/work/web_dashboard",
            colorHex = "#F59E0B",
            gitBranch = "dev",
        ),
    )

    private val tasks = listOf(
        AgentTask(
            id = "task-1",
            taskNumber = 1,
            title = "Add mention autocomplete",
            projectId = "p1",
            projectName = "conductor",
            projectPath = "/Users/dev/Documents/projects/conductor",
            status = "running",
        ),
        AgentTask(
            id = "task-2",
            taskNumber = 2,
            title = "Fix build pipeline",
            projectId = "p3",
            projectName = "web_dashboard",
            projectPath = "/Users/dev/work/web_dashboard",
            status = "needs_review",
        ),
        AgentTask(
            id = "task-12",
            taskNumber = 12,
            title = "Refactor Android chat bar",
            projectId = "p1",
            projectName = "conductor",
            projectPath = "/Users/dev/Documents/projects/conductor",
            status = "done",
        ),
    )

    @Test
    fun detectsActiveMentionForAllAndProjectTaskModesAndIgnoresEmails() {
        val bare = MentionAutocomplete.detectActiveMention("@", 1)
        assertNotNull(bare)
        assertEquals(0, bare!!.start)
        assertEquals(1, bare.end)
        assertEquals("", bare.rawQuery)
        assertEquals(ActiveMentionMode.ALL, bare.mode)

        val japanese = MentionAutocomplete.detectActiveMention("確認して@con", 8)
        assertNotNull(japanese)
        assertEquals(4, japanese!!.start)
        assertEquals("con", japanese.rawQuery)
        assertEquals(ActiveMentionMode.ALL, japanese.mode)

        val scoped = MentionAutocomplete.detectActiveMention("見て @conductor/T1", 16)
        assertNotNull(scoped)
        assertEquals(ActiveMentionMode.PROJECT_TASKS, scoped!!.mode)
        assertEquals("conductor", scoped.projectQuery)
        assertEquals("T1", scoped.taskQuery)

        // Caret mid-sentence right after @T1
        val midSentence = MentionAutocomplete.detectActiveMention("Compare @T1 and @web_dashboard", 11)
        assertNotNull(midSentence)
        assertEquals(8, midSentence!!.start)
        assertEquals(11, midSentence.end)
        assertEquals("T1", midSentence.rawQuery)

        // Email address & invalid slashes must not trigger autocomplete
        assertNull(MentionAutocomplete.detectActiveMention("alice@conductor", 15))
        assertNull(MentionAutocomplete.detectActiveMention("@conductor/T1/extra", 19))
        assertNull(MentionAutocomplete.detectActiveMention("@/T1", 4))
        assertNull(MentionAutocomplete.detectActiveMention("@conductor ", 11))
    }

    @Test
    fun filtersAndRanksSuggestionsByProjectNameTaskCodeAndTitle() {
        // Empty '@' lists tasks first (running -> needs_review -> done), then all projects
        val allRes = MentionAutocomplete.getMentionSuggestions(
            MentionAutocomplete.detectActiveMention("@", 1)!!,
            projects,
            tasks,
        )
        assertNull(allRes.scopedProject)
        val taskIds = allRes.suggestions.filterIsInstance<MentionSuggestion.TaskSuggestion>().map { it.task.id }
        assertEquals(listOf("task-1", "task-2", "task-12"), taskIds)
        val projectSuggestions = allRes.suggestions.filterIsInstance<MentionSuggestion.ProjectSuggestion>()
        assertEquals(listOf("conductor", "conductor_docs", "web_dashboard"), projectSuggestions.map { it.project.name })
        assertEquals(2, projectSuggestions.first { it.project.id == "p1" }.taskCount)
        assertEquals(0, projectSuggestions.first { it.project.id == "p2" }.taskCount)

        // '@T1' prioritizes T1 exact match before T12 prefix match
        val taskCodeRes = MentionAutocomplete.getMentionSuggestions(
            MentionAutocomplete.detectActiveMention("@T1", 3)!!,
            projects,
            tasks,
        )
        val matchingTaskCodes = taskCodeRes.suggestions
            .filterIsInstance<MentionSuggestion.TaskSuggestion>()
            .map { it.insertText }
        assertEquals(listOf("@T1", "@T12"), matchingTaskCodes)

        // '@build' matches task title substring
        val titleRes = MentionAutocomplete.getMentionSuggestions(
            MentionAutocomplete.detectActiveMention("@build", 6)!!,
            projects,
            tasks,
        )
        assertEquals(1, titleRes.suggestions.size)
        val titleHit = titleRes.suggestions.first() as MentionSuggestion.TaskSuggestion
        assertEquals("task-2", titleHit.task.id)

        // '@web' puts project web_dashboard before task referencing web_dashboard
        val projRes = MentionAutocomplete.getMentionSuggestions(
            MentionAutocomplete.detectActiveMention("@web", 4)!!,
            projects,
            tasks,
        )
        assertTrue(projRes.suggestions.first() is MentionSuggestion.ProjectSuggestion)
        assertEquals("@web_dashboard", projRes.suggestions.first().insertText)
    }

    @Test
    fun searchesAcrossAllProjectsBeyondTop30() {
        val manyProjects = (1..42).map { i ->
            Project(
                id = "proj-$i",
                name = if (i == 40) "zulu_deep_project" else "repo_%02d".format(i),
                path = "/Users/dev/code/repo_$i",
            )
        }
        val query = MentionAutocomplete.detectActiveMention("Check @zulu", 11)!!
        val res = MentionAutocomplete.getMentionSuggestions(query, manyProjects, emptyList())
        assertEquals(1, res.suggestions.size)
        assertEquals("@zulu_deep_project", res.suggestions.first().insertText)
    }

    @Test
    fun filtersScopedProjectTasksForProjectSlashQuery() {
        val text = "確認して @conductor/"
        val query = MentionAutocomplete.detectActiveMention(text, text.length)!!
        val res = MentionAutocomplete.getMentionSuggestions(query, projects, tasks)

        assertEquals("conductor", res.scopedProject?.name)
        assertEquals(listOf("@conductor/T1", "@conductor/T12"), res.suggestions.map { it.insertText })

        val narrowed = MentionAutocomplete.detectActiveMention("確認して @conductor/refactor", 24)!!
        val narrowedRes = MentionAutocomplete.getMentionSuggestions(narrowed, projects, tasks)
        assertEquals(listOf("@conductor/T12"), narrowedRes.suggestions.map { it.insertText })
    }

    @Test
    fun appliesInlineMentionSelectionAndProjectScopeCleanly() {
        val text = "Please inspect @conductor/"
        val query = MentionAutocomplete.detectActiveMention(text, text.length)!!
        val applied = MentionAutocomplete.applyMentionSelection(text, query, "@conductor/T1")
        assertEquals("Please inspect @conductor/T1 ", applied.nextText)
        assertEquals(applied.nextText.length, applied.nextCaret)

        // Mid-sentence does not double trailing space
        val mid = "Compare @T1 and @web_dashboard"
        val midQuery = MentionAutocomplete.detectActiveMention(mid, 11)!!
        val midApplied = MentionAutocomplete.applyMentionSelection(mid, midQuery, "@T2")
        assertEquals("Compare @T2 and @web_dashboard", midApplied.nextText)
        assertEquals(11, midApplied.nextCaret)

        // Project scope drill-down inserts '@conductor/' with no trailing space so popup stays in PROJECT_TASKS mode
        val scopeQuery = MentionAutocomplete.detectActiveMention("確認 @con", 7)!!
        val scopedEdit = MentionAutocomplete.applyProjectTaskScope("確認 @con", scopeQuery, "conductor")
        assertEquals("確認 @conductor/", scopedEdit.nextText)
        assertEquals(scopedEdit.nextText.length, scopedEdit.nextCaret)
        val nextQuery = MentionAutocomplete.detectActiveMention(scopedEdit.nextText, scopedEdit.nextCaret)
        assertEquals(ActiveMentionMode.PROJECT_TASKS, nextQuery?.mode)
        assertEquals("conductor", nextQuery?.projectQuery)
    }

    @Test
    fun removesActiveMentionQueryCleanlyOnChipAttachment() {
        val q1 = MentionAutocomplete.detectActiveMention("@web", 4)!!
        assertEquals(
            "" to 0,
            MentionAutocomplete.removeActiveMentionQuery("@web", q1).let { it.nextText to it.nextCaret },
        )

        val draft2 = "確認して @T1"
        val q2 = MentionAutocomplete.detectActiveMention(draft2, draft2.length)!!
        val r2 = MentionAutocomplete.removeActiveMentionQuery(draft2, q2)
        assertEquals("確認して", r2.nextText)
        assertEquals(4, r2.nextCaret)

        val draft3 = "これを @conductor/T1 確認して"
        val q3 = MentionAutocomplete.detectActiveMention(draft3, draft3.indexOf(" 確認"))!!
        val r3 = MentionAutocomplete.removeActiveMentionQuery(draft3, q3)
        assertEquals("これを 確認して", r3.nextText)
        assertEquals(4, r3.nextCaret)

        val draft4 = "@web ビルドを確認して"
        val q4 = MentionAutocomplete.detectActiveMention(draft4, 4)!!
        val r4 = MentionAutocomplete.removeActiveMentionQuery(draft4, q4)
        assertEquals("ビルドを確認して", r4.nextText)
        assertEquals(0, r4.nextCaret)

        val draft5 = "確認して@T12"
        val q5 = MentionAutocomplete.detectActiveMention(draft5, draft5.length)!!
        val r5 = MentionAutocomplete.removeActiveMentionQuery(draft5, q5)
        assertEquals("確認して", r5.nextText)
        assertEquals(4, r5.nextCaret)
    }

    @Test
    fun extractsDeduplicatedDraftMentionChipsAndRemovesInlineTokensCleanly() {
        val selected = listOf(
            MentionAutocomplete.suggestionToExplicitMentionTarget(
                MentionAutocomplete.getMentionSuggestions(
                    MentionAutocomplete.detectActiveMention("@T1", 3)!!,
                    projects,
                    tasks,
                ).suggestions.first(),
            ),
        )

        val draft = "@conductor/T1 と @conductor_docs と @T12 を確認して dev@conductor.com"
        val chips = MentionAutocomplete.extractDraftMentionChips(draft, projects, tasks, selected)
        assertEquals(3, chips.size)
        assertEquals("task:task-1", chips[0].key)
        assertEquals("project:p2", chips[1].key)
        assertEquals("task:task-12", chips[2].key)

        val task1Chip = chips[0] as DraftMentionChip.TaskChip
        assertEquals("T1", task1Chip.taskCode)
        assertEquals("conductor", task1Chip.projectName)
        assertEquals("#6366F1", task1Chip.projectColorHex)

        // Removing project p2 strips @conductor_docs without touching @conductor/T1 or @T12
        val removedProj = MentionAutocomplete.removeResolvedInlineMentions(
            text = draft,
            target = ExplicitMentionTarget(kind = "project", projectId = "p2", projectName = "conductor_docs"),
            projects = projects,
            tasks = tasks,
        )
        assertEquals("@conductor/T1 と と @T12 を確認して dev@conductor.com", removedProj.nextText)
        assertEquals(1, removedProj.removedCount)
    }

    @Test
    fun compactsLongProjectPathsLikeDesktop() {
        assertEquals(
            "~/…/projects/conductor",
            MentionAutocomplete.compactProjectPath("/Users/dev/Documents/projects/conductor"),
        )
        assertEquals(
            "~/work/app",
            MentionAutocomplete.compactProjectPath("/Users/dev/work/app"),
        )
    }
}
