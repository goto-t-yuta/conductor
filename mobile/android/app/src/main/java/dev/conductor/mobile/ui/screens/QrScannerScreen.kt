package dev.conductor.mobile.ui.screens

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import android.util.Size
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.FlashlightOff
import androidx.compose.material.icons.filled.FlashlightOn
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.graphics.ClipOp
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.NotFoundException
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import dev.conductor.mobile.model.ConnectUriParser
import dev.conductor.mobile.ui.theme.ConductorEmerald
import dev.conductor.mobile.ui.theme.ConductorTheme
import kotlinx.coroutines.delay
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

@Composable
fun QrScannerScreen(
    onQrCodeScanned: (String) -> Unit,
    onClose: () -> Unit,
) {
    BackHandler(onBack = onClose)

    val context = LocalContext.current
    var hasCameraPermission by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED,
        )
    }
    var permissionRequested by remember { mutableStateOf(false) }

    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission(),
    ) { granted ->
        hasCameraPermission = granted
        permissionRequested = true
    }

    LaunchedEffect(Unit) {
        if (!hasCameraPermission) {
            permissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    Surface(
        modifier = Modifier.fillMaxSize(),
        color = Color.Black,
    ) {
        if (hasCameraPermission) {
            CameraQrScannerContent(
                onQrCodeScanned = onQrCodeScanned,
                onClose = onClose,
            )
        } else {
            CameraPermissionFallback(
                permissionRequested = permissionRequested,
                onRequestPermission = { permissionLauncher.launch(Manifest.permission.CAMERA) },
                onOpenAppSettings = {
                    val intent = Intent(
                        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.fromParts("package", context.packageName, null),
                    )
                    context.startActivity(intent)
                },
                onClose = onClose,
            )
        }
    }
}

@Composable
private fun CameraQrScannerContent(
    onQrCodeScanned: (String) -> Unit,
    onClose: () -> Unit,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val mainExecutor = remember(context) { ContextCompat.getMainExecutor(context) }
    val analysisExecutor = remember { Executors.newSingleThreadExecutor() }
    val scanConsumed = remember { AtomicBoolean(false) }

    var boundCamera by remember { mutableStateOf<Camera?>(null) }
    var torchEnabled by remember { mutableStateOf(false) }
    var cameraError by remember { mutableStateOf<String?>(null) }
    var invalidQrHint by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(invalidQrHint) {
        if (invalidQrHint != null) {
            delay(2_500L)
            invalidQrHint = null
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            runCatching { boundCamera?.cameraControl?.enableTorch(false) }
            analysisExecutor.shutdown()
        }
    }

    val analyzer = remember {
        QrCodeImageAnalyzer { rawText ->
            if (scanConsumed.get()) return@QrCodeImageAnalyzer
            val parsed = ConnectUriParser.parse(rawText)
            if (parsed != null) {
                if (scanConsumed.compareAndSet(false, true)) {
                    mainExecutor.execute {
                        onQrCodeScanned(rawText)
                    }
                }
            } else {
                mainExecutor.execute {
                    invalidQrHint = "Step 2 のリンク用 QR コードを読み取ってください"
                }
            }
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { ctx ->
                val previewView = PreviewView(ctx).apply {
                    implementationMode = PreviewView.ImplementationMode.COMPATIBLE
                    scaleType = PreviewView.ScaleType.FILL_CENTER
                }

                val cameraProviderFuture = ProcessCameraProvider.getInstance(ctx)
                cameraProviderFuture.addListener(
                    {
                        try {
                            val cameraProvider = cameraProviderFuture.get()
                            val preview = Preview.Builder().build().also {
                                it.surfaceProvider = previewView.surfaceProvider
                            }

                            val resolutionSelector = ResolutionSelector.Builder()
                                .setResolutionStrategy(
                                    ResolutionStrategy(
                                        Size(1280, 720),
                                        ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER,
                                    ),
                                )
                                .build()

                            val imageAnalysis = ImageAnalysis.Builder()
                                .setResolutionSelector(resolutionSelector)
                                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                                .build()
                                .also { analysis ->
                                    analysis.setAnalyzer(analysisExecutor, analyzer)
                                }

                            cameraProvider.unbindAll()
                            val camera = cameraProvider.bindToLifecycle(
                                lifecycleOwner,
                                CameraSelector.DEFAULT_BACK_CAMERA,
                                preview,
                                imageAnalysis,
                            )
                            boundCamera = camera
                            cameraError = null
                        } catch (e: Exception) {
                            cameraError = "カメラの起動に失敗しました: ${e.message ?: "unknown error"}"
                        }
                    },
                    mainExecutor,
                )

                previewView
            },
        )

        // Framing overlay
        ScannerOverlay(modifier = Modifier.fillMaxSize())

        // Top controls bar
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .statusBarsPadding()
                .padding(horizontal = 16.dp, vertical = 12.dp)
                .align(Alignment.TopCenter),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            IconButton(
                onClick = onClose,
                modifier = Modifier.background(Color.Black.copy(alpha = 0.55f), CircleShape),
            ) {
                Icon(
                    imageVector = Icons.Default.Close,
                    contentDescription = "閉じる",
                    tint = Color.White,
                )
            }

            Text(
                text = "QRコードをスキャンしてリンク",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                color = Color.White,
            )

            val hasFlash = boundCamera?.cameraInfo?.hasFlashUnit() == true
            IconButton(
                onClick = {
                    val next = !torchEnabled
                    torchEnabled = next
                    boundCamera?.cameraControl?.enableTorch(next)
                },
                enabled = hasFlash,
                modifier = Modifier.background(Color.Black.copy(alpha = 0.55f), CircleShape),
            ) {
                Icon(
                    imageVector = if (torchEnabled) {
                        Icons.Default.FlashlightOn
                    } else {
                        Icons.Default.FlashlightOff
                    },
                    contentDescription = "ライト切替",
                    tint = if (hasFlash) Color.White else Color.White.copy(alpha = 0.35f),
                )
            }
        }

        // Bottom instructions & feedback
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .align(Alignment.BottomCenter)
                .navigationBarsPadding()
                .padding(horizontal = 24.dp, vertical = 32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            val feedback = cameraError ?: invalidQrHint
            if (feedback != null) {
                Surface(
                    color = Color(0xFFD97706).copy(alpha = 0.92f),
                    shape = RoundedCornerShape(12.dp),
                ) {
                    Text(
                        text = feedback,
                        modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
                        style = MaterialTheme.typography.bodySmall,
                        fontWeight = FontWeight.Medium,
                        color = Color.White,
                        textAlign = TextAlign.Center,
                    )
                }
            }

            Surface(
                color = Color.Black.copy(alpha = 0.65f),
                shape = RoundedCornerShape(14.dp),
            ) {
                Text(
                    text = "デスクトップの Conductor「設定 → リモートアクセス → Step 2」の QR コードを枠内に合わせてください",
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                    style = MaterialTheme.typography.bodySmall,
                    color = Color.White.copy(alpha = 0.92f),
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}

@Composable
private fun ScannerOverlay(modifier: Modifier = Modifier) {
    Canvas(modifier = modifier) {
        val boxSize = (size.minDimension * 0.68f).coerceIn(220.dp.toPx(), 320.dp.toPx())
        val left = (size.width - boxSize) / 2f
        val top = (size.height - boxSize) / 2f
        val right = left + boxSize
        val bottom = top + boxSize
        val cornerRadiusPx = 20.dp.toPx()

        val cutoutPath = Path().apply {
            addRoundRect(
                RoundRect(
                    rect = Rect(left, top, right, bottom),
                    cornerRadius = CornerRadius(cornerRadiusPx, cornerRadiusPx),
                ),
            )
        }

        clipPath(cutoutPath, clipOp = ClipOp.Difference) {
            drawRect(color = Color.Black.copy(alpha = 0.58f))
        }

        // Subtle border around scan frame
        drawRoundRect(
            color = Color.White.copy(alpha = 0.35f),
            topLeft = Offset(left, top),
            size = androidx.compose.ui.geometry.Size(boxSize, boxSize),
            cornerRadius = CornerRadius(cornerRadiusPx, cornerRadiusPx),
            style = Stroke(width = 1.5.dp.toPx()),
        )

        // Bright emerald corner brackets
        val bracketLen = 28.dp.toPx()
        val strokeWidth = 4.dp.toPx()
        val accent = ConductorEmerald

        // Top-left
        drawLine(accent, Offset(left, top + bracketLen), Offset(left, top), strokeWidth, StrokeCap.Round)
        drawLine(accent, Offset(left, top), Offset(left + bracketLen, top), strokeWidth, StrokeCap.Round)
        // Top-right
        drawLine(accent, Offset(right - bracketLen, top), Offset(right, top), strokeWidth, StrokeCap.Round)
        drawLine(accent, Offset(right, top), Offset(right, top + bracketLen), strokeWidth, StrokeCap.Round)
        // Bottom-left
        drawLine(accent, Offset(left, bottom - bracketLen), Offset(left, bottom), strokeWidth, StrokeCap.Round)
        drawLine(accent, Offset(left, bottom), Offset(left + bracketLen, bottom), strokeWidth, StrokeCap.Round)
        // Bottom-right
        drawLine(accent, Offset(right - bracketLen, bottom), Offset(right, bottom), strokeWidth, StrokeCap.Round)
        drawLine(accent, Offset(right, bottom), Offset(right, bottom - bracketLen), strokeWidth, StrokeCap.Round)
    }
}

@Composable
private fun CameraPermissionFallback(
    permissionRequested: Boolean,
    onRequestPermission: () -> Unit,
    onOpenAppSettings: () -> Unit,
    onClose: () -> Unit,
) {
    val colors = ConductorTheme.colors
    Surface(
        modifier = Modifier.fillMaxSize(),
        color = colors.canvas,
    ) {
        Box(modifier = Modifier.fillMaxSize()) {
            IconButton(
                onClick = onClose,
                modifier = Modifier
                    .statusBarsPadding()
                    .padding(12.dp)
                    .align(Alignment.TopStart),
            ) {
                Icon(Icons.Default.Close, contentDescription = "閉じる", tint = colors.textPrimary)
            }

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .align(Alignment.Center)
                    .padding(horizontal = 28.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Box(
                    modifier = Modifier
                        .size(64.dp)
                        .background(colors.indigoBg, RoundedCornerShape(18.dp)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = Icons.Default.CameraAlt,
                        contentDescription = null,
                        tint = colors.indigo,
                        modifier = Modifier.size(32.dp),
                    )
                }
                Text(
                    text = "カメラ権限が必要です",
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.SemiBold,
                    color = colors.textPrimary,
                    textAlign = TextAlign.Center,
                )
                Text(
                    text = "デスクトップの Conductor に表示されたリンク用 QR コードを読み取るため、カメラへのアクセスを許可してください。",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.textMuted,
                    textAlign = TextAlign.Center,
                )
                Spacer(modifier = Modifier.height(6.dp))
                Button(
                    onClick = onRequestPermission,
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("カメラ権限を許可する")
                }
                if (permissionRequested) {
                    OutlinedButton(
                        onClick = onOpenAppSettings,
                        shape = RoundedCornerShape(10.dp),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("アプリの設定を開く")
                    }
                }
                OutlinedButton(
                    onClick = onClose,
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("キャンセル")
                }
            }
        }
    }
}

/**
 * CameraX ImageAnalysis.Analyzer that decodes QR codes from YUV_420_888 frames
 * using ZXing's pure-JVM MultiFormatReader (zero Google Play Services dependency).
 */
private class QrCodeImageAnalyzer(
    private val onDecoded: (String) -> Unit,
) : ImageAnalysis.Analyzer {

    private val reader = MultiFormatReader().apply {
        setHints(
            mapOf(
                DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
                DecodeHintType.TRY_HARDER to true,
            ),
        )
    }

    private var rowAlignedBuffer: ByteArray = ByteArray(0)

    override fun analyze(imageProxy: ImageProxy) {
        try {
            val plane = imageProxy.planes.firstOrNull() ?: return
            val width = imageProxy.width
            val height = imageProxy.height
            if (width <= 0 || height <= 0) return

            val yBytes = extractLuminanceBytes(plane, width, height)
            val source = PlanarYUVLuminanceSource(
                yBytes,
                width,
                height,
                0,
                0,
                width,
                height,
                false,
            )

            val decoded = decodeSource(source) ?: decodeSource(source.invert())
            if (!decoded.isNullOrBlank()) {
                onDecoded(decoded)
            }
        } catch (_: Exception) {
            // Ignore transient frame decoding errors
        } finally {
            reader.reset()
            imageProxy.close()
        }
    }

    private fun decodeSource(source: com.google.zxing.LuminanceSource): String? =
        try {
            reader.decodeWithState(BinaryBitmap(HybridBinarizer(source))).text
        } catch (_: NotFoundException) {
            null
        }

    private fun extractLuminanceBytes(
        plane: ImageProxy.PlaneProxy,
        width: Int,
        height: Int,
    ): ByteArray {
        val needed = width * height
        if (rowAlignedBuffer.size < needed) {
            rowAlignedBuffer = ByteArray(needed)
        }
        val buffer = plane.buffer.duplicate()
        buffer.rewind()
        val rowStride = plane.rowStride
        if (rowStride == width) {
            buffer.get(rowAlignedBuffer, 0, needed)
        } else {
            val row = ByteArray(rowStride)
            var dstOffset = 0
            for (y in 0 until height) {
                val toRead = minOf(rowStride, buffer.remaining())
                if (toRead <= 0) break
                buffer.get(row, 0, toRead)
                System.arraycopy(row, 0, rowAlignedBuffer, dstOffset, minOf(width, toRead))
                dstOffset += width
            }
        }
        return rowAlignedBuffer
    }
}
