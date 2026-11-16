import { config } from '../config.ts';
import { all, get, logEvent, now, run, tx } from '../db.ts';
import { runExtractor } from '../extractor.ts';
import { calendar } from './calendar.ts';
import { gmail, linkedin, slack } from './claudeSources.ts';
import type { Connector, SourceId } from './types.ts';
import { whatsapp } from './whatsapp.ts';

export const connectors: Record<SourceId, Connector> = { whatsapp, gmail, slack, linkedin, calendar };

export interface ConnectorRow {
  id: SourceId;
  enabled: number;
  interval_min: number;
  cursor: string | null;
  last_sync: string | null;
  last_error: string | null;
  last_count: number | null;
  settings: string;
}

export function initConnectors() {
  for (const c of Object.values(connectors)) {
    const enabled = c.id === 'whatsapp' && c.ready().ok ? 1 : 0;
    run('INSERT OR IGNORE INTO connectors (id, enabled, interval_min) VALUES (?, ?, ?)', c.id, enabled, c.defaultIntervalMin);
  }
}

const syncing = new Set<SourceId>();

export function connectorState() {
  return all<ConnectorRow>('SELECT * FROM connectors').map((row) => {
    const c = connectors[row.id];
    const ready = c.ready();
    return {
      id: row.id,
      name: c.name,
      how: c.how,
      enabled: !!row.enabled,
      intervalMin: row.interval_min,
      lastSync: row.last_sync,
      lastError: row.last_error,
      lastCount: row.last_count,
      settings: JSON.parse(row.settings),
      syncing: syncing.has(row.id),
      ready: ready.ok,
      notReadyReason: ready.ok ? null : ready.reason,
      mcpServer: row.id === 'gmail' ? config.mcp.gmail : row.id === 'slack' ? config.mcp.slack : row.id === 'calendar' ? config.mcp.calendar : null,
    };
  });
}

export function updateConnector(id: SourceId, patch: { enabled?: boolean; intervalMin?: number; settings?: Record<string, unknown> }) {
  const row = get<ConnectorRow>('SELECT * FROM connectors WHERE id = ?', id);
  if (!row) throw new Error(`Unknown connector ${id}`);
  run(
    'UPDATE connectors SET enabled = ?, interval_min = ?, settings = ? WHERE id = ?',
    patch.enabled === undefined ? row.enabled : Number(patch.enabled),
    Math.max(1, Math.round(patch.intervalMin ?? row.interval_min)),
    JSON.stringify({ ...JSON.parse(row.settings), ...(patch.settings ?? {}) }),
    id,
  );
}

export async function syncConnector(id: SourceId): Promise<{ added: number }> {
  const c = connectors[id];
  const row = get<ConnectorRow>('SELECT * FROM connectors WHERE id = ?', id);
  if (!c || !row) throw new Error(`Unknown connector ${id}`);
  const ready = c.ready();
  if (!ready.ok) throw new Error(ready.reason);
  if (syncing.has(id)) return { added: 0 };
  syncing.add(id);
  try {
    const { messages, cursor } = await c.fetch(row.cursor, JSON.parse(row.settings));
    const added = tx(() => {
      let n = 0;
      for (const m of messages) {
        const res = run(
          `INSERT OR IGNORE INTO signals (source, external_id, thread_id, from_name, from_handle, channel, subject, text, url, is_from_me, received_at, raw)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, m.external_id, m.thread_id, m.from_name, m.from_handle ?? null, m.channel ?? null, m.subject ?? null,
          m.text.slice(0, 8000), m.url ?? null, m.is_from_me ? 1 : 0, m.received_at, JSON.stringify(m),
        );
        n += Number(res.changes);
      }
      run('UPDATE connectors SET cursor = ?, last_sync = ?, last_error = NULL, last_count = ? WHERE id = ?', cursor, now(), n, id);
      return n;
    });
    if (added) await runExtractor();
    if (id === 'calendar') expirePastEvents();
    return { added };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    run('UPDATE connectors SET last_sync = ?, last_error = ? WHERE id = ?', now(), message, id);
    logEvent('sync_failed', { connector: id, error: message });
    throw err;
  } finally {
    syncing.delete(id);
  }
}

/** New calendar tasks whose event is already over leave the Inbox on their own. */
export function expirePastEvents(): number {
  const expired = all<{ id: number }>(
    `SELECT t.id FROM tasks t
     WHERE t.source = 'calendar' AND t.status = 'suggested'
       AND NOT EXISTS (
         SELECT 1 FROM task_signals ts JOIN signals s ON s.id = ts.signal_id
         WHERE ts.task_id = t.id
           AND COALESCE(json_extract(s.raw, '$.ends_at'), strftime('%Y-%m-%dT%H:%M:%fZ', s.received_at, '+1 hour')) > ?
       )`,
    now(),
  );
  for (const t of expired) {
    run("UPDATE tasks SET status = 'dismissed', updated_at = ? WHERE id = ?", now(), t.id);
    logEvent('expired', { detail: 'The event is over' }, t.id);
  }
  return expired.length;
}

export function startScheduler() {
  if (config.disableScheduler) return;
  const tick = () => {
    expirePastEvents();
    for (const row of all<ConnectorRow>('SELECT * FROM connectors WHERE enabled = 1')) {
      const due = !row.last_sync || Date.now() - Date.parse(row.last_sync) >= row.interval_min * 60_000;
      if (due && !syncing.has(row.id) && connectors[row.id].ready().ok) {
        syncConnector(row.id).catch((e) => console.error(`[sync ${row.id}]`, e instanceof Error ? e.message : e));
      }
    }
  };
  setTimeout(tick, 2_000);
  setInterval(tick, 30_000);
}
