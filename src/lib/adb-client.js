// Talks to the Android phone over WebUSB using the ADB protocol directly in
// the browser (Tango/ya-webadb libraries) - no native adb binary, no backend
// server. Opens the SMS compose screen for a contact, then finds and taps
// the on-screen "Send" button by reading the live UI hierarchy instead of
// relying on fixed screen coordinates (every SMS app/screen size differs).

import { Adb, AdbDaemonTransport, escapeArg } from "@yume-chan/adb";
import { AdbDaemonWebUsbDeviceManager } from "@yume-chan/adb-daemon-webusb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";
import { normalizePhone } from "./excel.js";

const WAIT_AFTER_OPEN_MS = 1600;
const WAIT_BEFORE_RETRY_MS = 1200;
const WAIT_AFTER_TAP_MS = 1000;

const SEND_TEXT_CANDIDATES = new Set(["send", "שלח"]);
const SAVE_TEXT_CANDIDATES = new Set(["save", "done", "שמור", "סיום", "אישור"]);
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

async function finishConnect(device) {
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

  return finishConnect(device);
}

// Silently reconnects to a phone that was already authorized in a previous
// session - no device picker, no user gesture needed (browsers remember
// WebUSB grants per origin+device; the Electron app auto-authorizes every
// USB device, see electron/main.js). Used on startup so the background
// scheduler has a chance to run without the user reopening the app and
// clicking "Connect" first. Returns null instead of throwing if nothing is
// available to reconnect to.
export async function reconnect() {
  if (!isWebUsbSupported()) return null;
  try {
    const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
    const [device] = await manager.getDevices();
    if (!device) return null;
    return await finishConnect(device);
  } catch {
    return null;
  }
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

// Per-channel "open the compose screen with number+text already filled in".
// Everything after that (finding & tapping Send) is identical regardless
// of channel, so only this part differs between SMS and WhatsApp.
const CHANNELS = {
  sms: {
    openCompose(adb, number, text) {
      const uri = "sms:" + number;
      const cmd =
        "am start -a android.intent.action.SENDTO " +
        `-d ${escapeArg(uri)} ` +
        `--es sms_body ${escapeArg(text)}`;
      return shellText(adb, cmd);
    },
    notFoundHint:
      "לא נמצא כפתור 'שלח' על המסך אוטומטית. ודא שהמכשיר לא נעול ושמסך כתיבת ה-SMS " +
      "נפתח בפועל, או הגדר קואורדינטות גיבוי ידניות.",
  },
  whatsapp: {
    // number here must already be in full international format with no
    // "+" (see phone.js) - that's what WhatsApp's click-to-chat link needs.
    openCompose(adb, number, text) {
      const uri = `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
      const cmd = `am start -a android.intent.action.VIEW -d ${escapeArg(uri)}`;
      return shellText(adb, cmd);
    },
    notFoundHint:
      "לא נמצא כפתור 'שלח' על המסך אוטומטית. ייתכן שלאיש הקשר הזה אין וואטסאפ, " +
      "שהמכשיר נעול, או שמסך הצ'אט לא נפתח - אפשר גם להגדיר קואורדינטות גיבוי ידניות.",
  },
};

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

// Search a uiautomator XML dump for the most likely control matching the
// given hints. Scores nodes by: resource-id containing resourceIdHint (3) >
// exact text/content-desc match against textCandidates (2) > text/desc just
// containing resourceIdHint (1). Returns [x, y] of the best match's center,
// or null if nothing matched.
function findButton(xmlText, { resourceIdHint, textCandidates }) {
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
    if (resourceId.includes(resourceIdHint)) {
      score = 3;
    } else if (textCandidates.has(text) || textCandidates.has(desc)) {
      score = 2;
    } else if (text.includes(resourceIdHint) || desc.includes(resourceIdHint)) {
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

// Search a uiautomator XML dump for the most likely "Send" control.
// Returns [x, y] of its center, or null if nothing matched.
export function findSendButton(xmlText) {
  return findButton(xmlText, { resourceIdHint: "send", textCandidates: SEND_TEXT_CANDIDATES });
}

// Search a uiautomator XML dump for the most likely "Save"/"Done" control
// (used when confirming a new contact on the native "Create contact" screen).
export function findSaveButton(xmlText) {
  return findButton(xmlText, { resourceIdHint: "save", textCandidates: SAVE_TEXT_CANDIDATES });
}

// Opens the compose screen for number/text on the given channel ("sms" or
// "whatsapp") and taps Send. manualTap: optional [x, y] fallback used only
// if the send button can't be located automatically (e.g. an unusual app
// layout). Throws AdbError - for WhatsApp, a "button not found" failure
// commonly just means that contact doesn't have WhatsApp (there's no way
// to check that without attempting to open the chat - see the hint text).
export async function sendMessage(adb, channel, number, text, manualTap = null) {
  const impl = CHANNELS[channel];
  if (!impl) throw new AdbError(`ערוץ שליחה לא מוכר: ${channel}`);

  await impl.openCompose(adb, number, text);
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
    throw new AdbError(impl.notFoundHint);
  }

  await tap(adb, point[0], point[1]);
  await sleep(WAIT_AFTER_TAP_MS);
  await goHome(adb);
  return { tapPoint: point };
}

// Opens Android's native "Create contact" screen pre-filled with name+number
// and taps Save/Done. Mirrors sendMessage's open -> dump -> find -> tap ->
// goHome flow. manualTap: optional [x, y] fallback if the Save button can't
// be located automatically.
export async function createContact(adb, name, number, manualTap = null) {
  const cmd =
    "am start -a android.intent.action.INSERT -t vnd.android.cursor.dir/contact " +
    `--es name ${escapeArg(name)} --es phone ${escapeArg(number)}`;
  await shellText(adb, cmd);
  await sleep(WAIT_AFTER_OPEN_MS);

  let point = findSaveButton(await dumpUi(adb));

  if (!point) {
    await sleep(WAIT_BEFORE_RETRY_MS);
    point = findSaveButton(await dumpUi(adb));
  }

  if (!point && manualTap) {
    point = manualTap;
  }

  if (!point) {
    await goHome(adb);
    throw new AdbError(
      "לא נמצא כפתור 'שמור' על מסך יצירת איש הקשר. ודא שהמכשיר לא נעול, או הגדר קואורדינטות גיבוי ידניות."
    );
  }

  await tap(adb, point[0], point[1]);
  await sleep(WAIT_AFTER_TAP_MS);
  await goHome(adb);
  return { tapPoint: point };
}

const PHONE_QUERY_LINE_RE = /data1=(.+)$/;

// Reads every phone number already saved in the device's Contacts Provider,
// normalized the same way normalizePhone() normalizes uploaded numbers -
// so callers can dedupe by simple Set membership before creating anything.
export async function listExistingPhoneNumbers(adb) {
  const output = await shellText(
    adb,
    "content query --uri content://com.android.contacts/data/phones --projection data1"
  );
  const numbers = new Set();
  for (const line of output.split("\n")) {
    const match = PHONE_QUERY_LINE_RE.exec(line.trim());
    if (!match) continue;
    const normalized = normalizePhone(match[1].trim());
    if (normalized) numbers.add(normalized);
  }
  return numbers;
}
