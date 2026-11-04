/**
 * Decoder for Esri's `FeatureCollectionPBuffer` (the payload returned by
 * `query?f=pbf`).
 *
 * This is *not* Mapbox Vector Tiles. Coordinates arrive as quantized integers,
 * delta encoded per ring/path, and are mapped to world coordinates through the
 * transform included in the payload:
 *
 *   x = translateX + cx * scaleX
 *   y = translateY - cy * scaleY   (upper-left quantization origin)
 */

import {NullIslandError} from '../errors.ts';
import {PbfReader, WIRE_LENGTH_DELIMITED, WIRE_VARINT} from './reader.ts';

export type Position = [number, number];

export type PbfGeometry =
  | {type: 'point'; coordinates: Position}
  | {type: 'multipoint'; coordinates: Position[]}
  | {type: 'polyline'; paths: Position[][]}
  | {type: 'polygon'; rings: Position[][]}
  | {type: 'none'};

export type PbfFieldType =
  | 'smallInteger'
  | 'integer'
  | 'single'
  | 'double'
  | 'string'
  | 'date'
  | 'oid'
  | 'geometry'
  | 'blob'
  | 'raster'
  | 'guid'
  | 'globalId'
  | 'xml'
  | 'bigInteger'
  | 'dateOnly'
  | 'timeOnly'
  | 'timestampOffset'
  | 'unknown';

export interface PbfField {
  name: string;
  type: PbfFieldType;
  alias?: string;
}

export interface PbfFeature {
  attributes: Record<string, unknown>;
  geometry: PbfGeometry;
}

export interface DecodedFeatureCollection {
  objectIdField: string;
  geometryType: 'point' | 'multipoint' | 'polyline' | 'polygon' | 'multipatch' | 'envelope' | 'none';
  exceededTransferLimit: boolean;
  hasZ: boolean;
  hasM: boolean;
  transform: PbfTransform | null;
  fields: PbfField[];
  features: PbfFeature[];
}

export interface PbfTransform {
  origin: 'upperLeft' | 'lowerLeft';
  scaleX: number;
  scaleY: number;
  translateX: number;
  translateY: number;
}

const GEOMETRY_TYPES = [
  'point',
  'multipoint',
  'polyline',
  'polygon',
  'multipatch',
  'envelope',
] as const;

const FIELD_TYPES: PbfFieldType[] = [
  'smallInteger',
  'integer',
  'single',
  'double',
  'string',
  'date',
  'oid',
  'geometry',
  'blob',
  'raster',
  'guid',
  'globalId',
  'xml',
  'bigInteger',
  'dateOnly',
  'timeOnly',
  'timestampOffset',
];

/** Raised when a server answers `f=pbf` with something that is not protobuf. */
export class NotPbfError extends NullIslandError {
  constructor(message = 'Response was not a PBF FeatureCollection') {
    super(message, 'NULLISLAND_NOT_PBF');
    this.name = 'NotPbfError';
  }
}

/** Decode a `FeatureCollectionPBuffer` payload. */
export function decodeFeatureCollection(input: Uint8Array | ArrayBuffer): DecodedFeatureCollection {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length === 0) throw new NotPbfError('Empty PBF payload');
  // A JSON error document starts with '{'. Servers that do not implement
  // f=pbf often return JSON instead of failing with a 4xx.
  if (bytes[0] === 0x7b) throw new NotPbfError();

  const reader = new PbfReader(bytes);
  let queryResult: PbfReader | null = null;

  while (!reader.eof) {
    const {field, wire} = reader.readTag();
    if (field === 2 && wire === WIRE_LENGTH_DELIMITED) {
      queryResult = reader.readMessage();
    } else {
      reader.skip(wire);
    }
  }

  if (!queryResult) throw new NotPbfError('PBF payload has no query result');

  while (!queryResult.eof) {
    const {field, wire} = queryResult.readTag();
    if (field === 1 && wire === WIRE_LENGTH_DELIMITED) {
      return decodeFeatureResult(queryResult.readMessage());
    }
    queryResult.skip(wire);
  }

  throw new NotPbfError('PBF payload contains no feature result');
}

function decodeFeatureResult(reader: PbfReader): DecodedFeatureCollection {
  let objectIdField = 'objectid';
  // Proto3 default is 0 = point; servers omit default enums.
  let geometryType: DecodedFeatureCollection['geometryType'] = 'point';
  let exceededTransferLimit = false;
  let hasZ = false;
  let hasM = false;
  let transform: PbfTransform | null = null;
  const fields: PbfField[] = [];
  const featureBuffers: Uint8Array[] = [];

  while (!reader.eof) {
    const {field, wire} = reader.readTag();
    switch (field) {
      case 1:
        objectIdField = reader.readString();
        break;
      case 7:
        geometryType = GEOMETRY_TYPES[reader.readVarintNumber()] ?? 'none';
        break;
      case 9:
        exceededTransferLimit = reader.readBool();
        break;
      case 10:
        hasZ = reader.readBool();
        break;
      case 11:
        hasM = reader.readBool();
        break;
      case 12:
        transform = decodeTransform(reader.readMessage());
        break;
      case 13:
        fields.push(decodeField(reader.readMessage()));
        break;
      case 15:
        featureBuffers.push(reader.readBytes());
        break;
      default:
        reader.skip(wire);
    }
  }

  const stride = 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0);
  const features = featureBuffers.map((buffer) =>
    decodeFeature(new PbfReader(buffer), fields, transform, stride),
  );

  return {
    objectIdField,
    geometryType,
    exceededTransferLimit,
    hasZ,
    hasM,
    transform,
    fields,
    features,
  };
}

function decodeField(reader: PbfReader): PbfField {
  let name = '';
  let type: PbfFieldType = 'unknown';
  let alias: string | undefined;

  while (!reader.eof) {
    const {field, wire} = reader.readTag();
    switch (field) {
      case 1:
        name = reader.readString();
        break;
      case 2:
        type = FIELD_TYPES[reader.readVarintNumber()] ?? 'unknown';
        break;
      case 3:
        alias = reader.readString();
        break;
      default:
        reader.skip(wire);
    }
  }

  return alias === undefined ? {name, type} : {name, type, alias};
}

function decodeTransform(reader: PbfReader): PbfTransform {
  const transform: PbfTransform = {
    // Proto3 default is 0 = upperLeft, and the field is usually omitted.
    origin: 'upperLeft',
    scaleX: 1,
    scaleY: 1,
    translateX: 0,
    translateY: 0,
  };

  while (!reader.eof) {
    const {field, wire} = reader.readTag();
    if (field === 1) {
      transform.origin = reader.readVarintNumber() === 0 ? 'upperLeft' : 'lowerLeft';
      continue;
    }
    if (field === 2 && wire === WIRE_LENGTH_DELIMITED) {
      const scale = reader.readMessage();
      while (!scale.eof) {
        const tag = scale.readTag();
        if (tag.field === 1) transform.scaleX = scale.readDouble();
        else if (tag.field === 2) transform.scaleY = scale.readDouble();
        else scale.skip(tag.wire);
      }
      continue;
    }
    if (field === 3 && wire === WIRE_LENGTH_DELIMITED) {
      const translate = reader.readMessage();
      while (!translate.eof) {
        const tag = translate.readTag();
        if (tag.field === 1) transform.translateX = translate.readDouble();
        else if (tag.field === 2) transform.translateY = translate.readDouble();
        else translate.skip(tag.wire);
      }
      continue;
    }
    reader.skip(wire);
  }

  if (!Number.isFinite(transform.scaleX) || transform.scaleX === 0) transform.scaleX = 1;
  if (!Number.isFinite(transform.scaleY) || transform.scaleY === 0) transform.scaleY = 1;
  return transform;
}

function decodeFeature(
  reader: PbfReader,
  fields: PbfField[],
  transform: PbfTransform | null,
  stride: number,
): PbfFeature {
  const attributes: Record<string, unknown> = {};
  let attributeIndex = 0;
  let geometry: PbfGeometry = {type: 'none'};

  while (!reader.eof) {
    const {field, wire} = reader.readTag();
    switch (field) {
      case 1: {
        const value = decodeValue(reader.readMessage());
        const name = fields[attributeIndex]?.name;
        if (name) attributes[name] = value;
        attributeIndex += 1;
        break;
      }
      case 2:
        geometry = decodeGeometry(reader.readMessage(), transform, stride);
        break;
      default:
        reader.skip(wire);
    }
  }

  return {attributes, geometry};
}

function decodeValue(reader: PbfReader): unknown {
  let value: unknown = null;
  while (!reader.eof) {
    const {field, wire} = reader.readTag();
    switch (field) {
      case 1:
        if (wire === WIRE_LENGTH_DELIMITED) value = reader.readString();
        else reader.skip(wire);
        break;
      case 2:
        if (wire === 5) value = reader.readFloat();
        else reader.skip(wire);
        break;
      case 3:
        if (wire === 1) value = reader.readDouble();
        else reader.skip(wire);
        break;
      case 4:
      case 5:
      case 6:
      case 7:
      case 8:
      case 9:
        if (wire === WIRE_VARINT) value = readScalarValue(field, reader);
        else reader.skip(wire);
        break;
      case 10:
        value = null;
        if (wire === WIRE_VARINT) reader.readVarint();
        else reader.skip(wire);
        break;
      default:
        reader.skip(wire);
    }
  }
  return value;
}

function readScalarValue(field: number, reader: PbfReader): unknown {
  switch (field) {
    case 4:
      return reader.readSint32();
    case 5:
      return reader.readUint32();
    case 6:
      return reader.readInt64();
    case 7:
      return reader.readUint64();
    case 8:
      return reader.readSint64();
    case 9:
      return reader.readBool();
    default:
      return null;
  }
}

function decodeGeometry(reader: PbfReader, transform: PbfTransform | null, stride: number): PbfGeometry {
  let geometryType = 0;
  let lengths: number[] = [];
  let coords: number[] = [];

  while (!reader.eof) {
    const {field, wire} = reader.readTag();
    switch (field) {
      case 1:
        geometryType = reader.readVarintNumber();
        break;
      case 2:
        if (wire === WIRE_LENGTH_DELIMITED) lengths = reader.readPackedUint32();
        else lengths = [reader.readVarintNumber()];
        break;
      case 3:
        if (wire === WIRE_LENGTH_DELIMITED) coords = reader.readPackedSint64();
        else coords = [reader.readSint64()];
        break;
      default:
        reader.skip(wire);
    }
  }

  const parts = decodeParts(coords, lengths, stride, transform);

  switch (geometryType) {
    case 0: {
      const point = parts[0]?.[0];
      return point ? {type: 'point', coordinates: point} : {type: 'none'};
    }
    case 1:
      return {type: 'multipoint', coordinates: parts.flat()};
    case 2:
      return {type: 'polyline', paths: parts};
    case 3:
      return {type: 'polygon', rings: parts.map(closeRing)};
    default:
      return {type: 'none'};
  }
}

/**
 * Decode the flat coordinate array into parts.
 *
 * Delta encoding restarts for every part, so each ring/path is decoded
 * independently. This is also why a polygon's second ring does not inherit
 * the first ring's position.
 */
export function decodeParts(
  coords: number[],
  lengths: number[],
  stride: number,
  transform: PbfTransform | null = null,
): Position[][] {
  const counts = lengths.length > 0 ? lengths : [Math.floor(coords.length / Math.max(stride, 2))];
  const parts: Position[][] = [];
  let cursor = 0;

  for (const count of counts) {
    let x = 0;
    let y = 0;
    const part: Position[] = [];
    for (let vertex = 0; vertex < count; vertex += 1) {
      x += coords[cursor++] ?? 0;
      y += coords[cursor++] ?? 0;
      for (let extra = 2; extra < stride; extra += 1) cursor += 1;
      part.push(applyTransform(x, y, transform));
    }
    if (part.length > 0) parts.push(part);
  }

  return parts;
}

function applyTransform(x: number, y: number, transform: PbfTransform | null): Position {
  if (!transform) return [x, y];
  const px = transform.translateX + x * transform.scaleX;
  const py =
    transform.origin === 'upperLeft'
      ? transform.translateY - y * transform.scaleY
      : transform.translateY + y * transform.scaleY;
  return [px, py];
}

function closeRing(ring: Position[]): Position[] {
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (!first || !last) return ring;
  if (first[0] !== last[0] || first[1] !== last[1]) return [...ring, first];
  return ring;
}

/**
 * Split decoded coordinates into parts with a per-part delta accumulator.
 *
 * The public decoder above works on absolute positions, so this function is
 * only used internally by callers that need the delta start points. It is
 * exported for tests.
 */
export function decodeDeltaParts(coords: number[], lengths: number[], stride: number): Position[][] {
  return decodeParts(coords, lengths, stride, null);
}

/** Signed ring area. Esri emits outer rings clockwise (negative area). */
export function signedArea(ring: Position[]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    sum += ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1];
  }
  return sum / 2;
}

function pointInRing(point: Position, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    const intersects = yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Group polygon rings into polygons: outer ring first, followed by its holes.
 *
 * Esri orients outer rings clockwise and holes counter-clockwise. Some
 * services do not, so when every ring has the same orientation the first ring
 * is treated as the outer ring and later rings are nested by containment.
 */
export function groupRings(rings: Position[][]): Position[][][] {
  const closed = rings.map(closeRing).filter((ring) => ring.length >= 4);
  if (closed.length === 0) return [];

  const areas = closed.map((ring) => signedArea(ring));
  const hasClockwise = areas.some((area) => area < 0);

  if (!hasClockwise) {
    const outer = closed[0]!;
    const polygons: Position[][][] = [[outer]];
    for (let i = 1; i < closed.length; i += 1) {
      const ring = closed[i]!;
      const target = polygons.find((polygon) => pointInRing(ring[0]!, polygon[0]!));
      if (target) target.push(ring);
      else polygons.push([ring]);
    }
    return polygons;
  }

  const polygons: Position[][][] = [];
  const holes: Position[][] = [];

  closed.forEach((ring, index) => {
    if ((areas[index] ?? 0) <= 0) polygons.push([ring]);
    else holes.push(ring);
  });

  for (const hole of holes) {
    const target = polygons.find((polygon) => pointInRing(hole[0]!, polygon[0]!));
    if (target) target.push(hole);
    else if (polygons[0]) polygons[0].push(hole);
  }

  return polygons;
}
