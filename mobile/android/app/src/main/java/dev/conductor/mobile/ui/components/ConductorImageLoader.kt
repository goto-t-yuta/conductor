package dev.conductor.mobile.ui.components

import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.BrokenImage
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.filled.ZoomIn
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.conductor.mobile.data.ClassifiedImageSource
import dev.conductor.mobile.data.ConductorApiClient
import dev.conductor.mobile.data.ImageSourceClassifier
import dev.conductor.mobile.model.ConnectionConfig
import dev.conductor.mobile.ui.theme.ConductorTheme
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.IOException
import kotlin.math.max
import kotlin.math.roundToInt

data class LoadedImageAsset(
    val bitmap: ImageBitmap,
    val pixelWidth: Int,
    val pixelHeight: Int,
)

class ConductorImageLoader(
    private val api: ConductorApiClient,
) {
    private val maxCacheBytes: Int = run {
        val maxMem = Runtime.getRuntime().maxMemory().coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
        (maxMem / 6).coerceIn(8 * 1024 * 1024, 32 * 1024 * 1024)
    }

    private val cache = object : LruCache<String, LoadedImageAsset>(maxCacheBytes) {
        override fun sizeOf(key: String, value: LoadedImageAsset): Int {
            val bytes = value.pixelWidth.toLong() * value.pixelHeight.toLong() * 4L
            return bytes.coerceIn(1024L, maxCacheBytes.toLong()).toInt()
        }
    }

    private val inFlightMutex = Mutex()
    private val inFlight = mutableMapOf<String, CompletableDeferred<Result<LoadedImageAsset>>>()

    fun cacheKey(
        config: ConnectionConfig?,
        rawSrc: String,
        basePath: String?,
        maxDimensionPx: Int,
    ): String {
        val server = config?.serverUrl?.trim().orEmpty()
        return "$server|${basePath.orEmpty()}|$maxDimensionPx|${rawSrc.trim()}"
    }

    fun getCached(
        config: ConnectionConfig?,
        rawSrc: String,
        basePath: String?,
        maxDimensionPx: Int = INLINE_MAX_DIMENSION_PX,
    ): LoadedImageAsset? = cache.get(cacheKey(config, rawSrc, basePath, maxDimensionPx))

    fun invalidate(
        config: ConnectionConfig?,
        rawSrc: String,
        basePath: String?,
    ) {
        cache.remove(cacheKey(config, rawSrc, basePath, INLINE_MAX_DIMENSION_PX))
        cache.remove(cacheKey(config, rawSrc, basePath, FULLSCREEN_MAX_DIMENSION_PX))
    }

    fun clear() {
        cache.evictAll()
    }

    suspend fun load(
        config: ConnectionConfig?,
        rawSrc: String,
        basePath: String? = null,
        maxDimensionPx: Int = INLINE_MAX_DIMENSION_PX,
        forceReload: Boolean = false,
    ): Result<LoadedImageAsset> {
        val key = cacheKey(config, rawSrc, basePath, maxDimensionPx)
        if (!forceReload) {
            cache.get(key)?.let { return Result.success(it) }
        } else {
            cache.remove(key)
        }

        var owner = false
        val deferred: CompletableDeferred<Result<LoadedImageAsset>> = inFlightMutex.withLock {
            val existing = if (forceReload) null else inFlight[key]
            if (existing != null) {
                existing
            } else {
                owner = true
                CompletableDeferred<Result<LoadedImageAsset>>().also { inFlight[key] = it }
            }
        }

        if (!owner) {
            return deferred.await()
        }

        val result = try {
            val fetched = api.fetchImageBytes(config = config, rawSrc = rawSrc, basePath = basePath)
                .getOrThrow()
            if (fetched.contentType == "image/svg+xml" ||
                rawSrc.trim().substringBefore('?').substringBefore('#').endsWith(".svg", ignoreCase = true)
            ) {
                throw IOException("SVG 形式のプレビューには対応していません")
            }
            val decoded = withContext(Dispatchers.Default) {
                decodeDownsampledBitmap(fetched.bytes, maxDimensionPx)
            } ?: throw IOException("画像をデコードできませんでした")
            cache.put(key, decoded)
            Result.success(decoded)
        } catch (t: Throwable) {
            Result.failure(t)
        }

        inFlightMutex.withLock {
            if (inFlight[key] === deferred) {
                inFlight.remove(key)
            }
        }
        deferred.complete(result)
        return result
    }

    companion object {
        const val INLINE_MAX_DIMENSION_PX = 1600
        const val FULLSCREEN_MAX_DIMENSION_PX = 3072

        internal fun computeInSampleSize(
            rawWidth: Int,
            rawHeight: Int,
            maxDimensionPx: Int,
        ): Int {
            if (rawWidth <= 0 || rawHeight <= 0 || maxDimensionPx <= 0) return 1
            var sampleSize = 1
            val longest = max(rawWidth, rawHeight)
            while (longest / (sampleSize * 2) >= maxDimensionPx) {
                sampleSize *= 2
            }
            return sampleSize
        }

        private fun decodeDownsampledBitmap(
            bytes: ByteArray,
            maxDimensionPx: Int,
        ): LoadedImageAsset? {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            val srcW = bounds.outWidth
            val srcH = bounds.outHeight
            if (srcW <= 0 || srcH <= 0) return null

            val opts = BitmapFactory.Options().apply {
                inSampleSize = computeInSampleSize(srcW, srcH, maxDimensionPx)
                inJustDecodeBounds = false
            }
            val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts) ?: return null
            return LoadedImageAsset(
                bitmap = bmp.asImageBitmap(),
                pixelWidth = bmp.width,
                pixelHeight = bmp.height,
            )
        }
    }
}

data class ConductorImageContext(
    val loader: ConductorImageLoader,
    val config: ConnectionConfig?,
)

val LocalConductorImageContext = compositionLocalOf<ConductorImageContext?> { null }

private sealed interface ImageUiState {
    data object Loading : ImageUiState
    data class Loaded(val asset: LoadedImageAsset) : ImageUiState
    data class Error(val message: String) : ImageUiState
}

@Composable
fun MarkdownImageBlock(
    alt: String,
    src: String,
    basePath: String? = null,
    modifier: Modifier = Modifier,
) {
    val colors = ConductorTheme.colors
    val imageContext = LocalConductorImageContext.current
    val classified = remember(src, basePath) { ImageSourceClassifier.classify(src, basePath) }
    val displayFileName = remember(src) { ImageSourceClassifier.extractDisplayFileName(src) }
    val caption = alt.trim().ifBlank { displayFileName }

    if (classified is ClassifiedImageSource.VideoMedia) {
        Surface(
            color = colors.surfaceSecondary,
            shape = RoundedCornerShape(10.dp),
            border = BorderStroke(1.dp, colors.border),
            modifier = modifier.fillMaxWidth(),
        ) {
            Row(
                modifier = Modifier.padding(horizontal = 11.dp, vertical = 9.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(9.dp),
            ) {
                Box(
                    modifier = Modifier
                        .size(30.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(colors.indigoBg),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = Icons.Default.Videocam,
                        contentDescription = null,
                        tint = colors.indigo,
                        modifier = Modifier.size(16.dp),
                    )
                }
                Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(
                        text = caption,
                        fontSize = 12.5.sp,
                        fontWeight = FontWeight.Medium,
                        color = colors.textPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        text = "動画ファイル · デスクトップ版で再生できます",
                        fontSize = 11.sp,
                        color = colors.textMuted,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
        return
    }

    if (classified is ClassifiedImageSource.Invalid) {
        MarkdownImageErrorCard(
            title = caption,
            detail = classified.reason,
            filePath = src,
            onRetry = null,
            modifier = modifier,
        )
        return
    }

    if (imageContext == null) {
        MarkdownImageErrorCard(
            title = caption,
            detail = "画像ローダーが初期化されていません",
            filePath = displayFileName,
            onRetry = null,
            modifier = modifier,
        )
        return
    }

    var retryNonce by remember(src, basePath) { mutableIntStateOf(0) }
    var showFullscreen by remember(src, basePath) { mutableStateOf(false) }

    val cached = remember(imageContext.config, src, basePath, retryNonce) {
        if (retryNonce == 0) {
            imageContext.loader.getCached(
                config = imageContext.config,
                rawSrc = src,
                basePath = basePath,
                maxDimensionPx = ConductorImageLoader.INLINE_MAX_DIMENSION_PX,
            )
        } else {
            null
        }
    }

    var uiState by remember(imageContext.config, src, basePath, retryNonce) {
        mutableStateOf<ImageUiState>(
            if (cached != null) ImageUiState.Loaded(cached) else ImageUiState.Loading,
        )
    }

    LaunchedEffect(imageContext.config, src, basePath, retryNonce) {
        if (uiState is ImageUiState.Loaded && retryNonce == 0) return@LaunchedEffect
        uiState = ImageUiState.Loading
        val result = imageContext.loader.load(
            config = imageContext.config,
            rawSrc = src,
            basePath = basePath,
            maxDimensionPx = ConductorImageLoader.INLINE_MAX_DIMENSION_PX,
            forceReload = retryNonce > 0,
        )
        uiState = result.fold(
            onSuccess = { ImageUiState.Loaded(it) },
            onFailure = { err -> ImageUiState.Error(err.message ?: "画像の読み込みに失敗しました") },
        )
    }

    when (val state = uiState) {
        is ImageUiState.Loading -> {
            Surface(
                color = colors.surfaceSecondary,
                shape = RoundedCornerShape(12.dp),
                border = BorderStroke(1.dp, colors.border),
                modifier = modifier.fillMaxWidth(),
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(16.dp),
                        strokeWidth = 2.dp,
                        color = colors.indigo,
                    )
                    Icon(
                        imageVector = Icons.Default.Image,
                        contentDescription = null,
                        tint = colors.textSubtle,
                        modifier = Modifier.size(16.dp),
                    )
                    Text(
                        text = "画像を読み込み中: $caption",
                        fontSize = 12.sp,
                        color = colors.textMuted,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }

        is ImageUiState.Error -> {
            MarkdownImageErrorCard(
                title = caption,
                detail = state.message,
                filePath = displayFileName,
                onRetry = {
                    imageContext.loader.invalidate(imageContext.config, src, basePath)
                    retryNonce++
                },
                modifier = modifier,
            )
        }

        is ImageUiState.Loaded -> {
            val asset = state.asset
            val naturalRatio = (asset.pixelWidth.toFloat() / asset.pixelHeight.toFloat())
                .coerceIn(0.65f, 3.0f)

            Surface(
                color = colors.surfaceSecondary,
                shape = RoundedCornerShape(12.dp),
                border = BorderStroke(1.dp, colors.border),
                modifier = modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .clickable { showFullscreen = true }
                    .semantics { contentDescription = "画像: $caption (タップして拡大)" },
            ) {
                Column {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(colors.codeBlockBg),
                        contentAlignment = Alignment.Center,
                    ) {
                        Image(
                            bitmap = asset.bitmap,
                            contentDescription = caption,
                            contentScale = ContentScale.Fit,
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(min = 72.dp, max = 340.dp)
                                .aspectRatio(naturalRatio, matchHeightConstraintsFirst = false),
                        )

                        // Subtle zoom affordance pill
                        Surface(
                            color = Color.Black.copy(alpha = 0.56f),
                            shape = RoundedCornerShape(99.dp),
                            modifier = Modifier
                                .align(Alignment.BottomEnd)
                                .padding(8.dp),
                        ) {
                            Row(
                                modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(3.dp),
                            ) {
                                Icon(
                                    imageVector = Icons.Default.ZoomIn,
                                    contentDescription = "拡大表示",
                                    tint = Color.White,
                                    modifier = Modifier.size(13.dp),
                                )
                                Text(
                                    text = "拡大",
                                    fontSize = 10.5.sp,
                                    fontWeight = FontWeight.Medium,
                                    color = Color.White,
                                )
                            }
                        }
                    }

                    if (alt.isNotBlank()) {
                        HorizontalDivider(thickness = 1.dp, color = colors.borderSubtle)
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 10.dp, vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            Icon(
                                imageVector = Icons.Default.Image,
                                contentDescription = null,
                                tint = colors.textSubtle,
                                modifier = Modifier.size(13.dp),
                            )
                            Text(
                                text = alt.trim(),
                                fontSize = 11.5.sp,
                                color = colors.textSecondary,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f),
                            )
                        }
                    }
                }
            }

            if (showFullscreen) {
                FullscreenImageDialog(
                    title = caption,
                    subtitle = displayFileName,
                    initialAsset = asset,
                    src = src,
                    basePath = basePath,
                    imageContext = imageContext,
                    onDismiss = { showFullscreen = false },
                )
            }
        }
    }
}

@Composable
private fun MarkdownImageErrorCard(
    title: String,
    detail: String,
    filePath: String,
    onRetry: (() -> Unit)?,
    modifier: Modifier = Modifier,
) {
    val colors = ConductorTheme.colors
    Surface(
        color = colors.roseBg,
        shape = RoundedCornerShape(10.dp),
        border = BorderStroke(1.dp, colors.roseBorder),
        modifier = modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(
                imageVector = Icons.Default.BrokenImage,
                contentDescription = null,
                tint = colors.rose,
                modifier = Modifier.size(16.dp),
            )
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Text(
                    text = title.ifBlank { "画像を読み込めませんでした" },
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Medium,
                    color = colors.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = detail,
                    fontSize = 11.sp,
                    color = colors.roseText,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                if (filePath.isNotBlank() && filePath != title) {
                    Text(
                        text = filePath,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 10.sp,
                        color = colors.textMuted,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            if (onRetry != null) {
                Surface(
                    color = colors.card,
                    shape = RoundedCornerShape(8.dp),
                    border = BorderStroke(1.dp, colors.border),
                    modifier = Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .clickable(onClick = onRetry),
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 5.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Icon(
                            imageVector = Icons.Default.Refresh,
                            contentDescription = "再試行",
                            tint = colors.textSecondary,
                            modifier = Modifier.size(13.dp),
                        )
                        Text(
                            text = "再試行",
                            fontSize = 11.sp,
                            fontWeight = FontWeight.Medium,
                            color = colors.textPrimary,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun FullscreenImageDialog(
    title: String,
    subtitle: String,
    initialAsset: LoadedImageAsset,
    src: String,
    basePath: String?,
    imageContext: ConductorImageContext,
    onDismiss: () -> Unit,
) {
    var displayAsset by remember(src, basePath) { mutableStateOf(initialAsset) }
    var scale by remember(src, basePath) { mutableFloatStateOf(1f) }
    var offset by remember(src, basePath) { mutableStateOf(Offset.Zero) }
    var containerSize by remember { mutableStateOf(IntSize.Zero) }

    // Upgrade to higher resolution in the background while showing cached preview immediately
    LaunchedEffect(imageContext.config, src, basePath) {
        val hiRes = imageContext.loader.load(
            config = imageContext.config,
            rawSrc = src,
            basePath = basePath,
            maxDimensionPx = ConductorImageLoader.FULLSCREEN_MAX_DIMENSION_PX,
        ).getOrNull()
        if (hiRes != null) {
            displayAsset = hiRes
        }
    }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(
            usePlatformDefaultWidth = false,
            decorFitsSystemWindows = false,
        ),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color(0xF5090B10)),
        ) {
            // Zoomable & pannable image canvas
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .onSizeChanged { containerSize = it }
                    .pointerInput(Unit) {
                        detectTapGestures(
                            onDoubleTap = {
                                if (scale > 1.25f) {
                                    scale = 1f
                                    offset = Offset.Zero
                                } else {
                                    scale = 2.5f
                                }
                            },
                        )
                    }
                    .pointerInput(Unit) {
                        detectTransformGestures { _, pan, zoom, _ ->
                            val nextScale = (scale * zoom).coerceIn(1f, 5f)
                            scale = nextScale
                            if (nextScale <= 1.01f) {
                                offset = Offset.Zero
                            } else {
                                val maxX = (containerSize.width * (nextScale - 1f)) / 2f
                                val maxY = (containerSize.height * (nextScale - 1f)) / 2f
                                offset = Offset(
                                    x = (offset.x + pan.x).coerceIn(-maxX, maxX),
                                    y = (offset.y + pan.y).coerceIn(-maxY, maxY),
                                )
                            }
                        }
                    },
                contentAlignment = Alignment.Center,
            ) {
                Image(
                    bitmap = displayAsset.bitmap,
                    contentDescription = title,
                    contentScale = ContentScale.Fit,
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(horizontal = 8.dp, vertical = 68.dp)
                        .graphicsLayer {
                            scaleX = scale
                            scaleY = scale
                            translationX = offset.x
                            translationY = offset.y
                        },
                )
            }

            // Top bar: title, zoom reset pill, close button
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .align(Alignment.TopCenter)
                    .background(Color.Black.copy(alpha = 0.55f))
                    .statusBarsPadding()
                    .padding(horizontal = 14.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                    Text(
                        text = title,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = Color.White,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (subtitle.isNotBlank() && subtitle != title) {
                        Text(
                            text = subtitle,
                            fontFamily = FontFamily.Monospace,
                            fontSize = 11.sp,
                            color = Color.White.copy(alpha = 0.72f),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }

                if (scale > 1.02f) {
                    Surface(
                        color = Color.White.copy(alpha = 0.16f),
                        shape = RoundedCornerShape(99.dp),
                        modifier = Modifier
                            .clip(RoundedCornerShape(99.dp))
                            .clickable {
                                scale = 1f
                                offset = Offset.Zero
                            },
                    ) {
                        Text(
                            text = "${(scale * 100).roundToInt()}% · リセット",
                            fontSize = 11.5.sp,
                            fontWeight = FontWeight.Medium,
                            color = Color.White,
                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
                        )
                    }
                }

                IconButton(
                    onClick = onDismiss,
                    modifier = Modifier
                        .size(36.dp)
                        .clip(CircleShape)
                        .background(Color.White.copy(alpha = 0.14f)),
                ) {
                    Icon(
                        imageVector = Icons.Default.Close,
                        contentDescription = "閉じる",
                        tint = Color.White,
                        modifier = Modifier.size(20.dp),
                    )
                }
            }

            // Bottom subtle gesture hint (extra bottom padding clears the gesture pill even inside Dialog windows)
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .align(Alignment.BottomCenter)
                    .navigationBarsPadding()
                    .padding(bottom = 34.dp),
                contentAlignment = Alignment.Center,
            ) {
                Surface(
                    color = Color.Black.copy(alpha = 0.55f),
                    shape = RoundedCornerShape(99.dp),
                ) {
                    Text(
                        text = "ピンチ・ダブルタップで拡大縮小",
                        fontSize = 11.sp,
                        color = Color.White.copy(alpha = 0.80f),
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 5.dp),
                    )
                }
            }
        }
    }
}
