package com.smsclicksender.app

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
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

        binding.closeButton.setOnClickListener { finish() }
    }
}
