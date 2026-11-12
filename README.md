# Nøde

Free community Wi-Fi: fixed gateways at venues and homes, extended by Nøde routers and (on tested devices) phones, paid for by aggregated, privacy-safe data products and commercial partners.

> Phones can't create internet access. Somewhere every Nøde network needs a paid broadband, cellular or satellite uplink whose terms allow public sharing. Nøde makes those uplinks easy to share safely and pays for them.

## What's here

| Path | What it is |
|---|---|
| `src/server.ts` | API and web host (Node ≥ 24, no dependencies, SQLite via `node:sqlite`) |
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

## How it works

**Roles.** A *user* joins any network named “Nøde”. A *host* chooses, separately, to share part of a connection, with a speed cap, daily data limit, battery and temperature cutoffs, a schedule and a stop button. Guests are always on an isolated network. New hotspots start stopped.

**Sign-in.** Cumulus ID only (“Sign in with Cumulus ID” / “Create a Cumulus ID”), via the shared Cumulus bar. Browsing hotspots needs no account.

**Data.** Analytics rows carry a rotating anonymous session id, a ~5 km area and an hour — never an account id. Reports drop any group under 10 sessions and round counts to 5. Free access never depends on an optional purpose; see [docs/LEGAL.md](docs/LEGAL.md).

**Analytics.** Amplitude Browser SDK 2.49.2, vendored, US region, page views and sessions only; everything else off. CSP adds only `api2.amplitude.com` and `api.amplitude.com` to `connect-src`.

## Not built yet

- Native Android/iOS host agents. Third-party apps can't switch on tethering for the user; phone hosting needs device-by-device testing (Android Wi-Fi Aware / local-only hotspot give no internet; iOS Multipeer stops in the background). The web app records limits and shows battery state; enforcement today is on Nøde routers.
- Router ↔ API sync (routers are configured locally; the app's start/stop is mirrored by `uci set node.settings.active`).
- The `node` client must be registered with Cumulus ID (`InfinitumCorp/cumulus-id`, `src/clients.ts`) before sign-in works in production.
