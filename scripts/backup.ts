// Daily backup script for KUKI POS.
// Usage: bun run scripts/backup.ts
//
// Edit BACKUP_DIR below to your Google Drive-synced folder.
// Recommended: a folder inside your "Google Drive" path that auto-syncs to the cloud.

import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, statSync, rmSync, existsSync } from "fs";
import path from "path";
import { spawnSync } from "child_process";

// === CONFIG ===
// Change this to your local Google Drive folder, e.g.:
//   "G:/My Drive/kuki-backups"     (if Google Drive uses drive letter G)
//   "C:/Users/you/Google Drive/kuki-backups"
const BACKUP_DIR = process.env.BACKUP_DIR || "C:/kuki-backups";
const KEEP_DAYS = 30;
// =============

const DB_PATH = process.env.DB_PATH || path.join(import.meta.dir, "../data/shop.db");
const DATA_DIR = path.dirname(DB_PATH);
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");

function pad(n: number) { return String(n).padStart(2, "0"); }
const now = new Date();
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;

mkdirSync(BACKUP_DIR, { recursive: true });

const tmpDir = path.join(BACKUP_DIR, `.tmp_${stamp}`);
mkdirSync(tmpDir, { recursive: true });

// 1. Snapshot the DB safely (VACUUM INTO works even with the app running).
const dbBackupPath = path.join(tmpDir, "shop.db");
console.log(`Snapshotting database to ${dbBackupPath}...`);
const db = new Database(DB_PATH, { readonly: true });
db.exec(`VACUUM INTO '${dbBackupPath.replace(/'/g, "''")}'`);
db.close();

// 2. Copy uploads folder so product images come along.
if (existsSync(UPLOADS_DIR)) {
  const dest = path.join(tmpDir, "uploads");
  mkdirSync(dest, { recursive: true });
  for (const f of readdirSync(UPLOADS_DIR)) {
    const src = path.join(UPLOADS_DIR, f);
    if (statSync(src).isFile()) {
      Bun.write(path.join(dest, f), Bun.file(src));
    }
  }
}

// 3. Zip it (uses PowerShell on Windows; tar on macOS/Linux).
const zipPath = path.join(BACKUP_DIR, `kuki-backup-${stamp}.zip`);
console.log(`Creating ${zipPath}...`);
const isWindows = process.platform === "win32";
const zipCmd = isWindows
  ? spawnSync("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path '${tmpDir}/*' -DestinationPath '${zipPath}' -Force`], { stdio: "inherit" })
  : spawnSync("tar", ["-czf", zipPath.replace(/\.zip$/, ".tar.gz"), "-C", tmpDir, "."], { stdio: "inherit" });
if (zipCmd.status !== 0) {
  console.error("Zip failed");
  process.exit(1);
}
rmSync(tmpDir, { recursive: true, force: true });

// 4. Clean up old backups (keep last KEEP_DAYS days).
const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
let purged = 0;
for (const f of readdirSync(BACKUP_DIR)) {
  if (!f.startsWith("kuki-backup-")) continue;
  const full = path.join(BACKUP_DIR, f);
  if (statSync(full).mtimeMs < cutoff) {
    rmSync(full, { force: true });
    purged++;
  }
}

console.log(`\nBackup complete: ${zipPath}`);
if (purged) console.log(`Removed ${purged} old backup(s) older than ${KEEP_DAYS} days.`);
