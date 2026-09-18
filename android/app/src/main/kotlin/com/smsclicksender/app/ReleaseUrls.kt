package com.smsclicksender.app

/**
 * Stable, tag-agnostic GitHub "latest release" download URLs - same pattern
 * the website's own download page already uses (see build-android-app.yml's
 * file comment), so these never need to change between versions.
 */
object ReleaseUrls {
    private const val BASE = "https://github.com/elyashivye/sms-click-sender/releases/latest/download"
    const val APK = "$BASE/SMS-Click-Sender.apk"
    const val VERSION_MANIFEST = "$BASE/android-version.json"
}
