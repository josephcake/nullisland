/**
 * Tile scheduling: which tiles a viewport needs, at which zoom, and where
 * their pixels land on the canvas.
 */

import {clamp, lngLatToWorld, type BBox} from '../util/mercator.ts';
import {tileX, tileY} from '../util/tiles.ts';
import {padBBox, type Viewport} from '../viewport.ts';

export interface TileRef {
  z: number;
  x: number;
  y: number;
}

export interface TilePlan {
  /** Tile zoom (native to the view, clamped to the source range). */
  z: number;
  tiles: TileRef[];
  /** Padded geographic area the canvas covers. */
  bbox: BBox;
  /** Tile size in CSS pixels at the current fractional zoom. */
  tilePx: number;
  /** World-pixel origin of the padded area at the current zoom. */
  originX: number;
  originY: number;
}

export function planTiles(
  view: Viewport,
  minZoom: number,
  maxZoom: number,
  padding: number,
): TilePlan {
  const z = clamp(Math.round(view.zoom), minZoom, maxZoom);
  const bbox = padBBox(view.bounds4326, padding);
  const max = 2 ** z - 1;

  const x0 = clamp(Math.floor(tileX(bbox[0], z)), 0, max);
  const x1 = clamp(Math.floor(tileX(bbox[2], z)), 0, max);
  const y0 = clamp(Math.floor(tileY(bbox[3], z)), 0, max);
  const y1 = clamp(Math.floor(tileY(bbox[1], z)), 0, max);

  const tiles: TileRef[] = [];
  for (let x = x0; x <= x1; x += 1) {
    for (let y = y0; y <= y1; y += 1) tiles.push({z, x, y});
  }

  const northWest = lngLatToWorld(bbox[0], bbox[3]);
  return {
    z,
    tiles,
    bbox,
    tilePx: 256 * 2 ** (view.zoom - z),
    originX: northWest.x * 256 * 2 ** view.zoom,
    originY: northWest.y * 256 * 2 ** view.zoom,
  };
}
