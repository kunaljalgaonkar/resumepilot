// ─────────────────────────────────────────────────────────────────────────
//  Pure-JS .docx text extraction (no external dependencies).
//
//  A .docx file is a ZIP archive containing OOXML parts. The visible text
//  lives in word/document.xml as a sequence of paragraphs (<w:p>), each
//  containing runs (<w:r>) with text nodes (<w:t>). This module extracts
//  readable plain text, preserving paragraph breaks, tabs, and explicit
//  line breaks.
// ─────────────────────────────────────────────────────────────────────────

import { readZip } from './zip.js';

export async function extractTextFromDOCX(arrayBuffer) {
  const zip = await readZip(arrayBuffer);
  const docXmlBytes = zip.get('word/document.xml');
  if (!docXmlBytes) {
    const err = new Error('This .docx file appears to be invalid (missing word/document.xml).');
    err.code = 'DOCX_INVALID';
    throw err;
  }
  const xml = new TextDecoder('utf-8').decode(docXmlBytes);
  let text = docxXmlToText(xml);

  // Some resumes put contact info / extra sections in headers or footers.
  for (const [name, bytes] of zip) {
    if (/^word\/(header|footer)\d*\.xml$/.test(name)) {
      try {
        const extra = docxXmlToText(new TextDecoder('utf-8').decode(bytes));
        if (extra.trim()) text = extra.trim() + '\n' + text;
      } catch (_) { /* ignore */ }
    }
  }

  return text;
}

// Recovers real hyperlink URLs from a .docx — same problem as PDFs: a
// clickable word like "Portfolio" carries no URL in its visible text at
// all; the target lives in word/_rels/document.xml.rels, referenced by a
// relationship ID on the <w:hyperlink> element, not in the text itself.
// Returns [{ uri, paragraphIndex }] — paragraphIndex is how many paragraphs
// precede the link, used the same way as a PDF's topFraction to separate
// header/contact links from links mentioned later in the body (e.g. a
// project's URL). Paragraph index is used rather than a character-offset
// fraction because name+contact are reliably the first 1-2 paragraphs of
// any resume regardless of how long the overall document is — a fractional
// offset shrinks for longer documents and can misclassify short ones.
export async function extractDOCXLinks(arrayBuffer) {
  try {
    const zip = await readZip(arrayBuffer);
    const relsBytes = zip.get('word/_rels/document.xml.rels');
    const docXmlBytes = zip.get('word/document.xml');
    if (!relsBytes || !docXmlBytes) return [];

    const relsXml = new TextDecoder('utf-8').decode(relsBytes);
    const relMap = new Map();
    const relRe = /<Relationship\s+Id="([^"]+)"[^>]*Type="[^"]*\/hyperlink"[^>]*Target="([^"]+)"/g;
    let m;
    while ((m = relRe.exec(relsXml))) relMap.set(m[1], decodeXmlEntities(m[2]));

    const xml = new TextDecoder('utf-8').decode(docXmlBytes);

    // Index every paragraph start so we can count how many precede a given
    // hyperlink's position.
    const paraStarts = [];
    const paraRe = /<w:p\b/g;
    while ((m = paraRe.exec(xml))) paraStarts.push(m.index);

    const linkRe = /<w:hyperlink\b[^>]*r:id="([^"]+)"[^>]*>/g;
    const results = [];
    while ((m = linkRe.exec(xml))) {
      const uri = relMap.get(m[1]);
      if (!uri) continue;
      // Number of paragraph-starts at or before this link's position, minus
      // one for 0-based indexing.
      let paragraphIndex = 0;
      for (const p of paraStarts) { if (p <= m.index) paragraphIndex++; else break; }
      results.push({ uri, paragraphIndex: Math.max(0, paragraphIndex - 1) });
    }
    return results;
  } catch (_) {
    return [];
  }
}

// Same classification approach as pdf-extract.js's classifyContactLinks —
// only links in the first couple of paragraphs (the header/contact block)
// are treated as contact links.
export function classifyContactLinksFromDocx(links) {
  const result = { linkedin: '', portfolio: '', github: '' };
  const headerLinks = (links || []).filter(l => l.paragraphIndex <= 1 && !/^mailto:/i.test(l.uri));

  for (const l of headerLinks) {
    if (/linkedin\.com/i.test(l.uri) && !result.linkedin) result.linkedin = l.uri;
    else if (/github\.com\/[^/]+\/?$/i.test(l.uri) && !result.github) result.github = l.uri;
  }
  for (const l of headerLinks) {
    if (l.uri === result.linkedin || l.uri === result.github) continue;
    if (!result.portfolio) result.portfolio = l.uri;
  }
  return result;
}

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

function docxXmlToText(xml) {
  // Match each paragraph, including self-closing empty paragraphs.
  const paraRe = /<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
  const paras = xml.match(paraRe) || [];
  const lines = [];

  // Single-pass token scan over each paragraph's contents, in document
  // order. IMPORTANT: the <w:t> alternative requires the tag name to be
  // followed by whitespace or '>' — otherwise it would also match
  // <w:tab/>, <w:tabs>, <w:tbl>, <w:tc>, etc. (anything starting "<w:t").
  const tokenRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<w:cr\s*\/>/g;

  for (const p of paras) {
    let line = '';
    let m;
    tokenRe.lastIndex = 0;
    while ((m = tokenRe.exec(p))) {
      if (m[1] !== undefined) line += decodeXmlEntities(m[1]);
      else if (m[0].startsWith('<w:tab')) line += '\t';
      else line += '\n'; // <w:br/> or <w:cr/>
    }
    lines.push(line);
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
