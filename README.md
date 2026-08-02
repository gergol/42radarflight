# 42RadarFlight

A minimal FlightRadar24-style web app: live ADS-B aircraft on an
OpenStreetMap-based map, with flight details, aircraft type, flight track,
and filtering by airport or route.

No build step, no API keys — plain HTML/CSS/JS with [Leaflet](https://leafletjs.com/).

## Features

- **Live aircraft positions** from the free [adsb.lol](https://adsb.lol) API,
  refreshed every 8 seconds for the area currently visible on the map.
- **Shows the 3 nearest planes by default** (switchable to 10 / 25 / 50 / all
  in range) so the map stays readable.
- **Click a plane** (on the map or in the sidebar list) to see:
  - callsign, ICAO aircraft type + type description, registration, operator
  - altitude, ground speed, heading, vertical rate, squawk, ICAO hex
  - the flight's route (origin → destination airports with full names)
  - the **track flown so far on the current trip**, drawn on the map
    (from the OpenSky Network track API; if that is unavailable it falls
    back to the trail collected while the page is open).
- **Filter by airport** — enter an ICAO code (e.g. `EDDF`) or IATA code
  (e.g. `FRA`) to show only flights departing from or arriving at that airport.
- **Filter by route** — e.g. `EDDF-KJFK` (origin-destination; a single code
  filters by origin only).

## Running it

Any static file server works. From the repo root:

```bash
python3 -m http.server 8000
# or: npx serve .
```

Then open <http://localhost:8000>.

> Opening `index.html` directly via `file://` mostly works too, but a local
> server is recommended so browser security policies don't get in the way.

## How it works

| Concern | Source |
|---|---|
| Map tiles | OpenStreetMap |
| Live positions, aircraft type, registration | `api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{nm}` |
| Route (origin/destination airports) | `api.adsb.lol/api/0/routeset` (POST, batched per callsign) |
| Track so far | `opensky-network.org/api/tracks/all?icao24=…&time=0`, with a client-side session trail as fallback |

Notes and limits:

- adsb.lol caps the search radius at 250 NM around the map centre; pan/zoom
  the map to load a different area.
- Route data is keyed by callsign; some flights (private, military, blocked)
  have no published route, and are hidden while an airport/route filter is
  active.
- The anonymous OpenSky track endpoint is rate-limited; when it declines, the
  app quietly falls back to the positions it has collected itself during the
  session.

## Files

```
index.html      page structure, Leaflet from CDN
css/style.css   layout and theming
js/app.js       all application logic
```
