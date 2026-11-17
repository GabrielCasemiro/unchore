# Security

Unchore reads your email, chats and calendar and can send replies for you, so security problems
matter a lot here. Thanks for reporting them responsibly.

## Reporting a problem

Please **don't open a public issue**. Report it privately on GitHub instead:

**[Report a vulnerability](https://github.com/GabrielCasemiro/unchore/security/advisories/new)**

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get a
first answer within a few days. Once it's fixed, you'll be credited in the advisory unless you'd
rather not be.

## What's in scope

These are the problems we care about most:

- **Prompt injection that escapes the sandbox.** A message that makes Claude use a tool it
  shouldn't have, read something outside its source, or send a reply without the user's approval.
- **Sending without approval.** Any way a reply, draft or action goes out before the user clicks
  Approve.
- **Access from outside the computer.** The server should only accept requests from
  `127.0.0.1` and from the Unchore web app itself. Requests from other websites must be rejected.
- **Leaking data or secrets.** Messages, `.env` values or tokens ending up somewhere they shouldn't,
  such as logs, `TASK.md` files shared on take-over, or error messages.

Out of scope: problems that need someone who already controls your computer, issues in Claude
Code, the claude.ai connectors or uazapi themselves (please report those to their makers), and the
known limitations listed in the README.

## Supported versions

Only the latest version on the `main` branch gets security fixes.
