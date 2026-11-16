import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import { all, get, run } from './db.ts';

export const TASK_SKILL = 'what-counts-as-a-task';

export interface Skill {
  slug: string;
  name: string;
  when: string;
  system: boolean;
  body: string;
  version: number;
  updatedAt: string | null;
  file: string;
}

const DEFAULTS: Record<string, { name: string; when: string; system?: boolean; body: string }> = {
  [TASK_SKILL]: {
    name: 'What counts as a task',
    when: 'Every new message',
    system: true,
    body: `# What counts as a task

A message is a task when someone asks me to do, send, decide, review, answer or
schedule something, or when a reply from me is clearly expected.

## Not tasks
- Newsletters, promotions, automated notifications and receipts
- Messages I sent myself
- Group chatter that doesn't mention me or ask me something
- Simple thanks / ok / emoji replies

## Calendar events
- Every event with a title that I organize, accepted or haven't answered becomes a task
  ("Prepare for …" or the event title), due on the event date
- Skip holidays, all-day out-of-office/birthday events, declined events and
  free/busy blocks without a title

## Priority
- High: clients, money, legal, anything due in the next 48h
- Low: personal chats, nice-to-have requests
`,
  },
  'writing-replies': {
    name: 'Writing replies',
    when: 'Any task answered with a message',
    body: `# Writing replies

- Reply in the same language the person wrote in
- Short and friendly; no greetings longer than one line
- Answer the question first, then details
- Never promise dates or prices that are not in the thread
`,
  },
  scheduling: {
    name: 'Scheduling',
    when: 'Meetings, calls, events and reservations',
    body: `# Scheduling

- Offer two concrete time options instead of asking "when works?"
- Default meeting length: 30 minutes
- Mention the time zone when the person is in another country
`,
  },
};

const fileOf = (slug: string) => join(config.skillsDir, `${slug}.md`);
const validSlug = (slug: string) => /^[a-z0-9][a-z0-9-]{0,60}$/.test(slug);

function parse(slug: string, text: string): Omit<Skill, 'version' | 'updatedAt'> {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta: Record<string, string> = {};
  if (m) for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return {
    slug,
    name: meta.name || slug,
    when: meta.when || '',
    system: meta.system === 'true',
    body: (m ? m[2] : text).trim() + '\n',
    file: fileOf(slug),
  };
}

function serialize(s: { name: string; when: string; system: boolean; body: string }) {
  return `---\nname: ${s.name.replace(/\n/g, ' ')}\nwhen: ${s.when.replace(/\n/g, ' ')}\nsystem: ${s.system}\n---\n${s.body.trim()}\n`;
}

function versionOf(slug: string) {
  return get<{ v: number; at: string }>('SELECT MAX(version) AS v, MAX(created_at) AS at FROM skill_versions WHERE skill = ?', slug);
}

export function seedSkills() {
  for (const [slug, d] of Object.entries(DEFAULTS)) {
    if (existsSync(fileOf(slug))) continue;
    writeFileSync(fileOf(slug), serialize({ ...d, system: !!d.system }));
    run('INSERT INTO skill_versions (skill, version, body, note) VALUES (?, 1, ?, ?)', slug, d.body, 'created');
  }
}

const CALENDAR_RULES = DEFAULTS[TASK_SKILL].body.slice(DEFAULTS[TASK_SKILL].body.indexOf('## Calendar events'), DEFAULTS[TASK_SKILL].body.indexOf('## Priority')).trim();

/** Skills created before a feature existed get its default rules once. */
export function migrateSkills() {
  const s = getSkill(TASK_SKILL);
  if (s && !s.body.includes('## Calendar events')) {
    saveSkill(TASK_SKILL, { name: s.name, when: s.when, body: `${s.body.trimEnd()}\n\n${CALENDAR_RULES}\n`, system: true }, 'added calendar rules');
  }
}

export function getSkill(slug: string): Skill | null {
  if (!validSlug(slug) || !existsSync(fileOf(slug))) return null;
  const s = parse(slug, readFileSync(fileOf(slug), 'utf8'));
  const v = versionOf(slug);
  return { ...s, version: v?.v ?? 1, updatedAt: v?.at ?? null };
}

export function listSkills(): Skill[] {
  return readdirSync(config.skillsDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => getSkill(f.slice(0, -3)))
    .filter((s): s is Skill => !!s)
    .sort((a, b) => Number(b.system) - Number(a.system) || a.name.localeCompare(b.name));
}

export function saveSkill(slug: string, input: { name: string; when: string; body: string; system?: boolean }, note = 'edited'): Skill {
  if (!validSlug(slug)) throw new Error('Skill names may only use a-z, 0-9 and dashes');
  const prev = getSkill(slug);
  const system = input.system ?? prev?.system ?? false;
  writeFileSync(fileOf(slug), serialize({ ...input, system }));
  const version = (versionOf(slug)?.v ?? 0) + 1;
  run('INSERT INTO skill_versions (skill, version, body, note) VALUES (?, ?, ?, ?)', slug, version, input.body, note);
  return getSkill(slug)!;
}

/** Adds one rule line under a "Learned from feedback" heading. */
export function appendRule(slug: string, rule: string, note: string): Skill {
  const s = getSkill(slug);
  if (!s) throw new Error(`Unknown skill ${slug}`);
  const line = `- ${rule.replace(/^[-*]\s*/, '').replace(/\n+/g, ' ').trim()}`;
  const heading = '## Learned from feedback';
  const body = s.body.includes(heading) ? `${s.body.trimEnd()}\n${line}\n` : `${s.body.trimEnd()}\n\n${heading}\n${line}\n`;
  return saveSkill(slug, { name: s.name, when: s.when, body, system: s.system }, note);
}

export function skillHistory(slug: string) {
  return all<{ version: number; note: string; created_at: string }>(
    'SELECT version, note, created_at FROM skill_versions WHERE skill = ? ORDER BY version DESC LIMIT 30',
    slug,
  );
}

/** All non-system skills, formatted for a prompt. */
export function workSkillsPrompt(): string {
  return listSkills()
    .filter((s) => !s.system)
    .map((s) => `### Skill: ${s.name} (slug: ${s.slug}) — use when: ${s.when}\n${s.body}`)
    .join('\n\n');
}
