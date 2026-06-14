// Minimal CBOR (RFC 8949) codec, only the subset the App Attest attestation
// object uses: unsigned integers, byte strings, text strings, arrays, and maps
// with text-string keys. Deliberately small and dependency-free; it rejects
// anything outside that subset rather than guess. decode() is used to parse the
// attestation object; encode() exists for tests that synthesize one.

class CBORError extends Error {}

function decode(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const reader = { view, pos: 0 };
  const value = readItem(reader);
  if (reader.pos !== view.length) {
    throw new CBORError("trailing bytes after CBOR item");
  }
  return value;
}

function readItem(reader) {
  const initial = readUint8(reader);
  const major = initial >> 5;
  const minor = initial & 0x1f;
  switch (major) {
    case 0: // unsigned integer
      return readLength(reader, minor);
    case 2: { // byte string
      const len = readLength(reader, minor);
      return readBytes(reader, len);
    }
    case 3: { // text string
      const len = readLength(reader, minor);
      return new TextDecoder().decode(readBytes(reader, len));
    }
    case 4: { // array
      const count = readLength(reader, minor);
      const out = [];
      for (let i = 0; i < count; i++) out.push(readItem(reader));
      return out;
    }
    case 5: { // map (text-string keys only)
      const count = readLength(reader, minor);
      const out = {};
      for (let i = 0; i < count; i++) {
        const key = readItem(reader);
        if (typeof key !== "string") {
          throw new CBORError("only text-string map keys are supported");
        }
        out[key] = readItem(reader);
      }
      return out;
    }
    default:
      throw new CBORError(`unsupported CBOR major type ${major}`);
  }
}

function readLength(reader, minor) {
  if (minor < 24) return minor;
  if (minor === 24) return readUint8(reader);
  if (minor === 25) return readUintN(reader, 2);
  if (minor === 26) return readUintN(reader, 4);
  if (minor === 27) {
    // 8-byte length: only safe-integer-sized values are accepted (attestation
    // fields are tiny, so anything larger is malformed/hostile).
    const hi = readUintN(reader, 4);
    const lo = readUintN(reader, 4);
    if (hi > 0x001fffff) throw new CBORError("CBOR length exceeds safe integer");
    return hi * 0x100000000 + lo;
  }
  throw new CBORError(`bad CBOR length encoding ${minor}`);
}

function readUint8(reader) {
  if (reader.pos >= reader.view.length) throw new CBORError("unexpected end of CBOR");
  return reader.view[reader.pos++];
}

function readUintN(reader, n) {
  let value = 0;
  for (let i = 0; i < n; i++) value = value * 256 + readUint8(reader);
  return value;
}

function readBytes(reader, len) {
  if (reader.pos + len > reader.view.length) throw new CBORError("CBOR byte run past end");
  const slice = reader.view.subarray(reader.pos, reader.pos + len);
  reader.pos += len;
  return slice;
}

// --- encode (for tests) ---

function encode(value) {
  const parts = [];
  writeItem(value, parts);
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function writeItem(value, parts) {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) throw new CBORError("only unsigned ints");
    writeTypeAndLength(0, value, parts);
  } else if (value instanceof Uint8Array) {
    writeTypeAndLength(2, value.length, parts);
    parts.push(value);
  } else if (typeof value === "string") {
    const utf8 = new TextEncoder().encode(value);
    writeTypeAndLength(3, utf8.length, parts);
    parts.push(utf8);
  } else if (Array.isArray(value)) {
    writeTypeAndLength(4, value.length, parts);
    for (const item of value) writeItem(item, parts);
  } else if (value && typeof value === "object") {
    const keys = Object.keys(value);
    writeTypeAndLength(5, keys.length, parts);
    for (const key of keys) {
      writeItem(key, parts);
      writeItem(value[key], parts);
    }
  } else {
    throw new CBORError(`cannot encode ${typeof value}`);
  }
}

function writeTypeAndLength(major, length, parts) {
  const head = major << 5;
  if (length < 24) {
    parts.push(new Uint8Array([head | length]));
  } else if (length < 0x100) {
    parts.push(new Uint8Array([head | 24, length]));
  } else if (length < 0x10000) {
    parts.push(new Uint8Array([head | 25, length >> 8, length & 0xff]));
  } else {
    parts.push(new Uint8Array([head | 26, (length >>> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]));
  }
}

export { decode, encode, CBORError };
