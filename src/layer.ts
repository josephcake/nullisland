/**
 * A configured layer: owns discovery, the chosen rendering strategy, the
 * zoom gate, and visibility state.
 */

import {NullIslandError} from './errors.ts';
import {discoverService, type ArcGisService} from './discovery.ts';
import type {NormalizedLayerConfig} from './config.ts';
import {ExportRenderer} from './renderers/export-renderer.ts';
import {VectorRenderer} from './renderers/vector-renderer.ts';
import type {LayerRenderer} from './renderers/types.ts';
import type {HttpClient} from './http.ts';
import type {NullIslandLayer, NullIslandSublayer, LayerState, ResolvedMode} from './types.ts';
import type {Viewport} from './viewport.ts';

export interface LayerContext {
  map: google.maps.Map;
  google: typeof google;
  http: HttpClient;
  cacheSize: number;
  padding: number;
  maxImageSize: number;
  fadeDuration: number;
  reducedMotion: boolean;
  onLoading(id: string, loading: boolean): void;
  onError(error: Error): void;
  onLoaded(id: string): void;
}

export class LayerController implements NullIslandLayer {
  readonly config: NormalizedLayerConfig;
  service: ArcGisService | null = null;
  renderer: LayerRenderer | null = null;
  state: LayerState = 'idle';
  message: string | undefined;
  minZoom = 0;
  maxZoom = 22;

  private currentView: Viewport | null = null;
  private isVisible: boolean;
  private layerTitle: string;

  constructor(
    config: NormalizedLayerConfig,
    private readonly context: LayerContext,
  ) {
    this.config = config;
    this.isVisible = config.visible;
    this.layerTitle = config.title ?? config.service.base;
  }

  get id(): string {
    return this.config.id;
  }

  get title(): string {
    return this.layerTitle;
  }

  get url(): string {
    return this.config.service.base;
  }

  get mode(): ResolvedMode | null {
    return this.renderer?.mode ?? null;
  }

  get visible(): boolean {
    return this.isVisible;
  }

  get sublayers(): readonly NullIslandSublayer[] {
    return (this.service?.sublayers ?? []).map((sublayer) => ({
      id: sublayer.id,
      name: sublayer.name,
    }));
  }

  async init(): Promise<void> {
    this.state = 'loading';
    const service = await discoverService(this.config.service, this.context.http, {
      sublayers: this.config.sublayers,
      title: this.config.title,
    });

    this.service = service;
    this.layerTitle = this.config.title ?? service.title;
    this.minZoom = this.config.minZoom ?? service.zoom.minZoom;
    this.maxZoom = this.config.maxZoom ?? service.zoom.maxZoom;

    const mode = this.resolveMode(service);
    const options = {
      map: this.context.map,
      google: this.context.google,
      http: this.context.http,
      layer: this.config,
      service,
      color: this.config.color,
      opacity: this.config.opacity,
      cacheSize: this.context.cacheSize,
      padding: this.context.padding,
      maxImageSize: this.context.maxImageSize,
      fadeDuration: this.context.fadeDuration,
      reducedMotion: this.context.reducedMotion,
      onLoading: (loading: boolean) => this.context.onLoading(this.id, loading),
      onError: (error: Error) => this.context.onError(error),
      onLoaded: () => this.context.onLoaded(this.id),
    };

    this.renderer =
      mode === 'export' ? new ExportRenderer(options) : new VectorRenderer(options);
    this.state = 'ready';

    if (this.isVisible && this.currentView) this.sync(this.currentView);
  }

  fail(error: Error): void {
    this.state = 'error';
    this.message = error.message;
  }

  sync(view: Viewport): void {
    this.currentView = view;
    if (!this.isVisible || !this.renderer) return;

    if (view.zoom < this.minZoom || view.zoom > this.maxZoom) {
      this.renderer.detach();
      return;
    }

    this.renderer.attach();
    this.renderer.update(view);
  }

  setVisible(visible: boolean): void {
    if (this.isVisible === visible) return;
    this.isVisible = visible;
    if (!visible) {
      this.renderer?.detach();
      return;
    }
    if (this.currentView) this.sync(this.currentView);
  }

  setOpacity(opacity: number): void {
    this.config.opacity = Math.min(1, Math.max(0, opacity));
    this.renderer?.setOpacity(this.config.opacity);
  }

  prefetch(): void {
    if (!this.currentView || !this.renderer) return;
    this.renderer.prefetch(this.currentView);
  }

  refresh(): void {
    this.renderer?.refresh();
    if (this.currentView) this.sync(this.currentView);
  }

  destroy(): void {
    this.renderer?.destroy();
    this.renderer = null;
    this.currentView = null;
  }

  private resolveMode(service: ArcGisService): ResolvedMode {
    if (this.config.mode === 'export') {
      if (!service.supportsExport) {
        throw new NullIslandError(
          `Layer ${this.config.id} requested export mode but ${service.url} does not advertise the Map capability`,
          'NULLISLAND_NO_EXPORT',
        );
      }
      return 'export';
    }

    if (this.config.mode === 'vector') {
      if (!service.sublayers.some((sublayer) => sublayer.supportsQuery)) {
        throw new NullIslandError(
          `Layer ${this.config.id} requested vector mode but no sublayer supports querying`,
          'NULLISLAND_NO_QUERY',
        );
      }
      return 'vector';
    }

    return service.supportsExport ? 'export' : 'vector';
  }
}
