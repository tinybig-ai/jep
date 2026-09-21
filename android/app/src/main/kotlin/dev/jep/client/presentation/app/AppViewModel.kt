package dev.jep.client.presentation.app

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.jep.client.data.GatewayChatRepository
import dev.jep.client.device.JepHttp
import dev.jep.client.device.PairingStore
import dev.jep.client.domain.repository.ChatRepository
import dev.jep.client.domain.model.SessionSummary
import dev.jep.client.domain.model.Workspace
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

// Which screen is up, and the one object every screen builds its data from.
// Navigation is deliberately a single enum: two content screens and the gate.
sealed interface Screen {
    data object Sessions : Screen
    data class Chat(val sessionId: String, val title: String) : Screen
}

class AppViewModel(application: Application) : AndroidViewModel(application) {
    val pairing = PairingStore(application.getSharedPreferences("jep", Context.MODE_PRIVATE))

    private val _screen = MutableStateFlow<Screen>(Screen.Sessions)
    val screen = _screen.asStateFlow()

    private val _sessions = MutableStateFlow<List<SessionSummary>>(emptyList())
    val sessions = _sessions.asStateFlow()

    private val _busy = MutableStateFlow(false)
    val busy = _busy.asStateFlow()

    // workspaces a conversation can be created in, for the creation picker
    private val _workspaces = MutableStateFlow<List<Workspace>>(emptyList())
    val workspaces = _workspaces.asStateFlow()

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
        )
        repo = built
        refresh()
        return built
    }

    fun refresh() {
        val r = repo ?: return
        if (_busy.value) return
        viewModelScope.launch {
            _busy.value = true
            runCatching { r.sessions() }
                .onSuccess { _sessions.value = it; _notice.value = null }
                .onFailure { _notice.value = "gateway unreachable: ${it.message}" }
            // the creation picker lists the same served workspaces; keep them
            // fresh with the session list so "New conversation" is never empty
            runCatching { r.workspaces() }.onSuccess { _workspaces.value = it }
            _busy.value = false
        }
    }

    fun pair(address: String, code: String, onDone: (Boolean, String?) -> Unit) {
        val base = pairing.normalize(address)
        if (base == null || code.isBlank()) {
            onDone(false, "an address and the code are both needed")
            return
        }
        val attempt = GatewayChatRepository(base, { null }, JepHttp.client())
        viewModelScope.launch {
            runCatching { attempt.pair(base, code) }
                .onSuccess { token ->
                    pairing.save(base, token)
                    _paired.value = true
                    connect()
                    onDone(true, null)
                }
                .onFailure { onDone(false, it.message ?: "pairing failed") }
        }
    }

    fun open(session: SessionSummary) {
        _screen.value = Screen.Chat(session.id, session.title)
    }

    // creation-time selection: the workspace (and so the harness) is chosen
    // here, not after the fact — null means the gateway's default
    fun newSession(workspace: String? = null) {
        val r = repo ?: connect()
        viewModelScope.launch {
            runCatching { r.newSession(null, workspace) }
                .onSuccess {
                    refresh()
                    open(it)
                }
                .onFailure { _notice.value = "couldn't start a conversation: ${it.message}" }
        }
    }

    fun back() {
        _screen.value = Screen.Sessions
    }

    fun forgetPairing() {
        pairing.forget()
        repo = null
        _paired.value = false
        _screen.value = Screen.Sessions
        _sessions.value = emptyList()
    }

    /** every chat opens against the same port; ChatViewModels share it */
    fun chat(): ChatRepository = connect()
}
