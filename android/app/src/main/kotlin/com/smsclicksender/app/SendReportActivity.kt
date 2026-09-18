package com.smsclicksender.app

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.smsclicksender.app.databinding.ActivitySendReportBinding
import org.json.JSONArray
import org.json.JSONObject

data class RowResult(
    val scheduleLabel: String,
    val number: String,
    val success: Boolean,
    val error: String?,
)

/**
 * Shows the per-contact outcome of a manual foreground send (MainActivity's
 * "pull selected schedules, then send now" flow) - unlike the background
 * SyncWorker path, which only reports an aggregate count via notification,
 * this is the detailed, on-device-only report the user explicitly asked for.
 */
class SendReportActivity : AppCompatActivity() {
    private lateinit var binding: ActivitySendReportBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivitySendReportBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val results = decodeResults(intent.getStringExtra(EXTRA_RESULTS) ?: "[]")
        val sentCount = results.count { it.success }
        val failedCount = results.size - sentCount

        binding.summaryText.text = if (failedCount == 0) {
            getString(R.string.report_summary_all_ok, sentCount)
        } else {
            getString(R.string.report_summary_with_failures, sentCount, failedCount)
        }

        for (result in results) {
            addResultRow(result)
        }

        binding.closeButton.setOnClickListener { finish() }
    }

    private fun addResultRow(result: RowResult) {
        val row = TextView(this).apply {
            text = if (result.success) {
                getString(R.string.report_row_ok, result.number, result.scheduleLabel)
            } else {
                getString(R.string.report_row_failed, result.number, result.scheduleLabel, result.error ?: "")
            }
            setTextColor(
                ContextCompat.getColor(context, if (result.success) R.color.text_primary else R.color.error),
            )
            setPadding(24, 20, 24, 20)
            setBackgroundResource(R.drawable.bg_card)
            textSize = 13f
        }
        val params = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        )
        params.bottomMargin = 12
        row.layoutParams = params
        binding.resultsContainer.addView(row)
    }

    companion object {
        private const val EXTRA_RESULTS = "results"

        fun intent(context: Context, results: List<RowResult>): Intent =
            Intent(context, SendReportActivity::class.java).putExtra(EXTRA_RESULTS, encodeResults(results))

        private fun encodeResults(results: List<RowResult>): String {
            val array = JSONArray()
            for (r in results) {
                array.put(
                    JSONObject()
                        .put("scheduleLabel", r.scheduleLabel)
                        .put("number", r.number)
                        .put("success", r.success)
                        .put("error", r.error ?: JSONObject.NULL),
                )
            }
            return array.toString()
        }

        private fun decodeResults(json: String): List<RowResult> {
            val array = JSONArray(json)
            return (0 until array.length()).map { i ->
                val obj = array.getJSONObject(i)
                RowResult(
                    scheduleLabel = obj.getString("scheduleLabel"),
                    number = obj.getString("number"),
                    success = obj.getBoolean("success"),
                    error = if (obj.isNull("error")) null else obj.getString("error"),
                )
            }
        }
    }
}
