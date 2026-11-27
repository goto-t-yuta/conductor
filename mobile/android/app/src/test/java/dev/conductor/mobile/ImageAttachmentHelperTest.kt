package dev.conductor.mobile

import dev.conductor.mobile.data.AttachmentByteCache
import dev.conductor.mobile.data.ImageAttachmentLogic
import dev.conductor.mobile.model.PendingImageAttachment
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ImageAttachmentHelperTest {
    @Test
    fun computeSampleSizeScalesDownLargePhonePhotos() {
        assertEquals(1, ImageAttachmentLogic.computeSampleSize(1200, 900, 1600))
        assertEquals(2, ImageAttachmentLogic.computeSampleSize(4032, 3024, 1600))
        assertEquals(4, ImageAttachmentLogic.computeSampleSize(8000, 6000, 1600))
        assertEquals(1, ImageAttachmentLogic.computeSampleSize(0, 0, 1600))
    }

    @Test
    fun computeTargetDimensionsPreservesAspectRatio() {
        assertEquals(1200 to 900, ImageAttachmentLogic.computeTargetDimensions(1200, 900, 1600))
        assertEquals(1600 to 1200, ImageAttachmentLogic.computeTargetDimensions(4000, 3000, 1600))
        assertEquals(800 to 1600, ImageAttachmentLogic.computeTargetDimensions(1500, 3000, 1600))
    }

    @Test
    fun normalizeMimeTypeAndSanitizeFileNameProduceDesktopCompatibleNames() {
        assertEquals("image/png", ImageAttachmentLogic.normalizeMimeType("image/png", null))
        assertEquals("image/jpeg", ImageAttachmentLogic.normalizeMimeType("image/jpg", null))
        assertEquals("image/webp", ImageAttachmentLogic.normalizeMimeType(null, "clip.webp"))
        assertEquals("image/jpeg", ImageAttachmentLogic.normalizeMimeType("application/octet-stream", "photo.heic"))

        assertEquals("screenshot.png", ImageAttachmentLogic.sanitizeFileName("screenshot.png", "image/png"))
        assertEquals("IMG_001.jpg", ImageAttachmentLogic.sanitizeFileName("IMG_001.HEIC", "image/jpeg"))
        assertEquals("image-3.jpg", ImageAttachmentLogic.sanitizeFileName(null, "image/jpeg", fallbackIndex = 3))
        assertEquals(
            "data:image/jpeg;base64,ABCD",
            ImageAttachmentLogic.buildDataUrl("image/jpeg", "ABCD"),
        )
    }

    @Test
    fun attachmentByteCacheEvictsLeastRecentlyUsedEntries() {
        val cache = AttachmentByteCache(maxTotalBytes = 10)
        val a = byteArrayOf(1, 2, 3, 4)
        val b = byteArrayOf(5, 6, 7, 8)
        val c = byteArrayOf(9, 10, 11, 12)

        cache.put("a", a)
        cache.put("b", b)
        assertEquals(8, cache.totalBytes())

        // Touch "a" so "b" becomes least recently used
        assertArrayEquals(a, cache.get("a"))

        // Adding "c" (4 bytes) exceeds 10 bytes -> "b" is evicted, "a" and "c" remain
        cache.put("c", c)
        assertNull(cache.get("b"))
        assertArrayEquals(a, cache.get("a"))
        assertArrayEquals(c, cache.get("c"))
        assertEquals(8, cache.totalBytes())
    }

    @Test
    fun pendingImageAttachmentConvertsToDesktopCompatibleChatAttachment() {
        val pending = PendingImageAttachment(
            id = "att-123",
            label = "bug.jpg",
            mimeType = "image/jpeg",
            imageDataUrl = "data:image/jpeg;base64,AA==",
            byteSize = 2048,
            previewBytes = byteArrayOf(1, 2, 3),
        )
        val wire = pending.toChatAttachment()
        assertEquals("att-123", wire.id)
        assertEquals("image", wire.kind)
        assertEquals("bug.jpg", wire.label)
        assertEquals("data:image/jpeg;base64,AA==", wire.imageDataUrl)
        assertNull(wire.imagePath)
        assertTrue(ImageAttachmentLogic.formatByteSize(pending.byteSize).contains("KB"))
    }
}
