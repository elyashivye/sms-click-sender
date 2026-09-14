"""SMS Click Sender - local web app.

Runs identically on Windows or a Linux server: a phone connected over USB
with ADB debugging enabled is controlled to send a personalized SMS to
every contact in an uploaded Excel/CSV file. See README.md.
"""

import os
import uuid

from flask import Flask, jsonify, render_template, request

from sms_sender import adb as adb_mod
from sms_sender import sender
from sms_sender.excel_utils import guess_phone_column, parse_contacts_file
from sms_sender.templating import render, unknown_placeholders

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

ALLOWED_EXTENSIONS = {".xlsx", ".xls", ".csv"}

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 10 * 1024 * 1024  # 10MB
app.json.ensure_ascii = False

# In-memory contacts state. Single-user local tool: no auth, no persistence.
_STATE = {"headers": [], "rows": [], "phone_column": None}


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/devices")
def api_devices():
    adb_path = request.args.get("adb_path") or "adb"
    try:
        devices = adb_mod.list_devices(adb_path=adb_path)
    except adb_mod.AdbError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    return jsonify({"ok": True, "devices": devices})


@app.route("/api/upload", methods=["POST"])
def api_upload():
    file = request.files.get("file")
    if not file or not file.filename:
        return jsonify({"ok": False, "error": "לא נבחר קובץ"}), 400

    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        return jsonify({"ok": False, "error": "סוג קובץ לא נתמך (יש להעלות xlsx / xls / csv)"}), 400

    temp_path = os.path.join(UPLOAD_DIR, f"{uuid.uuid4().hex}{ext}")
    file.save(temp_path)

    try:
        headers, rows = parse_contacts_file(temp_path)
    except Exception as exc:  # noqa: BLE001 - surface any parse failure to the user
        return jsonify({"ok": False, "error": f"שגיאה בקריאת הקובץ: {exc}"}), 400
    finally:
        try:
            os.remove(temp_path)
        except OSError:
            pass

    if not headers or not rows:
        return jsonify({"ok": False, "error": "הקובץ ריק, או שלא ניתן לקרוא ממנו נתונים"}), 400

    _STATE["headers"] = headers
    _STATE["rows"] = rows
    _STATE["phone_column"] = guess_phone_column(headers)

    return jsonify(
        {
            "ok": True,
            "headers": headers,
            "phone_column": _STATE["phone_column"],
            "row_count": len(rows),
            "sample_rows": rows[:5],
        }
    )


@app.route("/api/preview", methods=["POST"])
def api_preview():
    data = request.get_json(force=True) or {}
    template = data.get("template", "")
    phone_column = data.get("phone_column") or _STATE.get("phone_column")
    rows = _STATE.get("rows", [])

    preview = [
        {"number": row.get(phone_column, ""), "message": render(template, row)}
        for row in rows[:20]
    ]

    return jsonify(
        {
            "ok": True,
            "preview": preview,
            "unknown_placeholders": unknown_placeholders(template, _STATE.get("headers")),
            "total_rows": len(rows),
        }
    )


@app.route("/api/send", methods=["POST"])
def api_send():
    data = request.get_json(force=True) or {}
    template = data.get("template", "")
    phone_column = data.get("phone_column") or _STATE.get("phone_column")
    serial = data.get("serial")
    adb_path = data.get("adb_path") or "adb"
    dry_run = bool(data.get("dry_run", False))
    delay_seconds = data.get("delay_seconds", 4)

    rows = _STATE.get("rows", [])
    if not rows:
        return jsonify({"ok": False, "error": "לא הועלה קובץ אנשי קשר"}), 400
    if not template.strip():
        return jsonify({"ok": False, "error": "לא הוזנה הודעה לשליחה"}), 400
    if not dry_run and not serial:
        return jsonify({"ok": False, "error": "לא נבחר מכשיר"}), 400

    manual_tap = None
    raw_manual_tap = data.get("manual_tap") or {}
    if raw_manual_tap.get("x") and raw_manual_tap.get("y"):
        try:
            manual_tap = (int(raw_manual_tap["x"]), int(raw_manual_tap["y"]))
        except (TypeError, ValueError):
            manual_tap = None

    config = {
        "serial": serial,
        "adb_path": adb_path,
        "dry_run": dry_run,
        "delay_seconds": delay_seconds,
        "manual_tap": manual_tap,
    }

    job = sender.create_job(rows, template, phone_column, config)
    sender.start_job(job)

    return jsonify({"ok": True, "job_id": job.id})


@app.route("/api/status/<job_id>")
def api_status(job_id):
    job = sender.get_job(job_id)
    if not job:
        return jsonify({"ok": False, "error": "העבודה לא נמצאה"}), 404
    return jsonify({"ok": True, **job.to_dict()})


@app.route("/api/cancel/<job_id>", methods=["POST"])
def api_cancel(job_id):
    sender.cancel_job(job_id)
    return jsonify({"ok": True})


if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "5000"))
    app.run(host=host, port=port, debug=False)
