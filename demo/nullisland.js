var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// src/errors.ts
var NullIslandError = class extends Error {
  constructor(message, code = "NULLISLAND_ERROR", options) {
    super(message, options);
    __publicField(this, "code");
    this.name = "NullIslandError";
    this.code = code;
  }
};
var NullIslandConfigError = class extends NullIslandError {
  constructor(message) {
    super(message, "NULLISLAND_CONFIG");
    this.name = "NullIslandConfigError";
  }
};
var NullIslandHttpError = class extends NullIslandError {
  constructor(message, status, url, options) {
    super(message, "NULLISLAND_HTTP", options);
    __publicField(this, "status");
    __publicField(this, "url");
    __publicField(this, "details");
    this.name = "NullIslandHttpError";
    this.status = status;
    this.url = url;
    this.details = options?.details;
  }
};
var NullIslandAuthError = class extends NullIslandHttpError {
  constructor(message, status, url, options) {
    super(message, status, url, options);
    this.name = "NullIslandAuthError";
  }
};
var NullIslandAbortError = class extends NullIslandError {
  constructor(message = "Request aborted") {
    super(message, "NULLISLAND_ABORTED");
    this.name = "NullIslandAbortError";
  }
};
function isAbortError(error) {
  if (error instanceof NullIslandAbortError) return true;
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

// src/util/color.ts
function parseColor(color2) {
  if (Array.isArray(color2)) {
    const [r2, g2, b2, a2 = 255] = color2;
    for (const channel of [r2, g2, b2, a2]) {
      if (!Number.isFinite(channel) || channel < 0 || channel > 255) {
        throw new NullIslandConfigError(`Invalid color channel: ${channel}`);
      }
    }
    return [Math.round(r2), Math.round(g2), Math.round(b2), Math.round(a2)];
  }
  if (typeof color2 !== "string") {
    throw new NullIslandConfigError("Color must be a hex string or RGBA tuple");
  }
  const value = color2.trim().replace(/^#/, "");
  if (!/^[0-9a-f]+$/i.test(value) || ![3, 4, 6, 8].includes(value.length)) {
    throw new NullIslandConfigError(`Invalid color: ${color2}`);
  }
  const expand = value.length <= 4 ? [...value].map((c) => c + c).join("") : value;
  const channels = (expand.match(/.{2}/g) ?? []).map((c) => Number.parseInt(c, 16));
  const [r = 0, g = 0, b = 0, a = 255] = channels;
  return [r, g, b, a];
}
function rgbaToCss([r, g, b, a]) {
  return `rgba(${r}, ${g}, ${b}, ${a / 255})`;
}
function applyOpacity(color2, opacity) {
  return [color2[0], color2[1], color2[2], Math.round(color2[3] * opacity)];
}

// src/config.ts
var MAX_ZOOM = 22;
var DEFAULT_MAX_FEATURES = 2e4;
var DEFAULT_MAX_PAGES = 10;
function parseServiceUrl(input, options = {}) {
  if (typeof input !== "string" || input.trim() === "") {
    throw new NullIslandConfigError("Layer url must be a non-empty string");
  }
  let parsed;
  try {
    parsed = new URL(input.trim());
  } catch (error) {
    throw new NullIslandConfigError(`Invalid layer url: ${input}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new NullIslandConfigError(`Layer url must be http(s): ${input}`);
  }
  if (parsed.username || parsed.password) {
    throw new NullIslandConfigError("Layer url must not contain credentials; use the apiKey option instead");
  }
  const localHosts = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  if (parsed.protocol === "http:" && !options.allowInsecure && !localHosts.has(parsed.hostname)) {
    throw new NullIslandConfigError(
      `Layer url must use https (got ${input}); pass allowInsecure: true to override`
    );
  }
  const match = /^(.*\/(mapserver|featureserver|vectortileserver))(?:\/(\d+))?\/?$/i.exec(parsed.pathname);
  if (!match) {
    throw new NullIslandConfigError(
      `Layer url must point at a MapServer or FeatureServer: ${input}`
    );
  }
  const base = `${parsed.origin}${match[1]}`;
  const name = match[2].toLowerCase();
  const kind = name === "mapserver" ? "MapServer" : name === "featureserver" ? "FeatureServer" : "VectorTileServer";
  const layerId = match[3] === void 0 ? null : Number(match[3]);
  return { base, kind, layerId };
}
function normalizeLayers(configs, options = {}) {
  if (!Array.isArray(configs)) {
    throw new NullIslandConfigError("layers must be an array");
  }
  const layers = [];
  const errors = [];
  const usedIds = /* @__PURE__ */ new Set();
  configs.forEach((config, index) => {
    try {
      const normalized = normalizeLayer(config, usedIds, options);
      usedIds.add(normalized.id);
      layers.push(normalized);
    } catch (error) {
      errors.push({
        index,
        config,
        error: error instanceof Error ? error : new Error(String(error))
      });
    }
  });
  return { layers, errors };
}
function normalizeLayer(config, usedIds = /* @__PURE__ */ new Set(), options = {}) {
  if (!config || typeof config !== "object") {
    throw new NullIslandConfigError("Layer config must be an object");
  }
  const service = parseServiceUrl(config.url, options);
  const color2 = config.color === void 0 ? void 0 : normalizeColor(config.color);
  const opacity = config.opacity === void 0 ? 1 : config.opacity;
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
    throw new NullIslandConfigError(`opacity must be between 0 and 1, received ${String(config.opacity)}`);
  }
  const minZoom = normalizeZoom(config.minZoom, "minZoom");
  const maxZoom = normalizeZoom(config.maxZoom, "maxZoom");
  if (minZoom !== void 0 && maxZoom !== void 0 && minZoom > maxZoom) {
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
  const maxFeatures = positiveInteger(config.maxFeatures, DEFAULT_MAX_FEATURES, "maxFeatures");
  const maxPages = positiveInteger(config.maxPages, DEFAULT_MAX_PAGES, "maxPages");
  return {
    id,
    title: config.title?.trim() || void 0,
    url: config.url,
    service,
    color: color2,
    opacity,
    minZoom,
    maxZoom,
    visible: config.visible !== false,
    mode,
    sublayers,
    styleUrl: config.styleUrl,
    maxFeatures,
    maxPages
  };
}
function normalizeColor(color2) {
  try {
    return parseColor(color2);
  } catch (error) {
    throw new NullIslandConfigError(error instanceof Error ? error.message : "Invalid color");
  }
}
function normalizeZoom(value, field) {
  if (value === void 0) return void 0;
  if (!Number.isFinite(value) || value < 0 || value > MAX_ZOOM) {
    throw new NullIslandConfigError(`${field} must be between 0 and ${MAX_ZOOM}`);
  }
  return value;
}
function normalizeMode(value) {
  if (value === void 0) return "auto";
  if (value !== "auto" && value !== "export" && value !== "vector") {
    throw new NullIslandConfigError(`mode must be "auto", "export" or "vector"`);
  }
  return value;
}
function normalizeSublayers(value) {
  if (value === void 0) return void 0;
  if (!Array.isArray(value)) throw new NullIslandConfigError("sublayers must be an array of layer ids");
  const ids = value.map((id) => {
    if (!Number.isInteger(id) || id < 0) {
      throw new NullIslandConfigError(`Invalid sublayer id: ${String(id)}`);
    }
    return id;
  });
  return ids.length > 0 ? [...new Set(ids)] : void 0;
}
function positiveInteger(value, fallback, field) {
  if (value === void 0) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new NullIslandConfigError(`${field} must be a positive integer`);
  }
  return value;
}
function deriveLayerId(url, service) {
  const parts = service.base.split("/");
  const name = parts[parts.length - 2] ?? "layer";
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "layer";
  const layer = service.layerId === null ? "" : `-${service.layerId}`;
  return `${slug}${layer}-${hash(url)}`;
}
function hash(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// src/events.ts
var Emitter = class {
  constructor() {
    __publicField(this, "listeners", /* @__PURE__ */ new Map());
  }
  on(event, listener) {
    let set = this.listeners.get(event);
    if (!set) {
      set = /* @__PURE__ */ new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(event);
    };
  }
  emit(event, payload) {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      listener(payload);
    }
  }
  clear() {
    this.listeners.clear();
  }
};

// src/http.ts
var DEFAULT_TIMEOUT_MS = 3e4;
var HttpClient = class {
  constructor(options = {}) {
    __publicField(this, "token");
    __publicField(this, "fetchImpl");
    __publicField(this, "timeoutMs");
    const impl = options.fetch ?? (typeof fetch === "function" ? fetch : void 0);
    if (!impl) {
      throw new NullIslandError("No fetch implementation available", "NULLISLAND_NO_FETCH");
    }
    this.fetchImpl = impl;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }
  setToken(token) {
    this.token = token;
  }
  /** GET a URL with query parameters and the configured token. */
  async request(url, params = {}, init = {}) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.resolveToken();
      const full = withParams(url, params, token);
      let response;
      try {
        response = await this.fetchWithTimeout(full, init);
      } catch (error) {
        if (isAbortError(error)) throw error;
        throw new NullIslandHttpError(
          error instanceof Error ? error.message : "Network request failed",
          0,
          full,
          { cause: error }
        );
      }
      if ((response.status === 498 || response.status === 499) && attempt === 0) {
        lastError = await this.toError(response, full);
        continue;
      }
      if (!response.ok) throw await this.toError(response, full);
      return response;
    }
    throw lastError ?? new NullIslandAuthError("Token rejected by the ArcGIS server", 499, url);
  }
  /** Build a request URL (including token) without performing the request. */
  async url(path, params = {}) {
    const token = await this.resolveToken();
    return withParams(path, params, token);
  }
  /** GET and parse JSON, surfacing ArcGIS `{error: ...}` documents as exceptions. */
  async json(url, params = {}) {
    const response = await this.request(url, params);
    return parseJson(await response.text(), url);
  }
  /** GET binary data. */
  async bytes(url, params = {}) {
    const response = await this.request(url, params);
    return { buffer: await response.arrayBuffer(), contentType: response.headers.get("content-type") ?? "" };
  }
  async resolveToken() {
    if (!this.token) return null;
    if (typeof this.token === "string") return this.token;
    try {
      const value = await this.token();
      return value || null;
    } catch (error) {
      throw new NullIslandAuthError(
        "Token provider threw",
        401,
        "token",
        { cause: error }
      );
    }
  }
  async fetchWithTimeout(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Request timed out")), this.timeoutMs);
    const source = init.signal;
    const forwardAbort = () => controller.abort(source?.reason);
    if (source) {
      if (source.aborted) forwardAbort();
      else source.addEventListener("abort", forwardAbort, { once: true });
    }
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      source?.removeEventListener("abort", forwardAbort);
    }
  }
  async toError(response, url) {
    let message = `ArcGIS request failed with HTTP ${response.status}`;
    let details;
    try {
      const text = await response.text();
      if (text) {
        const body = parseJson(text, url, { soft: true });
        if (body?.error?.message) {
          message = body.error.message;
          details = body.error.details;
        }
      }
    } catch {
    }
    if ((response.status === 498 || response.status === 499) && !this.token) {
      message = "This ArcGIS service requires a token. Pass the `apiKey` option; public layers do not need one.";
    }
    const ErrorType = response.status === 401 || response.status === 498 || response.status === 499 ? NullIslandAuthError : NullIslandHttpError;
    return new ErrorType(message, response.status, url, { details });
  }
};
function withParams(url, params, token) {
  const absolute = new URL(url, getBaseUrl());
  for (const [key, value] of Object.entries(params)) {
    if (value === void 0 || value === null) continue;
    absolute.searchParams.set(key, String(value));
  }
  if (token) absolute.searchParams.set("token", token);
  return absolute.toString();
}
function getBaseUrl() {
  if (typeof location !== "undefined" && location.href) return location.href;
  return "http://localhost/";
}
function parseJson(text, url, options = {}) {
  try {
    const data = JSON.parse(text);
    if (data && typeof data === "object" && "error" in data && data.error) {
      throw new NullIslandHttpError(
        data.error.message ?? "ArcGIS request failed",
        data.error.code ?? 500,
        url,
        { details: data.error.details }
      );
    }
    return data;
  } catch (error) {
    if (error instanceof NullIslandHttpError) throw error;
    if (options.soft) return void 0;
    throw new NullIslandError(`Invalid JSON from ${url}`, "NULLISLAND_BAD_JSON", { cause: error });
  }
}

// src/util/zoom.ts
var DPI = 96;
var METERS_PER_INCH = 0.0254;
var ZOOM0_RESOLUTION = 156543.03392804097;
var MIN_ZOOM = 0;
var MAX_ZOOM2 = 22;
function scaleToZoom(scale) {
  if (!Number.isFinite(scale) || scale <= 0) return Number.NaN;
  const resolution = scale * METERS_PER_INCH / DPI;
  return Math.log2(ZOOM0_RESOLUTION / resolution);
}
function zoomRangeFromScales(minScale, maxScale) {
  let minZoom = MIN_ZOOM;
  let maxZoom = MAX_ZOOM2;
  if (typeof minScale === "number" && minScale > 0) {
    const zoom = scaleToZoom(minScale);
    if (Number.isFinite(zoom)) minZoom = clampZoom(Math.ceil(zoom));
  }
  if (typeof maxScale === "number" && maxScale > 0) {
    const zoom = scaleToZoom(maxScale);
    if (Number.isFinite(zoom)) maxZoom = clampZoom(Math.floor(zoom));
  }
  if (maxZoom < minZoom) maxZoom = minZoom;
  return { minZoom, maxZoom };
}
function clampZoom(zoom) {
  return Math.min(MAX_ZOOM2, Math.max(MIN_ZOOM, zoom));
}

// src/discovery.ts
var PBF_MIN_VERSION = 10.7;
var METADATA_CONCURRENCY = 4;
async function discoverService(service, http, options = {}) {
  const metadata = await http.json(service.base, { f: "json" });
  const version = Number(metadata.currentVersion ?? 0);
  const capabilities = splitCapabilities(metadata.capabilities ?? "");
  const queryFormats = splitFormats(metadata.supportedQueryFormats);
  if (service.layerId !== null) {
    const layerMetadata = await readLayerMetadata(http, service, metadata);
    const layer = { ...layerMetadata, id: service.layerId };
    const layerFormats = splitFormats(layerMetadata.supportedQueryFormats);
    const formats = layerFormats.length > 0 ? layerFormats : queryFormats;
    const sublayer = toSublayer(layer, {
      kind: service.kind,
      version,
      maxRecordCount: Number(layerMetadata.maxRecordCount ?? metadata.maxRecordCount ?? 1e3),
      queryFormats: formats
    });
    const layerCapabilities = splitCapabilities(layer.capabilities ?? metadata.capabilities ?? "");
    return {
      url: service.base,
      kind: service.kind,
      version,
      title: options.title ?? layer.name ?? service.base,
      description: metadata.description ?? metadata.serviceDescription,
      capabilities: layerCapabilities,
      queryFormats: formats,
      supportsExport: service.kind === "MapServer" && hasCapability(layerCapabilities, "map"),
      maxRecordCount: sublayer.maxRecordCount,
      singleLayer: true,
      sublayers: [sublayer],
      zoom: sublayer.zoom
    };
  }
  const rawLayers = (metadata.layers ?? []).filter((layer) => !isGroupLayer(layer));
  const selected = options.sublayers ? rawLayers.filter((layer) => layer.id !== void 0 && options.sublayers.includes(layer.id)) : rawLayers;
  if (selected.length === 0) {
    throw new NullIslandError(
      `No queryable sublayers found in ${service.base}`,
      "NULLISLAND_NO_SUBLAYERS"
    );
  }
  const details = await mapLimit(selected, METADATA_CONCURRENCY, async (layer) => {
    if (layer.id === void 0) return layer;
    try {
      return await http.json(`${service.base}/${layer.id}`, { f: "json" });
    } catch {
      return layer;
    }
  });
  const sublayers = details.map(
    (layer) => toSublayer(layer, {
      kind: service.kind,
      version,
      maxRecordCount: Number(layer.maxRecordCount ?? metadata.maxRecordCount ?? 1e3),
      queryFormats
    })
  );
  const zoom = unionZoom(sublayers);
  const first = sublayers[0];
  return {
    url: service.base,
    kind: service.kind,
    version,
    title: options.title ?? metadata.mapName ?? metadata.name ?? first?.name ?? service.base,
    description: metadata.serviceDescription ?? metadata.description,
    capabilities,
    queryFormats,
    supportsExport: service.kind === "MapServer" && hasCapability(capabilities, "map"),
    maxRecordCount: Number(metadata.maxRecordCount ?? first?.maxRecordCount ?? 1e3),
    singleLayer: false,
    sublayers,
    zoom
  };
}
async function readLayerMetadata(http, service, fallback) {
  try {
    return await http.json(`${service.base}/${service.layerId}`, { f: "json" });
  } catch {
    return fallback;
  }
}
function toSublayer(layer, context) {
  const minScale = Number(layer.minScale ?? 0);
  const maxScale = Number(layer.maxScale ?? 0);
  const formats = context.queryFormats;
  const supportsPbf = formats.includes("pbf") ? true : context.kind === "FeatureServer" && context.version >= PBF_MIN_VERSION ? "unknown" : false;
  const supportsGeoJson = formats.length === 0 ? "unknown" : formats.includes("geojson");
  const supportsPagination = layer.supportsAdvancedQueries !== false && layer.advancedQueryCapabilities?.supportsPagination !== false;
  return {
    id: layer.id ?? 0,
    name: layer.name ?? "Layer",
    geometryType: layer.geometryType ?? null,
    objectIdField: layer.objectIdField ?? "objectid",
    minScale,
    maxScale,
    maxRecordCount: Number(layer.maxRecordCount ?? context.maxRecordCount ?? 1e3),
    renderer: layer.renderer ?? null,
    fields: layer.fields ?? [],
    supportsQuery: layer.supportsAdvancedQueries !== false,
    supportsPbf,
    supportsGeoJson,
    supportsPagination,
    zoom: zoomRangeFromScales(minScale, maxScale)
  };
}
function isGroupLayer(layer) {
  return layer.type === "Group Layer" || Array.isArray(layer.subLayerIds) && layer.subLayerIds.length > 0;
}
function unionZoom(sublayers) {
  if (sublayers.length === 0) return { minZoom: 0, maxZoom: 22 };
  let minZoom = Infinity;
  let maxZoom = -Infinity;
  for (const sublayer of sublayers) {
    minZoom = Math.min(minZoom, sublayer.zoom.minZoom);
    maxZoom = Math.max(maxZoom, sublayer.zoom.maxZoom);
  }
  return { minZoom: Number.isFinite(minZoom) ? minZoom : 0, maxZoom: Number.isFinite(maxZoom) ? maxZoom : 22 };
}
function splitFormats(value) {
  if (!value) return [];
  return value.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
}
function splitCapabilities(value) {
  return value.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
}
function hasCapability(capabilities, name) {
  return capabilities.includes(name);
}
async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (; ; ) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

// src/util/mercator.ts
var EARTH_RADIUS = 6378137;
var WORLD_METERS = 2 * Math.PI * EARTH_RADIUS;
var HALF_WORLD = WORLD_METERS / 2;
var MAX_LATITUDE = 85.0511287798066;
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
function clampLatitude(lat) {
  return clamp(lat, -MAX_LATITUDE, MAX_LATITUDE);
}
function normalizeLng(lng) {
  let value = ((lng + 180) % 360 + 360) % 360 - 180;
  if (Object.is(value, -0)) value = 0;
  return value;
}
function metersToLng(x) {
  return x / HALF_WORLD * 180;
}
function metersToLat(y) {
  return (2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2) * (180 / Math.PI);
}
function lngLatToWorld(lng, lat) {
  const sin = Math.sin(clampLatitude(lat) * Math.PI / 180);
  return {
    x: (lng + 180) / 360,
    y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)
  };
}
function worldToLngLat(x, y) {
  const n = Math.PI - 2 * Math.PI * y;
  return {
    lng: x * 360 - 180,
    lat: 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
  };
}
function tileToLngLat(x, y, z) {
  const n = 2 ** z;
  return worldToLngLat(x / n, y / n);
}
function worldSize(zoom) {
  return 256 * 2 ** zoom;
}
function metersToBbox(box) {
  const [xmin, ymin, xmax, ymax] = box;
  return [metersToLng(xmin), metersToLat(ymin), metersToLng(xmax), metersToLat(ymax)];
}
function splitBBox(bbox) {
  const [west, south, east, north] = bbox;
  const span = east - west;
  if (!Number.isFinite(span) || span <= 0) return [[west, south, Math.max(west, east), north]];
  if (span >= 360) return [[-180, south, 180, north]];
  const start = normalizeLng(west);
  const end = start + span;
  if (end <= 180) return [[start, south, end, north]];
  return [
    [start, south, 180, north],
    [-180, south, end - 360, north]
  ];
}
function clampBBoxLatitude(bbox) {
  return [bbox[0], clampLatitude(bbox[1]), bbox[2], clampLatitude(bbox[3])];
}
function degreesPerPixel(zoom) {
  return 360 / worldSize(zoom);
}

// src/mvt/service.ts
async function discoverVectorTileService(service, http, options = {}) {
  const metadata = await http.json(service.base, { f: "json" });
  const levels = (metadata.tileInfo?.lods ?? []).map((lod) => Number(lod.level)).filter((level) => Number.isFinite(level));
  const minZoom = levels.length > 0 ? Math.min(...levels) : 0;
  const maxZoom = levels.length > 0 ? Math.max(...levels) : 19;
  const tileTemplate = metadata.tiles?.[0] ?? "tile/{z}/{y}/{x}.pbf";
  const styleUrl = options.styleUrl ?? `${service.base}/resources/styles/root.json`;
  let styleLayers = [];
  try {
    styleLayers = parseStyleLayers(await http.json(styleUrl));
  } catch {
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
    styleUrl
  };
}
function parseStyleLayers(style) {
  const result = [];
  for (const layer of style.layers ?? []) {
    const type = layer.type === "fill" ? "fill" : layer.type === "line" ? "line" : null;
    if (!type) continue;
    const paint = layer.paint ?? {};
    const sourceLayer = typeof layer["source-layer"] === "string" ? layer["source-layer"] : String(layer.id ?? "");
    if (!sourceLayer) continue;
    result.push({
      id: String(layer.id ?? sourceLayer),
      sourceLayer,
      type,
      fillColor: color(paint["fill-color"]),
      fillOpacity: number(paint["fill-opacity"]),
      // Fill layers carry their border in fill-outline-*.
      lineColor: color(type === "fill" ? paint["fill-outline-color"] : paint["line-color"]),
      lineWidth: number(type === "fill" ? paint["fill-outline-width"] : paint["line-width"]) ?? (type === "fill" ? 1 : void 0),
      lineOpacity: number(paint["line-opacity"]),
      minZoom: number(layer.minzoom),
      maxZoom: number(layer.maxzoom)
    });
  }
  return result;
}
function parseExtent(extent) {
  if (!extent) return void 0;
  const { xmin, ymin, xmax, ymax } = extent;
  if (![xmin, ymin, xmax, ymax].every((value) => typeof value === "number")) return void 0;
  const wkid = extent.spatialReference?.latestWkid ?? extent.spatialReference?.wkid;
  if (wkid === 4326) return [xmin, ymin, xmax, ymax];
  return metersToBbox([xmin, ymin, xmax, ymax]);
}
function color(value) {
  return typeof value === "string" && value.trim() !== "" ? value : void 0;
}
function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}

// src/renderers/export-renderer.ts
var MAX_WORLD_SPAN = HALF_WORLD * 2;
var EXPORT_MARGIN = 0.15;
function needsExportRefresh(current, view, padding) {
  if (!current) return true;
  if (current.zoom !== view.zoom) return true;
  const required = padMeters(view.bounds3857, padding * EXPORT_MARGIN);
  return !containsMeters(current.bbox, required);
}
var ExportRenderer = class {
  constructor(options) {
    __publicField(this, "options", options);
    __publicField(this, "mode", "export");
    __publicField(this, "overlay");
    __publicField(this, "timeoutMs");
    __publicField(this, "current", null);
    __publicField(this, "pending", null);
    __publicField(this, "generation", 0);
    __publicField(this, "controller", null);
    __publicField(this, "attached", false);
    __publicField(this, "opacity");
    __publicField(this, "loading", false);
    this.opacity = options.opacity;
    this.timeoutMs = options.exportTimeout;
    this.overlay = new ImageOverlay(options.google, options.map, options.opacity, this.timeoutMs);
  }
  attach() {
    if (this.attached) return;
    this.overlay.setMap(this.options.map);
    this.attached = true;
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      void this.overlay.show(pending.source, pending.bbox, 0, true, pending.revoke).then((visible) => {
        if (visible) this.current = { bbox: pending.bbox, zoom: pending.zoom };
      });
    }
  }
  detach() {
    if (!this.attached) return;
    this.overlay.setMap(null);
    this.attached = false;
  }
  update(view) {
    if (!this.attached) return;
    if (!needsExportRefresh(this.current, view, this.options.padding)) return;
    void this.load(view, true);
  }
  prefetch(view) {
    if (!needsExportRefresh(this.current, view, this.options.padding)) return;
    if (this.pending) return;
    void this.load(view, false);
  }
  setOpacity(opacity) {
    this.opacity = opacity;
    this.overlay.setOpacity(opacity);
  }
  refresh() {
    this.current = null;
  }
  destroy() {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    this.overlay.destroy();
    if (this.pending?.revoke) URL.revokeObjectURL(this.pending.source);
    this.pending = null;
    this.current = null;
  }
  setLoading(loading) {
    if (this.loading === loading) return;
    this.loading = loading;
    this.options.onLoading(loading);
  }
  async load(view, show) {
    const generation = ++this.generation;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.setLoading(true);
    const request = this.buildRequest(view);
    const attempts = this.options.exportTransport === "image" ? 2 : 1;
    try {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          const source = await this.fetchImage(request, controller.signal);
          if (generation !== this.generation) {
            if (source.revoke) URL.revokeObjectURL(source.source);
            return;
          }
          if (!show) {
            if (this.pending?.revoke) URL.revokeObjectURL(this.pending.source);
            this.pending = { source: source.source, revoke: source.revoke, bbox: request.bbox, zoom: view.zoom };
            return;
          }
          const visible = await this.overlay.show(
            source.source,
            request.bbox,
            this.options.fadeDuration,
            this.options.reducedMotion,
            source.revoke
          );
          if (generation !== this.generation || !visible) return;
          if (this.pending?.revoke) URL.revokeObjectURL(this.pending.source);
          this.pending = null;
          this.current = { bbox: request.bbox, zoom: view.zoom };
          return;
        } catch (error) {
          const retryable = !isAbortError(error) && attempt + 1 < attempts;
          if (!retryable) throw error;
        }
      }
    } catch (error) {
      if (!isAbortError(error)) this.options.onError(toError(error));
    } finally {
      if (generation === this.generation) this.setLoading(false);
    }
  }
  async fetchImage(request, signal) {
    if (this.options.exportTransport === "fetch") {
      const response = await this.options.http.request(request.url, request.params, { signal });
      const blob = await response.blob();
      return { source: URL.createObjectURL(blob), revoke: true };
    }
    const url = await this.options.http.url(request.url, request.params);
    return { source: url, revoke: false };
  }
  buildRequest(view) {
    const { padding, maxImageSize, service, layer } = this.options;
    const padded = padMeters(view.bounds3857, padding);
    const clamped = clampMeters(padded);
    const cssWidth = view.width * (1 + padding * 2);
    const cssHeight = view.height * (1 + padding * 2);
    const scale = Math.min(1, maxImageSize / Math.max(cssWidth * view.dpr, cssHeight * view.dpr));
    const width = Math.max(1, Math.round(cssWidth * view.dpr * scale));
    const height = Math.max(1, Math.round(cssHeight * view.dpr * scale));
    const url = service.singleLayer && layer.service.layerId !== null ? `${service.url}/${layer.service.layerId}/export` : `${service.url}/export`;
    const params = {
      bbox: clamped.map((value) => value.toFixed(2)).join(","),
      bboxSR: "3857",
      imageSR: "3857",
      size: `${width},${height}`,
      format: "png32",
      transparent: "true",
      dpi: "96",
      f: "image"
    };
    if (!service.singleLayer) {
      const ids = layer.sublayers ?? service.sublayers.map((sublayer) => sublayer.id);
      if (ids.length > 0) params.layers = `show:${ids.join(",")}`;
    }
    return { url, params, bbox: clamped };
  }
};
function padMeters(bounds, padding) {
  const [xmin, ymin, xmax, ymax] = bounds;
  const dx = (xmax - xmin) * padding;
  const dy = (ymax - ymin) * padding;
  return [xmin - dx, ymin - dy, xmax + dx, ymax + dy];
}
function containsMeters(outer, inner) {
  return outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
}
function clampMeters(bounds) {
  const [xmin, ymin, xmax, ymax] = bounds;
  const x0 = Math.max(-HALF_WORLD, xmin);
  const x1 = Math.min(HALF_WORLD, xmax);
  if (x1 - x0 > MAX_WORLD_SPAN) return [-HALF_WORLD, -HALF_WORLD, HALF_WORLD, HALF_WORLD];
  return [x0, Math.max(-HALF_WORLD, ymin), x1, Math.min(HALF_WORLD, ymax)];
}
function toError(error) {
  return error instanceof Error ? error : new Error(String(error));
}
var ImageOverlay = class {
  constructor(googleApi, map, opacity, timeoutMs) {
    __publicField(this, "googleApi", googleApi);
    __publicField(this, "overlay");
    __publicField(this, "container", null);
    __publicField(this, "entries", []);
    __publicField(this, "opacity");
    __publicField(this, "timeoutMs");
    this.opacity = opacity;
    this.timeoutMs = timeoutMs;
    const overlay = new googleApi.maps.OverlayView();
    overlay.onAdd = () => this.onAdd();
    overlay.draw = () => this.draw();
    overlay.onRemove = () => this.onRemove();
    this.overlay = overlay;
    this.overlay.setMap(map);
  }
  setMap(map) {
    this.overlay.setMap(map);
  }
  setOpacity(opacity) {
    this.opacity = opacity;
    if (this.container) this.container.style.opacity = String(opacity);
  }
  async show(source, bbox, fadeMs, reducedMotion, revoke) {
    const image = new Image();
    image.alt = "";
    image.decoding = "async";
    image.style.position = "absolute";
    image.style.opacity = "0";
    image.style.transition = `opacity ${Math.max(fadeMs, 0)}ms linear`;
    image.style.willChange = "opacity";
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("Exported map image timed out"));
        }, this.timeoutMs);
        const cleanup = () => {
          clearTimeout(timer);
          image.onload = null;
          image.onerror = null;
        };
        image.onload = () => {
          cleanup();
          resolve();
        };
        image.onerror = () => {
          cleanup();
          reject(new Error("Exported map image failed to load"));
        };
        image.src = source;
      });
    } catch (error) {
      if (revoke) URL.revokeObjectURL(source);
      throw error;
    }
    if (!this.container) {
      if (revoke) URL.revokeObjectURL(source);
      return false;
    }
    const entry = { element: image, bbox, source, revoke };
    this.entries.push(entry);
    this.container.appendChild(image);
    this.draw();
    if (!reducedMotion) {
      image.getBoundingClientRect();
      requestAnimationFrame(() => {
        image.style.opacity = "1";
      });
    } else {
      image.style.opacity = "1";
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
  destroy() {
    this.overlay.setMap(null);
    for (const entry of this.entries) this.removeEntry(entry);
    this.entries = [];
    this.container?.remove();
    this.container = null;
  }
  removeEntry(entry) {
    entry.element.remove();
    if (entry.revoke) URL.revokeObjectURL(entry.source);
  }
  onAdd() {
    const panes = this.overlay.getPanes();
    if (!panes) return;
    const container = document.createElement("div");
    container.style.position = "absolute";
    container.style.left = "0";
    container.style.top = "0";
    container.style.width = "0";
    container.style.height = "0";
    container.style.opacity = String(this.opacity);
    container.style.pointerEvents = "none";
    container.dataset.nullisland = "export";
    for (const entry of this.entries) container.appendChild(entry.element);
    panes.overlayLayer.appendChild(container);
    this.container = container;
    this.draw();
  }
  onRemove() {
    this.container?.remove();
    this.container = null;
  }
  draw() {
    if (!this.container || this.entries.length === 0) return;
    const projection = this.overlay.getProjection();
    if (!projection) return;
    for (const { element, bbox } of this.entries) {
      const [west, south, east, north] = bbox;
      const northWest = projection.fromLatLngToDivPixel({ lat: north, lng: west });
      const southEast = projection.fromLatLngToDivPixel({ lat: south, lng: east });
      if (!northWest || !southEast) continue;
      const width = Math.max(0, southEast.x - northWest.x);
      const height = Math.max(0, southEast.y - northWest.y);
      element.style.left = `${northWest.x}px`;
      element.style.top = `${northWest.y}px`;
      element.style.width = `${width}px`;
      element.style.height = `${height}px`;
    }
  }
};

// src/pbf/reader.ts
var WIRE_VARINT = 0;
var WIRE_FIXED64 = 1;
var WIRE_LENGTH_DELIMITED = 2;
var WIRE_FIXED32 = 5;
var textDecoder = new TextDecoder("utf-8");
var PbfReader = class _PbfReader {
  constructor(input) {
    __publicField(this, "buffer");
    __publicField(this, "view");
    __publicField(this, "offset", 0);
    if (input instanceof Uint8Array) {
      this.buffer = input;
      this.view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    } else {
      this.buffer = new Uint8Array(input);
      this.view = new DataView(input);
    }
  }
  get eof() {
    return this.offset >= this.buffer.length;
  }
  get position() {
    return this.offset;
  }
  readTag() {
    const tag = this.readVarintNumber();
    return { field: tag >>> 3, wire: tag & 7 };
  }
  readVarint() {
    let result = 0n;
    let shift = 0n;
    for (; ; ) {
      if (this.offset >= this.buffer.length) {
        throw new NullIslandError("Unexpected end of PBF buffer", "NULLISLAND_PBF_TRUNCATED");
      }
      const byte = this.buffer[this.offset++];
      result |= BigInt(byte & 127) << shift;
      if ((byte & 128) === 0) return result;
      shift += 7n;
      if (shift > 70n) {
        throw new NullIslandError("Malformed varint in PBF buffer", "NULLISLAND_PBF_INVALID");
      }
    }
  }
  readVarintNumber() {
    return Number(this.readVarint());
  }
  readUint32() {
    return this.readVarintNumber();
  }
  readSint32() {
    return zigZag(this.readVarint());
  }
  readSint64() {
    return zigZag(this.readVarint());
  }
  readInt64() {
    const value = this.readVarint();
    return value >= 2n ** 63n ? Number(value - 2n ** 64n) : Number(value);
  }
  readUint64() {
    return Number(this.readVarint());
  }
  readBool() {
    return this.readVarintNumber() !== 0;
  }
  readFloat() {
    const value = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return value;
  }
  readDouble() {
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }
  readString() {
    return textDecoder.decode(this.readBytes());
  }
  readBytes() {
    const length = this.readVarintNumber();
    const start = this.offset;
    const end = start + length;
    if (end > this.buffer.length) {
      throw new NullIslandError("PBF length-delimited field overruns buffer", "NULLISLAND_PBF_TRUNCATED");
    }
    this.offset = end;
    return this.buffer.subarray(start, end);
  }
  /** Read a length-delimited message as a nested reader. */
  readMessage() {
    return new _PbfReader(this.readBytes());
  }
  /** Packed `uint32` values. */
  readPackedUint32() {
    const reader = this.readMessage();
    const values = [];
    while (!reader.eof) values.push(reader.readVarintNumber());
    return values;
  }
  /** Packed `sint64` values (zig-zag decoded). */
  readPackedSint64() {
    const reader = this.readMessage();
    const values = [];
    while (!reader.eof) values.push(reader.readSint64());
    return values;
  }
  /** Packed `sint32` values (zig-zag decoded). */
  readPackedSint32() {
    const reader = this.readMessage();
    const values = [];
    while (!reader.eof) values.push(reader.readSint32());
    return values;
  }
  skip(wire) {
    switch (wire) {
      case WIRE_VARINT:
        this.readVarint();
        return;
      case WIRE_FIXED64:
        this.offset += 8;
        return;
      case WIRE_LENGTH_DELIMITED: {
        const length = this.readVarintNumber();
        this.offset += length;
        if (this.offset > this.buffer.length) {
          throw new NullIslandError("PBF field overruns buffer", "NULLISLAND_PBF_TRUNCATED");
        }
        return;
      }
      case WIRE_FIXED32:
        this.offset += 4;
        return;
      default:
        throw new NullIslandError(`Unsupported PBF wire type ${wire}`, "NULLISLAND_PBF_INVALID");
    }
  }
};
function zigZag(value) {
  return Number(value >> 1n ^ -(value & 1n));
}

// src/pbf/decode.ts
var GEOMETRY_TYPES = [
  "point",
  "multipoint",
  "polyline",
  "polygon",
  "multipatch",
  "envelope"
];
var GEOMETRY_TYPE_VALUES = {
  point: 0,
  multipoint: 1,
  polyline: 2,
  polygon: 3,
  multipatch: 4,
  envelope: 5,
  none: 127
};
var FIELD_TYPES = [
  "smallInteger",
  "integer",
  "single",
  "double",
  "string",
  "date",
  "oid",
  "geometry",
  "blob",
  "raster",
  "guid",
  "globalId",
  "xml",
  "bigInteger",
  "dateOnly",
  "timeOnly",
  "timestampOffset"
];
var NotPbfError = class extends NullIslandError {
  constructor(message = "Response was not a PBF FeatureCollection") {
    super(message, "NULLISLAND_NOT_PBF");
    this.name = "NotPbfError";
  }
};
function decodeFeatureCollection(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length === 0) throw new NotPbfError("Empty PBF payload");
  if (bytes[0] === 123) throw new NotPbfError();
  const reader = new PbfReader(bytes);
  let queryResult = null;
  while (!reader.eof) {
    const { field, wire } = reader.readTag();
    if (field === 2 && wire === WIRE_LENGTH_DELIMITED) {
      queryResult = reader.readMessage();
    } else {
      reader.skip(wire);
    }
  }
  if (!queryResult) throw new NotPbfError("PBF payload has no query result");
  while (!queryResult.eof) {
    const { field, wire } = queryResult.readTag();
    if (field === 1 && wire === WIRE_LENGTH_DELIMITED) {
      return decodeFeatureResult(queryResult.readMessage());
    }
    queryResult.skip(wire);
  }
  throw new NotPbfError("PBF payload contains no feature result");
}
function decodeFeatureResult(reader) {
  let objectIdField = "objectid";
  let geometryType = "point";
  let exceededTransferLimit = false;
  let hasZ = false;
  let hasM = false;
  let transform = null;
  const fields = [];
  const featureBuffers = [];
  while (!reader.eof) {
    const { field, wire } = reader.readTag();
    switch (field) {
      case 1:
        objectIdField = reader.readString();
        break;
      case 7:
        geometryType = GEOMETRY_TYPES[reader.readVarintNumber()] ?? "none";
        break;
      case 9:
        exceededTransferLimit = reader.readBool();
        break;
      case 10:
        hasZ = reader.readBool();
        break;
      case 11:
        hasM = reader.readBool();
        break;
      case 12:
        transform = decodeTransform(reader.readMessage());
        break;
      case 13:
        fields.push(decodeField(reader.readMessage()));
        break;
      case 15:
        featureBuffers.push(reader.readBytes());
        break;
      default:
        reader.skip(wire);
    }
  }
  const stride = 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0);
  const fallbackType = GEOMETRY_TYPE_VALUES[geometryType];
  const features = featureBuffers.map(
    (buffer) => decodeFeature(new PbfReader(buffer), fields, transform, stride, fallbackType)
  );
  return {
    objectIdField,
    geometryType,
    exceededTransferLimit,
    hasZ,
    hasM,
    transform,
    fields,
    features
  };
}
function decodeField(reader) {
  let name = "";
  let type = "unknown";
  let alias;
  while (!reader.eof) {
    const { field, wire } = reader.readTag();
    switch (field) {
      case 1:
        name = reader.readString();
        break;
      case 2:
        type = FIELD_TYPES[reader.readVarintNumber()] ?? "unknown";
        break;
      case 3:
        alias = reader.readString();
        break;
      default:
        reader.skip(wire);
    }
  }
  return alias === void 0 ? { name, type } : { name, type, alias };
}
function decodeTransform(reader) {
  const transform = {
    // Proto3 default is 0 = upperLeft, and the field is usually omitted.
    origin: "upperLeft",
    scaleX: 1,
    scaleY: 1,
    translateX: 0,
    translateY: 0
  };
  while (!reader.eof) {
    const { field, wire } = reader.readTag();
    if (field === 1) {
      transform.origin = reader.readVarintNumber() === 0 ? "upperLeft" : "lowerLeft";
      continue;
    }
    if (field === 2 && wire === WIRE_LENGTH_DELIMITED) {
      const scale = reader.readMessage();
      while (!scale.eof) {
        const tag = scale.readTag();
        if (tag.field === 1) transform.scaleX = scale.readDouble();
        else if (tag.field === 2) transform.scaleY = scale.readDouble();
        else scale.skip(tag.wire);
      }
      continue;
    }
    if (field === 3 && wire === WIRE_LENGTH_DELIMITED) {
      const translate = reader.readMessage();
      while (!translate.eof) {
        const tag = translate.readTag();
        if (tag.field === 1) transform.translateX = translate.readDouble();
        else if (tag.field === 2) transform.translateY = translate.readDouble();
        else translate.skip(tag.wire);
      }
      continue;
    }
    reader.skip(wire);
  }
  if (!Number.isFinite(transform.scaleX) || transform.scaleX === 0) transform.scaleX = 1;
  if (!Number.isFinite(transform.scaleY) || transform.scaleY === 0) transform.scaleY = 1;
  return transform;
}
function decodeFeature(reader, fields, transform, stride, fallbackGeometryType) {
  const attributes = {};
  let attributeIndex = 0;
  let geometry = { type: "none" };
  while (!reader.eof) {
    const { field, wire } = reader.readTag();
    switch (field) {
      case 1: {
        const value = decodeValue(reader.readMessage());
        const name = fields[attributeIndex]?.name;
        if (name) attributes[name] = value;
        attributeIndex += 1;
        break;
      }
      case 2:
        geometry = decodeGeometry(reader.readMessage(), transform, stride, fallbackGeometryType);
        break;
      default:
        reader.skip(wire);
    }
  }
  return { attributes, geometry };
}
function decodeValue(reader) {
  let value = null;
  while (!reader.eof) {
    const { field, wire } = reader.readTag();
    switch (field) {
      case 1:
        if (wire === WIRE_LENGTH_DELIMITED) value = reader.readString();
        else reader.skip(wire);
        break;
      case 2:
        if (wire === 5) value = reader.readFloat();
        else reader.skip(wire);
        break;
      case 3:
        if (wire === 1) value = reader.readDouble();
        else reader.skip(wire);
        break;
      case 4:
      case 5:
      case 6:
      case 7:
      case 8:
      case 9:
        if (wire === WIRE_VARINT) value = readScalarValue(field, reader);
        else reader.skip(wire);
        break;
      case 10:
        value = null;
        if (wire === WIRE_VARINT) reader.readVarint();
        else reader.skip(wire);
        break;
      default:
        reader.skip(wire);
    }
  }
  return value;
}
function readScalarValue(field, reader) {
  switch (field) {
    case 4:
      return reader.readSint32();
    case 5:
      return reader.readUint32();
    case 6:
      return reader.readInt64();
    case 7:
      return reader.readUint64();
    case 8:
      return reader.readSint64();
    case 9:
      return reader.readBool();
    default:
      return null;
  }
}
function decodeGeometry(reader, transform, stride, fallbackGeometryType) {
  let geometryType = fallbackGeometryType;
  let lengths = [];
  let coords = [];
  while (!reader.eof) {
    const { field, wire } = reader.readTag();
    switch (field) {
      case 1:
        geometryType = reader.readVarintNumber();
        break;
      case 2:
        if (wire === WIRE_LENGTH_DELIMITED) lengths = reader.readPackedUint32();
        else lengths = [reader.readVarintNumber()];
        break;
      case 3:
        if (wire === WIRE_LENGTH_DELIMITED) coords = reader.readPackedSint64();
        else coords = [reader.readSint64()];
        break;
      default:
        reader.skip(wire);
    }
  }
  const parts = decodeParts(coords, lengths, stride, transform);
  switch (geometryType) {
    case 0: {
      const point = parts[0]?.[0];
      return point ? { type: "point", coordinates: point } : { type: "none" };
    }
    case 1:
      return { type: "multipoint", coordinates: parts.flat() };
    case 2:
      return { type: "polyline", paths: parts };
    case 3:
      return { type: "polygon", rings: parts.map(closeRing) };
    default:
      return { type: "none" };
  }
}
function decodeParts(coords, lengths, stride, transform = null) {
  const counts = lengths.length > 0 ? lengths : [Math.floor(coords.length / Math.max(stride, 2))];
  const parts = [];
  let cursor = 0;
  for (const count of counts) {
    let x = 0;
    let y = 0;
    const part = [];
    for (let vertex = 0; vertex < count; vertex += 1) {
      x += coords[cursor++] ?? 0;
      y += coords[cursor++] ?? 0;
      for (let extra = 2; extra < stride; extra += 1) cursor += 1;
      part.push(applyTransform(x, y, transform));
    }
    if (part.length > 0) parts.push(part);
  }
  return parts;
}
function applyTransform(x, y, transform) {
  if (!transform) return [x, y];
  const px = transform.translateX + x * transform.scaleX;
  const py = transform.origin === "upperLeft" ? transform.translateY - y * transform.scaleY : transform.translateY + y * transform.scaleY;
  return [px, py];
}
function closeRing(ring) {
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (!first || !last) return ring;
  if (first[0] !== last[0] || first[1] !== last[1]) return [...ring, first];
  return ring;
}
function signedArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return sum / 2;
}
function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects2 = yi > point[1] !== yj > point[1] && point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi;
    if (intersects2) inside = !inside;
  }
  return inside;
}
function groupRings(rings) {
  const closed = rings.map(closeRing).filter((ring) => ring.length >= 4);
  if (closed.length === 0) return [];
  const areas = closed.map((ring) => signedArea(ring));
  const hasClockwise = areas.some((area) => area < 0);
  if (!hasClockwise) {
    const outer = closed[0];
    const polygons2 = [[outer]];
    for (let i = 1; i < closed.length; i += 1) {
      const ring = closed[i];
      const target = polygons2.find((polygon) => pointInRing(ring[0], polygon[0]));
      if (target) target.push(ring);
      else polygons2.push([ring]);
    }
    return polygons2;
  }
  const polygons = [];
  const holes = [];
  closed.forEach((ring, index) => {
    if ((areas[index] ?? 0) <= 0) polygons.push([ring]);
    else holes.push(ring);
  });
  for (const hole of holes) {
    const target = polygons.find((polygon) => pointInRing(hole[0], polygon[0]));
    if (target) target.push(hole);
    else if (polygons[0]) polygons[0].push(hole);
  }
  return polygons;
}

// src/style/translate.ts
var DEFAULT_COLOR = [0, 102, 255, 255];
function createStyleResolver(context) {
  if (context.color) {
    const style = styleForColor(context.color, context.opacity, context.geometryType, context.google);
    return () => style;
  }
  const renderer = context.renderer;
  if (!renderer) {
    const style = styleForColor(DEFAULT_COLOR, context.opacity, context.geometryType, context.google);
    return () => style;
  }
  const defaultSymbol = renderer.symbol ?? renderer.defaultSymbol ?? null;
  const fallback = symbolToStyle(defaultSymbol, context);
  if (renderer.type === "uniqueValue" && Array.isArray(renderer.uniqueValueInfos)) {
    const styles = /* @__PURE__ */ new Map();
    for (const info of renderer.uniqueValueInfos) {
      if (info.value === void 0) continue;
      styles.set(String(info.value), symbolToStyle(info.symbol ?? defaultSymbol, context));
    }
    const field = renderer.field1;
    if (field) {
      return (feature) => styles.get(String(feature.getProperty(field))) ?? fallback;
    }
  }
  if (renderer.type === "classBreaks" && Array.isArray(renderer.classBreakInfos)) {
    const breaks = renderer.classBreakInfos.filter((info) => typeof info.classMinValue === "number").map((info) => ({
      min: info.classMinValue,
      max: typeof info.classMaxValue === "number" ? info.classMaxValue : Number.POSITIVE_INFINITY,
      style: symbolToStyle(info.symbol ?? defaultSymbol, context)
    }));
    const field = renderer.field1;
    if (field && breaks.length > 0) {
      return (feature) => {
        const value = Number(feature.getProperty(field));
        if (!Number.isFinite(value)) return fallback;
        const match = breaks.find((entry) => value >= entry.min && value <= entry.max);
        return match?.style ?? fallback;
      };
    }
  }
  return () => fallback;
}
function symbolToStyle(symbol, context) {
  if (!symbol) {
    return styleForColor(DEFAULT_COLOR, context.opacity, context.geometryType, context.google);
  }
  const fill = colorToRgba(symbol.color, DEFAULT_COLOR);
  const outline = symbol.outline;
  const stroke = colorToRgba(outline?.color, [0, 0, 0, 255]);
  const isPoint = symbol.type === "esriSMS" || context.geometryType === "esriGeometryPoint" || context.geometryType === "esriGeometryMultipoint";
  if (isPoint) {
    const size = clampNumber(symbol.size ?? 8, 4, 48);
    return {
      ...pointIcon(context.google, applyOpacity(fill, context.opacity), size, outline?.width ?? 1),
      fillColor: rgbaToCss(applyOpacity(fill, context.opacity)),
      fillOpacity: 1,
      strokeColor: rgbaToCss(applyOpacity(stroke, context.opacity)),
      strokeWeight: outline?.width ?? 1
    };
  }
  if (context.geometryType === "esriGeometryPolyline" || symbol.type === "esriSLS") {
    return {
      strokeColor: rgbaToCss(applyOpacity(fill, context.opacity)),
      strokeOpacity: 1,
      strokeWeight: clampNumber(symbol.width ?? 1.5, 0.5, 20),
      fillOpacity: 0
    };
  }
  return {
    fillColor: rgbaToCss(applyOpacity(fill, context.opacity)),
    fillOpacity: 1,
    strokeColor: rgbaToCss(applyOpacity(stroke, context.opacity)),
    strokeOpacity: 1,
    strokeWeight: clampNumber(outline?.width ?? 1, 0, 10)
  };
}
function styleForColor(color2, opacity, geometryType, googleApi) {
  const fill = applyOpacity(color2, opacity);
  if (geometryType === "esriGeometryPolyline") {
    return { strokeColor: rgbaToCss(fill), strokeOpacity: 1, strokeWeight: 2, fillOpacity: 0 };
  }
  if (geometryType === "esriGeometryPoint" || geometryType === "esriGeometryMultipoint") {
    return {
      ...pointIcon(googleApi, fill, 8, 1),
      fillColor: rgbaToCss(fill),
      strokeColor: rgbaToCss(applyOpacity([0, 0, 0, 255], opacity)),
      strokeWeight: 1
    };
  }
  return {
    fillColor: rgbaToCss(fill),
    fillOpacity: 1,
    strokeColor: rgbaToCss(applyOpacity(darken(color2), opacity)),
    strokeOpacity: 1,
    strokeWeight: 1
  };
}
function pointIcon(googleApi, fill, size, strokeWidth) {
  if (!googleApi?.maps?.Size || !googleApi.maps.Point) return {};
  const radius = size / 2 - strokeWidth / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${Math.max(radius, 1)}" fill="${rgbaToCss(fill)}" stroke="rgba(0,0,0,0.55)" stroke-width="${strokeWidth}"/></svg>`;
  return {
    icon: {
      url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
      scaledSize: new googleApi.maps.Size(size, size),
      anchor: new googleApi.maps.Point(size / 2, size / 2)
    }
  };
}
function colorToRgba(color2, fallback) {
  if (!Array.isArray(color2) || color2.length < 3) return fallback;
  const [r = fallback[0], g = fallback[1], b = fallback[2], a = 255] = color2;
  return [clampChannel(r), clampChannel(g), clampChannel(b), clampChannel(a)];
}
function clampChannel(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}
function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
function darken([r, g, b, a]) {
  return [Math.round(r * 0.6), Math.round(g * 0.6), Math.round(b * 0.6), a];
}

// src/util/lru.ts
var LRU = class {
  constructor(capacity) {
    __publicField(this, "capacity", capacity);
    __publicField(this, "entries", /* @__PURE__ */ new Map());
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("LRU capacity must be a positive integer");
    }
  }
  get size() {
    return this.entries.size;
  }
  has(key) {
    return this.entries.has(key);
  }
  get(key) {
    if (!this.entries.has(key)) return void 0;
    const value = this.entries.get(key);
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }
  set(key, value) {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, value);
  }
  delete(key) {
    return this.entries.delete(key);
  }
  clear() {
    this.entries.clear();
  }
  keys() {
    return [...this.entries.keys()];
  }
};

// src/util/tiles.ts
var MAX_TILE_ZOOM = 20;
function tileX(lng, z) {
  return (lng + 180) / 360 * 2 ** z;
}
function tileY(lat, z) {
  return lngLatToWorld(0, lat).y * 2 ** z;
}
function tileToBBox(z, x, y) {
  const northWest = tileToLngLat(x, y, z);
  const southEast = tileToLngLat(x + 1, y + 1, z);
  return [northWest.lng, southEast.lat, southEast.lng, northWest.lat];
}
function snapBBox(bbox, zoom, snapDelta = 1) {
  const z = clamp(Math.floor(zoom) - snapDelta, 0, MAX_TILE_ZOOM);
  const maxIndex = 2 ** z - 1;
  const areas = splitBBox(bbox).map((part) => {
    const [west, south, east, north] = part;
    const x0 = clamp(Math.floor(tileX(west, z)), 0, maxIndex);
    const x1 = clamp(Math.ceil(tileX(east, z)) - 1, 0, maxIndex);
    const y0 = clamp(Math.floor(tileY(north, z)), 0, maxIndex);
    const y1 = clamp(Math.ceil(tileY(south, z)) - 1, 0, maxIndex);
    const northWest = tileToLngLat(x0, y0, z);
    const southEast = tileToLngLat(x1 + 1, y1 + 1, z);
    return {
      bbox: [northWest.lng, southEast.lat, southEast.lng, northWest.lat],
      key: `${z}/${x0}/${y0}/${x1}/${y1}`,
      z
    };
  });
  const seen = /* @__PURE__ */ new Set();
  return areas.filter((area) => {
    if (seen.has(area.key)) return false;
    seen.add(area.key);
    return true;
  });
}

// src/renderers/vector-renderer.ts
function esriJsonGeometryToPbf(geometry) {
  if (!geometry) return { type: "none" };
  if (typeof geometry.x === "number" && typeof geometry.y === "number") {
    return { type: "point", coordinates: [geometry.x, geometry.y] };
  }
  if (Array.isArray(geometry.points)) return { type: "multipoint", coordinates: geometry.points };
  if (Array.isArray(geometry.paths)) return { type: "polyline", paths: geometry.paths };
  if (Array.isArray(geometry.rings)) {
    return {
      type: "polygon",
      rings: geometry.rings.map((ring) => {
        const first = ring[0];
        const last = ring[ring.length - 1];
        return first && last && (first[0] !== last[0] || first[1] !== last[1]) ? [...ring, first] : ring;
      })
    };
  }
  return { type: "none" };
}
var VectorRenderer = class {
  constructor(options) {
    __publicField(this, "options", options);
    __publicField(this, "mode", "vector");
    __publicField(this, "data");
    __publicField(this, "cache");
    __publicField(this, "resolvers", /* @__PURE__ */ new Map());
    __publicField(this, "featureSublayer", /* @__PURE__ */ new WeakMap());
    __publicField(this, "fallbackResolver");
    __publicField(this, "rendered", []);
    __publicField(this, "renderedKey", null);
    __publicField(this, "controller", null);
    __publicField(this, "generation", 0);
    __publicField(this, "attached", false);
    __publicField(this, "loading", false);
    __publicField(this, "opacity");
    this.opacity = options.opacity;
    this.data = new options.google.maps.Data();
    this.cache = new LRU(options.cacheSize);
    this.fallbackResolver = this.createResolver(options.service.sublayers[0]);
    this.rebuildStyles();
    this.data.setStyle((feature) => this.styleFor(feature));
  }
  attach() {
    if (this.attached) return;
    this.data.setMap(this.options.map);
    this.attached = true;
  }
  detach() {
    if (!this.attached) return;
    this.data.setMap(null);
    this.attached = false;
  }
  update(view) {
    const areas = snapBBox(view.bounds4326, view.zoom);
    const key = areas.map((area) => area.key).join("|");
    if (key === this.renderedKey) return;
    const cached = this.cache.get(key);
    if (cached) {
      this.render(cached, key);
      return;
    }
    void this.load(areas, key, true);
  }
  prefetch(view) {
    const areas = snapBBox(view.bounds4326, view.zoom);
    const key = areas.map((area) => area.key).join("|");
    if (key === this.renderedKey || this.cache.has(key)) return;
    void this.load(areas, key, false);
  }
  setOpacity(opacity) {
    this.opacity = opacity;
    this.rebuildStyles();
    this.data.setStyle((feature) => this.styleFor(feature));
  }
  refresh() {
    this.cache.clear();
    this.renderedKey = null;
    this.generation += 1;
    this.controller?.abort();
  }
  destroy() {
    this.generation += 1;
    this.controller?.abort();
    this.data.setMap(null);
    this.data.setStyle(null);
    this.cache.clear();
    this.rendered = [];
    this.renderedKey = null;
    this.attached = false;
  }
  createResolver(sublayer) {
    return createStyleResolver({
      renderer: sublayer?.renderer ?? null,
      color: this.options.color,
      opacity: this.opacity,
      geometryType: sublayer?.geometryType ?? null,
      google: this.options.google
    });
  }
  rebuildStyles() {
    this.resolvers.clear();
    for (const sublayer of this.options.service.sublayers) {
      this.resolvers.set(sublayer.id, this.createResolver(sublayer));
    }
    this.fallbackResolver = this.createResolver(this.options.service.sublayers[0]);
  }
  styleFor(feature) {
    const sublayer = this.featureSublayer.get(feature);
    const resolver = (sublayer === void 0 ? void 0 : this.resolvers.get(sublayer)) ?? this.fallbackResolver;
    return resolver(feature);
  }
  setLoading(loading) {
    if (this.loading === loading) return;
    this.loading = loading;
    this.options.onLoading(loading);
  }
  render(features, key) {
    const previous = this.rendered;
    for (const feature of features) this.data.add(feature);
    this.rendered = features;
    this.renderedKey = key;
    for (const feature of previous) this.data.remove(feature);
    if (features.length > 0) this.options.onLoaded?.();
  }
  async load(areas, key, shouldRender) {
    const generation = ++this.generation;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.setLoading(true);
    try {
      const groups = await Promise.all(
        areas.map((area) => this.loadArea(area, controller.signal))
      );
      if (generation !== this.generation) return;
      const features = groups.flat();
      this.cache.set(key, features);
      if (shouldRender) this.render(features, key);
    } catch (error) {
      if (!isAbortError(error)) this.options.onError(toError2(error));
    } finally {
      if (generation === this.generation) this.setLoading(false);
    }
  }
  async loadArea(area, signal) {
    const features = [];
    for (const sublayer of this.options.service.sublayers) {
      if (!sublayer.supportsQuery) continue;
      let offset = 0;
      let pages = 0;
      let total = 0;
      const pageSize = Math.min(Math.max(sublayer.maxRecordCount, 1), 2e3);
      while (pages < this.options.layer.maxPages && total < this.options.layer.maxFeatures) {
        if (signal.aborted) return features;
        const page = await this.fetchPage(sublayer, area, offset, pageSize, signal);
        features.push(...page.features);
        total += page.features.length;
        offset += page.features.length;
        pages += 1;
        if (!page.exceeded || page.features.length === 0 || !sublayer.supportsPagination) break;
      }
    }
    return features;
  }
  async fetchPage(sublayer, area, offset, count, signal) {
    const url = `${this.options.service.url}/${sublayer.id}/query`;
    const params = this.baseParams(sublayer, area, offset, count);
    if (this.options.service.kind === "FeatureServer" && sublayer.supportsPbf !== false) {
      const tolerance = quantizationTolerance(area.z);
      const pbfParams = {
        ...params,
        f: "pbf",
        resultType: "tile",
        quantizationParameters: JSON.stringify({
          mode: "view",
          originPosition: "upperLeft",
          tolerance
        }),
        maxAllowableOffset: tolerance
      };
      const response = await this.options.http.request(url, pbfParams, { signal });
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      if (contentType.includes("protobuf") || contentType.includes("octet-stream")) {
        const buffer = await response.arrayBuffer();
        try {
          const decoded = decodeFeatureCollection(buffer);
          return {
            features: decoded.features.map((feature) => this.toDataFeatureFromPbf(sublayer, feature.attributes, feature.geometry)).filter((feature) => feature !== null),
            exceeded: decoded.exceededTransferLimit
          };
        } catch (error) {
          if (error instanceof NotPbfError) {
            sublayer.supportsPbf = false;
          } else {
            throw error;
          }
        }
      } else {
        sublayer.supportsPbf = false;
      }
    }
    if (sublayer.supportsGeoJson !== false) {
      try {
        return await this.fetchGeoJson(url, { ...params, f: "geojson" }, sublayer, signal);
      } catch (error) {
        if (sublayer.supportsGeoJson === true) throw error;
        if (isAbortError(error)) throw error;
        if (!(error instanceof NullIslandHttpError)) throw error;
        sublayer.supportsGeoJson = false;
      }
    }
    return this.fetchEsriJson(url, { ...params, f: "json" }, sublayer, signal);
  }
  async fetchEsriJson(url, params, sublayer, signal) {
    const response = await this.options.http.request(url, params, { signal });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch (error) {
      throw new NullIslandHttpError("ArcGIS returned a non-JSON query response", response.status, url, {
        cause: error
      });
    }
    if (body.error) {
      throw new NullIslandHttpError(
        body.error.message ?? "ArcGIS query failed",
        body.error.code ?? response.status,
        url
      );
    }
    const features = (body.features ?? []).map((feature) => this.toDataFeatureFromEsriJson(sublayer, feature)).filter((feature) => feature !== null);
    return { features, exceeded: body.exceededTransferLimit === true };
  }
  async fetchGeoJson(url, params, sublayer, signal) {
    const response = await this.options.http.request(url, params, { signal });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch (error) {
      throw new NullIslandHttpError("ArcGIS returned a non-JSON query response", response.status, url, {
        cause: error
      });
    }
    if (body.error) {
      throw new NullIslandHttpError(body.error.message ?? "ArcGIS query failed", body.error.code ?? response.status, url);
    }
    const features = (body.features ?? []).map((feature) => this.toDataFeatureFromGeoJson(sublayer, feature)).filter((feature) => feature !== null);
    return { features, exceeded: body.exceededTransferLimit === true };
  }
  baseParams(sublayer, area, offset, count) {
    const params = {
      where: "1=1",
      geometry: area.bbox.join(","),
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      outSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      returnGeometry: "true",
      outFields: "*",
      returnZ: "false",
      returnM: "false",
      resultRecordCount: count
    };
    if (sublayer.supportsPagination) {
      if (offset > 0) params.resultOffset = offset;
      if (sublayer.objectIdField) params.orderByFields = `${sublayer.objectIdField} ASC`;
    }
    return params;
  }
  toDataFeatureFromPbf(sublayer, attributes, geometry) {
    const dataGeometry = this.toGoogleGeometry(geometry);
    if (!dataGeometry) return null;
    const id = attributes[sublayer.objectIdField];
    const feature = new this.options.google.maps.Data.Feature({
      geometry: dataGeometry,
      properties: attributes,
      ...typeof id === "string" || typeof id === "number" ? { id } : {}
    });
    this.featureSublayer.set(feature, sublayer.id);
    return feature;
  }
  toDataFeatureFromGeoJson(sublayer, feature) {
    const geometry = feature.geometry;
    if (!geometry) return null;
    const dataGeometry = this.toGoogleGeometryFromGeoJson(geometry);
    if (!dataGeometry) return null;
    const properties = feature.properties ?? {};
    const id = feature.id ?? properties[sublayer.objectIdField];
    const result = new this.options.google.maps.Data.Feature({
      geometry: dataGeometry,
      properties,
      ...typeof id === "string" || typeof id === "number" ? { id } : {}
    });
    this.featureSublayer.set(result, sublayer.id);
    return result;
  }
  toDataFeatureFromEsriJson(sublayer, feature) {
    const geometry = esriJsonGeometryToPbf(feature.geometry);
    if (geometry.type === "none") return null;
    const attributes = feature.attributes ?? {};
    const id = attributes[sublayer.objectIdField];
    const result = new this.options.google.maps.Data.Feature({
      geometry: this.toGoogleGeometry(geometry),
      properties: attributes,
      ...typeof id === "string" || typeof id === "number" ? { id } : {}
    });
    this.featureSublayer.set(result, sublayer.id);
    return result;
  }
  toGoogleGeometry(geometry) {
    const { google } = this.options;
    switch (geometry.type) {
      case "point":
        return new google.maps.Data.Point(toLatLng(geometry.coordinates));
      case "multipoint":
        return new google.maps.Data.MultiPoint(geometry.coordinates.map(toLatLng));
      case "polyline":
        return geometry.paths.length === 1 ? new google.maps.Data.LineString(geometry.paths[0].map(toLatLng)) : new google.maps.Data.MultiLineString(geometry.paths.map((path) => path.map(toLatLng)));
      case "polygon": {
        const polygons = groupRings(geometry.rings);
        if (polygons.length === 0) return null;
        if (polygons.length === 1) {
          return new google.maps.Data.Polygon(polygons[0].map((ring) => ring.map(toLatLng)));
        }
        return new google.maps.Data.MultiPolygon(
          polygons.map((polygon) => polygon.map((ring) => ring.map(toLatLng)))
        );
      }
      default:
        return null;
    }
  }
  toGoogleGeometryFromGeoJson(geometry) {
    const { google } = this.options;
    switch (geometry.type) {
      case "Point":
        return new google.maps.Data.Point(toLatLng(geometry.coordinates));
      case "MultiPoint":
        return new google.maps.Data.MultiPoint(
          geometry.coordinates.map(toLatLng)
        );
      case "LineString":
        return new google.maps.Data.LineString(
          geometry.coordinates.map(toLatLng)
        );
      case "MultiLineString":
        return new google.maps.Data.MultiLineString(
          geometry.coordinates.map((line) => line.map(toLatLng))
        );
      case "Polygon":
        return new google.maps.Data.Polygon(
          geometry.coordinates.map((ring) => ring.map(toLatLng))
        );
      case "MultiPolygon":
        return new google.maps.Data.MultiPolygon(
          geometry.coordinates.map(
            (polygon) => polygon.map((ring) => ring.map(toLatLng))
          )
        );
      default:
        return null;
    }
  }
};
function quantizationTolerance(zoom) {
  const value = degreesPerPixel(zoom) / 2;
  return Math.min(1e-3, Math.max(1e-9, value));
}
function toLatLng([lng, lat]) {
  return { lng, lat };
}
function toError2(error) {
  return error instanceof Error ? error : new Error(String(error));
}

// src/mvt/decode.ts
var GEOMETRY_TYPES2 = ["unknown", "point", "line", "polygon"];
var MOVE_TO = 1;
var LINE_TO = 2;
var CLOSE_PATH = 7;
var DEFAULT_EXTENT = 4096;
function decodeMvt(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const reader = new PbfReader(bytes);
  const layers = [];
  while (!reader.eof) {
    const { field, wire } = reader.readTag();
    if (field === 3 && wire === WIRE_LENGTH_DELIMITED) {
      layers.push(decodeLayer(reader.readMessage()));
    } else {
      reader.skip(wire);
    }
  }
  return { layers };
}
function decodeLayer(reader) {
  let name = "";
  let extent = DEFAULT_EXTENT;
  let version = 1;
  const keys = [];
  const values = [];
  const featureBuffers = [];
  while (!reader.eof) {
    const { field, wire } = reader.readTag();
    switch (field) {
      case 1:
        name = reader.readString();
        break;
      case 2:
        featureBuffers.push(reader.readBytes());
        break;
      case 3:
        keys.push(reader.readString());
        break;
      case 4:
        values.push(decodeValue2(reader.readMessage()));
        break;
      case 5:
        extent = reader.readVarintNumber();
        break;
      case 15:
        version = reader.readVarintNumber();
        break;
      default:
        reader.skip(wire);
    }
  }
  const features = featureBuffers.map((buffer) => decodeFeature2(new PbfReader(buffer), keys, values));
  return { name, extent: extent || DEFAULT_EXTENT, version, features };
}
function decodeFeature2(reader, keys, values) {
  let id;
  let geometryType = 0;
  let tags = [];
  let commands = [];
  while (!reader.eof) {
    const { field, wire } = reader.readTag();
    switch (field) {
      case 1:
        id = reader.readVarintNumber();
        break;
      case 2:
        tags = wire === WIRE_LENGTH_DELIMITED ? reader.readPackedUint32() : [reader.readVarintNumber()];
        break;
      case 3:
        geometryType = reader.readVarintNumber();
        break;
      case 4:
        commands = wire === WIRE_LENGTH_DELIMITED ? reader.readPackedUint32() : [reader.readVarintNumber()];
        break;
      default:
        reader.skip(wire);
    }
  }
  const properties = {};
  for (let i = 0; i + 1 < tags.length; i += 2) {
    const key = keys[tags[i]];
    if (key !== void 0) properties[key] = values[tags[i + 1]] ?? null;
  }
  return {
    ...id === void 0 ? {} : { id },
    type: GEOMETRY_TYPES2[geometryType] ?? "unknown",
    paths: decodeGeometry2(commands, geometryType),
    properties
  };
}
function decodeGeometry2(commands, geometryType) {
  if (geometryType === 1) return decodePoints(commands);
  return decodePaths(commands, geometryType === 3);
}
function decodePoints(commands) {
  const points = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < commands.length; ) {
    const command = commands[i++];
    if ((command & 7) !== MOVE_TO) break;
    const count = command >> 3;
    for (let n = 0; n < count; n += 1) {
      x += zigzag(commands[i++]);
      y += zigzag(commands[i++]);
      points.push([x, y]);
    }
  }
  return points.length > 0 ? [points] : [];
}
function decodePaths(commands, closeRings) {
  const paths = [];
  let current = null;
  let x = 0;
  let y = 0;
  for (let i = 0; i < commands.length; ) {
    const command = commands[i++];
    const id = command & 7;
    const count = command >> 3;
    if (id === MOVE_TO) {
      for (let n = 0; n < count; n += 1) {
        x += zigzag(commands[i++]);
        y += zigzag(commands[i++]);
        current = [[x, y]];
        paths.push(current);
      }
      continue;
    }
    if (id === LINE_TO) {
      if (!current) {
        current = [[x, y]];
        paths.push(current);
      }
      for (let n = 0; n < count; n += 1) {
        x += zigzag(commands[i++]);
        y += zigzag(commands[i++]);
        current.push([x, y]);
      }
      continue;
    }
    if (id === CLOSE_PATH && current) {
      const first = current[0];
      const last = current[current.length - 1];
      if (closeRings && (first[0] !== last[0] || first[1] !== last[1])) current.push([first[0], first[1]]);
    }
  }
  return paths;
}
function decodeValue2(reader) {
  let value = null;
  while (!reader.eof) {
    const { field, wire } = reader.readTag();
    switch (field) {
      case 1:
        value = reader.readString();
        break;
      case 2:
        value = reader.readFloat();
        break;
      case 3:
        value = reader.readDouble();
        break;
      case 4:
        value = reader.readInt64();
        break;
      case 5:
        value = reader.readUint64();
        break;
      case 6:
        value = reader.readSint64();
        break;
      case 7:
        value = reader.readBool();
        break;
      default:
        reader.skip(wire);
    }
  }
  return value;
}
function zigzag(value) {
  return value >>> 1 ^ -(value & 1);
}

// src/viewport.ts
function readViewport(map, dpr) {
  const zoom = map.getZoom();
  const center = map.getCenter();
  const projection = map.getProjection();
  const div = map.getDiv();
  if (zoom === void 0 || zoom === null || !center || !projection || !div) return null;
  const width = div.clientWidth || div.offsetWidth;
  const height = div.clientHeight || div.offsetHeight;
  if (!width || !height) return null;
  const point = projection.fromLatLngToPoint(center);
  if (!point) return null;
  const scale = 2 ** zoom;
  const centerX = point.x * scale;
  const centerY = point.y * scale;
  const left = centerX - width / 2;
  const right = centerX + width / 2;
  const top = centerY - height / 2;
  const bottom = centerY + height / 2;
  const metersPerPixel = WORLD_METERS / (256 * scale);
  const bounds3857 = [
    -HALF_WORLD + left * metersPerPixel,
    HALF_WORLD - bottom * metersPerPixel,
    -HALF_WORLD + right * metersPerPixel,
    HALF_WORLD - top * metersPerPixel
  ];
  return {
    zoom,
    width,
    height,
    dpr,
    center: { lng: center.lng(), lat: center.lat() },
    bounds3857,
    bounds4326: clampBBoxLatitude(metersToBbox(bounds3857))
  };
}
function padBBox(bbox, padding) {
  const [west, south, east, north] = bbox;
  const dx = (east - west) * padding;
  const dy = (north - south) * padding;
  return [west - dx, south - dy, east + dx, north + dy];
}
function bboxContains(outer, inner) {
  return outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
}

// src/renderers/mvt-renderer.ts
var PALETTE = ["#4c7dff", "#e8590c", "#f2b705", "#2f9e44", "#9c36b5", "#0c8599"];
var MvtRenderer = class {
  constructor(options) {
    __publicField(this, "options", options);
    __publicField(this, "mode", "mvt");
    __publicField(this, "overlay");
    __publicField(this, "cache");
    __publicField(this, "tileCache");
    __publicField(this, "controller", null);
    __publicField(this, "generation", 0);
    __publicField(this, "attached", false);
    __publicField(this, "loading", false);
    __publicField(this, "opacity");
    __publicField(this, "renderedKey", null);
    __publicField(this, "lastView", null);
    __publicField(this, "lastBbox", null);
    __publicField(this, "lastZoom", Number.NaN);
    this.opacity = options.opacity;
    this.cache = new LRU(64);
    this.tileCache = new LRU(48);
    this.overlay = new MvtCanvasOverlay(options.google, options.map);
  }
  attach() {
    if (this.attached) return;
    this.attached = true;
    this.lastBbox = null;
    this.renderedKey = null;
    this.overlay.setMap(this.options.map);
  }
  detach() {
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
  update(view) {
    this.lastView = view;
    void this.render(view);
  }
  prefetch(view) {
    void this.render(view);
  }
  setOpacity(opacity) {
    this.opacity = opacity;
    this.renderedKey = null;
    this.lastBbox = null;
    if (this.lastView) void this.render(this.lastView);
  }
  refresh() {
    this.cache.clear();
    this.renderedKey = null;
    this.lastBbox = null;
    if (this.lastView) void this.render(this.lastView);
  }
  destroy() {
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
  setLoading(loading) {
    if (this.loading === loading) return;
    this.loading = loading;
    this.options.onLoading(loading);
  }
  async render(view) {
    if (!this.attached) return;
    const { service } = this.options;
    const padding = Math.min(this.options.padding, 0.15);
    const bbox = padBBox(view.bounds4326, padding);
    if (this.lastBbox && view.zoom === this.lastZoom && bboxContains(this.lastBbox, view.bounds4326)) {
      return;
    }
    const z = clamp(Math.round(view.zoom), service.minZoom, service.maxZoom);
    const key = `${z}|${view.zoom.toFixed(2)}|${bbox.map((value) => value.toFixed(4)).join(",")}`;
    if (key === this.renderedKey) return;
    const generation = ++this.generation;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.setLoading(true);
    try {
      const extent = service.fullExtent;
      const tiles = tilesFor(bbox, z).filter(
        (tile) => !extent || intersects(tileToBBox(tile.z, tile.x, tile.y), extent)
      );
      const decoded = await Promise.all(
        tiles.map((tile) => this.loadTile(tile, controller.signal))
      );
      if (generation !== this.generation) return;
      const featureCount = countFeatures(decoded);
      if (featureCount > this.options.layer.maxFeatures) {
        this.clearCanvas(view, bbox);
        this.renderedKey = key;
        this.lastBbox = bbox;
        this.lastZoom = view.zoom;
        return;
      }
      await this.draw(view, bbox, z, tiles, decoded, generation);
      if (generation !== this.generation) return;
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
  async loadTile(tile, signal) {
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const path = this.options.service.tileTemplate.replace("{z}", String(tile.z)).replace("{y}", String(tile.y)).replace("{x}", String(tile.x));
    const url = `${this.options.service.url}/${path}`;
    try {
      const response = await this.options.http.request(url, {}, { signal });
      const buffer = await response.arrayBuffer();
      const decoded = decodeMvt(buffer);
      this.cache.set(key, decoded);
      return decoded;
    } catch (error) {
      if (error instanceof NullIslandHttpError && (error.status === 404 || error.status === 400)) {
        const empty = { layers: [] };
        this.cache.set(key, empty);
        return empty;
      }
      throw error;
    }
  }
  async draw(view, bbox, z, tiles, decoded, generation) {
    const canvas = this.overlay.getCanvas();
    if (!canvas) return;
    const padding = Math.min(this.options.padding, 0.15);
    const dpr = Math.min(view.dpr, 2);
    const cssWidth = Math.max(1, Math.round(view.width * (1 + padding * 2)));
    const cssHeight = Math.max(1, Math.round(view.height * (1 + padding * 2)));
    const maxPixels = 6e6;
    const pixelScale = Math.min(1, Math.sqrt(maxPixels / (cssWidth * dpr * cssHeight * dpr)));
    const deviceWidth = Math.max(1, Math.round(cssWidth * dpr * pixelScale));
    const deviceHeight = Math.max(1, Math.round(cssHeight * dpr * pixelScale));
    if (canvas.width !== deviceWidth || canvas.height !== deviceHeight) {
      canvas.width = deviceWidth;
      canvas.height = deviceHeight;
    }
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    const scaleX = deviceWidth / cssWidth;
    const scaleY = deviceHeight / cssHeight;
    context.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    context.clearRect(0, 0, cssWidth, cssHeight);
    const northWest = lngLatToWorld(bbox[0], bbox[3]);
    const originX = northWest.x * 256 * 2 ** view.zoom;
    const originY = northWest.y * 256 * 2 ** view.zoom;
    const tilePx = 256 * 2 ** (view.zoom - z);
    const started = typeof performance !== "undefined" ? performance.now() : 0;
    context.globalAlpha = this.opacity;
    for (let index = 0; index < tiles.length; index += 1) {
      const data = decoded[index];
      if (!data) continue;
      const tile = tiles[index];
      const key = `${z}/${tile.x}/${tile.y}`;
      let tileCanvas = this.tileCache.get(key);
      const cached = tileCanvas !== void 0;
      if (!tileCanvas) {
        tileCanvas = this.renderTile(data, view.zoom);
        this.tileCache.set(key, tileCanvas);
      }
      context.drawImage(
        tileCanvas,
        tile.x * tilePx - originX,
        tile.y * tilePx - originY,
        tilePx,
        tilePx
      );
      if (!cached && generation === this.generation) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    if (typeof performance !== "undefined" && typeof console !== "undefined") {
      const elapsed = performance.now() - started;
      if (elapsed > 50) {
        console.debug(
          `[nullisland mvt] compose ${Math.round(elapsed)}ms \u2014 ${tiles.length} tiles \u2014 ${deviceWidth}x${deviceHeight}`
        );
      }
    }
  }
  clearCanvas(view, bbox) {
    const canvas = this.overlay.getCanvas();
    if (!canvas) return;
    const { padding } = this.options;
    const cssWidth = Math.max(1, Math.round(view.width * (1 + padding * 2)));
    const cssHeight = Math.max(1, Math.round(view.height * (1 + padding * 2)));
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    this.overlay.setBounds(bbox);
  }
  /** Paint one tile at its native 512 px into an offscreen canvas. */
  renderTile(tile, zoom) {
    const size = 384;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) return canvas;
    const { service } = this.options;
    const styles = service.styleLayers.length > 0 ? service.styleLayers : this.fallbackStyles([tile]);
    context.lineJoin = "round";
    context.lineCap = "round";
    for (const style of styles) {
      if (!styleVisible(style, zoom)) continue;
      context.beginPath();
      let hasGeometry = false;
      for (const mvtLayer of tile.layers) {
        if (mvtLayer.name !== style.sourceLayer) continue;
        const scale = size / (mvtLayer.extent || service.extent);
        for (const feature of mvtLayer.features) {
          const relevant = style.type === "fill" ? feature.type === "polygon" : feature.type === "line";
          if (!relevant) continue;
          for (const path of feature.paths) {
            tracePath(context, path, 0, 0, scale, style.type === "fill");
          }
          hasGeometry = true;
        }
      }
      if (!hasGeometry) continue;
      if (style.type === "fill") {
        context.globalAlpha = style.fillOpacity ?? 1;
        context.fillStyle = style.fillColor ?? "rgba(76, 125, 255, 0.45)";
        context.fill("nonzero");
      }
      if (style.lineColor && style.type === "line") {
        context.globalAlpha = style.lineOpacity ?? 1;
        context.strokeStyle = style.lineColor;
        context.lineWidth = style.lineWidth ?? 1.5;
        context.stroke();
      }
    }
    return canvas;
  }
  fallbackStyles(decoded) {
    const names = /* @__PURE__ */ new Set();
    for (const tile of decoded) {
      for (const layer of tile?.layers ?? []) names.add(layer.name);
    }
    return [...names].map((name, index) => ({
      id: name,
      sourceLayer: name,
      type: "fill",
      fillColor: PALETTE[index % PALETTE.length],
      fillOpacity: 0.45,
      lineColor: PALETTE[index % PALETTE.length],
      lineWidth: 1,
      lineOpacity: 0.9,
      minZoom: void 0,
      maxZoom: void 0
    }));
  }
};
function tracePath(context, points, offsetX, offsetY, scale, close) {
  points.forEach(([x, y], index) => {
    const px = offsetX + x * scale;
    const py = offsetY + y * scale;
    if (index === 0) context.moveTo(px, py);
    else context.lineTo(px, py);
  });
  if (close) context.closePath();
}
function countFeatures(tiles) {
  let total = 0;
  for (const tile of tiles) {
    for (const layer of tile?.layers ?? []) total += layer.features.length;
  }
  return total;
}
function intersects(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}
function styleVisible(style, zoom) {
  if (style.minZoom !== void 0 && zoom < style.minZoom) return false;
  if (style.maxZoom !== void 0 && zoom > style.maxZoom) return false;
  return true;
}
function tilesFor(bbox, z) {
  const max = 2 ** z - 1;
  const x0 = clamp(Math.floor(tileX(bbox[0], z)), 0, max);
  const x1 = clamp(Math.floor(tileX(bbox[2], z)), 0, max);
  const y0 = clamp(Math.floor(tileY(bbox[3], z)), 0, max);
  const y1 = clamp(Math.floor(tileY(bbox[1], z)), 0, max);
  const tiles = [];
  for (let x = x0; x <= x1; x += 1) {
    for (let y = y0; y <= y1; y += 1) tiles.push({ z, x, y });
  }
  return tiles;
}
var MvtCanvasOverlay = class {
  constructor(googleApi, map) {
    __publicField(this, "overlay");
    __publicField(this, "container", null);
    __publicField(this, "canvas", null);
    __publicField(this, "bounds", null);
    const overlay = new googleApi.maps.OverlayView();
    overlay.onAdd = () => this.onAdd();
    overlay.draw = () => this.position();
    overlay.onRemove = () => this.onRemove();
    this.overlay = overlay;
    this.overlay.setMap(map);
  }
  setMap(map) {
    this.overlay.setMap(map);
  }
  getCanvas() {
    return this.canvas;
  }
  setBounds(bounds) {
    this.bounds = bounds;
    this.position();
  }
  destroy() {
    this.overlay.setMap(null);
    this.onRemove();
  }
  onAdd() {
    const panes = this.overlay.getPanes();
    if (!panes) return;
    this.container?.remove();
    const container = document.createElement("div");
    container.style.position = "absolute";
    container.style.left = "0";
    container.style.top = "0";
    container.style.pointerEvents = "none";
    const canvas = document.createElement("canvas");
    canvas.style.position = "absolute";
    canvas.style.left = "0";
    canvas.style.top = "0";
    canvas.style.pointerEvents = "none";
    container.appendChild(canvas);
    panes.overlayLayer.appendChild(container);
    this.container = container;
    this.canvas = canvas;
    this.position();
  }
  onRemove() {
    this.container?.remove();
    this.container = null;
    this.canvas = null;
  }
  position() {
    if (!this.container || !this.canvas || !this.bounds) return;
    const projection = this.overlay.getProjection();
    if (!projection) return;
    const [west, south, east, north] = this.bounds;
    const northWest = projection.fromLatLngToDivPixel({ lat: north, lng: west });
    const southEast = projection.fromLatLngToDivPixel({ lat: south, lng: east });
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
};

// src/layer.ts
var LayerController = class {
  constructor(config, context) {
    __publicField(this, "context", context);
    __publicField(this, "config");
    __publicField(this, "service", null);
    __publicField(this, "renderer", null);
    __publicField(this, "state", "idle");
    __publicField(this, "message");
    __publicField(this, "minZoom", 0);
    __publicField(this, "maxZoom", 22);
    __publicField(this, "currentView", null);
    __publicField(this, "isVisible");
    __publicField(this, "layerTitle");
    this.config = config;
    this.isVisible = config.visible;
    this.layerTitle = config.title ?? config.service.base;
  }
  get id() {
    return this.config.id;
  }
  get title() {
    return this.layerTitle;
  }
  get url() {
    return this.config.service.base;
  }
  get mode() {
    return this.renderer?.mode ?? null;
  }
  get visible() {
    return this.isVisible;
  }
  get sublayers() {
    const service = this.service;
    if (!service || !("sublayers" in service)) return [];
    return service.sublayers.map((sublayer) => ({
      id: sublayer.id,
      name: sublayer.name
    }));
  }
  async init() {
    this.state = "loading";
    if (this.config.service.kind === "VectorTileServer") {
      const vectorTiles = await discoverVectorTileService(this.config.service, this.context.http, {
        title: this.config.title,
        styleUrl: this.config.styleUrl
      });
      this.service = vectorTiles;
      this.layerTitle = this.config.title ?? vectorTiles.title;
      this.minZoom = this.config.minZoom ?? vectorTiles.minZoom;
      this.maxZoom = this.config.maxZoom ?? vectorTiles.maxZoom;
      this.renderer = new MvtRenderer({
        map: this.context.map,
        google: this.context.google,
        http: this.context.http,
        layer: this.config,
        service: vectorTiles,
        opacity: this.config.opacity,
        padding: this.context.padding,
        onLoading: (loading) => this.context.onLoading(this.id, loading),
        onError: (error) => this.context.onError(error)
      });
      this.state = "ready";
      if (this.isVisible && this.currentView) this.sync(this.currentView);
      return;
    }
    const service = await discoverService(this.config.service, this.context.http, {
      sublayers: this.config.sublayers,
      title: this.config.title
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
      exportTransport: this.context.exportTransport,
      exportTimeout: this.context.exportTimeout,
      onLoading: (loading) => this.context.onLoading(this.id, loading),
      onError: (error) => this.context.onError(error),
      onLoaded: () => this.context.onLoaded(this.id)
    };
    this.renderer = mode === "export" ? new ExportRenderer(options) : new VectorRenderer(options);
    this.state = "ready";
    if (this.isVisible && this.currentView) this.sync(this.currentView);
  }
  fail(error) {
    this.state = "error";
    this.message = error.message;
  }
  sync(view) {
    this.currentView = view;
    if (!this.isVisible || !this.renderer) return;
    if (view.zoom < this.minZoom || view.zoom > this.maxZoom) {
      this.renderer.detach();
      return;
    }
    this.renderer.attach();
    this.renderer.update(view);
  }
  setVisible(visible) {
    if (this.isVisible === visible) return;
    this.isVisible = visible;
    if (!visible) {
      this.renderer?.detach();
      return;
    }
    try {
      if (this.currentView) this.sync(this.currentView);
    } catch (error) {
      this.context.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }
  setOpacity(opacity) {
    this.config.opacity = Math.min(1, Math.max(0, opacity));
    this.renderer?.setOpacity(this.config.opacity);
  }
  prefetch() {
    if (!this.currentView || !this.renderer) return;
    this.renderer.prefetch(this.currentView);
  }
  refresh() {
    this.renderer?.refresh();
    if (this.currentView) this.sync(this.currentView);
  }
  destroy() {
    this.renderer?.destroy();
    this.renderer = null;
    this.currentView = null;
  }
  resolveMode(service) {
    if (this.config.mode === "export") {
      if (!service.supportsExport) {
        throw new NullIslandError(
          `Layer ${this.config.id} requested export mode but ${service.url} does not advertise the Map capability`,
          "NULLISLAND_NO_EXPORT"
        );
      }
      return "export";
    }
    if (this.config.mode === "vector") {
      if (!service.sublayers.some((sublayer) => sublayer.supportsQuery)) {
        throw new NullIslandError(
          `Layer ${this.config.id} requested vector mode but no sublayer supports querying`,
          "NULLISLAND_NO_QUERY"
        );
      }
      return "vector";
    }
    return service.supportsExport ? "export" : "vector";
  }
};

// src/engine.ts
var INDICATOR_DELAY_MS = 300;
var UPDATE_DEBOUNCE_MS = 120;
var NullIsland = class {
  constructor(options) {
    /** Resolves when every layer has finished discovery (errors included). */
    __publicField(this, "ready");
    __publicField(this, "controllers");
    __publicField(this, "http");
    __publicField(this, "emitter", new Emitter());
    __publicField(this, "map");
    __publicField(this, "googleApi");
    __publicField(this, "listeners", []);
    __publicField(this, "pending", /* @__PURE__ */ new Set());
    __publicField(this, "dpr");
    __publicField(this, "indicatorElement");
    __publicField(this, "ownsIndicator");
    __publicField(this, "updateTimer", null);
    __publicField(this, "indicatorTimer", null);
    __publicField(this, "destroyed", false);
    if (!options || typeof options !== "object") {
      throw new NullIslandConfigError("NullIsland requires an options object");
    }
    if (!options.map) {
      throw new NullIslandConfigError("NullIsland requires a Google Maps map instance");
    }
    this.map = options.map;
    this.googleApi = resolveGoogle(options.google);
    const dpr = globalThis.devicePixelRatio ?? 1;
    this.dpr = Math.min(3, Math.max(1, dpr));
    this.http = new HttpClient({ fetch: options.fetch, token: options.apiKey });
    const { layers, errors } = normalizeLayers(options.layers, {
      allowInsecure: options.allowInsecure === true
    });
    const reducedMotion = options.reducedMotion ?? prefersReducedMotion();
    this.controllers = layers.map(
      (config) => new LayerController(config, {
        map: this.map,
        google: this.googleApi,
        http: this.http,
        cacheSize: options.cacheSize ?? 8,
        padding: options.padding ?? 0.25,
        maxImageSize: options.maxImageSize ?? 4096,
        fadeDuration: options.fadeDuration ?? 150,
        reducedMotion,
        exportTransport: options.exportTransport ?? "image",
        exportTimeout: options.exportTimeout ?? 2e4,
        onLoading: (id, loading) => this.handleLoading(id, loading),
        onError: (error) => this.emitError(error),
        onLoaded: (id) => this.emitter.emit("load", { layer: id })
      })
    );
    const indicator = setupIndicator(options.indicator, this.map);
    this.indicatorElement = indicator?.element ?? null;
    this.ownsIndicator = indicator?.owned ?? false;
    for (const { index, error } of errors) {
      setTimeout(() => {
        this.emitError(
          new NullIslandConfigError(`Layer at index ${index} was skipped: ${error.message}`)
        );
      }, 0);
    }
    this.bindMapEvents();
    this.emitStatus();
    this.ready = this.init();
  }
  get layers() {
    return this.controllers;
  }
  on(event, listener) {
    return this.emitter.on(event, listener);
  }
  setApiKey(token) {
    this.http.setToken(token);
  }
  getLayer(id) {
    return this.controllers.find((controller) => controller.id === id);
  }
  prefetch(id) {
    this.controllers.find((controller) => controller.id === id)?.prefetch();
  }
  refresh(id) {
    for (const controller of this.controllers) {
      if (id === void 0 || controller.id === id) controller.refresh();
    }
  }
  getStatus() {
    return {
      loading: this.pending.size > 0,
      layers: this.controllers.map((controller) => ({
        id: controller.id,
        state: controller.state,
        mode: controller.mode,
        ...controller.message ? { message: controller.message } : {}
      }))
    };
  }
  destroy() {
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
  async init() {
    await Promise.all(
      this.controllers.map(async (controller) => {
        try {
          await controller.init();
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          controller.fail(failure);
          this.emitError(failure);
        }
      })
    );
    this.update();
    this.emitStatus();
  }
  bindMapEvents() {
    this.listeners.push(
      this.map.addListener("idle", () => this.scheduleUpdate()),
      this.map.addListener("zoom_changed", () => this.update()),
      this.map.addListener("projection_changed", () => this.update())
    );
  }
  scheduleUpdate() {
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      this.update();
    }, UPDATE_DEBOUNCE_MS);
  }
  update() {
    if (this.destroyed) return;
    const view = readViewport(this.map, this.dpr);
    if (!view) return;
    for (const controller of this.controllers) controller.sync(view);
    this.emitStatus();
  }
  handleLoading(id, loading) {
    if (loading) this.pending.add(id);
    else this.pending.delete(id);
    this.updateIndicator();
    this.emitStatus();
  }
  emitError(error) {
    this.emitter.emit("error", error);
  }
  emitStatus() {
    if (this.destroyed) return;
    this.emitter.emit("status", this.getStatus());
  }
  updateIndicator() {
    if (!this.indicatorElement) return;
    if (this.pending.size > 0) {
      if (this.indicatorTimer) return;
      this.indicatorTimer = setTimeout(() => {
        this.indicatorTimer = null;
        if (this.pending.size > 0 && !this.destroyed) {
          this.indicatorElement.style.display = "block";
        }
      }, INDICATOR_DELAY_MS);
      return;
    }
    if (this.indicatorTimer) {
      clearTimeout(this.indicatorTimer);
      this.indicatorTimer = null;
    }
    this.indicatorElement.style.display = "none";
  }
};
function resolveGoogle(injected) {
  const candidate = injected ?? globalThis.google;
  if (!candidate?.maps) {
    throw new NullIslandConfigError(
      "Google Maps JavaScript API is not loaded. Load it before creating NullIsland, or pass the `google` namespace."
    );
  }
  return candidate;
}
function prefersReducedMotion() {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
function setupIndicator(indicator, map) {
  if (!indicator) return null;
  if (typeof HTMLElement !== "undefined" && indicator instanceof HTMLElement) {
    return { element: indicator, owned: false };
  }
  if (typeof document === "undefined") return null;
  const element = document.createElement("div");
  element.textContent = "Loading map layers\u2026";
  element.setAttribute("role", "status");
  element.style.cssText = [
    "position:absolute",
    "left:50%",
    "bottom:24px",
    "transform:translateX(-50%)",
    "padding:6px 12px",
    "border-radius:9999px",
    "background:rgba(17,24,39,0.88)",
    "color:#fff",
    "font:500 12px/1.4 system-ui,-apple-system,sans-serif",
    "letter-spacing:0.01em",
    "box-shadow:0 6px 20px rgba(0,0,0,0.25)",
    "pointer-events:none",
    "display:none",
    "z-index:5"
  ].join(";");
  map.getDiv().appendChild(element);
  return { element, owned: true };
}
export {
  NotPbfError,
  NullIsland,
  NullIslandAbortError,
  NullIslandAuthError,
  NullIslandConfigError,
  NullIslandError,
  NullIslandHttpError,
  PbfReader,
  decodeFeatureCollection,
  deriveLayerId,
  discoverService,
  groupRings,
  isAbortError,
  metersToBbox,
  normalizeLayer,
  normalizeLayers,
  parseServiceUrl,
  scaleToZoom,
  signedArea,
  snapBBox,
  zoomRangeFromScales
};
