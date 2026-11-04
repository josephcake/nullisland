import {describe, expect, it} from 'vitest';
import {
  HALF_WORLD,
  bboxToMeters,
  clampBBoxToWorld,
  latToMeters,
  lngLatToWorld,
  lngToMeters,
  metersToBbox,
  metersToLat,
  metersToLng,
  normalizeLng,
  padBBox,
  splitBBox,
  worldToLngLat,
} from '../src/util/mercator.ts';

describe('web mercator', () => {
  it('maps the world corners', () => {
    expect(lngToMeters(180)).toBeCloseTo(HALF_WORLD, 3);
    expect(latToMeters(0)).toBe(0);
    expect(latToMeters(85.0511287798066)).toBeCloseTo(HALF_WORLD, 0);
  });

  it('round trips longitude and latitude', () => {
    for (const lng of [-179.9, -45, 0, 12.5, 179.9]) {
      expect(metersToLng(lngToMeters(lng))).toBeCloseTo(lng, 9);
    }
    for (const lat of [-84, -33.3, 0, 51.5, 84]) {
      expect(metersToLat(latToMeters(lat))).toBeCloseTo(lat, 9);
    }
  });

  it('round trips world coordinates', () => {
    const world = lngLatToWorld(-122.4194, 37.7749);
    const back = worldToLngLat(world.x, world.y);
    expect(back.lng).toBeCloseTo(-122.4194, 9);
    expect(back.lat).toBeCloseTo(37.7749, 9);
  });

  it('normalises longitudes', () => {
    expect(normalizeLng(190)).toBeCloseTo(-170, 9);
    expect(normalizeLng(-190)).toBeCloseTo(170, 9);
    expect(normalizeLng(180)).toBeCloseTo(-180, 9);
  });

  it('converts bboxes to metres and back', () => {
    const bbox = [-10, -20, 10, 20] as [number, number, number, number];
    const meters = bboxToMeters(bbox);
    const back = metersToBbox(meters);
    expect(back[0]).toBeCloseTo(-10, 6);
    expect(back[2]).toBeCloseTo(10, 6);
    expect(back[1]).toBeCloseTo(-20, 6);
    expect(back[3]).toBeCloseTo(20, 6);
  });

  it('pads bboxes by a fraction', () => {
    const padded = padBBox([0, 0, 10, 10], 0.25);
    expect(padded).toEqual([-2.5, -2.5, 12.5, 12.5]);
  });

  it('splits bboxes across the antimeridian', () => {
    const parts = splitBBox([179, -10, 181, 10]);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual([179, -10, 180, 10]);
    expect(parts[1]).toEqual([-180, -10, -179, 10]);
  });

  it('collapses world-spanning bboxes', () => {
    expect(splitBBox([-400, -80, 400, 80])).toEqual([[-180, -80, 180, 80]]);
  });

  it('clamps bboxes to the larger world portion', () => {
    const clamped = clampBBoxToWorld([179, -10, 181, 10]);
    expect(clamped[0]).toBe(179);
    expect(clamped[2]).toBe(180);
  });
});
