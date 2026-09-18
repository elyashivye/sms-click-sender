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

function authHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

// Only allowed for the small, fixed set of emails the server owner
// approved (ALLOWED_SIGNUP_EMAILS on the server) - anyone else gets a 403.
export async function signup(serverUrl, email, password) {
  const res = await fetch(`${serverUrl}/api/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return parseOrThrow(res, "שגיאה ביצירת החשבון");
}

// Returns { token, email } - the token (not the password) is what gets
// sent on every subsequent authenticated request.
export async function login(serverUrl, email, password) {
  const res = await fetch(`${serverUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return parseOrThrow(res, "התחברות נכשלה");
}

export async function logout(serverUrl, token) {
  const res = await fetch(`${serverUrl}/api/logout`, { method: "POST", headers: authHeaders(token) });
  return parseOrThrow(res, "שגיאה בהתנתקות");
}

export async function listSchedules(serverUrl, token) {
  const res = await fetch(`${serverUrl}/api/schedules`, { headers: authHeaders(token) });
  const data = await parseOrThrow(res, "שגיאה בטעינת תזמונים");
  return data.schedules;
}

export async function createSchedule(serverUrl, token, { label, recurrence, runMode, payload }) {
  const res = await fetch(`${serverUrl}/api/schedules`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(token) },
    body: JSON.stringify({ label, recurrence, runMode, payload }),
  });
  const data = await parseOrThrow(res, "שגיאה ביצירת תזמון");
  return data.schedule;
}

export async function updateSchedule(serverUrl, token, id, patch) {
  const res = await fetch(`${serverUrl}/api/schedules/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders(token) },
    body: JSON.stringify(patch),
  });
  const data = await parseOrThrow(res, "שגיאה בעדכון תזמון");
  return data.schedule;
}

export async function deleteSchedule(serverUrl, token, id) {
  const res = await fetch(`${serverUrl}/api/schedules/${id}`, {
    method: "DELETE",
    headers: authHeaders(token),
  });
  return parseOrThrow(res, "שגיאה במחיקת תזמון");
}
