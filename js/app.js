/* 42RadarFlight — a minimal FlightRadar24-style live ADS-B viewer.
 *
 * Data sources (all free, keyless, CORS-enabled):
 *  - Live positions:  https://api.adsb.lol/v2/...           (aggregated ADS-B)
 *  - Flight routes:   https://api.adsb.lol/api/0/routeset   (callsign -> airports)
 *  - Flight track:    https://opensky-network.org/api/tracks/all
 *    (falls back to a trail accumulated from live positions in this session)
 */

"use strict";

const ADSB_API = "https://api.adsb.lol";
const OPENSKY_API = "https://opensky-network.org/api";

const REFRESH_MS = 8000;          // live position refresh interval
const MAX_RADIUS_NM = 250;        // adsb.lol hard limit
const TRAIL_MAX_POINTS = 800;     // per-aircraft session trail cap
const STALE_MS = 10 * 60 * 1000;  // forget aircraft not seen for 10 min

// ---------------------------------------------------------------------------
// Map setup
// ---------------------------------------------------------------------------

const map = L.map("map", { zoomControl: true }).setView([50.05, 8.6], 8); // Frankfurt area

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const trackLayer = L.layerGroup().addTo(map);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  aircraft: new Map(),   // hex -> latest ADS-B record
  markers: new Map(),    // hex -> Leaflet marker
  trails: new Map(),     // hex -> [{lat, lon, ts}] accumulated this session
  routes: new Map(),     // callsign -> {origin, dest, airports} | null (looked up, none found)
  routePending: new Set(),
  selectedHex: null,
  lastUpdate: null,
  fetchError: null,
};

const ui = {
  limit: document.getElementById("limit-select"),
  filterAirport: document.getElementById("filter-airport"),
  filterRoute: document.getElementById("filter-route"),
  clearFilters: document.getElementById("clear-filters"),
  status: document.getElementById("status"),
  planeList: document.getElementById("plane-list"),
  detailPanel: document.getElementById("detail-panel"),
  detailCallsign: document.getElementById("detail-callsign"),
  detailBody: document.getElementById("detail-body"),
  detailClose: document.getElementById("detail-close"),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function callsignOf(ac) {
  return (ac.flight || "").trim().toUpperCase();
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function viewRadiusNm() {
  const b = map.getBounds();
  const c = map.getCenter();
  const corner = b.getNorthEast();
  const km = distanceKm(c.lat, c.lng, corner.lat, corner.lng);
  return Math.max(10, Math.min(MAX_RADIUS_NM, Math.round(km / 1.852)));
}

function fmtAlt(ac) {
  if (ac.alt_baro === "ground") return "on ground";
  const alt = ac.alt_baro ?? ac.alt_geom;
  return Number.isFinite(alt) ? `${alt.toLocaleString()} ft` : "—";
}

function fmtSpeed(ac) {
  return Number.isFinite(ac.gs) ? `${Math.round(ac.gs)} kt` : "—";
}

function fmtHeading(ac) {
  const h = ac.track ?? ac.true_heading ?? ac.mag_heading;
  return Number.isFinite(h) ? `${Math.round(h)}°` : "—";
}

function fmtVertRate(ac) {
  const vr = ac.baro_rate ?? ac.geom_rate;
  if (!Number.isFinite(vr)) return "—";
  const arrow = vr > 100 ? "↑" : vr < -100 ? "↓" : "→";
  return `${arrow} ${Math.abs(vr).toLocaleString()} ft/min`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// ---------------------------------------------------------------------------
// Plane icon
// ---------------------------------------------------------------------------

function planeIcon(heading, selected) {
  const color = selected ? "#f5a623" : "#2f9dff";
  const size = selected ? 34 : 28;
  const rot = Number.isFinite(heading) ? heading : 0;
  // Material Design "flight" glyph, nose pointing north at 0°.
  const html = `
    <svg width="${size}" height="${size}" viewBox="0 0 24 24"
         style="transform: rotate(${rot}deg);">
      <path fill="${color}" stroke="#0d1420" stroke-width="0.6"
        d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>
    </svg>`;
  return L.divIcon({
    className: "plane-icon",
    html,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

// ---------------------------------------------------------------------------
// Live position fetching (adsb.lol)
// ---------------------------------------------------------------------------

async function fetchAircraft() {
  const c = map.getCenter();
  const radius = viewRadiusNm();
  const urls = [
    `${ADSB_API}/v2/lat/${c.lat.toFixed(4)}/lon/${c.lng.toFixed(4)}/dist/${radius}`,
    `${ADSB_API}/v2/point/${c.lat.toFixed(4)}/${c.lng.toFixed(4)}/${radius}`,
  ];

  let data = null;
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!data) {
    state.fetchError = lastErr;
    render();
    return;
  }

  state.fetchError = null;
  state.lastUpdate = Date.now();
  const now = Date.now();

  for (const ac of data.ac || []) {
    if (!Number.isFinite(ac.lat) || !Number.isFinite(ac.lon)) continue;
    state.aircraft.set(ac.hex, { ...ac, _seen: now });

    // accumulate session trail
    let trail = state.trails.get(ac.hex);
    if (!trail) {
      trail = [];
      state.trails.set(ac.hex, trail);
    }
    const last = trail[trail.length - 1];
    if (!last || last.lat !== ac.lat || last.lon !== ac.lon) {
      trail.push({ lat: ac.lat, lon: ac.lon, ts: now });
      if (trail.length > TRAIL_MAX_POINTS) trail.splice(0, trail.length - TRAIL_MAX_POINTS);
    }
  }

  // drop stale aircraft
  for (const [hex, ac] of state.aircraft) {
    if (now - ac._seen > STALE_MS) {
      state.aircraft.delete(hex);
      state.trails.delete(hex);
    }
  }

  fetchRoutes();
  render();
}

// ---------------------------------------------------------------------------
// Route lookup (adsb.lol routeset) — needed for airport / route filters
// ---------------------------------------------------------------------------

async function fetchRoutes() {
  const wanted = [];
  for (const ac of state.aircraft.values()) {
    const cs = callsignOf(ac);
    if (cs && !state.routes.has(cs) && !state.routePending.has(cs)) {
      wanted.push({ callsign: cs, lat: ac.lat, lng: ac.lon });
    }
  }
  if (wanted.length === 0) return;

  const batch = wanted.slice(0, 100);
  batch.forEach((p) => state.routePending.add(p.callsign));

  try {
    const res = await fetch(`${ADSB_API}/api/0/routeset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planes: batch }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const results = await res.json();

    for (const r of results || []) {
      const cs = (r.callsign || "").toUpperCase();
      const airports = r._airports || [];
      if (airports.length >= 2) {
        state.routes.set(cs, {
          origin: airports[0],
          dest: airports[airports.length - 1],
          airports,
        });
      } else {
        state.routes.set(cs, null); // looked up, nothing known
      }
    }
    // anything the API didn't answer for: mark unknown so we don't loop
    for (const p of batch) {
      if (!state.routes.has(p.callsign)) state.routes.set(p.callsign, null);
    }
    render();
  } catch (err) {
    console.warn("routeset lookup failed:", err);
  } finally {
    batch.forEach((p) => state.routePending.delete(p.callsign));
  }
}

function routeOf(ac) {
  const cs = callsignOf(ac);
  return cs ? state.routes.get(cs) : undefined; // undefined = not looked up yet
}

// ---------------------------------------------------------------------------
// Filtering + limiting
// ---------------------------------------------------------------------------

function airportMatches(airport, code) {
  if (!airport) return false;
  return (
    (airport.icao || "").toUpperCase() === code ||
    (airport.iata || "").toUpperCase() === code
  );
}

function visibleAircraft() {
  const airportCode = ui.filterAirport.value.trim().toUpperCase();
  const routeRaw = ui.filterRoute.value.trim().toUpperCase();
  let routeFrom = null;
  let routeTo = null;
  if (routeRaw) {
    const parts = routeRaw.split(/[-–>\s]+/).filter(Boolean);
    routeFrom = parts[0] || null;
    routeTo = parts[1] || null;
  }
  const filtering = Boolean(airportCode || routeFrom);

  let list = [...state.aircraft.values()];

  if (filtering) {
    list = list.filter((ac) => {
      const route = routeOf(ac);
      if (!route) return false; // unknown or no route -> hide while filtering
      if (airportCode) {
        if (!airportMatches(route.origin, airportCode) && !airportMatches(route.dest, airportCode)) {
          return false;
        }
      }
      if (routeFrom && !airportMatches(route.origin, routeFrom)) return false;
      if (routeTo && !airportMatches(route.dest, routeTo)) return false;
      return true;
    });
  }

  // sort nearest to map centre, then cap at the selected count
  const c = map.getCenter();
  list.sort(
    (a, b) =>
      distanceKm(c.lat, c.lng, a.lat, a.lon) - distanceKm(c.lat, c.lng, b.lat, b.lon)
  );
  const limit = parseInt(ui.limit.value, 10);
  if (limit > 0) list = list.slice(0, limit);
  return list;
}

// ---------------------------------------------------------------------------
// Rendering: markers, list, status
// ---------------------------------------------------------------------------

function render() {
  const shown = visibleAircraft();
  const shownHexes = new Set(shown.map((ac) => ac.hex));

  // remove markers no longer shown
  for (const [hex, marker] of state.markers) {
    if (!shownHexes.has(hex)) {
      marker.remove();
      state.markers.delete(hex);
    }
  }

  // add / update markers
  for (const ac of shown) {
    const selected = ac.hex === state.selectedHex;
    const icon = planeIcon(ac.track, selected);
    let marker = state.markers.get(ac.hex);
    if (!marker) {
      marker = L.marker([ac.lat, ac.lon], { icon, riseOnHover: true });
      marker.on("click", () => selectAircraft(ac.hex));
      marker.addTo(map);
      state.markers.set(ac.hex, marker);
    } else {
      marker.setLatLng([ac.lat, ac.lon]);
      marker.setIcon(icon);
    }
    const cs = callsignOf(ac) || ac.hex;
    marker.bindTooltip(`${cs}${ac.t ? " · " + ac.t : ""}`, { direction: "top", offset: [0, -12] });
  }

  renderPlaneList(shown);
  renderStatus(shown);

  if (state.selectedHex) {
    if (state.aircraft.has(state.selectedHex)) {
      renderDetail();
      updateSelectedTrackLine();
    } else {
      // selected plane went stale
      clearSelection();
    }
  }
}

function renderPlaneList(shown) {
  ui.planeList.innerHTML = "";
  for (const ac of shown) {
    const cs = callsignOf(ac) || ac.hex.toUpperCase();
    const route = routeOf(ac);
    const routeStr = route
      ? `${route.origin.icao || route.origin.iata} → ${route.dest.icao || route.dest.iata}`
      : route === null
        ? "route n/a"
        : "route …";

    const row = document.createElement("div");
    row.className = "plane-row" + (ac.hex === state.selectedHex ? " selected" : "");
    row.innerHTML = `
      <span class="cs">${escapeHtml(cs)}</span>
      <span class="type">${escapeHtml(ac.t || "?")}</span>
      <span class="route">${escapeHtml(routeStr)}</span>`;
    row.addEventListener("click", () => {
      selectAircraft(ac.hex);
      map.panTo([ac.lat, ac.lon]);
    });
    ui.planeList.appendChild(row);
  }
}

function renderStatus(shown) {
  const total = state.aircraft.size;
  const time = state.lastUpdate ? new Date(state.lastUpdate).toLocaleTimeString() : "—";
  let html = `Showing <b>${shown.length}</b> of ${total} aircraft in range · updated ${time}`;
  if (state.fetchError) {
    html += `<br><span class="warn">Live data fetch failed (${escapeHtml(
      state.fetchError.message || "network error"
    )}) — retrying…</span>`;
  }
  ui.status.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Selection + detail panel + track
// ---------------------------------------------------------------------------

async function selectAircraft(hex) {
  state.selectedHex = hex;
  render();
  drawTrack(hex); // async: OpenSky first, session-trail fallback
}

function clearSelection() {
  state.selectedHex = null;
  trackLayer.clearLayers();
  ui.detailPanel.classList.add("hidden");
  render();
}

function renderDetail() {
  const ac = state.aircraft.get(state.selectedHex);
  if (!ac) return;
  const cs = callsignOf(ac) || ac.hex.toUpperCase();
  const route = routeOf(ac);

  ui.detailCallsign.textContent = cs;

  const items = [
    ["Aircraft type", ac.t || "unknown"],
    ["Registration", ac.r || "—"],
    ["Altitude", fmtAlt(ac)],
    ["Ground speed", fmtSpeed(ac)],
    ["Heading", fmtHeading(ac)],
    ["Vertical rate", fmtVertRate(ac)],
    ["Squawk", ac.squawk || "—"],
    ["ICAO hex", ac.hex.toUpperCase()],
  ];
  if (ac.desc) items.splice(1, 0, ["Type description", ac.desc]);
  if (ac.ownOp) items.push(["Operator", ac.ownOp]);

  let html = `<div class="detail-grid">${items
    .map(
      ([k, v]) =>
        `<div class="item${k === "Type description" ? " wide" : ""}">
           <div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(v)}</div>
         </div>`
    )
    .join("")}</div>`;

  if (route) {
    const o = route.origin;
    const d = route.dest;
    html += `
      <div class="route-box">
        <div class="codes">${escapeHtml(o.icao || o.iata || "?")} → ${escapeHtml(d.icao || d.iata || "?")}</div>
        <div><b>From:</b> ${escapeHtml(o.name || "?")}${o.location ? ", " + escapeHtml(o.location) : ""}</div>
        <div><b>To:</b> ${escapeHtml(d.name || "?")}${d.location ? ", " + escapeHtml(d.location) : ""}</div>
      </div>`;
  } else if (route === null) {
    html += `<div class="route-box">No route / flight plan data available for this callsign.</div>`;
  } else {
    html += `<div class="route-box">Looking up route…</div>`;
  }

  html += `<div class="trail-note" id="trail-note"></div>`;
  ui.detailBody.innerHTML = html;
  ui.detailPanel.classList.remove("hidden");
}

// --- track drawing ---------------------------------------------------------

let trackFetchToken = 0;

async function drawTrack(hex) {
  const token = ++trackFetchToken;
  let points = null;
  let source = null;

  // 1) try OpenSky's track-so-far endpoint (full trip since takeoff)
  try {
    const res = await fetch(`${OPENSKY_API}/tracks/all?icao24=${hex.toLowerCase()}&time=0`);
    if (res.ok) {
      const data = await res.json();
      const path = (data.path || [])
        .filter((p) => Number.isFinite(p[1]) && Number.isFinite(p[2]))
        .map((p) => [p[1], p[2]]);
      if (path.length >= 2) {
        points = path;
        source = "OpenSky Network (full track since takeoff)";
      }
    }
  } catch {
    /* CORS/rate-limit/offline — fall through to session trail */
  }

  // 2) fallback: trail accumulated while this page has been open
  if (!points) {
    const trail = state.trails.get(hex) || [];
    if (trail.length >= 2) {
      points = trail.map((p) => [p.lat, p.lon]);
      source = "positions collected this session (OpenSky track unavailable)";
    }
  }

  if (token !== trackFetchToken || hex !== state.selectedHex) return; // superseded

  trackLayer.clearLayers();
  if (points) {
    L.polyline(points, { color: "#f5a623", weight: 3, opacity: 0.85 }).addTo(trackLayer);
    L.polyline(points, { color: "#7a4d00", weight: 5, opacity: 0.25 }).addTo(trackLayer);
  }

  const note = document.getElementById("trail-note");
  if (note) {
    note.textContent = points
      ? `Track: ${points.length} points — source: ${source}`
      : "No track available yet — it will build up as positions arrive.";
  }
}

/** Keep the selected plane's live trail growing without re-hitting OpenSky. */
function updateSelectedTrackLine() {
  // If the OpenSky fetch already drew a full track, leave it; otherwise
  // redraw the session trail so it extends with each refresh.
  const layers = trackLayer.getLayers();
  if (layers.length === 0) drawTrack(state.selectedHex);
}

// ---------------------------------------------------------------------------
// Events + boot
// ---------------------------------------------------------------------------

ui.limit.addEventListener("change", render);
ui.filterAirport.addEventListener("input", render);
ui.filterRoute.addEventListener("input", render);
ui.clearFilters.addEventListener("click", () => {
  ui.filterAirport.value = "";
  ui.filterRoute.value = "";
  render();
});
ui.detailClose.addEventListener("click", clearSelection);

let moveTimer = null;
map.on("moveend", () => {
  clearTimeout(moveTimer);
  moveTimer = setTimeout(fetchAircraft, 400);
});

fetchAircraft();
setInterval(fetchAircraft, REFRESH_MS);
