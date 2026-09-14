// Runs a batch of personalized sends (SMS, WhatsApp, or both) and reports
// progress via a simple subscribe callback (no server/polling needed -
// everything runs in-tab).

import { AdbError, sendMessage } from "./adb-client.js";
import { normalizePhone } from "./excel.js";
import { toWhatsAppNumber } from "./phone.js";
import { render } from "./templating.js";

const DEFAULT_DELAY_SECONDS = 4;
const DEFAULT_COUNTRY_CODE = "972";

// Occasional much-longer pause between WhatsApp sends, on top of the usual
// jitter - makes the overall rhythm look less like a fixed-interval script.
// Only applied to WhatsApp sends: plain SMS has no comparable anti-spam
// ban risk, so there's no reason to slow those runs down.
const LONG_PAUSE_CHANCE = 0.08;
const LONG_PAUSE_MIN_MS = 45_000;
const LONG_PAUSE_MAX_MS = 120_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomizedDelayMs(seconds, isWhatsApp) {
  const base = Math.max(seconds, 0) * 1000;
  if (isWhatsApp && Math.random() < LONG_PAUSE_CHANCE) {
    return LONG_PAUSE_MIN_MS + Math.random() * (LONG_PAUSE_MAX_MS - LONG_PAUSE_MIN_MS);
  }
  const jitterRatio = isWhatsApp ? 0.35 : 0.2;
  const jitter = base * jitterRatio * (Math.random() * 2 - 1);
  return Math.max(500, Math.round(base + jitter));
}

// A row can carry its own country-code column value (e.g. a contact list
// mixing Israeli and foreign numbers that both happen to use a leading 0
// locally) - that takes priority over the single default when present.
function resolveCountryCode(row, countryCodeColumn, defaultCountryCode) {
  if (countryCodeColumn) {
    const raw = (row[countryCodeColumn] ?? "").toString().trim();
    const digits = raw.replace(/\D/g, "");
    if (digits) return digits;
  }
  return defaultCountryCode;
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
    const perContact = this.config.channel === "both" ? 2 : 1;
    return {
      status: this.status,
      total: this.rows.length * perContact,
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
      countryCodeColumn = null,
      dryRun = false,
      delaySeconds = DEFAULT_DELAY_SECONDS,
      manualTap = null,
    } = this.config;

    const channelsToSend = channel === "both" ? ["sms", "whatsapp"] : [channel];

    for (const row of this.rows) {
      for (const ch of channelsToSend) {
        if (this.cancelRequested) {
          this.status = "cancelled";
          this._notify();
          return;
        }

        const message = render(this.template, row);
        const rawNumber = row[this.phoneColumn];
        const number =
          ch === "whatsapp"
            ? toWhatsAppNumber(rawNumber, resolveCountryCode(row, countryCodeColumn, countryCode))
            : normalizePhone(rawNumber);

        const entry = { number, message, channel: ch };

        if (!number) {
          entry.ok = false;
          entry.error = "מספר טלפון חסר או לא תקין";
        } else if (dryRun) {
          entry.ok = true;
          entry.dryRun = true;
        } else {
          try {
            await sendMessage(adb, ch, number, message, manualTap);
            entry.ok = true;
          } catch (err) {
            entry.ok = false;
            entry.error = err instanceof AdbError ? err.message : String(err?.message || err);
          }
        }

        this.results.push(entry);
        this._notify();

        if (!dryRun && !this.cancelRequested) {
          await sleep(randomizedDelayMs(delaySeconds, ch === "whatsapp"));
        }
      }
    }

    if (this.status === "running") {
      this.status = "done";
      this._notify();
    }
  }
}
