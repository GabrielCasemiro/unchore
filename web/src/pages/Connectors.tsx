import { useState } from 'react';
import { api, type ConnectorInfo, timeAgo } from '../api.ts';
import { toast, usePoll } from '../App.tsx';
import { Brand, Icon } from '../icons.tsx';

const GUIDE = 'https://github.com/GabrielCasemiro/unchore/blob/main/docs/connecting-sources.md';

const SETUP: Record<string, string[]> = {
  whatsapp: [
    'In your uazapi panel, copy the Server URL and the instance token.',
    'Put them in .env as UAZAPI_URL and UAZAPI_TOKEN, then restart Unchore.',
    'The card turns on by itself. Press Sync now to test.',
  ],
  gmail: [
    'On claude.ai open Settings → Customize → Connectors → Discover, find Gmail and press +.',
    'Sign in with Google and allow access.',
    'In a terminal run: claude mcp list. You should see "claude.ai Gmail: ✔ Connected".',
    'Switch this card On and press Sync now.',
  ],
  slack: [
    'On claude.ai open Settings → Customize → Connectors → Discover, find Slack and press +.',
    'Pick your workspace and allow access.',
    'Check with claude mcp list ("claude.ai Slack: ✔ Connected"), then switch this card On.',
  ],
  calendar: [
    'On claude.ai open Settings → Customize → Connectors → Discover, find Google Calendar and press +.',
    'Sign in with Google and allow access.',
    'Check with claude mcp list ("claude.ai Google Calendar: ✔ Connected"), then switch this card On.',
    'Your events for the next 7 days become tasks. Edit the "Calendar events" rules in the What counts as a task skill to change which ones.',
  ],
  linkedin: [
    'Install the Claude in Chrome extension and log in to LinkedIn in that Chrome.',
    'Keep Chrome open while Unchore syncs.',
    'Switch this card On and press Sync now. A LinkedIn tab opens, is read, and closes.',
  ],
};

const HELP: Record<string, string> = {
  whatsapp: 'Reads direct chats of your business number through uazapi. Replies are sent with the same number.',
  gmail: 'Claude reads your inbox through the Gmail MCP server. Replies are sent, or saved as drafts if the server can only draft.',
  slack: 'Claude reads DMs, mentions and your threads through the Slack MCP server, and posts approved replies.',
  calendar: 'Claude reads your events for the next 7 days through the Google Calendar MCP server. Meetings become tasks due on their date; holidays and busy blocks are skipped.',
  linkedin: 'Claude opens linkedin.com/messaging in your Chrome with Claude in Chrome. Chrome must be open and logged in.',
};

export function Connectors() {
  const { data, reload } = usePoll(api.connectors, 5_000);
  return (
    <>
      <header className="page-head">
        <div className="titles">
          <h1>Connectors</h1>
          <p className="sub" style={{ margin: 0, fontSize: 14, maxWidth: 680 }}>
            Where your tasks come from. Everything runs on this Mac: Gmail, Slack and LinkedIn are read by Claude Code with your own MCP servers and Chrome; WhatsApp uses your uazapi token from <code>.env</code>.
          </p>
          <a href={GUIDE} target="_blank" rel="noreferrer" style={{ fontSize: 14, fontWeight: 600, color: '#4b2fd6' }}>Setup guide with screenshots →</a>
        </div>
      </header>
      <div className="grid">
        {data?.map((c) => <Card key={c.id} c={c} onChange={reload} />)}
      </div>
    </>
  );
}

function Card({ c, onChange }: { c: ConnectorInfo; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const patch = async (p: Parameters<typeof api.updateConnector>[1]) => {
    await api.updateConnector(c.id, p);
    onChange();
  };
  const status = !c.ready ? c.notReadyReason : c.syncing ? 'Syncing now…' : c.lastError ? `Last sync failed: ${c.lastError}` : c.lastSync ? `Synced ${timeAgo(c.lastSync)} · ${c.lastCount ?? 0} new` : c.enabled ? 'Waiting for first sync' : 'Off';
  const dot = !c.ready || c.lastError ? '#d97706' : c.enabled ? '#1e9e5a' : '#b5b5c0';

  return (
    <article className="conn">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span className="tile"><Brand id={c.id} size={24} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2>{c.name}</h2>
          <div className="sub">{c.how}{c.mcpServer ? ` · server ${c.mcpServer}` : ''}</div>
        </div>
        <label className="switch"><input type="checkbox" checked={c.enabled} disabled={!c.ready} onChange={(e) => patch({ enabled: e.target.checked })} />On</label>
      </div>
      <p style={{ margin: 0, fontSize: 13, color: '#3a3a45' }}>{HELP[c.id]}</p>
      <details open={!c.ready || (!c.enabled && !c.lastSync)}>
        <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600, color: '#4b2fd6', minHeight: 28 }}>How to connect</summary>
        <ol style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13, color: '#3a3a45', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {SETUP[c.id].map((s) => <li key={s}>{s}</li>)}
        </ol>
      </details>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13 }}>
        <span className="dot" style={{ background: dot, marginTop: 6 }} />
        <span style={{ overflowWrap: 'anywhere', color: c.lastError ? '#8a2008' : '#3a3a45' }}>{status}</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
        <label className="switch">Every
          <select className="input" style={{ width: 'auto', minHeight: 36 }} value={c.intervalMin} onChange={(e) => patch({ intervalMin: Number(e.target.value) })}>
            {[1, 2, 5, 10, 15, 30, 60, 120, 240].map((m) => <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} h`}</option>)}
          </select>
        </label>
        {c.id === 'whatsapp' && (
          <label className="switch"><input type="checkbox" checked={c.settings.includeGroups === true} onChange={(e) => patch({ settings: { includeGroups: e.target.checked } })} />Include groups</label>
        )}
        <button type="button" className="btn small" style={{ marginLeft: 'auto' }} disabled={busy || !c.ready || c.syncing} onClick={async () => {
          setBusy(true);
          try {
            const r = await api.sync(c.id);
            toast(`${c.name}: ${r.added} new message${r.added === 1 ? '' : 's'}`);
          } catch (e) {
            toast(`${c.name}: ${(e as Error).message}`);
          } finally {
            setBusy(false);
            onChange();
          }
        }}>{busy || c.syncing ? <span className="spinner" /> : Icon.refresh()}Sync now</button>
      </div>
    </article>
  );
}
