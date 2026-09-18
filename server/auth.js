// Password hashing using Node's built-in crypto.scrypt - no native
// dependency (bcrypt/argon2 native bindings are a common source of install
// failures on shared hosting), no external service, just Node itself.

import crypto from "node:crypto";

const KEY_LENGTH = 64;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH).toString("hex");
  return { salt, hash };
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.salt || !stored.hash) return false;
  const candidate = crypto.scryptSync(password, stored.salt, KEY_LENGTH);
  const expected = Buffer.from(stored.hash, "hex");
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

// Opaque session token minted at login and checked (not decoded) on every
// authenticated request - the actual password is only ever sent once, at
// login, rather than reused as the ongoing credential on every call.
export function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}
