import {describe, expect, it} from 'vitest';
import {scaleToZoom, zoomRangeFromScales} from '../src/util/zoom.ts';

describe('scaleToZoom', () => {
  it('matches known Web Mercator zoom levels', () => {
    // 1:1000 is roughly zoom 19.2, 1:250 000 is roughly zoom 11.2.
    expect(scaleToZoom(1000)).toBeCloseTo(19.17, 1);
    expect(scaleToZoom(250_000)).toBeCloseTo(11.17, 1);
    expect(scaleToZoom(0)).toBeNaN();
  });

  it('converts a scale range', () => {
    const range = zoomRangeFromScales(50_000, 1000);
    expect(range).toEqual({minZoom: 14, maxZoom: 19});
  });

  it('treats zero as unbounded', () => {
    expect(zoomRangeFromScales(0, 0)).toEqual({minZoom: 0, maxZoom: 22});
  });

  it('never returns an inverted range', () => {
    const range = zoomRangeFromScales(1000, 1000);
    expect(range.maxZoom).toBeGreaterThanOrEqual(range.minZoom);
  });
});
