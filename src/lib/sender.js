// Runs a batch of personalized sends (SMS or WhatsApp) and reports
// progress via a simple subscribe callback (no server/polling needed -
// everything runs in-tab).

import { AdbError, sendMessage } from "./adb-client.js";
import { normalizePhone } from "./excel.js";
import { toWhatsAppNumber } from "./phone.js";
import { render } from "./templating.js";

const DEFAULT_DELAY_SECONDS = 4;
const DEFAULT_COUNTRY_CODE = "972";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A little randomness so the gap between sends isn't a robotically exact
// interval every time - mainly relevant for WhatsApp, whose anti-spam
// systems watch for that kind of uniform pattern.
function jitteredDelayMs(seconds) {
  const base = Math.max(seconds, 0) * 1000;
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.max(500, Math.round(base + jitter));
}

export class SendJob {
  constructor(rows, template, phoneColumn, config) {
    this.rows = rows;
    this.template = template;
    this.phoneColumn = phoneColumn;
    this.config = config;
    this.status = "pending"; // pending -> running -> done | cancelled
    this.results = [];
    this.cancelRequested = false;
    this._listeners = new Set();
  }

  onUpdate(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _notify() {
    const snapshot = this.snapshot();
    for (const listener of this._listeners) listener(snapshot);
  }

  snapshot() {
    return {
      status: this.status,
      total: this.rows.length,
      completed: this.results.length,
      results: [...this.results],
    };
  }

  cancel() {
    this.cancelRequested = true;
  }

  async run() {
    this.status = "running";
    this._notify();

    const {
      adb,
      channel = "sms",
      countryCode = DEFAULT_COUNTRY_CODE,
      dryRun = false,
      delaySeconds = DEFAULT_DELAY_SECONDS,
      manualTap = null,
    } = this.config;

    for (const row of this.rows) {
      if (this.cancelRequested) {
        this.status = "cancelled";
        this._notify();
        return;
      }

      const message = render(this.template, row);
      const rawNumber = row[this.phoneColumn];
      const number = channel === "whatsapp" ? toWhatsAppNumber(rawNumber, countryCode) : normalizePhone(rawNumber);
      const entry = { number, message };

      if (!number) {
        entry.ok = false;
        entry.error = "מספר טלפון חסר או לא תקין";
      } else if (dryRun) {
        entry.ok = true;
        entry.dryRun = true;
      } else {
        try {
          await sendMessage(adb, channel, number, message, manualTap);
          entry.ok = true;
        } catch (err) {
          entry.ok = false;
          entry.error = err instanceof AdbError ? err.message : String(err?.message || err);
        }
      }

      this.results.push(entry);
      this._notify();

      if (!dryRun && !this.cancelRequested) {
        await sleep(jitteredDelayMs(delaySeconds));
      }
    }

    if (this.status === "running") {
      this.status = "done";
      this._notify();
    }
  }
}
