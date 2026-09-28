package dev.jep.client.presentation

import dev.jep.client.domain.model.SessionSummary
import dev.jep.client.presentation.sessions.groupedProjects
import dev.jep.client.presentation.sessions.projectDir
import dev.jep.client.presentation.sessions.projectName
import org.junit.Assert.assertEquals
import org.junit.Test

/** how the conversation list groups into projects when that is switched on */
class ProjectGroupingTest {
    private fun s(
        id: String,
        workspace: String = "",
        adapter: String? = null,
        updatedAt: Long = 0,
        pinned: Boolean = false,
    ) = SessionSummary(
        id = id,
        title = id,
        workspace = workspace,
        createdAt = 0,
        updatedAt = updatedAt,
        adapter = adapter,
        pinned = pinned,
    )

    @Test
    fun `a conversation groups under its workspace`() {
        assertEquals("/Users/me/jep", projectDir(s("a", workspace = "/Users/me/jep")))
    }

    @Test
    fun `with no workspace it groups under the adapter, then a last resort`() {
        assertEquals("claude", projectDir(s("a", adapter = "claude")))
        assertEquals("unknown", projectDir(s("a")))
    }

    @Test
    fun `a project is called the workspace's friendly name`() {
        val list = listOf(s("a", workspace = "/Users/me/jep", adapter = "opencode"))
        assertEquals("opencode", projectName("/Users/me/jep", list))
    }

    @Test
    fun `without a friendly name a project is called its folder`() {
        val list = listOf(s("a", workspace = "/Users/me/jep"))
        assertEquals("jep", projectName("/Users/me/jep", list))
    }

    @Test
    fun `conversations from one folder are one project`() {
        val projects = groupedProjects(
            listOf(
                s("a", workspace = "/x/jep"),
                s("b", workspace = "/x/other"),
                s("c", workspace = "/x/jep"),
            ),
        )
        assertEquals(listOf("/x/jep", "/x/other"), projects.map { it.first })
        assertEquals(listOf("a", "c"), projects[0].second.map { it.id })
    }

    @Test
    fun `a pinned conversation lifts its whole project above newer ones`() {
        val projects = groupedProjects(
            listOf(
                s("old", workspace = "/x/old", updatedAt = 10),
                s("new", workspace = "/x/new", updatedAt = 999),
                s("pinned", workspace = "/x/old", updatedAt = 5, pinned = true),
            ),
        )
        assertEquals(listOf("/x/old", "/x/new"), projects.map { it.first })
    }

    @Test
    fun `projects are ordered by their newest conversation`() {
        val projects = groupedProjects(
            listOf(
                s("a", workspace = "/x/one", updatedAt = 10),
                s("b", workspace = "/x/two", updatedAt = 999),
                s("c", workspace = "/x/one", updatedAt = 20),
            ),
        )
        assertEquals(listOf("/x/two", "/x/one"), projects.map { it.first })
    }
}
