package com.smsclicksender.app

import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlin.random.Random

/**
 * Runs on a WorkManager schedule (see MainActivity for the periodic
 * enqueue): polls the server for due phone-run schedules, sends each
 * contact's message via SmsManager, then reports the result back - the
 * whole point being that none of this needs a computer or the browser/
 * Electron app running anywhere.
 */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    private val notificationId = 1

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val prefs = Prefs(applicationContext)
        if (!prefs.isConfigured()) return@withContext Result.success()

        if (ActivityCompat.checkSelfPermission(applicationContext, Manifest.permission.SEND_SMS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            // Nothing we can do without the permission - the user needs to
            // open the app and grant it. Don't spam a notification on every
            // 15-minute tick; MainActivity already prompts for this on setup.
            return@withContext Result.success()
        }

        try {
            setForeground(foregroundInfo(applicationContext.getString(R.string.sync_notification_syncing)))
        } catch (e: Exception) {
            // Some OEMs/Android versions can refuse to promote to a
            // foreground service in edge cases (e.g. battery restrictions) -
            // that's not a reason to abandon the sync itself.
        }

        val client = ServerClient(prefs.serverUrl!!, prefs.password!!)
        val due = try {
            client.fetchDueSchedules()
        } catch (e: Exception) {
            return@withContext Result.retry()
        }

        if (due.isEmpty()) return@withContext Result.success()

        var totalSent = 0
        var totalFailed = 0

        for (schedule in due) {
            try {
                setForeground(
                    foregroundInfo(
                        applicationContext.getString(R.string.sync_notification_sending, schedule.label),
                    ),
                )
            } catch (e: Exception) {
                // Same as above - a notification issue shouldn't stop sends.
            }

            var sentCount = 0
            var failedCount = 0
            val payload = schedule.payload

            for ((index, row) in payload.rows.withIndex()) {
                val number = Template.normalizePhone(row[payload.phoneColumn])
                if (number.isEmpty()) {
                    failedCount++
                } else {
                    try {
                        val message = Template.render(payload.template, row)
                        SmsSender.send(applicationContext, number, message)
                        sentCount++
                    } catch (e: Exception) {
                        failedCount++
                    }
                }

                if (index < payload.rows.size - 1) {
                    delay(jitteredDelayMs(payload.delaySeconds))
                }
            }

            totalSent += sentCount
            totalFailed += failedCount

            try {
                client.ack(
                    scheduleId = schedule.id,
                    status = if (failedCount == 0) "success" else "failure",
                    sentCount = sentCount,
                    message = if (failedCount > 0) "$failedCount הודעות נכשלו (מתוך ${payload.rows.size})" else null,
                )
            } catch (e: Exception) {
                // The messages already went out - a failed ack just means
                // the server won't know this run happened, not that
                // anything failed to send. Not worth retrying the whole
                // schedule over.
            }
        }

        showResultNotification(totalSent, totalFailed)
        Result.success()
    }

    private fun jitteredDelayMs(delaySeconds: Double): Long {
        val base = (delaySeconds.coerceAtLeast(0.0)) * 1000
        val jitter = base * 0.2 * (Random.nextDouble() * 2 - 1)
        return (base + jitter).toLong().coerceAtLeast(500L)
    }

    private fun foregroundInfo(text: String): ForegroundInfo {
        val notification = NotificationCompat.Builder(applicationContext, SmsClickSenderApp.NOTIFICATION_CHANNEL_ID)
            .setContentTitle(applicationContext.getString(R.string.app_name))
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .build()

        return if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
            ForegroundInfo(notificationId, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            ForegroundInfo(notificationId, notification)
        }
    }

    private fun showResultNotification(sent: Int, failed: Int) {
        val text = if (failed == 0) {
            applicationContext.getString(R.string.sync_notification_done_ok, sent)
        } else {
            applicationContext.getString(R.string.sync_notification_done_with_failures, sent, failed)
        }
        val notification = NotificationCompat.Builder(applicationContext, SmsClickSenderApp.NOTIFICATION_CHANNEL_ID)
            .setContentTitle(applicationContext.getString(R.string.app_name))
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setAutoCancel(true)
            .build()
        try {
            val manager = applicationContext.getSystemService(NotificationManager::class.java)
            manager.notify(notificationId + 1, notification)
        } catch (e: Exception) {
            // Missing POST_NOTIFICATIONS permission shouldn't fail the job -
            // the ack to the server already recorded what actually happened.
        }
    }

    companion object {
        const val WORK_NAME = "sms-click-sender-sync"
    }
}
