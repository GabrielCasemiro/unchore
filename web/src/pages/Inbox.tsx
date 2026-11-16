import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type ChatMessage, type SourceId, SOURCE_NAMES, type TaskListItem, timeAgo } from '../api.ts';
import { toast, usePoll } from '../App.tsx';
import { Brand, Icon } from '../icons.tsx';

const REASONS = ['Just FYI', 'Automated / newsletter', 'Already handled', 'Not meant for me', 'Personal, keep out'];

const STATUS_CHIP: Record<string, [string, string]> = {
  accepted: ['Accepted', 'blue'],
  planning: ['Planning…', 'violet'],
  plan_ready: ['Plan ready', 'violet'],
  executing: ['Sending…', 'violet'],
  taken_over: ['Taken over', 'blue'],
  done: ['Done', 'green'],
};

export function Inbox({ onCount }: { onCount: (n: number) => void }) {
  const [showDone, setShowDone] = useState(false);
  const { data: tasks, error, reload } = usePoll(() => api.tasks(showDone), 8_000, [showDone]);
  const [source, setSource] = useState<SourceId | 'all'>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatTask, setChatTask] = useState<string | undefined>();
  const [learned, setLearned] = useState<{ taskId: number; uid: string; rule: string; previousBody: string | null } | null>(null);

  const open = (tasks ?? []).filter((t) => t.status !== 'done');
  const newCount = open.filter((t) => t.status === 'suggested').length;
  useEffect(() => onCount(newCount), [newCount, onCount]);

  const visible = useMemo(
    () =>
      (tasks ?? []).filter(
        (t) =>
          (source === 'all' || t.source === source) &&
          (!query || `${t.title} ${t.requester} ${t.last_text}`.toLowerCase().includes(query.toLowerCase())),
      ),
    [tasks, source, query],
  );
  const selected = visible.find((t) => t.id === selectedId) ?? visible[0] ?? null;
  const sources = (['all', 'gmail', 'calendar', 'slack', 'whatsapp', 'linkedin'] as const).map((id) => ({
    id,
    n: open.filter((t) => id === 'all' || t.source === id).length,
  }));

  return (
    <>
      <header className="page-head">
        <div className="titles">
          <div className="sub">{new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</div>
          <h1>Inbox</h1>
        </div>
        <label className="search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
          <span className="sr-only">Search</span>
          <input type="search" placeholder="Search tasks and people…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <button type="button" className="btn ai" aria-expanded={chatOpen} onClick={() => { setChatTask(undefined); setChatOpen(!chatOpen); }}>
          {Icon.sparkle()}Ask the Inbox agent
        </button>
      </header>

      <div role="group" aria-label="Filter by source" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {sources.map((s) => (
          <button key={s.id} type="button" className="pill" aria-pressed={source === s.id} onClick={() => setSource(s.id)}>
            {s.id !== 'all' && <Brand id={s.id} size={16} color={source === s.id && s.id === 'slack' ? '#fff' : undefined} />}
            {s.id === 'all' ? 'All' : SOURCE_NAMES[s.id]}
            <span className="n">{s.n}</span>
          </button>
        ))}
      </div>

      {error && <div className="notice err">Can't reach Unchore: {error}</div>}

      <div className="columns">
        <section className="list" aria-label="Tasks">
          {learned && (
            <div className="learned" role="status">
              <span className="ic">{Icon.sparkle(16)}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>Learned: {learned.rule}</div>
                <div style={{ fontSize: 13 }}>
                  Added to the “What counts as a task” skill. <a href="#/skills/what-counts-as-a-task" style={{ fontWeight: 600, color: '#3a1fc2', textDecoration: 'underline' }}>Open skill</a>
                </div>
              </div>
              <button type="button" className="btn small" onClick={async () => {
                await api.undoDismiss(learned.uid, learned.previousBody);
                setSelectedId(learned.taskId);
                setLearned(null);
                reload();
              }}>Undo</button>
            </div>
          )}
          {tasks && !visible.length && (
            <div className="empty">
              <strong>Inbox zero</strong>
              <span>New requests show up here as soon as a connector finds them.</span>
            </div>
          )}
          {visible.map((t) => (
            <button key={t.id} type="button" className={`row ${selected?.id === t.id ? 'selected' : ''}`} onClick={() => setSelectedId(t.id)}>
              <span className="src"><Brand id={t.source} size={20} /></span>
              <span className="body">
                <span className="top">
                  <span>{SOURCE_NAMES[t.source]} · {t.requester ?? 'Unknown'}{t.channel && t.channel !== 'WhatsApp' ? ` · ${t.channel}` : ''}</span>
                  <span className="when">{timeAgo(t.last_at ?? t.created_at)}</span>
                </span>
                <span className="title">
                  <span>{t.title}</span>
                  {t.status === 'suggested' ? <span className="chip new">New</span> : STATUS_CHIP[t.status] && <span className={`chip ${STATUS_CHIP[t.status][1]}`}>{STATUS_CHIP[t.status][0]}</span>}
                </span>
                <span className="snippet">{t.last_text ?? t.summary}</span>
              </span>
            </button>
          ))}
          {tasks && (
            <button type="button" className="btn ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setShowDone(!showDone)}>
              {showDone ? 'Hide done' : 'Show done'}
            </button>
          )}
        </section>

        {chatOpen ? (
          <AgentChat taskId={chatTask} onClose={() => setChatOpen(false)} onChange={reload} />
        ) : (
          selected && (
            <Details
              key={selected.id}
              task={selected}
              onWhy={() => { setChatTask(selected.uid); setChatOpen(true); }}
              onChanged={reload}
              onLearned={(rule, previousBody) => setLearned({ taskId: selected.id, uid: selected.uid, rule, previousBody })}
            />
          )
        )}
      </div>
    </>
  );
}

function Details({ task, onWhy, onChanged, onLearned }: {
  task: TaskListItem;
  onWhy: () => void;
  onChanged: () => void;
  onLearned: (rule: string, previousBody: string | null) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const isNew = task.status === 'suggested';

  const dismiss = async (reason: string) => {
    setBusy(true);
    try {
      const r = await api.dismiss(task.uid, reason, note || undefined);
      if (r.rule) onLearned(r.rule, r.previousBody);
      else toast('Removed from your Inbox.');
      onChanged();
    } catch (e) {
      toast(`Couldn't save: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="detail card raised" aria-label="Details">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--muted)', flexWrap: 'wrap' }}>
        {isNew ? <span className="chip violet">New · waiting for you to accept</span> : <span className={`chip ${STATUS_CHIP[task.status]?.[1] ?? ''}`}>{STATUS_CHIP[task.status]?.[0] ?? task.status}</span>}
        {isNew && task.confidence != null && <span>{Math.round(task.confidence * 100)}% sure this is a request</span>}
        <button type="button" className="btn ghost small" style={{ marginLeft: 'auto', background: '#f6eeff', color: '#3a1fc2' }} onClick={onWhy}>
          {Icon.sparkle(13)}Why?
        </button>
      </div>
      <h2 style={{ fontSize: 24, letterSpacing: '-0.025em' }}>{task.title}</h2>
      <figure className="quote">
        <figcaption><strong style={{ color: 'var(--ink)' }}>{task.requester}</strong> via {SOURCE_NAMES[task.source]}{task.channel && task.channel !== 'WhatsApp' ? ` · ${task.channel}` : ''} · {timeAgo(task.last_at)}</figcaption>
        <blockquote>{task.last_text ?? task.summary}</blockquote>
        <a href={`#/task/${task.uid}`} style={{ fontSize: 13, fontWeight: 600, color: '#4b2fd6' }}>Open task and full thread</a>
      </figure>
      <dl className="facts">
        <div><dt>Requester</dt><dd>{task.requester ?? '—'}</dd></div>
        <div><dt>Due</dt><dd>{task.due ?? 'Not set'}</dd></div>
        <div><dt>Priority</dt><dd style={{ textTransform: 'capitalize' }}>{task.priority}</dd></div>
      </dl>
      {task.summary && <p style={{ margin: 0, color: 'var(--ink-2)' }}>{task.summary}</p>}

      {isNew ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="actions">
            <button type="button" className="btn primary" disabled={busy} onClick={async () => {
              await api.accept(task.uid);
              toast('Accepted. Claude is preparing a plan.');
              onChanged();
            }}>{Icon.check()}Accept</button>
            <button type="button" className="btn" disabled={busy} onClick={() => setAsking(!asking)}>{Icon.x()}Not a task</button>
          </div>
          {asking && (
            <div className="reasons">
              <strong>Why isn't this a task?</strong>
              <span style={{ fontSize: 13, color: '#3a3a45' }}>Your answer becomes a rule, so similar messages are skipped next time.</span>
              <div className="opts">
                {REASONS.map((r) => <button key={r} type="button" disabled={busy} onClick={() => dismiss(r)}>{r}</button>)}
              </div>
              <label className="field">
                Anything else? (optional)
                <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. order updates from this store are automatic" />
              </label>
              {busy && <span style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}><span className="spinner" />Learning…</span>}
            </div>
          )}
        </div>
      ) : (
        <div className="actions">
          <a className="btn dark" href={`#/task/${task.uid}`}>{task.status === 'plan_ready' ? 'Review plan' : 'Open task'}</a>
          {task.status !== 'done' && (
            <button type="button" className="btn" onClick={async () => { await api.done(task.uid); onChanged(); }}>Mark as done</button>
          )}
        </div>
      )}
    </section>
  );
}

const QUICK = ['What did you skip today?', 'Rescan the last 24h'];

function AgentChat({ taskId, onClose, onChange }: { taskId?: string; onClose: () => void; onChange: () => void }) {
  const [log, setLog] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const send = async (text: string, focus?: string) => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setLog((l) => [...l, { id: -Date.now(), role: 'user', text, rule: null, created_at: new Date().toISOString() }]);
    try {
      setLog(await api.ask(text, focus));
      onChange();
    } catch (e) {
      toast(`The agent failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const asked = useRef<string | undefined>(undefined);
  useEffect(() => {
    api.chat().then(setLog);
    // StrictMode runs effects twice in dev; only ask once per task.
    if (taskId && asked.current !== taskId) {
      asked.current = taskId;
      void send('Why did you add this task?', taskId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  return (
    <section className="detail agent" aria-label="Inbox agent">
      <div className="head">
        <span className="avatar">{Icon.sparkle()}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2>Inbox agent</h2>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            Follows the skill <a href="#/skills/what-counts-as-a-task" style={{ fontWeight: 600, color: '#4b2fd6', textDecoration: 'underline' }}>What counts as a task</a>
          </div>
        </div>
        <button type="button" className="btn ghost small" onClick={async () => setLog(await api.clearChat())}>Clear</button>
        <button type="button" className="icon-btn" aria-label="Close chat" onClick={onClose}>{Icon.x()}</button>
      </div>
      <div className="log" role="log" aria-label="Conversation">
        {!log.length && <div className="bubble agent">Ask me why I added or skipped something, or tell me what to change. Your instructions become rules in my skill.</div>}
        {log.map((m) => (
          <div key={m.id} className={`bubble ${m.role}`}>
            {m.text}
            {m.rule && <div className="rule"><span>Added to What counts as a task</span><code>- {m.rule}</code></div>}
          </div>
        ))}
        {busy && <div className="bubble agent" style={{ flexDirection: 'row', alignItems: 'center' }}><span className="spinner" />Thinking…</div>}
      </div>
      <div className="prompts">
        {QUICK.map((q) => <button key={q} type="button" disabled={busy} onClick={() => send(q)}>{q}</button>)}
      </div>
      <form className="composer" onSubmit={(e) => { e.preventDefault(); void send(draft); setDraft(''); }}>
        <label style={{ flex: 1, minWidth: 0, display: 'flex' }}>
          <span className="sr-only">Message the Inbox agent</span>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Ask why, or tell it what to change…" style={{ width: '100%' }} />
        </label>
        <button type="submit" className="icon-btn primary" aria-label="Send" disabled={busy}>{Icon.send()}</button>
      </form>
    </section>
  );
}
