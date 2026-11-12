/**
 * Purposes and consent, by jurisdiction.
 *
 * Free access is never conditional on an optional purpose. `conditionalAccess` stays false in every
 * jurisdiction until a market-specific legal assessment says otherwise (see docs/LEGAL.md).
 * Hosting bandwidth is a separate choice from using Nøde and from any data purpose.
 *
 * Every change is appended to a ledger (who, purpose, granted, policy version, when); the current
 * state is the latest entry per purpose. Withdrawing is as easy as granting and costs nothing.
 */

export type Purpose = "service" | "network_quality" | "venue_reports" | "research" | "campaign_measurement" | "host_bandwidth";

export interface PurposeInfo {
  id: Purpose;
  title: string;
  summary: string;
  /** Needed to run the service at all (no consent asked, nothing sold). */
  necessary: boolean;
  /** Feeds a licensed data product. */
  licensed: boolean;
}

export const PURPOSES: readonly PurposeInfo[] = [
  { id: "service", title: "Run the network", necessary: true, licensed: false,
    summary: "Your sign-in and the hotspot you're connected to, so we can let you on and keep the network safe. Never sold." },
  { id: "network_quality", title: "Network quality reports", necessary: false, licensed: true,
    summary: "Speed, latency and uptime of Nøde hotspots, grouped by area and hour, with small groups removed. Never tied to your account." },
  { id: "venue_reports", title: "Venue busy-hours", necessary: false, licensed: true,
    summary: "How many sessions a venue had each hour, in groups of 10 or more. Venues use it to plan staffing." },
  { id: "research", title: "Consumer research", necessary: false, licensed: true,
    summary: "Surveys you choose to answer. Each survey says who it's for before you start; you can skip any." },
  { id: "campaign_measurement", title: "Campaign measurement", necessary: false, licensed: true,
    summary: "Whether a campaign at a venue was seen, counted only in aggregate. No profiles, no tracking across sites." },
  { id: "host_bandwidth", title: "Share my connection", necessary: false, licensed: false,
    summary: "Let Nøde guests use part of your connection within the limits you set. Uses your data allowance and battery." },
];

export type Basis = "opt_in" | "opt_out";

export interface Jurisdiction {
  code: string;
  name: string;
  /** How optional purposes start: opt_in = off until chosen; opt_out = on with a notice, can be turned off. */
  defaults: Partial<Record<Purpose, Basis>>;
  /** May access depend on an optional licensed purpose? false everywhere until legal review. */
  conditionalAccess: false;
  minAge: number;
  notes: string;
}

const STRICT: Jurisdiction["defaults"] = {
  network_quality: "opt_in", venue_reports: "opt_in", research: "opt_in", campaign_measurement: "opt_in", host_bandwidth: "opt_in",
};

export const JURISDICTIONS: readonly Jurisdiction[] = [
  { code: "EU", name: "European Union / EEA", defaults: STRICT, conditionalAccess: false, minAge: 16,
    notes: "GDPR consent: specific, freely given, withdrawable without detriment. Access never tied to licensing." },
  { code: "GB", name: "United Kingdom", defaults: STRICT, conditionalAccess: false, minAge: 13, notes: "UK GDPR and PECR." },
  { code: "US-CA", name: "California", defaults: { ...STRICT, network_quality: "opt_out", venue_reports: "opt_out" }, conditionalAccess: false, minAge: 16,
    notes: "CCPA/CPRA: aggregated, deidentified reports with a Do Not Sell/Share switch; financial-incentive notice before any conditional offer." },
  { code: "US", name: "United States (other)", defaults: { ...STRICT, network_quality: "opt_out", venue_reports: "opt_out" }, conditionalAccess: false, minAge: 13,
    notes: "State privacy laws vary; sensitive locations are never collected (FTC location-data actions)." },
  { code: "RU", name: "Russia", defaults: STRICT, conditionalAccess: false, minAge: 14,
    notes: "152-FZ: written-form consent per purpose, data localisation review before launch." },
  { code: "OTHER", name: "Everywhere else", defaults: STRICT, conditionalAccess: false, minAge: 16,
    notes: "Strictest defaults until a market is reviewed." },
];

export const jurisdiction = (code: string | null | undefined): Jurisdiction =>
  JURISDICTIONS.find((j) => j.code === String(code ?? "").toUpperCase()) ?? JURISDICTIONS.find((j) => j.code === "OTHER")!;

export const POLICY_VERSION = "2026-11-12";

export interface LedgerEntry { purpose: Purpose; granted: boolean; policy: string; at: number }

/** What each purpose is right now for one person: their latest ledger entry, else the jurisdiction default. */
export function currentConsent(entries: readonly LedgerEntry[], j: Jurisdiction): Record<Purpose, { granted: boolean; source: "choice" | "default" | "necessary" }> {
  const out = {} as Record<Purpose, { granted: boolean; source: "choice" | "default" | "necessary" }>;
  for (const p of PURPOSES) {
    if (p.necessary) { out[p.id] = { granted: true, source: "necessary" }; continue; }
    const last = [...entries].filter((e) => e.purpose === p.id).sort((a, b) => a.at - b.at).at(-1);
    out[p.id] = last ? { granted: last.granted, source: "choice" } : { granted: j.defaults[p.id] === "opt_out", source: "default" };
  }
  return out;
}

export const isPurpose = (v: unknown): v is Purpose => PURPOSES.some((p) => p.id === v);
