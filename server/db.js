// Tiny JSON-file "database" - no native modules, so it runs anywhere Node
// runs (including constrained shared hosting where compiling something like
// better-sqlite3 can fail). The data here is intentionally tiny: a password
// hash and a handful of schedule records. Writes are serialized through a
// single in-process queue and written atomically (write to a temp file,
// then rename) so a crash mid-write can't corrupt the file.

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

const DEFAULT_DB = {
  // { salt: hex, hash: hex } - set once via POST /api/setup.
  passwordHash: null,
  // Desktop-run schedules hold only scheduling metadata. Phone-run ones
  // (runMode: "phone") also carry a payload field with the actual contacts
  // + message content - see the comment at the top of index.js.
  schedules: [],
};

function ensureDataDir() {
  if (!fsSync.existsSync(DATA_DIR)) {
    fsSync.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export async function readDb() {
  ensureDataDir();
  try {
    const text = await fs.readFile(DB_FILE, "utf8");
    return { ...structuredClone(DEFAULT_DB), ...JSON.parse(text) };
  } catch (err) {
    if (err.code === "ENOENT") return structuredClone(DEFAULT_DB);
    throw err;
  }
}

let writeQueue = Promise.resolve();

// Serializes all writes so concurrent requests can't race and corrupt the
// file. `mutator(db)` returns the next db state to persist and return.
export function updateDb(mutator) {
  writeQueue = writeQueue.then(async () => {
    const db = await readDb();
    const next = await mutator(db);
    ensureDataDir();
    const tmpFile = `${DB_FILE}.${process.pid}.tmp`;
    await fs.writeFile(tmpFile, JSON.stringify(next, null, 2), "utf8");
    await fs.rename(tmpFile, DB_FILE);
    return next;
  });
  return writeQueue;
}
