package com.smsclicksender.app

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

data class ScheduleSummary(
    val id: String,
    val label: String,
    val enabled: Boolean,
    val nextRunAt: String?,
    val lastRunAt: String?,
    val lastStatus: String?,
)

data class PhonePayload(
    val rows: List<Map<String, String>>,
    val template: String,
    val phoneColumn: String,
    val delaySeconds: Double,
)

data class DueSchedule(
    val id: String,
    val label: String,
    val payload: PhonePayload,
)

class ServerApiException(message: String) : Exception(message)

/**
 * Thin client for the same small scheduling API the website/desktop app
 * already talks to (server/index.js) - this app just polls
 * /api/schedules/due?runMode=phone instead of ?runMode=desktop, since it
 * has no local contact list/message of its own to fall back on.
 */
class ServerClient(serverUrl: String, private val password: String) {
    private val baseUrl = serverUrl.trimEnd('/')

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private val jsonMediaType = "application/json".toMediaType()

    private fun authorizedGet(path: String): Request =
        Request.Builder().url("$baseUrl$path").addHeader("Authorization", "Bearer $password").build()

    fun login() {
        val body = JSONObject().put("password", password).toString().toRequestBody(jsonMediaType)
        val request = Request.Builder().url("$baseUrl/api/login").post(body).build()
        client.newCall(request).execute().use { response ->
            val json = parseJsonOrEmpty(response)
            if (!response.isSuccessful) throw ServerApiException(json.optString("error", "התחברות נכשלה"))
        }
    }

    fun listPhoneSchedules(): List<ScheduleSummary> {
        client.newCall(authorizedGet("/api/schedules")).execute().use { response ->
            val json = parseJsonOrEmpty(response)
            if (!response.isSuccessful) throw ServerApiException(json.optString("error", "שגיאה בטעינת תזמונים"))
            val schedules = json.optJSONArray("schedules") ?: JSONArray()
            val result = mutableListOf<ScheduleSummary>()
            for (i in 0 until schedules.length()) {
                val s = schedules.getJSONObject(i)
                if (s.optString("runMode") != "phone") continue
                result.add(
                    ScheduleSummary(
                        id = s.getString("id"),
                        label = s.getString("label"),
                        enabled = s.optBoolean("enabled", true),
                        nextRunAt = s.optStringOrNull("nextRunAt"),
                        lastRunAt = s.optStringOrNull("lastRunAt"),
                        lastStatus = s.optStringOrNull("lastStatus"),
                    ),
                )
            }
            return result
        }
    }

    fun fetchDueSchedules(): List<DueSchedule> {
        client.newCall(authorizedGet("/api/schedules/due?runMode=phone")).execute().use { response ->
            val json = parseJsonOrEmpty(response)
            if (!response.isSuccessful) throw ServerApiException(json.optString("error", "שגיאה בבדיקת תזמונים"))
            val due = json.optJSONArray("due") ?: JSONArray()
            val result = mutableListOf<DueSchedule>()
            for (i in 0 until due.length()) {
                val s = due.getJSONObject(i)
                val payloadJson = s.optJSONObject("payload") ?: continue
                val rowsJson = payloadJson.optJSONArray("rows") ?: JSONArray()
                val rows = mutableListOf<Map<String, String>>()
                for (r in 0 until rowsJson.length()) {
                    val rowJson = rowsJson.getJSONObject(r)
                    val row = mutableMapOf<String, String>()
                    val keys = rowJson.keys()
                    while (keys.hasNext()) {
                        val key = keys.next()
                        row[key] = rowJson.optString(key, "")
                    }
                    rows.add(row)
                }
                result.add(
                    DueSchedule(
                        id = s.getString("id"),
                        label = s.getString("label"),
                        payload = PhonePayload(
                            rows = rows,
                            template = payloadJson.optString("template", ""),
                            phoneColumn = payloadJson.optString("phoneColumn", ""),
                            delaySeconds = payloadJson.optDouble("delaySeconds", 4.0),
                        ),
                    ),
                )
            }
            return result
        }
    }

    fun ack(scheduleId: String, status: String, sentCount: Int?, message: String?) {
        val bodyJson = JSONObject().put("status", status)
        if (sentCount != null) bodyJson.put("sentCount", sentCount)
        if (message != null) bodyJson.put("message", message)
        val body = bodyJson.toString().toRequestBody(jsonMediaType)
        val request = Request.Builder()
            .url("$baseUrl/api/schedules/$scheduleId/ack")
            .addHeader("Authorization", "Bearer $password")
            .post(body)
            .build()
        client.newCall(request).execute().close()
    }

    private fun parseJsonOrEmpty(response: Response): JSONObject {
        return try {
            JSONObject(response.body?.string() ?: "{}")
        } catch (e: Exception) {
            JSONObject()
        }
    }
}

private fun JSONObject.optStringOrNull(key: String): String? =
    if (has(key) && !isNull(key)) getString(key) else null
