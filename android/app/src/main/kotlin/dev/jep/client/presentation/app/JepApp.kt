package dev.jep.client.presentation.app

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.jep.client.presentation.chat.ChatScreen
import dev.jep.client.presentation.chat.ChatViewModel
import dev.jep.client.presentation.newchat.NewChatScreen
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
        screen is Screen.NewChat -> {
            val ns by app.newChat.collectAsState()
            NewChatScreen(
                state = ns,
                onBack = { app.closeNewChat() },
                onTitle = { app.setNewTitle(it) },
                onHarness = { app.setNewHarness(it) },
                onSelectWorkspace = { name, harness -> app.selectWorkspace(name, harness) },
                onSelectPath = { app.selectPath(it) },
                onOpenBrowse = { app.openBrowse() },
                onCloseBrowse = { app.closeBrowse() },
                onBrowseInto = { app.browseInto(it) },
                onBrowseUp = { app.browseUp() },
                onCreate = { app.createConversation() },
            )
        }
        screen is Screen.Settings -> {
            val prefs by app.prefs.collectAsState()
            dev.jep.client.presentation.settings.SettingsScreen(
                theme = prefs.theme,
                terminalEnabled = prefs.terminalEnabled,
                backgroundStreaming = prefs.backgroundStreaming,
                terminalAccess = app.termAccess.collectAsState().value,
                gateway = app.gateway.collectAsState().value,
                onBack = { app.back() },
                onTheme = { app.setTheme(it) },
                onUnlockTerminal = { code, done -> app.enableTerminal(code, done) },
                onDisableTerminal = { app.disableTerminal() },
                onBackgroundStreaming = { app.setBackgroundStreaming(it) },
                onReconnect = { address, code, done -> app.reconnect(address, code, done) },
            )
        }
        screen is Screen.Chat -> {
            val c = screen as Screen.Chat
            val vm: ChatViewModel = viewModel(
                key = c.sessionId,
                factory = viewModelFactory {
                    initializer { ChatViewModel(app.chat(), c.sessionId, c.title, c.workspace, c.harness, { app.markRead(c.sessionId) }) }
                },
            )
            ChatScreen(
                vm,
                onBack = { app.back() },
                onNew = { app.openNewChat() },
                onForgetPairing = { app.forgetPairing() },
                terminalEnabled = app.prefs.collectAsState().value.terminalEnabled,
                onOpenSession = { app.open(it) },
                subagentCount = app.sessions.collectAsState().value.firstOrNull { it.id == c.sessionId }?.subagents ?: 0,
            )
        }
        else -> SessionsScreen(
            app.sessions.collectAsState().value,
            busy,
            notice,
            onOpen = { app.open(it) },
            onNew = { app.openNewChat() },
            onRefresh = { app.refresh() },
            onSettings = { app.openSettings() },
            importable = app.importable.collectAsState().value,
            onLoadImportable = { app.loadImportable() },
            onImport = { app.importSession(it.id) },
            onArchive = { app.archive(it) },
            unread = app.unread.collectAsState().value,
        )
    }
}
