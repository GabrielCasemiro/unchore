import { homedir } from 'node:os';

// A skill can let Claude use a few tools, written as Claude Code permission rules:
//   reads:   lookups a plan may run on its own (read files, run one command, read one MCP tool)
//   actions: tools an action may use, and only after the user approves that action
// They live only in the user's own skill files; shared and library skills never carry them.

export type GrantKind = 'reads' | 'actions';

const BUILTIN: Record<GrantKind, string[]> = {
  reads: ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch'],
  actions: ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch', 'Edit', 'Write'],
};
const FILE_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write'];
// Claude Code can reach every file in a folder it is given, so secrets inside granted
// folders are always denied (deny rules win over the folder access).
const SECRETS = ['.env*', '*.pem', '*.key', 'id_rsa*', 'id_ed25519*', '.ssh/**', '.aws/**', '.netrc', '.npmrc', 'credentials*'];

/** Splits "Read(a, b), Bash(x)" on the commas that are outside parentheses. */
export function splitGrants(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Why a grant is not allowed, or null when it is fine. */
export function grantError(grant: string, kind: GrantKind): string | null {
  if (/^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/.test(grant)) return null;
  if (/^mcp__/.test(grant)) return `${grant}: name one MCP tool (mcp__server__tool), not a whole server`;
  const m = grant.match(/^([A-Za-z]+)\((.+)\)$/);
  if (!m) return `${grant}: write it as Tool(what it may touch), for example Read(~/notes/**)`;
  if (!BUILTIN[kind].includes(m[1])) {
    return kind === 'reads' && BUILTIN.actions.includes(m[1])
      ? `${grant}: ${m[1]} changes things, so it belongs under actions`
      : `${grant}: ${m[1]} is not a tool a skill can use`;
  }
  // Claude Code only matches Bash rules as a prefix: an exact command never matches.
  // A prefix lets extra flags through, so tools that can write files (curl -o) are not allowed.
  if (m[1] === 'Bash' && /^(curl|wget)\b/.test(m[2])) return `${grant}: use WebFetch(domain:…) instead; curl and wget can also write files`;
  if (m[1] === 'Bash' && !m[2].endsWith(':*')) return `${grant}: end it with :* so it matches, like Bash(sqlite3 -safe -readonly ~/crm.db:*)`;
  if (m[1] === 'WebFetch' && !m[2].startsWith('domain:')) return `${grant}: limit WebFetch to one site, like WebFetch(domain:example.com)`;
  if (FILE_TOOLS.includes(m[1]) && !/^[~/]/.test(m[2])) return `${grant}: use a full path starting with ~/ or /`;
  if (FILE_TOOLS.includes(m[1]) && /^(~|\/Users\/[^/]+|\/home\/[^/]+)?\/\*\*$/.test(m[2])) return `${grant}: name a folder, not your whole disk or home`;
  if (FILE_TOOLS.includes(m[1]) && !/^[~/].*[^/*]\/\*\*$/.test(m[2])) {
    return `${grant}: grant a folder, like ${m[1]}(~/work/clients/**). Claude can open every file in a folder it is given`;
  }
  return null;
}

export interface Permissions {
  /** Built-in tools to turn on (--tools). */
  tools: string[];
  /** Permission rules (--allowedTools), file paths made absolute. */
  rules: string[];
  /** Deny rules (--disallowedTools) for secrets inside granted folders. */
  denied: string[];
  /** Folders the file tools may reach (--add-dir). */
  dirs: string[];
  /** Whether MCP servers must be loaded. */
  mcp: boolean;
}

const expandHome = (p: string) => (p.startsWith('~') ? homedir() + p.slice(1) : p);

/** Turns valid grants into CLI permissions. Invalid ones are dropped. */
export function permissionsFor(grants: string[], kind: GrantKind): Permissions {
  const perms: Permissions = { tools: [], rules: [], denied: [], dirs: [], mcp: false };
  for (const grant of new Set(grants)) {
    if (grantError(grant, kind)) continue;
    if (grant.startsWith('mcp__')) {
      perms.mcp = true;
      perms.rules.push(grant);
      continue;
    }
    const [, tool, spec] = grant.match(/^([A-Za-z]+)\((.+)\)$/)!;
    if (!perms.tools.includes(tool)) perms.tools.push(tool);
    if (FILE_TOOLS.includes(tool)) {
      const dir = expandHome(spec).slice(0, -'/**'.length);
      // Claude Code reads "//path" as an absolute path.
      perms.rules.push(`${tool}(/${dir}/**)`);
      if (!perms.dirs.includes(dir)) perms.dirs.push(dir);
    } else {
      perms.rules.push(grant);
    }
  }
  // Claude Code loads MCP tools on demand through ToolSearch. It only loads schemas;
  // calling a tool is still decided by the rules above.
  if (perms.mcp) perms.tools.push('ToolSearch');
  const fileTools = perms.tools.filter((t) => FILE_TOOLS.includes(t));
  for (const dir of perms.dirs) {
    for (const tool of fileTools) for (const secret of SECRETS) perms.denied.push(`${tool}(/${dir}/**/${secret})`);
  }
  return perms;
}
