import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { config } from './config.ts';
import { initConnectors, startScheduler } from './connectors/index.ts';
import { migrateSkills, seedSkills } from './skills.ts';

seedSkills();
migrateSkills();
initConnectors();

serve({ fetch: createApp().fetch, port: config.port, hostname: '127.0.0.1' }, (info) => {
  console.log(`unchore running on http://localhost:${info.port}  (data: ${config.home})`);
  startScheduler();
});
