import { config } from '../config.ts';
import { runClaude } from '../claude.ts';
import type { Connector, IncomingMessage } from './types.ts';

// Google Calendar via the claude.ai connector. Unlike the message sources, it
// always looks at a window (now → N days ahead): each event instance becomes a
// "message" whose received_at is the event start, so the extractor can turn it
// into a task due that day. Re-syncs don't duplicate: ids are stable.

interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string | null;
  all_day: boolean;
  organizer: string | null;
  my_response: string | null;
  calendar: string;
  location: string | null;
  attendees: string[];
  description: string | null;
  link: string | null;
}

const schema = {
  type: 'object',
  properties: {
    events: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Event id; for recurring events, the id of this instance' },
          title: { type: 'string', description: 'Event title, or "" when only free/busy is visible' },
          start: { type: 'string', description: 'ISO 8601 with offset (date only for all-day events)' },
          end: { type: ['string', 'null'] },
          all_day: { type: 'boolean' },
          organizer: { type: ['string', 'null'] },
          my_response: { type: ['string', 'null'], description: 'accepted, declined, tentative, needsAction, or null if I organize it' },
          calendar: { type: 'string', description: 'Calendar name or email' },
          location: { type: ['string', 'null'] },
          attendees: { type: 'array', items: { type: 'string' } },
          description: { type: ['string', 'null'], description: 'Max 500 characters' },
          link: { type: ['string', 'null'], description: 'htmlLink or meeting link' },
        },
        required: ['id', 'title', 'start', 'end', 'all_day', 'organizer', 'my_response', 'calendar', 'location', 'attendees', 'description', 'link'],
      },
    },
  },
  required: ['events'],
};

const fmt = (iso: string, allDay: boolean) => {
  const d = new Date(allDay && iso.length === 10 ? `${iso}T12:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return allDay
    ? d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' })
    : d.toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};

/** When the event is over (all-day events last until the end of their day). */
export function eventEnd(e: Pick<CalendarEvent, 'start' | 'end' | 'all_day'>): number {
  if (e.all_day) {
    const day = (e.end ?? e.start).slice(0, 10);
    return Date.parse(`${day}T23:59:59`);
  }
  const end = Date.parse(e.end ?? e.start);
  return Number.isNaN(end) ? Date.now() + 1 : end;
}

export function eventToMessage(e: CalendarEvent): IncomingMessage {
  const when = `${fmt(e.start, e.all_day)}${e.end && !e.all_day ? `–${new Date(e.end).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : ''}`;
  const lines = [
    `Calendar event: ${e.title || '(no title, busy)'}`,
    `When: ${when}${e.all_day ? ' (all day)' : ''}`,
    e.location && `Where: ${e.location}`,
    e.organizer && `Organizer: ${e.organizer}`,
    `My response: ${e.my_response ?? 'organizer'}`,
    e.attendees.length ? `Attendees: ${e.attendees.slice(0, 12).join(', ')}` : null,
    e.description && `Description: ${e.description.slice(0, 500)}`,
  ].filter(Boolean);
  const start = Number.isNaN(Date.parse(e.start)) ? new Date().toISOString() : new Date(e.all_day && e.start.length === 10 ? `${e.start}T09:00:00` : e.start).toISOString();
  return {
    external_id: `${e.id}@${e.start}`,
    thread_id: e.id,
    from_name: e.organizer || e.calendar,
    channel: e.calendar,
    subject: e.title || '(busy)',
    text: lines.join('\n'),
    url: e.link ?? undefined,
    is_from_me: false,
    received_at: start,
    ends_at: new Date(eventEnd(e)).toISOString(),
  };
}

export const calendar: Connector = {
  id: 'calendar',
  name: 'Google Calendar',
  how: 'MCP',
  defaultIntervalMin: 60,
  ready: () => ({ ok: true }),

  async fetch(_cursor, settings) {
    const days = Number(settings.days ?? 7);
    const from = new Date();
    const to = new Date(from.getTime() + days * 86_400_000);
    const { events } = await runClaude<{ events: CalendarEvent[] }>({
      mcpServers: [config.mcp.calendar],
      schema,
      timeoutMs: 240_000,
      system: 'You are the calendar reader for Unchore. You only read: never create, change, delete or respond to events.',
      prompt: `Use the Google Calendar tools to list every event on all my calendars from ${from.toISOString()} to ${to.toISOString()}.
You must actually call the tools; never answer from memory. Expand recurring events into their instances in that window.
Return every event, including all-day events, holidays and free/busy-only blocks (title ""); deciding what matters happens later.`,
    });
    const upcoming = (events ?? []).filter((e) => e.id && e.start && eventEnd(e) > Date.now());
    return { messages: upcoming.map(eventToMessage), cursor: new Date().toISOString() };
  },

  async reply() {
    throw new Error('Calendar tasks have no conversation to reply to. Use "Done" instead.');
  },
};
