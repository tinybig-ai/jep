package dev.jep.client.presentation.chat

import kotlinx.serialization.Serializable

// What a conversation must not lose when the process does: the half-typed
// message (with what is attached to it) and the sends the daemon never took.
// Both lived in the ViewModel's memory, so an app killed in the background, or
// swept away by the system, took them along.
interface ConversationMemory {
    fun loadDraft(sessionId: String): SavedDraft?
    fun saveDraft(sessionId: String, draft: SavedDraft)
    fun loadOutbox(sessionId: String): List<SavedSend>
    fun saveOutbox(sessionId: String, sends: List<SavedSend>)

    /** remembers nothing: previews, tests, a VM built without a device */
    object None : ConversationMemory {
        override fun loadDraft(sessionId: String): SavedDraft? = null
        override fun saveDraft(sessionId: String, draft: SavedDraft) = Unit
        override fun loadOutbox(sessionId: String): List<SavedSend> = emptyList()
        override fun saveOutbox(sessionId: String, sends: List<SavedSend>) = Unit
    }
}

@Serializable
data class SavedAttachment(val id: String, val name: String, val localUri: String? = null, val mimeType: String? = null)

@Serializable
data class SavedDraft(val text: String = "", val attachments: List<SavedAttachment> = emptyList())

@Serializable
data class SavedSend(val id: String, val body: String, val attachments: List<SavedAttachment> = emptyList(), val time: Long = 0)
