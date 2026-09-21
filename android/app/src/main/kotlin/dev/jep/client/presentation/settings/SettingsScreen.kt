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
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.ArrowDropUp
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.DarkMode
import androidx.compose.material.icons.filled.LightMode
import androidx.compose.material.icons.filled.SettingsBrightness
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jep.client.device.ThemeMode
import dev.jep.client.domain.model.TerminalAccess

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
    terminalAccess: TerminalAccess?,
    onUnlockTerminal: (String, (Boolean) -> Unit) -> Unit,
    onDisableTerminal: () -> Unit,
    onReconnect: (String, String, (Boolean) -> Unit) -> Unit,
) {
    BackHandler { onBack() }
    var codeOpen by remember { mutableStateOf(false) }
    var reconnectOpen by remember { mutableStateOf(false) }
    var howOpen by remember { mutableStateOf(false) }

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
                    subtitle = when {
                        terminalAccess?.allowed == false -> "not offered by this gateway"
                        terminalEnabled -> "a shell in the conversation's folder, attached to the chat"
                        else -> "enabling asks for the pairing code again"
                    },
                    icon = Icons.Filled.Terminal,
                    checked = terminalEnabled,
                    enabled = terminalAccess?.allowed != false,
                    onChange = { want -> if (want) codeOpen = true else onDisableTerminal() },
                )
            }
            if (terminalAccess?.allowed == false) {
                item {
                    Column(Modifier.padding(horizontal = 18.dp, vertical = 4.dp)) {
                        Text(
                            "This gateway does not allow a terminal.",
                            fontSize = 13.sp,
                            color = MaterialTheme.colorScheme.error,
                        )
                        Row(
                            Modifier.fillMaxWidth().clickable { howOpen = !howOpen }.padding(vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text("How to enable", fontSize = 13.sp, color = MaterialTheme.colorScheme.primary)
                            Icon(
                                if (howOpen) Icons.Filled.ArrowDropUp else Icons.Filled.ArrowDropDown,
                                "steps",
                                Modifier.size(18.dp),
                                tint = MaterialTheme.colorScheme.primary,
                            )
                        }
                        if (howOpen) {
                            Text(
                                "On the machine running jep:\n" +
                                    "1. put JEP_TERMINAL=1 in the daemon's EnvironmentVariables\n" +
                                    "   (~/Library/LaunchAgents/com.jep.tg.plist)\n" +
                                    "2. launchctl bootout gui/$(id -u)/com.jep.tg\n" +
                                    "   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jep.tg.plist\n" +
                                    "3. reopen Settings and enable it here.",
                                fontSize = 12.sp,
                                fontFamily = FontFamily.Monospace,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }

            item { SectionTitle("CONNECTION", top = 18.dp) }
            item {
                InfoRow(
                    "Gateway",
                    gateway?.takeIf { it.isNotBlank() } ?: "not paired — tap to set",
                    onClick = { reconnectOpen = true },
                )
            }
        }
    }

    if (codeOpen) TerminalUnlockDialog(
        onDismiss = { codeOpen = false },
        onSubmit = onUnlockTerminal,
    )
    if (reconnectOpen) ReconnectDialog(
        current = gateway,
        onDismiss = { reconnectOpen = false },
        onSubmit = onReconnect,
    )
}

// Changing the gateway means pointing at a different machine, and a machine's
// token is its own — so a reconnect always carries a fresh pairing code.
@Composable
private fun ReconnectDialog(
    current: String?,
    onDismiss: () -> Unit,
    onSubmit: (String, String, (Boolean) -> Unit) -> Unit,
) {
    var address by remember { mutableStateOf(current ?: "") }
    var code by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Change gateway") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "A different gateway is a different machine, so it needs its own pairing code — the one its daemon printed at start.",
                    fontSize = 13.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                OutlinedTextField(
                    value = address,
                    onValueChange = { address = it; error = null },
                    singleLine = true,
                    label = { Text("host:port") },
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = code,
                    onValueChange = { code = it; error = null },
                    singleLine = true,
                    label = { Text("Pairing code") },
                    modifier = Modifier.fillMaxWidth(),
                )
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp) }
            }
        },
        confirmButton = {
            TextButton(
                enabled = address.isNotBlank() && code.isNotBlank() && !busy,
                onClick = {
                    busy = true
                    onSubmit(address.trim(), code.trim()) { ok ->
                        busy = false
                        if (ok) onDismiss() else error = "couldn't reach or pair with that gateway"
                    }
                },
            ) { Text(if (busy) "Connecting…" else "Connect") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

// A shell is the one thing holding a device token shouldn't buy you, so it is
// gated behind the pairing code a second time — entered here, checked daemon-side.
@Composable
private fun TerminalUnlockDialog(onDismiss: () -> Unit, onSubmit: (String, (Boolean) -> Unit) -> Unit) {
    var code by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Enable terminal") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "A shell on this machine is powerful, so it asks for the pairing code again — the one shown when the gateway started.",
                    fontSize = 13.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                OutlinedTextField(
                    value = code,
                    onValueChange = { code = it; error = null },
                    singleLine = true,
                    label = { Text("Pairing code") },
                    modifier = Modifier.fillMaxWidth(),
                )
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp) }
            }
        },
        confirmButton = {
            TextButton(
                enabled = code.isNotBlank() && !busy,
                onClick = {
                    busy = true
                    onSubmit(code.trim()) { ok ->
                        busy = false
                        if (ok) onDismiss() else error = "that code didn't match"
                    }
                },
            ) { Text(if (busy) "Checking…" else "Enable") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
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
    enabled: Boolean = true,
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
        Switch(checked = checked, enabled = enabled, onCheckedChange = onChange)
    }
}

@Composable
private fun InfoRow(label: String, value: String, onClick: (() -> Unit)? = null) {
    Row(
        Modifier.fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 18.dp, vertical = 12.dp),
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
