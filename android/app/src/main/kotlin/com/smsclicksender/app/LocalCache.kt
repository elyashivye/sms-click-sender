package com.smsclicksender.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Local, on-device cache of a manually pulled batch (see MainActivity's
 * "pull selected schedules" flow) - lets pulling and sending be two
 * separate steps, and survives the app being closed and reopened before
 * the user actually sends. Plain internal storage (private to this app,
 * like all of Android's app-sandboxed files dir) - not Keystore-encrypted
 * like Prefs, since this is transient working data rather than a
 * long-lived credential.
 */
object LocalCache {
    private const val FILE_NAME = "pulled_schedules.json"

    fun save(context: Context, schedules: List<DueSchedule>) {
        val array = JSONArray()
        for (s in schedules) array.put(toJson(s))
        file(context).writeText(array.toString())
    }

    fun load(context: Context): List<DueSchedule> {
        val f = file(context)
        if (!f.exists()) return emptyList()
        return try {
            val array = JSONArray(f.readText())
            (0 until array.length()).map { fromJson(array.getJSONObject(it)) }
        } catch (e: Exception) {
            emptyList()
        }
    }

    fun clear(context: Context) {
        file(context).delete()
    }

    private fun file(context: Context) = File(context.filesDir, FILE_NAME)

    private fun toJson(s: DueSchedule): JSONObject {
        val rows = JSONArray()
        for (row in s.payload.rows) {
            val rowJson = JSONObject()
            for ((key, value) in row) rowJson.put(key, value)
            rows.put(rowJson)
        }
        val payload = JSONObject()
            .put("rows", rows)
            .put("template", s.payload.template)
            .put("phoneColumn", s.payload.phoneColumn)
            .put("delaySeconds", s.payload.delaySeconds)
        return JSONObject().put("id", s.id).put("label", s.label).put("payload", payload)
    }

    private fun fromJson(json: JSONObject): DueSchedule {
        val payloadJson = json.getJSONObject("payload")
        val rowsJson = payloadJson.getJSONArray("rows")
        val rows = (0 until rowsJson.length()).map { i ->
            val rowJson = rowsJson.getJSONObject(i)
            val row = mutableMapOf<String, String>()
            val keys = rowJson.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                row[key] = rowJson.optString(key, "")
            }
            row
        }
        return DueSchedule(
            id = json.getString("id"),
            label = json.getString("label"),
            payload = PhonePayload(
                rows = rows,
                template = payloadJson.optString("template", ""),
                phoneColumn = payloadJson.optString("phoneColumn", ""),
                delaySeconds = payloadJson.optDouble("delaySeconds", 4.0),
            ),
        )
    }
}
