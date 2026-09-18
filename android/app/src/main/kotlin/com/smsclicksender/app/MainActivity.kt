package com.smsclicksender.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.CheckBox
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import androidx.work.WorkManager
import com.smsclicksender.app.databinding.ActivityMainBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private lateinit var prefs: Prefs

    private val selectedScheduleIds = mutableSetOf<String>()
    private var pulledSchedules: List<DueSchedule> = emptyList()

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

        binding.settingsButton.setOnClickListener {
            startActivity(Intent(this, SettingsActivity::class.java))
        }
        binding.connectButton.setOnClickListener { handleConnect() }
        binding.disconnectButton.setOnClickListener { handleDisconnect() }
        binding.runNowButton.setOnClickListener { handleRunNow() }
        binding.pullSelectedButton.setOnClickListener { handlePullSelected() }
        binding.sendPulledButton.setOnClickListener { handleSendPulled() }

        if (prefs.isConfigured()) {
            binding.serverUrlInput.setText(prefs.serverUrl)
            binding.emailInput.setText(prefs.email)
            showConnectedUi(prefs.serverUrl!!, prefs.email!!)
            requestNeededPermissions()
            refreshSchedules()
            pulledSchedules = LocalCache.load(this)
            updatePulledUi()
        } else {
            binding.serverUrlInput.setText(DEFAULT_SERVER_URL)
        }

        observeManualRun()
    }

    private fun handleConnect() {
        val url = binding.serverUrlInput.text.toString().trim().trimEnd('/')
        val email = binding.emailInput.text.toString().trim()
        val password = binding.passwordInput.text.toString()
        val isSignup = binding.authModeSignup.isChecked
        if (url.isEmpty() || email.isEmpty() || password.isEmpty()) {
            binding.statusText.text = getString(R.string.hint_missing_fields)
            return
        }

        binding.statusText.text =
            getString(if (isSignup) R.string.status_creating_account else R.string.status_connecting)
        binding.connectButton.isEnabled = false

        lifecycleScope.launch {
            try {
                val token = withContext(Dispatchers.IO) {
                    if (isSignup) AccountClient.signup(url, email, password)
                    AccountClient.login(url, email, password)
                }
                prefs.serverUrl = url
                prefs.email = email
                prefs.token = token
                requestNeededPermissions()
                // Only the automatic mode (the default) starts anything on
                // its own - the manual mode chosen in Settings leaves
                // nothing running until the user pulls+sends by hand.
                if (prefs.backgroundSyncEnabled) {
                    SyncScheduler.enqueuePeriodic(this@MainActivity)
                    SyncScheduler.enqueueImmediate(this@MainActivity)
                }
                showConnectedUi(url, email)
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
        SyncScheduler.cancelPeriodic(this)
        pulledSchedules = emptyList()
        LocalCache.clear(this)
        selectedScheduleIds.clear()
        binding.passwordInput.setText("")
        binding.schedulesContainer.removeAllViews()
        binding.pullSelectedButton.visibility = View.GONE
        binding.pulledStatusText.visibility = View.GONE
        binding.sendPulledButton.visibility = View.GONE
        binding.statusText.text = getString(R.string.status_not_connected)
        binding.connectButton.visibility = View.VISIBLE
        binding.disconnectButton.visibility = View.GONE
        binding.runNowButton.visibility = View.GONE
    }

    private fun handleRunNow() {
        try {
            binding.statusText.text = getString(R.string.status_running_now)
            SyncScheduler.enqueueImmediate(this)
        } catch (e: Exception) {
            binding.statusText.text = "שגיאה בהפעלת הבדיקה: ${e.message}"
        }
    }

    private fun observeManualRun() {
        WorkManager.getInstance(this)
            .getWorkInfosForUniqueWorkLiveData(SyncScheduler.MANUAL_WORK_NAME)
            .observe(this) { infos ->
                val info = infos?.firstOrNull() ?: return@observe
                if (info.state.isFinished) {
                    binding.statusText.text = getString(R.string.status_run_now_done)
                    refreshSchedules()
                }
            }
    }

    private fun showConnectedUi(url: String, email: String) {
        binding.statusText.text = getString(R.string.status_connected, url, email)
        binding.connectButton.visibility = View.GONE
        binding.disconnectButton.visibility = View.VISIBLE
        binding.runNowButton.visibility = View.VISIBLE
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

    private fun refreshSchedules() {
        val url = prefs.serverUrl ?: return
        val token = prefs.token ?: return

        lifecycleScope.launch {
            try {
                val schedules = withContext(Dispatchers.IO) { ServerClient(url, token).listPhoneSchedules() }
                renderSchedules(schedules)
            } catch (e: Exception) {
                binding.schedulesContainer.removeAllViews()
                addInfoRow("שגיאה בטעינת תזמונים: ${e.message}")
            }
        }
    }

    private fun renderSchedules(schedules: List<ScheduleSummary>) {
        binding.schedulesContainer.removeAllViews()
        selectedScheduleIds.retainAll(schedules.map { it.id }.toSet())
        if (schedules.isEmpty()) {
            addInfoRow(getString(R.string.status_no_schedules))
            binding.pullSelectedButton.visibility = View.GONE
            return
        }
        for (schedule in schedules) {
            addScheduleCheckboxRow(schedule)
        }
        binding.pullSelectedButton.visibility = View.VISIBLE
        updatePullButtonEnabled()
    }

    private fun addScheduleCheckboxRow(s: ScheduleSummary) {
        val checkBox = CheckBox(this).apply {
            text = describeSchedule(s)
            isChecked = selectedScheduleIds.contains(s.id)
            setTextColor(ContextCompat.getColor(context, R.color.text_primary))
            setPadding(24, 20, 24, 20)
            setBackgroundResource(R.drawable.bg_card)
            setOnCheckedChangeListener { _, checked ->
                if (checked) selectedScheduleIds.add(s.id) else selectedScheduleIds.remove(s.id)
                updatePullButtonEnabled()
            }
        }
        val params = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        )
        params.bottomMargin = 16
        checkBox.layoutParams = params
        binding.schedulesContainer.addView(checkBox)
    }

    private fun updatePullButtonEnabled() {
        binding.pullSelectedButton.isEnabled = selectedScheduleIds.isNotEmpty()
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

    private fun handlePullSelected() {
        val url = prefs.serverUrl ?: return
        val token = prefs.token ?: return
        val ids = selectedScheduleIds.toList()
        if (ids.isEmpty()) return

        binding.pullSelectedButton.isEnabled = false
        binding.pulledStatusText.visibility = View.VISIBLE
        binding.pulledStatusText.text = getString(R.string.status_pulling)

        lifecycleScope.launch {
            try {
                val client = ServerClient(url, token)
                val fetched = withContext(Dispatchers.IO) { ids.map { id -> client.fetchSchedulePayload(id) } }
                pulledSchedules = fetched
                LocalCache.save(this@MainActivity, fetched)
                updatePulledUi()
            } catch (e: Exception) {
                binding.pulledStatusText.text = "שגיאה במשיכה: ${e.message}"
            } finally {
                binding.pullSelectedButton.isEnabled = true
            }
        }
    }

    private fun updatePulledUi() {
        if (pulledSchedules.isEmpty()) {
            binding.pulledStatusText.visibility = View.GONE
            binding.sendPulledButton.visibility = View.GONE
            return
        }
        val totalContacts = pulledSchedules.sumOf { it.payload.rows.size }
        binding.pulledStatusText.visibility = View.VISIBLE
        binding.pulledStatusText.text = getString(R.string.status_pulled_ready, pulledSchedules.size, totalContacts)
        binding.sendPulledButton.visibility = View.VISIBLE
    }

    // Sends the already-pulled, locally-cached batch right here in the
    // foreground while the user watches - deliberately not routed through
    // SyncWorker/WorkManager, since the whole point of this flow (versus
    // the automatic background mode) is a synchronous, watched send with a
    // detailed per-contact report at the end.
    private fun handleSendPulled() {
        val toSend = pulledSchedules
        if (toSend.isEmpty()) return
        val url = prefs.serverUrl
        val token = prefs.token

        binding.sendPulledButton.isEnabled = false
        binding.pullSelectedButton.isEnabled = false
        binding.pulledStatusText.text = getString(R.string.status_sending_foreground)

        lifecycleScope.launch {
            val results = mutableListOf<RowResult>()

            for (schedule in toSend) {
                var sentCount = 0
                var failedCount = 0
                val payload = schedule.payload

                for ((index, row) in payload.rows.withIndex()) {
                    binding.pulledStatusText.text = getString(
                        R.string.status_sending_progress,
                        schedule.label,
                        index + 1,
                        payload.rows.size,
                    )

                    val rawNumber = row[payload.phoneColumn] ?: ""
                    val number = Template.normalizePhone(rawNumber)
                    if (number.isEmpty()) {
                        failedCount++
                        results.add(
                            RowResult(
                                schedule.label,
                                rawNumber.ifBlank { "(ללא מספר)" },
                                false,
                                getString(R.string.error_missing_number),
                            ),
                        )
                    } else {
                        try {
                            val message = Template.render(payload.template, row)
                            withContext(Dispatchers.IO) { SmsSender.send(applicationContext, number, message) }
                            sentCount++
                            results.add(RowResult(schedule.label, number, true, null))
                        } catch (e: Exception) {
                            failedCount++
                            results.add(RowResult(schedule.label, number, false, e.message))
                        }
                    }

                    if (index < payload.rows.size - 1) {
                        delay(SendTiming.jitteredDelayMs(payload.delaySeconds))
                    }
                }

                if (url != null && token != null) {
                    try {
                        withContext(Dispatchers.IO) {
                            ServerClient(url, token).ack(
                                scheduleId = schedule.id,
                                status = if (failedCount == 0) "success" else "failure",
                                sentCount = sentCount,
                                message = if (failedCount > 0) {
                                    "$failedCount הודעות נכשלו (מתוך ${payload.rows.size})"
                                } else {
                                    null
                                },
                            )
                        }
                    } catch (e: Exception) {
                        // The messages already went out - a failed ack just
                        // means the server won't know this run happened.
                    }
                }
            }

            pulledSchedules = emptyList()
            LocalCache.clear(this@MainActivity)
            updatePulledUi()
            binding.pullSelectedButton.isEnabled = true
            refreshSchedules()

            startActivity(SendReportActivity.intent(this@MainActivity, results))
        }
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

    companion object {
        // This app is built for one specific deployment, not a generic
        // multi-server client - pre-filling the address means the user
        // only has to enter their own email+password, not also
        // remember/type a URL. Still an editable field in case the server
        // ever moves.
        private const val DEFAULT_SERVER_URL = "https://mediumpurple-stingray-338078.hostingersite.com"
    }
}
