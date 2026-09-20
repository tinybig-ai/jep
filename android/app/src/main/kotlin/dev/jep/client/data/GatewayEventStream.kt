package dev.jep.client.data

import dev.jep.client.data.dto.EventDto
import dev.jep.client.domain.repository.ChatEvent
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.util.concurrent.TimeUnit

// One push connection per device for the lifetime of the process. The feed
// exists whether the app is in the foreground or not (the foreground service
// owns the process while backgrounded); failures surface as ChatEvent.Lost so
// the UI shows staleness instead of pretending.
class GatewayEventStream(
    private val base: String,
    private val token: suspend () -> String?,
) {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    fun open(client: OkHttpClient): Flow<ChatEvent> = callbackFlow {
        val t = token()
        if (t == null) {
            close()
            return@callbackFlow
        }
        val request = Request.Builder()
            .url("$base/stream")
            .header("authorization", "Bearer $t")
            .build()

        val listener = object : EventSourceListener() {
            override fun onOpen(es: EventSource, res: Response) {}
            override fun onEvent(es: EventSource, id: String?, type: String?, data: String) {
                if (data.isBlank()) return
                runCatching { json.decodeFromString(EventDto.serializer(), data) }
                    .getOrNull()?.toChatEvent()?.let { trySend(it) }
            }
            override fun onClosed(es: EventSource) {
                trySend(ChatEvent.Lost)
                close()
            }
            override fun onFailure(es: EventSource, t: Throwable?, res: Response?) {
                trySend(ChatEvent.Lost)
                close()
            }
        }
        val source = EventSources.createFactory(client).newEventSource(request, listener)
        awaitClose { source.cancel() }
    }

    private fun EventDto.toChatEvent(): ChatEvent? {
        val sid = sessionID ?: return null
        return when (type) {
            "part.delta" -> {
                val mid = messageID ?: return null
                val pid = partID ?: return null
                ChatEvent.TextDelta(sid, mid, pid, text.orEmpty())
            }
            "part.updated" -> {
                val mid = messageID ?: return null
                val dto = part ?: return null
                ChatEvent.PartChanged(sid, mid, dto.toPart())
            }
            "message.created", "message.updated" -> {
                val mid = messageID ?: return null
                ChatEvent.MessageSeen(sid, mid, role?.let { if (it == "user") dev.jep.client.domain.model.Role.USER else dev.jep.client.domain.model.Role.ASSISTANT })
            }
            "session.idle" -> ChatEvent.Quiet(sid)
            "ask.requested" -> ask?.let { ChatEvent.Asked(it.sessionID.ifEmpty { sid }, it.toDomain()) }
            "session.error" -> ChatEvent.Failed(sid, message ?: "the harness failed")
            else -> null
        }
    }
}

private fun dev.jep.client.data.dto.PartDto.toPart() = when (kind) {
    "text" -> dev.jep.client.domain.model.ChatPart.Text(text.orEmpty())
    "reasoning" -> dev.jep.client.domain.model.ChatPart.Reasoning(text.orEmpty())
    "tool" -> dev.jep.client.domain.model.ChatPart.Tool(name.orEmpty(), status?.let { runCatching { dev.jep.client.domain.model.ToolStatus.valueOf(it.uppercase()) }.getOrNull() }, title)
    else -> dev.jep.client.domain.model.ChatPart.Unsupported(kind)
}
