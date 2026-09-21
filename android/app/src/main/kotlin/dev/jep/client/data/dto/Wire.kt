package dev.jep.client.data.dto

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

// Flat, tolerant DTOs mirroring the gateway JSON (docs/GATEWAY.md). Every field
// optional-padded so an unknown variant can ride through without breaking the
// parser; mapping into domain types is data/'s job, never the UI's.

@Serializable
data class PairRes(val token: String)

@Serializable
data class SessionDto(
    val id: String,
    val title: String = "",
    val workspace: String = "",
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
    // workspace's friendly name (display) …
    val adapter: String? = null,
    // … and the engine behind it (opencode/codex/claude); display-only, a
    // conversation never changes harness.
    val harness: String? = null,
)

@Serializable
data class SessionsRes(val items: List<SessionDto> = emptyList())

// the gateway answers a failure with {error:"…"}; the harness adapters phrase
// their own as {name,message}. Keep both, so the phone shows the real reason
// instead of only the status code.
@Serializable
data class ErrorDto(val name: String? = null, val message: String? = null, val error: String? = null)

@Serializable
data class CacheDto(val read: Long = 0, val write: Long = 0)

@Serializable
data class TokensDto(
    val input: Long = 0,
    val output: Long = 0,
    val reasoning: Long = 0,
    val cache: CacheDto = CacheDto(),
)

@Serializable
data class PartDto(
    val kind: String = "other",
    val id: String? = null,
    val text: String? = null,
    val name: String? = null,
    val status: String? = null,
    val title: String? = null,
    val filePath: String? = null,
    val fileName: String? = null,
    val mimeType: String? = null,
    // tool parts carry the call's input and captured output; without these the
    // phone could only ever render "Ran a command" and nothing behind it.
    // Both are JsonElement, not String: opencode reports `output` as a string
    // for most tools but as an object for others (a failed call reported
    // `"output":{}`), and a String field throws the whole history decode.
    val input: JsonElement? = null,
    val output: JsonElement? = null,
    // reasoning carries its duration once finalized ("Thought for 12s")
    val durationMs: Long? = null,
    val nativeType: String? = null,
)

@Serializable
data class MessageDto(
    val id: String,
    val sessionID: String = "",
    val role: String = "assistant",
    val time: Long = 0,
    val parts: List<PartDto> = emptyList(),
    val error: ErrorDto? = null,
    // usage the harness reported for this turn: which model answered, what it
    // cost, and the token breakdown
    val model: String? = null,
    val cost: Double? = null,
    val tokens: TokensDto? = null,
)

@Serializable
data class MessageRes(val message: MessageDto? = null)

@Serializable
data class HistoryRes(val messages: List<MessageDto> = emptyList(), val hasMore: Boolean = false)

@Serializable
data class NewSessionRes(val session: SessionDto)

@Serializable
data class WorkspaceDto(val name: String = "", val harness: String = "", val dir: String = "")

@Serializable
data class WorkspacesRes(val items: List<WorkspaceDto> = emptyList())

@Serializable
data class HarnessesRes(val harnesses: List<String> = emptyList(), val default: String? = null)

@Serializable
data class DirEntryDto(val name: String = "", val git: Boolean = false)

@Serializable
data class BrowseRes(
    val cwd: String = "",
    val root: String = "",
    val parent: String? = null,
    val dirs: List<DirEntryDto> = emptyList(),
)

@Serializable
data class ModelDto(
    val providerID: String = "",
    val modelID: String = "",
    val image: Boolean = false,
    val attachment: Boolean = false,
    val contextLimit: Long = 0,
)

@Serializable
data class ModelsRes(
    val models: List<ModelDto> = emptyList(),
    val current: String? = null,
    val default: String? = null,
)

@Serializable
data class SetModelRes(val ok: Boolean = false, val model: String? = null)

@Serializable
data class AgentRes(val current: String? = null)

@Serializable
data class SkillDto(
    val name: String = "",
    val description: String = "",
    val scope: String = "",
    val path: String = "",
    val disableModelInvocation: Boolean = false,
)

@Serializable
data class SkillsRes(val skills: List<SkillDto> = emptyList(), val toggleable: Boolean = false)

@Serializable
data class McpDto(val name: String = "", val kind: String = "", val enabled: Boolean = false, val detail: String = "")

@Serializable
data class McpRes(val servers: List<McpDto> = emptyList())

@Serializable
data class TermStatusRes(val allowed: Boolean = false, val authorized: Boolean = false)

@Serializable
data class TermFrameRes(val text: String = "")

@Serializable
data class UsageDto(
    val input: Long = 0,
    val output: Long = 0,
    val reasoning: Long = 0,
    val cacheRead: Long = 0,
    val cacheWrite: Long = 0,
    val total: Long = 0,
    val cost: Double = 0.0,
    val priced: Int = 0,
    val unpriced: Int = 0,
    val turns: Int = 0,
    val models: List<String> = emptyList(),
)

@Serializable
data class UsageRes(val usage: UsageDto = UsageDto())

@Serializable
data class FileDiffDto(
    val file: String = "",
    val additions: Int = 0,
    val deletions: Int = 0,
    val status: String? = null,
)

@Serializable
data class DiffRes(val files: List<FileDiffDto> = emptyList())

@Serializable
data class AttachRes(val id: String, val name: String = "")

@Serializable
data class AskOptionDto(val id: String, val label: String, val style: String? = null)

@Serializable
data class AskDto(
    val id: String,
    val sessionID: String = "",
    val title: String = "",
    val detail: String? = null,
    val options: List<AskOptionDto> = emptyList(),
    val kind: String? = null,
)

// one shape for every DomainEvent the gateway forwards; fields the event
// doesn't carry stay null and the mapper switches on `type`
@Serializable
data class EventDto(
    val type: String = "other",
    val sessionID: String? = null,
    val messageID: String? = null,
    val partID: String? = null,
    val partType: String? = null,
    val text: String? = null,
    val role: String? = null,
    val part: PartDto? = null,
    val ask: AskDto? = null,
    val message: String? = null,
)
