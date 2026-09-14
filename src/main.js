import "./style.css";
import { connect, isWebUsbSupported } from "./lib/adb-client.js";
import { guessPhoneColumn, parseContactsFile } from "./lib/excel.js";
import { SendJob } from "./lib/sender.js";
import { render, unknownPlaceholders } from "./lib/templating.js";

const state = {
  adb: null,
  headers: [],
  rows: [],
  phoneColumn: null,
  job: null,
};

const el = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------- Step 1: device ----------

async function handleConnect() {
  const statusEl = el("device-status");
  statusEl.textContent = "מתחבר... אשרו את הבקשה בדפדפן, ואת בקשת ניפוי ה-USB במסך הטלפון אם תופיע.";
  try {
    const adb = await connect();
    state.adb = adb;
    statusEl.textContent = `מחובר: ${adb.serial}`;
    el("connect-btn").hidden = true;
    el("disconnect-btn").hidden = false;

    adb.disconnected.then(() => {
      if (state.adb === adb) {
        state.adb = null;
        statusEl.textContent = "המכשיר התנתק.";
        el("connect-btn").hidden = false;
        el("disconnect-btn").hidden = true;
      }
    });
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
}

// ---------- Step 2: upload ----------

async function handleFileChange(event) {
  const file = event.target.files[0];
  const statusEl = el("upload-status");
  if (!file) return;

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

  const unknown = unknownPlaceholders(template, state.headers);
  el("preview-warning").textContent = unknown.length
    ? `שים לב: פרמטרים לא מוכרים בהודעה: ${unknown.map((p) => `{${p}}`).join(", ")}`
    : "";

  el("preview-count").textContent = rows.length
    ? `מוצגות עד 20 הודעות מתוך ${rows.length} אנשי קשר בקובץ.`
    : "";
}

// ---------- Step 5: send ----------

async function handleSend() {
  const template = el("message-textarea").value;
  const phoneColumn = el("phone-column-select").value || state.phoneColumn;
  const dryRun = el("dry-run-checkbox").checked;
  const delaySeconds = Number(el("delay-input").value) || 4;
  const manualX = el("manual-tap-x").value;
  const manualY = el("manual-tap-y").value;

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
    manualTap: manualX && manualY ? [Number(manualX), Number(manualY)] : null,
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
  }
}

function handleCancel() {
  state.job?.cancel();
}

// ---------- wiring ----------

if (!isWebUsbSupported()) {
  el("unsupported-banner").hidden = false;
  el("connect-btn").disabled = true;
}

el("connect-btn").addEventListener("click", handleConnect);
el("disconnect-btn").addEventListener("click", handleDisconnect);
el("file-input").addEventListener("change", handleFileChange);
el("phone-column-select").addEventListener("change", refreshPreview);
el("message-textarea").addEventListener("input", refreshPreview);
el("send-btn").addEventListener("click", handleSend);
el("cancel-btn").addEventListener("click", handleCancel);
