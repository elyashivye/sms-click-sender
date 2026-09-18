package com.smsclicksender.app

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * The two calls that happen before there's a session token yet - separate
 * from ServerClient, which needs a token for everything it does.
 */
object AccountClient {
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()
    private val jsonMediaType = "application/json".toMediaType()

    // Only succeeds for emails the server owner pre-approved
    // (ALLOWED_SIGNUP_EMAILS on the server) - anyone else gets a clear
    // error back.
    fun signup(serverUrl: String, email: String, password: String) {
        val baseUrl = serverUrl.trimEnd('/')
        val body = JSONObject().put("email", email).put("password", password).toString().toRequestBody(jsonMediaType)
        val request = Request.Builder().url("$baseUrl/api/signup").post(body).build()
        client.newCall(request).execute().use { response ->
            val json = parseJsonOrEmpty(response)
            if (!response.isSuccessful) throw ServerApiException(json.optString("error", "יצירת החשבון נכשלה"))
        }
    }

    // Returns a session token, stored (not the password) for every
    // subsequent authenticated request made through ServerClient.
    fun login(serverUrl: String, email: String, password: String): String {
        val baseUrl = serverUrl.trimEnd('/')
        val body = JSONObject().put("email", email).put("password", password).toString().toRequestBody(jsonMediaType)
        val request = Request.Builder().url("$baseUrl/api/login").post(body).build()
        client.newCall(request).execute().use { response ->
            val json = parseJsonOrEmpty(response)
            if (!response.isSuccessful) throw ServerApiException(json.optString("error", "מייל או סיסמה שגויים"))
            return json.getString("token")
        }
    }

    private fun parseJsonOrEmpty(response: Response): JSONObject {
        return try {
            JSONObject(response.body?.string() ?: "{}")
        } catch (e: Exception) {
            JSONObject()
        }
    }
}
