package dev.jep.client.presentation.sessions

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
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.DataObject
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
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
) {
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
                title = { Text("jep") },
                actions = {
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
            LazyColumn(Modifier.fillMaxSize()) {
                items(sessions.size) { i ->
                    SessionRow(sessions[i], onOpen)
                }
            }
        }
    }
}

@Composable
private fun SessionRow(session: SessionSummary, onOpen: (SessionSummary) -> Unit) {
    Column(
        Modifier.fillMaxWidth()
            .clickable { onOpen(session) }
            .padding(horizontal = 18.dp, vertical = 13.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
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
            Spacer(Modifier.width(10.dp))
            HarnessBadge(session.harness)
        }
        Text(
            // the workspace's friendly name and its harness, not the raw path
            listOfNotNull(session.adapter ?: session.workspace.substringAfterLast('/').ifBlank { null }, session.harness)
                .joinToString(" · "),
            fontSize = 13.sp,
            fontFamily = FontFamily.Monospace,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
        )
    }
}

// The avatar for a conversation is the harness behind it. A harness names its
// own mark by id; unknown harnesses fall back to a generic one, so a new
// adapter is never a blank row. (Until adapters can ship artwork, these are
// glyphs the client owns.)
@Composable
private fun HarnessBadge(harness: String?) {
    val icon = when (harness) {
        "opencode" -> Icons.Filled.Terminal
        "codex" -> Icons.Filled.DataObject
        "claude" -> Icons.Filled.AutoAwesome
        else -> Icons.Filled.SmartToy
    }
    Box(
        Modifier.size(32.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceContainer),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, harness ?: "harness", Modifier.size(17.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
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
