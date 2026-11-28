import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { MAX_BODY, createHandler, rewriteLocation, upstreamHeaders } from "./server.mjs";

test("redirects stay on the mirror; others are left alone", () => {
  const up = "https://node.infinitumcorporation.ai";
  assert.equal(rewriteLocation(`${up}/host?x=1`, "https://node-ru.infinitumcorporation.ai", up), "https://node-ru.infinitumcorporation.ai/host?x=1");
  assert.equal(rewriteLocation("https://ru.id.cumuluscloud.app/x", "https://node-ru.infinitumcorporation.ai", up), "https://ru.id.cumuluscloud.app/x");
});

test("cookies and a forged marker are not passed on; the mirror marker is set", () => {
  const h = upstreamHeaders({ host: "x", cookie: "a=1", "x-node-mirror": "nope", authorization: "Bearer t" });
  assert.deepEqual(h, { authorization: "Bearer t", "x-node-mirror": "ru" });
});

test("passes requests through and keeps API answers out of the CDN", async () => {
  const seen = [];
  const upstream = createServer((req, res) => {
    seen.push({ url: req.url, mirror: req.headers["x-node-mirror"], method: req.method });
    if (req.url === "/go") { res.writeHead(302, { location: `http://127.0.0.1:${upstream.address().port}/there` }); return res.end(); }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=60", "set-cookie": "x=1" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((r) => upstream.listen(0, r));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const mirror = createServer(createHandler(base));
  await new Promise((r) => mirror.listen(0, r));
  const m = `http://127.0.0.1:${mirror.address().port}`;

  const r = await fetch(`${m}/api/config`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.equal(r.headers.get("cache-control"), "private, no-store");
  assert.equal(r.headers.get("set-cookie"), null);
  assert.equal(seen[0].mirror, "ru");

  const g = await fetch(`${m}/go`, { redirect: "manual", headers: { "x-forwarded-host": "ru.node.example" } });
  assert.equal(g.headers.get("location"), "https://ru.node.example/there");

  const big = await fetch(`${m}/api/telemetry`, { method: "POST", body: "x".repeat(MAX_BODY + 1) });
  assert.equal(big.status, 413);
  assert.ok(!seen.some((s) => s.url === "/api/telemetry"), "an oversized body never reaches Nøde");
  const ok = await fetch(`${m}/api/telemetry`, { method: "POST", body: "{}" });
  assert.equal(ok.status, 200);
  mirror.close(); upstream.close();
});
