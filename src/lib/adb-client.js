// Talks to the Android phone over WebUSB using the ADB protocol directly in
// the browser (Tango/ya-webadb libraries) - no native adb binary, no backend
// server. Opens the SMS compose screen for a contact, then finds and taps
// the on-screen "Send" button by reading the live UI hierarchy instead of
// relying on fixed screen coordinates (every SMS app/screen size differs).

import { Adb, AdbDaemonTransport, escapeArg } from "@yume-chan/adb";
import { AdbDaemonWebUsbDeviceManager } from "@yume-chan/adb-daemon-webusb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";

const WAIT_AFTER_OPEN_MS = 1600;
const WAIT_BEFORE_RETRY_MS = 1200;
const WAIT_AFTER_TAP_MS = 1000;

const SEND_TEXT_CANDIDATES = new Set(["send", "שלח"]);
const BOUNDS_RE = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/;

export class AdbError extends Error {}

const credentialStore = new AdbWebCredentialStore("SMS Click Sender");

export function isWebUsbSupported() {
  return typeof navigator !== "undefined" && !!navigator.usb;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shellText(adb, command) {
  try {
    return await adb.subprocess.noneProtocol.spawnWaitText(command);
  } catch (err) {
    throw new AdbError(`פעולה בטלפון נכשלה: ${err.message || err}`);
  }
}

// Opens the browser's device picker and completes the ADB auth handshake.
// The phone will show "Allow USB debugging?" the first time - that tap on
// the phone screen is a required Android security step and can't be
// automated. Returns a ready-to-use Adb instance.
export async function connect() {
  if (!isWebUsbSupported()) {
    throw new AdbError(
      "הדפדפן הזה לא תומך ב-WebUSB. יש להשתמש ב-Chrome, Edge או Opera (לא Firefox/Safari)."
    );
  }

  const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
  const device = await manager.requestDevice();
  if (!device) {
    throw new AdbError("לא נבחר מכשיר.");
  }

  let connection;
  try {
    connection = await device.connect();
  } catch (err) {
    throw new AdbError(`לא ניתן להתחבר להתקן USB: ${err.message || err}`);
  }

  let transport;
  try {
    transport = await AdbDaemonTransport.authenticate({
      serial: device.serial,
      connection,
      credentialStore,
    });
  } catch (err) {
    throw new AdbError(
      `אימות ADB נכשל. ודא שניפוי USB מופעל בטלפון ושאישרת את הבקשה על המסך: ${err.message || err}`
    );
  }

  return new Adb(transport);
}

export function wakeScreen(adb) {
  return shellText(adb, "input keyevent 224");
}

export function goHome(adb) {
  return shellText(adb, "input keyevent 3");
}

export function tap(adb, x, y) {
  return shellText(adb, `input tap ${Math.round(x)} ${Math.round(y)}`);
}

export function openCompose(adb, number, text) {
  const uri = "sms:" + number;
  const cmd =
    "am start -a android.intent.action.SENDTO " +
    `-d ${escapeArg(uri)} ` +
    `--es sms_body ${escapeArg(text)}`;
  return shellText(adb, cmd);
}

export async function dumpUi(adb) {
  await shellText(adb, "uiautomator dump /sdcard/window_dump.xml");
  return shellText(adb, "cat /sdcard/window_dump.xml");
}

function boundsCenter(boundsStr) {
  const match = BOUNDS_RE.exec(boundsStr || "");
  if (!match) return null;
  const [, l, t, r, b] = match.map(Number);
  return [Math.round((l + r) / 2), Math.round((t + b) / 2)];
}

// Search a uiautomator XML dump for the most likely "Send" control.
// Returns [x, y] of its center, or null if nothing matched.
export function findSendButton(xmlText) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(xmlText, "text/xml");
  } catch {
    return null;
  }
  if (doc.getElementsByTagName("parsererror").length) return null;

  let bestScore = 0;
  let bestNode = null;

  for (const node of doc.getElementsByTagName("node")) {
    if (node.getAttribute("clickable") !== "true") continue;

    const resourceId = (node.getAttribute("resource-id") || "").toLowerCase();
    const text = (node.getAttribute("text") || "").trim().toLowerCase();
    const desc = (node.getAttribute("content-desc") || "").trim().toLowerCase();

    let score = 0;
    if (resourceId.includes("send")) {
      score = 3;
    } else if (SEND_TEXT_CANDIDATES.has(text) || SEND_TEXT_CANDIDATES.has(desc)) {
      score = 2;
    } else if (text.includes("send") || desc.includes("send")) {
      score = 1;
    }

    if (score > bestScore) {
      bestScore = score;
      bestNode = node;
    }
  }

  if (!bestNode) return null;
  return boundsCenter(bestNode.getAttribute("bounds"));
}

// Opens the compose screen for number/text and taps Send.
// manualTap: optional [x, y] fallback used only if the send button can't be
// located automatically (e.g. an unusual SMS app layout). Throws AdbError.
export async function sendSms(adb, number, text, manualTap = null) {
  await openCompose(adb, number, text);
  await sleep(WAIT_AFTER_OPEN_MS);

  let point = findSendButton(await dumpUi(adb));

  if (!point) {
    await sleep(WAIT_BEFORE_RETRY_MS);
    point = findSendButton(await dumpUi(adb));
  }

  if (!point && manualTap) {
    point = manualTap;
  }

  if (!point) {
    await goHome(adb);
    throw new AdbError(
      "לא נמצא כפתור 'שלח' על המסך אוטומטית. ודא שהמכשיר לא נעול ושמסך כתיבת ה-SMS " +
        "נפתח בפועל, או הגדר קואורדינטות גיבוי ידניות."
    );
  }

  await tap(adb, point[0], point[1]);
  await sleep(WAIT_AFTER_TAP_MS);
  await goHome(adb);
  return { tapPoint: point };
}
