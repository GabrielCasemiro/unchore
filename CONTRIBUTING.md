# Contributing to Unchore

Thanks for helping! Unchore is small and young, so there's a lot of room to shape it. This page
covers how to get it running, what kind of help is most useful, and what a good pull request looks
like.

## Good places to start

- **Skills for the library.** See [Sharing a skill](#sharing-a-skill).
- **New connectors.** Outlook, Telegram, Discord, Notion, Linear… Anything Claude can reach through
  an MCP server, an API or the browser. See [Adding a connector](#adding-a-connector).
- **Other AI providers.** Triage and planning only need text in and JSON out, so they could run on
  OpenAI-compatible APIs, Gemini or local models. Open an issue first so we agree on the design.
- **Linux support.** Everything except "open in Terminal" and the start-at-login script should
  work. Testing it and fixing what breaks is very welcome.
- **Issues labeled [`good first issue`](https://github.com/GabrielCasemiro/unchore/labels/good%20first%20issue).**

For anything bigger than a bug fix, please open an issue before you start, so you don't spend time
on something that won't fit.

## Running it locally

You need Node.js 22.13 or newer. Claude Code is only needed to run the app against real sources;
the tests use a fake Claude CLI.

```sh
git clone https://github.com/GabrielCasemiro/unchore.git
cd unchore
npm install
npm run dev         # API on :4477, UI with hot reload on http://localhost:5173
```

To keep your own data out of the way while developing, point Unchore at a separate folder and
port:

```sh
UNCHORE_HOME=/tmp/unchore-dev PORT=4488 npm run dev
```

Before you open a pull request:

```sh
npm run typecheck
npm test            # end-to-end flow against a fake Claude CLI and a fake uazapi server
```

CI runs the same commands on every pull request.

## How the code is organized

```
server/
  index.ts            starts the server and the sync scheduler
  app.ts              HTTP API used by the web app
  claude.ts           runs `claude -p` with a JSON schema and only the tools a step needs
  extractor.ts        decides which messages are tasks
  tasks.ts            planning, approving, sending, take-over
  agent.ts            the Inbox agent
  skills.ts           skills as Markdown files with version history
  connectors/         one file per kind of source
web/src/              React app (Inbox, Task, Skills, Connectors pages)
skills/               the public skill library shown on the Skills page
test/                 end-to-end test and the fake Claude CLI
```

## Adding a connector

A connector implements the `Connector` interface in `server/connectors/types.ts`: `fetch` returns
new messages in a fixed shape, and `reply` sends an answer in the same conversation.

If the source has an MCP server, you usually don't need integration code. Copy one of the blocks
in `server/connectors/claudeSources.ts` (Slack is a good model) and write:

1. **Which MCP server** Claude may use, and nothing else.
2. **Read instructions**: where to look, what counts as new since the last sync, what to skip.
3. **Reply instructions**: how to answer in the same thread, or say that the source can only draft.

Then:

- add the id to `SourceId` in `server/connectors/types.ts` and in `web/src/api.ts` (with its display
  name in `SOURCE_NAMES`);
- register it in `server/connectors/index.ts`;
- add its icon in `web/src/icons.tsx`;
- document what users need in the README table.

## Sharing a skill

The [`skills/`](skills/) folder is the public library that shows up on the Skills page. To add one:

1. Write and use the skill in your own Unchore first, then press **Export**. The export leaves out
   the rules learned from your feedback.
2. Remove anything personal: names, clients, prices, links, phone numbers. A library skill should
   work for anyone.
3. Save it as `skills/<slug>.md` with this header, and open a pull request:

```markdown
---
name: Answering quote requests
when: Someone asks how much something costs or for a quote
author: your-github-username
---
# Answering quote requests

- Only use prices that appear in the thread; otherwise leave `[price]`
```

Good skills are short bullets, say plainly when they apply, and tell Claude what never to invent.

## Ground rules

- **Never use real data.** Screenshots, tests, fixtures and examples use made-up names, messages,
  emails and phone numbers (`example.com`, `5511999990000`). This includes your own inbox.
- **Message content is untrusted.** Anyone can send an email that tries to instruct the AI.
  Extraction gets no tools at all, planning only gets the read-only lookups a user wrote in their
  own skill, and a sync or reply run only gets that one source's tools. Don't widen this; if a
  feature seems to need it, open an issue first.
- **Nothing is sent without approval.** Features that act on the user's behalf must wait for an
  explicit click.
- **No secrets in the repo.** Credentials live in `.env`, which is gitignored.
- **Match the surrounding code.** Small, readable functions; comments only where the why isn't
  obvious; plain words in the UI.

## Pull requests

- Keep each pull request focused on one change.
- Describe what changed and how you tested it. For UI changes, add a screenshot (with made-up data).
- Pull requests are squash-merged, so the PR title becomes the commit message. Write it as a short
  sentence about the change, like "Add Outlook connector".

## License and CLA

Unchore is licensed under [AGPL-3.0](LICENSE).

Before your first pull request can be merged, you'll be asked to accept the
[Contributor License Agreement](CLA.md). A bot comments on the pull request; you reply with the
sentence it gives you, once, and it covers all your future contributions.

In short: you keep the copyright to your work, and you give the maintainer a license that also
allows using it under other terms, such as a commercial license. In return, everything you
contribute will always stay available as open source. This keeps the project able to fund itself
later without closing it.

## Questions

Open an issue. For security problems, please follow [SECURITY.md](SECURITY.md) instead.
