package dev.jep.client.presentation.app

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.jep.client.data.GatewayChatRepository
import dev.jep.client.device.AppSettings
import dev.jep.client.device.JepHttp
import dev.jep.client.domain.model.TextSize
import dev.jep.client.domain.model.ThemeMode
import dev.jep.client.device.PairingStore
import dev.jep.client.domain.repository.ChatRepository
import dev.jep.client.domain.model.BrowseResult
import dev.jep.client.domain.model.ImportableSession
import dev.jep.client.domain.model.HarnessSetting
import dev.jep.client.domain.repository.Attention
import dev.jep.client.domain.repository.ConversationMemory
import dev.jep.client.domain.model.SessionSummary
import dev.jep.client.domain.model.TerminalAccess
import dev.jep.client.domain.model.Workspace
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// Which screen is up, and the one object every screen builds its data from.
// Navigation is deliberately a single enum: two content screens and the gate.
sealed interface Screen {
    data object Sessions : Screen
    data object NewChat : Screen
    data object Settings : Screen
    data class Chat(val sessionId: String, val title: String, val workspace: String, val harness: String?) : Screen
}

// The New Conversation form's state. A conversation is born with a directory
// (a served workspace, or any path under the browse root — or none at all: a
// "pod" has the daemon conjure a throwaway one) and a harness — both the
// user's to choose here, and not changeable afterwards.
data class NewChatState(
    val title: String = "",
    val harness: String? = null,
    /** selected served workspace name, when picking one of those */
    val workspace: String? = null,
    /** selected absolute directory, when browsing — wins over `workspace` */
    val path: String? = null,
    /** a pod: no folder picked — the daemon conjures a throwaway directory */
    val pod: Boolean = false,
    val harnesses: List<String> = emptyList(),
    val defaultHarness: String? = null,
    val harnessOptions: List<HarnessSetting> = emptyList(),
    val harnessSettings: Map<String, Boolean> = emptyMap(),
    val loadingHarnessSettings: Boolean = false,
    val workspaces: List<Workspace> = emptyList(),
    val browse: BrowseResult? = null,
    val browsing: Boolean = false,
    val loadingBrowse: Boolean = false,
    val creating: Boolean = false,
    val error: String? = null,
    /** content shared into jep, sent as the new conversation's first message */
    val shared: SharedContent? = null,
) {
    /** what the form would create in, for the summary line */
    val target: String? get() = path ?: workspace
}

// Something shared into jep from another app: text, a link, files — held
// until its destination is picked (a recent project, any folder, or a pod),
// then sent as the new conversation's first message.
data class SharedContent(
    val text: String?,
    val files: List<SharedFile> = emptyList(),
) {
    data class SharedFile(val name: String, val bytes: ByteArray, val mime: String? = null) {
        // ByteArray's default equals is identity — keep this a value class in
        // practice (state copy comparisons) by spelling out content equality
        override fun equals(other: Any?) = other is SharedFile && name == other.name && mime == other.mime && bytes.contentEquals(other.bytes)
        override fun hashCode() = 31 * (31 * name.hashCode() + (mime?.hashCode() ?: 0)) + bytes.contentHashCode()
    }

    /** one line for the form's banner, so it shows what it's carrying */
    val summary: String
        get() = when {
            files.isEmpty() -> text?.lineSequence()?.firstOrNull()?.take(80) ?: "Shared text"
            files.size == 1 && text.isNullOrBlank() -> files[0].name
            files.size == 1 -> "${files[0].name} + text"
            else -> "${files.size} files" + if (text.isNullOrBlank()) "" else " + text"
        }
}

// The group every pod conversation lists under in the grouped view: a pod's
// throwaway dir names no project, so they share a "Pods" one. Not a real
// path — the prefix keeps it from ever colliding with a directory.
internal const val PODS_PROJECT = "jep:pods"

// app-wide preferences, mirrored into a flow so the theme can react
data class Prefs(
    val theme: ThemeMode,
    val textSize: TextSize,
    val terminalEnabled: Boolean,
    val backgroundStreaming: Boolean,
    val groupByProject: Boolean = false,
)

class AppViewModel(application: Application) : AndroidViewModel(application) {
    val pairing = PairingStore(application.getSharedPreferences("jep", Context.MODE_PRIVATE))
    private val settings = AppSettings(application.getSharedPreferences("jep", Context.MODE_PRIVATE))

    private val read = dev.jep.client.device.ReadStore(application.getSharedPreferences("jep", Context.MODE_PRIVATE))
    /** each conversation's draft and unsent messages, past the process's life */
    val memory: ConversationMemory = dev.jep.client.device.ConversationStore(application.getSharedPreferences("jep-conversations", Context.MODE_PRIVATE))
    /** how the screens tell the device what the person is looking at */
    val attention: Attention = dev.jep.client.device.DeviceAttention(application)

    private val _prefs = MutableStateFlow(Prefs(settings.theme, settings.textSize, settings.terminalEnabled, settings.backgroundStreaming, settings.groupByProject))
    val prefs = _prefs.asStateFlow()

    // the gateway we're pointed at — changes when re-paired, and the Settings
    // read-out must show the new one without a restart
    private val _gateway = MutableStateFlow(pairing.baseUrl)
    val gateway = _gateway.asStateFlow()

    /** point at a different gateway: a new machine, so a new pairing code */
    fun reconnect(address: String, code: String, onResult: (Boolean) -> Unit) {
        pair(address, code) { ok, _ -> onResult(ok) }
    }

    fun setTheme(mode: ThemeMode) {
        settings.setTheme(mode)
        _prefs.value = _prefs.value.copy(theme = mode)
    }

    fun setTextSize(size: TextSize) {
        settings.setTextSize(size)
        _prefs.value = _prefs.value.copy(textSize = size)
    }

    // The terminal is not a normal preference: turning it on proves the pairing
    // code afresh, and only that unlocks a shell for this device on the daemon.
    fun enableTerminal(code: String, onResult: (Boolean) -> Unit) {
        val r = repo ?: connect()
        viewModelScope.launch {
            runCatching { r.unlockTerminal(code.trim()) }
                .onSuccess {
                    settings.setTerminalEnabled(true)
                    _prefs.value = _prefs.value.copy(terminalEnabled = true)
                    _termAccess.value = TerminalAccess(allowed = true, authorized = true)
                    onResult(true)
                }
                .onFailure { onResult(false) }
        }
    }

    fun setBackgroundStreaming(enabled: Boolean) {
        settings.setBackgroundStreaming(enabled)
        _prefs.value = _prefs.value.copy(backgroundStreaming = enabled)
    }

    fun setGroupByProject(enabled: Boolean) {
        settings.setGroupByProject(enabled)
        _prefs.value = _prefs.value.copy(groupByProject = enabled)
    }

    fun disableTerminal() {
        settings.setTerminalEnabled(false)
        _prefs.value = _prefs.value.copy(terminalEnabled = false)
        val r = repo ?: return
        viewModelScope.launch { runCatching { r.lockTerminal() } }
    }

    // whether the *gateway* offers a terminal — an operator setting on the
    // machine, which the phone can show but cannot grant itself
    private val _termAccess = MutableStateFlow<TerminalAccess?>(null)
    val termAccess = _termAccess.asStateFlow()

    fun openSettings() {
        _screen.value = Screen.Settings
        refreshTerminalAccess()
    }

    fun refreshTerminalAccess() {
        val r = repo ?: return
        viewModelScope.launch { runCatching { r.terminalStatus() }.onSuccess { _termAccess.value = it } }
    }

    private val _screen = MutableStateFlow<Screen>(Screen.Sessions)
    val screen = _screen.asStateFlow()

    // Opening a subagent replaces the conversation it was reached from, so
    // Back would drop you at the list. A stack keeps the way back: drill in,
    // come out where you were.
    private val chatStack = ArrayDeque<Screen.Chat>()

    private val _sessions = MutableStateFlow<List<SessionSummary>>(emptyList())
    val sessions = _sessions.asStateFlow()

    // harnesses that missed the daemon's listing budget — one line per harness,
    // ready to show in a banner on the sessions screen
    private val _degraded = MutableStateFlow<List<String>>(emptyList())
    val degraded = _degraded.asStateFlow()

    private val _busy = MutableStateFlow(false)
    val busy = _busy.asStateFlow()

    // conversations that have moved on since they were last opened; the list
    // marks them so a finished turn is visible without opening every chat
    private val _unread = MutableStateFlow<Set<String>>(emptySet())
    val unread = _unread.asStateFlow()

    private fun recomputeUnread() {
        _unread.value = _sessions.value.filter { read.isUnread(it) }.map { it.id }.toSet()
    }

    // workspaces a conversation can be created in, for the creation picker
    private val _workspaces = MutableStateFlow<List<Workspace>>(emptyList())
    val workspaces = _workspaces.asStateFlow()

    // The project opened inside the grouped list, kept here rather than in
    // the screen: it must survive leaving for a conversation, or Back lands
    // on the top of the list instead of the folder the chat came from.
    private val _openProject = MutableStateFlow<String?>(null)
    val openProject = _openProject.asStateFlow()

    fun openProject(dir: String?) {
        _openProject.value = dir
    }

    private val _newChat = MutableStateFlow(NewChatState())
    val newChat = _newChat.asStateFlow()

    private val _notice = MutableStateFlow<String?>(null)
    val notice = _notice.asStateFlow()

    private var repo: ChatRepository? = null

    private val _paired = MutableStateFlow(false)
    val paired = _paired.asStateFlow()

    init {
        if (pairing.isPaired) {
            _paired.value = true
            connect()
        }
    }

    private fun connect(): ChatRepository {
        val existing = repo
        if (existing != null) return existing
        val built = GatewayChatRepository(
            base = pairing.baseUrl ?: "",
            token = { pairing.token },
            http = JepHttp.client(),
            onNextCode = { pairing.rememberCode(it) },
        )
        repo = built
        refresh()
        return built
    }

    // A refresh asked for while one is already running is remembered, not
    // dropped. Importing a conversation asks for one the moment it lands, and
    // silently skipping it left the list without the new row — which looked
    // exactly like the import having failed.
    private var refreshQueued = false

    fun refresh() {
        val r = repo ?: return
        if (_busy.value) {
            refreshQueued = true
            return
        }
        viewModelScope.launch {
            _busy.value = true
            var anyActive = false
            runCatching { r.sessions() }
                .onSuccess { list ->
                    _sessions.value = list.items
                    _degraded.value = list.degraded.map { it.banner() }
                    recomputeUnread()
                    _notice.value = null
                    anyActive = list.items.any { it.active }
                }
                .onFailure {
                    _notice.value = "gateway unreachable: ${it.message}"
                    _degraded.value = emptyList()
                }
            // the creation picker lists the same served workspaces; keep them
            // fresh with the session list so "New conversation" is never empty
            runCatching { r.workspaces() }.onSuccess { _workspaces.value = byRecency(it) }
            _busy.value = false
            if (refreshQueued) {
                refreshQueued = false
                refresh()
            } else if (anyActive && _screen.value == Screen.Sessions) {
                // A live mark has to clear itself when the turn ends, and there is
                // no push for "this conversation is done" — so while anything is
                // running, look again in a moment. Stops as soon as nothing is.
                delay(4_000)
                if (_screen.value == Screen.Sessions) refresh()
            }
        }
    }

    fun pair(address: String, code: String, onDone: (Boolean, String?) -> Unit) {
        val base = pairing.normalize(address)
        if (base == null || code.isBlank()) {
            onDone(false, "an address and the code are both needed")
            return
        }
        val attempt = GatewayChatRepository(base, { null }, JepHttp.client(), { pairing.rememberCode(it) })
        viewModelScope.launch {
            runCatching { attempt.pair(base, code) }
                .onSuccess { token ->
                    pairing.save(base, token)
                    _gateway.value = pairing.baseUrl
                    _paired.value = true
                    connect()
                    onDone(true, null)
                }
                .onFailure { onDone(false, it.message ?: "pairing failed") }
        }
    }

    // Conversations archived a moment ago, held so they can be put back. A
    // swipe is easy to trigger by accident, and every mail client sets the
    // expectation that it is undoable.
    private val _undo = MutableStateFlow<List<SessionSummary>>(emptyList())
    val undo = _undo.asStateFlow()
    private var undoTimer: Job? = null

    /** rows picked in select mode */
    private val _selection = MutableStateFlow<Set<String>>(emptySet())
    val selection = _selection.asStateFlow()

    fun toggleSelect(session: SessionSummary) =
        _selection.update { if (session.id in it) it - session.id else it + session.id }

    fun clearSelection() = _selection.update { emptySet() }

    // swipe-to-archive: hide it from the list, leave the harness untouched
    fun archive(session: SessionSummary) = archiveAll(listOf(session))

    fun archiveSelected() {
        val chosen = _sessions.value.filter { it.id in _selection.value }
        _selection.value = emptySet()
        archiveAll(chosen)
    }

    fun markSelected(read: Boolean) {
        val ids = _selection.value
        if (ids.isEmpty()) return
        _selection.value = emptySet()
        ids.forEach { if (read) markRead(it) else markUnread(it) }
    }

    // Pinning holds a conversation at the top of the list. The daemon owns the
    // fact (so the phone and Telegram agree, and a reinstall keeps the pins),
    // but the list is re-sorted here at once rather than waiting for a reload:
    // a pin that visibly does nothing until the next refresh reads as broken.
    fun pinSelected(pinned: Boolean) {
        val ids = _selection.value
        if (ids.isEmpty()) return
        _selection.value = emptySet()
        pinAll(ids, pinned)
    }

    fun togglePin(session: SessionSummary) = pinAll(setOf(session.id), !session.pinned)

    private fun pinAll(ids: Set<String>, pinned: Boolean) {
        val r = repo ?: return
        if (ids.isEmpty()) return
        _sessions.value = pinFirst(_sessions.value.map { if (it.id in ids) it.copy(pinned = pinned) else it })
        viewModelScope.launch {
            var failed = false
            for (id in ids) {
                val done = runCatching { if (pinned) r.pinSession(id) else r.unpinSession(id) }.getOrDefault(false)
                if (!done) failed = true
            }
            if (failed) {
                _notice.value = "couldn't change the pin — the list is being reloaded"
                refresh()
            }
        }
    }

    /** pinned conversations first, then by recency — the daemon's own order */
    private fun pinFirst(sessions: List<SessionSummary>): List<SessionSummary> =
        sessions.sortedWith(compareByDescending<SessionSummary> { it.pinned }.thenByDescending { it.updatedAt })

    private fun archiveAll(sessions: List<SessionSummary>) {
        val r = repo ?: return
        if (sessions.isEmpty()) return
        val ids = sessions.map { it.id }.toSet()
        _sessions.value = _sessions.value.filterNot { it.id in ids }
        _undo.value = sessions
        undoTimer?.cancel()
        undoTimer = viewModelScope.launch {
            delay(UNDO_MS)
            _undo.value = emptyList()
        }
        viewModelScope.launch {
            var failed = false
            for (s in sessions) {
                runCatching { r.archiveSession(s.id) }.onFailure { failed = true }
            }
            if (failed) {
                _notice.value = "couldn't archive something — the list is being reloaded"
                refresh()
            }
        }
    }

    fun undoArchive() {
        val sessions = _undo.value
        if (sessions.isEmpty()) return
        undoTimer?.cancel()
        _undo.value = emptyList()
        val r = repo ?: return
        viewModelScope.launch {
            for (s in sessions) runCatching { r.unarchiveSession(s.id) }
            refresh()
        }
    }

    /** the row was looked at: stop marking it unread */
    fun markRead(sessionId: String) {
        val at = System.currentTimeMillis()
        read.markRead(sessionId, at)
        _unread.value = _unread.value - sessionId
        val r = repo ?: return
        viewModelScope.launch { runCatching { r.seen(sessionId, at) } }
    }

    fun markUnread(sessionId: String) {
        read.markUnread(sessionId)
        // the daemon's mark would otherwise keep it read until the next listing
        _sessions.value = _sessions.value.map { if (it.id == sessionId) it.copy(seenAt = 0) else it }
        recomputeUnread()
        val r = repo ?: return
        viewModelScope.launch { runCatching { r.seen(sessionId, 0) } }
    }

    // conversations that were archived: reachable, restorable, and otherwise
    // invisible — null until asked for, like the importable list
    private val _archived = MutableStateFlow<List<SessionSummary>?>(null)
    val archived = _archived.asStateFlow()

    fun loadArchived() {
        val r = repo ?: return
        viewModelScope.launch {
            runCatching { r.archivedSessions() }
                .onSuccess { _archived.value = it }
                .onFailure { _notice.value = "couldn't list archived conversations: ${it.message}" }
        }
    }

    fun unarchive(session: SessionSummary) {
        val r = repo ?: return
        _archived.value = _archived.value?.filterNot { it.id == session.id }
        viewModelScope.launch {
            runCatching { r.unarchiveSession(session.id) }
                .onFailure { _notice.value = "couldn't restore it: ${it.message}"; loadArchived() }
                .onSuccess { refresh() }
        }
    }

    // sessions in the user's own opencode (not jep's) that could be forked in
    private val _importable = MutableStateFlow<List<ImportableSession>?>(null)
    val importable = _importable.asStateFlow()

    fun loadImportable() {
        val r = repo ?: return
        viewModelScope.launch {
            runCatching { r.importableSessions() }
                .onSuccess { _importable.value = it }
                .onFailure { _notice.value = "couldn't list sessions to import: ${it.message}" }
        }
    }

    fun importSession(id: String) {
        val r = repo ?: return
        viewModelScope.launch {
            runCatching { r.importSession(id) }
                .onSuccess {
                    _importable.value = _importable.value?.filterNot { it.id == id }
                    // The daemon forks the copy and then restarts the workspace
                    // so the running harness can see it; that takes a beat, so
                    // look now and again shortly — otherwise the list misses the
                    // conversation it was just told about.
                    refresh()
                    viewModelScope.launch {
                        delay(1_500)
                        refresh()
                    }
                }
                .onFailure { _notice.value = "import failed: ${it.message}" }
        }
    }

    /** Open a conversation by id — how a notification tap lands in the chat
     * it was about rather than on the list. The list may not be loaded yet on a
     * cold start, so fall back to fetching it once. */
    fun openSessionById(sessionId: String) {
        _sessions.value.firstOrNull { it.id == sessionId }?.let {
            open(it)
            return
        }
        val r = repo ?: return
        viewModelScope.launch {
            runCatching { r.sessions() }.onSuccess { list ->
                _sessions.value = list.items
                recomputeUnread()
                list.items.firstOrNull { it.id == sessionId }?.let { open(it) }
            }
        }
    }

    fun open(session: SessionSummary) {
        markRead(session.id)
        // opened: whatever was announced about it is in front of the person now
        attention.seen(session.id)
        // `adapter` is the workspace's friendly name; fall back to the folder
        // name of the path when an older listing didn't carry it
        val target = Screen.Chat(
            session.id,
            session.title,
            session.adapter ?: session.workspace.substringAfterLast('/'),
            session.harness,
        )
        // reached from another conversation (a subagent): remember the way back
        (_screen.value as? Screen.Chat)?.takeIf { it.sessionId != target.sessionId }?.let { chatStack.addLast(it) }
        _screen.value = target
    }

    // ---- New conversation (a full view, not a modal) ----------------------

    fun openNewChat() {
        val r = repo ?: connect()
        // Inside a project folder, "New conversation" means here: the folder
        // it was opened from is already picked. A served workspace is named
        // (its harness comes with it); an unserved dir goes as a path and the
        // daemon brings the chosen harness up on it. Inside "Pods" the pick
        // is a pod itself.
        val inside = _openProject.value
        val base = NewChatState(workspaces = _workspaces.value)
        _newChat.value = when {
            inside == null -> base
            inside == PODS_PROJECT -> base.copy(pod = true)
            else -> _workspaces.value.firstOrNull { it.dir == inside }
                ?.let { base.copy(workspace = it.name, harness = it.harness) }
                ?: base.copy(path = inside)
        }
        _screen.value = Screen.NewChat
        viewModelScope.launch {
            runCatching { r.harnesses() }.onSuccess { h ->
                val selected = _newChat.value.harness ?: h.default
                _newChat.update { it.copy(harnesses = h.ids, harness = selected, defaultHarness = h.default) }
                selected?.let { loadNewHarnessOptions(r, it) }
            }
            runCatching { r.workspaces() }.onSuccess { w ->
                val ordered = byRecency(w)
                _workspaces.value = ordered
                _newChat.update { it.copy(workspaces = ordered) }
            }
        }
    }

    // Shared in from another app: open the same form with the content held
    // and only its destination to pick — a recent project (the fastest share
    // lands in the one you were just in), any folder, or a pod. The send goes
    // through the chat the form creates, so a share is a first message, not a
    // side channel.
    fun offerShared(content: SharedContent) {
        val r = repo ?: connect()
        val recent = byRecency(_workspaces.value).firstOrNull { !it.pod }
        _newChat.value = NewChatState(
            workspaces = _workspaces.value,
            shared = content,
            pod = recent == null,
            workspace = recent?.name,
            harness = recent?.harness,
        )
        _screen.value = Screen.NewChat
        viewModelScope.launch {
            runCatching { r.harnesses() }.onSuccess { h ->
                val selected = _newChat.value.harness ?: h.default
                _newChat.update { it.copy(harnesses = h.ids, harness = selected, defaultHarness = h.default) }
                selected?.let { loadNewHarnessOptions(r, it) }
            }
            runCatching { r.workspaces() }.onSuccess { w ->
                val ordered = byRecency(w)
                _workspaces.value = ordered
                _newChat.update { it.copy(workspaces = ordered) }
            }
        }
    }

    // Content created-with, waiting for its conversation to open: the chat
    // consumes it on first composition and sends it through the normal send
    // path, so a share is a real first message. Keyed by session so a share
    // abandoned mid-create can't leak into the next chat opened.
    private val _pendingShared = MutableStateFlow<Pair<String, SharedContent>?>(null)
    fun consumeShared(sessionId: String): SharedContent? =
        _pendingShared.value?.takeIf { it.first == sessionId }?.second?.also { _pendingShared.value = null }

    /**
     * The served workspaces, most recently used first.
     *
     * A folder's place comes from the newest conversation in it, not from the
     * order the gateway happens to list them: the picker is opened to start
     * work in a project you were just in, and a stable alphabetical list buries
     * that under folders untouched for weeks. Folders with no conversation keep
     * their served order, after the ones with history.
     */
    private fun byRecency(workspaces: List<Workspace>): List<Workspace> {
        val lastUsed = HashMap<String, Long>()
        for (s in _sessions.value) {
            if (s.workspace.isBlank()) continue
            val seen = lastUsed[s.workspace]
            if (seen == null || s.updatedAt > seen) lastUsed[s.workspace] = s.updatedAt
        }
        if (lastUsed.isEmpty()) return workspaces
        val used = workspaces.filter { lastUsed.containsKey(it.dir) }.sortedByDescending { lastUsed[it.dir] }
        val fresh = workspaces.filterNot { lastUsed.containsKey(it.dir) }
        return used + fresh
    }

    fun closeNewChat() {
        _screen.value = Screen.Sessions
    }

    fun setNewTitle(value: String) = _newChat.update { it.copy(title = value, error = null) }
    fun setNewHarness(id: String) {
        _newChat.update { it.copy(harness = id, harnessOptions = emptyList(), harnessSettings = emptyMap(), error = null) }
        (repo ?: return).let { loadNewHarnessOptions(it, id) }
    }

    fun setNewHarnessSetting(id: String, enabled: Boolean) = _newChat.update {
        it.copy(harnessSettings = it.harnessSettings + (id to enabled))
    }

    private fun loadNewHarnessOptions(r: ChatRepository, harness: String) {
        _newChat.update { it.copy(loadingHarnessSettings = true) }
        viewModelScope.launch {
            runCatching { r.harnessOptions(harness) }
                .onSuccess { options ->
                    _newChat.update { current ->
                        if (current.harness != harness) current
                        else current.copy(
                            harnessOptions = options,
                            harnessSettings = options.associate { option ->
                                option.id to (current.harnessSettings[option.id] ?: option.default)
                            },
                            loadingHarnessSettings = false,
                        )
                    }
                }
                .onFailure {
                    _newChat.update { current -> if (current.harness == harness) current.copy(loadingHarnessSettings = false) else current }
                }
        }
    }
    // a served workspace already names its harness — picking the row picks both,
    // so the two selectors can never disagree
    fun selectWorkspace(name: String, harness: String) {
        _newChat.update { it.copy(workspace = name, path = null, pod = false, harness = harness, harnessOptions = emptyList(), harnessSettings = emptyMap(), error = null) }
        (repo ?: return).let { loadNewHarnessOptions(it, harness) }
    }
    fun selectPath(path: String) = _newChat.update { it.copy(path = path, workspace = null, pod = false, browsing = false, error = null) }

    // a pod: no folder at all — the daemon conjures a throwaway directory,
    // and the harness chips above are the whole choice
    fun selectPod() = _newChat.update { it.copy(pod = true, workspace = null, path = null, error = null) }

    fun openBrowse() {
        _newChat.update { it.copy(browsing = true, error = null) }
        loadBrowse(_newChat.value.path)
    }

    fun closeBrowse() = _newChat.update { it.copy(browsing = false) }

    /** create a folder in the folder being browsed, then show it in place */
    fun newFolder(name: String) {
        val r = repo ?: return
        val cwd = _newChat.value.browse?.cwd
        viewModelScope.launch {
            runCatching { r.newFolder(cwd, name.trim()) }
                .onSuccess { loadBrowse(cwd) }
                .onFailure { e -> _newChat.update { it.copy(error = e.message ?: "couldn't create that folder") } }
        }
    }
    fun browseInto(path: String) = loadBrowse(path)
    fun browseUp() = loadBrowse(_newChat.value.browse?.parent)

    private fun loadBrowse(path: String?) {
        val r = repo ?: return
        // a listing can take seconds (and, for a folder the daemon can't reach,
        // a fixed timeout) — say so, or a tap looks like nothing happened
        _newChat.update { it.copy(loadingBrowse = true, error = null) }
        viewModelScope.launch {
            runCatching { r.browse(path) }
                .onSuccess { b -> _newChat.update { it.copy(browse = b, loadingBrowse = false) } }
                .onFailure { e -> _newChat.update { it.copy(loadingBrowse = false, error = browseError(e)) } }
        }
    }

    // the gateway 504s a folder it can't read (macOS TCC — Downloads/Documents/
    // Desktop — or a stalled mount); name that instead of leaking the wire text
    private fun browseError(e: Throwable): String {
        val m = e.message.orEmpty()
        return if (m.contains("respond", ignoreCase = true))
            "jep can't read that folder. On macOS give the daemon Full Disk Access (System Settings › Privacy & Security), or pick another folder."
        else "couldn't read that folder: $m"
    }

    fun createConversation() {
        val r = repo ?: connect()
        val st = _newChat.value
        if (st.creating) return
        if (!st.pod && st.target == null) {
            _newChat.update { it.copy(error = "pick a workspace or a folder first") }
            return
        }
        _newChat.update { it.copy(creating = true, error = null) }
        viewModelScope.launch {
            runCatching {
                r.newSession(st.title.ifBlank { null }, st.workspace, st.path, st.harness, st.harnessSettings, st.pod)
            }
                .onSuccess {
                    st.shared?.let { c -> _pendingShared.value = it.id to c }
                    refresh()
                    open(it)
                }
                .onFailure { e -> _newChat.update { it.copy(creating = false, error = "couldn't start it: ${e.message}") } }
        }
    }

    fun back() {
        // up to the conversation this one was opened from, if any; the list
        // otherwise
        val parent = if (_screen.value is Screen.Chat) chatStack.removeLastOrNull() else null
        _screen.value = parent ?: Screen.Sessions
        // a conversation can be renamed or deleted while it's open; the list
        // must show that on the way back rather than needing a manual pull
        refresh()
    }

    fun forgetPairing() {
        chatStack.clear()
        pairing.forget()
        _gateway.value = null
        repo = null
        _paired.value = false
        _screen.value = Screen.Sessions
        _sessions.value = emptyList()
    }

    /** every chat opens against the same port; ChatViewModels share it */
    fun chat(): ChatRepository = connect()

    private companion object {
        /** how long the undo affordance stays up after an archive */
        const val UNDO_MS = 6_000L
    }
}
