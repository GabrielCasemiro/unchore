export type SourceId = 'whatsapp' | 'gmail' | 'slack' | 'linkedin' | 'calendar';
export type TaskStatus = 'suggested' | 'accepted' | 'planning' | 'plan_ready' | 'executing' | 'done' | 'dismissed' | 'taken_over';

export interface TaskListItem {
  id: number;
  uid: string;
  title: string;
  summary: string | null;
  source: SourceId;
  channel: string | null;
  requester: string | null;
  due: string | null;
  priority: 'high' | 'medium' | 'low';
  confidence: number | null;
  reason: string | null;
  status: TaskStatus;
  last_text: string | null;
  last_at: string | null;
  created_at: string;
  hasPlan: boolean;
}

export interface Plan {
  summary: string;
  steps: string[];
  draft: { title: string; body: string } | null;
  reply: string | null;
  skill_slug: string | null;
  needs_from_me: string | null;
}

export interface ThreadMessage {
  external_id: string;
  from_name: string;
  channel: string | null;
  subject: string | null;
  text: string;
  is_from_me: number;
  received_at: string;
  url: string | null;
}

export interface TaskDetail {
  task: Omit<TaskListItem, 'hasPlan' | 'last_text' | 'last_at'> & { plan: Plan | null; plan_error: string | null; thread_id: string };
  thread: ThreadMessage[];
  events: Array<{ kind: string; detail: Record<string, unknown> | null; created_at: string }>;
}

export interface Skill {
  slug: string;
  name: string;
  when: string;
  system: boolean;
  body: string;
  version: number;
  updatedAt: string | null;
  file: string;
}

export interface LibrarySkill {
  slug: string;
  name: string;
  when: string;
  author: string;
  body: string;
  installed: boolean;
}

export interface ConnectorInfo {
  id: SourceId;
  name: string;
  how: string;
  enabled: boolean;
  intervalMin: number;
  lastSync: string | null;
  lastError: string | null;
  lastCount: number | null;
  settings: Record<string, unknown>;
  syncing: boolean;
  ready: boolean;
  notReadyReason: string | null;
  mcpServer: string | null;
}

export interface ChatMessage {
  id: number;
  role: 'user' | 'agent';
  text: string;
  rule: string | null;
  created_at: string;
}

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

export const api = {
  tasks: (done: boolean) => request<TaskListItem[]>(`/tasks${done ? '?done=1' : ''}`),
  task: (ref: string) => request<TaskDetail>(`/tasks/${ref}`),
  accept: (ref: string) => request(`/tasks/${ref}/accept`, 'POST'),
  replan: (ref: string) => request(`/tasks/${ref}/plan`, 'POST'),
  dismiss: (ref: string, reason: string, note?: string) =>
    request<{ rule: string | null; version: number | null; previousBody: string | null }>(`/tasks/${ref}/dismiss`, 'POST', { reason, note }),
  undoDismiss: (ref: string, previousBody: string | null) => request(`/tasks/${ref}/undo-dismiss`, 'POST', { previousBody }),
  approve: (ref: string, sendReply: boolean, reply?: string) => request<{ detail: string }>(`/tasks/${ref}/approve`, 'POST', { sendReply, reply }),
  changes: (ref: string, feedback: string, updateSkill: boolean) => request<{ skill: string | null }>(`/tasks/${ref}/changes`, 'POST', { feedback, updateSkill }),
  takeover: (ref: string, tool: string) =>
    request<{ file: string; command: string | null; markdown: string; openUrl: string | null }>(`/tasks/${ref}/takeover`, 'POST', { tool }),
  done: (ref: string) => request(`/tasks/${ref}/done`, 'POST', {}),
  reopen: (ref: string) => request(`/tasks/${ref}/reopen`, 'POST'),
  skills: () => request<Skill[]>('/skills'),
  skill: (slug: string) =>
    request<{ skill: Skill; history: Array<{ version: number; note: string; created_at: string }>; recent: Array<{ uid: string; title: string; status: string }> }>(`/skills/${slug}`),
  saveSkill: (slug: string, body: { name: string; when: string; body: string }) => request<Skill>(`/skills/${slug}`, 'PUT', body),
  exportSkill: (slug: string) => request<{ file: string; markdown: string }>(`/skills/${slug}/export`),
  library: () => request<LibrarySkill[]>('/library'),
  installSkill: (slug: string) => request<Skill>(`/library/${slug}/install`, 'POST'),
  connectors: () => request<ConnectorInfo[]>('/connectors'),
  updateConnector: (id: SourceId, patch: Partial<{ enabled: boolean; intervalMin: number; settings: Record<string, unknown> }>) =>
    request<ConnectorInfo[]>(`/connectors/${id}`, 'PATCH', patch),
  sync: (id: SourceId) => request<{ added: number }>(`/connectors/${id}/sync`, 'POST'),
  chat: () => request<ChatMessage[]>('/agent'),
  ask: (message: string, taskId?: string) => request<ChatMessage[]>('/agent', 'POST', { message, taskId }),
  clearChat: () => request<ChatMessage[]>('/agent', 'DELETE'),
};

export const timeAgo = (iso: string | null) => {
  if (!iso) return '';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < -60) {
    // Upcoming (calendar events): show when, not "ago".
    return new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (s < 7 * 86400) return new Date(iso).toLocaleDateString([], { weekday: 'short' });
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });
};

export const SOURCE_NAMES: Record<SourceId, string> = { whatsapp: 'WhatsApp', gmail: 'Gmail', slack: 'Slack', linkedin: 'LinkedIn', calendar: 'Calendar' };
