package com.smsclicksender.app

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.google.firebase.messaging.FirebaseMessaging
import java.util.concurrent.TimeUnit

class SmsClickSenderApp : Application() {
    override fun onCreate() {
        super.onCreate()
        CrashLogger.install(this)
        createNotificationChannels()
        subscribeToUpdateTopic()
        enqueuePeriodicUpdateCheck()
    }

    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(
                NotificationChannel(
                    NOTIFICATION_CHANNEL_ID,
                    getString(R.string.notification_channel_name),
                    NotificationManager.IMPORTANCE_LOW,
                ),
            )
            manager.createNotificationChannel(
                NotificationChannel(
                    UPDATE_CHANNEL_ID,
                    getString(R.string.update_channel_name),
                    NotificationManager.IMPORTANCE_DEFAULT,
                ),
            )
        }
    }

    // Best-effort: devices without Google Play Services (some tablets,
    // custom ROMs) can't receive FCM at all - the periodic
    // UpdateCheckWorker below still covers updates for them either way.
    private fun subscribeToUpdateTopic() {
        try {
            FirebaseMessaging.getInstance().subscribeToTopic(UPDATE_TOPIC)
                .addOnFailureListener { /* periodic check still covers this */ }
        } catch (e: Exception) {
            // Same reasoning as above.
        }
    }

    private fun enqueuePeriodicUpdateCheck() {
        val request = PeriodicWorkRequestBuilder<UpdateCheckWorker>(12, TimeUnit.HOURS).build()
        WorkManager.getInstance(this)
            .enqueueUniquePeriodicWork(UpdateCheckWorker.WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    companion object {
        const val NOTIFICATION_CHANNEL_ID = "sync_channel"
        const val UPDATE_CHANNEL_ID = "update_channel"
        const val UPDATE_TOPIC = "app-updates"
    }
}
