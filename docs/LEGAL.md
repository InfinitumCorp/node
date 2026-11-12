# Legal guardrails

Not legal advice. Each market needs its own assessment before launch.

## Rules the code enforces

1. **No conditional access.** `conditionalAccess` is `false` in every jurisdiction (`src/consent.ts`). Getting online never depends on agreeing to a licensed data purpose. Under EU consent guidance, tying access to unnecessary processing can invalidate consent; California treats it as a financial incentive that needs its own notice. Changing this for any market requires a written legal assessment for that market first.
2. **Specific purposes, each withdrawable.** Six purposes, one switch each, recorded in an append-only ledger with the policy version. Withdrawing costs nothing and takes effect at once.
3. **Hosting is separate.** Sharing a connection is its own purpose (`host_bandwidth`), off by default everywhere, with a plain warning about data allowance, battery and the internet plan's terms. Turning it off stops every hotspot.
4. **Identity and analytics never join.** No analytics table has an account column. Sessions are random, rotate daily and are hashed on arrival.
5. **Coarse and aggregated.** ~5 km areas, 1-hour windows, groups under 10 suppressed, counts rounded to 5. Hotspot locations stored to ~150 m.
6. **Erasure.** `DELETE /api/me` removes the account, ledger and hotspots.

## Never collected or sold

Message or page contents, browsing history, passwords, payment data, precise or continuous location, movement histories, device advertising IDs, sensitive locations (health, religious, political, shelters), anything about children, or sensitive profiles. The FTC's 2024 actions against location-data brokers are the cautionary example.

## Buyer license must include

- No re-identification, no linking with other data to single out a person or device.
- No resale; use limited to the licensed product.
- Audit right; every report request is logged (`report_log`).
- Termination and deletion on breach.

## Before each launch

- Local assessment: consent basis, minimum age, data-localisation (e.g. Russia 152-FZ), telecom rules for offering public Wi-Fi (some markets require user identification on public hotspots — check before enabling).
- Host terms: confirm the uplink's ISP terms allow public sharing; business hosts get a venue agreement.
- Update `JURISDICTIONS` and bump `POLICY_VERSION`.
