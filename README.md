# Nøde

Free community Wi-Fi: fixed gateways at venues and homes, extended by Nøde routers and (on tested devices) phones, paid for by aggregated, privacy-safe data products and commercial partners.

> Phones can't create internet access. Somewhere every Nøde network needs a paid broadband, cellular or satellite uplink whose terms allow public sharing. Nøde makes those uplinks easy to share safely and pays for them.

## What's here

| Path | What it is |
|---|---|
| `src/app.ts` | The API (`/api/*`, `/healthz`) on standard Request/Response |
| `src/worker.ts` | Production: Cloudflare Worker on D1, web app from Workers static assets (`wrangler.jsonc`, `web/_headers`) |
| `src/server.ts` | Local development and tests: same API on Node ≥ 24, SQLite via `node:sqlite`, no dependencies |
| `src/sql.ts` | The schema and a small SQL interface over D1 or `node:sqlite` |
| `src/consent.ts` | Purposes, per-jurisdiction defaults, the append-only consent ledger |
| `src/privacy.ts` | Geohash coarsening, hour buckets, small-group suppression, count rounding |
| `src/store.ts` | Identity tables and analytics tables that never join |
| `src/cid.ts` | Cumulus ID token verification (copied from `architect`) |
| `web/` | The Nøde web app (installable PWA): find Wi-Fi, your data choices, host controls |
| `firmware/openwrt/` | Router setup for Nøde Home / Business / Relay / Gateway: isolated guest AP, 802.11s mesh, SQM caps, schedule and daily limit |
| `docs/` | [Data products](docs/DATA-PRODUCTS.md), [legal guardrails](docs/LEGAL.md), [economics and pilot plan](docs/ECONOMICS.md) |

## Run it

```bash
npm start            # http://localhost:8080, data in ./node.db
npm test
```

Settings (environment variables, never committed):

| Variable | Meaning |
|---|---|
| `PORT` | default 8080 |
| `NODE_DB` | SQLite file, default `node.db` |
| `CID_ISSUER` | Cumulus ID issuer the server verifies against. Default `https://id.cumuluscloud.app/realms/cumulus`. |
| `CID_PUBLIC_ISSUER` | Where the browser sends people to sign in. Set to the Cumulus ID mirror for Russia so sign-in works without a VPN. |

Issue a data-license key (printed once, stored hashed):

```bash
node scripts/add-buyer.ts "Metro ISP planning" LIC-2026-001 connectivity
```

## Deploy

Production is a Cloudflare Worker named `node` on the custom domain `node.infinitumcorporation.ai`, with D1 database `node`. The schema is created on first request (`CREATE TABLE IF NOT EXISTS`).

```bash
npx wrangler@4 deploy
```

The account's "All Workers" Cloudflare Access rule puts a sign-in wall in front of every Worker. Nøde is public through its own Access app, "Nøde (public)", with a bypass-for-everyone policy on `node.infinitumcorporation.ai` only. A new hostname needs the same before the public can reach it.

For a production data-license key, add `--d1` to `add-buyer`: it prints the key and an `INSERT` to run with `npx wrangler@4 d1 execute node --remote --command "<sql>"`. Only the key's hash goes into D1.

The CSP is set in two places that must match: `src/app.ts` (API and local server) and `web/_headers` (static assets). A test checks this.

## How it works

**Roles.** A *user* joins any network named “Nøde”. A *host* chooses, separately, to share part of a connection, with a speed cap, daily data limit, battery and temperature cutoffs, a schedule and a stop button. Guests are always on an isolated network. New hotspots start stopped.

**Sign-in.** Cumulus ID only (“Sign in with Cumulus ID” / “Create a Cumulus ID”), via the shared Cumulus bar. Browsing hotspots needs no account.

**Data.** Analytics rows carry a rotating anonymous session id, a ~5 km area and an hour — never an account id. Reports drop any group under 10 sessions and round counts to 5. Free access never depends on an optional purpose; see [docs/LEGAL.md](docs/LEGAL.md).

**Analytics.** Amplitude Browser SDK 2.49.2, vendored, US region, page views and sessions only; everything else off. CSP adds only `api2.amplitude.com` and `api.amplitude.com` to `connect-src`.

## Router sync

Pair a Nøde router in the app (Host → your hotspot → Pair a router). The key is shown once; on the router:

```sh
uci set node.settings.key='nr_...'; uci commit node; nod-sync
```

Every 5 minutes `nod-sync` (cron, installed by `nod-setup.sh`) fetches `GET /api/router/config` with `Authorization: Bearer <key>`, applies the start/stop switch, speed cap, daily data cap, hours and network name, runs `nod-limits`, then posts `{state, tempC, usedMb}` to `/api/router/status`. The Host tab shows what each router last reported. Only the host's own totals are sent, never anything about guests. The server stores a SHA-256 hash of the key, not the key. Unreachable server: the router keeps its last settings. In Russia set `uci set node.settings.api='https://node-ru.infinitumcorporation.ai'`.

## Not built yet

- Native Android/iOS host agents. Third-party apps can't switch on tethering for the user; phone hosting needs device-by-device testing (Android Wi-Fi Aware / local-only hotspot give no internet; iOS Multipeer stops in the background). The web app records limits and shows battery state; enforcement today is on Nøde routers.
- Cumulus ID client `node` is registered in InfinitumCorp/infinitum-nexus (`packages/cid/src/id-clients.ts`, merged in PR #175 and live) for `https://node.infinitumcorporation.ai`. People who open Nøde through the Russian mirror (`node-ru.infinitumcorporation.ai`) sign in at `https://ru.id.cumuluscloud.app` (`CID_MIRROR_ISSUER`) automatically.
