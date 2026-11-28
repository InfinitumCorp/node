// Nøde web app. No framework; renders three views into <main> from the URL hash.
import { placePins, ringKm } from "./radar.js";
import { LANGS, apiError, choose, lang, routerState, setup, t, tIn } from "./i18n.js";
import qrcode from "./qrcode.vendor.js";

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
  let r;
  try { r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch {
    throw Object.assign(new Error(navigator.onLine === false
      ? t("You're offline. Join any Wi-Fi network named “Nøde” and try again.")
      : t("Can't reach Nøde right now. Check your connection and try again.")), { status: 0 });
  }
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
      <div id="results" aria-live="polite"></div>
    </section>`;
  $("#locate").addEventListener("click", () => {
    const out = $("#results");
    out.innerHTML = `<p class="muted">${t("Finding you…")}</p>`;
    if (!navigator.geolocation) { out.innerHTML = `<p class="error">${t("This browser can't share a location.")}</p>`; return; }
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        const { hotspots } = await api("GET", `/api/hotspots?lat=${pos.coords.latitude.toFixed(3)}&lng=${pos.coords.longitude.toFixed(3)}`);
        const anyLive = hotspots.some((h) => h.verified) && hotspots.some((h) => !h.verified);
        out.innerHTML = hotspots.length ? `${anyLive ? `<label class="check"><input type="checkbox" id="liveonly"> ${t("Only show hotspots a router confirmed in the last 20 minutes")}</label>` : ""}<div class="radar-box"></div><ul class="list">${hotspots.map((h, i) => `
          <li data-live="${h.verified ? 1 : 0}"><div><span class="pin-no" aria-hidden="true">${i + 1}</span> <strong><a href="#/spot/${esc(h.id)}">${esc(h.name)}</a></strong>${h.verified ? ` <span class="tag ok" title="${esc(t("A Nøde router reported sharing in the last 20 minutes"))}">${t("live")}</span>` : ""}<br><span class="muted">${esc(t("Network: {ssid} · about {km} km", { ssid: h.ssid, km: h.distanceKm.toLocaleString(lang) }))}</span></div>
          <div><span class="tag">${esc(t(h.kind))}</span><br><button data-measure="${esc(h.id)}">${t("I'm on it")}</button><br>${problemPicker(h.id)}</div></li>`).join("")}</ul>`
          : `<p class="muted">${t("No Nøde hotspots here yet. Coverage grows place by place —")} <a href="#/host">${t("host one")}</a>.</p>`;
        if (hotspots.length) out.querySelector(".radar-box").append(radar(pos.coords, hotspots));
        out.querySelector("#liveonly")?.addEventListener("change", (e) => {
          const only = e.currentTarget.checked;
          out.querySelectorAll("li[data-live]").forEach((li) => { li.hidden = only && li.dataset.live !== "1"; });
          out.querySelectorAll(".radar .pin").forEach((g) => { g.classList.toggle("dim", only && !g.classList.contains("live")); });
        });
        out.querySelectorAll("[data-measure]").forEach((b) => b.addEventListener("click", () => measure(b.dataset.measure, b)));
        out.querySelectorAll("[data-problem]").forEach((s) => s.addEventListener("change", () => reportProblem(s)));
      } catch (e) { out.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
    }, () => { out.innerHTML = `<p class="error">${t("Location wasn't shared. You can still join any network named “Nøde”.")}</p>`; }, { maximumAge: 300000, timeout: 15000 });
  });
}

/**
 * Where the hotspots are from you: direction and distance on rings, drawn here with no map tiles,
 * so your location never leaves the page. Hotspot positions are the ~150 m cells the API gives.
 */
function radar(me, hotspots) {
  const ns = "http://www.w3.org/2000/svg", R = 140, C = 160;
  const el = (name, attrs, text) => {
    const n = document.createElementNS(ns, name);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    if (text != null) n.textContent = text;
    return n;
  };
  const ring = ringKm(hotspots.map((h) => h.distanceKm));
  const svg = el("svg", { viewBox: "0 0 320 320", class: "radar", role: "img",
    "aria-label": t("Map of {n} hotspots around you, up to {km} km", { n: hotspots.length, km: ring.toLocaleString(lang) }) });
  for (const f of [1 / 3, 2 / 3, 1]) svg.append(el("circle", { cx: C, cy: C, r: R * f, class: "ring" }));
  svg.append(el("text", { x: C + 4, y: C - R + 12, class: "ring-label" }, t("{km} km", { km: ring.toLocaleString(lang) })));
  for (const [x, y, d] of [[C, 12, "N"], [312, C + 4, "E"], [C, 316, "S"], [8, C + 4, "W"]]) svg.append(el("text", { x, y, class: "compass", "text-anchor": "middle" }, t(d)));
  svg.append(el("circle", { cx: C, cy: C, r: 6, class: "me" }));
  const pins = placePins(me, hotspots, R);
  hotspots.forEach((h, i) => {
    const x = C + pins[i].x, y = C + pins[i].y;
    const g = el("g", { class: h.verified ? "pin live" : "pin" });
    g.append(el("title", {}, h.name), el("circle", { cx: x, cy: y, r: 10 }), el("text", { x, y: y + 4, "text-anchor": "middle" }, i + 1));
    svg.append(g);
  });
  return svg;
}

const PROBLEM_TIPS = {
  no_internet: "No internet: check the router's own connection and that the daily data limit isn't used up.",
  not_found: "Can't find it: check the network name on your sign matches, and that sharing hours include now.",
  asks_password: "Asks for a password: the guest network must be open; re-run the router setup or check the phone hotspot settings.",
  slow: "Too slow: raise the guest speed cap if your connection allows, or move the router closer to where guests sit.",
};

const PROBLEMS = {
  no_internet: "Connected, but no internet",
  not_found: "Couldn't find the network",
  asks_password: "It asked for a password",
  slow: "Too slow to use",
};

function problemPicker(id) {
  if (sessionGet(`problem:${id}`)) return `<span class="fine">${t("Reported. Thank you.")}</span>`;
  return `<select data-problem="${esc(id)}" aria-label="${esc(t("Report a problem with this hotspot"))}">
    <option value="">${t("Report a problem…")}</option>
    ${Object.entries(PROBLEMS).map(([k, v]) => `<option value="${k}">${t(v)}</option>`).join("")}
  </select>`;
}

/** Tells the host something is wrong. Only a daily count per reason is kept: nothing about you. */
async function reportProblem(select) {
  const hotspot = select.dataset.problem, reason = select.value;
  if (!reason) return;
  select.disabled = true;
  try {
    await api("POST", "/api/telemetry", { kind: "problem", hotspot, session: sessionId(), reason });
    sessionSet(`problem:${hotspot}`, "1");
    select.replaceWith(Object.assign(document.createElement("span"), { className: "fine", textContent: t("Reported. Thank you.") }));
  } catch (e) {
    select.disabled = false;
    select.value = "";
    select.after(Object.assign(document.createElement("span"), { className: "error", textContent: ` ${e.message}` }));
  }
}

function sessionGet(k) { try { return sessionStorage.getItem(`node:${k}`); } catch { return null; } }
function sessionSet(k, v) { try { sessionStorage.setItem(`node:${k}`, v); } catch { /* private mode */ } }

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
      <details id="history"><summary>${t("Your choices over time")}</summary><div data-history class="fine"></div></details>
    </section>
    <section class="card">
      <h3>${t("Your data, to keep or delete")}</h3>
      <p class="muted">${t("Download a copy of everything Nøde holds about you, or delete it all. Deleting removes your Nøde account, your choices and any hotspots you host. Anonymous measurements were never linked to you.")}</p>
      <div class="row start"><button type="button" id="export">${t("Download my data")}</button><button id="erase">${t("Delete my Nøde data")}</button></div>
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
  $("#history").addEventListener("toggle", async (e) => {
    if (!e.currentTarget.open) return;
    const box = view.querySelector("[data-history]");
    try {
      const { consentLedger } = await api("GET", "/api/me/export");
      const title = Object.fromEntries(purposes.map((p) => [p.id, t(p.title)]));
      box.innerHTML = consentLedger.length
        ? `<ul class="list">${[...consentLedger].sort((a, b) => b.at - a.at).map((x) => `<li><div>${esc(title[x.purpose] ?? x.purpose)}<br><span class="muted">${esc(new Date(x.at).toLocaleString(lang))}</span></div><span class="tag ${x.granted ? "ok" : ""}">${x.granted ? t("allowed") : t("declined")}</span></li>`).join("")}</ul>`
        : esc(t("No choices recorded yet, so the starting choices for where you live apply."));
    } catch (err) { box.textContent = err.message; }
  });
  $("#jur").addEventListener("change", async () => {
    await api("PUT", "/api/me/consent", { jurisdiction: $("#jur").value, choices: {} });
    await loadMe();
    renderPrivacy();
  });
  $("#export").addEventListener("click", async () => {
    const r = await fetch("/api/me/export", { headers: { authorization: `Bearer ${token()}`, accept: "application/json" } });
    if (!r.ok) { $("#saved").textContent = t("Request failed ({status})", { status: r.status }); return; }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await r.blob());
    a.download = "node-my-data.json";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
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
    <div class="row start presets">${[["", "Any time"], ["8-19", "Daytime 08–20"], ["9-17", "Office 09–18"], ["18-22", "Evenings 18–23"]]
      .map(([v, label]) => `<button type="button" class="link" data-hours="${v}">${t(label)}</button>`).join("")}</div>
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

const when = (ts) => {
  const d = new Date(ts), today = new Date();
  const time = d.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === today.toDateString() ? time : `${d.toLocaleDateString(lang, { weekday: "short" })} ${time}`;
};

// Matches ROUTER_LIVE_MS in src/store.ts: four missed 5-minute check-ins.
const ROUTER_LIVE_MS = 20 * 60_000;

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
        // While the hotspot is on, say why this router isn't putting it on the map.
        if (h.active) {
          const quiet = r.lastSeen ? Date.now() - r.lastSeen > ROUTER_LIVE_MS : Date.now() - r.createdAt > ROUTER_LIVE_MS;
          const why = quiet
            ? (r.lastSeen ? t("Last heard from {ago}, so the hotspot is off the map. Check the router's power and internet.", { ago: ago(r.lastSeen) })
              : t("It hasn't checked in since it was paired. Run the command shown when you paired it, or unpair and pair again."))
            : r.state && r.state !== "sharing" ? t("Not on the map right now: {state}.", { state: routerState(r.state) }) : "";
          if (why) list.append(Object.assign(document.createElement("p"), { className: "warn", textContent: why }));
        }
        if (r.days?.length) {
          const max = Math.max(1, ...r.days.map((d) => d.usedMb));
          const days = document.createElement("ul");
          days.className = "days";
          days.setAttribute("aria-label", t("Guest data by day"));
          for (const d of r.days) {
            const li = document.createElement("li");
            li.innerHTML = `<span>${esc(new Date(d.endedAt).toLocaleDateString(lang, { weekday: "short", day: "numeric", month: "short" }))}</span><meter min="0"></meter><span>${esc(t("{n} MB", { n: d.usedMb.toLocaleString(lang) }))}</span>`;
            const m = li.querySelector("meter");
            m.max = max;
            m.value = d.usedMb;
            days.append(li);
          }
          list.append(days);
        }
      }
    } catch (e) { list.textContent = e.message; }
  }
  el.querySelector("[data-pair]").addEventListener("click", async () => {
    try {
      const { router, key } = await api("POST", `/api/me/hotspots/${h.id}/routers`, {});
      // A new router gets the one-command installer (it checks the scripts against SHA256SUMS); one already
      // running Nøde only needs the key. Through the Russian mirror both point at the mirror.
      const site = location.origin;
      const api_ = site === "https://node.infinitumcorporation.ai" ? "" : ` NODE_API='${site}'`;
      const role = ["home", "business", "relay", "gateway"].includes(h.kind) ? h.kind : "home";
      const cmds = [
        [t("New router (OpenWrt 23.05 or later):"), `wget -qO /tmp/nod-install.sh ${site}/firmware/openwrt/nod-install.sh && ROLE=${role} NODE_KEY='${key}'${api_} sh /tmp/nod-install.sh`],
        [t("Router that already runs Nøde:"), `uci set node.settings.key='${key}';${api_ ? ` uci set node.settings.api='${site}';` : ""} uci commit node; nod-sync`],
      ];
      keyBox.innerHTML = `<div class="notice"><strong>${esc(t("{name} paired.", { name: router.name }))}</strong> ${t("Run one of these on the router now. The key is shown only once; if you lose it, unpair and pair again.")}
        ${cmds.map(() => `<p class="fine"></p><pre class="cmd"></pre><button type="button">${t("Copy")}</button>`).join("")}</div>`;
      const labels = keyBox.querySelectorAll("p.fine"), pres = keyBox.querySelectorAll("pre"), buttons = keyBox.querySelectorAll("button");
      cmds.forEach(([label, cmd], i) => {
        labels[i].textContent = label;
        pres[i].textContent = cmd;
        buttons[i].addEventListener("click", async () => { try { await navigator.clipboard.writeText(cmd); buttons[i].textContent = t("Copied"); } catch {} });
      });
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
    <section class="card"><h2>${t("Your hotspots")}</h2><p class="muted" id="week" aria-live="polite"></p>${await batteryNote()}
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
  api("GET", "/api/me/summary").then((s) => {
    if (!s.hotspots) return;
    const gb = s.sharedMb >= 1000 ? t("{n} GB", { n: (s.sharedMb / 1024).toLocaleString(lang, { maximumFractionDigits: 1 }) }) : t("{n} MB", { n: s.sharedMb });
    $("#week").textContent = [
      t("{sharing} of {total} sharing now", { sharing: s.sharing, total: s.hotspots }),
      s.liveRouters ? t("{n} routers live", { n: s.liveRouters }) : null,
      s.sharedMb ? t("{data} shared with guests this week", { data: gb }) : null,
      s.problems ? t("{n} problem reports", { n: s.problems }) : null,
    ].filter(Boolean).join(" · ");
  }).catch(() => {});
  for (const h of hotspots) {
    const el = document.createElement("form");
    el.className = "card";
    const paused = h.active && h.pausedUntil && h.pausedUntil > Date.now();
    const status = !h.active ? t("Stopped") : paused ? t("Paused until {time}", { time: when(h.pausedUntil) }) : t("Sharing");
    el.innerHTML = `<div class="row between"><div><strong>${esc(h.name)}</strong> <span class="tag">${esc(t(h.kind))}</span><br>
      <span class="muted">${esc(status)} · ${esc(h.ssid)}</span></div>
      <div class="row end">
        ${h.active && !paused ? `<select data-pause aria-label="${esc(t("Pause sharing"))}"><option value="">${t("Pause…")}</option>
          <option value="1">${t("for 1 hour")}</option><option value="3">${t("for 3 hours")}</option><option value="morning">${t("until 8:00 tomorrow")}</option></select>` : ""}
        ${paused ? `<button type="button" class="primary" data-resume>${t("Resume now")}</button>` : ""}
        <button type="button" class="${h.active ? "stop" : "primary"}" data-toggle>${h.active ? t("Stop") : t("Start sharing")}</button></div></div>
      <div class="grid">
        <label class="field"><span>${t("Name people see")}</span><input type="text" name="hname" maxlength="60" required value="${esc(h.name)}"></label>
        <label class="field"><span>${t("Wi-Fi network name")}</span><input type="text" name="ssid" maxlength="32" required value="${esc(h.ssid)}"></label>
      </div>
      ${limitsForm(h.limits)}<div class="row start"><button>${t("Save changes")}</button>${h.kind === "business" ? `<button type="button" data-activity>${t("Busy hours")}</button>` : ""}<a class="button" href="#/sign/${esc(h.id)}">${t("Print a sign")}</a><button type="button" data-share>${t("Share link")}</button><button type="button" class="link danger" data-remove>${t("Remove this hotspot")}</button></div><div data-out class="fine" aria-live="polite"></div>
      <p class="fine" data-quality></p>
      <p class="fine warn" data-problems hidden></p>
      ${h.kind === "phone" ? "" : `<h3>${t("Nøde routers")}</h3><div data-routers class="fine">${t("Loading…")}</div>
      <div class="row start"><button type="button" data-pair>${t("Pair a router")}</button></div><div data-key></div>`}`;
    el.querySelector("[data-toggle]").addEventListener("click", async () => { await api("PATCH", `/api/me/hotspots/${h.id}`, { active: !h.active }); renderHost(); });
    el.querySelector("[data-resume]")?.addEventListener("click", async () => { await api("PATCH", `/api/me/hotspots/${h.id}`, { pausedUntil: null }); renderHost(); });
    el.querySelector("[data-pause]")?.addEventListener("change", async (ev) => {
      const v = ev.target.value;
      if (!v) return;
      let until;
      if (v === "morning") { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); until = d.getTime(); }
      else until = Date.now() + Number(v) * 3_600_000;
      await api("PATCH", `/api/me/hotspots/${h.id}`, { pausedUntil: until });
      renderHost();
    });
    el.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const f = el.elements;
      try {
        await api("PATCH", `/api/me/hotspots/${h.id}`, { name: f.namedItem("hname").value, ssid: f.namedItem("ssid").value, limits: readLimits(el) });
        el.querySelector("[data-out]").textContent = h.kind === "phone" || f.namedItem("ssid").value === h.ssid ? t("Saved.") : t("Saved. Paired routers switch to the new network name within 5 minutes.");
      }
      catch (e) { el.querySelector("[data-out]").textContent = e.message; }
    });
    el.querySelector("[data-share]").addEventListener("click", async (e) => {
      const url = `${location.origin}/#/spot/${h.id}`, btn = e.currentTarget;
      try {
        if (navigator.share) await navigator.share({ title: h.name, text: t("Free Wi-Fi: join “{ssid}”", { ssid: h.ssid }), url });
        else { await navigator.clipboard.writeText(url); btn.textContent = t("Link copied"); }
      } catch (err) { if (err?.name !== "AbortError") el.querySelector("[data-out]").textContent = url; }
    });
    el.querySelector("[data-remove]").addEventListener("click", async () => {
      if (!confirm(t("Remove “{name}”? Its routers stop working and its history is deleted. This can't be undone.", { name: h.name }))) return;
      try { await api("DELETE", `/api/me/hotspots/${h.id}`); renderHost(); }
      catch (e) { el.querySelector("[data-out]").textContent = e.message; }
    });
    el.querySelector("[data-activity]")?.addEventListener("click", async () => {
      const r = await api("GET", `/api/me/hotspots/${h.id}/activity`);
      const out = el.querySelector("[data-out]");
      if (!r.rows.length) { out.textContent = t("Not enough visits yet to show (hours with fewer than 10 sessions are hidden)."); return; }
      // The shown hours, added up by time of day in your time zone.
      const byHour = new Map();
      for (const x of r.rows) { const hr = new Date(x.hour).getHours(); byHour.set(hr, (byHour.get(hr) ?? 0) + x.sessions); }
      const max = Math.max(...byHour.values());
      const list = document.createElement("ul");
      list.className = "days";
      for (const [hr, n] of [...byHour].sort((a, b) => a[0] - b[0])) {
        const li = document.createElement("li");
        li.innerHTML = `<span>${esc(`${String(hr).padStart(2, "0")}:00`)}</span><meter min="0"></meter><span>${esc(t("~{n} sessions", { n }))}</span>`;
        Object.assign(li.querySelector("meter"), { max, value: n });
        list.append(li);
      }
      out.replaceChildren(Object.assign(document.createElement("p"), { textContent: t("Busy hours this week, by time of day (hours with fewer than 10 sessions are hidden):") }), list);
    });
    api("GET", `/api/me/hotspots/${h.id}/quality`).then((q) => {
      el.querySelector("[data-quality]").textContent = !q.enough
        ? t("Guest speed: not enough measurements in the last 7 days yet (needs {n} guests who share network quality).", { n: q.minSessions })
        : t("Guests, last 7 days: about {sessions} sessions, typical download {down} Mbit/s, {ok}% connected.", {
          sessions: q.sessions, down: q.medianDownMbps == null ? "—" : q.medianDownMbps.toLocaleString(lang), ok: Math.round(q.successRate * 100) });
    }).catch(() => {});
    api("GET", `/api/me/hotspots/${h.id}/problems`).then(({ problems }) => {
      const seen = Object.entries(problems).filter(([, n]) => n > 0);
      if (!seen.length) return;
      const box = el.querySelector("[data-problems]");
      box.textContent = t("Guests reported, last 7 days: {list}", {
        list: seen.map(([k, n]) => t("{what} ({n})", { what: t(PROBLEMS[k] ?? k), n })).join(", ") });
      box.after(...seen.filter(([k]) => PROBLEM_TIPS[k]).map(([k]) => Object.assign(document.createElement("p"), { className: "fine", textContent: t(PROBLEM_TIPS[k]) })));
      box.hidden = false;
    }).catch(() => {});
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
// ---------- Venue sign ----------
// A printable notice for the hotspot's window or counter: the network to join and a QR code to Nøde.
function qrSvg(text) {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  const n = q.getModuleCount(), pad = 4, ns = "http://www.w3.org/2000/svg";
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + pad} ${r + pad}h1v1h-1z`;
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${n + 2 * pad} ${n + 2 * pad}`);
  svg.setAttribute("class", "qr");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", t("QR code: {url}", { url: text }));
  svg.setAttribute("shape-rendering", "crispEdges");
  const bg = document.createElementNS(ns, "rect");
  bg.setAttribute("width", "100%"); bg.setAttribute("height", "100%"); bg.setAttribute("fill", "#fff");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", d); p.setAttribute("fill", "#000");
  svg.append(bg, p);
  return svg;
}

async function renderSign() {
  const hid = (location.hash.match(/^#\/sign\/(hs_[A-Za-z0-9_-]+)/) || [])[1];
  if (!me) { view.innerHTML = ""; view.append(signInCard()); return; }
  const { hotspots } = await api("GET", "/api/me/hotspots");
  const h = hotspots.find((x) => x.id === hid);
  if (!h) { view.innerHTML = `<section class="card"><p class="error">${t("No such hotspot.")}</p><a href="#/host">${t("Back to your hotspots")}</a></section>`; return; }
  const url = `${location.origin}/#/spot/${h.id}`;
  const other = lang === "ru" ? "en" : "ru";
  view.innerHTML = `
    <section class="card no-print"><div class="row between"><a href="#/host">${t("Back to your hotspots")}</a><button class="primary" id="print">${t("Print")}</button></div>
      <p class="fine">${t("Put it where guests can see it. It shows only the network name, never your address.")}</p>
      <label class="field"><span>${t("Sign language")}</span><select id="signlang">
        ${[[lang, LANGS.find((l) => l.code === lang)?.name ?? lang], [other, LANGS.find((l) => l.code === other)?.name ?? other], [`${lang}+${other}`, t("Both")]]
          .map(([v, n]) => `<option value="${esc(v)}">${esc(n)}</option>`).join("")}
      </select></label></section>
    <article class="sign"></article>`;
  const draw = (codes) => {
    // Each line in the first language, with the second underneath in smaller type.
    const line = (key, cls = "") => codes.map((c, i) => `<span class="${i ? "sign-alt" : cls}" lang="${c}">${esc(tIn(c, key))}</span>`).join(codes.length > 1 ? "<br>" : "");
    const art = $(".sign");
    art.setAttribute("lang", codes[0]);
    art.innerHTML = `
      <p class="sign-kicker">${line("Free Wi-Fi")}</p>
      <h1>${esc(h.name)}</h1>
      <p>${line("Join the network")}</p>
      <p class="sign-ssid">${esc(h.ssid)}</p>
      <p>${line("No password. Guests are on their own network, kept apart from ours.")}</p>
      <div class="sign-qr"></div>
      <p class="fine">${line("Scan to check it's working, report a problem or find more free Wi-Fi:")} ${esc(location.host)}</p>`;
    $(".sign-qr").append(qrSvg(url));
  };
  draw([lang]);
  $("#signlang").addEventListener("change", (e) => draw(e.currentTarget.value.split("+")));
  $("#print").addEventListener("click", () => window.print());
}

/** The page a sign's QR code opens: one hotspot's network and status, with nothing about where it is. */
async function renderSpot() {
  const hid = (location.hash.match(/^#\/spot\/(hs_[A-Za-z0-9_-]+)/) || [])[1];
  let h;
  try { ({ hotspot: h } = await api("GET", `/api/hotspots/${hid}`)); }
  catch { view.innerHTML = `<section class="card"><p class="error">${t("No such hotspot.")}</p><a href="#/find">${t("Find free Wi-Fi near you")}</a></section>`; return; }
  const status = {
    sharing: t("Sharing now"),
    paused: t("Paused until {time}", { time: new Date(h.pausedUntil).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" }) }),
    off: t("Not sharing right now"),
    quiet: t("Its router hasn't checked in recently, so it may be off"),
  }[h.status];
  view.innerHTML = `
    <section class="card">
      <p class="muted">${t("Free Wi-Fi")} · ${esc(t(h.kind))}</p>
      <h2>${esc(h.name)}</h2>
      <p>${t("Join the network")} <strong>${esc(h.ssid)}</strong></p>
      <p class="${h.status === "sharing" ? "" : "warn"}">${esc(status)}${h.verified ? ` <span class="tag ok">${t("live")}</span>` : ""}</p>
      <div class="row start"><button data-measure="${esc(h.id)}">${t("I'm on it")}</button>${problemPicker(h.id)}</div>
      <p class="fine"><a href="#/find">${t("Find free Wi-Fi near you")}</a></p>
    </section>`;
  view.querySelector("[data-measure]").addEventListener("click", (e) => measure(h.id, e.currentTarget));
  view.querySelector("[data-problem]")?.addEventListener("change", (e) => reportProblem(e.currentTarget));
}

// Sharing-hour presets: "8-19" ticks 08 to 19, i.e. sharing from 08:00 until 20:00. "" clears (any time).
document.addEventListener("click", (e) => {
  const b = e.target.closest?.("[data-hours]");
  if (!b) return;
  const [from, to] = b.dataset.hours ? b.dataset.hours.split("-").map(Number) : [1, 0];
  b.closest("form")?.querySelectorAll('input[name="hour"]').forEach((i) => { const h = Number(i.value); i.checked = h >= from && h <= to; });
});

const VIEWS = { find: renderFind, privacy: renderPrivacy, host: renderHost, sign: renderSign, spot: renderSpot };
async function route() {
  const name = (location.hash.match(/^#\/(\w+)/) || [])[1] || "find";
  const render = VIEWS[name] || renderFind;
  const tab = name === "sign" ? "host" : name === "spot" ? "find" : name;
  document.querySelectorAll(".tabs a").forEach((a) => (a.dataset.tab === tab ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
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
