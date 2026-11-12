import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/server.ts";
import { openStore } from "../src/store.ts";
import { geohash, geohashCenter, suppress } from "../src/privacy.ts";
import { currentConsent, jurisdiction } from "../src/consent.ts";

const T0 = Date.parse("2026-11-12T10:00:00Z");

async function boot() {
  const store = openStore(":memory:");
  let clock = T0;
  const { handler } = createApp({
    store,
    env: {},
    now: () => clock,
    verify: async (t) => (t.startsWith("cid_") ? { cid: t } : null),
  });
  const srv = createServer(handler);
  await new Promise<void>((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, opts: { as?: string; body?: unknown; key?: string } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.as) headers.authorization = `Bearer ${opts.as}`;
    if (opts.key) headers["x-node-buyer-key"] = opts.key;
    const r = await fetch(base + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    return { status: r.status, json: (await r.json()) as any };
  };
  return { store, call, close: () => srv.close(), tick: (ms: number) => (clock += ms) };
}

test("geohash round-trips to the same cell", () => {
  const h = geohash(51.5072, -0.1276, 5);
  assert.equal(h, "gcpvj");
  const c = geohashCenter(h);
  assert.equal(geohash(c.lat, c.lng, 5), h);
});

test("small groups are suppressed", () => {
  const r = suppress([{ key: "a", sessions: 9 }, { key: "b", sessions: 10 }]);
  assert.deepEqual(r.rows.map((x) => x.key), ["b"]);
  assert.equal(r.suppressed, 1);
});

test("EU defaults every optional purpose off; US-CA defaults aggregates on with opt-out", () => {
  const eu = currentConsent([], jurisdiction("EU"));
  assert.equal(eu.service.granted, true);
  assert.equal(eu.network_quality.granted, false);
  assert.equal(eu.research.granted, false);
  const ca = currentConsent([], jurisdiction("us-ca"));
  assert.equal(ca.network_quality.granted, true);
  assert.equal(ca.research.granted, false);
  assert.equal(ca.host_bandwidth.granted, false);
  for (const j of ["EU", "GB", "US", "US-CA", "RU", "OTHER"]) assert.equal(jurisdiction(j).conditionalAccess, false);
});

test("me requires Cumulus ID", async () => {
  const a = await boot();
  assert.equal((await a.call("GET", "/api/me")).status, 401);
  assert.equal((await a.call("GET", "/api/me", { as: "nope" })).status, 401);
  const me = await a.call("GET", "/api/me", { as: "cid_alice" });
  assert.equal(me.status, 200);
  assert.equal(me.json.consent.research.granted, false);
  a.close();
});

test("hosting is a separate choice; turning it off stops hotspots", async () => {
  const a = await boot();
  const spot = { name: "Corner Café", kind: "business", ssid: "Nøde Café", lat: 51.5072, lng: -0.1276 };
  assert.equal((await a.call("POST", "/api/me/hotspots", { as: "cid_bob", body: spot })).status, 403);
  await a.call("PUT", "/api/me/consent", { as: "cid_bob", body: { jurisdiction: "GB", choices: { host_bandwidth: true } } });
  const made = await a.call("POST", "/api/me/hotspots", { as: "cid_bob", body: { ...spot, limits: { maxMbps: 20, hours: [8, 9, 9, 22] } } });
  assert.equal(made.status, 201);
  assert.equal(made.json.hotspot.active, false, "new hotspots start stopped");
  assert.deepEqual(made.json.hotspot.limits.hours, [8, 9, 22]);
  assert.equal(made.json.hotspot.limits.guestIsolation, true);
  const id = made.json.hotspot.id;

  const bad = await a.call("PATCH", `/api/me/hotspots/${id}`, { as: "cid_bob", body: { limits: { guestIsolation: false } } });
  assert.equal(bad.status, 400);
  assert.equal((await a.call("PATCH", `/api/me/hotspots/${id}`, { as: "cid_eve", body: { active: true } })).status, 404);
  assert.equal((await a.call("PATCH", `/api/me/hotspots/${id}`, { as: "cid_bob", body: { active: true } })).json.hotspot.active, true);

  const near = await a.call("GET", "/api/hotspots?lat=51.51&lng=-0.13");
  assert.equal(near.json.hotspots.length, 1);
  assert.equal(near.json.hotspots[0].owner, undefined, "public listing never names the host");

  await a.call("PUT", "/api/me/consent", { as: "cid_bob", body: { choices: { host_bandwidth: false } } });
  assert.equal((await a.call("GET", "/api/hotspots?lat=51.51&lng=-0.13")).json.hotspots.length, 0);
  a.close();
});

test("consent changes are appended to the ledger, not overwritten", async () => {
  const a = await boot();
  await a.call("PUT", "/api/me/consent", { as: "cid_c", body: { jurisdiction: "EU", choices: { research: true } } });
  a.tick(1000);
  const r = await a.call("PUT", "/api/me/consent", { as: "cid_c", body: { choices: { research: false, service: false } } });
  assert.equal(r.json.consent.research.granted, false);
  assert.equal(r.json.consent.service.granted, true, "necessary purpose can't be toggled");
  assert.deepEqual(a.store.ledger("cid_c").map((e) => e.granted), [true, false]);
  a.close();
});

test("reports need a licensed key, suppress small groups, and never carry identity", async () => {
  const a = await boot();
  await a.call("PUT", "/api/me/consent", { as: "cid_h", body: { choices: { host_bandwidth: true } } });
  const h = (await a.call("POST", "/api/me/hotspots", { as: "cid_h", body: { name: "Library", kind: "business", ssid: "Nøde", lat: 40.7128, lng: -74.006 } })).json.hotspot;
  for (let i = 0; i < 12; i++) {
    assert.equal((await a.call("POST", "/api/telemetry", { body: { kind: "quality", hotspot: h.id, session: `s${i}`, downMbps: 20 + i, latencyMs: 30 } })).status, 202);
    await a.call("POST", "/api/telemetry", { body: { kind: "visit", hotspot: h.id, session: `s${i}` } });
  }
  a.tick(3_600_000);
  for (let i = 0; i < 3; i++) await a.call("POST", "/api/telemetry", { body: { kind: "quality", hotspot: h.id, session: `t${i}`, downMbps: 5 } });

  const area = geohash(40.7128, -74.006, 4);
  assert.equal((await a.call("GET", `/api/reports/connectivity?area=${area}`)).status, 401);
  const venueOnly = a.store.addBuyer("Venue Co", ["venue_activity"], "LIC-2");
  assert.equal((await a.call("GET", `/api/reports/connectivity?area=${area}`, { key: venueOnly })).status, 403);

  const key = a.store.addBuyer("ISP Planning", ["connectivity", "venue_activity"], "LIC-1");
  const rep = await a.call("GET", `/api/reports/connectivity?area=${area}&from=2026-11-12T00:00:00Z&to=2026-11-13T00:00:00Z`, { key });
  assert.equal(rep.status, 200);
  assert.equal(rep.json.rows.length, 1);
  assert.equal(rep.json.suppressed, 1, "the 3-session hour is held back");
  assert.equal(rep.json.rows[0].sessions, 10, "rounded to 5");
  assert.equal(rep.json.rows[0].medianDownMbps, 25);
  const flat = JSON.stringify(rep.json);
  assert.ok(!flat.includes("cid_") && !flat.includes("s1") && !flat.includes(h.id));

  const v = await a.call("GET", `/api/reports/venue-activity?hotspot=${h.id}&from=2026-11-12T00:00:00Z&to=2026-11-13T00:00:00Z`, { key });
  assert.deepEqual(v.json.rows, [{ hour: "2026-11-12T10:00:00.000Z", sessions: 10 }]);
  a.close();
});

test("erasing an account removes identity data", async () => {
  const a = await boot();
  await a.call("PUT", "/api/me/consent", { as: "cid_z", body: { choices: { research: true, host_bandwidth: true } } });
  await a.call("POST", "/api/me/hotspots", { as: "cid_z", body: { name: "Home", kind: "home", lat: 1, lng: 1 } });
  assert.equal((await a.call("DELETE", "/api/me", { as: "cid_z" })).status, 200);
  assert.equal(a.store.ledger("cid_z").length, 0);
  assert.equal(a.store.myHotspots("cid_z").length, 0);
  a.close();
});

test("web app is served with a strict CSP that only adds Amplitude to connect-src", async () => {
  const a = await boot();
  const store = a.store;
  void store;
  const { handler } = createApp({ store: openStore(":memory:"), env: {}, verify: async () => null });
  const srv = createServer(handler);
  await new Promise<void>((r) => srv.listen(0, r));
  const r = await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/`);
  const csp = r.headers.get("content-security-policy") ?? "";
  assert.match(csp, /connect-src 'self' https:\/\/api2\.amplitude\.com https:\/\/api\.amplitude\.com/);
  assert.match(csp, /script-src 'self';/);
  srv.close();
  a.close();
});
