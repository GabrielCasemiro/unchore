import { runClaude, untrusted } from './claude.ts';
import { all, run, tx } from './db.ts';
import { runExtractor } from './extractor.ts';
import { appendRule, getSkill, TASK_SKILL } from './skills.ts';
import { getTask } from './tasks.ts';

interface ChatRow {
  id: number;
  role: 'user' | 'agent';
  text: string;
  rule: string | null;
  created_at: string;
}

const schema = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'Your answer to the user, plain text, short' },
    rule_to_add: { type: ['string', 'null'], description: 'A new rule for "What counts as a task" when the user asks to change behaviour, else null' },
    rescan: { type: 'boolean', description: 'True when the user asks to rescan / re-check recent messages' },
  },
  required: ['reply', 'rule_to_add', 'rescan'],
};

export const chatHistory = () => all<ChatRow>('SELECT * FROM agent_chat ORDER BY id DESC LIMIT 40').reverse();

export function clearChat() {
  run('DELETE FROM agent_chat');
}

/** Re-runs extraction on the last day's skipped messages with the current rules. */
export async function rescan(hours = 24) {
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  tx(() => {
    run(
      `DELETE FROM decisions WHERE is_task = 0 AND signal_id IN (SELECT id FROM signals WHERE received_at >= ? AND is_from_me = 0)`,
      since,
    );
    run(
      `UPDATE signals SET processed = 0 WHERE received_at >= ? AND is_from_me = 0
       AND id NOT IN (SELECT signal_id FROM task_signals) AND id NOT IN (SELECT signal_id FROM decisions)`,
      since,
    );
  });
  return runExtractor();
}

export async function askAgent(message: string, taskId?: number) {
  run('INSERT INTO agent_chat (role, text) VALUES (?, ?)', 'user', message);
  const skill = getSkill(TASK_SKILL);
  const decisions = all<{ is_task: number; reason: string; source: string; from_name: string; text: string; received_at: string; task_id: number | null }>(
    `SELECT d.is_task, d.reason, d.task_id, s.source, s.from_name, s.text, s.received_at
     FROM decisions d JOIN signals s ON s.id = d.signal_id ORDER BY d.id DESC LIMIT 80`,
  );
  const focus = taskId ? getTask(taskId) : null;
  const history = chatHistory().slice(-12, -1);
  const stats = all<{ is_task: number; n: number }>(
    `SELECT d.is_task, COUNT(*) AS n FROM decisions d JOIN signals s ON s.id = d.signal_id
     WHERE s.received_at >= ? GROUP BY d.is_task`,
    new Date(Date.now() - 86_400_000).toISOString(),
  );
  const added = stats.find((s) => s.is_task)?.n ?? 0;
  const skipped = stats.find((s) => !s.is_task)?.n ?? 0;

  const out = await runClaude<{ reply: string; rule_to_add: string | null; rescan: boolean }>({
    schema,
    system: `You are the Inbox agent of Unchore. You decide which incoming messages become tasks, following the skill "What counts as a task". The user talks to you to understand your decisions and to change your rules.
- Explain decisions by citing the rule and the message.
- When the user wants different behaviour, put ONE clear general rule in rule_to_add and say in reply what you added.
- Set rescan true only when asked to re-check messages.

Current skill:
${skill?.body ?? ''}`,
    prompt: `In the last 24h: ${added} messages became tasks, ${skipped} were skipped.

${untrusted('recent-decisions', decisions.map((d) => `${d.received_at.slice(0, 16)} ${d.source} ${d.from_name}: "${d.text.slice(0, 160).replace(/\n/g, ' ')}" → ${d.is_task ? `TASK #${d.task_id}` : 'skipped'} (${d.reason})`).join('\n'))}
${focus ? `\nThe user is asking about task #${focus.id} "${focus.title}" from ${focus.requester} (${focus.source}). Your reason when you created it: ${focus.reason ?? 'n/a'}. Confidence ${Math.round((focus.confidence ?? 0) * 100)}%.` : ''}

Conversation so far:
${history.map((h) => `${h.role === 'user' ? 'User' : 'You'}: ${h.text}`).join('\n')}

User: ${message}`,
  });

  let rule: string | null = null;
  if (out.rule_to_add?.trim()) {
    appendRule(TASK_SKILL, out.rule_to_add, 'Inbox agent chat');
    rule = out.rule_to_add.trim();
  }
  let reply = out.reply;
  if (out.rescan) {
    const r = await rescan();
    reply += `\n\nRescanned ${r.processed} messages: ${r.created} new task${r.created === 1 ? '' : 's'}.`;
  }
  run('INSERT INTO agent_chat (role, text, rule) VALUES (?, ?, ?)', 'agent', reply, rule);
  return chatHistory();
}
