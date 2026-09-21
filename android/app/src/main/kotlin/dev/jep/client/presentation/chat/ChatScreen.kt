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
import androidx.compose.material.icons.filled.ArrowDropUp
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.ExitToApp
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material.icons.filled.Star
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
import androidx.compose.material3.Switch
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
import kotlin.math.roundToInt
import kotlin.math.roundToLong
import dev.jep.client.domain.model.ChatMessage
import dev.jep.client.domain.model.ChatPart
import dev.jep.client.domain.model.Role
import dev.jep.client.domain.model.ToolStatus
import dev.jep.client.domain.repository.ModelChoices

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
    var usageOpen by remember { mutableStateOf(false) }
    var changesOpen by remember { mutableStateOf(false) }
    var infoMsg by remember { mutableStateOf<ChatMessage?>(null) }

    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        TopAppBar(
            title = {
                Column {
                    Text(vm.title, style = MaterialTheme.typography.titleMedium, maxLines = 1)
                    Text(
                        // the workspace and the harness it runs under, always
                        // visible: the harness is fixed for the conversation
                        listOfNotNull(vm.workspace.ifBlank { "workspace" }, vm.harness).joinToString(" · ") +
                            if (state.lost) " · reconnecting…" else "",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
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
                            text = { Text("Usage") },
                            leadingIcon = { Icon(Icons.Filled.Info, null) },
                            onClick = { menu = false; usageOpen = true },
                        )
                        DropdownMenuItem(
                            text = { Text("Changes") },
                            leadingIcon = { Icon(Icons.Filled.List, null) },
                            onClick = { menu = false; changesOpen = true },
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
        // the ambient status line: model in use, tokens it held, spend so far —
        // the phone's answer to Telegram's pinned status. Silent when there is
        // nothing yet to say.
        statusText(state).takeIf { it.isNotEmpty() }?.let { s ->
            Surface(color = MaterialTheme.colorScheme.surface) {
                Text(
                    s,
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 3.dp),
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                )
            }
        }
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
                MessageRow(rendered[i], onInfo = { infoMsg = it })
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
    if (usageOpen) UsageDialog(vm, onDismiss = { usageOpen = false })
    if (changesOpen) ChangesDialog(vm, onDismiss = { changesOpen = false })
    infoMsg?.let { ResponseInfoDialog(it) { infoMsg = null } }
}

// What a single reply reported: the model, the token breakdown, the context it
// held, and what it cost — the detail the old footer crammed into one grey line.
@Composable
private fun ResponseInfoDialog(message: ChatMessage, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Response") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                message.model?.takeIf { it.isNotBlank() }?.let { StatRow("Model", it.substringAfterLast('/')) }
                message.tokens?.let { tk ->
                    StatRow("Input", fmtTokens(tk.input))
                    StatRow("Output", fmtTokens(tk.output))
                    if (tk.reasoning > 0) StatRow("Thinking", fmtTokens(tk.reasoning))
                    if (tk.cacheRead + tk.cacheWrite > 0) {
                        StatRow("Cache", "${fmtTokens(tk.cacheRead)} read · ${fmtTokens(tk.cacheWrite)} write")
                    }
                    StatRow("Context held", fmtTokens(tk.context))
                }
                message.cost?.let { StatRow("Cost", if (it > 0) fmtMoney(it) else "—") }
            }
        },
        confirmButton = { androidx.compose.material3.TextButton(onClick = onDismiss) { Text("Done") } },
    )
}

// Settings, opened from the top-right menu. Scoped to what a phone can act on
// today: the model this conversation runs on (mirroring Telegram's picker).
// The list is fetched when the panel opens; a tap sets it on the gateway, which
// remembers it for the next prompt.
@Composable
private fun SettingsDialog(vm: ChatViewModel, onDismiss: () -> Unit) {
    val state by vm.state.collectAsState()
    LaunchedEffect(Unit) { vm.loadModels(); vm.loadAgent(); vm.loadSkills(); vm.loadMcp() }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Settings") },
        text = {
            Column(Modifier.heightIn(max = 440.dp).verticalScroll(rememberScrollState())) {
                SectionLabel("HARNESS")
                // fixed for the life of the conversation: a chat cannot move
                // between harnesses, so this is shown, never offered
                SettingRow(
                    listOfNotNull(vm.workspace.ifBlank { null }, vm.harness).joinToString(" · ").ifBlank { "—" },
                    selected = false,
                    subtitle = "fixed for this conversation",
                    onPick = {},
                    checkable = false,
                )
                SectionLabel("MODEL", top = 12.dp)
                ModelDropdown(state.models) { vm.setModel(it) }
                SectionLabel("AGENT", top = 12.dp)
                SettingRow("Default (harness)", selected = state.agent == null, subtitle = null, onPick = { vm.setAgent(null) }, leading = { SettingIcon(Icons.Filled.Star) })
                SettingRow("Build", selected = state.agent == "build", subtitle = "executes tools", onPick = { vm.setAgent("build") }, leading = { SettingIcon(Icons.Filled.Build) })
                SettingRow("Plan", selected = state.agent == "plan", subtitle = "read-only — no edits", onPick = { vm.setAgent("plan") }, leading = { SettingIcon(Icons.Filled.Description) })

                val skills = state.skills
                SectionLabel("SKILLS", top = 14.dp)
                when {
                    skills == null -> LoadingLine()
                    skills.skills.isEmpty() -> EmptyLine("none found for this harness")
                    else -> skills.skills.forEach { s ->
                        ToggleRow(
                            name = s.name,
                            subtitle = s.scope + if (skills.toggleable) "" else " · fixed",
                            checked = !s.disabled,
                            enabled = skills.toggleable,
                            onChange = { vm.setSkill(s.path, !it) },
                        )
                    }
                }

                val mcp = state.mcp
                SectionLabel("MCP SERVERS", top = 14.dp)
                when {
                    mcp == null -> LoadingLine()
                    mcp.isEmpty() -> EmptyLine("none configured in this harness")
                    else -> mcp.forEach { m ->
                        ToggleRow(
                            name = m.name,
                            subtitle = listOf(m.kind, m.detail).filter { it.isNotBlank() }.joinToString(" · "),
                            checked = m.enabled,
                            enabled = true,
                            onChange = { vm.setMcp(m.name, it) },
                        )
                    }
                }
            }
        },
        confirmButton = {
            androidx.compose.material3.TextButton(onClick = onDismiss) { Text("Done") }
        },
    )
}

// The model picker, collapsed to one row: the list was an endless scroll inside
// Settings. Tap to open the choices; a check marks the active one, every row
// carries an icon (an image icon for a vision model), and the context limit
// rides along.
@Composable
private fun ModelDropdown(choices: ModelChoices?, onPick: (String?) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val current = choices?.current
    val label = when {
        choices == null -> "Loading…"
        current != null -> current.substringAfterLast('/')
        choices.default != null -> "Default · ${choices.default.substringAfterLast('/')}"
        else -> "Default (harness)"
    }
    Box {
        Surface(
            Modifier.fillMaxWidth().clickable(enabled = choices != null) { open = true },
            color = MaterialTheme.colorScheme.surfaceContainer,
            shape = RoundedCornerShape(12.dp),
        ) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(label, Modifier.weight(1f), fontSize = 15.sp, color = MaterialTheme.colorScheme.onSurface, maxLines = 1)
                Icon(Icons.Filled.ArrowDropDown, "choose model", tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(
                text = { Text(choices?.default?.let { "Default · ${it.substringAfterLast('/')}" } ?: "Default (harness)") },
                leadingIcon = { SettingIcon(Icons.Filled.Star) },
                trailingIcon = { if (current == null) Icon(Icons.Filled.Check, "selected", Modifier.size(18.dp), tint = MaterialTheme.colorScheme.primary) },
                onClick = { open = false; onPick(null) },
            )
            choices?.all?.forEach { m ->
                DropdownMenuItem(
                    text = { Text(m.modelID + if (m.contextLimit > 0) "  ·  ${fmtTokens(m.contextLimit)}" else "") },
                    // every model gets a mark; a vision model gets the eye-catching
                    // one — a real icon, not an emoji that reads as decoration
                    leadingIcon = {
                        Icon(
                            if (m.image) Icons.Filled.Image else Icons.Filled.SmartToy,
                            if (m.image) "accepts images" else null,
                            Modifier.size(18.dp),
                            tint = if (m.image) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    },
                    trailingIcon = { if (current == m.ref) Icon(Icons.Filled.Check, "selected", Modifier.size(18.dp), tint = MaterialTheme.colorScheme.primary) },
                    onClick = { open = false; onPick(m.ref) },
                )
            }
        }
    }
}

@Composable
private fun SectionLabel(text: String, top: androidx.compose.ui.unit.Dp = 0.dp) {
    Text(
        text,
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(top = top, bottom = 4.dp),
    )
}

@Composable
private fun LoadingLine() {
    Text("Loading…", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 4.dp))
}

@Composable
private fun EmptyLine(text: String) {
    Text(text, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 4.dp))
}

// a skills / MCP row: name and a one-line subtitle, with a switch to flip it
@Composable
private fun ToggleRow(name: String, subtitle: String?, checked: Boolean, enabled: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(name, fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurface, maxLines = 1)
            subtitle?.takeIf { it.isNotBlank() }?.let {
                Text(it, fontSize = 11.sp, fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
            }
        }
        Switch(checked = checked, enabled = enabled, onCheckedChange = onChange)
    }
}

@Composable
private fun SettingIcon(icon: androidx.compose.ui.graphics.vector.ImageVector) {
    Icon(icon, null, Modifier.size(18.dp).padding(end = 0.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun SettingRow(
    label: String,
    selected: Boolean,
    subtitle: String?,
    onPick: () -> Unit,
    checkable: Boolean = true,
    leading: (@Composable () -> Unit)? = null,
) {
    Row(
        Modifier.fillMaxWidth()
            .then(if (checkable) Modifier.clickable(onClick = onPick) else Modifier)
            .padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        leading?.let {
            Box(Modifier.padding(end = 12.dp)) { it() }
        }
        Column(Modifier.weight(1f)) {
            Text(
                label,
                fontSize = 15.sp,
                color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
            )
            subtitle?.takeIf { it.isNotBlank() }?.let {
                Text(it, fontSize = 12.sp, fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (selected && checkable) {
            Icon(Icons.Filled.Check, "selected", Modifier.size(18.dp), tint = MaterialTheme.colorScheme.primary)
        }
    }
}

// what the conversation has spent — the phone's /usage, from the same numbers
// the pinned status sums (tokens and *reported* cost; unpriced ≠ free)
@Composable
private fun UsageDialog(vm: ChatViewModel, onDismiss: () -> Unit) {
    val state by vm.state.collectAsState()
    LaunchedEffect(Unit) { vm.loadUsage() }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Usage") },
        text = {
            val u = state.usage
            if (u == null) {
                Text("Loading…", fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    StatRow("Turns", u.turns.toString())
                    StatRow("Input", fmtTokens(u.input))
                    StatRow("Output", fmtTokens(u.output))
                    StatRow("Thinking", fmtTokens(u.reasoning))
                    StatRow("Cache", "${fmtTokens(u.cacheRead)} read · ${fmtTokens(u.cacheWrite)} write")
                    StatRow("Total tokens", fmtTokens(u.total))
                    StatRow("Spend", if (u.cost > 0) fmtMoney(u.cost) else if (u.unpriced > 0) "unpriced (${u.unpriced})" else "$0")
                    if (u.models.isNotEmpty()) StatRow("Models", u.models.joinToString(", ") { it.substringAfterLast('/') })
                }
            }
        },
        confirmButton = { androidx.compose.material3.TextButton(onClick = onDismiss) { Text("Done") } },
    )
}

@Composable
private fun StatRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, fontSize = 13.sp, fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurface)
    }
}

// the files this conversation changed (adapter.diff via the gateway)
@Composable
private fun ChangesDialog(vm: ChatViewModel, onDismiss: () -> Unit) {
    val state by vm.state.collectAsState()
    LaunchedEffect(Unit) { vm.loadDiff() }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Changes") },
        text = {
            val files = state.diffs
            when {
                files == null -> Text("Loading…", fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                files.isEmpty() -> Text("No file changes in this conversation.", fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                else -> Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
                    files.forEach { f ->
                        Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(f.file.substringAfterLast('/'), Modifier.weight(1f), fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface, maxLines = 1)
                            Text("+${f.additions}", fontSize = 12.sp, color = Color(0xFF4CAF50))
                            Text(" −${f.deletions}", fontSize = 12.sp, color = MaterialTheme.colorScheme.error)
                        }
                    }
                }
            }
        },
        confirmButton = { androidx.compose.material3.TextButton(onClick = onDismiss) { Text("Done") } },
    )
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
private fun MessageRow(message: ChatMessage, onInfo: (ChatMessage) -> Unit) {
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
            Role.ASSISTANT -> AssistantBody(message, onInfo)
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
private fun AssistantBody(message: ChatMessage, onInfo: (ChatMessage) -> Unit) {
    // the per-turn accounting lives behind this quiet "i", not printed under
    // every reply: model, tokens, cost and context on demand
    val hasInfo = message.tokens != null || message.cost != null || message.model != null
    Column(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        message.parts.forEachIndexed { idx, part ->
            val isLast = idx == message.parts.lastIndex
            PartView(part, streaming = isLast && message.time == 0L)
        }
        message.error?.let {
            Text(it, color = MaterialTheme.colorScheme.error, fontSize = 14.sp)
        }
        if (hasInfo) {
            Icon(
                Icons.Filled.Info,
                "response info",
                Modifier.size(16.dp).clickable { onInfo(message) },
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun PartView(part: ChatPart, streaming: Boolean) {
    when (part) {
        is ChatPart.Text -> Markdown(part.text + if (streaming) " ▍" else "")
        is ChatPart.Reasoning -> ReasoningRow(part)
        is ChatPart.Tool -> ToolRow(part)
        is ChatPart.File -> FileRow(part)
        is ChatPart.Unsupported -> Unit
    }
}

// A file the agent produced or touched. Images aren't fetched (no image
// dependency wired) — the row names it so it is at least visible in the turn.
@Composable
private fun FileRow(part: ChatPart.File) {
    Surface(
        Modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.surfaceContainer,
        shape = RoundedCornerShape(10.dp),
    ) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.AttachFile, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Column(Modifier.padding(start = 8.dp)) {
                Text(
                    part.name ?: part.path.substringAfterLast('/'),
                    fontSize = 13.sp,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                )
                part.mimeType?.let {
                    Text(it, fontSize = 11.sp, fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
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
                if (part.durationMs != null) "Thought for ${maxOf(1, part.durationMs / 1000)}s" else "Thought",
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
    // the body — command output, a diff, a file's contents, or the arguments —
    // is what the collapsed row is hiding; a tap reveals it, like Telegram's
    // collapsible tool blocks. A running tool auto-opens so progress is visible.
    // The body is recomputed each composition (a running tool's output fills
    // in), but `open` is remembered by the part's stable id: keying it on the
    // whole part collapsed the row again the moment the part was re-emitted.
    val body = toolBody(part)
    var open by remember(part.id) { mutableStateOf(false) }
    val expanded = open || (running && body != null)
    Surface(
        Modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.surfaceContainer,
        shape = RoundedCornerShape(10.dp),
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .clickable(enabled = body != null) { open = !open }
                .padding(horizontal = 12.dp, vertical = 8.dp),
        ) {
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
                if (body != null) {
                    Icon(
                        if (expanded) Icons.Filled.ArrowDropUp else Icons.Filled.ArrowDropDown,
                        "expand",
                        Modifier.size(16.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            part.title?.let { t ->
                if (part.name.lowercase() in setOf("bash", "run")) {
                    Text(
                        t,
                        fontSize = 12.sp,
                        fontFamily = FontFamily.Monospace,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = if (expanded) 4 else 1,
                    )
                }
            }
            AnimatedVisibility(expanded && body != null) {
                Text(
                    body.orEmpty(),
                    Modifier
                        .fillMaxWidth()
                        .padding(top = 6.dp),
                    fontSize = 12.sp,
                    lineHeight = 17.sp,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

// The most useful single payload of a tool call, in the order a reader wants
// it: what it produced (stdout / diff / file), then what it was told.
private fun toolBody(part: ChatPart.Tool): String? {
    val out = part.output?.takeIf { it.isNotBlank() }
    val input = part.input?.takeIf { it.isNotBlank() && it != "{}" && it != "null" }
    val text = out ?: input ?: return null
    return if (text.length > 4000) text.take(4000) + "\n… (${text.length - 4000} more chars)" else text
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

// model · tokens · spend, from what the client already holds: the newest
// assistant turn's model and token count, and the summed cost of priced turns
// (an unpriced turn shows as "$?" — absent is not free).
private fun statusText(state: ChatViewModel.UiState): String {
    val turns = state.messages.filter { it.role == Role.ASSISTANT }
    val last = turns.lastOrNull { it.tokens != null }
    val out = mutableListOf<String>()
    // the model in use, up here by name rather than under every reply
    val model = last?.model?.substringAfterLast('/')
        ?: state.models?.current?.substringAfterLast('/')
        ?: state.models?.default?.substringAfterLast('/')
    if (!model.isNullOrBlank()) out += model
    // fill: how much of the model's context window the last turn held
    val used = last?.tokens?.context ?: 0
    val limit = state.models?.let { c ->
        val ref = c.current ?: c.default
        c.all.firstOrNull { it.ref == ref }?.contextLimit ?: 0L
    } ?: 0L
    when {
        used > 0 && limit > 0 -> out += "${fmtTokens(used)}/${fmtTokens(limit)}  ${(100.0 * used / limit).roundToInt()}%"
        used > 0 -> out += "${fmtTokens(used)} tok"
    }
    val spend = turns.mapNotNull { it.cost }.sum()
    val unpriced = turns.count { it.cost == null && it.tokens != null }
    if (spend > 0) out += fmtMoney(spend) else if (unpriced > 0) out += "$?"
    return out.joinToString("  ·  ")
}

private fun fmtTokens(n: Long): String = when {
    n >= 1_000_000 -> String.format(java.util.Locale.US, "%.1fM", n / 1_000_000.0)
    n >= 1_000 -> String.format(java.util.Locale.US, "%.1fK", n / 1_000.0)
    else -> n.toString()
}

private fun fmtMoney(usd: Double): String = when {
    usd <= 0 -> ""
    usd < 0.01 -> String.format(java.util.Locale.US, "$%.4f", usd)
    usd < 100 -> String.format(java.util.Locale.US, "$%.2f", usd)
    else -> "$" + usd.roundToLong()
}