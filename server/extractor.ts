import { runClaude, untrusted } from './claude.ts';
import { all, get, logEvent, makeTaskUid, run, tx } from './db.ts';
import { getSkill, TASK_SKILL } from './skills.ts';

interface Signal {
  id: number;
  source: string;
  thread_id: string;
  from_name: string;
  channel: string | null;
  subject: string | null;
  text: string;
  is_from_me: number;
  received_at: string;
}

interface Decision {
  signal_id: number;
  is_task: boolean;
  reason: string;
  existing_task_id: number | null;
  title: string;
  summary: string;
  due: string | null;
  priority: 'high' | 'medium' | 'low';
  confidence: number;
}

const schema = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          signal_id: { type: 'integer' },
          is_task: { type: 'boolean' },
          reason: { type: 'string', description: 'One short sentence: why this is or is not a task, citing the rule that applied' },
          existing_task_id: { type: ['integer', 'null'], description: 'Open task this message belongs to, if any' },
          title: { type: 'string', description: 'Imperative task title, max 70 chars, in the language of the message' },
          summary: { type: 'string', description: 'What exactly is being asked, 1-2 sentences' },
          due: { type: ['string', 'null'], description: 'YYYY-MM-DD if a deadline is stated or clearly implied' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['signal_id', 'is_task', 'reason', 'existing_task_id', 'title', 'summary', 'due', 'priority', 'confidence'],
      },
    },
  },
  required: ['decisions'],
};

const OPEN = "('suggested','accepted','planning','plan_ready','executing','taken_over')";
const BATCH = 25;
let busy = false;

export async function runExtractor(): Promise<{ processed: number; created: number }> {
  if (busy) return { processed: 0, created: 0 };
  busy = true;
  let processed = 0;
  let created = 0;
  try {
    // My own messages are context only.
    run('UPDATE signals SET processed = 1 WHERE processed = 0 AND is_from_me = 1');
    for (;;) {
      const batch = all<Signal>(
        'SELECT * FROM signals WHERE processed = 0 ORDER BY received_at ASC LIMIT ?',
        BATCH,
      );
      if (!batch.length) break;
      const r = await extractBatch(batch);
      processed += batch.length;
      created += r;
    }
  } finally {
    busy = false;
  }
  return { processed, created };
}

async function extractBatch(batch: Signal[]): Promise<number> {
  const skill = getSkill(TASK_SKILL);
  const threads = new Map<string, Signal[]>();
  for (const s of batch) {
    const key = `${s.source}|${s.thread_id}`;
    if (!threads.has(key)) {
      threads.set(
        key,
        all<Signal>(
          'SELECT * FROM signals WHERE source = ? AND thread_id = ? AND received_at <= ? ORDER BY received_at DESC LIMIT 8',
          s.source, s.thread_id, batch[batch.length - 1].received_at,
        ).reverse(),
      );
    }
  }
  const openTasks = all<{ id: number; title: string; source: string; thread_id: string }>(
    `SELECT id, title, source, thread_id FROM tasks WHERE status IN ${OPEN}`,
  ).filter((t) => threads.has(`${t.source}|${t.thread_id}`));

  const fmt = (s: Signal) =>
    `[${s.id}] ${s.received_at} ${s.is_from_me ? 'ME' : s.from_name}${s.subject ? ` (subject: ${s.subject})` : ''}: ${s.text.slice(0, 1500)}`;
  const threadText = [...threads.entries()]
    .map(([key, msgs]) => `## ${key.split('|')[0]} · ${msgs[0]?.channel ?? ''} · thread ${key.split('|')[1]}\n${msgs.map(fmt).join('\n')}`)
    .join('\n\n');
  const ids = batch.map((s) => s.id);

  const { decisions } = await runClaude<{ decisions: Decision[] }>({
    schema,
    system: `You decide which incoming messages are tasks for the user. Follow the user's rules exactly:\n\n${skill?.body ?? ''}`,
    prompt: `Today is ${new Date().toISOString().slice(0, 10)}.
Decide for each of these message ids: ${ids.join(', ')}. Earlier messages in each thread are context only.
If a message continues an open task listed below, set existing_task_id instead of creating a duplicate.
Items from source "calendar" are upcoming events (their timestamp is the event start): apply the calendar rules, and set due to the event date.

Open tasks: ${openTasks.length ? openTasks.map((t) => `#${t.id} "${t.title}" (${t.source} thread ${t.thread_id})`).join('; ') : 'none'}

${untrusted('messages', threadText)}`,
  });

  let created = 0;
  tx(() => {
    const byId = new Map(decisions.map((d) => [d.signal_id, d]));
    for (const s of batch) {
      const d = byId.get(s.id);
      if (!d) {
        run('INSERT INTO decisions (signal_id, is_task, reason) VALUES (?, 0, ?)', s.id, 'No decision returned');
      } else if (!d.is_task) {
        run('INSERT INTO decisions (signal_id, is_task, reason) VALUES (?, 0, ?)', s.id, d.reason);
      } else {
        const existing = d.existing_task_id
          ? get<{ id: number }>(`SELECT id FROM tasks WHERE id = ? AND status IN ${OPEN}`, d.existing_task_id)
          : get<{ id: number }>(`SELECT id FROM tasks WHERE source = ? AND thread_id = ? AND status IN ${OPEN} ORDER BY id DESC`, s.source, s.thread_id);
        let taskId = existing?.id;
        if (!taskId) {
          const res = run(
            `INSERT INTO tasks (uid, title, summary, source, thread_id, channel, requester, due, priority, confidence, reason)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            makeTaskUid(d.title), d.title.slice(0, 120), d.summary, s.source, s.thread_id, s.channel, s.from_name, d.due, d.priority, d.confidence, d.reason,
          );
          taskId = Number(res.lastInsertRowid);
          created++;
          logEvent('task_created', { signal: s.id, reason: d.reason }, taskId);
        } else {
          run("UPDATE tasks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", taskId);
        }
        run('INSERT OR IGNORE INTO task_signals (task_id, signal_id) VALUES (?, ?)', taskId, s.id);
        run('INSERT INTO decisions (signal_id, is_task, reason, task_id) VALUES (?, 1, ?, ?)', s.id, d.reason, taskId);
      }
      run('UPDATE signals SET processed = 1 WHERE id = ?', s.id);
    }
  });
  return created;
}
