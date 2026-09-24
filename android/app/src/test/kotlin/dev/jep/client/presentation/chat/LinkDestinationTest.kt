package dev.jep.client.presentation.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Where a link in a message points.
 *
 * The domain concept is a plain relative markdown link — a file in this
 * conversation's workspace. On Android a bare path routes nowhere, so relative
 * targets get an address only this app answers, which is then handed the tap by
 * the platform. Absolute links are left exactly as they were: they already work.
 */
class LinkDestinationTest {

    @Test
    fun `absolute links are left for the platform`() {
        for (url in listOf(
            "https://example.com/x",
            "http://example.com",
            "mailto:a@b.com",
            "tel:+15550100",
            "//cdn.example.com/a.js",
        )) {
            assertEquals(url, linkDestination(url))
        }
    }

    @Test
    fun `a relative link becomes an address this app answers`() {
        assertEquals("jep://file?path=docs%2FPROCESSES.md", linkDestination("docs/PROCESSES.md"))
        assertEquals("jep://file?path=docs%2Fa.md", linkDestination("./docs/a.md"))
        assertEquals("jep://file?path=todo.md", linkDestination("todo.md"))
    }

    @Test
    fun `a fragment or a query does not travel with the path`() {
        assertEquals("jep://file?path=docs%2Fa.md", linkDestination("docs/a.md#section"))
        assertEquals("jep://file?path=docs%2Fa.md", linkDestination("docs/a.md?v=2"))
    }

    @Test
    fun `an in-document anchor is the renderer's business`() {
        assertNull(linkDestination("#section"))
    }

    @Test
    fun `nothing to point at`() {
        assertNull(linkDestination(""))
        assertNull(linkDestination("   "))
        assertNull(linkDestination("?only=query"))
    }

    @Test
    fun `only relative destinations are rewritten in a message`() {
        val md = "see [notes](docs/notes.md) and [the site](https://example.com) plus ![shot](img/a.png)"
        assertEquals(
            "see [notes](jep://file?path=docs%2Fnotes.md) and [the site](https://example.com) " +
                "plus ![shot](jep://file?path=img%2Fa.png)",
            withLocalLinks(md),
        )
    }

    @Test
    fun `a quoted title after a relative link survives`() {
        assertEquals(
            """[notes](jep://file?path=docs%2Fa.md "the notes")""",
            withLocalLinks("""[notes](docs/a.md "the notes")"""),
        )
    }

    @Test
    fun `text with no links is untouched`() {
        val md = "just prose, and `docs/a.md` in a code span, and a bare docs/a.md"
        assertEquals(md, withLocalLinks(md))
    }
}
