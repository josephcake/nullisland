import {describe, expect, it} from 'vitest';
import {groupPolygonRings, lineSegments, ringArea, triangulatePolygons} from '../src/mvt/triangulate.ts';
import {planTiles} from '../src/mvt/scheduler.ts';
import {parseCssColor} from '../src/renderers/mvt-webgl-renderer.ts';
import type {MvtFeature} from '../src/mvt/decode.ts';
import type {Viewport} from '../src/viewport.ts';

const outer: Array<[number, number]> = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];
const hole: Array<[number, number]> = [
  [2, 2],
  [2, 8],
  [8, 8],
  [8, 2],
];

function polygonFeature(rings: Array<Array<[number, number]>>): MvtFeature {
  return {type: 'polygon', paths: rings, properties: {}};
}

describe('ring orientation', () => {
  it('treats clockwise tile-space rings as exteriors', () => {
    expect(ringArea(outer)).toBeGreaterThan(0);
    expect(ringArea(hole)).toBeLessThan(0);
  });

  it('groups exteriors with their holes', () => {
    const polygons = groupPolygonRings([outer, hole]);
    expect(polygons).toHaveLength(1);
    expect(polygons[0]).toHaveLength(2);
  });
});

describe('triangulatePolygons', () => {
  it('triangulates a square into two triangles', () => {
    const mesh = triangulatePolygons([polygonFeature([outer])], 1);
    expect(mesh).not.toBeNull();
    expect(mesh!.positions).toHaveLength(8);
    expect(mesh!.indices).toHaveLength(6);
  });

  it('subtracts a hole', () => {
    const solid = triangulatePolygons([polygonFeature([outer])], 1)!;
    const holed = triangulatePolygons([polygonFeature([outer, hole])], 1)!;
    expect(holed.indices.length).toBeGreaterThan(solid.indices.length);
    expect(holed.indices.length % 3).toBe(0);
  });

  it('drops features smaller than a pixel', () => {
    expect(triangulatePolygons([polygonFeature([outer])], 0.001)).toBeNull();
  });

  it('handles empty input', () => {
    expect(triangulatePolygons([], 1)).toBeNull();
  });
});

describe('lineSegments', () => {
  it('emits a vertex pair per segment', () => {
    const mesh = lineSegments([
      {type: 'line', paths: [[[0, 0], [1, 1], [2, 2]]], properties: {}},
    ]);
    expect(mesh).not.toBeNull();
    expect(mesh!).toHaveLength(8); // 2 segments × 2 vertices × 2 coords
  });
});

describe('planTiles', () => {
  const view: Viewport = {
    zoom: 14.2,
    width: 1000,
    height: 800,
    dpr: 2,
    center: {lat: 34.08, lng: -118.6},
    bounds3857: [-1, 1, 1, 2],
    bounds4326: [-118.7, 34.0, -118.5, 34.15],
  };

  it('uses the native zoom and emits tiles covering the bbox', () => {
    const plan = planTiles(view, 0, 19, 0.15);
    expect(plan.z).toBe(14);
    expect(plan.tilePx).toBeCloseTo(256 * 2 ** 0.2, 5);
    expect(plan.tiles.length).toBeGreaterThan(0);
    for (const tile of plan.tiles) expect(tile.z).toBe(14);
  });

  it('clamps to the source zoom range', () => {
    expect(planTiles(view, 0, 12, 0.15).z).toBe(12);
    expect(planTiles(view, 16, 19, 0.15).z).toBe(16);
  });
});

describe('parseCssColor', () => {
  it('parses hex and rgba', () => {
    expect(parseCssColor('#ff0000')).toEqual([1, 0, 0, 1]);
    expect(parseCssColor('#00ff0080')[3]).toBeCloseTo(0.5, 2);
    const rgba = parseCssColor('rgba(0, 0, 255, 0.5)');
    expect(rgba[2]).toBeCloseTo(1, 5);
    expect(rgba[3]).toBeCloseTo(0.5, 5);
  });
});
