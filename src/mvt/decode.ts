/**
 * Mapbox Vector Tile decoder.
 *
 * MVT is protobuf, but its geometry is command-encoded rather than the
 * quantized coordinate arrays Esri uses. Commands are `(count << 3) | id`:
 *
 *   1 MoveTo   — starts a path (or, for points, adds points)
 *   2 LineTo   — appends points
 *   7 ClosePath
 *
 * Parameters are zig-zag encoded deltas from the previous point.
 */

import {PbfReader, WIRE_LENGTH_DELIMITED} from '../pbf/reader.ts';
import type {Position} from '../pbf/decode.ts';

export type MvtGeometryType = 'point' | 'line' | 'polygon' | 'unknown';

export interface MvtFeature {
  id?: number;
  type: MvtGeometryType;
  /** Points: one path. Lines: one path per line. Polygons: one path per ring. */
  paths: Position[][];
  properties: Record<string, unknown>;
}

export interface MvtLayer {
  name: string;
  extent: number;
  version: number;
  features: MvtFeature[];
}

export interface MvtTile {
  layers: MvtLayer[];
}

const GEOMETRY_TYPES = ['unknown', 'point', 'line', 'polygon'] as const;

const MOVE_TO = 1;
const LINE_TO = 2;
const CLOSE_PATH = 7;
const DEFAULT_EXTENT = 4096;

export function decodeMvt(input: Uint8Array | ArrayBuffer): MvtTile {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const reader = new PbfReader(bytes);
  const layers: MvtLayer[] = [];

  while (!reader.eof) {
    const {field, wire} = reader.readTag();
    if (field === 3 && wire === WIRE_LENGTH_DELIMITED) {
      layers.push(decodeLayer(reader.readMessage()));
    } else {
      reader.skip(wire);
    }
  }

  return {layers};
}

function decodeLayer(reader: PbfReader): MvtLayer {
  let name = '';
  let extent = DEFAULT_EXTENT;
  let version = 1;
  const keys: string[] = [];
  const values: unknown[] = [];
  const featureBuffers: Uint8Array[] = [];

  while (!reader.eof) {
    const {field, wire} = reader.readTag();
    switch (field) {
      case 1:
        name = reader.readString();
        break;
      case 2:
        featureBuffers.push(reader.readBytes());
        break;
      case 3:
        keys.push(reader.readString());
        break;
      case 4:
        values.push(decodeValue(reader.readMessage()));
        break;
      case 5:
        extent = reader.readVarintNumber();
        break;
      case 15:
        version = reader.readVarintNumber();
        break;
      default:
        reader.skip(wire);
    }
  }

  const features = featureBuffers.map((buffer) => decodeFeature(new PbfReader(buffer), keys, values));
  return {name, extent: extent || DEFAULT_EXTENT, version, features};
}

function decodeFeature(
  reader: PbfReader,
  keys: string[],
  values: unknown[],
): MvtFeature {
  let id: number | undefined;
  let geometryType = 0;
  let tags: number[] = [];
  let commands: number[] = [];

  while (!reader.eof) {
    const {field, wire} = reader.readTag();
    switch (field) {
      case 1:
        id = reader.readVarintNumber();
        break;
      case 2:
        tags = wire === WIRE_LENGTH_DELIMITED ? reader.readPackedUint32() : [reader.readVarintNumber()];
        break;
      case 3:
        geometryType = reader.readVarintNumber();
        break;
      case 4:
        commands =
          wire === WIRE_LENGTH_DELIMITED ? reader.readPackedUint32() : [reader.readVarintNumber()];
        break;
      default:
        reader.skip(wire);
    }
  }

  const properties: Record<string, unknown> = {};
  for (let i = 0; i + 1 < tags.length; i += 2) {
    const key = keys[tags[i]!];
    if (key !== undefined) properties[key] = values[tags[i + 1]!] ?? null;
  }

  return {
    ...(id === undefined ? {} : {id}),
    type: GEOMETRY_TYPES[geometryType] ?? 'unknown',
    paths: decodeGeometry(commands, geometryType),
    properties,
  };
}

function decodeGeometry(commands: number[], geometryType: number): Position[][] {
  if (geometryType === 1) return decodePoints(commands);
  return decodePaths(commands, geometryType === 3);
}

function decodePoints(commands: number[]): Position[][] {
  const points: Position[] = [];
  let x = 0;
  let y = 0;

  for (let i = 0; i < commands.length; ) {
    const command = commands[i++]!;
    if ((command & 0x07) !== MOVE_TO) break;
    const count = command >> 3;
    for (let n = 0; n < count; n += 1) {
      x += zigzag(commands[i++]!);
      y += zigzag(commands[i++]!);
      points.push([x, y]);
    }
  }

  return points.length > 0 ? [points] : [];
}

function decodePaths(commands: number[], closeRings: boolean): Position[][] {
  const paths: Position[][] = [];
  let current: Position[] | null = null;
  let x = 0;
  let y = 0;

  for (let i = 0; i < commands.length; ) {
    const command = commands[i++]!;
    const id = command & 0x07;
    const count = command >> 3;

    if (id === MOVE_TO) {
      for (let n = 0; n < count; n += 1) {
        x += zigzag(commands[i++]!);
        y += zigzag(commands[i++]!);
        current = [[x, y]];
        paths.push(current);
      }
      continue;
    }

    if (id === LINE_TO) {
      if (!current) {
        current = [[x, y]];
        paths.push(current);
      }
      for (let n = 0; n < count; n += 1) {
        x += zigzag(commands[i++]!);
        y += zigzag(commands[i++]!);
        current.push([x, y]);
      }
      continue;
    }

    if (id === CLOSE_PATH && current) {
      const first = current[0]!;
      const last = current[current.length - 1]!;
      if (closeRings && (first[0] !== last[0] || first[1] !== last[1])) current.push([first[0], first[1]]);
    }
  }

  return paths;
}

function decodeValue(reader: PbfReader): unknown {
  let value: unknown = null;
  while (!reader.eof) {
    const {field, wire} = reader.readTag();
    switch (field) {
      case 1:
        value = reader.readString();
        break;
      case 2:
        value = reader.readFloat();
        break;
      case 3:
        value = reader.readDouble();
        break;
      case 4:
        value = reader.readInt64();
        break;
      case 5:
        value = reader.readUint64();
        break;
      case 6:
        value = reader.readSint64();
        break;
      case 7:
        value = reader.readBool();
        break;
      default:
        reader.skip(wire);
    }
  }
  return value;
}

function zigzag(value: number): number {
  return (value >>> 1) ^ -(value & 1);
}
