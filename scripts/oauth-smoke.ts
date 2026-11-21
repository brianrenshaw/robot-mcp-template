// Local test of the OAuth sign-in used by chat apps (Claude on the web and phone).
// Works only against the server running on your own computer (npm run dev), where the sign-in
// page lets you through without Cloudflare Access.
//   npm run smoke:oauth
// Steps: discover, register an app, open the consent page, approve, swap the code for tokens,
// call a tool, refresh the token, and confirm a denied consent gives no access.

import { createHash, randomBytes } from "node:crypto";

const BASE = process.env.MCP_BASE ?? "http://localhost:8787";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

function check(label: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) {
    console.log("      ", JSON.stringify(detail)?.slice(0, 500));
    process.exitCode = 1;
  }
}

async function mcp(token: string | null, body: unknown) {
  return fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function consent(clientId: string, decision: "approve" | "deny") {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: "use",
    state: "s123",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${BASE}/mcp`,
  });
  const pageRes = await fetch(`${BASE}/authorize?${q}`);
  const html = await pageRes.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const cookie = (pageRes.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const post = await fetch(`${BASE}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie, Origin: BASE },
    body: new URLSearchParams({ handle, decision }),
  });
  return { html, status: pageRes.status, post, verifier, location: post.headers.get("Location") ?? "" };
}

async function main() {
  const unauth = await mcp(null, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const challengeHeader = unauth.headers.get("WWW-Authenticate") ?? "";
  check("no token gives 401 with a discovery pointer", unauth.status === 401 && challengeHeader.includes("resource_metadata"), challengeHeader);

  const prm: any = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
  const asm: any = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  check("discovery documents are served", prm.resource === `${BASE}/mcp` && !!asm.token_endpoint && !!asm.registration_endpoint, { prm, asm });

  const reg: any = await (
    await fetch(asm.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
    })
  ).json();
  check("an app can register", !!reg.client_id, reg);

  const denied = await consent(reg.client_id, "deny");
  check("consent page names the app and where access goes", denied.status === 200 && denied.html.includes("Claude") && denied.html.includes("claude.ai"), denied.html.slice(0, 300));
  check("Deny sends the app away without a code", denied.location.includes("error=access_denied") && !denied.location.includes("code="), denied.location);

  const ok = await consent(reg.client_id, "approve");
  const code = new URL(ok.location || "http://x").searchParams.get("code") ?? "";
  check("Allow returns a code to the app", ok.post.status === 302 && !!code, { status: ok.post.status, location: ok.location });

  const tokenRes = await fetch(asm.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: ok.verifier, resource: `${BASE}/mcp` }),
  });
  const tokens: any = await tokenRes.json();
  check("code exchanges for access and refresh tokens", !!tokens.access_token && !!tokens.refresh_token, tokens);

  const list = await mcp(tokens.access_token, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  check("the OAuth token can list tools", list.status === 200, list.status);

  const wc = await mcp(tokens.access_token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_notes", arguments: {} } });
  check("the OAuth token can call a tool", wc.status === 200 && (await wc.text()).includes("notes"), wc.status);

  const refreshed: any = await (
    await fetch(asm.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: reg.client_id }),
    })
  ).json();
  check("the refresh token gets a new access token", !!refreshed.access_token, refreshed);

  const junk = await mcp("not-a-real-token", { jsonrpc: "2.0", id: 4, method: "tools/list" });
  check("a made-up token is refused", junk.status === 401, junk.status);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
