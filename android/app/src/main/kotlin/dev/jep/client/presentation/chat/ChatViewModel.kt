package dev.jep.client.presentation.chat

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.jep.client.domain.model.Ask
import dev.jep.client.domain.model.AgentInfo
import dev.jep.client.domain.repository.ChatEvent
import dev.jep.client.domain.model.ChatMessage
import dev.jep.client.domain.model.ChatPart
import dev.jep.client.domain.repository.ChatRepository
import dev.jep.client.domain.repository.ModelChoices
import dev.jep.client.domain.repository.TurnAborted
import dev.jep.client.device.AppPresence
import dev.jep.client.domain.model.FileDiff
import dev.jep.client.domain.model.McpServer
import dev.jep.client.domain.model.SessionSummary
import dev.jep.client.domain.model.SkillSet
import dev.jep.client.domain.model.Usage
import dev.jep.client.domain.model.Role
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// The open conversation: stateful merge of the authoritative history and the
// live stream. Prompt runs happen in the repository/gateway and outlive this
// screen entirely — a closed chat costs nothing, a reopened one re-syncs.
//
// History is paged: only the newest WINDOW messages load up front; older pages
// come on demand when the user scrolls to the top. A whole conversation can be
// hundreds of messages long, so an unbounded initial fetch made loading slow
// and handing megabytes of JSON to the UI thread crashed the app.
const val WINDOW = 30

class ChatViewModel(
    private val repo: ChatRepository,
    val sessionId: String,
    initialTitle: String,
    // the workspace's friendly name and the harness behind it — shown in the
    // header, never changed: a conversation cannot move between harnesses
    val workspace: String = "",
    val harness: String? = null,
    // tells the device layer this conversation has been seen, so the list stops
    // marking it unread
    private val onRead: () -> Unit = {},
) : ViewModel() {

    // a chat the user renamed no longer matches the sessions-list title
    var title by mutableStateOf(initialTitle)
        private set

    /** where the file is on this phone, so it can be shown before the harness
     *  has ingested the message it belongs to */
    data class Attachment(val id: String, val name: String, val localUri: String? = null, val mimeType: String? = null)

    /** a message typed while the agent was busy: held, shown as queued, handed
     * over when the current turn ends */
    data class Queued(val id: String, val text: String, val attachments: List<Attachment> = emptyList(), val steer: Boolean = true, /** served user message ids already present when this was queued, so an older message with the same words cannot clear it */ val seen: Set<String> = emptySet())

    /** the turn being written right now, unit = streaming part */
    data class LiveTurn(
        val messageId: String,
        /** parts in arrival order, keyed by part id: a delta appends to the part
         * it belongs to, a full snapshot replaces it — so the same text never
         * lands twice (once accumulated, once as the snapshot) */
        val parts: LinkedHashMap<String, ChatPart> = LinkedHashMap(),
    )

    /** a workspace file opened from a link, and what the reader has of it */
    data class OpenFile(
        val path: String,
        val loading: Boolean = true,
        val text: String? = null,
        val error: String? = null,
        val tooBig: Boolean = false,
    )

    data class UiState(        val messages: List<ChatMessage> = emptyList(),
        val live: LiveTurn? = null,
        val ask: Ask? = null,
        /** when that ask was raised, so the card can sit in the transcript where
         *  it happened instead of being pinned to the bottom of the pane */
        val askAt: Long = 0L,
        /** the option tapped for that ask; set once it has been answered, which
         *  leaves the card in place with its choices spent */
        val askChoice: String? = null,
        /** the message that was streaming when the ask arrived — the tool call
         *  that raised it lives in there, so the card belongs just after it */
        val askAfter: String? = null,
        /** a file opened from a link in the transcript, read into the reader */
        val openFile: OpenFile? = null,
        val failure: String? = null,
        val sending: Boolean = false,
        val lost: Boolean = false,
        val attachments: List<Attachment> = emptyList(),
        val queued: List<Queued> = emptyList(),
        val notice: String? = null,
        val hasMore: Boolean = false,
        val loadingOlder: Boolean = false,
        /** the first page of history is still arriving */
        val loadingHistory: Boolean = false,
        /** models this conversation may run on; null until Settings asks */
        val models: ModelChoices? = null,
        /** the primary agent; null = harness default */
        val agent: String? = null,
        /** the primary agents the harness offers; empty until Settings asks */
        val agents: List<AgentInfo> = emptyList(),
        /** loaded on demand for the Usage panel */
        val usage: Usage? = null,
        /** loaded on demand for the Changes panel */
        val diffs: List<FileDiff>? = null,
        /** subagent sessions of this conversation, loaded on demand */
        val subagents: List<SessionSummary>? = null,
        /** loaded on demand for the Settings panel */
        val skills: SkillSet? = null,
        val mcp: List<McpServer>? = null,
    )

    private val _state = MutableStateFlow(UiState())
    val state = _state.asStateFlow()

    // sends land optimistically and are reconciled by the next history read
    private val optimistic = mutableListOf<ChatMessage>()

    /** Sends the daemon never took, kept with enough to try again. A message
     *  that failed on the way out is the one case where the transcript is ahead
     *  of the truth, so it has to be recoverable rather than decorative. */
    private val outbox = mutableMapOf<String, Pair<String, List<Attachment>>>()

    // who said what, from the harness's message events: a user message's parts
    // are echoed back during the turn and must never stream into the agent's row
    private val roles = mutableMapOf<String, Role>()

    // Identifies the turn whose callbacks may still write state. A reply that
    // arrives after the turn was superseded — stopped, or replaced by a newer
    // send — is stale and must not touch the state that replaced it.
    private var turn = 0

    init {
        // the foreground service needs to know which conversation is on screen:
        // it is the difference between "you are reading this" and "tell me when
        // it is done" (see NotificationPolicy)
        AppPresence.onChatOpen(sessionId)
        onRead()
        refresh()
        // the banner needs the model's name and context window up front, not
        // only when Settings is opened
        loadModels()
        // The push feed is a convenience, not the record: it drops on a daemon
        // restart, a network change, a backgrounded radio. A chat that stops
        // updating is worse than one that reconnects a moment late, so we
        // resubscribe forever and catch up from history after every drop.
        viewModelScope.launch {
            // One collector owns the stream; a second stage takes everything that
            // has already arrived and applies it in a single pass. A turn's worth
            // of events lands as a burst, and applying them one at a time
            // published one state per event — so a finished answer arrived in the
            // transcript one piece per frame instead of all at once.
            val incoming = Channel<ChatEvent>(Channel.UNLIMITED)
            launch {
                repo.events().collect { evt ->
                    if (evt.sessionId == sessionId || evt is ChatEvent.Lost) incoming.send(evt)
                }
            }
            while (true) {
                val first = incoming.receive()
                val batch = ArrayList<ChatEvent>(8).apply { add(first) }
                while (batch.size < 512) {
                    val next = incoming.tryReceive().getOrNull() ?: break
                    batch.add(next)
                }
                // no suspension inside the loop: StateFlow conflates, so the whole
                // burst reaches the screen as one update
                batch.forEach { apply(it) }
                if (batch.any { it is ChatEvent.Lost }) {
                    // the feed ended: say so, wait a beat, resubscribe, catch up
                    _state.update { it.copy(lost = true) }
                    delay(1_000)
                    refresh()
                }
            }
        }
        // And while a turn is in flight, follow it from history as well. Even
        // with no push feed at all the answer grows, which is what makes the
        // streaming seamless rather than all-at-once at the end.
        viewModelScope.launch {
            while (true) {
                delay(1_200)
                // follow the turn from history whether this device started it or
                // not: `sending` only tracks our own prompts, and a turn begun
                // elsewhere (Telegram, another phone) must grow on screen too
                if (_state.value.sending || _state.value.live != null) refresh()
            }
        }
    }

    override fun onCleared() {
        AppPresence.onChatClosed(sessionId)
        super.onCleared()
    }

    private fun apply(evt: ChatEvent) {
        when (evt) {
            is ChatEvent.TextDelta -> {
                // the harness echoes the user's own message back mid-turn; its
                // parts are not the agent's output (this rendered your prompt
                // as if the agent had said it)
                if (isUserMessage(evt.messageId)) return
                _state.update { st ->
                    val live = liveFor(st, evt.messageId)
                    val existing = live.parts[evt.partId]
                    val part = if (evt.partType == "reasoning")
                        // thinking streams into a thinking block, never into the
                        // answer body
                        ChatPart.Reasoning((existing as? ChatPart.Reasoning)?.text.orEmpty() + evt.text)
                    else
                        ChatPart.Text((existing as? ChatPart.Text)?.text.orEmpty() + evt.text)
                    // A NEW map and a NEW LiveTurn, never a mutation in place:
                    // StateFlow drops a value equal to the last one, and a
                    // mutated-in-place LiveTurn compares equal — so every delta
                    // after the first was invisible and the visible growth was
                    // coming from the 1.2s history poll instead. That is exactly
                    // why streaming looked chunky and late.
                    st.copy(
                        live = live.copy(parts = LinkedHashMap(live.parts).apply { put(evt.partId, part) }),
                        lost = false,
                        failure = null,
                    )
                }
            }
            is ChatEvent.PartChanged -> {
                if (isUserMessage(evt.messageId)) return
                _state.update { st ->
                    val live = liveFor(st, evt.messageId)
                    val key = evt.partId ?: "extra${live.parts.size}"
                    // a full snapshot is authoritative: it replaces whatever the
                    // deltas accumulated for this part (and, as above, as a new
                    // map so the change is actually observable)
                    st.copy(live = live.copy(parts = LinkedHashMap(live.parts).apply { put(key, evt.part) }))
                }
            }
            is ChatEvent.Asked -> _state.update {
                it.copy(
                    ask = evt.ask,
                    askAt = System.currentTimeMillis(),
                    askChoice = null,
                    askAfter = it.live?.messageId,
                )
            }
            // a harness-reported failure ends the turn: it must clear the live
            // row too, or the spinner outlives the turn it belonged to. An
            // abort is the user's own stop coming back around, not an error.
            is ChatEvent.Failed -> _state.update {
                it.copy(failure = evt.error, live = null, sending = false)
            }
            // a stop ends the turn: clear the live row (or it dangles as a
            // spinner forever) and say why, since the stop can come from the
            // watchdog or the harness and not only from this screen's button
            is ChatEvent.Aborted -> _state.update {
                it.copy(failure = null, live = null, sending = false, notice = "the turn was stopped")
            }
            // the turn finished while this chat is open: it has been seen.
            // session.idle is the turn ending, and prompt() (the blocking POST)
            // can hang even after the model is done (readTimeout is 0), so
            // without clearing here the Stop button outlives the turn and eats
            // the next Send as another stop.
            is ChatEvent.Quiet -> {
                onRead()
                refresh()
                _state.update { it.copy(sending = false, live = null) }
            }
            is ChatEvent.Lost -> _state.update { it.copy(lost = true) }
            is ChatEvent.MessageSeen -> {
                evt.role?.let { roles[evt.messageId] = it }
                // learning mid-turn that the row we're streaming is the user's
                // message: drop it rather than leave the prompt on screen as
                // the agent's
                if (evt.role == Role.USER && _state.value.live?.messageId == evt.messageId) {
                    _state.update { it.copy(live = null) }
                }
            }
        }
    }

    // the text of a message as the user sees it, for reconciling a local
    // placeholder against the harness's record
    private fun textOf(m: ChatMessage): String =
        m.parts.filterIsInstance<ChatPart.Text>().joinToString("\n") { it.text }.trim()

    // the live row is always one message's: an event for a different message
    // (the user's echo, then the agent's answer) starts a fresh row rather than
    // mixing two speakers into one
    private fun liveFor(st: UiState, messageId: String): LiveTurn =
        if (st.live?.messageId == messageId) st.live!! else LiveTurn(messageId)

    private fun isUserMessage(messageId: String): Boolean = roles[messageId] == Role.USER

    // the harness's own record is authoritative once served; optimistic rows
    // survive only until they show up there. History is paged: the newest
    // window only, then older pages on demand via loadOlder().
    fun refresh() {
        // an empty screen while the first page loads looks broken; say we're busy
        if (_state.value.messages.isEmpty()) _state.update { it.copy(loadingHistory = true) }
        viewModelScope.launch {
            runCatching { repo.history(sessionId, limit = WINDOW) }
                .onSuccess { batch ->
                    // An optimistic row is a placeholder for a send still in
                    // flight, and it must go the moment the harness's own
                    // record has that message. The ids can never match (ours is
                    // local, the harness mints its own), so match by text —
                    // otherwise your own message sits there twice for the whole
                    // turn.
                    val servedUser = batch.messages.filter { it.role == Role.USER }.map { textOf(it) }.toMutableList()
                    optimistic.removeAll { o ->
                        val i = servedUser.indexOf(textOf(o))
                        if (i >= 0) {
                            servedUser.removeAt(i)
                            true
                        } else {
                            false
                        }
                    }
                    val servedNow = batch.messages.filter { it.role == Role.USER }
                    _state.update { st ->
                        st.copy(
                            messages = batch.messages + optimistic.toList(),
                            // history is the record, not the stream: it must never
                            // wipe a live row it has merely caught up with, even
                            // when this device did not start the turn
                            live = st.live,
                            hasMore = batch.hasMore,
                            loadingHistory = false,
                            // a queued message that now shows in the record has been
                            // picked up: it is no longer waiting, it is the turn. A
                            // NEW record entry only — an older message with the same
                            // words must not clear it.
                            queued = st.queued.filterNot { q -> servedNow.any { m -> m.id !in q.seen && textOf(m) == q.text } },
                        )
                    }
                }
                .onFailure { _state.update { it.copy(loadingHistory = false) } }
        }
    }

    fun loadOlder() {
        val st = _state.value
        if (st.loadingOlder || !st.hasMore) return
        val oldest = st.messages.minOfOrNull { it.time } ?: return
        _state.update { it.copy(loadingOlder = true) }
        viewModelScope.launch {
            // tell the daemon how much is already held: it asks the harness for
            // one window instead of the whole conversation (a long fork is 199 MB)
            runCatching { repo.history(sessionId, limit = WINDOW, before = oldest, have = st.messages.size) }
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

    fun send(text: String, steer: Boolean = true) {
        val trimmed = text.trim()
        val files = _state.value.attachments
        // an image on its own is a valid message. The model still needs words, so
        // use the line the daemon and Telegram use, so the optimistic row and the
        // served message agree on the text (refresh reconciles them by text).
        if (trimmed.isEmpty() && files.isEmpty()) return
        val body = trimmed.ifEmpty { "see the attached file" }
        if (_state.value.sending) {
            enqueue(body, files, steer)
            return
        }
        sendNow(body, files)
    }

    // The daemon owns the queue now: hand the message over with an id and a mode,
    // and it steers it in at the next tool boundary — or waits for the turn to end
    // if the user asked for that. The client keeps it on screen as queued until it
    // is picked up.
    private fun enqueue(body: String, files: List<Attachment>, steer: Boolean) {
        val clientID = "q-${System.nanoTime()}"
        val seen = _state.value.messages.filter { it.role == Role.USER }.map { it.id }.toSet()
        _state.update { it.copy(queued = it.queued + Queued(clientID, body, files, steer, seen), attachments = emptyList()) }
        viewModelScope.launch {
            // resolves when its turn finishes, or at once if it was cancelled
            runCatching { repo.prompt(sessionId, body, files.map { it.id }, clientID, steer) }
            _state.update { st ->
                val rest = st.queued.filterNot { q -> q.id == clientID }
                // this one is done; a turn is still active only if another waits
                st.copy(queued = rest, sending = if (rest.isEmpty()) false else st.sending)
            }
            refresh()
        }
    }

    private fun sendNow(body: String, files: List<Attachment>) {
        // The optimistic row carries the prompt text and the attachments as
        // separate parts, never the prompt plus an "[attached: …]" suffix the
        // daemon would never produce.
        val pending = ChatMessage(
            id = "local-${System.nanoTime()}",
            role = Role.USER,
            time = System.currentTimeMillis(),
            // the phone's own copy rides along, so an image shows in the bubble
            // straight away rather than as a blank space until the harness
            // ingests the message and hands back a path to fetch
            parts = listOf(ChatPart.Text(body)) + files.map {
                ChatPart.File(path = it.name, name = it.name, mimeType = it.mimeType, localUri = it.localUri)
            },
        )
        val seq = ++turn
        optimistic.add(pending)
        outbox[pending.id] = body to files
        supersedeAsk()
        _state.update {
            it.copy(
                messages = it.messages + pending,
                sending = true,
                live = null,
                failure = null,
                attachments = emptyList(),
            )
        }
        viewModelScope.launch {
            runCatching { repo.prompt(sessionId, body, files.map { it.id }) }
                .onSuccess { final ->
                    if (seq != turn) return@onSuccess
                    optimistic.removeAll { it.id == pending.id }
                    outbox.remove(pending.id)
                    // polling may already have served this message; replace by
                    // id rather than append, or the answer lands twice
                    _state.update { st ->
                        st.copy(
                            messages = st.messages.filterNot { it.id == final.id } + final,
                            sending = false,
                            live = null,
                        )
                    }
                    refresh()
                    // the harness can still be settling its own record for a
                    // moment after the turn returns; read once more, so a
                    // finished answer is never left out
                    viewModelScope.launch {
                        delay(1_500)
                        if (seq == turn) refresh()
                    }
                }
                .onFailure { err ->
                    if (seq != turn) return@onFailure
                    // A stop ends the turn. A steer also aborts this prompt, but
                    // only because a queued message takes over: keep the turn shown
                    // as active until that one finishes, or the reply looks idle.
                    //
                    // A send that never reached the daemon is NOT sent. It stays
                    // where it was put, drawn dimmed with an hourglass and
                    // retryable — the alternative was a normal-looking bubble
                    // that the harness never saw and nobody could tell apart from
                    // a delivered one.
                    if (err !is TurnAborted) {
                        _state.update { st ->
                            st.copy(
                                messages = st.messages.map {
                                    if (it.id == pending.id) it.copy(undelivered = true) else it
                                },
                            )
                        }
                    }
                    _state.update {
                        it.copy(
                            sending = it.queued.isNotEmpty(),
                            live = null,
                            failure = if (err is TurnAborted) null else (err.message ?: "the turn failed"),
                        )
                    }
                }
        }
    }

    fun editQueued(id: String, text: String) {
        val body = text.trim().ifEmpty { return }
        _state.update { st -> st.copy(queued = st.queued.map { if (it.id == id) it.copy(text = body) else it }) }
        viewModelScope.launch { runCatching { repo.queueEdit(sessionId, id, body) } }
    }

    fun cancelQueued(id: String) {
        _state.update { st -> st.copy(queued = st.queued.filterNot { it.id == id }) }
        viewModelScope.launch { runCatching { repo.queueCancel(sessionId, id) } }
    }

    /** run a queued message next, aborting the running turn so it can */
    fun forceSendQueued(id: String) {
        val item = _state.value.queued.firstOrNull { it.id == id } ?: return
        if (!_state.value.sending) {
            // nothing is running: it can go now
            _state.update { it.copy(queued = it.queued.filterNot { q -> q.id == id }) }
            sendNow(item.text, item.attachments)
            return
        }
        _state.update { st -> st.copy(queued = listOf(item) + st.queued.filterNot { q -> q.id == id }) }
        viewModelScope.launch { runCatching { repo.queueForce(sessionId, id) } }
    }

    fun attach(filename: String, bytes: ByteArray, localUri: String? = null, mimeType: String? = null) {
        viewModelScope.launch {
            runCatching { repo.attach(sessionId, filename, bytes) }
                .onSuccess { id ->
                    _state.update { it.copy(attachments = it.attachments + Attachment(id, filename, localUri, mimeType)) }
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

    // Settings: the pickable models and the current agent, loaded on demand
    // when the panel opens, like Telegram's.
    fun loadModels() {
        viewModelScope.launch {
            runCatching { repo.models(sessionId) }
                .onSuccess { m -> _state.update { it.copy(models = m) } }
                .onFailure { err -> _state.update { it.copy(notice = "couldn't load models: ${err.message}") } }
        }
    }

    fun loadAgent() {
        viewModelScope.launch {
            runCatching { repo.agent(sessionId) }
                .onSuccess { a -> _state.update { it.copy(agent = a) } }
            runCatching { repo.agents(sessionId) }
                .onSuccess { list -> _state.update { it.copy(agents = list) } }
        }
    }

    fun setAgent(agent: String?) {
        val before = _state.value.agent
        _state.update { it.copy(agent = agent) }
        viewModelScope.launch {
            runCatching { repo.setAgent(sessionId, agent) }
                .onFailure { err ->
                    _state.update { it.copy(agent = before, notice = "couldn't set the agent: ${err.message}") }
                }
        }
    }

    fun loadUsage() {
        viewModelScope.launch {
            runCatching { repo.usage(sessionId) }
                .onSuccess { u -> _state.update { it.copy(usage = u) } }
                .onFailure { err -> _state.update { it.copy(notice = "couldn't load usage: ${err.message}") } }
        }
    }

    fun loadDiff() {
        viewModelScope.launch {
            runCatching { repo.diff(sessionId) }
                .onSuccess { d -> _state.update { it.copy(diffs = d) } }
                .onFailure { err -> _state.update { it.copy(notice = "couldn't load changes: ${err.message}") } }
        }
    }

    // the in-chat terminal: a tmux-backed shell in this conversation's folder,
    // attached to the session so it reattaches across app and daemon restarts
    suspend fun termOpen() {
        runCatching { repo.termOpen(sessionId) }
    }

    suspend fun termFrame(): String = runCatching { repo.termFrame(sessionId) }.getOrDefault("")

    suspend fun termInput(text: String) {
        runCatching { repo.termInput(sessionId, text) }
    }

    suspend fun termKey(key: String) {
        runCatching { repo.termKey(sessionId, key) }
    }

    suspend fun termClose() {
        runCatching { repo.termClose(sessionId) }
    }

    // the subagent sessions this conversation spawned — reached from here, not
    // listed on their own
    fun loadSubagents() {
        viewModelScope.launch {
            runCatching { repo.subagents(sessionId) }
                .onSuccess { subs -> _state.update { it.copy(subagents = subs) } }
                .onFailure { err -> _state.update { it.copy(notice = "couldn't load subagents: ${err.message}") } }
        }
    }

    // Settings › skills / MCP: what the harness loads. Read from the harness's
    // own files, and toggled in place (frontmatter line / enabled flag).
    fun loadSkills() {
        viewModelScope.launch {
            runCatching { repo.skills(sessionId) }
                .onSuccess { s -> _state.update { it.copy(skills = s) } }
                .onFailure { err -> _state.update { it.copy(notice = "couldn't load skills: ${err.message}") } }
        }
    }

    fun setSkill(path: String, disabled: Boolean) {
        val before = _state.value.skills ?: return
        _state.update { st ->
            st.copy(skills = before.copy(skills = before.skills.map { if (it.path == path) it.copy(disabled = disabled) else it }))
        }
        viewModelScope.launch {
            runCatching { repo.setSkill(sessionId, path, disabled) }
                .onFailure { err -> _state.update { it.copy(skills = before, notice = "couldn't change the skill: ${err.message}") } }
        }
    }

    fun loadMcp() {
        viewModelScope.launch {
            runCatching { repo.mcp(sessionId) }
                .onSuccess { s -> _state.update { it.copy(mcp = s) } }
                .onFailure { err -> _state.update { it.copy(notice = "couldn't load MCP servers: ${err.message}") } }
        }
    }

    fun setMcp(name: String, enabled: Boolean) {
        val before = _state.value.mcp ?: return
        _state.update { st -> st.copy(mcp = before.map { if (it.name == name) it.copy(enabled = enabled) else it }) }
        viewModelScope.launch {
            runCatching { repo.setMcp(sessionId, name, enabled) }
                .onFailure { err -> _state.update { it.copy(mcp = before, notice = "couldn't change the server: ${err.message}") } }
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

    /** a fetchable URL for a file part's bytes (the gateway's /file route) */
    fun fileUrl(path: String): String = repo.fileUrl(path)

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

    fun respond(askId: String, optionId: String) {
        viewModelScope.launch {
            val st = _state.value
            // The card only goes spent when the harness confirms the answer
            // resolved. If it did not, the choices come back: a card that reads
            // "answered" over a turn that is still parked is worse than no
            // acknowledgement at all, because it looks like the work moved on.
            if (st.ask?.id != askId || st.askChoice != null) return@launch
            runCatching { repo.respond(askId, optionId) }
                .onSuccess { ok ->
                    if (ok) _state.update { it.copy(askChoice = optionId, notice = null) }
                    else _state.update {
                        it.copy(notice = "that one didn't land — the ask is still open, try again")
                    }
                }
                .onFailure { err ->
                    _state.update {
                        it.copy(askChoice = null, notice = "the ask didn't take: ${err.message}")
                    }
                }
        }
    }

    /** Send an undelivered message again. Tapping the dimmed bubble is the
     *  affordance: a message the harness never saw is not a message yet. */
    fun retrySend(id: String) {
        val (body, files) = outbox[id] ?: return
        val st = _state.value
        if (st.messages.none { it.id == id && it.undelivered }) return
        // put it back in flight: the bubble loses its dimmed state the moment the
        // send is on its way, exactly as a first attempt did
        _state.update { s ->
            s.copy(
                messages = s.messages.map { if (it.id == id) it.copy(undelivered = false) else it },
                failure = null,
                sending = true,
            )
        }
        val seq = ++turn
        viewModelScope.launch {
            runCatching { repo.prompt(sessionId, body, files.map { it.id }) }
                .onSuccess { final ->
                    if (seq != turn) return@onSuccess
                    optimistic.removeAll { it.id == id }
                    outbox.remove(id)
                    _state.update { s ->
                        s.copy(
                            messages = s.messages.filterNot { it.id == id || it.id == final.id } + final,
                            sending = false,
                        )
                    }
                    refresh()
                }
                .onFailure { err ->
                    _state.update { s ->
                        s.copy(
                            messages = s.messages.map { if (it.id == id) it.copy(undelivered = true) else it },
                            sending = false,
                            failure = err.message ?: "still no connection",
                        )
                    }
                }
        }
    }

    /**
     * Open a file the transcript linked to, in the reader sheet.
     *
     * A relative markdown link is the web's own convention for "a file next to
     * this document", so it needs no jep-specific scheme: the link carries the
     * path, and the workspace it belongs to is the one this conversation is
     * already in. Resolution and the roots check both happen in the daemon, so a
     * link cannot be used to read outside the workspace.
     */
    fun openFile(path: String) {
        val clean = path.trim().removePrefix("./")
        if (clean.isEmpty() || clean.contains("://")) return
        _state.update { it.copy(openFile = OpenFile(clean)) }
        viewModelScope.launch {
            runCatching { repo.readFile(clean) }
                .onSuccess { text ->
                    _state.update { st ->
                        val open = st.openFile ?: return@update st
                        if (open.path != clean) st
                        else st.copy(openFile = open.copy(loading = false, text = text, tooBig = text.length > 400_000))
                    }
                }
                .onFailure { err ->
                    _state.update { st ->
                        val open = st.openFile ?: return@update st
                        if (open.path != clean) st
                        else st.copy(openFile = open.copy(loading = false, error = err.message ?: "couldn't read it"))
                    }
                }
        }
    }

    fun closeFile() {
        _state.update { it.copy(openFile = null) }
    }

    /** The card's "Something else": the choices are spent and the ask stands
     *  down, and the harness is told so — otherwise the turn stays parked on the
     *  ask and never ends without a manual stop. The answer comes as a message. */
    fun spendAsk(askId: String) {
        val st = _state.value
        if (st.ask?.id != askId || st.askChoice != null) return
        _state.update { it.copy(askChoice = SOMETHING_ELSE) }
        viewModelScope.launch { runCatching { repo.reject(askId) } }
    }

    /** A message sent in place of an answer is the answer: stand the ask down so
     *  the turn can finish, and spend the card. */
    private fun supersedeAsk() {
        val st = _state.value
        val ask = st.ask
        if (ask == null || st.askChoice != null) return
        _state.update { it.copy(askChoice = SOMETHING_ELSE) }
        viewModelScope.launch { runCatching { repo.reject(ask.id) } }
    }
}
