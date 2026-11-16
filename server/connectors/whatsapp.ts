import { config } from '../config.ts';
import type { Connector, IncomingMessage } from './types.ts';

interface UazChat {
  wa_chatid: string;
  wa_name?: string;
  wa_contactName?: string;
  name?: string;
  wa_isGroup?: boolean;
  wa_lastMsgTimestamp?: number;
}

interface UazMessage {
  messageid: string;
  chatid: string;
  sender?: string;
  sender_pn?: string | null;
  senderName?: string;
  isGroup?: boolean;
  fromMe?: boolean;
  messageType?: string;
  messageTimestamp: number;
  text?: string;
}

const SKIP_TYPES = new Set(['ReactionMessage', 'ProtocolMessage', 'PollUpdateMessage', 'call', 'error']);
const DAY = 24 * 60 * 60 * 1000;
const ms = (t: number | undefined) => (!t ? 0 : t < 1e12 ? t * 1000 : t);

async function uaz<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${config.uazapi.url}${path}`, {
    method: 'POST',
    headers: { token: config.uazapi.token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`uazapi ${path} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

const chatName = (c: UazChat) => c.wa_name || c.wa_contactName || c.name || c.wa_chatid.split('@')[0];

export const whatsapp: Connector = {
  id: 'whatsapp',
  name: 'WhatsApp Business',
  how: 'uazapi',
  defaultIntervalMin: 2,

  ready() {
    if (!config.uazapi.url || !config.uazapi.token) return { ok: false, reason: 'Set UAZAPI_URL and UAZAPI_TOKEN in .env' };
    return { ok: true };
  },

  async fetch(cursor, settings) {
    const since = cursor ? Number(cursor) : Date.now() - DAY;
    const includeGroups = settings.includeGroups === true;
    const { chats = [] } = await uaz<{ chats?: UazChat[] }>('/chat/find', {
      sort: '-wa_lastMsgTimestamp',
      limit: 60,
      compact: true,
      ...(includeGroups ? {} : { wa_isGroup: false }),
    });
    // The list is not strictly ordered (pinned chats come first), so filter rather than stop early.
    const active = chats.filter((c) => ms(c.wa_lastMsgTimestamp) > since).slice(0, 30);
    const messages: IncomingMessage[] = [];
    let newest = since;
    for (const chat of active) {
      const { messages: found = [] } = await uaz<{ messages?: UazMessage[] }>('/message/find', { chatid: chat.wa_chatid, limit: 30 });
      for (const m of found) {
        const at = ms(m.messageTimestamp);
        if (at <= since || SKIP_TYPES.has(m.messageType ?? '')) continue;
        const text = (m.text ?? '').trim() || `[${(m.messageType ?? 'media').replace(/Message$/, '').toLowerCase()}]`;
        newest = Math.max(newest, at);
        messages.push({
          external_id: m.messageid,
          thread_id: m.chatid,
          from_name: m.fromMe ? 'Me' : m.senderName || chatName(chat),
          from_handle: (m.sender_pn ?? m.sender ?? m.chatid).split('@')[0],
          channel: chat.wa_isGroup ? chatName(chat) : 'WhatsApp',
          text,
          is_from_me: !!m.fromMe,
          received_at: new Date(at).toISOString(),
        });
      }
    }
    return { messages, cursor: String(newest) };
  },

  async reply(thread, text) {
    const chatid = thread[0]?.thread_id;
    if (!chatid) throw new Error('No WhatsApp chat to reply to');
    const lastInbound = [...thread].reverse().find((m) => !m.is_from_me);
    await uaz('/send/text', { number: chatid, text, ...(lastInbound ? { replyid: lastInbound.external_id } : {}) });
    return { mode: 'sent', detail: `Sent on WhatsApp to ${thread.find((m) => !m.is_from_me)?.from_name ?? chatid}` };
  },
};
