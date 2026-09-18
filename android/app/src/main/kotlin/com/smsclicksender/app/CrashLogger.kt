package com.smsclicksender.app

import android.content.Context
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Installs a global uncaught-exception handler that writes the crash's full
 * stack trace to a plain-text file before letting the OS's own crash
 * handling continue as normal - without this, a crash on a real device
 * leaves no trace anywhere for us to diagnose later (this app has no
 * connected debugger/logcat in normal use). Overwrites on every crash since
 * only the most recent one matters for chasing down a live bug report.
 */
object CrashLogger {
    private const val FILE_NAME = "crash_log.txt"

    fun install(context: Context) {
        val appContext = context.applicationContext
        val previousHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            try {
                writeLog(appContext, thread, throwable)
            } catch (e: Exception) {
                // Never let the logger itself block the real crash handling.
            }
            previousHandler?.uncaughtException(thread, throwable)
        }
    }

    private fun writeLog(context: Context, thread: Thread, throwable: Throwable) {
        val timestamp = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date())
        val stringWriter = StringWriter()
        throwable.printStackTrace(PrintWriter(stringWriter))
        val content = "זמן: $timestamp\nת׳רד: ${thread.name}\n\n$stringWriter"
        File(context.filesDir, FILE_NAME).writeText(content)
    }

    fun readLog(context: Context): String? {
        val file = File(context.filesDir, FILE_NAME)
        if (!file.exists()) return null
        return file.readText()
    }
}
