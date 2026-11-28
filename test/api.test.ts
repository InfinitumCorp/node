import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { createNodeHandler } from "../src/server.ts";
import { CSP } from "../src/app.ts";
import { nodeSqlite } from "../src/sqlite-node.ts";
import { openStore } from "../src/store.ts";
import { geohash, geohashCenter, suppress } from "../src/privacy.ts";
import { currentConsent, jurisdiction } from "../src/consent.ts";

const T0 = Date.parse("2026-11-12T10:00:00Z");

async function boot() {
  const store = openStore(nodeSqlite());
  let clock = T0;
  const handler = createNodeHandler({
    store,
    env: {},
    now: () => clock,
    verify: async (t) => (t.startsWith("cid_") ? { cid: t } : null),
  });
  const srv = createServer(handler);
  await new Promise<void>((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, opts: { as?: string; body?: unknown; key?: string; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json", ...opts.headers };
    if (opts.as) headers.authorization = `Bearer ${opts.as}`;
    if (opts.key) headers["x-node-buyer-key"] = opts.key;
    const r = await fetch(base + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    const raw = await r.text();
    return { status: r.status, json: (raw ? JSON.parse(raw) : null) as any };
  };
  return { store, call, close: () => srv.close(), tick: (ms: number) => (clock += ms) };
}

test("the Russian mirror is pointed at the Cumulus ID mirror", async () => {
  const a = await boot();
  assert.equal((await a.call("GET", "/api/config")).json.cidIssuer, "https://id.cumuluscloud.app");
  const via = await a.call("GET", "/api/config", { headers: { "x-node-mirror": "ru" } });
  assert.equal(via.json.cidIssuer, "https://ru.id.cumuluscloud.app");
  assert.equal(via.json.cidClient, "node");
  a.close();
});

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
  assert.deepEqual((await a.store.ledger("cid_c")).map((e) => e.granted), [true, false]);
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
  const venueOnly = await a.store.addBuyer("Venue Co", ["venue_activity"], "LIC-2");
  assert.equal((await a.call("GET", `/api/reports/connectivity?area=${area}`, { key: venueOnly })).status, 403);

  const key = await a.store.addBuyer("ISP Planning", ["connectivity", "venue_activity"], "LIC-1");
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

test("a paired router reads its hotspot's switch and limits, and reports back", async () => {
  const a = await boot();
  await a.call("PUT", "/api/me/consent", { as: "cid_r", body: { choices: { host_bandwidth: true } } });
  const h = (await a.call("POST", "/api/me/hotspots", { as: "cid_r", body: { name: "Flat", kind: "home", ssid: "Nøde Flat", lat: 1, lng: 1, limits: { maxMbps: 15, hours: [7, 8] } } })).json.hotspot;
  const base = `/api/me/hotspots/${h.id}/routers`;

  assert.equal((await a.call("POST", base, { as: "cid_other", body: {} })).status, 404, "only the host can pair");
  const made = await a.call("POST", base, { as: "cid_r", body: {} });
  assert.equal(made.status, 201);
  assert.equal(made.json.router.name, "Router 1");
  assert.match(made.json.key, /^nr_/);
  const bearer = { authorization: `Bearer ${made.json.key}` };

  assert.equal((await a.call("GET", "/api/router/config")).status, 401);
  assert.equal((await a.call("GET", "/api/router/config", { headers: { authorization: "Bearer nr_wrongwrongwrongwrongwrong" } })).status, 401);
  assert.equal((await a.call("GET", `/api/router/config?key=${made.json.key}`)).status, 401, "never a key in the URL");
  let cfg = await a.call("GET", "/api/router/config", { headers: bearer });
  assert.equal(cfg.status, 200);
  assert.deepEqual(cfg.json, { hotspot: h.id, name: "Flat", ssid: "Nøde Flat", active: false, pausedUntil: null, limits: { maxMbps: 15, dailyMb: 2048, hours: [7, 8], maxTempC: 42 }, poll: 300 });

  await a.call("PATCH", `/api/me/hotspots/${h.id}`, { as: "cid_r", body: { active: true } });
  cfg = await a.call("GET", "/api/router/config", { headers: bearer });
  assert.equal(cfg.json.active, true, "the app's start button reaches the router");

  assert.equal((await a.call("POST", "/api/router/status", { headers: bearer, body: { state: "sharing", tempC: 51.4, usedMb: 120 } })).status, 204);
  assert.equal((await a.call("POST", "/api/router/status", { headers: bearer, body: { tempC: 5 } })).status, 400);
  const list = await a.call("GET", base, { as: "cid_r" });
  assert.equal(list.json.routers.length, 1);
  assert.equal(list.json.routers[0].state, "sharing");
  assert.equal(list.json.routers[0].tempC, 51);
  assert.equal(list.json.routers[0].usedMb, 120);
  assert.equal(list.json.routers[0].lastSeen, T0);
  assert.ok(!JSON.stringify(list.json).includes(made.json.key), "the key is shown once only");

  // Stopping hosting entirely reaches the router too.
  await a.call("PUT", "/api/me/consent", { as: "cid_r", body: { choices: { host_bandwidth: false } } });
  assert.equal((await a.call("GET", "/api/router/config", { headers: bearer })).json.active, false);

  assert.equal((await a.call("DELETE", `${base}/${made.json.router.id}`, { as: "cid_other" })).status, 404);
  assert.equal((await a.call("DELETE", `${base}/${made.json.router.id}`, { as: "cid_r" })).status, 200);
  assert.equal((await a.call("GET", "/api/router/config", { headers: bearer })).status, 401, "unpairing revokes the key");

  const again = await a.call("POST", base, { as: "cid_r", body: { name: "Hall" } });
  await a.call("DELETE", "/api/me", { as: "cid_r" });
  assert.equal((await a.call("GET", "/api/router/config", { headers: { authorization: `Bearer ${again.json.key}` } })).status, 401, "erasing the account removes routers");
  a.close();
});

test("a hotspot with routers is on the map only while a router says it is sharing", async () => {
  const a = await boot();
  await a.call("PUT", "/api/me/consent", { as: "cid_l", body: { choices: { host_bandwidth: true } } });
  const mk = async (name: string) => (await a.call("POST", "/api/me/hotspots", { as: "cid_l", body: { name, kind: "home", lat: 52.52, lng: 13.405 } })).json.hotspot;
  const plain = await mk("Venue Wi-Fi"), routed = await mk("Routed");
  for (const h of [plain, routed]) await a.call("PATCH", `/api/me/hotspots/${h.id}`, { as: "cid_l", body: { active: true } });
  const names = async () => (await a.call("GET", "/api/hotspots?lat=52.52&lng=13.405")).json.hotspots.map((h: any) => `${h.name}${h.verified ? "+" : ""}`).sort();

  assert.deepEqual(await names(), ["Routed", "Venue Wi-Fi"], "no routers: listed on the host's word");
  const { key } = (await a.call("POST", `/api/me/hotspots/${routed.id}/routers`, { as: "cid_l", body: {} })).json;
  const bearer = { authorization: `Bearer ${key}` };
  assert.deepEqual(await names(), ["Venue Wi-Fi"], "paired but not yet reporting");
  await a.call("POST", "/api/router/status", { headers: bearer, body: { state: "sharing" } });
  assert.deepEqual(await names(), ["Routed+", "Venue Wi-Fi"], "a router confirms it: verified");
  await a.call("POST", "/api/router/status", { headers: bearer, body: { state: "daily limit reached" } });
  assert.deepEqual(await names(), ["Venue Wi-Fi"], "the router stopped sharing");
  await a.call("POST", "/api/router/status", { headers: bearer, body: { state: "sharing" } });
  a.tick(21 * 60_000);
  assert.deepEqual(await names(), ["Venue Wi-Fi"], "the router went quiet");
  a.close();
});

test("a host sees what each router shared per day, newest first", async () => {
  const a = await boot();
  await a.call("PUT", "/api/me/consent", { as: "cid_d", body: { choices: { host_bandwidth: true } } });
  const h = (await a.call("POST", "/api/me/hotspots", { as: "cid_d", body: { name: "Shop", kind: "business", lat: 1, lng: 1 } })).json.hotspot;
  const base = `/api/me/hotspots/${h.id}/routers`;
  const { key, router } = (await a.call("POST", base, { as: "cid_d", body: {} })).json;
  const report = (usedMb: number) => a.call("POST", "/api/router/status", { headers: { authorization: `Bearer ${key}` }, body: { state: "sharing", usedMb } });
  const days = async () => (await a.call("GET", base, { as: "cid_d" })).json.routers[0].days.map((d: any) => d.usedMb);

  for (const mb of [10, 250, 400]) { await report(mb); a.tick(3_600_000); }
  assert.deepEqual(await days(), [400], "one day so far");
  await report(5); // the router's midnight: its count starts again
  a.tick(3_600_000);
  await report(90);
  assert.deepEqual(await days(), [90, 400]);
  a.tick(48 * 3_600_000);
  await report(120); // two silent days, and a bigger number: still a new day
  assert.deepEqual(await days(), [120, 90, 400]);
  for (let i = 0; i < 8; i++) { await report(0); a.tick(3_600_000); await report(1); a.tick(23 * 3_600_000); }
  assert.equal((await days()).length, 7, "a week at most");

  await a.call("DELETE", `${base}/${router.id}`, { as: "cid_d" });
  const left = await a.store.routers(h.id, "cid_d");
  assert.equal(left.length, 0);
  a.close();
});

test("a host can pause a hotspot for a while, and it comes back by itself", async () => {
  const a = await boot();
  await a.call("PUT", "/api/me/consent", { as: "cid_p", body: { choices: { host_bandwidth: true } } });
  const h = (await a.call("POST", "/api/me/hotspots", { as: "cid_p", body: { name: "Kiosk", kind: "business", lat: 40.4, lng: -3.7 } })).json.hotspot;
  const patch = (b: unknown) => a.call("PATCH", `/api/me/hotspots/${h.id}`, { as: "cid_p", body: b });
  await patch({ active: true });
  const { key } = (await a.call("POST", `/api/me/hotspots/${h.id}/routers`, { as: "cid_p", body: {} })).json;
  const bearer = { authorization: `Bearer ${key}` };
  const listed = async () => (await a.call("GET", "/api/hotspots?lat=40.4&lng=-3.7")).json.hotspots.length;
  await a.call("POST", "/api/router/status", { headers: bearer, body: { state: "sharing" } });
  assert.equal(await listed(), 1);

  assert.equal((await patch({ pausedUntil: T0 + 8 * 86_400_000 })).status, 400, "a week at most");
  const until = T0 + 2 * 3_600_000;
  const r = await patch({ pausedUntil: until });
  assert.equal(r.json.hotspot.pausedUntil, until);
  assert.equal(r.json.hotspot.active, true, "the switch stays on; the pause sits on top");
  let cfg = (await a.call("GET", "/api/router/config", { headers: bearer })).json;
  assert.equal(cfg.active, false, "the router stops while paused");
  assert.equal(cfg.pausedUntil, until);
  assert.equal(await listed(), 0, "off the map while paused");

  a.tick(2 * 3_600_000 + 1);
  cfg = (await a.call("GET", "/api/router/config", { headers: bearer })).json;
  assert.equal(cfg.active, true, "back on by itself");
  assert.equal(cfg.pausedUntil, null);
  await a.call("POST", "/api/router/status", { headers: bearer, body: { state: "sharing" } });
  assert.equal(await listed(), 1);

  await patch({ pausedUntil: T0 + 10 * 3_600_000 });
  assert.equal((await patch({ active: true })).json.hotspot.pausedUntil, null, "Start ends a pause");
  await patch({ pausedUntil: T0 + 10 * 3_600_000 });
  assert.equal((await patch({ pausedUntil: null })).json.hotspot.pausedUntil, null, "or end it directly");
  a.close();
});

test("changing the network name reaches the router", async () => {
  const a = await boot();
  await a.call("PUT", "/api/me/consent", { as: "cid_s", body: { choices: { host_bandwidth: true } } });
  const h = (await a.call("POST", "/api/me/hotspots", { as: "cid_s", body: { name: "Bar", kind: "business", lat: 1, lng: 1 } })).json.hotspot;
  const { key } = (await a.call("POST", `/api/me/hotspots/${h.id}/routers`, { as: "cid_s", body: {} })).json;
  assert.equal((await a.call("PATCH", `/api/me/hotspots/${h.id}`, { as: "cid_s", body: { ssid: "x".repeat(33) } })).status, 400);
  const r = await a.call("PATCH", `/api/me/hotspots/${h.id}`, { as: "cid_s", body: { ssid: "Nøde Bar", name: "The Bar" } });
  assert.equal(r.json.hotspot.ssid, "Nøde Bar");
  const cfg = (await a.call("GET", "/api/router/config", { headers: { authorization: `Bearer ${key}` } })).json;
  assert.equal(cfg.ssid, "Nøde Bar");
  assert.equal(cfg.name, "The Bar");
  a.close();
});

test("a person can download everything Nøde holds about them, without router keys", async () => {
  const a = await boot();
  assert.equal((await a.call("GET", "/api/me/export")).status, 401);
  await a.call("PUT", "/api/me/consent", { as: "cid_x", body: { jurisdiction: "EU", choices: { research: true, host_bandwidth: true } } });
  const h = (await a.call("POST", "/api/me/hotspots", { as: "cid_x", body: { name: "Home", kind: "home", lat: 1, lng: 1 } })).json.hotspot;
  const { key } = (await a.call("POST", `/api/me/hotspots/${h.id}/routers`, { as: "cid_x", body: { name: "Attic" } })).json;
  await a.call("POST", "/api/router/status", { headers: { authorization: `Bearer ${key}` }, body: { state: "sharing", usedMb: 42 } });

  const r = await a.call("GET", "/api/me/export", { as: "cid_x" });
  assert.equal(r.status, 200);
  assert.equal(r.json.account.cid, "cid_x");
  assert.equal(r.json.account.jurisdiction, "EU");
  assert.ok(r.json.consentLedger.some((e: any) => e.purpose === "research" && e.granted));
  assert.equal(r.json.hotspots[0].name, "Home");
  assert.equal(r.json.routers[0].name, "Attic");
  assert.equal(r.json.routers[0].days[0].usedMb, 42);
  const text = JSON.stringify(r.json);
  assert.ok(!text.includes(key) && !text.includes("key_hash"), "no key and no key hash");
  a.close();
});

test("a host sees guests' speed at their own hotspot only once 10 guests measured it", async () => {
  const a = await boot();
  await a.call("PUT", "/api/me/consent", { as: "cid_q", body: { choices: { host_bandwidth: true } } });
  const h = (await a.call("POST", "/api/me/hotspots", { as: "cid_q", body: { name: "Library", kind: "business", lat: 1, lng: 1 } })).json.hotspot;
  const q = () => a.call("GET", `/api/me/hotspots/${h.id}/quality`, { as: "cid_q" });
  assert.equal((await a.call("GET", `/api/me/hotspots/${h.id}/quality`, { as: "cid_other" })).status, 404, "owner only");
  const sample = (i: number, ok = true) => a.call("POST", "/api/telemetry", { body: { kind: "quality", hotspot: h.id, session: `guest-${i}`, ok, downMbps: 10 + i, latencyMs: 30 + i } });
  for (let i = 0; i < 9; i++) await sample(i);
  assert.deepEqual((await q()).json, { days: 7, enough: false, minSessions: 10 });
  await sample(9, false);
  const r = (await q()).json;
  assert.equal(r.enough, true);
  assert.equal(r.sessions, 10);
  assert.equal(r.successRate, 0.9);
  assert.ok(r.medianDownMbps >= 14 && r.medianDownMbps <= 15);
  a.tick(8 * 86_400_000);
  assert.equal((await q()).json.enough, false, "only the last 7 days count");
  a.close();
});

test("guests report problems anonymously; the host sees daily counts for 7 days", async () => {
  const a = await boot();
  await a.call("PUT", "/api/me/consent", { as: "cid_p", body: { choices: { host_bandwidth: true } } });
  const h = (await a.call("POST", "/api/me/hotspots", { as: "cid_p", body: { name: "Bakery", kind: "business", lat: 1, lng: 1 } })).json.hotspot;
  const report = (reason: string, session = "guest-1", hotspot = h.id) => a.call("POST", "/api/telemetry", { body: { kind: "problem", hotspot, session, reason } });
  assert.equal((await report("no_internet", "guest-1")).status, 202);
  assert.equal((await report("no_internet", "guest-1")).status, 202, "accepted, but the same guest counts once a day");
  assert.equal((await report("no_internet", "guest-2")).status, 202);
  assert.equal((await report("slow", "guest-3")).status, 202);
  assert.equal((await report("rude_staff")).status, 400);
  assert.equal((await report("slow", "g", "hs_nosuchspot")).status, 404);
  const get = (as = "cid_p") => a.call("GET", `/api/me/hotspots/${h.id}/problems`, { as });
  assert.equal((await get("cid_other")).status, 404, "owner only");
  assert.deepEqual((await get()).json, { days: 7, problems: { no_internet: 2, not_found: 0, asks_password: 0, slow: 0 } }, "one report alone isn't shown");
  const raw = JSON.stringify(await a.store.export("cid_p"));
  assert.ok(!raw.includes("guest-1"), "no session is kept");
  for (let i = 0; i < 60; i++) await report("asks_password", `script-${i}`);
  assert.equal((await get()).json.problems.asks_password, 25, "invented sessions count at most 25 a day");
  a.tick(8 * 86_400_000);
  assert.equal((await get()).json.problems.no_internet, 0, "only the last 7 days count");
  a.close();
});

test("a host removes one hotspot; its router key stops working at once", async () => {
  const a = await boot();
  await a.call("PUT", "/api/me/consent", { as: "cid_d", body: { choices: { host_bandwidth: true } } });
  const mk = async (name: string) => (await a.call("POST", "/api/me/hotspots", { as: "cid_d", body: { name, kind: "home", lat: 1, lng: 1 } })).json.hotspot;
  const gone = await mk("Old flat"), kept = await mk("New flat");
  const made = await a.call("POST", `/api/me/hotspots/${gone.id}/routers`, { as: "cid_d", body: {} });
  const bearer = { authorization: `Bearer ${made.json.key}` };
  assert.equal((await a.call("GET", "/api/router/config", { headers: bearer })).status, 200);
  await a.call("POST", "/api/telemetry", { body: { kind: "problem", hotspot: gone.id, session: "s", reason: "slow" } });
  assert.equal((await a.call("DELETE", `/api/me/hotspots/${gone.id}`, { as: "cid_other" })).status, 404, "owner only");
  assert.equal((await a.call("DELETE", `/api/me/hotspots/${gone.id}`, { as: "cid_d" })).status, 200);
  assert.equal((await a.call("DELETE", `/api/me/hotspots/${gone.id}`, { as: "cid_d" })).status, 404);
  assert.equal((await a.call("GET", "/api/router/config", { headers: bearer })).status, 401);
  assert.deepEqual((await a.store.myHotspots("cid_d")).map((h) => h.id), [kept.id]);
  a.close();
});

test("a sign's page shows one hotspot's network and status, never where it is", async () => {
  const a = await boot();
  await a.call("PUT", "/api/me/consent", { as: "cid_s", body: { choices: { host_bandwidth: true } } });
  const h = (await a.call("POST", "/api/me/hotspots", { as: "cid_s", body: { name: "Kiosk", kind: "business", ssid: "Nøde Kiosk", lat: 51.5, lng: -0.12 } })).json.hotspot;
  const get = async () => (await a.call("GET", `/api/hotspots/${h.id}`)).json.hotspot;
  assert.equal((await a.call("GET", "/api/hotspots/hs_nosuchspot")).status, 404);
  assert.equal((await get()).status, "off");
  await a.call("PATCH", `/api/me/hotspots/${h.id}`, { as: "cid_s", body: { active: true } });
  const shown = await get();
  assert.deepEqual(shown, { id: h.id, name: "Kiosk", ssid: "Nøde Kiosk", kind: "business", status: "sharing", verified: false, pausedUntil: null });
  await a.call("PATCH", `/api/me/hotspots/${h.id}`, { as: "cid_s", body: { pausedUntil: T0 + 3_600_000 } });
  assert.equal((await get()).status, "paused");
  a.tick(2 * 3_600_000);
  assert.equal((await get()).status, "sharing", "the pause ends by itself");
  const made = await a.call("POST", `/api/me/hotspots/${h.id}/routers`, { as: "cid_s", body: {} });
  assert.equal((await get()).status, "quiet", "a paired router that hasn't reported");
  await a.call("POST", "/api/router/status", { headers: { authorization: `Bearer ${made.json.key}` }, body: { state: "sharing" } });
  assert.deepEqual([(await get()).status, (await get()).verified], ["sharing", true]);
  a.close();
});

test("a host's week at a glance adds up their hotspots, routers, guest data and reports", async () => {
  const a = await boot();
  await a.call("PUT", "/api/me/consent", { as: "cid_w", body: { choices: { host_bandwidth: true } } });
  const mk = async (name: string) => (await a.call("POST", "/api/me/hotspots", { as: "cid_w", body: { name, kind: "business", lat: 1, lng: 1 } })).json.hotspot;
  const one = await mk("Cafe"), two = await mk("Shop");
  await a.call("PATCH", `/api/me/hotspots/${one.id}`, { as: "cid_w", body: { active: true } });
  await a.call("PATCH", `/api/me/hotspots/${two.id}`, { as: "cid_w", body: { active: true, pausedUntil: T0 + 3_600_000 } });
  const key = (await a.call("POST", `/api/me/hotspots/${one.id}/routers`, { as: "cid_w", body: {} })).json.key;
  const status = (usedMb: number) => a.call("POST", "/api/router/status", { headers: { authorization: `Bearer ${key}` }, body: { state: "sharing", usedMb } });
  await status(300); a.tick(3_600_000); await status(500);
  a.tick(20 * 3_600_000); await status(200);
  for (const s of ["x", "y"]) await a.call("POST", "/api/telemetry", { body: { kind: "problem", hotspot: two.id, session: s, reason: "slow" } });
  assert.equal((await a.call("GET", "/api/me/summary")).status, 401);
  assert.deepEqual((await a.call("GET", "/api/me/summary", { as: "cid_w" })).json,
    { days: 7, hotspots: 2, sharing: 2, liveRouters: 1, sharedMb: 700, problems: 2 }, "the pause has ended; two router days: 500 + 200 MB");
  assert.deepEqual((await a.call("GET", "/api/me/summary", { as: "cid_nobody" })).json, { days: 7, hotspots: 0, sharing: 0, liveRouters: 0, sharedMb: 0, problems: 0 });
  a.close();
});

test("erasing an account removes identity data", async () => {
  const a = await boot();
  await a.call("PUT", "/api/me/consent", { as: "cid_z", body: { choices: { research: true, host_bandwidth: true } } });
  await a.call("POST", "/api/me/hotspots", { as: "cid_z", body: { name: "Home", kind: "home", lat: 1, lng: 1 } });
  assert.equal((await a.call("DELETE", "/api/me", { as: "cid_z" })).status, 200);
  assert.equal((await a.store.ledger("cid_z")).length, 0);
  assert.equal((await a.store.myHotspots("cid_z")).length, 0);
  a.close();
});

test("web app is served with a strict CSP that only adds Amplitude to connect-src", async () => {
  const handler = createNodeHandler({ store: openStore(nodeSqlite()), env: {}, verify: async () => null });
  const srv = createServer(handler);
  await new Promise<void>((r) => srv.listen(0, r));
  const r = await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/`);
  const csp = r.headers.get("content-security-policy") ?? "";
  assert.match(csp, /connect-src 'self' https:\/\/api2\.amplitude\.com https:\/\/api\.amplitude\.com/);
  assert.match(csp, /script-src 'self';/);
  srv.close();
});

test("the Workers static headers carry the same CSP as the app", () => {
  const headers = readFileSync(new URL("../web/_headers", import.meta.url), "utf8");
  const line = headers.split(/\r?\n/).find((l) => l.trim().startsWith("Content-Security-Policy:"))!;
  assert.equal(line.split(": ").slice(1).join(": ").trim(), CSP);
});
