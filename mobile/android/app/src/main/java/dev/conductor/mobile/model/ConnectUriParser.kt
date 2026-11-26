package dev.conductor.mobile.model

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

/**
 * Pure Kotlin parser for Conductor pairing payloads:
 * - `conductor://connect?url=...&token=...`
 * - `conductor://link?url=...&token=...`
 * - JSON payload `{"url":"...","token":"..."}` (or `serverUrl`/`bearerToken`)
 *
 * JVM unit-testable with zero Android framework dependencies.
 */
object ConnectUriParser {
    private val acceptedHosts = setOf("connect", "link")
    private val json = Json { ignoreUnknownKeys = true }

    fun parse(rawInput: String): ConnectionConfig? {
        val trimmed = rawInput.trim()
        if (trimmed.isBlank()) return null

        // JSON payload support (e.g. from custom QR payloads)
        if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
            return parseJsonPayload(trimmed)
        }

        if (!trimmed.lowercase().startsWith("conductor://")) return null
        val uri = runCatching { URI(trimmed) }.getOrNull() ?: return null
        val host = uri.host?.lowercase().orEmpty()
        if (host.isNotBlank() && host !in acceptedHosts) return null
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

    private fun parseJsonPayload(rawJson: String): ConnectionConfig? {
        val obj = runCatching { json.parseToJsonElement(rawJson) as? JsonObject }.getOrNull()
            ?: return null
        val rawUrl = obj["url"]?.jsonPrimitive?.contentOrNull
            ?: obj["serverUrl"]?.jsonPrimitive?.contentOrNull
            ?: ""
        val rawToken = obj["token"]?.jsonPrimitive?.contentOrNull
            ?: obj["bearerToken"]?.jsonPrimitive?.contentOrNull
            ?: ""
        val url = normalizeServerUrl(rawUrl)
        val token = rawToken.trim()
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
