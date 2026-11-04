import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {decodeFeatureCollection, decodeParts, groupRings, signedArea} from '../src/pbf/decode.ts';
import {
  feature,
  featureCollection,
  featureResult,
  field,
  geometryPoint,
  geometryPolygon,
  transform,
  valueInt,
  valueString,
} from './helpers/encode.ts';

const fixture = readFileSync(new URL('./fixtures/service-requests.pbf', import.meta.url));

describe('decodeFeatureCollection', () => {
  it('decodes a real quantized point response', () => {
    const decoded = decodeFeatureCollection(fixture);

    expect(decoded.objectIdField).toBe('objectid');
    expect(decoded.geometryType).toBe('point');
    expect(decoded.exceededTransferLimit).toBe(true);
    expect(decoded.transform).toMatchObject({origin: 'upperLeft'});
    expect(decoded.features).toHaveLength(3);

    const [first] = decoded.features;
    expect(first!.attributes.objectid).toBe(2027111);
    expect(first!.geometry.type).toBe('point');

    const coordinates = (first!.geometry as {coordinates: [number, number]}).coordinates;
    // Values from the same query with f=geojson.
    expect(coordinates[0]).toBeCloseTo(-117.17902724850136, 4);
    expect(coordinates[1]).toBeCloseTo(34.0638396678731, 4);
  });

  it('applies the upper-left transform', () => {
    const payload = featureCollection(
      featureResult({
        transform: transform({origin: 'upperLeft', scale: [0.00001, 0.00001], translate: [-100, 40]}),
        fields: [field('name', 4)],
        features: [feature([valueString('a')], geometryPoint(1_000_000, 500_000))],
      }),
    );

    const decoded = decodeFeatureCollection(payload);
    const geometry = decoded.features[0]!.geometry as {coordinates: [number, number]};

    expect(geometry.coordinates[0]).toBeCloseTo(-90, 9);
    expect(geometry.coordinates[1]).toBeCloseTo(35, 9);
    expect(decoded.features[0]!.attributes.name).toBe('a');
  });

  it('applies the lower-left transform', () => {
    const payload = featureCollection(
      featureResult({
        transform: transform({origin: 'lowerLeft', scale: [1, 1], translate: [-100, 40]}),
        features: [feature([valueInt(7)], geometryPoint(10, 5))],
      }),
    );

    const decoded = decodeFeatureCollection(payload);
    const geometry = decoded.features[0]!.geometry as {coordinates: [number, number]};

    expect(geometry.coordinates).toEqual([-90, 45]);
  });

  it('rejects JSON responses', () => {
    const json = new TextEncoder().encode('{"error":{"message":"nope"}}');
    expect(() => decodeFeatureCollection(json)).toThrow(/not a PBF/i);
  });
});

describe('delta decoding', () => {
  // Example straight from the Esri FeatureCollection specification.
  const coords = [256, 256, 2, 0, 0, 2, -2, 0, 0, -2, 56, 56, 2, 0, 0, 2, -2, 0, 0, -2];
  const lengths = [5, 5];

  it('restarts the accumulator for every ring', () => {
    const parts = decodeParts(coords, lengths, 2);

    expect(parts).toEqual([
      [
        [256, 256],
        [258, 256],
        [258, 258],
        [256, 258],
        [256, 256],
      ],
      [
        [56, 56],
        [58, 56],
        [58, 58],
        [56, 58],
        [56, 56],
      ],
    ]);
  });

  it('decodes polygon rings through decodeFeatureCollection', () => {
    const payload = featureCollection(
      featureResult({
        geometryType: 3,
        features: [feature([valueInt(1)], geometryPolygon(lengths, coords))],
      }),
    );

    const decoded = decodeFeatureCollection(payload);
    const geometry = decoded.features[0]!.geometry as {rings: Array<Array<[number, number]>>};
    expect(geometry.rings).toHaveLength(2);
    expect(geometry.rings[1]![0]).toEqual([56, 56]);
  });
});

describe('groupRings', () => {
  it('nests counter-clockwise holes inside clockwise outer rings', () => {
    const outer: Array<[number, number]> = [
      [0, 0],
      [0, 10],
      [10, 10],
      [10, 0],
      [0, 0],
    ];
    const hole: Array<[number, number]> = [
      [2, 2],
      [8, 2],
      [8, 8],
      [2, 8],
      [2, 2],
    ];

    expect(signedArea(outer)).toBeLessThan(0);
    expect(signedArea(hole)).toBeGreaterThan(0);

    const polygons = groupRings([outer, hole]);
    expect(polygons).toHaveLength(1);
    expect(polygons[0]).toHaveLength(2);
  });

  it('falls back to containment when orientations are identical', () => {
    const outer: Array<[number, number]> = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ];
    const inner: Array<[number, number]> = [
      [2, 2],
      [2, 8],
      [8, 8],
      [8, 2],
      [2, 2],
    ];

    const polygons = groupRings([outer, inner]);
    expect(polygons).toHaveLength(1);
    expect(polygons[0]).toHaveLength(2);
  });
});
