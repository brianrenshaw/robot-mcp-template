// access.ts
// Who is allowed to approve a chat app. The /authorize page sits behind Cloudflare Access,
// which makes the person sign in and then adds a signed token to the request. This checks
// that token and that the email on it is the owner's.
//
// It fails closed: if anything is missing or wrong, the answer is no. There is no open fallback.

import { createRemoteJWKSet, jwtVerify } from "jose";

export interface AccessEnv {
  ENVIRONMENT?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** The email allowed to sign in. Several can be given, separated by commas. */
  OWNER_EMAIL?: string;
}

export type AccessResult = { ok: true; email: string } | { ok: false; status: 401 | 403 | 503; error: string };

const jwksByTeam = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

const teamOrigin = (domain: string) => `https://${domain.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
const isLocalHost = (hostname: string) => hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

export async function verifyAccess(req: Request, env: AccessEnv): Promise<AccessResult> {
  const url = new URL(req.url);

  // On your own computer only: both the setting and a localhost address are required.
  if (env.ENVIRONMENT === "local" && isLocalHost(url.hostname)) return { ok: true, email: "local-dev" };

  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.OWNER_EMAIL) {
    return { ok: false, status: 503, error: "Sign-in is not set up on this server yet, so no app can be connected." };
  }

  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return { ok: false, status: 401, error: "Missing Cloudflare Access token. Sign in first." };

  const issuer = teamOrigin(env.ACCESS_TEAM_DOMAIN);
  let jwks = jwksByTeam.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksByTeam.set(issuer, jwks);
  }

  try {
    const { payload } = await jwtVerify(token, jwks, { issuer, audience: env.ACCESS_AUD });
    const email = String(payload.email ?? "").toLowerCase();
    const allowed = env.OWNER_EMAIL.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (!email || !allowed.includes(email)) return { ok: false, status: 403, error: "This account is not allowed." };
    return { ok: true, email };
  } catch {
    return { ok: false, status: 401, error: "Invalid or expired Cloudflare Access token." };
  }
}
