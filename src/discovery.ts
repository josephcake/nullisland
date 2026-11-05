/**
 * Service discovery.
 *
 * Reads the ArcGIS REST metadata for a service (or a single layer), flattens
 * sublayers, and records the capabilities both renderers need.
 */

import {NullIslandError} from './errors.ts';
import type {ServiceKind, ServiceUrl} from './config.ts';
import type {HttpClient} from './http.ts';
import {zoomRangeFromScales, type ZoomRange} from './util/zoom.ts';

export interface ArcGisField {
  name: string;
  type?: string;
  alias?: string;
}

export interface ArcGisSymbol {
  type?: string;
  color?: number[];
  outline?: {color?: number[]; width?: number};
  width?: number;
  size?: number;
  style?: string;
}

export interface ArcGisRenderer {
  type?: string;
  symbol?: ArcGisSymbol;
  defaultSymbol?: ArcGisSymbol;
  defaultLabel?: string;
  field1?: string;
  field2?: string;
  field3?: string;
  uniqueValueInfos?: Array<{value?: string; symbol?: ArcGisSymbol; label?: string}>;
  classBreakInfos?: Array<{classMinValue?: number; classMaxValue?: number; symbol?: ArcGisSymbol; label?: string}>;
  visualVariables?: unknown[];
}

export interface ArcGisSublayer {
  id: number;
  name: string;
  geometryType: string | null;
  objectIdField: string;
  minScale: number;
  maxScale: number;
  maxRecordCount: number;
  renderer: ArcGisRenderer | null;
  fields: ArcGisField[];
  supportsQuery: boolean;
  supportsPbf: boolean | 'unknown';
  supportsGeoJson: boolean | 'unknown';
  supportsPagination: boolean;
  zoom: ZoomRange;
}

export interface ArcGisService {
  url: string;
  kind: ServiceKind;
  version: number;
  title: string;
  description: string | undefined;
  capabilities: string[];
  queryFormats: string[];
  supportsExport: boolean;
  maxRecordCount: number;
  singleLayer: boolean;
  sublayers: ArcGisSublayer[];
  zoom: ZoomRange;
}

interface LayerMetadata {
  id?: number;
  name?: string;
  type?: string;
  geometryType?: string | null;
  minScale?: number;
  maxScale?: number;
  objectIdField?: string;
  supportsAdvancedQueries?: boolean;
  capabilities?: string;
  renderer?: ArcGisRenderer | null;
  fields?: ArcGisField[];
  subLayerIds?: number[] | null;
  maxRecordCount?: number;
  advancedQueryCapabilities?: {
    supportsPagination?: boolean;
    supportsStatistics?: boolean;
    supportsReturningQueryExtent?: boolean;
  };
  supportedQueryFormats?: string;
}

interface ServiceMetadata extends LayerMetadata {
  currentVersion?: number;
  serviceDescription?: string;
  description?: string;
  mapName?: string;
  supportedQueryFormats?: string;
  layers?: LayerMetadata[];
  tables?: LayerMetadata[];
  singleFusedMapCache?: boolean;
}

const PBF_MIN_VERSION = 10.7;
const METADATA_CONCURRENCY = 4;

/** Fetch and normalise metadata for a service or a single layer. */
export async function discoverService(
  service: ServiceUrl,
  http: HttpClient,
  options: {sublayers?: number[]; title?: string} = {},
): Promise<ArcGisService> {
  const metadata = await http.json<ServiceMetadata>(service.base, {f: 'json'});
  const version = Number(metadata.currentVersion ?? 0);
  const capabilities = splitCapabilities(metadata.capabilities ?? '');
  const queryFormats = splitFormats(metadata.supportedQueryFormats);

  if (service.layerId !== null) {
    // A layer URL still needs the layer document: geometryType, objectIdField,
    // renderer and pagination flags live there, not on the service root.
    const layerMetadata = await readLayerMetadata(http, service, metadata);
    const layer = {...layerMetadata, id: service.layerId} as LayerMetadata;
    const layerFormats = splitFormats(layerMetadata.supportedQueryFormats);
    const formats = layerFormats.length > 0 ? layerFormats : queryFormats;
    const sublayer = toSublayer(layer, {
      kind: service.kind,
      version,
      maxRecordCount: Number(layerMetadata.maxRecordCount ?? metadata.maxRecordCount ?? 1000),
      queryFormats: formats,
    });
    const layerCapabilities = splitCapabilities(layer.capabilities ?? metadata.capabilities ?? '');
    return {
      url: service.base,
      kind: service.kind,
      version,
      title: options.title ?? layer.name ?? service.base,
      description: metadata.description ?? metadata.serviceDescription,
      capabilities: layerCapabilities,
      queryFormats: formats,
      supportsExport: service.kind === 'MapServer' && hasCapability(layerCapabilities, 'map'),
      maxRecordCount: sublayer.maxRecordCount,
      singleLayer: true,
      sublayers: [sublayer],
      zoom: sublayer.zoom,
    };
  }

  const rawLayers = (metadata.layers ?? []).filter((layer) => !isGroupLayer(layer));
  const selected = options.sublayers
    ? rawLayers.filter((layer) => layer.id !== undefined && options.sublayers!.includes(layer.id))
    : rawLayers;

  if (selected.length === 0) {
    throw new NullIslandError(
      `No queryable sublayers found in ${service.base}`,
      'NULLISLAND_NO_SUBLAYERS',
    );
  }

  const details = await mapLimit(selected, METADATA_CONCURRENCY, async (layer) => {
    if (layer.id === undefined) return layer;
    try {
      return await http.json<LayerMetadata>(`${service.base}/${layer.id}`, {f: 'json'});
    } catch {
      // Older or locked-down servers may refuse per-layer metadata; the
      // service-level listing is enough to render, so degrade gracefully.
      return layer;
    }
  });

  const sublayers = details.map((layer) =>
    toSublayer(layer, {
      kind: service.kind,
      version,
      maxRecordCount: Number(layer.maxRecordCount ?? metadata.maxRecordCount ?? 1000),
      queryFormats,
    }),
  );

  const zoom = unionZoom(sublayers);
  const first = sublayers[0];

  return {
    url: service.base,
    kind: service.kind,
    version,
    title:
      options.title ??
      metadata.mapName ??
      metadata.name ??
      first?.name ??
      service.base,
    description: metadata.serviceDescription ?? metadata.description,
    capabilities,
    queryFormats,
    supportsExport: service.kind === 'MapServer' && hasCapability(capabilities, 'map'),
    maxRecordCount: Number(metadata.maxRecordCount ?? first?.maxRecordCount ?? 1000),
    singleLayer: false,
    sublayers,
    zoom,
  };
}

async function readLayerMetadata(
  http: HttpClient,
  service: ServiceUrl,
  fallback: ServiceMetadata,
): Promise<ServiceMetadata> {
  try {
    return await http.json<ServiceMetadata>(`${service.base}/${service.layerId}`, {f: 'json'});
  } catch {
    // Older or locked-down servers may refuse the layer document.
    return fallback;
  }
}

function toSublayer(
  layer: LayerMetadata,
  context: {kind: ServiceKind; version: number; maxRecordCount: number; queryFormats: string[]},
): ArcGisSublayer {
  const minScale = Number(layer.minScale ?? 0);
  const maxScale = Number(layer.maxScale ?? 0);
  const formats = context.queryFormats;

  // Prefer what the service advertises. Some servers omit PBF from
  // supportedQueryFormats even though they serve it, so FeatureServer >= 10.7
  // stays 'unknown' and is probed on first use.
  const supportsPbf: boolean | 'unknown' = formats.includes('pbf')
    ? true
    : context.kind === 'FeatureServer' && context.version >= PBF_MIN_VERSION
      ? 'unknown'
      : false;
  const supportsGeoJson: boolean | 'unknown' =
    formats.length === 0 ? 'unknown' : formats.includes('geojson');
  const supportsPagination =
    layer.supportsAdvancedQueries !== false &&
    layer.advancedQueryCapabilities?.supportsPagination !== false;

  return {
    id: layer.id ?? 0,
    name: layer.name ?? 'Layer',
    geometryType: layer.geometryType ?? null,
    objectIdField: layer.objectIdField ?? 'objectid',
    minScale,
    maxScale,
    maxRecordCount: Number(layer.maxRecordCount ?? context.maxRecordCount ?? 1000),
    renderer: layer.renderer ?? null,
    fields: layer.fields ?? [],
    supportsQuery: layer.supportsAdvancedQueries !== false,
    supportsPbf,
    supportsGeoJson,
    supportsPagination,
    zoom: zoomRangeFromScales(minScale, maxScale),
  };
}

function isGroupLayer(layer: LayerMetadata): boolean {
  return layer.type === 'Group Layer' || (Array.isArray(layer.subLayerIds) && layer.subLayerIds.length > 0);
}

function unionZoom(sublayers: ArcGisSublayer[]): ZoomRange {
  if (sublayers.length === 0) return {minZoom: 0, maxZoom: 22};
  let minZoom = Infinity;
  let maxZoom = -Infinity;
  for (const sublayer of sublayers) {
    minZoom = Math.min(minZoom, sublayer.zoom.minZoom);
    maxZoom = Math.max(maxZoom, sublayer.zoom.maxZoom);
  }
  return {minZoom: Number.isFinite(minZoom) ? minZoom : 0, maxZoom: Number.isFinite(maxZoom) ? maxZoom : 22};
}

function splitFormats(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function splitCapabilities(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function hasCapability(capabilities: string[], name: string): boolean {
  return capabilities.includes(name);
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({length: Math.min(limit, items.length)}, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!);
    }
  });

  await Promise.all(workers);
  return results;
}
