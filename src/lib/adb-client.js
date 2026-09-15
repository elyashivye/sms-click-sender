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
const GROUPS_FILTER_TEXT_CANDIDATES = new Set(["groups", "קבוצות"]);
const BOUNDS_RE = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/;
const WHATSAPP_PACKAGE = "com.whatsapp";

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

function parseUiDump(xmlText) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(xmlText, "text/xml");
  } catch {
    return null;
  }
  if (doc.getElementsByTagName("parsererror").length) return null;
  return doc;
}

// Search a uiautomator XML dump for the most likely control matching the
// given hints. Scores nodes by: resource-id containing resourceIdHint (3) >
// exact text/content-desc match against textCandidates (2) > text/desc just
// containing resourceIdHint (1). resourceIdHint is optional - omit it when
// there's no reliable substring to guess (e.g. "group" would false-positive
// on too many unrelated resource-ids in a chat app) and score purely on
// exact text/content-desc matches instead. Returns [x, y] of the best
// match's center, or null if nothing matched.
function findButton(xmlText, { resourceIdHint = null, textCandidates }) {
  const doc = parseUiDump(xmlText);
  if (!doc) return null;

  let bestScore = 0;
  let bestNode = null;

  for (const node of doc.getElementsByTagName("node")) {
    if (node.getAttribute("clickable") !== "true") continue;

    const resourceId = (node.getAttribute("resource-id") || "").toLowerCase();
    const text = (node.getAttribute("text") || "").trim().toLowerCase();
    const desc = (node.getAttribute("content-desc") || "").trim().toLowerCase();

    let score = 0;
    if (resourceIdHint && resourceId.includes(resourceIdHint)) {
      score = 3;
    } else if (textCandidates.has(text) || textCandidates.has(desc)) {
      score = 2;
    } else if (resourceIdHint && (text.includes(resourceIdHint) || desc.includes(resourceIdHint))) {
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

// Search a uiautomator XML dump for the chat list's "Groups" filter chip.
// No resourceIdHint on purpose - a chat app has many resource-ids containing
// "group" (new-group button, group icon, group settings...), so this relies
// only on an exact text/content-desc match to avoid false positives.
export function findGroupsFilterChip(xmlText) {
  return findButton(xmlText, { textCandidates: GROUPS_FILTER_TEXT_CANDIDATES });
}

// Search a uiautomator XML dump for a clickable node whose text or
// content-desc exactly equals the given label (case-insensitive) - used to
// tap a chat-list row or a screen title by its exact visible name.
export function findExactTextButton(xmlText, label) {
  return findButton(xmlText, { textCandidates: new Set([label.trim().toLowerCase()]) });
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

// ---------- WhatsApp groups import (chat-list scraping via ADB/uiautomator) ----------
//
// There's no official API for a personal WhatsApp account to list its
// groups/members - the only way to get this without WhatsApp Business API
// is reading the on-screen UI, the same way sendMessage() finds "Send".
// This is inherently more fragile than a single button: it depends on
// WhatsApp's current chat-list "Groups" filter chip existing and on rough
// assumptions about how a chat/participant row's text is laid out. Every
// function here degrades to an empty result or a clear AdbError rather than
// silently returning wrong data - but the extraction heuristics themselves
// may need adjustment against a real, current WhatsApp version.

const DEFAULT_SCREEN_SIZE = [1080, 2280];
const PHONE_LIKE_RE = /\+?\d[\d\s\-()]{6,}\d/;

export function openWhatsApp(adb) {
  return shellText(adb, `monkey -p ${WHATSAPP_PACKAGE} -c android.intent.category.LAUNCHER 1`);
}

function screenSize(xmlText) {
  const doc = parseUiDump(xmlText);
  const first = doc?.getElementsByTagName("node")[0];
  const bounds = BOUNDS_RE.exec(first?.getAttribute("bounds") || "");
  if (!bounds) return null;
  const [, , , r, b] = bounds.map(Number);
  return [r, b];
}

async function scrollDown(adb, xmlText) {
  const [w, h] = screenSize(xmlText) || DEFAULT_SCREEN_SIZE;
  const x = Math.round(w / 2);
  await shellText(adb, `input swipe ${x} ${Math.round(h * 0.78)} ${x} ${Math.round(h * 0.3)} 300`);
}

// Scrapes a chat-list screen (already filtered to just groups) for its
// visible rows: each full-width clickable node is a chat row, and its name
// is either the first comma-separated part of its content-desc (a common
// Android accessibility pattern: "GroupName, last message, time") or,
// failing that, the first non-empty text found among its descendants.
function extractChatRows(xmlText) {
  const doc = parseUiDump(xmlText);
  if (!doc) return [];

  const screenWidth = screenSize(xmlText)?.[0] ?? null;
  const rows = [];

  for (const node of doc.getElementsByTagName("node")) {
    if (node.getAttribute("clickable") !== "true") continue;
    const boundsAttr = node.getAttribute("bounds");
    const bounds = BOUNDS_RE.exec(boundsAttr || "");
    if (!bounds) continue;
    const [, l, , r] = bounds.map(Number);
    if (screenWidth && r - l < screenWidth * 0.85) continue;

    const desc = (node.getAttribute("content-desc") || "").trim();
    let name = desc ? desc.split(",")[0].trim() : "";
    if (!name) {
      for (const child of node.getElementsByTagName("node")) {
        const text = (child.getAttribute("text") || "").trim();
        if (text) {
          name = text;
          break;
        }
      }
    }

    if (name) rows.push({ name, point: boundsCenter(boundsAttr) });
  }
  return rows;
}

function collectTextFragments(doc) {
  const fragments = [];
  for (const node of doc.getElementsByTagName("node")) {
    const value = (node.getAttribute("text") || "").trim() || (node.getAttribute("content-desc") || "").trim();
    if (!value) continue;
    const bounds = BOUNDS_RE.exec(node.getAttribute("bounds") || "");
    if (!bounds) continue;
    const [, , t, , b] = bounds.map(Number);
    fragments.push({ value, top: t, bottom: b });
  }
  return fragments;
}

// Two lines within the same list row (e.g. a saved name above its phone
// number) usually sit close together but don't actually overlap - only the
// gap *between* separate rows is reliably bigger than this. There's no way
// to derive the right threshold without a real device to measure against,
// so this is a best-effort constant, not a measured one.
const ROW_GAP_THRESHOLD = 24;

// Clusters text fragments into visual rows by vertical position - a
// generic way to turn a flat accessibility tree back into "list items"
// without knowing the real container structure.
function groupFragmentsIntoRows(fragments) {
  const sorted = [...fragments].sort((a, b) => a.top - b.top);
  const rows = [];
  for (const frag of sorted) {
    const lastRow = rows[rows.length - 1];
    if (lastRow && frag.top - lastRow.bottom <= ROW_GAP_THRESHOLD) {
      lastRow.values.push(frag.value);
      lastRow.bottom = Math.max(lastRow.bottom, frag.bottom);
    } else {
      rows.push({ values: [frag.value], top: frag.top, bottom: frag.bottom });
    }
  }
  return rows;
}

// Reads a "Group info" screen (already open) for participant rows: any
// visual row containing a phone-number-shaped fragment is treated as a
// participant, with whichever other fragment in that row (a saved contact
// name, if any) used as the display name. Rows with no phone-shaped
// fragment at all (section headings, "N participants", "You"...) are
// skipped rather than guessed at.
export function extractParticipants(xmlText) {
  const doc = parseUiDump(xmlText);
  if (!doc) return [];

  const participants = [];
  for (const row of groupFragmentsIntoRows(collectTextFragments(doc))) {
    const phoneValue = row.values.find((v) => PHONE_LIKE_RE.test(v));
    if (!phoneValue) continue;
    const phone = normalizePhone(phoneValue);
    if (!phone) continue;
    const nameValue = row.values.find((v) => v !== phoneValue) || phoneValue;
    participants.push({ name: nameValue, phone });
  }
  return participants;
}

async function tapGroupsFilter(adb) {
  let point = findGroupsFilterChip(await dumpUi(adb));
  if (!point) {
    await sleep(WAIT_BEFORE_RETRY_MS);
    point = findGroupsFilterChip(await dumpUi(adb));
  }
  if (!point) {
    await goHome(adb);
    throw new AdbError(
      "לא נמצא הפילטר 'קבוצות' ברשימת הצ'אטים בוואטסאפ. ודא שהמכשיר לא נעול, שוואטסאפ נפתח " +
        "בפועל, ושגרסת וואטסאפ המותקנת מציגה את הפילטר הזה בראש רשימת הצ'אטים."
    );
  }
  await tap(adb, point[0], point[1]);
  await sleep(WAIT_AFTER_TAP_MS);
}

// Opens WhatsApp, filters the chat list to groups only, and scrolls through
// it collecting every group name - cheap enough to run before the user has
// picked anything (fetchGroupMembers below is the expensive per-group part).
export async function listGroupChats(adb, { maxScrolls = 15, onProgress } = {}) {
  await openWhatsApp(adb);
  await sleep(WAIT_AFTER_OPEN_MS);
  await tapGroupsFilter(adb);

  const seen = new Set();
  const names = [];
  let previousXml = "";

  for (let i = 0; i < maxScrolls; i += 1) {
    const xml = await dumpUi(adb);
    for (const row of extractChatRows(xml)) {
      if (seen.has(row.name)) continue;
      seen.add(row.name);
      names.push(row.name);
    }
    onProgress?.(names.length);
    if (xml === previousXml) break;
    previousXml = xml;
    await scrollDown(adb, xml);
    await sleep(WAIT_BEFORE_RETRY_MS);
  }

  await goHome(adb);
  return names;
}

// Opens a specific group (by its exact chat-list name) and reads its member
// list from the Group Info screen. Independent per call (re-opens WhatsApp
// and re-filters to Groups each time) so a failure on one group can't take
// down the rest of a multi-group import.
export async function fetchGroupMembers(adb, groupName) {
  await openWhatsApp(adb);
  await sleep(WAIT_AFTER_OPEN_MS);
  await tapGroupsFilter(adb);

  let rowPoint = null;
  for (let i = 0; i < 15 && !rowPoint; i += 1) {
    const xml = await dumpUi(adb);
    rowPoint = extractChatRows(xml).find((row) => row.name === groupName)?.point ?? null;
    if (rowPoint) break;
    await scrollDown(adb, xml);
    await sleep(WAIT_BEFORE_RETRY_MS);
  }
  if (!rowPoint) {
    await goHome(adb);
    throw new AdbError(`הקבוצה "${groupName}" לא נמצאה ברשימת הצ'אטים (ייתכן ששמה השתנה או שהקבוצה נמחקה).`);
  }

  await tap(adb, rowPoint[0], rowPoint[1]);
  await sleep(WAIT_AFTER_OPEN_MS);

  let headerPoint = findExactTextButton(await dumpUi(adb), groupName);
  if (!headerPoint) {
    await sleep(WAIT_BEFORE_RETRY_MS);
    headerPoint = findExactTextButton(await dumpUi(adb), groupName);
  }
  if (!headerPoint) {
    await goHome(adb);
    throw new AdbError(`נפתחה הקבוצה "${groupName}" אך לא נמצאה כותרת הקבוצה כדי לפתוח את פרטי הקבוצה.`);
  }
  await tap(adb, headerPoint[0], headerPoint[1]);
  await sleep(WAIT_AFTER_OPEN_MS);

  const seenPhones = new Set();
  const members = [];
  let previousXml = "";

  for (let i = 0; i < 15; i += 1) {
    const xml = await dumpUi(adb);
    for (const member of extractParticipants(xml)) {
      if (seenPhones.has(member.phone)) continue;
      seenPhones.add(member.phone);
      members.push(member);
    }
    if (xml === previousXml) break;
    previousXml = xml;
    await scrollDown(adb, xml);
    await sleep(WAIT_BEFORE_RETRY_MS);
  }

  await goHome(adb);
  return members;
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
