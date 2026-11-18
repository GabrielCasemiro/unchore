import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { askAgent, chatHistory, clearChat, rescan } from './agent.ts';
import { config } from './config.ts';
import { connectors, connectorState, syncConnector, updateConnector } from './connectors/index.ts';
import type { SourceId } from './connectors/types.ts';
import { all } from './db.ts';
import { exportSkill, getSkill, installSkill, listLibrary, listSkills, saveSkill, skillHistory } from './skills.ts';
import {
  acceptTask, approveTask, dismissTask, getTask, getThread, listTasks, markDone, planTask,
  reopenTask, requestChanges, resolveTaskId, takeOver, taskEvents, undoDismiss, type TakeoverTool,
} from './tasks.ts';

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createApp() {
  const app = new Hono();

  app.onError((err, c) => c.json({ error: errorMessage(err) }, 400));

  // Only accept requests from this machine's own pages (blocks other sites from calling the API).
  app.use('/api/*', async (c, next) => {
    const origin = c.req.header('origin');
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return c.json({ error: 'Forbidden origin' }, 403);
    await next();
  });

  app.get('/api/health', (c) => c.json({ ok: true }));

  // Tasks
  app.get('/api/tasks', (c) => c.json(listTasks(c.req.query('done') === '1')));
  app.get('/api/tasks/:id', (c) => {
    const task = getTask(resolveTaskId(c.req.param('id')));
    if (!task) return c.json({ error: 'Not found' }, 404);
    return c.json({ task, thread: getThread(task), events: taskEvents(task.id) });
  });
  app.post('/api/tasks/:id/accept', (c) => {
    acceptTask(resolveTaskId(c.req.param('id')));
    return c.json({ ok: true });
  });
  app.post('/api/tasks/:id/plan', (c) => {
    void planTask(resolveTaskId(c.req.param('id')));
    return c.json({ ok: true });
  });
  app.post('/api/tasks/:id/dismiss', async (c) => {
    const { reason, note } = await c.req.json<{ reason: string; note?: string }>();
    return c.json(await dismissTask(resolveTaskId(c.req.param('id')), reason, note));
  });
  app.post('/api/tasks/:id/undo-dismiss', async (c) => {
    const { previousBody } = await c.req.json<{ previousBody: string | null }>();
    undoDismiss(resolveTaskId(c.req.param('id')), previousBody);
    return c.json({ ok: true });
  });
  app.post('/api/tasks/:id/approve', async (c) => {
    const body = await c.req.json<{ sendReply: boolean; reply?: string }>();
    return c.json(await approveTask(resolveTaskId(c.req.param('id')), body));
  });
  app.post('/api/tasks/:id/changes', async (c) => {
    const { feedback, updateSkill } = await c.req.json<{ feedback: string; updateSkill: boolean }>();
    return c.json(requestChanges(resolveTaskId(c.req.param('id')), feedback, updateSkill));
  });
  app.post('/api/tasks/:id/takeover', async (c) => {
    const { tool } = await c.req.json<{ tool: TakeoverTool }>();
    return c.json(takeOver(resolveTaskId(c.req.param('id')), tool));
  });
  app.post('/api/tasks/:id/reopen', (c) => {
    reopenTask(resolveTaskId(c.req.param('id')));
    return c.json({ ok: true });
  });
  app.post('/api/tasks/:id/done', async (c) => {
    const body = await c.req.json<{ note?: string }>().catch(() => ({ note: undefined }));
    markDone(resolveTaskId(c.req.param('id')), body.note);
    return c.json({ ok: true });
  });

  // Skills
  app.get('/api/skills', (c) => c.json(listSkills()));
  app.get('/api/skills/:slug', (c) => {
    const skill = getSkill(c.req.param('slug'));
    if (!skill) return c.json({ error: 'Not found' }, 404);
    const recent = all<{ uid: string; title: string; status: string }>(
      `SELECT uid, title, status FROM tasks WHERE plan LIKE ? ORDER BY updated_at DESC LIMIT 5`,
      `%"skill_slug":"${skill.slug}"%`,
    );
    return c.json({ skill, history: skillHistory(skill.slug), recent });
  });
  app.put('/api/skills/:slug', async (c) => {
    const body = await c.req.json<{ name: string; when: string; body: string }>();
    return c.json(saveSkill(c.req.param('slug'), body));
  });
  app.get('/api/skills/:slug/export', (c) => c.json(exportSkill(c.req.param('slug'))));
  app.get('/api/library', (c) => c.json(listLibrary()));
  app.post('/api/library/:slug/install', (c) => c.json(installSkill(c.req.param('slug'))));

  // Connectors
  app.get('/api/connectors', (c) => c.json(connectorState()));
  app.patch('/api/connectors/:id', async (c) => {
    const id = c.req.param('id') as SourceId;
    if (!connectors[id]) return c.json({ error: 'Unknown connector' }, 404);
    updateConnector(id, await c.req.json());
    return c.json(connectorState());
  });
  app.post('/api/connectors/:id/sync', async (c) => {
    const id = c.req.param('id') as SourceId;
    if (!connectors[id]) return c.json({ error: 'Unknown connector' }, 404);
    return c.json(await syncConnector(id));
  });

  // Inbox agent
  app.get('/api/agent', (c) => c.json(chatHistory()));
  app.post('/api/agent', async (c) => {
    const { message, taskId } = await c.req.json<{ message: string; taskId?: string }>();
    return c.json(await askAgent(message, taskId ? resolveTaskId(taskId) : undefined));
  });
  app.delete('/api/agent', (c) => {
    clearChat();
    return c.json([]);
  });
  app.post('/api/rescan', async (c) => c.json(await rescan()));

  // Built web app
  const dist = join(config.root, 'web', 'dist');
  app.get('*', (c) => {
    const path = c.req.path === '/' ? '/index.html' : c.req.path;
    const file = join(dist, path);
    if (file.startsWith(dist) && existsSync(file) && !file.endsWith('/')) {
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
      return c.body(readFileSync(file), 200, { 'content-type': type });
    }
    const index = join(dist, 'index.html');
    if (existsSync(index)) return c.html(readFileSync(index, 'utf8'));
    return c.text('Web app not built. Run `npm run build`, or use `npm run dev` and open http://localhost:5173', 404);
  });

  return app;
}
