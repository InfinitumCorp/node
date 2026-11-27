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
