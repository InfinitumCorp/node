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
| `firmware/openwrt/` | Router setup for Nøde Home / Business / Relay / Gateway: isolated guest AP, 802.11s mesh, SQM caps shared fairly between guests, schedule and daily limit |
| `web/openapi.json` | OpenAPI 3.1 description of the API (served at `/openapi.json`; a test checks it covers every route) |
| `docs/` | [Hosting guide](docs/HOSTING.md) ([по-русски](docs/HOSTING.ru.md)), [data products](docs/DATA-PRODUCTS.md), [legal guardrails](docs/LEGAL.md), [economics and pilot plan](docs/ECONOMICS.md) |

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

**Hosting, day to day.** In the Host tab a host can start, stop or pause a hotspot (1 h, 3 h or until morning; it comes back by itself), rename it and change its network name (paired routers follow within 5 minutes), print a sign with a QR code for the window, see each router's last report and a week of guest data, and see how fast the hotspot was for guests (only once 10 guests have measured it). A hotspot with paired routers is on the public map only while one of them reports "sharing" (marked "live"). Hours can be set with one tap (any time, daytime, office hours, evenings). "Share link" and the sign's QR code open a page for that one hotspot (`GET /api/hotspots/:id`: name, network and whether it's sharing, never where it is). Guests can report a problem there or in Find (no internet, can't find it, asks for a password, too slow); only a daily count per reason is kept (one per guest a day, at most 25 per reason a day), and the host card shows the last 7 days, once a reason has at least 2 reports. "Remove this hotspot" deletes it and unpairs its routers.

**Finding Wi-Fi.** Find shows nearby hotspots on a small direction-and-distance map drawn in the page, with no map tiles, so a guest's location never leaves the browser.

**Languages.** English and Russian (`web/i18n.js`); Russian is the default through the Russian mirror and for Russian-language browsers, and there's a switch in the footer. A test fails if any shown text lacks a translation.

**Your data.** "Download my data" gives a JSON copy of everything Nøde holds about a person (`GET /api/me/export`); "Delete my Nøde data" erases it. "Your choices over time" lists every consent choice with its date.

**Sign-in.** Cumulus ID only (“Sign in with Cumulus ID” / “Create a Cumulus ID”), via the shared Cumulus bar. Browsing hotspots needs no account.

**Data.** Analytics rows carry a rotating anonymous session id, a ~5 km area and an hour — never an account id. Reports drop any group under 10 sessions and round counts to 5. Free access never depends on an optional purpose; see [docs/LEGAL.md](docs/LEGAL.md).

**Analytics.** Amplitude Browser SDK 2.49.2, vendored, US region, page views and sessions only; everything else off. CSP adds only `api2.amplitude.com` and `api.amplitude.com` to `connect-src`.

## Install on a router

On an OpenWrt 23.05+ router (`ssh root@192.168.1.1`), one command downloads the scripts, checks them against `SHA256SUMS`, installs curl if needed and runs the setup:

```sh
wget -qO /tmp/nod-install.sh https://node.infinitumcorporation.ai/firmware/openwrt/nod-install.sh && ROLE=home NODE_KEY='nr_...' sh /tmp/nod-install.sh
```

To remove Nøde from a router: `nod-uninstall.sh` (same place). In Russia use `https://node-ru.infinitumcorporation.ai` in both places (`NODE_API=https://node-ru.infinitumcorporation.ai`); the router then talks to the mirror. The site serves copies of `firmware/openwrt/` from `web/firmware/openwrt/`: after editing a script run `node scripts/sync-firmware.mjs` (a test fails if the copies are stale).

## Router sync

Pair a Nøde router in the app (Host → your hotspot → Pair a router). The key is shown once; on the router:

```sh
uci set node.settings.key='nr_...'; uci commit node; nod-sync
```

Every 5 minutes `nod-sync` (cron, installed by `nod-setup.sh`) fetches `GET /api/router/config` with `Authorization: Bearer <key>`, applies the start/stop switch, speed cap, daily data cap, hours and network name, runs `nod-limits`, then posts `{state, tempC, usedMb}` to `/api/router/status`. The Host tab shows what each router last reported. Only the host's own totals are sent, never anything about guests. The server stores a SHA-256 hash of the key, not the key. Unreachable server: the router keeps its last settings. A refused key (401: unpaired, or the hotspot was deleted) stops sharing. In Russia set `uci set node.settings.api='https://node-ru.infinitumcorporation.ai'`. About once a day a paired router runs `nod-update`, which installs newer scripts from the same site only if they match `SHA256SUMS` and parse; `uci set node.settings.autoupdate=0` turns that off.

## Not built yet

- Native Android/iOS host agents. Third-party apps can't switch on tethering for the user; phone hosting needs device-by-device testing (Android Wi-Fi Aware / local-only hotspot give no internet; iOS Multipeer stops in the background). The web app records limits and shows battery state; enforcement today is on Nøde routers.
- Cumulus ID client `node` is registered in InfinitumCorp/infinitum-nexus (`packages/cid/src/id-clients.ts`, merged in PR #175 and live) for `https://node.infinitumcorporation.ai`. People who open Nøde through the Russian mirror (`node-ru.infinitumcorporation.ai`) sign in at `https://ru.id.cumuluscloud.app` (`CID_MIRROR_ISSUER`) automatically.
