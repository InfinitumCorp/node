// Issue a data-license key: node scripts/add-buyer.ts "<buyer name>" <license-ref> connectivity[,venue_activity]
// The key is printed once and only its hash is stored.
import { openStore } from "../src/store.ts";

const [name, license, products] = process.argv.slice(2);
const allowed = ["connectivity", "venue_activity"];
const list = (products ?? "").split(",").filter(Boolean);
if (!name || !license || !list.length || list.some((p) => !allowed.includes(p))) {
  console.error(`usage: add-buyer "<name>" <license-ref> ${allowed.join("|")}[,...]`);
  process.exit(1);
}
const store = openStore(process.env.NODE_DB ?? "node.db");
console.log(store.addBuyer(name, list, license));
