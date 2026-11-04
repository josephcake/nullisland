import type {HttpClient} from '../http.ts';
import type {ArcGisService} from '../discovery.ts';
import type {NormalizedLayerConfig} from '../config.ts';
import type {RGBA, ResolvedMode} from '../types.ts';
import type {Viewport} from '../viewport.ts';

export interface RendererOptions {
  map: google.maps.Map;
  google: typeof google;
  http: HttpClient;
  layer: NormalizedLayerConfig;
  service: ArcGisService;
  color: RGBA | undefined;
  opacity: number;
  cacheSize: number;
  padding: number;
  maxImageSize: number;
  fadeDuration: number;
  reducedMotion: boolean;
  exportTransport: 'image' | 'fetch';
  exportTimeout: number;
  onLoading(loading: boolean): void;
  onError(error: Error): void;
  onLoaded?(): void;
}

export interface LayerRenderer {
  readonly mode: ResolvedMode;
  attach(): void;
  detach(): void;
  update(view: Viewport): void;
  prefetch(view: Viewport): void;
  setOpacity(opacity: number): void;
  refresh(): void;
  destroy(): void;
}
