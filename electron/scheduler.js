// Background polling loop, running in the main process so it keeps working
// even while the window is hidden. It never touches the phone itself
// (WebUSB only exists in the renderer) - it asks the server what's due,
// asks the renderer to actually run each due job (which has the WebUSB
// connection and the locally stored contact list/template), then reports
// the result back to the server.

import { getLocalJob, getServerConfig } from "./store.js";

const POLL_INTERVAL_MS = 60_000;
const JOB_TIMEOUT_MS = 10 * 60 * 1000; // ceiling for one scheduled batch send

let pollTimer = null;
let requestCounter = 0;
const pendingRequests = new Map(); // requestId -> resolve()

export function startScheduler(getWindow) {
  stopScheduler();
  const runTick = () => tick(getWindow).catch((err) => console.error("[scheduler] tick failed:", err));
  pollTimer = setInterval(runTick, POLL_INTERVAL_MS);
  runTick();
}

export function stopScheduler() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

// Called from the ipcMain "job-result" handler when the renderer finishes
// running a job it was asked to run.
export function resolvePendingRequest(requestId, result) {
  const resolve = pendingRequests.get(requestId);
  if (!resolve) return;
  pendingRequests.delete(requestId);
  resolve(result);
}

async function tick(getWindow) {
  const config = getServerConfig();
  if (!config) return;

  let due;
  try {
    const res = await fetch(`${config.url}/api/schedules/due?runMode=desktop`, {
      headers: { Authorization: `Bearer ${config.token}` },
    });
    if (!res.ok) {
      console.error("[scheduler] GET /api/schedules/due ->", res.status);
      return;
    }
    ({ due } = await res.json());
  } catch (err) {
    console.error("[scheduler] could not reach server:", err.message || err);
    return;
  }

  for (const schedule of due) {
    await runOne(getWindow, config, schedule);
  }
}

async function runOne(getWindow, config, schedule) {
  const jobData = getLocalJob(schedule.id);
  let ackBody;

  if (!jobData) {
    ackBody = { status: "failure", message: "אין תוכן מקומי למחשב הזה עבור התזמון הזה" };
  } else {
    const win = getWindow();
    if (!win || win.isDestroyed()) {
      ackBody = { status: "failure", message: "חלון האפליקציה לא זמין" };
    } else {
      try {
        const result = await requestRunJob(win, schedule.id, jobData);
        ackBody = {
          status: result.ok ? "success" : "failure",
          sentCount: result.sentCount,
          message: result.error,
        };
      } catch (err) {
        ackBody = { status: "failure", message: String(err?.message || err) };
      }
    }
  }

  try {
    await fetch(`${config.url}/api/schedules/${schedule.id}/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
      body: JSON.stringify(ackBody),
    });
  } catch (err) {
    console.error("[scheduler] ack failed:", err.message || err);
  }
}

function requestRunJob(win, scheduleId, jobData) {
  const requestId = String(++requestCounter);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error("תם הזמן להרצת התזמון"));
    }, JOB_TIMEOUT_MS);

    pendingRequests.set(requestId, (result) => {
      clearTimeout(timer);
      resolve(result);
    });

    win.webContents.send("run-job", { requestId, scheduleId, jobData });
  });
}
