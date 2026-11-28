/**
 * The small SQL surface the store needs, so the same queries run on Cloudflare D1 (production) and
 * on node:sqlite (local runs and tests). Both are SQLite.
 */
export interface Sql {
  run(sql: string, ...args: unknown[]): Promise<void>;
  get<T = Record<string, unknown>>(sql: string, ...args: unknown[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, ...args: unknown[]): Promise<T[]>;
  /** Several statements at once (schema). */
  batch(statements: string[]): Promise<void>;
}

/** Cloudflare D1 binding, typed loosely so this file needs no Workers types. */
export interface D1Like {
  prepare(sql: string): { bind(...args: unknown[]): { run(): Promise<unknown>; first<T>(): Promise<T | null>; all<T>(): Promise<{ results: T[] }> } };
  batch(statements: unknown[]): Promise<unknown>;
}

export function d1(db: D1Like): Sql {
  const bind = (sql: string, args: unknown[]) => db.prepare(sql).bind(...args.map((a) => (a === undefined ? null : a)));
  return {
    async run(sql, ...args) { await bind(sql, args).run(); },
    async get(sql, ...args) { return ((await bind(sql, args).first()) ?? undefined) as never; },
    async all(sql, ...args) { return (await bind(sql, args).all()).results as never; },
    async batch(statements) { await db.batch(statements.map((s) => db.prepare(s).bind())); },
  };
}

export const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS accounts (cid TEXT PRIMARY KEY, jurisdiction TEXT NOT NULL DEFAULT 'OTHER', created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS consent_ledger (seq INTEGER PRIMARY KEY AUTOINCREMENT, cid TEXT NOT NULL, purpose TEXT NOT NULL,
    granted INTEGER NOT NULL, policy TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS consent_by_cid ON consent_ledger(cid)`,
  `CREATE TABLE IF NOT EXISTS hotspots (id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, ssid TEXT NOT NULL,
    area TEXT NOT NULL, active INTEGER NOT NULL, limits TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS hotspots_by_area ON hotspots(area)`,
  // Nøde routers paired to a hotspot. Only the key's hash is kept; the key is shown once.
  `CREATE TABLE IF NOT EXISTS routers (id TEXT PRIMARY KEY, hotspot TEXT NOT NULL, owner TEXT NOT NULL, name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_seen INTEGER, state TEXT, temp_c INTEGER, used_mb INTEGER)`,
  `CREATE INDEX IF NOT EXISTS routers_by_hotspot ON routers(hotspot)`,
  // A host's "pause for a while": the hotspot counts as stopped until then, and starts again by itself.
  `CREATE TABLE IF NOT EXISTS hotspot_pauses (hotspot TEXT PRIMARY KEY, until INTEGER NOT NULL)`,
  // Guest MB a router shared per router-day (it resets at the router's local midnight). The host's own figures.
  `CREATE TABLE IF NOT EXISTS router_days (router TEXT NOT NULL, started_at INTEGER NOT NULL, last_at INTEGER NOT NULL, used_mb INTEGER NOT NULL,
    PRIMARY KEY (router, started_at))`,
  // analytics: no account column, ever
  `CREATE TABLE IF NOT EXISTS quality_samples (hotspot TEXT NOT NULL, area TEXT NOT NULL, hour INTEGER NOT NULL, session TEXT NOT NULL,
    down_mbps REAL, up_mbps REAL, latency_ms REAL, ok INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS quality_by_area_hour ON quality_samples(area, hour)`,
  `CREATE TABLE IF NOT EXISTS venue_sessions (hotspot TEXT NOT NULL, hour INTEGER NOT NULL, session TEXT NOT NULL, PRIMARY KEY (hotspot, hour, session))`,
  `CREATE TABLE IF NOT EXISTS buyers (key_hash TEXT PRIMARY KEY, name TEXT NOT NULL, products TEXT NOT NULL, license TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS report_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, buyer TEXT NOT NULL, product TEXT NOT NULL,
    query TEXT NOT NULL, rows INTEGER NOT NULL, suppressed INTEGER NOT NULL, at INTEGER NOT NULL)`,
];
