package dev.jep.client.data.dto

import kotlinx.serialization.Serializable

// Flat, tolerant DTOs mirroring the gateway JSON (docs/GATEWAY.md). Every field
// optional-padded so an unknown variant can ride through without breaking the
// parser; mapping into domain types is data/'s job, never the UI's.

@Serializable
data class PairRes(val token: String)

@Serializable
data class SessionDto(
    val id: String,
    val title: String = "",
    val workspace: String = "",
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
    val adapter: String? = null,
)

@Serializable
data class SessionsRes(val items: List<SessionDto> = emptyList())

@Serializable
data class ErrorDto(val name: String? = null, val message: String? = null)

@Serializable
data class PartDto(
    val kind: String = "other",
    val id: String? = null,
    val text: String? = null,
    val name: String? = null,
    val status: String? = null,
    val title: String? = null,
    val filePath: String? = null,
)

@Serializable
data class MessageDto(
    val id: String,
    val sessionID: String = "",
    val role: String = "assistant",
    val time: Long = 0,
    val parts: List<PartDto> = emptyList(),
    val error: ErrorDto? = null,
)

@Serializable
data class MessageRes(val message: MessageDto? = null)

@Serializable
data class HistoryRes(val messages: List<MessageDto> = emptyList(), val hasMore: Boolean = false)

@Serializable
data class NewSessionRes(val session: SessionDto)

@Serializable
data class AttachRes(val id: String, val name: String = "")

@Serializable
data class AskOptionDto(val id: String, val label: String, val style: String? = null)

@Serializable
data class AskDto(
    val id: String,
    val sessionID: String = "",
    val title: String = "",
    val detail: String? = null,
    val options: List<AskOptionDto> = emptyList(),
    val kind: String? = null,
)

// one shape for every DomainEvent the gateway forwards; fields the event
// doesn't carry stay null and the mapper switches on `type`
@Serializable
data class EventDto(
    val type: String = "other",
    val sessionID: String? = null,
    val messageID: String? = null,
    val partID: String? = null,
    val partType: String? = null,
    val text: String? = null,
    val role: String? = null,
    val part: PartDto? = null,
    val ask: AskDto? = null,
    val message: String? = null,
)
