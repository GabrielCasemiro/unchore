import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import { all, get, run } from './db.ts';
import { grantError, splitGrants } from './grants.ts';

export const TASK_SKILL = 'what-counts-as-a-task';

export interface Skill {
  slug: string;
  name: string;
  when: string;
  system: boolean;
  body: string;
  /** Lookups a plan may run on its own (Claude Code permission rules). */
  reads: string[];
  /** Tools an action may use after the user approves it. */
  actions: string[];
  /** Grants that are not allowed, with the reason. They are ignored. */
  grantProblems: string[];
  version: number;
  updatedAt: string | null;
  file: string;
}

type SkillInput = { name: string; when: string; body: string; system?: boolean; reads?: string[]; actions?: string[] };

const fileOf = (slug: string) => join(config.skillsDir, `${slug}.md`);
const libraryFileOf = (slug: string) => join(config.librarySkillsDir, `${slug}.md`);
const validSlug = (slug: string) => /^[a-z0-9][a-z0-9-]{0,60}$/.test(slug);

function frontmatter(text: string) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta: Record<string, string> = {};
  if (m) for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: (m ? m[2] : text).trim() + '\n' };
}

function parse(slug: string, text: string): Omit<Skill, 'version' | 'updatedAt'> {
  const { meta, body } = frontmatter(text);
  const system = meta.system === 'true';
  // The system skill decides what is a task from raw messages: it never gets tools.
  const reads = system ? [] : splitGrants(meta.reads ?? '');
  const actions = system ? [] : splitGrants(meta.actions ?? '');
  const grantProblems = [
    ...reads.map((g) => grantError(g, 'reads')),
    ...actions.map((g) => grantError(g, 'actions')),
  ].filter((e): e is string => !!e);
  return { slug, name: meta.name || slug, when: meta.when || '', system, body, reads, actions, grantProblems, file: fileOf(slug) };
}

const oneLine = (s: string) => s.replace(/\n/g, ' ');

function serialize(s: { name: string; when: string; system: boolean; body: string; reads?: string[]; actions?: string[] }) {
  const grants = [
    s.reads?.length ? `reads: ${oneLine(s.reads.join(', '))}\n` : '',
    s.actions?.length ? `actions: ${oneLine(s.actions.join(', '))}\n` : '',
  ].join('');
  return `---\nname: ${oneLine(s.name)}\nwhen: ${oneLine(s.when)}\nsystem: ${s.system}\n${grants}---\n${s.body.trim()}\n`;
}

function versionOf(slug: string) {
  return get<{ v: number; at: string }>('SELECT MAX(version) AS v, MAX(created_at) AS at FROM skill_versions WHERE skill = ?', slug);
}

export interface LibrarySkill {
  slug: string;
  name: string;
  when: string;
  author: string;
  starter: boolean;
  system: boolean;
  body: string;
  installed: boolean;
}

/** Public skills shipped in the repo's skills/ folder. Users install a copy into their own folder.
 * Library skills never grant tools: reads/actions in a library file are ignored. */
export function listLibrary(): LibrarySkill[] {
  if (!existsSync(config.librarySkillsDir)) return [];
  return readdirSync(config.librarySkillsDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => librarySkill(f.slice(0, -3)))
    .filter((s): s is LibrarySkill => !!s)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function librarySkill(slug: string): LibrarySkill | null {
  if (!validSlug(slug) || !existsSync(libraryFileOf(slug))) return null;
  const { meta, body } = frontmatter(readFileSync(libraryFileOf(slug), 'utf8'));
  return {
    slug,
    name: meta.name || slug,
    when: meta.when || '',
    author: meta.author || '',
    starter: meta.starter === 'true',
    system: meta.system === 'true',
    body,
    installed: existsSync(fileOf(slug)),
  };
}

export function installSkill(slug: string): Skill {
  const lib = librarySkill(slug);
  if (!lib) throw new Error(`No skill called ${slug} in the library`);
  if (lib.installed) throw new Error(`You already have a skill called ${slug}`);
  return saveSkill(slug, { name: lib.name, when: lib.when, body: lib.body, system: lib.system }, 'installed from the library');
}

/** Starter skills are installed on first run and never overwritten. */
export function seedSkills() {
  for (const s of listLibrary()) if (s.starter && !s.installed) saveSkill(s.slug, { name: s.name, when: s.when, body: s.body, system: s.system }, 'created');
}

/** A skill as a file to share: without the rules learned from my own feedback, which often name real people,
 * and without the tools it grants on this computer. */
export function exportSkill(slug: string) {
  const s = getSkill(slug);
  if (!s) throw new Error(`Unknown skill ${slug}`);
  const body = s.body.replace(/\n*## Learned from feedback\n[\s\S]*?(?=\n## |$)/, '\n');
  return { file: `${slug}.md`, markdown: serialize({ name: s.name, when: s.when, system: s.system, body }) };
}

/** Skills created before a feature existed get its default rules once. */
export function migrateSkills() {
  const s = getSkill(TASK_SKILL);
  const defaults = librarySkill(TASK_SKILL)?.body ?? '';
  const calendarRules = defaults.slice(defaults.indexOf('## Calendar events'), defaults.indexOf('## Priority')).trim();
  if (s && calendarRules && !s.body.includes('## Calendar events')) {
    saveSkill(TASK_SKILL, { name: s.name, when: s.when, body: `${s.body.trimEnd()}\n\n${calendarRules}\n`, system: true }, 'added calendar rules');
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

export function saveSkill(slug: string, input: SkillInput, note = 'edited'): Skill {
  if (!validSlug(slug)) throw new Error('Skill names may only use a-z, 0-9 and dashes');
  const prev = getSkill(slug);
  const system = input.system ?? prev?.system ?? false;
  const reads = system ? [] : (input.reads ?? prev?.reads ?? []).map((g) => g.trim()).filter(Boolean);
  const actions = system ? [] : (input.actions ?? prev?.actions ?? []).map((g) => g.trim()).filter(Boolean);
  writeFileSync(fileOf(slug), serialize({ ...input, system, reads, actions }));
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

/** Everything the user's skills grant, across all work skills. */
export function skillGrants(kind: 'reads' | 'actions'): string[] {
  return listSkills().filter((s) => !s.system).flatMap((s) => s[kind]);
}

/** All non-system skills, formatted for a prompt. */
export function workSkillsPrompt(): string {
  return listSkills()
    .filter((s) => !s.system)
    .map((s) => `### Skill: ${s.name} (slug: ${s.slug}) — use when: ${s.when}\n${s.body}`)
    .join('\n\n');
}
