> **Note:** this is the original design draft. What was actually built (Inbox-first, Claude Code headless, uazapi, MCP, Claude in Chrome) is described in the [README](../README.md).

# Unchore — Design Doc (v0, draft)

> An open-source, self-hostable "chief of staff": it pulls the asks hidden in your
> Gmail, Slack, WhatsApp and Telegram into one task board, and lets you hand any
> task to an AI agent — with you approving what goes out.

Status: **draft for discussion** · Working name: `unchore` (rename freely)

---

## 1. Problem

Work arrives as messages scattered across channels. Turning "can you send me the Q3
numbers?" into a tracked task is manual, and doing the task is often mechanical work an
AI could draft. Existing tools either track tasks (Todoist, Linear) *or* run agents
(Claude, ChatGPT), but nothing connects **inbound messages → tasks → AI execution →
reviewed reply** in one loop that you own.

## 2. Goals / non-goals

**Goals (v1)**
- Ingest messages from pluggable **connectors** and extract **tasks** from them.
- Show tasks on a board: **Open → In progress → Done**.
- **Delegate** a task to a pluggable **AI agent**; review its output before anything is sent.
- **Skills**: reusable per-task-type instructions that improve from your feedback.
- Self-hostable with one `docker compose up`; your data and tokens stay on your machine.

**Non-goals (v1)**
- Multi-tenant SaaS / team accounts.
- Fully autonomous sending without approval (may come later, opt-in per skill).
- Building our own LLM or agent framework.

## 3. Design principles

1. **Human in the loop by default.** Agents draft; humans approve outbound actions.
   Incoming messages are *untrusted input* (prompt injection is a real risk when an
   email can instruct your agent).
2. **Everything is a plugin.** Connectors and agents implement small, documented
   interfaces so the community can add Discord, Jira, Outlook, Ollama, etc.
3. **Lean on MCP.** Many services already have MCP servers. A connector can wrap an
   MCP server instead of re-implementing an API; agents get tools via MCP.
4. **Local-first.** SQLite by default, secrets encrypted at rest, no telemetry.
5. **Traceability.** Every task links back to its source message; every agent run
   keeps a full log.

## 4. Core concepts

```
Connector ──syncs──▶ Signal ──extracted into──▶ Task ──delegated to──▶ Agent
 (Gmail)            (a message)                (Open/In prog/Done)     │
                                                    ▲                  ▼
                                                    └──approve/reject── Run ──uses── Skill
                                                                        │
                                                         Action (e.g. send reply) via Connector
```

| Concept | What it is |
|---|---|
| **Connector** | Plugin that reads from a source (and optionally writes back: reply, react, mark read). |
| **Signal** | A raw inbound item (email, Slack message, chat) — normalized, deduplicated. |
| **Task** | A unit of work extracted from one or more signals. Has status, priority, due date, requester, source links. |
| **Person** | Contacts + org context (role, relationship) used to rank urgency ("my manager" > "newsletter"). |
| **Agent** | Plugin that executes work: Claude, OpenAI, Ollama, Claude Code, a custom webhook… |
| **Skill** | Named instructions + examples for a type of task ("weekly report", "schedule a meeting"). Agents load the matching skill; your feedback updates it. |
| **Run** | One attempt by an agent at a task: log, output, proposed actions, review state. |
| **Action** | A side effect proposed by a run (send email, post Slack reply, create calendar event). Executed only after approval. |

## 5. Main flows

### 5.1 Ingest → triage
1. Connector syncs on a schedule (or webhook) and stores new **Signals**.
2. An **extractor** (LLM call with a small, cheap model) decides: is this an ask?
   If yes → creates a *suggested* task with title, requester, due date, urgency, and
   links to the signal. Related messages (same thread) attach to the existing task.
3. Suggested tasks land in the **Inbox**. You accept (→ Open), edit, or dismiss.
   Dismissals are feedback for the extractor (later: per-sender rules).

### 5.2 Delegate → review → done
1. On a task, click **Delegate** → choose agent (+ skill, auto-suggested).
2. Task → *In progress*; a **Run** starts with: task, source thread, skill, allowed tools.
3. Run finishes in **Needs review** with output + proposed **Actions**.
4. You **Approve** (actions execute via the connector, task → Done),
   **Request changes** (feedback goes back to the agent *and* is offered as a skill update),
   or **Take over** (task stays yours).

### 5.3 Feedback → better skills
When you request changes, the app proposes a diff to the skill
("Always CC finance on budget replies"). You accept the diff → future runs improve.
This is the "self-improving chief of staff" loop from the original idea, but explicit
and reviewable.

## 6. Task states

```
            ┌──────── dismiss ───────▶ (archived)
Suggested ──┤
            └─ accept ─▶ Open ──start/delegate──▶ In progress ──done──▶ Done
                          ▲                          │
                          └──── reject / take over ──┘
```
Run sub-states (shown as a badge on In-progress tasks):
`queued → running → needs_review → approved | changes_requested | failed`

## 7. Plugin interfaces (sketch, TypeScript)

```ts
interface Connector {
  id: string;                         // "gmail"
  auth: OAuthConfig | TokenConfig | QrPairing;
  sync(cursor?: string): Promise<{ signals: Signal[]; cursor: string }>;
  actions?: ActionDefinition[];       // e.g. "reply", "react", "archive"
  execute?(action: Action): Promise<ActionResult>;
}

interface Agent {
  id: string;                         // "claude", "openai", "ollama", "webhook"
  configSchema: JSONSchema;           // api key, model, etc.
  run(input: RunInput, ctx: RunContext): AsyncIterable<RunEvent>; // streamed log
}

type RunInput = {
  task: Task; thread: Signal[]; skill?: Skill;
  tools: ToolDefinition[];            // read-only tools + "propose_action"
};
```

Agents never call outbound APIs directly; they call `propose_action`, which the app
holds until approval. This is the core safety guarantee.

## 8. Architecture

```
┌─────────────┐     ┌────────────────────────── server ───────────────────────────┐
│  Web UI     │◀───▶│ API (REST + SSE)                                            │
│  (React)    │     │   ├─ Task service      ├─ Skill service                     │
└─────────────┘     │   ├─ Connector runtime ├─ Agent runtime (runs, tools, MCP)   │
                    │   └─ Scheduler / job queue                                  │
                    │                 │                                           │
                    │           SQLite / Postgres  ·  encrypted secret store      │
                    └─────────────────────────────────────────────────────────────┘
                          │ connectors (in-process plugins or MCP servers)
                    Gmail · Slack · Telegram · WhatsApp · …
```

Proposed stack (open to discussion):
- **TypeScript monorepo** (pnpm + Turborepo): `apps/web`, `apps/server`, `packages/sdk`,
  `packages/connectors/*`, `packages/agents/*`.
- **Server:** Node + Hono or Fastify; Drizzle ORM; SQLite default, Postgres optional.
- **Jobs:** in-process queue for SQLite mode (e.g. a DB-backed queue), BullMQ when Postgres+Redis.
- **Web:** React + Vite + Tailwind; SSE for live run logs.
- **Deploy:** single Docker image + `docker-compose.yml`.

Why TypeScript: one language across UI/server/plugins lowers the bar for contributors,
and the MCP + major LLM SDKs are first-class in TS.

## 9. Connector reality check

These constraints shape the design and should be in the README so users aren't surprised.

| Source | How | Caveats |
|---|---|---|
| **Gmail** | Gmail API, OAuth, `history` for incremental sync, push via Pub/Sub optional | Gmail read scopes are "restricted": a *public* hosted app needs Google's security assessment. Self-hosters create their own OAuth client → no review needed. Another reason to be self-host first. |
| **Slack** | Slack app with user token; Events API or polling `conversations.history` | Each user installs an app in their workspace; some orgs block custom apps. |
| **Telegram** | Bot API (only sees messages sent to the bot) **or** MTProto user client (TDLib/GramJS) to read your own chats | User-client is the useful mode; requires phone login + `api_id`. |
| **WhatsApp** | Official Cloud API (Business numbers only) **or** unofficial WhatsApp Web libraries (Baileys) | Personal accounts have no official API; unofficial libs violate WhatsApp ToS and risk bans. Ship as an opt-in community connector with a clear warning. |

## 10. Security & privacy

- Secrets (OAuth tokens, API keys) encrypted with a key from env, never logged.
- Least-privilege scopes; read-only by default, write scopes requested only when the
  user enables an action.
- Message content passed to agents is wrapped as untrusted data; agents can't execute
  outbound actions without approval; per-agent tool allowlists.
- Audit log of every action executed.
- Clear notice: using cloud LLMs sends message content to that provider; Ollama option
  for fully local. Users are responsible for their employer's data policies.

## 11. UI (screens)

```
┌───────────────┬──────────────────────────────────────────────────────────────┐
│ ▣ Inbox   (7) │  Open (12)          In progress (3)         Done (today 5)   │
│ ▤ Board       │ ┌────────────────┐ ┌────────────────────┐ ┌────────────────┐ │
│ ⚡ Agents      │ │ Send Q3 numbers│ │ Draft offsite plan │ │ Reply to Ana   │ │
│ ✎ Skills      │ │ ✉ Gmail · Ana  │ │ # Slack · Bruno    │ │ ✓ approved     │ │
│ ⛓ Connectors  │ │ due Fri · high │ │ 🤖 Claude · review │ │                │ │
│ ⚙ Settings    │ └────────────────┘ └────────────────────┘ └────────────────┘ │
└───────────────┴──────────────────────────────────────────────────────────────┘
```

1. **Inbox** — suggested tasks; accept / edit / dismiss with keyboard shortcuts.
2. **Board** — Kanban with filters (source, person, priority, assignee human/agent).
3. **Task detail** — source thread on the left; on the right: details, Delegate button,
   live run log, proposed actions with Approve / Request changes.
4. **Connectors** — catalog, connect/disconnect, sync status, last error.
5. **Agents** — configured agents, models, keys, default skill mapping, cost per run.
6. **Skills** — list/edit skills, version history, pending suggested diffs.
7. **People** — contacts and org context used for urgency.

## 12. Data model (first cut)

```
connector_account(id, connector_id, name, encrypted_credentials, cursor, status)
signal(id, account_id, external_id, thread_id, sender_person_id, body, received_at, url)
person(id, name, handles jsonb, org_role, priority_weight)
task(id, title, description, status, priority, due_at, requester_person_id,
     assignee_type[human|agent], agent_id, skill_id, created_at, done_at)
task_signal(task_id, signal_id)
agent(id, adapter, name, encrypted_config)
skill(id, name, instructions, version, match_hints)
skill_revision(id, skill_id, diff, source_run_id, accepted_at)
run(id, task_id, agent_id, skill_version, status, log, output, cost, started_at, ended_at)
action(id, run_id, connector_account_id, type, payload, status, executed_at)
audit_event(id, at, actor, kind, ref)
```

## 13. Milestones

| # | Scope | Outcome |
|---|---|---|
| **M0** | Repo, monorepo skeleton, plugin SDK, CI, CONTRIBUTING | Contributors can start |
| **M1** | Manual tasks + board UI + Gmail connector (read) + extractor + Inbox | "My email becomes a task list" |
| **M2** | Agent runtime + Claude & OpenAI adapters + review/approve + Gmail reply action | "AI drafts replies I approve" |
| **M3** | Skills + feedback→skill diffs + People/urgency | "It gets better over time" |
| **M4** | Slack + Telegram connectors, Ollama adapter, MCP-backed connectors | Multi-channel, fully local option |
| **M5** | WhatsApp community connector, notifications/digest, mobile-friendly UI | — |

## 14. Open questions

1. Self-host only, or also a hosted version later? (Affects auth, Gmail verification, license.)
2. License: **AGPL-3.0** (protects against closed SaaS forks) vs **MIT/Apache-2.0** (max adoption)?
3. Should tasks also be created *without* a source (manual tasks), and sync to Todoist/Linear?
4. Agents with real tool access (browser, code, files) — v1 or later?
5. Autonomous mode: allow per-skill auto-approve for low-risk actions (e.g. "acknowledge receipt")?
6. Product name.
