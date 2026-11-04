/**
 * Web Mercator helpers shared by both rendering strategies.
 *
 * Everything here is pure math so it can be unit tested without Google Maps.
 */

export const EARTH_RADIUS = 6378137;
export const WORLD_METERS = 2 * Math.PI * EARTH_RADIUS;
export const HALF_WORLD = WORLD_METERS / 2;
/** Latitude where Web Mercator is clipped. */
export const MAX_LATITUDE = 85.0511287798066;

export interface LngLat {
  lng: number;
  lat: number;
}

/** `[west, south, east, north]` in WGS84 degrees, longitudes not normalised. */
export type BBox = [number, number, number, number];

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampLatitude(lat: number): number {
  return clamp(lat, -MAX_LATITUDE, MAX_LATITUDE);
}

/** Wrap a longitude into [-180, 180). */
export function normalizeLng(lng: number): number {
  let value = ((lng + 180) % 360 + 360) % 360 - 180;
  if (Object.is(value, -0)) value = 0;
  return value;
}

export function lngToMeters(lng: number): number {
  return (lng / 180) * HALF_WORLD;
}

export function metersToLng(x: number): number {
  return (x / HALF_WORLD) * 180;
}

export function latToMeters(lat: number): number {
  const sin = Math.sin((clampLatitude(lat) * Math.PI) / 180);
  return (Math.log((1 + sin) / (1 - sin)) / 2) * EARTH_RADIUS;
}

export function metersToLat(y: number): number {
  return (2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2) * (180 / Math.PI);
}

/** Normalised world coordinates: x, y in [0, 1], y grows southwards. */
export function lngLatToWorld(lng: number, lat: number): {x: number; y: number} {
  const sin = Math.sin((clampLatitude(lat) * Math.PI) / 180);
  return {
    x: (lng + 180) / 360,
    y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI),
  };
}

export function worldToLngLat(x: number, y: number): LngLat {
  const n = Math.PI - 2 * Math.PI * y;
  return {
    lng: x * 360 - 180,
    lat: (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))),
  };
}

/** WGS84 position of the north-west corner of a tile. */
export function tileToLngLat(x: number, y: number, z: number): LngLat {
  const n = 2 ** z;
  return worldToLngLat(x / n, y / n);
}

/**
 * Google Maps world coordinates (256px at zoom 0) for a zoom level.
 */
export function worldSize(zoom: number): number {
  return 256 * 2 ** zoom;
}

/** Bounding box in EPSG:3857 metres for a WGS84 bbox. */
export function bboxToMeters(bbox: BBox): [number, number, number, number] {
  const [west, south, east, north] = bbox;
  return [lngToMeters(west), latToMeters(south), lngToMeters(east), latToMeters(north)];
}

/** WGS84 bbox for an EPSG:3857 bounding box. */
export function metersToBbox(box: [number, number, number, number]): BBox {
  const [xmin, ymin, xmax, ymax] = box;
  return [metersToLng(xmin), metersToLat(ymin), metersToLng(xmax), metersToLat(ymax)];
}

/** Expand a WGS84 bbox by a fraction of its size on each side. */
export function padBBox(bbox: BBox, padding: number): BBox {
  const [west, south, east, north] = bbox;
  const dx = (east - west) * padding;
  const dy = (north - south) * padding;
  return [west - dx, south - dy, east + dx, north + dy];
}

/**
 * Split a bbox that crosses the antimeridian into up to two boxes inside
 * [-180, 180]. A bbox spanning the whole world is returned as one box.
 */
export function splitBBox(bbox: BBox): BBox[] {
  const [west, south, east, north] = bbox;
  const span = east - west;
  if (!Number.isFinite(span) || span <= 0) return [[west, south, Math.max(west, east), north]];
  if (span >= 360) return [[-180, south, 180, north]];

  const start = normalizeLng(west);
  const end = start + span;

  if (end <= 180) return [[start, south, end, north]];
  return [
    [start, south, 180, north],
    [-180, south, end - 360, north],
  ];
}

/** Clamp a bbox to the world, choosing the larger portion when it wraps. */
export function clampBBoxToWorld(bbox: BBox): BBox {
  const parts = splitBBox(bbox);
  if (parts.length === 1) {
    const part = parts[0]!;
    return [Math.max(-180, part[0]), clampLatitude(part[1]), Math.min(180, part[2]), clampLatitude(part[3])];
  }
  const area = (box: BBox) => (box[2] - box[0]) * (box[3] - box[1]);
  const best = area(parts[0]!) >= area(parts[1]!) ? parts[0]! : parts[1]!;
  return [Math.max(-180, best[0]), clampLatitude(best[1]), Math.min(180, best[2]), clampLatitude(best[3])];
}

/** Clamp a latitude into the valid Web Mercator range. */
export function clampBBoxLatitude(bbox: BBox): BBox {
  return [bbox[0], clampLatitude(bbox[1]), bbox[2], clampLatitude(bbox[3])];
}

/** Approximate metres per screen pixel at a latitude and zoom. */
export function metersPerPixel(lat: number, zoom: number): number {
  return (Math.cos((clampLatitude(lat) * Math.PI) / 180) * WORLD_METERS) / worldSize(zoom);
}

/** Degrees of longitude per screen pixel at a given zoom. */
export function degreesPerPixel(zoom: number): number {
  return 360 / worldSize(zoom);
}
