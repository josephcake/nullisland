/**
 * MVT geometry -> GPU-ready triangle meshes.
 *
 * Polygons are grouped into (outer, holes) rings, triangulated with earcut and
 * emitted as flat Float32 positions in tile units plus Uint32 indices. Callers
 * apply a per-tile model transform in the vertex shader, so a mesh is reused
 * for every camera position until its tile is evicted.
 */

import earcut from 'earcut';
import type {MvtFeature} from './decode.ts';
import type {Position} from '../pbf/decode.ts';

export interface Mesh {
  /** Interleaved x, y in tile units. */
  positions: Float32Array;
  indices: Uint32Array;
}

/** Signed ring area; MVT exteriors are clockwise in tile space (positive). */
export function ringArea(ring: Position[]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    sum += ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1];
  }
  return sum / 2;
}

/**
 * Group rings into polygons: a positive-area ring starts a polygon, negative
 * rings are holes of the most recent polygon.
 */
export function groupPolygonRings(rings: Position[][]): Position[][][] {
  const polygons: Position[][][] = [];
  for (const ring of rings) {
    if (ring.length < 3) continue;
    const area = ringArea(ring);
    if (Math.abs(area) < 1e-9) continue;
    if (area > 0 || polygons.length === 0) polygons.push([ring]);
    else polygons[polygons.length - 1]!.push(ring);
  }
  return polygons;
}

/**
 * Triangulate every polygon feature in a batch.
 *
 * `screenScale` is screen pixels per tile unit; features smaller than a couple
 * of pixels are dropped — at low zoom they are most of a tile and invisible.
 */
export function triangulatePolygons(features: MvtFeature[], screenScale: number): Mesh | null {
  const positions: number[] = [];
  const indices: number[] = [];

  for (const feature of features) {
    if (feature.type !== 'polygon') continue;

    const bounds = featureBounds(feature);
    if (!bounds) continue;
    const screenWidth = (bounds[2] - bounds[0]) * screenScale;
    const screenHeight = (bounds[3] - bounds[1]) * screenScale;
    if (screenWidth * screenHeight < 2) continue;

    for (const polygon of groupPolygonRings(feature.paths)) {
      const flat: number[] = [];
      const holes: number[] = [];
      for (let ring = 0; ring < polygon.length; ring += 1) {
        if (ring > 0) holes.push(flat.length / 2);
        for (const [x, y] of polygon[ring]!) flat.push(x, y);
      }
      if (flat.length < 6) continue;

      const triangles = earcut(flat, holes, 2);
      if (triangles.length === 0) continue;

      const base = positions.length / 2;
      for (const value of flat) positions.push(value);
      for (const index of triangles) indices.push(index + base);
    }
  }

  if (indices.length === 0) return null;
  return {positions: new Float32Array(positions), indices: new Uint32Array(indices)};
}

/** Flat line segments (pairs of vertices) for `gl.LINES`. */
export function lineSegments(features: MvtFeature[]): Float32Array | null {
  const vertices: number[] = [];
  for (const feature of features) {
    if (feature.type !== 'line') continue;
    for (const path of feature.paths) {
      for (let i = 1; i < path.length; i += 1) {
        const a = path[i - 1]!;
        const b = path[i]!;
        vertices.push(a[0], a[1], b[0], b[1]);
      }
    }
  }
  return vertices.length === 0 ? null : new Float32Array(vertices);
}

export function featureBounds(feature: MvtFeature): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const path of feature.paths) {
    for (const [x, y] of path) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (!Number.isFinite(minX)) return null;
  return [minX, minY, maxX, maxY];
}
