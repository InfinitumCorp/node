import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.ts";
import { nodeSqlite } from "../src/sqlite-node.ts";
import { openStore } from "../src/store.ts";

/** A counter like the Workers rate-limiting binding: `max` calls per key, then false. */
const counter = (max: number) => {
  const seen = new Map<string, number>();
  const keys: string[] = [];
  const fn = async (key: string) => { keys.push(key); const n = (seen.get(key) ?? 0) + 1; seen.set(key, n); return n <= max; };
  return Object.assign(fn, { keys });
};

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://node.test/api/telemetry", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("anonymous telemetry is rate limited per address and per hotspot", async () => {
  const ip = counter(2), hotspot = counter(3);
  const app = createApp({ store: openStore(nodeSqlite()), env: {}, verify: async () => null, limits: { ip, hotspot } });
  const send = async (h: string, from: string) => (await app(post({ kind: "visit", hotspot: h, session: "s" }, { "cf-connecting-ip": from })))!.status;

  assert.equal(await send("hs_one", "203.0.113.1"), 404); // under the limits: unknown hotspot
  assert.equal(await send("hs_one", "203.0.113.1"), 404);
  const third = await app(post({ kind: "visit", hotspot: "hs_one", session: "s" }, { "cf-connecting-ip": "203.0.113.1" }));
  assert.equal(third!.status, 429);
  assert.equal(third!.headers.get("retry-after"), "60");
  assert.equal(await send("hs_one", "203.0.113.2"), 429); // another address, but hs_one is at its limit
  assert.equal(await send("hs_two", "203.0.113.2"), 404);
  assert.ok(ip.keys.every((k) => k.startsWith("ip:")) && hotspot.keys.every((k) => k.startsWith("hs:")));
});

test("through the Russian mirror only the per-hotspot limit applies (addresses are hidden)", async () => {
  const ip = counter(0), hotspot = counter(100);
  const app = createApp({ store: openStore(nodeSqlite()), env: {}, verify: async () => null, limits: { ip, hotspot } });
  const r = await app(post({ kind: "visit", hotspot: "hs_one", session: "s" }, { "x-node-mirror": "ru", "cf-connecting-ip": "198.51.100.9" }));
  assert.equal(r!.status, 404);
  assert.equal(ip.keys.length, 0);
});
