import { Database } from "bun:sqlite";
import path from "path";

const DB_PATH = process.env.DB_PATH || path.join(import.meta.dir, "../../data/shop.db");

let db: Database;

export function getDb(): Database {
  if (!db) {
    db = new Database(DB_PATH, { create: true });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
  }
}
