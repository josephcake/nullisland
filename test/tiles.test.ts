import {describe, expect, it} from 'vitest';
import {snapBBox, tileToBBox, tileX, tileY} from '../src/util/tiles.ts';

describe('tiles', () => {
  it('maps the whole world to tile 0/0/0', () => {
    const bbox = tileToBBox(0, 0, 0);
    expect(bbox[0]).toBe(-180);
    expect(bbox[2]).toBe(180);
    expect(bbox[1]).toBeCloseTo(-85.0511, 3);
    expect(bbox[3]).toBeCloseTo(85.0511, 3);
  });

  it('computes tile coordinates', () => {
    expect(tileX(-180, 0)).toBe(0);
    expect(tileX(180, 0)).toBe(1);
    expect(tileY(0, 0)).toBeCloseTo(0.5, 9);
  });

  it('snaps a viewport to a coarser grid', () => {
    const areas = snapBBox([-10, -10, 10, 10], 9);
    expect(areas).toHaveLength(1);

    const area = areas[0]!;
    // One zoom level coarser than the map.
    expect(area.z).toBe(8);
    expect(area.key.startsWith('8/')).toBe(true);

    // The snapped box must contain the original.
    expect(area.bbox[0]).toBeLessThanOrEqual(-10);
    expect(area.bbox[1]).toBeLessThanOrEqual(-10);
    expect(area.bbox[2]).toBeGreaterThanOrEqual(10);
    expect(area.bbox[3]).toBeGreaterThanOrEqual(10);
  });

  it('is stable for small pans', () => {
    const a = snapBBox([-10, -10, 10, 10], 9)[0]!;
    const b = snapBBox([-9.9, -9.95, 10.05, 10.02], 9)[0]!;
    expect(a.key).toBe(b.key);
  });

  it('produces two areas across the antimeridian', () => {
    const areas = snapBBox([179, -5, 181, 5], 6);
    expect(areas).toHaveLength(2);
    expect(areas[0]!.key).not.toBe(areas[1]!.key);
  });
});
