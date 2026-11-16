#!/usr/bin/env -S npx tsx
// Small CLI so a Claude Code / Codex session can report back:
//   unchore done <task-id> [--note "what was done"]   (task id like responder-maria-k3f9)
//   unchore sync <whatsapp|gmail|slack|linkedin>
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { note: { type: 'string' }, port: { type: 'string' } },
});
const base = `http://127.0.0.1:${values.port ?? process.env.PORT ?? 4477}/api`;
const [cmd, arg] = positionals;

async function call(path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

try {
  if (cmd === 'done' && arg) {
    await call(`/tasks/${encodeURIComponent(arg)}/done`, { note: values.note });
    console.log(`Task ${arg} marked as done.`);
  } else if (cmd === 'sync' && arg) {
    const r = await call(`/connectors/${arg}/sync`);
    console.log(`${arg}: ${r.added} new messages.`);
  } else {
    console.log('Usage:\n  unchore done <task-id> [--note "…"]\n  unchore sync <whatsapp|gmail|slack|linkedin>');
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`unchore: ${err instanceof Error ? err.message : err} (is Unchore running?)`);
  process.exitCode = 1;
}
