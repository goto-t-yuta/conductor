package dev.conductor.mobile

import dev.conductor.mobile.ui.components.InlineNode
import dev.conductor.mobile.ui.components.MarkdownBlock
import dev.conductor.mobile.ui.components.MarkdownParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MarkdownParserTest {
    @Test
    fun parsesHeadingsParagraphsCodeBlocksAndDividers() {
        val md = """
            # Release Summary

            Updated `Theme.kt` and **ChatScreen**.

            ```kotlin
            val accent = Color(0xFF6366F1)
            ```

            ---

            > All checks passed.
        """.trimIndent()

        val blocks = MarkdownParser.parseBlocks(md)
        assertEquals(5, blocks.size)
        assertEquals(MarkdownBlock.Heading(1, "Release Summary"), blocks[0])
        assertEquals(MarkdownBlock.Paragraph("Updated `Theme.kt` and **ChatScreen**."), blocks[1])
        assertEquals(
            MarkdownBlock.CodeBlock("kotlin", "val accent = Color(0xFF6366F1)"),
            blocks[2],
        )
        assertEquals(MarkdownBlock.Divider, blocks[3])
        assertEquals(MarkdownBlock.Quote("All checks passed."), blocks[4])
    }

    @Test
    fun parsesBulletTaskChecklistsOrderedListsAndTables() {
        val md = """
            - [x] Theme system
            - [ ] Screenshots
            - Plain bullet

            1. Build APK
            2. Launch emulator

            | Screen | Status |
            | --- | --- |
            | Chat | Ready |
            | Tasks | Ready |
        """.trimIndent()

        val blocks = MarkdownParser.parseBlocks(md)
        assertEquals(3, blocks.size)

        val bullets = blocks[0] as MarkdownBlock.BulletList
        assertEquals(3, bullets.items.size)
        assertEquals(true, bullets.items[0].checked)
        assertEquals("Theme system", bullets.items[0].text)
        assertEquals(false, bullets.items[1].checked)
        assertEquals(null, bullets.items[2].checked)

        val ordered = blocks[1] as MarkdownBlock.OrderedList
        assertEquals(2, ordered.items.size)
        assertEquals("1", ordered.items[0].number)
        assertEquals("Launch emulator", ordered.items[1].text)

        val table = blocks[2] as MarkdownBlock.Table
        assertEquals(listOf("Screen", "Status"), table.headers)
        assertEquals(2, table.rows.size)
        assertEquals(listOf("Chat", "Ready"), table.rows[0])
    }

    @Test
    fun parsesInlineFormattingAndPreservesSnakeCase() {
        val nodes = MarkdownParser.parseInline(
            "Check **bold**, *italic*, ~~old~~, `snake_case_var`, snake_case_plain, and [Docs](https://conductor.dev) plus https://example.com.",
        )

        assertTrue(nodes.any { it is InlineNode.Bold })
        assertTrue(nodes.any { it is InlineNode.Italic })
        assertTrue(nodes.any { it is InlineNode.Strike })
        assertTrue(nodes.any { it == InlineNode.Code("snake_case_var") })
        assertTrue(nodes.any { it == InlineNode.Link("Docs", "https://conductor.dev") })
        assertTrue(nodes.any { it == InlineNode.Link("https://example.com", "https://example.com") })
        assertTrue(
            nodes.filterIsInstance<InlineNode.Plain>().any { it.text.contains("snake_case_plain") },
        )
    }

    @Test
    fun parsesStandaloneSpacedAngleBracketAndHtmlImages() {
        val md = """
            修正が完了しました。
            ![Updated UI](</Users/dev/Library/Application Support/Conductor/shot 1.png>)
            ![Bare Spaced](/Users/dev/Library/Application Support/Conductor/shot 2.png "After")
            <img src="/tmp/html-shot.webp" alt="HTML Shot" />
            ![](/tmp/no-alt.jpg)
            テストもすべて通っています。
        """.trimIndent()

        val blocks = MarkdownParser.parseBlocks(md)
        assertEquals(6, blocks.size)
        assertEquals(MarkdownBlock.Paragraph("修正が完了しました。"), blocks[0])
        assertEquals(
            MarkdownBlock.Image(
                alt = "Updated UI",
                src = "/Users/dev/Library/Application Support/Conductor/shot 1.png",
                title = null,
            ),
            blocks[1],
        )
        assertEquals(
            MarkdownBlock.Image(
                alt = "Bare Spaced",
                src = "/Users/dev/Library/Application Support/Conductor/shot 2.png",
                title = "After",
            ),
            blocks[2],
        )
        assertEquals(
            MarkdownBlock.Image(
                alt = "HTML Shot",
                src = "/tmp/html-shot.webp",
                title = null,
            ),
            blocks[3],
        )
        assertEquals(
            MarkdownBlock.Image(
                alt = "",
                src = "/tmp/no-alt.jpg",
                title = null,
            ),
            blocks[4],
        )
        assertEquals(MarkdownBlock.Paragraph("テストもすべて通っています。"), blocks[5])
    }

    @Test
    fun parsesInlineImagesAndIgnoresImagesInsideCode() {
        val inline = MarkdownParser.parseInline(
            "Before ![Preview](/tmp/preview.png) and `![Ignored](/tmp/code.png)` plus [![Linked](https://example.com/a.png)](https://example.com).",
        )
        assertEquals(
            listOf(
                InlineNode.Image("Preview", "/tmp/preview.png", null),
                InlineNode.Image("Linked", "https://example.com/a.png", null),
            ),
            inline.filterIsInstance<InlineNode.Image>(),
        )
        assertTrue(inline.any { it == InlineNode.Code("![Ignored](/tmp/code.png)") })

        val fenced = """
            ```markdown
            ![NotAnImage](/tmp/fenced.png)
            ```
        """.trimIndent()
        val blocks = MarkdownParser.parseBlocks(fenced)
        assertEquals(1, blocks.size)
        assertTrue(blocks[0] is MarkdownBlock.CodeBlock)
    }
}
