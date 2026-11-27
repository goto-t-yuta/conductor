package dev.conductor.mobile.ui.components

/**
 * Lightweight, pure-Kotlin Markdown AST parser supporting the subset used across
 * Conductor chat responses and task reports:
 * - ATX headings (# .. ####)
 * - Paragraphs (preserving soft line breaks cleanly)
 * - Fenced code blocks (```lang ... ```)
 * - Unordered & ordered lists, including task-list checkboxes (- [ ] / - [x])
 * - Blockquotes (> ...)
 * - Horizontal rules (--- / *** / ___)
 * - GitHub-Flavored Markdown tables (| a | b |)
 * - Inline bold, italic, bold-italic, strikethrough, inline code, links, and autolinks
 */
sealed interface MarkdownBlock {
    data class Heading(val level: Int, val text: String) : MarkdownBlock
    data class Paragraph(val text: String) : MarkdownBlock
    data class CodeBlock(val language: String?, val code: String) : MarkdownBlock
    data class Quote(val text: String) : MarkdownBlock
    data class BulletList(val items: List<ListItem>) : MarkdownBlock
    data class OrderedList(val items: List<OrderedListItem>) : MarkdownBlock
    data class Table(val headers: List<String>, val rows: List<List<String>>) : MarkdownBlock
    data object Divider : MarkdownBlock
}

data class ListItem(
    val text: String,
    val indentLevel: Int = 0,
    val checked: Boolean? = null,
)

data class OrderedListItem(
    val number: String,
    val text: String,
    val indentLevel: Int = 0,
)

sealed interface InlineNode {
    data class Plain(val text: String) : InlineNode
    data class Bold(val children: List<InlineNode>) : InlineNode
    data class Italic(val children: List<InlineNode>) : InlineNode
    data class BoldItalic(val children: List<InlineNode>) : InlineNode
    data class Strike(val children: List<InlineNode>) : InlineNode
    data class Code(val code: String) : InlineNode
    data class Link(val label: String, val url: String) : InlineNode
}

object MarkdownParser {
    private val headingRegex = Regex("""^(#{1,4})\s+(.+?)\s*#*$""")
    private val dividerRegex = Regex("""^\s*(?:[-*_]\s*){3,}$""")
    private val fenceOpenRegex = Regex("""^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+#.\-]*)\s*$""")
    private val unorderedRegex = Regex("""^(\s*)[-*+]\s+(.*)$""")
    private val taskPrefixRegex = Regex("""^\[([ xX])\]\s+(.*)$""")
    private val orderedRegex = Regex("""^(\s*)(\d+)\.\s+(.*)$""")
    private val tableSeparatorCellRegex = Regex("""^:?-{2,}:?$""")

    fun parseBlocks(markdown: String): List<MarkdownBlock> {
        if (markdown.isBlank()) return emptyList()
        val lines = markdown.replace("\r\n", "\n").replace('\r', '\n').split('\n')
        val blocks = mutableListOf<MarkdownBlock>()
        var i = 0

        while (i < lines.size) {
            val line = lines[i]
            val trimmed = line.trim()

            if (trimmed.isEmpty()) {
                i++
                continue
            }

            // Fenced code block
            val fenceMatch = fenceOpenRegex.matchEntire(line)
            if (fenceMatch != null) {
                val fenceMarker = fenceMatch.groupValues[1]
                val fenceChar = fenceMarker.first()
                val fenceLen = fenceMarker.length
                val lang = fenceMatch.groupValues[2].ifBlank { null }
                i++
                val codeLines = mutableListOf<String>()
                while (i < lines.size) {
                    val closingTrimmed = lines[i].trim()
                    if (closingTrimmed.length >= fenceLen &&
                        closingTrimmed.all { it == fenceChar }
                    ) {
                        i++
                        break
                    }
                    codeLines.add(lines[i])
                    i++
                }
                blocks.add(MarkdownBlock.CodeBlock(language = lang, code = codeLines.joinToString("\n")))
                continue
            }

            // Heading
            val headingMatch = headingRegex.matchEntire(trimmed)
            if (headingMatch != null) {
                blocks.add(
                    MarkdownBlock.Heading(
                        level = headingMatch.groupValues[1].length,
                        text = headingMatch.groupValues[2].trim(),
                    ),
                )
                i++
                continue
            }

            // Horizontal rule
            if (dividerRegex.matches(line)) {
                blocks.add(MarkdownBlock.Divider)
                i++
                continue
            }

            // Table (header row + separator row)
            if (i + 1 < lines.size && isTableRow(line) && isTableSeparatorRow(lines[i + 1])) {
                val headers = splitTableRow(line)
                i += 2
                val rows = mutableListOf<List<String>>()
                while (i < lines.size && lines[i].isNotBlank() && isTableRow(lines[i])) {
                    val cells = splitTableRow(lines[i])
                    val normalized = if (cells.size < headers.size) {
                        cells + List(headers.size - cells.size) { "" }
                    } else {
                        cells.take(headers.size)
                    }
                    rows.add(normalized)
                    i++
                }
                blocks.add(MarkdownBlock.Table(headers = headers, rows = rows))
                continue
            }

            // Blockquote
            if (trimmed.startsWith(">")) {
                val quoteLines = mutableListOf<String>()
                while (i < lines.size) {
                    val cur = lines[i].trim()
                    if (!cur.startsWith(">")) break
                    quoteLines.add(cur.removePrefix(">").removePrefix(" "))
                    i++
                }
                blocks.add(MarkdownBlock.Quote(quoteLines.joinToString("\n").trim()))
                continue
            }

            // Unordered list (including task checklists)
            if (unorderedRegex.matches(line)) {
                val items = mutableListOf<ListItem>()
                while (i < lines.size) {
                    val match = unorderedRegex.matchEntire(lines[i]) ?: break
                    val indent = (match.groupValues[1].length / 2).coerceAtMost(3)
                    val body = match.groupValues[2].trim()
                    val taskMatch = taskPrefixRegex.matchEntire(body)
                    if (taskMatch != null) {
                        items.add(
                            ListItem(
                                text = taskMatch.groupValues[2].trim(),
                                indentLevel = indent,
                                checked = taskMatch.groupValues[1].equals("x", ignoreCase = true),
                            ),
                        )
                    } else {
                        items.add(ListItem(text = body, indentLevel = indent))
                    }
                    i++
                }
                blocks.add(MarkdownBlock.BulletList(items))
                continue
            }

            // Ordered list
            if (orderedRegex.matches(line)) {
                val items = mutableListOf<OrderedListItem>()
                while (i < lines.size) {
                    val match = orderedRegex.matchEntire(lines[i]) ?: break
                    val indent = (match.groupValues[1].length / 2).coerceAtMost(3)
                    items.add(
                        OrderedListItem(
                            number = match.groupValues[2],
                            text = match.groupValues[3].trim(),
                            indentLevel = indent,
                        ),
                    )
                    i++
                }
                blocks.add(MarkdownBlock.OrderedList(items))
                continue
            }

            // Paragraph (accumulate until blank line or next block construct)
            val paraLines = mutableListOf<String>()
            while (i < lines.size) {
                val cur = lines[i]
                val curTrimmed = cur.trim()
                if (curTrimmed.isEmpty()) break
                if (paraLines.isNotEmpty() && (
                        fenceOpenRegex.matches(cur) ||
                            headingRegex.matches(curTrimmed) ||
                            dividerRegex.matches(cur) ||
                            curTrimmed.startsWith(">") ||
                            unorderedRegex.matches(cur) ||
                            orderedRegex.matches(cur) ||
                            (i + 1 < lines.size && isTableRow(cur) && isTableSeparatorRow(lines[i + 1]))
                        )
                ) {
                    break
                }
                paraLines.add(cur.trimEnd())
                i++
            }
            if (paraLines.isNotEmpty()) {
                blocks.add(MarkdownBlock.Paragraph(paraLines.joinToString("\n")))
            }
        }

        return blocks
    }

    fun parseInline(text: String): List<InlineNode> {
        if (text.isEmpty()) return emptyList()
        val result = mutableListOf<InlineNode>()
        val plainBuf = StringBuilder()
        var i = 0
        val n = text.length

        fun flushPlain() {
            if (plainBuf.isNotEmpty()) {
                result.add(InlineNode.Plain(plainBuf.toString()))
                plainBuf.clear()
            }
        }

        while (i < n) {
            // Backslash escape for common Markdown punctuation
            if (text[i] == '\\' && i + 1 < n && text[i + 1] in "\\`*_{}[]()#+-.!~|") {
                plainBuf.append(text[i + 1])
                i += 2
                continue
            }

            // Inline code: `...`
            if (text[i] == '`') {
                val end = text.indexOf('`', startIndex = i + 1)
                if (end > i + 1) {
                    flushPlain()
                    result.add(InlineNode.Code(text.substring(i + 1, end)))
                    i = end + 1
                    continue
                }
            }

            // Markdown link: [label](url)
            if (text[i] == '[') {
                val closeBracket = findMatchingBracket(text, i)
                if (closeBracket > i + 1 && closeBracket + 1 < n && text[closeBracket + 1] == '(') {
                    val closeParen = text.indexOf(')', startIndex = closeBracket + 2)
                    if (closeParen > closeBracket + 2) {
                        val label = text.substring(i + 1, closeBracket)
                        val url = text.substring(closeBracket + 2, closeParen).trim()
                        if (url.isNotEmpty()) {
                            flushPlain()
                            result.add(InlineNode.Link(label = label, url = url))
                            i = closeParen + 1
                            continue
                        }
                    }
                }
            }

            // Autolink: https://... or http://...
            if (text.startsWith("https://", i) || text.startsWith("http://", i)) {
                var end = i
                while (end < n && !text[end].isWhitespace() && text[end] !in "<>()[]{}\"") {
                    end++
                }
                var url = text.substring(i, end)
                while (url.isNotEmpty() && url.last() in ".,;:!?") {
                    url = url.dropLast(1)
                    end--
                }
                if (url.length > 8) {
                    flushPlain()
                    result.add(InlineNode.Link(label = url, url = url))
                    i = end
                    continue
                }
            }

            // Bold + Italic: ***text***
            if (text.startsWith("***", i)) {
                val end = text.indexOf("***", startIndex = i + 3)
                if (end > i + 3) {
                    flushPlain()
                    result.add(InlineNode.BoldItalic(parseInline(text.substring(i + 3, end))))
                    i = end + 3
                    continue
                }
            }

            // Bold: **text** or __text__
            if (text.startsWith("**", i)) {
                val end = text.indexOf("**", startIndex = i + 2)
                if (end > i + 2) {
                    flushPlain()
                    result.add(InlineNode.Bold(parseInline(text.substring(i + 2, end))))
                    i = end + 2
                    continue
                }
            }
            if (text.startsWith("__", i)) {
                val end = text.indexOf("__", startIndex = i + 2)
                if (end > i + 2) {
                    flushPlain()
                    result.add(InlineNode.Bold(parseInline(text.substring(i + 2, end))))
                    i = end + 2
                    continue
                }
            }

            // Strikethrough: ~~text~~
            if (text.startsWith("~~", i)) {
                val end = text.indexOf("~~", startIndex = i + 2)
                if (end > i + 2) {
                    flushPlain()
                    result.add(InlineNode.Strike(parseInline(text.substring(i + 2, end))))
                    i = end + 2
                    continue
                }
            }

            // Italic: *text* (avoid matching standalone bullet or spaces)
            if (text[i] == '*' && i + 1 < n && !text[i + 1].isWhitespace()) {
                val end = text.indexOf('*', startIndex = i + 1)
                if (end > i + 1 && !text[end - 1].isWhitespace()) {
                    flushPlain()
                    result.add(InlineNode.Italic(parseInline(text.substring(i + 1, end))))
                    i = end + 1
                    continue
                }
            }

            // Italic: _text_ (word-boundary safe so snake_case_identifiers stay intact)
            if (text[i] == '_' &&
                (i == 0 || !text[i - 1].isLetterOrDigit()) &&
                i + 1 < n && !text[i + 1].isWhitespace()
            ) {
                val end = text.indexOf('_', startIndex = i + 1)
                if (end > i + 1 &&
                    !text[end - 1].isWhitespace() &&
                    (end + 1 == n || !text[end + 1].isLetterOrDigit())
                ) {
                    flushPlain()
                    result.add(InlineNode.Italic(parseInline(text.substring(i + 1, end))))
                    i = end + 1
                    continue
                }
            }

            plainBuf.append(text[i])
            i++
        }

        flushPlain()
        return result
    }

    private fun findMatchingBracket(text: String, openIndex: Int): Int {
        var depth = 0
        for (idx in openIndex until text.length) {
            when (text[idx]) {
                '[' -> depth++
                ']' -> {
                    depth--
                    if (depth == 0) return idx
                }
            }
        }
        return -1
    }

    private fun isTableRow(line: String): Boolean {
        val trimmed = line.trim()
        return trimmed.contains('|') && splitTableRow(trimmed).size >= 2
    }

    private fun isTableSeparatorRow(line: String): Boolean {
        val cells = splitTableRow(line)
        return cells.size >= 2 && cells.all { tableSeparatorCellRegex.matches(it.trim()) }
    }

    private fun splitTableRow(line: String): List<String> {
        var trimmed = line.trim()
        if (trimmed.startsWith("|")) trimmed = trimmed.substring(1)
        if (trimmed.endsWith("|")) trimmed = trimmed.dropLast(1)
        return trimmed.split('|').map { it.trim() }
    }
}
