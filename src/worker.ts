// Nøde on Cloudflare Workers: the API on D1, the web app from Workers static assets.
// Static files are served by the assets layer with headers from web/_headers; only /api/* and
// /healthz reach this code (run_worker_first in wrangler.jsonc).
import { createApp } from "./app.ts";
import { d1, type D1Like } from "./sql.ts";
import { openStore, type Store } from "./store.ts";

interface Env {
  DB: D1Like;
  ASSETS: { fetch(req: Request): Promise<Response> };
  CID_ISSUER?: string;
  CID_PUBLIC_ISSUER?: string;
}

let cached: { db: D1Like; store: Store; handle: ReturnType<typeof createApp> } | null = null;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (!cached || cached.db !== env.DB) {
      const store = openStore(d1(env.DB));
      cached = { db: env.DB, store, handle: createApp({ store, env: env as unknown as Record<string, unknown> }) };
    }
    const r = await cached.handle(req);
    return r ?? env.ASSETS.fetch(req);
  },
};
