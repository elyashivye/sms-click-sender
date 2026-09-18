package com.smsclicksender.app

import android.content.Context
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Downloads the latest APK to app-specific external storage (no extra
 * permission needed on API 26+, the project's minSdk) so it can be handed
 * to the system installer via FileProvider.
 */
object UpdateDownloader {
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()

    fun download(context: Context): File {
        val request = Request.Builder().url(ReleaseUrls.APK).build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IOException("הורדת העדכון נכשלה: ${response.code}")
            val body = response.body ?: throw IOException("תגובה ריקה מהשרת")
            val file = File(context.getExternalFilesDir(null), "update.apk")
            file.outputStream().use { out -> body.byteStream().copyTo(out) }
            return file
        }
    }
}
