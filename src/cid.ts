/**
 * Cumulus://ID for the Nøde API. Copied from InfinitumCorp/architect src/cid.ts (verifier only).
 *
 * People sign in with Cumulus://ID (OIDC issuer https://id.cumuluscloud.app/realms/cumulus) and call
 * /api with its access token as a Bearer. The token is verified offline against the issuer JWKS
 * (ES256, typ at+jwt, iss, aud = "node", exp), then against userinfo so sign-out takes effect at once.
 * CID_ISSUER points at another issuer, e.g. the mirror that is reachable from Russia without a VPN.
 */
export const DEFAULT_CID_ISSUER = "https://id.cumuluscloud.app/realms/cumulus";
export const CID_CLIENT = "node";

export interface CidProfile {
  cid: string;
  username?: string;
  handle?: string;
  email?: string;
  name?: string;
}

export type CidVerifier = (token: string) => Promise<CidProfile | null>;

export const cidIssuer = (env: Record<string, unknown>): string =>
  (typeof env.CID_ISSUER === "string" && /^https:\/\//.test(env.CID_ISSUER) ? env.CID_ISSUER : DEFAULT_CID_ISSUER).replace(/\/+$/, "");


const JWT = /^[A-Za-z0-9_-]{2,4000}\.[A-Za-z0-9_-]{2,4000}\.[A-Za-z0-9_-]{2,400}$/;
const CID = /^cid_[A-Za-z0-9_-]{1,64}$/;

async function hash(token: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

const b64urlBytes = (text: string): Uint8Array<ArrayBuffer> => {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const b64urlJson = (text: string): Record<string, unknown> => JSON.parse(new TextDecoder().decode(b64urlBytes(text))) as Record<string, unknown>;

type Jwk = { kty?: string; crv?: string; x?: string; y?: string; kid?: string; use?: string };

/**
 * Verify a Cumulus://ID ES256 JWT against a JWKS: signature, `typ`, `iss`, `aud`, `exp`/`nbf`.
 * Returns the claims, or null when anything does not hold.
 */
export async function verifyCidJwt(
  token: string,
  opts: { issuer: string; audience: string; typ: "at+jwt" | "JWT"; keys: readonly Jwk[]; now?: number },
): Promise<Record<string, unknown> | null> {
  if (!JWT.test(token)) return null;
  const [h, p, sig] = token.split(".") as [string, string, string];
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = b64urlJson(h);
    claims = b64urlJson(p);
  } catch {
    return null;
  }
  if (header.alg !== "ES256" || String(header.typ ?? "JWT").toLowerCase() !== opts.typ.toLowerCase()) return null;
  const jwk = opts.keys.find((k) => k.kty === "EC" && k.crv === "P-256" && (!header.kid || k.kid === header.kid) && (!k.use || k.use === "sig"));
  if (!jwk?.x || !jwk.y) return null;
  try {
    const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64urlBytes(sig), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return null;
  } catch {
    return null;
  }
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const skew = 60;
  if (claims.iss !== opts.issuer) return null;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(opts.audience)) return null;
  if (typeof claims.exp !== "number" || claims.exp + skew <= now) return null;
  if (typeof claims.nbf === "number" && claims.nbf - skew > now) return null;
  if (typeof claims.sub !== "string" || !CID.test(claims.sub)) return null;
  return claims;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/**
 * Checks an access token: offline against the JWKS, then the issuer's userinfo. Answers are cached
 * briefly (by the token's hash, never the token) so a busy web app does not ask the issuer on every
 * poll; a revoked session stops working within `ttlMs`.
 */
export function createCidVerifier(
  opts: { issuer?: string; audience?: string; fetch?: typeof fetch; ttlMs?: number; max?: number; now?: () => number } = {},
): CidVerifier {
  const issuer = (opts.issuer ?? DEFAULT_CID_ISSUER).replace(/\/+$/, "");
  const oidc = `${issuer}/protocol/openid-connect`;
  const audience = opts.audience ?? CID_CLIENT;
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = opts.now ?? (() => Date.now());
  const ttl = opts.ttlMs ?? 60_000;
  const max = opts.max ?? 500;
  const cache = new Map<string, { profile: CidProfile | null; until: number }>();
  let jwks: { keys: Jwk[]; until: number } | null = null;
  const keys = async (): Promise<Jwk[]> => {
    if (jwks && jwks.until > now()) return jwks.keys;
    const r = await doFetch(`${oidc}/certs`, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`Cumulus ID JWKS answered ${r.status}`);
    const body = (await r.json()) as { keys?: unknown };
    jwks = { keys: Array.isArray(body.keys) ? (body.keys as Jwk[]) : [], until: now() + 10 * 60_000 };
    return jwks.keys;
  };
  return async (token) => {
    if (!JWT.test(token)) return null;
    const key = await hash(token);
    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit.profile;
    let profile: CidProfile | null = null;
    try {
      const claims = await verifyCidJwt(token, { issuer, audience, typ: "at+jwt", keys: await keys(), now: now() });
      if (claims) {
        const r = await doFetch(`${oidc}/userinfo`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
        if (r.ok) {
          const p = (await r.json()) as Record<string, unknown>;
          if (p.sub === claims.sub) {
            profile = {
              cid: claims.sub as string,
              username: str(p.preferred_username) ?? str(p.username),
              handle: str(p.handle),
              email: str(p.email),
              name: str(p.name),
            };
          }
        } else if (r.status >= 500) {
          throw new Error(`Cumulus ID answered ${r.status}`);
        }
      }
    } catch (err) {
      // The issuer is unreachable: don't cache, and say so instead of "not signed in".
      throw new CidUnavailable(err instanceof Error ? err.message : String(err));
    }
    if (cache.size >= max) cache.delete(cache.keys().next().value as string);
    cache.set(key, { profile, until: now() + ttl });
    return profile;
  };
}

export class CidUnavailable extends Error {}

/** The bearer a request carries: Authorization header, else ?token= (EventSource and <img> can't set headers). */
export const presentedToken = (authorization: string | null | undefined, url: URL): string =>
  authorization?.replace(/^Bearer\s+/i, "").trim() || url.searchParams.get("token") || "";
