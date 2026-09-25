// ─────────────────────────────────────────────────────────
//  ResumePilot PDF Generator
//  Matches the style of Kunal's resume:
//  - Clean header with name + contact
//  - Section rules with ALL CAPS labels
//  - Company bold left, location right
//  - Title italic, dates right
//  - Bullet points with • and proper indentation
//  - Skills grouped by category
//  - Projects section
//  Pure JS, no external libs, MV3 CSP compliant
// ─────────────────────────────────────────────────────────

const PW = 612, PH = 792, ML = 50, MR = 50, MT = 45, MB = 45;
const CW = PW - ML - MR;

// Simple template registry. Each template supplies sizing/spacing preferences
// that `buildOps` will apply. Start with `classic` (current behaviour)
// and `modern` (clean single-column layout).
const TEMPLATES = {
  classic: {
    nameSize: 18, contactSize: 8.5, summarySize: 9.5, sectionLabelSize: 9,
    bulletSize: 9.5, skillSize: 9.5, rowLeftSize: 10, rowRightSize: 9
  },
  modern: {
    nameSize: 20, contactSize: 9, summarySize: 10, sectionLabelSize: 10,
    bulletSize: 10, skillSize: 10, rowLeftSize: 10.5, rowRightSize: 9
  }
};

// ── Sanitize ────────────────────────────────────────────────
function sanitize(d) {
  if (!d) return {};
  return {
    ...d,
    contact: d.contact || {},
    experience: (d.experience || []).map(e => ({
      ...e,
      bullets: Array.isArray(e.bullets) ? e.bullets
             : typeof e.bullets === 'string' ? e.bullets.split('\n').filter(Boolean) : []
    })),
    projects: (d.projects || []).map(p => ({
      ...p,
      bullets: Array.isArray(p.bullets) ? p.bullets
             : typeof p.bullets === 'string' ? p.bullets.split('\n').filter(Boolean) : []
    })),
    education:      d.education      || [],
    certifications: Array.isArray(d.certifications) ? d.certifications : [],
    skills:         Array.isArray(d.skills) ? d.skills : []
  };
}

// ── Public API ──────────────────────────────────────────────
export async function generatePDF(rawData, template = 'modern') {
  const d   = sanitize(rawData);
  const ops = buildOps(d, template);   // array of draw operations
  return renderPDF(ops, template);     // returns base64 string
}

// ── Build draw operations ───────────────────────────────────
// Each op: { type, ...props, y }
function buildOps(d, template = 'classic') {
  const tpl = TEMPLATES[template] || TEMPLATES.classic;
  // local shortcuts for sizes
  const nameSize = tpl.nameSize;
  const contactSize = tpl.contactSize;
  const summarySize = tpl.summarySize;
  const sectionLabelSize = tpl.sectionLabelSize;
  const bulletSize = tpl.bulletSize;
  const skillSize = tpl.skillSize;
  const rowLeftSize = tpl.rowLeftSize;

  const ops = [];
  let y = MT;

  function gap(h) { y += h; }

  function text(str, opts) {
    // opts: { size, bold, italic, color='#111', x=ML, maxW=CW, rightText, rightSize, justify }
    const wrapped = wrapText(String(str || ''), opts.maxW ?? CW, opts.size ?? summarySize);
    for (let i = 0; i < wrapped.length; i++) {
      // mark lines for justification except the last line of a paragraph
      const justify = Boolean(opts.justify && i < wrapped.length - 1);
      ops.push({ type: 'text', text: wrapped[i], y, justify, size: opts.size ?? summarySize, color: opts.color || '#111', x: opts.x, maxW: opts.maxW });
      y += (opts.size ?? summarySize) + 3;
    }
    if (opts.rightText && wrapped.length === 1) {
      // already pushed — add right-side text at same y
      ops[ops.length - 1].rightText = opts.rightText;
      ops[ops.length - 1].rightSize = opts.rightSize ?? rowLeftSize;
    }
  }

  function rule(label) {
    gap(7);
    ops.push({ type: 'rule', label, y });
    y += 16;
  }

  function bullet(str, indent = 14) {
    const wrapped = wrapText(String(str || ''), CW - indent - 6, bulletSize);
    for (let i = 0; i < wrapped.length; i++) {
      ops.push({ type: 'bullet', text: wrapped[i], firstLine: i === 0, indent, y, justify: i < wrapped.length - 1, size: bulletSize });
      y += bulletSize + 2;
    }
    gap(1);
  }

  // ── Name ──
  ops.push({ type: 'name', text: d.name || '', y, size: nameSize });
  y += nameSize + 6;

  // ── Contact ──
  const c = d.contact;
  const contactParts = [
    { text: c.email },
    { text: c.phone },
    { text: c.location },
    // Show a clean clickable label (matches how most resumes present these)
    // rather than printing the full raw URL as visible text — the URL is
    // still the actual link target, just not the visible text.
    c.portfolio ? { text: 'Portfolio', url: c.portfolio } : null,
    c.linkedin ? { text: 'LinkedIn', url: c.linkedin } : null,
    c.github ? { text: 'GitHub', url: c.github } : null
  ].filter(p => p && p.text);
  const contactLine = contactParts.map(p => p.text).join('  |  ');
  ops.push({ type: 'contact', text: contactLine, y, links: contactParts.filter(p => p.url), size: contactSize });
  y += contactSize + 4;

  // ── Summary ──
  if (d.summary) {
    rule('PROFESSIONAL SUMMARY');
    const wrapped = wrapText(d.summary, CW, summarySize);
    for (let i = 0; i < wrapped.length; i++) {
      ops.push({ type: 'text', text: wrapped[i], y, size: summarySize, color: '#222', justify: i < wrapped.length - 1 });
      y += summarySize + 3;
    }
    gap(2);
  }

  // ── Experience ──
  if (d.experience?.length) {
    rule('WORK EXPERIENCE');
    for (const exp of d.experience) {
      gap(4);
      // Company (bold left) + Location (muted right)
      ops.push({ type: 'row2', leftText: exp.company || '', leftBold: true, leftSize: rowLeftSize,
             rightText: exp.location || '', rightSize: tpl.rowRightSize || 9, rightMuted: true, y });
      y += rowLeftSize + 4;
      // Title (italic left) + Dates (muted right)
      if (exp.title || exp.dates) {
        ops.push({ type: 'row2', leftText: exp.title || '', leftItalic: true, leftSize: rowLeftSize - 0.5, leftMuted: true,
             rightText: exp.dates || '', rightSize: tpl.rowRightSize || 9, rightMuted: true, y });
        y += (rowLeftSize - 0.5) + 3;
      }
      gap(2);
      for (const b of exp.bullets) bullet(b);
    }
    gap(3);
  }

  // ── Skills ──
  if (d.skills?.length) {
    rule('SKILLS');
    for (const cat of d.skills) {
      if (!cat || typeof cat !== 'object') continue;
      const label = cat.category || cat.label || 'Skills';
      const items = (Array.isArray(cat.items) ? cat.items : []).join(', ');
      if (!items) continue;
      const line = `${label}: ${items}`;
      const wrapped = wrapText(line, CW, skillSize);
      for (let i = 0; i < wrapped.length; i++) {
          if (i === 0) {
            ops.push({ type: 'skill_row', label, items: items.slice(0, wrapped[0].length - label.length - 2), full: wrapped[0], y, size: skillSize });
          } else {
            const x = ML + 4;
            ops.push({ type: 'text', text: wrapped[i], y, size: skillSize, x, maxW: CW - (x - ML), justify: i < wrapped.length - 1 });
          }
        y += skillSize + 3;
      }
    }
    gap(3);
  }

  // ── Education ──
  if (d.education?.length) {
    rule('EDUCATION');
    for (const edu of d.education) {
      gap(4);
      ops.push({ type: 'row2', leftText: edu.institution || '', leftBold: true, leftSize: 10.5,
                 rightText: edu.location || '', rightSize: 9, rightMuted: true, y });
      y += 14;
      ops.push({ type: 'row2', leftText: edu.degree || '', leftItalic: true, leftSize: 9.5, leftMuted: true,
                 rightText: edu.dates || '', rightSize: 9, rightMuted: true, y });
      y += 13;
    }
    gap(3);
  }

  // ── Projects ──
  if (d.projects?.length) {
    rule('PROJECTS');
    for (const proj of d.projects) {
      gap(4);
      ops.push({ type: 'row2', leftText: proj.name || '', leftBold: true, leftSize: 10.5,
                 rightText: proj.dates || '', rightSize: 9, rightMuted: true, y });
      y += 14;
      for (const b of proj.bullets) bullet(b);
    }
    gap(3);
  }

  // ── Certifications ──
  if (d.certifications?.length) {
    rule('CERTIFICATIONS');
    for (const cert of d.certifications) bullet(cert);
  }

  return ops;
}

// ── Cover letter PDF ─────────────────────────────────────────
// Renders a plain block-text letter (already formatted with date,
// salutation, body paragraphs, and signature by ai.js's buildCoverLetter)
// using the same low-level PDF renderer as the resume.
export async function generateCoverLetterPDF(text, opts = {}) {
  const ops = buildCoverLetterOps(String(text || ''), opts);
  return renderPDF(ops);
}

function buildCoverLetterOps(text, opts = {}) {
  const size = opts.size || 11;
  const lineGap = size + 5;
  const ops = [];
  let y = MT;

  const paragraphs = text.replace(/\r\n/g, '\n').split(/\n\s*\n/);
  for (const para of paragraphs) {
    const lines = para.split('\n');
    for (const line of lines) {
      const wrapped = wrapText(line, CW, size);
      for (let i = 0; i < wrapped.length; i++) {
        // Justify all lines except:
        //  - the last line of each paragraph (left-align fragment)
        //  - very short lines like the date, salutation, or closing,
        //    which look terrible if stretched to full width
        const isLast = i === wrapped.length - 1;
        const isShortLine = approxWidth(wrapped[i], size) < CW * 0.55;
        const justify = !isLast && !isShortLine;
        ops.push({ type: 'text', text: wrapped[i], y, size, color: '#111', justify });
        y += lineGap;
      }
    }
    y += Math.round(size * 0.6); // blank line between paragraphs
  }
  return ops;
}


function renderPDF(ops) {
  // Paginate by estimating per-op heights instead of relying on absolute y
  // coordinates. This avoids orphan lines and uneven trailing pages.
  const pages = [];
  let currentPage = [];
  let cursorY = MT;

  // Estimate heights using y-deltas when present, or fall back to heuristics.
  const heights = new Array(ops.length).fill(12);
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const next = ops[i + 1];
    if (next && typeof next.y === 'number' && typeof op.y === 'number') {
      const h = Math.max(10, next.y - op.y);
      heights[i] = h;
    } else {
      if (op.type === 'name') heights[i] = 26;
      else if (op.type === 'contact') heights[i] = 14;
      else if (op.type === 'rule') heights[i] = 18;
      else if (op.type === 'row2') heights[i] = 14;
      else if (op.type === 'bullet') heights[i] = 12;
      else heights[i] = (op.size || 9.5) + 4;
    }
  }

  for (let i = 0; i < ops.length; i++) {
    const op = { ...ops[i] };
    const h = heights[i];
    if (cursorY + h > PH - MB) {
      pages.push(currentPage);
      currentPage = [];
      cursorY = MT;
    }
    op.y = cursorY;
    currentPage.push(op);
    cursorY += h;
  }
  if (currentPage.length) pages.push(currentPage);

  const objs = [];
  let oid = 1;
  const newObj = (content) => { const id = oid++; objs.push({ id, content }); return id; };

  const catalogId = newObj('');
  const pagesId   = newObj('');
  const pageIds   = [];

  for (const page of pages) {
    const { stream, annots } = opsToStream(page);
    const streamId = newObj(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);

    // Create annotation objects (URI links) and collect their object ids
    const annotIds = [];
    for (const a of annots || []) {
      // a: { rect: [x1,y1,x2,y2], uri }
      const content = `<< /Type /Annot /Subtype /Link /Rect [${a.rect.join(' ')}] /Border [0 0 0] /A << /S /URI /URI (${esc(a.uri)}) >> >>`;
      const aid = newObj(content);
      annotIds.push(aid);
    }

    const annotsRef = annotIds.length ? ` /Annots [${annotIds.map(id => `${id} 0 R`).join(' ')}] ` : '';

    const pageId = newObj(
      `<< /Type /Page /Parent ${pagesId} 0 R ` +
      `/MediaBox [0 0 ${PW} ${PH}] /Contents ${streamId} 0 R ` +
      `${annotsRef}` +
      `/Resources << /Font << ` +
      `/F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >> ` +
      `/F2 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >> ` +
      `/F3 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >> ` +
      `>> >> >>`
    );
    pageIds.push(pageId);
  }

  objs[pagesId - 1] = { id: pagesId,
    content: `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>` };
  objs[catalogId - 1] = { id: catalogId, content: `<< /Type /Catalog /Pages ${pagesId} 0 R >>` };

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const obj of objs) {
    offsets.push(pdf.length);
    pdf += `${obj.id} 0 obj\n${obj.content}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += String(off).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF`;

  // base64 encode
  let out = '';
  for (let i = 0; i < pdf.length; i++) {
    const code = pdf.charCodeAt(i);
    out += code < 256 ? pdf[i] : '?';
  }
  return btoa(out);
}

// ── Ops → PDF stream string ─────────────────────────────────
function opsToStream(ops) {
  const lines = [];
  const pyf   = y => PH - y;   // PDF Y-axis is bottom-up
  const annots = [];

  lines.push('BT');

  for (const op of ops) {
    const y = pyf(op.y);

    if (op.type === 'name') {
      const s = op.size || 18;
      lines.push(`/F2 ${s} Tf`);
      lines.push(`0.05 0.05 0.05 rg`);
      const w = approxWidth(op.text, s, true); // bold
      const x = Math.max(ML, (PW - w) / 2);
      lines.push(`${x} ${y} Td`);
      lines.push(`(${esc(op.text)}) Tj`);
      lines.push(`ET`);
      lines.push('BT');

    } else if (op.type === 'contact') {
      const size = op.size || 8.5;
      lines.push(`/F1 ${size} Tf`);
      lines.push(`0.35 0.35 0.35 rg`);
      const fullW = approxWidth(op.text, size);
      const startX = Math.max(ML, (PW - fullW) / 2);
      lines.push(`${startX} ${y} Td`);
      lines.push(`(${esc(op.text)}) Tj`);
      lines.push(`ET BT`);
      // If there are link hints attach a single annotation per link covering the text area.
      if (Array.isArray(op.links) && op.links.length) {
        // compute full text width and then position each link roughly by splitting on the separator '  |  '
        const full = op.text;
        const sep = '  |  ';
        let offsetX = startX; // start from the centered position, not ML
        const parts = full.split(sep);
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          const w = approxWidth(part, size);
          const linkMeta = op.links.find(l => l.text === part || (l.text && part.includes(l.text)));
          if (linkMeta && linkMeta.url) {
            const rx = offsetX + w;
            const py = pyf(op.y);
            // Rect must span the glyph area ABOVE the baseline, where the
            // text actually renders — the previous version used
            // [py-(size+2), py], which covers only blank space BELOW the
            // baseline and never overlaps the visible text at all. That,
            // not just X-position accuracy, is why clicking the text did
            // nothing.
            const rect = [offsetX, py - 0.25 * size, rx, py + 0.8 * size];
            annots.push({ rect, uri: linkMeta.url });
          }
          offsetX += w + approxWidth(sep, size);
        }
      }

    } else if (op.type === 'rule') {
      lines.push(`ET`);
      lines.push(`0.65 w`);
      lines.push(`0.08 0.08 0.08 RG`);
      lines.push(`${ML} ${y - 3} m ${PW - MR} ${y - 3} l S`);
      lines.push(`BT`);
      const ls = op.labelSize || 9;
      lines.push(`/F2 ${ls} Tf`);
      lines.push(`0.08 0.08 0.08 rg`);
      lines.push(`${ML} ${y} Td`);
      lines.push(`(${esc(op.label)}) Tj`);
      lines.push(`ET BT`);

    } else if (op.type === 'row2') {
      // Left side
      const lf = op.leftBold ? '/F2' : op.leftItalic ? '/F3' : '/F1';
      const ls = op.leftSize || 10;
      const lc = op.leftMuted ? '0.3 0.3 0.3' : '0.05 0.05 0.05';
      lines.push(`${lf} ${ls} Tf`);
      lines.push(`${lc} rg`);
      lines.push(`${ML} ${y} Td`);
      lines.push(`(${esc(op.leftText)}) Tj`);
      // Right side
      if (op.rightText) {
        const rs  = op.rightSize || 9;
        const rw  = approxWidth(op.rightText, rs);
        const rx  = PW - MR - rw;
        lines.push(`ET BT`);
        lines.push(`/F1 ${rs} Tf`);
        lines.push(`0.4 0.4 0.4 rg`);
        lines.push(`${rx} ${y} Td`);
        lines.push(`(${esc(op.rightText)}) Tj`);
        lines.push(`ET BT`);
      } else {
        lines.push(`ET BT`);
      }

    } else if (op.type === 'bullet') {
      if (op.firstLine) {
        // Draw a small filled square as a bullet (avoids non-ASCII glyph issues)
        lines.push(`ET`);
        const bx = ML + 3;
        const by = y - 2; // adjust because PDF y is baseline; draw slightly below baseline
        const bsize = 3; // 3pt square
        lines.push(`0.12 0.3 0.65 rg`);
        lines.push(`${bx} ${by} ${bsize} ${bsize} re`);
        lines.push(`f`);
        lines.push(`BT`);
      }
      const bsize = op.size || 9.5;
      lines.push(`/F1 ${bsize} Tf`);
      lines.push(`0.1 0.1 0.1 rg`);
      const bx = ML + op.indent;
      lines.push(`${bx} ${y} Td`);
      if (op.justify) {
        const width = PW - MR - bx;
        const curW = approxWidth(op.text, bsize);
        const scale = Math.max(85, Math.min(110, Math.round((width / Math.max(1, curW)) * 100)));
        lines.push(`${scale} Tz`);
        lines.push(`(${esc(op.text)}) Tj`);
        lines.push(`100 Tz`);
      } else {
        lines.push(`(${esc(op.text)}) Tj`);
      }
      lines.push(`ET BT`);

    } else if (op.type === 'skill_row') {
      // Bold category label, regular items
      const s = op.size || 9.5;
      lines.push(`/F2 ${s} Tf`);
      lines.push(`0.1 0.1 0.1 rg`);
      lines.push(`${ML} ${y} Td`);
      lines.push(`(${esc(op.label + ': ')}) Tj`);
      lines.push(`/F1 ${s} Tf`);
      lines.push(`0.2 0.2 0.2 rg`);
      // Items on same line
      const labelW = approxWidth(op.label + ': ', s, true);
      lines.push(`ET BT /F1 ${s} Tf 0.2 0.2 0.2 rg ${ML + labelW} ${y} Td (${esc(op.full.slice(op.label.length + 2))}) Tj ET BT`);

    } else if (op.type === 'text') {
      const f = '/F1';
      const s = op.size || 9.5;
      const x = op.x || ML;
      lines.push(`${f} ${s} Tf`);
      lines.push(`0.15 0.15 0.15 rg`);
      lines.push(`${x} ${y} Td`);
      if (op.justify) {
        const width = PW - MR - x;
        const curW = approxWidth(op.text, s);
        const scale = Math.max(85, Math.min(110, Math.round((width / Math.max(1, curW)) * 100)));
        lines.push(`${scale} Tz`);
        lines.push(`(${esc(op.text)}) Tj`);
        lines.push(`100 Tz`);
      } else {
        lines.push(`(${esc(op.text)}) Tj`);
      }
      lines.push(`ET BT`);
    }
  }

  lines.push('ET');
  return { stream: lines.join('\n'), annots };
}

// ── Helpers ──────────────────────────────────────────────────
function wrapText(text, maxW, size) {
  if (!text) return [''];
  const words = String(text).split(' ');
  const out = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (approxWidth(test, size) > maxW && cur) { out.push(cur); cur = w; }
    else cur = test;
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

// Standard Adobe AFM glyph widths for Helvetica / Helvetica-Bold, in
// thousandths of an em (the same metrics every PDF reader/writer uses for
// these built-in Base-14 fonts — Helvetica-Oblique shares Helvetica's
// widths, it's just a sheared transform of the same glyphs). Using a flat
// per-character average here (the old approach) systematically misjudges
// short strings like "Portfolio"/"LinkedIn" and accumulates error across a
// line, which is what was causing contact-link click areas to drift from
// the visible text, and right-aligned columns (location/dates) to not
// actually land flush against the right margin.
const HELVETICA_WIDTHS = {
  ' ':278,'!':278,'"':355,'#':556,'$':556,'%':889,'&':667,"'":191,'(':333,')':333,
  '*':389,'+':584,',':278,'-':333,'.':278,'/':278,
  '0':556,'1':556,'2':556,'3':556,'4':556,'5':556,'6':556,'7':556,'8':556,'9':556,
  ':':278,';':278,'<':584,'=':584,'>':584,'?':556,'@':1015,
  'A':667,'B':667,'C':722,'D':722,'E':667,'F':611,'G':778,'H':722,'I':278,'J':500,
  'K':667,'L':556,'M':833,'N':722,'O':778,'P':667,'Q':778,'R':722,'S':667,'T':611,
  'U':722,'V':667,'W':944,'X':667,'Y':667,'Z':611,
  '[':278,'\\':278,']':278,'^':469,'_':556,'`':333,
  'a':556,'b':556,'c':500,'d':556,'e':556,'f':278,'g':556,'h':556,'i':222,'j':222,
  'k':500,'l':222,'m':833,'n':556,'o':556,'p':556,'q':556,'r':333,'s':500,'t':278,
  'u':556,'v':500,'w':722,'x':500,'y':500,'z':500,
  '{':334,'|':260,'}':334,'~':584,
  '\u2013':556,'\u2014':1000,'\u2018':222,'\u2019':222,'\u201A':222,
  '\u201C':333,'\u201D':333,'\u2022':350,'\u2026':1000,'\u2122':980
};
const HELVETICA_BOLD_WIDTHS = {
  ' ':278,'!':333,'"':474,'#':556,'$':556,'%':889,'&':722,"'":238,'(':333,')':333,
  '*':389,'+':584,',':278,'-':333,'.':278,'/':278,
  '0':556,'1':556,'2':556,'3':556,'4':556,'5':556,'6':556,'7':556,'8':556,'9':556,
  ':':333,';':333,'<':584,'=':584,'>':584,'?':611,'@':975,
  'A':722,'B':722,'C':722,'D':722,'E':667,'F':611,'G':778,'H':722,'I':278,'J':556,
  'K':722,'L':611,'M':833,'N':722,'O':778,'P':667,'Q':778,'R':722,'S':667,'T':611,
  'U':722,'V':667,'W':944,'X':667,'Y':667,'Z':611,
  '[':333,'\\':278,']':333,'^':584,'_':556,'`':333,
  'a':556,'b':611,'c':556,'d':611,'e':556,'f':333,'g':611,'h':611,'i':278,'j':278,
  'k':556,'l':278,'m':889,'n':611,'o':611,'p':611,'q':611,'r':389,'s':556,'t':333,
  'u':611,'v':556,'w':778,'x':556,'y':556,'z':500,
  '{':389,'|':280,'}':389,'~':584,
  '\u2013':556,'\u2014':1000,'\u2018':278,'\u2019':278,'\u201A':278,
  '\u201C':333,'\u201D':333,'\u2022':350,'\u2026':1000,'\u2122':1000
};

function approxWidth(text, size, bold = false) {
  const table = bold ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  const s = String(text || '');
  let units = 0;
  for (const ch of s) units += table[ch] ?? 556; // 556 ≈ digit width, a reasonable default for unmapped chars
  return (units / 1000) * size;
}

// Map common "smart"/typographic Unicode punctuation to their WinAnsiEncoding
// byte values (0x80-0x9F range) so they render correctly now that fonts
// declare /Encoding /WinAnsiEncoding, instead of becoming '?'.
const UNICODE_TO_WINANSI = {
  '\u2013': '\x96', // en dash
  '\u2014': '\x97', // em dash
  '\u2018': '\x91', // left single quote
  '\u2019': '\x92', // right single quote
  '\u201A': '\x82',
  '\u201C': '\x93', // left double quote
  '\u201D': '\x94', // right double quote
  '\u2022': '\x95', // bullet
  '\u2026': '\x85', // ellipsis
  '\u2122': '\x99', // trademark
  '\u02C6': '\x88',
  '\u2039': '\x8B',
  '\u203A': '\x9B',
  '\u0152': '\x8C',
  '\u0153': '\x9C',
  '\u0160': '\x8A',
  '\u0161': '\x9A',
  '\u0178': '\x9F',
  '\u017D': '\x8E',
  '\u017E': '\x9E',
  '\u0192': '\x83'
};

function esc(s) {
  let str = String(s || '');
  str = str.replace(/[\u2013\u2014\u2018\u2019\u201A\u201C\u201D\u2022\u2026\u2122\u02C6\u2039\u203A\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u0192]/g, c => UNICODE_TO_WINANSI[c] || '?');
  let out = '';
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (code >= 0x20 && code <= 0x7E) out += ch;
    else if (code >= 0x80 && code <= 0xFF) out += ch; // WinAnsi / Latin-1 range
    else out += '?';
  }
  return out
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}
