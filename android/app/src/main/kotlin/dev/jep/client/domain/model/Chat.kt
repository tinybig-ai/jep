package dev.jep.client.domain.model

enum class Role { USER, ASSISTANT }

data class SessionSummary(
    val id: String,
    val title: String,
    val workspace: String,
    val createdAt: Long,
    val updatedAt: Long,
    /** the workspace's friendly name */
    val adapter: String? = null,
    /** the engine behind it (opencode/codex/claude) — display-only */
    val harness: String? = null,
)

/** a workspace the gateway serves, and the harness (opencode/codex/…) behind it */
data class Workspace(val name: String, val harness: String)

/** one model the conversation's harness can run on */
data class Model(
    val providerID: String,
    val modelID: String,
    val image: Boolean = false,
    val attachment: Boolean = false,
    val contextLimit: Long = 0,
) {
    val ref: String get() = "$providerID/$modelID"
}

/** the token breakdown a turn reported; `context` is what it held at its peak */
data class TokenUsage(
    val input: Long = 0,
    val output: Long = 0,
    val reasoning: Long = 0,
    val cacheRead: Long = 0,
    val cacheWrite: Long = 0,
) {
    val total: Long get() = input + output + reasoning + cacheRead + cacheWrite
    val context: Long get() = input + cacheRead + cacheWrite
}

sealed interface ChatPart {
    data class Text(val text: String) : ChatPart

    data class Tool(
        val id: String?,
        val name: String,
        val status: ToolStatus?,
        val title: String?,
        /** the call's arguments, as compact JSON */
        val input: String? = null,
        /** captured stdout / diff / result — what the collapsed row hides */
        val output: String? = null,
    ) : ChatPart

    data class Reasoning(val text: String, val durationMs: Long? = null) : ChatPart

    /** a file the agent produced or read (images, patches, attachments) */
    data class File(val path: String, val name: String?, val mimeType: String?) : ChatPart

    data class Unsupported(val kind: String) : ChatPart
}

enum class ToolStatus { PENDING, RUNNING, COMPLETED, ERROR }

data class ChatMessage(
    val id: String,
    val role: Role,
    val time: Long,
    val parts: List<ChatPart>,
    val error: String? = null,
    /** the model that answered this turn (as reported by the harness) */
    val model: String? = null,
    /** reported cost of this turn in USD; null when the harness didn't price it */
    val cost: Double? = null,
    val tokens: TokenUsage? = null,
)

data class AskOption(val id: String, val label: String, val danger: Boolean = false)

data class Ask(
    val id: String,
    val title: String,
    val detail: String? = null,
    val options: List<AskOption> = emptyList(),
)

/** what a conversation has spent, summed from the harness's own record */
data class Usage(
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

/** one file a conversation changed */
data class FileDiff(val file: String, val additions: Int, val deletions: Int, val status: String? = null)
