package com.smsclicksender.app

import android.content.Context
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * Central place for the two ways SyncWorker gets scheduled - shared between
 * MainActivity (connect / run-now) and SettingsActivity (the background-sync
 * toggle) so neither duplicates the WorkManager wiring.
 */
object SyncScheduler {
    const val MANUAL_WORK_NAME = "manual-sync"

    fun enqueuePeriodic(context: Context) {
        // 15 minutes is Android's own guaranteed minimum interval for
        // periodic WorkManager jobs - there's no way to poll more often
        // than that in the background.
        val request = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES).build()
        WorkManager.getInstance(context)
            .enqueueUniquePeriodicWork(SyncWorker.WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    fun cancelPeriodic(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(SyncWorker.WORK_NAME)
    }

    fun enqueueImmediate(context: Context) {
        val request = OneTimeWorkRequestBuilder<SyncWorker>().build()
        WorkManager.getInstance(context)
            .enqueueUniqueWork(MANUAL_WORK_NAME, ExistingWorkPolicy.REPLACE, request)
    }
}
