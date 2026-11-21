# Your own MCP server: a starter

An MCP server is what lets a chat app such as Claude read and change **your own data**: your
tasks, your recipes, your client list, your reading notes, whatever your project is about. You
talk to the chat app; it uses the server to look things up and write things down.

This is a small, working one to start from. Out of the box it keeps **notes**, so there is
something to try. You replace notes with your own thing.

What you get:

- A server that runs on Cloudflare (the free plan is enough to start) with its own database.
- Sign-in that only lets **you** in. Chat apps connect with a proper sign-in page; coding tools
  and scripts connect with a secret token.
- It works with Claude on the web, the phone and the desktop app, and with Claude Code.
- The habits that make a chatbot use a server well, already built in (see
  [What we learned](#what-we-learned)).

## The quickest way: hand it to an AI

You do not have to write code. Press **Use this template** at the top of this page to make
your own copy (choose Private if it will hold anything personal), open your copy in an AI
coding tool such as Claude Code, and say something like:

> Read CLAUDE.md first. This is a starter for an MCP server. I want mine to keep track of
> ______ (say what, in your own words, and what you want to ask your chatbot to do with it).
> Replace the notes example with that. Then walk me through the setup in the README one step
> at a time, doing every step you can do yourself.

`CLAUDE.md` tells the AI how the project is put together and which rules to keep. The steps
below are the same ones it will follow, so you can also do them by hand.

## What you need

- A [Cloudflare](https://dash.cloudflare.com/sign-up) account.
- [Node.js](https://nodejs.org) 22 or newer on your computer (or an AI coding tool that has it).
- A Claude plan that allows custom connectors, if you want to use it from the Claude app.

## Setup

Step 1 was run exactly as written. Steps 2 to 8 were written from a working setup of the same
design, not re-run on a brand-new Cloudflare account, so if Cloudflare's screens or commands
have changed since, go by Cloudflare's current documentation.

### 1. Get the code and try it on your computer

```bash
npm install
```

```bash
cp .dev.vars.example .dev.vars
```

```bash
npm run migrate:local
```

```bash
npm run dev
```

The server is now running at `http://localhost:8787`. In a second terminal, check it:

```bash
npm run smoke
```

```bash
npm run smoke:oauth
```

Every line should say `PASS`. The first checks the token route, the second the sign-in that
chat apps use. Nothing has left your computer yet.

### 2. Name it

In `wrangler.jsonc`, change `my-mcp-server` (the `name` and the `database_name`) to a name of
your own, in lowercase with dashes. In `src/index.ts`, change `SERVER_NAME` to what you want
chat apps to call it.

### 3. Create the database

```bash
npx wrangler login
```

```bash
npx wrangler d1 create my-mcp-server
```

Use your own name in place of `my-mcp-server`. The command prints a `database_id`. Put it in
`wrangler.jsonc` in place of `REPLACE-WITH-YOUR-DATABASE-ID`. If it offers to add the database
to your configuration for you, say no: it is already there. Then create the tables:

```bash
npm run migrate:remote
```

### 4. Deploy it once to learn its address

```bash
npm run deploy
```

It prints an address like `https://my-mcp-server.your-subdomain.workers.dev`. Put that address
in `wrangler.jsonc` as `PUBLIC_URL`, with no slash at the end. It has to be exact: chat apps
are told to sign in there.

### 5. Set the two secrets

A long random token, for Claude Code and scripts. Make one:

```bash
openssl rand -hex 32
```

Save it:

```bash
npx wrangler secret put MCP_TOKEN
```

And the email address that is allowed to sign in (yours):

```bash
npx wrangler secret put OWNER_EMAIL
```

Keep the token somewhere safe, such as a password manager. Anyone who has it can use your
server. Never put it in a file in this repository.

### 6. Put the sign-in page behind Cloudflare Access

This is what makes the sign-in page yours alone. Cloudflare Access asks whoever opens the page
to prove who they are (it emails a one-time code), and the server then checks that it was you.

In the Cloudflare dashboard, go to **Zero Trust**, then **Access controls**, then
**Applications**. (The first time, Zero Trust asks you to pick a team name. The free plan is
fine.)

1. Create a new application of the **self-hosted** kind.
2. Add a public hostname: your server's address from step 4, with the path `authorize`. So the
   application covers `my-mcp-server.your-subdomain.workers.dev/authorize` and nothing else.
3. Add a policy that **allows** one email address: yours.
4. Save it. Then open the application again and copy its **Application Audience (AUD) tag**.

Put two values in `wrangler.jsonc`:

- `ACCESS_AUD`: the AUD tag you copied.
- `ACCESS_TEAM_DOMAIN`: your team's address, `your-team-name.cloudflareaccess.com`.

Then deploy again:

```bash
npm run deploy
```

Two things to get right here:

- **Protect only the `/authorize` path.** Do not turn on Access for the whole server (the
  "Cloudflare Access" switch in the Worker's own settings does that). The chat app itself has
  to reach the rest of the server without a browser, and it carries its own token for that.
- Cloudflare moves these menus around. If the names above do not match what you see, look for
  "self-hosted application" in Cloudflare's Access documentation, or ask your AI tool to do
  this step with Cloudflare's API.

Until this step is done, the sign-in page refuses everyone. That is on purpose.

### 7. Connect it

**Claude (web, phone, desktop).** In a browser, go to claude.ai, open **Settings**, then
**Connectors**, and add a custom connector. Give it a name and your server's address with
`/mcp` on the end:

```
https://my-mcp-server.your-subdomain.workers.dev/mcp
```

Claude sends you to your sign-in page. Sign in with your email, then choose **Allow**. Add it
on the website, not in the desktop app: the desktop app's dialog has failed where the website
worked. Once added, it is available in the apps too.

**Claude Code.** With the token from step 5:

```bash
claude mcp add --transport http my-mcp-server https://my-mcp-server.your-subdomain.workers.dev/mcp --header "Authorization: Bearer YOUR-TOKEN"
```

### 8. Try it

Start a new chat and say "add a note that the setup works", then "what notes do I have?".

To check the deployed server from your computer:

```bash
MCP_URL=https://my-mcp-server.your-subdomain.workers.dev/mcp MCP_TOKEN=YOUR-TOKEN npm run smoke
```

## Making it yours

The example is notes. Three files hold everything about notes, and those are the ones to
change:

| File | What it holds |
| --- | --- |
| `migrations/0001_init.sql` | The database tables. Add your own in a new file, `0002_...sql`. |
| `src/db.ts` | Every database query. |
| `src/tools.ts` | What the chatbot can do (the tools) and what it is told (the instructions). |

The rest (`src/index.ts`, `src/authorize.ts`, `src/access.ts`, `src/kv.ts`) is sign-in and
plumbing. You should not need to touch it.

After any change: `npm run typecheck`, then `npm run dev` and `npm run smoke`, then
`npm run deploy`. Start a **new chat** afterwards: chat apps remember a server's tools and
instructions for the length of a chat.

## What we learned

These came from building a server like this and using it every day. The starter already
follows them.

1. **Few tools, exact descriptions.** A chatbot picks worse among many look-alike tools.
   Before adding one, see whether an existing tool can answer. Every description says *when*
   to use the tool, with the words a person would actually say.
2. **Keep the instructions short.** Chat apps cut long text without telling anyone. One was
   seen to keep only the first 4,096 characters of a server's instructions; some are reported
   to cut instructions and tool descriptions at 2,048. Stay under 4,000 and 2,000
   (`npm run smoke` checks both), and put the most important lines first.
3. **Put a routine's rules where the routine starts.** If one job needs a page of rules,
   return them in the result of the tool that job begins with (the example does this with
   `how_to` in `list_notes`). They arrive exactly when needed, and results are not cut.
4. **Every change answers with a receipt.** One plain line saying what was done, for the
   chatbot to pass on. Otherwise it reads the whole record back to you.
5. **Never guess.** When a name fits more than one thing, the tool returns the choices and the
   chatbot asks. A wrong guess written to your data is worse than a question.
6. **Search before adding.** Tell the chatbot to look first, or you get duplicates.
7. **Never really delete.** Mark things as removed so they can be brought back. People say
   "undo" to a chatbot the way they press Ctrl+Z.
8. **Tell it to read fresh every time.** Without that, a chatbot answers from earlier in the
   chat and is confidently out of date.
9. **Record who wrote what.** Each write is marked with the app that made it (`mcp:claude`),
   so you can tell what an AI changed.
10. **Fail closed.** If sign-in is not set up, the answer is no. There is no "open for now".
11. **Keep the address stable.** Changing the server's address means removing and re-adding
    the connector in every app.

## When something goes wrong

- **The connector "couldn't be added".** Add it on the claude.ai website, not the desktop app.
  Check that `PUBLIC_URL` is exactly the address you deployed to, with no slash at the end.
- **The sign-in page says sign-in is not set up.** `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN` or the
  `OWNER_EMAIL` secret is missing. Do steps 5 and 6, then deploy again.
- **"This account is not allowed."** The email you signed in with is not the one in
  `OWNER_EMAIL`.
- **The chatbot does not see a new tool.** Start a new chat.
- **To see what the server is doing:** `npx wrangler tail` shows each request as it happens.
- **To sign every chat app out:** empty the `oauth_kv` table. Each app then has to sign in
  again.
- **To change the token:** `npx wrangler secret put MCP_TOKEN` with a new value, then update
  every tool that uses it.

## What is in here

```
README.md                 this file
CLAUDE.md                 notes for the AI that changes this project
wrangler.jsonc            the server's settings (name, database, address)
migrations/               the database tables, in numbered files
src/index.ts              the front door: who gets in, where each request goes
src/authorize.ts          the sign-in page chat apps send you to
src/access.ts             checks that the person signing in is you
src/kv.ts                 keeps sign-in records in the database
src/db.ts                 every database query (the notes example)
src/tools.ts              the tools and the instructions (the notes example)
scripts/smoke.ts          checks the token route end to end
scripts/oauth-smoke.ts    checks the chat-app sign-in, on your computer only
```

## No promises

This is shared as an example, as it is. Nobody is offering support for it. See `LICENSE`
(MIT): you may use it and change it freely.
