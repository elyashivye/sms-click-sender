// Thin client for the small scheduling API in server/index.js. For a
// desktop-run schedule (the default) the server only ever sees a label +
// timing - never contact lists or message text. A phone-run schedule is the
// deliberate exception: its payload (contacts + message) is sent here too,
// since that's the whole point (the Android app has nothing local to run
// from otherwise) - see server/index.js's file comment for the trade-off.

export class ScheduleApiError extends Error {}

async function parseOrThrow(res, fallbackMessage) {
  let data = {};
  try {
    data = await res.json();
  } catch {
    // ignore - non-JSON error response
  }
  if (!res.ok) throw new ScheduleApiError(data.error || fallbackMessage);
  return data;
}

function authHeaders(password) {
  return { Authorization: `Bearer ${password}` };
}

export async function getSetupStatus(serverUrl) {
  const res = await fetch(`${serverUrl}/api/setup/status`);
  return parseOrThrow(res, "לא ניתן להתחבר לשרת");
}

export async function setupPassword(serverUrl, password) {
  const res = await fetch(`${serverUrl}/api/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  return parseOrThrow(res, "שגיאה בהגדרת הסיסמה");
}

export async function login(serverUrl, password) {
  const res = await fetch(`${serverUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  return parseOrThrow(res, "התחברות נכשלה");
}

export async function listSchedules(serverUrl, password) {
  const res = await fetch(`${serverUrl}/api/schedules`, { headers: authHeaders(password) });
  const data = await parseOrThrow(res, "שגיאה בטעינת תזמונים");
  return data.schedules;
}

export async function createSchedule(serverUrl, password, { label, recurrence, runMode, payload }) {
  const res = await fetch(`${serverUrl}/api/schedules`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(password) },
    body: JSON.stringify({ label, recurrence, runMode, payload }),
  });
  const data = await parseOrThrow(res, "שגיאה ביצירת תזמון");
  return data.schedule;
}

export async function updateSchedule(serverUrl, password, id, patch) {
  const res = await fetch(`${serverUrl}/api/schedules/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders(password) },
    body: JSON.stringify(patch),
  });
  const data = await parseOrThrow(res, "שגיאה בעדכון תזמון");
  return data.schedule;
}

export async function deleteSchedule(serverUrl, password, id) {
  const res = await fetch(`${serverUrl}/api/schedules/${id}`, {
    method: "DELETE",
    headers: authHeaders(password),
  });
  return parseOrThrow(res, "שגיאה במחיקת תזמון");
}
