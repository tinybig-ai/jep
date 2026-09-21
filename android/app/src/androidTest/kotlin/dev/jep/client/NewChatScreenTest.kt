package dev.jep.client

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.jep.client.domain.model.BrowseResult
import dev.jep.client.domain.model.DirEntry
import dev.jep.client.domain.model.Workspace
import dev.jep.client.presentation.app.NewChatState
import dev.jep.client.presentation.newchat.NewChatScreen
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

// The New Conversation view: creation-time workspace/harness control and the
// folder browser. These are the screens that regressed, so they get dr[awn] on
// a real device and driven for real.
@RunWith(AndroidJUnit4::class)
class NewChatScreenTest {

    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val root = BrowseResult(
        cwd = "/home/me",
        root = "/home/me",
        parent = null,
        dirs = listOf(DirEntry("Documents", false), DirEntry("repo", true)),
    )

    @Test
    fun a_folder_tap_descends_into_it() {
        var into: String? = null
        show(browsing = true, onBrowseInto = { into = it })
        rule.onNodeWithText("Documents").performClick()
        assertEquals("/home/me/Documents", into)
    }

    @Test
    fun back_in_the_browser_returns_to_the_form() {
        var closed = 0
        show(browsing = true, onCloseBrowse = { closed++ })
        back()
        assertEquals(1, closed)
    }

    @Test
    fun back_at_the_form_leaves_to_the_list() {
        var backed = 0
        show(browsing = false, onBack = { backed++ })
        back()
        assertEquals(1, backed)
    }

    @Test
    fun the_form_offers_every_harness_and_workspace() {
        show(browsing = false)
        rule.onNodeWithText("opencode  · default").assertExists()
        rule.onNodeWithText("codex").assertExists()
        rule.onNodeWithText("jep").assertExists()
    }

    @Test
    fun a_slow_first_listing_shows_a_spinner() {
        show(browsing = true, browse = null, loading = true)
        rule.onNodeWithText("Opening…").assertExists()
    }

    @Test
    fun descending_into_a_folder_shows_a_spinner_in_the_header() {
        show(browsing = true, browse = root, loading = true)
        rule.onNodeWithContentDescription("loading folders").assertExists()
    }

    @Test
    fun an_unreadable_folder_is_named_in_place() {
        show(browsing = true, error = "jep can't read that folder. On macOS give the daemon Full Disk Access.")
        rule.onNodeWithText("jep can't read that folder", substring = true).assertExists()
    }

    private fun show(
        browsing: Boolean,
        browse: BrowseResult? = if (browsing) root else null,
        loading: Boolean = false,
        error: String? = null,
        onBack: () -> Unit = {},
        onCloseBrowse: () -> Unit = {},
        onBrowseInto: (String) -> Unit = {},
    ) {
        val state = NewChatState(
            harness = "opencode",
            defaultHarness = "opencode",
            harnesses = listOf("opencode", "codex"),
            workspaces = listOf(Workspace("jep", "opencode", "/home/me/jep")),
            browse = browse,
            browsing = browsing,
            loadingBrowse = loading,
            error = error,
        )
        rule.setContent {
            NewChatScreen(
                state = state,
                onBack = onBack,
                onTitle = {},
                onHarness = {},
                onSelectWorkspace = {},
                onSelectPath = {},
                onOpenBrowse = {},
                onCloseBrowse = onCloseBrowse,
                onBrowseInto = onBrowseInto,
                onBrowseUp = {},
                onCreate = {},
            )
        }
    }

    private fun back() {
        rule.runOnUiThread { rule.activity.onBackPressedDispatcher.onBackPressed() }
        rule.waitForIdle()
    }
}
