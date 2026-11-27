package dev.conductor.mobile.data

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import dev.conductor.mobile.model.PendingImageAttachment
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.UUID
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Pure-Kotlin image sizing, MIME normalization, and filename helpers
 * (kept Android-framework-free so they can be verified directly by JVM unit tests).
 */
object ImageAttachmentLogic {
    const val MAX_ATTACHMENTS = 8
    const val MAX_IMAGE_DIMENSION_PX = 1600
    const val MAX_ENCODED_IMAGE_BYTES = 2 * 1024 * 1024 // 2 MiB per compressed image
    const val DEFAULT_JPEG_QUALITY = 85

    fun computeSampleSize(srcWidth: Int, srcHeight: Int, maxDimension: Int): Int {
        if (srcWidth <= 0 || srcHeight <= 0 || maxDimension <= 0) return 1
        var sampleSize = 1
        var halfW = srcWidth / 2
        var halfH = srcHeight / 2
        while (max(halfW, halfH) >= maxDimension) {
            sampleSize *= 2
            halfW /= 2
            halfH /= 2
        }
        return sampleSize.coerceAtLeast(1)
    }

    fun computeTargetDimensions(srcWidth: Int, srcHeight: Int, maxDimension: Int): Pair<Int, Int> {
        if (srcWidth <= 0 || srcHeight <= 0 || maxDimension <= 0) return srcWidth to srcHeight
        val longest = max(srcWidth, srcHeight)
        if (longest <= maxDimension) return srcWidth to srcHeight
        val scale = maxDimension.toDouble() / longest.toDouble()
        val targetW = (srcWidth * scale).roundToInt().coerceAtLeast(1)
        val targetH = (srcHeight * scale).roundToInt().coerceAtLeast(1)
        return targetW to targetH
    }

    fun normalizeMimeType(rawMimeType: String?, fileName: String?): String {
        val cleaned = rawMimeType?.trim()?.lowercase()
        when (cleaned) {
            "image/png" -> return "image/png"
            "image/jpeg", "image/jpg" -> return "image/jpeg"
            "image/webp" -> return "image/webp"
            "image/gif" -> return "image/gif"
        }
        val ext = fileName?.substringAfterLast('.', "")?.lowercase()
        return when (ext) {
            "png" -> "image/png"
            "webp" -> "image/webp"
            "gif" -> "image/gif"
            else -> "image/jpeg"
        }
    }

    fun extensionForMimeType(mimeType: String): String = when (mimeType.lowercase()) {
        "image/png" -> "png"
        "image/webp" -> "webp"
        "image/gif" -> "gif"
        else -> "jpg"
    }

    fun sanitizeFileName(rawName: String?, mimeType: String, fallbackIndex: Int = 1): String {
        val ext = extensionForMimeType(mimeType)
        val cleaned = rawName
            ?.trim()
            ?.substringAfterLast('/')
            ?.substringAfterLast('\\')
            ?.takeIf { it.isNotBlank() }
            ?: return "image-$fallbackIndex.$ext"

        val base = cleaned.substringBeforeLast('.', cleaned).ifBlank { "image-$fallbackIndex" }
        val existingExt = cleaned.substringAfterLast('.', "").lowercase()
        val finalExt = when {
            existingExt == "jpeg" && ext == "jpg" -> "jpg"
            existingExt in setOf("png", "jpg", "jpeg", "webp", "gif") &&
                (existingExt == ext || (existingExt == "jpeg" && ext == "jpg")) -> existingExt
            else -> ext
        }
        return "$base.$finalExt"
    }

    fun buildDataUrl(mimeType: String, base64Payload: String): String =
        "data:${mimeType.lowercase()};base64,$base64Payload"

    fun formatByteSize(bytes: Int): String = when {
        bytes >= 1024 * 1024 -> String.format("%.1f MB", bytes / (1024.0 * 1024.0))
        bytes >= 1024 -> "${(bytes / 1024.0).roundToInt()} KB"
        else -> "$bytes B"
    }
}

/**
 * Bounded thread-safe in-memory LRU byte cache for attachment images.
 */
class AttachmentByteCache(
    private val maxTotalBytes: Int = 20 * 1024 * 1024,
) {
    private val map = LinkedHashMap<String, ByteArray>(16, 0.75f, true)
    private var currentBytes = 0

    @Synchronized
    fun get(key: String): ByteArray? = map[key]

    @Synchronized
    fun put(key: String, bytes: ByteArray) {
        if (bytes.isEmpty() || bytes.size > maxTotalBytes) return
        val previous = map.put(key, bytes)
        if (previous != null) {
            currentBytes -= previous.size
        }
        currentBytes += bytes.size
        val iterator = map.entries.iterator()
        while (currentBytes > maxTotalBytes && iterator.hasNext()) {
            val eldest = iterator.next()
            currentBytes -= eldest.value.size
            iterator.remove()
        }
    }

    @Synchronized
    fun clear() {
        map.clear()
        currentBytes = 0
    }

    @Synchronized
    fun totalBytes(): Int = currentBytes
}

/**
 * Reads user-selected Android ContentResolver image URIs, fixes EXIF orientation,
 * resizes/compresses safely off the main thread, and produces Conductor-compatible
 * base64 data URL attachments.
 */
class AndroidImageAttachmentProcessor(
    private val context: Context,
) {
    suspend fun processUri(uri: Uri, fallbackIndex: Int = 1): Result<PendingImageAttachment> =
        withContext(Dispatchers.IO) {
            runCatching {
                val resolver = context.contentResolver
                val rawName = queryDisplayName(uri)
                val rawMime = resolver.getType(uri)
                val sourceMime = ImageAttachmentLogic.normalizeMimeType(rawMime, rawName)

                // 1. Probe bounds (note: decodeStream intentionally returns null when inJustDecodeBounds=true)
                val boundsOpts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                val boundsStream = resolver.openInputStream(uri)
                    ?: throw IOException("画像を読み込めませんでした")
                boundsStream.use { stream ->
                    BitmapFactory.decodeStream(stream, null, boundsOpts)
                }

                if (boundsOpts.outWidth <= 0 || boundsOpts.outHeight <= 0) {
                    throw IOException("対応していない画像形式です")
                }

                // 2. Read EXIF orientation
                val orientation = runCatching {
                    resolver.openInputStream(uri)?.use { stream ->
                        ExifInterface(stream).getAttributeInt(
                            ExifInterface.TAG_ORIENTATION,
                            ExifInterface.ORIENTATION_NORMAL,
                        )
                    } ?: ExifInterface.ORIENTATION_NORMAL
                }.getOrDefault(ExifInterface.ORIENTATION_NORMAL)

                // 3. Subsampled decode to avoid OOM on high-MP phone photos
                val sampleSize = ImageAttachmentLogic.computeSampleSize(
                    srcWidth = boundsOpts.outWidth,
                    srcHeight = boundsOpts.outHeight,
                    maxDimension = ImageAttachmentLogic.MAX_IMAGE_DIMENSION_PX,
                )
                val decodeOpts = BitmapFactory.Options().apply {
                    inSampleSize = sampleSize
                    inPreferredConfig = Bitmap.Config.ARGB_8888
                }
                val decoded = resolver.openInputStream(uri)?.use { stream ->
                    BitmapFactory.decodeStream(stream, null, decodeOpts)
                } ?: throw IOException("画像のデコードに失敗しました")

                val oriented = applyExifOrientation(decoded, orientation)
                if (oriented !== decoded) {
                    decoded.recycle()
                }

                val (targetW, targetH) = ImageAttachmentLogic.computeTargetDimensions(
                    srcWidth = oriented.width,
                    srcHeight = oriented.height,
                    maxDimension = ImageAttachmentLogic.MAX_IMAGE_DIMENSION_PX,
                )
                val finalBitmap = if (targetW != oriented.width || targetH != oriented.height) {
                    Bitmap.createScaledBitmap(oriented, targetW, targetH, true).also {
                        if (it !== oriented) oriented.recycle()
                    }
                } else {
                    oriented
                }

                val encoded = try {
                    encodeBitmapWithinLimit(
                        bitmap = finalBitmap,
                        preferPng = (sourceMime == "image/png" || sourceMime == "image/webp") &&
                            finalBitmap.hasAlpha(),
                    )
                } finally {
                    finalBitmap.recycle()
                }

                val base64 = Base64.encodeToString(encoded.bytes, Base64.NO_WRAP)
                val dataUrl = ImageAttachmentLogic.buildDataUrl(encoded.mimeType, base64)
                val label = ImageAttachmentLogic.sanitizeFileName(rawName, encoded.mimeType, fallbackIndex)

                PendingImageAttachment(
                    id = UUID.randomUUID().toString(),
                    label = label,
                    mimeType = encoded.mimeType,
                    imageDataUrl = dataUrl,
                    byteSize = encoded.bytes.size,
                    previewBytes = encoded.bytes,
                )
            }
        }

    private fun queryDisplayName(uri: Uri): String? = runCatching {
        context.contentResolver.query(
            uri,
            arrayOf(OpenableColumns.DISPLAY_NAME),
            null,
            null,
            null,
        )?.use { cursor ->
            if (cursor.moveToFirst()) {
                val idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (idx >= 0) cursor.getString(idx) else null
            } else {
                null
            }
        }
    }.getOrNull()

    private fun applyExifOrientation(bitmap: Bitmap, orientation: Int): Bitmap {
        val matrix = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.setScale(-1f, 1f)
            ExifInterface.ORIENTATION_ROTATE_180 -> matrix.setRotate(180f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> {
                matrix.setRotate(180f)
                matrix.postScale(-1f, 1f)
            }
            ExifInterface.ORIENTATION_TRANSPOSE -> {
                matrix.setRotate(90f)
                matrix.postScale(-1f, 1f)
            }
            ExifInterface.ORIENTATION_ROTATE_90 -> matrix.setRotate(90f)
            ExifInterface.ORIENTATION_TRANSVERSE -> {
                matrix.setRotate(-90f)
                matrix.postScale(-1f, 1f)
            }
            ExifInterface.ORIENTATION_ROTATE_270 -> matrix.setRotate(270f)
            else -> return bitmap
        }
        return runCatching {
            Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
        }.getOrDefault(bitmap)
    }

    private data class EncodedImage(val bytes: ByteArray, val mimeType: String)

    private fun encodeBitmapWithinLimit(bitmap: Bitmap, preferPng: Boolean): EncodedImage {
        if (preferPng) {
            val out = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
            val pngBytes = out.toByteArray()
            if (pngBytes.size <= ImageAttachmentLogic.MAX_ENCODED_IMAGE_BYTES) {
                return EncodedImage(pngBytes, "image/png")
            }
        }

        val qualities = listOf(ImageAttachmentLogic.DEFAULT_JPEG_QUALITY, 74, 60, 48)
        var lastBytes = ByteArray(0)
        for (quality in qualities) {
            val out = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out)
            lastBytes = out.toByteArray()
            if (lastBytes.size <= ImageAttachmentLogic.MAX_ENCODED_IMAGE_BYTES) {
                return EncodedImage(lastBytes, "image/jpeg")
            }
        }
        return EncodedImage(lastBytes, "image/jpeg")
    }

    companion object {
        fun decodeBitmapSafe(bytes: ByteArray, maxDimension: Int): Bitmap? {
            if (bytes.isEmpty()) return null
            return runCatching {
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
                val opts = BitmapFactory.Options().apply {
                    inSampleSize = ImageAttachmentLogic.computeSampleSize(
                        bounds.outWidth,
                        bounds.outHeight,
                        maxDimension,
                    )
                }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
            }.getOrNull()
        }
    }
}
