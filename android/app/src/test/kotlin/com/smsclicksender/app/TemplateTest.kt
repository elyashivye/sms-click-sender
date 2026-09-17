package com.smsclicksender.app

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Template.render()/normalizePhone() are Kotlin reimplementations of
 * src/lib/templating.js and src/lib/excel.js - these tests mirror the same
 * cases already covered there, so a message renders identically whether
 * it's sent from the browser/desktop app or from here.
 */
class TemplateTest {
    private val row = mapOf("שם" to "דוד", "עיר" to "ירושלים")

    @Test
    fun `render substitutes known placeholders`() {
        assertEquals("שלום דוד מירושלים", Template.render("שלום {שם} מ{עיר}", row))
    }

    @Test
    fun `render leaves unknown placeholders untouched`() {
        assertEquals("שלום {לא_קיים}", Template.render("שלום {לא_קיים}", row))
    }

    @Test
    fun `render handles an empty-string value`() {
        assertEquals("איש קשר: ", Template.render("איש קשר: {ריק}", mapOf("ריק" to "")))
    }

    @Test
    fun `render with no placeholders returns the template unchanged`() {
        assertEquals("הודעה רגילה בלי פרמטרים", Template.render("הודעה רגילה בלי פרמטרים", row))
    }

    @Test
    fun `normalizePhone strips dashes and spaces`() {
        assertEquals("0501234567", Template.normalizePhone("050-123 4567"))
    }

    @Test
    fun `normalizePhone keeps a leading plus`() {
        assertEquals("+972501234567", Template.normalizePhone("+972 50-123-4567"))
    }

    @Test
    fun `normalizePhone handles null`() {
        assertEquals("", Template.normalizePhone(null))
    }

    @Test
    fun `normalizePhone strips parentheses`() {
        assertEquals("0501234567", Template.normalizePhone("(050) 1234567"))
    }
}
