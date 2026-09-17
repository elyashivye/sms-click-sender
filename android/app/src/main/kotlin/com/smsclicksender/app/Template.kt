package com.smsclicksender.app

/**
 * Mirrors src/lib/templating.js's render() and src/lib/excel.js's
 * normalizePhone() exactly, so a message renders identically whether it's
 * sent from the browser/desktop app or from here.
 */
object Template {
    private val PLACEHOLDER_RE = Regex("\\{([^{}]+)}")

    fun render(template: String, row: Map<String, String>): String {
        return PLACEHOLDER_RE.replace(template) { match ->
            val key = match.groupValues[1]
            row[key] ?: match.value
        }
    }

    fun normalizePhone(value: String?): String {
        if (value == null) return ""
        return value.replace(Regex("[^\\d+]"), "")
    }
}
