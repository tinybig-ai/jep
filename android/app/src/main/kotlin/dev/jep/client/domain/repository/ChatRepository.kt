package dev.jep.client.domain.repository

import dev.jep.client.domain.model.Ask
import dev.jep.client.domain.model.ChatMessage
import dev.jep.client.domain.model.ChatPart
import dev.jep.client.domain.model.Role
import dev.jep.client.domain.model.SessionSummary
import kotlinx.coroutines.flow.Flow

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
    suspend fun newSession(title: String?): SessionSummary
    suspend fun history(sessionId: String): List<ChatMessage>
    suspend fun prompt(sessionId: String, text: String, files: List<String> = emptyList()): ChatMessage
    suspend fun stop(sessionId: String): Boolean
    suspend fun respond(askId: String, optionId: String): Boolean
    suspend fun rename(sessionId: String, title: String): Boolean
    suspend fun delete(sessionId: String): Boolean
    /** upload a file to the gateway; returns the id to pass in the next prompt */
    suspend fun attach(sessionId: String, filename: String, bytes: ByteArray): String
    fun events(): Flow<ChatEvent>
}
