package com.smsclicksender.app

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import java.io.File

/**
 * Builds the tap-to-install intent for a downloaded APK. Android always
 * requires this explicit user confirmation for an install from outside the
 * Play Store - even to update an already-installed app - so "one tap to
 * install" after a background download is the realistic ceiling here, not
 * a fully silent update.
 */
object UpdateInstaller {
    fun installPendingIntent(context: Context, apkFile: File): PendingIntent {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", apkFile)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        return PendingIntent.getActivity(
            context,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
