import { useEffect, useState } from 'react';
import { api, SOURCE_NAMES, type TaskDetail, timeAgo } from '../api.ts';
import { toast, usePoll } from '../App.tsx';
import { AiMenu } from '../components/AiMenu.tsx';
import { Brand, Icon } from '../icons.tsx';


const STATUS: Record<string, [string, string]> = {
  suggested: ['New · not accepted yet', 'violet'],
  accepted: ['Accepted', 'blue'],
  planning: ['Claude is planning…', 'violet'],
  plan_ready: ['Plan ready · needs your review', 'violet'],
  executing: ['Sending…', 'violet'],
  taken_over: ['You took over', 'blue'],
  done: ['Done', 'green'],
  dismissed: ['Not a task', ''],
};

const ACTION_CHIP: Record<string, [string, string]> = {
  running: ['Running…', 'violet'],
  done: ['Done', 'green'],
  failed: ['Failed', 'high'],
  skipped: ['Skipped', ''],
};

// Claude leaves [placeholders] for facts it doesn't know; never send those.
const findPlaceholders = (text: string) => text.match(/\[[^\]\n]{3,}\]/g) ?? [];

export function Task({ id }: { id: string }) {
  const [fast, setFast] = useState(false);
  const { data, error, reload } = usePoll(() => api.task(id), fast ? 2_000 : 10_000, [id, fast]);
  const status = data?.task.status;
  useEffect(() => setFast(status === 'planning' || status === 'executing'), [status]);

  if (error) return <div className="notice err">{error}</div>;
  if (!data) return <div className="sub">Loading…</div>;
  const { task, thread } = data;

  return (
    <>
      <a href="#/" className="btn ghost" style={{ alignSelf: 'flex-start', paddingLeft: 0 }}>{Icon.back()}Inbox</a>
      <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '12px 16px' }}>
        <h1 style={{ flex: '1 1 360px', fontSize: 32 }}>{task.title}</h1>
        <span className={`chip ${STATUS[task.status]?.[1] ?? ''}`} style={{ fontSize: 13, padding: '6px 12px' }}>{STATUS[task.status]?.[0] ?? task.status}</span>
      </header>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 13 }}>
        <span className="chip" style={{ background: '#fff', border: '1px solid #e4e4ea', fontWeight: 400 }}>Requester <strong>{task.requester ?? '—'}</strong></span>
        <span className="chip" style={{ background: '#fff', border: '1px solid #e4e4ea', fontWeight: 400 }}>Due <strong>{task.due ?? 'not set'}</strong></span>
        <span className="chip" style={{ background: '#fff', border: '1px solid #e4e4ea', fontWeight: 400, textTransform: 'capitalize' }}>Priority <strong>{task.priority}</strong></span>
        {task.plan?.skill_slug && (
          <a className="chip" href={`#/skills/${task.plan.skill_slug}`} style={{ background: '#fff', border: '1px solid #e4e4ea', fontWeight: 400 }}>
            Skill <strong style={{ color: '#4b2fd6', textDecoration: 'underline' }}>{task.plan.skill_slug}</strong>
          </a>
        )}
        <span className="chip" style={{ background: 'transparent', fontWeight: 400, color: 'var(--faint)' }}>{task.uid}</span>
      </div>

      <div className="columns">
        <section className="thread card" aria-label="Conversation">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Brand id={task.source} size={20} />
            <h2>{SOURCE_NAMES[task.source]}{task.channel && task.channel !== 'WhatsApp' ? ` · ${task.channel}` : ''}</h2>
            {thread.find((m) => m.url) && (
              <a href={thread.find((m) => m.url)!.url!} target="_blank" rel="noreferrer" style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 600, color: '#4b2fd6' }}>Open original</a>
            )}
          </div>
          {thread.map((m) => (
            <div key={m.external_id} className={`msg ${m.is_from_me ? 'me' : ''}`}>
              <span className="av">{(m.is_from_me ? 'Me' : m.from_name).charAt(0).toUpperCase()}</span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13 }}><strong>{m.is_from_me ? 'Me' : m.from_name}</strong> <span style={{ color: 'var(--faint)' }}>{timeAgo(m.received_at)}</span></div>
                {m.subject && <div style={{ fontSize: 13, fontWeight: 600 }}>{m.subject}</div>}
                <p>{m.text}</p>
              </div>
            </div>
          ))}
          <div className="notice warn">Messages are passed to the AI as untrusted data. It can only <strong>propose</strong> a reply; nothing is sent until you press send.</div>
          <History data={data} />
        </section>

        <PlanPanel data={data} reload={reload} />
      </div>
    </>
  );
}

const EVENT_LABEL: Record<string, string> = {
  task_created: 'Found in your messages',
  accepted: 'Accepted',
  plan_ready: 'Plan ready',
  plan_failed: 'Planning failed',
  changes_requested: 'Changes requested',
  reply_sent: 'Reply sent',
  reply_draft: 'Reply saved as draft',
  reply_failed: 'Sending failed',
  taken_over: 'Taken over',
  reopened: 'Reopened',
  done: 'Done',
  dismissed: 'Marked not a task',
  expired: 'Removed: the event is over',
  action_approved: 'Action approved',
  action_done: 'Action done',
  action_failed: 'Action failed',
  action_skipped: 'Action skipped',
};

function History({ data }: { data: TaskDetail }) {
  if (!data.events.length) return null;
  return (
    <details>
      <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600, minHeight: 32 }}>History</summary>
      <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13, color: 'var(--muted)', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {data.events.map((e, i) => (
          <li key={i}>
            <strong style={{ color: 'var(--ink)' }}>{EVENT_LABEL[e.kind] ?? e.kind}</strong> · {timeAgo(e.created_at)}
            {typeof e.detail?.detail === 'string' && ` · ${e.detail.detail}`}
            {typeof e.detail?.error === 'string' && ` · ${e.detail.error}`}
            {typeof e.detail?.tool === 'string' && ` · ${e.detail.tool}`}
            {typeof e.detail?.title === 'string' && ` · ${e.detail.title}`}
            {typeof e.detail?.note === 'string' && e.detail.note && ` · “${e.detail.note}”`}
          </li>
        ))}
      </ul>
    </details>
  );
}


function PlanPanel({ data, reload }: { data: TaskDetail; reload: () => void }) {
  const { task } = data;
  const plan = task.plan;
  const [reply, setReply] = useState(plan?.reply ?? '');
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [updateSkill, setUpdateSkill] = useState(true);
  const [busy, setBusy] = useState(false);
  const [takeover, setTakeover] = useState<{ name: string; command: string | null; file: string } | null>(null);
  const [acceptNote, setAcceptNote] = useState('');
  useEffect(() => setReply(plan?.reply ?? ''), [plan?.reply]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      reload();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const status = task.status;
  const canReview = status === 'plan_ready' && !!plan;
  const canReply = task.source !== 'calendar';
  const placeholders = findPlaceholders(reply);
  const sendBlocked = !reply.trim() ? 'Write the reply first.' : placeholders.length ? `Fill in ${placeholders.join(', ')} before sending.` : null;
  const doneEvent = data.events.find((e) => e.kind === 'done');
  const sentEvent = data.events.find((e) => e.kind === 'reply_sent' || e.kind === 'reply_draft');

  return (
    <section className="plan card raised" aria-label="Plan">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ width: 36, height: 36, borderRadius: 12, border: '1px solid var(--line-2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Brand id="claude" size={18} />
        </span>
        <div style={{ flex: 1 }}>
          <h2>Claude's plan</h2>
          <div className="sub">{status === 'planning' ? 'Working on it…' : plan ? plan.summary : 'No plan yet'}</div>
        </div>
        {plan && status !== 'planning' && status !== 'done' && (
          <button type="button" className="btn ghost small" disabled={busy} onClick={() => act(() => api.replan(task.uid))}>{Icon.refresh()}Redo</button>
        )}
      </div>

      {status === 'suggested' && (
        <>
          <label className="field">
            Note (optional)
            <input className="input" value={acceptNote} onChange={(e) => setAcceptNote(e.target.value)} placeholder="e.g. offer next Tuesday, and keep it short" />
          </label>
          <div className="actions">
            <button type="button" className="btn primary" onClick={() => act(() => api.accept(task.uid, acceptNote.trim() || undefined))}>{Icon.check()}Accept and plan</button>
          </div>
        </>
      )}
      {status === 'planning' && <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><span className="spinner" />Claude is reading the conversation and your skills…</div>}
      {task.plan_error && <div className="notice err">{task.plan_error}</div>}
      {status === 'accepted' && !plan && (
        <button type="button" className="btn primary" disabled={busy} onClick={() => act(() => api.replan(task.uid))}>Make a plan</button>
      )}

      {plan && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>How I'll solve it</h3>
            <ol className="steps">{plan.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
          </div>
          {!!(plan.checked?.length || plan.tools_used?.length) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <h3 style={{ margin: 0, fontSize: 14 }}>What I checked</h3>
              {!!plan.checked?.length && <ul className="checked">{plan.checked.map((c, i) => <li key={i}>{c}</li>)}</ul>}
              {plan.tools_used && (plan.tools_used.length
                ? <details className="sub" style={{ fontSize: 12 }}><summary style={{ cursor: 'pointer' }}>{plan.tools_used.length} tool call{plan.tools_used.length > 1 ? 's' : ''} recorded by Unchore</summary><ul className="checked" style={{ marginTop: 4 }}>{plan.tools_used.map((t, i) => <li key={i}><code>{t}</code></li>)}</ul></details>
                : !!plan.checked?.length && <div className="notice warn">Unchore saw no lookups run for this plan, so treat these as unverified.</div>)}
            </div>
          )}
          {plan.needs_from_me && <div className="notice warn"><strong>Needs you:</strong> {plan.needs_from_me}</div>}
          {!!plan.actions?.length && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <h3 style={{ margin: 0, fontSize: 14 }}>Actions <span className="sub" style={{ fontWeight: 400 }}>each one runs only when you approve it</span></h3>
              {plan.actions.map((a, i) => (
                <div key={i} className="action-row" style={{ flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
                    <strong style={{ flex: 1 }}>{a.title}</strong>
                    {a.status && a.status !== 'proposed' && <span className={`chip ${ACTION_CHIP[a.status][1]}`}>{ACTION_CHIP[a.status][0]}</span>}
                  </div>
                  <p style={{ margin: 0, fontSize: 13, whiteSpace: 'pre-wrap', color: 'var(--ink-2)' }}>{a.instructions}</p>
                  {a.result && <span style={{ fontSize: 12, color: a.status === 'failed' ? '#8a2008' : 'var(--muted)' }}>{a.result}</span>}
                  {(a.status === 'proposed' || a.status === 'failed') && status !== 'done' && (
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button type="button" className="btn dark small" disabled={busy} onClick={() => act(async () => {
                        const r = await api.runAction(task.uid, i);
                        toast(r.status === 'done' ? `Done: ${r.title}` : `Couldn't do it: ${r.result ?? ''}`);
                      })}>{a.status === 'failed' ? 'Try again' : 'Approve & run'}</button>
                      {a.status === 'proposed' && <button type="button" className="btn ghost small" disabled={busy} onClick={() => act(() => api.skipAction(task.uid, i))}>Skip</button>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {plan.draft && (
            <article className="draft">
              <div className="label">Draft</div>
              <h3 style={{ margin: 0, fontSize: 17 }}>{plan.draft.title}</h3>
              <pre>{plan.draft.body}</pre>
              {canReview && canReply && !reply.trim() && (
                <button type="button" className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => setReply(plan.draft!.body)}>Use as reply</button>
              )}
            </article>
          )}
        </>
      )}

      {canReview && canReply && (
        <label className="field">
          <span>Reply in {SOURCE_NAMES[task.source]} <span className="sub" style={{ fontWeight: 400 }}>to {task.requester}, sent when you press send</span></span>
          <textarea className="textarea" rows={Math.min(12, Math.max(4, reply.split('\n').length + 1))} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Write the message to send…" />
          {sendBlocked && reply.trim() && <span style={{ fontSize: 12, color: '#8a2008', fontWeight: 400 }}>{sendBlocked}</span>}
        </label>
      )}

      {feedbackOpen && canReview && (
        <div className="reasons" style={{ background: 'var(--warn-bg)', borderColor: '#f0dfb8' }}>
          <label className="field">What should change?
            <textarea className="textarea" rows={3} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="e.g. be more formal, and always offer a call" />
          </label>
          <label className="switch"><input type="checkbox" checked={updateSkill} onChange={(e) => setUpdateSkill(e.target.checked)} />Also update the skill “{plan?.skill_slug ?? 'writing-replies'}”</label>
          <div><button type="button" className="btn dark small" disabled={busy || !feedback.trim()} onClick={() => act(async () => {
            await api.changes(task.uid, feedback, updateSkill);
            setFeedback('');
            setFeedbackOpen(false);
          })}>Send back to Claude</button></div>
        </div>
      )}

      {takeover && (
        <div className="notice" style={{ background: '#f1f1f4', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <strong>You took over{takeover.name !== 'Do it myself' ? ` in ${takeover.name}` : ''}. TASK.md is ready.</strong>
          {takeover.command && <code className="term">{takeover.command}</code>}
          <span style={{ fontSize: 12 }}>{takeover.file}</span>
        </div>
      )}
      {status === 'done' && (
        <div className={`notice ${sentEvent ? 'ok' : 'warn'}`}>
          {sentEvent ? `Done. ${String(sentEvent.detail?.detail ?? '')}` : `Done. ${String(doneEvent?.detail?.detail ?? 'No reply was sent.')}`}
        </div>
      )}

      {status !== 'suggested' && status !== 'planning' && (
        <div className="actions" style={{ alignItems: 'flex-start' }}>
          {canReview && canReply && (
            <button type="button" className="btn primary" title={sendBlocked ?? undefined} disabled={busy || !!sendBlocked} onClick={() => act(async () => {
              const r = await api.approve(task.uid, true, reply);
              toast(r.detail);
            })}>
              {busy ? <span className="spinner" /> : Icon.send()}Approve &amp; send reply
            </button>
          )}
          {canReview && <button type="button" className="btn" disabled={busy} onClick={() => setFeedbackOpen(!feedbackOpen)}>Request changes</button>}
          <AiMenu
            label="Take over with AI"
            heading="Continue with your AI"
            sub="It opens with the conversation, your skills and Claude's plan."
            withSelf
            onPick={(tool) => api.takeover(task.uid, tool)}
            onDone={(r) => { setTakeover(r); reload(); }}
          />
          {status === 'done' ? (
            <button type="button" className="btn" disabled={busy} onClick={() => act(() => api.reopen(task.uid))}>{Icon.refresh()}Reopen</button>
          ) : (
            <button type="button" className={canReply ? 'btn ghost' : 'btn primary'} disabled={busy} onClick={() => act(async () => {
              if (canReview) await api.approve(task.uid, false);
              else await api.done(task.uid);
            })}>{canReply ? 'Done without sending' : <>{Icon.check()}Done</>}</button>
          )}
        </div>
      )}
    </section>
  );
}
