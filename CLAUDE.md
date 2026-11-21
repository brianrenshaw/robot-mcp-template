# CLAUDE.md

Notes for the AI session that changes this project. Read all of it before changing anything.
The person you are working for may not read code. Favor clarity and easy repair over
cleverness, and explain what you did in plain words.

## What this is

A starter for a personal MCP server: one Cloudflare Worker with one D1 database, used by one
person through their chatbot. The example data is notes. Your first job is usually to replace
notes with what the person actually wants to keep track of. Ask them what that is and what
they want to say to their chatbot before you design anything.

## How it is put together

- `src/index.ts` is the front door. `/mcp` is a stateless MCP server (Streamable HTTP,
  `createMcpHandler` from `agents/mcp/server` with `@modelcontextprotocol/server` v2, no
  Durable Objects). Two kinds of credential get in, both handled by
  `@cloudflare/workers-oauth-provider`:
  1. **OAuth**, for chat apps. The app discovers the server, registers itself at
     `/oauth/register`, and sends the person to `/authorize`.
  2. **`Authorization: Bearer <MCP_TOKEN>`**, for Claude Code and scripts
     (`resolveExternalToken`). Compared in constant time.
  Anything else gets 401.
- `src/authorize.ts` is the consent page (Allow / Deny). `/authorize` is the only path behind
  Cloudflare Access, and `src/access.ts` verifies the Access token again and checks the email
  against `OWNER_EMAIL`. If anything is missing it refuses. It never falls back to open.
- `src/kv.ts` gives the OAuth library the `oauth_kv` table in place of a KV namespace.
- `src/db.ts` holds every SQL query. `src/tools.ts` holds the tools and the instructions.

You should rarely need to change `index.ts`, `authorize.ts`, `access.ts` or `kv.ts`. If you
do, run `npm run smoke:oauth` afterwards.

## Rules

1. **Never edit a migration that has been applied.** Add `migrations/000N_description.sql`.
2. **Never hard delete.** Give rows a `deleted_at` (or `archived_at`) and filter on it.
3. **All SQL stays in `src/db.ts`.** Tools call functions; they do not write queries.
4. **Writes never guess.** A name that fits more than one record throws `AmbiguousError` with
   the candidates (see `requireNote`), and the chatbot asks the person which one.
5. **Keep the tools few and their descriptions exact.** Before adding a tool, see whether an
   existing one can answer with one more input. Each description says when to use the tool,
   using the words the person would say.
6. **Keep within the limits.** `INSTRUCTIONS` under 4,000 characters and every tool
   description under 2,000 (`INSTRUCTIONS_LIMIT`, `DESCRIPTION_LIMIT` in `tools.ts`). Chat apps
   cut longer text silently. `npm run smoke` fails when either is passed.
7. **A routine's rules go in a tool's result, not in `INSTRUCTIONS`.** Return them as `how_to`
   from the tool the routine starts with (see `TIDY_GUIDE`), say so in that tool's
   description, and add one line to `INSTRUCTIONS` naming the tool.
8. **Every write returns a `receipt`**: one plain line saying what was done.
9. **Record who wrote it.** Pass `actor` (`mcp:<client>`) through to anything that writes.
10. **Secrets are never committed, logged or returned.** `MCP_TOKEN` and `OWNER_EMAIL` are set
    with `wrangler secret put`. `.dev.vars` is for local values only and is git-ignored.
11. **Do not weaken sign-in.** No open fallback, no skipping the Access check outside local
    development, no putting the whole Worker behind Access (chat apps reach `/mcp` without a
    browser).

## Where each kind of change goes

| Change | Files |
| --- | --- |
| A new kind of thing to keep (a table) | a new migration; types and queries in `src/db.ts`; tools in `src/tools.ts` |
| A new field | a new migration; `src/db.ts`; the tool's `inputSchema` and its brief in `src/tools.ts` |
| What the chatbot can do | a tool in `src/tools.ts`; a check for it in `scripts/smoke.ts` |
| What every chat is told | `INSTRUCTIONS` in `src/tools.ts` |
| The rules for one routine | a guide constant in `src/tools.ts`, returned as `how_to` |
| The name chat apps show | `SERVER_NAME` in `src/index.ts`; `WHAT_IT_IS` in `src/authorize.ts` |
| Who may sign in | the `OWNER_EMAIL` secret, and the policy on the Access application |

## Checking your work

```bash
npm run typecheck
```

```bash
npm run migrate:local
```

```bash
npm run dev
```

Then, in another terminal, both of these should print only `PASS`:

```bash
npm run smoke
```

```bash
npm run smoke:oauth
```

Local development needs `.dev.vars` (copy `.dev.vars.example`). With `ENVIRONMENT=local` the
Access check is skipped, and only for requests to localhost.

Update `scripts/smoke.ts` when you replace the notes tools: it calls them by name.

## Things to know

- **Chat apps cache a server's tools and instructions.** After a deploy, the person starts a
  new chat to see changes.
- **Writes are not transactional.** D1 has no BEGIN/COMMIT from a Worker. Keep each write to
  one statement where you can.
- **Add the connector on the claude.ai website.** The desktop app's dialog has failed where
  the website worked.
- **`PUBLIC_URL` must match the deployed address exactly**, or sign-in fails.
- **OAuth records live in `oauth_kv`** (tokens only as hashes). Emptying the table signs every
  chat app out.
- **Rolling back code does not roll back the database.** Migrations only move forward.
