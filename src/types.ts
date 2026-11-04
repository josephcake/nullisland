/**
 * Public types for nullisland.
 *
 * The engine renders ArcGIS MapServer / FeatureServer content on top of a
 * Google Maps map. It never assumes a specific bundler, framework, or map
 * initialization order.
 */

/** RGBA tuple with 0-255 channels. */
export type RGBA = [number, number, number, number];

/** CSS hex color (`#rgb`, `#rrggbb`, `#rrggbbaa`) or an RGBA tuple. */
export type Color = string | RGBA;

/** Rendering strategy resolved for a layer. */
export type ResolvedMode = 'export' | 'vector';

/** Lifecycle state of a layer. */
export type LayerState = 'idle' | 'loading' | 'ready' | 'error';

/** Preferred rendering strategy. `auto` picks based on service capabilities. */
export type LayerMode = 'auto' | ResolvedMode;

/**
 * Supplies an ArcGIS token (or API key). Called again when the server reports
 * an expired token (HTTP 498/499), which makes short-lived OAuth tokens usable.
 */
export type TokenSource = string | (() => string | Promise<string>);

/** Configuration for a single ArcGIS service or layer. */
export interface ArcGisLayerConfig {
  /**
   * ArcGIS REST endpoint. Either a service root
   * (`.../FeatureServer`, `.../MapServer`) or a single layer
   * (`.../FeatureServer/0`).
   */
  url: string;
  /** Stable id. Defaults to a slug of the URL plus a short hash. */
  id?: string;
  /** Human readable name shown in layer trays. Defaults to the service name. */
  title?: string;
  /** Overrides the service's own symbology. */
  color?: Color;
  /** Global opacity, 0..1. Defaults to 1. */
  opacity?: number;
  /** Minimum Google Maps zoom at which the layer is displayed. */
  minZoom?: number;
  /** Maximum Google Maps zoom at which the layer is displayed. */
  maxZoom?: number;
  /** Whether the layer starts visible. Defaults to true. */
  visible?: boolean;
  /** Force a rendering strategy. Defaults to `auto`. */
  mode?: LayerMode;
  /** MapServer sublayer ids to include. Defaults to every visible sublayer. */
  sublayers?: number[];
  /** Hard cap on features fetched per viewport. Defaults to 20 000. */
  maxFeatures?: number;
  /** Hard cap on pages fetched per viewport. Defaults to 10. */
  maxPages?: number;
}

/** Engine-wide options. */
export interface NullIslandOptions {
  /** The Google Maps map instance. */
  map: google.maps.Map;
  /** ArcGIS layers to manage. Invalid entries are reported and skipped. */
  layers: ArcGisLayerConfig[];
  /**
   * Optional ArcGIS token or API key. Public layers need no token; only
   * services that enforce authentication require one. When provided it is
   * appended as `token` to every ArcGIS request.
   */
  apiKey?: TokenSource;
  /**
   * The Google Maps API namespace. Defaults to `globalThis.google`.
   * Inject it when the API is loaded under a different name or in tests.
   */
  google?: typeof google;
  /**
   * Extra viewport coverage as a fraction of its size. Defaults to 0.25 (25%),
   * matching ArcGIS's own map view padding.
   */
  padding?: number;
  /** Upper bound for exported image dimensions. Defaults to 4096. */
  maxImageSize?: number;
  /** Number of viewport snapshots kept per vector layer. Defaults to 8. */
  cacheSize?: number;
  /** Cross-fade duration for exported images in ms. Defaults to 150. */
  fadeDuration?: number;
  /** Respect `prefers-reduced-motion`. Defaults to the media query result. */
  reducedMotion?: boolean;
  /** Show a built-in "Loading map layers…" indicator. Defaults to false. */
  indicator?: boolean | HTMLElement;
  /** Custom fetch implementation (proxying, instrumentation). */
  fetch?: typeof fetch;
  /**
   * How exported images are loaded. `image` (default) sets `img.src`
   * directly, so it works on servers that do not send CORS headers. `fetch`
   * downloads a blob, which adds abort, timeout and HTTP status handling at
   * the cost of requiring CORS on `/export`.
   */
  exportTransport?: 'image' | 'fetch';
  /** Allow plain HTTP service URLs. Localhost is always allowed. Defaults to false. */
  allowInsecure?: boolean;
  /** Timeout for a single export image load, in ms. Defaults to 20000. */
  exportTimeout?: number;
}

/** Per-layer status snapshot. */
export interface LayerStatus {
  id: string;
  state: LayerState;
  mode: ResolvedMode | null;
  message?: string;
}

/** Engine status snapshot, emitted on the `status` event. */
export interface NullIslandStatus {
  loading: boolean;
  layers: LayerStatus[];
}

/** A discovered sublayer of an ArcGIS service. */
export interface NullIslandSublayer {
  id: number;
  name: string;
}

/** Public handle for a configured layer. */
export interface NullIslandLayer {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly mode: ResolvedMode | null;
  readonly state: LayerState;
  readonly sublayers: readonly NullIslandSublayer[];
  readonly visible: boolean;
  setVisible(visible: boolean): void;
  setOpacity(opacity: number): void;
  /** Warm the cache for the current viewport without showing the layer. */
  prefetch(): void;
  /** Discard cached content and reload the current viewport. */
  refresh(): void;
}

/** Events emitted by the engine. */
export interface NullIslandEventMap {
  status: NullIslandStatus;
  error: Error;
  load: {layer: string};
}
