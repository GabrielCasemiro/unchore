import { useCallback, useEffect, useState } from 'react';
import { api, type ConnectorInfo, SOURCE_NAMES, timeAgo } from './api.ts';
import { Brand, Icon, Logo } from './icons.tsx';
import { Connectors } from './pages/Connectors.tsx';
import { Inbox } from './pages/Inbox.tsx';
import { Skills } from './pages/Skills.tsx';
import { Task } from './pages/Task.tsx';

function useHash() {
  const [hash, setHash] = useState(location.hash || '#/');
  useEffect(() => {
    const on = () => setHash(location.hash || '#/');
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return hash;
}

export function usePoll<T>(load: () => Promise<T>, ms: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reload = useCallback(() => load().then((d) => { setData(d); setError(null); }, (e: Error) => setError(e.message)), deps);
  useEffect(() => {
    reload();
    const t = setInterval(reload, ms);
    return () => clearInterval(t);
  }, [reload, ms]);
  return { data, error, reload };
}

let toastTimer: ReturnType<typeof setTimeout>;
export function toast(text: string) {
  window.dispatchEvent(new CustomEvent('unchore-toast', { detail: text }));
}

function Toast() {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      setText((e as CustomEvent<string>).detail);
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => setText(null), 4500);
    };
    addEventListener('unchore-toast', on);
    return () => removeEventListener('unchore-toast', on);
  }, []);
  return text ? <div className="toast" role="status">{text}</div> : null;
}

function Sidebar({ hash, newCount }: { hash: string; newCount: number }) {
  const { data: conns } = usePoll<ConnectorInfo[]>(api.connectors, 15_000);
  const link = (href: string, label: string, icon: React.ReactNode, extra?: React.ReactNode) => {
    const active = href === '#/' ? hash === '#/' || hash.startsWith('#/task') : hash.startsWith(href);
    return (
      <a href={href} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined}>
        {icon}
        <span>{label}</span>
        {extra}
      </a>
    );
  };
  return (
    <aside className="sidebar">
      <a href="#/" className="brand">
        <Logo />
        <span className="wordmark"><span className="un">un</span>chore</span>
      </a>
      <nav className="nav" aria-label="Main">
        {link('#/', 'Inbox', Icon.inbox(), newCount ? <span className="count">{newCount}</span> : null)}
        {link('#/skills', 'Skills', Icon.book())}
        {link('#/connectors', 'Connectors', Icon.plug())}
      </nav>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div className="side-label">Sources</div>
        {(conns ?? []).filter((c) => c.enabled).map((c) => (
          <a key={c.id} href="#/connectors" className="source-row">
            <Brand id={c.id} size={16} />
            {SOURCE_NAMES[c.id]}
            <span className={`meta ${c.lastError ? 'err' : ''}`}>{c.syncing ? 'syncing…' : c.lastError ? 'error' : timeAgo(c.lastSync) || 'waiting'}</span>
          </a>
        ))}
        {conns && !conns.some((c) => c.enabled) && <a href="#/connectors" className="source-row" style={{ color: '#4b2fd6', fontWeight: 600 }}>Connect a source</a>}
      </div>
    </aside>
  );
}

export function App() {
  const hash = useHash();
  const [newCount, setNewCount] = useState(0);
  const taskMatch = hash.match(/^#\/task\/([\w-]+)/);
  return (
    <div className="shell">
      <Sidebar hash={hash} newCount={newCount} />
      <main className="main">
        {taskMatch ? <Task key={taskMatch[1]} id={taskMatch[1]} /> :
          hash.startsWith('#/skills') ? <Skills initial={hash.split('/')[2]} /> :
          hash.startsWith('#/connectors') ? <Connectors /> :
          <Inbox onCount={setNewCount} />}
      </main>
      <Toast />
    </div>
  );
}
