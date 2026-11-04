/**
 * Export mode: ask the ArcGIS server to render the viewport as an image and
 * place that image over Google Maps.
 *
 * The image is already in Web Mercator, so it is positioned using the div
 * pixel coordinates of its geographic corners. A custom OverlayView is used
 * instead of GroundOverlay to avoid any additional geographic transformation.
 */

import {isAbortError} from '../errors.ts';
import {HALF_WORLD, metersToBbox, type BBox} from '../util/mercator.ts';
import {bboxContains} from '../viewport.ts';
import type {Viewport} from '../viewport.ts';
import type {LayerRenderer, RendererOptions} from './types.ts';

interface ImageEntry {
  element: HTMLImageElement;
  bbox: BBox;
  objectUrl: string;
}

const MAX_WORLD_SPAN = HALF_WORLD * 2;

export class ExportRenderer implements LayerRenderer {
  readonly mode = 'export' as const;

  private readonly overlay: ImageOverlay;
  private current: {bbox: BBox; zoom: number} | null = null;
  private pending: {objectUrl: string; bbox: BBox; zoom: number} | null = null;
  private generation = 0;
  private controller: AbortController | null = null;
  private attached = false;
  private opacity: number;
  private loading = false;

  constructor(private readonly options: RendererOptions) {
    this.opacity = options.opacity;
    this.overlay = new ImageOverlay(options.google, options.map, options.opacity);
  }

  attach(): void {
    if (this.attached) return;
    this.overlay.setMap(this.options.map);
    this.attached = true;
    if (this.pending) {
      this.overlay.show(this.pending.objectUrl, this.pending.bbox, 0, true);
      this.current = {bbox: this.pending.bbox, zoom: this.pending.zoom};
      this.pending = null;
    }
  }

  detach(): void {
    if (!this.attached) return;
    this.overlay.setMap(null);
    this.attached = false;
  }

  update(view: Viewport): void {
    if (!this.attached) return;

    if (
      this.current &&
      this.current.zoom === view.zoom &&
      bboxContains(metersToBbox(this.current.bbox), view.bounds4326)
    ) {
      return;
    }

    void this.load(view, this.attached);
  }

  prefetch(view: Viewport): void {
    if (this.current && bboxContains(metersToBbox(this.current.bbox), view.bounds4326)) return;
    if (this.pending) return;
    void this.load(view, false);
  }

  setOpacity(opacity: number): void {
    this.opacity = opacity;
    this.overlay.setOpacity(opacity);
  }

  refresh(): void {
    this.current = null;
  }

  destroy(): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    this.overlay.destroy();
    if (this.pending) URL.revokeObjectURL(this.pending.objectUrl);
    this.pending = null;
    this.current = null;
  }

  private setLoading(loading: boolean): void {
    if (this.loading === loading) return;
    this.loading = loading;
    this.options.onLoading(loading);
  }

  private async load(view: Viewport, show: boolean): Promise<void> {
    const generation = ++this.generation;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.setLoading(true);

    try {
      const request = this.buildRequest(view);
      const response = await this.options.http.request(
        request.url,
        request.params,
        {signal: controller.signal},
      );
      const blob = await response.blob();
      if (generation !== this.generation) return;

      const objectUrl = URL.createObjectURL(blob);
      if (!show) {
        if (this.pending) URL.revokeObjectURL(this.pending.objectUrl);
        this.pending = {objectUrl, bbox: request.bbox, zoom: view.zoom};
        return;
      }

      const visible = await this.overlay.show(
        objectUrl,
        request.bbox,
        this.options.fadeDuration,
        this.options.reducedMotion,
      );
      if (generation !== this.generation || !visible) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      if (this.pending) URL.revokeObjectURL(this.pending.objectUrl);
      this.pending = null;
      this.current = {bbox: request.bbox, zoom: view.zoom};
    } catch (error) {
      if (!isAbortError(error)) this.options.onError(toError(error));
    } finally {
      if (generation === this.generation) this.setLoading(false);
    }
  }

  private buildRequest(view: Viewport): {
    url: string;
    params: Record<string, string | number>;
    bbox: BBox;
  } {
    const {padding, maxImageSize, service, layer} = this.options;

    const padded = padMeters(view.bounds3857, padding);
    const clamped = clampMeters(padded);

    const cssWidth = view.width * (1 + padding * 2);
    const cssHeight = view.height * (1 + padding * 2);
    const scale = Math.min(1, maxImageSize / Math.max(cssWidth * view.dpr, cssHeight * view.dpr));
    const width = Math.max(1, Math.round(cssWidth * view.dpr * scale));
    const height = Math.max(1, Math.round(cssHeight * view.dpr * scale));

    const url = service.singleLayer && layer.service.layerId !== null
      ? `${service.url}/${layer.service.layerId}/export`
      : `${service.url}/export`;

    const params: Record<string, string | number> = {
      bbox: clamped.map((value) => value.toFixed(2)).join(','),
      bboxSR: '3857',
      imageSR: '3857',
      size: `${width},${height}`,
      format: 'png32',
      transparent: 'true',
      dpi: '96',
      f: 'image',
    };

    if (!service.singleLayer) {
      const ids = layer.sublayers ?? service.sublayers.map((sublayer) => sublayer.id);
      if (ids.length > 0) params.layers = `show:${ids.join(',')}`;
    }

    return {url, params, bbox: clamped};
  }
}

function padMeters(
  bounds: [number, number, number, number],
  padding: number,
): [number, number, number, number] {
  const [xmin, ymin, xmax, ymax] = bounds;
  const dx = (xmax - xmin) * padding;
  const dy = (ymax - ymin) * padding;
  return [xmin - dx, ymin - dy, xmax + dx, ymax + dy];
}

function clampMeters(
  bounds: [number, number, number, number],
): [number, number, number, number] {
  const [xmin, ymin, xmax, ymax] = bounds;
  const x0 = Math.max(-HALF_WORLD, xmin);
  const x1 = Math.min(HALF_WORLD, xmax);
  if (x1 - x0 > MAX_WORLD_SPAN) return [-HALF_WORLD, -HALF_WORLD, HALF_WORLD, HALF_WORLD];
  return [x0, Math.max(-HALF_WORLD, ymin), x1, Math.min(HALF_WORLD, ymax)];
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** OverlayView holding one or two cross-fading images. */
class ImageOverlay {
  private readonly overlay: google.maps.OverlayView;
  private container: HTMLDivElement | null = null;
  private entries: ImageEntry[] = [];
  private opacity: number;

  constructor(
    private readonly googleApi: typeof google,
    map: google.maps.Map,
    opacity: number,
  ) {
    this.opacity = opacity;
    const overlay = new googleApi.maps.OverlayView();
    overlay.onAdd = () => this.onAdd();
    overlay.draw = () => this.draw();
    overlay.onRemove = () => this.onRemove();
    this.overlay = overlay;
    this.overlay.setMap(map);
  }

  setMap(map: google.maps.Map | null): void {
    this.overlay.setMap(map);
  }

  setOpacity(opacity: number): void {
    this.opacity = opacity;
    if (this.container) this.container.style.opacity = String(opacity);
  }

  async show(objectUrl: string, bbox: BBox, fadeMs: number, reducedMotion: boolean): Promise<boolean> {
    const image = new Image();
    image.alt = '';
    image.decoding = 'async';
    image.style.position = 'absolute';
    image.style.opacity = '0';
    image.style.transition = `opacity ${Math.max(fadeMs, 0)}ms linear`;
    image.style.willChange = 'opacity';

    try {
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('Exported map image failed to load'));
        image.src = objectUrl;
      });
    } catch (error) {
      URL.revokeObjectURL(objectUrl);
      throw error;
    }

    if (!this.container) {
      // Detached before the image arrived.
      URL.revokeObjectURL(objectUrl);
      return false;
    }

    const entry: ImageEntry = {element: image, bbox, objectUrl};
    this.entries.push(entry);
    this.container.appendChild(image);
    this.draw();

    // Force a frame so the transition runs.
    if (!reducedMotion) {
      image.getBoundingClientRect();
      requestAnimationFrame(() => {
        image.style.opacity = '1';
      });
    } else {
      image.style.opacity = '1';
    }

    const stale = this.entries.filter((candidate) => candidate !== entry);
    this.entries = [entry];

    if (reducedMotion || fadeMs <= 0) {
      for (const old of stale) this.removeEntry(old);
      return true;
    }

    setTimeout(() => {
      for (const old of stale) this.removeEntry(old);
    }, fadeMs + 30);
    return true;
  }

  destroy(): void {
    this.overlay.setMap(null);
    for (const entry of this.entries) this.removeEntry(entry);
    this.entries = [];
    this.container?.remove();
    this.container = null;
  }

  private removeEntry(entry: ImageEntry): void {
    entry.element.remove();
    URL.revokeObjectURL(entry.objectUrl);
  }

  private onAdd(): void {
    const panes = this.overlay.getPanes();
    if (!panes) return;

    const container = document.createElement('div');
    container.style.position = 'absolute';
    container.style.left = '0';
    container.style.top = '0';
    container.style.width = '0';
    container.style.height = '0';
    container.style.opacity = String(this.opacity);
    container.style.pointerEvents = 'none';
    container.dataset.nullisland = 'export';

    for (const entry of this.entries) container.appendChild(entry.element);

    panes.overlayLayer.appendChild(container);
    this.container = container;
    this.draw();
  }

  private onRemove(): void {
    this.container?.remove();
    this.container = null;
  }

  private draw(): void {
    if (!this.container || this.entries.length === 0) return;
    const projection = this.overlay.getProjection();
    if (!projection) return;

    for (const {element, bbox} of this.entries) {
      const [west, south, east, north] = bbox;
      const northWest = projection.fromLatLngToDivPixel({lat: north, lng: west});
      const southEast = projection.fromLatLngToDivPixel({lat: south, lng: east});
      if (!northWest || !southEast) continue;

      const width = Math.max(0, southEast.x - northWest.x);
      const height = Math.max(0, southEast.y - northWest.y);
      element.style.left = `${northWest.x}px`;
      element.style.top = `${northWest.y}px`;
      element.style.width = `${width}px`;
      element.style.height = `${height}px`;
    }
  }
}
