package dev.jep.client.presentation.chat

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.BorderStroke
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.ArrowDropUp
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Dns
import androidx.compose.material.icons.filled.Extension
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
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import coil3.compose.AsyncImage
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import androidx.compose.ui.unit.sp
import com.mikepenz.markdown.m3.Markdown
import com.mikepenz.markdown.m3.markdownTypography
import com.mikepenz.markdown.model.rememberMarkdownState
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.roundToInt
import kotlin.math.roundToLong
import java.net.URLEncoder
import dev.jep.client.domain.model.ChatMessage
import dev.jep.client.domain.model.ChatPart
import dev.jep.client.domain.model.Role
import dev.jep.client.domain.model.Ask
import dev.jep.client.domain.model.SessionSummary
import dev.jep.client.domain.model.ToolStatus
import dev.jep.client.domain.repository.ModelChoices

/** the ask card's own "Something else": spends the card without answering the
 *  harness, exactly as saying the answer in chat does */
internal const val SOMETHING_ELSE = "something-else"

/** one row of the transcript: a message, or the ask the harness is blocked on */
internal sealed interface Row {
    val key: String

    data class Msg(val m: ChatMessage) : Row {
        override val key: String get() = m.id
    }

    data class Pending(val ask: Ask) : Row {
        override val key: String get() = "ask-${ask.id}"
    }

    /** several tool-only messages standing in for one line */
    data class Tools(val tools: List<ChatPart.Tool>) : Row {
        override val key: String get() = "tools-${tools.firstOrNull()?.id ?: "run"}"
    }
}

/**
 * The tool calls of a message that carries nothing else, or null when it says
 * something. opencode emits one message per step, so a turn's tool calls arrive
 * as a run of messages that each hold one call and a step marker — which is why
 * grouping inside a message never saw them, and why the run has to be found
 * across messages.
 */
internal fun toolOnlyCalls(m: ChatMessage): List<ChatPart.Tool>? {
    val tools = m.parts.filterIsInstance<ChatPart.Tool>()
    if (tools.isEmpty()) return null
    val onlyToolsOrMarkers = m.parts.all { it is ChatPart.Tool || it is ChatPart.Unsupported }
    return if (onlyToolsOrMarkers) tools else null
}

/** Collapse a run of tool-only messages of the same kind into one row. */
internal fun groupToolRuns(rows: List<Row>): List<Row> {
    val out = ArrayList<Row>(rows.size)
    var run = mutableListOf<Row.Msg>()
    fun flush() {
        // three is where the noise starts; one or two still read as themselves
        if (run.size > 2) {
            out += Row.Tools(run.flatMap { toolOnlyCalls(it.m) ?: emptyList() })
        } else {
            out += run
        }
        run = mutableListOf()
    }
    for (row in rows) {
        val calls = (row as? Row.Msg)?.let { toolOnlyCalls(it.m) }
        when {
            calls == null -> {
                flush()
                out += row
            }
            // only a run of the same tool collapses: an alternation is the order
            // the work happened in
            run.isNotEmpty() && toolOnlyCalls(run[0].m)?.firstOrNull()?.name != calls.firstOrNull()?.name -> {
                flush()
                run.add(row as Row.Msg)
            }
            else -> run.add(row as Row.Msg)
        }
    }
    flush()
    return out
}

/**
 * The transcript with the ask spliced in where it was raised, newest first.
 *
 * Docked above the composer, an ask could never move: it sat at the bottom of
 * the pane for the whole turn, and once you answered in your own words instead
 * of tapping a choice it stayed there, still offering buttons for a question
 * you had already answered. Placed by time, it is part of the conversation —
 * whatever you say next lands below it and carries it up the screen.
 *
 * `askAfter` is the message that was streaming when the ask arrived — the tool
 * call that raised the ask is a part of it, so the card belongs immediately
 * after that message and not above it. Comparing timestamps alone gets this
 * wrong: a message's time is when it started, and the ask happened in the
 * middle of it, so the by-time rule floats the card above the very question it
 * answers. `liveMessageId` is the row still streaming, which carries no usable
 * timestamp; when there is no anchor to follow, the scan steps over it.
 */
internal fun transcriptRows(
    ordered: List<ChatMessage>,
    ask: Ask?,
    askAt: Long,
    liveMessageId: String? = null,
    askAfter: String? = null,
): List<Row> {
    if (ask == null) return ordered.map { Row.Msg(it) }
    val out = ArrayList<Row>(ordered.size + 1)
    var placed = false
    for (m in ordered) {
        // the anchor wins, and the card follows its message: the tool call that
        // raised the ask is a part of that message, so the card comes after it
        if (!placed && askAfter != null && m.id == askAfter) {
            out += Row.Msg(m)
            out += Row.Pending(ask)
            placed = true
            continue
        }
        // otherwise the first message that is neither live nor newer than the
        // ask is the spot: it goes above the card, pushing the ask up as the
        // turn says more below
        if (!placed && m.id != liveMessageId && m.time <= askAt) {
            out += Row.Pending(ask)
            placed = true
        }
        out += Row.Msg(m)
    }
    if (!placed) out += Row.Pending(ask)
    return out
}

/**
 * True once the ask has been answered: a tap, the card's "Something else", or a
 * message sent in place of an answer. The card then stays as a record with its
 * choices spent.
 *
 * What this deliberately does not do is compare message timestamps against the
 * ask's — those come from two different clocks (the phone's, and the harness's
 * on the Mac), so the comparison is only ever accidentally right. What actually
 * happened is recorded when it happens, in `askChoice`.
 */
internal fun askIsSpent(ask: Ask?, askChoice: String?): Boolean = ask != null && askChoice != null

/**
 * Whether the composer will send. A card standing open takes the send button
 * with it: a message typed during an ask used to queue silently behind a turn
 * that was blocked on the very question being asked, which read as the app
 * swallowing what you wrote. Answer the card, or tap "Something else" to say you
 * are answering in words, and sending comes back.
 */
internal fun canSend(ask: Ask?, askChoice: String?): Boolean = ask == null || askIsSpent(ask, askChoice)

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
    terminalEnabled: Boolean = false,
    onOpenSession: (SessionSummary) -> Unit = {},
    subagentCount: Int = 0,
) {
    val state by vm.state.collectAsState()
    // a file tapped in a message: this conversation is the one that can resolve
    // a relative path against its own workspace, so it takes the hand-off
    val tappedFile by OpenedFile.pending.collectAsState()
    LaunchedEffect(tappedFile) {
        tappedFile?.let {
            vm.openFile(it)
            OpenedFile.take(it)
        }
    }

    // The live row and the harness's record are the same message (both carry the
    // raw message id), so one replaces the other in place. Which one to show is
    // decided by how far along it is, not by whether a turn is open: at the
    // instant a turn ends the record can still be a beat behind, and swapping to
    // it rewound the text for a frame — the "deleted and recreated" flicker.
    val rendered = remember(state) {
        val live = liveAsMessage(state.live)
        val served = state.messages
        if (live == null) {
            served
        } else {
            // The live row is authoritative while it exists: it is the same
            // message as the record's, and it can only exist while its turn is
            // still streaming — deltas build it, and the turn-ending events
            // (Quiet/Failed/Aborted) clear it. The old branch compared lengths
            // and handed over to the record whenever `sending` was false — but
            // `sending` only tracks prompts THIS device started, so a turn begun
            // elsewhere (Telegram, another phone) was treated as over and Android
            // reverted to a stale snapshot until that turn ended. Handover now
            // happens exactly when the turn ends (the live row disappears), and
            // history polling keeps the record pacing alongside, so there is
            // nothing to rewind to.
            val twin = served.firstOrNull { it.id == live.id }
            if (twin == null) served + live
            else served.map { if (it.id == live.id) live else it }
        }
    }
    // A turn is one user message and however many assistant messages it takes to
    // answer (opencode emits one per step: the tool call, then the text). Only
    // the message that ENDS a turn carries the info/copy row — otherwise the
    // buttons appear at every intermediate step.
    val busy = state.sending || state.live != null
    val actionIds = remember(rendered, busy) {
        val ids = mutableSetOf<String>()
        rendered.forEachIndexed { idx, m ->
            if (m.role != Role.ASSISTANT) return@forEachIndexed
            val last = idx == rendered.lastIndex
            // ends the turn if a user message follows, or nothing does — and a
            // turn still in flight has no end yet
            if (last) {
                if (!busy) ids += m.id
            } else if (rendered[idx + 1].role == Role.USER) {
                ids += m.id
            }
        }
        ids
    }
    val listState = rememberLazyListState()
    // system back should pop the conversation, not the whole activity; the
    // phone's back gesture currently drops straight to the launcher because
    // nothing here intercepted it.
    BackHandler { onBack() }

    // Newest first, laid out reversed: index 0 is the BOTTOM of the screen.
    // This is how the Compose team and the chat UIs do it — a bottom-up list
    // stays pinned by itself, because new content grows the item at index 0 and
    // nothing above it moves. No scroll calls, no item-height estimates, no
    // "am I near the bottom?" heuristics (which cannot work when one message is
    // taller than the viewport).
    val ordered = remember(rendered) { rendered.asReversed() }
    val ask = state.ask
    val liveMessageId = state.live?.messageId
    val rows = remember(ordered, ask, state.askAt, liveMessageId, state.askAfter) {
        groupToolRuns(transcriptRows(ordered, ask, state.askAt, liveMessageId, state.askAfter))
    }
    val askAnswered = remember(ask, state.askChoice) { askIsSpent(ask, state.askChoice) }
    // An unanswered card is the signal in its own right; the spinner is not. This
    // is "a card is waiting", not "a card was answered" — asking the latter
    // silenced the spinner in every turn that never happened to raise an ask.
    val askPending = ask != null && !askAnswered
    // the newest message, which carries the "still working" mark; the ask can sit
    // between it and the bottom, so this is a lookup rather than an index
    val newestMsgId = remember(rows) { rows.firstOrNull { it is Row.Msg }?.let { (it as Row.Msg).m.id } }
    // At the bottom iff the sentinel below is the first thing on screen. Exact,
    // cheap, and stable while the answer streams.
    val atBottom by remember {
        derivedStateOf {
            listState.firstVisibleItemIndex == 0 && listState.firstVisibleItemScrollOffset <= 2
        }
    }
    // Sending pulls you back to your own message wherever you had scrolled to.
    LaunchedEffect(state.sending) {
        if (state.sending) listState.animateScrollToItem(0)
    }

    // approaching the top of a long conversation pulls the previous page
    LaunchedEffect(listState, state.hasMore, ordered.size) {
        snapshotFlow { listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0 }
            .collect { last ->
                // the top of the screen is the END of a reversed list
                if (state.hasMore && !state.loadingOlder && last >= ordered.size - 1) vm.loadOlder()
            }
    }

    var renameOpen by remember { mutableStateOf(false) }
    var queuedMenuFor by remember { mutableStateOf<ChatViewModel.Queued?>(null) }
    var queuedEditFor by remember { mutableStateOf<ChatViewModel.Queued?>(null) }
    var queuedCancelFor by remember { mutableStateOf<ChatViewModel.Queued?>(null) }
    var deleteOpen by remember { mutableStateOf(false) }
    var forgetOpen by remember { mutableStateOf(false) }
    var settingsOpen by remember { mutableStateOf(false) }
    var usageOpen by remember { mutableStateOf(false) }
    var changesOpen by remember { mutableStateOf(false) }
    var infoMsg by remember { mutableStateOf<ChatMessage?>(null) }
    var replyTo by remember { mutableStateOf<ChatMessage?>(null) }
    var skillsView by remember { mutableStateOf(false) }
    var mcpView by remember { mutableStateOf(false) }
    var termVisible by remember { mutableStateOf(false) }
    var subsOpen by remember { mutableStateOf(false) }

    Box(Modifier.fillMaxSize()) {
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
                        if (terminalEnabled) {
                            DropdownMenuItem(
                                text = { Text("Terminal") },
                                leadingIcon = { Icon(Icons.Filled.Terminal, null) },
                                onClick = { menu = false; termVisible = true },
                            )
                        }
                        DropdownMenuItem(
                            // nothing to open when it spawned none — the row
                            // says so instead of a dialog that would be empty
                            text = { Text(if (subagentCount > 0) "Subagents ($subagentCount)" else "Subagents") },
                            leadingIcon = { Icon(Icons.Filled.AccountTree, null) },
                            enabled = subagentCount > 0,
                            onClick = { menu = false; subsOpen = true },
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
        val scope = rememberCoroutineScope()
        // there is content below the fold: one tap and you are back at the end
        val showJump = !atBottom && rendered.isNotEmpty()
        Box(Modifier.weight(1f)) {
            if (state.messages.isEmpty() && state.loadingHistory) {
                Box(
                    Modifier.fillMaxSize().semantics { contentDescription = "loading conversation" },
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(Modifier.size(30.dp), strokeWidth = 3.dp)
                }
            } else LazyColumn(
                Modifier.fillMaxSize().testTag("chat-list"),
                state = listState,
                // bottom-up: index 0 is the bottom of the screen
                reverseLayout = true,
                contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 10.dp),
            ) {
                // A 1px sentinel at index 0, below the newest message. It is the
                // current scroll position if and only if we are at the very
                // bottom, which is what makes "at the bottom" exact — and new
                // messages slot in above it, so a pinned view stays pinned with
                // no scroll call at all.
                item(key = "bottom-sentinel") { Spacer(Modifier.height(1.dp)) }
                // reaching the top threshold pulls the previous page; say so while
                // it is in flight, or the list just sits there looking stuck
                if (state.loadingOlder) {
                    item(key = "loading-older") {
                        Box(
                            Modifier.fillMaxWidth()
                                .padding(vertical = 12.dp)
                                .semantics { contentDescription = "loading earlier messages" },
                            contentAlignment = Alignment.Center,
                        ) {
                            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                        }
                    }
                }
                // queued messages ride at the end, like the real messages they are
                val queuedDisplay = state.queued.asReversed()
                items(queuedDisplay.size, key = { "queued-${queuedDisplay[it].id}" }) { i ->
                    QueuedBubble(queuedDisplay[i]) { queuedMenuFor = queuedDisplay[i] }
                }
                val busy = state.sending || state.live != null
                items(rows.size, key = { rows[it].key }) { i ->
                    when (val row = rows[i]) {
                        is Row.Tools -> ToolGroupRow(row.tools)
                        is Row.Pending -> AskBar(row.ask, vm, spent = askAnswered, choiceId = state.askChoice)
                        is Row.Msg -> CompositionLocalProvider(LocalFileUrl provides { path -> vm.fileUrl(path) }) {
                            MessageRow(
                                row.m,
                                onInfo = { infoMsg = it },
                                onReply = { replyTo = it },
                                // the newest reply carries the "still working" mark: a
                                // pause between parts (thinking, a tool call) must not
                                // read as finished.
                                // an unanswered card is the signal, in its own
                                // right: a spinner under it would only add noise
                                responding = busy && !askPending &&
                                    row.m.id == newestMsgId && row.m.role == Role.ASSISTANT,
                                showActions = row.m.id in actionIds,
                                onRetrySend = { vm.retrySend(it) },
                            )
                        }
                    }
                }
            }
            if (showJump) {
                FloatingActionButton(
                    onClick = { scope.launch { listState.animateScrollToItem(0) } },
                    modifier = Modifier.align(Alignment.BottomEnd).padding(end = 16.dp, bottom = 12.dp).size(44.dp),
                    containerColor = MaterialTheme.colorScheme.primaryContainer,
                    contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                ) {
                    Icon(Icons.Filled.ArrowDownward, "jump to latest", Modifier.size(22.dp))
                }
            }
        }
        replyTo?.let { ReplyBanner(it) { replyTo = null } }
        Composer(vm, replyTo) { replyTo = null }
    }
    state.openFile?.let { open -> FileSheet(open, onClose = { vm.closeFile() }) }
    if (termVisible) TerminalOverlay(vm, onClose = { termVisible = false })
    if (subsOpen) SubagentsDialog(vm, onOpen = { onOpenSession(it); subsOpen = false }, onDismiss = { subsOpen = false })
    }

    queuedMenuFor?.let { q ->
        AlertDialog(
            onDismissRequest = { queuedMenuFor = null },
            title = { Text("Queued") },
            text = { Text("The agent is busy. This steers in at its next tool call, or send it after this reply ends.") },
            confirmButton = { TextButton(onClick = { queuedMenuFor = null; vm.forceSendQueued(q.id) }) { Text("Send now") } },
            dismissButton = {
                Row {
                    TextButton(onClick = { queuedMenuFor = null; queuedEditFor = q }) { Text("Edit") }
                    TextButton(onClick = { queuedMenuFor = null; queuedCancelFor = q }) { Text("Cancel") }
                }
            },
        )
    }
    queuedEditFor?.let { q ->
        var text by remember(q.id) { mutableStateOf(q.text) }
        AlertDialog(
            onDismissRequest = { queuedEditFor = null },
            title = { Text("Edit queued message") },
            text = { OutlinedTextField(value = text, onValueChange = { text = it }, Modifier.fillMaxWidth()) },
            confirmButton = { TextButton(onClick = { vm.editQueued(q.id, text); queuedEditFor = null }) { Text("Save") } },
            dismissButton = { TextButton(onClick = { queuedEditFor = null }) { Text("Back") } },
        )
    }
    queuedCancelFor?.let { q ->
        AlertDialog(
            onDismissRequest = { queuedCancelFor = null },
            title = { Text("Cancel this message?") },
            text = { Text("It will not be sent.") },
            confirmButton = { TextButton(onClick = { vm.cancelQueued(q.id); queuedCancelFor = null }) { Text("Cancel it") } },
            dismissButton = { TextButton(onClick = { queuedCancelFor = null }) { Text("Keep") } },
        )
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
    if (settingsOpen) SettingsDialog(
        vm,
        onDismiss = { settingsOpen = false },
        onSkills = { settingsOpen = false; skillsView = true },
        onMcp = { settingsOpen = false; mcpView = true },
    )
    if (skillsView) ManageScreen("Skills", onClose = { skillsView = false }) { SkillsBody(vm) }
    if (mcpView) ManageScreen("MCP servers", onClose = { mcpView = false }) { McpBody(vm) }

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
        title = { Text("This reply") },
        text = {
            // this turn's own numbers, not the conversation's running totals:
            // what it generated, what it was shown, and what that cost
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                message.model?.takeIf { it.isNotBlank() }?.let { StatRow("Model", it.substringAfterLast('/')) }
                message.durationMs?.takeIf { it > 0 }?.let { StatRow("Took", fmtDuration(it)) }
                StatRow("Time", fmtClock(message.time))
                message.tokens?.let { tk ->
                    StatRow("Output", fmtTokens(tk.output))
                    if (tk.reasoning > 0) StatRow("Thinking", fmtTokens(tk.reasoning))
                    StatRow("Prompt", fmtTokens(tk.input + tk.cacheRead + tk.cacheWrite))
                    if (tk.cacheRead + tk.cacheWrite > 0) {
                        StatRow("Cache", "${fmtTokens(tk.cacheRead)} read · ${fmtTokens(tk.cacheWrite)} write")
                    }
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
private fun SettingsDialog(
    vm: ChatViewModel,
    onDismiss: () -> Unit,
    onSkills: () -> Unit,
    onMcp: () -> Unit,
) {
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
                state.agents.forEach { a ->
                    SettingRow(a.label, selected = state.agent == a.id, subtitle = a.detail, onPick = { vm.setAgent(a.id) }, leading = { SettingIcon(Icons.Filled.Build) })
                }

                // managing these lives in its own view: the modal stays a summary
                SectionLabel("SKILLS", top = 14.dp)
                SettingRow(
                    "Skills",
                    selected = false,
                    subtitle = state.skills?.let { "${it.skills.size} loaded" } ?: "loading…",
                    onPick = onSkills,
                    leading = { SettingIcon(Icons.Filled.Extension) },
                )
                SectionLabel("MCP SERVERS", top = 14.dp)
                SettingRow(
                    "MCP servers",
                    selected = false,
                    subtitle = state.mcp?.let { if (it.isEmpty()) "none configured" else "${it.size} configured" } ?: "loading…",
                    onPick = onMcp,
                    leading = { SettingIcon(Icons.Filled.Dns) },
                )
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

// A full view for managing one thing, so the settings modal stays a summary.
@Composable
private fun ManageScreen(title: String, onClose: () -> Unit, content: @Composable () -> Unit) {
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxSize()) {
                Row(
                    Modifier.fillMaxWidth().padding(start = 4.dp, top = 6.dp, bottom = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "back") }
                    Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(start = 4.dp))
                }
                content()
            }
        }
    }
}

@Composable
private fun SkillsBody(vm: ChatViewModel) {
    val state by vm.state.collectAsState()
    LaunchedEffect(Unit) { vm.loadSkills() }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 18.dp)) {
        val s = state.skills
        when {
            s == null -> LoadingLine()
            s.skills.isEmpty() -> EmptyLine("none found for this harness")
            else -> s.skills.forEach { sk ->
                ToggleRow(
                    name = sk.name,
                    subtitle = sk.scope + if (s.toggleable) "" else " · fixed",
                    checked = !sk.disabled,
                    enabled = s.toggleable,
                    onChange = { vm.setSkill(sk.path, !it) },
                )
            }
        }
    }
}

@Composable
private fun McpBody(vm: ChatViewModel) {
    val state by vm.state.collectAsState()
    LaunchedEffect(Unit) { vm.loadMcp() }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 18.dp)) {
        val m = state.mcp
        when {
            m == null -> LoadingLine()
            m.isEmpty() -> EmptyLine("none configured in this harness")
            else -> m.forEach { s ->
                ToggleRow(
                    name = s.name,
                    subtitle = listOf(s.kind, s.detail).filter { it.isNotBlank() }.joinToString(" · "),
                    checked = s.enabled,
                    enabled = true,
                    onChange = { vm.setMcp(s.name, it) },
                )
            }
        }
    }
}

// The subagent sessions this conversation spawned: a subagent never lists on
// its own, so this is the way to them — from the conversation that made them.
@Composable
private fun SubagentsDialog(vm: ChatViewModel, onOpen: (SessionSummary) -> Unit, onDismiss: () -> Unit) {
    val state by vm.state.collectAsState()
    LaunchedEffect(Unit) { vm.loadSubagents() }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Subagents") },
        text = {
            val subs = state.subagents
            when {
                subs == null -> LoadingLine()
                subs.isEmpty() -> Text("No subagents — this conversation didn't spawn any.", fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                else -> Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
                    subs.forEach { s ->
                        Column(Modifier.fillMaxWidth().clickable { onOpen(s) }.padding(vertical = 10.dp)) {
                            Text(s.title.ifBlank { s.id }, fontSize = 15.sp, color = MaterialTheme.colorScheme.onSurface, maxLines = 1)
                            Text(
                                s.workspace.substringAfterLast('/'),
                                fontSize = 12.sp,
                                fontFamily = FontFamily.Monospace,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                            )
                        }
                    }
                }
            }
        },
        confirmButton = { androidx.compose.material3.TextButton(onClick = onDismiss) { Text("Done") } },
    )
}

/**
 * The reader's markdown is calmer than the transcript's. A transcript is
 * scanned — the display-sized headings are what you notice from arm's length. A
 * file is read, at reading distance, on a phone, where those headings shout and
 * cost a third of the screen each.
 */
@Composable
private fun readerTypography() = markdownTypography(
    h1 = MaterialTheme.typography.titleLarge,
    h2 = MaterialTheme.typography.titleMedium,
    h3 = MaterialTheme.typography.titleSmall,
    h4 = MaterialTheme.typography.bodyLarge,
    h5 = MaterialTheme.typography.bodyMedium,
    h6 = MaterialTheme.typography.bodyMedium,
    text = MaterialTheme.typography.bodyMedium,
    paragraph = MaterialTheme.typography.bodyMedium.copy(lineHeight = 21.sp),
    code = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
    inlineCode = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
    textLink = TextLinkStyles(
        style = SpanStyle(
            color = MaterialTheme.colorScheme.primary,
            textDecoration = TextDecoration.Underline,
        ),
    ),
)

/** How the reader shows a file. The store is small and pure on purpose — a path
 *  in, an engine and two defaults out — so what the reader does with any file is
 *  testable without a screen, and adding a format is one line here. */
internal enum class FileEngine { Markdown, Code, Text }

private val MARKDOWN_EXT = setOf("md", "markdown", "mdx")
private val DIFF_EXT = setOf("diff", "patch")
private val CODE_EXT = setOf(
    "kt", "kts", "java", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "swift",
    "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "zsh", "bash", "zsh", "sql", "toml", "yaml",
    "yml", "ini", "gradle", "lua", "pl", "r", "scala", "dart", "ex", "exs", "erl", "hs", "clj",
    "vue", "svelte", "css", "scss", "less", "html", "htm", "xml", "json", "csv", "tsv", "lock",
)

internal fun fileEngineFor(path: String): FileEngine {
    val ext = path.substringAfterLast('.', "").lowercase()
    return when (ext) {
        in MARKDOWN_EXT -> FileEngine.Markdown
        in DIFF_EXT, in CODE_EXT -> FileEngine.Code
        // anything unrecognised is prose: readable beats clever, and a file with
        // no extension at all is far more often notes than binary
        else -> FileEngine.Text
    }
}

// A file the user tapped in a message, read in a sheet. The engine comes from
// the store, and the only option is whether a markdown file is shown rendered —
// set it wrong once and the settings affordance is right there.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FileSheet(open: ChatViewModel.OpenFile, onClose: () -> Unit) {
    val engine = remember(open.path) { fileEngineFor(open.path) }
    // one option, and it belongs to markdown: there is nothing to configure
    // about prose or source, and a menu that changes shape as you use it is worse
    // than a menu with one entry. Everything wraps — this is a phone.
    val canRender = engine == FileEngine.Markdown
    var render by remember(open.path) { mutableStateOf(canRender) }
    var options by remember { mutableStateOf(false) }
    val down = rememberScrollState()
    // Retaining the parsed state is what stops Render from blanking the sheet:
    // without it the reader reparses, shows nothing while it does, and a sheet
    // with no content minimizes itself — which is what you saw.
    val rendered = rememberMarkdownState(open.text.orEmpty(), retainState = true)
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onClose, sheetState = sheetState) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    open.path,
                    Modifier.weight(1f),
                    fontSize = 15.sp,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (canRender) Box {
                    IconButton(onClick = { options = true }) {
                        Icon(
                            Icons.Filled.Settings,
                            "reader options",
                            Modifier.size(20.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    DropdownMenu(expanded = options, onDismissRequest = { options = false }) {
                        // the whole row is the target; the switch only shows state
                        DropdownMenuItem(
                            text = { Text("Render") },
                            trailingIcon = { Switch(checked = render, onCheckedChange = null) },
                            onClick = { render = !render },
                        )
                    }
                }
            }
            HorizontalDivider()
            // a floor as well as a ceiling: a sheet sized purely by its content
            // shrinks to nothing the instant the content is momentarily gone
            Box(Modifier.fillMaxWidth().fillMaxHeight(0.62f).heightIn(min = 120.dp)) {
                when {
                    open.loading -> Text(
                        "reading…",
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    open.error != null -> Text(
                        open.error,
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.error,
                    )
                    open.tooBig -> Text(
                        "too large to read here — ${open.text?.length ?: 0} characters",
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    render && engine == FileEngine.Markdown -> Markdown(
                        markdownState = rendered,
                        typography = readerTypography(),
                        modifier = Modifier.verticalScroll(down),
                    )
                    else -> Text(
                        open.text.orEmpty(),
                        Modifier.verticalScroll(down),
                        fontSize = 13.sp,
                        fontFamily = if (engine == FileEngine.Code) FontFamily.Monospace else FontFamily.Default,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                }
            }
        }
    }
}

// The terminal fills this window rather than a Dialog — a Dialog is its own
// window, which the soft keyboard covers without resizing — and pads for the
// IME so the command line stays above the keyboard.
@Composable
private fun TerminalOverlay(vm: ChatViewModel, onClose: () -> Unit) {
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        // statusBarsPadding: the row would sit under the clock otherwise.
        // imePadding: the whole canvas shrinks for the keyboard, and because the
        // terminal body is weighted it gives up its own height — the text stops
        // falling behind the keyboard instead of keeping its size.
        Column(Modifier.fillMaxSize().statusBarsPadding().imePadding()) {
            Row(
                Modifier.fillMaxWidth().padding(start = 4.dp, top = 6.dp, bottom = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "back") }
                Text("Terminal", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(start = 4.dp))
            }
            TerminalBody(vm, Modifier.weight(1f))
        }
    }
}

// The conversation's shell: a tmux session on the machine, so it keeps running
// when this view closes and reattaches when it reopens. Here we show its screen
// and feed it keystrokes.
@Composable
private fun TerminalBody(vm: ChatViewModel, modifier: Modifier = Modifier) {
    val scope = rememberCoroutineScope()
    var frame by remember { mutableStateOf("") }
    val draft = remember { mutableStateOf("") }
    LaunchedEffect(Unit) {
        vm.termOpen()
        while (true) {
            frame = vm.termFrame()
            delay(700)
        }
    }
    val scroll = rememberScrollState()
    // keep the prompt (the last line) in view — the pane is taller than the
    // screen, and the keyboard makes it shorter still, so a frame that opens at
    // the top hides exactly the line you're typing at
    LaunchedEffect(frame, scroll.maxValue) {
        scroll.scrollTo(scroll.maxValue)
    }
    Column(modifier.fillMaxWidth()) {
        Text(
            frame.trimEnd('\n'),
            Modifier.weight(1f).fillMaxWidth()
                .verticalScroll(scroll)
                .background(Color(0xFF0E0E0D))
                .padding(10.dp)
                .semantics { contentDescription = "terminal output" },
            fontFamily = FontFamily.Monospace,
            fontSize = 11.sp,
            lineHeight = 15.sp,
            color = Color(0xFFD8D6CE),
        )
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            listOf("C-c" to "Ctrl-C", "Tab" to "Tab", "Up" to "↑", "Down" to "↓", "Escape" to "Esc", "BSpace" to "⌫")
                .forEach { (key, label) ->
                    OutlinedButton(
                        onClick = { scope.launch { vm.termKey(key) } },
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp, vertical = 2.dp),
                    ) { Text(label, fontSize = 12.sp) }
                }
        }
        Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = draft.value,
                onValueChange = { draft.value = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text("type a command", fontSize = 13.sp) },
                textStyle = androidx.compose.ui.text.TextStyle(fontFamily = FontFamily.Monospace, fontSize = 13.sp),
                maxLines = 3,
            )
            IconButton(onClick = {
                val t = draft.value
                draft.value = ""
                scope.launch {
                    if (t.isNotEmpty()) vm.termInput(t)
                    vm.termKey("Enter")
                }
            }) { Icon(Icons.AutoMirrored.Filled.Send, "send", tint = MaterialTheme.colorScheme.primary) }
        }
    }
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
    // a thinking part with nothing in it yet is not worth a bubble
    val parts = live.parts.values.filterNot { it is ChatPart.Text && it.text.isEmpty() || it is ChatPart.Reasoning && it.text.isEmpty() }
    if (parts.isEmpty()) return null
    return ChatMessage(live.messageId, Role.ASSISTANT, 0, parts)
}

// what the copy button takes: the answer as the user saw it — no thinking, no
// tool calls, no file noise
private fun messageText(message: ChatMessage): String =
    message.parts.filterIsInstance<ChatPart.Text>().joinToString("\n") { it.text }

// what a long-press copies: the whole turn, tool calls and thinking included
private fun fullTurnText(message: ChatMessage): String =
    message.parts.joinToString("\n\n") { p ->
        when (p) {
            is ChatPart.Text -> p.text
            is ChatPart.Reasoning -> "[thinking]\n${p.text}"
            is ChatPart.Tool ->
                buildString {
                    append("[tool: ${p.name}]")
                    p.title?.takeIf { it.isNotBlank() }?.let { append(" $it") }
                    p.output?.takeIf { it.isNotBlank() }?.let { append("\n$it") }
                }
            is ChatPart.File -> "[file] ${p.name ?: p.path}"
            is ChatPart.Unsupported -> ""
        }
    }.trim()

private fun codeBlocks(text: String): List<String> {
    val fence = Regex("(?s)```(?:[\\w.+-]+)?\\n?(.*?)```")
    val inline = Regex("`([^`\\n]+)`")
    return (fence.findAll(text).map { it.groupValues[1] } +
        inline.findAll(text).map { it.groupValues[1] }).toList()
}

@Composable
private fun MessageRow(
    message: ChatMessage,
    onInfo: (ChatMessage) -> Unit,
    onReply: (ChatMessage) -> Unit,
    responding: Boolean = false,
    showActions: Boolean = true,
    onRetrySend: (String) -> Unit = {},
) {
    var menu by remember { mutableStateOf(false) }
    val clipboard = LocalClipboardManager.current
    val fullText = remember(message) { fullTurnText(message) }
    val visibleText = remember(message) { messageText(message) }
    val code = remember(message, visibleText) { codeBlocks(visibleText) }

    SwipeToReply(onReply = { onReply(message) }) {
    Box(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 4.dp)
            .combinedClickable(onClick = {}, onLongClick = { menu = true }),
    ) {
        when (message.role) {
            Role.USER -> UserBubble(message) { onRetrySend(message.id) }
            Role.ASSISTANT -> AssistantBody(message, onInfo, responding, showActions)
            else -> Unit
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
}

// A rightward swipe on a row arms a reply: an affordance fades in behind it and
// the row follows the finger, then springs back (and fires) past the threshold.
@Composable
private fun SwipeToReply(onReply: () -> Unit, content: @Composable () -> Unit) {
    val offset = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    val threshold = 110f
    Box(
        Modifier.fillMaxWidth().pointerInput(Unit) {
            detectHorizontalDragGestures(
                onDragEnd = {
                    val fire = offset.value >= threshold
                    scope.launch { offset.animateTo(0f) }
                    if (fire) onReply()
                },
                onDragCancel = { scope.launch { offset.animateTo(0f) } },
                onHorizontalDrag = { change, drag ->
                    change.consume()
                    scope.launch { offset.snapTo((offset.value + drag).coerceIn(0f, threshold + 30f)) }
                },
            )
        },
    ) {
        if (offset.value > 1f) {
            Icon(
                Icons.AutoMirrored.Filled.Reply,
                "reply",
                Modifier.align(Alignment.CenterStart).padding(start = 10.dp).size(18.dp),
                tint = MaterialTheme.colorScheme.primary.copy(alpha = (offset.value / threshold).coerceIn(0f, 1f)),
            )
        }
        Box(Modifier.offset { IntOffset(offset.value.roundToInt(), 0) }) { content() }
    }
}

// the armed reply sits above the composer until sent or dismissed
@Composable
private fun ReplyBanner(message: ChatMessage, onCancel: () -> Unit) {
    Surface(Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.surfaceContainer) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 7.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.AutoMirrored.Filled.Reply, null, Modifier.size(15.dp), tint = MaterialTheme.colorScheme.primary)
            Text(
                messageText(message).replace("\n", " ").trim().take(90),
                Modifier.weight(1f).padding(start = 8.dp),
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
            )
            Icon(
                Icons.Filled.Close,
                "cancel reply",
                Modifier.size(16.dp).clickable(onClick = onCancel),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun UserBubble(message: ChatMessage, onRetry: () -> Unit = {}) {
    // A send the daemon never took. This is not a waiting state — nothing is
    // queued, the send simply failed — so it is drawn as a problem rather than a
    // clock: the bubble takes the error tone, says so, and sends again on a tap.
    val pending = message.undelivered
    Box(Modifier.fillMaxWidth()) {
        Surface(
            Modifier
                .align(Alignment.CenterEnd)
                .widthIn(max = 320.dp)
                .then(if (pending) Modifier.clickable(onClick = onRetry) else Modifier),
            color = if (pending) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.primaryContainer,
            shape = RoundedCornerShape(18.dp),
        ) {
            Column(Modifier.padding(horizontal = 14.dp, vertical = 9.dp)) {
                // a file must show in the person's own bubble too, or an image
                // sent from another client (Telegram) is invisible here
                message.parts.forEach { part ->
                    when (part) {
                        is ChatPart.Text -> Text(
                            part.text,
                            color = if (pending) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onPrimaryContainer,
                            fontSize = 15.sp,
                        )
                        is ChatPart.File -> if (isImagePart(part)) {
                            ImageThumb(part)
                        } else {
                            Row(Modifier.padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                                Icon(Icons.Filled.AttachFile, null, Modifier.size(16.dp), tint = if (pending) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onPrimaryContainer)
                                Text(
                                    part.name ?: part.path.substringAfterLast('/'),
                                    Modifier.padding(start = 6.dp),
                                    color = if (pending) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onPrimaryContainer,
                                    fontSize = 13.sp,
                                    maxLines = 1,
                                )
                            }
                        }
                        else -> Unit
                    }
                    if (pending) {
                        Row(
                            Modifier.padding(top = 6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(
                                Icons.Filled.ErrorOutline,
                                null,
                                Modifier.size(14.dp),
                                tint = MaterialTheme.colorScheme.onErrorContainer,
                            )
                            Text(
                                "Not sent — tap to retry",
                                Modifier.padding(start = 5.dp),
                                fontSize = 12.sp,
                                color = MaterialTheme.colorScheme.onErrorContainer,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun AssistantBody(
    message: ChatMessage,
    onInfo: (ChatMessage) -> Unit,
    responding: Boolean = false,
    showActions: Boolean = true,
) {
    // the per-turn accounting lives behind a quiet hollow "i", not printed under
    // every reply; a copy button sits beside it for the reply's own text
    val hasInfo = message.tokens != null || message.cost != null || message.model != null
    val clipboard = LocalClipboardManager.current
    val fullText = remember(message) { messageText(message) }
    Column(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        collapseTranscript(message.parts).forEach { row ->
            when (row) {
                is TranscriptRow.Group -> ToolGroupRow(row.tools)
                is TranscriptRow.One -> PartView(row.part, streaming = row.part === message.parts.last())
            }
        }
        // still working: a quiet spinner at the end of the reply, so a pause
        // between parts (thinking, a tool call) never looks like an ending
        if (responding) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(13.dp), strokeWidth = 2.dp)
                Spacer(Modifier.size(8.dp))
                Text("responding…", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        message.error?.let {
            Text(it, color = MaterialTheme.colorScheme.error, fontSize = 14.sp)
        }
        if (showActions) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (hasInfo) {
                    Icon(
                        Icons.Outlined.Info,
                        "response info",
                        Modifier.size(15.dp).clickable { onInfo(message) },
                        tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                    )
                    Spacer(Modifier.size(16.dp))
                }
                Icon(
                    Icons.Outlined.ContentCopy,
                    "copy response",
                    Modifier.size(15.dp).clickable { clipboard.setText(AnnotatedString(fullText)) },
                    tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                )
            }
        }
    }
}

/**
 * Where a link in a message should point.
 *
 * The domain concept is a plain relative markdown link — a file in this
 * conversation's workspace — and that is what other clients implement too. This
 * app needs an address Android can route, because a bare path routes nowhere:
 * taps on relative links did nothing at all. So relative targets are rewritten to
 * an address only this app answers. The scheme appears in neither the stored
 * message nor the daemon, and copying a message still yields the original text.
 */
internal fun linkDestination(raw: String): String? {
    val target = raw.trim()
    if (target.isEmpty()) return null
    // already addressed: http, mailto, jep, or protocol-relative
    if (target.startsWith("//")) return target
    val colon = target.indexOf(':')
    val slash = target.indexOf('/')
    if (colon > 0 && (slash < 0 || colon < slash)) return target
    // an in-document anchor is the renderer's business, not ours
    if (target.startsWith("#")) return null
    val path = target.substringBefore('#').substringBefore('?').removePrefix("./")
    if (path.isEmpty()) return null
    return "jep://file?path=" + URLEncoder.encode(path, "UTF-8")
}

// `[label](target)`, and images `![alt](target)`. Only the destination is
// touched, and only when it is relative, so a quoted title after it survives.
private val LINK_TARGET = Regex("""(!?\[[^\]]*\])\(([^)\s]+)((?:\s+"[^"]*")?)\)""")

internal fun withLocalLinks(markdown: String): String =
    LINK_TARGET.replace(markdown) { m ->
        val dest = linkDestination(m.groupValues[2]) ?: return@replace m.value
        "${m.groupValues[1]}($dest${m.groupValues[3]})"
    }

/**
 * A run of the same tool call, as one line. It opens to the calls it stands for —
 * the work is still all there, it is just not spelled out in full while you are
 * reading around it.
 */
/**
 * A run of the same tool call, as one line — styled exactly like the call rows
 * it stands for, because it is one of them. It opens to those calls, which are
 * themselves ordinary rows, so nothing about the expanded state looks like a
 * different kind of thing.
 */
@Composable
private fun ToolGroupRow(tools: List<ChatPart.Tool>) {
    var open by remember(tools) { mutableStateOf(false) }
    val anyFailed = tools.any { it.status == ToolStatus.ERROR }
    val anyRunning = tools.any { it.status == ToolStatus.RUNNING || it.status == ToolStatus.PENDING }
    val added = tools.sumOf { it.added ?: 0 }
    val removed = tools.sumOf { it.removed ?: 0 }
    val tint = when {
        anyFailed -> MaterialTheme.colorScheme.error
        anyRunning -> MaterialTheme.colorScheme.primary
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().clickable { open = !open },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(toolGroupSummary(tools), style = MaterialTheme.typography.labelMedium, color = tint)
            if (added > 0) {
                Text("+$added", style = MaterialTheme.typography.labelMedium, fontFamily = FontFamily.Monospace, color = LineAdded, modifier = Modifier.padding(start = 6.dp))
            }
            if (removed > 0) {
                Text("-$removed", style = MaterialTheme.typography.labelMedium, fontFamily = FontFamily.Monospace, color = LineRemoved, modifier = Modifier.padding(start = 4.dp))
            }
            Icon(
                if (open) Icons.Filled.ArrowDropUp else Icons.Filled.ArrowDropDown,
                if (open) "hide these calls" else "show these calls",
                Modifier.size(16.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (open) tools.forEach { ToolRow(it) }
    }
}

/**
 * Consecutive tool calls of the same kind collapse into one row.
 *
 * A turn that reads seventeen files, or edits six of them, was seventeen or six
 * identical-looking lines in the transcript — noise that made a turn expensive to
 * read and to review. Grouping is by consecutive runs of the same tool, never
 * across kinds: a read/edit/test alternation is the order the work happened in,
 * and collapsing that would throw away the thing you were reading for.
 */
internal sealed interface TranscriptRow {
    data class One(val part: ChatPart) : TranscriptRow
    data class Group(val tools: List<ChatPart.Tool>) : TranscriptRow
}

internal fun collapseTranscript(parts: List<ChatPart>): List<TranscriptRow> {
    val out = ArrayList<TranscriptRow>(parts.size)
    var run = mutableListOf<ChatPart.Tool>()
    fun flush() {
        // Three is where the noise starts. One or two calls side by side still
        // read as themselves, and wrapping them in a disclosure costs a tap for
        // no gain.
        if (run.size > 2) out += TranscriptRow.Group(run.toList()) else run.forEach { out += TranscriptRow.One(it) }
        run = mutableListOf()
    }
    for (part in parts) {
        val tool = part as? ChatPart.Tool
        if (tool == null) {
            flush()
            out += TranscriptRow.One(part)
        } else if (run.isNotEmpty() && run[0].name != tool.name) {
            flush()
            run.add(tool)
        } else {
            run.add(tool)
        }
    }
    flush()
    return out
}

private val TOOL_VERB = mapOf(
    "read" to "Read", "edit" to "Edited", "write" to "Wrote", "bash" to "Ran",
    "grep" to "Searched", "glob" to "Found", "list" to "Listed", "patch" to "Patched",
)

/** "Read 17 files", "Edited 6 files +128 -94", "Ran 3 commands" */
internal fun toolGroupSummary(tools: List<ChatPart.Tool>): String {
    val kind = tools[0].name.lowercase()
    val verb = TOOL_VERB[kind] ?: kind.replaceFirstChar { it.uppercase() }
    val noun = when (kind) {
        "read", "edit", "write", "patch" -> "files"
        "bash" -> "commands"
        "grep" -> "searches"
        "glob" -> "matches"
        else -> "calls"
    }
    val added = tools.sumOf { it.added ?: 0 }
    val removed = tools.sumOf { it.removed ?: 0 }
    val delta = if (added == 0 && removed == 0) "" else " +$added -$removed"
    return "$verb ${tools.size} $noun$delta"
}

@Composable
private fun PartView(part: ChatPart, streaming: Boolean, onOpenLink: (String) -> Unit = {}) {
    when (part) {
        is ChatPart.Text -> Markdown(
            withLocalLinks(part.text + if (streaming) " ▍" else ""),
            // A link has to look like one before anyone taps it. 0.43 has no
            // colour slot for links anywhere — markdownColor covers text, code,
            // tables and dividers — so the style comes from the typography's
            // textLink, and the app's own accent is what it should be.
            typography = markdownTypography(
                textLink = TextLinkStyles(
                    style = SpanStyle(
                        color = MaterialTheme.colorScheme.primary,
                        textDecoration = TextDecoration.Underline,
                    ),
                ),
            ),
        )
        is ChatPart.Reasoning -> ReasoningRow(part, active = streaming)
        is ChatPart.Tool -> ToolRow(part)
        is ChatPart.File -> FileRow(part)
        is ChatPart.Unsupported -> Unit
    }
}

// How a file part becomes a fetchable URL: the gateway's authenticated /file
// route plus the pairing token, built by the repository. A CompositionLocal so
// the deep part renderers need not thread it through every signature.
private val LocalFileUrl = compositionLocalOf<(String) -> String> { { "" } }

private val IMAGE_EXTS = setOf("png", "jpg", "jpeg", "webp", "gif", "bmp", "heic", "heif", "avif", "svg")

private fun isImagePart(part: ChatPart.File): Boolean {
    val mime = part.mimeType?.lowercase()
    if (mime?.startsWith("image/") == true) return true
    return (part.name ?: part.path).substringAfterLast('.', "").lowercase() in IMAGE_EXTS
}

// An image attachment as a small square thumbnail; tapping it opens the full
// picture. A file this phone has just attached is shown from its own copy, so
// the thumbnail appears the moment you send instead of waiting for the harness
// to ingest the message; everything else comes from the daemon (/file), which is
// what makes an image sent from another client (Telegram) work here too.
@Composable
private fun ImageThumb(part: ChatPart.File) {
    var open by remember { mutableStateOf(false) }
    val url = part.localUri ?: LocalFileUrl.current(part.path)
    AsyncImage(
        model = url,
        contentDescription = part.name ?: "image",
        contentScale = ContentScale.Crop,
        modifier = Modifier
            .padding(top = 4.dp)
            .size(96.dp)
            .clip(RoundedCornerShape(10.dp))
            .clickable(enabled = url.isNotBlank()) { open = true },
    )
    if (open) {
        Dialog(onDismissRequest = { open = false }) {
            AsyncImage(
                model = url,
                contentDescription = part.name ?: "image",
                contentScale = ContentScale.Fit,
                modifier = Modifier.fillMaxWidth().clickable { open = false },
            )
        }
    }
}

// A file the agent produced or touched. An image shows as a tappable thumbnail;
// anything else is named in a card.
@Composable
private fun FileRow(part: ChatPart.File) {
    if (isImagePart(part)) {
        ImageThumb(part)
    } else {
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
}

@Composable
private fun ReasoningRow(part: ChatPart.Reasoning, active: Boolean = false) {
    var open by remember { mutableStateOf(false) }
    // While it is still thinking the seconds must tick, or a frozen "1s" reads
    // as stuck. Driven by an infinite animation rather than a delay loop in the
    // composition: a loop there keeps the screen "busy" forever, which also
    // makes it untestable. One unit per second, so elapsed reads as seconds.
    val transition = rememberInfiniteTransition(label = "thinking")
    val elapsed by transition.animateFloat(
        initialValue = 0f,
        targetValue = 3_600f,
        animationSpec = infiniteRepeatable(tween(3_600_000, easing = LinearEasing)),
        label = "seconds",
    )
    val secs = elapsed.toInt()
    Column(Modifier.fillMaxWidth().combinedClickable(onClick = { open = !open }, onLongClick = {})) {
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                when {
                    // still going: present tense, and counting
                    active -> "thinking · ${maxOf(0, secs)}s"
                    part.durationMs != null -> "Thought for ${maxOf(1, part.durationMs / 1000)}s"
                    else -> "Thought"
                },
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
            Column {
                Text(
                    part.text,
                    fontSize = 14.sp,
                    lineHeight = 20.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodySmall,
                )
                // the thinking section copies itself, here inside the fold
                val clipboard = LocalClipboardManager.current
                Icon(
                    Icons.Outlined.ContentCopy,
                    "copy thinking",
                    Modifier.size(15.dp).clickable { clipboard.setText(AnnotatedString(part.text)) },
                    tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                )
            }
        }
    }
}

// the diff colours: green for what a change added, red for what it took away
private val LineAdded = Color(0xFF4CAF50)
private val LineRemoved = Color(0xFFEF5350)

private val ToolSubjectKeys = listOf("command", "filePath", "file_path", "path", "pattern", "query", "description", "url")

// opencode sometimes hands the whole call input as the title; pull the one field
// a person cares about rather than printing JSON at them.
private fun toolTitle(part: ChatPart.Tool): String? {
    val raw = part.title?.trim().orEmpty()
    if (raw.isEmpty()) return null
    if (!raw.startsWith("{")) return raw
    val obj = runCatching { Json.parseToJsonElement(raw) as? JsonObject }.getOrNull() ?: return null
    for (k in ToolSubjectKeys) {
        (obj[k] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }?.let { return it }
    }
    return null
}

@Composable
private fun ToolRow(part: ChatPart.Tool) {
    val running = part.status == ToolStatus.RUNNING || part.status == ToolStatus.PENDING
    val failed = part.status == ToolStatus.ERROR
    val body = toolBody(part)
    val added = part.added ?: 0
    val removed = part.removed ?: 0
    val diff = part.diff
    val title = toolTitle(part)
    var sheet by remember(part.id) { mutableStateOf(false) }
    val hasDetail = diff != null || body != null
    val keyboard = LocalSoftwareKeyboardController.current
    val focus = LocalFocusManager.current
    // One shape always: a quiet line, then the call's subject. Nothing expands or
    // collapses on its own. A running tool used to auto-open and then shut when it
    // finished, which jittered the whole list; the detail is a sheet now, reusing
    // the shelf the diff already uses.
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().clickable(enabled = hasDetail) {
                if (hasDetail) {
                    // put the keyboard away first, or the sheet opens above it
                    // and then drops to its place (still expanded) when it hides
                    focus.clearFocus(force = true)
                    keyboard?.hide()
                    sheet = true
                }
            },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                when (part.name.lowercase()) {
                    "write", "edit", "multi-edit" -> "Edited " + (title?.substringAfterLast('/') ?: "file")
                    "read" -> "Read " + (title?.substringAfterLast('/') ?: "file")
                    "bash", "run" -> "Ran a command"
                    else -> "Used ${part.name.ifEmpty { "tool" }}"
                },
                style = MaterialTheme.typography.labelMedium,
                color = when {
                    running -> MaterialTheme.colorScheme.primary
                    failed -> MaterialTheme.colorScheme.error
                    else -> MaterialTheme.colorScheme.onSurfaceVariant
                },
            )
            // how big the change was, readable without opening anything
            if (added > 0) {
                Text("+$added", style = MaterialTheme.typography.labelMedium, fontFamily = FontFamily.Monospace, color = LineAdded, modifier = Modifier.padding(start = 6.dp))
            }
            if (removed > 0) {
                Text("-$removed", style = MaterialTheme.typography.labelMedium, fontFamily = FontFamily.Monospace, color = LineRemoved, modifier = Modifier.padding(start = 4.dp))
            }
            if (hasDetail) {
                Icon(Icons.Filled.ArrowDropDown, "open details", Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        // the subject of the call, one line, cleaned of any JSON in the title
        title?.let {
            if (part.name.lowercase() in setOf("bash", "run", "grep", "glob", "search")) {
                Text(
                    it.lineSequence().first(),
                    fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
    if (sheet) {
        if (diff != null) DiffSheet(part.title, diff) { sheet = false }
        else ToolSheet(title ?: part.name, body.orEmpty()) { sheet = false }
    }
}

// The detail of a tool call, in the same shelf as a diff: a sheet, so it never
// grows the row in place.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ToolSheet(title: String, body: String, onDismiss: () -> Unit) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(Modifier.fillMaxWidth().padding(bottom = 20.dp)) {
            Text(
                title,
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            )
            HorizontalDivider(Modifier.padding(top = 8.dp))
            Text(
                body.ifBlank { "(no output)" },
                Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp),
                fontSize = 12.sp,
                lineHeight = 17.sp,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}

// A small, dependency-free highlighter: enough for a diff to read like code —
// comments, strings, numbers, keywords, which is where the eye goes first. Per
// line, so a construct spanning lines just falls back to plain text.
private val CodeKeywords = setOf(
    "def", "class", "return", "if", "elif", "else", "for", "while", "in", "not", "and", "or",
    "import", "from", "as", "with", "try", "except", "finally", "raise", "yield", "lambda",
    "pass", "break", "continue", "global", "assert", "del", "async", "await", "self", "None",
    "True", "False", "function", "const", "let", "var", "export", "default", "new", "this",
    "typeof", "null", "undefined", "true", "false", "public", "private", "static", "void",
    "int", "float", "double", "string", "bool", "struct", "interface", "type", "func",
    "package", "range", "map", "chan", "go", "defer", "match", "impl", "fn", "mut", "pub",
    "use", "mod", "enum", "trait", "val", "fun", "object", "when", "data", "sealed",
    "override", "suspend", "lateinit",
)
private val CodeToken = Regex(
    "([#].*$|//.*$)" +                       // a comment to end of line
        "|('''[\\s\\S]*?'''|\"\"\"[\\s\\S]*?\"\"\"|'[^']*'|\"[^\"]*\"|`[^`]*`)" + // a string
        "|(\\b\\d[\\d_]*(?:\\.\\d+)?\\b)" +  // a number
        "|([A-Za-z_][A-Za-z0-9_]*)",         // an identifier
)
private val CodeKeyword = Color(0xFF7C4DFF)
private val CodeString = Color(0xFFC25E00)
private val CodeNumber = Color(0xFF1976D2)

private fun highlight(line: String, base: Color, comment: Color): AnnotatedString {
    val out = AnnotatedString.Builder()
    var last = 0
    for (m in CodeToken.findAll(line)) {
        if (m.range.first > last) out.append(line.substring(last, m.range.first))
        val text = m.value
        val color = when {
            m.groupValues[1].isNotEmpty() -> comment
            m.groupValues[2].isNotEmpty() -> CodeString
            m.groupValues[3].isNotEmpty() -> CodeNumber
            m.groupValues[4].isNotEmpty() && text in CodeKeywords -> CodeKeyword
            else -> base
        }
        out.pushStyle(SpanStyle(color = color))
        out.append(text)
        out.pop()
        last = m.range.last + 1
    }
    if (last < line.length) out.append(line.substring(last))
    return out.toAnnotatedString()
}

// A file's change, GitHub-style but single column: the path, then the hunk, with
// what came out in red and what went in in green. A bottom sheet, so it starts
// as a peek and pulls up to fullscreen — a diff wants the whole screen.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DiffSheet(path: String?, diff: String, onDismiss: () -> Unit) {
    // Open at the content's own height, clamped to the screen — not at the
    // half-height anchor, which clipped a diff that would have fitted whole.
    // A long one opens fullscreen and scrolls; either way the first position
    // shows as much as there is.
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(Modifier.fillMaxWidth().padding(bottom = 20.dp)) {
            Text(
                path?.substringAfterLast('/') ?: "changes",
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            )
            path?.let {
                Text(
                    it,
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 16.dp),
                )
            }
            HorizontalDivider(Modifier.padding(top = 8.dp))
            val onSurface = MaterialTheme.colorScheme.onSurface
            val faded = MaterialTheme.colorScheme.onSurfaceVariant
            LazyColumn(Modifier.fillMaxWidth()) {
                items(diff.split("\n")) { line ->
                    // the red/green is the line's background, the way a diff reads
                    val added = line.startsWith("+")
                    val removed = line.startsWith("-")
                    val bg = when {
                        added -> LineAdded.copy(alpha = 0.18f)
                        removed -> LineRemoved.copy(alpha = 0.18f)
                        else -> Color.Transparent
                    }
                    Text(
                        highlight(line, onSurface, faded),
                        Modifier
                            .fillMaxWidth()
                            .background(bg)
                            .padding(horizontal = 14.dp, vertical = 1.dp),
                        fontSize = 12.sp,
                        lineHeight = 17.sp,
                        fontFamily = FontFamily.Monospace,
                    )
                }
            }
        }
    }
}

// The most useful single payload of a tool call, in the order a reader wants
// it: what it produced (stdout / diff / file), then what it was told.
private val ShellMetadataTag = Regex("</?shell_metadata>", RegexOption.IGNORE_CASE)

private fun toolBody(part: ChatPart.Tool): String? {
    val out = part.output?.takeIf { it.isNotBlank() }
    val input = part.input?.takeIf { it.isNotBlank() && it != "{}" && it != "null" }
    // opencode wraps its own note about a call in <shell_metadata> tags; strip the
    // tags so the note reads as text and the markup never shows
    val text = (out ?: input ?: return null).replace(ShellMetadataTag, "").replace(Regex("\n{3,}"), "\n\n").trim()
    if (text.isEmpty()) return null
    return if (text.length > 4000) text.take(4000) + "\n… (${text.length - 4000} more chars)" else text
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AskBar(ask: Ask, vm: ChatViewModel, spent: Boolean, choiceId: String?) {
    // The card is the record: it stays where it was raised, rides up the chat as
    // the turn continues below it, and keeps every choice on show — spent, not
    // removed — once it has been answered.
    Card(
        Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 6.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (spent) MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)
            else MaterialTheme.colorScheme.surface,
        ),
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
                    val picked = option.id == choiceId
                    if (picked) {
                        // the one you chose is filled, in the app's own accent: a
                        // spent card that still shows every choice, with this one
                        // unmistakably the answer
                        Button(
                            onClick = {},
                            enabled = false,
                            colors = ButtonDefaults.buttonColors(
                                disabledContainerColor = MaterialTheme.colorScheme.primaryContainer,
                                disabledContentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                            ),
                            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 14.dp, vertical = 4.dp),
                            modifier = Modifier.semantics { contentDescription = "${option.label}, chosen" },
                        ) {
                            Text(option.label, fontSize = 14.sp, maxLines = 1)
                        }
                    } else {
                        OutlinedButton(
                            onClick = { vm.respond(ask.id, option.id) },
                            enabled = !spent,
                            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 14.dp, vertical = 4.dp),
                        ) {
                            Text(option.label, fontSize = 14.sp, maxLines = 1)
                        }
                    }
                }
                // A question asked in the open does not have to be answered with
                // one of the labels I wrote. This spends the card the way saying
                // the answer in chat does, and sends nothing: the ask stands down
                // and the reply comes as a message.
                if (ask.kind == "question") {
                    OutlinedButton(
                        onClick = { vm.spendAsk(ask.id) },
                        enabled = !spent,
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 14.dp, vertical = 4.dp),
                    ) {
                        Text("Something else", fontSize = 14.sp, maxLines = 1)
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun QueuedBubble(q: ChatViewModel.Queued, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.End,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // a queued message looks like a real one — same side, same bubble — only
        // dimmed, with a clock beside it: it is waiting its turn, not broken. A
        // clock face reads at this size; an hourglass was a smudge.
        Icon(
            Icons.Filled.Schedule,
            "queued",
            Modifier.size(20.dp).padding(end = 7.dp),
            tint = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.75f),
        )
        Surface(
            Modifier.widthIn(max = 320.dp).clickable { onClick() },
            color = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.45f),
            shape = RoundedCornerShape(18.dp),
        ) {
            Text(
                q.text,
                Modifier.padding(horizontal = 14.dp, vertical = 9.dp),
                color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.75f),
                fontSize = 15.sp,
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Composer(vm: ChatViewModel, replyTo: ChatMessage?, onCancelReply: () -> Unit) {
    val state by vm.state.collectAsState()
    val draft = remember { mutableStateOf("") }
    var sendMenu by remember { mutableStateOf(false) }
    // Stop shows whenever a turn is active for this conversation — this client's,
    // or one started elsewhere (Telegram, a steer). Safe now that a tap on Send
    // while busy queues instead of stopping.
    val busy = state.sending || state.live != null
    // A card standing open holds the send button. Answering in words is allowed,
    // but it is said out loud by tapping "Something else" first, so a message can
    // never disappear into a queue behind the question that is waiting for you.
    val sendable = canSend(state.ask, state.askChoice)

    val context = LocalContext.current
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            val name = displayName(context, uri) ?: "file"
            val mime = context.contentResolver.getType(uri)
            val bytes = runCatching { context.contentResolver.openInputStream(uri)?.use { it.readBytes() } }.getOrNull()
            if (bytes != null) vm.attach(name, bytes, uri.toString(), mime)
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
                // while the agent works, the send button queues the message and a
                // small stop sits beside it, so you are never forced to stop first
                if (busy) {
                    IconButton(onClick = { vm.stop() }) {
                        Icon(Icons.Filled.Stop, "stop", Modifier.size(22.dp), tint = MaterialTheme.colorScheme.error)
                    }
                }
                Box(
                    Modifier
                        .size(48.dp)
                        .combinedClickable(
                            enabled = sendable,
                            onClick = {
                                // a swipe-armed reply rides along as a quoted block
                                val quote = replyTo?.let { m ->
                                    messageText(m).trim().lineSequence().take(6).joinToString("\n") { "> $it" } + "\n\n"
                                } ?: ""
                                vm.send(quote + draft.value)
                                draft.value = ""
                                onCancelReply()
                            },
                            // hold to choose: steer in now, or wait for the reply to end
                            onLongClick = { if (draft.value.isNotBlank() || state.attachments.isNotEmpty()) sendMenu = true },
                        ),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.AutoMirrored.Filled.Send,
                        "send",
                        Modifier.size(26.dp),
                        tint = when {
                            !sendable -> MaterialTheme.colorScheme.surfaceVariant
                            draft.value.isBlank() && state.attachments.isEmpty() -> MaterialTheme.colorScheme.surfaceVariant
                            else -> MaterialTheme.colorScheme.primary
                        },
                    )
                }
                if (sendMenu) {
                    val quote = replyTo?.let { m ->
                        messageText(m).trim().lineSequence().take(6).joinToString("\n") { "> $it" } + "\n\n"
                    } ?: ""
                    AlertDialog(
                        onDismissRequest = { sendMenu = false },
                        title = { Text("Send how?") },
                        text = { Text("While the agent works, Send steers your message in at the next tool call. You can hold to send it only after this reply ends.") },
                        confirmButton = {
                            TextButton(onClick = {
                                vm.send(quote + draft.value, steer = false)
                                draft.value = ""
                                sendMenu = false
                                onCancelReply()
                            }) { Text("After this reply") }
                        },
                        dismissButton = { TextButton(onClick = { sendMenu = false }) { Text("Back") } },
                    )
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
    // a harness that prices nothing (claude) simply says nothing: "$?" was a
    // stand-in for "unpriced turns exist" and read as a bug
    if (spend > 0) out += fmtMoney(spend)
    return out.joinToString("  ·  ")
}

private fun fmtTokens(n: Long): String = when {
    n >= 1_000_000 -> String.format(java.util.Locale.US, "%.1fM", n / 1_000_000.0)
    n >= 1_000 -> String.format(java.util.Locale.US, "%.1fK", n / 1_000.0)
    else -> n.toString()
}

private fun fmtDuration(ms: Long): String =
    if (ms < 60_000) String.format(java.util.Locale.US, "%.1fs", ms / 1000.0) else "${ms / 60_000}m ${(ms / 1000) % 60}s"

private fun fmtClock(ms: Long): String =
    java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.getDefault()).format(java.util.Date(ms))

private fun fmtMoney(usd: Double): String = when {
    usd <= 0 -> ""
    usd < 0.01 -> String.format(java.util.Locale.US, "$%.4f", usd)
    usd < 100 -> String.format(java.util.Locale.US, "$%.2f", usd)
    else -> "$" + usd.roundToLong()
}