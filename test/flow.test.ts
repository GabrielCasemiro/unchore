import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

// --- fake uazapi -----------------------------------------------------------
const sent: Array<Record<string, unknown>> = [];
const T0 = Date.now() - 60_000;
const uaz = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const json = body ? JSON.parse(body) : {};
    res.setHeader('content-type', 'application/json');
    if (req.headers.token !== 'test-token') return res.writeHead(401).end('{}');
    if (req.url === '/chat/find') {
      return res.end(JSON.stringify({ chats: [
        { wa_chatid: '5511999990000@s.whatsapp.net', wa_name: 'Maria', wa_isGroup: false, wa_lastMsgTimestamp: T0 + 3000 },
        { wa_chatid: '5511888880000@s.whatsapp.net', wa_name: 'Loja', wa_isGroup: false, wa_lastMsgTimestamp: T0 - 10 * 86_400_000 },
      ] }));
    }
    if (req.url === '/message/find' && json.chatid === '5511999990000@s.whatsapp.net') {
      return res.end(JSON.stringify({ messages: [
        { messageid: 'm3', chatid: json.chatid, senderName: 'Maria', fromMe: false, messageType: 'ExtendedTextMessage', messageTimestamp: T0 + 3000, text: 'Quanto custa o kit?' },
        { messageid: 'm2', chatid: json.chatid, senderName: 'Maria', fromMe: false, messageType: 'Conversation', messageTimestamp: T0 + 2000, text: 'Seu pedido foi enviado' },
        { messageid: 'm1', chatid: json.chatid, fromMe: true, messageType: 'Conversation', messageTimestamp: T0 + 1000, text: 'Oi Maria!' },
        { messageid: 'old', chatid: json.chatid, fromMe: false, messageType: 'Conversation', messageTimestamp: T0 - 3 * 86_400_000, text: 'old?' },
      ] }));
    }
    if (req.url === '/send/text') {
      sent.push(json);
      return res.end('{"ok":true}');
    }
    res.end(JSON.stringify({ messages: [], chats: [] }));
  });
});

type App = { fetch: (r: Request) => Promise<Response> | Response };
let app: App;
let home: string;

const api = async (path: string, method = 'GET', body?: unknown) => {
  const res = await app.fetch(new Request(`http://localhost/api${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const data = await res.json();
  assert.ok(res.ok, `${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
};

const waitFor = async (fn: () => Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
};

before(async () => {
  await new Promise<void>((r) => uaz.listen(0, '127.0.0.1', r));
  home = mkdtempSync(join(tmpdir(), 'unchore-test-'));
  const fake = join(import.meta.dirname, 'fake-claude.mjs');
  chmodSync(fake, 0o755);
  Object.assign(process.env, {
    UNCHORE_ENV_FILE: join(home, 'no.env'),
    UNCHORE_HOME: home,
    CLAUDE_BIN: fake,
    FAKE_CLAUDE_LOG: join(home, 'claude.log'),
    UAZAPI_URL: `http://127.0.0.1:${(uaz.address() as AddressInfo).port}`,
    UAZAPI_TOKEN: 'test-token',
    UNCHORE_NO_SCHEDULER: '1',
    UNCHORE_NO_TERMINAL: '1',
  });
  const { seedSkills } = await import('../server/skills.ts');
  const { initConnectors } = await import('../server/connectors/index.ts');
  const { createApp } = await import('../server/app.ts');
  seedSkills();
  initConnectors();
  app = createApp();
});

after(() => uaz.close());

test('claude runs get no built-in tools, and only the MCP servers they need', async () => {
  const { claudeArgs } = await import('../server/claude.ts');
  const plain = claudeArgs({ prompt: 'x' });
  assert.deepEqual(plain.slice(plain.indexOf('--tools'), plain.indexOf('--tools') + 2), ['--tools', '']);
  assert.ok(plain.includes('--strict-mcp-config'));
  const gmail = claudeArgs({ prompt: 'x', mcpServers: ['claude_ai_Gmail'] });
  assert.equal(gmail[gmail.indexOf('--allowedTools') + 1], 'mcp__claude_ai_Gmail');
  assert.equal(gmail[gmail.indexOf('--permission-mode') + 1], 'dontAsk');
  const chrome = claudeArgs({ prompt: 'x', chrome: true });
  assert.ok(chrome.includes('--chrome'));
  assert.equal(chrome[chrome.indexOf('--allowedTools') + 1], 'mcp__claude-in-chrome');
});

test('full flow: WhatsApp sync → task → plan → approve sends the reply', async () => {
  const conn = await api('/connectors');
  assert.equal(conn.find((c: { id: string }) => c.id === 'whatsapp').enabled, true, 'WhatsApp is on when credentials exist');

  const sync = await api('/connectors/whatsapp/sync', 'POST');
  assert.equal(sync.added, 3, 'three messages from the last day; the old one is ignored');

  const tasks = await api('/tasks');
  assert.equal(tasks.length, 1, 'only the question became a task');
  const task = tasks[0];
  assert.equal(task.status, 'suggested');
  assert.equal(task.source, 'whatsapp');
  assert.equal(task.requester, 'Maria');

  const again = await api('/connectors/whatsapp/sync', 'POST');
  assert.equal(again.added, 0, 'cursor prevents duplicates');

  await api(`/tasks/${task.id}/accept`, 'POST');
  await waitFor(async () => (await api(`/tasks/${task.id}`)).task.status === 'plan_ready');
  const detail = await api(`/tasks/${task.id}`);
  assert.equal(detail.task.plan.reply, 'O kit custa R$ 49,90.');
  assert.equal(detail.thread.length, 3);

  const approved = await api(`/tasks/${task.id}/approve`, 'POST', { sendReply: true });
  assert.match(approved.detail, /Sent on WhatsApp/);
  assert.deepEqual(sent, [{ number: '5511999990000@s.whatsapp.net', text: 'O kit custa R$ 49,90.', replyid: 'm3' }]);
  assert.equal((await api(`/tasks/${task.id}`)).task.status, 'done');
});

test('"Not a task" adds a rule to the extractor skill, and undo restores it', async () => {
  const { run } = await import('../server/db.ts');
  const id = Number(run(
    "INSERT INTO tasks (title, source, thread_id, requester, status) VALUES ('Track order', 'whatsapp', 'x@s.whatsapp.net', 'Loja', 'suggested')",
  ).lastInsertRowid);
  const before = await api('/skills/what-counts-as-a-task');
  const r = await api(`/tasks/${id}/dismiss`, 'POST', { reason: 'Automated / notification' });
  assert.equal(r.rule, 'Order status notifications are not tasks');
  const file = readFileSync(join(home, 'skills', 'what-counts-as-a-task.md'), 'utf8');
  assert.match(file, /## Learned from feedback\n- Order status notifications are not tasks/);
  const afterSkill = await api('/skills/what-counts-as-a-task');
  assert.equal(afterSkill.skill.version, before.skill.version + 1);

  await api(`/tasks/${id}/undo-dismiss`, 'POST', { previousBody: r.previousBody });
  assert.doesNotMatch(readFileSync(join(home, 'skills', 'what-counts-as-a-task.md'), 'utf8'), /Order status/);
  assert.equal((await api(`/tasks/${id}`)).task.status, 'suggested');
});

test('Inbox agent chat can add a rule', async () => {
  const chat = await api('/agent', 'POST', { message: 'Stop creating tasks from promo groups' });
  assert.equal(chat.at(-1).role, 'agent');
  assert.equal(chat.at(-1).rule, 'Messages in promo groups are not tasks');
  assert.match(readFileSync(join(home, 'skills', 'what-counts-as-a-task.md'), 'utf8'), /promo groups are not tasks/);
});

test('request changes re-plans and can update the skill', async () => {
  const task = (await api('/tasks?done=1')).find((t: { requester: string }) => t.requester === 'Maria');
  await api(`/tasks/${task.id}/changes`, 'POST', { feedback: 'Always add the delivery time', updateSkill: true });
  assert.match(readFileSync(join(home, 'skills', 'writing-replies.md'), 'utf8'), /- Always add the delivery time/);
  await waitFor(async () => (await api(`/tasks/${task.id}`)).task.status === 'plan_ready');
});

test('take over writes TASK.md with the conversation and plan', async () => {
  const task = (await api('/tasks?done=1')).find((t: { requester: string }) => t.requester === 'Maria');
  const r = await api(`/tasks/${task.id}/takeover`, 'POST', { tool: 'claude-code' });
  assert.ok(existsSync(r.file));
  const md = readFileSync(r.file, 'utf8');
  assert.match(md, /Quanto custa o kit\?/);
  assert.match(md, /## Suggested reply\nO kit custa/);
  assert.match(r.command, /^cd '.*' && claude "Read TASK.md/);
  await api(`/tasks/${task.id}/done`, 'POST', { note: 'done in Claude Code' });
  assert.equal((await api(`/tasks/${task.id}`)).task.status, 'done');
});

test('skills can be edited and keep a version history', async () => {
  const s = await api('/skills/scheduling');
  const saved = await api('/skills/scheduling', 'PUT', { name: 'Scheduling', when: s.skill.when, body: '# Scheduling\n\n- 45 minute meetings\n' });
  assert.equal(saved.version, s.skill.version + 1);
  assert.equal((await api('/skills/scheduling')).history.length, 2);
});

test('the note from accepting reaches every plan of the task; titles follow the language setting', async () => {
  const log = () => readFileSync(join(home, 'claude.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; props: string[]; prompt: string });
  const extract = log().find((c) => c.props.includes('decisions'))!;
  assert.match(extract.args[extract.args.indexOf('--json-schema') + 1], /Imperative task title in English/);

  const { run } = await import('../server/db.ts');
  run(`INSERT INTO tasks (uid, title, source, thread_id, status) VALUES ('note-test-aaaa', 'Answer Ana', 'whatsapp', 'note', 'suggested')`);
  await api('/tasks/note-test-aaaa/accept', 'POST', { note: 'Offer next Tuesday' });
  await waitFor(async () => (await api('/tasks/note-test-aaaa')).task.status === 'plan_ready');
  const plan = log().filter((c) => c.props.includes('steps')).pop()!;
  assert.match(plan.prompt, /note when accepting this task — follow it:\nOffer next Tuesday/);
  assert.equal(plan.args[plan.args.indexOf('--tools') + 1], '', 'planning gets no tools');

  await api('/tasks/note-test-aaaa/plan', 'POST');
  await waitFor(async () => (await api('/tasks/note-test-aaaa')).task.status === 'plan_ready' && log().filter((c) => c.props.includes('steps')).length > 1);
  assert.match(log().filter((c) => c.props.includes('steps')).pop()!.prompt, /Offer next Tuesday/, 'the accept note is kept on later plans');
});

test('grants: only narrow, user-written tools become CLI permissions', async () => {
  const { grantError, permissionsFor, splitGrants } = await import('../server/grants.ts');
  const { claudeArgs } = await import('../server/claude.ts');
  const { homedir } = await import('node:os');
  assert.deepEqual(splitGrants('Read(~/a/**), Bash(sqlite3 -safe -readonly ~/a.db:*)'), ['Read(~/a/**)', 'Bash(sqlite3 -safe -readonly ~/a.db:*)']);
  assert.equal(grantError('Read(~/notes/**)', 'reads'), null);
  assert.match(grantError('Write(~/notes/x)', 'reads')!, /belongs under actions/);
  assert.match(grantError('Read(~/**)', 'reads')!, /whole disk or home/);
  assert.match(grantError('mcp__claude_ai_Gmail', 'reads')!, /not a whole server/);
  assert.match(grantError('WebFetch(https://x.com)', 'reads')!, /one site/);
  assert.match(grantError('Bash', 'reads')!, /Tool\(what it may touch\)/);
  assert.match(grantError('Bash(cat ~/a.txt)', 'reads')!, /end it with :\*/);
  assert.match(grantError('Bash(curl -s https://x.com/:*)', 'reads')!, /use WebFetch/);

  const perms = permissionsFor(['Read(~/notes/**)', 'Bash(sqlite3 -safe -readonly ~/crm.db:*)', 'Write(~/x)'], 'reads');
  assert.deepEqual(perms.tools, ['Read', 'Bash'], 'Write is dropped for lookups');
  assert.deepEqual(perms.dirs, [`${homedir()}/notes`]);
  const args = claudeArgs({ prompt: 'x', permissions: perms });
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Bash');
  assert.ok(args.includes('--restricted') && args.includes('--strict-mcp-config'));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(args[args.indexOf('--allowedTools') + 1], `Read(/${homedir()}/notes/**),Bash(sqlite3 -safe -readonly ~/crm.db:*)`);
});

test('plans run granted lookups and propose actions; an action runs only when approved, without the conversation', async () => {
  const log = () => readFileSync(join(home, 'claude.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; props: string[]; prompt: string });
  const s = (await api('/skills/scheduling')).skill;
  const saved = await api('/skills/scheduling', 'PUT', { name: s.name, when: s.when, body: s.body, reads: ['Read(~/notes/**)', 'Write(~/notes/x)'], actions: ['mcp__claude_ai_Google_Calendar__create_event'] });
  assert.deepEqual(saved.reads, ['Read(~/notes/**)', 'Write(~/notes/x)']);
  assert.equal(saved.grantProblems.length, 1);
  assert.match(readFileSync(join(home, 'skills', 'scheduling.md'), 'utf8'), /^actions: mcp__claude_ai_Google_Calendar__create_event$/m);

  const { run } = await import('../server/db.ts');
  run(`INSERT INTO signals (source, external_id, thread_id, from_name, text, received_at, processed) VALUES ('whatsapp', 'act1', 'act', 'Ana', 'SECRET-THREAD-TEXT can we talk in January?', ?, 1)`, new Date().toISOString());
  run(`INSERT INTO tasks (uid, title, source, thread_id, status) VALUES ('action-test-aaaa', 'Follow up with Ana', 'whatsapp', 'act', 'suggested')`);
  await api('/tasks/action-test-aaaa/accept', 'POST', {});
  await waitFor(async () => (await api('/tasks/action-test-aaaa')).task.status === 'plan_ready');
  const planRun = log().filter((c) => c.props.includes('steps')).pop()!;
  assert.equal(planRun.args[planRun.args.indexOf('--tools') + 1], 'Read', 'lookups only: the Write grant is ignored');
  assert.ok(planRun.args.includes('--restricted'));
  assert.doesNotMatch(planRun.args[planRun.args.indexOf('--allowedTools') + 1], /create_event/, 'action tools are not given to planning');

  const plan = (await api('/tasks/action-test-aaaa')).task.plan;
  assert.deepEqual(plan.checked, ['Read the notes: the client asked to talk in January']);
  assert.equal(plan.actions[0].status, 'proposed');

  const done = await api('/tasks/action-test-aaaa/actions/0/run', 'POST');
  assert.equal(done.status, 'done');
  const actRun = log().filter((c) => c.props.includes('done')).pop()!;
  assert.match(actRun.args[actRun.args.indexOf('--allowedTools') + 1], /mcp__claude_ai_Google_Calendar__create_event/);
  assert.ok(!actRun.args.includes('--strict-mcp-config'), 'MCP servers load for an MCP action');
  assert.match(actRun.prompt, /Create a calendar event on 2027-01-05/);
  assert.doesNotMatch(actRun.prompt, /SECRET-THREAD-TEXT/);
  assert.equal((await api('/tasks/action-test-aaaa')).task.plan.actions[0].status, 'done');
  const again = await app.fetch(new Request('http://localhost/api/tasks/action-test-aaaa/actions/0/run', { method: 'POST' }));
  assert.equal(again.status, 400, 'an action never runs twice');

  const exported = await api('/skills/scheduling/export');
  assert.doesNotMatch(exported.markdown, /reads:|actions:|create_event/);
  await api('/skills/scheduling', 'PUT', { name: s.name, when: s.when, body: s.body, reads: [], actions: [] });
  assert.doesNotMatch(readFileSync(join(home, 'skills', 'scheduling.md'), 'utf8'), /reads:|actions:/);
});

test('library skills can be installed, and exports leave out learned rules', async () => {
  const library = await api('/library');
  const starter = library.find((s: { slug: string }) => s.slug === 'writing-replies');
  assert.equal(starter.installed, true, 'starter skills are installed on first run');
  assert.equal(library.find((s: { slug: string }) => s.slug === 'quote-requests').installed, false);

  const installed = await api('/library/quote-requests/install', 'POST');
  assert.equal(installed.version, 1);
  assert.match(readFileSync(join(home, 'skills', 'quote-requests.md'), 'utf8'), /# Answering quote requests/);
  const res = await app.fetch(new Request('http://localhost/api/library/quote-requests/install', { method: 'POST' }));
  assert.equal(res.status, 400, 'installing twice never overwrites my copy');

  const { appendRule } = await import('../server/skills.ts');
  appendRule('quote-requests', 'Café Aurora gets 10% off', 'test');
  const exported = await api('/skills/quote-requests/export');
  assert.equal(exported.file, 'quote-requests.md');
  assert.match(exported.markdown, /^---\nname: Answering quote requests\n/);
  assert.match(exported.markdown, /## Draft/);
  assert.doesNotMatch(exported.markdown, /Learned from feedback|Café Aurora/);
});

test('API rejects requests from other websites', async () => {
  const res = await app.fetch(new Request('http://localhost/api/tasks', { headers: { origin: 'https://evil.example' } }));
  assert.equal(res.status, 403);
});

test('tasks get readable uids and the API accepts them', async () => {
  const tasks = await api('/tasks?done=1');
  const maria = tasks.find((t: { requester: string }) => t.requester === 'Maria');
  assert.match(maria.uid, /^answer-quanto-custa-o-kit-[a-z0-9]{4}$/);
  assert.equal((await api(`/tasks/${maria.uid}`)).task.id, maria.id);
});

test('a reply is never silently skipped: empty or [placeholder] replies cannot be sent', async () => {
  const { run } = await import('../server/db.ts');
  const id = Number(run(
    `INSERT INTO tasks (uid, title, source, thread_id, requester, status, plan) VALUES ('no-reply-test-aaaa', 'No reply', 'whatsapp', '5511999990000@s.whatsapp.net', 'Maria', 'plan_ready', ?)`,
    JSON.stringify({ summary: 's', steps: [], draft: { title: 'd', body: 'Oi [nome]' }, reply: null, skill_slug: null, needs_from_me: 'Your name' }),
  ).lastInsertRowid);
  const sendEmpty = await app.fetch(new Request('http://localhost/api/tasks/no-reply-test-aaaa/approve', { method: 'POST', body: JSON.stringify({ sendReply: true }) }));
  assert.equal(sendEmpty.status, 400);
  assert.match((await sendEmpty.json()).error, /Write the reply/);
  const placeholder = await app.fetch(new Request('http://localhost/api/tasks/no-reply-test-aaaa/approve', { method: 'POST', body: JSON.stringify({ sendReply: true, reply: 'Oi [nome]' }) }));
  assert.equal(placeholder.status, 400);
  assert.equal((await api(`/tasks/${id}`)).task.status, 'plan_ready', 'a failed send keeps the task open');

  const before = sent.length;
  await api('/tasks/no-reply-test-aaaa/approve', 'POST', { sendReply: true, reply: 'Oi Maria, tudo certo!' });
  assert.equal(sent.length, before + 1);
  assert.equal(sent.at(-1)!.text, 'Oi Maria, tudo certo!');
});

test('done tasks can be reopened and taken over', async () => {
  await api('/tasks/no-reply-test-aaaa/reopen', 'POST');
  assert.equal((await api('/tasks/no-reply-test-aaaa')).task.status, 'plan_ready');
  await api('/tasks/no-reply-test-aaaa/done', 'POST', {});
  const r = await api('/tasks/no-reply-test-aaaa/takeover', 'POST', { tool: 'codex' });
  assert.match(r.file, /no-reply-test-aaaa\/TASK\.md$/);
  assert.match(r.command, /&& codex "Read TASK.md/);
  assert.match(readFileSync(r.file, 'utf8'), /unchore done no-reply-test-aaaa/);
});

test('calendar: titled events in the next days become tasks; busy blocks and holidays are skipped', async () => {
  const skill = readFileSync(join(home, 'skills', 'what-counts-as-a-task.md'), 'utf8');
  assert.match(skill, /## Calendar events/);
  const r = await api('/connectors/calendar/sync', 'POST');
  assert.equal(r.added, 3);
  const again = await api('/connectors/calendar/sync', 'POST');
  assert.equal(again.added, 0, 'event instances are not duplicated on re-sync');
  const cal = (await api('/tasks')).filter((t: { source: string }) => t.source === 'calendar');
  assert.equal(cal.length, 1);
  assert.equal(cal[0].requester, 'me@example.com');
  const res = await app.fetch(new Request(`http://localhost/api/tasks/${cal[0].uid}/approve`, { method: 'POST', body: JSON.stringify({ sendReply: true, reply: 'x' }) }));
  assert.equal(res.status, 400, 'nothing to send for a calendar task');
  await api(`/tasks/${cal[0].uid}/done`, 'POST', {});
  assert.equal((await api(`/tasks/${cal[0].uid}`)).task.status, 'done');
});

test('calendar tasks whose event is over leave the Inbox; "Already handled" learns no rule', async () => {
  const { run } = await import('../server/db.ts');
  const { expirePastEvents } = await import('../server/connectors/index.ts');
  const sig = Number(run(
    `INSERT INTO signals (source, external_id, thread_id, from_name, text, received_at, raw, processed)
     VALUES ('calendar', 'past@1', 'past', 'me', 'Calendar event: old', ?, ?, 1)`,
    new Date(Date.now() - 3 * 3600e3).toISOString(),
    JSON.stringify({ ends_at: new Date(Date.now() - 2 * 3600e3).toISOString() }),
  ).lastInsertRowid);
  const id = Number(run(`INSERT INTO tasks (uid, title, source, thread_id, status) VALUES ('old-event-aaaa', 'Old event', 'calendar', 'past', 'suggested')`).lastInsertRowid);
  run('INSERT INTO task_signals (task_id, signal_id) VALUES (?, ?)', id, sig);
  assert.equal(expirePastEvents(), 1);
  assert.equal((await api('/tasks/old-event-aaaa')).task.status, 'dismissed');

  const before = readFileSync(join(home, 'skills', 'what-counts-as-a-task.md'), 'utf8');
  const tid = Number(run(`INSERT INTO tasks (uid, title, source, thread_id, status) VALUES ('handled-aaaa', 'Handled', 'whatsapp', 'h', 'suggested')`).lastInsertRowid);
  const r = await api(`/tasks/${tid}/dismiss`, 'POST', { reason: 'Already handled' });
  assert.equal(r.rule, null);
  assert.equal(readFileSync(join(home, 'skills', 'what-counts-as-a-task.md'), 'utf8'), before);
});
