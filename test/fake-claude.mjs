#!/usr/bin/env node
// Stands in for the `claude` CLI in tests. Picks a canned answer from the JSON
// schema it is given, and records every call in $FAKE_CLAUDE_LOG.
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const prompt = readFileSync(0, 'utf8');
const schema = JSON.parse(args[args.indexOf('--json-schema') + 1] || '{}');
const props = Object.keys(schema.properties ?? {});
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, props, prompt }) + '\n');

let out;
if (props.includes('decisions')) {
  const ids = (prompt.match(/Decide for each of these message ids: ([\d, ]+)/)?.[1] ?? '').split(',').map((s) => Number(s.trim())).filter(Boolean);
  out = {
    decisions: ids.map((id) => {
      const line = prompt.split('\n').find((l) => l.startsWith(`[${id}]`)) ?? '';
      const isTask = line.includes('Calendar event:') ? !/\(no title|Feriado/.test(line) : line.includes('?');
      return {
        signal_id: id, is_task: isTask, reason: isTask ? 'Direct question to me' : 'No request',
        existing_task_id: null, title: isTask ? `Answer: ${line.split(': ').slice(1).join(': ').slice(0, 40)}` : '',
        summary: 'They asked a question', due: null, priority: 'medium', confidence: 0.9,
      };
    }),
  };
} else if (props.includes('steps')) {
  const canAct = args.join(' ').includes('Actions you may propose');
  out = {
    summary: 'Reply with the price', steps: ['Check the price list', 'Reply'], draft: null, reply: 'O kit custa R$ 49,90.', skill_slug: 'writing-replies', needs_from_me: null,
    checked: canAct ? ['Read the notes: the client asked to talk in January'] : [],
    actions: canAct ? [{ title: 'Add a reminder on Jan 5', instructions: 'Create a calendar event on 2027-01-05 at 09:00 titled "Follow up with Ana".', skill_slug: 'scheduling' }] : [],
  };
} else if (props.includes('done') && props.includes('detail')) {
  out = { done: true, detail: 'Created the event' };
} else if (props.includes('rule')) {
  out = { rule: 'Order status notifications are not tasks' };
} else if (props.includes('rescan')) {
  out = { reply: 'Ok, I will skip those from now on.', rule_to_add: prompt.includes('Stop') ? 'Messages in promo groups are not tasks' : null, rescan: false };
} else if (props.includes('mode')) {
  out = { mode: 'sent', detail: 'Sent' };
} else if (props.includes('events')) {
  const day = (n, h) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10) + `T${h}:00:00-03:00`;
  out = { events: [
    { id: 'ev0', title: 'Reunião que já passou', start: day(-1, '10'), end: day(-1, '11'), all_day: false, organizer: 'me@example.com', my_response: null, calendar: 'Pessoal', location: null, attendees: [], description: null, link: null },
    { id: 'ev1', title: 'Reunião com Bruno', start: day(2, '17'), end: day(2, '18'), all_day: false, organizer: 'me@example.com', my_response: null, calendar: 'Pessoal', location: 'Online', attendees: ['bruno@example.com'], description: null, link: 'https://calendar.google.com/ev1' },
    { id: 'ev2', title: '', start: day(3, '09'), end: day(3, '10'), all_day: false, organizer: null, my_response: null, calendar: 'work@example.com', location: null, attendees: [], description: null, link: null },
    { id: 'ev3', title: 'Feriado', start: day(4, '00').slice(0, 10), end: null, all_day: true, organizer: 'Feriados no Brasil', my_response: null, calendar: 'Feriados no Brasil', location: null, attendees: [], description: null, link: null },
  ] };
} else if (props.includes('messages')) {
  out = { messages: [] };
} else {
  out = 'ok';
}
const result = { type: 'result', subtype: 'success', is_error: false, result: typeof out === 'string' ? out : JSON.stringify(out), structured_output: typeof out === 'string' ? undefined : out };
if (args.includes('stream-json')) {
  // Runs with granted tools: pretend to call the first allowed tool, unless FAKE_NO_TOOL_USE is set.
  const allowed = (args[args.indexOf('--allowedTools') + 1] ?? '').split(',');
  const tool = props.includes('done') ? allowed.find((t) => t.startsWith('mcp__')) : allowed[0]?.replace(/\(.*$/, '');
  const calls = tool && !process.env.FAKE_NO_TOOL_USE ? [{ type: 'tool_use', name: tool, input: { file_path: '/notes/ana.md' } }] : [];
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\n' + JSON.stringify({ type: 'assistant', message: { content: calls } }) + '\n' + JSON.stringify(result) + '\n');
} else {
  process.stdout.write(JSON.stringify(result));
}
