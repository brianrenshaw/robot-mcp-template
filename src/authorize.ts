// authorize.ts
// The sign-in page a chat app sends you to when you connect it ("Let Claude use your ...?").
// Who is allowed: this one path sits behind Cloudflare Access, and the check in access.ts is
// run again here. If that check fails, nothing is approved.
// What it shows: which app is asking and where access will be sent, with Allow and Deny.

import { AuthorizationError, CimdFetchError, type ConsentDescription, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { verifyAccess, type AccessEnv } from "./access";

/** What the consent page calls your data. Change it to suit your project. */
const WHAT_IT_IS = "your notes";

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#f7f7f5;--surface:#fff;--fg:#1d1d1f;--muted:#6b6b70;--accent:#2f5fc4;--sunken:#f0f0ed;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#151517;--surface:#1e1e21;--fg:#ececee;--muted:#9b9ba1;--accent:#7ea2f0;--sunken:#26262a;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif}
main{width:100%;max-width:400px;background:var(--surface);border-radius:16px;padding:28px;box-shadow:0 6px 24px rgba(0,0,0,.08),0 0 0 1px rgba(0,0,0,.04)}
h1{font-size:20px;line-height:1.3;margin:0 0 12px}
p{margin:0 0 12px;color:var(--muted);font-size:15px}
strong{color:var(--fg);font-weight:600}
.row{display:flex;gap:8px;margin-top:24px}
button{flex:1;height:44px;border:0;border-radius:10px;font:inherit;font-weight:600;cursor:pointer}
.allow{background:var(--accent);color:#fff}
.deny{background:var(--sunken);color:var(--fg)}
</style></head><body><main>${body}</main></body></html>`;
}

function html(content: string, status = 200, headers = new Headers()): Response {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(content, { status, headers });
}

function consentPage(d: ConsentDescription, handle: string, email: string): string {
  const name = esc(d.clientName || "An app");
  const origin = d.clientDomain ? `Published by <strong>${esc(d.clientDomain)}</strong>.` : "This app named itself; the name is not verified.";
  return page(
    `Connect ${d.clientName}`,
    `<h1>Let ${name} use ${esc(WHAT_IT_IS)}?</h1>
<p>It will be able to read and change them.</p>
<p>${origin} Access will be sent to <strong>${esc(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? "<p><strong>This sends access to an app on this computer.</strong> Continue only if you just started connecting from it.</p>" : ""}
<p>Signed in as ${esc(email)}.</p>
<form method="post"><input type="hidden" name="handle" value="${esc(handle)}">
<div class="row"><button class="deny" name="decision" value="deny">Deny</button><button class="allow" name="decision" value="approve">Allow</button></div></form>`,
  );
}

/** A short label for the app, used to record who wrote what: "Claude" becomes "claude". */
export function clientSlug(name: string | null | undefined): string | null {
  if (!name) return null;
  const n = name.toLowerCase();
  // The Claude app introduces itself as "Anthropic" when it connects with a token.
  if (n.includes("claude") || n === "anthropic") return "claude";
  if (n.includes("chatgpt") || n.includes("openai")) return "chatgpt";
  return n.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || null;
}

export async function handleAuthorize(req: Request, env: AccessEnv, oauth: OAuthHelpers): Promise<Response> {
  const who = await verifyAccess(req, env);
  if (!who.ok) return html(page("Sign-in needed", `<h1>Sign-in needed</h1><p>${esc(who.error)}</p>`), who.status);
  try {
    if (req.method === "GET") {
      const request = await oauth.parseAuthRequest(req);
      const details = await oauth.describeConsent(request);
      const consent = await oauth.beginConsent(request);
      return html(consentPage(details, consent.handle, who.email), 200, consent.headers);
    }
    if (req.method === "POST") {
      const form = await req.formData();
      const handle = String(form.get("handle") ?? "");
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(req, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const approved = await oauth.approveConsent(req, handle);
      const client = await oauth.lookupClient(approved.request.clientId);
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: who.email,
        metadata: { client: client?.clientName ?? null },
        scope: approved.request.scope,
        props: { client: clientSlug(client?.clientName) ?? "unknown" },
      });
      approved.headers.set("Location", redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    }
    return new Response("Method not allowed", { status: 405 });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      const message = error instanceof AuthorizationError ? error.description : "This app could not be verified.";
      return html(page("Could not connect", `<h1>Could not connect</h1><p>${esc(message)}</p><p>Go back to the app and start connecting again.</p>`), 400);
    }
    throw error;
  }
}
