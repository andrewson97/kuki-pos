import path from "path";
import { mkdirSync } from "fs";

// Exported because the backup code (src/services/backup.ts) must snapshot
// exactly the file the app is writing to. On fly.io that is DB_PATH=/data/shop.db
// on the mounted volume, NOT "data/shop.db" relative to the working directory,
// which is how the old download route looked for it and why it found nothing
// there. Same expression as src/db/database.ts, so both name the same file.
export const DB_PATH = process.env.DB_PATH || path.join(import.meta.dir, "../../data/shop.db");
export const DATA_DIR = path.dirname(DB_PATH);

// Side effect on import: bun:sqlite will not create the folder that holds the
// database file, so make sure it exists before anything opens the DB.
try { mkdirSync(DATA_DIR, { recursive: true }); } catch {}
