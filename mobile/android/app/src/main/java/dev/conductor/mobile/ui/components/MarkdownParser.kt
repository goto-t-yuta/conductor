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
    data class Image(val alt: String, val src: String, val title: String? = null) : MarkdownBlock
    data class Video(
        val alt: String,
        val src: String,
        val title: String? = null,
        val poster: String? = null,
    ) : MarkdownBlock
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
    data class Image(val alt: String, val src: String, val title: String? = null) : InlineNode
    data class Video(
        val alt: String,
        val src: String,
        val title: String? = null,
        val poster: String? = null,
    ) : InlineNode
}

object MarkdownParser {
    private val headingRegex = Regex("""^(#{1,4})\s+(.+?)\s*#*$""")
    private val dividerRegex = Regex("""^\s*(?:[-*_]\s*){3,}$""")
    private val fenceOpenRegex = Regex("""^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+#.\-]*)\s*$""")
    private val unorderedRegex = Regex("""^(\s*)[-*+]\s+(.*)$""")
    private val taskPrefixRegex = Regex("""^\[([ xX])\]\s+(.*)$""")
    private val orderedRegex = Regex("""^(\s*)(\d+)\.\s+(.*)$""")
    private val tableSeparatorCellRegex = Regex("""^:?-{2,}:?$""")
    private val htmlImgTagRegex = Regex("""^<img\b([^>]*?)/?>""", RegexOption.IGNORE_CASE)
    private val htmlVideoTagRegex = Regex(
        """^<video\b([^>]*?)(?:/>|>([\s\S]*?)</video>)""",
        RegexOption.IGNORE_CASE,
    )
    private val htmlSourceTagRegex = Regex("""<source\b([^>]*?)/?>""", RegexOption.IGNORE_CASE)
    private val htmlAttrRegex = Regex("""([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))""")
    private val optionalTitleSuffixRegex = Regex("""^(.*?\S)\s+(?:"([^"\r\n]*)"|'([^'\r\n]*)')$""")

    private data class ParsedImageToken(
        val alt: String,
        val src: String,
        val title: String?,
        val endIndex: Int,
    )

    private data class ParsedVideoToken(
        val alt: String,
        val src: String,
        val title: String?,
        val poster: String?,
        val endIndex: Int,
    )

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

            // Standalone image line: ![alt](src), ![alt](<src with spaces>), or <img src="..." />
            val standaloneImage = parseStandaloneImageLine(trimmed)
            if (standaloneImage != null) {
                blocks.add(
                    MarkdownBlock.Image(
                        alt = standaloneImage.alt,
                        src = standaloneImage.src,
                        title = standaloneImage.title,
                    ),
                )
                i++
                continue
            }

            // Standalone HTML <video ...>...</video> (single-line or multi-line)
            val standaloneVideo = parseStandaloneHtmlVideoBlock(lines, i)
            if (standaloneVideo != null) {
                blocks.add(
                    MarkdownBlock.Video(
                        alt = standaloneVideo.first.alt,
                        src = standaloneVideo.first.src,
                        title = standaloneVideo.first.title,
                        poster = standaloneVideo.first.poster,
                    ),
                )
                i = standaloneVideo.second
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
                            parseStandaloneImageLine(curTrimmed) != null ||
                            parseStandaloneHtmlVideoBlock(lines, i) != null ||
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

            // Markdown image: ![alt](src) or ![alt](<src with spaces>)
            if (text[i] == '!' && i + 1 < n && text[i + 1] == '[') {
                val parsedImg = parseMarkdownImageAt(text, i)
                if (parsedImg != null) {
                    flushPlain()
                    result.add(
                        InlineNode.Image(
                            alt = parsedImg.alt,
                            src = parsedImg.src,
                            title = parsedImg.title,
                        ),
                    )
                    i = parsedImg.endIndex
                    continue
                }
            }

            // HTML <video ...>...</video> or <video ... />
            if (text[i] == '<' && text.startsWith("<video", i, ignoreCase = true)) {
                val parsedHtmlVideo = parseHtmlVideoAt(text, i)
                if (parsedHtmlVideo != null) {
                    flushPlain()
                    result.add(
                        InlineNode.Video(
                            alt = parsedHtmlVideo.alt,
                            src = parsedHtmlVideo.src,
                            title = parsedHtmlVideo.title,
                            poster = parsedHtmlVideo.poster,
                        ),
                    )
                    i = parsedHtmlVideo.endIndex
                    continue
                }
            }

            // HTML <img src="..." alt="..." />
            if (text[i] == '<' && (text.startsWith("<img", i, ignoreCase = true))) {
                val parsedHtmlImg = parseHtmlImageAt(text, i)
                if (parsedHtmlImg != null) {
                    flushPlain()
                    result.add(
                        InlineNode.Image(
                            alt = parsedHtmlImg.alt,
                            src = parsedHtmlImg.src,
                            title = parsedHtmlImg.title,
                        ),
                    )
                    i = parsedHtmlImg.endIndex
                    continue
                }
            }

            // Markdown link: [label](url) (also handles linked image [![alt](img)](href))
            if (text[i] == '[') {
                val closeBracket = findMatchingBracket(text, i)
                if (closeBracket > i + 1 && closeBracket + 1 < n && text[closeBracket + 1] == '(') {
                    val closeParen = findMatchingLinkDestinationEnd(text, closeBracket + 1)
                    if (closeParen > closeBracket + 2) {
                        val label = text.substring(i + 1, closeBracket)
                        val url = unwrapAngleBrackets(text.substring(closeBracket + 2, closeParen).trim())
                        if (url.isNotEmpty()) {
                            val nestedImg = parseStandaloneImageLine(label.trim())
                            if (nestedImg != null) {
                                flushPlain()
                                result.add(
                                    InlineNode.Image(
                                        alt = nestedImg.alt,
                                        src = nestedImg.src,
                                        title = nestedImg.title,
                                    ),
                                )
                                i = closeParen + 1
                                continue
                            }
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

    private fun parseStandaloneImageLine(trimmedLine: String): ParsedImageToken? {
        if (trimmedLine.isEmpty()) return null
        if (trimmedLine.startsWith("![")) {
            val img = parseMarkdownImageAt(trimmedLine, 0)
            if (img != null && img.endIndex == trimmedLine.length) return img
        }
        if (trimmedLine.startsWith("<img", ignoreCase = true)) {
            val htmlImg = parseHtmlImageAt(trimmedLine, 0)
            if (htmlImg != null && htmlImg.endIndex == trimmedLine.length) return htmlImg
        }
        // Linked image on its own line: [![alt](img.png)](https://...)
        if (trimmedLine.startsWith("[![")) {
            val closeBracket = findMatchingBracket(trimmedLine, 0)
            if (closeBracket > 2 && closeBracket + 1 < trimmedLine.length && trimmedLine[closeBracket + 1] == '(') {
                val closeParen = findMatchingLinkDestinationEnd(trimmedLine, closeBracket + 1)
                if (closeParen == trimmedLine.length - 1) {
                    val inner = trimmedLine.substring(1, closeBracket).trim()
                    val nested = parseMarkdownImageAt(inner, 0)
                    if (nested != null && nested.endIndex == inner.length) {
                        return nested.copy(endIndex = trimmedLine.length)
                    }
                }
            }
        }
        return null
    }

    private fun parseMarkdownImageAt(text: String, startIndex: Int): ParsedImageToken? {
        if (startIndex + 3 >= text.length) return null
        if (text[startIndex] != '!' || text[startIndex + 1] != '[') return null
        val closeBracket = findMatchingBracket(text, startIndex + 1)
        if (closeBracket < startIndex + 2 || closeBracket + 1 >= text.length) return null
        if (text[closeBracket + 1] != '(') return null

        val openParen = closeBracket + 1
        val closeParen = findMatchingLinkDestinationEnd(text, openParen)
        if (closeParen <= openParen + 1) return null

        val alt = text.substring(startIndex + 2, closeBracket)
        val rawInner = text.substring(openParen + 1, closeParen).trim()
        if (rawInner.isEmpty()) return null

        val (src, title) = parseDestinationAndTitle(rawInner)
        if (src.isEmpty()) return null

        return ParsedImageToken(
            alt = alt,
            src = src,
            title = title,
            endIndex = closeParen + 1,
        )
    }

    private fun parseHtmlImageAt(text: String, startIndex: Int): ParsedImageToken? {
        val slice = text.substring(startIndex)
        val match = htmlImgTagRegex.find(slice) ?: return null
        val attrBody = match.groupValues[1]
        var src = ""
        var alt = ""
        var title: String? = null
        for (attr in htmlAttrRegex.findAll(attrBody)) {
            val name = attr.groupValues[1].lowercase()
            val value = attr.groupValues[2].ifEmpty {
                attr.groupValues[3].ifEmpty { attr.groupValues[4] }
            }.trim()
            when (name) {
                "src" -> src = value
                "alt" -> alt = value
                "title" -> if (value.isNotEmpty()) title = value
            }
        }
        if (src.isEmpty()) return null
        return ParsedImageToken(
            alt = alt,
            src = src,
            title = title,
            endIndex = startIndex + match.value.length,
        )
    }

    private fun parseStandaloneHtmlVideoBlock(
        lines: List<String>,
        startLine: Int,
    ): Pair<ParsedVideoToken, Int>? {
        val firstTrimmed = lines[startLine].trim()
        if (!firstTrimmed.startsWith("<video", ignoreCase = true)) return null

        // Single-line <video ...>...</video> or <video ... />
        val single = parseHtmlVideoAt(firstTrimmed, 0)
        if (single != null && single.endIndex == firstTrimmed.length) {
            return single to (startLine + 1)
        }

        // Multi-line <video ...>\n  <source src="..." />\n</video>
        val sb = StringBuilder(firstTrimmed)
        var j = startLine + 1
        val maxEnd = (startLine + 20).coerceAtMost(lines.size)
        while (j < maxEnd) {
            sb.append('\n').append(lines[j].trim())
            val joined = sb.toString()
            if (joined.endsWith("</video>", ignoreCase = true)) {
                val multi = parseHtmlVideoAt(joined, 0)
                if (multi != null && multi.endIndex == joined.length) {
                    return multi to (j + 1)
                }
                return null
            }
            j++
        }
        return null
    }

    private fun parseHtmlVideoAt(text: String, startIndex: Int): ParsedVideoToken? {
        val slice = text.substring(startIndex)
        val match = htmlVideoTagRegex.find(slice) ?: return null
        val attrBody = match.groupValues[1]
        val innerBody = match.groupValues[2]

        var src = ""
        var alt = ""
        var title: String? = null
        var poster: String? = null

        for (attr in htmlAttrRegex.findAll(attrBody)) {
            val name = attr.groupValues[1].lowercase()
            val value = attr.groupValues[2].ifEmpty {
                attr.groupValues[3].ifEmpty { attr.groupValues[4] }
            }.trim()
            when (name) {
                "src" -> src = value
                "aria-label", "alt" -> if (value.isNotEmpty() && alt.isEmpty()) alt = value
                "title" -> if (value.isNotEmpty()) title = value
                "poster" -> if (value.isNotEmpty()) poster = value
            }
        }

        if (src.isEmpty() && innerBody.isNotBlank()) {
            val sourceMatch = htmlSourceTagRegex.find(innerBody)
            if (sourceMatch != null) {
                for (attr in htmlAttrRegex.findAll(sourceMatch.groupValues[1])) {
                    val name = attr.groupValues[1].lowercase()
                    val value = attr.groupValues[2].ifEmpty {
                        attr.groupValues[3].ifEmpty { attr.groupValues[4] }
                    }.trim()
                    if (name == "src" && value.isNotEmpty()) {
                        src = value
                        break
                    }
                }
            }
        }

        if (src.isEmpty()) return null
        val resolvedAlt = alt.ifBlank { title.orEmpty() }
        return ParsedVideoToken(
            alt = resolvedAlt,
            src = src,
            title = title,
            poster = poster,
            endIndex = startIndex + match.value.length,
        )
    }

    private fun findMatchingLinkDestinationEnd(text: String, openParenIndex: Int): Int {
        var i = openParenIndex + 1
        val n = text.length
        while (i < n && text[i].isWhitespace()) i++
        if (i >= n) return -1

        // Angle-bracket wrapped destination: (<path with spaces and (parens)>)
        if (text[i] == '<') {
            val closeAngle = text.indexOf('>', startIndex = i + 1)
            if (closeAngle < 0) return -1
            var j = closeAngle + 1
            while (j < n && text[j] != ')' && text[j] != '\n') j++
            return if (j < n && text[j] == ')') j else -1
        }

        // Standard destination with balanced parentheses support
        var parenDepth = 0
        var inQuote: Char? = null
        while (i < n) {
            val c = text[i]
            if (c == '\n') return -1
            if (inQuote != null) {
                if (c == '\\' && i + 1 < n) {
                    i += 2
                    continue
                }
                if (c == inQuote) inQuote = null
            } else {
                when (c) {
                    '\\' -> if (i + 1 < n) {
                        i += 2
                        continue
                    }
                    '"', '\'' -> inQuote = c
                    '(' -> parenDepth++
                    ')' -> {
                        if (parenDepth == 0) return i
                        parenDepth--
                    }
                }
            }
            i++
        }
        return -1
    }

    private fun parseDestinationAndTitle(rawInner: String): Pair<String, String?> {
        val trimmed = rawInner.trim()
        if (trimmed.startsWith("<")) {
            val closeAngle = trimmed.indexOf('>')
            if (closeAngle > 1) {
                val dest = trimmed.substring(1, closeAngle).trim()
                val rest = trimmed.substring(closeAngle + 1).trim()
                val title = when {
                    rest.length >= 2 && rest.startsWith("\"") && rest.endsWith("\"") ->
                        rest.substring(1, rest.length - 1)
                    rest.length >= 2 && rest.startsWith("'") && rest.endsWith("'") ->
                        rest.substring(1, rest.length - 1)
                    else -> null
                }
                return dest to title
            }
        }
        val titleMatch = optionalTitleSuffixRegex.matchEntire(trimmed)
        if (titleMatch != null) {
            val dest = titleMatch.groupValues[1].trim()
            val title = titleMatch.groupValues[2].ifEmpty { titleMatch.groupValues[3] }
            return dest to title
        }
        return trimmed to null
    }

    private fun unwrapAngleBrackets(raw: String): String {
        val trimmed = raw.trim()
        return if (trimmed.length >= 2 && trimmed.startsWith("<") && trimmed.endsWith(">")) {
            trimmed.substring(1, trimmed.length - 1).trim()
        } else {
            trimmed
        }
    }

    private fun findMatchingBracket(text: String, openIndex: Int): Int {
        var depth = 0
        var idx = openIndex
        while (idx < text.length) {
            val c = text[idx]
            if (c == '\\' && idx + 1 < text.length) {
                idx += 2
                continue
            }
            when (c) {
                '[' -> depth++
                ']' -> {
                    depth--
                    if (depth == 0) return idx
                }
            }
            idx++
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
