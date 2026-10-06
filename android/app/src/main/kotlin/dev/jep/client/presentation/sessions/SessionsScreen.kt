package dev.jep.client.presentation.sessions

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.MarkEmailRead
import androidx.compose.material.icons.filled.MarkEmailUnread
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material3.Checkbox
import androidx.compose.ui.graphics.Color
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.LocalMinimumInteractiveComponentEnforcement
import androidx.compose.material3.Scaffold
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.foundation.layout.offset
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import kotlinx.coroutines.launch
import kotlin.math.roundToInt
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Inventory2
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.activity.compose.BackHandler
import dev.jep.client.domain.model.ImportableSession
import androidx.compose.foundation.layout.offset
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import dev.jep.client.presentation.theme.JepMark
import dev.jep.client.presentation.theme.JepMono
import dev.jep.client.presentation.theme.LocalSyntaxColors
import dev.jep.client.R
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jep.client.domain.model.SessionSummary
import dev.jep.client.presentation.app.PODS_PROJECT

// The entry list: newest conversation first, one workspace tag per row. The
// screen reflects the gateway; it never caches beyond what it was handed.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(
    sessions: List<SessionSummary>,
    busy: Boolean,
    notice: String?,
    onOpen: (SessionSummary) -> Unit,
    onNew: () -> Unit,
    onRefresh: () -> Unit,
    onSettings: () -> Unit,
    onArchive: (SessionSummary) -> Unit,
    /** conversations that have changed since they were last opened */
    unread: Set<String> = emptySet(),
    /** what was archived — null until the view is asked for */
    archived: List<SessionSummary>? = null,
    onLoadArchived: () -> Unit = {},
    onUnarchive: (SessionSummary) -> Unit = {},
    /** rows picked in select mode */
    selection: Set<String> = emptySet(),
    onToggleSelect: (SessionSummary) -> Unit = {},
    onClearSelection: () -> Unit = {},
    onArchiveSelected: () -> Unit = {},
    onMarkSelected: (Boolean) -> Unit = {},
    /** hold the picked conversations at the top, or release them */
    onPinSelected: (Boolean) -> Unit = {},
    /** conversations archived a moment ago, restorable while this is non-empty */
    undo: List<SessionSummary> = emptyList(),
    onUndoArchive: () -> Unit = {},
    importable: List<ImportableSession>?,
    onLoadImportable: () -> Unit,
    onImport: (ImportableSession) -> Unit,
    /** group the list into projects (one row per directory) instead of a flat list */
    grouped: Boolean = false,
    // which project is open (its directory), when grouped. Kept in the
    // ViewModel, not the screen: a project survives leaving for a chat, so
    // Back returns inside it rather than to the top of the list.
    openProject: String? = null,
    onOpenProject: (String?) -> Unit = {},
) {
    var importOpen by remember { mutableStateOf(false) }
    var archivedOpen by remember { mutableStateOf(false) }
    var confirmImport by remember { mutableStateOf<ImportableSession?>(null) }
    // Turning grouping off while a project is open must not leave a flat list
    // filtered to that one project, so the drill-in is dropped with the mode.
    LaunchedEffect(grouped) { if (!grouped) onOpenProject(null) }
    BackHandler(enabled = grouped && openProject != null) { onOpenProject(null) }
    Scaffold(
        containerColor = Color.Transparent,
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = onNew,
                modifier = Modifier.height(42.dp),
                containerColor = MaterialTheme.colorScheme.primary,
                contentColor = MaterialTheme.colorScheme.onPrimary,
            ) {
                Icon(Icons.Filled.Add, null, Modifier.size(18.dp))
                Text(" New conversation", fontSize = 13.sp)
            }
        },
    ) { pad ->
        Column(Modifier.fillMaxSize().padding(pad)) {
            // the mark floats on its own row, centered — the bar below keeps
            // the plain wordmark instead of squeezing a logo into the title
            Box(Modifier.fillMaxWidth().padding(top = 2.dp), contentAlignment = Alignment.Center) {
                Image(
                    JepMark,
                    null,
                    Modifier.size(24.dp),
                )
            }
            if (selection.isNotEmpty()) {
                TopAppBar(
                    modifier = Modifier.height(48.dp),
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                    navigationIcon = {
                        CompositionLocalProvider(LocalMinimumInteractiveComponentEnforcement provides false) {
                            IconButton(onClick = onClearSelection, Modifier.size(36.dp)) {
                                Icon(Icons.Filled.Close, "cancel selection", Modifier.size(20.dp))
                            }
                        }
                    },
                    title = { Text("${selection.size} selected") },
                    actions = {
                        // one toggle rather than pin and unpin side by side: it
                        // reads as the state those rows are in
                        val allPinned = sessions.filter { it.id in selection }.all { it.pinned } &&
                            sessions.any { it.id in selection }
                        CompositionLocalProvider(LocalMinimumInteractiveComponentEnforcement provides false) {
                        IconButton(onClick = { onPinSelected(!allPinned) }, Modifier.size(36.dp)) {
                            Icon(
                                Icons.Filled.PushPin,
                                if (allPinned) "unpin selected" else "pin selected",
                                Modifier.size(20.dp),
                                tint = if (allPinned) MaterialTheme.colorScheme.primary else LocalContentColor.current,
                            )
                        }
                        IconButton(onClick = onArchiveSelected, Modifier.size(36.dp)) {
                            Icon(Icons.Filled.Archive, "archive selected", Modifier.size(20.dp))
                        }
                        IconButton(onClick = { onMarkSelected(true) }, Modifier.size(36.dp)) {
                            Icon(Icons.Filled.MarkEmailRead, "mark as read", Modifier.size(20.dp))
                        }
                        IconButton(onClick = { onMarkSelected(false) }, Modifier.size(36.dp)) {
                            Icon(Icons.Filled.MarkEmailUnread, "mark as unread", Modifier.size(20.dp))
                        }
                        }
                    },
                )
            } else TopAppBar(
                modifier = Modifier.height(48.dp),
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                navigationIcon = {
                    // inside a project the only way out is back, so the bar
                    // grows one — the logo is replaced by where you are
                    if (grouped && openProject != null) {
                        CompositionLocalProvider(LocalMinimumInteractiveComponentEnforcement provides false) {
                            IconButton(onClick = { onOpenProject(null) }, Modifier.size(36.dp)) {
                                Icon(Icons.AutoMirrored.Filled.ArrowBack, "back to projects", Modifier.size(20.dp))
                            }
                        }
                    }
                },
                title = {
                    val dir = openProject
                    if (grouped && dir != null) {
                        Column {
                            Text(projectName(dir, sessions.filter { projectDir(it) == dir }))
                            Text(
                                "${sessions.count { projectDir(it) == dir }} conversation" +
                                    (if (sessions.count { projectDir(it) == dir } == 1) "" else "s"),
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    } else Text("Jep")
                },
                actions = {
                    if (busy) {
                        CircularProgressIndicator(
                            Modifier.size(18.dp).padding(end = 6.dp),
                            strokeWidth = 2.dp,
                        )
                    }
                    // an archive you can take back, for a moment — a swipe is
                    // easy to trigger by accident
                    if (undo.isNotEmpty()) {
                        TextButton(onClick = onUndoArchive) { Text("Undo") }
                    }
                    // compact bars: the material 48dp target reads huge next to
                    // 20dp glyphs, so the enforcement goes off for this bar only
                    CompositionLocalProvider(LocalMinimumInteractiveComponentEnforcement provides false) {
                        IconButton(onClick = { importOpen = true; onLoadImportable() }, Modifier.size(36.dp)) {
                            Icon(Icons.Filled.Link, "import a session", Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        // archive hid conversations with no way back to them
                        IconButton(onClick = { archivedOpen = true; onLoadArchived() }, Modifier.size(36.dp)) {
                            Icon(Icons.Filled.Inventory2, "archived conversations", Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        IconButton(onClick = onSettings, Modifier.size(36.dp)) {
                            Icon(Icons.Filled.Settings, "settings", Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                },
            )
            notice?.let {
                Text(
                    it,
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 16.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    fontSize = 14.sp,
                )
            }
            PullToRefreshBox(
                isRefreshing = busy,
                onRefresh = onRefresh,
                modifier = Modifier.weight(1f).fillMaxWidth(),
            ) {
            if (sessions.isEmpty() && busy) {
                Box(
                    Modifier.fillMaxSize().semantics { contentDescription = "loading conversations" },
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 3.dp)
                }
            } else if (grouped && openProject == null) {
                // one row per project: the conversations, by the directory they
                // were started in, newest project first. Pinning a conversation
                // lifts its project too, so the pin is not buried a level down.
                val projects = groupedProjects(sessions)
                LazyColumn(Modifier.fillMaxSize()) {
                    items(projects.size) { i ->
                        val (dir, list) = projects[i]
                        ProjectRow(
                            name = projectName(dir, list),
                            dir = dir,
                            count = list.size,
                            unread = list.any { unread.contains(it.id) },
                            active = list.any { it.active },
                            pinned = list.any { it.pinned },
                            onClick = { onOpenProject(dir) },
                        )
                    }
                }
            } else {
                val shown = if (grouped && openProject != null) sessions.filter { projectDir(it) == openProject } else sessions
                LazyColumn(Modifier.fillMaxSize()) {
                    items(shown.size) { i ->
                        val s = shown[i]
                        val row = @Composable {
                            SessionRow(
                                session = s,
                                unread = unread.contains(s.id),
                                selected = s.id in selection,
                                selecting = selection.isNotEmpty(),
                                onOpen = { onOpen(s) },
                                onToggleSelect = { onToggleSelect(s) },
                            )
                        }
                        // selecting replaces the swipe: a row you are picking is
                        // not a row you are filing away
                        if (selection.isEmpty()) {
                            SwipeToArchive(onArchive = { onArchive(s) }) { row() }
                        } else {
                            row()
                        }
                    }
                }
            }
            }
        }
    }
    if (archivedOpen) {
        ArchivedDialog(
            archived = archived,
            onDismiss = { archivedOpen = false },
            onUnarchive = onUnarchive,
        )
    }
    if (importOpen) ImportDialog(
        importable,
        onPick = { confirmImport = it; importOpen = false },
        onDismiss = { importOpen = false },
    )
    confirmImport?.let { sel ->
        AlertDialog(
            onDismissRequest = { confirmImport = null },
            title = { Text("Fork to jep?") },
            text = {
                Text(
                    "\"${sel.title.ifBlank { sel.id }}\" is copied into jep as its own conversation. " +
                        "The original stays where it is, and the copy won't follow later changes there.",
                    fontSize = 13.sp,
                )
            },
            confirmButton = { TextButton(onClick = { onImport(sel); confirmImport = null }) { Text("Fork") } },
            dismissButton = { TextButton(onClick = { confirmImport = null }) { Text("Cancel") } },
        )
    }
}

// The sessions your own opencode has (in a folder jep serves) that jep doesn't:
// pick one to fork in.
@Composable
private fun ImportDialog(
    sessions: List<ImportableSession>?,
    onPick: (ImportableSession) -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Import external session") },
        text = {
            when {
                sessions == null -> Text("Looking…", fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                sessions.isEmpty() -> Text(
                    "Nothing to import — no sessions in your opencode that jep doesn't already have.",
                    fontSize = 14.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                else -> LazyColumn(Modifier.heightIn(max = 420.dp)) {
                    items(sessions.size) { i ->
                        val s = sessions[i]
                        Column(Modifier.fillMaxWidth().clickable { onPick(s) }.padding(vertical = 10.dp)) {
                            Text(s.title.ifBlank { s.id }, fontSize = 15.sp, color = MaterialTheme.colorScheme.onSurface, maxLines = 1)
                            Text(
                                // harness and where it lives — the two things
                                // that tell two same-titled sessions apart
                                (if (s.harness.isNotBlank()) "${s.harness} · " else "") +
                                    s.directory.trimEnd('/').split('/').takeLast(2).joinToString("/"),
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
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}

// Swipe a row left to file it away: it follows the finger, an Archive label
// fades in behind it, and past the threshold it's archived (hidden, not
// deleted). Springs back otherwise.
@Composable
private fun SwipeToArchive(onArchive: () -> Unit, content: @Composable () -> Unit) {
    val offset = remember { androidx.compose.animation.core.Animatable(0f) }
    val scope = rememberCoroutineScope()
    val threshold = -110f
    Box(
        Modifier.fillMaxWidth().pointerInput(Unit) {
            detectHorizontalDragGestures(
                onDragEnd = {
                    val fire = offset.value <= threshold
                    scope.launch { offset.animateTo(0f) }
                    if (fire) onArchive()
                },
                onDragCancel = { scope.launch { offset.animateTo(0f) } },
                onHorizontalDrag = { change, drag ->
                    change.consume()
                    scope.launch { offset.snapTo((offset.value + drag).coerceIn(threshold - 30f, 0f)) }
                },
            )
        },
    ) {
        if (offset.value < -1f) {
            Row(
                Modifier.align(Alignment.CenterEnd).padding(end = 18.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.Archive, "archive", tint = MaterialTheme.colorScheme.primary)
            }
        }
        Box(
            Modifier
                .fillMaxWidth()
                .offset { androidx.compose.ui.unit.IntOffset(offset.value.roundToInt(), 0) },
        ) { content() }
    }
}

// Swipe-to-archive was a one-way door: nothing listed what had been filed
// away, so restoring one meant guessing its id. This is that door, both ways.
@Composable
private fun ArchivedDialog(
    archived: List<SessionSummary>?,
    onDismiss: () -> Unit,
    onUnarchive: (SessionSummary) -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Archived") },
        text = {
            when {
                archived == null -> Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
                }
                archived.isEmpty() -> Text(
                    "Nothing is archived.",
                    fontSize = 13.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                else -> LazyColumn(Modifier.fillMaxWidth()) {
                    items(archived.size) { i ->
                        val s = archived[i]
                        Row(
                            Modifier.fillMaxWidth().padding(vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(s.title.ifEmpty { "Untitled" }, fontSize = 15.sp, maxLines = 1)
                                Text(
                                    s.adapter ?: s.workspace.substringAfterLast('/'),
                                    fontSize = 12.sp,
                                    fontFamily = JepMono,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1,
                                )
                            }
                            TextButton(onClick = { onUnarchive(s) }) { Text("Restore") }
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}

@Composable
@OptIn(ExperimentalFoundationApi::class)
private fun SessionRow(
    session: SessionSummary,
    unread: Boolean,
    selected: Boolean,
    selecting: Boolean,
    onOpen: () -> Unit,
    onToggleSelect: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth()
            // long-press starts a selection, the way a mail client does; once
            // anything is selected, a plain tap picks rather than opens
            .combinedClickable(
                onClick = { if (selecting) onToggleSelect() else onOpen() },
                onLongClick = { if (!selecting) onToggleSelect() },
            )
            .background(if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.10f) else Color.Transparent)
            .padding(horizontal = 18.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        HarnessAvatar(session.harness)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    session.title.ifEmpty { "Untitled" },
                    Modifier.weight(1f),
                    fontSize = 16.sp,
                    color = MaterialTheme.colorScheme.onBackground,
                    maxLines = 1,
                )
                Column(horizontalAlignment = Alignment.End) {
                    Text(
                        ago(session.updatedAt),
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    // The one mark a row can carry: working right now, or
                    // changed since it was last opened. The slot is always
                    // there — an empty box when neither — so nothing nudges the
                    // age, the title, or anything below it.
                    Box(Modifier.padding(top = 3.dp).size(9.dp), contentAlignment = Alignment.Center) {
                        when {
                            // Working reads as *alive*: it pulses, where unread is a
                            // still dot. Two green-ish dots that both just sat there
                            // said the same thing; the movement is the difference.
                            session.active -> LiveDot()
                            unread -> Icon(Icons.Filled.Circle, "unread", Modifier.fillMaxSize(), tint = MaterialTheme.colorScheme.primary)
                        }
                    }
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                // a pinned row says so where the eye already is, in the line
                // that describes it — not as another badge in the corner
                if (session.pinned) {
                    Icon(
                        Icons.Filled.PushPin,
                        "pinned",
                        Modifier.size(12.dp),
                        tint = MaterialTheme.colorScheme.primary,
                    )
                    Spacer(Modifier.width(5.dp))
                }
                Text(
                    // workspace, harness, and — when it spawned any — how many
                    // subagents it has (they're reachable from the conversation)
                    (
                        listOfNotNull(session.adapter ?: session.workspace.substringAfterLast('/').ifBlank { null }, session.harness)
                            .joinToString(" · ") +
                            if (session.subagents > 0) "  ·  ${session.subagents} subagent" + (if (session.subagents == 1) "" else "s") else ""
                        ),
                    fontSize = 13.sp,
                    fontFamily = JepMono,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                )
            }
        }
        // The tick lives at the row's end, where a picking hand reaches: the
        // left is the avatar's, and moving the mark away from the thing it
        // selects would reflow every title the moment select mode starts.
        if (selecting) {
            Spacer(Modifier.width(6.dp))
            Checkbox(checked = selected, onCheckedChange = { onToggleSelect() })
        }
    }
}

// The conversation's avatar is the harness behind it: the real brand mark,
// monochromised to one colour and tinted, so it sits quietly beside the title.
// An unknown harness falls back to a generic glyph rather than a blank circle.
@Composable
private fun HarnessAvatar(harness: String?) {
    val mark = when (harness) {
        "opencode" -> R.drawable.ic_harness_opencode
        "codex" -> R.drawable.ic_harness_codex
        "claude" -> R.drawable.ic_harness_claude
        else -> null
    }
    Box(
        Modifier.size(34.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceContainer),
        contentAlignment = Alignment.Center,
    ) {
        if (mark != null) {
            Icon(
                painterResource(mark),
                harness ?: "harness",
                Modifier.size(19.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            Icon(Icons.Filled.SmartToy, harness ?: "harness", Modifier.size(19.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

// the mark on a conversation that is working right now — the theme's "live"
// green, so it lifts in dark mode like the rest of the status colours

// A pulse, not a spinner: a progress ring is indeterminate work you cannot
// finish, while a slow glow is just "this is happening". One transition drives
// both the core and its halo, so the two never disagree.
@Composable
private fun LiveDot() {
    val transition = rememberInfiniteTransition(label = "live")
    val pulse by transition.animateFloat(
        initialValue = 0.35f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(850, easing = LinearEasing), RepeatMode.Reverse),
        label = "pulse",
    )
    val live = LocalSyntaxColors.current.live
    Box(
        Modifier.fillMaxSize().semantics { contentDescription = "running" },
        contentAlignment = Alignment.Center,
    ) {
        Icon(Icons.Filled.Circle, null, Modifier.fillMaxSize(), tint = live.copy(alpha = pulse * 0.30f))
        Icon(Icons.Filled.Circle, null, Modifier.size(5.dp), tint = live.copy(alpha = pulse))
    }
}

private fun ago(epoch: Long): String {
    val minutes = (System.currentTimeMillis() - epoch) / 60_000
    return when {
        minutes < 1 -> "now"
        minutes < 60 -> "${minutes}m"
        minutes < 60 * 24 -> "${minutes / 60}h"
        else -> "${minutes / (60 * 24)}d"
    }
}

/** the directory a conversation belongs to — the project it groups under.
 * Pods all group under one sentinel: a throwaway dir names no project. */
internal fun projectDir(s: SessionSummary): String =
    if (s.pod) PODS_PROJECT else s.workspace.ifBlank { s.adapter ?: "unknown" }

/**
 * The projects in the list, each with its conversations.
 *
 * A project's place is its newest conversation's — the folder you were in a
 * minute ago is first — except that a pinned conversation lifts its whole
 * project, so a pin is not buried a level down. Within a project the sessions
 * keep the daemon's order, which is already pinned first.
 */
internal fun groupedProjects(sessions: List<SessionSummary>): List<Pair<String, List<SessionSummary>>> =
    sessions.groupBy { projectDir(it) }.entries
        .sortedWith(
            compareByDescending<Map.Entry<String, List<SessionSummary>>> { e -> e.value.any { it.pinned } }
                .thenByDescending { e -> e.value.maxOf { it.updatedAt } },
        )
        .map { it.key to it.value }

/** what to call a project: the workspace's friendly name, else its folder name */
internal fun projectName(dir: String, sessions: List<SessionSummary>): String =
    if (dir == PODS_PROJECT) "Pods"
    else sessions.firstNotNullOfOrNull { it.adapter?.takeIf { a -> a.isNotBlank() } }
        ?: dir.trimEnd('/').substringAfterLast('/').ifBlank { dir }

// One row per project in the grouped view: the folder, how many conversations
// are in it, and the same live/unread marks a conversation row carries, rolled
// up so the project tells you whether anything in it needs you.
@Composable
private fun ProjectRow(
    name: String,
    dir: String,
    count: Int,
    unread: Boolean,
    active: Boolean,
    pinned: Boolean,
    onClick: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 18.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(34.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceContainer),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Filled.Folder, "project", Modifier.size(19.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (pinned) {
                    Icon(Icons.Filled.PushPin, "pinned", Modifier.size(12.dp), tint = MaterialTheme.colorScheme.primary)
                    Spacer(Modifier.width(5.dp))
                }
                Text(
                    name,
                    Modifier.weight(1f),
                    fontSize = 16.sp,
                    color = MaterialTheme.colorScheme.onBackground,
                    maxLines = 1,
                )
                // the same slot a conversation row keeps, so the marks line up
                Box(Modifier.padding(top = 3.dp).size(9.dp), contentAlignment = Alignment.Center) {
                    when {
                        active -> LiveDot()
                        unread -> Icon(Icons.Filled.Circle, "unread", Modifier.fillMaxSize(), tint = MaterialTheme.colorScheme.primary)
                    }
                }
            }
            Text(
                "$count conversation" + (if (count == 1) "" else "s"),
                fontSize = 13.sp,
                fontFamily = JepMono,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}
