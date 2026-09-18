package com.smsclicksender.app

import android.app.NotificationManager
import android.content.Context
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Checks for a newer app version and, if found, downloads it and shows a
 * tap-to-install notification. Runs both on a periodic ~12h schedule (the
 * safety net - FCM delivery isn't 100% guaranteed: Doze mode, missing Play
 * Services, a force-stopped app) and immediately whenever an FCM update
 * push arrives (UpdatePushService) - the push is just a "check right now"
 * trigger, so both paths share this exact same logic instead of duplicating
 * it.
 */
class UpdateCheckWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val info = UpdateChecker.fetchLatest() ?: return@withContext Result.success()
        if (info.versionCode <= BuildConfig.VERSION_CODE) return@withContext Result.success()

        try {
            val apkFile = UpdateDownloader.download(applicationContext)
            showInstallNotification(info, apkFile)
        } catch (e: Exception) {
            return@withContext Result.retry()
        }

        Result.success()
    }

    private fun showInstallNotification(info: UpdateInfo, apkFile: File) {
        val pendingIntent = UpdateInstaller.installPendingIntent(applicationContext, apkFile)
        val notification = NotificationCompat.Builder(applicationContext, SmsClickSenderApp.UPDATE_CHANNEL_ID)
            .setContentTitle(applicationContext.getString(R.string.update_notification_title))
            .setContentText(applicationContext.getString(R.string.update_notification_text, info.versionName))
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .build()
        try {
            val manager = applicationContext.getSystemService(NotificationManager::class.java)
            manager.notify(NOTIFICATION_ID, notification)
        } catch (e: Exception) {
            // Missing POST_NOTIFICATIONS permission shouldn't fail the
            // download - the APK is already downloaded and sitting there,
            // this notification is just the convenient path to install it.
        }
    }

    companion object {
        const val WORK_NAME = "sms-click-sender-update-check"
        private const val NOTIFICATION_ID = 2
    }
}
