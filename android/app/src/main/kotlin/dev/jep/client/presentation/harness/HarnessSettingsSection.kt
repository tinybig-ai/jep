package dev.jep.client.presentation.harness

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jep.client.domain.model.HarnessSetting

/** Generic presentation for adapter-declared harness controls. */
@Composable
fun HarnessSettingsSection(
    options: List<HarnessSetting>,
    values: Map<String, Boolean>,
    onChange: (String, Boolean) -> Unit,
    title: String = "HARNESS OPTIONS",
) {
    if (options.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            title,
            Modifier.padding(top = 14.dp, bottom = 4.dp),
            fontSize = 10.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        options.forEach { option ->
            val checked = values[option.id] ?: option.default
            Row(
                // the whole row is the control, as every other settings row on
                // this screen is: a bare switch is a small target, and the label
                // explaining it was not tappable at all
                Modifier
                    .fillMaxWidth()
                    .toggleable(
                        value = checked,
                        role = Role.Switch,
                        onValueChange = { onChange(option.id, it) },
                    )
                    .padding(vertical = 7.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f).padding(end = 12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (option.danger) {
                            Icon(
                                Icons.Filled.Warning,
                                null,
                                Modifier.padding(end = 5.dp),
                                tint = MaterialTheme.colorScheme.error,
                            )
                        }
                        Text(
                            option.label,
                            fontSize = 14.sp,
                            color = if (option.danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                        )
                    }
                    Text(
                        option.description,
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                // presentational: the row above owns the toggle, so the switch
                // must not also fire and flip it back
                Switch(checked = checked, onCheckedChange = null)
            }
        }
    }
}
