// Local Node server: the same API as the Worker, plus the web app from ./web with the same headers.
// Production runs on Cloudflare Workers (src/worker.ts); this is for development and tests.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, PAGE_HEADERS, type Options } from "./app.ts";
import { nodeSqlite } from "./sqlite-node.ts";
import { openStore } from "./store.ts";

const WEB = fileURLToPath(new URL("../web/", import.meta.url));
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png",
};

async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && chunks.length > 0;
  return new Request(new URL(req.url ?? "/", "http://localhost"), { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined });
}

async function serveStatic(res: ServerResponse, path: string) {
  const rel = path === "/" ? "index.html" : path.slice(1);
  const file = normalize(join(WEB, rel));
  let data: Buffer;
  let served = file;
  if (!file.startsWith(normalize(WEB)) || rel === "_headers") served = join(WEB, "index.html");
  try {
    data = await readFile(served);
  } catch {
    served = join(WEB, "index.html");
    data = await readFile(served); // the app handles its own routes
  }
  const type = TYPES[extname(served)] ?? "text/html; charset=utf-8";
  res.writeHead(200, { "content-type": type, ...PAGE_HEADERS, "cache-control": type.startsWith("text/html") || rel === "sw.js" ? "no-cache" : "public, max-age=3600" });
  res.end(data);
}

export function createNodeHandler(opts: Partial<Options> = {}) {
  const store = opts.store ?? openStore(nodeSqlite(process.env.NODE_DB ?? "node.db"));
  const handle = createApp({ ...opts, store, env: opts.env ?? process.env });
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const r = await handle(await toRequest(req));
      if (r) {
        res.writeHead(r.status, Object.fromEntries(r.headers));
        res.end(Buffer.from(await r.arrayBuffer()));
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Method not allowed." }));
        return;
      }
      await serveStatic(res, new URL(req.url ?? "/", "http://localhost").pathname);
    } catch (e) {
      console.error("node: unexpected error", e instanceof Error ? e.message : e);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Something went wrong." }));
    }
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 8080);
  createServer(createNodeHandler()).listen(port, () => console.log(`Nøde listening on http://localhost:${port}`));
}
