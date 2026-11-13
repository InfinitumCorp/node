// node:sqlite adapter for local runs and tests. Never imported by the Worker.
import { DatabaseSync } from "node:sqlite";
import type { Sql } from "./sql.ts";

export function nodeSqlite(path = ":memory:"): Sql {
  const db = new DatabaseSync(path);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  const args = (a: unknown[]) => a.map((x) => (x === undefined ? null : x)) as never[];
  return {
    async run(sql, ...a) { db.prepare(sql).run(...args(a)); },
    async get(sql, ...a) { return db.prepare(sql).get(...args(a)) as never; },
    async all(sql, ...a) { return db.prepare(sql).all(...args(a)) as never; },
    async batch(statements) { for (const s of statements) db.exec(s); },
  };
}
