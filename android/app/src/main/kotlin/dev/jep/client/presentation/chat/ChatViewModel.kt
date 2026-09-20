package dev.jep.client.presentation.chat

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.jep.client.domain.model.Ask
import dev.jep.client.domain.repository.ChatEvent
import dev.jep.client.domain.model.ChatMessage
import dev.jep.client.domain.model.ChatPart
import dev.jep.client.domain.repository.ChatRepository
import dev.jep.client.domain.model.Role
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

// The open conversation: stateful merge of the authoritative history and the
// live stream. Prompt runs happen in the repository/gateway and outlive this
// screen entirely — a closed chat costs nothing, a reopened one re-syncs.
class ChatViewModel(
    private val repo: ChatRepository,
    val sessionId: String,
    initialTitle: String,
) : ViewModel() {

    // a chat the user renamed no longer matches the sessions-list title
    var title by mutableStateOf(initialTitle)
        private set

    data class Attachment(val id: String, val name: String)

    /** the turn being written right now, unit = streaming part */
    data class LiveTurn(
        val messageId: String,
        val texts: LinkedHashMap<String, StringBuilder> = LinkedHashMap(),
        val extras: LinkedHashMap<String, ChatPart> = LinkedHashMap(),
    )

    data class UiState(
        val messages: List<ChatMessage> = emptyList(),
        val live: LiveTurn? = null,
        val ask: Ask? = null,
        val failure: String? = null,
        val sending: Boolean = false,
        val lost: Boolean = false,
        val attachments: List<Attachment> = emptyList(),
        val notice: String? = null,
    )

    private val _state = MutableStateFlow(UiState())
    val state = _state.asStateFlow()

    // sends land optimistically and are reconciled by the next history read
    private val optimistic = mutableListOf<ChatMessage>()

    init {
        refresh()
        viewModelScope.launch {
            repo.events().collect { evt ->
                when (evt) {
                    is ChatEvent.Lost -> _state.update { it.copy(lost = true) }
                    else -> if (evt.sessionId == sessionId) apply(evt)
                }
            }
        }
    }

    private fun apply(evt: ChatEvent) {
        when (evt) {
            is ChatEvent.TextDelta -> _state.update { st ->
                val live = st.live ?: LiveTurn(evt.messageId)
                live.texts.getOrPut(evt.partId) { StringBuilder() }.append(evt.text)
                st.copy(live = live, lost = false, failure = null)
            }
            is ChatEvent.PartChanged -> _state.update { st ->
                val live = st.live ?: LiveTurn(evt.messageId)
                val key = evt.partId ?: "extra${live.extras.size}"
                live.extras[key] = evt.part
                st.copy(live = live)
            }
            is ChatEvent.Asked -> _state.update { it.copy(ask = evt.ask) }
            is ChatEvent.Failed -> _state.update { it.copy(failure = evt.error, live = null, sending = false) }
            is ChatEvent.Quiet -> refresh()
            is ChatEvent.MessageSeen, is ChatEvent.Lost -> Unit
        }
    }

    // the harness's own record is authoritative once served; optimistic rows
    // survive only until they show up there
    fun refresh() {
        viewModelScope.launch {
            runCatching { repo.history(sessionId) }
                .onSuccess { served ->
                    val servedIds = served.map { it.id }.toSet()
                    optimistic.removeAll { it.id in servedIds }
                    _state.update { st ->
                        st.copy(
                            messages = served + optimistic.toList(),
                            live = if (st.sending) st.live else null,
                        )
                    }
                }
        }
    }

    fun send(text: String) {
        val trimmed = text.trim()
        if (trimmed.isEmpty() || _state.value.sending) return
        val files = _state.value.attachments
        val pending = ChatMessage(
            id = "local-${System.nanoTime()}",
            role = Role.USER,
            time = System.currentTimeMillis(),
            parts = listOf(ChatPart.Text(if (files.isEmpty()) trimmed else trimmed + "\n\n[attached: ${files.joinToString(", ") { it.name }}]")),
        )
        optimistic.add(pending)
        _state.update { it.copy(messages = it.messages + pending, sending = true, live = null, failure = null, attachments = emptyList()) }
        viewModelScope.launch {
            runCatching { repo.prompt(sessionId, trimmed, files.map { it.id }) }
                .onSuccess { final ->
                    optimistic.removeAll { it.id == pending.id }
                    _state.update { it.copy(messages = it.messages + final, sending = false, live = null) }
                    refresh()
                }
                .onFailure { err ->
                    _state.update { it.copy(sending = false, failure = err.message ?: "the turn failed") }
                }
        }
    }

    fun attach(filename: String, bytes: ByteArray) {
        viewModelScope.launch {
            runCatching { repo.attach(sessionId, filename, bytes) }
                .onSuccess { id ->
                    _state.update { it.copy(attachments = it.attachments + Attachment(id, filename)) }
                }
                .onFailure { err -> _state.update { it.copy(notice = "couldn't attach \"$filename\": ${err.message}") } }
        }
    }

    fun removeAttachment(id: String) {
        _state.update { it.copy(attachments = it.attachments.filterNot { a -> a.id == id }) }
    }

    fun rename(newTitle: String) {
        val clean = newTitle.trim()
        if (clean.isEmpty()) return
        viewModelScope.launch {
            runCatching { repo.rename(sessionId, clean) }
                .onSuccess { title = clean }
                .onFailure { err -> _state.update { it.copy(notice = "rename failed: ${err.message}") } }
        }
    }

    fun delete(onDone: (Boolean) -> Unit) {
        viewModelScope.launch {
            runCatching { repo.delete(sessionId) }
                .onSuccess { onDone(true) }
                .onFailure { err ->
                    _state.update { it.copy(notice = "couldn't delete: ${err.message}") }
                    onDone(false)
                }
        }
    }

    fun stop() {
        viewModelScope.launch { runCatching { repo.stop(sessionId) } }
    }

    fun respond(askId: String, optionId: String) {
        viewModelScope.launch {
            val ask = _state.value.ask ?: return@launch
            _state.update { it.copy(ask = null) }
            runCatching { repo.respond(askId, optionId) }
                .onFailure { err -> _state.update { it.copy(ask = ask, failure = "the ask didn't take: ${err.message}") } }
        }
    }
}
