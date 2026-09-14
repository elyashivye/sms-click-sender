"""ADB integration: detect the phone, open the SMS compose screen for a
contact, then find and tap the on-screen "Send" button.

This deliberately avoids hardcoded screen coordinates. Every SMS app lays
out its "Send" button differently (and the same app differs across screen
sizes), so instead we dump the current UI hierarchy with `uiautomator` and
search it for the send control, then tap its actual on-screen center.
"""

import re
import subprocess
import time
import xml.etree.ElementTree as ET

WAIT_AFTER_OPEN_SECONDS = 1.6
WAIT_BEFORE_RETRY_SECONDS = 1.2
WAIT_AFTER_TAP_SECONDS = 1.0

SEND_TEXT_CANDIDATES = {"send", "שלח"}
BOUNDS_RE = re.compile(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]")


class AdbError(RuntimeError):
    """Raised for any failure talking to adb or the device."""


def _run(args, adb_path="adb", timeout=15):
    try:
        result = subprocess.run(
            [adb_path, *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except FileNotFoundError as exc:
        raise AdbError(
            f"לא נמצאה תוכנת adb בנתיב '{adb_path}'. "
            "יש להתקין Android Platform Tools ולוודא שהנתיב נכון."
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise AdbError("הפעולה ב-adb נתקעה (timeout). ודא שהמכשיר מחובר ומגיב.") from exc

    if result.returncode != 0:
        message = (result.stderr or result.stdout or "").strip()
        raise AdbError(message or f"adb {' '.join(args)} נכשל")
    return result.stdout


def _shell_quote(value):
    """Quote a value for the *device's* POSIX shell (adb shell re-parses argv)."""
    return "'" + str(value).replace("'", "'\"'\"'") + "'"


def list_devices(adb_path="adb"):
    """Return [{"serial": ..., "state": "device"|"unauthorized"|...}, ...]."""
    output = _run(["devices"], adb_path=adb_path)
    devices = []
    for line in output.splitlines()[1:]:
        line = line.strip()
        if not line or line.startswith("*"):
            continue
        parts = line.split()
        if len(parts) >= 2:
            devices.append({"serial": parts[0], "state": parts[1]})
    return devices


def wake_screen(serial, adb_path="adb"):
    _run(["-s", serial, "shell", "input", "keyevent", "224"], adb_path=adb_path)


def go_home(serial, adb_path="adb"):
    _run(["-s", serial, "shell", "input", "keyevent", "3"], adb_path=adb_path)


def tap(serial, x, y, adb_path="adb"):
    _run(["-s", serial, "shell", "input", "tap", str(int(x)), str(int(y))], adb_path=adb_path)


def open_compose(serial, number, text, adb_path="adb"):
    uri = "sms:" + number
    cmd = (
        "am start -a android.intent.action.SENDTO "
        f"-d {_shell_quote(uri)} "
        f"--es sms_body {_shell_quote(text)}"
    )
    _run(["-s", serial, "shell", cmd], adb_path=adb_path, timeout=15)


def dump_ui(serial, adb_path="adb"):
    _run(
        ["-s", serial, "shell", "uiautomator", "dump", "/sdcard/window_dump.xml"],
        adb_path=adb_path,
        timeout=20,
    )
    return _run(
        ["-s", serial, "shell", "cat", "/sdcard/window_dump.xml"],
        adb_path=adb_path,
        timeout=15,
    )


def _bounds_center(bounds_str):
    match = BOUNDS_RE.match(bounds_str or "")
    if not match:
        return None
    left, top, right, bottom = (int(v) for v in match.groups())
    return ((left + right) // 2, (top + bottom) // 2)


def find_send_button(xml_text):
    """Search a uiautomator XML dump for the most likely 'Send' control.

    Returns (x, y) of its center, or None if nothing matched.
    """
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return None

    best_score = 0
    best_node = None
    for node in root.iter("node"):
        if node.get("clickable") != "true":
            continue
        resource_id = (node.get("resource-id") or "").lower()
        text = (node.get("text") or "").strip().lower()
        desc = (node.get("content-desc") or "").strip().lower()

        if "send" in resource_id:
            score = 3
        elif text in SEND_TEXT_CANDIDATES or desc in SEND_TEXT_CANDIDATES:
            score = 2
        elif "send" in text or "send" in desc:
            score = 1
        else:
            score = 0

        if score > best_score:
            best_score = score
            best_node = node

    if best_node is None:
        return None
    return _bounds_center(best_node.get("bounds"))


def send_sms(serial, number, text, adb_path="adb", manual_tap=None):
    """Open the compose screen for `number`/`text` and tap Send.

    manual_tap: optional (x, y) fallback used only if the send button
    can't be located automatically (e.g. an unusual SMS app layout).
    Raises AdbError on failure.
    """
    open_compose(serial, number, text, adb_path=adb_path)
    time.sleep(WAIT_AFTER_OPEN_SECONDS)

    point = find_send_button(dump_ui(serial, adb_path=adb_path))

    if point is None:
        time.sleep(WAIT_BEFORE_RETRY_SECONDS)
        point = find_send_button(dump_ui(serial, adb_path=adb_path))

    if point is None and manual_tap:
        point = manual_tap

    if point is None:
        go_home(serial, adb_path=adb_path)
        raise AdbError(
            "לא נמצא כפתור 'שלח' על המסך אוטומטית. ודא שהמכשיר לא נעול "
            "ושמסך כתיבת ה-SMS נפתח בפועל, או הגדר קואורדינטות גיבוי ידניות."
        )

    tap(serial, point[0], point[1], adb_path=adb_path)
    time.sleep(WAIT_AFTER_TAP_SECONDS)
    go_home(serial, adb_path=adb_path)
    return {"tap_point": point}
