package dev.jep.client.presentation.pair

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// The gate. One-time claim of the gateway: its address and the pairing code
// printed at boot. After the token lands here, this screen never shows again.
@Composable
fun PairScreen(busy: Boolean, onPair: (address: String, code: String, done: (Boolean, String?) -> Unit) -> Unit) {
    var address by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var waiting by remember { mutableStateOf(false) }

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .imePadding()
                .padding(28.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(
                "jep",
                fontSize = 40.sp,
                color = MaterialTheme.colorScheme.onBackground,
                style = MaterialTheme.typography.displaySmall,
            )
            Text(
                "your coding agent, in your pocket",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontSize = 15.sp,
            )
            OutlinedTextField(
                value = address,
                onValueChange = { address = it },
                Modifier.fillMaxWidth(),
                label = { Text("gateway address") },
                placeholder = { Text("192.168.1.20:8931", fontFamily = FontFamily.Monospace) },
                singleLine = true,
            )
            OutlinedTextField(
                value = code,
                onValueChange = { code = it },
                Modifier.fillMaxWidth(),
                label = { Text("pairing code") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            )
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp) }
            Button(
                onClick = {
                    waiting = true
                    onPair(address, code.trim()) { ok, message ->
                        waiting = false
                        if (!ok) error = message
                    }
                },
                Modifier.fillMaxWidth(),
                enabled = !busy && !waiting,
            ) {
                Text(if (waiting) "pairing…" else "Connect")
            }
            Text(
                "The pairing code is printed once when the gateway starts on the machine running jep. "
                    + "The phone then keeps a private token — only this profile holds it.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontSize = 13.sp,
                lineHeight = 19.sp,
            )
        }
    }
}
