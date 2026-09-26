package dev.jep.client.device

import android.content.SharedPreferences
import dev.jep.client.domain.repository.ConversationMemory
import dev.jep.client.domain.repository.SavedDraft
import dev.jep.client.domain.repository.SavedSend
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

// ConversationMemory on the device: one small JSON value per conversation and
// kind. An empty draft or outbox removes its key rather than storing nothing.
class ConversationStore(private val prefs: SharedPreferences) : ConversationMemory {
    private val json = Json { ignoreUnknownKeys = true }

    override fun loadDraft(sessionId: String): SavedDraft? =
        prefs.getString("draft_$sessionId", null)?.let { runCatching { json.decodeFromString(SavedDraft.serializer(), it) }.getOrNull() }

    override fun saveDraft(sessionId: String, draft: SavedDraft) {
        val key = "draft_$sessionId"
        if (draft.text.isEmpty() && draft.attachments.isEmpty()) prefs.edit().remove(key).apply()
        else prefs.edit().putString(key, json.encodeToString(SavedDraft.serializer(), draft)).apply()
    }

    override fun loadOutbox(sessionId: String): List<SavedSend> =
        prefs.getString("outbox_$sessionId", null)
            ?.let { runCatching { json.decodeFromString(ListSerializer(SavedSend.serializer()), it) }.getOrNull() }
            .orEmpty()

    override fun saveOutbox(sessionId: String, sends: List<SavedSend>) {
        val key = "outbox_$sessionId"
        if (sends.isEmpty()) prefs.edit().remove(key).apply()
        else prefs.edit().putString(key, json.encodeToString(ListSerializer(SavedSend.serializer()), sends)).apply()
    }
}
