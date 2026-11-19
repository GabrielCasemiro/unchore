import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runClaude, untrusted } from './claude.ts';
import { config } from './config.ts';
import { connectors } from './connectors/index.ts';
import type { SourceId, ThreadMessage } from './connectors/types.ts';
import { all, get, logEvent, run, slugify } from './db.ts';
import { permissionsFor } from './grants.ts';
import { appendRule, getSkill, listSkills, saveSkill, skillGrants, TASK_SKILL, workSkillsPrompt } from './skills.ts';

export type TaskStatus =
  | 'suggested' | 'accepted' | 'planning' | 'plan_ready' | 'executing' | 'done' | 'dismissed' | 'taken_over';

export interface PlanAction {
  title: string;
  instructions: string;
  skill_slug: string | null;
  status?: 'proposed' | 'running' | 'done' | 'failed' | 'skipped';
  result?: string;
}

export interface Plan {
  summary: string;
  steps: string[];
  draft: { title: string; body: string } | null;
  reply: string | null;
  skill_slug: string | null;
  needs_from_me: string | null;
  /** Lookups the plan ran and what they showed. */
  checked?: string[];
  /** Things to do besides the reply; each runs only after the user approves it. */
  actions?: PlanAction[];
}

export interface TaskRow {
  id: number;
  uid: string;
  title: string;
  summary: string | null;
  source: SourceId;
  thread_id: string;
  channel: string | null;
  requester: string | null;
  due: string | null;
  priority: string;
  confidence: number | null;
  reason: string | null;
  status: TaskStatus;
  plan: string | null;
  plan_error: string | null;
  created_at: string;
  updated_at: string;
}

const touch = (id: number, status: TaskStatus) =>
  run("UPDATE tasks SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", status, id);

/** Accepts the public uid (or a numeric id, for old links) and returns the row id. */
export function resolveTaskId(ref: string): number {
  const row = /^\d+$/.test(ref)
    ? get<{ id: number }>('SELECT id FROM tasks WHERE id = ?', Number(ref))
    : get<{ id: number }>('SELECT id FROM tasks WHERE uid = ?', ref);
  if (!row) throw new Error(`Task ${ref} not found`);
  return row.id;
}

export function getTask(id: number) {
  const t = get<TaskRow>('SELECT * FROM tasks WHERE id = ?', id);
  if (!t) return null;
  return { ...t, plan: t.plan ? (JSON.parse(t.plan) as Plan) : null };
}

export function getThread(task: TaskRow | NonNullable<ReturnType<typeof getTask>>): ThreadMessage[] {
  return all<ThreadMessage>(
    `SELECT external_id, thread_id, from_name, channel, subject, text, is_from_me, received_at, url
     FROM signals WHERE source = ? AND thread_id = ? ORDER BY received_at DESC LIMIT 30`,
    task.source, task.thread_id,
  ).reverse();
}

export function listTasks(includeDone: boolean) {
  const rows = all<TaskRow & { last_text: string | null; last_at: string | null }>(
    `SELECT t.*,
       (SELECT s.text FROM signals s JOIN task_signals ts ON ts.signal_id = s.id WHERE ts.task_id = t.id ORDER BY s.received_at DESC LIMIT 1) AS last_text,
       (SELECT s.received_at FROM signals s JOIN task_signals ts ON ts.signal_id = s.id WHERE ts.task_id = t.id ORDER BY s.received_at DESC LIMIT 1) AS last_at
     FROM tasks t
     WHERE t.status NOT IN ('dismissed'${includeDone ? '' : ",'done'"})
     ORDER BY CASE t.status WHEN 'suggested' THEN 0 WHEN 'done' THEN 2 ELSE 1 END,
       -- calendar tasks sort by when they were found, not by the (future) event date
       CASE WHEN t.source = 'calendar' THEN t.created_at ELSE COALESCE(last_at, t.created_at) END DESC
     LIMIT 300`,
  );
  return rows.map((r) => ({ ...r, plan: undefined, hasPlan: !!r.plan }));
}

const planSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One sentence: what you will do' },
    steps: { type: 'array', items: { type: 'string' }, description: '2-5 short steps' },
    draft: {
      type: ['object', 'null'],
      properties: { title: { type: 'string' }, body: { type: 'string' } },
      required: ['title', 'body'],
      description: 'A separate document the task needs (agenda, summary, numbers…). Never put the reply message here. Null if none.',
    },
    reply: { type: ['string', 'null'], description: 'The exact message to send back in the same conversation. Always fill it when the person expects an answer, using [placeholders] for facts you do not know. Null only when no reply is expected.' },
    skill_slug: { type: ['string', 'null'], description: 'Slug of the skill you followed' },
    needs_from_me: { type: ['string', 'null'], description: 'Anything you could not do or know and the user must provide, or null' },
    checked: { type: 'array', items: { type: 'string' }, description: 'Each lookup you ran and what it showed, one short line each. Empty if none.' },
    actions: {
      type: 'array',
      description: 'Things to do besides the reply, using only the action tools listed. Each runs only if the user approves it. Empty if none.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short label, e.g. "Add a reminder on Jan 5"' },
          instructions: { type: 'string', description: 'Exact, self-contained instructions with every value needed (dates, names, ids), so it can be done without the conversation' },
          skill_slug: { type: 'string', description: 'The skill whose action tools this uses' },
        },
        required: ['title', 'instructions', 'skill_slug'],
      },
    },
  },
  required: ['summary', 'steps', 'draft', 'reply', 'skill_slug', 'needs_from_me', 'checked', 'actions'],
};

/** What planning may look up, and which actions it may propose, from the user's skills. */
function planTools() {
  const reads = skillGrants('reads');
  const actionSkills = listSkills().filter((s) => !s.system && s.actions.length);
  const lines: string[] = [];
  lines.push(reads.length
    ? `You may run these lookups and nothing else: ${reads.join(', ')}. Use them when a skill says to check something before answering. They only read: never try to change anything. List each lookup and what it showed in checked.`
    : 'You cannot use any tools: work only from the conversation and the skills. Set checked to [].');
  lines.push(actionSkills.length
    ? `Actions you may propose (the user approves each one before it runs, with only these tools): ${actionSkills.map((s) => `skill ${s.slug} can use ${s.actions.join(', ')}`).join('; ')}. Propose an action only when a skill or the user asks for it and the tools can do it. Never put sending the reply in actions.`
    : 'No actions are available: set actions to [] and put anything that must be done in needs_from_me.');
  return { reads, text: lines.join('\n') };
}

export interface PlanOptions {
  /** Changes the user asked for on the previous plan. */
  feedback?: string;
}

/** The note the user added when accepting, kept for every later plan of the task. */
function acceptNote(id: number): string | null {
  const e = get<{ detail: string | null }>("SELECT detail FROM events WHERE task_id = ? AND kind = 'accepted' ORDER BY id DESC LIMIT 1", id);
  const note = e?.detail ? (JSON.parse(e.detail) as { note?: string } | null)?.note : undefined;
  return note?.trim() || null;
}

// Planning never acts: the run gets no tools, and anything it proposes waits for the user's approval.
export async function planTask(id: number, { feedback }: PlanOptions = {}) {
  const task = getTask(id);
  if (!task) throw new Error('Task not found');
  const note = acceptNote(id);
  const tools = planTools();
  touch(id, 'planning');
  run('UPDATE tasks SET plan_error = NULL WHERE id = ?', id);
  const thread = getThread(task);
  const previous = task.plan;
  try {
    const plan = await runClaude<Plan>({
      schema: planSchema,
      permissions: tools.reads.length ? permissionsFor(tools.reads, 'reads') : undefined,
      system: `You are Unchore, the user's assistant. You prepare a plan and the exact reply for a task. You never act: you only read, and propose. ${tools.text}\n\nNever invent facts, numbers, links or commitments that are not in the conversation: write them as [placeholders] in the reply and list them in needs_from_me. When the person expects an answer, the reply field must always contain the full message to send. Write summary, steps and needs_from_me in ${config.language}; write the reply and the draft in the language of the conversation.\n\nThe user's skills:\n\n${workSkillsPrompt()}`,
      prompt: `Today is ${new Date().toISOString().slice(0, 10)}.
Task: ${task.title}
What is asked: ${task.summary ?? ''}
Source: ${connectors[task.source].name}${task.channel ? ` · ${task.channel}` : ''} · requester: ${task.requester ?? 'unknown'} · due: ${task.due ?? 'not set'}${task.source === 'calendar' ? '\nThis is a calendar event: plan how to prepare for it (agenda, questions, materials) and set reply to null.' : ''}

${untrusted('conversation', thread.map((m) => `${m.received_at} ${m.is_from_me ? 'ME' : m.from_name}: ${m.text}`).join('\n'))}
${note ? `\nThe user's note when accepting this task — follow it:\n${note}\n` : ''}${previous && feedback ? `\nYour previous plan:\n${JSON.stringify(previous, null, 2)}\n\nThe user asked for these changes — apply them:\n${feedback}` : ''}`,
    });
    plan.actions = (plan.actions ?? []).map((a) => ({ ...a, status: 'proposed' as const }));
    run('UPDATE tasks SET plan = ? WHERE id = ?', JSON.stringify(plan), id);
    touch(id, 'plan_ready');
    logEvent('plan_ready', { feedback: feedback ?? null }, id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    run('UPDATE tasks SET plan_error = ? WHERE id = ?', message, id);
    touch(id, previous ? 'plan_ready' : 'accepted');
    logEvent('plan_failed', { error: message }, id);
  }
}

const savePlan = (id: number, plan: Plan) => run('UPDATE tasks SET plan = ? WHERE id = ?', JSON.stringify(plan), id);

function actionAt(id: number, index: number) {
  const task = getTask(id);
  const action = task?.plan?.actions?.[index];
  if (!task?.plan || !action) throw new Error('No such action');
  return { task, plan: task.plan, action };
}

const actionSchema = {
  type: 'object',
  properties: {
    done: { type: 'boolean', description: 'True only if the action was carried out exactly as written' },
    detail: { type: 'string', description: 'One sentence: what was done, or why nothing was done' },
  },
  required: ['done', 'detail'],
};

/** Runs one action the user approved, with only the tools its skill grants for actions. */
export async function runAction(id: number, index: number) {
  const { task, plan, action } = actionAt(id, index);
  if (action.status === 'running' || action.status === 'done') throw new Error('This action already ran');
  const skill = action.skill_slug ? getSkill(action.skill_slug) : null;
  if (!skill?.actions.length) throw new Error(`The skill ${action.skill_slug ?? '(none)'} doesn't allow any actions`);
  action.status = 'running';
  savePlan(id, plan);
  logEvent('action_approved', { title: action.title }, id);
  try {
    // Only the approved instructions go in: the conversation itself is never shown to the acting run.
    const r = await runClaude<{ done: boolean; detail: string }>({
      schema: actionSchema,
      permissions: permissionsFor([...skill.actions, ...skill.reads], 'actions'),
      system: 'You carry out one action that the user approved, exactly as written, and nothing else. Use only the tools you have. If you cannot do it exactly as written, do nothing and say why.',
      prompt: `Today is ${new Date().toISOString().slice(0, 10)}.\nTask: ${task.title}\nApproved action: ${action.title}\n\n${action.instructions}`,
    });
    action.status = r.done ? 'done' : 'failed';
    action.result = r.detail;
  } catch (err) {
    action.status = 'failed';
    action.result = err instanceof Error ? err.message : String(err);
  }
  const latest = getTask(id)?.plan;
  // Keep the result even if the plan was redone meanwhile, as long as it is the same action.
  if (latest?.actions?.[index]?.instructions === action.instructions) {
    latest.actions[index] = action;
    savePlan(id, latest);
  }
  logEvent(action.status === 'done' ? 'action_done' : 'action_failed', { title: action.title, detail: action.result }, id);
  return action;
}

export function skipAction(id: number, index: number) {
  const { plan, action } = actionAt(id, index);
  if (action.status === 'running' || action.status === 'done') throw new Error('This action already ran');
  action.status = 'skipped';
  savePlan(id, plan);
  logEvent('action_skipped', { title: action.title }, id);
}

export function acceptTask(id: number, note?: string) {
  touch(id, 'accepted');
  logEvent('accepted', note?.trim() ? { note: note.trim() } : null, id);
  void planTask(id);
}

export async function approveTask(id: number, opts: { sendReply: boolean; reply?: string }) {
  const task = getTask(id);
  if (!task?.plan) throw new Error('Task has no plan to approve');
  touch(id, 'executing');
  try {
    let detail = 'Marked as done without sending a reply.';
    const text = (opts.reply ?? task.plan.reply ?? '').trim();
    if (opts.sendReply && task.source === 'calendar') throw new Error('Calendar tasks have nothing to send');
    if (opts.sendReply && !text) throw new Error('Write the reply before sending it');
    if (opts.sendReply && /\[[^\]\n]{3,}\]/.test(text)) throw new Error('The reply still has [placeholders] to fill in');
    if (opts.sendReply) {
      const result = await connectors[task.source].reply(getThread(task), text);
      detail = result.detail;
      logEvent('reply_' + result.mode, { text, detail }, id);
    }
    touch(id, 'done');
    logEvent('done', { via: 'approve', detail }, id);
    return { detail };
  } catch (err) {
    touch(id, 'plan_ready');
    const message = err instanceof Error ? err.message : String(err);
    run('UPDATE tasks SET plan_error = ? WHERE id = ?', `Sending failed: ${message}`, id);
    logEvent('reply_failed', { error: message }, id);
    throw err;
  }
}

export function requestChanges(id: number, feedback: string, updateSkill: boolean) {
  const task = getTask(id);
  if (!task) throw new Error('Task not found');
  const slug = task.plan?.skill_slug && getSkill(task.plan.skill_slug) ? task.plan.skill_slug : 'writing-replies';
  let skill: string | null = null;
  if (updateSkill && feedback.trim()) {
    appendRule(slug, feedback, `feedback on task #${id}`);
    skill = slug;
  }
  logEvent('changes_requested', { feedback, skill }, id);
  void planTask(id, { feedback });
  return { skill };
}

const ruleSchema = {
  type: 'object',
  properties: { rule: { type: 'string', description: 'One general rule line, max 160 chars, no leading dash' } },
  required: ['rule'],
};

/** "Not a task": dismiss, and turn the reason into a rule for the extractor skill. */
export async function dismissTask(id: number, reason: string, note?: string) {
  const task = getTask(id);
  if (!task) throw new Error('Task not found');
  touch(id, 'dismissed');
  // "Already handled" is about this one item, not a kind of message: nothing to learn.
  if (reason === 'Already handled' && !note?.trim()) {
    logEvent('dismissed', { reason }, id);
    return { rule: null, version: null, previousBody: null };
  }
  const before = getSkill(TASK_SKILL);
  const last = getThread(task).filter((m) => !m.is_from_me).pop();
  const { rule } = await runClaude<{ rule: string }>({
    schema: ruleSchema,
    system: `You maintain the rules that decide which incoming messages are tasks. Write one general, reusable rule in ${config.language}. Do not quote the message.`,
    prompt: `This message was wrongly turned into a task "${task.title}".
Source: ${task.source}${task.channel ? ` · ${task.channel}` : ''}, sender: ${task.requester ?? 'unknown'}.
User's reason: ${reason}${note ? `. User's note: ${note}` : ''}
${untrusted('message', last?.text.slice(0, 1000) ?? '')}

Existing rules:
${before?.body ?? ''}

Write the new rule (under "Not tasks" style), general enough to catch similar messages but not real requests.${task.source === 'calendar' ? ' This item is a calendar event: write the rule about which events to skip, based only on the user\'s reason.' : ''}`,
  });
  const skill = appendRule(TASK_SKILL, rule, `not a task: task #${id}`);
  logEvent('dismissed', { reason, note, rule }, id);
  return { rule, version: skill.version, previousBody: before?.body ?? null };
}

export function undoDismiss(id: number, previousBody: string | null) {
  touch(id, 'suggested');
  const s = getSkill(TASK_SKILL);
  if (s && previousBody) saveSkill(TASK_SKILL, { name: s.name, when: s.when, body: previousBody, system: true }, `undo for task #${id}`);
  logEvent('dismiss_undone', null, id);
}

export function reopenTask(id: number) {
  const task = getTask(id);
  if (!task) throw new Error('Task not found');
  touch(id, task.plan ? 'plan_ready' : 'accepted');
  run('UPDATE tasks SET plan_error = NULL WHERE id = ?', id);
  logEvent('reopened', null, id);
}

export function markDone(id: number, note?: string) {
  touch(id, 'done');
  logEvent('done', { via: 'manual', note: note ?? null }, id);
}

export type TakeoverTool = 'claude-code' | 'codex' | 'claude' | 'chatgpt' | 'self';

export function taskMarkdown(id: number): { dir: string; file: string; markdown: string } {
  const task = getTask(id);
  if (!task) throw new Error('Task not found');
  const thread = getThread(task);
  const skills = listSkills().filter((s) => !s.system && (!task.plan?.skill_slug || s.slug === task.plan.skill_slug || s.slug === 'writing-replies'));
  const dir = join(config.tasksDir, task.uid ?? slugify(task.title));
  const markdown = `---
task: ${task.title}
id: ${task.uid}
source: ${connectors[task.source].name}${task.channel ? ` · ${task.channel}` : ''}
requester: ${task.requester ?? 'unknown'}
due: ${task.due ?? 'not set'}
priority: ${task.priority}
---

# What is being asked
${task.summary ?? task.title}

# Conversation
${thread.map((m) => `- **${m.is_from_me ? 'Me' : m.from_name}** (${m.received_at.slice(0, 16).replace('T', ' ')}): ${m.text.replace(/\n+/g, ' ')}`).join('\n')}
${task.plan ? `
# Plan prepared by Unchore
${task.plan.summary}

${task.plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}
${task.plan.draft ? `\n## Draft: ${task.plan.draft.title}\n${task.plan.draft.body}\n` : ''}${task.plan.reply ? `\n## Suggested reply\n${task.plan.reply}\n` : ''}${task.plan.needs_from_me ? `\n## Still needed\n${task.plan.needs_from_me}\n` : ''}` : ''}
# How I like this done
${skills.map((s) => s.body).join('\n')}
# When you finish
Run \`npx unchore done ${task.uid} --note "what was done"\` from the Unchore folder (${config.root}),
or click "Mark as done" in Unchore.
`;
  return { dir, file: join(dir, 'TASK.md'), markdown };
}

export function takeOver(id: number, tool: TakeoverTool) {
  const { dir, file, markdown } = taskMarkdown(id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, markdown);
  touch(id, 'taken_over');
  logEvent('taken_over', { tool, file }, id);
  const quoted = `'${dir.replace(/'/g, `'\\''`)}'`;
  const prompt = '"Read TASK.md and help me finish this task"';
  let command: string | null = null;
  if (tool === 'claude-code') command = `cd ${quoted} && claude ${prompt}`;
  if (tool === 'codex') command = `cd ${quoted} && codex ${prompt}`;
  if (command && process.platform === 'darwin' && !process.env.UNCHORE_NO_TERMINAL) {
    const script = `tell application "Terminal"\n activate\n do script ${JSON.stringify(command)}\nend tell`;
    execFile('osascript', ['-e', script], (err) => err && console.error('[takeover] could not open Terminal:', err.message));
  }
  const openUrl = tool === 'claude' ? 'https://claude.ai/new' : tool === 'chatgpt' ? 'https://chatgpt.com/' : null;
  return { file, dir, command, markdown, openUrl };
}

export function taskEvents(id: number) {
  return all<{ kind: string; detail: string; created_at: string }>(
    'SELECT kind, detail, created_at FROM events WHERE task_id = ? ORDER BY id DESC LIMIT 50',
    id,
  ).map((e) => ({ ...e, detail: JSON.parse(e.detail) }));
}
