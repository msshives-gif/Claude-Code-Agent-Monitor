/**
 * @file cursor-state-db.js
 * @description Best-effort, read-only lookup of Cursor chat titles from the
 * Cursor IDE's global state store (User/globalStorage/state.vscdb). Cursor
 * keeps each agent chat under `cursorDiskKV` as `composerData:<composerId>`,
 * where the composer id is the agent-transcripts folder name and `name` is the
 * title shown in Cursor. Any failure (missing file, lock, unexpected schema,
 * no SQLite driver) yields no title so ingestion falls back to its defaults.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { isSafeCursorId } = require("./cursor-home");

const TITLE_QUERY =
  "SELECT json_extract(CAST(value AS TEXT), '$.name') AS name FROM cursorDiskKV WHERE key = ?";
// Cursor is the only writer; never wait on its locks during an ingest pass.
const BUSY_TIMEOUT_MS = 250;

/** Default location of Cursor's global state.vscdb per platform (override: DASHBOARD_CURSOR_STATE_DB). */
function getCursorStateDbPath() {
  const override = process.env.DASHBOARD_CURSOR_STATE_DB;
  const home = os.homedir();
  if (override) return path.resolve(override.replace(/^~(?=$|[\\/])/, home));
  let userDir;
  if (process.platform === "darwin") {
    userDir = path.join(home, "Library", "Application Support", "Cursor", "User");
  } else if (process.platform === "win32") {
    userDir = path.join(
      process.env.APPDATA || path.join(home, "AppData", "Roaming"),
      "Cursor",
      "User"
    );
  } else {
    userDir = path.join(
      process.env.XDG_CONFIG_HOME || path.join(home, ".config"),
      "Cursor",
      "User"
    );
  }
  return path.join(userDir, "globalStorage", "state.vscdb");
}

let openReadOnly;

/** Pick a SQLite driver once, preferring better-sqlite3 like server/db.js. */
function readOnlyOpener() {
  if (openReadOnly !== undefined) return openReadOnly;
  openReadOnly = null;
  try {
    const Database = require("better-sqlite3");
    // The native addon loads lazily; probe it so an ABI mismatch falls back.
    new Database(":memory:").close();
    openReadOnly = (filePath) =>
      new Database(filePath, { readonly: true, fileMustExist: true, timeout: BUSY_TIMEOUT_MS });
  } catch {
    try {
      const { DatabaseSync } = require("node:sqlite");
      openReadOnly = (filePath) => {
        if (!fs.statSync(filePath).isFile()) throw new Error("not a file");
        return new DatabaseSync(filePath, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
      };
    } catch {
      // No SQLite driver: titles stay unavailable.
    }
  }
  return openReadOnly;
}

/**
 * Create a per-sync-pass title lookup. The database opens lazily on the first
 * call; after any error the lookup stays disabled until the next pass so a
 * locked or unexpected store costs at most one short wait per pass.
 * @returns {{ title: (sessionId: string) => string | null, close: () => void }}
 */
function createCursorTitleLookup(filePath = getCursorStateDbPath()) {
  let db = null;
  let stmt = null;
  let disabled = !filePath;

  function close() {
    try {
      db?.close();
    } catch {
      // Already closed or never fully opened.
    }
    db = null;
    stmt = null;
  }

  function title(sessionId) {
    if (disabled || !isSafeCursorId(sessionId)) return null;
    try {
      if (!stmt) {
        const open = readOnlyOpener();
        if (!open) throw new Error("no SQLite driver");
        db = open(filePath);
        stmt = db.prepare(TITLE_QUERY);
      }
      const name = stmt.get(`composerData:${sessionId}`)?.name;
      return typeof name === "string" && name.trim() ? name : null;
    } catch {
      disabled = true;
      close();
      return null;
    }
  }

  return { title, close };
}

module.exports = { createCursorTitleLookup, getCursorStateDbPath };
