package dev.jep.client.presentation.newchat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.FolderOpen
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jep.client.presentation.app.NewChatState

// New conversation — a full view, not a modal: a form where the workspace and
// the harness are the user's to choose before anything exists. The harness is
// fixed once the conversation is born, so it belongs here and nowhere else.
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun NewChatScreen(
    state: NewChatState,
    onBack: () -> Unit,
    onTitle: (String) -> Unit,
    onHarness: (String) -> Unit,
    onSelectWorkspace: (String) -> Unit,
    onSelectPath: (String) -> Unit,
    onOpenBrowse: () -> Unit,
    onCloseBrowse: () -> Unit,
    onBrowseInto: (String) -> Unit,
    onBrowseUp: () -> Unit,
    onCreate: () -> Unit,
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(if (state.browsing) "Choose a folder" else "New conversation") },
                navigationIcon = {
                    IconButton(onClick = if (state.browsing) onCloseBrowse else onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "back")
                    }
                },
            )
        },
    ) { pad ->
        Column(
            Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).padding(pad),
        ) {
            if (state.browsing) {
                Browser(state, onBrowseInto, onBrowseUp, onSelectPath)
            } else {
                Form(state, onTitle, onHarness, onSelectWorkspace, onOpenBrowse, onCreate)
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Form(
    state: NewChatState,
    onTitle: (String) -> Unit,
    onHarness: (String) -> Unit,
    onSelectWorkspace: (String) -> Unit,
    onOpenBrowse: () -> Unit,
    onCreate: () -> Unit,
) {
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
        item {
            OutlinedTextField(
                value = state.title,
                onValueChange = onTitle,
                Modifier.fillMaxWidth().padding(top = 8.dp),
                label = { Text("Title (optional)") },
                singleLine = true,
                shape = RoundedCornerShape(12.dp),
            )
        }

        item { SectionTitle("HARNESS") }
        item {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                state.harnesses.forEach { id ->
                    FilterChip(
                        selected = state.harness == id,
                        onClick = { onHarness(id) },
                        label = { Text(id + if (id == state.defaultHarness) "  · default" else "") },
                    )
                }
                if (state.harnesses.isEmpty()) {
                    Text("loading…", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }

        item { SectionTitle("WORKSPACE") }
        item {
            state.workspaces.forEach { w ->
                val selected = state.workspace == w.name && state.path == null
                SelectRow(
                    title = w.name,
                    subtitle = w.harness + (w.dir.takeIf { it.isNotBlank() }?.let { "  ·  $it" } ?: ""),
                    selected = selected,
                    onClick = { onSelectWorkspace(w.name) },
                )
            }
            SelectRow(
                title = "Browse folders…",
                subtitle = state.path ?: "pick any directory under the browse root",
                selected = state.path != null,
                onClick = onOpenBrowse,
                icon = { Icon(Icons.Filled.FolderOpen, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.primary) },
            )
        }

        item {
            state.error?.let {
                Text(it, Modifier.padding(top = 10.dp), color = MaterialTheme.colorScheme.error, fontSize = 13.sp)
            }
        }

        item {
            Button(
                onClick = onCreate,
                modifier = Modifier.fillMaxWidth().padding(vertical = 16.dp),
                enabled = !state.creating,
            ) {
                Text(if (state.creating) "Starting…" else "Create conversation")
            }
        }
    }
}

@Composable
private fun Browser(
    state: NewChatState,
    onBrowseInto: (String) -> Unit,
    onBrowseUp: () -> Unit,
    onSelectPath: (String) -> Unit,
) {
    val b = state.browse
    Column(Modifier.fillMaxSize().padding(horizontal = 12.dp)) {
        Text(
            b?.cwd ?: "…",
            Modifier.fillMaxWidth().padding(vertical = 8.dp),
            fontSize = 13.sp,
            fontFamily = FontFamily.Monospace,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 2,
        )
        LazyColumn(Modifier.weight(1f)) {
            if (b?.parent != null) {
                item {
                    SelectRow(
                        title = "⬆︎  Up",
                        subtitle = b.parent,
                        selected = false,
                        onClick = onBrowseUp,
                    )
                }
            }
            items(b?.dirs?.size ?: 0) { i ->
                val d = b!!.dirs[i]
                SelectRow(
                    title = (if (d.git) "📦  " else "📁  ") + d.name,
                    subtitle = if (d.git) "git repo" else null,
                    selected = false,
                    onClick = { onBrowseInto(joinPath(b.cwd, d.name)) },
                    icon = { Icon(Icons.Filled.Folder, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant) },
                )
            }
            if (b != null && b.dirs.isEmpty()) {
                item {
                    Text("(no sub-folders here)", Modifier.padding(16.dp), fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        state.error?.let {
            Text(it, Modifier.padding(vertical = 6.dp), color = MaterialTheme.colorScheme.error, fontSize = 13.sp)
        }
        Button(
            onClick = { b?.let { onSelectPath(it.cwd) } },
            modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp),
            enabled = b != null,
        ) {
            Text("Use this folder")
        }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text,
        Modifier.padding(top = 18.dp, bottom = 6.dp),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
private fun SelectRow(
    title: String,
    subtitle: String?,
    selected: Boolean,
    onClick: () -> Unit,
    icon: (@Composable () -> Unit)? = null,
) {
    Surface(
        Modifier.fillMaxWidth().padding(vertical = 3.dp).clickable(onClick = onClick),
        color = if (selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainer,
        shape = RoundedCornerShape(12.dp),
    ) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 11.dp), verticalAlignment = Alignment.CenterVertically) {
            icon?.let { Box(Modifier.padding(end = 10.dp)) { it() } }
            Column(Modifier.weight(1f)) {
                Text(title, fontSize = 15.sp, color = MaterialTheme.colorScheme.onSurface, maxLines = 1)
                subtitle?.let {
                    Text(it, fontSize = 12.sp, fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                }
            }
            if (selected) Text("✓", color = MaterialTheme.colorScheme.primary, fontSize = 16.sp)
        }
    }
}

private fun joinPath(dir: String, name: String): String =
    if (dir.endsWith("/")) "$dir$name" else "$dir/$name"
