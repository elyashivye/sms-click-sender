package com.smsclicksender.app

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.smsclicksender.app.databinding.ActivityMainBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private lateinit var prefs: Prefs

    private val requestPermissions =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { results ->
            if (results[Manifest.permission.SEND_SMS] != true) {
                binding.statusText.text = getString(R.string.status_sms_permission_needed)
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        prefs = Prefs(this)

        binding.connectButton.setOnClickListener { handleConnect() }
        binding.disconnectButton.setOnClickListener { handleDisconnect() }
        binding.runNowButton.setOnClickListener { handleRunNow() }

        if (prefs.isConfigured()) {
            binding.serverUrlInput.setText(prefs.serverUrl)
            showConnectedUi(prefs.serverUrl!!)
            requestNeededPermissions()
            refreshSchedules()
        }

        observeManualRun()
    }

    private fun handleConnect() {
        val url = binding.serverUrlInput.text.toString().trim().trimEnd('/')
        val password = binding.passwordInput.text.toString()
        if (url.isEmpty() || password.isEmpty()) {
            binding.statusText.text = getString(R.string.hint_server_url)
            return
        }

        binding.statusText.text = getString(R.string.status_connecting)
        binding.connectButton.isEnabled = false

        lifecycleScope.launch {
            try {
                withContext(Dispatchers.IO) { ServerClient(url, password).login() }
                prefs.serverUrl = url
                prefs.password = password
                requestNeededPermissions()
                enqueuePeriodicSync()
                enqueueImmediateSync()
                showConnectedUi(url)
                refreshSchedules()
            } catch (e: Exception) {
                binding.statusText.text = "שגיאה: ${e.message}"
            } finally {
                binding.connectButton.isEnabled = true
            }
        }
    }

    private fun handleDisconnect() {
        prefs.clear()
        WorkManager.getInstance(this).cancelUniqueWork(SyncWorker.WORK_NAME)
        binding.passwordInput.setText("")
        binding.schedulesContainer.removeAllViews()
        binding.statusText.text = getString(R.string.status_not_connected)
        binding.connectButton.visibility = android.view.View.VISIBLE
        binding.disconnectButton.visibility = android.view.View.GONE
        binding.runNowButton.visibility = android.view.View.GONE
    }

    private fun handleRunNow() {
        binding.statusText.text = getString(R.string.status_running_now)
        enqueueImmediateSync()
    }

    private fun enqueueImmediateSync() {
        val request = OneTimeWorkRequestBuilder<SyncWorker>().build()
        WorkManager.getInstance(this)
            .enqueueUniqueWork("manual-sync", ExistingWorkPolicy.REPLACE, request)
    }

    private fun observeManualRun() {
        WorkManager.getInstance(this)
            .getWorkInfosForUniqueWorkLiveData("manual-sync")
            .observe(this) { infos ->
                val info = infos?.firstOrNull() ?: return@observe
                if (info.state.isFinished) {
                    binding.statusText.text = getString(R.string.status_run_now_done)
                    refreshSchedules()
                }
            }
    }

    private fun showConnectedUi(url: String) {
        binding.statusText.text = getString(R.string.status_connected, url)
        binding.connectButton.visibility = android.view.View.GONE
        binding.disconnectButton.visibility = android.view.View.VISIBLE
        binding.runNowButton.visibility = android.view.View.VISIBLE
    }

    private fun requestNeededPermissions() {
        val permissions = mutableListOf(Manifest.permission.SEND_SMS)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permissions.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        val alreadyGranted = permissions.all {
            ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
        }
        if (!alreadyGranted) requestPermissions.launch(permissions.toTypedArray())
    }

    private fun enqueuePeriodicSync() {
        // 15 minutes is Android's own guaranteed minimum interval for
        // periodic WorkManager jobs - there's no way to poll more often
        // than that in the background.
        val request = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES).build()
        WorkManager.getInstance(this)
            .enqueueUniquePeriodicWork(SyncWorker.WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    private fun refreshSchedules() {
        val url = prefs.serverUrl ?: return
        val password = prefs.password ?: return

        lifecycleScope.launch {
            try {
                val schedules = withContext(Dispatchers.IO) { ServerClient(url, password).listPhoneSchedules() }
                renderSchedules(schedules)
            } catch (e: Exception) {
                binding.schedulesContainer.removeAllViews()
                addInfoRow("שגיאה בטעינת תזמונים: ${e.message}")
            }
        }
    }

    private fun renderSchedules(schedules: List<ScheduleSummary>) {
        binding.schedulesContainer.removeAllViews()
        if (schedules.isEmpty()) {
            addInfoRow(getString(R.string.status_no_schedules))
            return
        }
        for (schedule in schedules) {
            addInfoRow(describeSchedule(schedule))
        }
    }

    private fun describeSchedule(s: ScheduleSummary): String {
        val statusPart = when {
            s.lastStatus == "success" -> "הצלחה"
            s.lastStatus == "failure" -> "כישלון"
            else -> "טרם רץ"
        }
        val enabledPart = if (s.enabled) "פעיל" else "מושבת"
        return "${s.label}\n$enabledPart · ריצה אחרונה: $statusPart"
    }

    private fun addInfoRow(text: String) {
        val row = TextView(this).apply {
            this.text = text
            setPadding(32, 24, 32, 24)
            setBackgroundResource(R.drawable.bg_card)
            setTextColor(ContextCompat.getColor(context, R.color.text_primary))
            textSize = 14f
            gravity = Gravity.START
        }
        val params = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        )
        params.bottomMargin = 24
        row.layoutParams = params
        binding.schedulesContainer.addView(row)
    }
}
