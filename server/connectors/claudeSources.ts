import { config } from '../config.ts';
import { runClaude, untrusted } from '../claude.ts';
import type { Connector, IncomingMessage, ReplyResult, SourceId, ThreadMessage } from './types.ts';

// Gmail, Slack and LinkedIn have no API key in Unchore: Claude Code reads them
// for us, through your MCP servers (Gmail, Slack) or Claude in Chrome (LinkedIn).

const DAY = 24 * 60 * 60 * 1000;

const messagesSchema = {
  type: 'object',
  properties: {
    messages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          external_id: { type: 'string', description: 'Stable unique id of the message in the source' },
          thread_id: { type: 'string', description: 'Id of the conversation/thread/channel the message belongs to' },
          from_name: { type: 'string' },
          from_handle: { type: 'string', description: 'Email address, Slack user id or profile URL' },
          channel: { type: 'string', description: 'Channel, label or conversation name' },
          subject: { type: 'string' },
          text: { type: 'string', description: 'The message body as plain text, max 2000 characters' },
          url: { type: 'string', description: 'Link that opens the message in its app, if known' },
          is_from_me: { type: 'boolean' },
          received_at: { type: 'string', description: 'ISO 8601 timestamp' },
        },
        required: ['external_id', 'thread_id', 'from_name', 'text', 'is_from_me', 'received_at'],
      },
    },
  },
  required: ['messages'],
};

const replySchema = {
  type: 'object',
  properties: {
    mode: { type: 'string', enum: ['sent', 'draft', 'failed'] },
    detail: { type: 'string', description: 'One sentence saying what was done' },
  },
  required: ['mode', 'detail'],
};

interface SourceSpec {
  id: SourceId;
  name: string;
  how: string;
  defaultIntervalMin: number;
  mcpServer?: () => string;
  chrome?: boolean;
  timeoutMs: number;
  readInstructions: string;
  replyInstructions: string;
}

function claudeSource(spec: SourceSpec): Connector {
  const access = () => ({
    mcpServers: spec.mcpServer ? [spec.mcpServer()] : [],
    chrome: spec.chrome,
    timeoutMs: spec.timeoutMs,
  });
  return {
    id: spec.id,
    name: spec.name,
    how: spec.how,
    defaultIntervalMin: spec.defaultIntervalMin,
    ready: () => ({ ok: true }),

    async fetch(cursor) {
      const startedAt = new Date().toISOString();
      const since = cursor ?? new Date(Date.now() - DAY).toISOString();
      const { messages } = await runClaude<{ messages: IncomingMessage[] }>({
        ...access(),
        schema: messagesSchema,
        system:
          'You are the message collector for Unchore. You only read: never send, reply, archive, delete, label or react. Opening a conversation to read it is fine, even if the app then shows it as read.',
        prompt: `${spec.readInstructions}

You must actually call the tools to look; never answer from memory or assume there is nothing new.
Now is ${startedAt}. Collect every message received after ${since} (at most 40, newest first). Check each conversation's date against that cutoff; do not stop after the first one.
Return them in the schema. Use the source's own ids for external_id and thread_id so they stay stable between runs.
If there is nothing new, return an empty list.`,
      });
      if (process.env.UNCHORE_DEBUG) console.log(`[${spec.id}] raw`, JSON.stringify(messages).slice(0, 4000));
      const fresh = (messages ?? [])
        .filter((m) => m.external_id && m.text)
        // Sources like LinkedIn show fuzzy dates ("Nov 12", "2h"); keep those rather than drop them.
        .map((m) => ({ ...m, received_at: Number.isNaN(Date.parse(m.received_at)) ? startedAt : new Date(m.received_at).toISOString() }))
        .filter((m) => Date.parse(m.received_at) > Date.parse(since) - 60_000);
      return { messages: fresh, cursor: startedAt };
    },

    async reply(thread: ThreadMessage[], text: string): Promise<ReplyResult> {
      const last = [...thread].reverse().find((m) => !m.is_from_me) ?? thread[thread.length - 1];
      const result = await runClaude<{ mode: 'sent' | 'draft' | 'failed'; detail: string }>({
        ...access(),
        schema: replySchema,
        system: 'You send exactly one reply that the user already approved. Do nothing else.',
        prompt: `${spec.replyInstructions}

Thread id: ${last.thread_id}
Message to reply to: id ${last.external_id}, from ${last.from_name}${last.subject ? `, subject "${last.subject}"` : ''}${last.url ? `, ${last.url}` : ''}

Send exactly this text, unchanged:
${untrusted('approved-reply', text)}`,
      });
      if (result.mode === 'failed') throw new Error(result.detail);
      return { mode: result.mode, detail: result.detail };
    },
  };
}

export const gmail = claudeSource({
  id: 'gmail',
  name: 'Gmail',
  how: 'MCP',
  defaultIntervalMin: 10,
  mcpServer: () => config.mcp.gmail,
  timeoutMs: 240_000,
  readInstructions:
    'Use the Gmail tools to search the inbox (query like "in:inbox -category:promotions -category:social newer_than:2d"). Read each message and include the plain-text body. Mark is_from_me true for messages I sent. Use the Gmail message id as external_id and the thread id as thread_id; channel is "Inbox".',
  replyInstructions:
    'Use the Gmail tools to reply in this email thread (reply to the sender, keep the subject). If the tools can send, send it and return mode "sent". If they can only create drafts, create a reply draft and return mode "draft".',
});

export const slack = claudeSource({
  id: 'slack',
  name: 'Slack',
  how: 'MCP',
  defaultIntervalMin: 10,
  mcpServer: () => config.mcp.slack,
  timeoutMs: 240_000,
  readInstructions:
    'Use the Slack tools to find messages that need me: direct messages to me, messages that @mention me, and replies in threads I took part in. Search, do not read whole busy channels. Use "<channel_id>:<ts>" as external_id and "<channel_id>:<thread_ts or ts>" as thread_id; channel is "#name" or "DM". Include a permalink as url when available.',
  replyInstructions:
    'Use the Slack tools to post the reply in the same conversation. thread_id is "<channel_id>:<thread_ts>": reply inside that thread (use thread_ts). Return mode "sent".',
});

export const linkedin = claudeSource({
  id: 'linkedin',
  name: 'LinkedIn',
  how: 'Claude in Chrome',
  defaultIntervalMin: 60,
  chrome: true,
  timeoutMs: 600_000,
  readInstructions:
    'Use Claude in Chrome. Open a new tab at https://www.linkedin.com/messaging/ (I am already logged in). The conversation list shows each conversation\'s date. For every conversation with activity in the time window, open it and read the latest messages (include recruiter and sponsored messages too; deciding what matters is done later). Use the conversation URL as thread_id and "<conversation URL>#<sender>-<date>" as external_id; url is the conversation URL. LinkedIn shows dates like "Nov 12" or "2h": convert them to ISO 8601 using today\'s date. Close the tab when done.',
  replyInstructions:
    'Use Claude in Chrome. Open the conversation URL (the thread id) in a new tab, type the text into the message box and send it. Return mode "sent". Close the tab when done.',
});
