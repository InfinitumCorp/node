import { CidUnavailable, cidIssuer, createCidVerifier, presentedToken, type CidVerifier } from "./cid.ts";
import { JURISDICTIONS, POLICY_VERSION, PURPOSES, currentConsent, isPurpose, jurisdiction } from "./consent.ts";
import { AREA, geohash } from "./privacy.ts";
import { HOTSPOT_KINDS, PROBLEMS, type HostLimits, type HotspotKind, type Problem, type Store } from "./store.ts";

/**
 * Nøde API, on standard Request/Response so it runs on Cloudflare Workers and on Node.
 *
 *   GET  /healthz
 *   GET  /api/config                      public settings for the web app
 *   GET  /api/purposes                    what each data purpose means
 *   GET  /api/jurisdictions               consent defaults by jurisdiction
 *   GET  /api/hotspots?lat&lng            active hotspots around a point (public)
 *   GET  /api/me                          (CID) account, consent state
 *   PUT  /api/me/consent                  (CID) { jurisdiction?, choices: { purpose: boolean } }
 *   GET  /api/me/export                   (CID) everything Nøde holds about me, as a JSON download
 *   DELETE /api/me                        (CID) erase account, ledger and hotspots
 *   GET  /api/me/hotspots                 (CID) my hotspots
 *   POST /api/me/hotspots                 (CID, host_bandwidth consent) register a hotspot
 *   PATCH /api/me/hotspots/:id            (CID) name, ssid, active (the stop button), pausedUntil, limits
 *   DELETE /api/me/hotspots/:id           (CID) remove a hotspot, its routers and their history
 *   GET  /api/me/hotspots/:id/activity    (CID) the venue's own busy-hours report
 *   GET  /api/me/hotspots/:id/quality     (CID) guests' measured speed over 7 days, hidden under 10 sessions
 *   GET  /api/me/hotspots/:id/problems    (CID) guests' problem reports over 7 days, counted per reason
 *   GET  /api/me/hotspots/:id/routers     (CID) paired Nøde routers and what they last reported
 *   POST /api/me/hotspots/:id/routers     (CID) { name? } pair a router; the key is shown once
 *   DELETE /api/me/hotspots/:id/routers/:rid  (CID) unpair; the key stops working at once
 *   GET  /api/router/config               (router key) the hotspot's switch and limits, for nod-sync
 *   POST /api/router/status               (router key) { state, tempC?, usedMb? }
 *   POST /api/telemetry                  anonymous: { hotspot, session, kind: "quality"|"visit"|"problem", ... }
 *   GET  /api/reports/connectivity?area&from&to       (buyer key) aggregated, small groups suppressed
 *   GET  /api/reports/venue-activity?hotspot&from&to  (buyer key)
 */

export interface Options {
  store: Store;
  verify?: CidVerifier;
  env?: Record<string, unknown>;
  now?: () => number;
  /**
   * Rate limits for anonymous telemetry: return false to refuse. On Workers these are rate-limiting
   * bindings (wrangler.jsonc); counts are kept by Cloudflare per key and nothing is stored here.
   *   ip      per client address (not applied through the Russian mirror, which hides addresses)
   *   hotspot per hotspot, so nobody can flood one venue's report
   *   router  per paired router, on /api/router/* (a router checks in every 5 minutes)
   */
  limits?: { ip?: Limiter; hotspot?: Limiter; router?: Limiter };
}

export type Limiter = (key: string) => Promise<boolean>;

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' https://api2.amplitude.com https://api.amplitude.com",
  "form-action 'self' https://id.cumuluscloud.app",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

export const PAGE_HEADERS: Record<string, string> = {
  "content-security-policy": CSP,
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "permissions-policy": "geolocation=(self), camera=(), microphone=()",
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });

async function body(req: Request, max = 16_384): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > max) throw new HttpError(413, "Request too large.");
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Send a JSON object.");
  }
}

const num = (v: unknown, lo: number, hi: number, name: string): number => {
  const n = typeof v === "string" && v !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < lo || n > hi) throw new HttpError(400, `${name} must be a number from ${lo} to ${hi}.`);
  return n;
};
const text = (v: unknown, max: number, name: string): string => {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new HttpError(400, `${name} is required (up to ${max} characters).`);
  return v.trim();
};

export function limitsPatch(v: unknown): Partial<HostLimits> {
  if (v == null) return {};
  if (typeof v !== "object") throw new HttpError(400, "limits must be an object.");
  const l = v as Record<string, unknown>;
  const out: Partial<HostLimits> = {};
  if (l.maxMbps != null) out.maxMbps = num(l.maxMbps, 1, 1000, "maxMbps");
  if (l.dailyMb != null) out.dailyMb = num(l.dailyMb, 50, 1_000_000, "dailyMb");
  if (l.minBatteryPct != null) out.minBatteryPct = num(l.minBatteryPct, 20, 100, "minBatteryPct");
  if (l.maxTempC != null) out.maxTempC = num(l.maxTempC, 30, 60, "maxTempC");
  if (l.hours != null) {
    if (!Array.isArray(l.hours) || l.hours.length > 24) throw new HttpError(400, "hours must be a list of hours 0-23.");
    out.hours = [...new Set(l.hours.map((h) => Math.floor(num(h, 0, 23, "hour"))))].sort((a, b) => a - b);
  }
  if (l.guestIsolation === false) throw new HttpError(400, "Guests are always kept off the host's own network.");
  return out;
}

const time = (v: string | null, fallback: number) => {
  if (!v) return fallback;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new HttpError(400, "from/to must be ISO dates.");
  return t;
};

function km(a: number, b: number, c: number, d: number) {
  const r = Math.PI / 180;
  const x = Math.sin(((c - a) * r) / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(((d - b) * r) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(x));
}

const b64url = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Checks the mirror's `<id>.<sig>` tag (mirror/server.mjs clientTag) and returns a limiter key, or "". */
export async function mirrorClient(tag: string | null, secret: string): Promise<string> {
  if (!tag || !secret) return "";
  const m = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/.exec(tag);
  if (!m) return "";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const want = b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`sig:${m[1]}`))).slice(0, 22);
  let diff = 0;
  for (let i = 0; i < 22; i++) diff |= want.charCodeAt(i) ^ m[2]!.charCodeAt(i);
  return diff === 0 ? `ru:${m[1]}` : "";
}

export function createApp(opts: Options) {
  const env = opts.env ?? {};
  const store = opts.store;
  const verify = opts.verify ?? createCidVerifier({ issuer: cidIssuer(env), audience: "node" });
  const now = opts.now ?? (() => Date.now());
  const str = (k: string) => (typeof env[k] === "string" ? (env[k] as string) : "");

  async function person(req: Request, url: URL) {
    const token = presentedToken(req.headers.get("authorization"), url);
    if (!token) throw new HttpError(401, "Sign in with Cumulus ID.");
    let profile;
    try {
      profile = await verify(token);
    } catch (e) {
      if (e instanceof CidUnavailable) throw new HttpError(502, "Cumulus ID can't be reached right now. Try again shortly.");
      throw e;
    }
    if (!profile) throw new HttpError(401, "Sign in with Cumulus ID.");
    return profile;
  }

  async function buyer(req: Request, product: string) {
    const key = req.headers.get("x-node-buyer-key") ?? "";
    const b = key ? await store.buyer(key) : null;
    if (!b) throw new HttpError(401, "A data license key is required.");
    if (!b.products.includes(product)) throw new HttpError(403, `This license doesn't include ${product}.`);
    return b;
  }

  async function api(req: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    const m = req.method;

    if (path === "/api/config" && m === "GET") {
      // Through the Russian mirror (mirror/server.mjs marks its requests), sign-in goes to the
      // Cumulus ID mirror too, since id.cumuluscloud.app is throttled there. Tokens from either
      // carry the same issuer, so verification doesn't change.
      const mirrored = req.headers.get("x-node-mirror") === "ru";
      const cidIssuer = mirrored
        ? str("CID_MIRROR_ISSUER") || "https://ru.id.cumuluscloud.app"
        : str("CID_PUBLIC_ISSUER") || "https://id.cumuluscloud.app";
      return json(200, { cidIssuer, cidClient: "node", policy: POLICY_VERSION, lang: mirrored ? "ru" : null });
    }
    if (path === "/api/purposes" && m === "GET") return json(200, { policy: POLICY_VERSION, purposes: PURPOSES });
    if (path === "/api/jurisdictions" && m === "GET") return json(200, { jurisdictions: JURISDICTIONS });

    if (path === "/api/hotspots" && m === "GET") {
      const lat = num(url.searchParams.get("lat"), -90, 90, "lat");
      const lng = num(url.searchParams.get("lng"), -180, 180, "lng");
      // The ~4.9 km cell the point is in plus its neighbours, found by sampling around it.
      const cells = new Set<string>();
      for (const dl of [-0.04, 0, 0.04]) for (const dg of [-0.05, 0, 0.05]) {
        const la = Math.max(-90, Math.min(90, lat + dl)), lo = ((lng + dg + 540) % 360) - 180;
        cells.add(geohash(la, lo, 5));
      }
      const hotspots = (await store.nearby([...cells], now())).map((h) => ({ ...h, distanceKm: Math.round(km(lat, lng, h.lat, h.lng) * 10) / 10 }))
        .sort((a, b) => a.distanceKm - b.distanceKm);
      return json(200, { hotspots });
    }

    if (path === "/api/telemetry" && m === "POST") {
      const b = await body(req);
      const hotspot = text(b.hotspot, 64, "hotspot");
      const session = text(b.session, 128, "session");
      // Through the mirror the address is hidden; a signed per-client id from the mirror stands in for it.
      const ip = req.headers.get("x-node-mirror")
        ? await mirrorClient(req.headers.get("x-node-mirror-client"), str("NODE_MIRROR_SECRET"))
        : req.headers.get("cf-connecting-ip") ?? "";
      const allowed = (await Promise.all([
        ip && opts.limits?.ip ? opts.limits.ip(`ip:${ip}`) : true,
        opts.limits?.hotspot ? opts.limits.hotspot(`hs:${hotspot}`) : true,
      ])).every(Boolean);
      if (!allowed) return new Response(JSON.stringify({ error: "Too many measurements. Try again in a minute." }), {
        status: 429, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "retry-after": "60" },
      });
      let ok: boolean;
      if (b.kind === "quality") {
        ok = await store.addQualitySample({
          hotspot, session, ok: b.ok !== false,
          downMbps: b.downMbps == null ? undefined : num(b.downMbps, 0, 10_000, "downMbps"),
          upMbps: b.upMbps == null ? undefined : num(b.upMbps, 0, 10_000, "upMbps"),
          latencyMs: b.latencyMs == null ? undefined : num(b.latencyMs, 0, 60_000, "latencyMs"),
        }, now());
      } else if (b.kind === "visit") {
        ok = await store.addVenueSession(hotspot, session, now());
      } else if (b.kind === "problem") {
        // Reported by the guest on purpose, so no consent purpose applies; only a daily count is kept.
        if (!PROBLEMS.includes(b.reason as Problem)) throw new HttpError(400, `reason must be one of ${PROBLEMS.join(", ")}.`);
        ok = await store.addProblem(hotspot, b.reason as Problem, now());
      } else throw new HttpError(400, "kind must be quality, visit or problem.");
      return json(ok ? 202 : 404, ok ? { accepted: true } : { error: "Unknown hotspot." });
    }

    if (path === "/api/reports/connectivity" && m === "GET") {
      const b = await buyer(req, "connectivity");
      const area = url.searchParams.get("area") ?? "";
      if (!AREA.test(area) || area.length < 3) throw new HttpError(400, "area must be a geohash of 3-5 characters.");
      const to = time(url.searchParams.get("to"), now());
      const from = time(url.searchParams.get("from"), to - 7 * 86_400_000);
      if (to - from > 92 * 86_400_000 || to <= from) throw new HttpError(400, "A report covers up to 92 days.");
      const r = await store.connectivityReport(area, from, to);
      await store.logReport(b.name, "connectivity", url.search, r.rows.length, r.suppressed, now());
      return json(200, { product: "connectivity", license: b.license, minGroup: 10, ...r });
    }
    if (path === "/api/reports/venue-activity" && m === "GET") {
      const b = await buyer(req, "venue_activity");
      const hotspot = text(url.searchParams.get("hotspot"), 64, "hotspot");
      const to = time(url.searchParams.get("to"), now());
      const from = time(url.searchParams.get("from"), to - 7 * 86_400_000);
      const r = await store.venueReport(hotspot, from, to);
      await store.logReport(b.name, "venue_activity", url.search, r.rows.length, r.suppressed, now());
      return json(200, { product: "venue_activity", license: b.license, minGroup: 10, ...r });
    }

    if (path === "/api/router/config" || path === "/api/router/status") {
      // Routers authenticate with their own key, in the Authorization header only (never in a URL).
      const auth = req.headers.get("authorization") ?? "";
      const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      const found = key ? await store.routerByKey(key) : null;
      if (!found) throw new HttpError(401, "Unknown router key. Pair the router again in the Host tab.");
      const { router, hotspot: h } = found;
      if (opts.limits?.router && !(await opts.limits.router(`rt:${router.id}`))) {
        return new Response(JSON.stringify({ error: "This router is checking in too often." }), {
          status: 429, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "retry-after": "60" },
        });
      }
      if (path === "/api/router/config" && m === "GET") {
        await store.routerSeen(router.id, null, now());
        const paused = h.pausedUntil != null && h.pausedUntil > now();
        return json(200, {
          hotspot: h.id, name: h.name, ssid: h.ssid, active: h.active && !paused, pausedUntil: paused ? h.pausedUntil : null,
          limits: { maxMbps: Math.max(1, Math.round(h.limits.maxMbps)), dailyMb: Math.round(h.limits.dailyMb), hours: h.limits.hours, maxTempC: h.limits.maxTempC },
          poll: 300,
        });
      }
      if (path === "/api/router/status" && m === "POST") {
        const b = await body(req, 2048);
        await store.routerSeen(router.id, {
          state: text(b.state, 60, "state"),
          tempC: b.tempC == null ? undefined : Math.round(num(b.tempC, -40, 150, "tempC")),
          usedMb: b.usedMb == null ? undefined : Math.round(num(b.usedMb, 0, 10_000_000, "usedMb")),
        }, now());
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      }
      throw new HttpError(405, "Method not allowed.");
    }

    if (path === "/api/me" || path.startsWith("/api/me/")) {
      const p = await person(req, url);
      if (path === "/api/me" && m === "GET") {
        const acct = await store.ensureAccount(p.cid, undefined, now());
        const j = jurisdiction(acct.jurisdiction);
        return json(200, { profile: p, jurisdiction: j.code, policy: POLICY_VERSION, consent: currentConsent(await store.ledger(p.cid), j) });
      }
      if (path === "/api/me/export" && m === "GET") {
        await store.ensureAccount(p.cid, undefined, now());
        const data = await store.export(p.cid);
        return new Response(JSON.stringify({ exportedAt: new Date(now()).toISOString(), profile: p, ...data }, null, 2), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-disposition": 'attachment; filename="node-my-data.json"' },
        });
      }
      if (path === "/api/me" && m === "DELETE") {
        await store.forget(p.cid);
        return json(200, { erased: true });
      }
      if (path === "/api/me/consent" && m === "PUT") {
        const b = await body(req);
        const code = b.jurisdiction == null ? undefined : jurisdiction(String(b.jurisdiction)).code;
        const acct = await store.ensureAccount(p.cid, code, now());
        const choices = (b.choices ?? {}) as Record<string, unknown>;
        if (typeof choices !== "object") throw new HttpError(400, "choices must be an object.");
        const j = jurisdiction(acct.jurisdiction);
        const current = currentConsent(await store.ledger(p.cid), j);
        for (const [k, v] of Object.entries(choices)) {
          if (!isPurpose(k)) throw new HttpError(400, `Unknown purpose ${k}.`);
          if (PURPOSES.find((x) => x.id === k)!.necessary) continue;
          if (typeof v !== "boolean") throw new HttpError(400, `${k} must be true or false.`);
          if (current[k].source !== "choice" || current[k].granted !== v) await store.record(p.cid, k, v, POLICY_VERSION, now());
        }
        // Turning off hosting stops every hotspot this person runs, at once.
        if (choices.host_bandwidth === false) for (const h of await store.myHotspots(p.cid)) await store.updateHotspot(h.id, p.cid, { active: false }, now());
        return json(200, { jurisdiction: j.code, consent: currentConsent(await store.ledger(p.cid), j) });
      }
      if (path === "/api/me/hotspots" && m === "GET") return json(200, { hotspots: await store.myHotspots(p.cid) });
      if (path === "/api/me/hotspots" && m === "POST") {
        const acct = await store.ensureAccount(p.cid, undefined, now());
        if (!currentConsent(await store.ledger(p.cid), jurisdiction(acct.jurisdiction)).host_bandwidth.granted) {
          throw new HttpError(403, "Turn on “Share my connection” first. It's separate from using Nøde.");
        }
        const b = await body(req);
        const kind = b.kind as HotspotKind;
        if (!HOTSPOT_KINDS.includes(kind)) throw new HttpError(400, `kind must be one of ${HOTSPOT_KINDS.join(", ")}.`);
        const h = await store.addHotspot(p.cid, {
          name: text(b.name, 60, "name"), kind, ssid: text(b.ssid ?? "Nøde", 32, "ssid"),
          lat: num(b.lat, -90, 90, "lat"), lng: num(b.lng, -180, 180, "lng"), limits: limitsPatch(b.limits),
        }, now());
        return json(201, { hotspot: h });
      }
      const qm = /^\/api\/me\/hotspots\/(hs_[A-Za-z0-9_-]{6,20})\/quality$/.exec(path);
      if (qm && m === "GET") {
        if (!(await store.hotspot(qm[1]!, p.cid))) throw new HttpError(404, "No such hotspot.");
        const to = now();
        return json(200, { days: 7, ...(await store.hotspotQuality(qm[1]!, to - 7 * 86_400_000, to)) });
      }
      const pm = /^\/api\/me\/hotspots\/(hs_[A-Za-z0-9_-]{6,20})\/problems$/.exec(path);
      if (pm && m === "GET") {
        if (!(await store.hotspot(pm[1]!, p.cid))) throw new HttpError(404, "No such hotspot.");
        return json(200, { days: 7, problems: await store.hotspotProblems(pm[1]!, now() - 7 * 86_400_000) });
      }
      const hm = /^\/api\/me\/hotspots\/(hs_[A-Za-z0-9_-]{6,20})(\/activity)?$/.exec(path);
      if (hm && !hm[2] && m === "PATCH") {
        const b = await body(req);
        const h = await store.updateHotspot(hm[1]!, p.cid, {
          name: b.name == null ? undefined : text(b.name, 60, "name"),
          ssid: b.ssid == null ? undefined : text(b.ssid, 32, "ssid"),
          active: b.active == null ? undefined : Boolean(b.active),
          // A pause is a moment up to a week ahead; null ends it.
          pausedUntil: b.pausedUntil === undefined ? undefined : b.pausedUntil === null ? null : Math.round(num(b.pausedUntil, now(), now() + 7 * 86_400_000, "pausedUntil")),
          limits: limitsPatch(b.limits),
        }, now());
        if (!h) throw new HttpError(404, "No such hotspot.");
        return json(200, { hotspot: h });
      }
      if (hm && !hm[2] && m === "DELETE") {
        if (!(await store.removeHotspot(hm[1]!, p.cid))) throw new HttpError(404, "No such hotspot.");
        return json(200, { removed: true });
      }
      if (hm && hm[2] && m === "GET") {
        if (!(await store.hotspot(hm[1]!, p.cid))) throw new HttpError(404, "No such hotspot.");
        const to = now();
        return json(200, await store.venueReport(hm[1]!, to - 7 * 86_400_000, to));
      }
      const rm = /^\/api\/me\/hotspots\/(hs_[A-Za-z0-9_-]{6,20})\/routers(?:\/(rt_[A-Za-z0-9_-]{6,20}))?$/.exec(path);
      if (rm) {
        const [, hid, rid] = rm as unknown as [string, string, string | undefined];
        if (!(await store.hotspot(hid, p.cid))) throw new HttpError(404, "No such hotspot.");
        if (!rid && m === "GET") return json(200, { routers: await store.routers(hid, p.cid) });
        if (!rid && m === "POST") {
          const b = await body(req);
          const existing = await store.routers(hid, p.cid);
          const name = b.name == null || b.name === "" ? `Router ${existing.length + 1}` : text(b.name, 40, "name");
          let made;
          try { made = await store.addRouter(hid, p.cid, name, now()); }
          catch (e) { if (e instanceof RangeError) throw new HttpError(409, e.message); throw e; }
          if (!made) throw new HttpError(404, "No such hotspot.");
          return json(201, made);
        }
        if (rid && m === "DELETE") {
          if (!(await store.removeRouter(rid, hid, p.cid))) throw new HttpError(404, "No such router.");
          return json(200, { removed: true });
        }
        throw new HttpError(405, "Method not allowed.");
      }
    }
    throw new HttpError(404, "Not found.");
  }

  /** Answers /healthz and /api/*; returns null for anything else (static files). */
  return async function handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    if (url.pathname !== "/healthz" && !url.pathname.startsWith("/api/")) return null;
    try {
      if (url.pathname === "/healthz") return json(200, { ok: true });
      return await api(req, url);
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.message });
      console.error("node: unexpected error", e instanceof Error ? e.message : e);
      return json(500, { error: "Something went wrong." });
    }
  };
}
