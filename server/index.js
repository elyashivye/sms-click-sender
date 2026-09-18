// Single Node app: serves the built website (dist/) as static files AND a
// small JSON API under /api/* for scheduled/recurring sends. Multi-user:
// each person creates their own account (POST /api/signup, gated by the
// ALLOWED_SIGNUP_EMAILS allowlist below) and every schedule belongs to
// exactly one user (ownerId) - nobody sees anyone else's schedules, even
// though they share one server/database.
//
// For a "desktop"-run schedule (the default, and the only mode that
// existed before phone-run schedules), the API only ever stores scheduling
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

import { generateToken, hashPassword, verifyPassword } from "./auth.js";
import { readDb, updateDb } from "./db.js";
import { computeNextRun, validatePhonePayload, validateRecurrence } from "./schedule.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, "..", "dist");
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());

// Permissive CORS on the API only: the Electron app's renderer calls this
// server from a different origin (file://, or app://) and there's no
// session/cookie involved - the session token is the real guard.
app.use("/api", (req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---------- accounts ----------

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

// Closed registration: only emails the server owner explicitly approved can
// ever create an account, even though the repo (and so this source file)
// is public - the actual list lives in an env var set on the host, never
// committed to git, so it never leaks who's allowed to sign up.
function allowedSignupEmails() {
  return String(process.env.ALLOWED_SIGNUP_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

app.post("/api/signup", async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const { password } = req.body || {};

  if (!email || !email.includes("@")) {
    return res.status(400).json({ error: "כתובת אימייל לא תקינה" });
  }
  if (!password || String(password).length < 4) {
    return res.status(400).json({ error: "יש לבחור סיסמה של לפחות 4 תווים" });
  }

  const allowed = allowedSignupEmails();
  if (!allowed.includes(email)) {
    return res.status(403).json({ error: "כתובת המייל הזו לא מורשית ליצור חשבון" });
  }

  const db = await readDb();
  if (db.users.some((u) => u.email === email)) {
    return res.status(409).json({ error: "כבר קיים חשבון עם המייל הזה" });
  }

  const user = {
    id: crypto.randomUUID(),
    email,
    passwordHash: hashPassword(String(password)),
    createdAt: new Date().toISOString(),
  };
  await updateDb((current) => ({ ...current, users: [...current.users, user] }));
  res.status(201).json({ ok: true });
});

app.post("/api/login", async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const { password } = req.body || {};

  const db = await readDb();
  const user = db.users.find((u) => u.email === email);
  if (!user || !verifyPassword(String(password || ""), user.passwordHash)) {
    return res.status(401).json({ error: "מייל או סיסמה שגויים" });
  }

  const token = generateToken();
  await updateDb((current) => ({
    ...current,
    sessions: [...current.sessions, { token, userId: user.id, createdAt: new Date().toISOString() }],
  }));
  res.json({ token, email: user.email });
});

async function requireAuth(req, res, next) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ error: "לא מורשה - יש להתחבר" });

  const db = await readDb();
  const session = db.sessions.find((s) => s.token === token);
  if (!session) return res.status(401).json({ error: "לא מורשה - יש להתחבר מחדש" });

  req.db = db;
  req.userId = session.userId;
  req.token = token;
  next();
}

app.post("/api/logout", requireAuth, async (req, res) => {
  await updateDb((current) => ({
    ...current,
    sessions: current.sessions.filter((s) => s.token !== req.token),
  }));
  res.json({ ok: true });
});

// ---------- schedules ----------

app.get("/api/schedules", requireAuth, async (req, res) => {
  // The list view never needs the actual contacts/message content (only
  // used when a phone-run schedule is fetched via /due) - strip it here so
  // a large contact list isn't re-sent on every schedules-page refresh.
  const schedules = req.db.schedules
    .filter((s) => s.ownerId === req.userId)
    .map(({ payload, ...rest }) => rest);
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
    ownerId: req.userId,
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
      if (s.id !== id || s.ownerId !== req.userId) return s;
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
    const schedules = db.schedules.filter((s) => {
      if (s.id === id && s.ownerId === req.userId) {
        found = true;
        return false;
      }
      return true;
    });
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
    .filter(
      (s) =>
        s.ownerId === req.userId &&
        s.runMode === runMode &&
        s.enabled &&
        s.nextRunAt &&
        new Date(s.nextRunAt) <= now,
    )
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
  const schedule = req.db.schedules.find((s) => s.id === id && s.ownerId === req.userId);
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
      if (s.id !== id || s.ownerId !== req.userId) return s;
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

// Vite gives every build's JS/CSS a unique content hash in the filename
// (e.g. index-CSCnGAg0.js) - once fetched under that exact name it never
// changes, so caching those aggressively is free performance. index.html
// itself keeps a fixed name and is what references those hashed
// filenames, so it must always be revalidated: without this, a phone that
// cached an old index.html keeps pointing at asset files a newer deploy
// already deleted (Vite's build wipes dist/ clean each time), and the
// page silently breaks - missing styles/JS - until the user manually
// clears their browser cache.
app.use(
  express.static(DIST_DIR, {
    setHeaders: (res, filePath) => {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  }),
);

app.listen(PORT, () => {
  console.log(`SMS Click Sender server listening on port ${PORT}`);
});
