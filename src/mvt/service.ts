/**
 * VectorTileServer discovery.
 *
 * Metadata gives the tile template and LODs; `resources/styles/root.json` is a
 * Mapbox GL style. We translate the fill/line layers we can render and ignore
 * symbol layers (no label engine yet).
 */

import type {ServiceUrl} from '../config.ts';
import type {HttpClient} from '../http.ts';
import {metersToBbox, type BBox} from '../util/mercator.ts';

export interface MvtStyleLayer {
  id: string;
  sourceLayer: string;
  type: 'fill' | 'line';
  fillColor: string | undefined;
  fillOpacity: number | undefined;
  lineColor: string | undefined;
  lineWidth: number | undefined;
  lineOpacity: number | undefined;
  minZoom: number | undefined;
  maxZoom: number | undefined;
}

export interface VectorTileService {
  url: string;
  title: string;
  tileTemplate: string;
  tileSize: number;
  extent: number;
  minZoom: number;
  maxZoom: number;
  /** Geographic coverage of the cache; tiles outside it do not exist. */
  fullExtent: BBox | undefined;
  styleLayers: MvtStyleLayer[];
  styleUrl: string;
}

interface VectorTileMetadata {
  name?: string;
  tiles?: string[];
  tileInfo?: {
    rows?: number;
    cols?: number;
    lods?: Array<{level?: number; resolution?: number}>;
  };
  fullExtent?: {
    xmin?: number;
    ymin?: number;
    xmax?: number;
    ymax?: number;
    spatialReference?: {wkid?: number; latestWkid?: number};
  };
}

interface MapboxStyle {
  layers?: Array<Record<string, unknown>>;
}

export async function discoverVectorTileService(
  service: ServiceUrl,
  http: HttpClient,
  options: {title?: string; styleUrl?: string} = {},
): Promise<VectorTileService> {
  const metadata = await http.json<VectorTileMetadata>(service.base, {f: 'json'});
  const levels = (metadata.tileInfo?.lods ?? [])
    .map((lod) => Number(lod.level))
    .filter((level) => Number.isFinite(level));

  const minZoom = levels.length > 0 ? Math.min(...levels) : 0;
  const maxZoom = levels.length > 0 ? Math.max(...levels) : 19;
  const tileTemplate = metadata.tiles?.[0] ?? 'tile/{z}/{y}/{x}.pbf';
  const styleUrl = options.styleUrl ?? `${service.base}/resources/styles/root.json`;

  let styleLayers: MvtStyleLayer[] = [];
  try {
    styleLayers = parseStyleLayers(await http.json<MapboxStyle>(styleUrl));
  } catch {
    // A service without a style still renders with the fallback palette.
  }

  return {
    url: service.base,
    title: options.title ?? metadata.name ?? service.base,
    tileTemplate,
    tileSize: 512,
    extent: 4096,
    minZoom,
    maxZoom,
    fullExtent: parseExtent(metadata.fullExtent),
    styleLayers,
    styleUrl,
  };
}

export function parseStyleLayers(style: MapboxStyle): MvtStyleLayer[] {
  const result: MvtStyleLayer[] = [];

  for (const layer of style.layers ?? []) {
    const type = layer.type === 'fill' ? 'fill' : layer.type === 'line' ? 'line' : null;
    if (!type) continue;

    const paint = (layer.paint ?? {}) as Record<string, unknown>;
    const sourceLayer =
      typeof layer['source-layer'] === 'string' ? layer['source-layer'] : String(layer.id ?? '');
    if (!sourceLayer) continue;

    result.push({
      id: String(layer.id ?? sourceLayer),
      sourceLayer,
      type,
      fillColor: color(paint['fill-color']),
      fillOpacity: number(paint['fill-opacity']),
      // Fill layers carry their border in fill-outline-*.
      lineColor: color(type === 'fill' ? paint['fill-outline-color'] : paint['line-color']),
      lineWidth:
        number(type === 'fill' ? paint['fill-outline-width'] : paint['line-width']) ??
        (type === 'fill' ? 1 : undefined),
      lineOpacity: number(paint['line-opacity']),
      minZoom: number(layer.minzoom),
      maxZoom: number(layer.maxzoom),
    });
  }

  return result;
}

function parseExtent(extent: VectorTileMetadata['fullExtent']): BBox | undefined {
  if (!extent) return undefined;
  const {xmin, ymin, xmax, ymax} = extent;
  if (![xmin, ymin, xmax, ymax].every((value) => typeof value === 'number')) return undefined;
  const wkid = extent.spatialReference?.latestWkid ?? extent.spatialReference?.wkid;
  if (wkid === 4326) return [xmin!, ymin!, xmax!, ymax!];
  return metersToBbox([xmin!, ymin!, xmax!, ymax!]);
}

function color(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
