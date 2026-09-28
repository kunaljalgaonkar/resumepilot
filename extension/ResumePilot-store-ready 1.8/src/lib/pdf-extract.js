// ─────────────────────────────────────────────────────────────────────────
//  Pure-JS PDF text extraction.
//
//  No external dependencies (no pdfjs-dist). Relies only on standard Web
//  APIs available in Chrome extension pages: DecompressionStream, Blob,
//  Response, TextDecoder.
//
//  This implements a small subset of the PDF spec sufficient to pull
//  readable text out of typical "selectable text" PDFs (resumes exported
//  from Word, Google Docs, LibreOffice, Pages, Canva, etc.):
//    - object scanning ( N G obj ... endobj )
//    - dictionary / array / name / string / reference tokenizing
//    - FlateDecode stream decompression
//    - object streams (ObjStm) used by modern PDF writers
//    - page tree traversal (Catalog -> Pages -> Kids)
//    - content stream text operators (BT/ET, Tf, Td/TD/Tm/T*, Tj/TJ/'/")
//    - font decoding via /ToUnicode CMaps, /Differences encodings, and a
//      WinAnsi fallback for simple fonts
//
//  It will NOT handle: encrypted PDFs, scanned/image-only PDFs (no text
//  layer), or exotic non-conformant PDF structures. For those cases the
//  caller should fall back to the legacy raw-byte extractor and/or ask
//  the user to paste their resume text.
// ─────────────────────────────────────────────────────────────────────────

// ── byte <-> latin1 string helpers (1 char === 1 byte, lossless) ──────────
function bytesToLatin1(bytes) {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return out;
}

function latin1ToBytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

// ── inflate (zlib / FlateDecode) ───────────────────────────────────────────
async function inflate(bytes, raw = false) {
  const ds = new DecompressionStream(raw ? 'deflate-raw' : 'deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

async function flateDecode(bytes) {
  try {
    return await inflate(bytes, false);
  } catch (_) {
    try {
      return await inflate(bytes, true);
    } catch (_) {
      return null;
    }
  }
}

// ── small PDF object wrappers ──────────────────────────────────────────────
class PDFName { constructor(name) { this.name = name; } }
class PDFRef { constructor(num, gen) { this.num = num; this.gen = gen; } get key() { return `${this.num} ${this.gen}`; } }
class PDFKeyword { constructor(kw) { this.kw = kw; } }

function isName(v, name) { return v instanceof PDFName && v.name === name; }

// ── lexer ────────────────────────────────────────────────────────────────
const WS_RE = /[\s\0]/;
const DELIM_RE = /[()<>[\]{}/%]/;

class Lexer {
  constructor(s, pos = 0) {
    this.s = s;
    this.pos = pos;
    this.len = s.length;
  }

  skipWs() {
    while (this.pos < this.len) {
      const c = this.s[this.pos];
      if (c === '%') {
        while (this.pos < this.len && this.s[this.pos] !== '\n' && this.s[this.pos] !== '\r') this.pos++;
      } else if (WS_RE.test(c)) {
        this.pos++;
      } else break;
    }
  }

  next() {
    this.skipWs();
    if (this.pos >= this.len) return null;
    const c = this.s[this.pos];
    if (c === '/') return this.readName();
    if (c === '(') return this.readLiteralString();
    if (c === '<') {
      if (this.s[this.pos + 1] === '<') { this.pos += 2; return { t: 'dictStart' }; }
      return this.readHexString();
    }
    if (c === '>') {
      if (this.s[this.pos + 1] === '>') { this.pos += 2; return { t: 'dictEnd' }; }
      this.pos++; return { t: 'unknown', v: '>' };
    }
    if (c === '[') { this.pos++; return { t: 'arrStart' }; }
    if (c === ']') { this.pos++; return { t: 'arrEnd' }; }
    if (c === '{') { this.pos++; return { t: 'procStart' }; }
    if (c === '}') { this.pos++; return { t: 'procEnd' }; }
    if (/[+\-.0-9]/.test(c)) return this.readNumber();
    return this.readKeyword();
  }

  readName() {
    this.pos++;
    let out = '';
    while (this.pos < this.len) {
      const c = this.s[this.pos];
      if (WS_RE.test(c) || DELIM_RE.test(c)) break;
      if (c === '#' && /^[0-9A-Fa-f]{2}$/.test(this.s.substr(this.pos + 1, 2))) {
        out += String.fromCharCode(parseInt(this.s.substr(this.pos + 1, 2), 16));
        this.pos += 3;
      } else {
        out += c; this.pos++;
      }
    }
    return { t: 'name', v: out };
  }

  readLiteralString() {
    this.pos++; // skip (
    let depth = 1;
    const out = [];
    while (this.pos < this.len && depth > 0) {
      const c = this.s[this.pos];
      if (c === '\\') {
        const n = this.s[this.pos + 1];
        switch (n) {
          case 'n': out.push(10); this.pos += 2; break;
          case 'r': out.push(13); this.pos += 2; break;
          case 't': out.push(9); this.pos += 2; break;
          case 'b': out.push(8); this.pos += 2; break;
          case 'f': out.push(12); this.pos += 2; break;
          case '(': out.push(40); this.pos += 2; break;
          case ')': out.push(41); this.pos += 2; break;
          case '\\': out.push(92); this.pos += 2; break;
          case '\r':
            this.pos += 2;
            if (this.s[this.pos] === '\n') this.pos++;
            break;
          case '\n': this.pos += 2; break;
          default:
            if (/[0-7]/.test(n || '')) {
              let oct = n; this.pos += 2;
              for (let k = 0; k < 2; k++) {
                if (/[0-7]/.test(this.s[this.pos] || '')) { oct += this.s[this.pos]; this.pos++; } else break;
              }
              out.push(parseInt(oct, 8) & 0xff);
            } else {
              if (n != null) out.push(n.charCodeAt(0));
              this.pos += 2;
            }
        }
      } else if (c === '(') { depth++; out.push(40); this.pos++; }
      else if (c === ')') { depth--; this.pos++; if (depth > 0) out.push(41); }
      else { out.push(c.charCodeAt(0) & 0xff); this.pos++; }
    }
    return { t: 'str', v: Uint8Array.from(out) };
  }

  readHexString() {
    this.pos++; // skip <
    let hex = '';
    while (this.pos < this.len && this.s[this.pos] !== '>') {
      const c = this.s[this.pos];
      if (/[0-9A-Fa-f]/.test(c)) hex += c;
      this.pos++;
    }
    this.pos++; // skip >
    if (hex.length % 2) hex += '0';
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return { t: 'str', v: out };
  }

  readNumber() {
    let str = '';
    while (this.pos < this.len && /[+\-.0-9]/.test(this.s[this.pos])) { str += this.s[this.pos]; this.pos++; }
    const v = parseFloat(str);
    return { t: 'num', v: Number.isNaN(v) ? 0 : v };
  }

  readKeyword() {
    let str = '';
    while (this.pos < this.len) {
      const c = this.s[this.pos];
      if (WS_RE.test(c) || DELIM_RE.test(c)) break;
      str += c; this.pos++;
    }
    return { t: 'kw', v: str };
  }
}

// ── recursive-descent value parser (dicts / arrays / refs) ────────────────
function parseValue(lex) {
  const tok = lex.next();
  if (!tok) return undefined;
  return parseValueFromToken(tok, lex);
}

function parseValueFromToken(tok, lex) {
  switch (tok.t) {
    case 'dictStart': return parseDict(lex);
    case 'arrStart': return parseArray(lex);
    case 'name': return new PDFName(tok.v);
    case 'str': return tok.v;
    case 'num': {
      if (Number.isInteger(tok.v)) {
        const save = lex.pos;
        const t2 = lex.next();
        if (t2 && t2.t === 'num' && Number.isInteger(t2.v)) {
          const save2 = lex.pos;
          const t3 = lex.next();
          if (t3 && t3.t === 'kw' && t3.v === 'R') {
            return new PDFRef(tok.v, t2.v);
          }
          lex.pos = save2; // undo t3
        }
        lex.pos = save; // undo t2
      }
      return tok.v;
    }
    case 'kw':
      if (tok.v === 'true') return true;
      if (tok.v === 'false') return false;
      if (tok.v === 'null') return null;
      return new PDFKeyword(tok.v);
    default:
      return undefined;
  }
}

function parseDict(lex) {
  const map = new Map();
  while (true) {
    const tok = lex.next();
    if (!tok || tok.t === 'dictEnd') break;
    if (tok.t !== 'name') continue;
    const key = tok.v;
    const val = parseValue(lex);
    map.set(key, val);
  }
  return map;
}

function parseArray(lex) {
  const arr = [];
  while (true) {
    const tok = lex.next();
    if (!tok || tok.t === 'arrEnd') break;
    arr.push(parseValueFromToken(tok, lex));
  }
  return arr;
}

// ── scan the raw file for "N G obj ... endobj" ─────────────────────────────
function findEndstream(s, from) {
  const idx = s.indexOf('endstream', from);
  if (idx === -1) return s.length;
  let end = idx;
  while (end > from && (s[end - 1] === '\n' || s[end - 1] === '\r')) end--;
  return end;
}

function parseIndirectObjects(s) {
  const objects = new Map(); // "num gen" -> { dict|value, stream: Uint8Array|null }
  const re = /(\d+)[ \t\r\n]+(\d+)[ \t\r\n]+obj\b/g;
  let m;
  while ((m = re.exec(s))) {
    const num = parseInt(m[1], 10);
    const gen = parseInt(m[2], 10);
    const lex = new Lexer(s, re.lastIndex);
    let value;
    try {
      value = parseValue(lex);
    } catch (_) {
      continue;
    }
    lex.skipWs();
    let stream = null;
    if (s.substr(lex.pos, 6) === 'stream') {
      let p = lex.pos + 6;
      if (s[p] === '\r' && s[p + 1] === '\n') p += 2;
      else if (s[p] === '\n') p += 1;
      else if (s[p] === '\r') p += 1;

      let length = null;
      if (value instanceof Map) {
        const lenVal = value.get('Length');
        if (typeof lenVal === 'number') length = lenVal;
      }
      let endPos;
      if (length != null) {
        endPos = p + length;
        const tail = s.substr(endPos, 20);
        if (!/^[\s\0]*endstream/.test(tail)) endPos = findEndstream(s, p);
      } else {
        endPos = findEndstream(s, p);
      }
      stream = latin1ToBytes(s.slice(p, endPos));
      // advance scanner past this object so the regex doesn't pick up
      // numbers inside binary stream data as object headers
      re.lastIndex = Math.max(re.lastIndex, endPos);
    }
    objects.set(`${num} ${gen}`, { value, stream });
  }
  return objects;
}

// ── resolve references ─────────────────────────────────────────────────────
function resolve(val, objects) {
  let v = val;
  let guard = 0;
  while (v instanceof PDFRef && guard++ < 32) {
    const entry = objects.get(`${v.num} ${v.gen}`) || objects.get(`${v.num} 0`);
    v = entry ? entry.value : null;
  }
  return v;
}

function getStreamBytes(refOrEntryVal, objects) {
  let v = refOrEntryVal;
  let guard = 0;
  while (v instanceof PDFRef && guard++ < 32) {
    const entry = objects.get(`${v.num} ${v.gen}`) || objects.get(`${v.num} 0`);
    if (!entry) return null;
    if (entry.stream) return { dict: entry.value, stream: entry.stream };
    v = entry.value;
  }
  return null;
}

async function getDecodedStream(refOrEntryVal, objects) {
  const found = getStreamBytes(refOrEntryVal, objects);
  if (!found || !found.stream) return null;
  const { dict, stream } = found;
  let filters = dict instanceof Map ? dict.get('Filter') : null;
  if (filters instanceof PDFName) filters = [filters];
  if (!Array.isArray(filters)) filters = [];
  let data = stream;
  for (const f of filters) {
    if (isName(f, 'FlateDecode') || isName(f, 'Fl')) {
      const out = await flateDecode(data);
      if (!out) return null;
      data = out;
    } else if (isName(f, 'ASCIIHexDecode') || isName(f, 'AHx')) {
      data = decodeASCIIHex(data);
    } else if (isName(f, 'ASCII85Decode') || isName(f, 'A85')) {
      data = decodeASCII85(data);
    } else {
      // Unsupported filter (DCTDecode/CCITT/JBIG2/etc.) - bail
      return null;
    }
  }
  return { dict, data };
}

function decodeASCIIHex(bytes) {
  const s = bytesToLatin1(bytes).replace(/[^0-9A-Fa-f]/g, '');
  const out = new Uint8Array(Math.floor(s.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

function decodeASCII85(bytes) {
  const s = bytesToLatin1(bytes).replace(/\s/g, '').replace(/~>$/, '');
  const out = [];
  let group = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === 'z' && group.length === 0) { out.push(0, 0, 0, 0); continue; }
    group.push(c.charCodeAt(0) - 33);
    if (group.length === 5) {
      let n = 0;
      for (const g of group) n = n * 85 + g;
      out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
      group = [];
    }
  }
  if (group.length) {
    const padLen = 5 - group.length;
    for (let i = 0; i < padLen; i++) group.push(84);
    let n = 0;
    for (const g of group) n = n * 85 + g;
    const bytesOut = [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
    out.push(...bytesOut.slice(0, 4 - padLen));
  }
  return Uint8Array.from(out);
}

// ── expand compressed object streams (ObjStm) ──────────────────────────────
async function expandObjectStreams(objects) {
  const extra = [];
  for (const [, entry] of objects) {
    const dict = entry.value;
    if (!(dict instanceof Map) || !entry.stream) continue;
    if (!isName(dict.get('Type'), 'ObjStm')) continue;
    const decoded = await getDecodedStream(dict, new Map([['x', { value: dict, stream: entry.stream }]]).set('x', { value: dict, stream: entry.stream }));
    // getDecodedStream expects (ref|value, objects); pass the entry directly
    const direct = await (async () => {
      let filters = dict.get('Filter');
      if (filters instanceof PDFName) filters = [filters];
      if (!Array.isArray(filters)) filters = [];
      let data = entry.stream;
      for (const f of filters) {
        if (isName(f, 'FlateDecode') || isName(f, 'Fl')) {
          const out = await flateDecode(data);
          if (!out) return null;
          data = out;
        } else {
          return null;
        }
      }
      return data;
    })();
    if (!direct) continue;
    const n = dict.get('N');
    const first = dict.get('First');
    if (typeof n !== 'number' || typeof first !== 'number') continue;
    const headerStr = bytesToLatin1(direct.slice(0, first));
    const headerLex = new Lexer(headerStr, 0);
    const pairs = [];
    for (let i = 0; i < n; i++) {
      const a = headerLex.next();
      const b = headerLex.next();
      if (!a || !b || a.t !== 'num' || b.t !== 'num') break;
      pairs.push([a.v, b.v]);
    }
    const bodyStr = bytesToLatin1(direct.slice(first));
    for (const [objNum, offset] of pairs) {
      try {
        const lex = new Lexer(bodyStr, offset);
        const val = parseValue(lex);
        extra.push([`${objNum} 0`, { value: val, stream: null }]);
      } catch (_) { /* skip malformed sub-object */ }
    }
  }
  for (const [key, entry] of extra) {
    if (!objects.has(key)) objects.set(key, entry);
  }
}

// ── WinAnsi fallback for high bytes (0x80-0x9F differ from Latin-1) ─────────
const WINANSI_HIGH = {
  0x80: '\u20AC', 0x82: '\u201A', 0x83: '\u0192', 0x84: '\u201E', 0x85: '\u2026',
  0x86: '\u2020', 0x87: '\u2021', 0x88: '\u02C6', 0x89: '\u2030', 0x8A: '\u0160',
  0x8B: '\u2039', 0x8C: '\u0152', 0x8E: '\u017D', 0x91: '\u2018', 0x92: '\u2019',
  0x93: '\u201C', 0x94: '\u201D', 0x95: '\u2022', 0x96: '\u2013', 0x97: '\u2014',
  0x98: '\u02DC', 0x99: '\u2122', 0x9A: '\u0161', 0x9B: '\u203A', 0x9C: '\u0153',
  0x9E: '\u017E', 0x9F: '\u0178'
};
function winAnsiChar(code) {
  if (code in WINANSI_HIGH) return WINANSI_HIGH[code];
  return String.fromCharCode(code); // 0xA0-0xFF matches Latin-1
}

// ── Adobe Glyph List subset for /Differences without /ToUnicode ────────────
const GLYPH_NAME_MAP = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%',
  ampersand: '&', quotesingle: "'", quoteright: '\u2019', parenleft: '(', parenright: ')',
  asterisk: '*', plus: '+', comma: ',', hyphen: '-', minus: '\u2212', period: '.', slash: '/',
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7',
  eight: '8', nine: '9', colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>',
  question: '?', at: '@', bracketleft: '[', backslash: '\\', bracketright: ']',
  asciicircum: '^', underscore: '_', grave: '`', braceleft: '{', bar: '|', braceright: '}',
  asciitilde: '~', bullet: '\u2022', endash: '\u2013', emdash: '\u2014',
  quoteleft: '\u2018', quotedblleft: '\u201C', quotedblright: '\u201D',
  ellipsis: '\u2026', trademark: '\u2122', copyright: '\u00A9', registered: '\u00AE',
  degree: '\u00B0', plusminus: '\u00B1', divide: '\u00F7', multiply: '\u00D7',
  section: '\u00A7', paragraph: '\u00B6', dagger: '\u2020', daggerdbl: '\u2021',
  AE: '\u00C6', ae: '\u00E6', oslash: '\u00F8', Oslash: '\u00D8', eacute: '\u00E9',
  egrave: '\u00E8', agrave: '\u00E0', ccedilla: '\u00E7', ntilde: '\u00F1',
  uuml: '\u00FC', ouml: '\u00F6', auml: '\u00E4'
};
function glyphNameToChar(name) {
  if (Object.prototype.hasOwnProperty.call(GLYPH_NAME_MAP, name)) return GLYPH_NAME_MAP[name];
  if (/^[A-Za-z]$/.test(name)) return name;
  return '';
}

// ── ToUnicode CMap parsing ──────────────────────────────────────────────────
function hexBytesToUnicode(bytes) {
  // Interpret as a sequence of UTF-16BE code units.
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  }
  if (bytes.length % 2 === 1) out += String.fromCharCode(bytes[bytes.length - 1]);
  return out;
}

function parseToUnicodeCMap(text) {
  const map = new Map(); // code (number) -> unicode string
  const lex = new Lexer(text, 0);
  let mode = null; // 'bfchar' | 'bfrange' | null
  let pending = []; // tokens accumulated for the current entry

  while (true) {
    const tok = lex.next();
    if (!tok) break;

    if (tok.t === 'kw') {
      if (tok.v === 'beginbfchar') { mode = 'bfchar'; pending = []; continue; }
      if (tok.v === 'beginbfrange') { mode = 'bfrange'; pending = []; continue; }
      if (tok.v === 'endbfchar' || tok.v === 'endbfrange') { mode = null; pending = []; continue; }
      continue;
    }

    if (!mode) continue; // ignore anything outside a bfchar/bfrange block

    if (mode === 'bfchar') {
      if (tok.t !== 'str') continue;
      pending.push(tok.v);
      if (pending.length === 2) {
        const [srcBytes, dstBytes] = pending;
        let code = 0;
        for (const b of srcBytes) code = code * 256 + b;
        map.set(code, hexBytesToUnicode(dstBytes));
        pending = [];
      }
      continue;
    }

    // mode === 'bfrange': "<start> <end> <dst>" or "<start> <end> [ <d1> <d2> ... ]"
    if (tok.t === 'str') {
      pending.push(tok.v);
      if (pending.length === 3) {
        const [startBytes, endBytes, dstBytes] = pending;
        let start = 0; for (const b of startBytes) start = start * 256 + b;
        let end = 0; for (const b of endBytes) end = end * 256 + b;
        if (end >= start && end - start < 65536) {
          let dstCode = 0; for (const b of dstBytes) dstCode = dstCode * 256 + b;
          for (let c = start; c <= end; c++) map.set(c, String.fromCharCode(dstCode + (c - start)));
        }
        pending = [];
      }
    } else if (tok.t === 'arrStart') {
      const arr = [];
      while (true) {
        const t2 = lex.next();
        if (!t2 || t2.t === 'arrEnd') break;
        if (t2.t === 'str') arr.push(hexBytesToUnicode(t2.v));
      }
      if (pending.length === 2) {
        const startBytes = pending[0];
        let start = 0; for (const b of startBytes) start = start * 256 + b;
        for (let i = 0; i < arr.length; i++) map.set(start + i, arr[i]);
      }
      pending = [];
    }
  }

  return map;
}

// ── build a font lookup table for a /Resources /Font dict ──────────────────
async function buildFontInfo(fontDict, objects) {
  const info = { bytesPerCode: 1, map: new Map(), diffMap: new Map() };
  if (!(fontDict instanceof Map)) return info;

  const subtype = fontDict.get('Subtype');
  if (isName(subtype, 'Type0')) {
    info.bytesPerCode = 2;
    const encoding = fontDict.get('Encoding');
    if (encoding instanceof PDFName && /Identity/.test(encoding.name)) info.bytesPerCode = 2;
  }

  // /Encoding /Differences (simple fonts)
  const encoding = resolve(fontDict.get('Encoding'), objects);
  if (encoding instanceof Map) {
    const diffs = encoding.get('Differences');
    if (Array.isArray(diffs)) {
      let code = 0;
      for (const item of diffs) {
        if (typeof item === 'number') code = item;
        else if (item instanceof PDFName) { info.diffMap.set(code, glyphNameToChar(item.name)); code++; }
      }
    }
  }

  // /ToUnicode CMap (most reliable)
  const toUni = fontDict.get('ToUnicode');
  if (toUni) {
    try {
      const decoded = await getDecodedStream(toUni, objects);
      if (decoded) {
        const text = bytesToLatin1(decoded.data);
        const map = parseToUnicodeCMap(text);
        if (map.size) info.map = map;
      }
    } catch (_) { /* ignore */ }
  }

  return info;
}

// ── decode a PDF string operand using a font's code map ────────────────────
function decodeTextString(bytes, font) {
  let out = '';
  if (font.bytesPerCode === 2) {
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const code = (bytes[i] << 8) | bytes[i + 1];
      if (font.map.has(code)) out += font.map.get(code);
      else if (code >= 32 && code <= 126) out += String.fromCharCode(code);
    }
    if (bytes.length % 2 === 1) {
      const code = bytes[bytes.length - 1];
      if (font.map.has(code)) out += font.map.get(code);
    }
  } else {
    for (let i = 0; i < bytes.length; i++) {
      const code = bytes[i];
      if (font.map.has(code)) { out += font.map.get(code); continue; }
      if (font.diffMap.has(code)) { out += font.diffMap.get(code); continue; }
      if (code >= 32 && code <= 126) { out += String.fromCharCode(code); continue; }
      if (code >= 128) { out += winAnsiChar(code); continue; }
      // control characters (tab, etc.) — ignore
    }
  }
  return out;
}

// ── extract text from a single content stream ──────────────────────────────
function extractTextFromContentStream(streamStr, fontMap) {
  const lex = new Lexer(streamStr, 0);
  let out = '';
  let operands = [];
  let currentFont = { bytesPerCode: 1, map: new Map(), diffMap: new Map() };
  let inText = false;
  let lineY = 0; // running Y position of the current text line, in text space

  const flushOperands = () => { operands = []; };
  const appendNewlineIfNeeded = () => {
    if (out.length && !out.endsWith('\n')) out += '\n';
  };
  // Word/LibreOffice-style exporters often reposition with Td/Tm for every
  // word (or even mid-word, at hyphenation points) purely for horizontal
  // kerning/justification, with ty == 0 (no vertical movement at all). Only
  // a real vertical move means a new line; a same-line horizontal nudge
  // should get a space (so words don't run together) instead of a newline.
  const handleLineMove = (newY) => {
    if (!inText) return;
    if (Math.abs(newY - lineY) > 1) {
      appendNewlineIfNeeded();
    } else if (out.length && !/\s$/.test(out)) {
      out += ' ';
    }
    lineY = newY;
  };

  while (true) {
    const tok = lex.next();
    if (!tok) break;

    if (tok.t === 'kw') {
      switch (tok.v) {
        case 'BT':
          // Note: deliberately NOT resetting lineY here. Many PDF
          // generators (Word, LibreOffice) emit a fresh BT/ET pair per
          // word or even per hyphenation fragment, each setting an
          // absolute position via Tm — comparing against the running Y
          // from the previous block is what correctly detects "still the
          // same visual line" across those block boundaries.
          inText = true; flushOperands(); break;
        case 'ET':
          // Deliberately NOT forcing a newline here, for the same reason —
          // the next block's Tm/Td will decide via handleLineMove whether
          // a real line change happened.
          inText = false; flushOperands(); break;
        case 'Tf': {
          const fontName = operands[operands.length - 2];
          if (fontName instanceof PDFName && fontMap.has(fontName.name)) {
            currentFont = fontMap.get(fontName.name);
          }
          flushOperands(); break;
        }
        case 'Td': case 'TD': {
          // "tx ty Td" — ty is relative to the previous line's origin, so it
          // accumulates onto the running line Y.
          const ty = operands[operands.length - 1];
          handleLineMove(lineY + (typeof ty === 'number' ? ty : 0));
          flushOperands(); break;
        }
        case 'Tm': {
          // "a b c d e f Tm" sets the matrix directly — f is the new
          // absolute Y translation (no rotation assumed, the common case).
          const f = operands[operands.length - 1];
          handleLineMove(typeof f === 'number' ? f : lineY);
          flushOperands(); break;
        }
        case "T*":
          // Explicit "move to next line" — always a real line break.
          if (inText) appendNewlineIfNeeded();
          flushOperands(); break;
        case 'Tj': {
          const s = operands[operands.length - 1];
          if (s instanceof Uint8Array) out += decodeTextString(s, currentFont);
          flushOperands(); break;
        }
        case "'": case '"': {
          if (inText) appendNewlineIfNeeded();
          const s = operands[operands.length - 1];
          if (s instanceof Uint8Array) out += decodeTextString(s, currentFont);
          flushOperands(); break;
        }
        case 'TJ': {
          const arr = operands[operands.length - 1];
          if (Array.isArray(arr)) {
            for (const item of arr) {
              if (item instanceof Uint8Array) out += decodeTextString(item, currentFont);
              else if (typeof item === 'number' && item <= -100) out += ' ';
            }
          }
          flushOperands(); break;
        }
        default:
          flushOperands(); break;
      }
    } else {
      operands.push(parseValueFromToken(tok, lex));
      if (operands.length > 64) operands = operands.slice(-8); // safety valve
    }
  }
  return out;
}

// ── page tree traversal ─────────────────────────────────────────────────────
function findCatalog(objects) {
  for (const [, entry] of objects) {
    if (entry.value instanceof Map && isName(entry.value.get('Type'), 'Catalog')) return entry.value;
  }
  return null;
}

function collectPages(pagesNode, objects, inheritedResources, out, guard) {
  if (!(pagesNode instanceof Map) || guard.n++ > 5000) return;
  const resources = pagesNode.get('Resources') || inheritedResources;
  if (isName(pagesNode.get('Type'), 'Page')) {
    out.push({ page: pagesNode, resources });
    return;
  }
  const kids = resolve(pagesNode.get('Kids'), objects);
  if (Array.isArray(kids)) {
    for (const kidRef of kids) {
      const kid = resolve(kidRef, objects);
      collectPages(kid, objects, resources, out, guard);
    }
  }
}

function getAllPagesFallback(objects) {
  const pages = [];
  for (const [, entry] of objects) {
    if (entry.value instanceof Map && isName(entry.value.get('Type'), 'Page')) {
      pages.push({ page: entry.value, resources: entry.value.get('Resources') });
    }
  }
  return pages;
}

// Recovers actual hyperlink URLs from PDF link annotations — plain text
// extraction only ever sees the clickable LABEL ("Portfolio", "LinkedIn"),
// never the URL behind it, since that lives in a separate /Annots entry,
// not in the page's text content stream at all.
// Returns [{ uri, pageIndex, topFraction }] — topFraction is how close to
// the top of its page the link sits (0 = very top, 1 = very bottom), which
// callers use to tell a contact-header link apart from an unrelated link
// mentioned somewhere in the body (e.g. a project's URL in a bullet).
export async function extractPDFLinks(arrayBuffer) {
  try {
    const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
    const s = bytesToLatin1(bytes);
    if (/\/Encrypt\b/.test(s.slice(0, 200000))) return [];

    const objects = parseIndirectObjects(s);
    await expandObjectStreams(objects);

    let pages = [];
    const catalog = findCatalog(objects);
    if (catalog) {
      const pagesRoot = resolve(catalog.get('Pages'), objects);
      collectPages(pagesRoot, objects, null, pages, { n: 0 });
    }
    if (!pages.length) pages = getAllPagesFallback(objects);

    const results = [];
    pages.forEach(({ page }, pageIndex) => {
      const mediaBox = resolve(page.get('MediaBox'), objects);
      const pageHeight = Array.isArray(mediaBox) && typeof mediaBox[3] === 'number' ? mediaBox[3] : 792;

      const annots = resolve(page.get('Annots'), objects);
      if (!Array.isArray(annots)) return;
      for (const annotRef of annots) {
        const annot = resolve(annotRef, objects);
        if (!(annot instanceof Map) || !isName(annot.get('Subtype'), 'Link')) continue;
        const action = resolve(annot.get('A'), objects);
        if (!(action instanceof Map) || !isName(action.get('S'), 'URI')) continue;
        const uriVal = action.get('URI');
        const uri = (uriVal instanceof Uint8Array ? bytesToLatin1(uriVal) : String(uriVal || '')).trim();
        if (!uri) continue;

        const rect = resolve(annot.get('Rect'), objects);
        let topFraction = 0; // default to "near the top" if we can't tell — safer than excluding it
        if (Array.isArray(rect) && typeof rect[3] === 'number' && pageHeight > 0) {
          topFraction = Math.max(0, Math.min(1, 1 - (rect[3] / pageHeight)));
        }
        results.push({ uri, pageIndex, topFraction });
      }
    });

    // De-dupe identical URIs, keeping the topmost occurrence
    const byUri = new Map();
    for (const r of results) {
      const existing = byUri.get(r.uri);
      if (!existing || (r.pageIndex < existing.pageIndex) || (r.pageIndex === existing.pageIndex && r.topFraction < existing.topFraction)) {
        byUri.set(r.uri, r);
      }
    }
    return [...byUri.values()];
  } catch (_) {
    return [];
  }
}

// Classifies extracted links into contact-header fields. Only considers
// links on the first page, near the top (within the top ~25% — comfortably
// covers a name+contact header block while excluding body/project links
// further down the same page).
export function classifyContactLinks(links) {
  const result = { linkedin: '', portfolio: '', github: '' };
  const headerLinks = (links || []).filter(l => l.pageIndex === 0 && l.topFraction <= 0.25 && !/^mailto:/i.test(l.uri));

  for (const l of headerLinks) {
    if (/linkedin\.com/i.test(l.uri) && !result.linkedin) result.linkedin = l.uri;
    else if (/github\.com\/[^/]+\/?$/i.test(l.uri) && !result.github) result.github = l.uri;
  }
  // Whatever header link is left that isn't LinkedIn/plain-GitHub-profile is
  // treated as the portfolio link (personal site, GitHub Pages, etc).
  for (const l of headerLinks) {
    if (l.uri === result.linkedin || l.uri === result.github) continue;
    if (!result.portfolio) result.portfolio = l.uri;
  }
  return result;
}

// ── main entry point ────────────────────────────────────────────────────────
export async function extractTextFromPDF(arrayBuffer) {
  const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
  const s = bytesToLatin1(bytes);

  // Bail early on encrypted PDFs — we don't implement decryption.
  if (/\/Encrypt\b/.test(s.slice(0, 200000))) {
    const err = new Error('This PDF is password-protected or encrypted and cannot be read automatically.');
    err.code = 'PDF_ENCRYPTED';
    throw err;
  }

  const objects = parseIndirectObjects(s);
  await expandObjectStreams(objects);

  let pages = [];
  const catalog = findCatalog(objects);
  if (catalog) {
    const pagesRoot = resolve(catalog.get('Pages'), objects);
    collectPages(pagesRoot, objects, null, pages, { n: 0 });
  }
  if (!pages.length) pages = getAllPagesFallback(objects);

  const pageTexts = [];
  for (const { page, resources } of pages) {
    const res = resolve(resources, objects);
    const fontMap = new Map();
    if (res instanceof Map) {
      const fonts = resolve(res.get('Font'), objects);
      if (fonts instanceof Map) {
        for (const [fname, fref] of fonts) {
          const fdict = resolve(fref, objects);
          try {
            fontMap.set(fname, await buildFontInfo(fdict, objects));
          } catch (_) { /* skip this font */ }
        }
      }
    }

    let contents = resolve(page.get('Contents'), objects);
    if (!Array.isArray(contents)) contents = contents ? [page.get('Contents')] : [];

    let pageStr = '';
    for (const c of contents) {
      try {
        const decoded = await getDecodedStream(c, objects);
        if (decoded) pageStr += bytesToLatin1(decoded.data) + '\n';
      } catch (_) { /* skip */ }
    }
    if (pageStr) {
      const text = extractTextFromContentStream(pageStr, fontMap);
      if (text.trim()) pageTexts.push(text.trim());
    }
  }

  return pageTexts.join('\n\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// ── legacy fallback: scan raw bytes for literal (text) Tj / [..] TJ ─────────
// Useful for older, fully-uncompressed PDFs where text operators appear as
// plain bytes in the file (no FlateDecode).
export function extractTextFromPDFLegacy(arrayBuffer) {
  try {
    const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
    const raw = bytesToLatin1(bytes);
    let text = '';

    const tjRe = /\(((?:[^()\\]|\\.)*)\)\s*Tj/g;
    const tjRe2 = /\[((?:[^\][\\]|\\.)*)\]\s*TJ/g;
    let m;

    while ((m = tjRe.exec(raw)) !== null) {
      const s = unescapePdfLiteral(m[1]);
      if (/[a-zA-Z]/.test(s)) text += s + ' ';
    }
    while ((m = tjRe2.exec(raw)) !== null) {
      const inner = m[1].replace(/\(((?:[^()\\]|\\.)*)\)/g, (_, g) => unescapePdfLiteral(g) + ' ');
      if (/[a-zA-Z]/.test(inner)) text += inner + '\n';
    }

    return text.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  } catch (_) {
    return '';
  }
}

function unescapePdfLiteral(s) {
  return s
    .replace(/\\n/g, ' ').replace(/\\r/g, ' ').replace(/\\t/g, ' ')
    .replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\\/g, '\\');
}

// ── public: best-effort extraction with fallback chain ──────────────────────
export async function extractPDFText(arrayBuffer) {
  let text = '';
  try {
    text = await extractTextFromPDF(arrayBuffer);
  } catch (err) {
    if (err && err.code === 'PDF_ENCRYPTED') throw err;
    text = '';
  }
  // Only fall back to the crude legacy extractor when the structured
  // extractor produced essentially nothing (e.g. unsupported filters,
  // non-conformant structure). When the structured extractor succeeds it
  // is strictly more accurate than the legacy regex scanner, even when the
  // resulting text happens to be short.
  if (!text || text.trim().length < 10) {
    const legacy = extractTextFromPDFLegacy(arrayBuffer);
    if (legacy.length > text.length) text = legacy;
  }
  return text;
}