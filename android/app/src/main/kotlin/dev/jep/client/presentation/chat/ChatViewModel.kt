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
import dev.jep.client.domain.repository.ModelChoices
import dev.jep.client.domain.model.Role
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

// The open conversation: stateful merge of the authoritative history and the
// live stream. Prompt runs happen in the repository/gateway and outlive this
// screen entirely — a closed chat costs nothing, a reopened one re-syncs.
//
// History is paged: only the newest WINDOW messages load up front; older pages
// come on demand when the user scrolls to the top. A whole conversation can be
// hundreds of messages long, so an unbounded initial fetch made loading slow
// and handing megabytes of JSON to the UI thread crashed the app.
const val WINDOW = 120

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
        val hasMore: Boolean = false,
        val loadingOlder: Boolean = false,
        /** models this conversation may run on; null until Settings asks */
        val models: ModelChoices? = null,
    )

    private val _state = MutableStateFlow(UiState())
    val state = _state.asStateFlow()

    // sends land optimistically and are reconciled by the next history read
    private val optimistic = mutableListOf<ChatMessage>()

    // Identifies the turn whose callbacks may still write state. A reply that
    // arrives after the turn was superseded — stopped, or replaced by a newer
    // send — is stale and must not touch the state that replaced it.
    private var turn = 0

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
            // a harness-reported failure ends the turn: it must clear the live
            // row too, or the spinner outlives the turn it belonged to. An
            // abort is the user's own stop coming back around, not an error.
            is ChatEvent.Failed -> _state.update {
                it.copy(failure = if (evt.error.isAbort()) null else evt.error, live = null, sending = false)
            }
            is ChatEvent.Quiet -> refresh()
            is ChatEvent.MessageSeen, is ChatEvent.Lost -> Unit
        }
    }

    // the harness's own record is authoritative once served; optimistic rows
    // survive only until they show up there. History is paged: the newest
    // window only, then older pages on demand via loadOlder().
    fun refresh() {
        viewModelScope.launch {
            runCatching { repo.history(sessionId, limit = WINDOW) }
                .onSuccess { batch ->
                    val servedIds = batch.messages.map { it.id }.toSet()
                    optimistic.removeAll { it.id in servedIds }
                    _state.update { st ->
                        st.copy(
                            messages = batch.messages + optimistic.toList(),
                            live = if (st.sending) st.live else null,
                            hasMore = batch.hasMore,
                        )
                    }
                }
        }
    }

    fun loadOlder() {
        val st = _state.value
        if (st.loadingOlder || !st.hasMore) return
        val oldest = st.messages.minOfOrNull { it.time } ?: return
        _state.update { it.copy(loadingOlder = true) }
        viewModelScope.launch {
            runCatching { repo.history(sessionId, limit = WINDOW, before = oldest) }
                .onSuccess { batch ->
                    _state.update { prev ->
                        val priorIds = prev.messages.map { it.id }.toSet()
                        val fresh = batch.messages.filter { it.id !in priorIds }
                        prev.copy(
                            // the older page goes in front; keep everything we hold
                            messages = fresh + prev.messages,
                            hasMore = batch.hasMore,
                            loadingOlder = false,
                        )
                    }
                }
                .onFailure {
                    _state.update { it.copy(loadingOlder = false) }
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
        val seq = ++turn
        optimistic.add(pending)
        _state.update { it.copy(messages = it.messages + pending, sending = true, live = null, failure = null, attachments = emptyList()) }
        viewModelScope.launch {
            runCatching { repo.prompt(sessionId, trimmed, files.map { it.id }) }
                .onSuccess { final ->
                    if (seq != turn) return@onSuccess
                    optimistic.removeAll { it.id == pending.id }
                    _state.update { it.copy(messages = it.messages + final, sending = false, live = null) }
                    refresh()
                }
                .onFailure { err ->
                    if (seq != turn) return@onFailure
                    // the live row is this turn's; an abort must clear it or it
                    // dangles as a spinner forever — the "freak-out". A stop the
                    // user asked for is not a failure to shout about, either.
                    _state.update {
                        it.copy(sending = false, live = null, failure = if (err.message.isAbort()) null else (err.message ?: "the turn failed"))
                    }
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

    // Settings › model: the pickable models for this conversation and the one
    // it is set to. Loaded on demand when the panel opens, like Telegram's.
    fun loadModels() {
        viewModelScope.launch {
            runCatching { repo.models(sessionId) }
                .onSuccess { m -> _state.update { it.copy(models = m) } }
                .onFailure { err -> _state.update { it.copy(notice = "couldn't load models: ${err.message}") } }
        }
    }

    fun setModel(ref: String?) {
        val before = _state.value.models ?: return
        _state.update { it.copy(models = before.copy(current = ref)) }
        viewModelScope.launch {
            runCatching { repo.setModel(sessionId, ref) }
                .onFailure { err ->
                    _state.update { it.copy(models = before, notice = "couldn't set the model: ${err.message}") }
                }
        }
    }

    fun stop() {
        // Stop has to take effect on the screen at once. The turn is over the
        // moment the user says so — waiting for the server's reply to clear the
        // spinner and the Stop button is exactly what left the row dangling
        // when the server had gone quiet (readTimeout is 0, so that reply may
        // never come). Invalidate the turn so its late reply is ignored.
        turn++
        _state.update { it.copy(sending = false, live = null, failure = null) }
        viewModelScope.launch { runCatching { repo.stop(sessionId) } }
    }

    // the gateway reports an aborted turn as a failure carrying the harness's
    // own words ("prompt aborted"); it is a stop, not an error worth surfacing
    private fun String?.isAbort(): Boolean = this?.contains("abort", ignoreCase = true) == true

    fun respond(askId: String, optionId: String) {
        viewModelScope.launch {
            val ask = _state.value.ask ?: return@launch
            _state.update { it.copy(ask = null) }
            runCatching { repo.respond(askId, optionId) }
                .onFailure { err -> _state.update { it.copy(ask = ask, failure = "the ask didn't take: ${err.message}") } }
        }
    }
}
