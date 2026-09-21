package dev.jep.client.domain.repository

import dev.jep.client.domain.model.Ask
import dev.jep.client.domain.model.BrowseResult
import dev.jep.client.domain.model.ChatMessage
import dev.jep.client.domain.model.ChatPart
import dev.jep.client.domain.model.FileDiff
import dev.jep.client.domain.model.Harnesses
import dev.jep.client.domain.model.McpServer
import dev.jep.client.domain.model.Model
import dev.jep.client.domain.model.Role
import dev.jep.client.domain.model.SessionSummary
import dev.jep.client.domain.model.SkillSet
import dev.jep.client.domain.model.TerminalAccess
import dev.jep.client.domain.model.Usage
import dev.jep.client.domain.model.Workspace
import kotlinx.coroutines.flow.Flow

/** one paged slice of a conversation; `hasMore` means older messages exist */
data class HistoryBatch(
    val messages: List<ChatMessage>,
    val hasMore: Boolean,
)

/** the models a conversation may run on, the one it is set to (null = the
 * harness default), and what "default" actually resolves to */
data class ModelChoices(
    val all: List<Model>,
    val current: String?,
    val default: String? = null,
)

// Events the push feed forwards, translated out of the wire's vocabulary.
// The presentation layer renders from these alone; it never learns how they
// traveled or who sent them.
sealed interface ChatEvent {
    val sessionId: String?

    data class TextDelta(
        override val sessionId: String,
        val messageId: String,
        val partId: String,
        val text: String,
    ) : ChatEvent

    data class PartChanged(
        override val sessionId: String,
        val messageId: String,
        val partId: String?,
        val part: ChatPart,
    ) : ChatEvent

    data class MessageSeen(
        override val sessionId: String,
        val messageId: String,
        val role: Role?,
    ) : ChatEvent

    data class Quiet(override val sessionId: String) : ChatEvent

    data class Asked(override val sessionId: String, val ask: Ask) : ChatEvent

    data class Failed(override val sessionId: String, val error: String) : ChatEvent

    data object Lost : ChatEvent {
        override val sessionId: String? = null
    }
}

interface ChatRepository {
    suspend fun pair(baseUrl: String, code: String): String
    suspend fun sessions(): List<SessionSummary>
    /** the workspaces (and harnesses) a conversation may be created in */
    suspend fun workspaces(): List<Workspace>
    /** the harnesses installed on the machine, and the default */
    suspend fun harnesses(): Harnesses
    /** folders under `path` (or the browse root when null), bounded by the root */
    suspend fun browse(path: String?): BrowseResult
    /** create a conversation in a named workspace and/or at an absolute path,
     * under a harness — the path is spawned as a workspace if not served yet */
    suspend fun newSession(
        title: String? = null,
        workspace: String? = null,
        path: String? = null,
        harness: String? = null,
    ): SessionSummary
    /** the models available to a conversation, and its current choice */
    suspend fun models(sessionId: String): ModelChoices
    /** set (or clear, with null) the conversation's model */
    suspend fun setModel(sessionId: String, ref: String?): Boolean
    /** the conversation's primary agent (null = harness default) */
    suspend fun agent(sessionId: String): String?
    /** set (or clear) the conversation's primary agent */
    suspend fun setAgent(sessionId: String, agent: String?): Boolean
    /** what the conversation has spent */
    suspend fun usage(sessionId: String): Usage
    /** files the conversation has changed */
    suspend fun diff(sessionId: String): List<FileDiff>
    /** the skills this conversation's harness loads */
    suspend fun skills(sessionId: String): SkillSet
    /** hide (or allow) a skill for the model, by its SKILL.md path */
    suspend fun setSkill(sessionId: String, path: String, disabled: Boolean): Boolean
    /** the MCP servers this conversation's harness will start */
    suspend fun mcp(sessionId: String): List<McpServer>
    /** enable or disable an MCP server by name */
    suspend fun setMcp(sessionId: String, name: String, enabled: Boolean): Boolean
    /** whether this gateway offers a terminal, and whether this device may use it */
    suspend fun terminalStatus(): TerminalAccess
    /** prove the pairing code again, unlocking a shell for this device token */
    suspend fun unlockTerminal(code: String): Boolean
    /** drop that grant for this device token */
    suspend fun lockTerminal(): Boolean
    /** start (or reattach) the conversation's shell in its workspace */
    suspend fun termOpen(sessionId: String): Boolean
    /** the shell's current screen, as rendered text */
    suspend fun termFrame(sessionId: String): String
    /** type into the shell */
    suspend fun termInput(sessionId: String, text: String): Boolean
    /** press a named key: Enter, Tab, C-c, Up, … */
    suspend fun termKey(sessionId: String, key: String): Boolean
    /** kill the shell */
    suspend fun termClose(sessionId: String): Boolean
    /** fetch the newest `limit` messages, or the newest `limit` older than `before` (ms) */
    suspend fun history(sessionId: String, limit: Int = 0, before: Long = 0): HistoryBatch
    suspend fun prompt(sessionId: String, text: String, files: List<String> = emptyList()): ChatMessage
    suspend fun stop(sessionId: String): Boolean
    suspend fun respond(askId: String, optionId: String): Boolean
    suspend fun rename(sessionId: String, title: String): Boolean
    suspend fun delete(sessionId: String): Boolean
    /** upload a file to the gateway; returns the id to pass in the next prompt */
    suspend fun attach(sessionId: String, filename: String, bytes: ByteArray): String
    fun events(): Flow<ChatEvent>
}
