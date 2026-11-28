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

test("a paired router that checks in too often gets 429, other routers don't", async () => {
  const store = openStore(nodeSqlite());
  const router = counter(2);
  const app = createApp({ store, env: {}, verify: async (t) => (t.startsWith("cid_") ? { cid: t } : null), limits: { router } });
  const call = async (method: string, path: string, body?: unknown, auth?: string) =>
    (await app(new Request(`https://node.test${path}`, { method, headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })))!;
  await call("PUT", "/api/me/consent", { choices: { host_bandwidth: true } }, "cid_host");
  const h = await (await call("POST", "/api/me/hotspots", { name: "Café", kind: "business", lat: 55.75, lng: 37.62 }, "cid_host")).json() as any;
  const a = await (await call("POST", `/api/me/hotspots/${h.hotspot.id}/routers`, {}, "cid_host")).json() as any;
  const b = await (await call("POST", `/api/me/hotspots/${h.hotspot.id}/routers`, {}, "cid_host")).json() as any;
  assert.equal((await call("GET", "/api/router/config", undefined, a.key)).status, 200);
  assert.equal((await call("POST", "/api/router/status", { state: "sharing" }, a.key)).status, 204);
  assert.equal((await call("GET", "/api/router/config", undefined, a.key)).status, 429);
  assert.equal((await call("GET", "/api/router/config", undefined, b.key)).status, 200);
  assert.equal((await call("GET", "/api/router/config", undefined, "nr_wrongwrongwrongwrongwrong")).status, 401);
});

test("through the mirror a signed per-client id stands in for the address; forged ones are ignored", async () => {
  // @ts-ignore: plain ESM
  const { clientTag } = await import("../mirror/server.mjs");
  const secret = "test-mirror-secret-0123456789abcdef";
  const ip = counter(1), hotspot = counter(100);
  const app = createApp({ store: openStore(nodeSqlite()), env: { NODE_MIRROR_SECRET: secret }, verify: async () => null, limits: { ip, hotspot } });
  const send = async (tag: string) => (await app(post({ kind: "visit", hotspot: "hs_one", session: "s" }, { "x-node-mirror": "ru", "x-node-mirror-client": tag })))!.status;

  const tag = clientTag("198.51.100.7", secret);
  assert.equal(await send(tag), 404);
  assert.equal(await send(tag), 429, "the same phone is limited");
  assert.equal(await send(clientTag("198.51.100.8", secret)), 404, "another phone has its own budget");
  const forged = clientTag("198.51.100.9", "not-the-secret");
  const before = ip.keys.length;
  assert.equal(await send(forged), 404);
  assert.equal(ip.keys.length, before, "a forged tag is not used as a key");
  assert.ok(ip.keys.every((k) => k.startsWith("ip:ru:") && !k.includes("198.51")), "addresses never reach Nøde");
});
