/**
 * Vector mode: query features from an ArcGIS layer and draw them with a
 * Google Maps Data layer.
 *
 * PBF (`f=pbf`) is preferred when the service supports it; GeoJSON is the
 * fallback. Requests are snapped to the tile grid so panning reuses cached
 * results, paginated with a stable ORDER BY, and aborted as soon as the
 * viewport moves on.
 */

import {NullIslandHttpError, isAbortError} from '../errors.ts';
import {decodeFeatureCollection, groupRings, NotPbfError, type PbfGeometry} from '../pbf/decode.ts';
import {createStyleResolver, type StyleResolver} from '../style/translate.ts';
import {LRU} from '../util/lru.ts';
import {degreesPerPixel} from '../util/mercator.ts';
import {snapBBox, type SnappedArea} from '../util/tiles.ts';
import type {ArcGisSublayer} from '../discovery.ts';
import type {RGBA} from '../types.ts';
import type {Viewport} from '../viewport.ts';
import type {LayerRenderer, RendererOptions} from './types.ts';

interface PageResult {
  features: google.maps.Data.Feature[];
  exceeded: boolean;
}

interface GeoJsonFeature {
  type: 'Feature';
  id?: string | number;
  geometry: {type: string; coordinates: unknown} | null;
  properties?: Record<string, unknown> | null;
}

interface GeoJsonCollection {
  type: 'FeatureCollection';
  features?: GeoJsonFeature[];
  exceededTransferLimit?: boolean;
}

interface EsriJsonGeometry {
  x?: number;
  y?: number;
  points?: Array<[number, number]>;
  paths?: Array<Array<[number, number]>>;
  rings?: Array<Array<[number, number]>>;
}

interface EsriJsonFeature {
  attributes?: Record<string, unknown>;
  geometry?: EsriJsonGeometry;
}

interface EsriJsonCollection {
  features?: EsriJsonFeature[];
  exceededTransferLimit?: boolean;
  error?: {message?: string; code?: number};
}

/** Convert an Esri JSON geometry (outSR=4326) into the PBF shape we already draw. */
export function esriJsonGeometryToPbf(geometry: EsriJsonGeometry | undefined): PbfGeometry {
  if (!geometry) return {type: 'none'};
  if (typeof geometry.x === 'number' && typeof geometry.y === 'number') {
    return {type: 'point', coordinates: [geometry.x, geometry.y]};
  }
  if (Array.isArray(geometry.points)) return {type: 'multipoint', coordinates: geometry.points};
  if (Array.isArray(geometry.paths)) return {type: 'polyline', paths: geometry.paths};
  if (Array.isArray(geometry.rings)) {
    return {
      type: 'polygon',
      rings: geometry.rings.map((ring) => {
        const first = ring[0];
        const last = ring[ring.length - 1];
        return first && last && (first[0] !== last[0] || first[1] !== last[1])
          ? [...ring, first]
          : ring;
      }),
    };
  }
  return {type: 'none'};
}

export class VectorRenderer implements LayerRenderer {
  readonly mode = 'vector' as const;

  private readonly data: google.maps.Data;
  private readonly cache: LRU<string, google.maps.Data.Feature[]>;
  private readonly resolvers = new Map<number, StyleResolver>();
  private readonly featureSublayer = new WeakMap<google.maps.Data.Feature, number>();
  private fallbackResolver: StyleResolver;
  private rendered: google.maps.Data.Feature[] = [];
  private renderedKey: string | null = null;
  private controller: AbortController | null = null;
  private generation = 0;
  private attached = false;
  private loading = false;
  private opacity: number;

  constructor(private readonly options: RendererOptions) {
    this.opacity = options.opacity;
    this.data = new options.google.maps.Data();
    this.cache = new LRU(options.cacheSize);
    this.fallbackResolver = this.createResolver(options.service.sublayers[0]);
    this.rebuildStyles();
    this.data.setStyle((feature) => this.styleFor(feature));
  }

  attach(): void {
    if (this.attached) return;
    this.data.setMap(this.options.map);
    this.attached = true;
  }

  detach(): void {
    if (!this.attached) return;
    this.data.setMap(null);
    this.attached = false;
  }

  update(view: Viewport): void {
    const areas = snapBBox(view.bounds4326, view.zoom);
    const key = areas.map((area) => area.key).join('|');
    if (key === this.renderedKey) return;

    const cached = this.cache.get(key);
    if (cached) {
      this.render(cached, key);
      return;
    }

    void this.load(areas, key, true);
  }

  prefetch(view: Viewport): void {
    const areas = snapBBox(view.bounds4326, view.zoom);
    const key = areas.map((area) => area.key).join('|');
    if (key === this.renderedKey || this.cache.has(key)) return;
    void this.load(areas, key, false);
  }

  setOpacity(opacity: number): void {
    this.opacity = opacity;
    this.rebuildStyles();
    this.data.setStyle((feature) => this.styleFor(feature));
  }

  refresh(): void {
    this.cache.clear();
    this.renderedKey = null;
    this.generation += 1;
    this.controller?.abort();
  }

  destroy(): void {
    this.generation += 1;
    this.controller?.abort();
    this.data.setMap(null);
    this.data.setStyle(null);
    this.cache.clear();
    this.rendered = [];
    this.renderedKey = null;
    this.attached = false;
  }

  private createResolver(sublayer: ArcGisSublayer | undefined): StyleResolver {
    return createStyleResolver({
      renderer: sublayer?.renderer ?? null,
      color: this.options.color,
      opacity: this.opacity,
      geometryType: sublayer?.geometryType ?? null,
      google: this.options.google,
    });
  }

  private rebuildStyles(): void {
    this.resolvers.clear();
    for (const sublayer of this.options.service.sublayers) {
      this.resolvers.set(sublayer.id, this.createResolver(sublayer));
    }
    this.fallbackResolver = this.createResolver(this.options.service.sublayers[0]);
  }

  private styleFor(feature: google.maps.Data.Feature): google.maps.Data.StyleOptions {
    const sublayer = this.featureSublayer.get(feature);
    const resolver = (sublayer === undefined ? undefined : this.resolvers.get(sublayer)) ?? this.fallbackResolver;
    return resolver(feature);
  }

  private setLoading(loading: boolean): void {
    if (this.loading === loading) return;
    this.loading = loading;
    this.options.onLoading(loading);
  }

  private render(features: google.maps.Data.Feature[], key: string): void {
    const previous = this.rendered;
    for (const feature of features) this.data.add(feature);
    this.rendered = features;
    this.renderedKey = key;
    for (const feature of previous) this.data.remove(feature);
    if (features.length > 0) this.options.onLoaded?.();
  }

  private async load(areas: SnappedArea[], key: string, shouldRender: boolean): Promise<void> {
    const generation = ++this.generation;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.setLoading(true);

    try {
      const groups = await Promise.all(
        areas.map((area) => this.loadArea(area, controller.signal)),
      );
      if (generation !== this.generation) return;

      const features = groups.flat();
      this.cache.set(key, features);
      if (shouldRender) this.render(features, key);
    } catch (error) {
      if (!isAbortError(error)) this.options.onError(toError(error));
    } finally {
      if (generation === this.generation) this.setLoading(false);
    }
  }

  private async loadArea(area: SnappedArea, signal: AbortSignal): Promise<google.maps.Data.Feature[]> {
    const features: google.maps.Data.Feature[] = [];

    for (const sublayer of this.options.service.sublayers) {
      if (!sublayer.supportsQuery) continue;
      let offset = 0;
      let pages = 0;
      let total = 0;
      const pageSize = Math.min(Math.max(sublayer.maxRecordCount, 1), 2000);

      while (pages < this.options.layer.maxPages && total < this.options.layer.maxFeatures) {
        if (signal.aborted) return features;
        const page = await this.fetchPage(sublayer, area, offset, pageSize, signal);
        features.push(...page.features);
        total += page.features.length;
        offset += page.features.length;
        pages += 1;
        // Servers that do not advertise pagination cannot be paged; accept
        // the first page rather than sending parameters they reject.
        if (!page.exceeded || page.features.length === 0 || !sublayer.supportsPagination) break;
      }
    }

    return features;
  }

  private async fetchPage(
    sublayer: ArcGisSublayer,
    area: SnappedArea,
    offset: number,
    count: number,
    signal: AbortSignal,
  ): Promise<PageResult> {
    const url = `${this.options.service.url}/${sublayer.id}/query`;
    const params = this.baseParams(sublayer, area, offset, count);

    if (this.options.service.kind === 'FeatureServer' && sublayer.supportsPbf !== false) {
      const tolerance = quantizationTolerance(area.z);
      const pbfParams = {
        ...params,
        f: 'pbf',
        resultType: 'tile',
        quantizationParameters: JSON.stringify({
          mode: 'view',
          originPosition: 'upperLeft',
          tolerance,
        }),
        maxAllowableOffset: tolerance,
      };

      const response = await this.options.http.request(url, pbfParams, {signal});
      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();

      if (contentType.includes('protobuf') || contentType.includes('octet-stream')) {
        const buffer = await response.arrayBuffer();
        try {
          const decoded = decodeFeatureCollection(buffer);
          return {
            features: decoded.features
              .map((feature) => this.toDataFeatureFromPbf(sublayer, feature.attributes, feature.geometry))
              .filter((feature): feature is google.maps.Data.Feature => feature !== null),
            exceeded: decoded.exceededTransferLimit,
          };
        } catch (error) {
          // A malformed payload should not poison the layer forever.
          if (error instanceof NotPbfError) {
            sublayer.supportsPbf = false;
          } else {
            throw error;
          }
        }
      } else {
        // Server ignored f=pbf and returned JSON (older ArcGIS Server or a
        // MapServer endpoint). Fall through to the GeoJSON path below.
        sublayer.supportsPbf = false;
      }
    }

    if (sublayer.supportsGeoJson !== false) {
      try {
        return await this.fetchGeoJson(url, {...params, f: 'geojson'}, sublayer, signal);
      } catch (error) {
        if (sublayer.supportsGeoJson === true) throw error;
        if (isAbortError(error)) throw error;
        if (!(error instanceof NullIslandHttpError)) throw error;
        sublayer.supportsGeoJson = false;
      }
    }

    return this.fetchEsriJson(url, {...params, f: 'json'}, sublayer, signal);
  }

  private async fetchEsriJson(
    url: string,
    params: Record<string, string | number>,
    sublayer: ArcGisSublayer,
    signal: AbortSignal,
  ): Promise<PageResult> {
    const response = await this.options.http.request(url, params, {signal});
    const text = await response.text();
    let body: EsriJsonCollection;
    try {
      body = JSON.parse(text) as EsriJsonCollection;
    } catch (error) {
      throw new NullIslandHttpError('ArcGIS returned a non-JSON query response', response.status, url, {
        cause: error,
      });
    }

    if (body.error) {
      throw new NullIslandHttpError(
        body.error.message ?? 'ArcGIS query failed',
        body.error.code ?? response.status,
        url,
      );
    }

    const features = (body.features ?? [])
      .map((feature) => this.toDataFeatureFromEsriJson(sublayer, feature))
      .filter((feature): feature is google.maps.Data.Feature => feature !== null);

    return {features, exceeded: body.exceededTransferLimit === true};
  }

  private async fetchGeoJson(
    url: string,
    params: Record<string, string | number>,
    sublayer: ArcGisSublayer,
    signal: AbortSignal,
  ): Promise<PageResult> {
    const response = await this.options.http.request(url, params, {signal});
    const text = await response.text();
    let body: GeoJsonCollection & {error?: {message?: string; code?: number}};
    try {
      body = JSON.parse(text) as typeof body;
    } catch (error) {
      throw new NullIslandHttpError('ArcGIS returned a non-JSON query response', response.status, url, {
        cause: error,
      });
    }

    if (body.error) {
      throw new NullIslandHttpError(body.error.message ?? 'ArcGIS query failed', body.error.code ?? response.status, url);
    }

    const features = (body.features ?? [])
      .map((feature) => this.toDataFeatureFromGeoJson(sublayer, feature))
      .filter((feature): feature is google.maps.Data.Feature => feature !== null);

    return {features, exceeded: body.exceededTransferLimit === true};
  }

  private baseParams(
    sublayer: ArcGisSublayer,
    area: SnappedArea,
    offset: number,
    count: number,
  ): Record<string, string | number> {
    const params: Record<string, string | number> = {
      where: '1=1',
      geometry: area.bbox.join(','),
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      outSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      returnGeometry: 'true',
      outFields: '*',
      returnZ: 'false',
      returnM: 'false',
      resultRecordCount: count,
    };
    if (sublayer.supportsPagination) {
      if (offset > 0) params.resultOffset = offset;
      if (sublayer.objectIdField) params.orderByFields = `${sublayer.objectIdField} ASC`;
    }
    return params;
  }

  private toDataFeatureFromPbf(
    sublayer: ArcGisSublayer,
    attributes: Record<string, unknown>,
    geometry: PbfGeometry,
  ): google.maps.Data.Feature | null {
    const dataGeometry = this.toGoogleGeometry(geometry);
    if (!dataGeometry) return null;

    const id = attributes[sublayer.objectIdField];
    const feature = new this.options.google.maps.Data.Feature({
      geometry: dataGeometry,
      properties: attributes,
      ...(typeof id === 'string' || typeof id === 'number' ? {id} : {}),
    });
    this.featureSublayer.set(feature, sublayer.id);
    return feature;
  }

  private toDataFeatureFromGeoJson(
    sublayer: ArcGisSublayer,
    feature: GeoJsonFeature,
  ): google.maps.Data.Feature | null {
    const geometry = feature.geometry;
    if (!geometry) return null;

    const dataGeometry = this.toGoogleGeometryFromGeoJson(geometry);
    if (!dataGeometry) return null;

    const properties = feature.properties ?? {};
    const id = feature.id ?? properties[sublayer.objectIdField];
    const result = new this.options.google.maps.Data.Feature({
      geometry: dataGeometry,
      properties,
      ...(typeof id === 'string' || typeof id === 'number' ? {id} : {}),
    });
    this.featureSublayer.set(result, sublayer.id);
    return result;
  }

  private toDataFeatureFromEsriJson(
    sublayer: ArcGisSublayer,
    feature: EsriJsonFeature,
  ): google.maps.Data.Feature | null {
    const geometry = esriJsonGeometryToPbf(feature.geometry);
    if (geometry.type === 'none') return null;

    const attributes = feature.attributes ?? {};
    const id = attributes[sublayer.objectIdField];
    const result = new this.options.google.maps.Data.Feature({
      geometry: this.toGoogleGeometry(geometry)!,
      properties: attributes,
      ...(typeof id === 'string' || typeof id === 'number' ? {id} : {}),
    });
    this.featureSublayer.set(result, sublayer.id);
    return result;
  }

  private toGoogleGeometry(geometry: PbfGeometry): google.maps.Data.Geometry | null {
    const {google} = this.options;
    switch (geometry.type) {
      case 'point':
        return new google.maps.Data.Point(toLatLng(geometry.coordinates));
      case 'multipoint':
        return new google.maps.Data.MultiPoint(geometry.coordinates.map(toLatLng));
      case 'polyline':
        return geometry.paths.length === 1
          ? new google.maps.Data.LineString(geometry.paths[0]!.map(toLatLng))
          : new google.maps.Data.MultiLineString(geometry.paths.map((path) => path.map(toLatLng)));
      case 'polygon': {
        const polygons = groupRings(geometry.rings);
        if (polygons.length === 0) return null;
        if (polygons.length === 1) {
          return new google.maps.Data.Polygon(polygons[0]!.map((ring) => ring.map(toLatLng)));
        }
        return new google.maps.Data.MultiPolygon(
          polygons.map((polygon) => polygon.map((ring) => ring.map(toLatLng))),
        );
      }
      default:
        return null;
    }
  }

  private toGoogleGeometryFromGeoJson(
    geometry: {type: string; coordinates: unknown},
  ): google.maps.Data.Geometry | null {
    const {google} = this.options;
    switch (geometry.type) {
      case 'Point':
        return new google.maps.Data.Point(toLatLng(geometry.coordinates as [number, number]));
      case 'MultiPoint':
        return new google.maps.Data.MultiPoint(
          (geometry.coordinates as Array<[number, number]>).map(toLatLng),
        );
      case 'LineString':
        return new google.maps.Data.LineString(
          (geometry.coordinates as Array<[number, number]>).map(toLatLng),
        );
      case 'MultiLineString':
        return new google.maps.Data.MultiLineString(
          (geometry.coordinates as Array<Array<[number, number]>>).map((line) => line.map(toLatLng)),
        );
      case 'Polygon':
        return new google.maps.Data.Polygon(
          (geometry.coordinates as Array<Array<[number, number]>>).map((ring) => ring.map(toLatLng)),
        );
      case 'MultiPolygon':
        return new google.maps.Data.MultiPolygon(
          (geometry.coordinates as Array<Array<Array<[number, number]>>>).map((polygon) =>
            polygon.map((ring) => ring.map(toLatLng)),
          ),
        );
      default:
        return null;
    }
  }
}

/** Web Mercator degrees per pixel, halved: about half a screen pixel. */
export function quantizationTolerance(zoom: number): number {
  const value = degreesPerPixel(zoom) / 2;
  return Math.min(0.001, Math.max(1e-9, value));
}

function toLatLng([lng, lat]: [number, number]): google.maps.LatLngLiteral {
  return {lng, lat};
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
