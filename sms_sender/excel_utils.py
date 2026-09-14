"""Read contacts from an uploaded .xlsx/.xls/.csv file into a list of dict rows.

Every column header becomes an available {placeholder} for the message
template, so the caller never has to know column names in advance.
"""

import csv
import os
import re

from openpyxl import load_workbook

PHONE_HEADER_HINTS = [
    "טלפון", "נייד", "פלאפון", "מספר טלפון", "מספר נייד",
    "phone", "mobile", "cell", "tel",
]

_NON_PHONE_CHARS_RE = re.compile(r"[^\d+]")


def _cell_to_str(value):
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        # openpyxl/Excel store plain numbers as float (e.g. phone numbers
        # entered without formatting); avoid turning 501234567 into
        # "501234567.0".
        return str(int(value))
    return str(value).strip()


def parse_contacts_file(file_path):
    """Return (headers, rows). rows is a list of {header: str_value} dicts.

    Blank rows are skipped. Missing/duplicate headers are auto-named.
    """
    ext = os.path.splitext(file_path)[1].lower()
    if ext == ".csv":
        return _parse_csv(file_path)
    return _parse_xlsx(file_path)


def _dedupe_headers(raw_headers):
    headers = []
    seen = {}
    for i, raw in enumerate(raw_headers):
        name = raw or f"עמודה_{i + 1}"
        if name in seen:
            seen[name] += 1
            name = f"{name}_{seen[name]}"
        else:
            seen[name] = 0
        headers.append(name)
    return headers


def _parse_xlsx(file_path):
    workbook = load_workbook(file_path, read_only=True, data_only=True)
    sheet = workbook.active
    rows_iter = sheet.iter_rows(values_only=True)

    try:
        header_row = next(rows_iter)
    except StopIteration:
        workbook.close()
        return [], []

    headers = _dedupe_headers([_cell_to_str(h) for h in header_row])

    rows = []
    for raw_row in rows_iter:
        if raw_row is None or all(v is None or _cell_to_str(v) == "" for v in raw_row):
            continue
        row = {}
        for i, header in enumerate(headers):
            row[header] = _cell_to_str(raw_row[i]) if i < len(raw_row) else ""
        rows.append(row)

    workbook.close()
    return headers, rows


def _parse_csv(file_path):
    with open(file_path, newline="", encoding="utf-8-sig") as f:
        raw_rows = list(csv.reader(f))

    if not raw_rows:
        return [], []

    headers = _dedupe_headers([h.strip() for h in raw_rows[0]])

    rows = []
    for raw_row in raw_rows[1:]:
        if not any(cell.strip() for cell in raw_row):
            continue
        row = {}
        for i, header in enumerate(headers):
            row[header] = raw_row[i].strip() if i < len(raw_row) else ""
        rows.append(row)

    return headers, rows


def guess_phone_column(headers):
    """Best-effort guess of which column holds the phone number."""
    for header in headers:
        low = header.lower()
        if any(hint in header or hint in low for hint in PHONE_HEADER_HINTS):
            return header
    return headers[0] if headers else None


def normalize_phone(value):
    """Strip spaces/dashes/parentheses etc, keep only digits and a leading +."""
    if value is None:
        return ""
    cleaned = _NON_PHONE_CHARS_RE.sub("", str(value))
    return cleaned
