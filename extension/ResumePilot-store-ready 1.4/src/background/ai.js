// ─────────────────────────────────────────────────────────
//  ResumePilot AI Module
//  All calls go through your Cloudflare Worker (Claude Haiku 4.5 backend)
//  See server/hosted-api-example.js for the worker implementation.
// ─────────────────────────────────────────────────────────

const HOSTED_AI_ENDPOINT = 'https://wispy-recipe-d3bd.my1assistant-support.workers.dev';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseRetryDelay(msg) {
  if (!msg) return null;
  const ms = msg.match(/(\d+(?:\.\d+)?)ms/);
  if (ms) return Math.ceil(parseFloat(ms[1])) + 150;
  const s  = msg.match(/(\d+(?:\.\d+)?)s/);
  if (s)  return Math.ceil(parseFloat(s[1]) * 1000) + 200;
  return null;
}

// Simple debug logger persisted to chrome.storage.local.rp_debug
async function debugLog(entry) {
  try {
    const rec = { ts: Date.now(), entry: typeof entry === 'string' ? entry : JSON.stringify(entry) };
    const stored = await chrome.storage.local.get(['rp_debug']);
    const arr = stored.rp_debug || [];
    arr.push(rec);
    if (arr.length > 200) arr.splice(0, arr.length - 200);
    await chrome.storage.local.set({ rp_debug: arr });
  } catch (e) {
    // swallow
  }
}

function isRequestTooLarge(message) {
  return /request too large|TPM|tokens per minute|limit 6000|prompt is too long|context_length|too many tokens|maximum context length/i.test(message);
}

function isJsonGenerationFailed(message) {
  return /failed_generation|failed to generate|json_validate_failed|json mode|tool_use|invalid_request_error.*tool/i.test(message || '');
}

function arrayify(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === 'object') return Object.values(value).filter(v => v && typeof v === 'object');
  return [];
}

// Defensive safety net: the hosted backend enforces a strict JSON Schema via
// tool-use for the primary path (bullets/items MUST be strings — see
// server/hosted-api-example.js), but the no-JSON-mode retry path has no such
// guarantee. Coerce anything unexpected (e.g. {text: "..."} objects) back to
// plain strings so a malformed item never reaches the PDF/DOCX renderer.
function coerceToString(v) {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  if (typeof v === 'object') {
    const candidate = v.text || v.bullet || v.content || v.value || v.description || v.item;
    if (typeof candidate === 'string') return candidate;
    return '';
  }
  return String(v);
}

function sanitizeResumeShape(resume) {
  if (!resume || typeof resume !== 'object') return resume;
  const r = { ...resume };
  r.experience = arrayify(r.experience).map(e => ({
    ...e,
    bullets: arrayify(e.bullets).map(coerceToString).filter(Boolean)
  }));
  r.projects = arrayify(r.projects).map(p => ({
    ...p,
    bullets: arrayify(p.bullets).map(coerceToString).filter(Boolean)
  }));
  r.skills = arrayify(r.skills).map(s => ({
    ...s,
    items: arrayify(s.items).map(coerceToString).filter(Boolean)
  }));
  r.certifications = arrayify(r.certifications).map(coerceToString).filter(Boolean);
  return r;
}

function inferNameFromText(text) {
  if (!text) return '';
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 8)) {
    if (line.length < 60
        && /[A-Za-z]/.test(line)
        && !/[@\d]/.test(line)
        && !/(resume|curriculum vitae|summary|experience|education|skills|projects|contact)/i.test(line)) {
      return line;
    }
  }
  return '';
}

function normalizeParsedResume(parsed, rawText) {
  if (!parsed || typeof parsed !== 'object') parsed = {};

  const rawContact = parsed.contact || {};
  const normalized = {
    name: cleanField(parsed.name || parsed.full_name || parsed.fullName || parsed.contact?.name || ''),
    contact: {
      email: cleanField(rawContact.email) || '',
      phone: cleanField(rawContact.phone) || '',
      location: cleanField(rawContact.location) || '',
      linkedin: cleanField(rawContact.linkedin) || '',
      portfolio: cleanField(rawContact.portfolio) || '',
      github: cleanField(rawContact.github) || ''
    },
    summary: parsed.summary || '',
    experience: arrayify(parsed.experience || parsed.jobs || parsed.work_experience || parsed.roles),
    education: arrayify(parsed.education),
    skills: arrayify(parsed.skills),
    projects: arrayify(parsed.projects),
    certifications: arrayify(parsed.certifications)
  };

  if (!normalized.name) {
    normalized.name = inferNameFromText(rawText);
  }

  // Normalize contact links so downstream PDF/link handling gets full URLs
  if (normalized.contact) {
    normalized.contact.linkedin = ensureUrl(normalized.contact.linkedin);
    normalized.contact.portfolio = ensureUrl(normalized.contact.portfolio);
  }

  return sanitizeResumeShape(normalized);
}

// Ensure a URL has a scheme. If the user or parser returned linkedin.com/in/xyz
// or github.com/user, convert to https://linkedin.com/in/xyz.
function ensureUrl(u) {
  if (!u || typeof u !== 'string') return '';
  const s = u.trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  // If it looks like a domain/path (contains a dot or starts with linkedin/github/behance), prepend https://
  if (/^[\w.-]+\/[\w\-._~:/?#[\]@!$&'()*+,;=]+$/.test(s) || /\./.test(s) || /^(linkedin|github|behance|dribbble)\./i.test(s) || /^(linkedin|github)\//i.test(s)) {
    return 'https://' + s.replace(/^\/+/, '');
  }
  return s;
}

// A line that looks like the START of a new resume entry: a job title/company
// header (often followed by a date range), a section heading (EXPERIENCE,
// EDUCATION, PROJECTS, SKILLS...), or a bullet marker. Used to find a SAFE
// place to cut between chunks — never between a header line and the bullets
// that belong to it.
const ENTRY_BOUNDARY_RE = /^(\s*(•|-|\*|●|▪)\s|\s*[A-Z][A-Za-z0-9&.,'\/ ]{2,80}\s{2,}[A-Za-z]|\s*(EDUCATION|EXPERIENCE|WORK EXPERIENCE|PROJECTS|SKILLS|CERTIFICATIONS|PUBLICATIONS|SUMMARY)\s*$)/;

// A line containing a year (date range) is very often a job/education header
// line — resumes reliably put "Month Year – Month Year" or "Year - Present"
// right on the company/title line. This is the primary signal splitResumeText
// uses to find a safe cut point between job entries.
const DATE_LINE_RE = /\b(19|20)\d{2}\b.{0,20}(–|-|to|present)/i;

function splitResumeText(rawText, maxChars = 2400) {
  const normalized = rawText.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const chunks = [];
  let current = '';
  let currentLines = [];

  function flush() {
    if (current.trim()) chunks.push(current.trim());
    current = '';
    currentLines = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!line && current.length > 0 && current.length >= maxChars * 0.8) {
      flush();
      continue;
    }

    if (current.length + line.length + 1 > maxChars && current.length > 0) {
      // We need to cut. Rather than cutting exactly here (which can land
      // between a job's header line and its bullets — the actual cause of
      // orphaned bullets becoming a fake "<UNKNOWN> at <UNKNOWN>" entry),
      // walk backward to find a JOB-ENTRY START: a header/date line, or a
      // section heading. Cutting there carries that whole header + all its
      // bullets into the next chunk together, intact.
      //
      // A bullet line is deliberately NOT treated as a safe cut point on its
      // own — the bullet immediately following a header belongs to that
      // header, and an earlier version of this function cut there, which
      // orphaned the header from its own content just as badly as the
      // original bug this function exists to prevent.
      let cutAt = currentLines.length; // default: no better boundary found
      for (let j = currentLines.length - 1; j >= Math.max(0, currentLines.length - 20); j--) {
        const l = currentLines[j];
        if (DATE_LINE_RE.test(l)) { cutAt = j; break; }
        if (/^\s*(EDUCATION|EXPERIENCE|WORK EXPERIENCE|PROJECTS|SKILLS|CERTIFICATIONS|PUBLICATIONS|SUMMARY)\s*$/i.test(l)) { cutAt = j; break; }
      }

      const keep = currentLines.slice(0, cutAt);
      const carry = currentLines.slice(cutAt);
      chunks.push(keep.join('\n').trim());
      currentLines = carry;
      current = carry.join('\n') + (carry.length ? '\n' : '');
      currentLines.push(line);
      current += line + '\n';
    } else {
      currentLines.push(line);
      current += line + '\n';
    }
  }

  flush();
  return chunks.filter(Boolean);
}

function mergeParsedResumes(parts, rawText) {
  const merged = {
    name: '',
    contact: {},
    summary: '',
    experience: [],
    education: [],
    skills: [],
    projects: [],
    certifications: []
  };

  const expMap = new Map();
  const eduMap = new Map();
  const projMap = new Map();
  const certMap = new Map();
  const skillMap = new Map();

  for (const part of parts) {
    if (!merged.name && cleanField(part.name)) merged.name = cleanField(part.name);
    if (!merged.summary && cleanField(part.summary)) merged.summary = cleanField(part.summary);

    // Merge contact field-by-field, keeping the first real (non-empty,
    // non-placeholder) value found across chunks. A naive object-spread
    // merge here would let a LATER chunk's empty/placeholder contact
    // (chunks past the first rarely contain the contact line at all)
    // silently overwrite an EARLIER chunk's correctly-parsed value.
    for (const field of ['email', 'phone', 'location', 'linkedin', 'portfolio', 'github']) {
      const existing = cleanField(merged.contact[field]);
      const incoming = cleanField(part.contact?.[field]);
      if (!existing && incoming) merged.contact[field] = incoming;
    }

    for (const exp of part.experience || []) {
      const cCompany = cleanField(exp.company);
      const cTitle = cleanField(exp.title);

      if (!cCompany && !cTitle) {
        // Orphaned bullets with no header — the chunk boundary landed between
        // a job's header line and its bullets despite splitResumeText's
        // boundary-awareness (can still happen for a single entry longer
        // than maxChars). Rather than surface this as a fake
        // "<UNKNOWN> at <UNKNOWN>" job, fold its bullets into whichever real
        // experience entry was added most recently — resumes are
        // chronological, so the immediately preceding entry in expMap
        // insertion order is almost always the job these bullets actually
        // belong to.
        const lastKey = Array.from(expMap.keys()).pop();
        if (lastKey && Array.isArray(exp.bullets) && exp.bullets.length) {
          const prev = expMap.get(lastKey);
          const bullets = new Set([...(prev.bullets || []), ...exp.bullets]);
          prev.bullets = Array.from(bullets);
        }
        // Nothing to attach to (this was the very first entry) — drop it
        // rather than invent a job. Losing a few bullets from an
        // unrecoverable split is a smaller failure than fabricating an
        // employer that doesn't exist.
        continue;
      }

      const key = `${cCompany.toLowerCase()}|${cTitle.toLowerCase()}|${(exp.dates || '').toLowerCase().trim()}`;
      const existing = expMap.get(key);
      if (existing) {
        const bullets = new Set([...(existing.bullets || []), ...(exp.bullets || [])]);
        existing.bullets = Array.from(bullets);
      } else {
        expMap.set(key, { ...exp, company: cCompany, title: cTitle, bullets: Array.isArray(exp.bullets) ? exp.bullets : [] });
      }
    }

    for (const edu of part.education || []) {
      const key = `${(edu.institution || '').toLowerCase().trim()}|${(edu.degree || '').toLowerCase().trim()}|${(edu.dates || '').toLowerCase().trim()}`;
      if (!eduMap.has(key)) eduMap.set(key, { ...edu });
    }

    for (const proj of part.projects || []) {
      const key = `${(proj.name || '').toLowerCase().trim()}|${(proj.dates || '').toLowerCase().trim()}`;
      if (!projMap.has(key)) projMap.set(key, { ...proj, bullets: Array.isArray(proj.bullets) ? proj.bullets : [] });
    }

    for (const cert of part.certifications || []) {
      const key = String(cert).toLowerCase().trim();
      if (key && !certMap.has(key)) certMap.set(key, cert);
    }

    for (const skill of part.skills || []) {
      const category = (skill.category || 'Skills').trim();
      if (!skillMap.has(category)) skillMap.set(category, new Set());
      for (const item of Array.isArray(skill.items) ? skill.items : []) {
        if (item && String(item).trim()) {
          skillMap.get(category).add(String(item).trim());
        }
      }
    }
  }

  merged.experience = Array.from(expMap.values());
  merged.education = Array.from(eduMap.values());
  merged.projects = Array.from(projMap.values());
  merged.certifications = Array.from(certMap.values());
  merged.skills = Array.from(skillMap.entries()).map(([category, items]) => ({ category, items: Array.from(items) }));

  if (!merged.name) merged.name = inferNameFromText(rawText);
  return merged;
}

async function callAI(systemPrompt, userMessage, jsonMode = false, task = null) {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // log attempt
    await debugLog({ stage: 'callAI_attempt_start', attempt });
    // Use AbortController to bound individual fetch attempts so a hung network
    // request doesn't block retries or the background worker indefinitely.
    const controller = new AbortController();
    const FETCH_TIMEOUT = 25000; // 25s per attempt — covers browser → Worker → Anthropic → back
    const fetchTimer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    let res;
    try {
      await debugLog({ stage: 'callAI_before_fetch', attempt, endpoint: HOSTED_AI_ENDPOINT });
      res = await fetch(HOSTED_AI_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: systemPrompt,
          userMessage,
          jsonMode,
          task
        }),
        signal: controller.signal
      });
      await debugLog({ stage: 'callAI_after_fetch', attempt, status: res.status });
    } catch (err) {
      clearTimeout(fetchTimer);
      await debugLog({ stage: 'callAI_fetch_error', attempt, name: err?.name, message: err?.message });
      // Convert abort into a transient timeout response so code below handles it uniformly
      if (err.name === 'AbortError') {
        const fake = { status: 408, json: async () => ({ error: { message: 'Request timed out' } }), headers: new Map() };
        res = fake;
      } else if (attempt < MAX_ATTEMPTS) {
        // Generic network failure (DNS, connection reset, offline, etc.) —
        // also worth a retry rather than failing the whole tailoring on one
        // blip.
        await debugLog({ stage: 'callAI_network_error_retry', attempt });
        await sleep(Math.min(1000 * Math.pow(2, attempt - 1), 6000));
        continue;
      } else {
        throw err;
      }
    } finally {
      clearTimeout(fetchTimer);
    }

    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      const retryAfterHeader = res.headers.get('Retry-After');
      await debugLog({ stage: 'callAI_429', attempt, body });
      const retryAfterDelay = parseRetryDelay(body?.error?.message || '')
        ?? (retryAfterHeader ? Math.max(1000, parseFloat(retryAfterHeader) * 1000) : null)
        ?? Math.min(1500 * Math.pow(1.8, attempt - 1), 8000);
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(`Rate limit reached. Please wait ${Math.ceil(retryAfterDelay / 1000)} seconds and try again.`);
      }
      // add jitter to avoid thundering herd
      const jitter = Math.floor(Math.random() * 400) - 200;
      await debugLog({ stage: 'callAI_429_wait', attempt, wait: Math.max(500, retryAfterDelay + jitter) });
      await sleep(Math.max(500, retryAfterDelay + jitter));
      continue;
    }

    // Timeouts and transient server-side errors are worth retrying — these
    // are exactly the kind of "the AI service was briefly slow" blips a
    // retry resolves, but were previously falling through to an immediate
    // failure on the very first attempt regardless of MAX_ATTEMPTS.
    if ([408, 425, 500, 502, 503, 504].includes(res.status) && attempt < MAX_ATTEMPTS) {
      const body = await res.json().catch(() => ({}));
      await debugLog({ stage: 'callAI_retryable_status', attempt, status: res.status, body });
      await sleep(Math.min(1500 * Math.pow(2, attempt - 1), 8000));
      continue;
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      await debugLog({ stage: 'callAI_not_ok', attempt, status: res.status, err });
      const message = (typeof err?.error === 'string' ? err.error : err?.error?.message) || `AI error ${res.status}`;
      // JSON generation failures shouldn't be retried — they need a different approach
      if (isJsonGenerationFailed(message)) {
        throw new Error(message);
      }
      if (isRequestTooLarge(message) && attempt < MAX_ATTEMPTS) {
        // wait progressively longer when requests are too large
        await sleep(Math.min(1500 * Math.pow(2, attempt - 1), 8000));
        continue;
      }
      if (res.status === 408) {
        throw new Error('The AI service took too long to respond after several attempts. Please try again — if this keeps happening, check that your Cloudflare Worker is deployed correctly.');
      }
      throw new Error(message);
    }

    const data = await res.json();
    let text = null;
    if (typeof data.text === 'string') {
      text = data.text;
    } else if (typeof data.output === 'string') {
      text = data.output;
    } else if (Array.isArray(data.choices) && data.choices[0]?.message?.content) {
      text = data.choices[0].message.content;
    }
    if (typeof text === 'string') return text;
      await debugLog({ stage: 'callAI_empty_response', attempt });
      throw new Error('AI returned an empty response.');
  }
}

// Repair JSON cut off mid-stream (e.g. by a max_tokens cap): walk the text
// tracking string-state and bracket depth, find the last position where every
// open value was complete, cut there, strip a dangling comma, close the stack.
// Recovers everything before the cut — for a truncated requirements array,
// that's most of the list instead of a hard parse failure.
function repairTruncatedJSON(s) {
  // Collect every position where a container ({...} or [...]) closes, with the
  // bracket stack as it stood there. Then try cutting at each, newest first:
  // strip a dangling comma, append closers for whatever is still open, and see
  // if it parses. A cut at a container boundary can never strand a bare key —
  // the earlier single-point approach could, e.g. {"requirement"} — and trying
  // multiple candidates means one malformed region doesn't sink the whole
  // salvage.
  const cuts = [];
  const stack = [];
  let inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{' || ch === '[') { stack.push(ch); continue; }
    if (ch === '}' || ch === ']') { stack.pop(); cuts.push({ i, st: [...stack] }); }
  }
  for (let k = cuts.length - 1; k >= 0 && k >= cuts.length - 25; k--) {
    const { i, st } = cuts[k];
    const head = s.slice(0, i + 1);
    const closers = [...st].reverse().map(b => (b === '{' ? '}' : ']')).join('');
    const candidate = head + closers;
    try { JSON.parse(candidate); return candidate; } catch (_) {}
  }
  return null;
}

function safeParseJSON(raw) {
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch (_) {}
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) { try { return JSON.parse(match[0]); } catch (_) {} }
  // Truncated mid-response (token cap)? Repair and salvage what arrived.
  const start = cleaned.indexOf('{');
  if (start !== -1) {
    const repaired = repairTruncatedJSON(cleaned.slice(start));
    if (repaired) { try { return JSON.parse(repaired); } catch (_) {} }
  }
  throw new Error('AI returned malformed JSON. Please try again.');
}

// Truncate text to approximate token count (1 token ≈ 4 chars)
function truncate(text, maxTokens) {
  if (!text) return '';
  return String(text).slice(0, maxTokens * 4);
}

// ── 1. Parse uploaded resume text → structured JSON ────────
// This replaces the broken regex parser entirely.
// Called once when user uploads their PDF.
export async function parseResumeText(rawText) {
  const system = `Resume parser. Output ONLY valid JSON, no markdown.
Schema: {"name":"","contact":{"email":"","phone":"","location":"","linkedin":"","portfolio":"","github":""},"summary":"","experience":[{"company":"","location":"","title":"","dates":"","bullets":[]}],"education":[{"institution":"","location":"","degree":"","dates":""}],"skills":[{"category":"","items":[]}],"projects":[{"name":"","dates":"","bullets":[]}],"certifications":[]}
Rules: preserve all bullets, all jobs, all entries. Group skills by category or use "Technical Skills". Missing fields = "" or [].
"github" is specifically a github.com profile/repo URL — put it there, not in "portfolio". "portfolio" is a personal site, GitHub Pages, Behance, or other non-GitHub link. If a github.com URL is the only link present, it still goes in "github", not "portfolio".
If the resume is split into chunks, parse only the current chunk and return any fields you can identify. Do not invent new jobs or projects, and do not remove duplicate entries.`;

  const chunks = splitResumeText(rawText, 2400);
  const parsedParts = [];
  let lastError = null;

  for (const chunk of chunks) {
    try {
      const raw = await callAI(system, `Parse this resume chunk:\n\n${chunk}`, true, 'parse_resume');
      const parsed = normalizeParsedResume(safeParseJSON(raw), chunk);
      parsedParts.push(parsed);
    } catch (err) {
      lastError = err;
      if (isRequestTooLarge(err.message)) {
        continue;
      }
      // Retry without JSON mode if failed_generation occurs
      if (isJsonGenerationFailed(err.message)) {
        try {
          const raw2 = await callAI(system + '\nRespond with pure JSON only, starting with {', `Parse this resume chunk:\n\n${chunk}`, false);
          const parsed2 = normalizeParsedResume(safeParseJSON(raw2), chunk);
          parsedParts.push(parsed2);
          continue;
        } catch (_) { /* fall through */ }
      }
      throw err;
    }
  }

  if (!parsedParts.length) {
    throw lastError || new Error('Resume parsing failed. Please try pasting your resume text manually.');
  }

  const merged = mergeParsedResumes(parsedParts, rawText);
  if (!Array.isArray(merged.experience)) {
    throw new Error('Resume parsing failed. Please try pasting your resume text manually.');
  }
  return merged;
}

// ── helpers for tailoring quality/safety (see buildTailoredResume) ─────────

// Some models, when forced by a schema to fill a required field they have no
// data for, write a placeholder like "<UNKNOWN>" instead of an empty string.
// Treat those the same as empty so they never render as literal text.
const PLACEHOLDER_RE = /^(unknown|n\/?a|none|not specified|not provided|not available|<.*>|null|undefined|tbd|pending)$/i;
function cleanField(v) {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!t || PLACEHOLDER_RE.test(t)) return '';
  return v;
}

// Rough career-span estimate from experience dates, used to decide whether a
// one-page or two-page resume target is appropriate.
function estimateCareerSpanYears(experience) {
  const currentYear = new Date().getFullYear();
  let totalYears = 0;
  for (const exp of experience || []) {
    const dates = String(exp.dates || '');
    const years = (dates.match(/\b(19|20)\d{2}\b/g) || []).map(Number);
    if (!years.length) continue;
    const start = Math.min(...years);
    const end = /present|current/i.test(dates) ? currentYear : Math.max(...years);
    // Sum actual per-role duration rather than overall earliest-to-latest
    // span — a calendar span over-counts when there's a gap in the middle
    // (e.g. time spent in school between two jobs). Give same-year roles
    // at least partial credit rather than zero.
    totalYears += Math.max(end - start, 0.5);
  }
  return Math.round(totalYears);
}

const FUZZY_STOPWORDS = new Set(['a','an','the','and','or','to','of','in','on','for','with','by','at','as','is','are','was','were','be','been','this','that','these','those','it','its','their','our','your']);

function jaccardWords(a, b) {
  const tokenize = s => String(s || '').toLowerCase().replace(/[.,;:!?()]/g, '').split(/\s+/).filter(w => w && !FUZZY_STOPWORDS.has(w));
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter);
}

// Fields the AI should never be trusted to alter — always take them from the
// original resume verbatim. This eliminates whole classes of corruption (the
// AI fabricating "<UNKNOWN>" placeholders for contact info it didn't fully
// see, subtly rewording a degree title, etc.) regardless of root cause.
function restoreFixedFields(parsed, original) {
  const origContact = original.contact || {};
  return {
    ...parsed,
    name: cleanField(original.name) || parsed.name,
    contact: {
      email: origContact.email || '',
      phone: origContact.phone || '',
      location: origContact.location || '',
      linkedin: origContact.linkedin || '',
      portfolio: origContact.portfolio || '',
      github: origContact.github || ''
    },
    education: Array.isArray(original.education) ? original.education : parsed.education,
    certifications: Array.isArray(original.certifications) ? original.certifications : parsed.certifications
  };
}

// A "bullet" this long is almost certainly paragraph-style source data
// (e.g. a README-style project description pasted in wholesale), not a
// real resume bullet — never worth restoring verbatim even if the AI's
// condensed rewrite doesn't share much vocabulary with it (condensing a
// paragraph into one sentence is SUPPOSED to drop most of the wording).
const LONG_BULLET_CHARS = 260;
// Hard ceiling applied to every bullet right before rendering, regardless
// of where it came from — a final guarantee against runaway-length bullets.
const MAX_BULLET_CHARS = 220;

// Words that can't sensibly end a sentence — if truncation lands right
// after one of these, keep trimming back until it doesn't.
const DANGLING_TRAILING_WORDS = /\b(and|or|with|for|to|of|in|on|using|via|by|the|a|an|that|which|as|including)$/i;

function capBulletLength(text) {
  const s = String(text || '').trim();
  if (s.length <= MAX_BULLET_CHARS) return s;
  const truncated = s.slice(0, MAX_BULLET_CHARS);
  const lastSpace = truncated.lastIndexOf(' ');
  let cut = (lastSpace > 100 ? truncated.slice(0, lastSpace) : truncated).trim();
  let guard = 0;
  while (DANGLING_TRAILING_WORDS.test(cut) && guard++ < 5) {
    const idx = cut.lastIndexOf(' ');
    if (idx <= 0) break;
    cut = cut.slice(0, idx).trim();
  }
  return cut.replace(/[,;:\-–—]+$/, '').trim() + '.';
}

// Safety net: if the AI dropped a bullet's substance entirely, restore it —
// using fuzzy word-overlap matching rather than exact-string matching, so a
// bullet the AI legitimately reworded doesn't ALSO get appended verbatim as
// a near-duplicate of itself. Skips original "bullets" that are really
// paragraph-length source data (see LONG_BULLET_CHARS) — those should be
// trusted to the AI's condensed rewrite, not force-restored wholesale.
// targetCount is enforced as a hard cap after merging — AI bullets always
// take priority (they come first in `merged`), with restored-original
// bullets only filling in if there's room left. This is a stronger
// guarantee than fuzzy matching alone: long, jargon-dense bullets can
// legitimately share very little vocabulary even when they cover the same
// underlying point, which let a near-duplicate slip past the similarity
// check before — capping the total count bounds the damage regardless.
function restoreMissingBullets(tailoredList, originalList, targetCount) {
  if (!Array.isArray(tailoredList)) return tailoredList;
  return tailoredList.map((entry, i) => {
    const orig = (originalList || [])[i];
    if (!orig) return entry;
    const aiBullets = Array.isArray(entry.bullets) ? entry.bullets : [];
    const origBullets = Array.isArray(orig.bullets) ? orig.bullets : [];
    const merged = [...aiBullets];
    for (const ob of origBullets) {
      if (String(ob || '').length > LONG_BULLET_CHARS) continue; // trust the AI's condensed version
      const isRepresented = merged.some(ab => jaccardWords(ab, ob) >= 0.2);
      if (!isRepresented) merged.push(ob);
    }
    const capped = targetCount ? merged.slice(0, targetCount) : merged;
    return { ...entry, bullets: capped.map(capBulletLength) };
  });
}

// Hard backstop: strip AI-generated title-claim summaries.
// Pattern: the first few words are "[adjective(s)] Engineer/Developer/etc."
// e.g. "Backend engineer with...", "ML Engineer who...", "Applied AI Engineer..."
const TITLE_WORDS = ['engineer', 'developer', 'analyst', 'scientist', 'architect', 'practitioner', 'specialist'];
const TITLE_PREFIXES = ['backend', 'frontend', 'full-stack', 'fullstack', 'ml', 'ai', 'data', 'cloud', 'platform', 'genai', 'software', 'senior', 'junior', 'staff', 'principal', 'applied', 'generative'];

function stripTitleClaim(summary, realTitles) {
  if (!summary) return summary;
  const words = summary.trimStart().split(/\s+/);
  if (words.length < 3) return summary;

  // Check whether the first 1, 2, or 3 words are a title-claim phrase
  // (e.g. "Backend engineer", "ML Engineer", "Applied AI Engineer")
  let titleWordIdx = -1;
  for (let i = 0; i <= Math.min(3, words.length - 1); i++) {
    if (TITLE_WORDS.includes(words[i].toLowerCase().replace(/[.,]$/, ''))) {
      // Verify the words before it are in the prefix list
      const prefixWords = words.slice(0, i).map(w => w.toLowerCase().replace(/[^a-z-]/g, ''));
      if (i === 0 || prefixWords.every(p => TITLE_PREFIXES.includes(p))) {
        titleWordIdx = i;
        break;
      }
    }
  }
  if (titleWordIdx === -1) return summary; // no title claim found

  // Check it actually matches one of the candidate's real job titles
  const claimedTitle = words.slice(0, titleWordIdx + 1).join(' ').toLowerCase();
  const matchesRealTitle = (realTitles || []).some(t => {
    const rt = String(t || '').toLowerCase();
    // The claimed title must be an exact match to the real title, not just
    // sharing a first word — "Data Engineer" should NOT pass because "Data
    // Analyst" is a real title (different role), only "Data Analyst" itself.
    return rt === claimedTitle;
  });
  if (matchesRealTitle) return summary;

  // Strip the title-claim preamble — everything up to and including the
  // first period/comma after the title word, then resume from the next word.
  const afterTitle = words.slice(titleWordIdx + 1).join(' ').trim();
  // Strip common connectors like "with", "who", "that", "specializing in" at start
  const stripped = afterTitle.replace(/^(with |who |that |specializing\s+in |and |,\s*|—\s*|–\s*)/i, '').trim();
  // Capitalize first letter
  return stripped ? stripped.charAt(0).toUpperCase() + stripped.slice(1) : summary;
}

// ── 2. Tailor resume for a job ─────────────────────────────
export async function buildTailoredResume({ jobDescription, resumeData, skillProfile, originalText, additionalInfo }) {
  // Build ranked skill list — used to tell AI what to prioritize
  const rankedSkills = (skillProfile?.skills || [])
    .sort((a, b) => b.level - a.level)
    .slice(0, 6)
    .map(s => `${s.name}:${s.level}%`)
    .join(', ');

  const careerSpan = estimateCareerSpanYears(resumeData.experience);
  const numJobs = (resumeData.experience || []).length;
  const allowTwoPages = careerSpan >= 4 || numJobs >= 4;
  const targetExpBullets = allowTwoPages ? 4 : 3;
  const targetProjBullets = 3;

  // Send the FULL original content. The old 2-bullet-per-role trim was a
  // token-saving workaround for the previous (free-tier, 6000 TPM) Groq
  // backend — Claude Haiku 4.5 has a 200K context window and doesn't need
  // it. Pre-trimming also meant most bullets were never seen by the AI at
  // all, so a later "restore the bullets we hid" step had to re-append them
  // verbatim — and because that step matched on exact text, a bullet the AI
  // *did* rephrase would get restored too, creating visible near-duplicates.
  // Sending everything up front avoids both problems at the source.
  const trimmedResume = resumeData;

  const system = `You are a world-class ATS resume writer. Tailor the given resume JSON for a job description.

ABSOLUTE RULES — NEVER VIOLATE:
1. Output ONLY valid parseable JSON. Zero markdown, zero commentary.
2. Preserve the EXACT schema — same keys, same nesting, same array structures.
3. NEVER invent experience, companies, dates, degrees, metrics, or projects.
4. NEVER remove any job, project, or education entry.
5. NEVER change company names, job titles, dates, contact info, or education details — copy those fields through unchanged.
6. "skills" MUST stay as array of {category, items[]} objects.
7. Avoid opening the summary with a specific "X years of experience" claim. Career gaps, school, or overlapping roles usually make a single number debatable even when well-intentioned — describe the candidate by their actual roles and concrete impact instead of asserting a headline year count. Only state a specific number if the work history is unambiguous and gapless.
8. NEVER invent or imply hands-on experience with a specific technology, tool, or methodology that isn't actually in the resume — even when the job description emphasizes it heavily. If the JD wants something the candidate's history doesn't show, leave it out rather than implying coverage through vague language.
9. The summary must NOT open with a professional title/identity label. This means any phrasing that starts with a job-title adjective: "ML Engineer with...", "Backend Engineer who...", "Applied AI Engineer...", "Software Engineer with...", "Senior Engineer...", "Data Engineer...", "Full-stack Engineer..." etc. — this includes ANY combination of a technical specialty word + "Engineer/Developer/Analyst/Scientist" as the opening phrase. Open with a concrete action instead: "Built and shipped...", "Designed and deployed...", "Engineered production systems...", "Experienced in..." These are allowed only if "Engineer" or "Developer" is the EXACT word in one of the candidate's real job titles AND you're not prepending a specialty word that changes what it claims. When in doubt, start with what they built, not what title they held.
10. If the candidate provided "ADDITIONAL TRUTHFUL INFO" below, you may incorporate it (e.g. as a new skill, or woven into the summary) since the candidate has confirmed it's true — but never extrapolate beyond what they actually wrote.

JD THEME COVERAGE — like a good recruiter would do, not just keyword stuffing:
- Identify the 3-5 ideas the JD emphasizes most (repeated language, things listed first, things described in detail) — these matter more than items mentioned only once in passing.
- For each theme the candidate's ACTUAL experience genuinely connects to (even loosely — e.g. their RAG/LLM-orchestration work is relevant to a JD about "agentic workflows" even if they've never used the exact framework named), make that connection explicit in the summary or a bullet, using the JD's own terminology where it's honestly applicable.
- For themes the candidate's resume shows NO real connection to, don't paper over the gap with vague language ("strong foundation in X") — just don't mention it. A resume that's honestly silent on a gap is far better than one that implies coverage it doesn't have.

BULLET COUNT & LENGTH — for a consistent, evenly-formatted resume:
- For EACH experience entry, condense to exactly ${targetExpBullets} bullets. If the original has more, merge related points together rather than dropping their substance. If it has fewer, keep what's there — never invent new ones to hit the count.
- This target applies EQUALLY to every entry, regardless of how relevant that role seems to this specific JD. A role that connects less obviously to the JD still gets ${targetExpBullets} bullets by merging/condensing its own real content — never fewer just because it feels like a weaker match. An uneven resume (one role at full detail, another looking sparse) reads as a red flag to a recruiter regardless of the reason, so don't let relevance judgments show up as bullet-count differences.
- For EACH project entry, use exactly ${targetProjBullets} bullets, same rule.
- EVERY bullet must be ONE concise sentence, roughly 15–25 words — never a paragraph. If the source material for a point is long-form (e.g. a multi-sentence project description), condense it down to its single most concrete, impressive point. Length matters as much as count here — a 2-sentence or paragraph-length "bullet" is a failure even if the count is right.
- This candidate has roughly ${careerSpan || 'a few'} years of experience across ${numJobs} role(s) — ${allowTwoPages ? 'a two-page resume is fine given that experience level' : 'aim to fit the whole resume on ONE page, so stay concise'}.

WHAT TO CHANGE:
- Condense and reorder bullets within each job to put the most JD-relevant points first, per the bullet-count rule above.
- Rephrase bullets to naturally reflect the JD's actual themes (see JD THEME COVERAGE above), not just inserted keywords — touch every bullet, not just the first couple.
- Rewrite summary to speak directly to this role, grounded only in what's actually in the resume.
- Reorder skill items within categories to front-load relevant ones.`;

  const userMsg = `JD (focus on keywords, required skills, responsibilities):
${truncate(jobDescription, 1200)}

CANDIDATE SKILLS (ranked by confidence): ${rankedSkills || 'see resume'}
${additionalInfo && additionalInfo.trim() ? `\nADDITIONAL TRUTHFUL INFO FROM CANDIDATE (confirmed true, ok to incorporate):\n${truncate(additionalInfo, 300)}\n` : ''}
RESUME JSON:
${truncate(JSON.stringify(trimmedResume), 6000)}

Return tailored resume JSON only. Preserve schema exactly.`;

  let raw;
  try {
    raw = await callAI(system, userMsg, true, 'tailor_resume');
  } catch (err) {
    await debugLog({ stage: 'buildTailoredResume_callAI_failed', message: err?.message || String(err) });
    // If JSON mode caused a failed_generation error, retry without JSON mode
    if (isJsonGenerationFailed(err.message)) {
      try {
        await debugLog({ stage: 'buildTailoredResume_retry_no_json_mode' });
        raw = await callAI(system + '\n\nIMPORTANT: Respond with pure JSON only. Start with { end with }.', userMsg, false);
      } catch (err2) {
        await debugLog({ stage: 'buildTailoredResume_retry_failed', message: err2?.message || String(err2) });
        throw new Error('Failed to generate tailored resume. Please try again in a moment.');
      }
    } else if (isRequestTooLarge(err.message) || /rate limit|TPM|tokens per minute/i.test(err.message)) {
      // If we hit rate limits or request-too-large, attempt a lightweight fallback
      try {
        const tiny = await buildTailoredResumeFallback({ jobDescription, resumeData, skillProfile });
        await debugLog({ stage: 'buildTailoredResume_fallback_ok' });
        return tiny;
      } catch (err2) {
        await debugLog({ stage: 'buildTailoredResume_fallback_failed', message: err2?.message || String(err2) });
        throw err; // rethrow original so user sees the cause
      }
    } else {
      throw err;
    }
  }
  let parsed = sanitizeResumeShape(safeParseJSON(raw));

  if (!parsed.name || !Array.isArray(parsed.experience)) {
    throw new Error('Tailoring failed — invalid output. Please try again.');
  }

  // Lock down fields the AI shouldn't touch, then patch in any bullet whose
  // substance went missing (fuzzy-matched, so reworded bullets don't also
  // get a verbatim duplicate appended).
  parsed = restoreFixedFields(parsed, resumeData);

  // Hard backstop: remove any AI-generated title-claim opening even if the
  // prompt rule was ignored (e.g. "Backend Engineer with..." when none of
  // the candidate's real titles say "Backend Engineer").
  const realTitles = (resumeData.experience || []).map(e => String(e.title || ''));
  if (parsed.summary) parsed.summary = stripTitleClaim(parsed.summary, realTitles);

  parsed.experience = restoreMissingBullets(parsed.experience, resumeData.experience, targetExpBullets);
  parsed.projects = restoreMissingBullets(parsed.projects, resumeData.projects, targetProjBullets);

  return parsed;
}

// Fallback: attempt a much smaller tailoring request when the primary call fails
// due to rate limits or request size. This keeps UX responsive under tight TPM.
async function buildTailoredResumeFallback({ jobDescription, resumeData, skillProfile }) {
  const rankedSkills = (skillProfile?.skills || [])
    .sort((a, b) => b.level - a.level)
    .map(s => `${s.name}:${s.level}%`)
    .join(', ');

  const trimmedResume = {
    ...resumeData,
    experience: (resumeData.experience || []).map(exp => ({
      ...exp,
      bullets: (exp.bullets || []).slice(0, 2)
    })),
    projects: (resumeData.projects || []).map(p => ({
      ...p,
      bullets: (p.bullets || []).slice(0, 1)
    }))
  };

  const system = `You are a concise ATS resume rewriter. Output ONLY valid JSON with the same schema.`;

  const userMsg = `JD (short):\n${truncate(jobDescription, 400)}\n\nSKILLS: ${rankedSkills || 'see resume'}\n\nRESUME JSON:\n${truncate(JSON.stringify(trimmedResume), 800)}\n\nReturn tailored resume JSON only.`;

  async function attemptTailor(extraInstruction = '') {
    const raw = await callAI(system, userMsg + extraInstruction, true, 'tailor_resume');
    let parsed = sanitizeResumeShape(safeParseJSON(raw));
    parsed = restoreFixedFields(parsed, resumeData);
    parsed.experience = (parsed.experience || []).map(exp => ({ ...exp, bullets: (exp.bullets || []).map(capBulletLength) }));
    parsed.projects = (parsed.projects || []).map(p => ({ ...p, bullets: (p.bullets || []).map(capBulletLength) }));
    return parsed;
  }

  let parsed = await attemptTailor();

  // A role that looks less relevant to THIS job can end up under-developed
  // even with the prompt rule above — the model treating low relevance as
  // license to show less, rather than merging what's actually there up to
  // the same target as every other entry. Only flag this when the ORIGINAL
  // source genuinely had enough content to hit the target — a role that was
  // honestly thin to begin with should stay thin, that's not a bug.
  const original = arrayify(resumeData?.experience);
  const underdeveloped = (parsed.experience || []).find((exp, i) => {
    const origBulletCount = arrayify(original[i]?.bullets).length;
    const gotBulletCount = arrayify(exp.bullets).length;
    return origBulletCount >= targetExpBullets && gotBulletCount < targetExpBullets - 1;
  });
  if (underdeveloped) {
    parsed = await attemptTailor(
      `\n\nOne more thing: make sure "${underdeveloped.company || underdeveloped.title || 'every'}" also gets the full ${targetExpBullets} bullets by merging its own real content — the original had enough material for that, don't under-develop it just because it connects less directly to this JD.`
    );
  }

  return parsed;
}

// ── 3. Cover letter ────────────────────────────────────────
export async function buildCoverLetter({ jobDescription, tailoredResume, skillProfile, applicantName, companyName, roleTitle }) {
  const topSkills = (skillProfile?.skills || [])
    .sort((a, b) => b.level - a.level).slice(0, 6).map(s => s.name).join(', ')
    || (tailoredResume.skills || []).flatMap(s => s.items || []).slice(0, 6).join(', ');

  const expLines = (tailoredResume.experience || []).slice(0, 2)
    .map(e => `${e.title} @ ${e.company}: ${(e.bullets || []).slice(0, 2).join(' | ')}`)
    .join('\n');

  const system = `You are the job applicant, writing this cover letter in your own voice about your own experience.
Write in FIRST PERSON throughout — "I built", "my work at", "I led" — never in third person about the
candidate ("your work", "you built", "their experience"). This is the applicant's own letter, not a
recommendation written by someone else about them.
Rules: Open with a hook (never "I am writing to..."). 3 paragraphs, ~260 words.
Reference specific JD details. Connect real achievements to role needs, always as your own, in first person.
Output ONLY the letter body — no date, salutation, or sign-off.`;

  const body = await callAI(system,
    `You are ${applicantName}, applying for: ${roleTitle} at ${companyName}\nJob description: ${truncate(jobDescription, 1200)}\nYour top skills: ${topSkills}\nYour experience:\n${expLines}\nYour summary: ${truncate(tailoredResume.summary || '', 300)}\n\nWrite the letter as yourself, in first person.`,
    false
  );

  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  return `${today}\n\nDear Hiring Manager,\n\n${body.trim()}\n\nSincerely,\n${applicantName}`;
}

// ── 4. Why us ──────────────────────────────────────────────
export async function buildWhyUs({ jobDescription, tailoredResume, applicantName, companyName, roleTitle }) {
  const system = `Write a 2-3 sentence "Why this company?" answer. Be specific and genuine. No clichés. Output only the answer.`;
  return callAI(system,
    `Applicant: ${applicantName}\nRole: ${roleTitle} at ${companyName}\nJD: ${truncate(jobDescription, 800)}\nSummary: ${truncate(tailoredResume.summary || '', 200)}`,
    false
  );
}

// ── 5. Custom application questions ─────────────────────────
// Answers an arbitrary list of free-text application questions (e.g. "Why
// are you a good fit?", "Describe a challenging project") grounded in the
// tailored resume — never inventing facts not present in it.
export async function buildApplicationAnswers({ jobDescription, tailoredResume, applicantName, companyName, roleTitle, questions }) {
  const qs = (questions || []).map(q => String(q || '').trim()).filter(Boolean);
  if (!qs.length) return [];

  const expLines = (tailoredResume.experience || []).slice(0, 3)
    .map(e => `${e.title} @ ${e.company}: ${(e.bullets || []).slice(0, 2).join(' | ')}`)
    .join('\n');

  const system = `You are helping a job applicant answer screening questions for a job application.
Output ONLY valid JSON, no markdown: {"answers":["answer 1","answer 2", ...]}
Rules:
- Return exactly one answer per question, in the same order as given.
- Ground every answer in the candidate's actual resume below — never invent employers, titles, metrics, or experience that isn't there.
- Each answer is 2-4 sentences, specific and conversational, not generic filler.
- Reference the job description's needs where relevant.`;

  const userMsg = `Role: ${roleTitle} at ${companyName}
JD: ${truncate(jobDescription, 1000)}
Applicant: ${applicantName}
Summary: ${truncate(tailoredResume.summary || '', 300)}
Experience:
${expLines}

Questions (answer each in order):
${qs.map((q, i) => `${i + 1}. ${q}`).join('\n')}`;

  let raw;
  try {
    raw = await callAI(system, userMsg, true, 'application_answers');
  } catch (err) {
    if (isJsonGenerationFailed(err.message)) {
      raw = await callAI(system + '\nRespond with pure JSON only, starting with {', userMsg, false);
    } else {
      throw err;
    }
  }

  const parsed = safeParseJSON(raw);
  const answers = Array.isArray(parsed.answers) ? parsed.answers : [];
  return qs.map((q, i) => ({ question: q, answer: String(answers[i] || '').trim() || 'Could not generate an answer for this question.' }));
}

// ── 6. AI-based match analysis ──────────────────────────────
// Replaces the old pure-keyword-overlap heuristic (still kept in
// src/lib/analysis.js as a fallback if this call fails). The heuristic
// approach required constantly patching against new failure modes — page
// chrome from different job sites, capitalized section headers, company
// names looking like named technologies, "Machine"/"Learning" not
// recognized as one concept when not literally adjacent — because it has
// no actual understanding of the text, just word-frequency counting. An
// AI call can be told to ignore navigation/badge noise and use real
// judgment, the same way a recruiter would skim a JD and a resume side by
// side, instead of pattern-matching token by token.
// ── Shared quality filters for extracted requirement labels ────────────────
// Used by both the extraction pass and the coverage-judgment pass, so a
// label is held to the exact same bar regardless of which call produced it.
const KNOWN_KINDS = new Set(['technical', 'experience', 'domain', 'language', 'methodology', 'interpersonal']);
// Kinds that don't count toward the score — real, worth showing, but not
// something a real ATS keyword match weighs the way it weighs a hard skill.
const UNSCORED_KINDS = new Set(['language', 'interpersonal']);

// Filler the model sometimes leaves in despite instructions. Strip it from
// the front of a label rather than reject the whole item — the underlying
// requirement is usually still real, just wrapped in JD phrasing.
const FILLER_PREFIX = /^(comfortable with|deep familiarity with|familiarity with|experience with|experienced with|ability to|skilled in|knowledge of|understanding of|proficient in|proficiency in)\s+/i;

function normalizeLabel(s) {
  let t = String(s).trim();
  t = t.replace(FILLER_PREFIX, '').trim();
  if (t.length) t = t.charAt(0).toUpperCase() + t.slice(1);
  return t;
}

function soundRequirement(r) {
  if (!r || typeof r !== 'object') return false;
  if (typeof r.requirement !== 'string' || r.requirement.trim().length < 2) return false;
  // A label ending in a comma, semicolon, or trailing "and"/"or" is a
  // crammed multi-item list the model truncated instead of splitting —
  // malformed by construction, not a real single requirement.
  if (/[,;]\s*$/.test(r.requirement.trim())) return false;
  if (/\b(and|or)\s*$/i.test(r.requirement.trim())) return false;
  // "Data Engineering Tools Proficiency", "Cloud Skills", "Systems
  // Expertise" — a label ending in one of these is a category-summary
  // buzzword, not a distinct requirement. It's almost always restating
  // whatever specific tools were ALSO listed separately (Spark, Airflow,
  // Kafka...), just under a vaguer umbrella name — double-counting the
  // same gap under two labels.
  if (/\b(proficiency|expertise|competency|competence)\s*$/i.test(r.requirement.trim())) return false;
  // A bare single word that's a common verb/gerund fragment — "Apply",
  // "Participate", "Contribution" — is a grammatical remnant of a JD
  // sentence the model shredded into pieces, not a real requirement.
  // Exact match only (case-insensitive, whole label) — this can never
  // catch a legitimate multi-word term like "Contribution Guidelines" or
  // a term that merely CONTAINS one of these words.
  const BARE_VERB_FRAGMENT = new Set([
    'apply', 'applying', 'participate', 'participating', 'contribute',
    'contributing', 'contribution', 'contributions', 'collaborate',
    'collaborating', 'engage', 'engaging', 'join', 'joining', 'assist',
    'assisting', 'support', 'supporting', 'help', 'helping',
    'build', 'building', 'feature', 'features'
  ]);
  if (BARE_VERB_FRAGMENT.has(r.requirement.trim().toLowerCase())) return false;
  // "Top Product-Led Tech Company", "VC-Backed Startup", "Fast-Paced
  // Environment" — these describe the KIND OF PLACE someone has worked,
  // not something the candidate can show. Not skills, and can't be added
  // to a resume the way a real capability can.
  if (/\b(vc.?backed|product.?led|high.?growth|fortune\s*500|fast.?paced)\b/i.test(r.requirement.trim())) return false;
  // A degree is a credential, not a skill — either the candidate has it or
  // doesn't, and there's nothing to "add" here the way there is for a real
  // capability. Requires the possessive ("bachelor's"/"master's") to avoid
  // false-positiving on real terms like "Master Data Management" or "MS SQL
  // Server" — bare "b.s."/"m.s." abbreviations were dropped entirely for
  // the same reason, too ambiguous with Microsoft-branded tech terms.
  if (/\bdegree\b|bachelor'?s\b|master'?s\b|\bmba\b|\bphd\b/i.test(r.requirement.trim())) return false;
  // Verbose entries (the model quoting a JD sentence despite instructions)
  // still COUNT — they're real requirements and belong in the denominator.
  // Discarding them was how a whole evaluation could silently collapse to
  // zero requirements and render as "couldn't read a job description".
  // We trim them for display instead of dropping them.
  return true;
}

function compactRequirement(s) {
  const t = String(s).trim();
  if (t.length <= 90) return t;
  // Cut at a natural boundary near the front — commas, dashes, "including"
  const cut = t.slice(0, 90);
  const natural = Math.max(cut.lastIndexOf(','), cut.lastIndexOf(' — '), cut.lastIndexOf(' - '), cut.lastIndexOf(' including'));
  return (natural > 30 ? cut.slice(0, natural) : cut).trim();
}

// A requirement only counts — toward the checklist AND the score — if the
// model could name a real artifact for it. An item with no artifact, or an
// evasive one ("experience", "track record"), is JD prose the model
// couldn't actually justify as checkable. Drop it entirely: not shown, not
// scored, not silently inflating either side of the fraction.
const EVASIVE = /^(experience|examples?|past (work|projects?|roles?)|evidence|background|history|track record|demonstrated .*|their (work|experience)|n\/?a|none|unclear|nothing specific)$/i;
function hasRealArtifact(r) {
  if (r.covered === true) return true;   // already satisfied — artifact quality moot
  const a = typeof r.artifact === 'string' ? r.artifact.trim() : '';
  return a.length >= 4 && !EVASIVE.test(a);
}

// Run a checklist item array through the shared quality bar in one place.
// Programming language names that could plausibly be confused with the
// "language" kind (spoken/written human languages) given the word itself —
// Java is the clearest case (also a place, also slang for coffee). A
// misclassification here isn't cosmetic: it silently moves a real,
// scored technical requirement into the unscored bonus section. Forced to
// technical regardless of what the model tagged it, as a backstop the
// prompt instruction alone can't fully guarantee.
const PROGRAMMING_LANGUAGE_NAMES = new Set([
  'java', 'go', 'golang', 'r', 'c', 'swift', 'rust', 'ruby', 'dart', 'elixir',
  'julia', 'perl', 'scala', 'kotlin', 'haskell', 'lua', 'crystal', 'zig'
]);

function cleanChecklist(items) {
  return items
    .filter(soundRequirement)
    .filter(hasRealArtifact)
    .map(r => {
      let kind = KNOWN_KINDS.has(r.kind) ? r.kind : 'experience';
      if (kind === 'language' && PROGRAMMING_LANGUAGE_NAMES.has(r.requirement.trim().toLowerCase())) {
        kind = 'technical';
      }
      return { ...r, requirement: normalizeLabel(r.requirement), kind };
    });
}

// The rules shared by both passes for what makes a real, checkable
// requirement — extracted once so the extraction pass and the fallback
// paths judge quality identically.
const REQUIREMENT_QUALITY_RULES = `Each entry:
    {
      "requirement": "<SHORT label, 2-8 words — NOT a quoted sentence>",
      "kind":        "technical" | "experience" | "domain" | "language" | "methodology" | "interpersonal",
      "artifact":    "<what a candidate would show you>"
    }

Do NOT include pure years-of-experience / tenure requirements at all
("10+ years", "5 years in a senior role"). Those are evaluated separately,
outside this checklist. If a requirement is ONLY a span of time with
nothing else in it, skip it.

Do NOT include employer-pedigree or environment descriptors — these describe
the KIND OF PLACE someone has worked, not something the candidate can show:
    "Top product-led tech company", "VC-backed startup", "Fast-paced
    environment", "Fortune 500 experience", "High-growth company"
None of these are skills. Skip them entirely — they cannot be added to a
resume the way a real capability can, and scoring against them would
penalize a candidate for their employer's characteristics, not their own.

Do NOT include education or degree requirements ("Computer Science degree",
"Bachelor's in Engineering", "MBA preferred"). A degree is a credential, not
a skill — either the candidate has it or doesn't, and there's nothing to
"add" here the way there is for a real capability. Skip these entirely.

Spoken or written LANGUAGE requirements ("Fluent in Mandarin", "Spanish
proficiency") get their OWN kind: "language". They're real and worth
knowing about, but a real ATS keyword match doesn't weigh a language the
way it weighs a technical skill, and neither should this score — they're
evaluated and shown, but kept OUT of the score entirely, same as tenure.

Named METHODOLOGIES and practices ("Agile", "Scrum", "TDD", "CI/CD",
"Six Sigma") get their own kind: "methodology". These ARE genuinely
keyword-matched by a real ATS — unlike languages or soft skills — so they
still count toward the score, just grouped separately from raw tools so
the candidate can see the shape of what they're missing.

Bare, generic INTERPERSONAL descriptors ("Communication", "Teamwork",
"Leadership" used as a trait rather than a demonstrated act, "Stakeholder
Management" with no concrete engagement behind it) get their own kind:
"interpersonal". A real ATS keyword match barely weighs these — they're
too generic and overused across every resume to carry discriminative
signal — so treat them like language: evaluated and shown, but kept OUT
of the score. This is different from "experience" — "Briefed executives
directly" or "Led a team of 5 through a migration" is a demonstrated act
with a real artifact behind it and stays kind: experience, counted
normally. The distinction is concreteness: a vague trait is
interpersonal; a specific thing someone did is experience.

"requirement" must be a compact label a recruiter would write on a
checklist, never the JD's full sentence. Distill:
    JD says: "Proven track record designing and managing complex,
              multi-stakeholder AI or digital-transformation engagements"
    You write: "Led multi-stakeholder AI engagements"     (kind: experience)
    JD says: "Working knowledge of knowledge graph principles, semantic
              technologies, and standards (RDF, SPARQL)"
    You write THREE entries: "Knowledge Graphs", "RDF", "SPARQL"  (technical)
    JD says: "Strong written and verbal communication with executives"
    You write: "Briefed executives directly"                (kind: experience)
    JD says: "Deep familiarity with vLLM, SGLang, and other inference
              serving engines, comfortable with token scheduling and
              batching"
    You write FOUR entries: "vLLM", "SGLang", "Token Scheduling",
    "Batching" — never one crammed label. A requirement that lists several
    named things joined by commas or "and" is always several requirements,
    not one. Never let an entry end mid-list with a trailing comma — that
    means it should have been split, not truncated.

Strip filler from the front of every label — the label is the THING, not
the phrasing the JD wrapped around it:
    "Comfortable with PCIe"              →  "PCIe"
    "Deep familiarity with CUDA"         →  "CUDA"
    "Experience with distributed systems" →  "Distributed Systems"
    "Ability to work with hardware teams" →  "Hardware Team Collaboration"

NEVER extract a bare, isolated word ripped out of a sentence. A real
requirement is always a coherent noun phrase naming a real thing — never
a lone verb, a lone gerund, or a company/product name mistaken for a skill:
    JD bullet: "Opportunities to apply cutting-edge research, participate
                in open-source projects, and make contributions to the
                team's shared tooling"
    WRONG: "Apply", "Participate", "Contribution" — these are grammatical
    fragments of one sentence, not three requirements.
    RIGHT: either capture the underlying THING once — "Open-Source
    Contribution" (kind: experience) — or, if nothing concrete survives
    stripping the sentence down, skip the whole bullet. It is describing
    a general attitude toward the work, not a checkable requirement.

    If the JD mentions the HIRING COMPANY'S OWN NAME, or an internal /
    proprietary platform the company built (its own product, not a
    third-party tool), that is not a missing skill — it's who's hiring
    you. Never list the employer's own name or brand as a requirement,
    even if it appears many times in the posting. The one exception: the
    JD explicitly demands PRIOR hands-on experience with that exact named
    platform as a hiring bar ("3+ years operating our proprietary X
    platform") — rare, and it will say so plainly, not just mention the
    name in passing.

"kind" — technical, experience, domain, and methodology are addable and
count toward the score. language and interpersonal are real and worth
showing, but EXCLUDED from the score — same treatment as tenure.
    technical    — a named tool, platform, programming language, framework,
                   protocol, technique, or certification. RAG, SPARQL,
                   Kubernetes, Python, Now Assist, "Certified Implementation
                   Specialist". (A PROGRAMMING language — Python, Go, Rust —
                   is technical. A SPOKEN/WRITTEN human language is not.)
    experience   — something a person DID, or a way of working, that they
                   could have done and never written down. "Advised C-suite
                   on AI strategy", "Led multi-stakeholder transformation",
                   "Briefed executives", "Reviewed peers' code".
    domain       — industry or functional background. "Financial services",
                   "Healthcare", "Regulated industries", "B2B SaaS".
    methodology  — a named practice or framework: "Agile", "Scrum", "TDD",
                   "CI/CD", "Six Sigma". Counted, same as technical — just
                   grouped separately so its shape is visible.
    language     — a spoken or written human language: "Mandarin", "Spanish
                   fluency", "Bilingual English/French". Not counted. Watch
                   for false alarms: "Java" is a PROGRAMMING language — kind
                   technical, never language, despite the word itself.
    interpersonal — a bare, generic trait with no concrete act behind it:
                   "Communication", "Teamwork", "Stakeholder Management"
                   with nothing specific attached. Not counted — contrast
                   with experience, which is a demonstrated act ("Briefed
                   executives") and stays counted.

"artifact" — describes the REQUIREMENT ITSELF, not any particular resume.
Ask: "if ANY candidate genuinely met this requirement, what would they be
able to show an interviewer?" Keep it under 8 words — it is a label, not
an explanation.
    technical  → a deployment manifest they wrote. A SPARQL query. The
                 certificate itself.
    experience → the engagement itself. "the transformation programme they
                 led". "the executives they briefed". "the PR they reviewed".
    domain     → where someone would have worked in it. "two years at a
                 bank". "built HIPAA-compliant systems at a health company".

Only skip a requirement entirely — omit it from the array — when it is so
vague that NO candidate could show anything for it: "team player",
"passionate about technology", "fast-paced environment". That is rare. A
concrete requirement stays in, with a real artifact, even if it's something
this particular candidate is unlikely to have.

One more skip case: a category-summary umbrella like "Data Engineering
Tools Proficiency" or "Cloud Skills" — when the JD names the SPECIFIC
tools within that category elsewhere (Spark, Airflow, Kafka...), the
umbrella term is the same gap counted twice under a vaguer name. List
the specific tools as their own entries; skip the umbrella entirely.

Enumerate EVERY requirement that survives this test — do not cap or
shortlist. Two readings of the same job description should produce close
to the same list.`;

// ── Pass 1: extract the checklist from the JD alone ─────────────────────
// No resume involved yet — this is purely "what does this job ask for?".
// Kept deliberately separate from judging coverage so it can never be
// starved of output room by also having to write a coverage verdict and
// artifact for every item in the same breath as everything else; and so a
// re-evaluation later never has to pay for re-deriving this list at all.
async function extractRequirementsChecklist(jobDescription) {
  const system = `You are a recruiter building a requirements checklist from a job description — nothing else yet, no coverage judgment.

Rules:
1. Output ONLY valid JSON, no markdown.
2. The job description text below may include leftover page navigation, badges, or sidebar content from wherever it was captured (e.g. "Verified", "On-Site", "Posted 2 weeks ago", "57 applicants", "Easy Apply", related-job suggestions, the hiring company's own name and its sister brands). Ignore all of that — focus only on the actual role's real requirements: skills, technologies, tools, responsibilities, and qualifications.

Return a JSON object with exactly these keys:
{
  "requirements": [ ... ],
  "job_title": "<exact role title, or null if unclear>",
  "company": "<hiring company's name as stated in the JD content, or null>"
}

"requirements": EVERY requirement this job description states. Read the
qualifications and responsibilities and list what the job asks for.

${REQUIREMENT_QUALITY_RULES}

"job_title": the exact role title from this job description. Just the
title — not the company, not the location, not seniority boilerplate.

"company": the company actually hiring for this role, read from the JD's
content, not page furniture (a LinkedIn page says "LinkedIn" everywhere,
but the hiring company is named in the description itself).`;

  const userMsg = `JOB DESCRIPTION (may contain page noise — see rule 2 above):
${truncate(jobDescription, 4000)}

Return the requirements checklist JSON only.`;

  async function attemptOnce() {
    const raw = await callAI(system, userMsg, true, 'ats_extract');
    return safeParseJSON(raw);
  }

  let parsed = await attemptOnce();
  let ok = Array.isArray(parsed.requirements) && parsed.requirements.length > 0;
  if (!ok) parsed = await attemptOnce();   // retry 1
  ok = Array.isArray(parsed.requirements) && parsed.requirements.length > 0;
  if (!ok) parsed = await attemptOnce();   // retry 2

  const requirements = Array.isArray(parsed.requirements) ? parsed.requirements : [];
  return {
    requirements: cleanChecklist(requirements),
    job_title: typeof parsed.job_title === 'string' && parsed.job_title.trim() ? parsed.job_title.trim() : null,
    company: typeof parsed.company === 'string' && parsed.company.trim() ? parsed.company.trim() : null
  };
}

// ── Pass 2: judge coverage of a FIXED checklist against the resume ──────
// Never asked to invent new items — only to say true/false for each one it
// is given, plus a holistic fit read. This is the only call that ever sees
// the resume, and it is the only call a re-evaluation needs to repeat.
async function judgeChecklistCoverage(checklist, tailoredResume, jobDescription) {
  const system = `You are a recruiter checking a candidate's resume against an ALREADY-BUILT requirements checklist for a job. Do not derive a new checklist — judge only the items you are given.

Rules:
1. Output ONLY valid JSON, no markdown.

Return a JSON object with exactly these keys:
{
  "requirements": [ ... ],
  "matching_responsibilities": [ ... up to 3 ... ],
  "score": <0-100>
}

"requirements": reproduce the FIXED CHECKLIST below EXACTLY, item for item,
in the same order — do not add, remove, reorder, or reword any item.

FIXED CHECKLIST:
${JSON.stringify(checklist.map(r => ({ requirement: r.requirement, kind: r.kind })))}

For EACH item above, in the same order, output:
    {
      "requirement": "<copied verbatim from the checklist above>",
      "kind":        "<copied verbatim from the checklist above>",
      "covered":     true | false,
      "artifact":    "<what a candidate would show you>"
    }

"covered" — is there real evidence in the resume? Be honest, not generous.
A resume listing "LangChain" does NOT cover "AI Agents and Agentic
workflows" as a consulting practice. It covers "LangChain". Adjacent is not
the same as equivalent. If you would not defend the claim to the hiring
manager, mark it false.

"matching_responsibilities": at most THREE job duties the resume shows real
evidence of handling. Three maximum — the requirements array above is the
complete picture; this is a highlight reel, not a second enumeration.

"score": your honest holistic 0-100 assessment of how well this candidate's background fits this specific role — weigh both direct keyword matches AND reasonably adjacent/transferable experience, the way an experienced recruiter would, not a raw keyword-count percentage. If the match is genuinely weak, say so — don't inflate it to be encouraging.`;

  const userMsg = `JOB DESCRIPTION (context only — the checklist above is what you're judging):
${truncate(jobDescription, 4000)}

TAILORED RESUME:
${truncate(JSON.stringify(tailoredResume), 15000)}

Return the coverage judgment JSON only.`;

  const raw = await callAI(system, userMsg, true, 'ats_judge');
  return safeParseJSON(raw);
}

export async function buildAtsAnalysis({ jobDescription, tailoredResume, skillsAddedCount = 0, placedSkills = [], listedOnlySkills = [], existingRequirements = null }) {
  const jdWasSubstantial = jobDescription && jobDescription.trim().length >= 150;

  // Once something is covered — by an earlier judgment OR because the user
  // confirmed they added it — that is settled. Re-sending it for the model
  // to re-judge invites it to reverse a decision the user already made,
  // which is exactly backwards: a user's own confirmation should outrank a
  // second AI guess, not lose to it. Only STILL-OPEN items ever go back to
  // the model; covered ones are carried through untouched.
  let alreadyCovered = [];
  let stillOpen = [];
  let extractedJobTitle = null;
  let extractedCompany = null;
  const usingExistingChecklist = Array.isArray(existingRequirements) && existingRequirements.length > 0;

  if (usingExistingChecklist) {
    // Re-evaluation: the checklist already exists. Skip extraction entirely
    // — this is the whole point of keeping it, and it's free.
    alreadyCovered = existingRequirements.filter(r => r.covered === true);
    stillOpen = existingRequirements.filter(r => r.covered !== true);
  } else {
    // First evaluation: derive the checklist from the JD, once. This call
    // never touches the resume and stays small regardless of how long the
    // job description is, since it's only ever listing what the JOB wants.
    if (!jdWasSubstantial) {
      return {
        score: null, fit_signal: null, job_title: null, company: null,
        requirements: [], total_requirements: 0, covered_requirements: 0,
        missing_requirements: [], matching_responsibilities: [],
        notes: 'No job description available to evaluate against.'
      };
    }
    const extracted = await extractRequirementsChecklist(jobDescription);
    if (!extracted.requirements.length) {
      throw new Error('AI returned no usable requirements for a substantial job description after retries.');
    }
    stillOpen = extracted.requirements;
    extractedJobTitle = extracted.job_title;
    extractedCompany = extracted.company;
  }

  // Nothing left to check — every item is already settled. Don't spend an
  // API call confirming that 100% is still 100%; return it directly.
  if (stillOpen.length === 0) {
    const scoredCovered = alreadyCovered.filter(r => !UNSCORED_KINDS.has(r.kind));
    return {
      score: 100,
      fit_signal: 100,
      job_title: extractedJobTitle,
      company: extractedCompany,
      requirements: alreadyCovered,
      total_requirements: scoredCovered.length,
      covered_requirements: scoredCovered.length,
      missing_requirements: [],
      bonus_requirements: [],
      matching_responsibilities: [],
      notes: 'Coverage of every requirement this job states.'
    };
  }

  // Judge coverage of the (possibly reduced) still-open checklist against
  // the resume. If this call itself comes back unusable, don't throw away
  // a perfectly good checklist we already have — degrade to "not yet
  // confirmed covered" for those items rather than losing the whole result.
  let judged;
  try {
    const parsed = await judgeChecklistCoverage(stillOpen, tailoredResume, jobDescription);
    judged = Array.isArray(parsed.requirements) && parsed.requirements.length > 0
      ? parsed
      : { requirements: stillOpen.map(r => ({ ...r, covered: false })), score: null, matching_responsibilities: [] };
  } catch (_) {
    judged = { requirements: stillOpen.map(r => ({ ...r, covered: false })), score: null, matching_responsibilities: [] };
  }

  // The prompt says "reproduce exactly, don't add new items" — but that's a
  // request, not a guarantee. This is the guarantee: match the model's reply
  // back to what was actually SENT, by requirement text (safe here — both
  // sides are server-side text from the same call, not a UI/label boundary).
  // Anything the model added beyond stillOpen is discarded outright. Anything
  // it dropped defaults back to its previous covered:false rather than
  // disappearing. The set of items literally cannot grow or shrink from this
  // point on — only "covered" can change. This is what makes "20 missing,
  // then 30 more on the next check" structurally impossible, not just unlikely.
  const norm = s => String(s || '').toLowerCase().trim();
  const echoedByText = new Map((judged.requirements || []).map(r => [norm(r.requirement), r]));
  judged = {
    ...judged,
    requirements: stillOpen.map(orig => {
      const echoed = echoedByText.get(norm(orig.requirement));
      return echoed
        ? { ...orig, covered: echoed.covered === true, artifact: echoed.artifact ?? orig.artifact }
        : { ...orig, covered: false };
    })
  };

  const holisticScore = Number.isFinite(Number(judged.score)) ? Math.max(0, Math.min(100, Math.round(Number(judged.score)))) : null;

  // Merge settled items (never resent) with the freshly-judged ones, then
  // run everything through the same quality bar once more — cheap and
  // idempotent, and catches anything the judgment pass reworded despite
  // being told to reproduce labels verbatim.
  const merged = [...alreadyCovered, ...judged.requirements];
  // A stable, unique id per item — assigned once, here, and never re-derived
  // from text anywhere downstream. The chip UI and the confirmation flow
  // will reference this id directly instead of re-matching by label, which
  // is what silently broke when a label passed through normalization
  // differently on two different sides of the same comparison.
  const clean = cleanChecklist(merged).map((r, i) => ({ ...r, id: i }));

  // Drop any gap the resume already lists. The old substring check required
  // both sides to be ≥5 chars before matching — meant to stop false
  // positives like "R" matching "Framework" — but it silently broke on
  // short REAL skill names too: resume lists "C#" (2 chars), requirement
  // reads "C# Programming" (longer, AI-verbose phrasing of the same thing).
  // Neither "C#".includes("C# Programming") nor the reverse is true, and
  // "C#".length >= 5 is false, so the guard blocked the legitimate match.
  // Same failure mode hit .NET, Go, R, C, SQL-adjacent short names.
  //
  // Fix: normalize punctuation out of both sides, then match on whole word
  // boundaries — a short token like "c#" or "net" must appear as its own
  // word in the requirement (or vice versa), not as an arbitrary substring.
  // This keeps "R" from matching inside "Framework" (no word-boundary "r"
  // in "framework") while correctly matching "C#" inside "C# Programming".
  function normTokens(s) {
    return String(s).toLowerCase()
      .replace(/[.#+]/g, m => ({ '.': ' dot ', '#': ' sharp ', '+': ' plus ' }[m]))
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
  }

  const resumeSkills = new Set();
  const resumeSkillTokenSets = [];
  try {
    (tailoredResume?.skills || []).forEach(cat =>
      (cat.items || []).forEach(i => {
        if (typeof i !== 'string') return;
        const s = i.toLowerCase().trim();
        resumeSkills.add(s);
        resumeSkillTokenSets.push(normTokens(s));
      })
    );
  } catch (_) {}

  function alreadyPresent(skill) {
    const s = String(skill).toLowerCase().trim();
    if (!s) return false;
    if (resumeSkills.has(s)) return true;

    const reqTokens = normTokens(s);
    if (!reqTokens.length) return false;

    for (const haveTokens of resumeSkillTokenSets) {
      if (!haveTokens.length) continue;
      // Whole-token containment either direction: every token of the
      // shorter side must appear as a token in the longer side. Catches
      // "c#" ⊂ "c# programming" and "net" ⊂ ".net core", while "r" never
      // matches inside "framework" (tokenized as one word, "r" isn't a
      // token of it).
      const [shorter, longer] = haveTokens.length <= reqTokens.length ? [haveTokens, reqTokens] : [reqTokens, haveTokens];
      if (shorter.every(t => longer.includes(t))) return true;
    }
    return false;
  }

  // Score excludes language-kind items — same treatment as tenure. They're
  // real requirements, worth showing, but a real ATS keyword match doesn't
  // weigh a language the way it weighs a technical skill, so folding them
  // into the score would penalize (or inflate) a candidate for something
  // that isn't actually being scored in practice.
  //
  // "Covered" here means the SAME thing it means for the chip list below:
  // the AI said so, OR the resume's Skills section already has it. Using a
  // narrower definition for the score than for the chips is exactly what
  // produced a 41/100 with C#, .NET, PyTorch, TensorFlow, LangGraph, Unit
  // Testing, Anthropic Integration, AI Evaluation, Vertex AI, Object-
  // Oriented, Data Structures, Data Flow Diagrams, and Entity Relationship
  // Diagrams ALL flagged missing — while the resume attached had every one
  // of them, verbatim, in its Skills section.
  const scored = clean.filter(r => !UNSCORED_KINDS.has(r.kind));
  const totalReqs = scored.length;
  const coveredReqs = scored.filter(r => r.covered === true || alreadyPresent(r.requirement.trim())).length;
  const boostedScore = totalReqs > 0 ? Math.round((coveredReqs / totalReqs) * 100) : holisticScore;

  // ── What the user can actually close by editing their resume ──────────
  // TRUST THE USER. Every uncovered requirement is addable — the user tells
  // us where they used it (technical/domain into Skills + a bullet;
  // experience into a bullet only). Nothing is silently dropped or set aside
  // in a bucket the user can't act on.
  //
  // alreadyPresent, resumeSkills, normTokens are defined above, ahead of the
  // score calculation, so both the score and this chip list agree on what
  // counts as "already have it" — the two used to be computed from different
  // definitions and could disagree with each other.
  function actionable(r) { return r.covered !== true && !alreadyPresent(r.requirement.trim()); }

  // Everything the user can act on, tagged so the panel asks the right question.
  // A tool goes in the Skills section; an engagement goes in a bullet under the
  // role where it happened. Language items are addable too — the user might
  // genuinely speak it — but shown separately from the scored list.
  const actionableUncovered = clean.filter(actionable);
  const filteredMissing = actionableUncovered
    .filter(r => !UNSCORED_KINDS.has(r.kind))
    .map(r => ({ skill: compactRequirement(r.requirement), kind: r.kind, id: r.id }));
  const bonusMissing = actionableUncovered
    .filter(r => UNSCORED_KINDS.has(r.kind))
    .map(r => ({ skill: compactRequirement(r.requirement), kind: r.kind, id: r.id }));

  return {
    score: boostedScore,
    fit_signal: holisticScore,
    job_title: extractedJobTitle,
    company: extractedCompany,

    // Every requirement, so the panel can show the whole picture.
    requirements: clean,
    total_requirements: totalReqs,
    covered_requirements: coveredReqs,

    // Every uncovered requirement — all addable, all shown at once.
    missing_requirements: filteredMissing,

    // Language requirements — real, worth showing, addable if genuine, but
    // never counted toward the score above.
    bonus_requirements: bonusMissing,

    matching_responsibilities: Array.isArray(judged.matching_responsibilities) ? judged.matching_responsibilities.slice(0, 3) : [],
    notes: 'Coverage of every requirement this job states.'
  };
}

// ── 8. Answer application question ─────────────────────────
export async function buildAnswerQuestion({ question, tailoredResume, jobDescription }) {
  const system = `You are helping a job candidate answer application or interview questions. 
Write in FIRST PERSON as the candidate. Use their actual resume experience — never fabricate.
Keep answers concise: 2-4 sentences for short questions, up to 2 paragraphs for open-ended ones.
Sound natural and genuine, not like a template. Tie the answer specifically to the role and company from the JD.`;

  const userMsg = `QUESTION: ${question}

CANDIDATE'S RESUME SUMMARY:
${truncate(JSON.stringify({ name: tailoredResume?.name, summary: tailoredResume?.summary, experience: tailoredResume?.experience?.slice(0,2), skills: tailoredResume?.skills?.slice(0,2) }), 2000)}

JOB DESCRIPTION (for context on company/role):
${truncate(jobDescription || '', 1500)}

Write a natural, first-person answer to this question using only the candidate's real experience.`;

  const raw = await callAI(system, userMsg, false, null);
  return raw?.trim() || 'Could not generate an answer. Try rephrasing the question.';
}
// Applies a single plain-English instruction to the tailored resume.
// The same absolute rules as tailoring apply — no fabrication, same schema.
// The instruction is intentionally kept separate from the resume JSON so
// the system prompt (containing the rules) gets cached by Anthropic while
// only the user message (instruction + resume) changes per call.
export async function buildChatEdit({ instruction, tailoredResume, jobDescription }) {
  const system = `You are a precise resume editor. Apply the user's instruction to the resume JSON exactly as asked.

ABSOLUTE RULES — NEVER VIOLATE:
1. Output ONLY valid parseable JSON. Zero markdown, zero commentary.
2. Preserve the EXACT schema — same keys, same nesting.
3. NEVER invent experience, companies, dates, degrees, metrics, or projects.
4. NEVER change company names, job titles, or dates.
5. "skills" MUST stay as array of {category, items[]} objects.
6. If the instruction says to REMOVE something, set ONLY that specific field to empty string or empty array. Do NOT remove any other fields.
7. If the instruction says to ADD a skill, add it to the most relevant existing skill category only.
8. SURGICAL EDITS ONLY — touch exactly what the instruction says. If told to remove the summary, set summary to "". Leave experience, projects, skills, education, and everything else completely unchanged.
9. NEVER reduce the number of bullets in an experience or project entry unless explicitly told to remove one. Adding something means adding a new bullet or extending an existing one — never replacing several bullets with one to "make room" for the new content.
10. If the instruction is ambiguous, do the most conservative possible interpretation and change only one thing.`;

  async function attemptEdit(extraInstruction = '') {
    const userMsg = `INSTRUCTION: ${truncate(instruction, 400)}${extraInstruction}

CURRENT RESUME JSON:
${truncate(JSON.stringify(tailoredResume), 15000)}

Apply the instruction and return the updated resume JSON only.`;

    const raw = await callAI(system, userMsg, true, 'tailor_resume');
    let parsed = sanitizeResumeShape(safeParseJSON(raw));
    if (!parsed.name || !Array.isArray(parsed.experience)) {
      return { error: 'invalid_output' };
    }

    // A surgical edit should almost never shrink the resume by more than a
    // bullet or two (an explicit "remove this" request). A bigger drop is the
    // signature of truncated or malformed output — the model losing its place
    // partway through and returning a shortened version of whatever came
    // last, rather than a deliberate edit.
    const countBullets = r => arrayify(r?.experience).reduce((n, e) => n + arrayify(e.bullets).length, 0)
                              + arrayify(r?.projects).reduce((n, p) => n + arrayify(p.bullets).length, 0);
    const before = countBullets(tailoredResume);
    const after = countBullets(parsed);
    if (before > 0 && after < before - 2) {
      return { error: 'shrunk_total' };
    }

    // A resume-wide total can hide a single entry collapsing — one company
    // dropping from several bullets to just one, with everything else
    // unchanged, barely moves the total but is exactly the failure this is
    // meant to catch. Compare each experience/project entry by position.
    const entryCollapsed = (beforeList, afterList) => {
      const b = arrayify(beforeList), a = arrayify(afterList);
      return b.some((entry, i) => {
        const beforeCount = arrayify(entry.bullets).length;
        const afterCount = arrayify(a[i]?.bullets).length;
        return beforeCount >= 3 && afterCount <= 1;
      });
    };
    if (entryCollapsed(tailoredResume?.experience, parsed?.experience) || entryCollapsed(tailoredResume?.projects, parsed?.projects)) {
      return { error: 'entry_collapsed' };
    }

    return { parsed };
  }

  let result = await attemptEdit();
  if (result.error) {
    // One retry with a reinforced instruction naming the exact failure mode
    // — a truncated or malformed result is often a one-off, and simply
    // asking again, more explicitly, resolves it without the user having to
    // retry manually.
    result = await attemptEdit(
      `\n\nIMPORTANT: Your previous attempt at this exact instruction returned an incomplete result — some existing bullets were lost or the output was malformed. Apply ONLY the requested change and return every other bullet, in every experience and project entry, completely unchanged and in full.`
    );
  }
  if (result.error) {
    const messages = {
      invalid_output: 'Edit failed — invalid output. Please try again.',
      shrunk_total: 'Edit failed — the result looked incomplete. Nothing was changed; try again.',
      entry_collapsed: 'Edit failed — one entry lost most of its detail in the result. Nothing was changed; try again.'
    };
    throw new Error(messages[result.error] || 'Edit failed. Please try again.');
  }
  let parsed = result.parsed;

  // Lock down fields that should never change regardless of instruction
  parsed = restoreFixedFields(parsed, tailoredResume);
  return parsed;
}
