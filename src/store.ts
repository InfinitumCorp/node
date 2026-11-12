import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import type { LedgerEntry, Purpose } from "./consent.ts";
import { geohash, geohashCenter, hourOf, percentile, roundCount, suppress } from "./privacy.ts";

/**
 * Storage. Two worlds that never join:
 *  - identity: accounts (keyed by Cumulus ID), the consent ledger, hosts and their hotspots;
 *  - analytics: samples keyed by a rotating random session id, a geohash cell and an hour.
 * No analytics table has an account column, and no report reads the identity tables.
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

const id = (prefix: string) => `${prefix}_${randomBytes(9).toString("base64url")}`;
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function openStore(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS accounts (cid TEXT PRIMARY KEY, jurisdiction TEXT NOT NULL DEFAULT 'OTHER', created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS consent_ledger (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, cid TEXT NOT NULL, purpose TEXT NOT NULL,
      granted INTEGER NOT NULL, policy TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS consent_by_cid ON consent_ledger(cid);
    CREATE TABLE IF NOT EXISTS hotspots (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, ssid TEXT NOT NULL,
      area TEXT NOT NULL, active INTEGER NOT NULL, limits TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS hotspots_by_area ON hotspots(area);
    -- analytics: no account column, ever
    CREATE TABLE IF NOT EXISTS quality_samples (
      hotspot TEXT NOT NULL, area TEXT NOT NULL, hour INTEGER NOT NULL, session TEXT NOT NULL,
      down_mbps REAL, up_mbps REAL, latency_ms REAL, ok INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS quality_by_area_hour ON quality_samples(area, hour);
    CREATE TABLE IF NOT EXISTS venue_sessions (hotspot TEXT NOT NULL, hour INTEGER NOT NULL, session TEXT NOT NULL,
      PRIMARY KEY (hotspot, hour, session));
    CREATE TABLE IF NOT EXISTS buyers (key_hash TEXT PRIMARY KEY, name TEXT NOT NULL, products TEXT NOT NULL,
      license TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS report_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, buyer TEXT NOT NULL, product TEXT NOT NULL,
      query TEXT NOT NULL, rows INTEGER NOT NULL, suppressed INTEGER NOT NULL, at INTEGER NOT NULL);
  `);

  const toHotspot = (r: Record<string, unknown>, withOwner = false): Hotspot => {
    const c = geohashCenter(String(r.area));
    return {
      id: String(r.id), name: String(r.name), kind: r.kind as HotspotKind, ssid: String(r.ssid), area: String(r.area),
      lat: c.lat, lng: c.lng, active: Boolean(r.active), limits: JSON.parse(String(r.limits)) as HostLimits,
      updatedAt: Number(r.updated_at), ...(withOwner ? { owner: String(r.owner) } : {}),
    };
  };

  return {
    db,

    // ---- identity ----
    ensureAccount(cid: string, jurisdiction?: string, now = Date.now()) {
      db.prepare("INSERT INTO accounts (cid, jurisdiction, created_at) VALUES (?, ?, ?) ON CONFLICT(cid) DO NOTHING").run(cid, jurisdiction ?? "OTHER", now);
      if (jurisdiction) db.prepare("UPDATE accounts SET jurisdiction = ? WHERE cid = ?").run(jurisdiction, cid);
      return db.prepare("SELECT cid, jurisdiction FROM accounts WHERE cid = ?").get(cid) as { cid: string; jurisdiction: string };
    },
    ledger(cid: string): LedgerEntry[] {
      return (db.prepare("SELECT purpose, granted, policy, at FROM consent_ledger WHERE cid = ? ORDER BY seq").all(cid) as Record<string, unknown>[])
        .map((r) => ({ purpose: r.purpose as Purpose, granted: Boolean(r.granted), policy: String(r.policy), at: Number(r.at) }));
    },
    record(cid: string, purpose: Purpose, granted: boolean, policy: string, now = Date.now()) {
      db.prepare("INSERT INTO consent_ledger (cid, purpose, granted, policy, at) VALUES (?, ?, ?, ?, ?)").run(cid, purpose, granted ? 1 : 0, policy, now);
    },
    /** Erase a person: account, ledger and hotspots. Analytics were never linked to them. */
    forget(cid: string) {
      db.prepare("DELETE FROM consent_ledger WHERE cid = ?").run(cid);
      db.prepare("DELETE FROM hotspots WHERE owner = ?").run(cid);
      db.prepare("DELETE FROM accounts WHERE cid = ?").run(cid);
    },

    // ---- hotspots ----
    addHotspot(owner: string, h: { name: string; kind: HotspotKind; ssid: string; lat: number; lng: number; limits?: Partial<HostLimits> }, now = Date.now()): Hotspot {
      const hid = id("hs");
      const limits = { ...DEFAULT_LIMITS, ...h.limits, guestIsolation: true as const };
      // Stored at public precision only: a host's exact address is never kept.
      db.prepare("INSERT INTO hotspots (id, owner, name, kind, ssid, area, active, limits, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)")
        .run(hid, owner, h.name, h.kind, h.ssid, geohash(h.lat, h.lng, 7), JSON.stringify(limits), now);
      return this.hotspot(hid, owner)!;
    },
    hotspot(hid: string, owner?: string): Hotspot | null {
      const r = db.prepare("SELECT * FROM hotspots WHERE id = ?").get(hid) as Record<string, unknown> | undefined;
      if (!r || (owner && r.owner !== owner)) return null;
      return toHotspot(r, Boolean(owner));
    },
    myHotspots(owner: string): Hotspot[] {
      return (db.prepare("SELECT * FROM hotspots WHERE owner = ? ORDER BY updated_at DESC").all(owner) as Record<string, unknown>[]).map((r) => toHotspot(r, true));
    },
    updateHotspot(hid: string, owner: string, patch: { name?: string; active?: boolean; limits?: Partial<HostLimits> }, now = Date.now()): Hotspot | null {
      const cur = this.hotspot(hid, owner);
      if (!cur) return null;
      const limits = { ...cur.limits, ...patch.limits, guestIsolation: true as const };
      db.prepare("UPDATE hotspots SET name = ?, active = ?, limits = ?, updated_at = ? WHERE id = ? AND owner = ?")
        .run(patch.name ?? cur.name, (patch.active ?? cur.active) ? 1 : 0, JSON.stringify(limits), now, hid, owner);
      return this.hotspot(hid, owner);
    },
    /** Public discovery: active hotspots in the given geohash cells (prefix match). */
    nearby(cells: string[]): Hotspot[] {
      const out: Hotspot[] = [];
      const q = db.prepare("SELECT * FROM hotspots WHERE active = 1 AND area LIKE ? LIMIT 200");
      for (const c of cells) for (const r of q.all(`${c}%`) as Record<string, unknown>[]) out.push(toHotspot(r));
      return out;
    },

    // ---- analytics (anonymous) ----
    addQualitySample(s: { hotspot: string; session: string; downMbps?: number; upMbps?: number; latencyMs?: number; ok: boolean }, now = Date.now()) {
      const h = db.prepare("SELECT area FROM hotspots WHERE id = ?").get(s.hotspot) as { area: string } | undefined;
      if (!h) return false;
      db.prepare("INSERT INTO quality_samples (hotspot, area, hour, session, down_mbps, up_mbps, latency_ms, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(s.hotspot, h.area.slice(0, 5), hourOf(now), sha256(s.session), s.downMbps ?? null, s.upMbps ?? null, s.latencyMs ?? null, s.ok ? 1 : 0);
      return true;
    },
    addVenueSession(hotspot: string, session: string, now = Date.now()) {
      const h = db.prepare("SELECT kind FROM hotspots WHERE id = ?").get(hotspot) as { kind: string } | undefined;
      if (!h || h.kind !== "business") return false;
      db.prepare("INSERT OR IGNORE INTO venue_sessions (hotspot, hour, session) VALUES (?, ?, ?)").run(hotspot, hourOf(now), sha256(session));
      return true;
    },

    // ---- buyers and reports ----
    addBuyer(name: string, products: string[], license: string, now = Date.now()) {
      const key = `nb_${randomBytes(24).toString("base64url")}`;
      db.prepare("INSERT INTO buyers (key_hash, name, products, license, created_at) VALUES (?, ?, ?, ?, ?)").run(sha256(key), name, JSON.stringify(products), license, now);
      return key; // shown once
    },
    buyer(key: string): { name: string; products: string[]; license: string } | null {
      const r = db.prepare("SELECT name, products, license FROM buyers WHERE key_hash = ?").get(sha256(key)) as Record<string, unknown> | undefined;
      return r ? { name: String(r.name), products: JSON.parse(String(r.products)) as string[], license: String(r.license) } : null;
    },
    logReport(buyer: string, product: string, query: string, rows: number, suppressed: number, now = Date.now()) {
      db.prepare("INSERT INTO report_log (buyer, product, query, rows, suppressed, at) VALUES (?, ?, ?, ?, ?, ?)").run(buyer, product, query, rows, suppressed, now);
    },

    connectivityReport(area: string, from: number, to: number) {
      const rows = db.prepare(`SELECT area, hour, session, down_mbps, up_mbps, latency_ms, ok FROM quality_samples
        WHERE area LIKE ? AND hour >= ? AND hour < ?`).all(`${area}%`, hourOf(from), to) as Record<string, unknown>[];
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

    venueReport(hotspot: string, from: number, to: number) {
      const all = (db.prepare(`SELECT hour, COUNT(*) AS sessions FROM venue_sessions WHERE hotspot = ? AND hour >= ? AND hour < ? GROUP BY hour ORDER BY hour`)
        .all(hotspot, hourOf(from), to) as Record<string, unknown>[])
        .map((r) => ({ key: Number(r.hour), sessions: Number(r.sessions) }));
      const { rows, suppressed } = suppress(all);
      return { rows: rows.map((r) => ({ hour: new Date(r.key).toISOString(), sessions: roundCount(r.sessions) })), suppressed };
    },
  };
}

export type Store = ReturnType<typeof openStore>;
