var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/cid.ts
var DEFAULT_CID_ISSUER = "https://id.cumuluscloud.app/realms/cumulus";
var CID_CLIENT = "node";
var cidIssuer = /* @__PURE__ */ __name((env) => (typeof env.CID_ISSUER === "string" && /^https:\/\//.test(env.CID_ISSUER) ? env.CID_ISSUER : DEFAULT_CID_ISSUER).replace(/\/+$/, ""), "cidIssuer");
var JWT = /^[A-Za-z0-9_-]{2,4000}\.[A-Za-z0-9_-]{2,4000}\.[A-Za-z0-9_-]{2,400}$/;
var CID = /^cid_[A-Za-z0-9_-]{1,64}$/;
async function hash(token) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}
__name(hash, "hash");
var b64urlBytes = /* @__PURE__ */ __name((text2) => {
  const b64 = text2.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - b64.length % 4) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}, "b64urlBytes");
var b64urlJson = /* @__PURE__ */ __name((text2) => JSON.parse(new TextDecoder().decode(b64urlBytes(text2))), "b64urlJson");
async function verifyCidJwt(token, opts) {
  if (!JWT.test(token)) return null;
  const [h, p, sig] = token.split(".");
  let header;
  let claims;
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
  const now = Math.floor((opts.now ?? Date.now()) / 1e3);
  const skew = 60;
  if (claims.iss !== opts.issuer) return null;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(opts.audience)) return null;
  if (typeof claims.exp !== "number" || claims.exp + skew <= now) return null;
  if (typeof claims.nbf === "number" && claims.nbf - skew > now) return null;
  if (typeof claims.sub !== "string" || !CID.test(claims.sub)) return null;
  return claims;
}
__name(verifyCidJwt, "verifyCidJwt");
var str = /* @__PURE__ */ __name((v) => typeof v === "string" && v ? v : void 0, "str");
function createCidVerifier(opts = {}) {
  const issuer = (opts.issuer ?? DEFAULT_CID_ISSUER).replace(/\/+$/, "");
  const oidc = `${issuer}/protocol/openid-connect`;
  const audience = opts.audience ?? CID_CLIENT;
  const doFetch = opts.fetch ?? ((...a) => fetch(...a));
  const now = opts.now ?? (() => Date.now());
  const ttl = opts.ttlMs ?? 6e4;
  const max = opts.max ?? 500;
  const cache = /* @__PURE__ */ new Map();
  let jwks = null;
  const keys = /* @__PURE__ */ __name(async () => {
    if (jwks && jwks.until > now()) return jwks.keys;
    const r = await doFetch(`${oidc}/certs`, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`Cumulus ID JWKS answered ${r.status}`);
    const body2 = await r.json();
    jwks = { keys: Array.isArray(body2.keys) ? body2.keys : [], until: now() + 10 * 6e4 };
    return jwks.keys;
  }, "keys");
  return async (token) => {
    if (!JWT.test(token)) return null;
    const key = await hash(token);
    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit.profile;
    let profile = null;
    try {
      const claims = await verifyCidJwt(token, { issuer, audience, typ: "at+jwt", keys: await keys(), now: now() });
      if (claims) {
        const r = await doFetch(`${oidc}/userinfo`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
        if (r.ok) {
          const p = await r.json();
          if (p.sub === claims.sub) {
            profile = {
              cid: claims.sub,
              username: str(p.preferred_username) ?? str(p.username),
              handle: str(p.handle),
              email: str(p.email),
              name: str(p.name)
            };
          }
        } else if (r.status >= 500) {
          throw new Error(`Cumulus ID answered ${r.status}`);
        }
      }
    } catch (err) {
      throw new CidUnavailable(err instanceof Error ? err.message : String(err));
    }
    if (cache.size >= max) cache.delete(cache.keys().next().value);
    cache.set(key, { profile, until: now() + ttl });
    return profile;
  };
}
__name(createCidVerifier, "createCidVerifier");
var CidUnavailable = class extends Error {
  static {
    __name(this, "CidUnavailable");
  }
};
var presentedToken = /* @__PURE__ */ __name((authorization, url) => authorization?.replace(/^Bearer\s+/i, "").trim() || url.searchParams.get("token") || "", "presentedToken");

// src/consent.ts
var PURPOSES = [
  {
    id: "service",
    title: "Run the network",
    necessary: true,
    licensed: false,
    summary: "Your sign-in and the hotspot you're connected to, so we can let you on and keep the network safe. Never sold."
  },
  {
    id: "network_quality",
    title: "Network quality reports",
    necessary: false,
    licensed: true,
    summary: "Speed, latency and uptime of N\xF8de hotspots, grouped by area and hour, with small groups removed. Never tied to your account."
  },
  {
    id: "venue_reports",
    title: "Venue busy-hours",
    necessary: false,
    licensed: true,
    summary: "How many sessions a venue had each hour, in groups of 10 or more. Venues use it to plan staffing."
  },
  {
    id: "research",
    title: "Consumer research",
    necessary: false,
    licensed: true,
    summary: "Surveys you choose to answer. Each survey says who it's for before you start; you can skip any."
  },
  {
    id: "campaign_measurement",
    title: "Campaign measurement",
    necessary: false,
    licensed: true,
    summary: "Whether a campaign at a venue was seen, counted only in aggregate. No profiles, no tracking across sites."
  },
  {
    id: "host_bandwidth",
    title: "Share my connection",
    necessary: false,
    licensed: false,
    summary: "Let N\xF8de guests use part of your connection within the limits you set. Uses your data allowance and battery."
  }
];
var STRICT = {
  network_quality: "opt_in",
  venue_reports: "opt_in",
  research: "opt_in",
  campaign_measurement: "opt_in",
  host_bandwidth: "opt_in"
};
var JURISDICTIONS = [
  {
    code: "EU",
    name: "European Union / EEA",
    defaults: STRICT,
    conditionalAccess: false,
    minAge: 16,
    notes: "GDPR consent: specific, freely given, withdrawable without detriment. Access never tied to licensing."
  },
  { code: "GB", name: "United Kingdom", defaults: STRICT, conditionalAccess: false, minAge: 13, notes: "UK GDPR and PECR." },
  {
    code: "US-CA",
    name: "California",
    defaults: { ...STRICT, network_quality: "opt_out", venue_reports: "opt_out" },
    conditionalAccess: false,
    minAge: 16,
    notes: "CCPA/CPRA: aggregated, deidentified reports with a Do Not Sell/Share switch; financial-incentive notice before any conditional offer."
  },
  {
    code: "US",
    name: "United States (other)",
    defaults: { ...STRICT, network_quality: "opt_out", venue_reports: "opt_out" },
    conditionalAccess: false,
    minAge: 13,
    notes: "State privacy laws vary; sensitive locations are never collected (FTC location-data actions)."
  },
  {
    code: "RU",
    name: "Russia",
    defaults: STRICT,
    conditionalAccess: false,
    minAge: 14,
    notes: "152-FZ: written-form consent per purpose, data localisation review before launch."
  },
  {
    code: "OTHER",
    name: "Everywhere else",
    defaults: STRICT,
    conditionalAccess: false,
    minAge: 16,
    notes: "Strictest defaults until a market is reviewed."
  }
];
var jurisdiction = /* @__PURE__ */ __name((code) => JURISDICTIONS.find((j) => j.code === String(code ?? "").toUpperCase()) ?? JURISDICTIONS.find((j) => j.code === "OTHER"), "jurisdiction");
var POLICY_VERSION = "2026-11-12";
function currentConsent(entries, j) {
  const out = {};
  for (const p of PURPOSES) {
    if (p.necessary) {
      out[p.id] = { granted: true, source: "necessary" };
      continue;
    }
    const last = [...entries].filter((e) => e.purpose === p.id).sort((a, b) => a.at - b.at).at(-1);
    out[p.id] = last ? { granted: last.granted, source: "choice" } : { granted: j.defaults[p.id] === "opt_out", source: "default" };
  }
  return out;
}
__name(currentConsent, "currentConsent");
var isPurpose = /* @__PURE__ */ __name((v) => PURPOSES.some((p) => p.id === v), "isPurpose");

// src/privacy.ts
var MIN_GROUP = 10;
var AREA_PRECISION = 5;
var BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";
function geohash(lat, lng, precision = AREA_PRECISION) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new RangeError("lat/lng out of range");
  }
  let latLo = -90, latHi = 90, lngLo = -180, lngHi = 180;
  let out = "", bit = 0, ch = 0, even = true;
  while (out.length < precision) {
    if (even) {
      const mid = (lngLo + lngHi) / 2;
      if (lng >= mid) {
        ch = ch << 1 | 1;
        lngLo = mid;
      } else {
        ch <<= 1;
        lngHi = mid;
      }
    } else {
      const mid = (latLo + latHi) / 2;
      if (lat >= mid) {
        ch = ch << 1 | 1;
        latLo = mid;
      } else {
        ch <<= 1;
        latHi = mid;
      }
    }
    even = !even;
    if (++bit === 5) {
      out += BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return out;
}
__name(geohash, "geohash");
function geohashCenter(hash2) {
  let latLo = -90, latHi = 90, lngLo = -180, lngHi = 180, even = true;
  for (const c of hash2) {
    const v = BASE32.indexOf(c);
    if (v < 0) throw new RangeError("not a geohash");
    for (let b = 4; b >= 0; b--) {
      const on = v >> b & 1;
      if (even) {
        const m = (lngLo + lngHi) / 2;
        if (on) lngLo = m;
        else lngHi = m;
      } else {
        const m = (latLo + latHi) / 2;
        if (on) latLo = m;
        else latHi = m;
      }
      even = !even;
    }
  }
  return { lat: (latLo + latHi) / 2, lng: (lngLo + lngHi) / 2 };
}
__name(geohashCenter, "geohashCenter");
var AREA = /^[0-9bcdefghjkmnpqrstuvwxyz]{1,5}$/;
var hourOf = /* @__PURE__ */ __name((ms) => Math.floor(ms / 36e5) * 36e5, "hourOf");
var roundCount = /* @__PURE__ */ __name((n) => Math.round(n / 5) * 5, "roundCount");
function suppress(groups, min = MIN_GROUP) {
  const rows = groups.filter((g) => g.sessions >= min);
  return { rows, suppressed: groups.length - rows.length };
}
__name(suppress, "suppress");
function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(p / 100 * s.length) - 1));
  return s[i];
}
__name(percentile, "percentile");

// src/sql.ts
function d1(db) {
  const bind = /* @__PURE__ */ __name((sql, args) => db.prepare(sql).bind(...args.map((a) => a === void 0 ? null : a)), "bind");
  return {
    async run(sql, ...args) {
      await bind(sql, args).run();
    },
    async get(sql, ...args) {
      return await bind(sql, args).first() ?? void 0;
    },
    async all(sql, ...args) {
      return (await bind(sql, args).all()).results;
    },
    async batch(statements) {
      await db.batch(statements.map((s) => db.prepare(s).bind()));
    }
  };
}
__name(d1, "d1");
var SCHEMA = [
  `CREATE TABLE IF NOT EXISTS accounts (cid TEXT PRIMARY KEY, jurisdiction TEXT NOT NULL DEFAULT 'OTHER', created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS consent_ledger (seq INTEGER PRIMARY KEY AUTOINCREMENT, cid TEXT NOT NULL, purpose TEXT NOT NULL,
    granted INTEGER NOT NULL, policy TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS consent_by_cid ON consent_ledger(cid)`,
  `CREATE TABLE IF NOT EXISTS hotspots (id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, ssid TEXT NOT NULL,
    area TEXT NOT NULL, active INTEGER NOT NULL, limits TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS hotspots_by_area ON hotspots(area)`,
  // analytics: no account column, ever
  `CREATE TABLE IF NOT EXISTS quality_samples (hotspot TEXT NOT NULL, area TEXT NOT NULL, hour INTEGER NOT NULL, session TEXT NOT NULL,
    down_mbps REAL, up_mbps REAL, latency_ms REAL, ok INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS quality_by_area_hour ON quality_samples(area, hour)`,
  `CREATE TABLE IF NOT EXISTS venue_sessions (hotspot TEXT NOT NULL, hour INTEGER NOT NULL, session TEXT NOT NULL, PRIMARY KEY (hotspot, hour, session))`,
  `CREATE TABLE IF NOT EXISTS buyers (key_hash TEXT PRIMARY KEY, name TEXT NOT NULL, products TEXT NOT NULL, license TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS report_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, buyer TEXT NOT NULL, product TEXT NOT NULL,
    query TEXT NOT NULL, rows INTEGER NOT NULL, suppressed INTEGER NOT NULL, at INTEGER NOT NULL)`
];

// src/store.ts
var HOTSPOT_KINDS = ["home", "business", "relay", "gateway", "phone"];
var DEFAULT_LIMITS = { maxMbps: 10, dailyMb: 2048, minBatteryPct: 40, maxTempC: 42, hours: [], guestIsolation: true };
var b64url = /* @__PURE__ */ __name((bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), "b64url");
var random = /* @__PURE__ */ __name((n) => b64url(crypto.getRandomValues(new Uint8Array(n))), "random");
var id = /* @__PURE__ */ __name((prefix) => `${prefix}_${random(9)}`, "id");
async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256, "sha256");
function openStore(sql) {
  let ready = null;
  const init = /* @__PURE__ */ __name(() => ready ??= sql.batch(SCHEMA).catch((e) => {
    ready = null;
    throw e;
  }), "init");
  const toHotspot = /* @__PURE__ */ __name((r, withOwner = false) => {
    const c = geohashCenter(String(r.area));
    return {
      id: String(r.id),
      name: String(r.name),
      kind: r.kind,
      ssid: String(r.ssid),
      area: String(r.area),
      lat: c.lat,
      lng: c.lng,
      active: Boolean(r.active),
      limits: JSON.parse(String(r.limits)),
      updatedAt: Number(r.updated_at),
      ...withOwner ? { owner: String(r.owner) } : {}
    };
  }, "toHotspot");
  const store = {
    init,
    // ---- identity ----
    async ensureAccount(cid, jurisdiction2, now = Date.now()) {
      await init();
      await sql.run("INSERT INTO accounts (cid, jurisdiction, created_at) VALUES (?, ?, ?) ON CONFLICT(cid) DO NOTHING", cid, jurisdiction2 ?? "OTHER", now);
      if (jurisdiction2) await sql.run("UPDATE accounts SET jurisdiction = ? WHERE cid = ?", jurisdiction2, cid);
      return await sql.get("SELECT cid, jurisdiction FROM accounts WHERE cid = ?", cid);
    },
    async ledger(cid) {
      await init();
      return (await sql.all("SELECT purpose, granted, policy, at FROM consent_ledger WHERE cid = ? ORDER BY seq", cid)).map((r) => ({ purpose: r.purpose, granted: Boolean(r.granted), policy: String(r.policy), at: Number(r.at) }));
    },
    async record(cid, purpose, granted, policy, now = Date.now()) {
      await init();
      await sql.run("INSERT INTO consent_ledger (cid, purpose, granted, policy, at) VALUES (?, ?, ?, ?, ?)", cid, purpose, granted ? 1 : 0, policy, now);
    },
    /** Erase a person: account, ledger and hotspots. Analytics were never linked to them. */
    async forget(cid) {
      await init();
      await sql.run("DELETE FROM consent_ledger WHERE cid = ?", cid);
      await sql.run("DELETE FROM hotspots WHERE owner = ?", cid);
      await sql.run("DELETE FROM accounts WHERE cid = ?", cid);
    },
    // ---- hotspots ----
    async addHotspot(owner, h, now = Date.now()) {
      await init();
      const hid = id("hs");
      const limits = { ...DEFAULT_LIMITS, ...h.limits, guestIsolation: true };
      await sql.run(
        "INSERT INTO hotspots (id, owner, name, kind, ssid, area, active, limits, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)",
        hid,
        owner,
        h.name,
        h.kind,
        h.ssid,
        geohash(h.lat, h.lng, 7),
        JSON.stringify(limits),
        now
      );
      return await store.hotspot(hid, owner);
    },
    async hotspot(hid, owner) {
      await init();
      const r = await sql.get("SELECT * FROM hotspots WHERE id = ?", hid);
      if (!r || owner && r.owner !== owner) return null;
      return toHotspot(r, Boolean(owner));
    },
    async myHotspots(owner) {
      await init();
      return (await sql.all("SELECT * FROM hotspots WHERE owner = ? ORDER BY updated_at DESC", owner)).map((r) => toHotspot(r, true));
    },
    async updateHotspot(hid, owner, patch, now = Date.now()) {
      const cur = await store.hotspot(hid, owner);
      if (!cur) return null;
      const limits = { ...cur.limits, ...patch.limits, guestIsolation: true };
      await sql.run(
        "UPDATE hotspots SET name = ?, active = ?, limits = ?, updated_at = ? WHERE id = ? AND owner = ?",
        patch.name ?? cur.name,
        patch.active ?? cur.active ? 1 : 0,
        JSON.stringify(limits),
        now,
        hid,
        owner
      );
      return store.hotspot(hid, owner);
    },
    /** Public discovery: active hotspots in the given geohash cells (prefix match). */
    async nearby(cells) {
      await init();
      const out = [];
      for (const c of cells) for (const r of await sql.all("SELECT * FROM hotspots WHERE active = 1 AND area LIKE ? LIMIT 200", `${c}%`)) out.push(toHotspot(r));
      return out;
    },
    // ---- analytics (anonymous) ----
    async addQualitySample(s, now = Date.now()) {
      await init();
      const h = await sql.get("SELECT area FROM hotspots WHERE id = ?", s.hotspot);
      if (!h) return false;
      await sql.run(
        "INSERT INTO quality_samples (hotspot, area, hour, session, down_mbps, up_mbps, latency_ms, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        s.hotspot,
        h.area.slice(0, 5),
        hourOf(now),
        await sha256(s.session),
        s.downMbps ?? null,
        s.upMbps ?? null,
        s.latencyMs ?? null,
        s.ok ? 1 : 0
      );
      return true;
    },
    async addVenueSession(hotspot, session, now = Date.now()) {
      await init();
      const h = await sql.get("SELECT kind FROM hotspots WHERE id = ?", hotspot);
      if (!h || h.kind !== "business") return false;
      await sql.run("INSERT OR IGNORE INTO venue_sessions (hotspot, hour, session) VALUES (?, ?, ?)", hotspot, hourOf(now), await sha256(session));
      return true;
    },
    // ---- buyers and reports ----
    async addBuyer(name, products, license, now = Date.now()) {
      await init();
      const key = `nb_${random(24)}`;
      await sql.run("INSERT INTO buyers (key_hash, name, products, license, created_at) VALUES (?, ?, ?, ?, ?)", await sha256(key), name, JSON.stringify(products), license, now);
      return key;
    },
    async buyer(key) {
      await init();
      const r = await sql.get("SELECT name, products, license FROM buyers WHERE key_hash = ?", await sha256(key));
      return r ? { name: String(r.name), products: JSON.parse(String(r.products)), license: String(r.license) } : null;
    },
    async logReport(buyer, product, query, rows, suppressed, now = Date.now()) {
      await init();
      await sql.run("INSERT INTO report_log (buyer, product, query, rows, suppressed, at) VALUES (?, ?, ?, ?, ?, ?)", buyer, product, query, rows, suppressed, now);
    },
    async connectivityReport(area, from, to) {
      await init();
      const rows = await sql.all(`SELECT area, hour, session, down_mbps, up_mbps, latency_ms, ok FROM quality_samples
        WHERE area LIKE ? AND hour >= ? AND hour < ?`, `${area}%`, hourOf(from), to);
      const groups = /* @__PURE__ */ new Map();
      for (const r of rows) {
        const k = `${r.area}|${r.hour}`;
        let g = groups.get(k);
        if (!g) groups.set(k, g = { area: String(r.area), hour: Number(r.hour), sessions: /* @__PURE__ */ new Set(), down: [], up: [], lat: [], ok: 0, n: 0 });
        g.sessions.add(String(r.session));
        if (r.down_mbps != null) g.down.push(Number(r.down_mbps));
        if (r.up_mbps != null) g.up.push(Number(r.up_mbps));
        if (r.latency_ms != null) g.lat.push(Number(r.latency_ms));
        g.ok += Number(r.ok);
        g.n++;
      }
      const all = [...groups.values()].map((g) => ({
        key: `${g.area}|${g.hour}`,
        sessions: g.sessions.size,
        area: g.area,
        hour: new Date(g.hour).toISOString(),
        medianDownMbps: percentile(g.down, 50),
        p90LatencyMs: percentile(g.lat, 90),
        medianUpMbps: percentile(g.up, 50),
        successRate: g.n ? Math.round(g.ok / g.n * 1e3) / 1e3 : null
      }));
      const { rows: kept, suppressed } = suppress(all);
      return { rows: kept.map(({ key: _k, sessions, ...r }) => ({ ...r, sessions: roundCount(sessions) })), suppressed };
    },
    async venueReport(hotspot, from, to) {
      await init();
      const all = (await sql.all(
        "SELECT hour, COUNT(*) AS sessions FROM venue_sessions WHERE hotspot = ? AND hour >= ? AND hour < ? GROUP BY hour ORDER BY hour",
        hotspot,
        hourOf(from),
        to
      )).map((r) => ({ key: Number(r.hour), sessions: Number(r.sessions) }));
      const { rows, suppressed } = suppress(all);
      return { rows: rows.map((r) => ({ hour: new Date(r.key).toISOString(), sessions: roundCount(r.sessions) })), suppressed };
    }
  };
  return store;
}
__name(openStore, "openStore");

// src/app.ts
var CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' https://api2.amplitude.com https://api.amplitude.com",
  "form-action 'self' https://id.cumuluscloud.app",
  "frame-ancestors 'none'",
  "base-uri 'none'"
].join("; ");
var HttpError = class extends Error {
  static {
    __name(this, "HttpError");
  }
  status;
  constructor(status, message) {
    super(message);
    this.status = status;
  }
};
var json = /* @__PURE__ */ __name((status, body2) => new Response(JSON.stringify(body2), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } }), "json");
async function body(req, max = 16384) {
  const text2 = await req.text();
  if (text2.length > max) throw new HttpError(413, "Request too large.");
  if (!text2) return {};
  try {
    const v = JSON.parse(text2);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new HttpError(400, "Send a JSON object.");
  }
}
__name(body, "body");
var num = /* @__PURE__ */ __name((v, lo, hi, name) => {
  const n = typeof v === "string" && v !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < lo || n > hi) throw new HttpError(400, `${name} must be a number from ${lo} to ${hi}.`);
  return n;
}, "num");
var text = /* @__PURE__ */ __name((v, max, name) => {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new HttpError(400, `${name} is required (up to ${max} characters).`);
  return v.trim();
}, "text");
function limitsPatch(v) {
  if (v == null) return {};
  if (typeof v !== "object") throw new HttpError(400, "limits must be an object.");
  const l = v;
  const out = {};
  if (l.maxMbps != null) out.maxMbps = num(l.maxMbps, 1, 1e3, "maxMbps");
  if (l.dailyMb != null) out.dailyMb = num(l.dailyMb, 50, 1e6, "dailyMb");
  if (l.minBatteryPct != null) out.minBatteryPct = num(l.minBatteryPct, 20, 100, "minBatteryPct");
  if (l.maxTempC != null) out.maxTempC = num(l.maxTempC, 30, 60, "maxTempC");
  if (l.hours != null) {
    if (!Array.isArray(l.hours) || l.hours.length > 24) throw new HttpError(400, "hours must be a list of hours 0-23.");
    out.hours = [...new Set(l.hours.map((h) => Math.floor(num(h, 0, 23, "hour"))))].sort((a, b) => a - b);
  }
  if (l.guestIsolation === false) throw new HttpError(400, "Guests are always kept off the host's own network.");
  return out;
}
__name(limitsPatch, "limitsPatch");
var time = /* @__PURE__ */ __name((v, fallback) => {
  if (!v) return fallback;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new HttpError(400, "from/to must be ISO dates.");
  return t;
}, "time");
function km(a, b, c, d) {
  const r = Math.PI / 180;
  const x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(x));
}
__name(km, "km");
function createApp(opts) {
  const env = opts.env ?? {};
  const store = opts.store;
  const verify = opts.verify ?? createCidVerifier({ issuer: cidIssuer(env), audience: "node" });
  const now = opts.now ?? (() => Date.now());
  const str2 = /* @__PURE__ */ __name((k) => typeof env[k] === "string" ? env[k] : "", "str");
  async function person(req, url) {
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
  __name(person, "person");
  async function buyer(req, product) {
    const key = req.headers.get("x-node-buyer-key") ?? "";
    const b = key ? await store.buyer(key) : null;
    if (!b) throw new HttpError(401, "A data license key is required.");
    if (!b.products.includes(product)) throw new HttpError(403, `This license doesn't include ${product}.`);
    return b;
  }
  __name(buyer, "buyer");
  async function api(req, url) {
    const path = url.pathname;
    const m = req.method;
    if (path === "/api/config" && m === "GET") {
      return json(200, { cidIssuer: str2("CID_PUBLIC_ISSUER") || "https://id.cumuluscloud.app", cidClient: "node", policy: POLICY_VERSION });
    }
    if (path === "/api/purposes" && m === "GET") return json(200, { policy: POLICY_VERSION, purposes: PURPOSES });
    if (path === "/api/jurisdictions" && m === "GET") return json(200, { jurisdictions: JURISDICTIONS });
    if (path === "/api/hotspots" && m === "GET") {
      const lat = num(url.searchParams.get("lat"), -90, 90, "lat");
      const lng = num(url.searchParams.get("lng"), -180, 180, "lng");
      const cells = /* @__PURE__ */ new Set();
      for (const dl of [-0.04, 0, 0.04]) for (const dg of [-0.05, 0, 0.05]) {
        const la = Math.max(-90, Math.min(90, lat + dl)), lo = (lng + dg + 540) % 360 - 180;
        cells.add(geohash(la, lo, 5));
      }
      const hotspots = (await store.nearby([...cells])).map((h) => ({ ...h, distanceKm: Math.round(km(lat, lng, h.lat, h.lng) * 10) / 10 })).sort((a, b) => a.distanceKm - b.distanceKm);
      return json(200, { hotspots });
    }
    if (path === "/api/telemetry" && m === "POST") {
      const b = await body(req);
      const hotspot = text(b.hotspot, 64, "hotspot");
      const session = text(b.session, 128, "session");
      let ok;
      if (b.kind === "quality") {
        ok = await store.addQualitySample({
          hotspot,
          session,
          ok: b.ok !== false,
          downMbps: b.downMbps == null ? void 0 : num(b.downMbps, 0, 1e4, "downMbps"),
          upMbps: b.upMbps == null ? void 0 : num(b.upMbps, 0, 1e4, "upMbps"),
          latencyMs: b.latencyMs == null ? void 0 : num(b.latencyMs, 0, 6e4, "latencyMs")
        }, now());
      } else if (b.kind === "visit") {
        ok = await store.addVenueSession(hotspot, session, now());
      } else throw new HttpError(400, "kind must be quality or visit.");
      return json(ok ? 202 : 404, ok ? { accepted: true } : { error: "Unknown hotspot." });
    }
    if (path === "/api/reports/connectivity" && m === "GET") {
      const b = await buyer(req, "connectivity");
      const area = url.searchParams.get("area") ?? "";
      if (!AREA.test(area) || area.length < 3) throw new HttpError(400, "area must be a geohash of 3-5 characters.");
      const to = time(url.searchParams.get("to"), now());
      const from = time(url.searchParams.get("from"), to - 7 * 864e5);
      if (to - from > 92 * 864e5 || to <= from) throw new HttpError(400, "A report covers up to 92 days.");
      const r = await store.connectivityReport(area, from, to);
      await store.logReport(b.name, "connectivity", url.search, r.rows.length, r.suppressed, now());
      return json(200, { product: "connectivity", license: b.license, minGroup: 10, ...r });
    }
    if (path === "/api/reports/venue-activity" && m === "GET") {
      const b = await buyer(req, "venue_activity");
      const hotspot = text(url.searchParams.get("hotspot"), 64, "hotspot");
      const to = time(url.searchParams.get("to"), now());
      const from = time(url.searchParams.get("from"), to - 7 * 864e5);
      const r = await store.venueReport(hotspot, from, to);
      await store.logReport(b.name, "venue_activity", url.search, r.rows.length, r.suppressed, now());
      return json(200, { product: "venue_activity", license: b.license, minGroup: 10, ...r });
    }
    if (path === "/api/me" || path.startsWith("/api/me/")) {
      const p = await person(req, url);
      if (path === "/api/me" && m === "GET") {
        const acct = await store.ensureAccount(p.cid, void 0, now());
        const j = jurisdiction(acct.jurisdiction);
        return json(200, { profile: p, jurisdiction: j.code, policy: POLICY_VERSION, consent: currentConsent(await store.ledger(p.cid), j) });
      }
      if (path === "/api/me" && m === "DELETE") {
        await store.forget(p.cid);
        return json(200, { erased: true });
      }
      if (path === "/api/me/consent" && m === "PUT") {
        const b = await body(req);
        const code = b.jurisdiction == null ? void 0 : jurisdiction(String(b.jurisdiction)).code;
        const acct = await store.ensureAccount(p.cid, code, now());
        const choices = b.choices ?? {};
        if (typeof choices !== "object") throw new HttpError(400, "choices must be an object.");
        const j = jurisdiction(acct.jurisdiction);
        const current = currentConsent(await store.ledger(p.cid), j);
        for (const [k, v] of Object.entries(choices)) {
          if (!isPurpose(k)) throw new HttpError(400, `Unknown purpose ${k}.`);
          if (PURPOSES.find((x) => x.id === k).necessary) continue;
          if (typeof v !== "boolean") throw new HttpError(400, `${k} must be true or false.`);
          if (current[k].source !== "choice" || current[k].granted !== v) await store.record(p.cid, k, v, POLICY_VERSION, now());
        }
        if (choices.host_bandwidth === false) for (const h of await store.myHotspots(p.cid)) await store.updateHotspot(h.id, p.cid, { active: false }, now());
        return json(200, { jurisdiction: j.code, consent: currentConsent(await store.ledger(p.cid), j) });
      }
      if (path === "/api/me/hotspots" && m === "GET") return json(200, { hotspots: await store.myHotspots(p.cid) });
      if (path === "/api/me/hotspots" && m === "POST") {
        const acct = await store.ensureAccount(p.cid, void 0, now());
        if (!currentConsent(await store.ledger(p.cid), jurisdiction(acct.jurisdiction)).host_bandwidth.granted) {
          throw new HttpError(403, "Turn on \u201CShare my connection\u201D first. It's separate from using N\xF8de.");
        }
        const b = await body(req);
        const kind = b.kind;
        if (!HOTSPOT_KINDS.includes(kind)) throw new HttpError(400, `kind must be one of ${HOTSPOT_KINDS.join(", ")}.`);
        const h = await store.addHotspot(p.cid, {
          name: text(b.name, 60, "name"),
          kind,
          ssid: text(b.ssid ?? "N\xF8de", 32, "ssid"),
          lat: num(b.lat, -90, 90, "lat"),
          lng: num(b.lng, -180, 180, "lng"),
          limits: limitsPatch(b.limits)
        }, now());
        return json(201, { hotspot: h });
      }
      const hm = /^\/api\/me\/hotspots\/(hs_[A-Za-z0-9_-]{6,20})(\/activity)?$/.exec(path);
      if (hm && !hm[2] && m === "PATCH") {
        const b = await body(req);
        const h = await store.updateHotspot(hm[1], p.cid, {
          name: b.name == null ? void 0 : text(b.name, 60, "name"),
          active: b.active == null ? void 0 : Boolean(b.active),
          limits: limitsPatch(b.limits)
        }, now());
        if (!h) throw new HttpError(404, "No such hotspot.");
        return json(200, { hotspot: h });
      }
      if (hm && hm[2] && m === "GET") {
        if (!await store.hotspot(hm[1], p.cid)) throw new HttpError(404, "No such hotspot.");
        const to = now();
        return json(200, await store.venueReport(hm[1], to - 7 * 864e5, to));
      }
    }
    throw new HttpError(404, "Not found.");
  }
  __name(api, "api");
  return /* @__PURE__ */ __name(async function handle(req) {
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
  }, "handle");
}
__name(createApp, "createApp");

// src/worker.ts
var cached = null;
var worker_default = {
  async fetch(req, env) {
    if (!cached || cached.db !== env.DB) {
      const store = openStore(d1(env.DB));
      cached = { db: env.DB, store, handle: createApp({ store, env }) };
    }
    const r = await cached.handle(req);
    return r ?? env.ASSETS.fetch(req);
  }
};
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
