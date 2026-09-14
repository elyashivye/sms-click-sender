// Saves every row in the uploaded file as a phone contact, skipping anyone
// already saved (matched by normalized phone number) so re-running never
// creates duplicates. Mirrors SendJob's progress-callback pattern (sender.js)
// so the UI can reuse the same kind of progress bar / results table.

import { AdbError, createContact, listExistingPhoneNumbers } from "./adb-client.js";
import { normalizePhone } from "./excel.js";

// Native Android UI, not a messaging app someone could flag as a bot - a
// short fixed delay is only here to let one "Create contact" screen fully
// close before the next intent opens, not to look human.
const WAIT_BETWEEN_MS = 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SaveContactsJob {
  constructor(rows, nameColumn, phoneColumn, config) {
    this.rows = rows;
    this.nameColumn = nameColumn;
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

    const { adb, dryRun = false, manualTap = null } = this.config;

    // Queried once up front, then kept up to date locally as contacts are
    // created - this also dedupes against duplicate rows within the file
    // itself, not just against what was already on the phone.
    let existing = new Set();
    if (!dryRun) {
      try {
        existing = await listExistingPhoneNumbers(adb);
      } catch {
        existing = new Set();
      }
    }

    for (const row of this.rows) {
      if (this.cancelRequested) {
        this.status = "cancelled";
        this._notify();
        return;
      }

      const name = (row[this.nameColumn] ?? "").toString().trim();
      const number = normalizePhone(row[this.phoneColumn]);
      const entry = { name, number };

      if (!number) {
        entry.ok = false;
        entry.state = "failed";
        entry.error = "מספר טלפון חסר או לא תקין";
      } else if (existing.has(number)) {
        entry.ok = true;
        entry.state = "skipped";
      } else if (dryRun) {
        entry.ok = true;
        entry.state = "dryRun";
      } else {
        try {
          await createContact(adb, name || number, number, manualTap);
          entry.ok = true;
          entry.state = "created";
          existing.add(number);
        } catch (err) {
          entry.ok = false;
          entry.state = "failed";
          entry.error = err instanceof AdbError ? err.message : String(err?.message || err);
        }
      }

      this.results.push(entry);
      this._notify();

      if (!dryRun && !this.cancelRequested && entry.state !== "skipped") {
        await sleep(WAIT_BETWEEN_MS);
      }
    }

    if (this.status === "running") {
      this.status = "done";
      this._notify();
    }
  }
}
