package dev.jep.client.data

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import dev.jep.client.data.dto.AskDto
import dev.jep.client.data.dto.AgentDto
import dev.jep.client.data.dto.BrowseRes
import dev.jep.client.data.dto.DirEntryDto
import dev.jep.client.data.dto.FileDiffDto
import dev.jep.client.data.dto.ImportableDto
import dev.jep.client.data.dto.McpDto
import dev.jep.client.data.dto.MessageDto
import dev.jep.client.data.dto.ModelDto
import dev.jep.client.data.dto.PartDto
import dev.jep.client.data.dto.SessionDto
import dev.jep.client.data.dto.SkillDto
import dev.jep.client.data.dto.SkillsRes
import dev.jep.client.data.dto.TokensDto
import dev.jep.client.data.dto.UsageDto
import dev.jep.client.data.dto.WorkspaceDto
import dev.jep.client.domain.model.Ask
import dev.jep.client.domain.model.AgentInfo
import dev.jep.client.domain.model.AskOption
import dev.jep.client.domain.model.BrowseResult
import dev.jep.client.domain.model.ChatMessage
import dev.jep.client.domain.model.ChatPart
import dev.jep.client.domain.model.DirEntry
import dev.jep.client.domain.model.FileDiff
import dev.jep.client.domain.model.ImportableSession
import dev.jep.client.domain.model.McpServer
import dev.jep.client.domain.model.Model
import dev.jep.client.domain.model.Role
import dev.jep.client.domain.model.Skill
import dev.jep.client.domain.model.SkillSet
import dev.jep.client.domain.model.SessionSummary
import dev.jep.client.domain.model.TokenUsage
import dev.jep.client.domain.model.ToolStatus
import dev.jep.client.domain.model.Usage
import dev.jep.client.domain.model.Workspace

// the JSON→domain boundary. Unknown part kinds and statuses degrade to
// inert renderings here, once, instead of leaking harness vocabulary upward.
fun SessionDto.toDomain() = SessionSummary(id, title, workspace, createdAt, updatedAt, adapter, harness, subagents, active)

fun WorkspaceDto.toDomain() = Workspace(name, harness, dir)

fun DirEntryDto.toDomain() = DirEntry(name, git)

fun SkillDto.toDomain() = Skill(name, description, scope, path, disableModelInvocation)

fun SkillsRes.toDomain() = SkillSet(skills.map { it.toDomain() }, toggleable)

fun McpDto.toDomain() = McpServer(name, kind, enabled, detail)

fun ImportableDto.toDomain() = ImportableSession(id, title, directory, updated, harness)

fun BrowseRes.toDomain() = BrowseResult(cwd, root, parent, dirs.map { it.toDomain() })

fun ModelDto.toDomain() = Model(providerID, modelID, image, attachment, contextLimit)

fun AgentDto.toDomain() = AgentInfo(id, label, detail)

fun TokensDto.toDomain() = TokenUsage(input, output, reasoning, cache.read, cache.write)

fun UsageDto.toDomain() = Usage(
    input = input,
    output = output,
    reasoning = reasoning,
    cacheRead = cacheRead,
    cacheWrite = cacheWrite,
    total = total,
    cost = cost,
    priced = priced,
    unpriced = unpriced,
    turns = turns,
    models = models,
)

fun FileDiffDto.toDomain() = FileDiff(file, additions, deletions, status)

fun MessageDto.toDomain() = ChatMessage(
    id = id,
    role = if (role == "user") Role.USER else Role.ASSISTANT,
    time = time,
    parts = parts.mapNotNull { it.toDomain() },
    error = error?.message,
    model = model,
    cost = cost,
    tokens = tokens?.toDomain(),
    durationMs = durationMs,
)

fun AskDto.toDomain() = Ask(
    id = id,
    title = title,
    detail = detail,
    options = options.map { AskOption(it.id, it.label, it.style == "danger") },
)

// What an edit changed, counted from the call's own arguments. opencode hands
// back no diff for a write (its metadata carries only the path), and its edit
// args are the literal old/new strings — which is exactly what a line count
// needs, and it is available for every harness.
private fun JsonElement.lineChange(tool: String): Pair<Int, Int>? {
    val obj = this as? JsonObject ?: return null
    fun lines(v: JsonElement?): Int =
        (v as? JsonPrimitive)?.contentOrNull?.let { if (it.isEmpty()) 0 else it.count { c -> c == '\n' } + 1 } ?: 0
    fun str(k: String): JsonElement? = obj[k]
    return when (tool.lowercase()) {
        "write" -> str("content")?.let { lines(it) to 0 }
        "edit" -> if (str("oldString") != null || str("newString") != null) lines(str("oldString")) to lines(str("newString")) else null
        "multi-edit", "multiedit" -> {
            val edits = str("edits") as? JsonArray ?: return null
            var add = 0
            var del = 0
            edits.forEach { e ->
                val o = e as? JsonObject ?: return@forEach
                del += lines(o["oldString"])
                add += lines(o["newString"])
            }
            add to del
        }
        else -> null
    }
}

// The change a tool call made, as a unified hunk. No context lines: the old file
// is not available (opencode's write metadata carries only the path), so this is
// exactly what changed — which is what a diff view is for.
private fun JsonElement.toolDiff(tool: String): String? {
    val obj = this as? JsonObject ?: return null
    fun text(v: JsonElement?): String? = (v as? JsonPrimitive)?.contentOrNull
    fun hunk(old: String?, new: String?): List<String> =
        (old?.takeIf { it.isNotEmpty() }?.split("\n")?.map { "-$it" } ?: emptyList()) +
            (new?.takeIf { it.isNotEmpty() }?.split("\n")?.map { "+$it" } ?: emptyList())
    val lines = when (tool.lowercase()) {
        "write" -> hunk(null, text(obj["content"]))
        "edit" -> hunk(text(obj["oldString"]), text(obj["newString"]))
        "multi-edit", "multiedit" -> {
            val edits = obj["edits"] as? JsonArray ?: return null
            edits.flatMap { e ->
                val o = e as? JsonObject ?: return@flatMap emptyList<String>()
                hunk(text(o["oldString"]), text(o["newString"]))
            }
        }
        else -> return null
    }
    return lines.takeIf { it.isNotEmpty() }?.joinToString("\n")
}

fun PartDto.toDomain(): ChatPart? = when (kind) {
    "text" -> text?.let { ChatPart.Text(it) }
    "reasoning" -> text?.let { ChatPart.Reasoning(it, durationMs) }
    "tool" -> {
        val change = input?.lineChange(name.orEmpty())
        ChatPart.Tool(
            id,
            name.orEmpty(),
            status?.let { runCatching { ToolStatus.valueOf(it.uppercase()) }.getOrNull() },
            title,
            input?.display(),
            output?.display(),
            change?.first,
            change?.second,
            input?.toolDiff(name.orEmpty()),
        )
    }
    "file" -> filePath?.takeIf { it.isNotBlank() }?.let { ChatPart.File(it, fileName, mimeType) }
    else -> null
}

// A tool payload shown as text: a JSON string becomes its contents (no quotes
// around captured stdout); anything else becomes its compact JSON form.
private fun kotlinx.serialization.json.JsonElement.display(): String? {
    val s = if (this is kotlinx.serialization.json.JsonPrimitive && isString) content else toString()
    return s.takeIf { it.isNotBlank() && it != "{}" && it != "null" }
}
