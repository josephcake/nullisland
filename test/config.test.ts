import {describe, expect, it} from 'vitest';
import {
  deriveLayerId,
  hash,
  normalizeLayers,
  parseServiceUrl,
} from '../src/config.ts';
import {parseColor} from '../src/util/color.ts';

describe('parseServiceUrl', () => {
  it('parses a service root', () => {
    const parsed = parseServiceUrl('https://example.com/arcgis/rest/services/Census/FeatureServer');
    expect(parsed).toEqual({
      base: 'https://example.com/arcgis/rest/services/Census/FeatureServer',
      kind: 'FeatureServer',
      layerId: null,
    });
  });

  it('parses a layer url and strips the id', () => {
    const parsed = parseServiceUrl('https://example.com/arcgis/rest/services/USA/MapServer/2/');
    expect(parsed.kind).toBe('MapServer');
    expect(parsed.layerId).toBe(2);
    expect(parsed.base).toBe('https://example.com/arcgis/rest/services/USA/MapServer');
  });

  it('rejects non-ArcGIS urls', () => {
    expect(() => parseServiceUrl('https://example.com/not-a-service')).toThrow(/MapServer or FeatureServer/);
    expect(() => parseServiceUrl('ftp://example.com/FeatureServer')).toThrow(/http/);
    expect(() => parseServiceUrl('')).toThrow(/non-empty/);
  });
});

describe('normalizeLayers', () => {
  it('keeps valid layers and reports invalid ones', () => {
    const {layers, errors} = normalizeLayers([
      {url: 'https://example.com/arcgis/rest/services/A/FeatureServer'},
      {url: 'https://example.com/arcgis/rest/services/B/FeatureServer', opacity: 2},
      {url: 'https://example.com/arcgis/rest/services/C/MapServer', color: '#ff0000'},
    ]);

    expect(layers).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.index).toBe(1);
    expect(layers[1]!.color).toEqual([255, 0, 0, 255]);
  });

  it('derives unique ids', () => {
    const url = 'https://example.com/arcgis/rest/services/A/FeatureServer';
    const {layers} = normalizeLayers([{url}, {url}]);
    expect(layers[0]!.id).not.toBe(layers[1]!.id);
    expect(layers[1]!.id.endsWith('-2')).toBe(true);
  });

  it('validates zoom ranges', () => {
    const {errors} = normalizeLayers([
      {url: 'https://example.com/arcgis/rest/services/A/FeatureServer', minZoom: 10, maxZoom: 5},
    ]);
    expect(errors).toHaveLength(1);
  });

  it('defaults pagination and visibility', () => {
    const {layers} = normalizeLayers([
      {url: 'https://example.com/arcgis/rest/services/A/FeatureServer', visible: false},
    ]);
    const layer = layers[0]!;
    expect(layer.visible).toBe(false);
    expect(layer.maxFeatures).toBe(20_000);
    expect(layer.maxPages).toBe(10);
    expect(layer.mode).toBe('auto');
    expect(layer.opacity).toBe(1);
  });
});

describe('ids', () => {
  it('are stable and readable', () => {
    const service = parseServiceUrl('https://example.com/arcgis/rest/services/World_Parcels/FeatureServer/0');
    const id = deriveLayerId('https://example.com/arcgis/rest/services/World_Parcels/FeatureServer/0', service);
    expect(id.startsWith('world-parcels-0-')).toBe(true);

    const again = deriveLayerId('https://example.com/arcgis/rest/services/World_Parcels/FeatureServer/0', service);
    expect(again).toBe(id);
  });

  it('hashes deterministically', () => {
    expect(hash('abc')).toBe(hash('abc'));
    expect(hash('abc')).not.toBe(hash('abd'));
  });
});

describe('parseColor', () => {
  it('parses hex and rgba', () => {
    expect(parseColor('#f00')).toEqual([255, 0, 0, 255]);
    expect(parseColor('#ff000080')).toEqual([255, 0, 0, 128]);
    expect(parseColor([1, 2, 3, 4])).toEqual([1, 2, 3, 4]);
  });

  it('rejects nonsense', () => {
    expect(() => parseColor('#zzz')).toThrow(/Invalid color/);
    expect(() => parseColor([300, 0, 0, 255])).toThrow(/Invalid color channel/);
  });
});
