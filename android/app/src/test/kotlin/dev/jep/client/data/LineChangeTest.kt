package dev.jep.client.data

import dev.jep.client.data.dto.PartDto
import dev.jep.client.domain.model.ChatPart
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

class LineChangeTest {

    @Test
    fun `an edit adds its new lines and removes its old ones`() {
        val input = buildJsonObject {
            put("oldString", JsonPrimitive("a\nb"))
            put("newString", JsonPrimitive("a\nb\nc\nd\ne"))
        }
        val tool = PartDto(kind = "tool", name = "edit", input = input).toDomain() as ChatPart.Tool
        assertEquals(5, tool.added)
        assertEquals(2, tool.removed)
    }
}
