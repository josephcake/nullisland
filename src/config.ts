/**
 * Configuration validation.
 *
 * Invalid layer entries never abort the engine: they are reported through the
 * `error` event and skipped, so one bad URL cannot take the map down.
 */

import {NullIslandConfigError} from './errors.ts';
import type {ArcGisLayerConfig, Color, LayerMode, RGBA} from './types.ts';
import {parseColor} from './util/color.ts';

export type ServiceKind = 'MapServer' | 'FeatureServer' | 'VectorTileServer';

export interface ServiceUrl {
  /** Service root without the trailing layer id. */
  base: string;
  kind: ServiceKind;
  /** Layer id when the configured URL pointed at a single layer. */
  layerId: number | null;
}

export interface NormalizedLayerConfig {
  id: string;
  title: string | undefined;
  url: string;
  service: ServiceUrl;
  color: RGBA | undefined;
  opacity: number;
  minZoom: number | undefined;
  maxZoom: number | undefined;
  visible: boolean;
  mode: LayerMode;
  sublayers: number[] | undefined;
  styleUrl: string | undefined;
  renderer: 'auto' | 'webgl' | 'canvas';
  maxFeatures: number;
  maxPages: number;
}

export interface NormalizedLayers {
  layers: NormalizedLayerConfig[];
  errors: Array<{index: number; config: ArcGisLayerConfig; error: Error}>;
}

const MAX_ZOOM = 22;
const DEFAULT_MAX_FEATURES = 20_000;
const DEFAULT_MAX_PAGES = 10;

/** Parse and validate an ArcGIS REST service or layer URL. */
export function parseServiceUrl(
  input: string,
  options: {allowInsecure?: boolean} = {},
): ServiceUrl {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new NullIslandConfigError('Layer url must be a non-empty string');
  }

  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch (error) {
    throw new NullIslandConfigError(`Invalid layer url: ${input}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new NullIslandConfigError(`Layer url must be http(s): ${input}`);
  }

  if (parsed.username || parsed.password) {
    throw new NullIslandConfigError('Layer url must not contain credentials; use the apiKey option instead');
  }

  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  if (parsed.protocol === 'http:' && !options.allowInsecure && !localHosts.has(parsed.hostname)) {
    throw new NullIslandConfigError(
      `Layer url must use https (got ${input}); pass allowInsecure: true to override`,
    );
  }

  const match = /^(.*\/(mapserver|featureserver|vectortileserver))(?:\/(\d+))?\/?$/i.exec(parsed.pathname);
  if (!match) {
    throw new NullIslandConfigError(
      `Layer url must point at a MapServer or FeatureServer: ${input}`,
    );
  }

  const base = `${parsed.origin}${match[1]}`;
  const name = match[2]!.toLowerCase();
  const kind: ServiceKind =
    name === 'mapserver' ? 'MapServer' : name === 'featureserver' ? 'FeatureServer' : 'VectorTileServer';
  const layerId = match[3] === undefined ? null : Number(match[3]);

  return {base, kind, layerId};
}

export function normalizeLayers(
  configs: ArcGisLayerConfig[],
  options: {allowInsecure?: boolean} = {},
): NormalizedLayers {
  if (!Array.isArray(configs)) {
    throw new NullIslandConfigError('layers must be an array');
  }

  const layers: NormalizedLayerConfig[] = [];
  const errors: NormalizedLayers['errors'] = [];
  const usedIds = new Set<string>();

  configs.forEach((config, index) => {
    try {
      const normalized = normalizeLayer(config, usedIds, options);
      usedIds.add(normalized.id);
      layers.push(normalized);
    } catch (error) {
      errors.push({
        index,
        config,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  });

  return {layers, errors};
}

export function normalizeLayer(
  config: ArcGisLayerConfig,
  usedIds: Set<string> = new Set(),
  options: {allowInsecure?: boolean} = {},
): NormalizedLayerConfig {
  if (!config || typeof config !== 'object') {
    throw new NullIslandConfigError('Layer config must be an object');
  }

  const service = parseServiceUrl(config.url, options);
  const color = config.color === undefined ? undefined : normalizeColor(config.color);
  const opacity = config.opacity === undefined ? 1 : config.opacity;
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
    throw new NullIslandConfigError(`opacity must be between 0 and 1, received ${String(config.opacity)}`);
  }

  const minZoom = normalizeZoom(config.minZoom, 'minZoom');
  const maxZoom = normalizeZoom(config.maxZoom, 'maxZoom');
  if (minZoom !== undefined && maxZoom !== undefined && minZoom > maxZoom) {
    throw new NullIslandConfigError(`minZoom (${minZoom}) must be <= maxZoom (${maxZoom})`);
  }

  const mode = normalizeMode(config.mode);
  const sublayers = normalizeSublayers(config.sublayers);

  let id = config.id?.trim() || deriveLayerId(config.url, service);
  if (usedIds.has(id)) {
    let suffix = 2;
    while (usedIds.has(`${id}-${suffix}`)) suffix += 1;
    id = `${id}-${suffix}`;
  }

  const maxFeatures = positiveInteger(config.maxFeatures, DEFAULT_MAX_FEATURES, 'maxFeatures');
  const maxPages = positiveInteger(config.maxPages, DEFAULT_MAX_PAGES, 'maxPages');

  return {
    id,
    title: config.title?.trim() || undefined,
    url: config.url,
    service,
    color,
    opacity,
    minZoom,
    maxZoom,
    visible: config.visible !== false,
    mode,
    sublayers,
    styleUrl: config.styleUrl,
    renderer: config.renderer ?? 'auto',
    maxFeatures,
    maxPages,
  };
}

function normalizeColor(color: Color): RGBA {
  try {
    return parseColor(color);
  } catch (error) {
    throw new NullIslandConfigError(error instanceof Error ? error.message : 'Invalid color');
  }
}

function normalizeZoom(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0 || value > MAX_ZOOM) {
    throw new NullIslandConfigError(`${field} must be between 0 and ${MAX_ZOOM}`);
  }
  return value;
}

function normalizeMode(value: LayerMode | undefined): LayerMode {
  if (value === undefined) return 'auto';
  if (value !== 'auto' && value !== 'export' && value !== 'vector') {
    throw new NullIslandConfigError(`mode must be "auto", "export" or "vector"`);
  }
  return value;
}

function normalizeSublayers(value: number[] | undefined): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new NullIslandConfigError('sublayers must be an array of layer ids');
  const ids = value.map((id) => {
    if (!Number.isInteger(id) || id < 0) {
      throw new NullIslandConfigError(`Invalid sublayer id: ${String(id)}`);
    }
    return id;
  });
  return ids.length > 0 ? [...new Set(ids)] : undefined;
}

function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new NullIslandConfigError(`${field} must be a positive integer`);
  }
  return value;
}

/** Stable, human readable id derived from the URL. */
export function deriveLayerId(url: string, service: ServiceUrl): string {
  const parts = service.base.split('/');
  const name = parts[parts.length - 2] ?? 'layer';
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'layer';
  const layer = service.layerId === null ? '' : `-${service.layerId}`;
  return `${slug}${layer}-${hash(url)}`;
}

/** FNV-1a, base36 encoded: 4-6 characters is plenty for an id suffix. */
export function hash(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
