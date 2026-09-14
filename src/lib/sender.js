// Runs a batch of personalized SMS sends and reports progress via a simple
// subscribe callback (no server/polling needed - everything runs in-tab).

import { AdbError, sendSms } from "./adb-client.js";
import { normalizePhone } from "./excel.js";
import { render } from "./templating.js";

const DEFAULT_DELAY_SECONDS = 4;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

    const { adb, dryRun = false, delaySeconds = DEFAULT_DELAY_SECONDS, manualTap = null } = this.config;

    for (const row of this.rows) {
      if (this.cancelRequested) {
        this.status = "cancelled";
        this._notify();
        return;
      }

      const message = render(this.template, row);
      const number = normalizePhone(row[this.phoneColumn]);
      const entry = { number, message };

      if (!number) {
        entry.ok = false;
        entry.error = "מספר טלפון חסר או לא תקין";
      } else if (dryRun) {
        entry.ok = true;
        entry.dryRun = true;
      } else {
        try {
          await sendSms(adb, number, message, manualTap);
          entry.ok = true;
        } catch (err) {
          entry.ok = false;
          entry.error = err instanceof AdbError ? err.message : String(err?.message || err);
        }
      }

      this.results.push(entry);
      this._notify();

      if (!dryRun && !this.cancelRequested) {
        await sleep(delaySeconds * 1000);
      }
    }

    if (this.status === "running") {
      this.status = "done";
      this._notify();
    }
  }
}
