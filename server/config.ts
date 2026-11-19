import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const envFile = process.env.UNCHORE_ENV_FILE ?? join(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const expand = (p: string) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p);

const home = resolve(expand(process.env.UNCHORE_HOME || '~/unchore'));

export const config = {
  root,
  home,
  dbPath: join(home, 'unchore.db'),
  skillsDir: join(home, 'skills'),
  librarySkillsDir: join(root, 'skills'),
  tasksDir: join(home, 'tasks'),
  // Empty working folder for runs with granted tools, so they can't browse the data folder.
  runDir: join(home, 'run'),
  port: Number(process.env.PORT || 4477),
  claudeBin: process.env.CLAUDE_BIN || 'claude',
  model: process.env.UNCHORE_MODEL ?? 'sonnet',
  // Language for task titles, summaries and plans. Replies always follow the conversation.
  language: process.env.UNCHORE_LANGUAGE || 'English',
  uazapi: {
    url: (process.env.UAZAPI_URL || '').replace(/\/+$/, ''),
    token: process.env.UAZAPI_TOKEN || '',
  },
  mcp: {
    gmail: process.env.GMAIL_MCP_SERVER || 'claude_ai_Gmail',
    slack: process.env.SLACK_MCP_SERVER || 'claude_ai_Slack',
    calendar: process.env.CALENDAR_MCP_SERVER || 'claude_ai_Google_Calendar',
  },
  // Set by tests to stop the background sync loop.
  disableScheduler: process.env.UNCHORE_NO_SCHEDULER === '1',
};

for (const dir of [config.home, config.skillsDir, config.tasksDir, config.runDir]) mkdirSync(dir, { recursive: true });
