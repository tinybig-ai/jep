package dev.jep.client.data

import dev.jep.client.data.dto.AgentRes
import dev.jep.client.data.dto.AgentsRes
import dev.jep.client.data.dto.AttachRes
import dev.jep.client.data.dto.BrowseRes
import dev.jep.client.data.dto.DiffRes
import dev.jep.client.data.dto.ErrorDto
import dev.jep.client.data.dto.HarnessesRes
import dev.jep.client.data.dto.HistoryRes
import dev.jep.client.data.dto.ImportableRes
import dev.jep.client.data.dto.McpRes
import dev.jep.client.data.dto.MessageRes
import dev.jep.client.data.dto.MkdirRes
import dev.jep.client.data.dto.NextCodeRes
import dev.jep.client.data.dto.ModelsRes
import dev.jep.client.data.dto.SkillsRes
import dev.jep.client.data.dto.NewSessionRes
import dev.jep.client.data.dto.PairRes
import dev.jep.client.data.dto.TermFrameRes
import dev.jep.client.data.dto.TermStatusRes
import dev.jep.client.data.dto.SessionDto
import dev.jep.client.data.dto.SessionsRes
import dev.jep.client.data.dto.UsageRes
import dev.jep.client.data.dto.WorkspacesRes
import dev.jep.client.domain.repository.ChatEvent
import dev.jep.client.domain.repository.HistoryBatch
import dev.jep.client.domain.repository.ModelChoices
import dev.jep.client.domain.repository.TurnAborted
import dev.jep.client.domain.model.BrowseResult
import dev.jep.client.domain.model.AgentInfo
import dev.jep.client.domain.model.ChatMessage
import dev.jep.client.domain.model.FileDiff
import dev.jep.client.domain.model.Harnesses
import dev.jep.client.domain.model.ImportableSession
import dev.jep.client.domain.model.McpServer
import dev.jep.client.domain.repository.ChatRepository
import dev.jep.client.domain.model.SessionSummary
import dev.jep.client.domain.model.TerminalAccess
import dev.jep.client.domain.model.SkillSet
import dev.jep.client.domain.model.Usage
import dev.jep.client.domain.model.Workspace
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import android.util.Base64
import java.net.URLEncoder

// The gateway's protocol, behind the one port the app knows. OkHttp lives
// here and nowhere else; domain and presentation stay transport-blind.
class GatewayChatRepository(
    private val base: String,
    private val token: () -> String?,
    private val http: OkHttpClient,
    /** the daemon rotates its pairing code per use; every response that carries
     * the next one hands it here, so the person never has to go and read it */
    private val onNextCode: (String?) -> Unit = {},
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
            throw ApiFailure(code, err?.message ?: err?.error ?: "gateway said $code")
        }
        // a whole conversation can be megabytes; never decode it on the UI thread
        return withContext(Dispatchers.Default) { json.decodeFromString(serializer, text) }
    }

    override suspend fun pair(baseUrl: String, code: String): String {
        val (code_, text) = postUnauthed("$baseUrl/pair", payload("code" to code))
        if (code_ != 200) {
            val err = runCatching { json.decodeFromString(ErrorDto.serializer(), text) }.getOrNull()
            throw ApiFailure(code_, err?.message ?: err?.error ?: "pairing failed")
        }
        val res = json.decodeFromString(PairRes.serializer(), text)
        onNextCode(res.nextCode)
        return res.token
    }

    private suspend fun postUnauthed(url: String, body: String): Pair<Int, String> =
        withContext(Dispatchers.IO) {
            val req = Request.Builder().url(url).post(body.toRequestBody(jsonMedia)).build()
            http.newCall(req).execute().use { it.code to it.body?.string().orEmpty() }
        }

    override suspend fun sessions(): List<SessionSummary> =
        decode("/sessions", SessionsRes.serializer()).items.map { it.toDomain() }

    override suspend fun workspaces(): List<Workspace> =
        decode("/workspaces", WorkspacesRes.serializer()).items.map { it.toDomain() }

    override suspend fun harnesses(): Harnesses {
        val res = decode("/harnesses", HarnessesRes.serializer(), "{}")
        return Harnesses(res.harnesses, res.default)
    }

    override suspend fun browse(path: String?): BrowseResult =
        decode(
            "/browse",
            BrowseRes.serializer(),
            buildJsonObject { path?.let { put("path", it) } }.toString(),
        ).toDomain()

    override suspend fun newFolder(path: String?, name: String): String {
        val body = buildJsonObject {
            path?.let { put("path", it) }
            put("name", name)
        }.toString()
        return decode("/mkdir", MkdirRes.serializer(), body).path
    }

    override suspend fun archivedSessions(): List<SessionSummary> =
        decode("/archived", SessionsRes.serializer()).items.map { it.toDomain() }

    override suspend fun newSession(title: String?, workspace: String?, path: String?, harness: String?): SessionSummary {
        val body = buildJsonObject {
            title?.let { put("title", it) }
            workspace?.let { put("workspace", it) }
            path?.let { put("path", it) }
            harness?.let { put("harness", it) }
        }.toString()
        return decode("/new", NewSessionRes.serializer(), body).session.toDomain()
    }

    override suspend fun models(sessionId: String): ModelChoices {
        val res = decode("/models", ModelsRes.serializer(), payload("id" to sessionId))
        return ModelChoices(res.models.map { it.toDomain() }, res.current, res.default)
    }

    override suspend fun setModel(sessionId: String, ref: String?): Boolean =
        post("/setmodel", payload("id" to sessionId, "model" to (ref ?: ""))).first in 200..299

    override suspend fun agent(sessionId: String): String? =
        decode("/agent", AgentRes.serializer(), payload("id" to sessionId)).current

    override suspend fun agents(sessionId: String): List<AgentInfo> =
        decode("/agents", AgentsRes.serializer(), payload("id" to sessionId)).agents.map { it.toDomain() }

    override suspend fun setAgent(sessionId: String, agent: String?): Boolean =
        post("/setagent", payload("id" to sessionId, "agent" to (agent ?: ""))).first in 200..299

    override suspend fun usage(sessionId: String): Usage =
        decode("/usage", UsageRes.serializer(), payload("id" to sessionId)).usage.toDomain()

    override suspend fun diff(sessionId: String): List<FileDiff> =
        decode("/diff", DiffRes.serializer(), payload("id" to sessionId)).files.map { it.toDomain() }

    override suspend fun skills(sessionId: String): SkillSet =
        decode("/skills", SkillsRes.serializer(), payload("id" to sessionId)).toDomain()

    override suspend fun setSkill(sessionId: String, path: String, disabled: Boolean): Boolean =
        post("/setskill", buildJsonObject { put("id", sessionId); put("path", path); put("disabled", disabled) }.toString()).first in 200..299

    override suspend fun mcp(sessionId: String): List<McpServer> =
        decode("/mcp", McpRes.serializer(), payload("id" to sessionId)).servers.map { it.toDomain() }

    override suspend fun setMcp(sessionId: String, name: String, enabled: Boolean): Boolean =
        post("/setmcp", buildJsonObject { put("id", sessionId); put("name", name); put("enabled", enabled) }.toString()).first in 200..299

    override suspend fun subagents(sessionId: String): List<SessionSummary> =
        decode("/subagents", SessionsRes.serializer(), payload("id" to sessionId)).items.map { it.toDomain() }

    override suspend fun importableSessions(): List<ImportableSession> =
        decode("/importable", ImportableRes.serializer(), "{}").sessions.map { it.toDomain() }

    override suspend fun importSession(sessionId: String): Boolean =
        post("/import", payload("id" to sessionId)).first in 200..299

    override suspend fun archiveSession(sessionId: String): Boolean =
        post("/archive", payload("id" to sessionId)).first in 200..299

    override suspend fun unarchiveSession(sessionId: String): Boolean =
        post("/unarchive", payload("id" to sessionId)).first in 200..299

    override suspend fun terminalStatus(): TerminalAccess {
        val r = decode("/term", TermStatusRes.serializer(), "{}")
        return TerminalAccess(r.allowed, r.authorized)
    }

    override suspend fun unlockTerminal(code: String): Boolean {
        val (status, text) = post("/term/unlock", payload("code" to code))
        if (status in 200..299) {
            onNextCode(runCatching { json.decodeFromString(NextCodeRes.serializer(), text) }.getOrNull()?.nextCode)
        }
        return status in 200..299
    }

    override suspend fun lockTerminal(): Boolean = post("/term/lock", "{}").first in 200..299

    override suspend fun termOpen(sessionId: String): Boolean =
        post("/term/open", payload("id" to sessionId)).first in 200..299

    override suspend fun termFrame(sessionId: String): String =
        decode("/term/frame", TermFrameRes.serializer(), payload("id" to sessionId)).text

    override suspend fun termInput(sessionId: String, text: String): Boolean =
        post("/term/input", payload("id" to sessionId, "text" to text)).first in 200..299

    override suspend fun termKey(sessionId: String, key: String): Boolean =
        post("/term/input", payload("id" to sessionId, "key" to key)).first in 200..299

    override suspend fun termClose(sessionId: String): Boolean =
        post("/term/close", payload("id" to sessionId)).first in 200..299

    override suspend fun history(sessionId: String, limit: Int, before: Long, have: Int): HistoryBatch =
        withContext(Dispatchers.Default) {
            val res = decode(
                "/history",
                HistoryRes.serializer(),
                buildJsonObject {
                    put("id", sessionId)
                    if (limit > 0) put("limit", limit)
                    if (before > 0) put("before", before)
                    if (have > 0) put("have", have)
                }.toString(),
            )
            HistoryBatch(res.messages.map { it.toDomain() }, res.hasMore)
        }

    override suspend fun prompt(sessionId: String, text: String, files: List<String>): ChatMessage {
        val body = buildJsonObject {
            put("id", sessionId)
            put("text", text)
            if (files.isNotEmpty()) put("files", JsonArray(files.map { JsonPrimitive(it) }))
        }.toString()
        val dto = try {
            decode("/prompt", MessageRes.serializer(), body)
        } catch (e: ApiFailure) {
            // 409 is "a turn is already running": say so in words, not the
            // gateway's bare "busy"
            if (e.status == 409) throw ApiFailure(409, "the agent is still working on the last reply")
            throw e
        }
        // a stop is not a failure: the gateway answers {aborted:true} rather
        // than an error, and the caller renders it as a stop
        if (dto.aborted) throw TurnAborted()
        return (dto.message ?: error("gateway returned no message for the turn")).toDomain()
    }

    override suspend fun rename(sessionId: String, title: String): Boolean =
        post("/rename", payload("id" to sessionId, "title" to title)).first in 200..299

    override suspend fun delete(sessionId: String): Boolean =
        post("/delete", payload("id" to sessionId)).first in 200..299

    override suspend fun attach(sessionId: String, filename: String, bytes: ByteArray): String {
        val q = "id=${URLEncoder.encode(sessionId, "UTF-8")}&name=${URLEncoder.encode(filename, "UTF-8")}"
        val res = withContext(Dispatchers.IO) {
            val builder = Request.Builder().url("$base/attach?$q")
            token()?.let { builder.header("authorization", "Bearer $it") }
            val req = builder.post(bytes.toRequestBody("application/octet-stream".toMediaType())).build()
            http.newCall(req).execute().use { it.code to it.body?.string().orEmpty() }
        }
        if (res.first !in 200..299) {
            val err = runCatching { json.decodeFromString(ErrorDto.serializer(), res.second) }.getOrNull()
            throw ApiFailure(res.first, err?.message ?: err?.error ?: "gateway said ${res.first}")
        }
        return json.decodeFromString(AttachRes.serializer(), res.second).id
    }

    override suspend fun stop(sessionId: String): Boolean =
        post("/stop", payload("id" to sessionId)).first in 200..299

    override fun fileUrl(path: String): String {
        // the pairing token rides in the query because the image loader fetches
        // this URL on its own, outside the repository's header path
        val enc = Base64.encodeToString(path.toByteArray(Charsets.UTF_8), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        return "$base/file?p=$enc&token=${token() ?: ""}"
    }

    override suspend fun respond(askId: String, optionId: String): Boolean =
        post("/respond", payload("askID" to askId, "optionID" to optionId)).first in 200..299

    override fun events(): Flow<ChatEvent> = GatewayEventStream(base, token).open(http)
}
