import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { CidUnavailable, cidIssuer, createCidVerifier, presentedToken, type CidVerifier } from "./cid.ts";
import { JURISDICTIONS, POLICY_VERSION, PURPOSES, currentConsent, isPurpose, jurisdiction } from "./consent.ts";
import { AREA, geohash } from "./privacy.ts";
import { HOTSPOT_KINDS, openStore, type HostLimits, type HotspotKind, type Store } from "./store.ts";

/**
 * Nøde API and web app.
 *
 *   GET  /healthz
 *   GET  /api/config                      public settings for the web app (issuer, Amplitude key)
 *   GET  /api/purposes                    what each data purpose means
 *   GET  /api/jurisdictions               consent defaults by jurisdiction
 *   GET  /api/hotspots?lat&lng            active hotspots around a point (public)
 *   GET  /api/me                          (CID) account, consent state
 *   PUT  /api/me/consent                  (CID) { jurisdiction?, choices: { purpose: boolean } }
 *   DELETE /api/me                        (CID) erase account, ledger and hotspots
 *   GET  /api/me/hotspots                 (CID) my hotspots
 *   POST /api/me/hotspots                 (CID, host_bandwidth consent) register a hotspot
 *   PATCH /api/me/hotspots/:id            (CID) name, active (the stop button), limits
 *   GET  /api/me/hotspots/:id/activity    (CID) the venue's own busy-hours report
 *   POST /api/telemetry                   anonymous: { hotspot, session, kind: "quality"|"visit", ... }
 *   GET  /api/reports/connectivity?area&from&to   (buyer key) aggregated, small groups suppressed
 *   GET  /api/reports/venue-activity?hotspot&from&to (buyer key)
 */

export interface Options {
  store?: Store;
  verify?: CidVerifier;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

const WEB = fileURLToPath(new URL("../web/", import.meta.url));
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png",
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' https://api2.amplitude.com https://api.amplitude.com",
  "form-action 'self' https://id.cumuluscloud.app",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
  res.end(json);
}

async function body(req: IncomingMessage, max = 16_384): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new HttpError(413, "Request too large.");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Send a JSON object.");
  }
}

const num = (v: unknown, lo: number, hi: number, name: string): number => {
  const n = typeof v === "string" ? Number(v) : v;
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
    out.hours = [...new Set(l.hours.map((h) => num(h, 0, 23, "hour")))].map(Math.floor).sort((a, b) => a - b);
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

export function createApp(opts: Options = {}) {
  const env = opts.env ?? process.env;
  const store = opts.store ?? openStore(env.NODE_DB ?? "node.db");
  const verify = opts.verify ?? createCidVerifier({ issuer: cidIssuer(env), audience: "node" });
  const now = opts.now ?? (() => Date.now());

  async function person(req: IncomingMessage, url: URL) {
    const token = presentedToken(req.headers.authorization, url);
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

  function buyer(req: IncomingMessage, product: string) {
    const key = String(req.headers["x-node-buyer-key"] ?? "");
    const b = key ? store.buyer(key) : null;
    if (!b) throw new HttpError(401, "A data license key is required.");
    if (!b.products.includes(product)) throw new HttpError(403, `This license doesn't include ${product}.`);
    return b;
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
    const { pathname: path } = url;
    const m = req.method ?? "GET";

    if (path === "/api/config" && m === "GET") {
      return send(res, 200, {
        cidIssuer: env.CID_PUBLIC_ISSUER || "https://id.cumuluscloud.app",
        cidClient: "node",
        amplitudeKey: env.AMPLITUDE_API_KEY || "",
        policy: POLICY_VERSION,
      });
    }
    if (path === "/api/purposes" && m === "GET") return send(res, 200, { policy: POLICY_VERSION, purposes: PURPOSES });
    if (path === "/api/jurisdictions" && m === "GET") return send(res, 200, { jurisdictions: JURISDICTIONS });

    if (path === "/api/hotspots" && m === "GET") {
      const lat = num(url.searchParams.get("lat"), -90, 90, "lat");
      const lng = num(url.searchParams.get("lng"), -180, 180, "lng");
      // The 4.9 km cell the point is in plus its neighbours, approximated by sampling around it.
      const cells = new Set<string>();
      for (const dl of [-0.04, 0, 0.04]) for (const dg of [-0.05, 0, 0.05]) {
        const la = Math.max(-90, Math.min(90, lat + dl)), lo = ((lng + dg + 540) % 360) - 180;
        cells.add(geohash(la, lo, 5));
      }
      const hotspots = store.nearby([...cells]).map((h) => ({ ...h, distanceKm: Math.round(km(lat, lng, h.lat, h.lng) * 10) / 10 }))
        .sort((a, b) => a.distanceKm - b.distanceKm);
      return send(res, 200, { hotspots });
    }

    if (path === "/api/telemetry" && m === "POST") {
      const b = await body(req);
      const hotspot = text(b.hotspot, 64, "hotspot");
      const session = text(b.session, 128, "session");
      let ok = false;
      if (b.kind === "quality") {
        ok = store.addQualitySample({
          hotspot, session, ok: b.ok !== false,
          downMbps: b.downMbps == null ? undefined : num(b.downMbps, 0, 10_000, "downMbps"),
          upMbps: b.upMbps == null ? undefined : num(b.upMbps, 0, 10_000, "upMbps"),
          latencyMs: b.latencyMs == null ? undefined : num(b.latencyMs, 0, 60_000, "latencyMs"),
        }, now());
      } else if (b.kind === "visit") {
        ok = store.addVenueSession(hotspot, session, now());
      } else throw new HttpError(400, "kind must be quality or visit.");
      return send(res, ok ? 202 : 404, ok ? { accepted: true } : { error: "Unknown hotspot." });
    }

    if (path === "/api/reports/connectivity" && m === "GET") {
      const b = buyer(req, "connectivity");
      const area = url.searchParams.get("area") ?? "";
      if (!AREA.test(area) || area.length < 3) throw new HttpError(400, "area must be a geohash of 3-5 characters.");
      const to = time(url.searchParams.get("to"), now());
      const from = time(url.searchParams.get("from"), to - 7 * 86_400_000);
      if (to - from > 92 * 86_400_000 || to <= from) throw new HttpError(400, "A report covers up to 92 days.");
      const r = store.connectivityReport(area, from, to);
      store.logReport(b.name, "connectivity", url.search, r.rows.length, r.suppressed, now());
      return send(res, 200, { product: "connectivity", license: b.license, minGroup: 10, ...r });
    }
    if (path === "/api/reports/venue-activity" && m === "GET") {
      const b = buyer(req, "venue_activity");
      const hotspot = text(url.searchParams.get("hotspot"), 64, "hotspot");
      const to = time(url.searchParams.get("to"), now());
      const from = time(url.searchParams.get("from"), to - 7 * 86_400_000);
      const r = store.venueReport(hotspot, from, to);
      store.logReport(b.name, "venue_activity", url.search, r.rows.length, r.suppressed, now());
      return send(res, 200, { product: "venue_activity", license: b.license, minGroup: 10, ...r });
    }

    if (path.startsWith("/api/me")) {
      const p = await person(req, url);
      if (path === "/api/me" && m === "GET") {
        const acct = store.ensureAccount(p.cid, undefined, now());
        const j = jurisdiction(acct.jurisdiction);
        return send(res, 200, { profile: p, jurisdiction: j.code, policy: POLICY_VERSION, consent: currentConsent(store.ledger(p.cid), j) });
      }
      if (path === "/api/me" && m === "DELETE") {
        store.forget(p.cid);
        return send(res, 200, { erased: true });
      }
      if (path === "/api/me/consent" && m === "PUT") {
        const b = await body(req);
        const code = b.jurisdiction == null ? undefined : jurisdiction(String(b.jurisdiction)).code;
        const acct = store.ensureAccount(p.cid, code, now());
        const choices = (b.choices ?? {}) as Record<string, unknown>;
        if (typeof choices !== "object") throw new HttpError(400, "choices must be an object.");
        const j = jurisdiction(acct.jurisdiction);
        const current = currentConsent(store.ledger(p.cid), j);
        for (const [k, v] of Object.entries(choices)) {
          if (!isPurpose(k)) throw new HttpError(400, `Unknown purpose ${k}.`);
          if (PURPOSES.find((x) => x.id === k)!.necessary) continue;
          if (typeof v !== "boolean") throw new HttpError(400, `${k} must be true or false.`);
          if (current[k].source !== "choice" || current[k].granted !== v) store.record(p.cid, k, v, POLICY_VERSION, now());
        }
        // Turning off hosting stops every hotspot this person runs, at once.
        if (choices.host_bandwidth === false) for (const h of store.myHotspots(p.cid)) store.updateHotspot(h.id, p.cid, { active: false }, now());
        return send(res, 200, { jurisdiction: j.code, consent: currentConsent(store.ledger(p.cid), j) });
      }
      if (path === "/api/me/hotspots" && m === "GET") return send(res, 200, { hotspots: store.myHotspots(p.cid) });
      if (path === "/api/me/hotspots" && m === "POST") {
        const acct = store.ensureAccount(p.cid, undefined, now());
        if (!currentConsent(store.ledger(p.cid), jurisdiction(acct.jurisdiction)).host_bandwidth.granted) {
          throw new HttpError(403, "Turn on “Share my connection” first. It's separate from using Nøde.");
        }
        const b = await body(req);
        const kind = b.kind as HotspotKind;
        if (!HOTSPOT_KINDS.includes(kind)) throw new HttpError(400, `kind must be one of ${HOTSPOT_KINDS.join(", ")}.`);
        const h = store.addHotspot(p.cid, {
          name: text(b.name, 60, "name"), kind, ssid: text(b.ssid ?? "Nøde", 32, "ssid"),
          lat: num(b.lat, -90, 90, "lat"), lng: num(b.lng, -180, 180, "lng"), limits: limitsPatch(b.limits),
        }, now());
        return send(res, 201, { hotspot: h });
      }
      const hm = /^\/api\/me\/hotspots\/(hs_[A-Za-z0-9_-]{6,20})(\/activity)?$/.exec(path);
      if (hm && !hm[2] && m === "PATCH") {
        const b = await body(req);
        const h = store.updateHotspot(hm[1]!, p.cid, {
          name: b.name == null ? undefined : text(b.name, 60, "name"),
          active: b.active == null ? undefined : Boolean(b.active),
          limits: limitsPatch(b.limits),
        }, now());
        if (!h) throw new HttpError(404, "No such hotspot.");
        return send(res, 200, { hotspot: h });
      }
      if (hm && hm[2] && m === "GET") {
        if (!store.hotspot(hm[1]!, p.cid)) throw new HttpError(404, "No such hotspot.");
        const to = now();
        return send(res, 200, store.venueReport(hm[1]!, to - 7 * 86_400_000, to));
      }
    }
    throw new HttpError(404, "Not found.");
  }

  async function serveStatic(res: ServerResponse, path: string) {
    const rel = path === "/" ? "index.html" : path.slice(1);
    const file = normalize(join(WEB, rel));
    if (!file.startsWith(normalize(WEB))) throw new HttpError(404, "Not found.");
    let data: Buffer;
    try {
      data = await readFile(file);
    } catch {
      data = await readFile(join(WEB, "index.html")); // the app handles its own routes
    }
    const type = TYPES[extname(file)] ?? "text/html; charset=utf-8";
    res.writeHead(200, {
      "content-type": type,
      "content-security-policy": CSP,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "permissions-policy": "geolocation=(self), camera=(), microphone=()",
      "cache-control": rel === "sw.js" || type.startsWith("text/html") ? "no-cache" : "public, max-age=3600",
    });
    res.end(data);
  }

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/healthz") return send(res, 200, { ok: true });
      if (url.pathname.startsWith("/api/")) return await api(req, res, url);
      if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed.");
      return await serveStatic(res, url.pathname);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error("node: unexpected error", e instanceof Error ? e.message : e);
      return send(res, 500, { error: "Something went wrong." });
    }
  };
  return { handler, store };
}

function km(a: number, b: number, c: number, d: number) {
  const r = Math.PI / 180;
  const x = Math.sin(((c - a) * r) / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(((d - b) * r) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(x));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { handler } = createApp();
  const port = Number(process.env.PORT ?? 8080);
  createServer(handler).listen(port, () => console.log(`Nøde listening on http://localhost:${port}`));
}
