# Design notes

How nullisland decides what to fetch and when. The README covers usage; this file covers the
tradeoffs behind the defaults.

## Discovery

Every layer is inspected independently. nullisland reads the service metadata, flattens group
layers, and records what each sublayer can do: query, export, renderer, scale limits,
`maxRecordCount`, and which query formats it supports. Discovery happens even for hidden layers, so
enabling one is instant. Invalid configuration entries are reported on the `error` event and skipped
— one bad URL cannot break the rest of the map.

## Strategy selection

| Service capability | Strategy | What is drawn |
| --- | --- | --- |
| MapServer with `Map` capability | `export` | A server-rendered PNG positioned over the map |
| FeatureServer (or MapServer without export) | `vector` | Features decoded client-side into a `google.maps.Data` layer |

Force a strategy per layer with `mode: 'export' | 'vector'`. `auto` is the default.

## Export mode

1. The viewport is expanded by 25% (`padding`).
2. The map is requested from `/export` in EPSG:3857 at the device pixel ratio, capped at 4096px.
3. The image is loaded with `img.src` and placed with a custom `OverlayView` using the div pixel
   coordinates of its geographic corners — not a `GroundOverlay`, which would apply a second
   geographic transformation to an image that is already in Web Mercator.
4. A new image cross-fades in over 150ms while the old one stays visible. Reduced-motion users get
   an instant swap.
5. Another image is requested when the zoom changes or roughly 85% of the padding has been panned
   away. A generation counter discards responses for viewports the user already left.

Export mode is cheap for dense layers: the server does the drawing, and the client downloads one
image instead of thousands of features. The tradeoff is that the result is raster — it cannot be
styled client-side, picked, or queried without an extra request.

## Vector mode

Requests are snapped outward to the OSM/XYZ tile grid one zoom level coarser than the map, which
makes cache keys deterministic and makes small pans free. Up to eight snapped viewports are cached
per layer (`cacheSize`).

Features are requested with:

- `f=pbf` when the service supports it, then `f=geojson`, then `f=json` (Esri JSON).
- `resultType=tile` and `quantizationParameters` (PBF only), which returns integer coordinates plus a
  transform — typically 5–10× smaller than raw doubles.
- `outSR=4326` and an envelope in WGS84.
- `orderByFields=<oid> ASC` and `resultOffset` only when the layer advertises
  `advancedQueryCapabilities.supportsPagination`.
- Page size from the service's `maxRecordCount`, capped at 2000.
- A hard cap of 10 pages / 20 000 features per viewport (`maxPages`, `maxFeatures`).

Each page is added to the `Data` layer as it arrives, before the previous viewport's features are
removed, so the layer never blanks out during navigation. If the viewport moves while a request is
in flight, the request is aborted and the response discarded.

## Styling

Colors resolve in this order:

1. `color` on the layer config.
2. The service's published renderer (`simple`, `uniqueValue`, `classBreaks`).
3. A default blue.

ArcGIS symbols are translated to `Data` styles, including marker icons rendered as inline SVG so
point size and outline survive. Visual variables, dash patterns, halos, labels and picture fills are
not translated — they degrade to the base symbol.

## Shared behaviour

- **Visibility is free.** Hiding a layer detaches it from the map but keeps decoded features and
  images in memory. Showing it again reattaches immediately.
- **Zoom gating.** Outside a layer's zoom range it is detached, not destroyed.
- **Antimeridian.** Viewports crossing ±180° are split into two longitude ranges before querying.
- **Loading indicator.** Optional, appears only after 300ms so quick loads do not flicker.
- **Prefetch.** `arc.prefetch(id)` warms the cache for the current viewport, e.g. on hover in a layer
  tray.

## Decisions

**Exports use `img.src`, not `fetch`.** ArcGIS `/export` endpoints are frequently served without CORS
headers, and an `<img>` does not need them. The default `exportTransport: 'image'` therefore works on
far more servers. The tradeoff is that a failed image reveals no status code; `exportTransport:
'fetch'` downloads a blob instead, adding abort, timeout and status handling at the cost of CORS.

**Refetch before the edge shows.** The exported image covers the viewport plus `padding`; a new image
is requested once ~85% of that margin has been panned away, not when the image stops covering the
view entirely.

**Cache keys are tile-snapped.** Vector queries snap outward to the XYZ grid one zoom level coarser
than the map. Keys are exact and repeatable, so a pan of a few hundred pixels reuses the previous
response instead of fetching an overlapping envelope.

**Queries stay in WGS84.** `inSR`/`outSR` are 4326 because `google.maps.Data` wants lat/lng. This
avoids a client-side reprojection pass and keeps quantization tolerance meaningful in degrees.

**PBF is probed, not assumed.** `supportedQueryFormats` is read first; FeatureServer ≥ 10.7 is
probed on first use because some servers serve PBF without advertising it. Fallback order is PBF →
GeoJSON → Esri JSON.

**Pagination is capability-gated.** `resultOffset` and `orderByFields` are only sent when the layer
advertises `advancedQueryCapabilities.supportsPagination`; older servers reject parameters they do
not know.

**One engine layer per service.** `sublayers` filters what is queried, but the result renders as one
Google layer. For independent toggles today, configure one layer per sublayer URL.

**URLs must be HTTPS.** Plain `http:` is rejected except for localhost, credentials embedded in URLs
are rejected, and only a service's metadata, `/query` and `/export` endpoints are requested. Set
`allowInsecure: true` for an internal HTTP server.

## PBF

Two formats share the name "PBF" in the ArcGIS world, and nullisland only deals with the second:

| Format | Endpoint | Decoder |
| --- | --- | --- |
| Mapbox Vector Tiles | `VectorTileServer/tile/{z}/{y}/{x}.pbf` | Many (deck.gl, MapLibre, `@mapbox/vector-tile`) |
| Esri FeatureCollection PBuffer | `FeatureServer/{id}/query?f=pbf` | This package, from the [Esri spec](https://github.com/Esri/arcgis-pbf) |

The decoder is a hand-written protobuf reader with no runtime dependency. It handles quantized
integer coordinates, per-ring delta encoding, the upper-left transform, attribute types, and polygon
ring grouping. It is usable standalone:

```ts
import {decodeFeatureCollection} from '@offthemap/nullisland/pbf';

const {features, exceededTransferLimit} = decodeFeatureCollection(await response.arrayBuffer());
```
