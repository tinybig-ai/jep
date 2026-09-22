package dev.jep.client

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.jep.client.domain.model.SessionSummary
import dev.jep.client.presentation.sessions.SessionsScreen
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SessionsScreenTest {

    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun each_row_carries_its_harness_mark() {
        val rows = listOf(
            SessionSummary("s1", "Chat", "", 0, 0, "jep", "opencode"),
            SessionSummary("s2", "Other", "", 0, 0, "morsel", "codex"),
        )
        rule.setContent {
            SessionsScreen(rows, busy = false, notice = null, onOpen = {}, onNew = {}, onRefresh = {}, onSettings = {}, onArchive = {}, importable = emptyList(), onLoadImportable = {}, onImport = {})
        }
        rule.onNodeWithContentDescription("opencode").assertExists()
        rule.onNodeWithContentDescription("codex").assertExists()
    }

    @Test
    fun a_conversation_that_is_working_right_now_is_marked() {
        val rows = listOf(
            SessionSummary("s1", "Working", "", 0, 0, "jep", "opencode", active = true),
            SessionSummary("s2", "Idle", "", 0, 0, "jep", "opencode"),
        )
        rule.setContent {
            SessionsScreen(rows, busy = false, notice = null, onOpen = {}, onNew = {}, onRefresh = {}, onSettings = {}, onArchive = {}, importable = emptyList(), onLoadImportable = {}, onImport = {})
        }
        // exactly one row carries the live mark
        rule.onAllNodesWithContentDescription("running").assertCountEquals(1)
    }

    @Test
    fun the_row_mark_is_either_unread_or_running_never_both() {
        val rows = listOf(
            SessionSummary("s1", "New reply", "", 0, 2, "jep", "opencode"),
            SessionSummary("s2", "Read", "", 0, 1, "jep", "opencode"),
            // changed *and* still working: the live state wins, one mark
            SessionSummary("s3", "Working", "", 0, 3, "jep", "opencode", active = true),
        )
        rule.setContent {
            SessionsScreen(rows, busy = false, notice = null, onOpen = {}, onNew = {}, onRefresh = {}, onSettings = {}, onArchive = {}, importable = emptyList(), onLoadImportable = {}, onImport = {}, unread = setOf("s1", "s3"))
        }
        rule.onAllNodesWithContentDescription("unread").assertCountEquals(1)
        rule.onAllNodesWithContentDescription("running").assertCountEquals(1)
    }

    @Test
    fun archived_conversations_can_be_restored() {
        val filed = listOf(SessionSummary("s9", "Old work", "/home/me/jep", 0, 0, "jep", "codex"))
        var restored: SessionSummary? = null
        rule.setContent {
            SessionsScreen(emptyList(), busy = false, notice = null, onOpen = {}, onNew = {}, onRefresh = {}, onSettings = {}, onArchive = {}, importable = emptyList(), onLoadImportable = {}, onImport = {}, archived = filed, onUnarchive = { restored = it })
        }
        rule.onNodeWithContentDescription("archived conversations").performClick()
        rule.onNodeWithText("Old work").assertExists()
        rule.onNodeWithText("Restore").performClick()
        assert(restored?.id == "s9") { "the row's restore must name the conversation" }
    }

    @Test
    fun long_press_picks_a_row() {
        var toggled: String? = null
        val rows = listOf(SessionSummary("s1", "Chat", "", 0, 0, "jep", "opencode"))
        rule.setContent {
            SessionsScreen(rows, busy = false, notice = null, onOpen = {}, onNew = {}, onRefresh = {}, onSettings = {}, onArchive = {}, importable = emptyList(), onLoadImportable = {}, onImport = {}, onToggleSelect = { toggled = it.id })
        }
        rule.onNodeWithText("Chat").performTouchInput { longClick() }
        assert(toggled == "s1") { "a long press must start a selection" }
    }

    @Test
    fun selecting_swaps_the_bar_for_the_actions() {
        var archived = false
        var marked: Boolean? = null
        val rows = listOf(SessionSummary("s1", "Chat", "", 0, 0, "jep", "opencode"))
        rule.setContent {
            SessionsScreen(rows, busy = false, notice = null, onOpen = {}, onNew = {}, onRefresh = {}, onSettings = {}, onArchive = {}, importable = emptyList(), onLoadImportable = {}, onImport = {}, selection = setOf("s1"), onArchiveSelected = { archived = true }, onMarkSelected = { marked = it })
        }
        rule.onNodeWithText("1 selected").assertExists()
        rule.onNodeWithContentDescription("archive selected").performClick()
        assert(archived) { "archive selected must reach the action" }
        rule.onNodeWithContentDescription("mark as unread").performClick()
        assert(marked == false) { "mark as unread must say which way" }
    }

    @Test
    fun an_archive_can_be_taken_back() {
        var undone = false
        val rows = listOf(SessionSummary("s1", "Chat", "", 0, 0, "jep", "opencode"))
        rule.setContent {
            SessionsScreen(rows, busy = false, notice = null, onOpen = {}, onNew = {}, onRefresh = {}, onSettings = {}, onArchive = {}, importable = emptyList(), onLoadImportable = {}, onImport = {}, undo = rows, onUndoArchive = { undone = true })
        }
        rule.onNodeWithText("Undo").performClick()
        assert(undone) { "the undo affordance must put the conversation back" }
    }

    @Test
    fun the_title_names_the_app_and_a_cold_load_spins() {
        rule.setContent {
            SessionsScreen(emptyList(), busy = true, notice = null, onOpen = {}, onNew = {}, onRefresh = {}, onSettings = {}, onArchive = {}, importable = emptyList(), onLoadImportable = {}, onImport = {})
        }
        rule.onNodeWithText("Jep").assertExists()
        rule.onNodeWithContentDescription("loading conversations").assertExists()
    }
}
