package dev.jep.client.presentation.chat

import android.content.Context
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.viewinterop.AndroidView
import android.webkit.WebViewClient
import android.webkit.WebView
import android.webkit.WebResourceRequest
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.foundation.ScrollState
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
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
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.isImeVisible
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
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.lazy.LazyColumn
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.FastForward
import androidx.compose.material.icons.automirrored.filled.CallMerge
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Compress
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Dns
import androidx.compose.material.icons.filled.Extension
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Source
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
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TextField
import androidx.compose.material3.InputChip
import androidx.compose.material3.FilledIconButton
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.material.icons.filled.OpenInFull
import androidx.compose.material.icons.filled.CloseFullscreen
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.SpanStyle
import dev.jep.client.presentation.theme.JepMono
import dev.jep.client.presentation.theme.LocalSyntaxColors
import dev.jep.client.presentation.theme.Radius
import dev.jep.client.presentation.theme.Spacing
import dev.jep.client.presentation.theme.SyntaxColors
import dev.jep.client.presentation.theme.pill
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
import com.mikepenz.markdown.m3.markdownColor
import com.mikepenz.markdown.m3.markdownTypography
import com.mikepenz.markdown.model.rememberMarkdownState
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.roundToInt
import kotlin.math.roundToLong
import java.net.URLEncoder
import dev.jep.client.domain.model.SendMode
import dev.jep.client.domain.model.ChatMessage
import dev.jep.client.domain.model.ChatPart
import dev.jep.client.domain.model.Role
import dev.jep.client.domain.model.Ask
import dev.jep.client.domain.model.AskEntry
import dev.jep.client.domain.model.AskOption
import dev.jep.client.domain.model.GitCommit
import dev.jep.client.domain.model.GitSnapshot
import dev.jep.client.domain.model.SessionSummary
import dev.jep.client.domain.model.ToolStatus
import dev.jep.client.domain.repository.ModelChoices
import dev.jep.client.presentation.harness.HarnessSettingsSection

/** the ask card's own "Something else": spends the card without answering the
 *  harness, exactly as saying the answer in chat does */
internal const val SOMETHING_ELSE = "something-else"

/** one row of the transcript: a message, or the ask the harness is blocked on */
internal sealed interface Row {
    val key: String

    /** `cards`: asks drawn inside the message, right after the tool call they
     *  hold up (by call id). A live message keeps growing below its calls, so a
     *  card placed under the whole message ended up under everything written
     *  after it, and only fell into place when the turn ended. */
    data class Msg(val m: ChatMessage, val cards: Map<String, List<Row>> = emptyMap()) : Row {
        override val key: String get() = m.id
    }

    data class Pending(val ask: Ask) : Row {
        override val key: String get() = "ask-${ask.id}"
    }

    /** an earlier card, spent: kept in place as the record of what was asked */
    data class PastAsk(val entry: AskEntry) : Row {
        override val key: String get() = "ask-${entry.ask.id}"
    }

    /** several work-only messages (tool calls, thinking) standing in for one
     *  line; `durationMs` is how long they took, when the harness timed them */
    data class Work(val id: String, val parts: List<ChatPart>, val durationMs: Long? = null) : Row {
        override val key: String get() = "work-$id"
    }

    /** the harness folded the conversation; a divider, not a bubble */
    data class Compaction(val m: ChatMessage) : Row {
        override val key: String get() = m.id
    }

    /** opencode told the model to keep going after the fold; the user-turn
     *  anchor a compaction divider settles against, shown as a quiet note */
    data class AutoContinue(val m: ChatMessage) : Row {
        override val key: String get() = m.id
    }
}

/** A compaction marker is its own row; everything else renders as a message. */
internal fun rowFor(m: ChatMessage, cards: Map<String, List<Row>> = emptyMap()): Row = when {
    m.parts.size == 1 && m.parts[0] is ChatPart.Compaction -> Row.Compaction(m)
    m.parts.size == 1 && m.parts[0] is ChatPart.AutoContinue -> Row.AutoContinue(m)
    else -> Row.Msg(m, cards)
}

/**
 * The work of a message that says nothing: its tool calls and thinking, or null
 * when it carries anything a person should read. opencode emits one message per
 * step, so a turn's work arrives as a run of messages that each hold a call or a
 * thought and a step marker — which is why the run has to be found across them.
 */
internal fun workParts(m: ChatMessage): List<ChatPart>? {
    if (m.role != Role.ASSISTANT) return null
    if (!m.parts.all { it is ChatPart.Tool || it is ChatPart.Reasoning || it is ChatPart.Unsupported }) return null
    val work = m.parts.filter { it is ChatPart.Tool || (it is ChatPart.Reasoning && it.text.isNotBlank()) }
    return work.ifEmpty { null }
}

/**
 * Collapse a run of work-only messages into one "Worked for …" row. `hold` is a
 * message that stays itself — the newest one while the turn is still going, so
 * its spinner and live thinking stay in view.
 */
internal fun groupWorkRuns(rows: List<Row>, hold: String? = null): List<Row> {
    val out = ArrayList<Row>(rows.size)
    var run = mutableListOf<Row.Msg>()
    fun flush() {
        if (run.size > 1) {
            // rows are newest first; the work reads in the order it happened
            val oldest = run.asReversed()
            out += Row.Work(oldest[0].m.id, oldest.flatMap { workParts(it.m).orEmpty() }, workSpan(oldest.map { it.m }))
        } else {
            out += run
        }
        run = mutableListOf()
    }
    for (row in rows) {
        // a message carrying a card is never folded away: the card must show
        val msg = (row as? Row.Msg)?.takeIf { it.cards.isEmpty() && it.m.id != hold && workParts(it.m) != null }
        if (msg == null) {
            flush()
            out += row
        } else {
            run.add(msg)
        }
    }
    flush()
    return out
}

/** first start to last finish, or null when the harness gave no times */
internal fun workSpan(messages: List<ChatMessage>): Long? {
    if (messages.isEmpty()) return null
    val start = messages.minOf { it.time }
    val end = messages.maxOf { it.time + (it.durationMs ?: 0) }
    return (end - start).takeIf { start > 0 && it > 0 }
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
 * The card goes directly under the message it belongs to — the one carrying
 * the tool call it holds up (`Ask.callId`), else the message the harness named
 * (`Ask.messageId`), else `askAfter`, the message that was streaming when it
 * arrived. `ordered` is newest first with index 0 at the bottom of the screen,
 * so "under" means the card comes *before* its message here. It used to come
 * after, which put the card above the call it was asking about.
 *
 * With no anchor in view it falls back to time. That compares `askAt` with
 * message times, so `askAt` has to be on the harness's clock (`Ask.at`): the
 * phone's own clock running a fraction behind was enough to float the card
 * above a tool call written milliseconds before the ask. `liveMessageId` is the
 * row still streaming, which carries no usable timestamp; the scan steps over it.
 */
internal fun transcriptRows(
    ordered: List<ChatMessage>,
    ask: Ask?,
    askAt: Long,
    liveMessageId: String? = null,
    askAfter: String? = null,
    past: List<AskEntry> = emptyList(),
): List<Row> {
    // every card goes in by the same rule: the open one, and each spent one on
    // the record (which has no "was streaming" message, only its own anchors)
    class Card(val row: Row, val ask: Ask, val at: Long, val after: String?)
    val cards = buildList {
        past.forEach { add(Card(Row.PastAsk(it), it.ask, it.ask.at ?: 0L, null)) }
        if (ask != null) add(Card(Row.Pending(ask), ask, askAt, askAfter))
    }
    if (cards.isEmpty()) return settleCompaction(ordered.map { rowFor(it) })
    val anchors = cards.map { c ->
        c.ask.callId?.let { call ->
            ordered.firstOrNull { m -> m.parts.any { it is ChatPart.Tool && it.id == call } }
        }
            ?: c.ask.messageId?.let { id -> ordered.firstOrNull { it.id == id } }
            ?: c.after?.let { id -> ordered.firstOrNull { it.id == id } }
    }
    val placed = BooleanArray(cards.size)
    // a card whose call is found inside its message goes in the message, after
    // that call — not under the message, where later parts would pile on top
    val inline = HashMap<String, MutableMap<String, MutableList<Row>>>()
    cards.indices.sortedBy { cards[it].at }.forEach { i ->
        val call = cards[i].ask.callId ?: return@forEach
        val host = anchors[i] ?: return@forEach
        if (host.parts.none { it is ChatPart.Tool && it.id == call }) return@forEach
        inline.getOrPut(host.id) { mutableMapOf() }.getOrPut(call) { mutableListOf() } += cards[i].row
        placed[i] = true
    }
    val out = ArrayList<Row>(ordered.size + cards.size)
    // several cards under one message: newest nearest the bottom, and the list
    // is newest first
    fun drop(pick: (Int) -> Boolean) {
        cards.indices.filter { !placed[it] && pick(it) }.sortedByDescending { cards[it].at }.forEach {
            out += cards[it].row
            placed[it] = true
        }
    }
    for (m in ordered) {
        // a card sits right under its message; nothing newer than the message
        // may claim it first. With no anchor, the first message that is neither
        // live nor newer than the ask is the spot, so the card rides up as the
        // turn says more below it.
        drop { i -> anchors[i]?.let { it === m } ?: (m.id != liveMessageId && m.time <= cards[i].at) }
        out += rowFor(m, inline[m.id].orEmpty())
    }
    drop { true }
    return settleCompaction(out)
}

/**
 * A compaction marker arrives BEFORE the summarize reply that answers it, so a
 * literal placement draws the line above the very response the compaction
 * produced. The marker is the boundary between the folded history and what
 * follows it, so it settles after everything the compaction emitted: it floats
 * past the assistant messages that carry the reply and plants itself right
 * before the next user turn — at the transcript's end when no turn comes. The
 * auto-continue prompt opencode writes after a summarize is that next turn, so
 * it releases the divider there even though it is scaffolding, not words the
 * person typed.
 */
private fun settleCompaction(rows: List<Row>): List<Row> {
    if (rows.none { it is Row.Compaction }) return rows
    // the caller passes rows newest-first; the settle rule is a rule about
    // reading order, so walk it oldest-first and hand back the same order
    val reading = rows.asReversed()
    val out = ArrayList<Row>(rows.size)
    var held: Row.Compaction? = null
    fun isUserTurn(row: Row): Boolean =
        row is Row.AutoContinue || (row as? Row.Msg)?.m?.role == Role.USER
    for (row in reading) {
        if (row is Row.Compaction) {
            held = row
            continue
        }
        if (held != null && isUserTurn(row)) {
            out += held
            held = null
        }
        out += row
    }
    held?.let { out += it }
    return out.asReversed()
}

/** Refine LazyColumn's estimate as it measures toward a distant final item. */
private suspend fun LazyListState.snapToEnd(endIndex: Int, keepFollowing: () -> Boolean) {
    delay(32)
    var settledEndLayouts = 0
    repeat(96) {
        if (!keepFollowing()) return
        if (canScrollForward) {
            settledEndLayouts = 0
            scrollToItem(endIndex)
        } else {
            settledEndLayouts++
            if (settledEndLayouts >= 3) {
                delay(32)
                if (!canScrollForward) return
                settledEndLayouts = 0
            }
        }
        delay(24)
    }
    // A very distant lazy target can keep refining its size estimate for more
    // than the snap passes above. Finish with LazyList's animated target logic
    // rather than declaring success just because one step stopped moving.
    if (canScrollForward && keepFollowing()) {
        animateScrollToItem(endIndex)
    }
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

/**
 * Whether a draft is worth a full-screen editor: once it is four lines tall.
 *
 * Four is not arbitrary. The composer's controls are a column at the field's
 * bottom end, and adding expand makes that column 90dp: a 1-3 line field is
 * shorter than that, so the pills hang out through the top of the field. Four
 * lines is the first draft tall enough to hold the whole cluster inside its
 * own border, which is why expand appears exactly there and not before.
 *
 * Takes a line count, not a draft: characters per line change with the
 * field's width and with the text size the reader picked, so any character
 * count is a guess that a reader with large text loses.
 */
internal fun isWorthExpanding(lines: Int): Boolean = lines >= 4

// The conversation. Reads like the reference: the harness speaks in marked-up
// paragraphs, tool calls collapse to one quiet row each, the person answers
// from a rounded composer that pins itself to the keyboard. Long-press any
// message to copy it; the top bar owns the chat itself.
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun ChatScreen(
    vm: ChatViewModel,
    onBack: () -> Unit,
    onNew: () -> Unit,
    @Suppress("UNUSED_PARAMETER") onForgetPairing: () -> Unit = {},
    terminalEnabled: Boolean = false,
    onOpenSession: (SessionSummary) -> Unit = {},
    subagentCount: Int = 0,
) {
    val state by vm.state.collectAsState()
    var retainedStatus by remember(vm.sessionId) { mutableStateOf(StatusSummary()) }
    val currentStatus = remember(state.messages, state.models, state.usage) { statusSummary(state) }
    val visibleStatus = retainStatus(retainedStatus, currentStatus)
    SideEffect {
        if (retainedStatus != visibleStatus) retainedStatus = visibleStatus
    }
    // a file tapped in a message: this conversation is the one that can resolve
    // a relative path against its own workspace, so it takes the hand-off
    // a file:// link names a file on the machine running the agent, never on
    // this phone, so it opens in the reader through the gateway like any path
    val systemUris = LocalUriHandler.current
    val uriHandler = remember(systemUris) {
        object : UriHandler {
            override fun openUri(uri: String) {
                val path = localFilePath(uri)
                if (path != null) vm.openFile(path) else systemUris.openUri(uri)
            }
        }
    }
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
        // a record entry can carry nothing renderable — opencode marks a
        // compaction with a synthetic user message whose only part silences to
        // null in the mapper. Rendering it shows an empty bubble the user can't
        // decode; the compact action already announces itself.
        val served = renderableMessages(state.messages)
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

    // The transcript model is newest first; the LazyColumn below displays it
    // oldest first so message content unfolds in the normal reading direction.
    val ordered = remember(rendered) { rendered.asReversed() }
    val ask = state.ask
    val liveMessageId = state.live?.messageId
    val rows = remember(ordered, ask, state.askAt, liveMessageId, state.askAfter, state.pastAsks, state.sending) {
        val raw = transcriptRows(ordered, ask, state.askAt, liveMessageId, state.askAfter, state.pastAsks)
        val hold = if (state.sending || state.live != null) raw.firstOrNull { it is Row.Msg }?.key else null
        groupWorkRuns(raw, hold)
    }
    val displayRows = remember(rows) { rows.asReversed() }
    val askAnswered = remember(ask, state.askChoice) { askIsSpent(ask, state.askChoice) }
    // An unanswered card is the signal in its own right; the spinner is not. This
    // is "a card is waiting", not "a card was answered" — asking the latter
    // silenced the spinner in every turn that never happened to raise an ask.
    val askPending = ask != null && !askAnswered
    // Whether the open card is on screen. A card above the fold is what made a
    // parked turn look hung: no spinner, Send withheld, and nothing in view to
    // say why. When it is out of sight, the composer says so and jumps to it.
    // the row that holds the open card: its own, or the message it sits inside
    val askHost = remember(displayRows) {
        displayRows.indexOfFirst { r ->
            r is Row.Pending || (r is Row.Msg && r.cards.values.any { cs -> cs.any { it is Row.Pending } })
        }
    }
    val askKey = if (ask != null && askHost >= 0) displayRows[askHost].key else null
    val askInView by remember(askKey) {
        derivedStateOf { askKey != null && listState.layoutInfo.visibleItemsInfo.any { it.key == askKey } }
    }
    // the newest message, which carries the "still working" mark; the ask can sit
    // between it and the bottom, so this is a lookup rather than an index
    val newestMsgId = remember(rows) { rows.firstOrNull { it is Row.Msg }?.let { (it as Row.Msg).m.id } }
    val queuedDisplay = state.queued
    val endIndex = displayRows.size + queuedDisplay.size + if (state.loadingOlder) 1 else 0
    var atEnd by remember { mutableStateOf(false) }
    var landed by remember { mutableStateOf(false) }
    var followLatest by remember { mutableStateOf(true) }
    var jumpVisible by remember { mutableStateOf(false) }
    var scrollActivity by remember { mutableStateOf(0) }

    // Remember whether the reader chose to leave the end. New messages and
    // streaming deltas change the scroll range; that alone must not clear the
    // reader's previous choice to follow the latest reply.
    LaunchedEffect(listState) {
        snapshotFlow { listState.canScrollForward }
            .collect { canScrollForward ->
                if (canScrollForward) {
                    atEnd = false
                } else {
                    delay(48)
                    if (!listState.canScrollForward) {
                        atEnd = true
                        if (landed) followLatest = true
                    }
                }
            }
    }
    LaunchedEffect(listState) {
        listState.interactionSource.interactions.collect { interaction ->
            when (interaction) {
                is DragInteraction.Start -> followLatest = false
                is DragInteraction.Stop,
                is DragInteraction.Cancel -> if (atEnd) followLatest = true
            }
        }
    }
    LaunchedEffect(listState, endIndex) {
        var previousPosition: Pair<Int, Int>? = null
        snapshotFlow {
            Triple(
                listState.firstVisibleItemIndex to listState.firstVisibleItemScrollOffset,
                listState.isScrollInProgress,
                atEnd,
            )
        }.collect { (position, scrolling, atEndNow) ->
            if (!landed) {
                previousPosition = position
                return@collect
            }
            if (atEndNow) jumpVisible = false
            // The button answers a reader who left the end, not content that
            // arrived: a streamed node reads as "not at the bottom" for a frame
            // before pinning ("stickiness") catches up, and the pin itself is a
            // programmatic scroll. Both move the position and set
            // isScrollInProgress, and reacting to them flashed the button on
            // every delta for a reader who never scrolled. `followLatest` is
            // false only once the reader actually dragged away.
            else if (!followLatest && (scrolling || (previousPosition != null && position != previousPosition))) {
                jumpVisible = true
                scrollActivity++
            }
            previousPosition = position
        }
    }
    LaunchedEffect(scrollActivity, jumpVisible, atEnd) {
        if (jumpVisible && !atEnd) {
            delay(2_500)
            jumpVisible = false
        }
    }

    // Open at the latest message once history has arrived; follow subsequent
    // content changes only if the reader was already at the end.
    LaunchedEffect(state.loadingHistory) {
        if (state.loadingHistory || landed) return@LaunchedEffect
        snapshotFlow { listState.layoutInfo.totalItemsCount }
            .first { it >= endIndex + 1 }
        listState.snapToEnd(endIndex) { followLatest }
        landed = true
        followLatest = true
    }
    LaunchedEffect(displayRows, queuedDisplay, state.loadingOlder, endIndex) {
        if (state.loadingHistory || !landed || !followLatest) return@LaunchedEffect
        snapshotFlow { listState.layoutInfo.totalItemsCount }
            .first { it >= endIndex + 1 }
        listState.snapToEnd(endIndex) { followLatest }
    }

    // Sending is an explicit request to return to the newest part of the chat.
    LaunchedEffect(state.sending) {
        if (state.sending) {
            followLatest = true
            listState.animateScrollToItem(endIndex)
            listState.snapToEnd(endIndex) { followLatest }
        }
    }

    // The keyboard takes half the screen without moving the words. The window
    // changes size, the list's viewport shrinks, and a reader sitting on the
    // newest reply watches it slide below the fold — a resize is not a scroll,
    // so nothing re-pins it. A reader who was following gets the end again; a
    // reader who scrolled away keeps their place, which is what followLatest
    // already records, and is why "the text doesn't move" is only right then.
    val imeVisible = WindowInsets.isImeVisible
    LaunchedEffect(imeVisible) {
        if (!landed || !followLatest) return@LaunchedEffect
        // let the window take the keyboard's size before chasing the end
        delay(80)
        if (followLatest) listState.snapToEnd(endIndex) { followLatest }
    }

    // Older pages are at the top of a forward list, behind a pull: reaching
    // the top used to load them on its own, so a scroll that only meant to
    // read the first message kept yanking in more. Now you ask, the way a
    // swipe archives a conversation: past the threshold and let go.
    val pullAvailable = landed && state.hasMore && !state.loadingOlder
    val olderPull = rememberOlderPull(pullAvailable) { vm.loadOlder() }

    var renameOpen by remember { mutableStateOf(false) }
    var queuedMenuFor by remember { mutableStateOf<ChatViewModel.Queued?>(null) }
    val keyboard = LocalSoftwareKeyboardController.current
    val focus = LocalFocusManager.current
    var queuedEditFor by remember { mutableStateOf<ChatViewModel.Queued?>(null) }
    var queuedCancelFor by remember { mutableStateOf<ChatViewModel.Queued?>(null) }
    var deleteOpen by remember { mutableStateOf(false) }
    var settingsOpen by remember { mutableStateOf(false) }
    var usageOpen by remember { mutableStateOf(false) }
    var gitOpen by remember { mutableStateOf(false) }
    var infoMsg by remember { mutableStateOf<ChatMessage?>(null) }
    var replyTo by remember { mutableStateOf<ChatMessage?>(null) }
    var skillsView by remember { mutableStateOf(false) }
    var mcpView by remember { mutableStateOf(false) }
    var termVisible by remember { mutableStateOf(false) }
    var subsOpen by remember { mutableStateOf(false) }

    Box(Modifier.fillMaxSize()) {
    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
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
                            text = { Text("Git") },
                            leadingIcon = { Icon(Icons.Filled.Source, null) },
                            onClick = { menu = false; gitOpen = true },
                        )
                        if (terminalEnabled) {
                            DropdownMenuItem(
                                text = { Text("Terminal") },
                                leadingIcon = { Icon(Icons.Filled.Terminal, null) },
                                onClick = { menu = false; termVisible = true },
                            )
                        }
                        // Offered where the harness can do it, as the gateway
                        // says (opencode and Claude today), never by name: the
                        // menu stays honest instead of failing at a tap.
                        if (state.harnessSettings.canCompact) {
                            DropdownMenuItem(
                                text = { Text(if (state.compacting) "Compacting…" else "Compact") },
                                leadingIcon = { Icon(Icons.Filled.Compress, null) },
                                enabled = !state.compacting && !busy,
                                onClick = { menu = false; vm.compact() },
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
                    }
                }
            },
        )
        // the ambient status line: model in use, tokens it held, spend so far —
        // the phone's answer to Telegram's pinned status. Silent when there is
        // nothing yet to say.
        statusText(visibleStatus).takeIf { it.isNotEmpty() }?.let { s ->
            Surface(color = MaterialTheme.colorScheme.surface) {
                Text(
                    s,
                    Modifier.fillMaxWidth().padding(horizontal = Spacing.gutter, vertical = 3.dp),
                    fontSize = 11.sp,
                    fontFamily = JepMono,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                )
            }
        }
        AnimatedVisibility(state.failure != null || state.notice != null) {
            Surface(color = MaterialTheme.colorScheme.surfaceVariant) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    // dismissible, not on a timer: an explanation you came for
                    // (a refusal's reason, a failed send) must survive reading
                    Text(
                        state.failure ?: state.notice.orEmpty(),
                        Modifier.weight(1f).padding(start = 16.dp, top = 8.dp, bottom = 8.dp),
                        color = if (state.failure != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                        fontSize = 13.sp,
                    )
                    IconButton(
                        onClick = vm::dismissBanner,
                        modifier = Modifier.padding(end = 6.dp).size(24.dp),
                    ) {
                        Icon(Icons.Filled.Close, "dismiss", Modifier.size(14.dp))
                    }
                }
            }
        }
        val scope = rememberCoroutineScope()
        // there is content below the fold: one tap and you are back at the end
        val showJump = jumpVisible && landed && !atEnd && rendered.isNotEmpty()
        Box(Modifier.weight(1f).nestedScroll(olderPull.connection)) {
            OlderPullIndicator(olderPull, Modifier.align(Alignment.TopCenter))
            if (state.messages.isEmpty() && state.loadingHistory) {
                Box(
                    Modifier.fillMaxSize().semantics { contentDescription = "loading conversation" },
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(Modifier.size(30.dp), strokeWidth = 3.dp)
                }
            } else LazyColumn(
                Modifier
                    .fillMaxSize()
                    .offset { androidx.compose.ui.unit.IntOffset(0, olderPull.offset.roundToInt()) }
                    .testTag("chat-list"),
                state = listState,
                contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 10.dp),
            ) {
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
                val busy = state.sending || state.live != null
                items(displayRows.size, key = { displayRows[it].key }) { i ->
                    when (val row = displayRows[i]) {
                        is Row.Work -> WorkRow(row.parts, row.durationMs)
                        is Row.Pending -> AskBar(row.ask, vm, spent = askAnswered, choiceId = state.askChoice)
                        is Row.PastAsk -> AskBar(row.entry.ask, vm, spent = true, choiceId = row.entry.choice)
                        is Row.Compaction -> CompactionRow(row.m)
                        is Row.AutoContinue -> AutoContinueRow(row.m)
                        is Row.Msg -> CompositionLocalProvider(
                            LocalFileUrl provides { path -> vm.fileUrl(path) },
                            LocalUriHandler provides uriHandler,
                        ) {
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
                                cards = row.cards,
                                cardView = { card ->
                                    when (card) {
                                        is Row.Pending -> AskBar(card.ask, vm, spent = askAnswered, choiceId = state.askChoice)
                                        is Row.PastAsk -> AskBar(card.entry.ask, vm, spent = true, choiceId = card.entry.choice)
                                        else -> Unit
                                    }
                                },
                            )
                        }
                    }
                }
                // sent, and the harness has not written a word back yet
                if (busy && !askPending && rows.firstOrNull { it is Row.Msg }?.let { (it as Row.Msg).m.role } != Role.ASSISTANT) {
                    item(key = "awaiting-reply") {
                        // a row of its own, so it takes the inset a message row
                        // gets from MessageRow; bare, it sat against the edge
                        Box(Modifier.padding(horizontal = RowInset, vertical = RowVInset).testTag("awaiting-reply")) {
                            RespondingMark()
                        }
                    }
                }
                // Keep the visible queue in send order, after the newest message.
                items(queuedDisplay.size, key = { "queued-${queuedDisplay[it].id}" }) { i ->
                    QueuedBubble(queuedDisplay[i]) {
                        // Let go of the composer first. A dialog hands focus back
                        // to whatever held it when it closes, so "Send now" raised
                        // the keyboard over a composer nobody was typing in.
                        focus.clearFocus(force = true)
                        keyboard?.hide()
                        queuedMenuFor = queuedDisplay[i]
                    }
                }
                // The last item gives end-of-conversation a stable scroll target.
                item(key = "end-sentinel") { Spacer(Modifier.height(1.dp)) }
            }
            Column(
                Modifier.align(Alignment.BottomEnd).padding(end = 16.dp, bottom = 12.dp).size(44.dp),
                horizontalAlignment = Alignment.End,
                verticalArrangement = Arrangement.Bottom,
            ) {
                AnimatedVisibility(
                    visible = showJump,
                    modifier = Modifier.align(Alignment.End),
                    enter = fadeIn(tween(170)) + scaleIn(initialScale = 0.82f, animationSpec = tween(170)),
                    exit = fadeOut(tween(260)) + scaleOut(targetScale = 0.9f, animationSpec = tween(260)),
                ) {
                    FloatingActionButton(
                        onClick = {
                            scope.launch {
                                followLatest = true
                                listState.animateScrollToItem(endIndex)
                                listState.snapToEnd(endIndex) { followLatest }
                            }
                        },
                        modifier = Modifier.fillMaxSize(),
                        containerColor = MaterialTheme.colorScheme.primaryContainer,
                        contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                    ) {
                        Icon(Icons.Filled.ArrowDownward, "jump to latest", Modifier.size(22.dp))
                    }
                }
            }
            if (!landed && rendered.isNotEmpty()) {
                Box(
                    Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).testTag("positioning-overlay"),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                }
            }
        }
        replyTo?.let { ReplyBanner(it) { replyTo = null } }
        if (askPending && !askInView) {
            WaitingForYou(ask?.kind == "question") {
                val at = askHost
                if (at >= 0) scope.launch {
                    followLatest = false
                    listState.animateScrollToItem(at + if (state.loadingOlder) 1 else 0)
                }
            }
        }
        // compaction outlives the menu that started it: a tap closes the
        // dropdown, so the "Compacting…" label there would never be seen.
        // It sits just above the composer, where your eyes already are: a
        // banner up by the title bar went unnoticed.
        AnimatedVisibility(state.compacting) {
            Surface(color = MaterialTheme.colorScheme.surfaceVariant) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                    Text(
                        "Compacting…",
                        Modifier.padding(start = 10.dp),
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
        Composer(vm, replyTo) { replyTo = null }
    }
    state.openFile?.let { open ->
        if (open.url != null) ImageViewer(open.url, open.path) { vm.closeFile() }
        else FileSheet(open, onClose = { vm.closeFile() })
    }
    if (termVisible) TerminalOverlay(vm, onClose = { termVisible = false })
    if (subsOpen) SubagentsDialog(vm, onOpen = { onOpenSession(it); subsOpen = false }, onDismiss = { subsOpen = false })
    }

    queuedMenuFor?.let { q ->
        AlertDialog(
            onDismissRequest = { queuedMenuFor = null },
            title = { Text("Queued") },
            text = { Text(queuedExplainer(q.mode)) },
            confirmButton = {
                if (q.mode != SendMode.NOW) {
                    TextButton(onClick = { queuedMenuFor = null; vm.forceSendQueued(q.id) }) { Text("Send now") }
                }
            },
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
    if (settingsOpen) SettingsSheet(
        vm,
        onDismiss = { settingsOpen = false },
        onSkills = { settingsOpen = false; skillsView = true },
        onMcp = { settingsOpen = false; mcpView = true },
    )
    if (skillsView) ManageScreen("Skills", onClose = { skillsView = false }) { SkillsBody(vm) }
    if (mcpView) ManageScreen("MCP servers", onClose = { mcpView = false }) { McpBody(vm) }

    if (usageOpen) UsageDialog(vm, onDismiss = { usageOpen = false })
    if (gitOpen) GitSheet(vm, onDismiss = { gitOpen = false })
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

// Settings, opened from the top-right menu. A sheet rather than a dialog: it
// grew past what an AlertDialog can hold — a dialog capped the body at 440dp
// and scrolled the whole lot inside a box the size of a postcard, and the
// harness options below needed room to explain themselves. Sheets are already
// how this screen shows its other deep panels (Git, the diff shelf).
@Composable
@OptIn(ExperimentalMaterial3Api::class)
private fun SettingsSheet(
    vm: ChatViewModel,
    onDismiss: () -> Unit,
    onSkills: () -> Unit,
    onMcp: () -> Unit,
) {
    val state by vm.state.collectAsState()
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    LaunchedEffect(Unit) { vm.loadModels(); vm.loadAgent(); vm.loadSkills(); vm.loadMcp(); vm.loadHarnessSettings() }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(
            Modifier.fillMaxWidth().heightIn(max = 720.dp).padding(horizontal = 18.dp).padding(bottom = 24.dp),
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("Settings", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                IconButton(onClick = onDismiss) { Icon(Icons.Filled.Close, "close settings") }
            }
            HorizontalDivider()
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {
                // Only what can be changed. Which workspace and harness the chat
                // runs in is fixed, and the header under the title already says
                // it; a row here that did nothing when tapped was noise.
                SectionLabel("MODEL")
                ModelDropdown(state.models) { vm.setModel(it) }
                SectionLabel("AGENT", top = 12.dp)
                SettingRow("Default", selected = state.agent == null, subtitle = null, onPick = { vm.setAgent(null) }, leading = { SettingIcon(Icons.Filled.Star) })
                state.agents.forEach { a ->
                    SettingRow(a.label, selected = state.agent == a.id, subtitle = a.detail, onPick = { vm.setAgent(a.id) }, leading = { SettingIcon(Icons.Filled.Build) })
                }

                // managing these lives in its own view: the sheet stays a summary
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

                // Last, and the only destructive thing here: whatever this
                // conversation's harness declares. The adapter owns the ids and
                // the wording — the phone renders whatever comes back and knows
                // none of it, so a harness gaining a control needs no app change.
                HarnessSettingsSection(
                    options = state.harnessSettings.options,
                    values = state.harnessSettings.values,
                    onChange = { id: String, enabled: Boolean -> vm.setHarnessSetting(id, enabled) },
                    title = "${vm.harness?.ifBlank { null }?.uppercase() ?: "HARNESS"} OPTIONS",
                )
                if (state.harnessSettingsLoading) {
                    Text("Loading options…", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
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
        else -> "Default"
    }
    Box {
        Surface(
            Modifier.fillMaxWidth().clickable(enabled = choices != null) { open = true },
            color = MaterialTheme.colorScheme.surfaceContainer,
            shape = RoundedCornerShape(Radius.card),
        ) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // a model id can be far longer than the row. maxLines alone would
                // clip it mid-glyph, which reads as breakage; ellipsis reads as
                // "there is more", and the full id is one tap away in the list.
                Text(
                    label,
                    Modifier.weight(1f),
                    fontSize = 15.sp,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
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
                                fontFamily = JepMono,
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
    code = MaterialTheme.typography.bodySmall.copy(fontFamily = JepMono),
    inlineCode = MaterialTheme.typography.bodySmall.copy(fontFamily = JepMono),
    textLink = TextLinkStyles(
        style = SpanStyle(
            color = MaterialTheme.colorScheme.primary,
            textDecoration = TextDecoration.Underline,
        ),
    ),
)

/**
 * The transcript's own inset.
 *
 * A message row's chrome — this padding and the long-press menu around it — is
 * applied by MessageRow, so anything rendered as a row in its own right (a
 * collapsed tool run, an ask card) has to carry the same inset itself. Two
 * copies of this number is how a group row ended up flush left beside inset rows
 * and read as misaligned, so there is one.
 */
private val RowInset = Spacing.row
private val RowVInset = 3.dp

/** How the reader shows a file. The store is small and pure on purpose — a path
 *  in, an engine and two defaults out — so what the reader does with any file is
 *  testable without a screen, and adding a format is one line here. */
internal enum class FileEngine { Markdown, Html, Image, Code, Text }

private val MARKDOWN_EXT = setOf("md", "markdown", "mdx")
private val HTML_EXT = setOf("html", "htm")
private val DIFF_EXT = setOf("diff", "patch")
private val CODE_EXT = setOf(
    "kt", "kts", "java", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "swift",
    "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "zsh", "bash", "zsh", "sql", "toml", "yaml",
    "yml", "ini", "gradle", "lua", "pl", "r", "scala", "dart", "ex", "exs", "erl", "hs", "clj",
    "vue", "svelte", "css", "scss", "less", "xml", "json", "csv", "tsv", "lock",
)

internal fun fileEngineFor(path: String): FileEngine {
    val ext = path.substringAfterLast('.', "").lowercase()
    return when (ext) {
        in MARKDOWN_EXT -> FileEngine.Markdown
        in HTML_EXT -> FileEngine.Html
        in IMAGE_EXTS -> FileEngine.Image
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
    val canRender = engine == FileEngine.Markdown || engine == FileEngine.Html
    var render by remember(open.path) { mutableStateOf(canRender) }
    var options by remember { mutableStateOf(false) }
    val down = rememberScrollState()
    // Retaining the parsed state is what stops Render from blanking the sheet:
    // without it the reader reparses, shows nothing while it does, and a sheet
    // with no content minimizes itself — which is what you saw.
    val rendered = rememberMarkdownState(open.text.orEmpty(), retainState = true)
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    // a WebView can't hand drags to the sheet, so the sheet would take them all
    // and the page would never scroll; it still closes from the scrim or back
    ModalBottomSheet(
        onDismissRequest = onClose,
        sheetState = sheetState,
        sheetGesturesEnabled = !(render && engine == FileEngine.Html),
    ) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    open.path,
                    Modifier.weight(1f),
                    fontSize = 15.sp,
                    fontFamily = JepMono,
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
                    render && engine == FileEngine.Html -> HtmlView(open.text.orEmpty())
                    render && engine == FileEngine.Markdown -> Markdown(
                        markdownState = rendered,
                        typography = readerTypography(),
                        modifier = Modifier.verticalScroll(down),
                    )
                    else -> Text(
                        open.text.orEmpty(),
                        Modifier.verticalScroll(down),
                        fontSize = 13.sp,
                        fontFamily = if (engine == FileEngine.Code || engine == FileEngine.Html) JepMono else FontFamily.Default,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                }
            }
        }
    }
}

/**
 * An HTML file drawn as a page. It has no origin and no file access, so it can
 * reach nothing on the phone; a tapped link leaves for the browser rather than
 * navigating the reader away from the file.
 */
@Composable
private fun HtmlView(html: String) {
    val uris = LocalUriHandler.current
    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { ctx ->
            WebView(ctx).apply {
                settings.javaScriptEnabled = true
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                        runCatching { uris.openUri(request.url.toString()) }
                        return true
                    }
                }
                loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
            }
        },
    )
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
    // A terminal is dark in both themes: its output is a fixed ground, not a
    // surface, and a light one costs more in legibility than it gains in looks.
    val syntax = LocalSyntaxColors.current
    Column(modifier.fillMaxWidth()) {
        Text(
            frame.trimEnd('\n'),
            Modifier.weight(1f).fillMaxWidth()
                .verticalScroll(scroll)
                .background(syntax.terminalBg)
                .padding(10.dp)
                .semantics { contentDescription = "terminal output" },
            fontFamily = JepMono,
            fontSize = 11.sp,
            lineHeight = 15.sp,
            color = syntax.terminalFg,
        )
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            listOf("C-c" to "Ctrl-C", "Tab" to "Tab", "Up" to "↑", "Down" to "↓", "Escape" to "Esc", "BSpace" to "⌫")
                .forEach { (key, label) ->
                    OutlinedButton(
                        onClick = { scope.launch { vm.termKey(key) } },
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 10.dp, vertical = 0.dp),
                    ) { Text(label, fontSize = 12.sp) }
                }
        }
        Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = draft.value,
                onValueChange = { draft.value = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text("type a command", fontSize = 13.sp) },
                textStyle = androidx.compose.ui.text.TextStyle(fontFamily = JepMono, fontSize = 13.sp),
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
                Text(it, fontSize = 11.sp, fontFamily = JepMono, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
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
    leading: (@Composable () -> Unit)? = null,
) {
    Row(
        Modifier.fillMaxWidth()
            .clickable(onClick = onPick)
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
                Text(it, fontSize = 12.sp, fontFamily = JepMono, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (selected) {
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
        Text(value, fontSize = 13.sp, fontFamily = JepMono, color = MaterialTheme.colorScheme.onSurface)
    }
}

@Composable
@OptIn(ExperimentalMaterial3Api::class)
private fun GitSheet(vm: ChatViewModel, onDismiss: () -> Unit) {
    val state by vm.state.collectAsState()
    val git = state.git
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    LaunchedEffect(Unit) { vm.loadGit() }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(
            Modifier.fillMaxWidth().heightIn(max = 720.dp).padding(horizontal = 18.dp).padding(bottom = 24.dp),
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("Git", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                TextButton(onClick = { vm.loadGit() }, enabled = !state.gitLoading) { Text("Refresh") }
                IconButton(onClick = onDismiss) { Icon(Icons.Filled.Close, "close Git sheet") }
            }
            HorizontalDivider()
            when {
                state.gitLoading && git == null -> LoadingLine()
                state.gitError != null && git == null -> Text(
                    state.gitError.orEmpty(),
                    Modifier.padding(vertical = 18.dp),
                    color = MaterialTheme.colorScheme.error,
                    fontSize = 13.sp,
                )
                git == null -> LoadingLine()
                !git.isRepository -> Text(
                    "This workspace isn't a Git repository.",
                    Modifier.padding(vertical = 18.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    fontSize = 14.sp,
                )
                else -> GitSnapshotContent(git)
            }
        }
    }
}

@Composable
private fun GitSnapshotContent(git: GitSnapshot) {
    Column(Modifier.fillMaxWidth().heightIn(max = 620.dp).verticalScroll(rememberScrollState())) {
        Row(
            Modifier.fillMaxWidth().padding(top = 14.dp, bottom = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = pill) {
                Row(Modifier.padding(horizontal = 11.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Filled.Source, null, Modifier.size(15.dp), tint = MaterialTheme.colorScheme.onSecondaryContainer)
                    Text(git.branch ?: "detached HEAD", Modifier.padding(start = 6.dp), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSecondaryContainer)
                }
            }
            Spacer(Modifier.weight(1f))
            if (git.changedFiles > 0) {
                Text(
                    "${git.changedFiles} changed",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.tertiary,
                )
            } else {
                Text("clean", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        git.head?.let { GitCommitCard(it) }
        if (git.commits.isEmpty()) {
            Text("No commits yet", Modifier.padding(vertical = 16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp)
        } else {
            Text("RECENT HISTORY", Modifier.padding(top = 18.dp, bottom = 8.dp), fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            git.commits.drop(1).forEach { GitCommitRow(it) }
        }
    }
}

@Composable
private fun GitCommitCard(commit: GitCommit) {
    Surface(
        Modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.primaryContainer,
        shape = RoundedCornerShape(Radius.card),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("HEAD", fontSize = 10.sp, color = MaterialTheme.colorScheme.onPrimaryContainer)
                Spacer(Modifier.size(8.dp))
                Text(commit.shortHash, fontSize = 11.sp, fontFamily = JepMono, color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.75f))
            }
            Text(commit.subject, fontSize = 15.sp, color = MaterialTheme.colorScheme.onPrimaryContainer)
            Text(
                "${commit.author} · ${fmtGitTime(commit.time)}",
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.75f),
            )
        }
    }
}

@Composable
private fun GitCommitRow(commit: GitCommit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        Column(Modifier.width(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Surface(Modifier.padding(top = 5.dp).size(8.dp), shape = CircleShape, color = MaterialTheme.colorScheme.outline) {}
            Box(Modifier.padding(top = 4.dp).width(1.dp).height(38.dp).background(MaterialTheme.colorScheme.outline.copy(alpha = 0.5f)))
        }
        Column(Modifier.weight(1f).padding(bottom = 10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(commit.shortHash, fontSize = 11.sp, fontFamily = JepMono, color = MaterialTheme.colorScheme.primary)
                Text("  ·  ${fmtGitTime(commit.time)}", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(commit.subject, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface)
            Text(commit.author, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

private fun fmtGitTime(seconds: Long): String =
    java.text.SimpleDateFormat("MMM d · HH:mm", java.util.Locale.getDefault()).format(java.util.Date(seconds * 1000))

private fun liveAsMessage(live: ChatViewModel.LiveTurn?): ChatMessage? {
    if (live == null) return null
    // a thinking part with nothing in it yet is not worth a bubble
    val parts = live.parts.values.filterNot { it is ChatPart.Text && it.text.isEmpty() || it is ChatPart.Reasoning && it.text.isBlank() }
    if (parts.isEmpty()) return null
    return ChatMessage(live.messageId, Role.ASSISTANT, 0, parts)
}

// what the copy button takes: the answer as the user saw it — no thinking, no
// tool calls, no file noise
private fun messageText(message: ChatMessage): String =
    message.parts.filterIsInstance<ChatPart.Text>().joinToString("\n") { it.text }

// what a reply carries of the message it answers: enough to know which one,
// not the whole of a long answer
private fun quoteOf(message: ChatMessage): String? {
    val text = messageText(message).trim()
    if (text.isEmpty()) return null
    val lines = text.lines()
    var q = lines.take(6).joinToString("\n")
    if (q.length > 500) q = q.take(500).trimEnd()
    return if (q.length < text.length) "$q…" else q
}

// A quote above the words it was answered with: a bar and the quoted words,
// quieter than the message, cut to a few lines. It is a jep quote, not a
// markdown block typed into the text.
@Composable
private fun QuoteBlock(text: String, ink: Color, modifier: Modifier = Modifier) {
    Row(
        modifier.height(IntrinsicSize.Min).semantics { contentDescription = "quoted message" },
    ) {
        Box(
            Modifier
                .width(3.dp)
                .fillMaxHeight()
                .background(ink.copy(alpha = 0.45f), RoundedCornerShape(2.dp)),
        )
        Text(
            text,
            Modifier.padding(start = 8.dp),
            color = ink.copy(alpha = 0.7f),
            fontSize = 13.sp,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

// what a long-press copies: the whole turn, tool calls and thinking included
private fun fullTurnText(message: ChatMessage): String =
    message.parts.joinToString("\n\n") { p ->
        when (p) {
            is ChatPart.Text -> p.text
            is ChatPart.Quote -> p.text.lines().joinToString("\n") { "> $it" }
            is ChatPart.Reasoning -> "[thinking]\n${p.text}"
            is ChatPart.Tool ->
                buildString {
                    append("[tool: ${p.name}]")
                    p.title?.takeIf { it.isNotBlank() }?.let { append(" $it") }
                    p.output?.takeIf { it.isNotBlank() }?.let { append("\n$it") }
                }
            is ChatPart.File -> "[file] ${p.name ?: p.path}"
            ChatPart.Compaction -> "[conversation compacted]"
            ChatPart.AutoContinue -> ""
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
    cards: Map<String, List<Row>> = emptyMap(),
    cardView: @Composable (Row) -> Unit = {},
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
            .padding(horizontal = RowInset, vertical = RowVInset)
            .testTag("message-row-${message.id}")
            .combinedClickable(onClick = {}, onLongClick = { menu = true }),
    ) {
        when (message.role) {
            Role.USER -> UserBubble(message) { onRetrySend(message.id) }
            Role.ASSISTANT -> AssistantBody(message, onInfo, responding, showActions, cards, cardView)
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
            shape = RoundedCornerShape(Radius.bubble),
        ) {
            Column(Modifier.padding(horizontal = 14.dp, vertical = 9.dp)) {
                // a file must show in the person's own bubble too, or an image
                // sent from another client (Telegram) is invisible here
                val ink = if (pending) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onPrimaryContainer
                message.parts.forEach { part ->
                    when (part) {
                        is ChatPart.Quote -> QuoteBlock(part.text, ink, Modifier.padding(bottom = 6.dp))
                        is ChatPart.Text -> UserText(part.text, ink)
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
                }
                // once per bubble, under everything it holds
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

@Composable
private fun RespondingMark() {
    Row(verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(Modifier.size(13.dp), strokeWidth = 2.dp)
        Spacer(Modifier.size(8.dp))
        Text("responding…", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun AssistantBody(
    message: ChatMessage,
    onInfo: (ChatMessage) -> Unit,
    responding: Boolean = false,
    showActions: Boolean = true,
    cards: Map<String, List<Row>> = emptyMap(),
    cardView: @Composable (Row) -> Unit = {},
) {
    // the per-turn accounting lives behind a quiet hollow "i", not printed under
    // every reply; a copy button sits beside it for the reply's own text
    val hasInfo = message.tokens != null || message.cost != null || message.model != null
    val clipboard = LocalClipboardManager.current
    val fullText = remember(message) { messageText(message) }
    Column(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        collapseTranscript(message.parts, cards.keys).forEach { row ->
            when (row) {
                is TranscriptRow.Group -> WorkRow(
                    row.parts,
                    active = responding && row.parts.last() === message.parts.lastOrNull { it !is ChatPart.Unsupported },
                )
                is TranscriptRow.One -> {
                    PartView(
                        row.part,
                        streaming = responding && row.part === message.parts.last(),
                    )
                    (row.part as? ChatPart.Tool)?.id?.let { cards[it] }?.forEach { cardView(it) }
                }
            }
        }
        // still working: a quiet spinner at the end of the reply, so a pause
        // between parts (thinking, a tool call) never looks like an ending
        if (responding) RespondingMark()
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

/** the path a file:// link names, or null for any other link */
internal fun localFilePath(uri: String): String? {
    if (!uri.startsWith("file:", ignoreCase = true)) return null
    val path = runCatching { java.net.URI(uri).path }.getOrNull()
    return path?.takeIf { it.isNotEmpty() }
}

// `[label](target)`, and images `![alt](target)`. Only the destination is
// touched, and only when it is relative, so a quoted title after it survives.
private val LINK_TARGET = Regex("""(!?\[[^\]]*\])\(([^)\s]+)((?:\s+"[^"]*")?)\)""")

/** workspace or file:// images a message links to, for thumbnails under it */
internal fun linkedImages(markdown: String): List<String> =
    LINK_TARGET.findAll(markdown).mapNotNull { m ->
        val raw = m.groupValues[2]
        val path = localFilePath(raw)
            ?: raw.takeIf { linkDestination(it)?.startsWith("jep://file") == true }
                ?.trim()?.substringBefore('#')?.substringBefore('?')?.removePrefix("./")
        path?.takeIf { fileEngineFor(it) == FileEngine.Image }
    }.distinct().toList()

internal fun withLocalLinks(markdown: String): String =
    LINK_TARGET.replace(markdown) { m ->
        val dest = linkDestination(m.groupValues[2]) ?: return@replace m.value
        "${m.groupValues[1]}($dest${m.groupValues[3]})"
    }

/**
 * Holds a disclosure's header still on screen while the block changes height.
 *
 * The transcript runs bottom-up, so the edge that holds still when a block opens
 * is the *bottom* of its item: the height the block adds comes out of the top,
 * which slides the content above it up and walks the header you tapped out from
 * under your finger. It reads as the block opening the wrong way. That height
 * has to be spent downwards instead.
 *
 * So the header reports where it is, and the list is given back exactly however
 * far it moved. The header keeps its place; the content below it is what moves,
 * which is the way a fold is expected to open.
 */
@Composable
private fun WorkRow(parts: List<ChatPart>, durationMs: Long? = null, active: Boolean = false) {
    var open by remember { mutableStateOf(false) }
    val tools = parts.filterIsInstance<ChatPart.Tool>()
    val anyFailed = tools.any { it.status == ToolStatus.ERROR }
    val anyRunning = active || tools.any { it.status == ToolStatus.RUNNING || it.status == ToolStatus.PENDING }
    val added = tools.sumOf { it.added ?: 0 }
    val removed = tools.sumOf { it.removed ?: 0 }
    val syntax = LocalSyntaxColors.current
    val tint = when {
        anyFailed -> MaterialTheme.colorScheme.error
        anyRunning -> MaterialTheme.colorScheme.primary
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    // The title carries the row inset, exactly like an ungrouped row, and the
    // parts it opens keep it too, so an opened fold lines up with its neighbours.
    Column(Modifier.fillMaxWidth().padding(vertical = RowVInset)) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = RowInset).clickable { open = !open },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                workTitle(parts, durationMs, anyRunning),
                style = MaterialTheme.typography.labelMedium,
                color = tint,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            if (added > 0) {
                Text("+$added", style = MaterialTheme.typography.labelMedium, fontFamily = JepMono, color = syntax.added, modifier = Modifier.padding(start = 6.dp))
            }
            if (removed > 0) {
                Text("-$removed", style = MaterialTheme.typography.labelMedium, fontFamily = JepMono, color = syntax.removed, modifier = Modifier.padding(start = 4.dp))
            }
            Icon(
                if (open) Icons.Filled.ArrowDropUp else Icons.Filled.ArrowDropDown,
                if (open) "hide this work" else "show this work",
                Modifier.size(16.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (open) {
            val scroll = rememberScrollState()
            // while the turn runs, the window follows its newest step
            LaunchedEffect(parts.size, active, scroll.maxValue) {
                if (active) scroll.scrollTo(scroll.maxValue)
            }
            Column(
                Modifier.fillMaxWidth()
                    .padding(start = RowInset, top = 2.dp, end = RowInset)
                    .heightIn(max = WorkWindow)
                    .fadeEdges(scroll)
                    .verticalScroll(scroll),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                parts.forEach { PartView(it, streaming = false) }
            }
        }
    }
}

private val WorkWindow = 280.dp
private val EdgeFade = 24.dp

/** fades the content out towards whichever edge still has more to scroll to */
private fun Modifier.fadeEdges(scroll: ScrollState): Modifier =
    graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
        .drawWithContent {
            drawContent()
            val fade = EdgeFade.toPx().coerceAtMost(size.height / 2)
            if (scroll.canScrollBackward) {
                drawRect(Brush.verticalGradient(0f to Color.Transparent, 1f to Color.Black, endY = fade), blendMode = BlendMode.DstIn)
            }
            if (scroll.canScrollForward) {
                drawRect(
                    Brush.verticalGradient(0f to Color.Black, 1f to Color.Transparent, startY = size.height - fade, endY = size.height),
                    blendMode = BlendMode.DstIn,
                )
            }
        }

/**
 * A run of work — tool calls and thinking with nothing said between them —
 * collapses into one row. A turn that read, thought, edited and ran its way to
 * an answer was a column of "Edited …", "Thought for 2s", "Ran a command" lines
 * between the two things it said; that is one stretch of work, and it reads as
 * one line titled by what is inside it. A lone call or thought stays itself: a
 * fold around one line costs a tap for nothing.
 */
internal sealed interface TranscriptRow {
    data class One(val part: ChatPart) : TranscriptRow
    data class Group(val parts: List<ChatPart>) : TranscriptRow
}

internal fun collapseTranscript(parts: List<ChatPart>, keep: Set<String> = emptySet()): List<TranscriptRow> {
    val out = ArrayList<TranscriptRow>(parts.size)
    var run = mutableListOf<ChatPart>()
    fun flush() {
        if (run.size > 1) out += TranscriptRow.Group(run.toList()) else run.forEach { out += TranscriptRow.One(it) }
        run = mutableListOf()
    }
    for (part in parts) {
        when {
            // step markers and blank thinking neither show nor break a run
            part is ChatPart.Unsupported -> Unit
            part is ChatPart.Reasoning && part.text.isBlank() -> Unit
            part is ChatPart.Reasoning -> run.add(part)
            // a call with a card under it stays its own row, so the card has a place
            part is ChatPart.Tool && part.id !in keep -> run.add(part)
            else -> {
                flush()
                out += TranscriptRow.One(part)
            }
        }
    }
    flush()
    return out
}

private val TOOL_VERB = mapOf(
    "read" to "Read", "edit" to "Edited", "write" to "Wrote", "bash" to "Ran",
    "grep" to "Searched", "glob" to "Found", "list" to "Listed", "patch" to "Patched",
    // Claude Code's MultiEdit lowercases to "multiedit"; opencode spells it
    // "multi-edit". Both are edits.
    "multiedit" to "Edited", "multi-edit" to "Edited",
)

private fun toolCount(kind: String, n: Int): String {
    val verb = TOOL_VERB[kind] ?: kind.replaceFirstChar { it.uppercase() }
    val noun = when (kind) {
        "read", "edit", "write", "patch", "multiedit", "multi-edit" -> "file"
        "bash" -> "command"
        "grep" -> "search"
        "glob" -> "match"
        else -> "call"
    }
    val plural = if (n == 1) noun else if (noun.endsWith("ch")) noun + "es" else noun + "s"
    return "$verb $n $plural"
}

/**
 * The title of a fold of work, from what is inside it: "Worked for 1m 13s ·
 * edited 6 files, ran 2 commands", "Thought for 12s", or just "Read 3 files"
 * when nothing was timed. No line counts: the row draws those itself, in the
 * diff's own colours.
 */
internal fun workTitle(parts: List<ChatPart>, durationMs: Long? = null, active: Boolean = false): String {
    val tools = parts.filterIsInstance<ChatPart.Tool>()
    if (tools.isEmpty()) {
        if (active) return "Thinking"
        val took = parts.mapNotNull { (it as? ChatPart.Reasoning)?.durationMs }
        val ms = durationMs ?: took.sum().takeIf { took.size == parts.size }
        return if (ms != null && ms >= 1000) "Thought for ${fmtSpan(ms)}" else "Thought"
    }
    val counts = tools.groupBy { it.name.lowercase() }.map { (kind, calls) -> toolCount(kind, calls.size) }
    val rest = counts.joinToString(", ") { c -> c.replaceFirstChar { it.lowercase() } }
    val said = rest.replaceFirstChar { it.uppercase() }
    return when {
        active -> "Working · $rest"
        durationMs != null && durationMs >= 1000 -> "Worked for ${fmtSpan(durationMs)} · $rest"
        else -> said
    }
}

/** 42s, 1m 13s, 2h 5m */
internal fun fmtSpan(ms: Long): String {
    val s = ms / 1000
    return when {
        s < 60 -> "${s}s"
        s < 3600 -> "${s / 60}m ${s % 60}s"
        else -> "${s / 3600}h ${(s / 60) % 60}m"
    }
}

@Composable
private fun PartView(part: ChatPart, streaming: Boolean, onOpenLink: (String) -> Unit = {}) {
    when (part) {
        is ChatPart.Text -> Column {
            TextPart(part, streaming)
            val images = remember(part.text) { linkedImages(part.text) }
            if (images.isNotEmpty()) Row(
                Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                for (path in images) ImageThumb(ChatPart.File(path, path.substringAfterLast('/'), null))
            }
        }
        is ChatPart.Reasoning -> if (part.text.isNotBlank()) ReasoningRow(part, active = streaming)
        is ChatPart.Tool -> ToolRow(part)
        is ChatPart.File -> FileRow(part)
        is ChatPart.Quote -> QuoteBlock(part.text, MaterialTheme.colorScheme.onSurface)
        ChatPart.Compaction -> Unit // a divider row renders the message, not its parts
        ChatPart.AutoContinue -> Unit // the anchor row renders the quiet note, not a bubble
        is ChatPart.Unsupported -> Unit
    }
}

@Composable
private fun TextPart(part: ChatPart.Text, streaming: Boolean) {
    Markdown(
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
}

/** What the person typed, as Markdown, but all at one size: headings are bold, not bigger. */
@Composable
private fun UserText(text: String, ink: Color) {
    val body = TextStyle(color = ink, fontSize = 15.sp)
    val mono = body.copy(fontFamily = JepMono)
    val bold = body.copy(fontWeight = FontWeight.SemiBold)
    Markdown(
        withLocalLinks(text),
        colors = markdownColor(text = ink),
        typography = markdownTypography(
            h1 = bold, h2 = bold, h3 = bold, h4 = bold, h5 = bold, h6 = bold,
            text = body, paragraph = body, quote = body, ordered = body, bullet = body, list = body,
            table = body, code = mono, inlineCode = mono,
            textLink = TextLinkStyles(style = SpanStyle(color = ink, textDecoration = TextDecoration.Underline)),
        ),
    )
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
            .clip(RoundedCornerShape(Radius.control))
            .clickable(enabled = url.isNotBlank()) { open = true },
    )
    if (open) ImageViewer(url, part.name ?: "image") { open = false }
}

@Composable
private fun ImageViewer(url: String, name: String, onClose: () -> Unit) {
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        var scale by remember { mutableFloatStateOf(1f) }
        var offset by remember { mutableStateOf(Offset.Zero) }
        AsyncImage(
            model = url,
            contentDescription = name,
            contentScale = ContentScale.Fit,
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Black)
                .pointerInput(Unit) {
                    detectTapGestures(
                        onTap = { onClose() },
                        onDoubleTap = { at ->
                            if (scale > 1f) {
                                scale = 1f
                                offset = Offset.Zero
                            } else {
                                scale = 2.5f
                                offset = clampPan((Offset(size.width / 2f, size.height / 2f) - at) * 1.5f, scale, size)
                            }
                        },
                    )
                }
                .pointerInput(Unit) {
                    detectTransformGestures { _, pan, zoom, _ ->
                        scale = (scale * zoom).coerceIn(1f, 5f)
                        offset = clampPan(offset + pan, scale, size)
                    }
                }
                .graphicsLayer {
                    scaleX = scale
                    scaleY = scale
                    translationX = offset.x
                    translationY = offset.y
                },
        )
    }
}

private fun clampPan(offset: Offset, scale: Float, size: IntSize): Offset {
    val maxX = size.width * (scale - 1f) / 2f
    val maxY = size.height * (scale - 1f) / 2f
    return Offset(offset.x.coerceIn(-maxX, maxX), offset.y.coerceIn(-maxY, maxY))
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
            shape = RoundedCornerShape(Radius.control),
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
                        Text(it, fontSize = 11.sp, fontFamily = JepMono, color = MaterialTheme.colorScheme.onSurfaceVariant)
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

// The diff's green and red, the terminal's ground, and the highlighter's three
// all come from the theme now (see LocalSyntaxColors), so a theme change reaches
// them; they used to be fixed constants that ignored dark mode.

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
    val syntax = LocalSyntaxColors.current
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
                    "write", "edit", "multi-edit", "multiedit" -> "Edited " + (title?.substringAfterLast('/') ?: "file")
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
                Text("+$added", style = MaterialTheme.typography.labelMedium, fontFamily = JepMono, color = syntax.added, modifier = Modifier.padding(start = 6.dp))
            }
            if (removed > 0) {
                Text("-$removed", style = MaterialTheme.typography.labelMedium, fontFamily = JepMono, color = syntax.removed, modifier = Modifier.padding(start = 4.dp))
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
                    fontFamily = JepMono,
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
                fontFamily = JepMono,
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

private fun highlight(line: String, base: Color, comment: Color, syntax: SyntaxColors): AnnotatedString {
    val out = AnnotatedString.Builder()
    var last = 0
    for (m in CodeToken.findAll(line)) {
        if (m.range.first > last) out.append(line.substring(last, m.range.first))
        val text = m.value
        val color = when {
            m.groupValues[1].isNotEmpty() -> comment
            m.groupValues[2].isNotEmpty() -> syntax.string
            m.groupValues[3].isNotEmpty() -> syntax.number
            m.groupValues[4].isNotEmpty() && text in CodeKeywords -> syntax.keyword
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
                    fontFamily = JepMono,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 16.dp),
                )
            }
            HorizontalDivider(Modifier.padding(top = 8.dp))
            val onSurface = MaterialTheme.colorScheme.onSurface
            val faded = MaterialTheme.colorScheme.onSurfaceVariant
            val syntax = LocalSyntaxColors.current
            LazyColumn(Modifier.fillMaxWidth()) {
                items(diff.split("\n")) { line ->
                    // the red/green is the line's background, the way a diff reads
                    val added = line.startsWith("+")
                    val removed = line.startsWith("-")
                    val bg = when {
                        added -> syntax.added.copy(alpha = 0.18f)
                        removed -> syntax.removed.copy(alpha = 0.18f)
                        else -> Color.Transparent
                    }
                    Text(
                        highlight(line, onSurface, faded, syntax),
                        Modifier
                            .fillMaxWidth()
                            .background(bg)
                            .padding(horizontal = 14.dp, vertical = 1.dp),
                        fontSize = 12.sp,
                        lineHeight = 17.sp,
                        fontFamily = JepMono,
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
    //
    // A `question` ask can ask several things at once. Each question is drawn
    // with its own choices under its own heading, and the answers go back
    // together — the harness reads them positionally, one list per question, so
    // a tap can only be sent once every question has one.
    val multi = ask.questions.size > 1
    var picks by remember(ask.id) { mutableStateOf(emptyMap<Int, String>()) }
    // while the card is open the picks are what has been tapped; once it is
    // spent they are the answers that were actually sent
    val chosen = if (spent) parsePicked(choiceId) else picks
    val onPick: (Int, AskOption) -> Unit = { qi, option ->
        if (!spent) {
            val next = picks + (qi to option.id)
            picks = next
            if (ask.questions.indices.all { next.containsKey(it) }) {
                vm.respond(ask.id, encodePicked(ask.questions.size, next))
            }
        }
    }
    Card(
        Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 6.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (spent) MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)
            else MaterialTheme.colorScheme.surface,
        ),
        shape = RoundedCornerShape(Radius.card),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(ask.title, fontSize = 15.sp, color = MaterialTheme.colorScheme.onBackground)
            // No line cap on the question itself. It used to clip at four lines
            // with no ellipsis, so a second question's text simply stopped
            // mid-sentence and read as though that were all of it.
            ask.detail?.takeIf { !multi }?.let {
                Text(
                    it,
                    fontSize = 13.sp,
                    fontFamily = JepMono,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (multi) {
                ask.questions.forEachIndexed { qi, q ->
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(q.title, fontSize = 14.sp, color = MaterialTheme.colorScheme.onBackground)
                        q.detail?.let {
                            Text(
                                it,
                                fontSize = 12.sp,
                                fontFamily = JepMono,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        AskChoices(q.options, spent, chosen[qi]) { onPick(qi, it) }
                    }
                }
            } else {
                AskChoices(ask.options, spent, choiceId) { vm.respond(ask.id, it.id) }
            }
            // A question asked in the open does not have to be answered with
            // one of the labels I wrote. This spends the card the way saying
            // the answer in chat does, and sends nothing: the ask stands down
            // and the reply comes as a message.
            if (ask.kind == "question") {
                OutlinedButton(
                    onClick = { vm.spendAsk(ask.id) },
                    enabled = !spent,
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp, vertical = 2.dp),
                ) {
                    Text("Something else", fontSize = 13.sp, maxLines = 1)
                }
            }
        }
    }
}

/** one question's choices: the picked one filled, the rest still pressable */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AskChoices(
    options: List<AskOption>,
    spent: Boolean,
    pickedId: String?,
    onPick: (AskOption) -> Unit,
) {
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        options.forEach { option ->
            if (option.id == pickedId) {
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
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp, vertical = 2.dp),
                    modifier = Modifier.semantics { contentDescription = "${option.label}, chosen" },
                ) {
                    Text(option.label, fontSize = 13.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            } else {
                // Deny reads as what it is: the harness marks it danger,
                // and a card is exactly where a slip is costly
                OutlinedButton(
                    onClick = { onPick(option) },
                    enabled = !spent,
                    colors = if (option.danger) ButtonDefaults.outlinedButtonColors(
                        contentColor = MaterialTheme.colorScheme.error,
                    ) else ButtonDefaults.outlinedButtonColors(),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp, vertical = 2.dp),
                ) {
                    Text(option.label, fontSize = 13.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

/**
 * The answers on a spent card, as a question index to option id.
 *
 * A card that answered one question holds a bare option id; several questions
 * hold the JSON array that was sent (see [encodePicked]). Anything else is
 * unknown, and an unknown answer highlights nothing rather than guessing.
 */
internal fun parsePicked(choiceId: String?): Map<Int, String> {
    val raw = choiceId?.trim() ?: return emptyMap()
    if (!raw.startsWith("[")) return emptyMap()
    val ids = Regex("\"([^\"]*)\"").findAll(raw).map { it.groupValues[1] }.toList()
    return ids.mapNotNull { id ->
        val prefix = id.substringBefore(':', "")
        prefix.toIntOrNull()?.let { it to id }
    }.toMap()
}

/** the picked option ids as one JSON array, in question order */
internal fun encodePicked(count: Int, picks: Map<Int, String>): String =
    (0 until count).mapNotNull { picks[it] }.joinToString(",", "[", "]") { "\"${it.replace("\"", "\\\"")}\"" }

/**
 * The composer, full screen, for writing something long. The six-line box
 * could only show a long message a few lines at a time. Here the text gets the
 * whole screen above the keyboard, and every control sits in one bar at the
 * top: fold back on the left, attach and send together on the right.
 */
@Composable
private fun FullComposer(
    draft: String,
    attachments: List<ChatViewModel.Attachment>,
    sendable: Boolean,
    onDraft: (String) -> Unit,
    onAttach: () -> Unit,
    onRemove: (String) -> Unit,
    onSend: () -> Unit,
    onClose: () -> Unit,
) {
    val focus = remember { FocusRequester() }
    androidx.compose.ui.window.Dialog(
        onDismissRequest = onClose,
        properties = androidx.compose.ui.window.DialogProperties(
            usePlatformDefaultWidth = false,
            decorFitsSystemWindows = false,
        ),
    ) {
        Surface(Modifier.fillMaxSize().testTag("full-composer"), color = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxSize().systemBarsPadding().imePadding()) {
                // The top bar is navigation and title only: shrink, and how
                // much is written. The draft's actions live at the bottom,
                // where the main composer keeps them — the sheet is tall, and
                // top-corner buttons would drift a thumb's journey from the
                // text they act on.
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onClick = onClose) {
                        Icon(Icons.Filled.CloseFullscreen, "shrink the composer")
                    }
                    Text(
                        "${draft.length} chars",
                        Modifier.weight(1f),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (attachments.isNotEmpty()) {
                    Row(
                        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        attachments.forEach { a ->
                            InputChip(
                                selected = false,
                                onClick = { onRemove(a.id) },
                                label = { Text(a.name, maxLines = 1) },
                                trailingIcon = { Icon(Icons.Filled.Close, "remove", Modifier.size(16.dp)) },
                            )
                        }
                    }
                }
                HorizontalDivider()
                TextField(
                    value = draft,
                    onValueChange = onDraft,
                    Modifier.fillMaxWidth().weight(1f).focusRequester(focus).testTag("full-composer-text"),
                    placeholder = { Text("Message the agent") },
                    colors = TextFieldDefaults.colors(
                        focusedContainerColor = MaterialTheme.colorScheme.background,
                        unfocusedContainerColor = MaterialTheme.colorScheme.background,
                        focusedIndicatorColor = Color.Transparent,
                        unfocusedIndicatorColor = Color.Transparent,
                    ),
                )
                // The draft's actions, bottom-right, mirroring the main
                // composer: attach, then send. The Column already carries
                // imePadding, so this rides above the keyboard, and the text
                // scrolls above it rather than under it.
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
                    horizontalArrangement = Arrangement.End,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onClick = onAttach) {
                        Icon(Icons.Filled.AttachFile, "attach", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    FilledIconButton(onClick = onSend, enabled = sendable) {
                        Icon(Icons.AutoMirrored.Filled.Send, "send")
                    }
                }
            }
        }
    }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
}

/** Above the composer while the turn is parked on a card that is out of view. */
@Composable
private fun WaitingForYou(question: Boolean, onJump: () -> Unit) {
    Surface(
        Modifier.fillMaxWidth()
            .clickable(onClick = onJump)
            .testTag("waiting-for-you"),
        color = MaterialTheme.colorScheme.tertiaryContainer,
    ) {
        Row(
            Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                if (question) "Waiting for your answer" else "Waiting for your approval",
                Modifier.weight(1f),
                color = MaterialTheme.colorScheme.onTertiaryContainer,
                fontSize = 14.sp,
            )
            Icon(Icons.Filled.ArrowUpward, "show the card", tint = MaterialTheme.colorScheme.onTertiaryContainer)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun QueuedBubble(q: ChatViewModel.Queued, onClick: () -> Unit) {
    // a steer, a message held for after the reply, and one stopping the reply
    // all wait, but for different things: the mark and the line under the
    // bubble say which, so a held message is never mistaken for a steer
    val look = sendModeLook(q.mode)
    val ink = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.75f)
    val held = q.mode == SendMode.AFTER_REPLY
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 4.dp),
        horizontalAlignment = Alignment.End,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            // a queued message looks like a real one — same side, same bubble —
            // only dimmed, with its mark beside it: it is waiting, not broken
            Icon(
                look.icon,
                look.caption,
                Modifier.size(20.dp).padding(end = 7.dp),
                tint = ink,
            )
            Surface(
                Modifier.widthIn(max = 320.dp).clickable { onClick() },
                // held for later sits back further: an outline, not a fill
                color = if (held) Color.Transparent else MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.45f),
                border = if (held) androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.45f)) else null,
                shape = RoundedCornerShape(Radius.card),
            ) {
                Column(Modifier.padding(horizontal = 14.dp, vertical = 9.dp)) {
                    q.quote?.let { QuoteBlock(it, if (held) MaterialTheme.colorScheme.onSurface.copy(alpha = 0.75f) else ink, Modifier.padding(bottom = 6.dp)) }
                    Text(
                        q.text,
                        color = if (held) MaterialTheme.colorScheme.onSurface.copy(alpha = 0.75f) else ink,
                        fontSize = 15.sp,
                    )
                    // what is going with it, named the same way the composer named it
                    // — a queued message that showed only its words looked as though
                    // the attachment had been dropped on the way into the queue
                    if (q.attachments.isNotEmpty()) {
                        FlowRow(
                            Modifier.padding(top = 6.dp),
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            q.attachments.forEach { a ->
                                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 2.dp)) {
                                    Icon(
                                        Icons.Filled.AttachFile,
                                        null,
                                        Modifier.size(14.dp),
                                        tint = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.6f),
                                    )
                                    Text(
                                        a.name,
                                        Modifier.padding(start = 3.dp),
                                        color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.6f),
                                        fontSize = 12.sp,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
        Text(
            look.caption,
            Modifier.padding(top = 3.dp, end = 6.dp),
            fontSize = 11.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

private class SendModeLook(val icon: androidx.compose.ui.graphics.vector.ImageVector, val title: String, val caption: String)

private fun sendModeLook(mode: SendMode) = when (mode) {
    SendMode.STEER -> SendModeLook(Icons.AutoMirrored.Filled.CallMerge, "Steer in", "steers in at the next tool call")
    SendMode.AFTER_REPLY -> SendModeLook(Icons.Filled.Schedule, "After this reply", "sends after this reply")
    SendMode.NOW -> SendModeLook(Icons.Filled.FastForward, "Send now", "stops the reply, sends next")
}

private fun queuedExplainer(mode: SendMode) = when (mode) {
    SendMode.STEER -> "The agent is busy. This steers in at its next tool call."
    SendMode.AFTER_REPLY -> "The agent is busy. This waits for the reply to end, then sends."
    SendMode.NOW -> "This stops the running reply and sends next."
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Composer(vm: ChatViewModel, replyTo: ChatMessage?, onCancelReply: () -> Unit) {
    val state by vm.state.collectAsState()
    // The draft lives in the ViewModel, not in a `remember` here: this composable
    // leaves composition the moment you tap back, and with it went everything you
    // had typed — while the attachment, held in the same state, survived. The
    // asymmetry read as the app eating the message.
    val draft = state.draft
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
    var expanded by rememberSaveable { mutableStateOf(false) }
    val send: () -> Unit = {
        // a swipe-armed reply rides along as a quote, beside the words, never
        // spliced into them as markdown
        vm.send(draft, quote = replyTo?.let { quoteOf(it) })
        onCancelReply()
        expanded = false
    }
    // several at once: picking one file, then reopening the picker for the
    // next, was the only way to send a handful of screenshots
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        uris.forEach { uri ->
            val name = displayName(context, uri) ?: "file"
            val mime = context.contentResolver.getType(uri)
            val bytes = runCatching { context.contentResolver.openInputStream(uri)?.use { it.readBytes() } }.getOrNull()
            if (bytes != null) vm.attach(name, bytes, uri.toString(), mime)
        }
    }

    if (expanded) {
        FullComposer(
            draft = draft,
            attachments = state.attachments,
            sendable = sendable && (draft.isNotBlank() || state.attachments.isNotEmpty()),
            onDraft = { vm.setDraft(it) },
            onAttach = { picker.launch(arrayOf("*/*")) },
            onRemove = { vm.removeAttachment(it) },
            onSend = send,
            onClose = { expanded = false },
        )
    }
    Surface(tonalElevation = 2.dp, color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxWidth().imePadding().padding(horizontal = 10.dp, vertical = 8.dp)) {
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
            // How tall the draft really is, measured the way the field will lay
            // it out: the same style, the same width, the reader's own text
            // size. A character count cannot do this — the characters per line
            // fall as the text grows and as the reader's text size grows, so
            // the same 320 characters is three lines for one reader and six for
            // another, and only the layout knows which.
            val measurer = rememberTextMeasurer()
            val draftStyle = MaterialTheme.typography.bodyLarge
            // the field's own 16dp insets are all that stands between the field
            // and its words now that nothing is reserved inside it
            val insetsPx = with(LocalDensity.current) { 32.dp.toPx() }
            var fieldPx by remember { mutableIntStateOf(0) }
            val draftLines = remember(draft, fieldPx, draftStyle, insetsPx) {
                val room = fieldPx - insetsPx
                if (draft.isBlank() || room <= 0f) {
                    1
                } else {
                    measurer.measure(
                        AnnotatedString(draft),
                        style = draftStyle,
                        constraints = Constraints(maxWidth = room.toInt()),
                    ).lineCount
                }
            }
            val expandable = isWorthExpanding(draftLines)

            // The field keeps the whole width, and the buttons sit on their own
            // row beneath it. Overlaying them inside the field cost the text
            // their width on every line — M3 lays a trailing icon beside the
            // text, so reserving room for the pills shortened every line of the
            // draft, and the more buttons were on offer the narrower the writing
            // became. A row below spends a little height and gives back all of
            // the width, and a button appearing in it cannot move the text.
            OutlinedTextField(
                value = draft,
                onValueChange = { vm.setDraft(it) },
                Modifier.fillMaxWidth().onSizeChanged { fieldPx = it.width }.testTag("composer"),
                placeholder = { Text("Message the agent", color = MaterialTheme.colorScheme.onSurfaceVariant) },
                shape = RoundedCornerShape(Radius.field),
                minLines = 1,
                maxLines = 6,
                colors = androidx.compose.material3.OutlinedTextFieldDefaults.colors(
                    unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainer,
                    focusedContainerColor = MaterialTheme.colorScheme.surfaceContainer,
                    focusedBorderColor = MaterialTheme.colorScheme.outline,
                    unfocusedBorderColor = Color.Transparent,
                ),
            )
            Row(
                Modifier.fillMaxWidth().padding(top = 2.dp),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // Stop leads while it is there: the only button that ends work
                // rather than shaping the draft, so it sits apart from the rest.
                if (busy) {
                    ComposerPill(
                        icon = Icons.Filled.Stop,
                        desc = "stop",
                        onClick = { vm.stop() },
                        tint = MaterialTheme.colorScheme.error,
                    )
                }
                // Expand sits with stop, on the left: neither is about the
                // message being sent. Attach and send are, so they stay
                // together at the end.
                //
                // Offered once the draft really is four lines tall, measured
                // rather than counted — see isWorthExpanding.
                if (expandable) {
                    ComposerPill(
                        icon = Icons.Filled.OpenInFull,
                        desc = "expand the composer",
                        onClick = { expanded = true },
                    )
                }
                ComposerPill(
                    icon = Icons.Filled.AttachFile,
                    desc = "attach",
                    onClick = { picker.launch(arrayOf("*/*")) },
                )
                ComposerPill(
                    icon = Icons.AutoMirrored.Filled.Send,
                    desc = "send",
                    enabled = sendable,
                    tint = if (sendable) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                    onClick = send,
                    // hold to choose how it joins a running turn. With nothing
                    // running there is no choice: a hold sends.
                    onLongClick = {
                        if (draft.isNotBlank() || state.attachments.isNotEmpty()) {
                            if (busy) sendMenu = true else send()
                        }
                    },
                    modifier = Modifier.testTag("send-button"),
                )
            }
                if (sendMenu) {
                    val quote = replyTo?.let { quoteOf(it) }
                    AlertDialog(
                        onDismissRequest = { sendMenu = false },
                        title = { Text("Send how?") },
                        text = {
                            // every way in, in one place; a tap on Send is the first
                            Column {
                                SendMode.entries.forEach { mode ->
                                    val look = sendModeLook(mode)
                                    Row(
                                        Modifier
                                            .fillMaxWidth()
                                            .clickable {
                                                vm.send(draft, mode, quote)
                                                sendMenu = false
                                                onCancelReply()
                                                expanded = false
                                            }
                                            .padding(vertical = 10.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        Icon(look.icon, null, Modifier.size(22.dp), tint = MaterialTheme.colorScheme.primary)
                                        Column(Modifier.padding(start = 14.dp)) {
                                            Text(look.title, fontSize = 15.sp, color = MaterialTheme.colorScheme.onSurface)
                                            Text(look.caption, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                        }
                                    }
                                }
                            }
                        },
                        confirmButton = {},
                        dismissButton = { TextButton(onClick = { sendMenu = false }) { Text("Back") } },
                    )
                }
        }
    }
}

/**
 * A round button for the composer, drawn as a filled disc rather than a bare
 * glyph. Attach and Send used to be icons floating on grey, which read as
 * decoration next to the field's outline; a pill says "pressable" at a glance
 * and keeps the accent meaningful, because only Send and Stop carry colour.
 *
 * The visible disc is 38dp inside a 44dp target. Not padding for its own sake:
 * a pill sized to its own target is a 44dp target, and a 44dp disc inside a
 * 56dp-tall field swamps it. This way the touch area still clears the 48dp
 * accessibility minimum's neighbourhood while the drawn button stays small.
 */
@Composable
private fun ComposerPill(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    desc: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    onLongClick: (() -> Unit)? = null,
    tint: Color = MaterialTheme.colorScheme.onSurfaceVariant,
) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.45f)
    Box(modifier.size(44.dp), contentAlignment = Alignment.Center) {
        Surface(
            Modifier.size(38.dp),
            shape = CircleShape,
            // a disabled Send recedes rather than vanishing: you can still see
            // where it is, so the reason the field looks inert is legible
            color = if (enabled) MaterialTheme.colorScheme.surfaceContainerHigh else MaterialTheme.colorScheme.surfaceContainerLow,
        ) {}
        Box(
            Modifier
                .matchParentSize()
                .combinedClickable(enabled = enabled, onClick = onClick, onLongClick = onLongClick),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, desc, Modifier.size(20.dp), tint = if (enabled) tint else muted)
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

/** Last known status fields survive partial history snapshots during a live turn. */
internal data class StatusSummary(
    val model: String? = null,
    val used: Long? = null,
    val limit: Long? = null,
    val spend: Double? = null,
)

/** The status line's current inputs; missing fields are distinct from zero. */
internal fun statusSummary(state: ChatViewModel.UiState): StatusSummary {
    val turns = state.messages.filter { it.role == Role.ASSISTANT }
    val last = turns.lastOrNull { it.tokens != null }
    val model = last?.model?.substringAfterLast('/')
        ?: state.models?.current?.substringAfterLast('/')
        ?: state.models?.default?.substringAfterLast('/')
    val used = last?.tokens?.context?.takeIf { it > 0 }
    // the picker's entry for the running model, else the gateway's own answer:
    // a model the picker does not list (an alias, a 1M variant, the CLI's own
    // fallback) still has a window
    val limit = state.models?.let { c ->
        val ref = c.current ?: c.default
        c.all.firstOrNull { it.ref == ref }?.contextLimit?.takeIf { it > 0 }
            ?: c.contextLimit.takeIf { it > 0 }
    }
    // Spend is the conversation's, not the window's: summing only the messages
    // loaded here read $0.04 beside a usage sheet saying $1.01. The gateway's
    // /usage (the sheet's source) is the one answer; the window is only a
    // stand-in until it arrives.
    val costs = turns.mapNotNull { it.cost }
    val spend = state.usage?.cost?.takeIf { it > 0.0 }
        ?: costs.sum().takeIf { costs.isNotEmpty() && it > 0.0 }
    return StatusSummary(model?.takeIf { it.isNotBlank() }, used, limit, spend)
}

/** Keep the last reported values when a streaming history snapshot omits them. */
internal fun retainStatus(previous: StatusSummary, current: StatusSummary): StatusSummary =
    StatusSummary(
        model = current.model ?: previous.model,
        used = current.used ?: previous.used,
        limit = current.limit ?: previous.limit,
        // the latest answer stands; keeping the largest ever seen is what
        // pinned a stale figure once a bigger one had flashed past
        spend = current.spend ?: previous.spend,
    )

/**
 * A record entry can carry nothing renderable — a part the mapper silences to
 * null and nothing else. Rendering it shows an empty bubble. Compaction is not
 * this case any more: its marker maps to a real part and renders as a divider.
 */
internal fun renderableMessages(messages: List<ChatMessage>): List<ChatMessage> =
    messages.filter { it.parts.isNotEmpty() }

/** compaction is written full width: a line, the words centred, a line */
@Composable
internal fun CompactionRow(m: ChatMessage) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.outlineVariant)
        Text(
            "compaction complete",
            Modifier.padding(horizontal = 12.dp),
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.outlineVariant)
    }
}

/** the auto-continue prompt is scaffolding, only an anchor: a quiet note that
 *  the harness simply went on — never the model's words as the user's own */
@Composable
internal fun AutoContinueRow(m: ChatMessage) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.outlineVariant)
        Text(
            "· auto-continued ·",
            Modifier.padding(horizontal = 12.dp),
            fontSize = 11.sp,
            color = MaterialTheme.colorScheme.outline,
        )
        HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.outlineVariant)
    }
}

internal fun statusText(status: StatusSummary): String {
    val out = mutableListOf<String>()
    status.model?.let { out += it }
    val used = status.used ?: 0L
    val limit = status.limit ?: 0L
    when {
        // more in use than the limit allows means the limit is the wrong one
        // (a window not learned yet): "461K/200K 231%" is worse than no limit
        used > 0 && limit >= used -> out += "${fmtTokens(used)}/${fmtTokens(limit)}  ${(100.0 * used / limit).roundToInt()}%"
        used > 0 -> out += "${fmtTokens(used)} tok"
    }
    status.spend?.takeIf { it > 0 }?.let { out += fmtMoney(it) }
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

/** how far past the top a pull must go before letting go loads older messages */
private const val OLDER_PULL_THRESHOLD = 150f

internal class OlderPull(
    val offset: Float,
    val armed: Boolean,
    val connection: NestedScrollConnection,
)

// A pull down past the top of the list, with the finger, never a fling that
// happens to reach it. The list follows the finger at half speed, and a
// release past the threshold asks for the previous page; anything short of it
// springs back and does nothing.
@Composable
private fun rememberOlderPull(enabled: Boolean, onLoad: () -> Unit): OlderPull {
    val scope = rememberCoroutineScope()
    val pull = remember { androidx.compose.animation.core.Animatable(0f) }
    val currentEnabled by androidx.compose.runtime.rememberUpdatedState(enabled)
    val currentLoad by androidx.compose.runtime.rememberUpdatedState(onLoad)
    val connection = remember {
        object : NestedScrollConnection {
            override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                // pushing back up takes the pull away before the list scrolls
                if (pull.value > 0f && available.y < 0f && source == NestedScrollSource.UserInput) {
                    val take = maxOf(available.y, -pull.value * 2f)
                    scope.launch { pull.snapTo((pull.value + take / 2f).coerceAtLeast(0f)) }
                    return Offset(0f, take)
                }
                return Offset.Zero
            }

            override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
                // the list is at its top and the finger keeps pulling down
                if (!currentEnabled || available.y <= 0f || source != NestedScrollSource.UserInput) return Offset.Zero
                scope.launch { pull.snapTo((pull.value + available.y / 2f).coerceAtMost(OLDER_PULL_THRESHOLD * 1.4f)) }
                return Offset(0f, available.y)
            }

            override suspend fun onPreFling(available: Velocity): Velocity {
                if (pull.value <= 0f) return Velocity.Zero
                val fire = pull.value >= OLDER_PULL_THRESHOLD && currentEnabled
                scope.launch { pull.animateTo(0f) }
                if (fire) currentLoad()
                // a released pull is spent: it must not fling the list as well
                return available
            }
        }
    }
    return OlderPull(pull.value, pull.value >= OLDER_PULL_THRESHOLD, connection)
}

@Composable
private fun OlderPullIndicator(pull: OlderPull, modifier: Modifier = Modifier) {
    if (pull.offset < 1f) return
    Row(
        modifier
            .padding(top = 8.dp)
            .graphicsLayer { alpha = (pull.offset / OLDER_PULL_THRESHOLD).coerceIn(0f, 1f) }
            .semantics { contentDescription = "pull to load earlier messages" },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            Icons.Filled.ArrowUpward,
            null,
            Modifier.size(16.dp).graphicsLayer { rotationZ = if (pull.armed) 0f else 180f },
            tint = if (pull.armed) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            if (pull.armed) "Release to load earlier" else "Pull to load earlier",
            Modifier.padding(start = 6.dp),
            fontSize = 12.sp,
            color = if (pull.armed) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
