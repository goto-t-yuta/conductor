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
    fun parsesValidConductorLinkUri() {
        val uri =
            "conductor://link?url=http%3A%2F%2F100.121.247.7%3A4789%2F&token=linkToken987"
        val parsed = ConnectUriParser.parse(uri)
        assertEquals("http://100.121.247.7:4789", parsed?.serverUrl)
        assertEquals("linkToken987", parsed?.bearerToken)
    }

    @Test
    fun parsesJsonQrPayloads() {
        val jsonPayload = """{"url":"http://100.64.0.10:4789/","token":"json-secret-1"}"""
        val parsed = ConnectUriParser.parse(jsonPayload)
        assertEquals("http://100.64.0.10:4789", parsed?.serverUrl)
        assertEquals("json-secret-1", parsed?.bearerToken)

        val altJson = """{"serverUrl":"100.64.0.11:4789","bearerToken":"alt-secret-2"}"""
        val parsedAlt = ConnectUriParser.parse(altJson)
        assertEquals("http://100.64.0.11:4789", parsedAlt?.serverUrl)
        assertEquals("alt-secret-2", parsedAlt?.bearerToken)
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
        assertNull(ConnectUriParser.parse("https://github.com/goto-t-yuta/conductor/releases/latest"))
        assertNull(ConnectUriParser.parse("conductor://other?url=http://100.64.0.1:4789&token=tok"))
        assertNull(ConnectUriParser.parse("conductor://connect?url=http://100.64.0.1:4789"))
        assertNull(ConnectUriParser.parse("conductor://connect?token=onlytoken"))
        assertNull(ConnectUriParser.parse("""{"url":"http://100.64.0.1:4789"}"""))
        assertNull(ConnectUriParser.parse("{not-valid-json}"))
    }
}
