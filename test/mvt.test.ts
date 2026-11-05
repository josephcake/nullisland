import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {decodeMvt} from '../src/mvt/decode.ts';
import {
  concat,
  fieldBytes,
  fieldMessage,
  fieldString,
  fieldVarint,
  varint,
  zigzag,
} from './helpers/encode.ts';

const fixture = readFileSync(new URL('./fixtures/parcels.pbf', import.meta.url));

function syntheticTile(): Uint8Array {
  // Square (0,0) (10,0) (10,10) (0,10), closed.
  const geometry: number[] = [];
  const raw = (value: number) => geometry.push(...varint(value));
  const delta = (value: number) => geometry.push(...zigzag(value));

  raw(9); // MoveTo, 1 point
  delta(0);
  delta(0);
  raw(10); // LineTo, 1 point
  delta(10);
  delta(0);
  raw(10);
  delta(0);
  delta(10);
  raw(10);
  delta(-10);
  delta(0);
  raw(7); // ClosePath

  const feature = concat(
    fieldVarint(3, 3), // polygon
    fieldBytes(2, [0, 0]), // tags: key 0 -> value 0
    fieldBytes(4, geometry),
  );

  const layer = concat(
    fieldString(1, 'parcels'),
    fieldMessage(2, feature),
    fieldString(3, 'kind'),
    fieldMessage(4, fieldString(1, 'parcel')),
    fieldVarint(5, 4096),
    fieldVarint(15, 2),
  );

  return new Uint8Array(fieldMessage(3, layer));
}

describe('decodeMvt', () => {
  it('decodes a real Esri vector tile', () => {
    const tile = decodeMvt(fixture);

    expect(tile.layers).toHaveLength(1);
    const layer = tile.layers[0]!;
    expect(layer.name).toBe('Santa_Monica_Mountains_Parcels');
    expect(layer.extent).toBe(4096);
    expect(layer.version).toBe(2);
    expect(layer.features).toHaveLength(2262);

    const first = layer.features[0]!;
    expect(first.type).toBe('polygon');
    expect(first.paths.length).toBeGreaterThan(0);
    expect(first.paths[0]!.length).toBeGreaterThan(2);
    expect(Object.keys(first.properties).length).toBeGreaterThan(0);
  });

  it('decodes command-encoded geometry and tags', () => {
    const tile = decodeMvt(syntheticTile());
    const layer = tile.layers[0]!;
    const feature = layer.features[0]!;

    expect(layer.name).toBe('parcels');
    expect(layer.extent).toBe(4096);
    expect(feature.type).toBe('polygon');
    expect(feature.properties).toEqual({kind: 'parcel'});
    expect(feature.paths[0]).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ]);
  });

  it('returns an empty tile for empty input', () => {
    expect(decodeMvt(new Uint8Array())).toEqual({layers: []});
  });
});
