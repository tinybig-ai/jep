package dev.jep.client.domain.model

/**
 * The person's text-size choice, a step under or over the system's own scale.
 * A factor rather than a size: the app has many sizes, and all of them move
 * together so the hierarchy never breaks.
 */
enum class TextSize(val label: String, val scale: Float) {
    EXTRA_SMALL("XS", 0.80f),
    SMALL("S", 0.88f),
    DEFAULT("M", 1f),
    LARGE("L", 1.12f),
    EXTRA_LARGE("XL", 1.25f),
    ;

    companion object {
        fun from(name: String?): TextSize = entries.firstOrNull { it.name == name } ?: DEFAULT
    }
}
