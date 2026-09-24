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
class FileKindTest {

    @Test
    fun `markdown opens rendered and wrapped`() {
        for (path in listOf("docs/PROCESSES.md", "readme.markdown", "notes.mdx")) {
            val kind = fileKindFor(path)
            assertEquals(FileEngine.Markdown, kind.engine)
            assertTrue(path, kind.renderByDefault)
            assertTrue(path, kind.wrapByDefault)
        }
    }

    @Test
    fun `code opens as source, unwrapped, so long lines keep their shape`() {
        for (path in listOf("src/app/tg.ts", "build.gradle.kts", "main.py", "styles.css", "a.json")) {
            val kind = fileKindFor(path)
            assertEquals(path, FileEngine.Code, kind.engine)
            assertFalse(path, kind.renderByDefault)
            assertFalse(path, kind.wrapByDefault)
        }
    }

    @Test
    fun `a diff reads as code, unwrapped`() {
        val kind = fileKindFor("changes.diff")
        assertEquals(FileEngine.Code, kind.engine)
        assertFalse(kind.wrapByDefault)
    }

    @Test
    fun `prose wraps`() {
        for (path in listOf("notes.txt", "server.log", "out/err.txt")) {
            val kind = fileKindFor(path)
            assertEquals(path, FileEngine.Text, kind.engine)
            assertTrue(path, kind.wrapByDefault)
        }
    }

    @Test
    fun `an unknown file is readable rather than clever`() {
        val kind = fileKindFor("LICENSE")
        assertEquals(FileEngine.Text, kind.engine)
        assertFalse(kind.renderByDefault)
    }

    @Test
    fun `the extension decides, not the case or the directory`() {
        assertEquals(FileEngine.Markdown, fileKindFor("Docs/Processes.MD").engine)
        assertEquals(FileEngine.Code, fileKindFor("a/b/c/My.File.KT").engine)
    }
}
