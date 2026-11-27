// Nøde web app. No framework; renders three views into <main> from the URL hash.
import { LANGS, apiError, choose, lang, routerState, setup, t } from "./i18n.js";

const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let config = { cidIssuer: "https://id.cumuluscloud.app", cidClient: "node", lang: null };
let me = null;

const token = () => (window.CumulusID && window.CumulusID.token()) || null;

async function api(method, path, body) {
  const headers = { accept: "application/json", "accept-language": lang };
  if (body !== undefined) headers["content-type"] = "application/json";
  const tk = token();
  if (tk) headers.authorization = `Bearer ${tk}`;
  const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(json.error ? apiError(json.error) : t("Request failed ({status})", { status: r.status })), { status: r.status });
  return json;
}

/** A random id for anonymous measurements. Rotates every day; never sent with your account. */
function sessionId() {
  const day = new Date().toISOString().slice(0, 10);
  try {
    const saved = JSON.parse(localStorage.getItem("node:session") || "null");
    if (saved && saved.day === day) return saved.id;
    const id = crypto.randomUUID();
    localStorage.setItem("node:session", JSON.stringify({ day, id }));
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

function signInCard() {
  const node = $("#signin").content.cloneNode(true);
  node.querySelector('[data-action="signin"]').addEventListener("click", () => window.CumulusID?.signIn());
  node.querySelector('[data-action="create"]').addEventListener("click", () => window.CumulusID?.signIn({ create: true }));
  return node;
}

async function loadMe() {
  if (!token()) { me = null; return null; }
  try { me = await api("GET", "/api/me"); } catch { me = null; }
  return me;
}

// ---------- Find ----------
async function renderFind() {
  view.innerHTML = `
    <section class="card">
      <h2>${t("Free Wi-Fi near you")}</h2>
      <p class="muted">${t("Nøde hotspots are run by venues, neighbours and Nøde routers. Join them like any Wi-Fi network.")}</p>
      <div class="row start"><button class="primary" id="locate">${t("Use my location")}</button></div>
      <p class="fine">${t("Your location is used once in your browser to search and isn't stored.")}</p>
      <div id="results"></div>
    </section>`;
  $("#locate").addEventListener("click", () => {
    const out = $("#results");
    out.innerHTML = `<p class="muted">${t("Finding you…")}</p>`;
    if (!navigator.geolocation) { out.innerHTML = `<p class="error">${t("This browser can't share a location.")}</p>`; return; }
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        const { hotspots } = await api("GET", `/api/hotspots?lat=${pos.coords.latitude.toFixed(3)}&lng=${pos.coords.longitude.toFixed(3)}`);
        out.innerHTML = hotspots.length ? `<ul class="list">${hotspots.map((h) => `
          <li><div><strong>${esc(h.name)}</strong>${h.verified ? ` <span class="tag ok" title="${esc(t("A Nøde router reported sharing in the last 20 minutes"))}">${t("live")}</span>` : ""}<br><span class="muted">${esc(t("Network: {ssid} · about {km} km", { ssid: h.ssid, km: h.distanceKm.toLocaleString(lang) }))}</span></div>
          <div><span class="tag">${esc(t(h.kind))}</span><br><button data-measure="${esc(h.id)}">${t("I'm on it")}</button></div></li>`).join("")}</ul>`
          : `<p class="muted">${t("No Nøde hotspots here yet. Coverage grows place by place —")} <a href="#/host">${t("host one")}</a>.</p>`;
        out.querySelectorAll("[data-measure]").forEach((b) => b.addEventListener("click", () => measure(b.dataset.measure, b)));
      } catch (e) { out.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
    }, () => { out.innerHTML = `<p class="error">${t("Location wasn't shared. You can still join any network named “Nøde”.")}</p>`; }, { maximumAge: 300000, timeout: 15000 });
  });
}

/** Counts a visit and, if you chose network quality reports, measures latency and download speed. */
async function measure(hotspot, button) {
  button.disabled = true;
  const consent = me?.consent;
  const session = sessionId();
  const tasks = [];
  if (consent?.venue_reports?.granted) tasks.push(api("POST", "/api/telemetry", { kind: "visit", hotspot, session }).catch(() => {}));
  if (consent?.network_quality?.granted) {
    const t0 = performance.now();
    let ok = true, latencyMs, downMbps;
    try {
      await fetch("/healthz", { cache: "no-store" });
      latencyMs = Math.round(performance.now() - t0);
      const t1 = performance.now();
      const r = await fetch("/amplitude.vendor.js", { cache: "no-store" });
      const bytes = (await r.arrayBuffer()).byteLength;
      downMbps = Math.round(((bytes * 8) / ((performance.now() - t1) / 1000) / 1e6) * 10) / 10;
    } catch { ok = false; }
    tasks.push(api("POST", "/api/telemetry", { kind: "quality", hotspot, session, ok, latencyMs, downMbps }).catch(() => {}));
  }
  await Promise.all(tasks);
  button.textContent = tasks.length ? t("Thanks") : t("Connected");
}

// ---------- Privacy ----------
async function renderPrivacy() {
  const [{ purposes }, { jurisdictions }] = await Promise.all([api("GET", "/api/purposes"), api("GET", "/api/jurisdictions")]);
  if (!me) {
    view.innerHTML = `<section class="card"><h2>${t("What Nøde collects")}</h2><ul class="list">${purposes.map((p) => `<li><div><strong>${esc(t(p.title))}</strong><br><span class="muted">${esc(t(p.summary))}</span></div><span class="tag">${p.necessary ? t("needed") : t("your choice")}</span></li>`).join("")}</ul></section>`;
    view.append(signInCard());
    return;
  }
  const c = me.consent;
  view.innerHTML = `
    <section class="card">
      <h2>${t("Your data, your choices")}</h2>
      <p class="muted">${t("Getting online never depends on these. Change them any time; nothing happens to your access.")}</p>
      <label class="field"><span>${t("Where you live (sets the starting choices the law expects)")}</span>
        <select id="jur">${jurisdictions.map((j) => `<option value="${esc(j.code)}" ${j.code === me.jurisdiction ? "selected" : ""}>${esc(t(j.name))}</option>`).join("")}</select></label>
      <form id="choices">
        ${purposes.filter((p) => p.id !== "host_bandwidth").map((p) => `
          <label class="switch"><div><strong>${esc(t(p.title))}</strong><br><span class="muted">${esc(t(p.summary))}</span>
            ${p.licensed ? `<br><span class="fine">${t("Licensed to partners in aggregate. Funds free access.")}</span>` : ""}</div>
            <input type="checkbox" name="${esc(p.id)}" ${c[p.id].granted ? "checked" : ""} ${p.necessary ? "disabled" : ""}></label>`).join("")}
      </form>
      <p class="fine" id="saved" aria-live="polite"></p>
    </section>
    <section class="card">
      <h3>${t("Delete everything")}</h3>
      <p class="muted">${t("Removes your Nøde account, your choices and any hotspots you host. Anonymous measurements were never linked to you.")}</p>
      <button id="erase">${t("Delete my Nøde data")}</button>
    </section>`;
  const save = async (extra = {}) => {
    const choices = {};
    view.querySelectorAll("#choices input:not([disabled])").forEach((i) => (choices[i.name] = i.checked));
    try {
      const r = await api("PUT", "/api/me/consent", { jurisdiction: $("#jur").value, choices, ...extra });
      me = { ...me, consent: r.consent, jurisdiction: r.jurisdiction };
      $("#saved").textContent = t("Saved.");
    } catch (e) { $("#saved").textContent = e.message; }
  };
  $("#choices").addEventListener("change", () => save());
  $("#jur").addEventListener("change", async () => {
    await api("PUT", "/api/me/consent", { jurisdiction: $("#jur").value, choices: {} });
    await loadMe();
    renderPrivacy();
  });
  $("#erase").addEventListener("click", async () => {
    if (!confirm(t("Delete your Nøde account, choices and hotspots? This can't be undone."))) return;
    await api("DELETE", "/api/me");
    try { localStorage.removeItem("node:session"); } catch {}
    window.CumulusID?.signOut();
  });
}

// ---------- Host ----------
const HOURS = Array.from({ length: 24 }, (_, i) => i);

function limitsForm(l) {
  return `
    <div class="grid">
      <label class="field"><span>${t("Guest speed cap (Mbit/s)")}</span><input type="number" name="maxMbps" min="1" max="1000" value="${l.maxMbps}"></label>
      <label class="field"><span>${t("Guest data per day (MB)")}</span><input type="number" name="dailyMb" min="50" value="${l.dailyMb}"></label>
      <label class="field"><span>${t("Stop below battery (%)")}</span><input type="number" name="minBatteryPct" min="20" max="100" value="${l.minBatteryPct}"></label>
      <label class="field"><span>${t("Stop above temperature (°C)")}</span><input type="number" name="maxTempC" min="30" max="60" value="${l.maxTempC}"></label>
    </div>
    <p class="fine">${t("Share during these hours (none ticked = any time):")}</p>
    <div class="hours">${HOURS.map((h) => `<label><input type="checkbox" name="hour" value="${h}" ${l.hours.includes(h) ? "checked" : ""}>${String(h).padStart(2, "0")}</label>`).join("")}</div>
    <p class="fine">${t("Guests are always on a separate network and can't reach your devices.")}</p>`;
}

const readLimits = (form) => ({
  maxMbps: Number(form.maxMbps.value), dailyMb: Number(form.dailyMb.value),
  minBatteryPct: Number(form.minBatteryPct.value), maxTempC: Number(form.maxTempC.value),
  hours: [...form.querySelectorAll('input[name="hour"]:checked')].map((i) => Number(i.value)),
});

async function batteryNote() {
  try {
    const b = await navigator.getBattery?.();
    if (!b) return "";
    return `<p class="fine">${t("This phone: battery {pct}%", { pct: Math.round(b.level * 100) })}${b.charging ? t(", charging") : ""}.</p>`;
  } catch { return ""; }
}

const ago = (ts) => {
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 1 ? t("just now") : m < 60 ? t("{n} min ago", { n: m }) : m < 2880 ? t("{n} h ago", { n: Math.round(m / 60) }) : t("{n} days ago", { n: Math.round(m / 1440) });
};

// A paired router follows this hotspot's switch and limits (firmware/openwrt/nod-sync.sh) and reports back.
function wireRouters(el, h) {
  const list = el.querySelector("[data-routers]");
  const keyBox = el.querySelector("[data-key]");
  async function load() {
    try {
      const { routers } = await api("GET", `/api/me/hotspots/${h.id}/routers`);
      list.textContent = routers.length ? "" : t("No router paired. Pair one so it follows Start/Stop and your limits from here.");
      for (const r of routers) {
        const row = document.createElement("div");
        row.className = "row between";
        const seen = r.lastSeen ? `${esc(r.state ? routerState(r.state) : t("checked in"))} · ${ago(r.lastSeen)}` : t("Hasn't checked in yet");
        const extra = [r.tempC != null ? `${r.tempC}°C` : "", r.usedMb != null ? t("{n} MB shared today", { n: r.usedMb }) : ""].filter(Boolean).join(" · ");
        row.innerHTML = `<span><strong>${esc(r.name)}</strong><br>${seen}${extra ? ` · ${esc(extra)}` : ""}</span><button type="button">${t("Unpair")}</button>`;
        row.querySelector("button").addEventListener("click", async () => {
          await api("DELETE", `/api/me/hotspots/${h.id}/routers/${r.id}`);
          keyBox.textContent = "";
          load();
        });
        list.append(row);
      }
    } catch (e) { list.textContent = e.message; }
  }
  el.querySelector("[data-pair]").addEventListener("click", async () => {
    try {
      const { router, key } = await api("POST", `/api/me/hotspots/${h.id}/routers`, {});
      keyBox.innerHTML = `<div class="notice"><strong>${esc(t("{name} paired.", { name: router.name }))}</strong> ${t("Run this on the router now. The key is shown only once; if you lose it, unpair and pair again.")}
        <pre class="cmd"></pre><button type="button">${t("Copy")}</button></div>`;
      const cmd = `uci set node.settings.key='${key}'; uci commit node; nod-sync`;
      keyBox.querySelector("pre").textContent = cmd;
      const copy = keyBox.querySelector("button");
      copy.addEventListener("click", async () => { try { await navigator.clipboard.writeText(cmd); copy.textContent = t("Copied"); } catch {} });
      load();
    } catch (e) { keyBox.textContent = e.message; }
  });
  load();
}

async function renderHost() {
  if (!me) {
    view.innerHTML = `<section class="card"><h2>${t("Host Nøde")}</h2><p class="muted">${t("Share part of your connection with neighbours or customers, within limits you set. It's separate from using Nøde.")}</p></section>`;
    view.append(signInCard());
    return;
  }
  const on = me.consent.host_bandwidth.granted;
  if (!on) {
    view.innerHTML = `
      <section class="card">
        <h2>${t("Share your connection")}</h2>
        <p>${t("Hosting lets Nøde guests use part of your internet. It's a separate choice from using Nøde Wi-Fi.")}</p>
        <div class="notice"><strong>${t("Before you turn this on:")}</strong> ${t("it uses your data allowance and battery, and your internet plan must allow sharing. Mobile hosting works only on phones we've tested.")}</div>
        <div class="row start"><button class="primary" id="opt">${t("Yes, I want to host")}</button></div>
      </section>`;
    $("#opt").addEventListener("click", async () => {
      const r = await api("PUT", "/api/me/consent", { choices: { host_bandwidth: true } });
      me.consent = r.consent;
      renderHost();
    });
    return;
  }
  const { hotspots } = await api("GET", "/api/me/hotspots");
  const anyActive = hotspots.some((h) => h.active);
  view.innerHTML = `
    ${anyActive ? `<section class="card center"><button class="stop" id="stopall">${t("Stop sharing now")}</button><p class="fine">${t("Stops every hotspot you run, immediately.")}</p></section>` : ""}
    <section class="card"><h2>${t("Your hotspots")}</h2>${await batteryNote()}
      ${hotspots.length ? "" : `<p class="muted">${t("None yet. Add your home router, venue Wi-Fi or a Nøde device below.")}</p>`}
      <div id="spots"></div></section>
    <section class="card"><h3>${t("Add a hotspot")}</h3>
      <form id="add">
        <div class="grid">
          <label class="field"><span>${t("Name people see")}</span><input type="text" name="name" maxlength="60" required placeholder="${esc(t("Corner Café"))}"></label>
          <label class="field"><span>${t("Wi-Fi network name")}</span><input type="text" name="ssid" maxlength="32" value="Nøde"></label>
          <label class="field"><span>${t("Type")}</span><select name="kind">
            <option value="home">${t("Nøde Home (household broadband)")}</option><option value="business">${t("Nøde Business (venue guest Wi-Fi)")}</option>
            <option value="relay">${t("Nøde Relay")}</option><option value="gateway">${t("Nøde Gateway")}</option><option value="phone">${t("This phone (tested devices only)")}</option></select></label>
        </div>
        ${limitsForm({ maxMbps: 10, dailyMb: 2048, minBatteryPct: 40, maxTempC: 42, hours: [] })}
        <p class="fine">${t("We store your location only to about 150 m so people can find the hotspot.")}</p>
        <div class="row start"><button class="primary">${t("Add hotspot")}</button></div>
        <p class="error" id="adderr" aria-live="polite"></p>
      </form></section>
    <section class="card"><h3>${t("Stop hosting entirely")}</h3><p class="muted">${t("Turns off sharing and every hotspot.")}</p><button id="optout">${t("Stop hosting")}</button></section>`;

  const spots = $("#spots");
  for (const h of hotspots) {
    const el = document.createElement("form");
    el.className = "card";
    el.innerHTML = `<div class="row between"><div><strong>${esc(h.name)}</strong> <span class="tag">${esc(t(h.kind))}</span><br>
      <span class="muted">${h.active ? t("Sharing") : t("Stopped")} · ${esc(h.ssid)}</span></div>
      <button type="button" class="${h.active ? "stop" : "primary"}" data-toggle>${h.active ? t("Stop") : t("Start sharing")}</button></div>
      ${limitsForm(h.limits)}<div class="row start"><button>${t("Save limits")}</button>${h.kind === "business" ? `<button type="button" data-activity>${t("Busy hours")}</button>` : ""}</div><div data-out class="fine"></div>
      ${h.kind === "phone" ? "" : `<h3>${t("Nøde routers")}</h3><div data-routers class="fine">${t("Loading…")}</div>
      <div class="row start"><button type="button" data-pair>${t("Pair a router")}</button></div><div data-key></div>`}`;
    el.querySelector("[data-toggle]").addEventListener("click", async () => { await api("PATCH", `/api/me/hotspots/${h.id}`, { active: !h.active }); renderHost(); });
    el.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      try { await api("PATCH", `/api/me/hotspots/${h.id}`, { limits: readLimits(el) }); el.querySelector("[data-out]").textContent = t("Saved."); }
      catch (e) { el.querySelector("[data-out]").textContent = e.message; }
    });
    el.querySelector("[data-activity]")?.addEventListener("click", async () => {
      const r = await api("GET", `/api/me/hotspots/${h.id}/activity`);
      el.querySelector("[data-out]").innerHTML = r.rows.length
        ? r.rows.map((x) => esc(t("{when}: ~{n} sessions", { when: new Date(x.hour).toLocaleString(lang), n: x.sessions }))).join("<br>")
        : t("Not enough visits yet to show (hours with fewer than 10 sessions are hidden).");
    });
    if (h.kind !== "phone") wireRouters(el, h);
    spots.append(el);
  }
  $("#stopall")?.addEventListener("click", async () => {
    await Promise.all(hotspots.filter((h) => h.active).map((h) => api("PATCH", `/api/me/hotspots/${h.id}`, { active: false })));
    renderHost();
  });
  $("#optout").addEventListener("click", async () => {
    const r = await api("PUT", "/api/me/consent", { choices: { host_bandwidth: false } });
    me.consent = r.consent;
    renderHost();
  });
  $("#add").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const f = ev.target;
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        await api("POST", "/api/me/hotspots", {
          name: f.name.value, ssid: f.ssid.value, kind: f.kind.value,
          lat: pos.coords.latitude, lng: pos.coords.longitude, limits: readLimits(f),
        });
        renderHost();
      } catch (e) { $("#adderr").textContent = e.message; }
    }, () => { $("#adderr").textContent = t("We need the hotspot's location (to about 150 m) so people can find it."); });
  });
}

// ---------- routing ----------
const VIEWS = { find: renderFind, privacy: renderPrivacy, host: renderHost };
async function route() {
  const name = (location.hash.match(/^#\/(\w+)/) || [])[1] || "find";
  const render = VIEWS[name] || renderFind;
  document.querySelectorAll(".tabs a").forEach((a) => (a.dataset.tab === name ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  try { await render(); } catch (e) { view.innerHTML = `<section class="card"><p class="error">${esc(e.message)}</p></section>`; }
}

function languagePicker() {
  const box = $("#langs");
  if (!box) return;
  box.setAttribute("aria-label", t("Language"));
  for (const l of LANGS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "link";
    b.lang = l.code;
    b.textContent = l.name;
    if (l.code === lang) b.setAttribute("aria-current", "true");
    else b.addEventListener("click", () => choose(l.code));
    box.append(b);
  }
}

function loadBar() {
  return new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = "/cumulus-bar.js";
    s.dataset.client = config.cidClient;
    s.dataset.issuer = config.cidIssuer;
    s.dataset.product = "node";
    s.dataset.lang = lang;
    s.onload = s.onerror = () => resolve();
    document.head.append(s);
  });
}

async function start() {
  try { config = { ...config, ...(await api("GET", "/api/config")) }; } catch {}
  setup(config.lang);
  languagePicker();
  await loadBar();
  await loadMe();
  window.addEventListener("cumulus-id", async () => { await loadMe(); route(); });
  window.addEventListener("hashchange", route);
  route();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
}
start();
