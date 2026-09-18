package com.smsclicksender.app

import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * The FCM push itself carries no meaningful payload - it's just a "check
 * right now instead of waiting for the periodic schedule" wake-up, sent by
 * the CI publish step to the "app-updates" topic every time a new release
 * goes out (see build-android-app.yml). This simply triggers an immediate
 * UpdateCheckWorker run, which does its own real version comparison against
 * the manifest, rather than trusting whatever the push claims.
 */
class UpdatePushService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val request = OneTimeWorkRequestBuilder<UpdateCheckWorker>().build()
        WorkManager.getInstance(applicationContext)
            .enqueueUniqueWork(UpdateCheckWorker.WORK_NAME, ExistingWorkPolicy.REPLACE, request)
    }

    override fun onNewToken(token: String) {
        // Topic-based messaging (see SmsClickSenderApp.subscribeToUpdateTopic)
        // doesn't need individual device tokens tracked anywhere.
    }
}
