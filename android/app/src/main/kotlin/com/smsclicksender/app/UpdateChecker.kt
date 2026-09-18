package com.smsclicksender.app

import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

data class UpdateInfo(val versionCode: Int, val versionName: String, val notes: String?)

/**
 * Fetches the small version manifest published alongside each Android
 * release (see build-android-app.yml) - a public GitHub release asset, not
 * our own server, so this needs no auth, same as the APK download itself.
 */
object UpdateChecker {
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    fun fetchLatest(): UpdateInfo? {
        val request = Request.Builder().url(ReleaseUrls.VERSION_MANIFEST).build()
        return try {
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return null
                val body = response.body?.string() ?: return null
                val json = JSONObject(body)
                UpdateInfo(
                    versionCode = json.getInt("versionCode"),
                    versionName = json.optString("versionName", ""),
                    notes = if (json.has("notes") && !json.isNull("notes")) json.getString("notes") else null,
                )
            }
        } catch (e: Exception) {
            null
        }
    }
}
