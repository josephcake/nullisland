/**
 * WebGL MVT renderer.
 *
 * Tiles are decoded and triangulated once on the CPU, then cached as VBOs and
 * drawn with a single shader. The GPU does the fill, so a viewport of tens of
 * thousands of polygons costs a few dozen draw calls instead of a main-thread
 * rasterisation pass.
 */

import {isAbortError, NullIslandHttpError} from '../errors.ts';
import {decodeMvt, type MvtTile} from '../mvt/decode.ts';
import {planTiles, type TilePlan, type TileRef} from '../mvt/scheduler.ts';
import type {MvtStyleLayer, VectorTileService} from '../mvt/service.ts';
import {lineSegments, triangulatePolygons, type Mesh} from '../mvt/triangulate.ts';
import {LRU} from '../util/lru.ts';
import type {BBox} from '../util/mercator.ts';
import type {Viewport} from '../viewport.ts';
import type {LayerRenderer} from './types.ts';
import type {MvtRendererOptions} from './mvt-renderer.ts';

const VERTEX_SHADER = `#version 300 es
in vec2 a_pos;
uniform vec2 u_offset;
uniform float u_scale;
uniform vec2 u_resolution;
void main() {
  vec2 p = a_pos * u_scale + u_offset;
  vec2 clip = vec2(p.x / u_resolution.x * 2.0 - 1.0, 1.0 - p.y / u_resolution.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 outColor;
void main() {
  outColor = u_color;
}`;

interface TileMeshSet {
  extent: number;
  fills: Map<string, Mesh | null>;
  lines: Map<string, Float32Array | null>;
}

interface GpuMesh {
  vbo: WebGLBuffer;
  ibo: WebGLBuffer | null;
  count: number;
}

const PALETTE: Array<[number, number, number, number]> = [
  [76, 125, 255, 255],
  [232, 89, 12, 255],
  [242, 183, 5, 255],
  [47, 158, 68, 255],
  [156, 54, 181, 255],
  [12, 133, 153, 255],
];

export function supportsWebGL2(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    return canvas.getContext('webgl2') !== null;
  } catch {
    return false;
  }
}

export class MvtWebGLRenderer implements LayerRenderer {
  readonly mode = 'mvt' as const;

  private readonly overlay: GlCanvasOverlay;
  private readonly decoded: LRU<string, MvtTile>;
  private readonly meshes: LRU<string, TileMeshSet>;
  private readonly gpu = new Map<string, GpuMesh>();
  private canvas: HTMLCanvasElement | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private uniforms: {
    offset: WebGLUniformLocation | null;
    scale: WebGLUniformLocation | null;
    resolution: WebGLUniformLocation | null;
    color: WebGLUniformLocation | null;
  } = {offset: null, scale: null, resolution: null, color: null};
  private controller: AbortController | null = null;
  private generation = 0;
  private attached = false;
  private loading = false;
  private opacity: number;
  private lastView: Viewport | null = null;

  constructor(private readonly options: MvtRendererOptions) {
    this.opacity = options.opacity;
    this.decoded = new LRU(64);
    this.meshes = new LRU(128);
    this.overlay = new GlCanvasOverlay(options.google, options.map);
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.overlay.setMap(this.options.map);
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    this.overlay.setMap(null);
    this.canvas = null;
    this.gl = null;
    this.program = null;
    this.gpu.clear();
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
    if (this.lastView) void this.render(this.lastView);
  }

  refresh(): void {
    this.decoded.clear();
    this.meshes.clear();
    this.gpu.clear();
    if (this.lastView) void this.render(this.lastView);
  }

  destroy(): void {
    this.generation += 1;
    this.controller?.abort();
    this.overlay.destroy();
    this.decoded.clear();
    this.meshes.clear();
    this.gpu.clear();
    this.attached = false;
    this.lastView = null;
  }

  private setLoading(loading: boolean): void {
    if (this.loading === loading) return;
    this.loading = loading;
    this.options.onLoading(loading);
  }

  private async render(view: Viewport): Promise<void> {
    if (!this.attached) return;

    const {service} = this.options;
    const padding = Math.min(this.options.padding, 0.15);
    const plan = planTiles(view, service.minZoom, service.maxZoom, padding);

    const generation = ++this.generation;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.setLoading(true);

    try {
      const tiles = plan.tiles;
      const decoded = await Promise.all(
        tiles.map((tile) => this.loadTile(tile, controller.signal)),
      );
      if (generation !== this.generation) return;

      let total = 0;
      for (const tile of decoded) {
        for (const layer of tile?.layers ?? []) total += layer.features.length;
      }
      // The canvas painter's feature budget exists because CPU rasterisation
      // is linear in feature count. A GPU draw is not, so only reject truly
      // pathological viewports.
      if (total > Math.max(this.options.layer.maxFeatures, 200_000)) {
        this.clearCanvas(plan, view);
        return;
      }

      for (let index = 0; index < tiles.length; index += 1) {
        if (generation !== this.generation) return;
        const tile = tiles[index]!;
        if (decoded[index]) {
          this.ensureMeshes(tile, decoded[index]!, plan);
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
      if (generation !== this.generation) return;

      this.draw(plan, view, tiles);
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
    const cached = this.decoded.get(key);
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
      this.decoded.set(key, decoded);
      return decoded;
    } catch (error) {
      if (error instanceof NullIslandHttpError && (error.status === 404 || error.status === 400)) {
        const empty: MvtTile = {layers: []};
        this.decoded.set(key, empty);
        return empty;
      }
      throw error;
    }
  }

  private ensureMeshes(tile: TileRef, data: MvtTile, plan: TilePlan): TileMeshSet {
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    const cached = this.meshes.get(key);
    if (cached) return cached;

    const {service} = this.options;
    const set: TileMeshSet = {extent: service.extent, fills: new Map(), lines: new Map()};

    // Only triangulate layers the style actually references.
    const styled =
      service.styleLayers.length > 0
        ? new Set(service.styleLayers.map((style) => style.sourceLayer))
        : null;
    const wantsLines = service.styleLayers.some((style) => style.type === 'line');

    for (const layer of data.layers) {
      if (styled && !styled.has(layer.name)) continue;
      const extent = layer.extent || service.extent;
      const screenScale = plan.tilePx / extent;
      set.fills.set(layer.name, triangulatePolygons(layer.features, screenScale));
      if (wantsLines) set.lines.set(layer.name, lineSegments(layer.features));
    }

    this.meshes.set(key, set);
    return set;
  }

  private ensureGl(canvas: HTMLCanvasElement): WebGL2RenderingContext | null {
    if (this.gl && this.canvas === canvas) return this.gl;

    const gl = canvas.getContext('webgl2', {alpha: true, antialias: true, premultipliedAlpha: false});
    if (!gl) return null;

    const program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    if (!program) return null;

    this.canvas = canvas;
    this.gl = gl;
    this.program = program;
    this.gpu.clear();
    this.uniforms = {
      offset: gl.getUniformLocation(program, 'u_offset'),
      scale: gl.getUniformLocation(program, 'u_scale'),
      resolution: gl.getUniformLocation(program, 'u_resolution'),
      color: gl.getUniformLocation(program, 'u_color'),
    };
    return gl;
  }

  private draw(plan: TilePlan, view: Viewport, tiles: TileRef[]): void {
    const canvas = this.overlay.getCanvas();
    if (!canvas) return;
    const gl = this.ensureGl(canvas);
    if (!gl || !this.program) {
      if (typeof console !== 'undefined') console.warn('[nullisland webgl] no GL context or program');
      return;
    }

    const {padding, service} = this.options;
    const dpr = Math.min(view.dpr, 2);
    const cssWidth = Math.max(1, Math.round(view.width * (1 + padding * 2)));
    const cssHeight = Math.max(1, Math.round(view.height * (1 + padding * 2)));
    const maxPixels = 6_000_000;
    const scale = Math.min(1, Math.sqrt(maxPixels / (cssWidth * dpr * cssHeight * dpr)));
    const deviceWidth = Math.max(1, Math.round(cssWidth * dpr * scale));
    const deviceHeight = Math.max(1, Math.round(cssHeight * dpr * scale));

    if (canvas.width !== deviceWidth || canvas.height !== deviceHeight) {
      canvas.width = deviceWidth;
      canvas.height = deviceHeight;
    }
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    gl.viewport(0, 0, deviceWidth, deviceHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.program);

    const position = gl.getAttribLocation(this.program, 'a_pos');
    gl.enableVertexAttribArray(position);
    gl.uniform2f(this.uniforms.resolution, cssWidth, cssHeight);

    const styles =
      service.styleLayers.length > 0 ? service.styleLayers : this.fallbackStyles(tiles);
    const fillOrLine = (style: MvtStyleLayer): boolean =>
      (style.type === 'fill' && style.fillColor !== undefined) ||
      (style.type === 'line' && style.lineColor !== undefined);

    for (const style of styles) {
      if (!fillOrLine(style)) continue;
      if (!styleVisible(style, view.zoom)) continue;

      const isLine = style.type === 'line';
      const rgba = parseCssColor(
        isLine ? (style.lineColor ?? '#4c7dff') : (style.fillColor ?? 'rgba(76,125,255,0.45)'),
      );
      const alpha = this.opacity * (isLine ? (style.lineOpacity ?? 1) : (style.fillOpacity ?? 1));
      gl.uniform4f(this.uniforms.color, rgba[0], rgba[1], rgba[2], rgba[3] * alpha);

      for (const tile of tiles) {
        const key = `${tile.z}/${tile.x}/${tile.y}`;
        const set = this.meshes.get(key);
        if (!set) continue;
        const scalePerUnit = plan.tilePx / set.extent;
        gl.uniform2f(
          this.uniforms.offset,
          tile.x * plan.tilePx - plan.originX,
          tile.y * plan.tilePx - plan.originY,
        );
        gl.uniform1f(this.uniforms.scale, scalePerUnit);

        if (isLine) {
          const lines = set.lines.get(style.sourceLayer);
          if (!lines) continue;
          const gpu = this.getGpuMesh(key, style.sourceLayer, 'line', lines, null);
          if (!gpu) continue;
          gl.bindBuffer(gl.ARRAY_BUFFER, gpu.vbo);
          gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
          gl.drawArrays(gl.LINES, 0, gpu.count);
        } else {
          const mesh = set.fills.get(style.sourceLayer);
          if (!mesh) continue;
          const gpu = this.getGpuMesh(key, style.sourceLayer, 'fill', mesh.positions, mesh.indices);
          if (!gpu || !gpu.ibo) continue;
          gl.bindBuffer(gl.ARRAY_BUFFER, gpu.vbo);
          gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gpu.ibo);
          gl.drawElements(gl.TRIANGLES, gpu.count, gl.UNSIGNED_INT, 0);
        }
      }
    }

    this.overlay.setBounds(plan.bbox);

    if (typeof console !== 'undefined') {
      let meshes = 0;
      for (const tile of tiles) {
        const set = this.meshes.get(`${tile.z}/${tile.x}/${tile.y}`);
        if (set) meshes += set.fills.size;
      }
      console.debug(`[nullisland webgl] ${tiles.length} tiles, ${meshes} meshes, ${deviceWidth}x${deviceHeight}`);
    }
  }

  private getGpuMesh(
    tileKey: string,
    layer: string,
    kind: 'fill' | 'line',
    positions: Float32Array,
    indices: Uint32Array | null,
  ): GpuMesh | null {
    const gl = this.gl;
    if (!gl) return null;
    const key = `${tileKey}|${layer}|${kind}`;
    const cached = this.gpu.get(key);
    if (cached) return cached;

    const vbo = gl.createBuffer();
    if (!vbo) return null;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

    let ibo: WebGLBuffer | null = null;
    let count = positions.length / 2;
    if (indices) {
      ibo = gl.createBuffer();
      if (!ibo) {
        gl.deleteBuffer(vbo);
        return null;
      }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
      count = indices.length;
    }

    const mesh: GpuMesh = {vbo, ibo, count};
    this.gpu.set(key, mesh);

    // Bound the GPU cache; delete the oldest buffers.
    if (this.gpu.size > 256) {
      const oldest = this.gpu.keys().next();
      if (!oldest.done) {
        const evicted = this.gpu.get(oldest.value);
        if (evicted) {
          gl.deleteBuffer(evicted.vbo);
          if (evicted.ibo) gl.deleteBuffer(evicted.ibo);
        }
        this.gpu.delete(oldest.value);
      }
    }

    return mesh;
  }

  private fallbackStyles(tiles: TileRef[]): MvtStyleLayer[] {
    const names = new Set<string>();
    for (const tile of tiles) {
      const set = this.meshes.get(`${tile.z}/${tile.x}/${tile.y}`);
      for (const name of set?.fills.keys() ?? []) names.add(name);
    }
    return [...names].map((name, index) => {
      const [r, g, b] = PALETTE[index % PALETTE.length]!;
      return {
        id: name,
        sourceLayer: name,
        type: 'fill' as const,
        fillColor: `rgb(${r}, ${g}, ${b})`,
        fillOpacity: 0.45,
        lineColor: `rgb(${r}, ${g}, ${b})`,
        lineWidth: 1,
        lineOpacity: 0.9,
        minZoom: undefined,
        maxZoom: undefined,
      };
    });
  }

  private clearCanvas(plan: TilePlan, view: Viewport): void {
    const canvas = this.overlay.getCanvas();
    if (!canvas) return;
    canvas.width = 1;
    canvas.height = 1;
    canvas.style.width = `${Math.round(view.width)}px`;
    canvas.style.height = `${Math.round(view.height)}px`;
    this.overlay.setBounds(plan.bbox);
  }
}

function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram | null {
  const compile = (type: number, source: string): WebGLShader | null => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      if (typeof console !== 'undefined') {
        console.warn('[nullisland webgl] shader compile failed', gl.getShaderInfoLog(shader));
      }
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  };

  const vertex = compile(gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
  if (!vertex || !fragment) return null;

  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    if (typeof console !== 'undefined') {
      console.warn('[nullisland webgl] program link failed', gl.getProgramInfoLog(program));
    }
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

/** Minimal CSS color parser for style paint values. */
export function parseCssColor(value: string): [number, number, number, number] {
  const text = value.trim();

  if (text.startsWith('#')) {
    const hex = text.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const [r, g, b, a = 'f'] = hex.split('');
      return [
        Number.parseInt(r! + r!, 16) / 255,
        Number.parseInt(g! + g!, 16) / 255,
        Number.parseInt(b! + b!, 16) / 255,
        Number.parseInt(a! + a!, 16) / 255,
      ];
    }
    if (hex.length === 6 || hex.length === 8) {
      return [
        Number.parseInt(hex.slice(0, 2), 16) / 255,
        Number.parseInt(hex.slice(2, 4), 16) / 255,
        Number.parseInt(hex.slice(4, 6), 16) / 255,
        hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
      ];
    }
  }

  const match = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (match) {
    const parts = match[1]!.split(',').map((part) => Number.parseFloat(part.trim()));
    const [r = 0, g = 0, b = 0, a = 1] = parts;
    return [r / 255, g / 255, b / 255, a];
  }

  return [0.3, 0.5, 1, 0.45];
}

function styleVisible(style: MvtStyleLayer, zoom: number): boolean {
  if (style.minZoom !== undefined && zoom < style.minZoom) return false;
  if (style.maxZoom !== undefined && zoom > style.maxZoom) return false;
  return true;
}



/** OverlayView that positions a canvas over a geographic bounding box. */
class GlCanvasOverlay {
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
