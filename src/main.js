import "./style.css";
import { connect, isWebUsbSupported, reconnect } from "./lib/adb-client.js";
import { downloadSampleFile, guessPhoneColumn, parseContactsFile } from "./lib/excel.js";
import { SendJob } from "./lib/sender.js";
import * as schedulesApi from "./lib/schedules-client.js";
import { render, unknownPlaceholders } from "./lib/templating.js";

const state = {
  adb: null,
  headers: [],
  rows: [],
  phoneColumn: null,
  job: null,
  hasSentOnce: false,
  serverConfig: null, // { url, password } - only used in Electron
};

const el = (id) => document.getElementById(id);
const isElectron = () => typeof window.smsSender !== "undefined";

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------- Step 1: device ----------

function setConnectedUi(adb) {
  state.adb = adb;
  el("device-status").textContent = `מחובר: ${adb.serial}`;
  el("connect-btn").hidden = true;
  el("disconnect-btn").hidden = false;
  updateStepper();

  adb.disconnected.then(() => {
    if (state.adb === adb) {
      state.adb = null;
      el("device-status").textContent = "המכשיר התנתק.";
      el("connect-btn").hidden = false;
      el("disconnect-btn").hidden = true;
      updateStepper();
    }
  });
}

async function handleConnect() {
  const statusEl = el("device-status");
  statusEl.textContent = "מתחבר... אשרו את הבקשה בדפדפן, ואת בקשת ניפוי ה-USB במסך הטלפון אם תופיע.";
  try {
    setConnectedUi(await connect());
  } catch (err) {
    statusEl.textContent = "שגיאה: " + (err.message || err);
  }
}

async function handleDisconnect() {
  if (state.adb) {
    await state.adb.close();
    state.adb = null;
  }
  el("device-status").textContent = "מנותק.";
  el("connect-btn").hidden = false;
  el("disconnect-btn").hidden = true;
  updateStepper();
}

async function trySilentReconnect() {
  const adb = await reconnect();
  if (adb) setConnectedUi(adb);
}

// ---------- Step 2: upload ----------

async function handleFileChange(event) {
  const file = event.target.files[0];
  const statusEl = el("upload-status");
  if (!file) return;

  el("file-drop-label").textContent = file.name;
  statusEl.textContent = "קורא קובץ...";
  try {
    const { headers, rows } = await parseContactsFile(file);
    if (!headers.length || !rows.length) {
      statusEl.textContent = "הקובץ ריק, או שלא ניתן לקרוא ממנו נתונים.";
      return;
    }

    state.headers = headers;
    state.rows = rows;
    state.phoneColumn = guessPhoneColumn(headers);

    statusEl.textContent = `נטענו ${rows.length} אנשי קשר, ${headers.length} עמודות.`;

    const phoneSelect = el("phone-column-select");
    phoneSelect.innerHTML = "";
    headers.forEach((h) => {
      const opt = document.createElement("option");
      opt.value = h;
      opt.textContent = h;
      if (h === state.phoneColumn) opt.selected = true;
      phoneSelect.appendChild(opt);
    });
    el("phone-column-row").hidden = false;

    renderChips(headers);
    refreshPreview();
  } catch (err) {
    statusEl.textContent = "שגיאה בקריאת הקובץ: " + (err.message || err);
  }
}

function renderChips(headers) {
  const container = el("param-chips");
  container.innerHTML = "";
  headers.forEach((header) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = `{${header}}`;
    chip.addEventListener("click", () => insertAtCursor(`{${header}}`));
    container.appendChild(chip);
  });
}

function insertAtCursor(text) {
  const textarea = el("message-textarea");
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);
  textarea.value = before + text + after;
  const cursor = start + text.length;
  textarea.focus();
  textarea.setSelectionRange(cursor, cursor);
  refreshPreview();
}

// ---------- Step 4: preview ----------

function refreshPreview() {
  const template = el("message-textarea").value;
  const phoneColumn = el("phone-column-select").value || state.phoneColumn;
  const rows = state.rows;

  const hasData = rows.length > 0;
  el("preview-table").hidden = !hasData;
  el("preview-empty").hidden = hasData;

  if (hasData) {
    const preview = rows.slice(0, 20).map((row) => ({
      number: row[phoneColumn] || "",
      message: render(template, row),
    }));

    const tbody = document.querySelector("#preview-table tbody");
    tbody.innerHTML = preview
      .map(
        (row) =>
          `<tr><td class="number">${escapeHtml(row.number)}</td><td>${escapeHtml(row.message)}</td></tr>`
      )
      .join("");
  }

  const unknown = unknownPlaceholders(template, state.headers);
  el("preview-warning").textContent = unknown.length
    ? `שים לב: פרמטרים לא מוכרים בהודעה: ${unknown.map((p) => `{${p}}`).join(", ")}`
    : "";

  updateStepper();

  el("preview-count").textContent = rows.length
    ? `מוצגות עד 20 הודעות מתוך ${rows.length} אנשי קשר בקובץ.`
    : "";
}

// ---------- Step 5: send ----------

function currentSendConfig() {
  return {
    template: el("message-textarea").value,
    phoneColumn: el("phone-column-select").value || state.phoneColumn,
    delaySeconds: Number(el("delay-input").value) || 4,
    manualTap:
      el("manual-tap-x").value && el("manual-tap-y").value
        ? [Number(el("manual-tap-x").value), Number(el("manual-tap-y").value)]
        : null,
  };
}

async function handleSend() {
  const { template, phoneColumn, delaySeconds, manualTap } = currentSendConfig();
  const dryRun = el("dry-run-checkbox").checked;

  if (!state.rows.length) {
    alert("יש להעלות קובץ אנשי קשר קודם.");
    return;
  }
  if (!template.trim()) {
    alert("יש להזין הודעה לשליחה.");
    return;
  }
  if (!dryRun && !state.adb) {
    alert("יש להתחבר לטלפון לפני שליחה בפועל (או להשאיר את מצב הבדיקה מסומן).");
    return;
  }
  if (!dryRun && !confirm("פעולה זו תשלח הודעות SMS אמיתיות מהטלפון המחובר. להמשיך?")) {
    return;
  }

  const job = new SendJob(state.rows, template, phoneColumn, {
    adb: state.adb,
    dryRun,
    delaySeconds,
    manualTap,
  });
  state.job = job;

  el("send-btn").disabled = true;
  el("cancel-btn").hidden = false;
  el("progress-wrap").hidden = false;
  el("results-table").hidden = false;
  document.querySelector("#results-table tbody").innerHTML = "";

  job.onUpdate(renderJobStatus);
  await job.run();
}

function renderJobStatus(snapshot) {
  const pct = snapshot.total ? Math.round((snapshot.completed / snapshot.total) * 100) : 0;
  el("progress-fill").style.width = pct + "%";
  el("progress-text").textContent = `${snapshot.completed} / ${snapshot.total} (${snapshot.status})`;

  const tbody = document.querySelector("#results-table tbody");
  tbody.innerHTML = snapshot.results
    .map((r) => {
      const statusLabel = r.ok
        ? r.dryRun
          ? '<span class="status-ok">בדיקה בלבד</span>'
          : '<span class="status-ok">נשלח</span>'
        : `<span class="status-fail">נכשל: ${escapeHtml(r.error || "")}</span>`;
      return `<tr><td class="number">${escapeHtml(r.number)}</td><td>${escapeHtml(r.message)}</td><td>${statusLabel}</td></tr>`;
    })
    .join("");

  if (snapshot.status === "done" || snapshot.status === "cancelled") {
    el("send-btn").disabled = false;
    el("cancel-btn").hidden = true;
    if (snapshot.status === "done") state.hasSentOnce = true;
    updateStepper();
  }
}

function handleCancel() {
  state.job?.cancel();
}

// ---------- Step 6: schedules (Electron only) ----------

const RECURRENCE_LABELS = { once: "חד פעמי", daily: "כל יום", weekday: "", weekly: "כל שבוע" };
const WEEKDAY_NAMES = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

function describeRecurrence(recurrence) {
  if (recurrence.type === "once") return `${RECURRENCE_LABELS.once} - ${new Date(recurrence.at).toLocaleString("he-IL")}`;
  if (recurrence.type === "daily") return `${RECURRENCE_LABELS.daily} ב-${recurrence.time}`;
  if (recurrence.type === "weekly") return `${RECURRENCE_LABELS.weekly}, ${WEEKDAY_NAMES[recurrence.weekday]} ב-${recurrence.time}`;
  return "";
}

function formatDate(iso) {
  return iso ? new Date(iso).toLocaleString("he-IL") : "-";
}

function readRecurrenceFromForm() {
  const type = el("sched-type").value;
  if (type === "once") {
    const value = el("sched-once-at").value;
    if (!value) throw new Error("יש לבחור תאריך ושעה");
    return { type: "once", at: new Date(value).toISOString() };
  }
  if (type === "daily") {
    return { type: "daily", time: el("sched-daily-time").value };
  }
  return { type: "weekly", time: el("sched-weekly-time").value, weekday: Number(el("sched-weekly-day").value) };
}

function updateScheduleTypeFields() {
  const type = el("sched-type").value;
  el("sched-once-fields").hidden = type !== "once";
  el("sched-daily-fields").hidden = type !== "daily";
  el("sched-weekly-fields").hidden = type !== "weekly";
}

async function loadServerConfig() {
  state.serverConfig = await window.smsSender.getServerConfig();
  if (state.serverConfig) {
    el("sched-server-url").value = state.serverConfig.url;
    await showSchedulesMain();
  }
}

async function handleSchedConnect() {
  const statusEl = el("sched-setup-status");
  const url = el("sched-server-url").value.trim().replace(/\/+$/, "");
  const password = el("sched-password").value;

  if (!url || !password) {
    statusEl.textContent = "יש למלא כתובת שרת וסיסמה.";
    return;
  }

  statusEl.textContent = "בודק...";
  try {
    const { configured } = await schedulesApi.getSetupStatus(url);
    if (!configured) {
      await schedulesApi.setupPassword(url, password);
    } else {
      await schedulesApi.login(url, password);
    }
    state.serverConfig = await window.smsSender.setServerConfig({ url, password });
    statusEl.textContent = "";
    await showSchedulesMain();
  } catch (err) {
    statusEl.textContent = "שגיאה: " + (err.message || err);
  }
}

async function showSchedulesMain() {
  el("schedules-setup").hidden = true;
  el("schedules-main").hidden = false;
  el("sched-connected-as").textContent = `מחובר לשרת: ${state.serverConfig.url}`;
  await refreshSchedulesList();
}

async function refreshSchedulesList() {
  const tbody = document.querySelector("#schedules-table tbody");
  try {
    const schedules = await schedulesApi.listSchedules(state.serverConfig.url, state.serverConfig.password);
    tbody.innerHTML = schedules
      .map(
        (s) => `
        <tr>
          <td>${escapeHtml(s.label)}</td>
          <td>${escapeHtml(describeRecurrence(s.recurrence))}</td>
          <td>${escapeHtml(formatDate(s.nextRunAt))}</td>
          <td>${escapeHtml(formatDate(s.lastRunAt))}${s.lastStatus ? ` (${s.lastStatus === "success" ? "הצלחה" : "כישלון"})` : ""}</td>
          <td><input type="checkbox" data-toggle-id="${s.id}" ${s.enabled ? "checked" : ""} /></td>
          <td><button type="button" data-delete-id="${s.id}">מחק</button></td>
        </tr>`
      )
      .join("");

    tbody.querySelectorAll("[data-toggle-id]").forEach((checkbox) => {
      checkbox.addEventListener("change", async () => {
        await schedulesApi.updateSchedule(state.serverConfig.url, state.serverConfig.password, checkbox.dataset.toggleId, {
          enabled: checkbox.checked,
        });
      });
    });
    tbody.querySelectorAll("[data-delete-id]").forEach((button) => {
      button.addEventListener("click", async () => {
        const id = button.dataset.deleteId;
        if (!confirm("למחוק את התזמון הזה?")) return;
        await schedulesApi.deleteSchedule(state.serverConfig.url, state.serverConfig.password, id);
        await window.smsSender.deleteLocalJob(id);
        await refreshSchedulesList();
      });
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6">שגיאה בטעינת תזמונים: ${escapeHtml(err.message || err)}</td></tr>`;
  }
}

async function handleCreateSchedule() {
  const statusEl = el("sched-create-status");
  const label = el("sched-label").value.trim();
  const { template, phoneColumn, delaySeconds, manualTap } = currentSendConfig();

  if (!label) return void (statusEl.textContent = "יש להזין תווית.");
  if (!state.rows.length) return void (statusEl.textContent = "יש להעלות קובץ אנשי קשר קודם (בשלב 2 למעלה).");
  if (!template.trim()) return void (statusEl.textContent = "יש להזין הודעה קודם (בשלב 3 למעלה).");

  let recurrence;
  try {
    recurrence = readRecurrenceFromForm();
  } catch (err) {
    statusEl.textContent = err.message;
    return;
  }

  statusEl.textContent = "יוצר תזמון...";
  try {
    const schedule = await schedulesApi.createSchedule(state.serverConfig.url, state.serverConfig.password, {
      label,
      recurrence,
    });
    await window.smsSender.saveLocalJob(schedule.id, {
      rows: state.rows,
      template,
      phoneColumn,
      delaySeconds,
      manualTap,
    });
    statusEl.textContent = "התזמון נוצר.";
    el("sched-label").value = "";
    await refreshSchedulesList();
  } catch (err) {
    statusEl.textContent = "שגיאה: " + (err.message || err);
  }
}

async function handleRunJob({ requestId, scheduleId, jobData }) {
  let adb = state.adb;
  if (!adb) {
    adb = await reconnect();
    if (adb) setConnectedUi(adb);
  }

  if (!adb) {
    window.smsSender.reportJobResult(requestId, { ok: false, error: "הטלפון לא מחובר במחשב הזה" });
    return;
  }

  const job = new SendJob(jobData.rows, jobData.template, jobData.phoneColumn, {
    adb,
    dryRun: false,
    delaySeconds: jobData.delaySeconds,
    manualTap: jobData.manualTap,
  });
  job.onUpdate(renderJobStatus);
  el("progress-wrap").hidden = false;
  el("results-table").hidden = false;

  await job.run();

  const sentCount = job.results.filter((r) => r.ok).length;
  const failed = job.results.filter((r) => !r.ok);
  window.smsSender.reportJobResult(requestId, {
    ok: failed.length === 0,
    sentCount,
    error: failed.length ? `${failed.length} הודעות נכשלו (מתוך ${job.results.length})` : undefined,
  });
}

// ---------- stepper (top nav: click-to-scroll, "done" + "active" states) ----------

function setStepDone(sectionId, isDone) {
  document.querySelector(`.step[data-goto="${sectionId}"]`)?.classList.toggle("done", isDone);
}

function updateStepper() {
  setStepDone("device-section", !!state.adb);
  setStepDone("upload-section", state.rows.length > 0);
  setStepDone("message-section", el("message-textarea").value.trim().length > 0);
  setStepDone("preview-section", state.rows.length > 0);
  setStepDone("send-section", state.hasSentOnce);
}

function setupStepper() {
  document.querySelectorAll(".step").forEach((button) => {
    button.addEventListener("click", () => {
      document.getElementById(button.dataset.goto)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  const sections = [...document.querySelectorAll(".step")]
    .map((button) => document.getElementById(button.dataset.goto))
    .filter(Boolean);

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        document
          .querySelector(`.step[data-goto="${entry.target.id}"]`)
          ?.classList.toggle("active", entry.isIntersecting);
      });
    },
    { rootMargin: "-40% 0px -50% 0px" }
  );
  sections.forEach((section) => observer.observe(section));
}

// ---------- USB debugging guide drawer ----------

function setupUsbGuideDrawer() {
  const drawer = el("usb-guide-drawer");
  const backdrop = el("drawer-backdrop");

  function openDrawer() {
    drawer.hidden = false;
    backdrop.hidden = false;
    requestAnimationFrame(() => {
      drawer.classList.add("open");
      backdrop.classList.add("open");
    });
  }

  function closeDrawer() {
    if (drawer.hidden) return;
    drawer.classList.remove("open");
    backdrop.classList.remove("open");
    const finish = () => {
      drawer.hidden = true;
      backdrop.hidden = true;
    };
    // Driven by the real transition finishing (not a guessed timer) so it
    // can never desync from the CSS duration; the timeout is just a
    // fallback in case transitionend doesn't fire for some reason.
    drawer.addEventListener("transitionend", finish, { once: true });
    setTimeout(finish, 350);
  }

  el("usb-guide-btn").addEventListener("click", openDrawer);
  el("drawer-close-btn").addEventListener("click", closeDrawer);
  backdrop.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && drawer.classList.contains("open")) closeDrawer();
  });
}

// ---------- wiring ----------

if (!isWebUsbSupported()) {
  el("unsupported-banner").hidden = false;
  el("connect-btn").disabled = true;
}

el("connect-btn").addEventListener("click", handleConnect);
el("disconnect-btn").addEventListener("click", handleDisconnect);
el("file-input").addEventListener("change", handleFileChange);
el("sample-file-btn").addEventListener("click", downloadSampleFile);
el("phone-column-select").addEventListener("change", refreshPreview);
el("message-textarea").addEventListener("input", refreshPreview);
el("send-btn").addEventListener("click", handleSend);
el("cancel-btn").addEventListener("click", handleCancel);

setupStepper();
setupUsbGuideDrawer();
updateStepper();

if (isElectron()) {
  el("schedules-section").hidden = false;
  el("sched-type").addEventListener("change", updateScheduleTypeFields);
  el("sched-connect-btn").addEventListener("click", handleSchedConnect);
  el("sched-create-btn").addEventListener("click", handleCreateSchedule);
  updateScheduleTypeFields();
  window.smsSender.onRunJob(handleRunJob);
  loadServerConfig();
  trySilentReconnect();
}
