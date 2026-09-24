package dev.jep.client.presentation.chat

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * A file the user tapped in a message, waiting to be opened in the reader.
 *
 * A tapped relative link arrives here as an intent, which the activity owns; the
 * conversation that can actually read the file is owned by a ViewModel that may
 * not exist yet on a cold start. So the path is parked until a chat is on screen
 * and takes it. It is consumed once, and never persisted — it is a navigation
 * hand-off, not a queue.
 */
object OpenedFile {
    private val _pending = MutableStateFlow<String?>(null)
    val pending: StateFlow<String?> = _pending.asStateFlow()

    fun offer(path: String) {
        if (path.isNotBlank()) _pending.value = path
    }

    fun take(path: String) {
        if (_pending.value == path) _pending.value = null
    }
}
