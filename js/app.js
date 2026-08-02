/* 42RadarFlight — a minimal FlightRadar24-style live ADS-B viewer.
 *
 * Live positions come from a chain of free, keyless, CORS-enabled providers;
 * if one is down (or blocked by an ad-blocker), the app fails over to the
 * next automatically:
 *   adsb.lol -> airplanes.live -> adsb.one -> adsb.fi -> OpenSky Network
 *
 * Routes (origin/destination): adsb.lol routeset API, with adsbdb.com as
 * per-callsign fallback. Aircraft info fallback: adsbdb.com by hex.
 * Track so far: OpenSky tracks API, falling back to the trail accumulated
 * from live positions during this session.
 */

"use strict";

const REFRESH_MS = 8000;          // live position refresh interval
const MAX_RADIUS_NM = 250;        // common provider limit
const TRAIL_MAX_POINTS = 800;     // per-aircraft session trail cap
const STALE_MS = 10 * 60 * 1000;  // forget aircraft not seen for 10 min
const ADSBDB_LOOKUPS_PER_CYCLE = 5;

// ---------------------------------------------------------------------------
// Map setup
// ---------------------------------------------------------------------------

const map = L.map("map", { zoomControl: true }).setView([50.05, 8.6], 8); // Frankfurt area

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const trackLayer = L.layerGroup().addTo(map);

// --- "center on my position" control ---------------------------------------

const locationLayer = L.layerGroup().addTo(map);

const LocateControl = L.Control.extend({
  options: { position: "topleft" },
  onAdd() {
    const btn = L.DomUtil.create("a", "locate-btn leaflet-bar");
    btn.href = "#";
    btn.title = "Center map on my position";
    btn.setAttribute("role", "button");
    btn.setAttribute("aria-label", "Center map on my position");
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path fill="currentColor" d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm8.94 3A8.99 8.99 0 0 0 13
          3.06V1h-2v2.06A8.99 8.99 0 0 0 3.06 11H1v2h2.06A8.99 8.99 0 0 0 11 20.94V23h2v-2.06A8.99
          8.99 0 0 0 20.94 13H23v-2h-2.06zM12 19a7 7 0 1 1 0-14 7 7 0 0 1 0 14z"/>
      </svg>`;
    L.DomEvent.on(btn, "click", (e) => {
      L.DomEvent.stop(e);
      locateMe(btn);
    });
    return btn;
  },
});
map.addControl(new LocateControl());

function showPosition(pos, recenter) {
  const { latitude, longitude, accuracy } = pos.coords;

  locationLayer.clearLayers();
  L.circle([latitude, longitude], {
    radius: Math.max(accuracy, 30),
    color: "#2f9dff",
    weight: 1,
    fillColor: "#2f9dff",
    fillOpacity: 0.12,
  }).addTo(locationLayer);
  L.circleMarker([latitude, longitude], {
    radius: 7,
    color: "#ffffff",
    weight: 2,
    fillColor: "#2f9dff",
    fillOpacity: 1,
  })
    .bindTooltip("You are here")
    .addTo(locationLayer);

  if (recenter) {
    // setView fires moveend, which reloads aircraft for the new area
    map.setView([latitude, longitude], Math.max(map.getZoom(), 8));
  }
}

const LOCATE_WINDOW_MS = 25000; // keep refining fixes for up to this long
const LOCATE_GOOD_ACCURACY_M = 100; // stop early once this accurate

function locateMe(btn) {
  if (!("geolocation" in navigator)) {
    setStatusNote("Geolocation is not supported by this browser.", true);
    return;
  }
  btn.classList.add("locating");

  let best = null;
  let finished = false;
  let watchId = null;

  const finish = (err) => {
    if (finished) return;
    finished = true;
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    clearTimeout(giveUpTimer);
    btn.classList.remove("locating");
    if (best) {
      const acc = best.coords.accuracy;
      setStatusNote(
        acc > 1000
          ? `Position found (accurate to ~${(acc / 1000).toFixed(1)} km) — tap the locate button again to refine.`
          : null
      );
    } else {
      const reasons = {
        1: "location permission denied — allow it in your browser settings",
        2: "position unavailable",
        3: "timed out waiting for a fix — try again outdoors or check that location is enabled for your browser",
      };
      setStatusNote(`Could not get your position: ${reasons[err?.code] || err?.message || "no fix"}.`, true);
    }
  };

  const giveUpTimer = setTimeout(() => finish({ code: 3 }), LOCATE_WINDOW_MS);

  // Center on the best fix seen so far; recenter only for the very first one.
  const usePos = (pos) => {
    if (finished) return;
    const isFirst = !best;
    if (isFirst || pos.coords.accuracy < best.coords.accuracy) {
      best = pos;
      showPosition(pos, isFirst);
    }
    if (pos.coords.accuracy <= LOCATE_GOOD_ACCURACY_M) finish();
  };

  // Fast path: explicitly ask for a cheap fix (cached or network-based).
  // This usually returns within a second, long before GPS has warmed up.
  navigator.geolocation.getCurrentPosition(
    usePos,
    () => {}, // ignore — the high-accuracy watch below is the fallback
    { enableHighAccuracy: false, maximumAge: 600000, timeout: 3000 }
  );

  // Refinement path: high-accuracy watch tightens the marker as GPS fixes
  // arrive. Stops early once accuracy is good.
  watchId = navigator.geolocation.watchPosition(
    usePos,
    (err) => {
      // only fatal if we never got any fix at all
      if (!best) finish(err);
      else finish();
    },
    { enableHighAccuracy: true, maximumAge: 300000, timeout: LOCATE_WINDOW_MS }
  );
}

let statusNote = null; // transient message shown in the status bar

function setStatusNote(msg, isWarning = false) {
  statusNote = msg ? { msg, isWarning } : null;
  render();
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  aircraft: new Map(),   // hex -> latest normalized position record
  markers: new Map(),    // hex -> Leaflet marker
  trails: new Map(),     // hex -> [{lat, lon, ts}] accumulated this session
  routes: new Map(),     // callsign -> {origin, dest} | null (looked up, none found)
  routePending: new Set(),
  acInfo: new Map(),     // hex -> {t, desc, r, ownOp} enrichment from adsbdb
  acInfoPending: new Set(),
  selectedHex: null,
  lastUpdate: null,
  fetchError: null,      // string describing why all providers failed
  dataSource: null,      // name of the provider currently delivering data
  routesetBroken: false, // adsb.lol batch route API unavailable -> use adsbdb
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
  btnFilters: document.getElementById("btn-filters"),
  btnSettings: document.getElementById("btn-settings"),
  filtersPanel: document.getElementById("filters-panel"),
  settingsPanel: document.getElementById("settings-panel"),
  flightSearch: document.getElementById("flight-search"),
  flightSearchBtn: document.getElementById("flight-search-btn"),
  flightPanel: document.getElementById("flight-panel"),
  flightTitle: document.getElementById("flight-title"),
  flightBody: document.getElementById("flight-body"),
  flightClose: document.getElementById("flight-close"),
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
  return Number.isFinite(alt) ? `${Math.round(alt).toLocaleString()} ft` : "—";
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
  return `${arrow} ${Math.abs(Math.round(vr)).toLocaleString()} ft/min`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function fetchOpts() {
  return typeof AbortSignal !== "undefined" && AbortSignal.timeout
    ? { signal: AbortSignal.timeout(8000) }
    : {};
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
// Live position providers (each returns a normalized aircraft array)
// ---------------------------------------------------------------------------

async function fetchTar1090Style(url) {
  const res = await fetch(url, fetchOpts());
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data.ac || []).filter((ac) => Number.isFinite(ac.lat) && Number.isFinite(ac.lon));
}

async function fetchOpenSkyStates() {
  const b = map.getBounds();
  const url =
    `https://opensky-network.org/api/states/all` +
    `?lamin=${b.getSouth().toFixed(3)}&lomin=${b.getWest().toFixed(3)}` +
    `&lamax=${b.getNorth().toFixed(3)}&lomax=${b.getEast().toFixed(3)}`;
  const res = await fetch(url, fetchOpts());
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data.states || [])
    .filter((s) => Number.isFinite(s[5]) && Number.isFinite(s[6]))
    .map((s) => ({
      hex: s[0],
      flight: (s[1] || "").trim(),
      lat: s[6],
      lon: s[5],
      alt_baro: s[8] ? "ground" : s[7] != null ? s[7] * 3.28084 : undefined,
      gs: s[9] != null ? s[9] * 1.94384 : undefined,
      track: s[10] ?? undefined,
      baro_rate: s[11] != null ? s[11] * 196.85 : undefined,
      squawk: s[14] || undefined,
      // no type/registration in OpenSky state vectors; enriched via adsbdb
    }));
}

const POSITION_PROVIDERS = [
  {
    name: "adsb.lol",
    fetch: (lat, lon, r) => fetchTar1090Style(`https://api.adsb.lol/v2/point/${lat}/${lon}/${r}`),
  },
  {
    name: "airplanes.live",
    fetch: (lat, lon, r) => fetchTar1090Style(`https://api.airplanes.live/v2/point/${lat}/${lon}/${r}`),
  },
  {
    name: "adsb.one",
    fetch: (lat, lon, r) => fetchTar1090Style(`https://api.adsb.one/v2/point/${lat}/${lon}/${r}`),
  },
  {
    name: "adsb.fi",
    fetch: (lat, lon, r) =>
      fetchTar1090Style(`https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${r}`),
  },
  {
    name: "OpenSky Network",
    fetch: () => fetchOpenSkyStates(),
  },
];

let providerIdx = 0; // sticks with the last provider that worked

async function fetchAircraft() {
  const c = map.getCenter();
  const lat = c.lat.toFixed(4);
  const lon = c.lng.toFixed(4);
  const radius = viewRadiusNm();

  let list = null;
  const errors = [];
  for (let i = 0; i < POSITION_PROVIDERS.length; i++) {
    const idx = (providerIdx + i) % POSITION_PROVIDERS.length;
    const provider = POSITION_PROVIDERS[idx];
    try {
      list = await provider.fetch(lat, lon, radius);
      providerIdx = idx;
      state.dataSource = provider.name;
      break;
    } catch (err) {
      errors.push(`${provider.name}: ${err.message || err.name || "failed"}`);
    }
  }

  if (!list) {
    state.fetchError = errors.join(" · ");
    render();
    return;
  }

  state.fetchError = null;
  state.lastUpdate = Date.now();
  const now = Date.now();

  for (const ac of list) {
    if (!ac.hex) continue;
    state.aircraft.set(ac.hex, { ...ac, _seen: now });

    // accumulate session trail
    let trail = state.trails.get(ac.hex);
    if (!trail) {
      trail = [];
      state.trails.set(ac.hex, trail);
    }
    const last = trail[trail.length - 1];
    if (!last || last.lat !== ac.lat || last.lon !== ac.lon) {
      const altVal =
        ac.alt_baro === "ground"
          ? 0
          : Number.isFinite(ac.alt_baro)
            ? ac.alt_baro
            : Number.isFinite(ac.alt_geom)
              ? ac.alt_geom
              : null;
      trail.push({ lat: ac.lat, lon: ac.lon, ts: now, alt: altVal });
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
// Route lookup — adsb.lol routeset (batch) with adsbdb.com fallback
// ---------------------------------------------------------------------------

function normalizeAdsbdbAirport(a) {
  return a
    ? { icao: a.icao_code, iata: a.iata_code, name: a.name, location: a.municipality }
    : null;
}

async function fetchRoutes() {
  const wanted = [];
  for (const ac of state.aircraft.values()) {
    const cs = callsignOf(ac);
    if (cs && !state.routes.has(cs) && !state.routePending.has(cs)) {
      wanted.push({ callsign: cs, lat: ac.lat, lng: ac.lon });
    }
  }
  if (wanted.length === 0) return;

  if (!state.routesetBroken) {
    const batch = wanted.slice(0, 100);
    batch.forEach((p) => state.routePending.add(p.callsign));
    try {
      const res = await fetch("https://api.adsb.lol/api/0/routeset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planes: batch }),
        ...fetchOpts(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const results = await res.json();

      for (const r of results || []) {
        const cs = (r.callsign || "").toUpperCase();
        const airports = r._airports || [];
        if (airports.length >= 2) {
          state.routes.set(cs, { origin: airports[0], dest: airports[airports.length - 1] });
        } else {
          state.routes.set(cs, null);
        }
      }
      for (const p of batch) {
        if (!state.routes.has(p.callsign)) state.routes.set(p.callsign, null);
      }
      render();
      return;
    } catch (err) {
      console.warn("adsb.lol routeset unavailable, falling back to adsbdb:", err);
      state.routesetBroken = true;
    } finally {
      batch.forEach((p) => state.routePending.delete(p.callsign));
    }
  }

  // adsbdb fallback: individual lookups, a few per refresh cycle.
  // Prioritize the selected plane, then the ones currently shown on the map.
  const priority = new Map(); // callsign -> rank
  const shownSet = new Set(visibleAircraft().map((a) => callsignOf(a)));
  for (const p of wanted) {
    const selectedCs =
      state.selectedHex && state.aircraft.has(state.selectedHex)
        ? callsignOf(state.aircraft.get(state.selectedHex))
        : null;
    priority.set(p.callsign, p.callsign === selectedCs ? 0 : shownSet.has(p.callsign) ? 1 : 2);
  }
  const queue = wanted
    .sort((a, b) => priority.get(a.callsign) - priority.get(b.callsign))
    .slice(0, ADSBDB_LOOKUPS_PER_CYCLE);

  await Promise.all(
    queue.map(async (p) => {
      state.routePending.add(p.callsign);
      try {
        const res = await fetch(
          `https://api.adsbdb.com/v0/callsign/${encodeURIComponent(p.callsign)}`,
          fetchOpts()
        );
        if (res.status === 404) {
          state.routes.set(p.callsign, null);
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const fr = data?.response?.flightroute;
        if (fr && fr.origin && fr.destination) {
          state.routes.set(p.callsign, {
            origin: normalizeAdsbdbAirport(fr.origin),
            dest: normalizeAdsbdbAirport(fr.destination),
            flightNumber: fr.callsign_iata || null,
          });
        } else {
          state.routes.set(p.callsign, null);
        }
      } catch (err) {
        console.warn(`adsbdb route lookup failed for ${p.callsign}:`, err);
        // leave un-cached so it can retry next cycle
      } finally {
        state.routePending.delete(p.callsign);
      }
    })
  );
  render();
}

function routeOf(ac) {
  const cs = callsignOf(ac);
  return cs ? state.routes.get(cs) : undefined; // undefined = not looked up yet
}

// ---------------------------------------------------------------------------
// Aircraft info enrichment (adsbdb by hex) — for providers without type data
// ---------------------------------------------------------------------------

async function fetchAircraftInfo(hex) {
  if (state.acInfo.has(hex) || state.acInfoPending.has(hex)) return;
  state.acInfoPending.add(hex);
  try {
    const res = await fetch(`https://api.adsbdb.com/v0/aircraft/${hex}`, fetchOpts());
    if (res.status === 404) {
      state.acInfo.set(hex, null);
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const a = data?.response?.aircraft;
    state.acInfo.set(
      hex,
      a
        ? {
            t: a.icao_type || a.type,
            desc: [a.manufacturer, a.type].filter(Boolean).join(" "),
            r: a.registration,
            ownOp: a.registered_owner,
          }
        : null
    );
    if (hex === state.selectedHex) renderDetail();
  } catch (err) {
    console.warn(`adsbdb aircraft lookup failed for ${hex}:`, err);
  } finally {
    state.acInfoPending.delete(hex);
  }
}

/** Merge live record with any adsbdb enrichment. */
function enriched(ac) {
  const info = state.acInfo.get(ac.hex);
  if (!info) return ac;
  return {
    ...ac,
    t: ac.t || info.t,
    desc: ac.desc || info.desc,
    r: ac.r || info.r,
    ownOp: ac.ownOp || info.ownOp,
  };
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
    const e = enriched(ac);
    const cs = callsignOf(ac) || ac.hex;
    marker.bindTooltip(`${cs}${e.t ? " · " + e.t : ""}`, { direction: "top", offset: [0, -12] });
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
  // the list lives inside the filters panel — skip DOM churn while hidden
  if (ui.filtersPanel.classList.contains("hidden")) return;
  ui.planeList.innerHTML = "";
  for (const ac of shown) {
    const e = enriched(ac);
    const cs = callsignOf(ac) || ac.hex.toUpperCase();
    const route = routeOf(ac);
    const routeStr = route
      ? `${route.origin.icao || route.origin.iata} → ${route.dest.icao || route.dest.iata}`
      : route === null
        ? "route n/a"
        : "route …";

    const flightNo = route?.flightNumber || null;
    const row = document.createElement("div");
    row.className = "plane-row" + (ac.hex === state.selectedHex ? " selected" : "");
    row.innerHTML = `
      <span class="cs" title="Tap for flight schedule">${escapeHtml(flightNo || cs)}</span>
      <span class="type">${escapeHtml(e.t || "?")}</span>
      <span class="route">${escapeHtml(routeStr)}</span>`;
    row.addEventListener("click", () => {
      selectAircraft(ac.hex);
      map.panTo([ac.lat, ac.lon]);
    });
    const csEl = row.querySelector(".cs");
    if (callsignOf(ac) || flightNo) {
      csEl.classList.add("clickable");
      csEl.addEventListener("click", (ev) => {
        ev.stopPropagation();
        searchFlight(flightNo || cs);
      });
    }
    ui.planeList.appendChild(row);
  }
}

function renderStatus(shown) {
  const total = state.aircraft.size;
  const time = state.lastUpdate ? new Date(state.lastUpdate).toLocaleTimeString() : "—";
  let html = `Showing <b>${shown.length}</b> of ${total} aircraft in range · updated ${time}`;
  if (state.dataSource) html += ` · via ${escapeHtml(state.dataSource)}`;
  if (state.fetchError) {
    html += `<br><span class="warn">All data sources failed — retrying…<br>${escapeHtml(
      state.fetchError
    )}</span>`;
  }
  if (statusNote) {
    html += `<br><span class="${statusNote.isWarning ? "warn" : ""}">${escapeHtml(statusNote.msg)}</span>`;
  }
  ui.status.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Selection + detail panel + track
// ---------------------------------------------------------------------------

async function selectAircraft(hex) {
  state.selectedHex = hex;
  const ac = state.aircraft.get(hex);
  if (ac && (!ac.t || !ac.r)) fetchAircraftInfo(hex); // enrich if provider lacks type data
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
  const raw = state.aircraft.get(state.selectedHex);
  if (!raw) return;
  const ac = enriched(raw);
  const cs = callsignOf(ac) || ac.hex.toUpperCase();
  const route = routeOf(ac);

  ui.detailCallsign.textContent = cs;

  const items = [
    ["Flight number", route?.flightNumber || "—"],
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

  if (cs && cs !== ac.hex.toUpperCase()) {
    html += `<button class="btn-mini sched-btn" id="detail-sched-btn">🗓 Flight schedule for ${escapeHtml(route?.flightNumber || cs)}</button>`;
  }

  html += `
    <div class="alt-legend">
      <span>0 ft</span>
      <div class="alt-bar"></div>
      <span>40,000+ ft</span>
    </div>
    <div class="trail-note" id="trail-note"></div>`;
  ui.detailBody.innerHTML = html;
  ui.detailPanel.classList.remove("hidden");

  const schedBtn = document.getElementById("detail-sched-btn");
  if (schedBtn) {
    schedBtn.addEventListener("click", () => searchFlight(route?.flightNumber || cs));
  }
}

// --- track drawing ---------------------------------------------------------
//
// Full history is fetched from adsb.lol's tar1090 trace endpoint (positions
// since UTC midnight, i.e. the whole current flight), with OpenSky's track
// API and the locally collected session trail as fallbacks. The line is
// drawn FlightRadar24-style: segments colored by altitude.

const TRACK_REFRESH_MS = 30000; // re-fetch history for the selected plane
const TRACK_MAX_DRAW_POINTS = 1500;

let trackFetchToken = 0;
const trackState = { hex: null, fetchedAt: 0, points: [], source: null };

function altColor(alt) {
  if (!Number.isFinite(alt)) return "#9aa7b5"; // unknown -> gray
  const a = Math.max(0, Math.min(alt, 40000));
  const hue = 50 + (a / 40000) * 250; // yellow (ground) -> magenta (FL400+)
  return `hsl(${Math.round(hue)}, 85%, 55%)`;
}

function altBucket(alt) {
  return Number.isFinite(alt) ? Math.round(alt / 2000) : -1;
}

/** Parse a tar1090-style trace file and keep only the current flight leg. */
function parseTar1090Trace(data) {
  const baseTs = Number(data.timestamp) || 0;
  const arr = data.trace || data.full?.trace || data.recent?.trace || [];
  const points = [];
  let lastAlt = null;
  for (const p of arr) {
    if (!Number.isFinite(p[1]) || !Number.isFinite(p[2])) continue;
    let alt = p[3];
    if (alt === "ground") alt = 0;
    if (!Number.isFinite(alt)) alt = lastAlt;
    else lastAlt = alt;
    points.push({
      lat: p[1],
      lon: p[2],
      alt,
      ts: baseTs + (Number(p[0]) || 0),
      newLeg: ((p[6] || 0) & 2) === 2, // readsb marks the first point of a new leg
    });
  }
  return currentLeg(points);
}

/**
 * A trace file covers the whole UTC day, i.e. every flight the aircraft made.
 * Keep only the latest leg: cut at readsb leg markers, at gaps of >15 min
 * without positions, and at lift-offs that follow >=5 min parked on ground.
 */
function currentLeg(points) {
  if (points.length < 2) return points;
  let start = 0;
  let groundSince = null;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (i > 0) {
      if (p.newLeg || p.ts - points[i - 1].ts > 900) {
        start = i;
        groundSince = null;
        continue;
      }
    }
    if (p.alt !== null && p.alt <= 100) {
      if (groundSince === null) groundSince = p.ts;
    } else {
      if (groundSince !== null && p.ts - groundSince >= 300) start = i;
      groundSince = null;
    }
  }
  return points.slice(start);
}

// tar1090 trace file layout used by most aggregator globes:
//   /data/traces/<last two hex chars>/trace_full_<hex>.json  (since UTC midnight)
const TRACE_BASES = [
  {
    name: "api.adsb.lol",
    url: (hex) => `https://api.adsb.lol/v0/trace/${hex}`,
  },
  {
    name: "globe.adsb.lol",
    url: (hex) => `https://globe.adsb.lol/data/traces/${hex.slice(-2)}/trace_full_${hex}.json`,
  },
  {
    name: "airplanes.live",
    url: (hex) => `https://globe.airplanes.live/data/traces/${hex.slice(-2)}/trace_full_${hex}.json`,
  },
  {
    name: "adsb.fi",
    url: (hex) => `https://globe.adsb.fi/data/traces/${hex.slice(-2)}/trace_full_${hex}.json`,
  },
];

// The globe servers don't send CORS headers, so direct browser fetches fail
// with "Failed to fetch". Retry each source through public CORS proxies —
// direct first, proxied only as fallback.
const CORS_PROXIES = [
  { suffix: "", wrap: (u) => u },
  { suffix: " (via allorigins)", wrap: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
  { suffix: " (via corsproxy)", wrap: (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}` },
];

const TRACE_SOURCES = [];
for (const proxy of CORS_PROXIES) {
  for (const base of TRACE_BASES) {
    TRACE_SOURCES.push({
      name: base.name + proxy.suffix,
      url: (hex) => proxy.wrap(base.url(hex)),
    });
  }
}

let traceSourceIdx = 0; // sticks with the last trace source that worked

async function fetchTrackPoints(hex) {
  const h = hex.toLowerCase();
  const errors = [];

  // 1) tar1090 trace files: full history since UTC midnight, with altitude
  for (let i = 0; i < TRACE_SOURCES.length; i++) {
    const idx = (traceSourceIdx + i) % TRACE_SOURCES.length;
    const src = TRACE_SOURCES[idx];
    try {
      const res = await fetch(src.url(h), fetchOpts());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const points = parseTar1090Trace(await res.json());
      if (points.length >= 2) {
        traceSourceIdx = idx;
        return { points, source: `${src.name} flight history`, errors };
      }
      errors.push(`${src.name}: empty trace`);
    } catch (err) {
      errors.push(`${src.name}: ${err.message || err.name || "failed"}`);
    }
  }

  // 2) OpenSky track-so-far (altitude in metres)
  try {
    const res = await fetch(
      `https://opensky-network.org/api/tracks/all?icao24=${h}&time=0`,
      fetchOpts()
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const points = (data.path || [])
      .filter((p) => Number.isFinite(p[1]) && Number.isFinite(p[2]))
      .map((p) => ({
        lat: p[1],
        lon: p[2],
        alt: Number.isFinite(p[3]) ? p[3] * 3.28084 : null,
      }));
    if (points.length >= 2) return { points, source: "OpenSky Network", errors };
    errors.push("OpenSky: empty track");
  } catch (err) {
    errors.push(`OpenSky: ${err.message || err.name || "failed"}`);
  }

  // 3) trail accumulated while this page has been open
  const trail = state.trails.get(hex) || [];
  if (trail.length >= 2) {
    return {
      points: trail.map((p) => ({ lat: p.lat, lon: p.lon, alt: p.alt })),
      source: "this session only",
      errors,
    };
  }
  return { points: [], source: null, errors };
}

async function drawTrack(hex) {
  const token = ++trackFetchToken;
  const { points, source, errors } = await fetchTrackPoints(hex);
  if (token !== trackFetchToken || hex !== state.selectedHex) return; // superseded

  trackState.hex = hex;
  trackState.fetchedAt = Date.now();
  trackState.points = points;
  trackState.source = source;
  trackState.errors = errors;
  renderTrackLayers();
}

/** Draw the stored track as altitude-colored segments plus a live connector. */
function renderTrackLayers() {
  trackLayer.clearLayers();
  let pts = trackState.points;

  if (pts.length >= 2) {
    // decimate very long traces, but always keep the newest point
    if (pts.length > TRACK_MAX_DRAW_POINTS) {
      const step = Math.ceil(pts.length / TRACK_MAX_DRAW_POINTS);
      const sampled = pts.filter((_, i) => i % step === 0);
      if (sampled[sampled.length - 1] !== pts[pts.length - 1]) sampled.push(pts[pts.length - 1]);
      pts = sampled;
    }

    // group consecutive points into segments per 2000 ft altitude band
    let seg = [pts[0]];
    let bucket = altBucket(pts[0].alt);
    const flush = () => {
      if (seg.length >= 2) {
        L.polyline(
          seg.map((p) => [p.lat, p.lon]),
          { color: altColor(seg[Math.floor(seg.length / 2)].alt), weight: 3, opacity: 0.9 }
        ).addTo(trackLayer);
      }
    };
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      seg.push(p);
      const b = altBucket(p.alt);
      if (b !== bucket) {
        flush();
        seg = [p];
        bucket = b;
      }
    }
    flush();
  }

  // connector from the last history point to the live position
  const ac = state.aircraft.get(trackState.hex);
  if (ac && pts.length >= 1) {
    const lastPt = pts[pts.length - 1];
    const liveAlt = ac.alt_baro === "ground" ? 0 : ac.alt_baro;
    L.polyline(
      [
        [lastPt.lat, lastPt.lon],
        [ac.lat, ac.lon],
      ],
      { color: altColor(liveAlt), weight: 3, opacity: 0.9 }
    ).addTo(trackLayer);
  }

  const note = document.getElementById("trail-note");
  if (note) {
    let text =
      trackState.points.length >= 2
        ? `Track: ${trackState.points.length} points — source: ${trackState.source}`
        : "No track available yet — it will build up as positions arrive.";
    // when history had to be skipped, say why per source
    const usingFallback =
      trackState.points.length < 2 || trackState.source === "this session only";
    if (usingFallback && trackState.errors?.length) {
      const shown = trackState.errors.slice(0, 8);
      const more = trackState.errors.length - shown.length;
      text += ` — history unavailable: ${shown.join(" · ")}${more > 0 ? ` · +${more} more` : ""}`;
    }
    note.textContent = text;
  }
}

/** Called on every data refresh while a plane is selected. */
function updateSelectedTrackLine() {
  if (trackState.hex !== state.selectedHex) return; // drawTrack in flight
  if (Date.now() - trackState.fetchedAt > TRACK_REFRESH_MS) {
    drawTrack(state.selectedHex); // periodic history re-fetch
  } else {
    renderTrackLayers(); // just extend the live connector
  }
}

// ---------------------------------------------------------------------------
// Flight number search + schedule panel
//
// Number resolution (OS26 <-> AUA26) and route: adsbdb.com (keyless).
// Live position by callsign: the ADS-B aggregators (keyless, worldwide).
// Multi-day schedule with planned/actual times: AeroDataBox via RapidAPI —
// needs a personal (free-tier) key, stored in localStorage only.
// ---------------------------------------------------------------------------

const FLIGHT_LIVE_SOURCES = [
  (cs) => `https://api.adsb.lol/v2/callsign/${cs}`,
  (cs) => `https://api.airplanes.live/v2/callsign/${cs}`,
  (cs) => `https://api.adsb.one/v2/callsign/${cs}`,
  (cs) => `https://opendata.adsb.fi/api/v2/callsign/${cs}`,
];

async function findLiveByCallsign(callsigns) {
  for (const cs of [...new Set(callsigns.filter(Boolean))]) {
    for (const mkUrl of FLIGHT_LIVE_SOURCES) {
      try {
        const res = await fetch(mkUrl(encodeURIComponent(cs)), fetchOpts());
        if (!res.ok) continue;
        const data = await res.json();
        const ac = (data.ac || []).find((a) => Number.isFinite(a.lat) && Number.isFinite(a.lon));
        if (ac) return ac;
      } catch {
        /* next source */
      }
    }
  }
  return null;
}

/** Put a live aircraft on the map, center on it and open its details. */
function showAircraftOnMap(ac) {
  state.aircraft.set(ac.hex, { ...ac, _seen: Date.now() });
  map.setView([ac.lat, ac.lon], Math.max(map.getZoom(), 7));
  selectAircraft(ac.hex);
}

function getAdbKey() {
  return localStorage.getItem("adbKey") || "";
}

function fmtAdbStamp(t) {
  // AeroDataBox time value: {local:"2026-08-02 07:40+02:00"} / {utc} / string
  const s = (t && (t.local || t.utc)) || (typeof t === "string" ? t : null);
  if (!s || s.length < 16) return { date: null, time: null };
  return { date: s.slice(0, 10), time: s.slice(11, 16) };
}

function segTimes(seg) {
  const sched = fmtAdbStamp(seg?.scheduledTime || seg?.scheduledTimeLocal);
  const act = fmtAdbStamp(
    seg?.actualTime || seg?.runwayTime || seg?.revisedTime || seg?.predictedTime || seg?.actualTimeLocal
  );
  return { sched, act };
}

const LIVE_STATUSES = new Set(["EnRoute", "Departed", "Approaching"]);

async function fetchSchedule(number) {
  const key = getAdbKey();
  if (!key) return { needKey: true };

  const headers = { "X-RapidAPI-Key": key, "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com" };
  const fmt = (d) => d.toISOString().slice(0, 10);
  const now = Date.now();
  const from = fmt(new Date(now - 3 * 864e5));
  const to = fmt(new Date(now + 1 * 864e5));
  const n = encodeURIComponent(number);

  let flights = null;
  try {
    const res = await fetch(
      `https://aerodatabox.p.rapidapi.com/flights/number/${n}/${from}/${to}?dateLocalRole=Both`,
      { headers, ...fetchOpts() }
    );
    if (res.status === 401 || res.status === 403) {
      return { error: "AeroDataBox rejected the API key — check the key and your (free) subscription on RapidAPI." };
    }
    if (res.ok) flights = await res.json();
  } catch {
    /* fall through to per-day */
  }

  if (!Array.isArray(flights)) {
    flights = [];
    for (let d = -3; d <= 1; d++) {
      try {
        const res = await fetch(
          `https://aerodatabox.p.rapidapi.com/flights/number/${n}/${fmt(new Date(now + d * 864e5))}`,
          { headers, ...fetchOpts() }
        );
        if (res.ok) {
          const j = await res.json();
          if (Array.isArray(j)) flights.push(...j);
        }
      } catch {
        /* skip day */
      }
    }
  }
  return { rows: flights };
}

let currentFlight = null;

async function searchFlight(query) {
  const q = query.trim().toUpperCase().replace(/\s+/g, "");
  if (!q) return;
  ui.flightPanel.classList.remove("hidden");
  ui.flightTitle.textContent = q;
  ui.flightBody.innerHTML = `<p class="hint">Searching ${escapeHtml(q)}…</p>`;

  // 1) resolve number/callsign + route via adsbdb
  let fr = null;
  try {
    const res = await fetch(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(q)}`, fetchOpts());
    if (res.ok) fr = (await res.json())?.response?.flightroute || null;
  } catch {
    /* keep nulls */
  }

  const flight = {
    query: q,
    csIcao: fr?.callsign_icao || null,
    csIata: fr?.callsign_iata || null,
    airline: fr?.airline?.name || null,
    origin: normalizeAdsbdbAirport(fr?.origin),
    dest: normalizeAdsbdbAirport(fr?.destination),
    live: null,
    schedule: null,
  };
  currentFlight = flight;

  // 2) is it in the air right now, anywhere in the world?
  flight.live = await findLiveByCallsign([flight.csIcao, q, flight.csIata]);
  if (currentFlight === flight) renderFlightPanel();

  // 3) multi-day schedule (needs AeroDataBox key)
  flight.schedule = await fetchSchedule(flight.csIata || q);
  if (currentFlight === flight) renderFlightPanel();
}

function renderFlightPanel() {
  const f = currentFlight;
  if (!f) return;
  const title = [f.csIata, f.csIcao].filter(Boolean).join(" · ") || f.query;
  ui.flightTitle.textContent = title;

  let html = "";
  if (f.airline) html += `<p class="flight-airline">${escapeHtml(f.airline)}</p>`;
  if (f.origin && f.dest) {
    html += `
      <div class="route-box">
        <div class="codes">${escapeHtml(f.origin.icao || f.origin.iata || "?")} → ${escapeHtml(f.dest.icao || f.dest.iata || "?")}</div>
        <div>${escapeHtml(f.origin.name || "?")} → ${escapeHtml(f.dest.name || "?")}</div>
      </div>`;
  }

  if (f.live) {
    html += `
      <div class="live-row">
        <span class="badge-live">LIVE</span>
        <span>${escapeHtml(fmtAlt(f.live))} · ${escapeHtml(fmtSpeed(f.live))}</span>
        <button class="btn-mini" data-find-cs="${escapeHtml((f.live.flight || "").trim() || f.query)}">📍 Find on map</button>
      </div>`;
  } else {
    html += `<p class="hint">Not airborne right now (or not receiving ADS-B).</p>`;
  }

  const s = f.schedule;
  if (!s) {
    html += `<p class="hint">Loading schedule…</p>`;
  } else if (s.needKey) {
    html += `
      <div class="keyform">
        <p class="hint">Multi-day schedules with planned/actual times need a free
          <a href="https://rapidapi.com/aedbx-aedbx/api/aerodatabox" target="_blank" rel="noopener">AeroDataBox (RapidAPI)</a>
          key. Paste it once — it is stored only in this browser.</p>
        <input id="adb-key-input" type="password" placeholder="RapidAPI key" autocomplete="off" />
        <button id="adb-key-save" class="btn-mini">Save key & load schedule</button>
      </div>`;
  } else if (s.error) {
    html += `<p class="hint warn">${escapeHtml(s.error)}</p>`;
  } else if (!s.rows?.length) {
    html += `<p class="hint">No schedule entries found for the last 3 days through tomorrow.</p>`;
  } else {
    html += `<h3 class="sched-h">Flights (last 3 days → tomorrow)</h3>`;
    const todayStr = new Date().toISOString().slice(0, 10);
    for (const row of s.rows) {
      const dep = segTimes(row.departure);
      const arr = segTimes(row.arrival);
      const date = dep.sched.date || dep.act.date || "?";
      const dayLabel =
        date === todayStr ? "Today" : date === new Date(Date.now() + 864e5).toISOString().slice(0, 10) ? "Tomorrow" : date;
      const o = row.departure?.airport || {};
      const d = row.arrival?.airport || {};
      const live = LIVE_STATUSES.has(row.status);
      html += `
        <div class="flight-card${live ? " live" : ""}">
          <div class="fc-top">
            <b>${escapeHtml(dayLabel)}</b>
            <span>${escapeHtml(o.iata || o.icao || "?")} → ${escapeHtml(d.iata || d.icao || "?")}</span>
            <span class="fc-status">${escapeHtml(row.status || "")}</span>
            ${live ? `<span class="badge-live">LIVE</span>
              <button class="btn-mini" data-find-cs="${escapeHtml(row.callSign || f.csIcao || f.query)}">📍</button>` : ""}
          </div>
          <div class="fc-times">
            <span>Dep ${escapeHtml(dep.sched.time || "—")}${dep.act.time ? ` <i>(act ${escapeHtml(dep.act.time)})</i>` : ""}</span>
            <span>Arr ${escapeHtml(arr.sched.time || "—")}${arr.act.time ? ` <i>(act/est ${escapeHtml(arr.act.time)})</i>` : ""}</span>
          </div>
        </div>`;
    }
    html += `<p class="hint">Times are local to each airport. "act" = actual/estimated.</p>`;
  }

  ui.flightBody.innerHTML = html;

  // wire dynamic buttons
  ui.flightBody.querySelectorAll("[data-find-cs]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      setStatusNote(`Locating ${btn.dataset.findCs}…`);
      const ac = await findLiveByCallsign([btn.dataset.findCs, currentFlight?.csIcao, currentFlight?.csIata]);
      if (ac) {
        setStatusNote(null);
        showAircraftOnMap(ac);
      } else {
        setStatusNote(`${btn.dataset.findCs}: no live position found right now.`, true);
      }
    });
  });
  const keySave = ui.flightBody.querySelector("#adb-key-save");
  if (keySave) {
    keySave.addEventListener("click", async () => {
      const val = ui.flightBody.querySelector("#adb-key-input").value.trim();
      if (!val) return;
      localStorage.setItem("adbKey", val);
      const f2 = currentFlight;
      f2.schedule = null;
      renderFlightPanel();
      f2.schedule = await fetchSchedule(f2.csIata || f2.query);
      if (currentFlight === f2) renderFlightPanel();
    });
  }
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

function toggleFloatPanel(panel, btn) {
  const wasHidden = panel.classList.contains("hidden");
  ui.filtersPanel.classList.add("hidden");
  ui.settingsPanel.classList.add("hidden");
  ui.btnFilters.classList.remove("active");
  ui.btnSettings.classList.remove("active");
  if (wasHidden) {
    panel.classList.remove("hidden");
    btn.classList.add("active");
    render(); // fill the plane list if it just became visible
  }
}
ui.btnFilters.addEventListener("click", () => toggleFloatPanel(ui.filtersPanel, ui.btnFilters));
ui.btnSettings.addEventListener("click", () => toggleFloatPanel(ui.settingsPanel, ui.btnSettings));

ui.flightSearchBtn.addEventListener("click", () => searchFlight(ui.flightSearch.value));
ui.flightSearch.addEventListener("keydown", (e) => {
  if (e.key === "Enter") searchFlight(ui.flightSearch.value);
});
ui.flightClose.addEventListener("click", () => {
  ui.flightPanel.classList.add("hidden");
  currentFlight = null;
});

let moveTimer = null;
map.on("moveend", () => {
  clearTimeout(moveTimer);
  moveTimer = setTimeout(fetchAircraft, 400);
});

fetchAircraft();
setInterval(fetchAircraft, REFRESH_MS);
