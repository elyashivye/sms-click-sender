(function () {
  "use strict";

  const state = {
    headers: [],
    phoneColumn: null,
    jobId: null,
    pollTimer: null,
  };

  const el = (id) => document.getElementById(id);

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function getAdbPath() {
    return el("adb-path").value.trim() || "adb";
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  // ---------- Step 1: devices ----------

  async function refreshDevices() {
    const statusEl = el("device-status");
    statusEl.textContent = "בודק...";
    try {
      const params = new URLSearchParams({ adb_path: getAdbPath() });
      const res = await fetch(`/api/devices?${params}`);
      const data = await res.json();
      const select = el("device-select");
      select.innerHTML = "";

      if (!data.ok) {
        statusEl.textContent = "שגיאה: " + data.error;
        select.innerHTML = '<option value="">— שגיאה —</option>';
        return;
      }

      if (!data.devices.length) {
        select.innerHTML = '<option value="">— לא נמצאו מכשירים —</option>';
        statusEl.textContent = "לא נמצא מכשיר מחובר. ודא שהכבל מחובר ושאישרת ניפוי USB בטלפון.";
        return;
      }

      data.devices.forEach((dev) => {
        const opt = document.createElement("option");
        opt.value = dev.serial;
        const label = dev.state === "device" ? dev.serial : `${dev.serial} (${dev.state})`;
        opt.textContent = label;
        opt.disabled = dev.state !== "device";
        select.appendChild(opt);
      });

      const ready = data.devices.filter((d) => d.state === "device");
      statusEl.textContent = ready.length
        ? `נמצאו ${ready.length} מכשיר/ים מוכנים.`
        : "המכשיר מחובר אך לא מאושר - אשר את בקשת ניפוי ה-USB במסך הטלפון.";
    } catch (err) {
      statusEl.textContent = "שגיאת תקשורת: " + err;
    }
  }

  // ---------- Step 2: upload ----------

  async function uploadFile() {
    const fileInput = el("file-input");
    const statusEl = el("upload-status");
    if (!fileInput.files.length) {
      statusEl.textContent = "יש לבחור קובץ קודם";
      return;
    }

    const formData = new FormData();
    formData.append("file", fileInput.files[0]);
    statusEl.textContent = "מעלה...";

    try {
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      const data = await res.json();
      if (!data.ok) {
        statusEl.textContent = "שגיאה: " + data.error;
        return;
      }

      state.headers = data.headers;
      state.phoneColumn = data.phone_column;

      statusEl.textContent = `נטענו ${data.row_count} אנשי קשר, ${data.headers.length} עמודות.`;

      const phoneSelect = el("phone-column-select");
      phoneSelect.innerHTML = "";
      data.headers.forEach((h) => {
        const opt = document.createElement("option");
        opt.value = h;
        opt.textContent = h;
        if (h === data.phone_column) opt.selected = true;
        phoneSelect.appendChild(opt);
      });
      el("phone-column-row").hidden = false;

      renderChips(data.headers);
      refreshPreview();
    } catch (err) {
      statusEl.textContent = "שגיאת תקשורת: " + err;
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

  let previewDebounce = null;
  function refreshPreview() {
    clearTimeout(previewDebounce);
    previewDebounce = setTimeout(doRefreshPreview, 250);
  }

  async function doRefreshPreview() {
    const template = el("message-textarea").value;
    const phoneColumn = el("phone-column-select").value || state.phoneColumn;

    const data = await postJson("/api/preview", { template, phone_column: phoneColumn });
    if (!data.ok) return;

    const tbody = document.querySelector("#preview-table tbody");
    tbody.innerHTML = data.preview
      .map(
        (row) =>
          `<tr><td class="number">${escapeHtml(row.number)}</td><td>${escapeHtml(row.message)}</td></tr>`
      )
      .join("");

    const warnEl = el("preview-warning");
    warnEl.textContent = data.unknown_placeholders.length
      ? `שים לב: פרמטרים לא מוכרים בהודעה: ${data.unknown_placeholders.map((p) => `{${p}}`).join(", ")}`
      : "";

    el("preview-count").textContent = data.total_rows
      ? `מוצגות עד 20 הודעות מתוך ${data.total_rows} אנשי קשר בקובץ.`
      : "";
  }

  // ---------- Step 5: send ----------

  async function startSend() {
    const template = el("message-textarea").value;
    const phoneColumn = el("phone-column-select").value || state.phoneColumn;
    const serial = el("device-select").value;
    const dryRun = el("dry-run-checkbox").checked;
    const delaySeconds = Number(el("delay-input").value) || 4;
    const manualX = el("manual-tap-x").value;
    const manualY = el("manual-tap-y").value;

    if (!dryRun && !serial) {
      alert("יש לבחור מכשיר מחובר לפני שליחה בפועל (או להשאיר את מצב הבדיקה מסומן).");
      return;
    }
    if (!dryRun) {
      const confirmed = confirm("פעולה זו תשלח הודעות SMS אמיתיות מהטלפון המחובר. להמשיך?");
      if (!confirmed) return;
    }

    const payload = {
      template,
      phone_column: phoneColumn,
      serial,
      adb_path: getAdbPath(),
      dry_run: dryRun,
      delay_seconds: delaySeconds,
      manual_tap: manualX && manualY ? { x: manualX, y: manualY } : null,
    };

    const data = await postJson("/api/send", payload);
    if (!data.ok) {
      alert("שגיאה: " + data.error);
      return;
    }

    state.jobId = data.job_id;
    el("send-btn").disabled = true;
    el("cancel-btn").hidden = false;
    el("progress-wrap").hidden = false;
    el("results-table").hidden = false;
    document.querySelector("#results-table tbody").innerHTML = "";

    state.pollTimer = setInterval(pollStatus, 900);
    pollStatus();
  }

  async function pollStatus() {
    if (!state.jobId) return;
    const res = await fetch(`/api/status/${state.jobId}`);
    const data = await res.json();
    if (!data.ok) return;

    const pct = data.total ? Math.round((data.completed / data.total) * 100) : 0;
    el("progress-fill").style.width = pct + "%";
    el("progress-text").textContent = `${data.completed} / ${data.total} (${data.status})`;

    const tbody = document.querySelector("#results-table tbody");
    tbody.innerHTML = data.results
      .map((r) => {
        const statusLabel = r.ok
          ? r.dry_run
            ? '<span class="status-ok">בדיקה בלבד</span>'
            : '<span class="status-ok">נשלח</span>'
          : `<span class="status-fail">נכשל: ${escapeHtml(r.error || "")}</span>`;
        return `<tr><td class="number">${escapeHtml(r.number)}</td><td>${escapeHtml(r.message)}</td><td>${statusLabel}</td></tr>`;
      })
      .join("");

    if (data.status === "done" || data.status === "cancelled") {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
      el("send-btn").disabled = false;
      el("cancel-btn").hidden = true;
    }
  }

  async function cancelSend() {
    if (!state.jobId) return;
    await fetch(`/api/cancel/${state.jobId}`, { method: "POST" });
  }

  // ---------- wiring ----------

  el("refresh-devices-btn").addEventListener("click", refreshDevices);
  el("upload-btn").addEventListener("click", uploadFile);
  el("phone-column-select").addEventListener("change", refreshPreview);
  el("message-textarea").addEventListener("input", refreshPreview);
  el("send-btn").addEventListener("click", startSend);
  el("cancel-btn").addEventListener("click", cancelSend);

  refreshDevices();
})();
