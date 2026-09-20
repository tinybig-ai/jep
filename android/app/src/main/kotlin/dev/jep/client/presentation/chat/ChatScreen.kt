package dev.jep.client.presentation.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jep.client.domain.model.ChatMessage
import dev.jep.client.domain.model.ChatPart
import dev.jep.client.domain.model.Role
import dev.jep.client.domain.model.ToolStatus

// The conversation. Reads like the reference: the harness speaks in plain
// paragraphs; tool calls collapse to one quiet row each; the person answers
// from a rounded composer that pins itself to the keyboard.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(vm: ChatViewModel, onBack: () -> Unit) {
    val state by vm.state.collectAsState()

    val rendered = remember(state) { state.messages + listOfNotNull(liveAsMessage(state.live)) }
    val listState = rememberLazyListState()
    LaunchedEffect(rendered.size, rendered.lastOrNull()?.id, state.live) {
        if (rendered.isNotEmpty()) listState.animateScrollToItem(rendered.size - 1)
    }

    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        TopAppBar(
            title = {
                Column {
                    Text(vm.title, style = MaterialTheme.typography.titleMedium)
                    Text(
                        "remote · ${if (state.lost) "reconnecting…" else "connected"}",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            },
            navigationIcon = {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, "back")
                }
            },
        )
        AnimatedVisibility(state.failure != null) {
            Surface(color = MaterialTheme.colorScheme.surfaceVariant) {
                Text(
                    state.failure.orEmpty(),
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                    color = MaterialTheme.colorScheme.error,
                    fontSize = 13.sp,
                )
            }
        }
        LazyColumn(Modifier.weight(1f), state = listState) {
            items(rendered.size, key = { rendered[it].id }) { i ->
                MessageRow(rendered[i])
            }
            item { Spacer8() }
        }
        state.ask?.let { ask -> AskBar(ask, vm) }
        Composer(state.sending || state.live != null, vm)
    }
}

private fun liveAsMessage(live: ChatViewModel.LiveTurn?): ChatMessage? {
    if (live == null) return null
    val parts = live.texts.entries.map { ChatPart.Text(it.value.toString()) } + live.extras.values
    if (parts.isEmpty()) return null
    return ChatMessage(live.messageId, Role.ASSISTANT, 0, parts)
}

@Composable
private fun MessageRow(message: ChatMessage) {
    Box(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 4.dp)) {
        when (message.role) {
            Role.USER -> UserBubble(message)
            Role.ASSISTANT -> AssistantBody(message)
        }
    }
}

@Composable
private fun UserBubble(message: ChatMessage) {
    Box(Modifier.fillMaxWidth()) {
        Surface(
            Modifier.align(Alignment.CenterEnd).widthIn(max = 320.dp),
            color = MaterialTheme.colorScheme.surfaceVariant,
            shape = RoundedCornerShape(18.dp),
        ) {
            Column(Modifier.padding(horizontal = 14.dp, vertical = 9.dp)) {
                message.parts.forEach { part ->
                    if (part is dev.jep.client.domain.model.ChatPart.Text) {
                        Text(part.text, color = MaterialTheme.colorScheme.onSurface, fontSize = 15.sp)
                    }
                }
            }
        }
    }
}

@Composable
private fun AssistantBody(message: ChatMessage) {
    Column(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        message.parts.forEachIndexed { idx, part ->
            val isLast = idx == message.parts.lastIndex
            PartView(part, streaming = isLast && message.time == 0L)
        }
        message.error?.let {
            Text(it, color = MaterialTheme.colorScheme.error, fontSize = 14.sp)
        }
    }
}

@Composable
private fun PartView(part: ChatPart, streaming: Boolean) {
    when (part) {
        is ChatPart.Text -> Text(
            part.text + if (streaming) " ▍" else "",
            color = MaterialTheme.colorScheme.onBackground,
            fontSize = 16.sp,
            lineHeight = 24.sp,
        )
        is ChatPart.Reasoning -> ReasoningRow(part)
        is ChatPart.Tool -> ToolRow(part)
        is ChatPart.Unsupported -> Unit
    }
}

@Composable
private fun ReasoningRow(part: ChatPart.Reasoning) {
    var open by remember { mutableStateOf(false) }
    Column {
        Row(
            Modifier.fillMaxWidth().clickable { open = !open },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "Thought",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Icon(
                Icons.Filled.ArrowDropDown,
                null,
                Modifier.size(18.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        AnimatedVisibility(open) {
            Text(
                part.text,
                fontSize = 14.sp,
                lineHeight = 20.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

@Composable
private fun ToolRow(part: ChatPart.Tool) {
    val running = part.status == ToolStatus.RUNNING || part.status == ToolStatus.PENDING
    val failed = part.status == ToolStatus.ERROR
    Surface(
        Modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.surfaceContainer,
        shape = RoundedCornerShape(10.dp),
    ) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    when (part.name.lowercase()) {
                        "write", "edit", "multi-edit" -> "Edited " + (part.title?.substringAfterLast('/') ?: "file")
                        "read" -> "Read " + (part.title?.substringAfterLast('/') ?: "file")
                        "bash", "run" -> "Ran a command"
                        else -> "Used ${part.name.ifEmpty { "tool" }}"
                    },
                    style = MaterialTheme.typography.labelMedium,
                    color = if (running) MaterialTheme.colorScheme.primary else if (failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Icon(
                    Icons.Filled.ArrowDropDown,
                    null,
                    Modifier.size(16.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            part.title?.let { t ->
                if (part.name.lowercase() in setOf("bash", "run")) {
                    Text(
                        t,
                        fontSize = 12.sp,
                        fontFamily = FontFamily.Monospace,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                    )
                }
            }
        }
    }
}

@Composable
private fun AskBar(ask: dev.jep.client.domain.model.Ask, vm: ChatViewModel) {
    Card(
        Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 6.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        shape = RoundedCornerShape(16.dp),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(ask.title, fontSize = 15.sp, color = MaterialTheme.colorScheme.onBackground)
            ask.detail?.let {
                Text(
                    it,
                    fontSize = 13.sp,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 4,
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ask.options.forEach { option ->
                    OutlinedButton(
                        onClick = { vm.respond(ask.id, option.id) },
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 14.dp, vertical = 4.dp),
                    ) {
                        Text(option.label, fontSize = 14.sp, maxLines = 1)
                    }
                }
            }
        }
    }
}

@Composable
private fun Composer(busy: Boolean, vm: ChatViewModel) {
    val draft = remember { mutableStateOf("") }
    Surface(tonalElevation = 2.dp, color = MaterialTheme.colorScheme.background) {
        Row(
            Modifier.fillMaxWidth().imePadding().padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            OutlinedTextField(
                value = draft.value,
                onValueChange = { draft.value = it },
                Modifier.weight(1f),
                placeholder = { Text("Type a message", color = MaterialTheme.colorScheme.onSurfaceVariant) },
                shape = RoundedCornerShape(24.dp),
                minLines = 1,
                maxLines = 5,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                colors = androidx.compose.material3.OutlinedTextFieldDefaults.colors(
                    unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainer,
                    focusedContainerColor = MaterialTheme.colorScheme.surfaceContainer,
                    focusedBorderColor = MaterialTheme.colorScheme.outline,
                    unfocusedBorderColor = androidx.compose.ui.graphics.Color.Transparent,
                ),
            )
            IconButton(onClick = {
                if (busy) vm.stop() else {
                    vm.send(draft.value)
                    draft.value = ""
                }
            }) {
                if (busy) {
                    Icon(Icons.Filled.Stop, "stop", Modifier.size(26.dp), tint = MaterialTheme.colorScheme.error)
                } else {
                    Icon(
                        Icons.AutoMirrored.Filled.Send,
                        "send",
                        Modifier.size(26.dp),
                        tint = MaterialTheme.colorScheme.primary,
                    )
                }
            }
        }
    }
}

@Composable
private fun Spacer8() {
    androidx.compose.foundation.layout.Spacer(Modifier.size(8.dp))
}
