package dev.jep.client.data

import dev.jep.client.data.dto.ErrorDto
import dev.jep.client.data.dto.HistoryRes
import dev.jep.client.data.dto.MessageRes
import dev.jep.client.data.dto.NewSessionRes
import dev.jep.client.data.dto.PairRes
import dev.jep.client.data.dto.SessionDto
import dev.jep.client.data.dto.SessionsRes
import dev.jep.client.domain.repository.ChatEvent
import dev.jep.client.domain.model.ChatMessage
import dev.jep.client.domain.repository.ChatRepository
import dev.jep.client.domain.model.SessionSummary
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

// The gateway's protocol, behind the one port the app knows. OkHttp lives
// here and nowhere else; domain and presentation stay transport-blind.
class GatewayChatRepository(
    private val base: String,
    private val token: () -> String?,
    private val http: OkHttpClient,
) : ChatRepository {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }
    private val jsonMedia = "application/json".toMediaType()

    class ApiFailure(val status: Int, message: String?) : RuntimeException(message ?: "gateway said $status")

    private fun payload(vararg fields: Pair<String, String>): String =
        buildJsonObject { fields.forEach { (k, v) -> put(k, v) } }.toString()

    private suspend fun post(path: String, body: String = "{}"): Pair<Int, String> =
        withContext(Dispatchers.IO) {
            val builder = Request.Builder().url(base + path)
            token()?.let { builder.header("authorization", "Bearer $it") }
            val req = builder.post(body.toRequestBody(jsonMedia)).build()
            http.newCall(req).execute().use { res -> res.code to res.body?.string().orEmpty() }
        }

    private suspend fun <T> decode(
        path: String,
        serializer: kotlinx.serialization.KSerializer<T>,
        body: String = "{}",
    ): T {
        val (code, text) = post(path, body)
        if (code !in 200..299) {
            val err = runCatching { json.decodeFromString(ErrorDto.serializer(), text) }.getOrNull()
            throw ApiFailure(code, err?.message ?: "gateway said $code")
        }
        return json.decodeFromString(serializer, text)
    }

    override suspend fun pair(baseUrl: String, code: String): String {
        val (code_, text) = postUnauthed("$baseUrl/pair", payload("code" to code))
        if (code_ != 200) {
            val err = runCatching { json.decodeFromString(ErrorDto.serializer(), text) }.getOrNull()
            throw ApiFailure(code_, err?.message ?: "pairing failed")
        }
        return json.decodeFromString(PairRes.serializer(), text).token
    }

    private suspend fun postUnauthed(url: String, body: String): Pair<Int, String> =
        withContext(Dispatchers.IO) {
            val req = Request.Builder().url(url).post(body.toRequestBody(jsonMedia)).build()
            http.newCall(req).execute().use { it.code to it.body?.string().orEmpty() }
        }

    override suspend fun sessions(): List<SessionSummary> =
        decode("/sessions", SessionsRes.serializer()).items.map { it.toDomain() }

    override suspend fun newSession(title: String?): SessionSummary = (if (title == null) decode("/new", NewSessionRes.serializer()) else decode("/new", NewSessionRes.serializer(), payload("title" to title))).session.toDomain()

    override suspend fun history(sessionId: String): List<ChatMessage> =
        decode("/history", HistoryRes.serializer(), payload("id" to sessionId)).messages.map { it.toDomain() }

    override suspend fun prompt(sessionId: String, text: String): ChatMessage {
        val dto = decode("/prompt", MessageRes.serializer(), payload("id" to sessionId, "text" to text))
        return (dto.message ?: error("gateway returned no message for the turn")).toDomain()
    }

    override suspend fun stop(sessionId: String): Boolean =
        post("/stop", payload("id" to sessionId)).first in 200..299

    override suspend fun respond(askId: String, optionId: String): Boolean =
        post("/respond", payload("askID" to askId, "optionID" to optionId)).first in 200..299

    override fun events(): Flow<ChatEvent> = GatewayEventStream(base, token).open(http)
}
