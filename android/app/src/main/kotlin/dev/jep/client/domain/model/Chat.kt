package dev.jep.client.domain.model

enum class Role { USER, ASSISTANT }

data class SessionSummary(
    val id: String,
    val title: String,
    val workspace: String,
    val createdAt: Long,
    val updatedAt: Long,
    val adapter: String? = null,
)

/** a workspace the gateway serves, and the harness (opencode/codex/…) behind it */
data class Workspace(val name: String, val harness: String)

/** one model the conversation's harness can run on */
data class Model(val providerID: String, val modelID: String) {
    val ref: String get() = "$providerID/$modelID"
}

sealed interface ChatPart {
    data class Text(val text: String) : ChatPart
    data class Tool(val id: String?, val name: String, val status: ToolStatus?, val title: String?) : ChatPart
    data class Reasoning(val text: String) : ChatPart
    data class Unsupported(val kind: String) : ChatPart
}

enum class ToolStatus { PENDING, RUNNING, COMPLETED, ERROR }

data class ChatMessage(
    val id: String,
    val role: Role,
    val time: Long,
    val parts: List<ChatPart>,
    val error: String? = null,
)

data class AskOption(val id: String, val label: String, val danger: Boolean = false)

data class Ask(
    val id: String,
    val title: String,
    val detail: String? = null,
    val options: List<AskOption> = emptyList(),
)
