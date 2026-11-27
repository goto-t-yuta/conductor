package dev.conductor.mobile.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.ClickableText
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CheckBox
import androidx.compose.material.icons.filled.CheckBoxOutlineBlank
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.conductor.mobile.ui.theme.ConductorColors
import dev.conductor.mobile.ui.theme.ConductorTheme
import kotlinx.coroutines.delay

enum class MarkdownVariant {
    DEFAULT,
    USER_BUBBLE,
    COMPACT,
}

@Composable
fun ConductorMarkdown(
    markdown: String,
    modifier: Modifier = Modifier,
    variant: MarkdownVariant = MarkdownVariant.DEFAULT,
    textColor: Color = ConductorTheme.colors.textPrimary,
) {
    val colors = ConductorTheme.colors
    val blocks = remember(markdown) { MarkdownParser.parseBlocks(markdown) }
    val uriHandler = LocalUriHandler.current

    val baseFontSize = when (variant) {
        MarkdownVariant.COMPACT -> 13.sp
        else -> 14.sp
    }
    val baseLineHeight = when (variant) {
        MarkdownVariant.COMPACT -> 19.sp
        MarkdownVariant.USER_BUBBLE -> 21.sp
        MarkdownVariant.DEFAULT -> 22.sp
    }

    Column(
        modifier = modifier,
        verticalArrangement = Arrangement.spacedBy(if (variant == MarkdownVariant.COMPACT) 6.dp else 8.dp),
    ) {
        blocks.forEach { block ->
            when (block) {
                is MarkdownBlock.Heading -> {
                    val headingSize = when (block.level) {
                        1 -> (baseFontSize.value * 1.24f).sp
                        2 -> (baseFontSize.value * 1.14f).sp
                        3 -> (baseFontSize.value * 1.05f).sp
                        else -> baseFontSize
                    }
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        MarkdownInlineText(
                            text = block.text,
                            colors = colors,
                            variant = variant,
                            style = TextStyle(
                                color = textColor,
                                fontSize = headingSize,
                                lineHeight = (headingSize.value * 1.35f).sp,
                                fontWeight = FontWeight.SemiBold,
                                letterSpacing = (-0.15).sp,
                            ),
                            onOpenUrl = { url -> runCatching { uriHandler.openUri(url) } },
                        )
                        if (block.level <= 2 && variant != MarkdownVariant.USER_BUBBLE) {
                            HorizontalDivider(
                                thickness = 1.dp,
                                color = colors.borderSubtle,
                            )
                        }
                    }
                }

                is MarkdownBlock.Paragraph -> {
                    MarkdownInlineText(
                        text = block.text,
                        colors = colors,
                        variant = variant,
                        style = TextStyle(
                            color = textColor,
                            fontSize = baseFontSize,
                            lineHeight = baseLineHeight,
                        ),
                        onOpenUrl = { url -> runCatching { uriHandler.openUri(url) } },
                    )
                }

                is MarkdownBlock.CodeBlock -> {
                    MarkdownCodeBlock(
                        language = block.language,
                        code = block.code,
                        colors = colors,
                    )
                }

                is MarkdownBlock.Quote -> {
                    val quoteBg = if (variant == MarkdownVariant.USER_BUBBLE) {
                        colors.userInlineCodeBg
                    } else {
                        colors.blockquoteBg
                    }
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(IntrinsicSize.Min)
                            .clip(RoundedCornerShape(topEnd = 8.dp, bottomEnd = 8.dp, topStart = 2.dp, bottomStart = 2.dp))
                            .background(quoteBg),
                    ) {
                        Box(
                            modifier = Modifier
                                .width(3.dp)
                                .fillMaxHeight()
                                .background(colors.indigo.copy(alpha = 0.65f)),
                        )
                        MarkdownInlineText(
                            text = block.text,
                            colors = colors,
                            variant = variant,
                            style = TextStyle(
                                color = textColor.copy(alpha = 0.88f),
                                fontSize = baseFontSize,
                                lineHeight = baseLineHeight,
                            ),
                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 7.dp),
                            onOpenUrl = { url -> runCatching { uriHandler.openUri(url) } },
                        )
                    }
                }

                is MarkdownBlock.BulletList -> {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        block.items.forEach { item ->
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(start = (item.indentLevel * 14).dp),
                                verticalAlignment = Alignment.Top,
                                horizontalArrangement = Arrangement.spacedBy(7.dp),
                            ) {
                                if (item.checked != null) {
                                    Icon(
                                        imageVector = if (item.checked) {
                                            Icons.Default.CheckBox
                                        } else {
                                            Icons.Default.CheckBoxOutlineBlank
                                        },
                                        contentDescription = null,
                                        tint = if (item.checked) colors.indigo else colors.textMuted,
                                        modifier = Modifier
                                            .padding(top = 3.dp)
                                            .size(15.dp),
                                    )
                                } else {
                                    Text(
                                        text = "•",
                                        color = colors.textMuted,
                                        fontSize = baseFontSize,
                                        lineHeight = baseLineHeight,
                                        fontWeight = FontWeight.Bold,
                                        modifier = Modifier.padding(start = 2.dp),
                                    )
                                }
                                MarkdownInlineText(
                                    text = item.text,
                                    colors = colors,
                                    variant = variant,
                                    style = TextStyle(
                                        color = if (item.checked == true) textColor.copy(alpha = 0.86f) else textColor,
                                        fontSize = baseFontSize,
                                        lineHeight = baseLineHeight,
                                    ),
                                    modifier = Modifier.weight(1f),
                                    onOpenUrl = { url -> runCatching { uriHandler.openUri(url) } },
                                )
                            }
                        }
                    }
                }

                is MarkdownBlock.OrderedList -> {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        block.items.forEach { item ->
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(start = (item.indentLevel * 14).dp),
                                verticalAlignment = Alignment.Top,
                                horizontalArrangement = Arrangement.spacedBy(6.dp),
                            ) {
                                Text(
                                    text = "${item.number}.",
                                    color = colors.textMuted,
                                    fontSize = baseFontSize,
                                    lineHeight = baseLineHeight,
                                    fontWeight = FontWeight.Medium,
                                    modifier = Modifier.widthIn(min = 18.dp),
                                )
                                MarkdownInlineText(
                                    text = item.text,
                                    colors = colors,
                                    variant = variant,
                                    style = TextStyle(
                                        color = textColor,
                                        fontSize = baseFontSize,
                                        lineHeight = baseLineHeight,
                                    ),
                                    modifier = Modifier.weight(1f),
                                    onOpenUrl = { url -> runCatching { uriHandler.openUri(url) } },
                                )
                            }
                        }
                    }
                }

                is MarkdownBlock.Table -> {
                    MarkdownTable(
                        headers = block.headers,
                        rows = block.rows,
                        colors = colors,
                        variant = variant,
                        textColor = textColor,
                        onOpenUrl = { url -> runCatching { uriHandler.openUri(url) } },
                    )
                }

                is MarkdownBlock.Divider -> {
                    HorizontalDivider(
                        modifier = Modifier.padding(vertical = 2.dp),
                        thickness = 1.dp,
                        color = colors.border,
                    )
                }
            }
        }
    }
}

@Composable
private fun MarkdownCodeBlock(
    language: String?,
    code: String,
    colors: ConductorColors,
) {
    val clipboard = LocalClipboardManager.current
    var copied by remember(code) { mutableStateOf(false) }

    LaunchedEffect(copied) {
        if (copied) {
            delay(1_600L)
            copied = false
        }
    }

    Surface(
        color = colors.codeBlockBg,
        shape = RoundedCornerShape(10.dp),
        border = BorderStroke(1.dp, colors.border),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(colors.codeBlockHeaderBg)
                    .padding(horizontal = 10.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = language?.lowercase()?.ifBlank { "code" } ?: "code",
                    fontFamily = FontFamily.Monospace,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Medium,
                    color = colors.textMuted,
                )
                Row(
                    modifier = Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .clickable {
                            clipboard.setText(AnnotatedString(code))
                            copied = true
                        }
                        .padding(horizontal = 6.dp, vertical = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Icon(
                        imageVector = if (copied) Icons.Default.Check else Icons.Default.ContentCopy,
                        contentDescription = "コードをコピー",
                        tint = if (copied) colors.emerald else colors.textMuted,
                        modifier = Modifier.size(13.dp),
                    )
                    Text(
                        text = if (copied) "Copied" else "Copy",
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Medium,
                        color = if (copied) colors.emeraldText else colors.textMuted,
                    )
                }
            }
            HorizontalDivider(thickness = 1.dp, color = colors.borderSubtle)
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = 12.dp, vertical = 10.dp),
            ) {
                Text(
                    text = code,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    lineHeight = 18.sp,
                    color = colors.textPrimary,
                )
            }
        }
    }
}

@Composable
private fun MarkdownTable(
    headers: List<String>,
    rows: List<List<String>>,
    colors: ConductorColors,
    variant: MarkdownVariant,
    textColor: Color,
    onOpenUrl: (String) -> Unit,
) {
    val colCount = headers.size
    val stretchToWidth = colCount <= 3
    val fixedCellWidth = 116.dp

    Surface(
        color = colors.card,
        shape = RoundedCornerShape(10.dp),
        border = BorderStroke(1.dp, colors.border),
        modifier = Modifier.fillMaxWidth(),
    ) {
        val columnModifier = if (stretchToWidth) {
            Modifier.fillMaxWidth()
        } else {
            Modifier.horizontalScroll(rememberScrollState())
        }

        Column(modifier = columnModifier) {
            // Header row
            Row(
                modifier = (if (stretchToWidth) Modifier.fillMaxWidth() else Modifier)
                    .background(colors.codeBlockHeaderBg)
                    .height(IntrinsicSize.Min),
            ) {
                headers.forEachIndexed { colIdx, header ->
                    Box(
                        modifier = (if (stretchToWidth) Modifier.weight(1f) else Modifier.width(fixedCellWidth))
                            .padding(horizontal = 10.dp, vertical = 7.dp),
                    ) {
                        MarkdownInlineText(
                            text = header,
                            colors = colors,
                            variant = variant,
                            style = TextStyle(
                                color = colors.textPrimary,
                                fontSize = 12.sp,
                                lineHeight = 16.sp,
                                fontWeight = FontWeight.SemiBold,
                            ),
                            onOpenUrl = onOpenUrl,
                        )
                    }
                    if (colIdx < headers.lastIndex) {
                        Box(
                            modifier = Modifier
                                .width(1.dp)
                                .fillMaxHeight()
                                .background(colors.borderSubtle),
                        )
                    }
                }
            }

            rows.forEachIndexed { rowIdx, row ->
                HorizontalDivider(thickness = 1.dp, color = colors.borderSubtle)
                Row(
                    modifier = (if (stretchToWidth) Modifier.fillMaxWidth() else Modifier)
                        .background(
                            if (rowIdx % 2 == 1) colors.surfaceSecondary.copy(alpha = 0.55f) else Color.Transparent,
                        )
                        .height(IntrinsicSize.Min),
                ) {
                    row.forEachIndexed { colIdx, cell ->
                        Box(
                            modifier = (if (stretchToWidth) Modifier.weight(1f) else Modifier.width(fixedCellWidth))
                                .padding(horizontal = 10.dp, vertical = 7.dp),
                        ) {
                            MarkdownInlineText(
                                text = cell,
                                colors = colors,
                                variant = variant,
                                style = TextStyle(
                                    color = textColor,
                                    fontSize = 12.sp,
                                    lineHeight = 17.sp,
                                ),
                                onOpenUrl = onOpenUrl,
                            )
                        }
                        if (colIdx < row.lastIndex) {
                            Box(
                                modifier = Modifier
                                    .width(1.dp)
                                    .fillMaxHeight()
                                    .background(colors.borderSubtle),
                            )
                        }
                    }
                }
            }
        }
    }
}

@Suppress("DEPRECATION")
@Composable
private fun MarkdownInlineText(
    text: String,
    colors: ConductorColors,
    variant: MarkdownVariant,
    style: TextStyle,
    modifier: Modifier = Modifier,
    onOpenUrl: (String) -> Unit,
) {
    val annotated = remember(text, colors, variant) {
        buildMarkdownAnnotatedString(
            nodes = MarkdownParser.parseInline(text),
            colors = colors,
            isUserBubble = variant == MarkdownVariant.USER_BUBBLE,
        )
    }

    val hasLinks = remember(annotated) {
        annotated.getStringAnnotations(tag = URL_TAG, start = 0, end = annotated.length).isNotEmpty()
    }

    if (hasLinks) {
        ClickableText(
            text = annotated,
            style = style,
            modifier = modifier,
            onClick = { offset ->
                annotated.getStringAnnotations(tag = URL_TAG, start = offset, end = offset)
                    .firstOrNull()
                    ?.let { onOpenUrl(it.item) }
            },
        )
    } else {
        Text(
            text = annotated,
            style = style,
            modifier = modifier,
        )
    }
}

private const val URL_TAG = "URL"

private fun buildMarkdownAnnotatedString(
    nodes: List<InlineNode>,
    colors: ConductorColors,
    isUserBubble: Boolean,
): AnnotatedString = buildAnnotatedString {
    fun appendNodes(list: List<InlineNode>) {
        for (node in list) {
            when (node) {
                is InlineNode.Plain -> append(node.text)
                is InlineNode.Bold -> {
                    val start = length
                    appendNodes(node.children)
                    addStyle(SpanStyle(fontWeight = FontWeight.SemiBold), start, length)
                }

                is InlineNode.Italic -> {
                    val start = length
                    appendNodes(node.children)
                    addStyle(SpanStyle(fontStyle = FontStyle.Italic), start, length)
                }

                is InlineNode.BoldItalic -> {
                    val start = length
                    appendNodes(node.children)
                    addStyle(
                        SpanStyle(
                            fontWeight = FontWeight.SemiBold,
                            fontStyle = FontStyle.Italic,
                        ),
                        start,
                        length,
                    )
                }

                is InlineNode.Strike -> {
                    val start = length
                    appendNodes(node.children)
                    addStyle(SpanStyle(textDecoration = TextDecoration.LineThrough), start, length)
                }

                is InlineNode.Code -> {
                    val start = length
                    append("\u00A0${node.code}\u00A0")
                    addStyle(
                        SpanStyle(
                            fontFamily = FontFamily.Monospace,
                            fontSize = 12.5.sp,
                            background = if (isUserBubble) colors.userInlineCodeBg else colors.inlineCodeBg,
                            color = if (isUserBubble) colors.userInlineCodeText else colors.textPrimary,
                        ),
                        start,
                        length,
                    )
                }

                is InlineNode.Link -> {
                    val start = length
                    append(node.label)
                    addStyle(
                        SpanStyle(
                            color = colors.indigoText,
                            textDecoration = TextDecoration.Underline,
                            fontWeight = FontWeight.Medium,
                        ),
                        start,
                        length,
                    )
                    addStringAnnotation(
                        tag = URL_TAG,
                        annotation = node.url,
                        start = start,
                        end = length,
                    )
                }
            }
        }
    }

    appendNodes(nodes)
}
