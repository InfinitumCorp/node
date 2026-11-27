import type { LedgerEntry, Purpose } from "./consent.ts";
import { geohash, geohashCenter, hourOf, percentile, roundCount, suppress } from "./privacy.ts";
import { SCHEMA, type Sql } from "./sql.ts";

/**
 * Storage. Two worlds that never join:
 *  - identity: accounts (keyed by Cumulus ID), the consent ledger, hosts and their hotspots;
 *  - analytics: samples keyed by a rotating random session id, a geohash cell and an hour.
 * No analytics table has an account column, and no report reads the identity tables.
 * Runs on D1 in production and node:sqlite locally (see sql.ts).
 */

export type HotspotKind = "home" | "business" | "relay" | "gateway" | "phone";
export const HOTSPOT_KINDS: readonly HotspotKind[] = ["home", "business", "relay", "gateway", "phone"];

export interface HostLimits {
  /** Max share of the uplink guests may use, Mbit/s. */
  maxMbps: number;
  /** Guests stop for the day after this many MB. */
  dailyMb: number;
  /** Phones: stop sharing below this battery %. */
  minBatteryPct: number;
  /** Phones and routers: stop above this temperature, °C. */
  maxTempC: number;
  /** Hours of the day (0-23, local) sharing is on; empty = always. */
  hours: number[];
  /** Guests always on an isolated network, never the host's LAN. Not switchable. */
  guestIsolation: true;
}

export const DEFAULT_LIMITS: HostLimits = { maxMbps: 10, dailyMb: 2048, minBatteryPct: 40, maxTempC: 42, hours: [], guestIsolation: true };

/** A Nøde router paired to a hotspot. It reads the hotspot's switch and limits with its own key. */
export interface Router {
  id: string;
  hotspot: string;
  name: string;
  createdAt: number;
  lastSeen: number | null;
  /** What the router last reported: "sharing", or why it isn't ("stopped by host", "too hot (86°C)", ...). */
  state: string | null;
  tempC: number | null;
  /** Guest data today, MB. The host's own figure; never per guest. */
  usedMb: number | null;
}

export const MAX_ROUTERS_PER_HOTSPOT = 10;
/** Routers check in every 5 minutes; three missed check-ins and the hotspot leaves the public map. */
export const ROUTER_LIVE_MS = 20 * 60_000;

export interface Hotspot {
  id: string;
  name: string;
  kind: HotspotKind;
  ssid: string;
  area: string;
  lat: number;
  lng: number;
  active: boolean;
  limits: HostLimits;
  owner?: string;
  updatedAt: number;
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const id = (prefix: string) => `${prefix}_${random(9)}`;
export async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

type Row = Record<string, unknown>;

export function openStore(sql: Sql) {
  let ready: Promise<void> | null = null;
  const init = () => (ready ??= sql.batch(SCHEMA).catch((e) => { ready = null; throw e; }));

  const toHotspot = (r: Row, withOwner = false): Hotspot => {
    const c = geohashCenter(String(r.area));
    return {
      id: String(r.id), name: String(r.name), kind: r.kind as HotspotKind, ssid: String(r.ssid), area: String(r.area),
      lat: c.lat, lng: c.lng, active: Boolean(r.active), limits: JSON.parse(String(r.limits)) as HostLimits,
      updatedAt: Number(r.updated_at), ...(withOwner ? { owner: String(r.owner) } : {}),
    };
  };

  const toRouter = (r: Row): Router => ({
    id: String(r.id), hotspot: String(r.hotspot), name: String(r.name), createdAt: Number(r.created_at),
    lastSeen: r.last_seen == null ? null : Number(r.last_seen), state: r.state == null ? null : String(r.state),
    tempC: r.temp_c == null ? null : Number(r.temp_c), usedMb: r.used_mb == null ? null : Number(r.used_mb),
  });

  const store = {
    init,

    // ---- identity ----
    async ensureAccount(cid: string, jurisdiction?: string, now = Date.now()) {
      await init();
      await sql.run("INSERT INTO accounts (cid, jurisdiction, created_at) VALUES (?, ?, ?) ON CONFLICT(cid) DO NOTHING", cid, jurisdiction ?? "OTHER", now);
      if (jurisdiction) await sql.run("UPDATE accounts SET jurisdiction = ? WHERE cid = ?", jurisdiction, cid);
      return (await sql.get<{ cid: string; jurisdiction: string }>("SELECT cid, jurisdiction FROM accounts WHERE cid = ?", cid))!;
    },
    async ledger(cid: string): Promise<LedgerEntry[]> {
      await init();
      return (await sql.all("SELECT purpose, granted, policy, at FROM consent_ledger WHERE cid = ? ORDER BY seq", cid))
        .map((r) => ({ purpose: r.purpose as Purpose, granted: Boolean(r.granted), policy: String(r.policy), at: Number(r.at) }));
    },
    async record(cid: string, purpose: Purpose, granted: boolean, policy: string, now = Date.now()) {
      await init();
      await sql.run("INSERT INTO consent_ledger (cid, purpose, granted, policy, at) VALUES (?, ?, ?, ?, ?)", cid, purpose, granted ? 1 : 0, policy, now);
    },
    /** Erase a person: account, ledger and hotspots. Analytics were never linked to them. */
    async forget(cid: string) {
      await init();
      await sql.run("DELETE FROM consent_ledger WHERE cid = ?", cid);
      await sql.run("DELETE FROM routers WHERE owner = ?", cid);
      await sql.run("DELETE FROM hotspots WHERE owner = ?", cid);
      await sql.run("DELETE FROM accounts WHERE cid = ?", cid);
    },

    // ---- hotspots ----
    async addHotspot(owner: string, h: { name: string; kind: HotspotKind; ssid: string; lat: number; lng: number; limits?: Partial<HostLimits> }, now = Date.now()): Promise<Hotspot> {
      await init();
      const hid = id("hs");
      const limits = { ...DEFAULT_LIMITS, ...h.limits, guestIsolation: true as const };
      // Stored to about 150 m only: a host's exact address is never kept.
      await sql.run("INSERT INTO hotspots (id, owner, name, kind, ssid, area, active, limits, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)",
        hid, owner, h.name, h.kind, h.ssid, geohash(h.lat, h.lng, 7), JSON.stringify(limits), now);
      return (await store.hotspot(hid, owner))!;
    },
    async hotspot(hid: string, owner?: string): Promise<Hotspot | null> {
      await init();
      const r = await sql.get("SELECT * FROM hotspots WHERE id = ?", hid);
      if (!r || (owner && r.owner !== owner)) return null;
      return toHotspot(r, Boolean(owner));
    },
    async myHotspots(owner: string): Promise<Hotspot[]> {
      await init();
      return (await sql.all("SELECT * FROM hotspots WHERE owner = ? ORDER BY updated_at DESC", owner)).map((r) => toHotspot(r, true));
    },
    async updateHotspot(hid: string, owner: string, patch: { name?: string; active?: boolean; limits?: Partial<HostLimits> }, now = Date.now()): Promise<Hotspot | null> {
      const cur = await store.hotspot(hid, owner);
      if (!cur) return null;
      const limits = { ...cur.limits, ...patch.limits, guestIsolation: true as const };
      await sql.run("UPDATE hotspots SET name = ?, active = ?, limits = ?, updated_at = ? WHERE id = ? AND owner = ?",
        patch.name ?? cur.name, (patch.active ?? cur.active) ? 1 : 0, JSON.stringify(limits), now, hid, owner);
      return store.hotspot(hid, owner);
    },
    /**
     * Public discovery: active hotspots in the given geohash cells (prefix match).
     * A hotspot with paired routers is listed only while one of them has reported "sharing" within
     * ROUTER_LIVE_MS, so a router that lost power or hit its limit drops off the map; those are
     * marked verified. Hotspots without routers (venue Wi-Fi, phones) are listed on the host's word.
     */
    async nearby(cells: string[], now = Date.now()): Promise<(Hotspot & { verified: boolean })[]> {
      await init();
      const out: (Hotspot & { verified: boolean })[] = [];
      const seen = new Set<string>();
      for (const c of cells) {
        const rows = await sql.all(
          `SELECT h.*, (SELECT COUNT(*) FROM routers r WHERE r.hotspot = h.id) AS n_routers,
                  (SELECT COUNT(*) FROM routers r WHERE r.hotspot = h.id AND r.last_seen >= ? AND r.state = 'sharing') AS n_live
             FROM hotspots h WHERE h.active = 1 AND h.area LIKE ? LIMIT 200`, now - ROUTER_LIVE_MS, `${c}%`);
        for (const r of rows) {
          if (seen.has(String(r.id))) continue;
          seen.add(String(r.id));
          const live = Number(r.n_live) > 0;
          if (Number(r.n_routers) > 0 && !live) continue;
          out.push({ ...toHotspot(r), verified: live });
        }
      }
      return out;
    },

    // ---- routers ----
    /** Pairs a router with a hotspot the owner runs. Returns the key once; only its hash is stored. */
    async addRouter(hotspot: string, owner: string, name: string, now = Date.now()): Promise<{ router: Router; key: string } | null> {
      if (!(await store.hotspot(hotspot, owner))) return null;
      const n = await sql.get<{ n: number }>("SELECT COUNT(*) AS n FROM routers WHERE hotspot = ?", hotspot);
      if (Number(n?.n ?? 0) >= MAX_ROUTERS_PER_HOTSPOT) throw new RangeError(`A hotspot can have up to ${MAX_ROUTERS_PER_HOTSPOT} routers.`);
      const rid = id("rt");
      const key = `nr_${random(24)}`;
      await sql.run("INSERT INTO routers (id, hotspot, owner, name, key_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        rid, hotspot, owner, name, await sha256(key), now);
      return { router: toRouter((await sql.get("SELECT * FROM routers WHERE id = ?", rid))!), key };
    },
    async routers(hotspot: string, owner: string): Promise<Router[]> {
      await init();
      return (await sql.all("SELECT * FROM routers WHERE hotspot = ? AND owner = ? ORDER BY created_at", hotspot, owner)).map(toRouter);
    },
    async removeRouter(rid: string, hotspot: string, owner: string): Promise<boolean> {
      await init();
      const r = await sql.get("SELECT id FROM routers WHERE id = ? AND hotspot = ? AND owner = ?", rid, hotspot, owner);
      if (!r) return false;
      await sql.run("DELETE FROM routers WHERE id = ?", rid);
      return true;
    },
    /** The router a key belongs to, with its hotspot. */
    async routerByKey(key: string): Promise<{ router: Router; hotspot: Hotspot } | null> {
      await init();
      if (!/^nr_[A-Za-z0-9_-]{20,64}$/.test(key)) return null;
      const r = await sql.get("SELECT * FROM routers WHERE key_hash = ?", await sha256(key));
      if (!r) return null;
      const h = await store.hotspot(String(r.hotspot), String(r.owner));
      return h ? { router: toRouter(r), hotspot: h } : null;
    },
    async routerSeen(rid: string, report: { state?: string; tempC?: number; usedMb?: number } | null, now = Date.now()) {
      await init();
      if (!report) return void (await sql.run("UPDATE routers SET last_seen = ? WHERE id = ?", now, rid));
      await sql.run("UPDATE routers SET last_seen = ?, state = ?, temp_c = ?, used_mb = ? WHERE id = ?",
        now, report.state ?? null, report.tempC ?? null, report.usedMb ?? null, rid);
    },

    // ---- analytics (anonymous) ----
    async addQualitySample(s: { hotspot: string; session: string; downMbps?: number; upMbps?: number; latencyMs?: number; ok: boolean }, now = Date.now()) {
      await init();
      const h = await sql.get<{ area: string }>("SELECT area FROM hotspots WHERE id = ?", s.hotspot);
      if (!h) return false;
      await sql.run("INSERT INTO quality_samples (hotspot, area, hour, session, down_mbps, up_mbps, latency_ms, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        s.hotspot, h.area.slice(0, 5), hourOf(now), await sha256(s.session), s.downMbps ?? null, s.upMbps ?? null, s.latencyMs ?? null, s.ok ? 1 : 0);
      return true;
    },
    async addVenueSession(hotspot: string, session: string, now = Date.now()) {
      await init();
      const h = await sql.get<{ kind: string }>("SELECT kind FROM hotspots WHERE id = ?", hotspot);
      if (!h || h.kind !== "business") return false;
      await sql.run("INSERT OR IGNORE INTO venue_sessions (hotspot, hour, session) VALUES (?, ?, ?)", hotspot, hourOf(now), await sha256(session));
      return true;
    },

    // ---- buyers and reports ----
    async addBuyer(name: string, products: string[], license: string, now = Date.now()) {
      await init();
      const key = `nb_${random(24)}`;
      await sql.run("INSERT INTO buyers (key_hash, name, products, license, created_at) VALUES (?, ?, ?, ?, ?)", await sha256(key), name, JSON.stringify(products), license, now);
      return key; // shown once
    },
    async buyer(key: string): Promise<{ name: string; products: string[]; license: string } | null> {
      await init();
      const r = await sql.get("SELECT name, products, license FROM buyers WHERE key_hash = ?", await sha256(key));
      return r ? { name: String(r.name), products: JSON.parse(String(r.products)) as string[], license: String(r.license) } : null;
    },
    async logReport(buyer: string, product: string, query: string, rows: number, suppressed: number, now = Date.now()) {
      await init();
      await sql.run("INSERT INTO report_log (buyer, product, query, rows, suppressed, at) VALUES (?, ?, ?, ?, ?, ?)", buyer, product, query, rows, suppressed, now);
    },

    async connectivityReport(area: string, from: number, to: number) {
      await init();
      const rows = await sql.all(`SELECT area, hour, session, down_mbps, up_mbps, latency_ms, ok FROM quality_samples
        WHERE area LIKE ? AND hour >= ? AND hour < ?`, `${area}%`, hourOf(from), to);
      const groups = new Map<string, { area: string; hour: number; sessions: Set<string>; down: number[]; up: number[]; lat: number[]; ok: number; n: number }>();
      for (const r of rows) {
        const k = `${r.area}|${r.hour}`;
        let g = groups.get(k);
        if (!g) groups.set(k, (g = { area: String(r.area), hour: Number(r.hour), sessions: new Set(), down: [], up: [], lat: [], ok: 0, n: 0 }));
        g.sessions.add(String(r.session));
        if (r.down_mbps != null) g.down.push(Number(r.down_mbps));
        if (r.up_mbps != null) g.up.push(Number(r.up_mbps));
        if (r.latency_ms != null) g.lat.push(Number(r.latency_ms));
        g.ok += Number(r.ok); g.n++;
      }
      const all = [...groups.values()].map((g) => ({
        key: `${g.area}|${g.hour}`, sessions: g.sessions.size, area: g.area, hour: new Date(g.hour).toISOString(),
        medianDownMbps: percentile(g.down, 50), p90LatencyMs: percentile(g.lat, 90), medianUpMbps: percentile(g.up, 50),
        successRate: g.n ? Math.round((g.ok / g.n) * 1000) / 1000 : null,
      }));
      const { rows: kept, suppressed } = suppress(all);
      return { rows: kept.map(({ key: _k, sessions, ...r }) => ({ ...r, sessions: roundCount(sessions) })), suppressed };
    },

    async venueReport(hotspot: string, from: number, to: number) {
      await init();
      const all = (await sql.all("SELECT hour, COUNT(*) AS sessions FROM venue_sessions WHERE hotspot = ? AND hour >= ? AND hour < ? GROUP BY hour ORDER BY hour",
        hotspot, hourOf(from), to)).map((r) => ({ key: Number(r.hour), sessions: Number(r.sessions) }));
      const { rows, suppressed } = suppress(all);
      return { rows: rows.map((r) => ({ hour: new Date(r.key).toISOString(), sessions: roundCount(r.sessions) })), suppressed };
    },
  };
  return store;
}

export type Store = ReturnType<typeof openStore>;
