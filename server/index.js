// Single Node app: serves the built website (dist/) as static files AND a
// small JSON API under /api/* for scheduled/recurring sends. For a
// "desktop"-run schedule (the default, and the only mode that existed
// before phone-run schedules), the API only ever stores scheduling
// metadata (label, timing, status) - never contact lists or message text,
// which stay local to whichever computer's Electron app has the phone
// plugged in. A "phone"-run schedule is the deliberate exception: the
// whole point is that no computer needs to be involved when it runs, so
// its contacts+message *do* get stored here so the Android app can pull
// them on its own. See README.md for the full picture and that trade-off.

import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import { hashPassword, verifyPassword } from "./auth.js";
import { readDb, updateDb } from "./db.js";
import { computeNextRun, validatePhonePayload, validateRecurrence } from "./schedule.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, "..", "dist");
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());

// Permissive CORS on the API only: the Electron app's renderer calls this
// server from a different origin (file://, or app://) and there's no
// session/cookie involved - the password bearer token is the real guard.
app.use("/api", (req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---------- setup / auth ----------

app.get("/api/setup/status", async (req, res) => {
  const db = await readDb();
  res.json({ configured: !!db.passwordHash });
});

app.post("/api/setup", async (req, res) => {
  const { password } = req.body || {};
  if (!password || String(password).length < 4) {
    return res.status(400).json({ error: "יש להגדיר סיסמה של לפחות 4 תווים" });
  }

  const db = await readDb();
  if (db.passwordHash) {
    return res.status(409).json({ error: "כבר הוגדרה סיסמה. אם שכחת אותה, מחקו את data/db.json בשרת." });
  }

  await updateDb((current) => ({ ...current, passwordHash: hashPassword(String(password)) }));
  res.json({ ok: true });
});

app.post("/api/login", async (req, res) => {
  const { password } = req.body || {};
  const db = await readDb();
  if (!db.passwordHash) return res.status(409).json({ error: "עדיין לא הוגדרה סיסמה" });
  if (!verifyPassword(String(password || ""), db.passwordHash)) {
    return res.status(401).json({ error: "סיסמה שגויה" });
  }
  res.json({ ok: true });
});

async function requireAuth(req, res, next) {
  const db = await readDb();
  if (!db.passwordHash) {
    return res.status(409).json({ error: "עדיין לא הוגדרה סיסמה בשרת" });
  }
  const header = req.get("authorization") || "";
  const password = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!verifyPassword(password, db.passwordHash)) {
    return res.status(401).json({ error: "לא מורשה - סיסמה שגויה או חסרה" });
  }
  req.db = db;
  next();
}

// ---------- schedules ----------

app.get("/api/schedules", requireAuth, async (req, res) => {
  // The list view never needs the actual contacts/message content (only
  // used when a phone-run schedule is fetched via /due) - strip it here so
  // a large contact list isn't re-sent on every schedules-page refresh.
  const schedules = req.db.schedules.map(({ payload, ...rest }) => rest);
  res.json({ schedules });
});

app.post("/api/schedules", requireAuth, async (req, res) => {
  const { label, recurrence, runMode, payload } = req.body || {};
  if (!label || !String(label).trim()) {
    return res.status(400).json({ error: "חסרה תווית לתזמון" });
  }
  const recurrenceError = validateRecurrence(recurrence);
  if (recurrenceError) return res.status(400).json({ error: recurrenceError });

  const resolvedRunMode = runMode === "phone" ? "phone" : "desktop";
  if (resolvedRunMode === "phone") {
    const payloadError = validatePhonePayload(payload);
    if (payloadError) return res.status(400).json({ error: payloadError });
  }

  const now = new Date();
  const schedule = {
    id: crypto.randomUUID(),
    label: String(label).trim(),
    recurrence,
    runMode: resolvedRunMode,
    // Only ever set for runMode "phone" - see the file-level comment above.
    payload: resolvedRunMode === "phone" ? payload : undefined,
    enabled: true,
    nextRunAt: computeNextRun(recurrence, now)?.toISOString() ?? null,
    lastRunAt: null,
    lastStatus: null,
    lastMessage: null,
    createdAt: now.toISOString(),
  };

  const next = await updateDb((db) => ({ ...db, schedules: [...db.schedules, schedule] }));
  res.status(201).json({ schedule: next.schedules.find((s) => s.id === schedule.id) });
});

app.patch("/api/schedules/:id", requireAuth, async (req, res) => {
  const { id } = req.params;
  const { label, recurrence, enabled } = req.body || {};

  if (recurrence !== undefined) {
    const recurrenceError = validateRecurrence(recurrence);
    if (recurrenceError) return res.status(400).json({ error: recurrenceError });
  }

  let found = false;
  const next = await updateDb((db) => ({
    ...db,
    schedules: db.schedules.map((s) => {
      if (s.id !== id) return s;
      found = true;
      const updated = { ...s };
      if (label !== undefined) updated.label = String(label).trim();
      if (enabled !== undefined) updated.enabled = !!enabled;
      if (recurrence !== undefined) {
        updated.recurrence = recurrence;
        updated.nextRunAt = computeNextRun(recurrence, new Date())?.toISOString() ?? null;
      }
      return updated;
    }),
  }));

  if (!found) return res.status(404).json({ error: "תזמון לא נמצא" });
  res.json({ schedule: next.schedules.find((s) => s.id === id) });
});

app.delete("/api/schedules/:id", requireAuth, async (req, res) => {
  const { id } = req.params;
  let found = false;
  await updateDb((db) => {
    const schedules = db.schedules.filter((s) => s.id !== id);
    found = schedules.length !== db.schedules.length;
    return { ...db, schedules };
  });
  if (!found) return res.status(404).json({ error: "תזמון לא נמצא" });
  res.json({ ok: true });
});

// Polled by two different runners, each asking only for its own kind:
// the Electron app (?runMode=desktop, the default) executes what comes
// back using the contact list/message content it already holds locally;
// the Android app (?runMode=phone) has nothing local at all, so its
// schedules come back with the actual payload inlined. Filtering by
// runMode here is what stops a desktop app from ever seeing (and wrongly
// failing) a phone-run schedule it has no local content for, and vice
// versa - each schedule belongs to exactly one runner.
app.get("/api/schedules/due", requireAuth, async (req, res) => {
  const runMode = req.query.runMode === "phone" ? "phone" : "desktop";
  const now = new Date();
  const due = req.db.schedules
    .filter((s) => s.runMode === runMode && s.enabled && s.nextRunAt && new Date(s.nextRunAt) <= now)
    .map((s) => (runMode === "phone" ? s : { ...s, payload: undefined }));
  res.json({ due });
});

// A single schedule's full record, payload included - unlike the list
// endpoint above, which strips it. Lets the Android app's manual "pull
// selected schedule(s) now" flow fetch exactly the schedule(s) the user
// checked, on demand, regardless of whether they're technically due yet
// (the whole point of that flow is user-driven control, not the
// recurrence timer).
app.get("/api/schedules/:id", requireAuth, async (req, res) => {
  const { id } = req.params;
  const schedule = req.db.schedules.find((s) => s.id === id);
  if (!schedule) return res.status(404).json({ error: "תזמון לא נמצא" });
  res.json({ schedule });
});

app.post("/api/schedules/:id/ack", requireAuth, async (req, res) => {
  const { id } = req.params;
  const { status, message, sentCount } = req.body || {};
  if (!["success", "failure"].includes(status)) {
    return res.status(400).json({ error: "status חייב להיות success או failure" });
  }

  let found = false;
  const now = new Date();
  const next = await updateDb((db) => ({
    ...db,
    schedules: db.schedules.map((s) => {
      if (s.id !== id) return s;
      found = true;
      const isOneOff = s.recurrence.type === "once";
      return {
        ...s,
        lastRunAt: now.toISOString(),
        lastStatus: status,
        lastMessage: message ? String(message).slice(0, 500) : sentCount != null ? `נשלחו ${sentCount} הודעות` : null,
        nextRunAt: isOneOff ? null : computeNextRun(s.recurrence, now)?.toISOString() ?? null,
        enabled: isOneOff ? false : s.enabled,
      };
    }),
  }));

  if (!found) return res.status(404).json({ error: "תזמון לא נמצא" });
  res.json({ schedule: next.schedules.find((s) => s.id === id) });
});

// ---------- static site ----------

app.use(express.static(DIST_DIR));

app.listen(PORT, () => {
  console.log(`SMS Click Sender server listening on port ${PORT}`);
});
