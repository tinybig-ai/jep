package dev.jep.client.presentation.sessions

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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.foundation.layout.offset
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.material.icons.filled.Archive
import kotlinx.coroutines.launch
import kotlin.math.roundToInt
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material.icons.filled.Link
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.jep.client.domain.model.ImportableSession
import androidx.compose.foundation.layout.offset
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import dev.jep.client.R
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jep.client.domain.model.SessionSummary

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
    importable: List<ImportableSession>?,
    onLoadImportable: () -> Unit,
    onImport: (ImportableSession) -> Unit,
) {
    var importOpen by remember { mutableStateOf(false) }
    var confirmImport by remember { mutableStateOf<ImportableSession?>(null) }
    Scaffold(
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = onNew,
                containerColor = MaterialTheme.colorScheme.primary,
                contentColor = MaterialTheme.colorScheme.onPrimary,
            ) {
                Icon(Icons.Filled.Add, null)
                Text(" New conversation")
            }
        },
    ) { pad ->
        Column(Modifier.fillMaxSize().padding(pad)) {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Image(
                            painterResource(R.mipmap.ic_launcher),
                            null,
                            Modifier.size(60.dp).clip(RoundedCornerShape(18.dp)),
                        )
                        Spacer(Modifier.width(12.dp))
                        Text("Jep")
                    }
                },
                actions = {
                    if (busy) {
                        CircularProgressIndicator(
                            Modifier.size(18.dp).padding(end = 6.dp),
                            strokeWidth = 2.dp,
                        )
                    }
                    IconButton(onClick = { importOpen = true; onLoadImportable() }) {
                        Icon(Icons.Filled.Link, "import a session", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    IconButton(onClick = onSettings) {
                        Icon(Icons.Filled.Settings, "settings", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    IconButton(onClick = onRefresh) {
                        Icon(Icons.Filled.Refresh, "refresh", tint = MaterialTheme.colorScheme.onSurfaceVariant)
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
            if (sessions.isEmpty() && busy) {
                Box(
                    Modifier.fillMaxSize().semantics { contentDescription = "loading conversations" },
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 3.dp)
                }
            } else {
                LazyColumn(Modifier.fillMaxSize()) {
                    items(sessions.size) { i ->
                        SwipeToArchive(onArchive = { onArchive(sessions[i]) }) {
                            SessionRow(sessions[i], onOpen)
                        }
                    }
                }
            }
        }
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
                                fontFamily = FontFamily.Monospace,
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
                Text("Archive", Modifier.padding(start = 8.dp), fontSize = 13.sp, color = MaterialTheme.colorScheme.primary)
            }
        }
        Box(
            Modifier
                .fillMaxWidth()
                .offset { androidx.compose.ui.unit.IntOffset(offset.value.roundToInt(), 0) },
        ) { content() }
    }
}

@Composable
private fun SessionRow(session: SessionSummary, onOpen: (SessionSummary) -> Unit) {
    Row(
        Modifier.fillMaxWidth()
            .clickable { onOpen(session) }
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
                Text(
                    ago(session.updatedAt),
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
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
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
            )
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

private fun ago(epoch: Long): String {
    val minutes = (System.currentTimeMillis() - epoch) / 60_000
    return when {
        minutes < 1 -> "now"
        minutes < 60 -> "${minutes}m"
        minutes < 60 * 24 -> "${minutes / 60}h"
        else -> "${minutes / (60 * 24)}d"
    }
}
