// Issue a data-license key: node scripts/add-buyer.ts "<buyer name>" <license-ref> connectivity[,venue_activity] [--d1]
// The key is printed once and only its hash is stored.
//   default: writes to the local SQLite file (NODE_DB, default node.db)
//   --d1:    writes nothing; prints the key and an INSERT to run against production with
//            npx wrangler d1 execute node --remote --command "<sql>"
import { nodeSqlite } from "../src/sqlite-node.ts";
import { openStore, sha256 } from "../src/store.ts";

const args = process.argv.slice(2);
const d1 = args.includes("--d1");
const [name, license, products] = args.filter((a) => a !== "--d1");
const allowed = ["connectivity", "venue_activity"];
const list = (products ?? "").split(",").filter(Boolean);
if (!name || !license || !list.length || list.some((p) => !allowed.includes(p))) {
  console.error(`usage: add-buyer "<name>" <license-ref> ${allowed.join("|")}[,...] [--d1]`);
  process.exit(1);
}

if (d1) {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const key = `nb_${Buffer.from(bytes).toString("base64url")}`;
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  console.log(`key (give to the buyer, shown once): ${key}`);
  console.log(`sql: INSERT INTO buyers (key_hash, name, products, license, created_at) VALUES (${q(await sha256(key))}, ${q(name)}, ${q(JSON.stringify(list))}, ${q(license)}, ${Date.now()});`);
} else {
  const store = openStore(nodeSqlite(process.env.NODE_DB ?? "node.db"));
  console.log(await store.addBuyer(name, list, license));
}
