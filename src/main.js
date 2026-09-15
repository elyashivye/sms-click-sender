import "./style.css";
import { connect, isWebUsbSupported, listGroupChats, reconnect } from "./lib/adb-client.js";
import {
  downloadSampleFile,
  guessCountryCodeColumn,
  guessNameColumn,
  guessPhoneColumn,
  parseContactsFile,
} from "./lib/excel.js";
import { SendJob } from "./lib/sender.js";
import { SaveContactsJob } from "./lib/contacts-job.js";
import { WhatsAppGroupsImportJob } from "./lib/whatsapp-groups-job.js";
import * as schedulesApi from "./lib/schedules-client.js";
import { render, unknownPlaceholders } from "./lib/templating.js";

const state = {
  adb: null,
  headers: [],
  rows: [],
  phoneColumn: null,
  job: null,
  contactsJob: null,
  groupsImportJob: null,
  availableGroups: [],
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

function setSidebarDeviceStatus(connected, label) {
  const statusEl = el("sidebar-device-status");
  statusEl.textContent = label;
  statusEl.classList.toggle("connected", connected);
}

function setConnectedUi(adb) {
  state.adb = adb;
  el("device-status").textContent = `מחובר: ${adb.serial}`;
  el("connect-btn").hidden = true;
  el("disconnect-btn").hidden = false;
  setSidebarDeviceStatus(true, `מחובר: ${adb.serial}`);
  updateNavProgress();

  adb.disconnected.then(() => {
    if (state.adb === adb) {
      state.adb = null;
      el("device-status").textContent = "המכשיר התנתק.";
      el("connect-btn").hidden = false;
      el("disconnect-btn").hidden = true;
      setSidebarDeviceStatus(false, "הטלפון לא מחובר");
      updateNavProgress();
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
  setSidebarDeviceStatus(false, "הטלפון לא מחובר");
  updateNavProgress();
}

async function trySilentReconnect() {
  const adb = await reconnect();
  if (adb) setConnectedUi(adb);
}

// ---------- Step 2: upload ----------

// Wires headers+rows into every downstream piece of UI (column selects,
// contacts-save-box, preview) - shared by the file-upload path and the
// WhatsApp-groups-import path, since from here on both are just "a table
// of contacts" to the rest of the app.
function applyContactsData(headers, rows) {
  state.headers = headers;
  state.rows = rows;
  state.phoneColumn = guessPhoneColumn(headers);

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

  const guessedNameColumn = guessNameColumn(headers);
  const nameSelect = el("name-column-select");
  nameSelect.innerHTML = "";
  headers.forEach((h) => {
    const opt = document.createElement("option");
    opt.value = h;
    opt.textContent = h;
    if (h === guessedNameColumn) opt.selected = true;
    nameSelect.appendChild(opt);
  });
  el("contacts-save-box").hidden = false;
  el("contacts-progress-wrap").hidden = true;
  el("contacts-results-table").hidden = true;
  document.querySelector("#contacts-results-table tbody").innerHTML = "";
  el("contacts-cancel-btn").hidden = true;
  el("save-contacts-btn").disabled = false;

  const guessedCountryCodeColumn = guessCountryCodeColumn(headers);
  const countryCodeColumnSelect = el("country-code-column-select");
  countryCodeColumnSelect.innerHTML = '<option value="">ללא - תמיד קידומת ברירת המחדל</option>';
  headers.forEach((h) => {
    const opt = document.createElement("option");
    opt.value = h;
    opt.textContent = h;
    if (h === guessedCountryCodeColumn) opt.selected = true;
    countryCodeColumnSelect.appendChild(opt);
  });

  renderChips(headers);
  refreshPreview();
}

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

    statusEl.textContent = `נטענו ${rows.length} אנשי קשר, ${headers.length} עמודות.`;
    applyContactsData(headers, rows);
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

// ---------- save as contacts ----------

async function handleSaveContacts() {
  const nameColumn = el("name-column-select").value;
  const phoneColumn = el("phone-column-select").value || state.phoneColumn;
  const dryRun = el("contacts-dry-run-checkbox").checked;

  if (!state.rows.length) {
    alert("יש להעלות קובץ אנשי קשר קודם.");
    return;
  }
  if (!dryRun && !state.adb) {
    alert("יש להתחבר לטלפון לפני שמירה בפועל (או להשאיר את מצב הבדיקה מסומן).");
    return;
  }
  if (!dryRun && !confirm(`פעולה זו תיצור אנשי קשר חדשים בטלפון המחובר עבור ${state.rows.length} שורות (מי שכבר שמור ידולג). להמשיך?`)) {
    return;
  }

  const job = new SaveContactsJob(state.rows, nameColumn, phoneColumn, {
    adb: state.adb,
    dryRun,
  });
  state.contactsJob = job;

  el("save-contacts-btn").disabled = true;
  el("contacts-cancel-btn").hidden = false;
  el("contacts-progress-wrap").hidden = false;
  el("contacts-results-table").hidden = false;
  document.querySelector("#contacts-results-table tbody").innerHTML = "";

  job.onUpdate(renderContactsJobStatus);
  await job.run();
}

const CONTACTS_STATE_LABELS = {
  created: '<span class="status-ok">נוצר</span>',
  dryRun: '<span class="status-ok">בדיקה בלבד</span>',
  skipped: '<span class="status-ok">כבר שמור - דולג</span>',
};

function renderContactsJobStatus(snapshot) {
  const pct = snapshot.total ? Math.round((snapshot.completed / snapshot.total) * 100) : 0;
  el("contacts-progress-fill").style.width = pct + "%";
  el("contacts-progress-text").textContent = `${snapshot.completed} / ${snapshot.total} (${snapshot.status})`;

  const tbody = document.querySelector("#contacts-results-table tbody");
  tbody.innerHTML = snapshot.results
    .map((r) => {
      const statusLabel = r.ok
        ? CONTACTS_STATE_LABELS[r.state] || '<span class="status-ok">בוצע</span>'
        : `<span class="status-fail">נכשל: ${escapeHtml(r.error || "")}</span>`;
      return `<tr><td>${escapeHtml(r.name)}</td><td class="number">${escapeHtml(r.number)}</td><td>${statusLabel}</td></tr>`;
    })
    .join("");

  if (snapshot.status === "done" || snapshot.status === "cancelled") {
    el("save-contacts-btn").disabled = false;
    el("contacts-cancel-btn").hidden = true;
  }
}

function handleContactsCancel() {
  state.contactsJob?.cancel();
}

// ---------- import contacts from WhatsApp groups ----------

async function handleLoadGroups() {
  const statusEl = el("groups-load-status");
  if (!state.adb) {
    alert("יש להתחבר לטלפון קודם.");
    return;
  }

  el("load-groups-btn").disabled = true;
  el("groups-picklist-wrap").hidden = true;
  statusEl.textContent = "פותח את וואטסאפ וסורק את רשימת הקבוצות...";

  try {
    const names = await listGroupChats(state.adb, {
      onProgress: (count) => {
        statusEl.textContent = `נמצאו ${count} קבוצות עד כה...`;
      },
    });
    state.availableGroups = names;
    if (!names.length) {
      statusEl.textContent = "לא נמצאו קבוצות. ודאו שבוואטסאפ יש לפחות קבוצה אחת ושהמכשיר לא נעול.";
    } else {
      statusEl.textContent = `נמצאו ${names.length} קבוצות.`;
      renderGroupsPicklist(names);
      el("groups-picklist-wrap").hidden = false;
    }
  } catch (err) {
    statusEl.textContent = "שגיאה: " + (err.message || err);
  } finally {
    el("load-groups-btn").disabled = false;
  }
}

function renderGroupsPicklist(names) {
  const list = el("groups-picklist");
  list.innerHTML = names
    .map(
      (name, i) => `
      <li>
        <label class="checkbox-label">
          <input type="checkbox" class="group-checkbox" id="group-check-${i}" value="${escapeHtml(name)}" />
          ${escapeHtml(name)}
        </label>
      </li>`
    )
    .join("");
}

function setAllGroupCheckboxes(checked) {
  document.querySelectorAll(".group-checkbox").forEach((cb) => {
    cb.checked = checked;
  });
}

async function handleBuildContactsFromGroups() {
  const groupNames = [...document.querySelectorAll(".group-checkbox:checked")].map((cb) => cb.value);
  if (!groupNames.length) {
    alert("יש לבחור לפחות קבוצה אחת.");
    return;
  }
  if (!state.adb) {
    alert("יש להתחבר לטלפון קודם.");
    return;
  }
  if (
    state.rows.length &&
    !confirm(`יש כבר ${state.rows.length} אנשי קשר טעונים - הפעולה תחליף אותם ברשימה החדשה מהקבוצות. להמשיך?`)
  ) {
    return;
  }

  const job = new WhatsAppGroupsImportJob(groupNames, { adb: state.adb });
  state.groupsImportJob = job;

  el("build-contacts-from-groups-btn").disabled = true;
  el("groups-import-cancel-btn").hidden = false;
  el("groups-import-progress-wrap").hidden = false;
  el("groups-import-results-table").hidden = false;
  document.querySelector("#groups-import-results-table tbody").innerHTML = "";

  job.onUpdate(renderGroupsImportStatus);
  await job.run();
}

function renderGroupsImportStatus(snapshot) {
  const pct = snapshot.total ? Math.round((snapshot.completed / snapshot.total) * 100) : 0;
  el("groups-import-progress-fill").style.width = pct + "%";
  el("groups-import-progress-text").textContent = `${snapshot.completed} / ${snapshot.total} (${snapshot.status})`;

  const tbody = document.querySelector("#groups-import-results-table tbody");
  tbody.innerHTML = snapshot.results
    .map((r) => {
      const statusLabel = r.ok
        ? `<span class="status-ok">נוספו ${r.count} אנשי קשר</span>`
        : `<span class="status-fail">נכשל: ${escapeHtml(r.error || "")}</span>`;
      return `<tr><td>${escapeHtml(r.group)}</td><td>${statusLabel}</td></tr>`;
    })
    .join("");

  if (snapshot.status === "done" || snapshot.status === "cancelled") {
    el("build-contacts-from-groups-btn").disabled = false;
    el("groups-import-cancel-btn").hidden = true;

    if (snapshot.contacts.length) {
      const headers = ["שם", "טלפון", "קבוצה"];
      const rows = snapshot.contacts.map((c) => ({ "שם": c.name, "טלפון": c.phone, "קבוצה": c.group }));
      applyContactsData(headers, rows);
      el("upload-status").textContent = `יובאו ${rows.length} אנשי קשר מ-${snapshot.results.filter((r) => r.ok).length} קבוצות וואטסאפ.`;
    }
  }
}

function handleGroupsImportCancel() {
  state.groupsImportJob?.cancel();
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

  updateNavProgress();

  el("preview-count").textContent = rows.length
    ? `מוצגות עד 20 הודעות מתוך ${rows.length} אנשי קשר בקובץ.`
    : "";
}

// ---------- Step 5: send ----------

function currentChannel() {
  return document.querySelector('input[name="channel"]:checked')?.value || "sms";
}

function currentSendConfig() {
  return {
    template: el("message-textarea").value,
    phoneColumn: el("phone-column-select").value || state.phoneColumn,
    channel: currentChannel(),
    countryCode: el("country-code-input").value.trim() || "972",
    countryCodeColumn: el("country-code-column-select").value || null,
    delaySeconds: Number(el("delay-input").value) || 4,
    manualTap:
      el("manual-tap-x").value && el("manual-tap-y").value
        ? [Number(el("manual-tap-x").value), Number(el("manual-tap-y").value)]
        : null,
  };
}

const CHANNEL_LABELS = { sms: "SMS", whatsapp: "WhatsApp", both: "SMS + WhatsApp" };

async function handleSend() {
  const { template, phoneColumn, channel, countryCode, countryCodeColumn, delaySeconds, manualTap } =
    currentSendConfig();
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
  if (!dryRun && !confirm(`פעולה זו תשלח הודעות ${CHANNEL_LABELS[channel]} אמיתיות מהטלפון המחובר. להמשיך?`)) {
    return;
  }

  const job = new SendJob(state.rows, template, phoneColumn, {
    adb: state.adb,
    channel,
    countryCode,
    countryCodeColumn,
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
      const channelLabel = r.channel === "whatsapp" ? "WhatsApp" : "SMS";
      return `<tr><td class="number">${escapeHtml(r.number)}</td><td>${escapeHtml(r.message)}</td><td>${channelLabel}</td><td>${statusLabel}</td></tr>`;
    })
    .join("");

  if (snapshot.status === "done" || snapshot.status === "cancelled") {
    el("send-btn").disabled = false;
    el("cancel-btn").hidden = true;
    if (snapshot.status === "done") state.hasSentOnce = true;
    updateNavProgress();
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
  const { template, phoneColumn, channel, countryCode, countryCodeColumn, delaySeconds, manualTap } =
    currentSendConfig();

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
      channel,
      countryCode,
      countryCodeColumn,
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
    channel: jobData.channel,
    countryCode: jobData.countryCode,
    countryCodeColumn: jobData.countryCodeColumn,
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

// ---------- sidebar nav (page switching + "done" states + mobile drawer) ----------

function setNavDone(sectionId, isDone) {
  document.querySelector(`.nav-item[data-section="${sectionId}"]`)?.classList.toggle("done", isDone);
}

function updateNavProgress() {
  setNavDone("device-section", !!state.adb);
  setNavDone("contacts-section", state.rows.length > 0);
  setNavDone("message-section", state.hasSentOnce || el("message-textarea").value.trim().length > 0);
}

function showPage(sectionId) {
  document.querySelectorAll(".page[data-page]").forEach((page) => {
    page.hidden = page.id !== sectionId;
  });
  document.querySelectorAll(".nav-item[data-section]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.section === sectionId);
  });
  closeSidebarMobile();
  window.scrollTo({ top: 0 });
}

function openSidebarMobile() {
  el("sidebar").classList.add("open");
  el("sidebar-backdrop").hidden = false;
  requestAnimationFrame(() => el("sidebar-backdrop").classList.add("open"));
}

function closeSidebarMobile() {
  el("sidebar").classList.remove("open");
  el("sidebar-backdrop").classList.remove("open");
  el("sidebar-backdrop").hidden = true;
}

function setupSidebarNav() {
  document.querySelectorAll(".nav-item[data-section]").forEach((button) => {
    button.addEventListener("click", () => showPage(button.dataset.section));
  });

  el("sidebar-toggle").addEventListener("click", () => {
    el("sidebar").classList.contains("open") ? closeSidebarMobile() : openSidebarMobile();
  });
  el("sidebar-backdrop").addEventListener("click", closeSidebarMobile);

  showPage("device-section");
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

// ---------- channel picker (SMS / WhatsApp) ----------

const SMS_DEFAULT_DELAY = 4;
const WHATSAPP_DEFAULT_DELAY = 20;

function setupChannelPicker() {
  const whatsappFields = el("whatsapp-fields");
  const whatsappWarning = el("whatsapp-warning");
  const delayInput = el("delay-input");

  document.querySelectorAll('input[name="channel"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      const isWhatsApp = currentChannel() === "whatsapp" || currentChannel() === "both";
      whatsappFields.hidden = !isWhatsApp;
      whatsappWarning.hidden = !isWhatsApp;

      // Only nudge the delay if it's still at the other channel's default -
      // never overwrite a value the user deliberately set.
      const currentDelay = Number(delayInput.value);
      if (isWhatsApp && currentDelay === SMS_DEFAULT_DELAY) {
        delayInput.value = WHATSAPP_DEFAULT_DELAY;
      } else if (!isWhatsApp && currentDelay === WHATSAPP_DEFAULT_DELAY) {
        delayInput.value = SMS_DEFAULT_DELAY;
      }
    });
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
el("save-contacts-btn").addEventListener("click", handleSaveContacts);
el("contacts-cancel-btn").addEventListener("click", handleContactsCancel);
el("load-groups-btn").addEventListener("click", handleLoadGroups);
el("groups-select-all-btn").addEventListener("click", () => setAllGroupCheckboxes(true));
el("groups-select-none-btn").addEventListener("click", () => setAllGroupCheckboxes(false));
el("build-contacts-from-groups-btn").addEventListener("click", handleBuildContactsFromGroups);
el("groups-import-cancel-btn").addEventListener("click", handleGroupsImportCancel);

setupSidebarNav();
setupUsbGuideDrawer();
setupChannelPicker();
updateNavProgress();

if (isElectron()) {
  el("nav-schedules").hidden = false;
  el("sched-type").addEventListener("change", updateScheduleTypeFields);
  el("sched-connect-btn").addEventListener("click", handleSchedConnect);
  el("sched-create-btn").addEventListener("click", handleCreateSchedule);
  updateScheduleTypeFields();
  window.smsSender.onRunJob(handleRunJob);
  loadServerConfig();
  trySilentReconnect();
}
