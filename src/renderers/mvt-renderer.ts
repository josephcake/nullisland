/**
 * VectorTileServer renderer.
 *
 * Decodes MVT tiles and paints them into one canvas anchored over the map.
 * The canvas scales better than a `google.maps.Data` layer because it draws
 * paths instead of tessellating one feature at a time.
 */

import {isAbortError, NullIslandHttpError} from '../errors.ts';
import type {NormalizedLayerConfig} from '../config.ts';
import type {HttpClient} from '../http.ts';
import {decodeMvt, type MvtTile} from '../mvt/decode.ts';
import type {MvtStyleLayer, VectorTileService} from '../mvt/service.ts';
import {LRU} from '../util/lru.ts';
import {clamp, lngLatToWorld, type BBox} from '../util/mercator.ts';
import {tileToBBox, tileX, tileY} from '../util/tiles.ts';
import {bboxContains, padBBox, type Viewport} from '../viewport.ts';
import type {LayerRenderer} from './types.ts';

export interface MvtRendererOptions {
  map: google.maps.Map;
  google: typeof google;
  http: HttpClient;
  layer: NormalizedLayerConfig;
  service: VectorTileService;
  opacity: number;
  padding: number;
  onLoading(loading: boolean): void;
  onError(error: Error): void;
}

interface TileRef {
  z: number;
  x: number;
  y: number;
}

const PALETTE = ['#4c7dff', '#e8590c', '#f2b705', '#2f9e44', '#9c36b5', '#0c8599'];

export class MvtRenderer implements LayerRenderer {
  readonly mode = 'mvt' as const;

  private readonly overlay: MvtCanvasOverlay;
  private readonly cache: LRU<string, MvtTile>;
  private readonly tileCache: LRU<string, HTMLCanvasElement>;
  private controller: AbortController | null = null;
  private generation = 0;
  private attached = false;
  private loading = false;
  private opacity: number;
  private renderedKey: string | null = null;
  private lastView: Viewport | null = null;
  private lastBbox: BBox | null = null;
  private lastZoom = Number.NaN;

  constructor(private readonly options: MvtRendererOptions) {
    this.opacity = options.opacity;
    this.cache = new LRU(64);
    this.tileCache = new LRU(48);
    this.overlay = new MvtCanvasOverlay(options.google, options.map);
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.lastBbox = null;
    this.renderedKey = null;
    this.overlay.setMap(this.options.map);
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    this.lastBbox = null;
    this.lastZoom = Number.NaN;
    this.renderedKey = null;
    this.overlay.setMap(null);
  }

  update(view: Viewport): void {
    this.lastView = view;
    void this.render(view);
  }

  prefetch(view: Viewport): void {
    void this.render(view);
  }

  setOpacity(opacity: number): void {
    this.opacity = opacity;
    this.renderedKey = null;
    this.lastBbox = null;
    if (this.lastView) void this.render(this.lastView);
  }

  refresh(): void {
    this.cache.clear();
    this.renderedKey = null;
    this.lastBbox = null;
    if (this.lastView) void this.render(this.lastView);
  }

  destroy(): void {
    this.generation += 1;
    this.controller?.abort();
    this.overlay.destroy();
    this.cache.clear();
    this.tileCache.clear();
    this.attached = false;
    this.lastView = null;
    this.lastBbox = null;
    this.lastZoom = Number.NaN;
    this.renderedKey = null;
  }

  private setLoading(loading: boolean): void {
    if (this.loading === loading) return;
    this.loading = loading;
    this.options.onLoading(loading);
  }

  private async render(view: Viewport): Promise<void> {
    if (!this.attached) return;

    const {service, padding} = this.options;
    const bbox = padBBox(view.bounds4326, padding);

    // The canvas is anchored to its bbox, so panning inside the padding needs
    // no redraw at all.
    if (
      this.lastBbox &&
      view.zoom === this.lastZoom &&
      bboxContains(this.lastBbox, view.bounds4326)
    ) {
      return;
    }
    const z = clamp(Math.round(view.zoom) - 1, service.minZoom, service.maxZoom);
    const key = `${z}|${view.zoom.toFixed(2)}|${bbox.map((value) => value.toFixed(4)).join(',')}`;
    if (key === this.renderedKey) return;

    const generation = ++this.generation;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.setLoading(true);

    try {
      const extent = service.fullExtent;
      const tiles = tilesFor(bbox, z).filter(
        (tile) => !extent || intersects(tileToBBox(tile.z, tile.x, tile.y), extent),
      );
      const decoded = await Promise.all(
        tiles.map((tile) => this.loadTile(tile, controller.signal)),
      );
      if (generation !== this.generation) return;

      this.draw(view, bbox, z, tiles, decoded);
      this.overlay.setBounds(bbox);
      this.renderedKey = key;
      this.lastBbox = bbox;
      this.lastZoom = view.zoom;
    } catch (error) {
      if (!isAbortError(error)) {
        this.options.onError(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      if (generation === this.generation) this.setLoading(false);
    }
  }

  private async loadTile(tile: TileRef, signal: AbortSignal): Promise<MvtTile | null> {
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const path = this.options.service.tileTemplate
      .replace('{z}', String(tile.z))
      .replace('{y}', String(tile.y))
      .replace('{x}', String(tile.x));
    const url = `${this.options.service.url}/${path}`;

    try {
      const response = await this.options.http.request(url, {}, {signal});
      const buffer = await response.arrayBuffer();
      const decoded = decodeMvt(buffer);
      this.cache.set(key, decoded);
      return decoded;
    } catch (error) {
      // Tiles outside the service cache return 404. Treat them as empty
      // instead of failing the whole layer.
      if (
        error instanceof NullIslandHttpError &&
        (error.status === 404 || error.status === 400)
      ) {
        const empty: MvtTile = {layers: []};
        this.cache.set(key, empty);
        return empty;
      }
      throw error;
    }
  }

  private draw(
    view: Viewport,
    bbox: BBox,
    z: number,
    tiles: TileRef[],
    decoded: Array<MvtTile | null>,
  ): void {
    const canvas = this.overlay.getCanvas();
    if (!canvas) return;

    const {padding} = this.options;
    const dpr = view.dpr;
    const cssWidth = Math.max(1, Math.round(view.width * (1 + padding * 2)));
    const cssHeight = Math.max(1, Math.round(view.height * (1 + padding * 2)));

    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, cssWidth, cssHeight);

    const northWest = lngLatToWorld(bbox[0], bbox[3]);
    const originX = northWest.x * 256 * 2 ** view.zoom;
    const originY = northWest.y * 256 * 2 ** view.zoom;
    const tilePx = 256 * 2 ** (view.zoom - z);

    // Tiles are rasterised once and cached: compositing images is cheap,
    // re-tessellating tens of thousands of polygons is not.
    context.globalAlpha = this.opacity;
    for (let index = 0; index < tiles.length; index += 1) {
      const data = decoded[index];
      if (!data) continue;
      const tile = tiles[index]!;
      const key = `${z}/${tile.x}/${tile.y}`;

      let tileCanvas = this.tileCache.get(key);
      if (!tileCanvas) {
        tileCanvas = this.renderTile(data, view.zoom);
        this.tileCache.set(key, tileCanvas);
      }

      context.drawImage(
        tileCanvas,
        tile.x * tilePx - originX,
        tile.y * tilePx - originY,
        tilePx,
        tilePx,
      );
    }
  }

  /** Paint one tile at its native 512 px into an offscreen canvas. */
  private renderTile(tile: MvtTile, zoom: number): HTMLCanvasElement {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;

    const context = canvas.getContext('2d');
    if (!context) return canvas;

    const {service} = this.options;
    const styles =
      service.styleLayers.length > 0 ? service.styleLayers : this.fallbackStyles([tile]);

    context.lineJoin = 'round';
    context.lineCap = 'round';

    for (const style of styles) {
      if (!styleVisible(style, zoom)) continue;

      context.beginPath();
      let hasGeometry = false;

      for (const mvtLayer of tile.layers) {
        if (mvtLayer.name !== style.sourceLayer) continue;
        const scale = size / (mvtLayer.extent || service.extent);
        for (const feature of mvtLayer.features) {
          const relevant =
            style.type === 'fill' ? feature.type === 'polygon' : feature.type === 'line';
          if (!relevant) continue;
          for (const path of feature.paths) {
            tracePath(context, path, 0, 0, scale, style.type === 'fill');
          }
          hasGeometry = true;
        }
      }

      if (!hasGeometry) continue;

      if (style.type === 'fill') {
        context.globalAlpha = style.fillOpacity ?? 1;
        context.fillStyle = style.fillColor ?? 'rgba(76, 125, 255, 0.45)';
        context.fill('nonzero');
      }
      if (style.lineColor) {
        context.globalAlpha = style.lineOpacity ?? 1;
        context.strokeStyle = style.lineColor;
        context.lineWidth = style.lineWidth ?? (style.type === 'fill' ? 1 : 1.5);
        context.stroke();
      }
    }

    return canvas;
  }

  private fallbackStyles(decoded: Array<MvtTile | null>): MvtStyleLayer[] {
    const names = new Set<string>();
    for (const tile of decoded) {
      for (const layer of tile?.layers ?? []) names.add(layer.name);
    }
    return [...names].map((name, index) => ({
      id: name,
      sourceLayer: name,
      type: 'fill' as const,
      fillColor: PALETTE[index % PALETTE.length]!,
      fillOpacity: 0.45,
      lineColor: PALETTE[index % PALETTE.length]!,
      lineWidth: 1,
      lineOpacity: 0.9,
      minZoom: undefined,
      maxZoom: undefined,
    }));
  }
}

function tracePath(
  context: CanvasRenderingContext2D,
  points: Array<[number, number]>,
  offsetX: number,
  offsetY: number,
  scale: number,
  close: boolean,
): void {
  points.forEach(([x, y], index) => {
    const px = offsetX + x * scale;
    const py = offsetY + y * scale;
    if (index === 0) context.moveTo(px, py);
    else context.lineTo(px, py);
  });
  if (close) context.closePath();
}

function intersects(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function styleVisible(style: MvtStyleLayer, zoom: number): boolean {
  if (style.minZoom !== undefined && zoom < style.minZoom) return false;
  if (style.maxZoom !== undefined && zoom > style.maxZoom) return false;
  return true;
}

function tilesFor(bbox: BBox, z: number): TileRef[] {
  const max = 2 ** z - 1;
  const x0 = clamp(Math.floor(tileX(bbox[0], z)), 0, max);
  const x1 = clamp(Math.floor(tileX(bbox[2], z)), 0, max);
  const y0 = clamp(Math.floor(tileY(bbox[3], z)), 0, max);
  const y1 = clamp(Math.floor(tileY(bbox[1], z)), 0, max);

  const tiles: TileRef[] = [];
  for (let x = x0; x <= x1; x += 1) {
    for (let y = y0; y <= y1; y += 1) tiles.push({z, x, y});
  }
  return tiles;
}

/** OverlayView that positions a canvas over a geographic bounding box. */
class MvtCanvasOverlay {
  private readonly overlay: google.maps.OverlayView;
  private container: HTMLDivElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private bounds: BBox | null = null;

  constructor(googleApi: typeof google, map: google.maps.Map) {
    const overlay = new googleApi.maps.OverlayView();
    overlay.onAdd = () => this.onAdd();
    overlay.draw = () => this.position();
    overlay.onRemove = () => this.onRemove();
    this.overlay = overlay;
    this.overlay.setMap(map);
  }

  setMap(map: google.maps.Map | null): void {
    this.overlay.setMap(map);
  }

  getCanvas(): HTMLCanvasElement | null {
    return this.canvas;
  }

  setBounds(bounds: BBox): void {
    this.bounds = bounds;
    this.position();
  }

  destroy(): void {
    this.overlay.setMap(null);
    this.onRemove();
  }

  private onAdd(): void {
    const panes = this.overlay.getPanes();
    if (!panes) return;

    // A re-add without onRemove would otherwise stack canvases.
    this.container?.remove();

    const container = document.createElement('div');
    container.style.position = 'absolute';
    container.style.left = '0';
    container.style.top = '0';
    container.style.pointerEvents = 'none';

    const canvas = document.createElement('canvas');
    canvas.style.position = 'absolute';
    canvas.style.left = '0';
    canvas.style.top = '0';
    canvas.style.pointerEvents = 'none';

    container.appendChild(canvas);
    panes.overlayLayer.appendChild(container);

    this.container = container;
    this.canvas = canvas;
    this.position();
  }

  private onRemove(): void {
    this.container?.remove();
    this.container = null;
    this.canvas = null;
  }

  private position(): void {
    if (!this.container || !this.canvas || !this.bounds) return;
    const projection = this.overlay.getProjection();
    if (!projection) return;

    const [west, south, east, north] = this.bounds;
    const northWest = projection.fromLatLngToDivPixel({lat: north, lng: west});
    const southEast = projection.fromLatLngToDivPixel({lat: south, lng: east});
    if (!northWest || !southEast) return;

    const width = Math.max(0, southEast.x - northWest.x);
    const height = Math.max(0, southEast.y - northWest.y);
    this.container.style.left = `${northWest.x}px`;
    this.container.style.top = `${northWest.y}px`;
    this.container.style.width = `${width}px`;
    this.container.style.height = `${height}px`;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  }
}
