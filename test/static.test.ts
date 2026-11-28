import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
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

test("nod-uninstall removes every uci section nod-setup creates", async () => {
  const { readFileSync } = await import("node:fs");
  const setup = readFileSync(new URL("nod-setup.sh", dir), "utf8");
  const uninstall = readFileSync(new URL("nod-uninstall.sh", dir), "utf8");
  const made = new Set([...setup.matchAll(/uci set "?(\w+)\.([\w$]+)=/g)].map(([, cfg, sec]) => `${cfg}.${sec}`));
  assert.ok(made.size >= 8);
  for (const s of made) {
    if (s === "node.settings") continue; // removed with /etc/config/node
    const [cfg, sec] = s.split(".") as [string, string];
    const literal = sec.includes("$") ? sec.slice(0, sec.indexOf("$")) : sec;
    const covered = uninstall.includes(`${cfg}.${sec}`) || (uninstall.includes(cfg) && uninstall.includes(literal.replace(/_$/, "")));
    assert.ok(covered, `nod-uninstall.sh doesn't remove ${s}`);
  }
  assert.match(uninstall, /rm -f[^\n]*\/etc\/config\/node/);
});

test("nod-update installs newer verified scripts and refuses tampered ones", async (t) => {
  try { execFileSync("sh", ["-c", "command -v curl && command -v sha256sum"]); } catch { return t.skip("needs sh, curl and sha256sum"); }
  const { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createServer } = await import("node:http");
  const { createHash } = await import("node:crypto");
  const root = mkdtempSync(join(tmpdir(), "nod-up-"));
  const site = join(root, "site"), bin = join(root, "bin"), stubs = join(root, "stubs");
  for (const d of [site, bin, stubs]) mkdirSync(d, { recursive: true });
  // OpenWrt commands the script calls: uci has no settings here, logger just prints.
  writeFileSync(join(stubs, "uci"), "#!/bin/sh\nexit 1\n"); chmodSync(join(stubs, "uci"), 0o755);
  writeFileSync(join(stubs, "logger"), "#!/bin/sh\nshift 2; echo \"$*\"\n"); chmodSync(join(stubs, "logger"), 0o755);
  const files: Record<string, string> = { "nod-limits.sh": "#!/bin/sh\necho new limits\n", "nod-sync.sh": "#!/bin/sh\necho new sync\n", "nod-update.sh": "#!/bin/sh\nexit 0\n" };
  const publish = (tamper = "") => {
    for (const [n, b] of Object.entries(files)) writeFileSync(join(site, n), n === tamper ? b + "echo evil\n" : b);
    writeFileSync(join(site, "SHA256SUMS"), Object.entries(files).map(([n, b]) => `${createHash("sha256").update(b).digest("hex")}  ${n}\n`).join(""));
  };
  writeFileSync(join(bin, "nod-limits"), "#!/bin/sh\necho old limits\n");
  writeFileSync(join(bin, "nod-sync"), "#!/bin/sh\necho old sync\n");
  const srv = createServer((q, r) => { try { r.end(readFileSync(join(site, q.url!.split("/").pop()!))); } catch { r.statusCode = 404; r.end(); } });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const api = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const toSh = (p: string) => p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
  const script = toSh(new URL("nod-update.sh", dir).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const run = () => new Promise<string>((res, rej) => {
    execFile("sh", ["-c", `PATH="${toSh(stubs)}:$PATH" NOD_BIN="${toSh(bin)}" NODE_API="${api}" sh "${script}"`],
      (e, out, err) => (e ? rej(e) : res(out + err)));
  });
  try {
    publish("nod-sync.sh");
    const first = await run();
    assert.match(first, /nod-sync.sh checksum mismatch/);
    assert.match(readFileSync(join(bin, "nod-sync"), "utf8"), /old sync/);
    assert.match(readFileSync(join(bin, "nod-limits"), "utf8"), /new limits/);
    publish();
    await run();
    assert.match(readFileSync(join(bin, "nod-sync"), "utf8"), /new sync/);
    assert.match(await run(), /up to date/);
  } finally { srv.close(); }
});
