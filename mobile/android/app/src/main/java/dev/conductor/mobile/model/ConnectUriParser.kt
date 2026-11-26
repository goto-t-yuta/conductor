package dev.conductor.mobile.model

import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

/**
 * Pure Kotlin parser for `conductor://connect?url=...&token=...` URIs
 * and server URL normalization (JVM unit-testable with zero Android dependencies).
 */
object ConnectUriParser {
    fun parse(rawInput: String): ConnectionConfig? {
        val trimmed = rawInput.trim()
        if (!trimmed.lowercase().startsWith("conductor://")) return null
        val uri = runCatching { URI(trimmed) }.getOrNull() ?: return null
        val query = uri.rawQuery ?: return null

        val params = mutableMapOf<String, String>()
        for (pair in query.split("&")) {
            val eqIdx = pair.indexOf('=')
            if (eqIdx <= 0) continue
            val key = decode(pair.substring(0, eqIdx))
            val value = decode(pair.substring(eqIdx + 1))
            params[key] = value
        }

        val url = normalizeServerUrl(params["url"].orEmpty())
        val token = params["token"].orEmpty().trim()
        if (url.isBlank() || token.isBlank()) return null
        return ConnectionConfig(serverUrl = url, bearerToken = token)
    }

    fun normalizeServerUrl(raw: String): String {
        val trimmed = raw.trim().trimEnd('/')
        if (trimmed.isBlank()) return ""
        val withScheme = if (trimmed.startsWith("http://", ignoreCase = true) ||
            trimmed.startsWith("https://", ignoreCase = true)
        ) {
            trimmed
        } else {
            "http://$trimmed"
        }
        return withScheme.trimEnd('/')
    }

    private fun decode(raw: String): String =
        runCatching { URLDecoder.decode(raw, StandardCharsets.UTF_8.name()) }.getOrDefault(raw)
}
