// index.ts
// The server's front door: who gets in, and where each request goes.
//
//   /mcp            The MCP server (Streamable HTTP, stateless). Two ways in:
//                     1. OAuth sign-in, for chat apps such as Claude on the web and phone.
//                     2. Authorization: Bearer <MCP_TOKEN>, for Claude Code and scripts.
//   /authorize      The sign-in page a chat app sends you to. Behind Cloudflare Access.
//   /oauth/token, /oauth/register, /.well-known/...   Answered by the OAuth library.
//   /health         Says "ok". No data.
//
// It fails closed: with no valid OAuth token and no matching MCP_TOKEN, /mcp answers 401.
// You should not need to change this file to make the server your own. Your tools are in
// tools.ts and your data is in db.ts.

import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import type { AccessEnv } from "./access";
import { clientSlug, handleAuthorize } from "./authorize";
import { dbKv } from "./kv";
import { buildServer } from "./tools";

interface Env extends AccessEnv {
  DB: D1Database;
  /** A long random secret. Whoever holds it can use the server, so treat it like a password. */
  MCP_TOKEN?: string;
  /** The public address of this server, no slash at the end. */
  PUBLIC_URL: string;
  OAUTH_KV: ReturnType<typeof dbKv>;
  OAUTH_PROVIDER: OAuthHelpers;
}

interface Props {
  /** Which app is calling: "claude", "chatgpt", ... Recorded as "mcp:<client>" on what it writes. */
  client: string;
}

/** What chat apps see as the name of the thing they are connecting to. */
const SERVER_NAME = "My MCP server";
const SCOPE = "use";

/** Compare two secrets without leaking, through timing, how much of a guess was right. */
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** For callers using the token: the X-Client-Name header, ?client=, then the User-Agent. */
function clientFromRequest(req: Request): string {
  const name = req.headers.get("X-Client-Name") ?? new URL(req.url).searchParams.get("client");
  if (name) return clientSlug(name) ?? "unknown";
  return /claude/i.test(req.headers.get("User-Agent") ?? "") ? "claude" : "unknown";
}

/** The MCP endpoint itself. Only reached with a valid OAuth token or the MCP_TOKEN. */
const mcpHandler = {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = (ctx as ExecutionContext & { props?: Props }).props;
    const actor = `mcp:${props?.client ?? "unknown"}`;
    // A fresh server for every request: nothing is remembered between calls, so there is no
    // session to lose and nothing extra to run (no Durable Objects).
    return createMcpHandler(() => buildServer(env.DB, actor), { route: "/mcp" })(req, env, ctx);
  },
};

/** Everything that is not /mcp or one of the OAuth library's own addresses. */
const defaultHandler = {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/authorize") return handleAuthorize(req, env, env.OAUTH_PROVIDER);
    return new Response("Not found", { status: 404 });
  },
};

function provider(env: Env) {
  const resource = `${env.PUBLIC_URL}/mcp`;
  return new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: mcpHandler as any,
    defaultHandler: defaultHandler as any,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    // Chat apps register themselves here the first time they connect.
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: false,
    scopesSupported: [SCOPE],
    requiredScopes: [SCOPE],
    resourceMetadata: { resource, authorization_servers: [env.PUBLIC_URL], resource_name: SERVER_NAME },
    // A chat app's access lasts an hour and renews itself for as long as the app is used at
    // least once every 90 days.
    accessTokenTTL: 3600,
    refreshTokenTTL: 90 * 86400,
    refreshTokenIdleTTL: 90 * 86400,
    // The second way in: the long-lived MCP_TOKEN, for Claude Code and scripts.
    resolveExternalToken: async ({ token, request, env }) => {
      if (!env.MCP_TOKEN || !safeEqual(token, env.MCP_TOKEN)) return null;
      return { props: { client: clientFromRequest(request) } satisfies Props, audience: resource };
    },
  });
}

/** Some apps look for the sign-in documents at other addresses. Answer those with the same documents. */
const DISCOVERY_ALIASES: Record<string, string> = {
  "/.well-known/oauth-protected-resource": "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server/mcp": "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration": "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration/mcp": "/.well-known/oauth-authorization-server",
  "/mcp/.well-known/openid-configuration": "/.well-known/oauth-authorization-server",
};

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // The OAuth library keeps its records through env.OAUTH_KV; give it the database table.
    const withStore: Env = { ...env, OAUTH_KV: dbKv(env.DB) };
    const alias = DISCOVERY_ALIASES[new URL(req.url).pathname];
    if (alias && req.method === "GET") req = new Request(new URL(alias, req.url), req);
    return provider(withStore).fetch(req, withStore, ctx);
  },
} satisfies ExportedHandler<Env>;
