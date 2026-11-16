import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { config } from './config.ts';

export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  thread_id TEXT,
  from_name TEXT,
  from_handle TEXT,
  channel TEXT,
  subject TEXT,
  text TEXT NOT NULL DEFAULT '',
  url TEXT,
  is_from_me INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL,
  raw TEXT,
  processed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (source, external_id)
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT,
  source TEXT NOT NULL,
  thread_id TEXT,
  channel TEXT,
  requester TEXT,
  requester_handle TEXT,
  due TEXT,
  priority TEXT NOT NULL DEFAULT 'medium',
  confidence REAL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'suggested',
  plan TEXT,
  plan_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS task_signals (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  signal_id INTEGER NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, signal_id)
);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY,
  signal_id INTEGER NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  is_task INTEGER NOT NULL,
  reason TEXT,
  task_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  interval_min INTEGER NOT NULL DEFAULT 15,
  cursor TEXT,
  last_sync TEXT,
  last_error TEXT,
  last_count INTEGER,
  settings TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  task_id INTEGER,
  kind TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS agent_chat (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  rule TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS skill_versions (
  id INTEGER PRIMARY KEY,
  skill TEXT NOT NULL,
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS signals_unprocessed ON signals (processed, received_at);
CREATE INDEX IF NOT EXISTS signals_thread ON signals (source, thread_id);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks (status);
`);

export function slugify(s: string, max = 40) {
  const slug = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (slug.length <= max) return slug || 'task';
  // Cut at a word boundary so ids don't end in half a word.
  const cut = slug.slice(0, max + 1);
  return cut.slice(0, cut.lastIndexOf('-') > 10 ? cut.lastIndexOf('-') : max) || 'task';
}

/** Readable, URL-safe task id: "send-q3-numbers-to-priya-a8d2". */
export const makeTaskUid = (title: string) => `${slugify(title)}-${Math.random().toString(36).slice(2, 6).padEnd(4, '0')}`;

// Migration: tasks get a public uid used in URLs, the API and the CLI.
if (!(db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).some((c) => c.name === 'uid')) {
  db.exec('ALTER TABLE tasks ADD COLUMN uid TEXT');
}
for (const t of db.prepare('SELECT id, title FROM tasks WHERE uid IS NULL').all() as Array<{ id: number; title: string }>) {
  db.prepare('UPDATE tasks SET uid = ? WHERE id = ?').run(makeTaskUid(t.title), t.id);
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS tasks_uid ON tasks (uid)');

export const all = <T>(sql: string, ...params: SQLInputValue[]) => db.prepare(sql).all(...params) as T[];
export const get = <T>(sql: string, ...params: SQLInputValue[]) => db.prepare(sql).get(...params) as T | undefined;
export const run = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).run(...params);

export function tx<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const now = () => new Date().toISOString();

export function logEvent(kind: string, detail: unknown, taskId: number | null = null) {
  run('INSERT INTO events (task_id, kind, detail) VALUES (?, ?, ?)', taskId, kind, JSON.stringify(detail ?? null));
}
