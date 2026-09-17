// Recurrence shapes:
//   { type: "once",    at: ISOString }
//   { type: "daily",   time: "HH:MM" }
//   { type: "weekly",  time: "HH:MM", weekday: 0-6 }   // 0 = Sunday
//
// The server never "wakes itself up" - it just stores nextRunAt and
// recomputes it lazily whenever something asks (a due-jobs poll, or an ack
// after a run). This fits shared hosting fine: no background timer needed.

export function validateRecurrence(recurrence) {
  if (!recurrence || typeof recurrence !== "object") return "חסר תזמון";

  if (recurrence.type === "once") {
    const at = new Date(recurrence.at);
    if (Number.isNaN(at.getTime())) return "תאריך/שעה לא תקינים";
    return null;
  }

  if (recurrence.type === "daily" || recurrence.type === "weekly") {
    if (!/^\d{2}:\d{2}$/.test(recurrence.time || "")) return "שעה לא תקינה (פורמט HH:MM)";
    const [h, m] = recurrence.time.split(":").map(Number);
    if (h > 23 || m > 59) return "שעה לא תקינה";
    if (recurrence.type === "weekly") {
      const day = Number(recurrence.weekday);
      if (!Number.isInteger(day) || day < 0 || day > 6) return "יום בשבוע לא תקין";
    }
    return null;
  }

  return "סוג תזמון לא מוכר";
}

// Only validated when runMode is "phone" - a desktop-run schedule never
// carries a payload at all (see server/index.js). SMS-only for now: the
// phone app sends via Android's SmsManager, which has no WhatsApp
// equivalent, so there's no channel field to validate here.
export function validatePhonePayload(payload) {
  if (!payload || typeof payload !== "object") return "חסר תוכן לשליחה מהטלפון";
  if (!Array.isArray(payload.rows) || !payload.rows.length) return "רשימת אנשי הקשר ריקה";
  if (!payload.rows.every((row) => row && typeof row === "object")) return "רשימת אנשי הקשר לא תקינה";
  if (!payload.template || !String(payload.template).trim()) return "חסרה הודעה לשליחה";
  if (!payload.phoneColumn || !String(payload.phoneColumn).trim()) return "חסרה עמודת מספר טלפון";
  if (payload.delaySeconds !== undefined && (!Number.isFinite(payload.delaySeconds) || payload.delaySeconds < 0)) {
    return "השהיה בין הודעות לא תקינה";
  }
  return null;
}

export function computeNextRun(recurrence, after = new Date()) {
  if (recurrence.type === "once") {
    const at = new Date(recurrence.at);
    return at > after ? at : null;
  }

  const [hours, minutes] = recurrence.time.split(":").map(Number);

  if (recurrence.type === "daily") {
    const next = new Date(after);
    next.setHours(hours, minutes, 0, 0);
    if (next <= after) next.setDate(next.getDate() + 1);
    return next;
  }

  if (recurrence.type === "weekly") {
    const next = new Date(after);
    next.setHours(hours, minutes, 0, 0);
    let daysUntil = (recurrence.weekday - next.getDay() + 7) % 7;
    if (daysUntil === 0 && next <= after) daysUntil = 7;
    next.setDate(next.getDate() + daysUntil);
    return next;
  }

  throw new Error(`Unknown recurrence type: ${recurrence.type}`);
}
