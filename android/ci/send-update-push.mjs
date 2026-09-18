// Sends a data-only FCM push to the "app-updates" topic, telling every
// installed copy of the Android app to check for a new version right now
// (see UpdatePushService.kt - it deliberately ignores this message's
// content and just re-checks android-version.json itself). Run from the
// build-android-app.yml publish job, after the new APK/manifest are
// already live on the release, so a device that wakes up on the push
// always finds the real thing waiting.
//
// Silently does nothing if FCM_SERVICE_ACCOUNT_KEY isn't set yet - that's
// the normal state until the project owner finishes the Firebase setup
// described in README.md; the release itself still publishes normally
// either way, and the app's own periodic UpdateCheckWorker fallback covers
// updates in the meantime.

const rawKey = process.env.FCM_SERVICE_ACCOUNT_KEY;
if (!rawKey) {
  console.log("FCM_SERVICE_ACCOUNT_KEY not set - skipping the update push (see README for setup steps).");
  process.exit(0);
}

const versionCode = process.env.VERSION_CODE;
if (!versionCode) {
  throw new Error("VERSION_CODE env var is required");
}

// Imported dynamically, after the env-var check above: a static top-level
// import is resolved before any of this code runs, so it would fail with
// "Cannot find package 'firebase-admin'" on every run where the workflow
// step skips installing it (the normal case, until FCM is configured).
const { initializeApp, cert } = await import("firebase-admin/app");
const { getMessaging } = await import("firebase-admin/messaging");

const serviceAccount = JSON.parse(rawKey);
initializeApp({ credential: cert(serviceAccount) });

await getMessaging().send({
  topic: "app-updates",
  data: {
    versionCode: String(versionCode),
  },
  android: {
    priority: "high",
  },
});

console.log(`Sent update push to topic "app-updates" for versionCode ${versionCode}`);
