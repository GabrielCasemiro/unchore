import { useState } from 'react';
import { toast } from '../App.tsx';
import { Brand, type BrandId, Icon } from '../icons.tsx';

const TOOLS: Array<{ id: string; name: string; kind: string; brand: BrandId | null }> = [
  { id: 'claude-code', name: 'Claude Code', kind: 'Opens Terminal with the context file', brand: 'claude' },
  { id: 'codex', name: 'Codex', kind: 'Opens Terminal with the context file', brand: 'openai' },
  { id: 'claude', name: 'Claude', kind: 'Copies the context, opens claude.ai', brand: 'claude' },
  { id: 'chatgpt', name: 'ChatGPT', kind: 'Copies the context, opens chatgpt.com', brand: 'openai' },
];
const SELF = { id: 'self', name: 'Do it myself', kind: 'Saves TASK.md, no AI', brand: null };

type Opened = { file: string; command: string | null; markdown: string; openUrl: string | null };

/** The "continue in your AI" menu: writes a context file, then opens Terminal or the AI's site. */
export function AiMenu({ label, heading, sub, here, withSelf, down, onPick, onDone }: {
  label: string;
  heading: string;
  sub: string;
  /** An extra first item that stays in Unchore. */
  here?: { name: string; kind: string; onPick: () => void };
  withSelf?: boolean;
  /** Open the menu below the button instead of above. */
  down?: boolean;
  onPick: (tool: string) => Promise<Opened>;
  onDone?: (r: { name: string; command: string | null; file: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const pick = async (tool: (typeof TOOLS)[number]) => {
    setOpen(false);
    try {
      const r = await onPick(tool.id);
      if (r.openUrl) {
        await navigator.clipboard.writeText(r.markdown).catch(() => undefined);
        window.open(r.openUrl, '_blank', 'noopener');
        toast(`Context copied. Paste it into a new ${tool.name} chat.`);
      } else if (r.command) {
        toast(`Opening ${tool.name} in Terminal.`);
      }
      onDone?.({ name: tool.name, command: r.command, file: r.file });
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <div className="menu-wrap" style={{ flex: '0 0 auto' }}>
      <button type="button" className="btn ai" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} style={{ minHeight: 48 }}>
        {Icon.sparkle()}{label}
        <span style={{ display: 'inline-flex' }}>
          <span className="ai-dot"><Brand id="claude" size={12} /></span>
          <span className="ai-dot" style={{ marginLeft: -6 }}><Brand id="openai" size={12} /></span>
        </span>
        {Icon.chevron()}
      </button>
      {open && (
        <div className={`menu ${down ? 'down' : ''}`} role="menu" aria-label={heading}>
          <div className="menu-head"><strong style={{ display: 'block', fontSize: 13 }}>{heading}</strong>{sub}</div>
          {here && (
            <button type="button" role="menuitem" onClick={() => { setOpen(false); here.onPick(); }}>
              <span className="ic">{Icon.sparkle(16)}</span>
              <span><span style={{ display: 'block', fontWeight: 600 }}>{here.name}</span><span className="sub">{here.kind}</span></span>
            </button>
          )}
          {[...TOOLS, ...(withSelf ? [SELF] : [])].map((t) => (
            <button key={t.id} type="button" role="menuitem" onClick={() => pick(t)}>
              <span className="ic">{t.brand ? <Brand id={t.brand} size={16} /> : Icon.person()}</span>
              <span><span style={{ display: 'block', fontWeight: 600 }}>{t.name}</span><span className="sub">{t.kind}</span></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
