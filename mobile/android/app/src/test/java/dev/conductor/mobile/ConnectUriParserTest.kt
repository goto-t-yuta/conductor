package dev.conductor.mobile

import dev.conductor.mobile.model.ConnectUriParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ConnectUriParserTest {
    @Test
    fun parsesValidConductorConnectUri() {
        val uri =
            "conductor://connect?url=http%3A%2F%2F100.121.247.7%3A4789&token=abc123def456"
        val parsed = ConnectUriParser.parse(uri)
        assertEquals("http://100.121.247.7:4789", parsed?.serverUrl)
        assertEquals("abc123def456", parsed?.bearerToken)
    }

    @Test
    fun normalizesServerUrlWithoutSchemeOrWithTrailingSlash() {
        assertEquals("http://100.64.0.1:4789", ConnectUriParser.normalizeServerUrl("100.64.0.1:4789/"))
        assertEquals("https://mac.tail.ts.net", ConnectUriParser.normalizeServerUrl("https://mac.tail.ts.net///"))
        assertEquals("", ConnectUriParser.normalizeServerUrl("   "))
    }

    @Test
    fun rejectsMalformedOrIncompleteUris() {
        assertNull(ConnectUriParser.parse("https://example.com"))
        assertNull(ConnectUriParser.parse("conductor://connect?url=http://100.64.0.1:4789"))
        assertNull(ConnectUriParser.parse("conductor://connect?token=onlytoken"))
    }
}
