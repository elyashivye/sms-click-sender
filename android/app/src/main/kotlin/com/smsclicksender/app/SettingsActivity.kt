package com.smsclicksender.app

import android.content.Intent
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import com.smsclicksender.app.databinding.ActivitySettingsBinding

class SettingsActivity : AppCompatActivity() {
    private lateinit var binding: ActivitySettingsBinding
    private lateinit var prefs: Prefs

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivitySettingsBinding.inflate(layoutInflater)
        setContentView(binding.root)
        prefs = Prefs(this)

        binding.backgroundSyncSwitch.isChecked = prefs.backgroundSyncEnabled
        binding.backgroundSyncSwitch.setOnCheckedChangeListener { _, isChecked ->
            prefs.backgroundSyncEnabled = isChecked
            if (isChecked) {
                if (prefs.isConfigured()) SyncScheduler.enqueuePeriodic(this)
            } else {
                SyncScheduler.cancelPeriodic(this)
            }
        }

        binding.currentVersionText.text = getString(R.string.settings_current_version, BuildConfig.VERSION_NAME)
        binding.checkUpdatesButton.setOnClickListener { handleCheckUpdates() }
        observeManualUpdateCheck()

        binding.shareCrashLogButton.setOnClickListener { handleShareCrashLog() }
        binding.closeButton.setOnClickListener { finish() }
    }

    private fun handleShareCrashLog() {
        val log = CrashLogger.readLog(this)
        if (log.isNullOrBlank()) {
            binding.updateStatusText.text = getString(R.string.status_no_crash_log)
            return
        }
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, log)
        }
        startActivity(Intent.createChooser(intent, getString(R.string.btn_share_crash_log)))
    }

    private fun handleCheckUpdates() {
        binding.updateStatusText.text = getString(R.string.status_checking_updates)
        val request = OneTimeWorkRequestBuilder<UpdateCheckWorker>().build()
        WorkManager.getInstance(this)
            .enqueueUniqueWork(MANUAL_UPDATE_CHECK_WORK_NAME, ExistingWorkPolicy.REPLACE, request)
    }

    private fun observeManualUpdateCheck() {
        WorkManager.getInstance(this)
            .getWorkInfosForUniqueWorkLiveData(MANUAL_UPDATE_CHECK_WORK_NAME)
            .observe(this) { infos ->
                val info = infos?.firstOrNull() ?: return@observe
                if (info.state.isFinished) {
                    binding.updateStatusText.text = getString(R.string.status_update_check_done)
                }
            }
    }

    companion object {
        private const val MANUAL_UPDATE_CHECK_WORK_NAME = "manual-update-check"
    }
}
