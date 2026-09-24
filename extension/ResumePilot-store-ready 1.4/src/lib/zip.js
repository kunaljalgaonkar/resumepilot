// ─────────────────────────────────────────────────────────────────────────
//  Minimal pure-JS ZIP reader/writer (no external dependencies).
//
//  Used for reading/writing .docx files (which are just ZIP archives of
//  XML parts). Writing always uses the "stored" (uncompressed) method —
//  this keeps the writer dependency-free and produces files that Word,
//  LibreOffice, and Google Docs all open without issue (compression is
//  optional per the ZIP/OOXML spec). Reading supports both "stored" and
//  "deflate" entries (real-world .docx files from Word use deflate), via
//  the standard DecompressionStream API.
// ─────────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function writeUint32LE(arr, offset, value) {
  arr[offset] = value & 0xff;
  arr[offset + 1] = (value >>> 8) & 0xff;
  arr[offset + 2] = (value >>> 16) & 0xff;
  arr[offset + 3] = (value >>> 24) & 0xff;
}

function writeUint16LE(arr, offset, value) {
  arr[offset] = value & 0xff;
  arr[offset + 1] = (value >>> 8) & 0xff;
}

function readUint32LE(arr, offset) {
  return (arr[offset] | (arr[offset + 1] << 8) | (arr[offset + 2] << 16) | (arr[offset + 3] << 24)) >>> 0;
}

function readUint16LE(arr, offset) {
  return arr[offset] | (arr[offset + 1] << 8);
}

function dosDateTime(date = new Date()) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  const dos = (((Math.max(0, date.getFullYear() - 1980)) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
  return { time, dos };
}

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Build a ZIP archive (stored/uncompressed entries) from a list of
 * { name, data } parts where data is a Uint8Array.
 * Returns a Uint8Array of the complete ZIP file.
 */
export function writeZip(entries) {
  const chunks = [];
  const centralRecords = [];
  let offset = 0;
  const { time, dos } = dosDateTime();
  const encoder = new TextEncoder();

  for (const { name, data } of entries) {
    const nameBytes = encoder.encode(name);
    const crc = crc32(data);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    writeUint32LE(localHeader, 0, 0x04034b50);
    writeUint16LE(localHeader, 4, 20);
    writeUint16LE(localHeader, 6, 0);
    writeUint16LE(localHeader, 8, 0); // stored
    writeUint16LE(localHeader, 10, time);
    writeUint16LE(localHeader, 12, dos);
    writeUint32LE(localHeader, 14, crc);
    writeUint32LE(localHeader, 18, data.length);
    writeUint32LE(localHeader, 22, data.length);
    writeUint16LE(localHeader, 26, nameBytes.length);
    writeUint16LE(localHeader, 28, 0);
    localHeader.set(nameBytes, 30);

    centralRecords.push({ nameBytes, crc, size: data.length, offset, time, dos });
    chunks.push(localHeader, data);
    offset += localHeader.length + data.length;
  }

  const cdStart = offset;
  for (const rec of centralRecords) {
    const central = new Uint8Array(46 + rec.nameBytes.length);
    writeUint32LE(central, 0, 0x02014b50);
    writeUint16LE(central, 4, 20);
    writeUint16LE(central, 6, 20);
    writeUint16LE(central, 8, 0);
    writeUint16LE(central, 10, 0); // stored
    writeUint16LE(central, 12, rec.time);
    writeUint16LE(central, 14, rec.dos);
    writeUint32LE(central, 16, rec.crc);
    writeUint32LE(central, 20, rec.size);
    writeUint32LE(central, 24, rec.size);
    writeUint16LE(central, 28, rec.nameBytes.length);
    writeUint16LE(central, 30, 0);
    writeUint16LE(central, 32, 0);
    writeUint16LE(central, 34, 0);
    writeUint16LE(central, 36, 0);
    writeUint32LE(central, 38, 0);
    writeUint32LE(central, 42, rec.offset);
    central.set(rec.nameBytes, 46);
    chunks.push(central);
    offset += central.length;
  }
  const cdSize = offset - cdStart;

  const eocd = new Uint8Array(22);
  writeUint32LE(eocd, 0, 0x06054b50);
  writeUint16LE(eocd, 4, 0);
  writeUint16LE(eocd, 6, 0);
  writeUint16LE(eocd, 8, centralRecords.length);
  writeUint16LE(eocd, 10, centralRecords.length);
  writeUint32LE(eocd, 12, cdSize);
  writeUint32LE(eocd, 16, cdStart);
  writeUint16LE(eocd, 20, 0);
  chunks.push(eocd);

  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

/**
 * Read a ZIP archive into a Map<filename, Uint8Array>.
 * Supports "stored" (method 0) and "deflate" (method 8) entries.
 */
export async function readZip(arrayBuffer) {
  const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);

  let eocdOffset = -1;
  const minOffset = Math.max(0, bytes.length - 22 - 65536);
  for (let i = bytes.length - 22; i >= minOffset; i--) {
    if (readUint32LE(bytes, i) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) throw new Error('Not a valid ZIP/DOCX file (no end-of-central-directory record found)');

  const cdCount = readUint16LE(bytes, eocdOffset + 10);
  const cdOffset = readUint32LE(bytes, eocdOffset + 16);

  const result = new Map();
  let p = cdOffset;
  const decoder = new TextDecoder('utf-8');

  for (let i = 0; i < cdCount; i++) {
    if (readUint32LE(bytes, p) !== 0x02014b50) break;
    const method = readUint16LE(bytes, p + 10);
    const compSize = readUint32LE(bytes, p + 20);
    const nameLen = readUint16LE(bytes, p + 28);
    const extraLen = readUint16LE(bytes, p + 30);
    const commentLen = readUint16LE(bytes, p + 32);
    const localOffset = readUint32LE(bytes, p + 42);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));

    const lfNameLen = readUint16LE(bytes, localOffset + 26);
    const lfExtraLen = readUint16LE(bytes, localOffset + 28);
    const dataStart = localOffset + 30 + lfNameLen + lfExtraLen;
    const compData = bytes.subarray(dataStart, dataStart + compSize);

    let data = null;
    if (method === 0) data = compData;
    else if (method === 8) {
      try { data = await inflateRaw(compData); } catch (_) { data = null; }
    }
    if (data) result.set(name, data);

    p += 46 + nameLen + extraLen + commentLen;
  }
  return result;
}
