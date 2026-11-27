// Nøde web app. No framework; renders three views into <main> from the URL hash.
const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let config = { cidIssuer: "https://id.cumuluscloud.app", cidClient: "node" };
let me = null;

const token = () => (window.CumulusID && window.CumulusID.token()) || null;

async function api(method, path, body) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const t = token();
  if (t) headers.authorization = `Bearer ${t}`;
  const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(json.error || `Request failed (${r.status})`), { status: r.status });
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
      <h2>Free Wi-Fi near you</h2>
      <p class="muted">Nøde hotspots are run by venues, neighbours and Nøde routers. Join them like any Wi-Fi network.</p>
      <div class="row start"><button class="primary" id="locate">Use my location</button></div>
      <p class="fine">Your location is used once in your browser to search and isn't stored.</p>
      <div id="results"></div>
    </section>`;
  $("#locate").addEventListener("click", () => {
    const out = $("#results");
    out.innerHTML = `<p class="muted">Finding you…</p>`;
    if (!navigator.geolocation) { out.innerHTML = `<p class="error">This browser can't share a location.</p>`; return; }
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        const { hotspots } = await api("GET", `/api/hotspots?lat=${pos.coords.latitude.toFixed(3)}&lng=${pos.coords.longitude.toFixed(3)}`);
        out.innerHTML = hotspots.length ? `<ul class="list">${hotspots.map((h) => `
          <li><div><strong>${esc(h.name)}</strong>${h.verified ? ` <span class="tag ok" title="A Nøde router reported sharing in the last 20 minutes">live</span>` : ""}<br><span class="muted">Network: ${esc(h.ssid)} · about ${h.distanceKm} km</span></div>
          <div><span class="tag">${esc(h.kind)}</span><br><button data-measure="${esc(h.id)}">I'm on it</button></div></li>`).join("")}</ul>`
          : `<p class="muted">No Nøde hotspots here yet. Coverage grows place by place — <a href="#/host">host one</a>.</p>`;
        out.querySelectorAll("[data-measure]").forEach((b) => b.addEventListener("click", () => measure(b.dataset.measure, b)));
      } catch (e) { out.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
    }, () => { out.innerHTML = `<p class="error">Location wasn't shared. You can still join any network named “Nøde”.</p>`; }, { maximumAge: 300000, timeout: 15000 });
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
  button.textContent = tasks.length ? "Thanks" : "Connected";
}

// ---------- Privacy ----------
async function renderPrivacy() {
  const [{ purposes }, { jurisdictions }] = await Promise.all([api("GET", "/api/purposes"), api("GET", "/api/jurisdictions")]);
  if (!me) {
    view.innerHTML = `<section class="card"><h2>What Nøde collects</h2><ul class="list">${purposes.map((p) => `<li><div><strong>${esc(p.title)}</strong><br><span class="muted">${esc(p.summary)}</span></div><span class="tag">${p.necessary ? "needed" : "your choice"}</span></li>`).join("")}</ul></section>`;
    view.append(signInCard());
    return;
  }
  const c = me.consent;
  view.innerHTML = `
    <section class="card">
      <h2>Your data, your choices</h2>
      <p class="muted">Getting online never depends on these. Change them any time; nothing happens to your access.</p>
      <label class="field"><span>Where you live (sets the starting choices the law expects)</span>
        <select id="jur">${jurisdictions.map((j) => `<option value="${esc(j.code)}" ${j.code === me.jurisdiction ? "selected" : ""}>${esc(j.name)}</option>`).join("")}</select></label>
      <form id="choices">
        ${purposes.filter((p) => p.id !== "host_bandwidth").map((p) => `
          <label class="switch"><div><strong>${esc(p.title)}</strong><br><span class="muted">${esc(p.summary)}</span>
            ${p.licensed ? `<br><span class="fine">Licensed to partners in aggregate. Funds free access.</span>` : ""}</div>
            <input type="checkbox" name="${esc(p.id)}" ${c[p.id].granted ? "checked" : ""} ${p.necessary ? "disabled" : ""}></label>`).join("")}
      </form>
      <p class="fine" id="saved" aria-live="polite"></p>
    </section>
    <section class="card">
      <h3>Delete everything</h3>
      <p class="muted">Removes your Nøde account, your choices and any hotspots you host. Anonymous measurements were never linked to you.</p>
      <button id="erase">Delete my Nøde data</button>
    </section>`;
  const save = async (extra = {}) => {
    const choices = {};
    view.querySelectorAll("#choices input:not([disabled])").forEach((i) => (choices[i.name] = i.checked));
    try {
      const r = await api("PUT", "/api/me/consent", { jurisdiction: $("#jur").value, choices, ...extra });
      me = { ...me, consent: r.consent, jurisdiction: r.jurisdiction };
      $("#saved").textContent = "Saved.";
    } catch (e) { $("#saved").textContent = e.message; }
  };
  $("#choices").addEventListener("change", () => save());
  $("#jur").addEventListener("change", async () => {
    await api("PUT", "/api/me/consent", { jurisdiction: $("#jur").value, choices: {} });
    await loadMe();
    renderPrivacy();
  });
  $("#erase").addEventListener("click", async () => {
    if (!confirm("Delete your Nøde account, choices and hotspots? This can't be undone.")) return;
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
      <label class="field"><span>Guest speed cap (Mbit/s)</span><input type="number" name="maxMbps" min="1" max="1000" value="${l.maxMbps}"></label>
      <label class="field"><span>Guest data per day (MB)</span><input type="number" name="dailyMb" min="50" value="${l.dailyMb}"></label>
      <label class="field"><span>Stop below battery (%)</span><input type="number" name="minBatteryPct" min="20" max="100" value="${l.minBatteryPct}"></label>
      <label class="field"><span>Stop above temperature (°C)</span><input type="number" name="maxTempC" min="30" max="60" value="${l.maxTempC}"></label>
    </div>
    <p class="fine">Share during these hours (none ticked = any time):</p>
    <div class="hours">${HOURS.map((h) => `<label><input type="checkbox" name="hour" value="${h}" ${l.hours.includes(h) ? "checked" : ""}>${String(h).padStart(2, "0")}</label>`).join("")}</div>
    <p class="fine">Guests are always on a separate network and can't reach your devices.</p>`;
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
    return `<p class="fine">This phone: battery ${Math.round(b.level * 100)}%${b.charging ? ", charging" : ""}.</p>`;
  } catch { return ""; }
}

// A paired router follows this hotspot's switch and limits (firmware/openwrt/nod-sync.sh) and reports back.
function wireRouters(el, h) {
  const list = el.querySelector("[data-routers]");
  const keyBox = el.querySelector("[data-key]");
  const ago = (t) => {
    const m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
  };
  async function load() {
    try {
      const { routers } = await api("GET", `/api/me/hotspots/${h.id}/routers`);
      list.textContent = routers.length ? "" : "No router paired. Pair one so it follows Start/Stop and your limits from here.";
      for (const r of routers) {
        const row = document.createElement("div");
        row.className = "row between";
        const seen = r.lastSeen ? `${esc(r.state ?? "checked in")} · ${ago(r.lastSeen)}` : "Hasn't checked in yet";
        const extra = [r.tempC != null ? `${r.tempC}°C` : "", r.usedMb != null ? `${r.usedMb} MB shared today` : ""].filter(Boolean).join(" · ");
        row.innerHTML = `<span><strong>${esc(r.name)}</strong><br>${seen}${extra ? ` · ${esc(extra)}` : ""}</span><button type="button">Unpair</button>`;
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
      keyBox.innerHTML = `<div class="notice"><strong>${esc(router.name)} paired.</strong> Run this on the router now. The key is shown only once; if you lose it, unpair and pair again.
        <pre class="cmd"></pre><button type="button">Copy</button></div>`;
      const cmd = `uci set node.settings.key='${key}'; uci commit node; nod-sync`;
      keyBox.querySelector("pre").textContent = cmd;
      keyBox.querySelector("button").addEventListener("click", () => navigator.clipboard?.writeText(cmd));
      load();
    } catch (e) { keyBox.textContent = e.message; }
  });
  load();
}

async function renderHost() {
  if (!me) {
    view.innerHTML = `<section class="card"><h2>Host Nøde</h2><p class="muted">Share part of your connection with neighbours or customers, within limits you set. It's separate from using Nøde.</p></section>`;
    view.append(signInCard());
    return;
  }
  const on = me.consent.host_bandwidth.granted;
  if (!on) {
    view.innerHTML = `
      <section class="card">
        <h2>Share your connection</h2>
        <p>Hosting lets Nøde guests use part of your internet. It's a separate choice from using Nøde Wi-Fi.</p>
        <div class="notice"><strong>Before you turn this on:</strong> it uses your data allowance and battery, and your internet plan must allow sharing. Mobile hosting works only on phones we've tested.</div>
        <div class="row start"><button class="primary" id="opt">Yes, I want to host</button></div>
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
    ${anyActive ? `<section class="card center"><button class="stop" id="stopall">Stop sharing now</button><p class="fine">Stops every hotspot you run, immediately.</p></section>` : ""}
    <section class="card"><h2>Your hotspots</h2>${await batteryNote()}
      ${hotspots.length ? "" : `<p class="muted">None yet. Add your home router, venue Wi-Fi or a Nøde device below.</p>`}
      <div id="spots"></div></section>
    <section class="card"><h3>Add a hotspot</h3>
      <form id="add">
        <div class="grid">
          <label class="field"><span>Name people see</span><input type="text" name="name" maxlength="60" required placeholder="Corner Café"></label>
          <label class="field"><span>Wi-Fi network name</span><input type="text" name="ssid" maxlength="32" value="Nøde"></label>
          <label class="field"><span>Type</span><select name="kind">
            <option value="home">Nøde Home (household broadband)</option><option value="business">Nøde Business (venue guest Wi-Fi)</option>
            <option value="relay">Nøde Relay</option><option value="gateway">Nøde Gateway</option><option value="phone">This phone (tested devices only)</option></select></label>
        </div>
        ${limitsForm({ maxMbps: 10, dailyMb: 2048, minBatteryPct: 40, maxTempC: 42, hours: [] })}
        <p class="fine">We store your location only to about 150 m so people can find the hotspot.</p>
        <div class="row start"><button class="primary">Add hotspot</button></div>
        <p class="error" id="adderr" aria-live="polite"></p>
      </form></section>
    <section class="card"><h3>Stop hosting entirely</h3><p class="muted">Turns off sharing and every hotspot.</p><button id="optout">Stop hosting</button></section>`;

  const spots = $("#spots");
  for (const h of hotspots) {
    const el = document.createElement("form");
    el.className = "card";
    el.innerHTML = `<div class="row between"><div><strong>${esc(h.name)}</strong> <span class="tag">${esc(h.kind)}</span><br>
      <span class="muted">${h.active ? "Sharing" : "Stopped"} · ${esc(h.ssid)}</span></div>
      <button type="button" class="${h.active ? "stop" : "primary"}" data-toggle>${h.active ? "Stop" : "Start sharing"}</button></div>
      ${limitsForm(h.limits)}<div class="row start"><button>Save limits</button>${h.kind === "business" ? `<button type="button" data-activity>Busy hours</button>` : ""}</div><div data-out class="fine"></div>
      ${h.kind === "phone" ? "" : `<h3>Nøde routers</h3><div data-routers class="fine">Loading…</div>
      <div class="row start"><button type="button" data-pair>Pair a router</button></div><div data-key></div>`}`;
    el.querySelector("[data-toggle]").addEventListener("click", async () => { await api("PATCH", `/api/me/hotspots/${h.id}`, { active: !h.active }); renderHost(); });
    el.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      try { await api("PATCH", `/api/me/hotspots/${h.id}`, { limits: readLimits(el) }); el.querySelector("[data-out]").textContent = "Saved."; }
      catch (e) { el.querySelector("[data-out]").textContent = e.message; }
    });
    el.querySelector("[data-activity]")?.addEventListener("click", async () => {
      const r = await api("GET", `/api/me/hotspots/${h.id}/activity`);
      el.querySelector("[data-out]").innerHTML = r.rows.length
        ? r.rows.map((x) => `${esc(new Date(x.hour).toLocaleString())}: ~${x.sessions} sessions`).join("<br>")
        : `Not enough visits yet to show (hours with fewer than 10 sessions are hidden).`;
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
    }, () => { $("#adderr").textContent = "We need the hotspot's location (to about 150 m) so people can find it."; });
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

function loadBar() {
  return new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = "/cumulus-bar.js";
    s.dataset.client = config.cidClient;
    s.dataset.issuer = config.cidIssuer;
    s.dataset.product = "node";
    s.onload = s.onerror = () => resolve();
    document.head.append(s);
  });
}

async function start() {
  try { config = { ...config, ...(await api("GET", "/api/config")) }; } catch {}
  await loadBar();
  await loadMe();
  window.addEventListener("cumulus-id", async () => { await loadMe(); route(); });
  window.addEventListener("hashchange", route);
  route();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
}
start();
