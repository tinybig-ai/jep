package dev.jep.client.presentation.settings

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.DarkMode
import androidx.compose.material.icons.filled.LightMode
import androidx.compose.material.icons.filled.SettingsBrightness
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jep.client.device.ThemeMode

// App-wide settings — preferences that belong to the person, not to one
// conversation (that's the in-chat Settings panel). Theme lives here; so does
// whether the in-conversation terminal is offered.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    theme: ThemeMode,
    terminalEnabled: Boolean,
    gateway: String?,
    onBack: () -> Unit,
    onTheme: (ThemeMode) -> Unit,
    onTerminal: (Boolean) -> Unit,
) {
    BackHandler { onBack() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "back") }
                },
            )
        },
    ) { pad ->
        LazyColumn(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).padding(pad)) {
            item { SectionTitle("APPEARANCE") }
            item {
                ThemeRow("System", Icons.Filled.SettingsBrightness, theme == ThemeMode.SYSTEM) { onTheme(ThemeMode.SYSTEM) }
                ThemeRow("Light", Icons.Filled.LightMode, theme == ThemeMode.LIGHT) { onTheme(ThemeMode.LIGHT) }
                ThemeRow("Dark", Icons.Filled.DarkMode, theme == ThemeMode.DARK) { onTheme(ThemeMode.DARK) }
            }

            item { SectionTitle("FEATURES", top = 18.dp) }
            item {
                SwitchRow(
                    name = "In-chat terminal",
                    subtitle = "a shell in the conversation's folder, attached to the chat",
                    icon = Icons.Filled.Terminal,
                    checked = terminalEnabled,
                    onChange = onTerminal,
                )
            }

            item { SectionTitle("CONNECTION", top = 18.dp) }
            item {
                InfoRow("Gateway", gateway?.takeIf { it.isNotBlank() } ?: "not paired")
            }
        }
    }
}

@Composable
private fun SectionTitle(text: String, top: androidx.compose.ui.unit.Dp = 0.dp) {
    Text(
        text,
        Modifier.padding(start = 18.dp, end = 18.dp, top = top, bottom = 8.dp),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
private fun ThemeRow(label: String, icon: ImageVector, selected: Boolean, onPick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onPick).padding(horizontal = 18.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, Modifier.size(19.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(
            label,
            Modifier.weight(1f).padding(start = 14.dp),
            fontSize = 15.sp,
            color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
        )
        if (selected) Icon(Icons.Filled.Check, "selected", Modifier.size(18.dp), tint = MaterialTheme.colorScheme.primary)
    }
}

@Composable
private fun SwitchRow(
    name: String,
    subtitle: String?,
    icon: ImageVector,
    checked: Boolean,
    onChange: (Boolean) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, Modifier.size(19.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Column(Modifier.weight(1f).padding(start = 14.dp)) {
            Text(name, fontSize = 15.sp, color = MaterialTheme.colorScheme.onSurface)
            subtitle?.let {
                Text(it, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, fontSize = 15.sp, color = MaterialTheme.colorScheme.onSurface)
        Text(
            value,
            fontSize = 12.sp,
            fontFamily = FontFamily.Monospace,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
