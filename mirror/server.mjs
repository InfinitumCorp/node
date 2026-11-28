// Nøde Russian mirror: a pass-through to the Nøde Worker, run on Cloud Run behind Firebase Hosting.
// Russian networks throttle Cloudflare's free-plan addresses and AWS (connections freeze after
// ~16-24 KB) but not Firebase Hosting's CDN, so phones in Russia reach Nøde through
//   phone -> Firebase Hosting (CDN) -> this service -> https://node.infinitumcorporation.ai
//
// Nøde keeps no cookies (Cumulus ID tokens travel as bearer headers), so nothing is repacked.
// Every request is marked `x-node-mirror: ru`; the Worker then points sign-in at the Cumulus ID
// mirror instead of id.cumuluscloud.app. No dependencies; Node 22+.
import { createHmac } from "node:crypto";
import { createServer } from "node:http";

export const UPSTREAM = (process.env.UPSTREAM || "https://node.infinitumcorporation.ai").replace(/\/$/, "");
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || "").replace(/\/$/, "");
const DROP_REQUEST = new Set(["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "cookie", "content-length",
  "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-cloud-trace-context", "traceparent", "x-appengine-country", "x-node-mirror", "x-node-mirror-client"]);
const DROP_RESPONSE = new Set(["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length", "set-cookie",
  "alt-svc", "nel", "report-to", "server", "cf-ray", "cf-cache-status"]);

/**
 * With MIRROR_SECRET set (the same value as the Worker's NODE_MIRROR_SECRET), each request carries
 * `x-node-mirror-client: <id>.<sig>`: an opaque id derived from the client's address, so Nøde can
 * rate-limit per client without ever seeing the address, and a signature so nobody else can forge one.
 */
export function clientTag(address, secret) {
  if (!address || !secret) return "";
  const id = createHmac("sha256", secret).update(`id:${address}`).digest("base64url").slice(0, 22);
  const sig = createHmac("sha256", secret).update(`sig:${id}`).digest("base64url").slice(0, 22);
  return `${id}.${sig}`;
}

/** The phone's address: Firebase Hosting and Google's front end put it first in x-forwarded-for. */
export function clientAddress(headers, socketAddress = "") {
  const xff = headers["x-forwarded-for"];
  const first = String(Array.isArray(xff) ? xff[0] : xff ?? "").split(",")[0]?.trim();
  return first || socketAddress;
}

/** Points absolute redirects at the mirror, so the browser stays on it. */
export function rewriteLocation(location, publicOrigin, upstream = UPSTREAM) {
  if (!location || !publicOrigin) return location;
  return location.startsWith(upstream) ? publicOrigin + location.slice(upstream.length) : location;
}

/** Headers sent upstream: hop-by-hop and cookies dropped, the mirror marker set. */
export function upstreamHeaders(incoming, tag = "") {
  const out = {};
  for (const [k, v] of Object.entries(incoming)) if (!DROP_REQUEST.has(k) && v !== undefined) out[k] = Array.isArray(v) ? v.join(", ") : v;
  out["x-node-mirror"] = "ru";
  if (tag) out["x-node-mirror-client"] = tag;
  return out;
}

/** Nøde's API takes at most 16 KB; anything far larger is refused here instead of held in memory. */
export const MAX_BODY = 256 * 1024;
class TooLarge extends Error {}

async function readBody(req) {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  if (Number(req.headers["content-length"] || 0) > MAX_BODY) throw new TooLarge();
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new TooLarge();
    chunks.push(c);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

export function createHandler(upstream = UPSTREAM, secret = process.env.MIRROR_SECRET || "") {
  return async (req, res) => {
    if (req.url === "/__mirror/health") {
      res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
      return res.end("ok");
    }
    const fwd = req.headers["x-forwarded-host"];
    const publicOrigin = PUBLIC_ORIGIN || (fwd ? `https://${String(fwd).split(",")[0].trim()}` : "");
    let body;
    try { body = await readBody(req); } catch (e) {
      if (!(e instanceof TooLarge)) throw e;
      res.writeHead(413, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
      return res.end(JSON.stringify({ error: "Request too large." }));
    }
    let up;
    try {
      up = await fetch(upstream + req.url, { method: req.method, headers: upstreamHeaders(req.headers, clientTag(clientAddress(req.headers, req.socket?.remoteAddress), secret)), body, redirect: "manual" });
    } catch {
      res.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ error: "Nøde can't be reached from the mirror right now. Try again shortly." }));
    }
    const out = {};
    up.headers.forEach((v, k) => { if (!DROP_RESPONSE.has(k)) out[k] = v; });
    if (out.location) out.location = rewriteLocation(out.location, publicOrigin, upstream);
    // /api/config differs between the mirror and the main site, so the CDN must not mix them up.
    if (req.url?.startsWith("/api/")) out["cache-control"] = "private, no-store";
    const payload = req.method === "HEAD" ? null : Buffer.from(await up.arrayBuffer());
    if (payload) out["content-length"] = String(payload.length);
    res.writeHead(up.status, out);
    res.end(payload ?? undefined);
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  const port = Number(process.env.PORT || 8080);
  const handle = createHandler();
  createServer((req, res) => handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("mirror error");
  })).listen(port, () => console.log(`Nøde mirror on :${port} -> ${UPSTREAM}`));
}
