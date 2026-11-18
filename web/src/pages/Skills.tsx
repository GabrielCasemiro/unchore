import { useEffect, useState } from 'react';
import { api, type LibrarySkill, type Skill, timeAgo } from '../api.ts';
import { toast, usePoll } from '../App.tsx';
import { Icon } from '../icons.tsx';

export function Skills({ initial }: { initial?: string }) {
  const { data: skills, reload } = usePoll(api.skills, 30_000);
  const { data: library, reload: reloadLibrary } = usePoll(api.library, 60_000);
  const [selected, setSelected] = useState<string | undefined>(initial);
  const [creating, setCreating] = useState(false);
  const [browsing, setBrowsing] = useState<string | null>(null);
  useEffect(() => { setSelected(initial); setBrowsing(null); }, [initial]);
  const current = skills?.find((s) => s.slug === selected) ?? skills?.[0];
  const available = library?.filter((s) => !s.installed) ?? [];
  const preview = available.find((s) => s.slug === browsing);

  return (
    <>
      <header className="page-head">
        <div className="titles">
          <h1>Skills</h1>
          <p className="sub" style={{ margin: 0, fontSize: 14, maxWidth: 640 }}>
            How your AI should do each kind of work. Plain Markdown files in your Unchore folder, updated by your feedback.
          </p>
        </div>
        <button type="button" className="btn dark" onClick={() => setCreating(true)}>New skill</button>
      </header>
      <div className="columns">
        <section className="skill-list" aria-label="All skills">
          {skills?.map((s) => (
            <button key={s.slug} type="button" className={`skill-item ${current?.slug === s.slug && !creating && !preview ? 'selected' : ''}`} onClick={() => { setCreating(false); setBrowsing(null); location.hash = `#/skills/${s.slug}`; setSelected(s.slug); }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <strong style={{ fontSize: 15, flex: 1 }}>{s.name}</strong>
                {s.system && <span className="chip violet">Inbox</span>}
              </span>
              <span className="sub" style={{ color: '#5a5a66' }}>{s.when}</span>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>v{s.version} · updated {timeAgo(s.updatedAt) || 'never'}</span>
            </button>
          ))}
          {!!available.length && (
            <>
              <h2 style={{ marginTop: 16 }}>Library</h2>
              <p className="sub" style={{ margin: 0, fontSize: 13 }}>Ready-made skills shared in the Unchore repo. Install one to get your own copy.</p>
              {available.map((s) => (
                <button key={s.slug} type="button" className={`skill-item ${preview?.slug === s.slug ? 'selected' : ''}`} onClick={() => { setCreating(false); setBrowsing(s.slug); }}>
                  <strong style={{ fontSize: 15 }}>{s.name}</strong>
                  <span className="sub" style={{ color: '#5a5a66' }}>{s.when}</span>
                  {s.author && <span style={{ fontSize: 12, color: 'var(--muted)' }}>by {s.author}</span>}
                </button>
              ))}
            </>
          )}
        </section>
        {creating ? (
          <Editor key="new" isNew onSaved={(slug) => { setCreating(false); reload(); location.hash = `#/skills/${slug}`; }} />
        ) : preview ? (
          <LibraryPreview key={preview.slug} skill={preview} onInstalled={(slug) => { reload(); reloadLibrary(); setBrowsing(null); location.hash = `#/skills/${slug}`; setSelected(slug); }} />
        ) : (
          current && <Editor key={current.slug + current.version} skill={current} onSaved={() => reload()} />
        )}
      </div>
    </>
  );
}

function Editor({ skill, isNew, onSaved }: { skill?: Skill; isNew?: boolean; onSaved: (slug: string) => void }) {
  const [name, setName] = useState(skill?.name ?? '');
  const [when, setWhen] = useState(skill?.when ?? '');
  const [body, setBody] = useState(skill?.body ?? '# New skill\n\n- \n');
  const [extra, setExtra] = useState<Awaited<ReturnType<typeof api.skill>> | null>(null);
  useEffect(() => { if (skill) api.skill(skill.slug).then(setExtra); }, [skill]);
  const dirty = !skill || name !== skill.name || when !== skill.when || body !== skill.body;
  const slug = skill?.slug ?? name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  return (
    <section className="detail card raised" style={{ flex: '2 1 520px' }} aria-label="Skill editor">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        <label className="field" style={{ flex: '1 1 220px' }}>Name<input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field" style={{ flex: '2 1 280px' }}>Used when<input className="input" value={when} onChange={(e) => setWhen(e.target.value)} placeholder="e.g. Requests from clients about invoices" /></label>
      </div>
      {skill?.system && <div className="notice violet">The Inbox uses this skill on every new message to decide what becomes a task. “Not a task” answers and the Inbox agent add rules here.</div>}
      <label className="field">
        <span>Instructions <span className="sub" style={{ fontWeight: 400 }}>Markdown · {skill ? skill.file : `skills/${slug || '…'}.md`}</span></span>
        <textarea className="textarea code" rows={18} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <div className="actions" style={{ alignItems: 'center' }}>
        <button type="button" className="btn dark" style={{ flex: '0 0 auto' }} disabled={!dirty || !name.trim() || !slug} onClick={async () => {
          try {
            const s = await api.saveSkill(slug, { name, when, body });
            toast(`Saved ${s.name} v${s.version}. The next task will use it.`);
            onSaved(s.slug);
          } catch (e) {
            toast((e as Error).message);
          }
        }}>{isNew ? 'Create skill' : `Save as v${(skill?.version ?? 0) + 1}`}</button>
        {skill && (
          <button type="button" className="btn small" style={{ flex: '0 0 auto' }} onClick={async () => {
            try {
              const { file, markdown } = await api.exportSkill(skill.slug);
              const link = document.createElement('a');
              link.href = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }));
              link.download = file;
              link.click();
              URL.revokeObjectURL(link.href);
              toast('Exported without the rules learned from your feedback. Check it for personal details before sharing.');
            } catch (e) {
              toast((e as Error).message);
            }
          }}>Export</button>
        )}
      </div>
      {extra && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, paddingTop: 14, borderTop: '1px solid var(--line-2)' }}>
          <div style={{ flex: '1 1 240px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>History</h3>
            {extra.history.map((h) => <div key={h.version} style={{ fontSize: 13 }}><strong>v{h.version}</strong> · {h.note} · <span className="sub">{timeAgo(h.created_at)}</span></div>)}
          </div>
          {!!extra.recent.length && (
            <div style={{ flex: '1 1 240px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <h3 style={{ margin: 0, fontSize: 14 }}>Recently used on</h3>
              {extra.recent.map((t) => <a key={t.uid} href={`#/task/${t.uid}`} className="source-row" style={{ padding: '6px 10px', borderRadius: 10, background: 'var(--bg)' }}>{Icon.book(14)}{t.title}</a>)}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function LibraryPreview({ skill, onInstalled }: { skill: LibrarySkill; onInstalled: (slug: string) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <section className="detail card raised" style={{ flex: '2 1 520px' }} aria-label="Library skill">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <h2 style={{ fontSize: 20 }}>{skill.name}</h2>
        <span className="sub">Used when: {skill.when}{skill.author ? ` · by ${skill.author}` : ''}</span>
      </div>
      <pre className="textarea code" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{skill.body}</pre>
      <div className="actions" style={{ alignItems: 'center' }}>
        <button type="button" className="btn dark" style={{ flex: '0 0 auto' }} disabled={busy} onClick={async () => {
          setBusy(true);
          try {
            const s = await api.installSkill(skill.slug);
            toast(`Installed ${s.name}. Edit it to make it yours.`);
            onInstalled(s.slug);
          } catch (e) {
            toast((e as Error).message);
            setBusy(false);
          }
        }}>Install</button>
      </div>
    </section>
  );
}
