import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
// @ts-ignore: plain ESM script
import { stale } from "../scripts/sync-firmware.mjs";

const dir = new URL("../firmware/openwrt/", import.meta.url);

test("routers download the same scripts that are in firmware/openwrt", () => {
  assert.deepEqual(stale(), [], "run node scripts/sync-firmware.mjs");
});

test("every router script parses as POSIX sh", (t) => {
  try { execFileSync("sh", ["-c", "true"]); } catch { return t.skip("no sh here"); }
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sh"))) {
    execFileSync("sh", ["-n", new URL(f, dir).pathname.replace(/^\/([A-Za-z]:)/, "$1")]);
  }
});

test("the OpenAPI document lists every route the API documents", async () => {
  const { readFileSync } = await import("node:fs");
  const spec = JSON.parse(readFileSync(new URL("../web/openapi.json", import.meta.url), "utf8"));
  const header = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8").split("*/")[0]!;
  const routes = [...header.matchAll(/^\s*\*\s+(GET|POST|PUT|PATCH|DELETE)\s+(\/\S+)/gm)]
    .map(([, m, p]) => [m!.toLowerCase(), p!.replace(/\?.*$/, "").replace(/:rid/, "{rid}").replace(/:id/, "{id}")] as const);
  assert.ok(routes.length > 10);
  for (const [m, p] of routes) assert.ok(spec.paths[p]?.[m], `${m.toUpperCase()} ${p} missing from web/openapi.json`);
});
