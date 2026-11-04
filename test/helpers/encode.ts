/**
 * Tiny protobuf writer used only by tests to build FeatureCollection payloads
 * without a protobuf dependency.
 */

export function varint(value: number | bigint): number[] {
  let v = BigInt(value);
  if (v < 0n) v += 1n << 64n;
  const out: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return out;
}

export function zigzag(value: number | bigint): number[] {
  const v = BigInt(value);
  return varint((v << 1n) ^ (v >> 63n));
}

function key(field: number, wire: number): number[] {
  return varint((field << 3) | wire);
}

export function fieldVarint(field: number, value: number | bigint): number[] {
  return [...key(field, 0), ...varint(value)];
}

export function fieldBool(field: number, value: boolean): number[] {
  return fieldVarint(field, value ? 1 : 0);
}

export function fieldDouble(field: number, value: number): number[] {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat64(0, value, true);
  return [...key(field, 1), ...new Uint8Array(buffer)];
}

export function fieldString(field: number, value: string): number[] {
  const bytes = [...new TextEncoder().encode(value)];
  return [...key(field, 2), ...varint(bytes.length), ...bytes];
}

export function fieldBytes(field: number, value: number[]): number[] {
  return [...key(field, 2), ...varint(value.length), ...value];
}

export function fieldMessage(field: number, value: number[]): number[] {
  return fieldBytes(field, value);
}

export function packedVarints(field: number, values: number[], encode: (value: number) => number[] = varint): number[] {
  const payload = values.flatMap((value) => encode(value));
  return fieldBytes(field, payload);
}

export function concat(...parts: number[][]): number[] {
  return parts.flat();
}

/** x/y scale + translate used by quantized responses. */
export function transform(options: {
  origin?: 'upperLeft' | 'lowerLeft';
  scale?: [number, number];
  translate?: [number, number];
} = {}): number[] {
  const scale = options.scale ?? [1, 1];
  const translate = options.translate ?? [0, 0];
  const scaleMessage = concat(
    fieldDouble(1, scale[0]),
    fieldDouble(2, scale[1]),
  );
  const translateMessage = concat(
    fieldDouble(1, translate[0]),
    fieldDouble(2, translate[1]),
  );
  return concat(
    fieldVarint(1, options.origin === 'lowerLeft' ? 1 : 0),
    fieldMessage(2, scaleMessage),
    fieldMessage(3, translateMessage),
  );
}

export function field(name: string, fieldType: number): number[] {
  return concat(fieldString(1, name), fieldVarint(2, fieldType));
}

export function valueString(value: string): number[] {
  return fieldString(1, value);
}

export function valueInt(value: number): number[] {
  return fieldVarint(4, value);
}

export function valueDouble(value: number): number[] {
  return fieldDouble(3, value);
}

export function geometryPoint(x: number, y: number): number[] {
  return concat(
    packedVarints(3, [x, y], zigzag),
  );
}

export function geometryPolyline(lengths: number[], coords: number[]): number[] {
  return concat(
    packedVarints(2, lengths),
    packedVarints(3, coords, zigzag),
  );
}

export function geometryPolygon(lengths: number[], coords: number[]): number[] {
  return concat(
    fieldVarint(1, 3),
    packedVarints(2, lengths),
    packedVarints(3, coords, zigzag),
  );
}

export function feature(attributes: number[][], geometry: number[] | null): number[] {
  const parts = attributes.map((attribute) => fieldMessage(1, attribute));
  if (geometry) parts.push(fieldMessage(2, geometry));
  return concat(...parts);
}

export function featureResult(options: {
  objectIdField?: string;
  exceeded?: boolean;
  geometryType?: number;
  transform?: number[];
  fields?: number[][];
  features?: number[][];
} = {}): number[] {
  const parts: number[][] = [
    fieldString(1, options.objectIdField ?? 'objectid'),
    fieldVarint(7, options.geometryType ?? 0),
    fieldBool(9, options.exceeded ?? false),
  ];
  if (options.transform) parts.push(fieldMessage(12, options.transform));
  for (const definition of options.fields ?? []) parts.push(fieldMessage(13, definition));
  for (const featureMessage of options.features ?? []) parts.push(fieldMessage(15, featureMessage));
  return concat(...parts);
}

export function featureCollection(featureResultMessage: number[]): Uint8Array {
  const queryResult = fieldMessage(1, featureResultMessage);
  const root = fieldMessage(2, queryResult);
  return new Uint8Array(root);
}
