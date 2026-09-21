package dev.jep.client.data

import dev.jep.client.data.dto.AskDto
import dev.jep.client.data.dto.MessageDto
import dev.jep.client.data.dto.PartDto
import dev.jep.client.data.dto.ModelDto
import dev.jep.client.data.dto.SessionDto
import dev.jep.client.data.dto.WorkspaceDto
import dev.jep.client.domain.model.Ask
import dev.jep.client.domain.model.AskOption
import dev.jep.client.domain.model.ChatMessage
import dev.jep.client.domain.model.ChatPart
import dev.jep.client.domain.model.Model
import dev.jep.client.domain.model.Role
import dev.jep.client.domain.model.SessionSummary
import dev.jep.client.domain.model.ToolStatus
import dev.jep.client.domain.model.Workspace

// the JSON→domain boundary. Unknown part kinds and statuses degrade to
// inert renderings here, once, instead of leaking harness vocabulary upward.
fun SessionDto.toDomain() = SessionSummary(id, title, workspace, createdAt, updatedAt, adapter)

fun WorkspaceDto.toDomain() = Workspace(name, harness)

fun ModelDto.toDomain() = Model(providerID, modelID)

fun MessageDto.toDomain() = ChatMessage(
    id = id,
    role = if (role == "user") Role.USER else Role.ASSISTANT,
    time = time,
    parts = parts.mapNotNull { it.toDomain() },
    error = error?.message,
)

fun AskDto.toDomain() = Ask(
    id = id,
    title = title,
    detail = detail,
    options = options.map { AskOption(it.id, it.label, it.style == "danger") },
)

private fun PartDto.toDomain(): ChatPart? = when (kind) {
    "text" -> text?.let { ChatPart.Text(it) }
    "reasoning" -> text?.let { ChatPart.Reasoning(it) }
    "tool" -> ChatPart.Tool(id, name.orEmpty(), status?.let { runCatching { ToolStatus.valueOf(it.uppercase()) }.getOrNull() }, title)
    else -> null
}
