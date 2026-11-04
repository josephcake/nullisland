import {describe, expect, it} from 'vitest';
import type {ArcGisRenderer} from '../src/discovery.ts';
import {createStyleResolver} from '../src/style/translate.ts';
import type {RGBA} from '../src/types.ts';

function feature(properties: Record<string, unknown>): google.maps.Data.Feature {
  return {
    getProperty: (name: string) => properties[name],
  } as unknown as google.maps.Data.Feature;
}

function resolve(renderer: ArcGisRenderer, options: {
  color?: RGBA;
  geometryType?: string;
  opacity?: number;
} = {}) {
  const resolver = createStyleResolver({
    renderer,
    color: options.color,
    opacity: options.opacity ?? 1,
    geometryType: options.geometryType ?? 'esriGeometryPolygon',
    google: undefined,
  });
  return resolver;
}

describe('createStyleResolver', () => {
  it('uses the simple renderer symbol', () => {
    const resolver = resolve({
      type: 'simple',
      symbol: {
        type: 'esriSFS',
        color: [255, 0, 0, 255],
        outline: {color: [0, 0, 0, 255], width: 2},
      },
    });

    const style = resolver(feature({}));
    expect(style.fillColor).toBe('rgba(255, 0, 0, 1)');
    expect(style.strokeColor).toBe('rgba(0, 0, 0, 1)');
    expect(style.strokeWeight).toBe(2);
  });

  it('applies unique value renderers by field', () => {
    const resolver = resolve({
      type: 'uniqueValue',
      field1: 'kind',
      uniqueValueInfos: [
        {value: 'a', symbol: {type: 'esriSFS', color: [255, 0, 0, 255]}},
        {value: 'b', symbol: {type: 'esriSFS', color: [0, 255, 0, 255]}},
      ],
    });

    expect(resolver(feature({kind: 'b'})).fillColor).toBe('rgba(0, 255, 0, 1)');
  });

  it('applies class breaks', () => {
    const resolver = resolve({
      type: 'classBreaks',
      field1: 'pop',
      classBreakInfos: [
        {classMinValue: 0, classMaxValue: 100, symbol: {type: 'esriSFS', color: [0, 0, 255, 255]}},
        {classMinValue: 100, classMaxValue: 1000, symbol: {type: 'esriSFS', color: [255, 0, 0, 255]}},
      ],
    });

    expect(resolver(feature({pop: 42})).fillColor).toBe('rgba(0, 0, 255, 1)');
    expect(resolver(feature({pop: 500})).fillColor).toBe('rgba(255, 0, 0, 1)');
  });

  it('lets a configured color win over the service renderer', () => {
    const resolver = resolve(
      {
        type: 'simple',
        symbol: {type: 'esriSFS', color: [255, 0, 0, 255]},
      },
      {color: [0, 255, 0, 255]},
    );

    expect(resolver(feature({})).fillColor).toBe('rgba(0, 255, 0, 1)');
  });

  it('falls back to a default blue', () => {
    expect(resolve(null as unknown as ArcGisRenderer)(feature({})).fillColor).toBe('rgba(0, 102, 255, 1)');
  });

  it('uses stroke weight for polylines', () => {
    const resolver = resolve(
      {
        type: 'simple',
        symbol: {type: 'esriSLS', color: [10, 20, 30, 255], width: 3},
      },
      {geometryType: 'esriGeometryPolyline'},
    );

    const style = resolver(feature({}));
    expect(style.strokeWeight).toBe(3);
    expect(style.fillOpacity).toBe(0);
  });
});
