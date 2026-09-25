package dev.jep.client.presentation.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The engine store: which reader a file gets, and what it opens as.
 *
 * Pure on purpose. The sheet's whole behaviour is "look up the path, then obey
 * the toggles", so pinning the mapping here is what keeps adding a format to one
 * line instead of a change in the UI.
 */
class FileEngineTest {

    @Test
    fun `markdown gets the rendered engine`() {
        for (path in listOf("docs/PROCESSES.md", "readme.markdown", "notes.mdx")) {
            assertEquals(path, FileEngine.Markdown, fileEngineFor(path))
        }
    }

    @Test
    fun `code opens as source, and still wraps`() {
        for (path in listOf("src/app/tg.ts", "build.gradle.kts", "main.py", "styles.css", "a.json")) {
            assertEquals(path, FileEngine.Code, fileEngineFor(path))
        }
    }

    @Test
    fun `a diff reads as code, and wraps too`() {
        assertEquals(FileEngine.Code, fileEngineFor("changes.diff"))
    }

    @Test
    fun `prose wraps`() {
        for (path in listOf("notes.txt", "server.log", "out/err.txt")) {
            assertEquals(path, FileEngine.Text, fileEngineFor(path))
        }
    }

    @Test
    fun `an unknown file is readable rather than clever`() {
        assertEquals(FileEngine.Text, fileEngineFor("LICENSE"))
    }

    @Test
    fun `the extension decides, not the case or the directory`() {
        assertEquals(FileEngine.Markdown, fileEngineFor("Docs/Processes.MD"))
        assertEquals(FileEngine.Code, fileEngineFor("a/b/c/My.File.KT"))
    }

}
