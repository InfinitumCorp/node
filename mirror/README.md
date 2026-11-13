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

## Set up (Google Cloud project `scalvs-mirror`, which already hosts the other mirrors)

1. Deploy the pass-through:

       gcloud run deploy node-mirror --source . --project scalvs-mirror --region europe-north1 --allow-unauthenticated --set-env-vars UPSTREAM=https://node.infinitumcorporation.ai,PUBLIC_ORIGIN=https://node-ru.infinitumcorporation.ai --memory 256Mi --max-instances 3

2. Create the Hosting site and deploy `firebase.json`:

       npx -y firebase-tools@14 hosting:sites:create node-ru --project scalvs-mirror
       npx -y firebase-tools@14 deploy --only hosting --project scalvs-mirror

   The mirror is then live at https://node-ru.web.app.
3. Custom domain: Firebase console > Hosting > node-ru > Add custom domain >
   `node-ru.infinitumcorporation.ai`. Add the records it shows in Cloudflare DNS as **DNS only**
   (grey cloud), then wait for the certificate.
4. Cumulus ID: `https://node-ru.infinitumcorporation.ai` (and `https://node-ru.web.app`) must be
   origins of client `node` in infinitum-nexus `packages/cid/src/id-clients.ts`.

`npm test` runs the pass-through tests.
