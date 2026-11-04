/**
 * The engine: owns layers, listens to the map, and keeps loading/status in
 * sync with the UI.
 */

import {normalizeLayers} from './config.ts';
import {NullIslandConfigError} from './errors.ts';
import {Emitter} from './events.ts';
import {HttpClient} from './http.ts';
import {LayerController} from './layer.ts';
import {readViewport} from './viewport.ts';
import type {
  NullIslandEventMap,
  NullIslandLayer,
  NullIslandOptions,
  NullIslandStatus,
  TokenSource,
} from './types.ts';

const INDICATOR_DELAY_MS = 300;
const UPDATE_DEBOUNCE_MS = 120;

export class NullIsland {
  /** Resolves when every layer has finished discovery (errors included). */
  readonly ready: Promise<void>;

  private readonly controllers: LayerController[];
  private readonly http: HttpClient;
  private readonly emitter = new Emitter<NullIslandEventMap>();
  private readonly map: google.maps.Map;
  private readonly googleApi: typeof google;
  private readonly listeners: google.maps.MapsEventListener[] = [];
  private readonly pending = new Set<string>();
  private readonly dpr: number;
  private readonly indicatorElement: HTMLElement | null;
  private readonly ownsIndicator: boolean;
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  private indicatorTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(options: NullIslandOptions) {
    if (!options || typeof options !== 'object') {
      throw new NullIslandConfigError('NullIsland requires an options object');
    }
    if (!options.map) {
      throw new NullIslandConfigError('NullIsland requires a Google Maps map instance');
    }

    this.map = options.map;
    this.googleApi = resolveGoogle(options.google);

    const dpr = (globalThis as {devicePixelRatio?: number}).devicePixelRatio ?? 1;
    this.dpr = Math.min(3, Math.max(1, dpr));

    this.http = new HttpClient({fetch: options.fetch, token: options.apiKey});

    const {layers, errors} = normalizeLayers(options.layers);
    const reducedMotion = options.reducedMotion ?? prefersReducedMotion();

    this.controllers = layers.map(
      (config) =>
        new LayerController(config, {
          map: this.map,
          google: this.googleApi,
          http: this.http,
          cacheSize: options.cacheSize ?? 8,
          padding: options.padding ?? 0.25,
          maxImageSize: options.maxImageSize ?? 4096,
          fadeDuration: options.fadeDuration ?? 150,
          reducedMotion,
          onLoading: (id, loading) => this.handleLoading(id, loading),
          onError: (error) => this.emitError(error),
          onLoaded: (id) => this.emitter.emit('load', {layer: id}),
        }),
    );

    const indicator = setupIndicator(options.indicator, this.map);
    this.indicatorElement = indicator?.element ?? null;
    this.ownsIndicator = indicator?.owned ?? false;

    // Config errors must not prevent valid layers from loading.
    for (const {index, error} of errors) {
      setTimeout(() => {
        this.emitError(
          new NullIslandConfigError(`Layer at index ${index} was skipped: ${error.message}`),
        );
      }, 0);
    }

    this.bindMapEvents();
    this.emitStatus();
    this.ready = this.init();
  }

  get layers(): readonly NullIslandLayer[] {
    return this.controllers;
  }

  on<K extends keyof NullIslandEventMap>(event: K, listener: (payload: NullIslandEventMap[K]) => void): () => void {
    return this.emitter.on(event, listener);
  }

  setApiKey(token: TokenSource | undefined): void {
    this.http.setToken(token);
  }

  getLayer(id: string): NullIslandLayer | undefined {
    return this.controllers.find((controller) => controller.id === id);
  }

  prefetch(id: string): void {
    this.controllers.find((controller) => controller.id === id)?.prefetch();
  }

  refresh(id?: string): void {
    for (const controller of this.controllers) {
      if (id === undefined || controller.id === id) controller.refresh();
    }
  }

  getStatus(): NullIslandStatus {
    return {
      loading: this.pending.size > 0,
      layers: this.controllers.map((controller) => ({
        id: controller.id,
        state: controller.state,
        mode: controller.mode,
        ...(controller.message ? {message: controller.message} : {}),
      })),
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.updateTimer) clearTimeout(this.updateTimer);
    if (this.indicatorTimer) clearTimeout(this.indicatorTimer);
    this.updateTimer = null;
    this.indicatorTimer = null;

    for (const listener of this.listeners) listener.remove();
    this.listeners.length = 0;

    for (const controller of this.controllers) controller.destroy();
    this.controllers.length = 0;
    this.pending.clear();

    if (this.indicatorElement && this.ownsIndicator) this.indicatorElement.remove();
    this.emitter.clear();
  }

  private async init(): Promise<void> {
    await Promise.all(
      this.controllers.map(async (controller) => {
        try {
          await controller.init();
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          controller.fail(failure);
          this.emitError(failure);
        }
      }),
    );

    this.update();
    this.emitStatus();
  }

  private bindMapEvents(): void {
    this.listeners.push(
      this.map.addListener('idle', () => this.scheduleUpdate()),
      this.map.addListener('zoom_changed', () => this.update()),
      this.map.addListener('projection_changed', () => this.update()),
    );
  }

  private scheduleUpdate(): void {
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      this.update();
    }, UPDATE_DEBOUNCE_MS);
  }

  private update(): void {
    if (this.destroyed) return;
    const view = readViewport(this.map, this.dpr);
    if (!view) return;

    for (const controller of this.controllers) controller.sync(view);
    this.emitStatus();
  }

  private handleLoading(id: string, loading: boolean): void {
    if (loading) this.pending.add(id);
    else this.pending.delete(id);
    this.updateIndicator();
    this.emitStatus();
  }

  private emitError(error: Error): void {
    this.emitter.emit('error', error);
  }

  private emitStatus(): void {
    if (this.destroyed) return;
    this.emitter.emit('status', this.getStatus());
  }

  private updateIndicator(): void {
    if (!this.indicatorElement) return;

    if (this.pending.size > 0) {
      if (this.indicatorTimer) return;
      this.indicatorTimer = setTimeout(() => {
        this.indicatorTimer = null;
        if (this.pending.size > 0 && !this.destroyed) {
          this.indicatorElement!.style.display = 'block';
        }
      }, INDICATOR_DELAY_MS);
      return;
    }

    if (this.indicatorTimer) {
      clearTimeout(this.indicatorTimer);
      this.indicatorTimer = null;
    }
    this.indicatorElement.style.display = 'none';
  }
}

function resolveGoogle(injected: typeof google | undefined): typeof google {
  const candidate = injected ?? (globalThis as {google?: typeof google}).google;
  if (!candidate?.maps) {
    throw new NullIslandConfigError(
      'Google Maps JavaScript API is not loaded. Load it before creating NullIsland, or pass the `google` namespace.',
    );
  }
  return candidate;
}

function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function setupIndicator(
  indicator: boolean | HTMLElement | undefined,
  map: google.maps.Map,
): {element: HTMLElement; owned: boolean} | null {
  if (!indicator) return null;

  if (typeof HTMLElement !== 'undefined' && indicator instanceof HTMLElement) {
    return {element: indicator, owned: false};
  }

  if (typeof document === 'undefined') return null;

  const element = document.createElement('div');
  element.textContent = 'Loading map layers…';
  element.setAttribute('role', 'status');
  element.style.cssText = [
    'position:absolute',
    'left:50%',
    'bottom:24px',
    'transform:translateX(-50%)',
    'padding:6px 12px',
    'border-radius:9999px',
    'background:rgba(17,24,39,0.88)',
    'color:#fff',
    'font:500 12px/1.4 system-ui,-apple-system,sans-serif',
    'letter-spacing:0.01em',
    'box-shadow:0 6px 20px rgba(0,0,0,0.25)',
    'pointer-events:none',
    'display:none',
    'z-index:5',
  ].join(';');

  map.getDiv().appendChild(element);
  return {element, owned: true};
}
