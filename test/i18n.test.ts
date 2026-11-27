import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JURISDICTIONS, PURPOSES } from "../src/consent.ts";
// @ts-ignore plain browser module
import { DICTS } from "../web/i18n.js";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const ru: Record<string, string> = DICTS.ru;

test("every string the web app shows has a Russian translation", () => {
  const app = read("web/app.js");
  const keys = new Set<string>();
  // t("...") calls; the strings in app.js contain no escaped quotes.
  for (const m of app.matchAll(/\bt\("([^"]*)"/g)) keys.add(m[1]!);
  const html = read("web/index.html");
  const plain = /data-i18n(?=[ >])[^>]*>([^<]+)/g;
  for (const m of html.matchAll(plain)) keys.add(m[1]!.trim());
  const attrs = new RegExp('data-i18n-attr="([^"]+)"', "g");
  for (const m of html.matchAll(attrs)) {
    const tag = html.slice(html.lastIndexOf("<", m.index), html.indexOf(">", m.index));
    for (const a of m[1]!.split(",")) { const v = new RegExp(`${a}="([^"]+)"`).exec(tag); if (v) keys.add(v[1]!); }
  }
  for (const p of PURPOSES) keys.add(p.title), keys.add(p.summary);
  for (const j of JURISDICTIONS) keys.add(j.name);
  for (const k of ["home", "business", "relay", "gateway", "phone"]) keys.add(k);
  // Router states written by firmware/openwrt/nod-limits.sh
  for (const s of ["sharing", "stopped by host", "outside sharing hours", "daily limit reached"]) {
    assert.ok(read("firmware/openwrt/nod-limits.sh").includes(s), `nod-limits writes "${s}"`);
    keys.add(s);
  }
  const missing = [...keys].filter((k) => !(k in ru));
  assert.deepEqual(missing, [], "add these to RU in web/i18n.js");
  assert.ok(keys.size > 100);
});

test("translations keep their placeholders", () => {
  for (const [en, tr] of Object.entries(ru)) {
    const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(ph(tr), ph(en), en);
  }
});

test("API errors the web app can show are translated", async () => {
  const src = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8") + readFileSync(new URL("../src/store.ts", import.meta.url), "utf8");
  for (const msg of ["Sign in with Cumulus ID.", "No such hotspot.", "Request too large.", "hours must be a list of hours 0-23."]) {
    assert.ok(src.includes(msg), `server still says "${msg}"`);
    assert.ok(msg in ru, msg);
  }
  assert.ok(src.includes("is required (up to ${max} characters)."));
  assert.ok(src.includes("must be a number from ${lo} to ${hi}."));
  assert.ok(src.includes("A hotspot can have up to ${MAX_ROUTERS_PER_HOTSPOT} routers."));
});
