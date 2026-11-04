# nullisland

> ArcGIS layers on Google Maps — binary PBF features, server-rendered exports, viewport-aware caching.

Google Maps has no vector-tile layer. ArcGIS has MapServer and FeatureServer endpoints, published
cartography, and a compact binary format for features. **nullisland** connects the two: point it at an
ArcGIS REST URL and it renders that layer on your Google Map, choosing the cheapest strategy per
layer and refusing to re-download what it already has.

```ts
import {NullIsland} from '@offthemap/nullisland';

const arc = new NullIsland({
  map: googleMap,
  layers: [
    {url: 'https://example.com/arcgis/rest/services/Parcels/FeatureServer', color: '#e4572e'},
    {url: 'https://example.com/arcgis/rest/services/Basemap/MapServer'},
  ],
});

await arc.ready;
```

No Google Maps API key handling, no framework, no runtime dependencies. Just a map and a service URL.

---

## Install

```bash
npm install @offthemap/nullisland
```

The Google Maps JavaScript API must be loaded first (or injected with the `google` option, which is
useful for tests and for loaders that expose the namespace under another name).

## Quick start

```html
<script src="https://maps.googleapis.com/maps/api/js?key=API_KEY&v=weekly"></script>
<script type="module">
  import {NullIsland} from '@offthemap/nullisland';

  const map = new google.maps.Map(document.getElementById('map'), {
    center: {lat: 34.05, lng: -117.2},
    zoom: 12,
    mapId: 'YOUR_MAP_ID',
  });

  const arc = new NullIsland({
    map,
    layers: [
      {
        url: 'https://sampleserver6.arcgisonline.com/arcgis/rest/services/ServiceRequest/FeatureServer',
        title: 'Service requests',
        color: '#e4572e',
        minZoom: 10,
      },
    ],
    indicator: true,
  });

  arc.on('error', (error) => console.error('[nullisland]', error));
  await arc.ready;
</script>
```

## How it works

### Discovery

Every layer is inspected independently. nullisland reads the service metadata, flattens group layers,
and records what each sublayer can do: query, export, renderer, scale limits, `maxRecordCount`, and
which query formats it supports. Discovery happens even for hidden layers, so enabling one is
instant. Invalid configuration entries are reported on the `error` event and skipped — one bad URL
cannot break the rest of the map.

### Strategy selection

| Service capability | Strategy | What is drawn |
| --- | --- | --- |
| MapServer with `Map` capability | `export` | A server-rendered PNG positioned over the map |
| FeatureServer (or MapServer without export) | `vector` | Features decoded client-side into a `google.maps.Data` layer |

Force a strategy per layer with `mode: 'export' | 'vector'`. `auto` is the default.

### Export mode

1. The current viewport is expanded by 25% (`padding`).
2. The map is requested from `/export` in **EPSG:3857** at the device pixel ratio, capped at 4096px.
3. The image is placed with a custom `OverlayView` using the div pixel coordinates of its geographic
   corners — not a `GroundOverlay`, which would apply a second geographic transformation to an image
   that is already in Web Mercator.
4. A new image cross-fades in over 150ms while the old one stays visible. Reduced-motion users get
   an instant swap.
5. Another image is requested only when the zoom changes or the current image no longer covers the
   viewport. A generation counter discards responses for viewports the user already left.

Export mode is cheap for dense layers: the server does the drawing, and nullisland downloads a single
image instead of thousands of features. The trade-off is that the result is raster — it cannot be
styled client-side, picked, or queried without an extra request.

### Vector mode

Requests are snapped outward to the OSM/XYZ tile grid (one zoom level coarser than the map), which
makes cache keys deterministic and makes small pans free. Up to eight snapped viewports are cached
per layer (`cacheSize`).

Features are requested with:

- `f=pbf` when the service supports it, `f=geojson` otherwise.
- `resultType=tile` and `quantizationParameters` (PBF only) so the server returns integer coordinates
  plus a transform — typically 5-10× smaller than raw doubles.
- `outSR=4326`, an envelope in WGS84, and `orderByFields=<oid> ASC` for stable pagination.
- Page size from the service's `maxRecordCount`, capped at 2000.
- A hard cap of 10 pages / 20 000 features per viewport (`maxPages`, `maxFeatures`).

Each page is added to the `Data` layer as it arrives, before the previous viewport's features are
removed, so the layer never blanks out during navigation. If the viewport moves while a request is
in flight, the request is aborted and the response discarded.

### Styling

Colors are resolved in this order:

1. `color` on the layer config.
2. The service's published renderer (`simple`, `uniqueValue`, `classBreaks`).
3. A default blue.

ArcGIS symbols are translated to Google Maps `Data` styles, including marker icons rendered as inline
SVG so point size and outline survive. Visual variables, dash patterns, halos, labels and picture
fills are not translated — they degrade to the base symbol.

### Shared behaviour

- **Visibility is free.** Hiding a layer detaches it from the map but keeps decoded features and
  images in memory. Showing it again reattaches immediately.
- **Zoom gating.** Outside a layer's zoom range it is detached, not destroyed.
- **Antimeridian.** Viewports crossing ±180° are split into two longitude ranges before querying.
- **Loading indicator.** Optional, appears only after 300ms so quick loads do not flicker.
- **Prefetch.** `arc.prefetch(id)` warms the cache for the current viewport, e.g. on hover in a layer
  tray.

## API

### `new NullIsland(options)`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `map` | `google.maps.Map` | — | Required. |
| `layers` | `ArcGisLayerConfig[]` | — | Required. |
| `apiKey` | `string \| () => string \| Promise<string>` | — | ArcGIS token or API key, appended as `token`. Functions are re-called on HTTP 498/499. |
| `google` | `typeof google` | `globalThis.google` | Inject the Maps namespace. |
| `padding` | `number` | `0.25` | Extra viewport coverage. |
| `maxImageSize` | `number` | `4096` | Export size cap. |
| `cacheSize` | `number` | `8` | Viewports cached per vector layer. |
| `fadeDuration` | `number` | `150` | Export cross-fade, ms. |
| `reducedMotion` | `boolean` | OS setting | Disable cross-fade. |
| `indicator` | `boolean \| HTMLElement` | `false` | Built-in loading pill, or your own element. |
| `fetch` | `typeof fetch` | global | Custom fetch for proxying or instrumentation. |

### Layer config

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | `string` | — | Service root or single layer URL. |
| `id` | `string` | derived | Stable id, used by `arc.getLayer(id)`. |
| `title` | `string` | service name | Display name. |
| `color` | `string \| [r,g,b,a]` | renderer | Overrides the service symbology. |
| `opacity` | `number` | `1` | 0-1. |
| `minZoom` / `maxZoom` | `number` | service scales | Google Maps zoom gate. |
| `visible` | `boolean` | `true` | Initial state. |
| `mode` | `'auto' \| 'export' \| 'vector'` | `'auto'` | Force a strategy. |
| `sublayers` | `number[]` | all | MapServer sublayer ids to include. |
| `maxFeatures` | `number` | `20000` | Per-viewport feature cap. |
| `maxPages` | `number` | `10` | Per-viewport page cap. |

### Instance

```ts
arc.ready;                       // Promise<void>, resolves after discovery
arc.layers;                      // readonly NullIslandLayer[]
arc.getLayer('parcels');         // NullIslandLayer | undefined
arc.prefetch('parcels');         // warm the current viewport
arc.refresh('parcels');          // drop cache and reload
arc.setApiKey('new-token');
arc.on('error' | 'status' | 'load', listener);  // returns an unsubscribe fn
arc.destroy();
```

`NullIslandLayer` exposes `id`, `title`, `url`, `mode`, `state`, `sublayers`, `visible`, and
`setVisible()`, `setOpacity()`, `prefetch()`, `refresh()`.

## About PBF

Two different formats share the name "PBF" in the ArcGIS world, and nullisland only deals with the
second:

| Format | Endpoint | Decoder |
| --- | --- | --- |
| Mapbox Vector Tiles | `VectorTileServer/tile/{z}/{y}/{x}.pbf` | Many (deck.gl, MapLibre, `@mapbox/vector-tile`) |
| Esri FeatureCollection PBuffer | `FeatureServer/{id}/query?f=pbf` | This package, from the [Esri spec](https://github.com/Esri/arcgis-pbf) |

The FeatureCollection decoder is a hand-written protobuf reader with no runtime dependency. It
handles quantized integer coordinates, per-ring delta encoding, the upper-left transform, attribute
types, and polygon ring grouping (outer rings clockwise, holes nested by containment). You can use it
standalone:

```ts
import {decodeFeatureCollection} from 'nullisland/pbf';

const response = await fetch(url);
const {features, exceededTransferLimit} = decodeFeatureCollection(await response.arrayBuffer());
```

Services that do not implement `f=pbf` (notably MapServer, and servers older than 10.7) fall back to
GeoJSON automatically, and the negative result is cached per sublayer.

## Limitations

- **Vector rendering ceiling.** `google.maps.Data` tessellates on the CPU. A few thousand features is
  comfortable; tens of thousands is not. Keep `maxZoom` high enough that dense layers are queried at
  street level only.
- **Export images are raster.** Client-side styling and hit-testing do not apply. Use vector mode for
  interactive layers.
- **MapServer PBF is not a thing.** Query PBF is a FeatureServer capability; MapServer layers use
  GeoJSON.
- **No MVT support on purpose.** If you have a `VectorTileServer`, deck.gl's `MVTLayer` over
  `GoogleMapsOverlay` is a better fit — nullisland targets arbitrary services that have no tiles
  published.
- **World wrap.** Export mode clamps to one world when the viewport spans more than 360°.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

Tests cover the Web Mercator math, tile snapping, configuration validation, renderer translation,
LRU caching, and PBF decoding against a recorded real response plus synthetic payloads built from the
Esri schema.

## License

MIT
