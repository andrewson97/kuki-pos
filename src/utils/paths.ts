import path from "path";
import { mkdirSync } from "fs";

const DB_PATH = process.env.DB_PATH || path.join(import.meta.dir, "../../data/shop.db");
export const DATA_DIR = path.dirname(DB_PATH);
export const UPLOADS_DIR = path.join(DATA_DIR, "uploads");

try { mkdirSync(UPLOADS_DIR, { recursive: true }); } catch {}
