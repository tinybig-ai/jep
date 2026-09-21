package dev.jep.client.presentation.app

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.jep.client.presentation.chat.ChatScreen
import dev.jep.client.presentation.chat.ChatViewModel
import dev.jep.client.presentation.sessions.SessionsScreen

@Composable
fun JepApp(app: AppViewModel) {
    val paired by app.paired.collectAsState()
    val screen by app.screen.collectAsState()
    val busy by app.busy.collectAsState()
    val notice by app.notice.collectAsState()

    when {
        !paired -> dev.jep.client.presentation.pair.PairScreen(busy) { address, code, done ->
            app.pair(address, code, done)
        }
        screen is Screen.Chat -> {
            val c = screen as Screen.Chat
            val vm: ChatViewModel = viewModel(
                key = c.sessionId,
                factory = viewModelFactory { initializer { ChatViewModel(app.chat(), c.sessionId, c.title, c.workspace, c.harness) } },
            )
            ChatScreen(
                vm,
                onBack = { app.back() },
                onNew = { app.newSession() },
                onForgetPairing = { app.forgetPairing() },
            )
        }
        else -> SessionsScreen(
            app.sessions.collectAsState().value,
            app.workspaces.collectAsState().value,
            busy,
            notice,
            onOpen = { app.open(it) },
            onNew = { workspace -> app.newSession(workspace) },
            onRefresh = { app.refresh() },
        )
    }
}
