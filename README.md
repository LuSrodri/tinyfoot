# tinyfoot

The planet in miniature, live.

A 3D globe you can zoom from orbit down to a street corner, rendered like a tilt-shift model railway — with the real world moving on it in real time.

| Layer | What you see | Source | Real? |
| --- | --- | --- | --- |
| Aircraft | Every aircraft with a transponder on, in the air **and on the ground**, drawn as a 3D model of its airframe family in its operator's colours. Click one for its exact model, registration, operator, altitude, speed, trail and planned route. | [adsb.lol](https://adsb.lol) (fallback [adsb.fi](https://adsb.fi)), [adsbdb](https://www.adsbdb.com), [OpenSky](https://opensky-network.org) | Live, ~5 s |
| Satellites | ISS, the brightest satellites, GPS, weather and science spacecraft at their true altitude. | [CelesTrak](https://celestrak.org) orbital elements, propagated in the browser (SGP4) | Live, computed |
| Ships | Vessels with AIS: name, type, size, destination. | [Fintraffic](https://www.digitraffic.fi/en/marine-traffic/) (Baltic, no key) · [aisstream.io](https://aisstream.io) (world-wide, optional free key) | Live, ~20 s |
| Trains & buses | Buses, trams, metros, trains and ferries where the operator publishes open vehicle positions. | 20 open feeds — see [`shared/feeds.ts`](shared/feeds.ts) | Live, 8–30 s |
| Shops & places | Green = open now, red = closed, evaluated in the place's own local time. | OpenStreetMap `opening_hours` via Overpass | Live rule evaluation |
| Traffic | Cars and trucks moving along the real street network. | Simulated | **Estimate** |
| Pedestrians | People walking along pavements and footpaths. | Simulated | **Estimate** |

Traffic and pedestrians are **not** real vehicles or people. No open world-wide feed of individual cars or pedestrians exists. They are an illustration of the flow you would expect right now: agents on the real street geometry, with density and speed estimated from local time of day, day of the week and street class. The UI labels them as estimates.

The base map is OpenStreetMap vector tiles from [OpenFreeMap](https://openfreemap.org) (refreshed weekly), real terrain from [Mapterhorn](https://mapterhorn.com) and buildings extruded from OSM heights, including `building:part` detail on landmarks. No API key is needed for anything above.

## View modes

- **Miniature** — tilt-shift: a sharp band across the middle, progressively blurred toward the top and bottom, with boosted colour.
- **Map** — the plain map.
- **Satellite** — Sentinel-2 cloudless imagery ([EOX](https://s2maps.eu), CC BY-NC-SA 4.0).
- **Night** — dark map; windows of vehicles and aircraft light up.

A day/night terminator is drawn on the globe from the actual position of the sun.

## Light on any device

- No model files, textures or icon fonts: every aircraft, ship, train, bus, car and person is a few hundred triangles generated at start-up and drawn with GPU instancing in one custom WebGL layer.
- The device is classified on load (cores, memory, touch, data-saver) into light / medium / high, which sets pixel ratio, frame-rate cap, terrain, blur passes and how many simulated agents are drawn. If frames get slow it steps down by itself. You can override it in the “i” dialog or with `?q=low|medium|high`.
- Opening-hours parsing and timezone lookup are only downloaded when you zoom into a street.
- Rendering pauses in background tabs.

## How it works

```
browser ── MapLibre GL JS (globe + terrain + buildings)
   │        └─ one instanced custom layer for everything that moves
   │
   └─ /api/* ── Cloudflare Worker: caching pass-through to the open feeds
```

The Worker (`worker/index.ts`) does no parsing — bytes in, bytes out, with a short edge cache per feed so that all viewers share one upstream request. The browser decodes everything, including GTFS-Realtime protobuf with a ~100-line reader (`src/data/gtfsrt.ts`).

Positions arrive every few seconds; between reports each object is dead-reckoned along its last course and speed and eased toward the next report (`src/util/mover.ts`), so motion is continuous.

## Run it

```sh
npm install
npm run dev      # Vite on :5173, Worker API on :8787
```

```sh
npm run deploy   # build + wrangler deploy
```

### Optional keys

Both are free and only widen coverage; everything else works without them.

```sh
npx wrangler secret put AISSTREAM_KEY   # ships world-wide (aisstream.io)
npx wrangler secret put SPTRANS_TOKEN   # São Paulo buses (sptrans.com.br/desenvolvedores)
```

### Adding a city's buses or trains

If the operator publishes GTFS-Realtime vehicle positions without a key, add one entry to [`shared/feeds.ts`](shared/feeds.ts):

```ts
{ id: 'mycity', name: 'My City Transit', bbox: [west, south, east, north], format: 'gtfsrt', mode: 'bus', ttl: 15, url: 'https://…/VehiclePositions.pb' },
```

## Limits worth knowing

- Aircraft coverage is what volunteer receivers hear; oceans and some regions are sparse. From a whole-planet view only the busiest air-traffic regions on the visible side are sampled; zoom in for everything.
- Satellites above 2,500 km (GPS, geostationary) are drawn at 2,500 km so they stay in view.
- Buildings are OSM extrusions, not photogrammetry: shapes and heights are real where mapped, façades are not.
- Shops without an `opening_hours` tag in OSM are not shown.

## License

Code: MIT. Map data © OpenStreetMap contributors (ODbL). Each data source keeps its own terms; see the links above.
