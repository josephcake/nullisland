/**
 * Tile grid helpers.
 *
 * Vector queries are snapped outward to the OSM/XYZ tile grid so that the
 * same viewport always produces the same cache key. This is what makes pans
 * cheap: moving 200px reuses the previous query instead of refetching.
 */

import {
  clamp,
  splitBBox,
  lngLatToWorld,
  tileToLngLat,
  type BBox,
} from './mercator.ts';

export interface TileRange {
  z: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface SnappedArea {
  /** Tile-aligned bbox in WGS84. */
  bbox: BBox;
  /** Stable cache key. */
  key: string;
  z: number;
}

const MAX_TILE_ZOOM = 20;
const TILE_SIZE = 256;

export function tileX(lng: number, z: number): number {
  return ((lng + 180) / 360) * 2 ** z;
}

export function tileY(lat: number, z: number): number {
  return lngLatToWorld(0, lat).y * 2 ** z;
}

/** Tile-local resolution in degrees at a zoom level (Web Mercator). */
export function tileDegrees(z: number): number {
  return 360 / (TILE_SIZE * 2 ** z);
}

export function tileToBBox(z: number, x: number, y: number): BBox {
  const northWest = tileToLngLat(x, y, z);
  const southEast = tileToLngLat(x + 1, y + 1, z);
  return [northWest.lng, southEast.lat, southEast.lng, northWest.lat];
}

/**
 * Snap a viewport bbox outward to tile boundaries.
 *
 * `snapDelta` coarsens the grid (1 = one zoom level less than the map), which
 * trades a slightly larger query area for far fewer refetches while panning.
 * Returns one area per antimeridian side.
 */
export function snapBBox(bbox: BBox, zoom: number, snapDelta = 1): SnappedArea[] {
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
      bbox: [northWest.lng, southEast.lat, southEast.lng, northWest.lat] as BBox,
      key: `${z}/${x0}/${y0}/${x1}/${y1}`,
      z,
    };
  });

  // Collapse duplicate keys (possible for tiny viewports on the antimeridian).
  const seen = new Set<string>();
  return areas.filter((area) => {
    if (seen.has(area.key)) return false;
    seen.add(area.key);
    return true;
  });
}
