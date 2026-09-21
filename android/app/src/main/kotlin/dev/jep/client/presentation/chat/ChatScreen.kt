package dev.jep.client.presentation.chat

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.ExitToApp
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mikepenz.markdown.m3.Markdown
import dev.jep.client.domain.model.ChatMessage
import dev.jep.client.domain.model.ChatPart
import dev.jep.client.domain.model.Role
import dev.jep.client.domain.model.ToolStatus

// The conversation. Reads like the reference: the harness speaks in marked-up
// paragraphs, tool calls collapse to one quiet row each, the person answers
// from a rounded composer that pins itself to the keyboard. Long-press any
// message to copy it; the top bar owns the chat itself.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    vm: ChatViewModel,
    onBack: () -> Unit,
    onNew: () -> Unit,
    onForgetPairing: () -> Unit,
) {
    val state by vm.state.collectAsState()

    // the streaming live row and a history row can carry the same message id
    // (opencode snapshots the in-flight message); LazyColumn keys must stay
    // unique, so the live copy wins and the identical history row is dropped
    val rendered = remember(state) {
        val liveId = state.live?.messageId
        state.messages.filterNot { it.id == liveId } + listOfNotNull(liveAsMessage(state.live))
    }
    val listState = rememberLazyListState()
    // system back should pop the conversation, not the whole activity; the
    // phone's back gesture currently drops straight to the launcher because
    // nothing here intercepted it.
    BackHandler { onBack() }

    LaunchedEffect(rendered.size, rendered.lastOrNull()?.id, state.live) {
        if (rendered.isNotEmpty()) listState.animateScrollToItem(rendered.size - 1)
    }

    // approaching the top of a long conversation pulls the previous page
    LaunchedEffect(listState, state.hasMore) {
        snapshotFlow { listState.firstVisibleItemIndex }
            .collect { index ->
                if (index <= 2 && state.hasMore && !state.loadingOlder) vm.loadOlder()
            }
    }

    var renameOpen by remember { mutableStateOf(false) }
    var deleteOpen by remember { mutableStateOf(false) }
    var forgetOpen by remember { mutableStateOf(false) }
    var settingsOpen by remember { mutableStateOf(false) }

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
            actions = {
                var menu by remember { mutableStateOf(false) }
                val clipboard = LocalClipboardManager.current
                Box {
                    IconButton(onClick = { menu = true }) {
                        Icon(Icons.Filled.MoreVert, "chat menu")
                    }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(
                            text = { Text("Settings") },
                            leadingIcon = { Icon(Icons.Filled.Settings, null) },
                            onClick = { menu = false; settingsOpen = true },
                        )
                        DropdownMenuItem(
                            text = { Text("Rename") },
                            leadingIcon = { Icon(Icons.Filled.Edit, null) },
                            onClick = { menu = false; renameOpen = true },
                        )
                        DropdownMenuItem(
                            text = { Text("New conversation") },
                            leadingIcon = { Icon(Icons.AutoMirrored.Filled.Send, null) },
                            onClick = { menu = false; onNew() },
                        )
                        DropdownMenuItem(
                            text = { Text("Delete conversation") },
                            leadingIcon = { Icon(Icons.Filled.Delete, null) },
                            onClick = { menu = false; deleteOpen = true },
                        )
                        DropdownMenuItem(
                            text = { Text("Copy session id") },
                            leadingIcon = { Icon(Icons.Filled.ContentCopy, null) },
                            onClick = {
                                menu = false
                                clipboard.setText(AnnotatedString(vm.sessionId))
                            },
                        )
                        DropdownMenuItem(
                            text = { Text("Forget pairing") },
                            leadingIcon = { Icon(Icons.Filled.ExitToApp, null) },
                            onClick = { menu = false; forgetOpen = true },
                        )
                    }
                }
            },
        )
        AnimatedVisibility(state.failure != null || state.notice != null) {
            Surface(color = MaterialTheme.colorScheme.surfaceVariant) {
                Text(
                    state.failure ?: state.notice.orEmpty(),
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                    color = if (state.failure != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
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
        Composer(vm)
    }

    if (renameOpen) RenameDialog(
        vm.title,
        onCommit = { vm.rename(it); renameOpen = false },
        onDismiss = { renameOpen = false },
    )
    if (deleteOpen) ConfirmDialog(
        "Delete this conversation?",
        "The session is removed from the machine — it can't be brought back from here.",
        onConfirm = { deleteOpen = false; vm.delete { if (it) onBack() } },
        onDismiss = { deleteOpen = false },
    )
    if (forgetOpen) ConfirmDialog(
        "Forget pairing?",
        "Your token is erased. Reconnect with the gateway address and a fresh pairing code.",
        onConfirm = { forgetOpen = false; onForgetPairing() },
        onDismiss = { forgetOpen = false },
    )
    if (settingsOpen) SettingsDialog(vm, onDismiss = { settingsOpen = false })
}

// Settings, opened from the top-right menu. Scoped to what a phone can act on
// today: the model this conversation runs on (mirroring Telegram's picker).
// The list is fetched when the panel opens; a tap sets it on the gateway, which
// remembers it for the next prompt.
@Composable
private fun SettingsDialog(vm: ChatViewModel, onDismiss: () -> Unit) {
    val state by vm.state.collectAsState()
    LaunchedEffect(Unit) { vm.loadModels() }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Settings") },
        text = {
            val choices = state.models
            Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
                Text(
                    "MODEL",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(bottom = 4.dp),
                )
                if (choices == null) {
                    Text("Loading…", fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                } else {
                    SettingRow("Default (harness)", choices.current == null, null) { vm.setModel(null) }
                    choices.all.forEach { m ->
                        SettingRow(m.modelID, choices.current == m.ref, m.providerID) { vm.setModel(m.ref) }
                    }
                }
            }
        },
        confirmButton = {
            androidx.compose.material3.TextButton(onClick = onDismiss) { Text("Done") }
        },
    )
}

@Composable
private fun SettingRow(label: String, selected: Boolean, subtitle: String?, onPick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onPick).padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                label,
                fontSize = 15.sp,
                color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
            )
            subtitle?.let {
                Text(
                    it,
                    fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        if (selected) Text("✓", color = MaterialTheme.colorScheme.primary, fontSize = 16.sp)
    }
}

private fun liveAsMessage(live: ChatViewModel.LiveTurn?): ChatMessage? {
    if (live == null) return null
    val parts = live.texts.entries.map { ChatPart.Text(it.value.toString()) } + live.extras.values
    if (parts.isEmpty()) return null
    return ChatMessage(live.messageId, Role.ASSISTANT, 0, parts)
}

private fun messageText(message: ChatMessage): String =
    message.parts.filterIsInstance<ChatPart.Text>().joinToString("\n") { it.text }

private fun codeBlocks(text: String): List<String> {
    val fence = Regex("(?s)```(?:[\\w.+-]+)?\\n?(.*?)```")
    val inline = Regex("`([^`\\n]+)`")
    return (fence.findAll(text).map { it.groupValues[1] } +
        inline.findAll(text).map { it.groupValues[1] }).toList()
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun MessageRow(message: ChatMessage) {
    var menu by remember { mutableStateOf(false) }
    val clipboard = LocalClipboardManager.current
    val fullText = remember(message) { messageText(message) }
    val code = remember(message, fullText) { codeBlocks(fullText) }

    Box(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 4.dp)
            .combinedClickable(onClick = {}, onLongClick = { menu = true }),
    ) {
        when (message.role) {
            Role.USER -> UserBubble(message)
            Role.ASSISTANT -> AssistantBody(message)
        }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            DropdownMenuItem(
                text = { Text("Copy") },
                leadingIcon = { Icon(Icons.Filled.ContentCopy, null) },
                onClick = { menu = false; clipboard.setText(AnnotatedString(fullText)) },
            )
            if (code.isNotEmpty()) {
                DropdownMenuItem(
                    text = { Text("Copy code") },
                    leadingIcon = { Icon(Icons.Filled.ContentCopy, null) },
                    onClick = { menu = false; clipboard.setText(AnnotatedString(code.joinToString("\n"))) },
                )
            }
        }
    }
}

@Composable
private fun UserBubble(message: ChatMessage) {
    Box(Modifier.fillMaxWidth()) {
        Surface(
            Modifier.align(Alignment.CenterEnd).widthIn(max = 320.dp),
            color = MaterialTheme.colorScheme.primaryContainer,
            shape = RoundedCornerShape(18.dp),
        ) {
            Column(Modifier.padding(horizontal = 14.dp, vertical = 9.dp)) {
                message.parts.forEach { part ->
                    if (part is dev.jep.client.domain.model.ChatPart.Text) {
                        Text(part.text, color = MaterialTheme.colorScheme.onPrimaryContainer, fontSize = 15.sp)
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
        is ChatPart.Text -> Markdown(part.text + if (streaming) " ▍" else "")
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
            Modifier.fillMaxWidth().combinedClickable(onClick = { open = !open }, onLongClick = {}),
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

@OptIn(ExperimentalLayoutApi::class)
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
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
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

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Composer(vm: ChatViewModel) {
    val state by vm.state.collectAsState()
    val draft = remember { mutableStateOf("") }
    val busy = state.sending || state.live != null

    val context = LocalContext.current
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            val name = displayName(context, uri) ?: "file"
            val bytes = runCatching { context.contentResolver.openInputStream(uri)?.use { it.readBytes() } }.getOrNull()
            if (bytes != null) vm.attach(name, bytes)
        }
    }

    Surface(tonalElevation = 2.dp, color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxWidth().imePadding().padding(horizontal = 12.dp, vertical = 10.dp)) {
            if (state.attachments.isNotEmpty()) {
                FlowRow(
                    Modifier.fillMaxWidth().padding(bottom = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    state.attachments.forEach { a ->
                        AssistChip(
                            onClick = {},
                            label = { Text(a.name, maxLines = 1) },
                            trailingIcon = {
                                Icon(
                                    Icons.Filled.Close,
                                    "remove",
                                    Modifier.size(16.dp).combinedClickable(onClick = { vm.removeAttachment(a.id) }, onLongClick = {}),
                                )
                            },
                        )
                    }
                }
            }
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.Bottom,
            ) {
                IconButton(onClick = { picker.launch(arrayOf("*/*")) }) {
                    Icon(Icons.Filled.AttachFile, "attach", Modifier.size(24.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                OutlinedTextField(
                    value = draft.value,
                    onValueChange = { draft.value = it },
                    Modifier.weight(1f),
                    placeholder = { Text("Message the agent", color = MaterialTheme.colorScheme.onSurfaceVariant) },
                    shape = RoundedCornerShape(24.dp),
                    minLines = 1,
                    maxLines = 6,
                    colors = androidx.compose.material3.OutlinedTextFieldDefaults.colors(
                        unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainer,
                        focusedContainerColor = MaterialTheme.colorScheme.surfaceContainer,
                        focusedBorderColor = MaterialTheme.colorScheme.outline,
                        unfocusedBorderColor = Color.Transparent,
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
                            tint = if (draft.value.isBlank() && state.attachments.isEmpty()) MaterialTheme.colorScheme.surfaceVariant else MaterialTheme.colorScheme.primary,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun RenameDialog(current: String, onCommit: (String) -> Unit, onDismiss: () -> Unit) {
    var value by remember { mutableStateOf(current) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Rename conversation") },
        text = {
            OutlinedTextField(value = value, onValueChange = { value = it }, singleLine = true)
        },
        confirmButton = {
            androidx.compose.material3.TextButton(onClick = { onCommit(value) }) { Text("Save") }
        },
        dismissButton = {
            androidx.compose.material3.TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}

@Composable
private fun ConfirmDialog(title: String, body: String, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(body) },
        confirmButton = {
            androidx.compose.material3.TextButton(onClick = onConfirm) { Text("Confirm") }
        },
        dismissButton = {
            androidx.compose.material3.TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}

private fun displayName(context: Context, uri: Uri): String? =
    runCatching {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            val i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (i >= 0 && c.moveToFirst()) c.getString(i) else null
        }
    }.getOrNull()

@Composable
private fun Spacer8() {
    androidx.compose.foundation.layout.Spacer(Modifier.size(8.dp))
}