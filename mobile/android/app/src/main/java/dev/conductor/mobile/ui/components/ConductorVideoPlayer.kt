package dev.conductor.mobile.ui.components

import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.util.LruCache
import android.view.LayoutInflater
import androidx.annotation.OptIn
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.VolumeOff
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Fullscreen
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.filled.VideocamOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import dev.conductor.mobile.R
import dev.conductor.mobile.data.ConductorApiClient
import dev.conductor.mobile.data.ImageSourceClassifier
import dev.conductor.mobile.data.VideoPlaybackTarget
import dev.conductor.mobile.model.ConnectionConfig
import dev.conductor.mobile.ui.theme.ConductorTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File
import java.security.MessageDigest
import java.util.Base64

data class VideoPreviewMetadata(
    val thumbnail: ImageBitmap?,
    val durationMs: Long?,
    val width: Int?,
    val height: Int?,
)

class ConductorVideoPreviewCache {
    private val cache = object : LruCache<String, VideoPreviewMetadata>(32) {}

    fun get(key: String): VideoPreviewMetadata? = cache.get(key)

    fun put(key: String, value: VideoPreviewMetadata) {
        cache.put(key, value)
    }

    fun invalidate(key: String) {
        cache.remove(key)
    }

    fun clear() {
        cache.evictAll()
    }
}

class ConductorVideoPlaybackCoordinator {
    private val _activeInlineKey = MutableStateFlow<String?>(null)
    val activeInlineKey: StateFlow<String?> = _activeInlineKey.asStateFlow()

    fun activateInline(key: String) {
        _activeInlineKey.value = key
    }

    fun deactivateInline(key: String) {
        if (_activeInlineKey.value == key) {
            _activeInlineKey.value = null
        }
    }

    fun pauseAllInline() {
        _activeInlineKey.value = null
    }
}

data class ConductorVideoContext(
    val api: ConductorApiClient,
    val config: ConnectionConfig?,
    val previewCache: ConductorVideoPreviewCache,
    val coordinator: ConductorVideoPlaybackCoordinator,
)

val LocalConductorVideoContext = compositionLocalOf<ConductorVideoContext?> { null }

internal object VideoPlayerFormatting {
    fun formatDurationMs(durationMs: Long?): String? {
        if (durationMs == null || durationMs <= 0L) return null
        val totalSeconds = durationMs / 1000L
        val hours = totalSeconds / 3600L
        val minutes = (totalSeconds % 3600L) / 60L
        val seconds = totalSeconds % 60L
        return if (hours > 0L) {
            "%d:%02d:%02d".format(hours, minutes, seconds)
        } else {
            "%d:%02d".format(minutes, seconds)
        }
    }

    fun mapHttpErrorCode(statusCode: Int): String = when (statusCode) {
        401 -> "認証エラー (401): 再接続してください"
        403 -> "動画ファイルへのアクセスが拒否されました (403)"
        404 -> "動画ファイルが見つかりません (404)"
        413 -> "動画サイズが大きすぎます (413)"
        416 -> "動画の範囲取得に失敗しました (416)"
        else -> "動画の取得に失敗しました (HTTP $statusCode)"
    }
}

private fun describePlaybackError(error: PlaybackException): String {
    var cause: Throwable? = error.cause
    while (cause != null) {
        if (cause is HttpDataSource.InvalidResponseCodeException) {
            return VideoPlayerFormatting.mapHttpErrorCode(cause.responseCode)
        }
        if (cause is HttpDataSource.HttpDataSourceException) {
            return "動画の読み込み中にネットワークエラーが発生しました"
        }
        cause = cause.cause
    }
    return when (error.errorCode) {
        PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
        PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT,
        -> "動画サーバーに接続できませんでした"

        PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
        PlaybackException.ERROR_CODE_DECODING_FAILED,
        PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED,
        -> "この動画形式は端末でデコードできませんでした"

        else -> error.localizedMessage?.takeIf { it.isNotBlank() } ?: "動画を再生できませんでした"
    }
}

private suspend fun materializeInlineVideoFile(
    context: Context,
    inlineData: VideoPlaybackTarget.InlineData,
): Uri = withContext(Dispatchers.IO) {
    val bytes = Base64.getDecoder().decode(inlineData.base64Data)
    val ext = when {
        inlineData.mimeType.contains("webm", ignoreCase = true) -> "webm"
        inlineData.mimeType.contains("quicktime", ignoreCase = true) -> "mov"
        else -> "mp4"
    }
    val digest = MessageDigest.getInstance("SHA-256")
        .digest(bytes)
        .take(12)
        .joinToString("") { "%02x".format(it) }
    val dir = File(context.cacheDir, "conductor-videos").apply { mkdirs() }
    val outFile = File(dir, "inline-$digest.$ext")
    if (!outFile.exists() || outFile.length() != bytes.size.toLong()) {
        outFile.writeBytes(bytes)
    }
    Uri.fromFile(outFile)
}

private suspend fun extractVideoPreviewMetadata(
    context: Context,
    target: VideoPlaybackTarget,
): VideoPreviewMetadata? = withTimeoutOrNull(8_000L) {
    withContext(Dispatchers.IO) {
        val retriever = MediaMetadataRetriever()
        try {
            when (target) {
                is VideoPlaybackTarget.HttpStream -> {
                    retriever.setDataSource(target.url, target.headers)
                }

                is VideoPlaybackTarget.InlineData -> {
                    val uri = materializeInlineVideoFile(context, target)
                    retriever.setDataSource(context, uri)
                }
            }
            val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
                ?.toLongOrNull()
                ?.takeIf { it > 0L }
            val width = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)
                ?.toIntOrNull()
                ?.takeIf { it > 0 }
            val height = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)
                ?.toIntOrNull()
                ?.takeIf { it > 0 }
            val frame = retriever.getFrameAtTime(0L, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
                ?: retriever.frameAtTime
            VideoPreviewMetadata(
                thumbnail = frame?.asImageBitmap(),
                durationMs = durationMs,
                width = width,
                height = height,
            )
        } catch (_: Throwable) {
            null
        } finally {
            runCatching { retriever.release() }
        }
    }
}

@OptIn(UnstableApi::class)
private fun buildExoPlayerForTarget(
    context: Context,
    api: ConductorApiClient,
    target: VideoPlaybackTarget,
    resolvedInlineUri: Uri?,
): ExoPlayer {
    val playerBuilder = ExoPlayer.Builder(context)
    val mediaItem = when (target) {
        is VideoPlaybackTarget.HttpStream -> {
            val httpFactory = OkHttpDataSource.Factory(api.getVideoStreamClient())
            if (target.headers.isNotEmpty()) {
                httpFactory.setDefaultRequestProperties(target.headers)
            }
            val mediaSourceFactory = DefaultMediaSourceFactory(
                DefaultDataSource.Factory(context, httpFactory),
            )
            playerBuilder.setMediaSourceFactory(mediaSourceFactory)
            MediaItem.fromUri(target.url)
        }

        is VideoPlaybackTarget.InlineData -> {
            MediaItem.fromUri(resolvedInlineUri ?: Uri.EMPTY)
        }
    }
    return playerBuilder.build().apply {
        setMediaItem(mediaItem)
        prepare()
    }
}

@Composable
fun MarkdownVideoBlock(
    alt: String,
    src: String,
    basePath: String? = null,
    poster: String? = null,
    modifier: Modifier = Modifier,
) {
    val colors = ConductorTheme.colors
    val context = LocalContext.current
    val videoContext = LocalConductorVideoContext.current
    val displayFileName = remember(src) { ImageSourceClassifier.extractDisplayFileName(src) }
    val caption = alt.trim().ifBlank { displayFileName.ifBlank { "動画" } }

    if (videoContext == null) {
        MarkdownVideoErrorCard(
            title = caption,
            detail = "動画プレーヤーが初期化されていません",
            filePath = displayFileName,
            onRetry = null,
            modifier = modifier,
        )
        return
    }

    val targetResult = remember(videoContext.config, src, basePath) {
        videoContext.api.resolveVideoPlaybackTarget(
            config = videoContext.config,
            rawSrc = src,
            basePath = basePath,
        )
    }

    val target = targetResult.getOrElse { err ->
        MarkdownVideoErrorCard(
            title = caption,
            detail = err.message ?: "動画を解決できませんでした",
            filePath = displayFileName,
            onRetry = null,
            modifier = modifier,
        )
        return
    }

    val formatBadge = when (target) {
        is VideoPlaybackTarget.HttpStream -> target.formatBadge
        is VideoPlaybackTarget.InlineData -> target.formatBadge
    }
    val instanceKey = remember(videoContext.config, src, basePath) {
        "${videoContext.config?.serverUrl.orEmpty()}|${basePath.orEmpty()}|${src.trim()}"
    }
    val activeInlineKey by videoContext.coordinator.activeInlineKey.collectAsState()
    val isInlinePlaying = activeInlineKey == instanceKey

    var showFullscreen by remember(instanceKey) { mutableStateOf(false) }
    var resumePositionMs by remember(instanceKey) { mutableLongStateOf(0L) }
    var inlineError by remember(instanceKey) { mutableStateOf<String?>(null) }
    var retryNonce by remember(instanceKey) { mutableIntStateOf(0) }
    var previewMeta by remember(instanceKey) {
        mutableStateOf(videoContext.previewCache.get(instanceKey))
    }

    LaunchedEffect(instanceKey, retryNonce) {
        if (previewMeta != null && retryNonce == 0) return@LaunchedEffect
        val extracted = extractVideoPreviewMetadata(context, target)
        if (extracted != null) {
            videoContext.previewCache.put(instanceKey, extracted)
            previewMeta = extracted
        }
    }

    val videoAspectRatio = remember(previewMeta) {
        val w = previewMeta?.width
        val h = previewMeta?.height
        if (w != null && h != null && w > 0 && h > 0) {
            (w.toFloat() / h.toFloat()).coerceIn(0.75f, 2.35f)
        } else {
            16f / 9f
        }
    }

    if (inlineError != null && !isInlinePlaying) {
        MarkdownVideoErrorCard(
            title = caption,
            detail = inlineError ?: "動画を再生できませんでした",
            filePath = displayFileName,
            onRetry = {
                inlineError = null
                videoContext.previewCache.invalidate(instanceKey)
                retryNonce++
                videoContext.coordinator.activateInline(instanceKey)
            },
            modifier = modifier,
        )
        return
    }

    Surface(
        color = colors.surfaceSecondary,
        shape = RoundedCornerShape(12.dp),
        border = BorderStroke(1.dp, colors.border),
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp)),
    ) {
        Column {
            if (isInlinePlaying && !showFullscreen) {
                InlineExoPlayerStage(
                    target = target,
                    api = videoContext.api,
                    aspectRatio = videoAspectRatio,
                    initialPositionMs = resumePositionMs,
                    retryNonce = retryNonce,
                    onPositionChanged = { pos -> resumePositionMs = pos },
                    onOpenFullscreen = { currentPos ->
                        resumePositionMs = currentPos
                        videoContext.coordinator.deactivateInline(instanceKey)
                        showFullscreen = true
                    },
                    onError = { message ->
                        inlineError = message
                        videoContext.coordinator.deactivateInline(instanceKey)
                    },
                )
            } else {
                // Idle / Preview card: tap to play inline or tap Fullscreen pill for modal player
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 148.dp, max = 280.dp)
                        .aspectRatio(videoAspectRatio, matchHeightConstraintsFirst = false)
                        .background(
                            Brush.verticalGradient(
                                listOf(Color(0xFF131722), Color(0xFF0A0D14)),
                            ),
                        )
                        .clickable {
                            inlineError = null
                            videoContext.coordinator.activateInline(instanceKey)
                        }
                        .semantics { contentDescription = "動画: $caption (タップして再生)" },
                    contentAlignment = Alignment.Center,
                ) {
                    val thumb = previewMeta?.thumbnail
                    if (thumb != null) {
                        Image(
                            bitmap = thumb,
                            contentDescription = caption,
                            contentScale = ContentScale.Fit,
                            modifier = Modifier.fillMaxSize(),
                        )
                        Box(
                            modifier = Modifier
                                .fillMaxSize()
                                .background(Color.Black.copy(alpha = 0.24f)),
                        )
                    }

                    // Format badge (top-left)
                    Surface(
                        color = Color.Black.copy(alpha = 0.62f),
                        shape = RoundedCornerShape(7.dp),
                        modifier = Modifier
                            .align(Alignment.TopStart)
                            .padding(8.dp),
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 7.dp, vertical = 3.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            Icon(
                                imageVector = Icons.Default.Videocam,
                                contentDescription = null,
                                tint = Color(0xFFA5B4FC),
                                modifier = Modifier.size(12.dp),
                            )
                            Text(
                                text = formatBadge,
                                fontSize = 10.sp,
                                fontWeight = FontWeight.Bold,
                                color = Color.White,
                            )
                        }
                    }

                    // Fullscreen quick action pill (top-right)
                    Surface(
                        color = Color.Black.copy(alpha = 0.62f),
                        shape = RoundedCornerShape(99.dp),
                        modifier = Modifier
                            .align(Alignment.TopEnd)
                            .padding(8.dp)
                            .clip(RoundedCornerShape(99.dp))
                            .clickable {
                                inlineError = null
                                videoContext.coordinator.pauseAllInline()
                                showFullscreen = true
                            },
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(3.dp),
                        ) {
                            Icon(
                                imageVector = Icons.Default.Fullscreen,
                                contentDescription = "全画面再生",
                                tint = Color.White,
                                modifier = Modifier.size(14.dp),
                            )
                            Text(
                                text = "全画面",
                                fontSize = 10.5.sp,
                                fontWeight = FontWeight.Medium,
                                color = Color.White,
                            )
                        }
                    }

                    // Center Play button
                    Surface(
                        color = colors.indigoAction.copy(alpha = 0.92f),
                        shape = CircleShape,
                        shadowElevation = 4.dp,
                        modifier = Modifier.size(52.dp),
                    ) {
                        Box(contentAlignment = Alignment.Center) {
                            Icon(
                                imageVector = Icons.Default.PlayArrow,
                                contentDescription = "再生",
                                tint = Color.White,
                                modifier = Modifier.size(30.dp),
                            )
                        }
                    }

                    // Duration pill (bottom-right)
                    val durationLabel = VideoPlayerFormatting.formatDurationMs(previewMeta?.durationMs)
                    if (durationLabel != null) {
                        Surface(
                            color = Color.Black.copy(alpha = 0.68f),
                            shape = RoundedCornerShape(6.dp),
                            modifier = Modifier
                                .align(Alignment.BottomEnd)
                                .padding(8.dp),
                        ) {
                            Text(
                                text = durationLabel,
                                fontFamily = FontFamily.Monospace,
                                fontSize = 10.5.sp,
                                fontWeight = FontWeight.Medium,
                                color = Color.White,
                                modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                            )
                        }
                    }
                }
            }

            HorizontalDivider(thickness = 1.dp, color = colors.borderSubtle)
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 10.dp, vertical = 7.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Icon(
                    imageVector = Icons.Default.Videocam,
                    contentDescription = null,
                    tint = colors.indigo,
                    modifier = Modifier.size(14.dp),
                )
                Text(
                    text = caption,
                    fontSize = 11.5.sp,
                    fontWeight = FontWeight.Medium,
                    color = colors.textSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (isInlinePlaying) {
                    Surface(
                        color = colors.surfaceSubtle,
                        shape = RoundedCornerShape(6.dp),
                        border = BorderStroke(1.dp, colors.border),
                        modifier = Modifier
                            .clip(RoundedCornerShape(6.dp))
                            .clickable {
                                videoContext.coordinator.deactivateInline(instanceKey)
                            },
                    ) {
                        Text(
                            text = "停止",
                            fontSize = 10.5.sp,
                            fontWeight = FontWeight.Medium,
                            color = colors.textSecondary,
                            modifier = Modifier.padding(horizontal = 7.dp, vertical = 3.dp),
                        )
                    }
                }
                Surface(
                    color = colors.indigoBg,
                    shape = RoundedCornerShape(6.dp),
                    border = BorderStroke(1.dp, colors.indigoBorder),
                    modifier = Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .clickable {
                            inlineError = null
                            videoContext.coordinator.pauseAllInline()
                            showFullscreen = true
                        },
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 7.dp, vertical = 3.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(3.dp),
                    ) {
                        Icon(
                            imageVector = Icons.Default.Fullscreen,
                            contentDescription = "全画面再生",
                            tint = colors.indigoText,
                            modifier = Modifier.size(13.dp),
                        )
                        Text(
                            text = "全画面",
                            fontSize = 10.5.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = colors.indigoText,
                        )
                    }
                }
            }
        }
    }

    if (showFullscreen) {
        FullscreenVideoDialog(
            title = caption,
            subtitle = displayFileName,
            target = target,
            api = videoContext.api,
            initialPositionMs = resumePositionMs,
            onDismiss = { endPos ->
                resumePositionMs = endPos
                showFullscreen = false
            },
        )
    }
}

@Composable
private fun InlineExoPlayerStage(
    target: VideoPlaybackTarget,
    api: ConductorApiClient,
    aspectRatio: Float,
    initialPositionMs: Long,
    retryNonce: Int,
    onPositionChanged: (Long) -> Unit,
    onOpenFullscreen: (Long) -> Unit,
    onError: (String) -> Unit,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    var resolvedInlineUri by remember(target, retryNonce) { mutableStateOf<Uri?>(null) }
    var preparingInline by remember(target, retryNonce) {
        mutableStateOf(target is VideoPlaybackTarget.InlineData)
    }

    LaunchedEffect(target, retryNonce) {
        if (target is VideoPlaybackTarget.InlineData) {
            preparingInline = true
            resolvedInlineUri = runCatching { materializeInlineVideoFile(context, target) }
                .onFailure { onError("埋め込み動画の展開に失敗しました") }
                .getOrNull()
            preparingInline = false
        }
    }

    if (preparingInline) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 160.dp, max = 280.dp)
                .aspectRatio(aspectRatio, matchHeightConstraintsFirst = false)
                .background(Color.Black),
            contentAlignment = Alignment.Center,
        ) {
            CircularProgressIndicator(
                modifier = Modifier.size(26.dp),
                strokeWidth = 2.4.dp,
                color = Color.White,
            )
        }
        return
    }

    val player = remember(target, resolvedInlineUri, retryNonce) {
        buildExoPlayerForTarget(
            context = context,
            api = api,
            target = target,
            resolvedInlineUri = resolvedInlineUri,
        ).apply {
            if (initialPositionMs > 0L) {
                seekTo(initialPositionMs)
            }
            playWhenReady = true
        }
    }

    DisposableEffect(player, lifecycleOwner) {
        val listener = object : Player.Listener {
            override fun onPlayerError(error: PlaybackException) {
                onError(describePlaybackError(error))
            }
        }
        val lifecycleObserver = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_PAUSE || event == Lifecycle.Event.ON_STOP) {
                onPositionChanged(player.currentPosition.coerceAtLeast(0L))
                player.pause()
            }
        }
        player.addListener(listener)
        lifecycleOwner.lifecycle.addObserver(lifecycleObserver)
        onDispose {
            onPositionChanged(player.currentPosition.coerceAtLeast(0L))
            lifecycleOwner.lifecycle.removeObserver(lifecycleObserver)
            player.removeListener(listener)
            player.release()
        }
    }

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 160.dp, max = 280.dp)
            .aspectRatio(aspectRatio, matchHeightConstraintsFirst = false)
            .background(Color.Black),
    ) {
        AndroidView(
            factory = { ctx ->
                (LayoutInflater.from(ctx).inflate(
                    R.layout.conductor_video_player_view,
                    null,
                    false,
                ) as PlayerView).apply {
                    this.player = player
                    keepScreenOn = true
                }
            },
            update = { view ->
                if (view.player !== player) {
                    view.player = player
                }
            },
            modifier = Modifier.fillMaxSize(),
        )

        IconButton(
            onClick = {
                val currentPos = player.currentPosition.coerceAtLeast(0L)
                player.pause()
                onOpenFullscreen(currentPos)
            },
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(8.dp)
                .size(32.dp)
                .clip(CircleShape)
                .background(Color.Black.copy(alpha = 0.56f)),
        ) {
            Icon(
                imageVector = Icons.Default.Fullscreen,
                contentDescription = "全画面再生",
                tint = Color.White,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}

@Composable
private fun FullscreenVideoDialog(
    title: String,
    subtitle: String,
    target: VideoPlaybackTarget,
    api: ConductorApiClient,
    initialPositionMs: Long,
    onDismiss: (Long) -> Unit,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    var retryNonce by remember { mutableIntStateOf(0) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var isMuted by remember { mutableStateOf(false) }
    var lastPositionMs by remember { mutableLongStateOf(initialPositionMs) }
    var resolvedInlineUri by remember(target, retryNonce) { mutableStateOf<Uri?>(null) }
    var preparingInline by remember(target, retryNonce) {
        mutableStateOf(target is VideoPlaybackTarget.InlineData)
    }

    LaunchedEffect(target, retryNonce) {
        if (target is VideoPlaybackTarget.InlineData) {
            preparingInline = true
            resolvedInlineUri = runCatching { materializeInlineVideoFile(context, target) }
                .onFailure { errorMessage = "埋め込み動画の展開に失敗しました" }
                .getOrNull()
            preparingInline = false
        }
    }

    Dialog(
        onDismissRequest = { onDismiss(lastPositionMs) },
        properties = DialogProperties(
            usePlatformDefaultWidth = false,
            decorFitsSystemWindows = false,
        ),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color(0xFA06080C)),
        ) {
            if (errorMessage != null) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(horizontal = 24.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    MarkdownVideoErrorCard(
                        title = title,
                        detail = errorMessage ?: "動画を再生できませんでした",
                        filePath = subtitle,
                        onRetry = {
                            errorMessage = null
                            retryNonce++
                        },
                    )
                }
            } else if (preparingInline) {
                Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(color = Color.White)
                }
            } else {
                val player = remember(target, resolvedInlineUri, retryNonce) {
                    buildExoPlayerForTarget(
                        context = context,
                        api = api,
                        target = target,
                        resolvedInlineUri = resolvedInlineUri,
                    ).apply {
                        if (lastPositionMs > 0L) {
                            seekTo(lastPositionMs)
                        }
                        volume = if (isMuted) 0f else 1f
                        playWhenReady = true
                    }
                }

                LaunchedEffect(player, isMuted) {
                    player.volume = if (isMuted) 0f else 1f
                }

                DisposableEffect(player, lifecycleOwner) {
                    val listener = object : Player.Listener {
                        override fun onPlayerError(error: PlaybackException) {
                            errorMessage = describePlaybackError(error)
                        }
                    }
                    val lifecycleObserver = LifecycleEventObserver { _, event ->
                        if (event == Lifecycle.Event.ON_PAUSE || event == Lifecycle.Event.ON_STOP) {
                            lastPositionMs = player.currentPosition.coerceAtLeast(0L)
                            player.pause()
                        }
                    }
                    player.addListener(listener)
                    lifecycleOwner.lifecycle.addObserver(lifecycleObserver)
                    onDispose {
                        lastPositionMs = player.currentPosition.coerceAtLeast(0L)
                        lifecycleOwner.lifecycle.removeObserver(lifecycleObserver)
                        player.removeListener(listener)
                        player.release()
                    }
                }

                AndroidView(
                    factory = { ctx ->
                        (LayoutInflater.from(ctx).inflate(
                            R.layout.conductor_video_player_view,
                            null,
                            false,
                        ) as PlayerView).apply {
                            this.player = player
                            keepScreenOn = true
                        }
                    },
                    update = { view ->
                        if (view.player !== player) {
                            view.player = player
                        }
                    },
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(top = 64.dp, bottom = 16.dp)
                        .navigationBarsPadding(),
                )
            }

            // Top bar: title, mute toggle, close button
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .align(Alignment.TopCenter)
                    .background(Color.Black.copy(alpha = 0.65f))
                    .statusBarsPadding()
                    .padding(horizontal = 14.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(1.dp),
                ) {
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

                IconButton(
                    onClick = { isMuted = !isMuted },
                    modifier = Modifier
                        .size(36.dp)
                        .clip(CircleShape)
                        .background(Color.White.copy(alpha = 0.14f)),
                ) {
                    Icon(
                        imageVector = if (isMuted) Icons.AutoMirrored.Filled.VolumeOff else Icons.AutoMirrored.Filled.VolumeUp,
                        contentDescription = if (isMuted) "ミュート解除" else "ミュート",
                        tint = Color.White,
                        modifier = Modifier.size(19.dp),
                    )
                }

                IconButton(
                    onClick = { onDismiss(lastPositionMs) },
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
        }
    }
}

@Composable
private fun MarkdownVideoErrorCard(
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
                imageVector = Icons.Default.VideocamOff,
                contentDescription = null,
                tint = colors.rose,
                modifier = Modifier.size(16.dp),
            )
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Text(
                    text = title.ifBlank { "動画を再生できませんでした" },
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
