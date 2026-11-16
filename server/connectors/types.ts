export type SourceId = 'whatsapp' | 'gmail' | 'slack' | 'linkedin' | 'calendar';

/** A message as a connector hands it over, before it is stored as a signal. */
export interface IncomingMessage {
  external_id: string;
  thread_id: string;
  from_name: string;
  from_handle?: string;
  /** Group, channel or mailbox label shown next to the sender. */
  channel?: string;
  subject?: string;
  text: string;
  url?: string;
  is_from_me: boolean;
  /** ISO 8601 */
  received_at: string;
  /** Calendar events only: when the event is over (ISO 8601). */
  ends_at?: string;
}

export interface ThreadMessage {
  external_id: string;
  thread_id: string;
  from_name: string;
  channel: string | null;
  subject: string | null;
  text: string;
  is_from_me: number;
  received_at: string;
  url: string | null;
}

export interface ReplyResult {
  mode: 'sent' | 'draft';
  detail: string;
}

export interface Connector {
  id: SourceId;
  name: string;
  how: string;
  defaultIntervalMin: number;
  /** Whether the connector has what it needs to run (credentials etc.). */
  ready(): { ok: true } | { ok: false; reason: string };
  fetch(cursor: string | null, settings: Record<string, unknown>): Promise<{ messages: IncomingMessage[]; cursor: string }>;
  reply(thread: ThreadMessage[], text: string): Promise<ReplyResult>;
}
