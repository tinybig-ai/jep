package dev.jep.client

import dev.jep.client.domain.model.BrowseResult
import dev.jep.client.domain.model.ChatMessage
import dev.jep.client.domain.model.ChatPart
import dev.jep.client.domain.model.FileDiff
import dev.jep.client.domain.model.Harnesses
import dev.jep.client.domain.model.ImportableSession
import dev.jep.client.domain.model.McpServer
import dev.jep.client.domain.model.Model
import dev.jep.client.domain.model.Role
import dev.jep.client.domain.model.SkillSet
import dev.jep.client.domain.model.TerminalAccess
import dev.jep.client.domain.model.SessionSummary
import dev.jep.client.domain.model.Usage
import dev.jep.client.domain.model.Workspace
import dev.jep.client.domain.repository.ChatEvent
import dev.jep.client.domain.repository.ChatRepository
import dev.jep.client.domain.repository.HistoryBatch
import dev.jep.client.domain.repository.ModelChoices
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow

// Hand-rolled in-memory port: the UI tests drive the real screens and the real
// ViewModels, and only the transport is faked. No emulator network, no gateway.
class FakeChatRepository(
    private val messages: List<ChatMessage> = emptyList(),
    private val choices: ModelChoices? = null,
    private val browseAnswer: (String?) -> BrowseResult = { p ->
        BrowseResult(p ?: "/root", "/root", null, emptyList())
    },
) : ChatRepository {
    override suspend fun pair(baseUrl: String, code: String) = "token"
    override suspend fun sessions(): List<SessionSummary> = emptyList()
    override suspend fun workspaces(): List<Workspace> = emptyList()
    override suspend fun harnesses() = Harnesses(listOf("opencode"), "opencode")
    override suspend fun browse(path: String?): BrowseResult = browseAnswer(path)

    /** folders the fake "created", by absolute path */
    val madeFolders = mutableListOf<String>()

    override suspend fun newFolder(path: String?, name: String): String {
        val full = "${path ?: "/fake"}/$name"
        madeFolders += full
        return full
    }

    var archivedAnswer: List<dev.jep.client.domain.model.SessionSummary> = emptyList()
    override suspend fun archivedSessions() = archivedAnswer
    override suspend fun newSession(title: String?, workspace: String?, path: String?, harness: String?) =
        SessionSummary("new-session", title ?: "new", workspace ?: "", 0, 0, workspace, harness)
    override suspend fun models(sessionId: String) = choices ?: ModelChoices(emptyList(), null)
    override suspend fun setModel(sessionId: String, ref: String?) = true
    override suspend fun agent(sessionId: String): String? = null
    override suspend fun setAgent(sessionId: String, agent: String?) = true
    override suspend fun usage(sessionId: String) = Usage()
    override suspend fun diff(sessionId: String) = emptyList<FileDiff>()
    override suspend fun skills(sessionId: String) = SkillSet(emptyList(), true)
    override suspend fun setSkill(sessionId: String, path: String, disabled: Boolean) = true
    override suspend fun mcp(sessionId: String): List<McpServer> = emptyList()
    override suspend fun setMcp(sessionId: String, name: String, enabled: Boolean) = true
    override suspend fun subagents(sessionId: String): List<SessionSummary> = emptyList()
    override suspend fun importableSessions(): List<ImportableSession> = emptyList()
    override suspend fun importSession(sessionId: String) = true
    override suspend fun archiveSession(sessionId: String) = true
    override suspend fun unarchiveSession(sessionId: String) = true
    override suspend fun terminalStatus() = TerminalAccess(allowed = true, authorized = false)
    override suspend fun unlockTerminal(code: String) = true
    override suspend fun lockTerminal() = true
    override suspend fun termOpen(sessionId: String) = true
    override suspend fun termFrame(sessionId: String) = "fake terminal\n$ "
    override suspend fun termInput(sessionId: String, text: String) = true
    override suspend fun termKey(sessionId: String, key: String) = true
    override suspend fun termClose(sessionId: String) = true
    override suspend fun history(sessionId: String, limit: Int, before: Long) = HistoryBatch(messages, false)
    override suspend fun prompt(sessionId: String, text: String, files: List<String>) =
        ChatMessage("reply", Role.ASSISTANT, 1, listOf(ChatPart.Text("ok")))
    override suspend fun stop(sessionId: String) = true
    override suspend fun respond(askId: String, optionId: String) = true
    override suspend fun rename(sessionId: String, title: String) = true
    override suspend fun delete(sessionId: String) = true
    override suspend fun attach(sessionId: String, filename: String, bytes: ByteArray) = "attachment"
    // tests drive a turn by hand: whatever the harness would emit goes here
    private val _events = MutableSharedFlow<ChatEvent>(extraBufferCapacity = 64)
    override fun events(): Flow<ChatEvent> = _events.asSharedFlow()
    fun emitEvent(evt: ChatEvent) { _events.tryEmit(evt) }
}

/** a small helpers so tests can name model rows */
fun model(id: String, image: Boolean = false, ctx: Long = 0) = Model("opencode", id, image = image, contextLimit = ctx)
