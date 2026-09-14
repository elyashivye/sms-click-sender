"""Runs a batch of personalized SMS sends in a background thread and tracks
progress so the web UI can poll for live status.
"""

import threading
import time
import uuid

from . import adb as adb_mod
from .excel_utils import normalize_phone
from .templating import render

DEFAULT_DELAY_SECONDS = 4


class Job:
    def __init__(self, job_id, rows, template, phone_column, config):
        self.id = job_id
        self.rows = rows
        self.template = template
        self.phone_column = phone_column
        self.config = config
        self.status = "pending"  # pending -> running -> done | cancelled
        self.results = []
        self.cancel_requested = False
        self._lock = threading.Lock()

    def to_dict(self):
        with self._lock:
            results = list(self.results)
        return {
            "id": self.id,
            "status": self.status,
            "total": len(self.rows),
            "completed": len(results),
            "results": results,
        }

    def _append_result(self, entry):
        with self._lock:
            self.results.append(entry)


_JOBS = {}
_JOBS_LOCK = threading.Lock()


def create_job(rows, template, phone_column, config):
    job_id = uuid.uuid4().hex[:12]
    job = Job(job_id, rows, template, phone_column, config)
    with _JOBS_LOCK:
        _JOBS[job_id] = job
    return job


def get_job(job_id):
    with _JOBS_LOCK:
        return _JOBS.get(job_id)


def cancel_job(job_id):
    job = get_job(job_id)
    if job:
        job.cancel_requested = True


def _run_job(job):
    job.status = "running"
    serial = job.config.get("serial")
    adb_path = job.config.get("adb_path", "adb")
    dry_run = bool(job.config.get("dry_run", False))
    delay_seconds = float(job.config.get("delay_seconds", DEFAULT_DELAY_SECONDS))
    manual_tap = job.config.get("manual_tap")

    for row in job.rows:
        if job.cancel_requested:
            job.status = "cancelled"
            return

        message = render(job.template, row)
        number = normalize_phone(row.get(job.phone_column, ""))
        entry = {"number": number, "message": message}

        if not number:
            entry["ok"] = False
            entry["error"] = "מספר טלפון חסר או לא תקין"
        elif dry_run:
            entry["ok"] = True
            entry["dry_run"] = True
        else:
            try:
                adb_mod.send_sms(serial, number, message, adb_path=adb_path, manual_tap=manual_tap)
                entry["ok"] = True
            except adb_mod.AdbError as exc:
                entry["ok"] = False
                entry["error"] = str(exc)

        job._append_result(entry)

        if not dry_run and not job.cancel_requested:
            time.sleep(delay_seconds)

    if job.status == "running":
        job.status = "done"


def start_job(job):
    thread = threading.Thread(target=_run_job, args=(job,), daemon=True)
    thread.start()
    return thread
