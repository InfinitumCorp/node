# Nøde Russian mirror (node-ru.infinitumcorporation.ai)

Russian networks throttle Cloudflare's free-plan addresses and AWS: a connection freezes after
roughly 16–24 KB. Firebase Hosting's CDN (Fastly) gets through (measured for Cumulus://Mail on
2026-11-11; see infinitum-nexus `apps/cumulus-mail/mirror/README.md`). So the mirror is:

    phone -> Firebase Hosting (Fastly) -> Cloud Run `node-mirror` (server.mjs) -> https://node.infinitumcorporation.ai

`server.mjs` passes every request through and marks it `x-node-mirror: ru`. The Worker then
answers `/api/config` with the Cumulus ID mirror (`CID_MIRROR_ISSUER`, default
`https://ru.id.cumuluscloud.app`), so sign-in stays off the throttled host too. Tokens from the
mirror carry the main issuer, so the Worker verifies them the same way. `/api/*` answers are
marked `private, no-store` so the CDN never serves the mirror's config on the main site or the
other way round. Cookies and client IPs are not passed on (Nøde uses neither).

## Status (2026-11-27)

Live:
- https://node-ru.web.app (Firebase Hosting site `node-ru`, served by Fastly) and
  https://node-ru.infinitumcorporation.ai (custom domain; Cloudflare CNAME to `node-ru.web.app`, DNS only)
- Cloud Run `node-mirror` behind them (europe-north1)
- Sign-in through the mirror goes to `ru.id.cumuluscloud.app`, which accepts both addresses for
  client `node` (infinitum-nexus #209)

- `ru.id.cumuluscloud.app` has its own Firebase front too (site `cumulus-id-ru`, Cloud Run
  `cumulus-id-ru`, switched 2026-11-14; infinitum-nexus #215), so the whole sign-in path is off
  Cloudflare in Russia.
- Routers install through the mirror as well: `/firmware/openwrt/nod-install.sh` with
  `NODE_API=https://node-ru.infinitumcorporation.ai`.

Not checked from a Russian network yet.

## Per-client rate limits (optional)

The mirror hides phones' addresses from Nøde, so by default only the per-hotspot telemetry limit applies to Russian traffic. To keep a per-phone limit, give the mirror and the Worker the same random secret:

```bash
openssl rand -base64 32                                    # the secret; never commit it
npx wrangler@4 secret put NODE_MIRROR_SECRET               # the Worker
gcloud run services update node-mirror --region europe-north1 --project scalvs-mirror --update-env-vars MIRROR_SECRET=<the secret>
```

The mirror then sends `x-node-mirror-client: <id>.<sig>`, an id derived from the address with the secret (the address itself never leaves the mirror) and a signature the Worker checks. Without the secret both sides behave as before.

## Set up (Google Cloud project `scalvs-mirror`, which already hosts the other mirrors)

1. Deploy the pass-through:

       gcloud run deploy node-mirror --source . --project scalvs-mirror --region europe-north1 --allow-unauthenticated --set-env-vars UPSTREAM=https://node.infinitumcorporation.ai,PUBLIC_ORIGIN=https://node-ru.infinitumcorporation.ai --memory 256Mi --max-instances 3

2. Once: enable Firebase on the project (Firebase console > Add project > pick `scalvs-mirror`,
   accept the terms). Then, with `GOOGLE_CLOUD_QUOTA_PROJECT=scalvs-mirror` set, create the Hosting site and deploy `firebase.json`:

       npx -y firebase-tools@14 hosting:sites:create node-ru --project scalvs-mirror
       npx -y firebase-tools@14 deploy --only hosting --project scalvs-mirror

   The mirror is then live at https://node-ru.web.app.
3. Custom domain: Firebase console > Hosting > node-ru > Add custom domain >
   `node-ru.infinitumcorporation.ai`. Add the records it shows in Cloudflare DNS as **DNS only**
   (grey cloud), then wait for the certificate.
4. Cumulus ID: `https://node-ru.infinitumcorporation.ai` (and `https://node-ru.web.app`) must be
   origins of client `node` in infinitum-nexus `packages/cid/src/id-clients.ts`.

`npm test` runs the pass-through tests.
