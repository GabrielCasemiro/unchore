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
  return { slug, name: meta.name || slug, when: meta.when || '', system: meta.system === 'true', body, file: fileOf(slug) };
}

function serialize(s: { name: string; when: string; system: boolean; body: string }) {
  return `---\nname: ${s.name.replace(/\n/g, ' ')}\nwhen: ${s.when.replace(/\n/g, ' ')}\nsystem: ${s.system}\n---\n${s.body.trim()}\n`;
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

/** Public skills shipped in the repo's skills/ folder. Users install a copy into their own folder. */
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
  return saveSkill(slug, lib, 'installed from the library');
}

/** Starter skills are installed on first run and never overwritten. */
export function seedSkills() {
  for (const s of listLibrary()) if (s.starter && !s.installed) saveSkill(s.slug, s, 'created');
}

/** A skill as a file to share: without the rules learned from my own feedback, which often name real people. */
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
