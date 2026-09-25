// ─────────────────────────────────────────────────────────────────────────
//  Pure-JS .docx generation (no external dependencies).
//
//  Builds minimal-but-valid OOXML Word documents (just the parts Word,
//  LibreOffice, and Google Docs need: [Content_Types].xml, _rels/.rels,
//  docProps/core.xml, word/document.xml) and packages them with zip.js.
//  Output is returned as a base64 string, matching the convention used by
//  src/background/pdf.js for storage in chrome.storage / data URIs.
// ─────────────────────────────────────────────────────────────────────────

import { writeZip } from './zip.js';

const FONT = 'Calibri';
const PAGE_WIDTH = 12240;  // 8.5in in twips
const PAGE_HEIGHT = 15840; // 11in in twips
const MARGIN = 720;        // 0.5in in twips
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN; // 10800

function bytesToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ── run / paragraph builders ────────────────────────────────────────────
function textRun(text, { bold, italic, size, color } = {}) {
  const rPrParts = [`<w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:cs="${FONT}"/>`];
  if (bold) rPrParts.push('<w:b/>');
  if (italic) rPrParts.push('<w:i/>');
  if (size != null) {
    const half = Math.round(size * 2);
    rPrParts.push(`<w:sz w:val="${half}"/><w:szCs w:val="${half}"/>`);
  }
  if (color) rPrParts.push(`<w:color w:val="${color}"/>`);
  const rPr = `<w:rPr>${rPrParts.join('')}</w:rPr>`;

  const segments = String(text ?? '').split('\n');
  let body = '';
  for (let i = 0; i < segments.length; i++) {
    if (i > 0) body += '<w:br/>';
    body += `<w:t xml:space="preserve">${escapeXml(segments[i])}</w:t>`;
  }
  return `<w:r>${rPr}${body}</w:r>`;
}

function tabRun() {
  return `<w:r><w:tab/></w:r>`;
}

// A real clickable hyperlink run. Word/LibreOffice/Google Docs all require
// the link target to live in a separate relationships part (word/_rels/
// document.xml.rels), referenced here by relId — see buildDocxBase64.
// Styled directly (blue + underline) rather than via a named "Hyperlink"
// style, since this package intentionally ships no styles.xml part.
function hyperlinkRun(text, relId, { size } = {}) {
  const rPrParts = [`<w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:cs="${FONT}"/>`, '<w:color w:val="0563C1"/>', '<w:u w:val="single"/>'];
  if (size != null) {
    const half = Math.round(size * 2);
    rPrParts.push(`<w:sz w:val="${half}"/><w:szCs w:val="${half}"/>`);
  }
  const rPr = `<w:rPr>${rPrParts.join('')}</w:rPr>`;
  return `<w:hyperlink r:id="${relId}"><w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:hyperlink>`;
}

function withScheme(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s) || /^mailto:/i.test(s)) return s;
  return 'https://' + s.replace(/^\/+/, '');
}

// Small per-document collector for hyperlink relationships — generateXxxDocx
// each create one of these, thread it through body-building, then hand the
// collected list to buildDocxBase64 to emit word/_rels/document.xml.rels.
function createLinkCollector() {
  const rels = [];
  let n = 0;
  return {
    rels,
    add(url) {
      const id = `rIdLink${++n}`;
      rels.push({ id, url: withScheme(url) });
      return id;
    }
  };
}

function paragraph(content, opts = {}) {
  const pPrParts = [];
  if (opts.rightTab) pPrParts.push(`<w:tabs><w:tab w:val="right" w:pos="${CONTENT_WIDTH}"/></w:tabs>`);
  if (opts.alignment) pPrParts.push(`<w:jc w:val="${opts.alignment}"/>`);
  const spacing = [];
  if (opts.spacingBefore != null) spacing.push(`w:before="${opts.spacingBefore}"`);
  if (opts.spacingAfter != null) spacing.push(`w:after="${opts.spacingAfter}"`);
  if (spacing.length) pPrParts.push(`<w:spacing ${spacing.join(' ')}/>`);
  if (opts.bullet) pPrParts.push(`<w:ind w:left="360" w:hanging="360"/>`);
  if (opts.borderBottom) pPrParts.push(`<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="2" w:color="999999"/></w:pBdr>`);
  const pPr = pPrParts.length ? `<w:pPr>${pPrParts.join('')}</w:pPr>` : '';
  return `<w:p>${pPr}${content}</w:p>`;
}

function bulletParagraph(text, opts = {}) {
  if (!text) return '';
  const content = `<w:r><w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}"/><w:t>\u2022</w:t></w:r>${tabRun()}${textRun(text, { size: 10, ...opts })}`;
  return paragraph(content, { spacingAfter: 40, bullet: true });
}

function sectionHeader(title) {
  return paragraph(textRun(title, { bold: true, size: 11, color: '1A1A1A' }), {
    spacingBefore: 220, spacingAfter: 100, borderBottom: true
  });
}

const SECT_PR = `<w:sectPr><w:pgSz w:w="${PAGE_WIDTH}" w:h="${PAGE_HEIGHT}"/><w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" w:header="${MARGIN}" w:footer="${MARGIN}" w:gutter="0"/></w:sectPr>`;

// ── package assembly ────────────────────────────────────────────────────
function contentTypesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;
}

function rootRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;
}

// Part-level relationships for word/document.xml — required for any
// <w:hyperlink r:id="..."> element in the document body to resolve to an
// actual URL.
function documentRelsXml(rels) {
  const items = (rels || []).map(r =>
    `<Relationship Id="${r.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(r.url)}" TargetMode="External"/>`
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items}</Relationships>`;
}

function corePropsXml(title) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${escapeXml(title)}</dc:title>
<dc:creator>TrueResume</dc:creator>
<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

function documentXml(bodyXml) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>${bodyXml}${SECT_PR}</w:body>
</w:document>`;
}

function buildDocxBase64(bodyXml, title, rels = []) {
  const enc = new TextEncoder();
  const files = [
    { name: '[Content_Types].xml', data: enc.encode(contentTypesXml()) },
    { name: '_rels/.rels', data: enc.encode(rootRelsXml()) },
    { name: 'docProps/core.xml', data: enc.encode(corePropsXml(title)) },
    { name: 'word/document.xml', data: enc.encode(documentXml(bodyXml)) }
  ];
  if (rels.length) {
    files.push({ name: 'word/_rels/document.xml.rels', data: enc.encode(documentRelsXml(rels)) });
  }
  const zipBytes = writeZip(files);
  return bytesToBase64(zipBytes);
}

// ── resume document body ────────────────────────────────────────────────
function buildResumeBody(d, linkCollector) {
  const body = [];

  body.push(paragraph(textRun(d.name || '', { bold: true, size: 22 }), { spacingAfter: 40 }));

  const c = d.contact || {};
  const sep = () => textRun('   |   ', { size: 9, color: '595959' });
  const contactRuns = [];
  if (c.email) contactRuns.push(textRun(c.email, { size: 9, color: '595959' }));
  if (c.phone) contactRuns.push(textRun(c.phone, { size: 9, color: '595959' }));
  if (c.location) contactRuns.push(textRun(c.location, { size: 9, color: '595959' }));
  // Clean clickable label (matches how most resumes present these) rather
  // than printing the full raw URL as visible text.
  if (c.portfolio) contactRuns.push(hyperlinkRun('Portfolio', linkCollector.add(c.portfolio), { size: 9 }));
  if (c.linkedin) contactRuns.push(hyperlinkRun('LinkedIn', linkCollector.add(c.linkedin), { size: 9 }));
  if (contactRuns.length) {
    const joined = contactRuns.flatMap((run, i) => i === 0 ? [run] : [sep(), run]).join('');
    body.push(paragraph(joined, { spacingAfter: 160 }));
  }

  if (d.summary) {
    body.push(sectionHeader('PROFESSIONAL SUMMARY'));
    body.push(paragraph(textRun(d.summary, { size: 10 }), { spacingAfter: 120 }));
  }

  if (Array.isArray(d.experience) && d.experience.length) {
    body.push(sectionHeader('WORK EXPERIENCE'));
    for (const exp of d.experience) {
      body.push(paragraph(
        textRun(exp.company || '', { bold: true, size: 11 }) + tabRun() + textRun(exp.location || '', { size: 9, color: '595959' }),
        { rightTab: true, spacingAfter: 20 }
      ));
      if (exp.title || exp.dates) {
        body.push(paragraph(
          textRun(exp.title || '', { italic: true, size: 10, color: '404040' }) + tabRun() + textRun(exp.dates || '', { size: 9, color: '595959' }),
          { rightTab: true, spacingAfter: 60 }
        ));
      }
      for (const b of exp.bullets || []) body.push(bulletParagraph(b));
      body.push(paragraph('', { spacingAfter: 60 }));
    }
  }

  if (Array.isArray(d.skills) && d.skills.length) {
    body.push(sectionHeader('SKILLS'));
    for (const cat of d.skills) {
      if (!cat || typeof cat !== 'object') continue;
      const label = cat.category || cat.label || 'Skills';
      const items = (Array.isArray(cat.items) ? cat.items : []).join(', ');
      if (!items) continue;
      body.push(paragraph(
        textRun(`${label}: `, { bold: true, size: 10 }) + textRun(items, { size: 10 }),
        { spacingAfter: 40 }
      ));
    }
  }

  if (Array.isArray(d.education) && d.education.length) {
    body.push(sectionHeader('EDUCATION'));
    for (const edu of d.education) {
      body.push(paragraph(
        textRun(edu.institution || '', { bold: true, size: 11 }) + tabRun() + textRun(edu.location || '', { size: 9, color: '595959' }),
        { rightTab: true, spacingAfter: 20 }
      ));
      if (edu.degree || edu.dates) {
        body.push(paragraph(
          textRun(edu.degree || '', { italic: true, size: 10, color: '404040' }) + tabRun() + textRun(edu.dates || '', { size: 9, color: '595959' }),
          { rightTab: true, spacingAfter: 60 }
        ));
      }
    }
  }

  if (Array.isArray(d.projects) && d.projects.length) {
    body.push(sectionHeader('PROJECTS'));
    for (const proj of d.projects) {
      body.push(paragraph(
        textRun(proj.name || '', { bold: true, size: 11 }) + tabRun() + textRun(proj.dates || '', { size: 9, color: '595959' }),
        { rightTab: true, spacingAfter: 60 }
      ));
      for (const b of proj.bullets || []) body.push(bulletParagraph(b));
      body.push(paragraph('', { spacingAfter: 60 }));
    }
  }

  if (Array.isArray(d.certifications) && d.certifications.length) {
    body.push(sectionHeader('CERTIFICATIONS'));
    for (const cert of d.certifications) body.push(bulletParagraph(cert));
  }

  return body.join('');
}

/**
 * Generate a tailored-resume .docx from the same resumeData shape produced
 * by ai.js / consumed by pdf.js. Returns a base64-encoded .docx file.
 */
export function generateResumeDocx(resumeData) {
  const d = resumeData || {};
  const linkCollector = createLinkCollector();
  const bodyXml = buildResumeBody(d, linkCollector);
  return buildDocxBase64(bodyXml, d.name ? `${d.name} - Resume` : 'Resume', linkCollector.rels);
}

// ── cover letter document body ──────────────────────────────────────────
function buildCoverLetterBody(text) {
  const body = [];
  const paragraphs = String(text || '').replace(/\r\n/g, '\n').split(/\n\s*\n/);
  for (const para of paragraphs) {
    if (!para.trim()) continue;
    body.push(paragraph(textRun(para, { size: 11 }), { spacingAfter: 200 }));
  }
  return body.join('');
}

/**
 * Generate a cover letter .docx from plain text (already formatted with
 * date / salutation / body / signature by ai.js's buildCoverLetter).
 * Returns a base64-encoded .docx file.
 */
export function generateCoverLetterDocx(text, opts = {}) {
  const bodyXml = buildCoverLetterBody(text);
  return buildDocxBase64(bodyXml, opts.title || 'Cover Letter');
}
