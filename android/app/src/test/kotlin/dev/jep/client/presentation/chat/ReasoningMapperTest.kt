package dev.jep.client.presentation.chat

import dev.jep.client.data.toDomain
import dev.jep.client.data.dto.PartDto
import dev.jep.client.domain.model.ChatPart
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ReasoningMapperTest {
    @Test
    fun empty_provider_reasoning_does_not_become_an_empty_block() {
        assertNull(PartDto(kind = "reasoning", text = "").toDomain())
        assertNull(PartDto(kind = "reasoning", text = " \n ").toDomain())
    }

    @Test
    fun visible_provider_reasoning_keeps_its_text_and_duration() {
        assertEquals(
            ChatPart.Reasoning("considering the options", 1_500),
            PartDto(kind = "reasoning", text = "considering the options", durationMs = 1_500).toDomain(),
        )
    }
}
