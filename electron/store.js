// Local-only settings for the desktop app: which server to poll, the
// signed-in account's session token, and the actual content (contact rows
// + message template) for each schedule this machine is responsible for
// running. None of this ever leaves the machine except the token, sent to
// the server the user configured, to authenticate the polling/ack
// requests - the password itself is only ever sent once, at login.

import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";

const STORE_FILE = path.join(app.getPath("userData"), "store.json");

function readRaw() {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  } catch {
    return { serverUrl: null, email: null, tokenEncrypted: null, localJobs: {} };
  }
}

function writeRaw(data) {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), "utf8");
}

// safeStorage ties encryption to the OS credential store (Keychain/DPAPI/
// libsecret). It can be unavailable (e.g. a Linux box with no keyring) -
// fall back to plain storage rather than failing outright.
function encrypt(text) {
  if (safeStorage.isEncryptionAvailable()) return safeStorage.encryptString(text).toString("base64");
  return Buffer.from(text, "utf8").toString("base64");
}

function decrypt(base64) {
  const buf = Buffer.from(base64, "base64");
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(buf);
    } catch {
      return null;
    }
  }
  return buf.toString("utf8");
}

export function getServerConfig() {
  const data = readRaw();
  if (!data.serverUrl || !data.email || !data.tokenEncrypted) return null;
  const token = decrypt(data.tokenEncrypted);
  if (token === null) return null;
  return { url: data.serverUrl, email: data.email, token };
}

export function setServerConfig({ url, email, token }) {
  const data = readRaw();
  data.serverUrl = String(url).replace(/\/+$/, "");
  data.email = String(email);
  data.tokenEncrypted = encrypt(String(token));
  writeRaw(data);
  return getServerConfig();
}

export function clearServerConfig() {
  const data = readRaw();
  data.serverUrl = null;
  data.email = null;
  data.tokenEncrypted = null;
  writeRaw(data);
}

export function getLocalJob(scheduleId) {
  return readRaw().localJobs[scheduleId] || null;
}

export function saveLocalJob(scheduleId, jobData) {
  const data = readRaw();
  data.localJobs[scheduleId] = jobData;
  writeRaw(data);
}

export function deleteLocalJob(scheduleId) {
  const data = readRaw();
  delete data.localJobs[scheduleId];
  writeRaw(data);
}

export function listLocalJobIds() {
  return Object.keys(readRaw().localJobs);
}
