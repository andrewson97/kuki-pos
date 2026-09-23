import path from "path";
import { mkdirSync } from "fs";

const DB_PATH = process.env.DB_PATH || path.join(import.meta.dir, "../../data/shop.db");
export const DATA_DIR = path.dirname(DB_PATH);

// Side effect on import: bun:sqlite will not create the folder that holds the
// database file, so make sure it exists before anything opens the DB.
try { mkdirSync(DATA_DIR, { recursive: true }); } catch {}
