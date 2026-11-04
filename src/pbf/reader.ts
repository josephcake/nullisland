/**
 * Minimal Protocol Buffers wire-format reader.
 *
 * nullisland decodes Esri's `FeatureCollectionPBuffer` directly so it has no
 * runtime dependency on protobufjs. The class only implements what the
 * FeatureCollection schema needs: varints, zig-zag, 32/64 bit fixed values,
 * length-delimited fields, and packed repeated fields.
 */

import {NullIslandError} from '../errors.ts';

export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_LENGTH_DELIMITED = 2;
export const WIRE_FIXED32 = 5;

const textDecoder = new TextDecoder('utf-8');

export interface Tag {
  field: number;
  wire: number;
}

export class PbfReader {
  readonly buffer: Uint8Array;
  private readonly view: DataView;
  private offset = 0;

  constructor(input: Uint8Array | ArrayBuffer) {
    if (input instanceof Uint8Array) {
      this.buffer = input;
      this.view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    } else {
      this.buffer = new Uint8Array(input);
      this.view = new DataView(input);
    }
  }

  get eof(): boolean {
    return this.offset >= this.buffer.length;
  }

  get position(): number {
    return this.offset;
  }

  readTag(): Tag {
    const tag = this.readVarintNumber();
    return {field: tag >>> 3, wire: tag & 0x07};
  }

  readVarint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.offset >= this.buffer.length) {
        throw new NullIslandError('Unexpected end of PBF buffer', 'NULLISLAND_PBF_TRUNCATED');
      }
      const byte = this.buffer[this.offset++]!;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 70n) {
        throw new NullIslandError('Malformed varint in PBF buffer', 'NULLISLAND_PBF_INVALID');
      }
    }
  }

  readVarintNumber(): number {
    return Number(this.readVarint());
  }

  readUint32(): number {
    return this.readVarintNumber();
  }

  readSint32(): number {
    return zigZag(this.readVarint());
  }

  readSint64(): number {
    return zigZag(this.readVarint());
  }

  readInt64(): number {
    const value = this.readVarint();
    return value >= 2n ** 63n ? Number(value - 2n ** 64n) : Number(value);
  }

  readUint64(): number {
    return Number(this.readVarint());
  }

  readBool(): boolean {
    return this.readVarintNumber() !== 0;
  }

  readFloat(): number {
    const value = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readDouble(): number {
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }

  readString(): string {
    return textDecoder.decode(this.readBytes());
  }

  readBytes(): Uint8Array {
    const length = this.readVarintNumber();
    const start = this.offset;
    const end = start + length;
    if (end > this.buffer.length) {
      throw new NullIslandError('PBF length-delimited field overruns buffer', 'NULLISLAND_PBF_TRUNCATED');
    }
    this.offset = end;
    return this.buffer.subarray(start, end);
  }

  /** Read a length-delimited message as a nested reader. */
  readMessage(): PbfReader {
    return new PbfReader(this.readBytes());
  }

  /** Packed `uint32` values. */
  readPackedUint32(): number[] {
    const reader = this.readMessage();
    const values: number[] = [];
    while (!reader.eof) values.push(reader.readVarintNumber());
    return values;
  }

  /** Packed `sint64` values (zig-zag decoded). */
  readPackedSint64(): number[] {
    const reader = this.readMessage();
    const values: number[] = [];
    while (!reader.eof) values.push(reader.readSint64());
    return values;
  }

  /** Packed `sint32` values (zig-zag decoded). */
  readPackedSint32(): number[] {
    const reader = this.readMessage();
    const values: number[] = [];
    while (!reader.eof) values.push(reader.readSint32());
    return values;
  }

  skip(wire: number): void {
    switch (wire) {
      case WIRE_VARINT:
        this.readVarint();
        return;
      case WIRE_FIXED64:
        this.offset += 8;
        return;
      case WIRE_LENGTH_DELIMITED: {
        const length = this.readVarintNumber();
        this.offset += length;
        if (this.offset > this.buffer.length) {
          throw new NullIslandError('PBF field overruns buffer', 'NULLISLAND_PBF_TRUNCATED');
        }
        return;
      }
      case WIRE_FIXED32:
        this.offset += 4;
        return;
      default:
        throw new NullIslandError(`Unsupported PBF wire type ${wire}`, 'NULLISLAND_PBF_INVALID');
    }
  }
}

function zigZag(value: bigint): number {
  return Number((value >> 1n) ^ -(value & 1n));
}
