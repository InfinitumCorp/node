// Copies the OpenWrt scripts into web/ so routers can download them from the Nøde site (and its
// Russian mirror), with SHA256SUMS for nod-install.sh to check. Run after editing firmware/openwrt/.
//   node scripts/sync-firmware.mjs          write web/firmware/openwrt/
//   node scripts/sync-firmware.mjs --check  exit 1 if web/ is out of date (the tests run this)
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

const src = new URL("../firmware/openwrt/", import.meta.url);
const out = new URL("../web/firmware/openwrt/", import.meta.url);

export function expected() {
  const files = {};
  for (const name of readdirSync(src).filter((n) => n.endsWith(".sh")).sort()) files[name] = readFileSync(new URL(name, src));
  const sums = Object.entries(files).map(([n, b]) => `${createHash("sha256").update(b).digest("hex")}  ${n}\n`).join("");
  return { ...files, SHA256SUMS: Buffer.from(sums) };
}

export function stale() {
  return Object.entries(expected())
    .filter(([n, b]) => { const p = new URL(n, out); return !existsSync(p) || !readFileSync(p).equals(b); })
    .map(([n]) => n);
}

if (process.argv[1] && import.meta.filename === (await import("node:path")).resolve(process.argv[1])) {
  if (process.argv.includes("--check")) {
    const s = stale();
    if (s.length) { console.error(`web/firmware/openwrt is out of date: ${s.join(", ")}. Run node scripts/sync-firmware.mjs`); process.exit(1); }
  } else {
    mkdirSync(out, { recursive: true });
    for (const [n, b] of Object.entries(expected())) writeFileSync(new URL(n, out), b);
    console.log("web/firmware/openwrt updated");
  }
}
