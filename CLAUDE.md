# CLAUDE.md

Unchore turns the requests hidden in someone's messages (Gmail, Calendar, Slack, WhatsApp, LinkedIn…)
into an Inbox of tasks, plans each one with Claude, and sends the reply only after the user approves.
It's a local Node app: a Hono server on `127.0.0.1:4477`, a React UI, SQLite and Markdown files in
`~/unchore/`. Every AI step runs `claude -p` on the user's own Claude Code subscription.

People open this repo in Claude Code for two reasons: to **install and set up Unchore for
themselves**, or to **work on the code**. Figure out which one before you start.

## Commands

```sh
npm install
npm run build        # builds the web UI into web/dist (needed for npm start)
npm start            # server + built UI on http://localhost:4477
npm run dev          # API on :4477, UI with hot reload on :5173
npm test             # end-to-end flow with a fake Claude CLI and a fake uazapi server
npm run typecheck
npx unchore done <task-id> --note "…"   # mark a task done (server must be running)
npx unchore sync <connector>            # run one sync now
```

## Helping someone install Unchore

Go step by step and check each one before moving on. Explain what you're doing in plain words;
the person may not be a developer.

1. **Check requirements.** `node --version` must be 22.13 or newer (Unchore uses `node:sqlite`).
   `claude --version` must work. macOS is the supported platform; on Linux everything works except
   opening Terminal on take-over and the start-at-login script.
2. **Install and build:** `npm install && npm run build`.
3. **Ask which sources they want.** Don't set up all of them by default. For each one:
   - **Gmail, Google Calendar, Slack:** they connect these on claude.ai (Settings → Connectors).
     Then run `claude mcp list` and confirm they show as connected (`claude.ai Gmail`, etc.). If the
     names differ, set `GMAIL_MCP_SERVER`, `SLACK_MCP_SERVER` or `CALENDAR_MCP_SERVER` in `.env`
     using the name with spaces and dots replaced by `_` (`claude.ai Gmail` → `claude_ai_Gmail`).
     Tell them the Gmail connector can only create drafts, so Gmail replies are saved as drafts.
   - **WhatsApp Business:** needs a uazapi instance. Copy `.env.example` to `.env` and ask them to
     paste `UAZAPI_URL` and `UAZAPI_TOKEN` themselves. Mention that uazapi is unofficial and can get
     a number banned.
   - **LinkedIn:** needs Chrome with the Claude in Chrome extension, logged in to LinkedIn. Mention
     that this goes against LinkedIn's terms and their account carries the risk.
   - The full guide with screenshots is `docs/connecting-sources.md`.
4. **Start it:** `npm start`, then open http://localhost:4477 → **Connectors**, switch on a source
   and press **Sync now**. The first Gmail sync reads the last 24 hours and takes a minute or two.
5. **Optional, ask first:** `./scripts/install-launchd.sh` keeps Unchore running at login
   (`uninstall` removes it). Logs go to `~/unchore/server.log`.
6. **Suggest sync intervals of 15–30 minutes** for Gmail, Slack and Calendar. Each sync is one
   Claude run and short intervals use up session and weekly limits.

Other settings in `.env`: `UNCHORE_HOME` (data folder, default `~/unchore`), `PORT` (default 4477),
`UNCHORE_MODEL` (default `sonnet`), `CLAUDE_BIN`, `UNCHORE_DEBUG=1` (log every Claude run).

Never print, log or commit `.env` values. Let the person type tokens themselves.

## Skills

Skills tell Claude how this person wants things done. There are two places:

- **The person's skills** live in `~/unchore/skills/<slug>.md` (or `$UNCHORE_HOME/skills/`). They
  are private and never go into the repo. This is what the app reads and edits.
- **The library** is the repo's [`skills/`](skills/) folder: public, made-up-data skills anyone can
  install from the Skills page (or `POST /api/library/<slug>/install`). Installing copies the file
  into the person's folder; it never overwrites one they already have. Library files marked
  `starter: true` are installed on first run.

Each skill is Markdown with a small header:

```markdown
---
name: Writing replies
when: Any task answered with a message
system: false
---
# Writing replies

- Reply in the same language the person wrote in
- Answer the question first, then details
```

- **`what-counts-as-a-task`** is the only `system: true` skill. Extraction uses it on every new
  message to decide what becomes a task, its priority, and which calendar events count. Don't
  rename it or delete it.
- **Every other skill is a work skill.** All of them go into the planning prompt, and Claude picks
  the ones whose `when` matches the task. So `when` should say plainly when the skill applies
  ("Messages from clients on WhatsApp", "Invoices and payments").
- **Slugs** are lowercase letters, digits and dashes (`client-replies`).
- **`## Learned from feedback`** sections are written by Unchore when the user dismisses a task or
  requests changes. Keep them unless the user asks to clean them up.

When someone asks you to create or change a skill:

1. Ask what the skill is for and when it should apply. Write rules as short, concrete bullets in the
   user's words. Facts Claude must never invent (prices, links, dates) should say so explicitly.
2. If the server is running, save through the API so the change gets a version in the history:
   ```sh
   curl -s -X PUT http://127.0.0.1:4477/api/skills/<slug> \
     -H 'content-type: application/json' \
     -d '{"name":"…","when":"…","body":"# …\n\n- …\n"}'
   ```
   Editing the `.md` file directly also works (it's read on every run), but skips the version
   history. The **Skills** page in the app does the same as the API.
3. Never put secrets or someone else's private data in a skill.

When someone wants to share a skill, use **Export** on the Skills page (or
`GET /api/skills/<slug>/export`). It drops the `## Learned from feedback` section, which usually
names real people. Read the result with them before it goes anywhere, and only add it to the repo's
`skills/` folder when it is generic and public.

## Code map

```
server/
  index.ts          starts the server and the sync scheduler
  app.ts            HTTP API; rejects requests whose Origin isn't localhost
  config.ts         .env and paths
  db.ts             SQLite schema and helpers (signals, tasks, decisions, events, skill_versions…)
  claude.ts         runClaude(): `claude -p` with a JSON schema and only the tools a step gets
  extractor.ts      decides which new messages are tasks (system skill)
  tasks.ts          plan, approve and send, request changes, take over (TASK.md), done
  agent.ts          the Inbox agent chat
  skills.ts         skills as files + version history
  connectors/       whatsapp.ts (uazapi API), claudeSources.ts (Gmail/Slack/LinkedIn via Claude),
                    calendar.ts, index.ts (registry and scheduler), types.ts (Connector interface)
web/src/            React UI: pages/Inbox, Task, Skills, Connectors
skills/             public skill library (starter skills + ones to install)
bin/unchore.ts      CLI used from take-over sessions
test/               flow.test.ts + fake-claude.mjs
```

Adding a connector is described in `CONTRIBUTING.md`. The source id also has to be added to
`SourceId` in `web/src/api.ts`.

## Rules that must not break

- **Message content is untrusted input.** Extraction, planning, the rule writer and the Inbox
  agent run with no tools at all. A sync or reply run gets only that one source's MCP server (or
  Chrome for LinkedIn). Never widen this; never pass message text into a run that has tools it
  doesn't need.
- **Nothing is sent without the user's Approve.** Replies with `[placeholders]` can't be sent.
- **Claude never invents facts** in plans and replies; unknowns become `[placeholders]` and go in
  `needs_from_me`.
- **The server listens on 127.0.0.1 only.**
- **No real data in the repo.** Tests, fixtures, screenshots and examples use made-up names,
  messages, emails and phone numbers. Never copy anything from `~/unchore/` into the repo.

## Working on the code

- Run `npm run typecheck` and `npm test` before you finish. Tests use `test/fake-claude.mjs`, which
  picks a canned answer from the JSON schema it receives; extend it when you add a new kind of
  Claude call.
- To try changes without touching the user's real data, run on a separate folder and port:
  `UNCHORE_HOME=/tmp/unchore-dev PORT=4488 npm run dev`. Set `UNCHORE_NO_SCHEDULER=1` to stop
  background syncs and `CLAUDE_BIN=test/fake-claude.mjs` to avoid real Claude calls.
- Match the surrounding code: small functions, few comments, TypeScript run directly with `tsx`,
  no new dependencies without a good reason.
- UI copy is short and plain, written from the user's side ("Sync now", "Not a task").
- Keep the README (English) and `README.pt-BR.md` in sync when behavior changes.
