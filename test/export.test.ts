import {describe, expect, it} from 'vitest';
import {needsExportRefresh} from '../src/renderers/export-renderer.ts';
import {esriJsonGeometryToPbf} from '../src/renderers/vector-renderer.ts';

type Box = [number, number, number, number];

const view = (x: number, width = 1000): {zoom: number; bounds3857: Box} => ({
  zoom: 10,
  bounds3857: [x, 0, x + width, width],
});

describe('needsExportRefresh', () => {
  const padding = 0.25;
  // An image covering the viewport plus 25% on every side.
  const image = {bbox: [-250, -250, 1250, 1250] as Box, zoom: 10};

  it('fetches the first image', () => {
    expect(needsExportRefresh(null, view(0), padding)).toBe(true);
  });

  it('keeps a covering image', () => {
    expect(needsExportRefresh(image, view(0), padding)).toBe(false);
    expect(needsExportRefresh(image, view(100), padding)).toBe(false);
  });

  it('refetches when zoom changes', () => {
    expect(needsExportRefresh(image, {zoom: 11, bounds3857: [0, 0, 1000, 1000]}, padding)).toBe(true);
  });

  it('refetches before the padding is fully consumed', () => {
    // 230px of the 250px margin is used: only 20px (8%) remains.
    expect(needsExportRefresh(image, view(230), padding)).toBe(true);
    // 100px used: 150px (60%) remains.
    expect(needsExportRefresh(image, view(100), padding)).toBe(false);
  });
});

describe('esriJsonGeometryToPbf', () => {
  it('converts points', () => {
    expect(esriJsonGeometryToPbf({x: -117.18, y: 34.05})).toEqual({
      type: 'point',
      coordinates: [-117.18, 34.05],
    });
  });

  it('converts multipoints, polylines and polygons', () => {
    expect(esriJsonGeometryToPbf({points: [[0, 0], [1, 1]]}).type).toBe('multipoint');
    expect(esriJsonGeometryToPbf({paths: [[[0, 0], [1, 1]]]}).type).toBe('polyline');

    const polygon = esriJsonGeometryToPbf({
      rings: [[[0, 0], [0, 1], [1, 1], [0, 0]]],
    });
    expect(polygon.type).toBe('polygon');
    if (polygon.type === 'polygon') expect(polygon.rings[0]).toHaveLength(4);
  });

  it('closes unclosed rings', () => {
    const polygon = esriJsonGeometryToPbf({rings: [[[0, 0], [0, 1], [1, 1]]]});
    if (polygon.type !== 'polygon') throw new Error('expected polygon');
    expect(polygon.rings[0]![0]).toEqual([0, 0]);
    expect(polygon.rings[0]![3]).toEqual([0, 0]);
  });

  it('returns none for missing geometry', () => {
    expect(esriJsonGeometryToPbf(undefined)).toEqual({type: 'none'});
  });
});
