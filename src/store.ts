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
    /** Public discovery: active hotspots in the given geohash cells (prefix match). */
    async nearby(cells: string[]): Promise<Hotspot[]> {
      await init();
      const out: Hotspot[] = [];
      for (const c of cells) for (const r of await sql.all("SELECT * FROM hotspots WHERE active = 1 AND area LIKE ? LIMIT 200", `${c}%`)) out.push(toHotspot(r));
      return out;
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
