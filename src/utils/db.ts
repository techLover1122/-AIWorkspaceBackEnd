import Database, { type Database as DatabaseType } from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { info } from "./logger.js";

const DB_DIR = join(homedir(), ".ai-ide");
const DB_PATH = join(DB_DIR, "data.sqlite");

if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });

export const db: DatabaseType = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS detected_ports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    port INTEGER NOT NULL,
    process_name TEXT,
    app_label TEXT,
    detected_at INTEGER NOT NULL,
    UNIQUE(port, process_name)
  );

  CREATE TABLE IF NOT EXISTS opened_tabs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    label TEXT,
    project_path TEXT,
    opened_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL UNIQUE,
    project_path TEXT,
    started_at INTEGER NOT NULL,
    last_active INTEGER NOT NULL,
    message_count INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS urls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    icon TEXT,
    url TEXT NOT NULL UNIQUE,
    opened INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  -- Singleton key/value table for user preferences. One row per key.
  -- Today it only holds whatsapp_forwarding_enabled; new prefs slot in
  -- without a schema migration.
  CREATE TABLE IF NOT EXISTS user_prefs (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_ports_detected ON detected_ports(detected_at DESC);
  CREATE INDEX IF NOT EXISTS idx_tabs_opened ON opened_tabs(opened_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(last_active DESC);
  CREATE INDEX IF NOT EXISTS idx_urls_created ON urls(created_at DESC);
`);

// Migration: add `opened` column to pre-existing urls tables (no-op if it already exists)
try {
  const cols = db.prepare(`PRAGMA table_info(urls)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === "opened")) {
    db.exec(`ALTER TABLE urls ADD COLUMN opened INTEGER NOT NULL DEFAULT 0`);
    info("Migrated urls table: added 'opened' column");
  }
} catch { /* table didn't exist yet — fresh schema above handles it */ }

info(`SQLite database ready at ${DB_PATH}`);

/* ---------- Prepared statements ---------- */

const stmtUpsertPort = db.prepare(`
  INSERT INTO detected_ports (port, process_name, app_label, detected_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(port, process_name) DO UPDATE SET
    app_label = excluded.app_label,
    detected_at = excluded.detected_at
`);

const stmtRecentPorts = db.prepare(`
  SELECT port, process_name, app_label, detected_at
  FROM detected_ports ORDER BY detected_at DESC LIMIT ?
`);

const stmtInsertTab = db.prepare(`
  INSERT INTO opened_tabs (url, label, project_path, opened_at) VALUES (?, ?, ?, ?)
`);

const stmtRecentTabs = db.prepare(`
  SELECT id, url, label, project_path, opened_at
  FROM opened_tabs ORDER BY opened_at DESC LIMIT ?
`);

const stmtUpsertSession = db.prepare(`
  INSERT INTO sessions (session_id, project_path, started_at, last_active, message_count)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(session_id) DO UPDATE SET
    last_active = excluded.last_active,
    message_count = excluded.message_count
`);

const stmtRecentSessions = db.prepare(`
  SELECT session_id, project_path, started_at, last_active, message_count
  FROM sessions ORDER BY last_active DESC LIMIT ?
`);

/* ---------- Public API ---------- */

export function recordPort(port: number, processName: string | null, appLabel: string | null) {
  stmtUpsertPort.run(port, processName ?? "", appLabel ?? "", Date.now());
}

export function recentPorts(limit = 50) {
  return stmtRecentPorts.all(limit);
}

export function recordTab(url: string, label: string, projectPath?: string) {
  stmtInsertTab.run(url, label, projectPath ?? null, Date.now());
}

export function recentTabs(limit = 50) {
  return stmtRecentTabs.all(limit);
}

export function recordSession(sessionId: string, projectPath: string | null, messageCount: number) {
  const now = Date.now();
  stmtUpsertSession.run(sessionId, projectPath, now, now, messageCount);
}

export function recentSessions(limit = 50) {
  return stmtRecentSessions.all(limit);
}

/* ---------- URLs / Bookmarks ---------- */

export type UrlRow = {
  id: number;
  name: string | null;
  icon: string | null;
  url: string;
  opened: number;
  created_at: number;
};

const stmtInsertUrl = db.prepare(`
  INSERT INTO urls (name, icon, url, created_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(url) DO UPDATE SET
    name = COALESCE(excluded.name, urls.name),
    icon = COALESCE(excluded.icon, urls.icon)
  RETURNING id, name, icon, url, opened, created_at
`);

const stmtListUrls = db.prepare(`
  SELECT id, name, icon, url, opened, created_at FROM urls ORDER BY created_at DESC
`);

const stmtListOpenedUrls = db.prepare(`
  SELECT id, name, icon, url, opened, created_at FROM urls
  WHERE opened = 1 ORDER BY created_at ASC
`);

const stmtGetUrl = db.prepare(`SELECT id, name, icon, url, opened, created_at FROM urls WHERE id = ?`);
const stmtGetUrlByUrl = db.prepare(`SELECT id, name, icon, url, opened, created_at FROM urls WHERE url = ?`);
const stmtDeleteUrl = db.prepare(`DELETE FROM urls WHERE id = ?`);
const stmtUpdateUrl = db.prepare(`
  UPDATE urls SET
    name = COALESCE(?, name),
    icon = COALESCE(?, icon)
  WHERE id = ?
`);

const stmtSetOpenedById = db.prepare(`UPDATE urls SET opened = ? WHERE id = ?`);
const stmtSetOpenedByUrl = db.prepare(`UPDATE urls SET opened = ? WHERE url = ?`);
const stmtCloseAllUrls = db.prepare(`UPDATE urls SET opened = 0 WHERE opened = 1`);

export function addUrl(url: string, name: string | null, icon: string | null): UrlRow {
  return stmtInsertUrl.get(name, icon, url, Date.now()) as UrlRow;
}

export function listUrls(): UrlRow[] {
  return stmtListUrls.all() as UrlRow[];
}

export function listOpenedUrls(): UrlRow[] {
  return stmtListOpenedUrls.all() as UrlRow[];
}

export function getUrl(id: number): UrlRow | undefined {
  return stmtGetUrl.get(id) as UrlRow | undefined;
}

export function getUrlByUrl(url: string): UrlRow | undefined {
  return stmtGetUrlByUrl.get(url) as UrlRow | undefined;
}

export function deleteUrl(id: number): void {
  stmtDeleteUrl.run(id);
}

export function updateUrl(id: number, name: string | null, icon: string | null): void {
  stmtUpdateUrl.run(name, icon, id);
}

export function setUrlOpenedById(id: number, opened: boolean): void {
  stmtSetOpenedById.run(opened ? 1 : 0, id);
}

export function setUrlOpenedByUrl(url: string, opened: boolean): void {
  stmtSetOpenedByUrl.run(opened ? 1 : 0, url);
}

export function closeAllUrls(): void {
  stmtCloseAllUrls.run();
}
