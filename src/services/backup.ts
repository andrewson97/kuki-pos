import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "fs";
import path from "path";
import { DATA_DIR, DB_PATH } from "../utils/paths";
import { todayDate } from "../utils/helpers";

// ---------------------------------------------------------------------------
// DATABASE BACKUPS: the Settings download, and a daily snapshot on the volume
// ---------------------------------------------------------------------------
// WHY VACUUM INTO, and never a plain file copy. The database runs in WAL mode
// (src/db/database.ts): a committed sale first lands in shop.db-wal and is only
// folded into shop.db at a later checkpoint. Copying shop.db on its own therefore
// hands back a file that is missing the most recent sales - possibly the whole
// day - and copying it mid-checkpoint can hand back a torn one. VACUUM INTO asks
// SQLite itself to write a complete, consistent copy as of one read transaction,
// WAL included, while the app carries on writing. The result is a single
// self-contained .db file (no -wal/-shm needed) that opens anywhere.
//
// It runs on its OWN read-only connection rather than the app's shared one from
// getDb(): VACUUM INTO refuses to run inside a transaction, and a separate
// connection can never be caught in the middle of one the app has open. It is
// synchronous, so it holds the event loop while it runs - a few milliseconds
// for a shop-sized database, which is why it is acceptable here at all.
//
// WHY "TODAY'S SNAPSHOT IF MISSING" AND NOT A 3 AM TIMER. On fly.io the machine
// auto-stops when idle (auto_stop_machines = "stop", min_machines_running = 0)
// and is only kept awake while the cash drawer is open, so at night the process
// usually does not exist and a nightly timer would simply never fire. Instead,
// on every boot and then hourly while running, take one snapshot per BUSINESS
// date (todayDate(), 5 AM Colombo rollover) if that date does not have one yet.
// In practice the first boot of the morning snapshots the database as it was at
// the end of the previous day's trading, which is exactly the copy worth
// keeping. The newest SNAPSHOT_KEEP are retained on the volume.
//
// These snapshots live on the SAME volume as the database. They protect against
// a bad migration, a mistaken bulk edit or a corrupted file - not against losing
// the volume itself. The Settings download is what gets a copy off the machine.

export const BACKUP_DIR = path.join(DATA_DIR, "backups");
const SNAPSHOT_KEEP = 14;
const SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000;

// The only filenames that are ever listed, served or pruned. The download-one
// endpoint accepts nothing that does not match this EXACTLY, which is also what
// stops path traversal: no slash, no "..", no other file on the volume.
const SNAPSHOT_RE = /^shop-(\d{4}-\d{2}-\d{2})\.db$/;

// Work-in-progress names. A snapshot is written under PARTIAL_SUFFIX and only
// renamed to its real name once VACUUM INTO has finished, so a crash or a
// machine stop half-way through can never leave a truncated file that looks
// like a complete day. Neither prefix/suffix matches SNAPSHOT_RE, so leftovers
// are invisible to listing and pruning, and sweepStaleTempFiles() removes them.
const PARTIAL_SUFFIX = ".partial";
const DOWNLOAD_TMP_PREFIX = ".backup-download-";

export interface SnapshotInfo {
  file: string;
  date: string;
  size: number;
  created_at: string; // ISO, from the file's mtime: when the snapshot was taken
}

export function isSnapshotName(name: string): boolean {
  return SNAPSHOT_RE.test(name);
}

function vacuumInto(dest: string): void {
  const src = new Database(DB_PATH, { readonly: true });
  try {
    // VACUUM INTO takes the path as a string literal, not a bound parameter, so
    // quote it the SQL way (same as scripts/backup.ts).
    src.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }
}

// One-off consistent copy for the Settings "Download Database Backup" button.
// Written next to the live DB (same volume, so there is room and no cross-device
// surprises), read into memory, and deleted before the response goes out - so
// nothing is left behind even if the client disconnects mid-download. Holding
// the copy in memory is fine at this shop's size (a few MB against a 512 MB VM).
export async function createDownloadSnapshot(): Promise<Uint8Array> {
  const tmp = path.join(DATA_DIR, `${DOWNLOAD_TMP_PREFIX}${crypto.randomUUID()}.db`);
  try {
    vacuumInto(tmp);
    return new Uint8Array(await Bun.file(tmp).arrayBuffer());
  } finally {
    try { rmSync(tmp, { force: true }); } catch {}
  }
}

export function listSnapshots(): SnapshotInfo[] {
  if (!existsSync(BACKUP_DIR)) return [];
  const out: SnapshotInfo[] = [];
  for (const file of readdirSync(BACKUP_DIR)) {
    const m = SNAPSHOT_RE.exec(file);
    if (!m) continue;
    try {
      const st = statSync(path.join(BACKUP_DIR, file));
      out.push({ file, date: m[1]!, size: st.size, created_at: st.mtime.toISOString() });
    } catch {}
  }
  // YYYY-MM-DD sorts lexically, newest first.
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

// Absolute path of a snapshot to serve, or null if the name is not exactly a
// snapshot name or no such file exists. Callers must go through this.
export function snapshotPath(name: string): string | null {
  if (!isSnapshotName(name)) return null;
  const full = path.join(BACKUP_DIR, name);
  return existsSync(full) ? full : null;
}

function pruneSnapshots(): void {
  for (const s of listSnapshots().slice(SNAPSHOT_KEEP)) {
    try {
      rmSync(path.join(BACKUP_DIR, s.file), { force: true });
    } catch (err) {
      console.error(`[backup] could not delete old snapshot ${s.file}`, err);
    }
  }
}

// Take today's snapshot if there is none yet. Never throws: a failed backup
// must not take the till down with it, so it logs loudly and returns.
export function ensureDailySnapshot(): void {
  try {
    mkdirSync(BACKUP_DIR, { recursive: true });
    const date = todayDate();
    const final = path.join(BACKUP_DIR, `shop-${date}.db`);
    if (existsSync(final)) return;

    const partial = final + PARTIAL_SUFFIX;
    // VACUUM INTO will not overwrite an existing file; clear any leftover first.
    rmSync(partial, { force: true });
    const started = Date.now();
    vacuumInto(partial);
    renameSync(partial, final);
    const size = statSync(final).size;
    console.log(`[backup] daily snapshot ${path.basename(final)} taken (${(size / 1024).toFixed(0)} KB, ${Date.now() - started} ms)`);

    pruneSnapshots();
  } catch (err) {
    console.error("[backup] !!! DAILY SNAPSHOT FAILED - the database was NOT backed up !!!", err);
  }
}

// Leftovers from a download or snapshot that was interrupted by a crash or a
// machine stop. Safe at boot: nothing can be writing them yet.
function sweepStaleTempFiles(): void {
  const sweep = (dir: string, match: (f: string) => boolean) => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      if (!match(f)) continue;
      try { rmSync(path.join(dir, f), { force: true }); } catch {}
    }
  };
  try {
    sweep(DATA_DIR, (f) => f.startsWith(DOWNLOAD_TMP_PREFIX));
    sweep(BACKUP_DIR, (f) => f.endsWith(PARTIAL_SUFFIX));
  } catch (err) {
    console.error("[backup] could not sweep stale temp files", err);
  }
}

// Call once at startup, after migrations have run.
export function startBackupSchedule(): void {
  sweepStaleTempFiles();
  ensureDailySnapshot();
  // unref(): the HTTP server is what keeps the process alive, never this timer.
  setInterval(ensureDailySnapshot, SNAPSHOT_INTERVAL_MS).unref();
}
