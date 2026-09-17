package com.smsclicksender.app

import android.content.Context
import android.os.Build
import android.telephony.SmsManager

/**
 * Sends via Android's own SmsManager - a real, official API (unlike the
 * uiautomator button-tapping the browser/desktop side has to use over ADB),
 * so this doesn't need to find or tap anything on screen. Only needs the
 * SEND_SMS runtime permission, not being the default SMS app.
 */
object SmsSender {
    fun send(context: Context, number: String, message: String) {
        val smsManager: SmsManager =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                context.getSystemService(SmsManager::class.java)
            } else {
                @Suppress("DEPRECATION")
                SmsManager.getDefault()
            }

        // divideMessage splits a long message into correctly-sized parts for
        // whatever the current SMS encoding is (GSM-7 vs UCS-2, the latter
        // being what Hebrew text uses, with a shorter 70-char-per-segment
        // limit) - sendMultipartTextMessage stitches them back together as
        // one multi-part message on the recipient's end.
        val parts = smsManager.divideMessage(message)
        smsManager.sendMultipartTextMessage(number, null, parts, null, null)
    }
}
