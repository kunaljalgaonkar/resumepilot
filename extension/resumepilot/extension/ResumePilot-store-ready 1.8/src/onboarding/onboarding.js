// ─────────────────────────────────────────────────────────
//  ResumePilot Onboarding
//  New flow:
//  Step 0 – Upload resume PDF → AI parses it → auto-fills everything
//  Step 1 – Review & edit parsed details (pre-filled, not manual entry)
//  Step 2 – Add hidden experience (projects/roles not in resume)
//  Step 3 – Skill confidence tuning
//  Step 4 – Review & save
// ─────────────────────────────────────────────────────────

import { extractPDFText as extractPdfBytes, extractPDFLinks, classifyContactLinks } from '../lib/pdf-extract.js';
import { extractTextFromDOCX, extractDOCXLinks, classifyContactLinksFromDocx } from '../lib/docx-extract.js';

// ── Date sanity check for parsed experience ────────────────────────────────
// Purely a courtesy heads-up for the USER to catch their own typos before
// applying anywhere — not a parsing-quality signal. The AI can only report
// what's printed on the resume; if the resume itself has a typo (a job
// ending before it starts, a future year, two full-time roles that
// overlap by more than a month), no amount of parsing accuracy fixes that،
// but the user catching it here is easy and free.
//
// Deliberately conservative: only flags clear, unambiguous problems. Doesn't
// flag brief overlaps (a two-week transition between jobs is normal), doesn't
// require every date to parse (many resumes have a role or two with fuzzy
// dates like "Summer 2019" that we just skip rather than guess at).
const MONTH_MAP = {
  jan:0, january:0, feb:1, february:1, mar:2, march:2, apr:3, april:3,
  may:4, jun:5, june:5, jul:6, july:6, aug:7, august:7,
  sep:8, sept:8, september:8, oct:9, october:9, nov:10, november:10, dec:11, december:11
};

// Parses one side of a date range ("March 2021", "2021", "Present") into a
// sortable value (year + month/12), or null if it can't be confidently read.
function parseDateToken(token) {
  const t = String(token || '').trim();
  if (!t) return null;
  if (/present|current|ongoing|now\b/i.test(t)) {
    const d = new Date();
    return d.getFullYear() + d.getMonth() / 12;
  }
  const yearMatch = t.match(/\b(19|20)\d{2}\b/);
  if (!yearMatch) return null;
  const year = parseInt(yearMatch[0], 10);
  const monthWord = t.toLowerCase().match(/[a-z]+/);
  const month = monthWord ? MONTH_MAP[monthWord[0]] : undefined;
  return year + (month !== undefined ? month / 12 : 0);
}

// Splits "March 2021 – Present" / "2021-2023" / "Jan 2020 to Dec 2021" into
// { start, end } sortable values. Returns null if it doesn't look like a
// real range (can't find two date-ish tokens).
function splitDateRangeString(s) {
  s = String(s || '').trim();
  // Primary: dash/em-dash/"to" surrounded by whitespace on both sides. The
  // whitespace requirement matters — an earlier version of this matched "to"
  // as a bare substring, which also matched inside ordinary words like
  // "October" (Oc-TO-ber), silently corrupting every October date.
  let parts = s.split(/\s+(?:–|—|-|to)\s+|\s*(?:–|—)\s*/i).filter(Boolean);
  if (parts.length >= 2) return parts;
  // Fallback: tight "YYYY-YYYY" or "YYYY-Present" with no spaces around the
  // hyphen — common shorthand the whitespace-based split above won't catch.
  const tight = s.match(/^\s*((?:19|20)\d{2})\s*-\s*((?:19|20)\d{2}|present)\s*$/i);
  if (tight) return [tight[1], tight[2]];
  return parts;
}

function parseDateRange(dates) {
  const s = String(dates || '').trim();
  if (!s) return null;
  const parts = splitDateRangeString(s);
  if (parts.length < 2) return null;
  const start = parseDateToken(parts[0]);
  const end = parseDateToken(parts[parts.length - 1]);
  if (start === null || end === null) return null;
  return { start, end };
}

// Returns a short list of human-readable warning strings, or [] if nothing
// looks off. Never throws — a checker that can crash onboarding over a
// resume it can't fully parse would be worse than not checking at all.
// Returns [{ message, entryIndices: [i, ...] }, ...] — entryIndices lets the
// review screen highlight exactly which date field(s) a warning is about,
// so the user can jump straight to fixing it rather than hunting through
// the whole list. Index refers to position in the `experience` array passed
// in, which the caller keeps in sync with the on-screen order.
function checkExperienceDates(experience) {
  const warnings = [];
  try {
    const nowValue = (() => { const d = new Date(); return d.getFullYear() + d.getMonth() / 12; })();
    const ranges = [];

    (experience || []).forEach((exp, idx) => {
      const r = parseDateRange(exp.dates);
      if (!r) return; // unparseable dates are skipped, not flagged — too many false positives otherwise
      const label = `${exp.title || 'a role'} at ${exp.company || 'this company'}`;

      if (r.end < r.start - 0.05) {
        warnings.push({ message: `"${label}" shows an end date before its start date (${exp.dates}) — double check this.`, entryIndices: [idx] });
      }
      if (r.start > nowValue + 0.2) {
        warnings.push({ message: `"${label}" has a start date in the future (${exp.dates}) — double check this.`, entryIndices: [idx] });
      }
      ranges.push({ label, idx, ...r });
    });

    // Overlap check: only flag when two roles overlap by more than ~2
    // months AND neither range is degenerate — brief transition overlaps
    // are completely normal and shouldn't be flagged as errors.
    for (let i = 0; i < ranges.length; i++) {
      for (let j = i + 1; j < ranges.length; j++) {
        const a = ranges[i], b = ranges[j];
        const overlapStart = Math.max(a.start, b.start);
        const overlapEnd = Math.min(a.end, b.end);
        const overlapMonths = (overlapEnd - overlapStart) * 12;
        if (overlapMonths > 2) {
          warnings.push({
            message: `"${a.label}" and "${b.label}" overlap by about ${Math.round(overlapMonths)} months — worth double-checking these dates.`,
            entryIndices: [a.idx, b.idx]
          });
        }
      }
    }
  } catch (_) {
    return []; // fail silently — this is a courtesy check, never a blocker
  }
  return warnings;
}

// Renders the experience list with EDITABLE date fields (a plain text
// input, not static text) and re-runs the date-sanity check live as the
// user types. Previously this screen only displayed a read-only warning —
// the user had to leave the review step, find the right field, fix it, and
// come back. Now the fix happens right where the warning appears: the
// specific date field(s) a warning is about get a highlighted border, and
// editing them re-checks immediately, clearing the warning as soon as it's
// resolved (no need to click anything to "confirm" the fix).
function renderExperienceWithDateCheck() {
  const expContainer = document.getElementById('exp-summary');
  const dateWarningEl = document.getElementById('exp-date-warning');
  if (!expContainer) return;

  const warnings = checkExperienceDates(data.experience);
  const flaggedIndices = new Set(warnings.flatMap(w => w.entryIndices));

  expContainer.innerHTML = data.experience.map((exp, i) => {
    const bullets = Array.isArray(exp.bullets) ? exp.bullets : [];
    const preview = bullets.slice(0, 4).map(b => `<div>• ${e(b)}</div>`).join('');
    const more = bullets.length > 4 ? `<div class="muted" style="margin-top:4px;font-size:12px">+ ${bullets.length - 4} more bullet${bullets.length - 4 === 1 ? '' : 's'}</div>` : '';
    const flagged = flaggedIndices.has(i);
    return `
      <div class="parsed-item">
        <strong>${e(exp.title)}</strong> at ${e(exp.company)} ·
        <input type="text" class="exp-date-input" data-exp-index="${i}" value="${e(exp.dates)}"
          style="display:inline-block;width:180px;font-size:12.5px;padding:3px 7px;border-radius:6px;
                 border:1px solid ${flagged ? '#f59e0b' : '#e5e7eb'};
                 background:${flagged ? '#fffbeb' : '#fff'};
                 color:#374151;font-family:inherit;">
        <div class="bullet-preview">${preview}${more}</div>
      </div>
    `;
  }).join('');

  // One listener per date input, re-runs the check on every keystroke —
  // cheap (pure client-side string parsing, no network) so this is fine to
  // run on every input event rather than debouncing.
  expContainer.querySelectorAll('.exp-date-input').forEach(input => {
    input.addEventListener('input', () => {
      const idx = Number(input.dataset.expIndex);
      if (data.experience[idx]) data.experience[idx].dates = input.value;
      renderDateWarningOnly(); // re-check + update banner WITHOUT rebuilding
                                 // the inputs themselves (would steal focus
                                 // and reset cursor position mid-type)
    });
  });

  renderDateWarningOnlyInto(dateWarningEl, warnings);
}

// Updates just the warning banner text — does NOT touch the date <input>
// elements. Called on every keystroke in a date field; rebuilding the
// inputs on every keystroke (via renderExperienceWithDateCheck) would blur
// the field the user is actively typing in.
function renderDateWarningOnly() {
  const dateWarningEl = document.getElementById('exp-date-warning');
  const warnings = checkExperienceDates(data.experience);
  const flaggedIndices = new Set(warnings.flatMap(w => w.entryIndices));

  // Update border/background on existing inputs in place, without
  // recreating them.
  document.querySelectorAll('.exp-date-input').forEach(input => {
    const idx = Number(input.dataset.expIndex);
    const flagged = flaggedIndices.has(idx);
    input.style.borderColor = flagged ? '#f59e0b' : '#e5e7eb';
    input.style.background = flagged ? '#fffbeb' : '#fff';
  });

  renderDateWarningOnlyInto(dateWarningEl, warnings);
}

function renderDateWarningOnlyInto(dateWarningEl, warnings) {
  if (!dateWarningEl) return;
  if (warnings.length) {
    dateWarningEl.innerHTML =
      `<strong>⚠️ Your resume's dates might need a second look:</strong>` +
      `<ul style="margin:6px 0 0 18px;padding:0;">${warnings.map(w => `<li>${e(w.message)}</li>`).join('')}</ul>` +
      `<div class="muted" style="margin-top:6px;font-size:11.5px;">Edit the highlighted date field(s) above to fix — this updates automatically.</div>`;
    dateWarningEl.classList.remove('hidden');
  } else {
    dateWarningEl.classList.add('hidden');
    dateWarningEl.innerHTML = '';
  }
}

// ── Auth gate ────────────────────────────────────────────────────────────
// Every user must sign in or create an account before accessing onboarding.
// If no user is stored in chrome.storage.local, redirect to auth.html.
// The path goes: auth.html → onboarding.html (resume upload) → popup usage.
(async () => {
  const stored = await new Promise(res => chrome.storage.local.get(['user'], res));
  if (!stored.user) {
    location.replace(chrome.runtime.getURL('src/pages/auth.html#register'));
    return;
  }
  // Show signed-in user in sidebar
  const userEl = document.getElementById('sidebar-user-info');
  if (userEl && stored.user.name) userEl.textContent = `Signed in as ${stored.user.name}`;
})();

// Logout from within onboarding
document.getElementById('btn-onboarding-logout')?.addEventListener('click', async () => {
  const stored = await chrome.storage.local.get(['user', 'resumeData', 'skillProfile']);
  // Save resume data under user's email before signing out
  if (stored.user?.email && stored.resumeData) {
    const key = `profile_${stored.user.email}`;
    await chrome.storage.local.set({ [key]: { resumeData: stored.resumeData, skillProfile: stored.skillProfile } });
  }
  await chrome.storage.local.remove(['user', 'token', 'resumeData', 'skillProfile', 'parsedResumeText', 'userName']);
  location.href = chrome.runtime.getURL('src/pages/auth.html');
});

let currentStep = 0;
const TOTAL_STEPS = 5;

const data = {
  userName: '',
  contact:    { email: '', phone: '', location: '', linkedin: '', portfolio: '', github: '' },
  summary:    '',
  experience: [],
  education:  [],
  projects:   [],
  skills:     [],         // [{ name, level }]
  hiddenExp:  []          // extra projects/roles user adds
};

// ── Navigation ─────────────────────────────────────────────
function goToStep(n) {
  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  const step   = document.querySelector(`.step[data-step="${n}"]`);
  const navBtn = document.querySelector(`.nav-item[data-step="${n}"]`);
  if (step)   step.classList.add('active');
  if (navBtn) navBtn.classList.add('active');
  currentStep = n;
  if (n === TOTAL_STEPS - 1) renderReview();
}

function nextStep() {
  collectStep(currentStep);
  if (currentStep < TOTAL_STEPS - 1) goToStep(currentStep + 1);
}
function prevStep() {
  collectStep(currentStep);
  if (currentStep > 0) goToStep(currentStep - 1);
}

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    collectStep(currentStep);
    goToStep(parseInt(btn.dataset.step, 10));
  });
});

document.addEventListener('click', ev => {
  const btn = ev.target.closest('[data-action]');
  if (!btn) return;
  const a = btn.dataset.action;
  if (a === 'upload-resume')      uploadResume();
  if (a === 'next')               nextStep();
  if (a === 'prev')               prevStep();
  if (a === 'add-hidden-exp')     addHiddenExp();
  if (a === 'add-hidden-proj')    addHiddenProject();
  if (a === 'add-skill')          addSkill();
  if (a === 'save')               saveAll();
  if (a === 'remove-hidden-exp')  btn.closest('.exp-card')?.remove();
  if (a === 'remove-hidden-proj') btn.closest('.exp-card')?.remove();
  if (a === 'remove-skill')       removeSkill(btn.dataset.skill || '');
  if (a === 'add-bullet')         addBullet(Number(btn.dataset.expId));
});

document.getElementById('skill-input').addEventListener('keydown', ev => {
  if (ev.key === 'Enter') { ev.preventDefault(); addSkill(); }
});

document.getElementById('resume-file')?.addEventListener('change', () => {
  const inp = document.getElementById('resume-file');
  const file = inp?.files?.[0];
  const nameEl = document.getElementById('resume-file-name');
  const labelText = document.querySelector('.upload-label .upload-text');
  if (!file) {
    if (labelText) labelText.textContent = 'Click to choose your resume (PDF or Word)';
    if (nameEl) {
      nameEl.textContent = '';
      nameEl.classList.add('hidden');
    }
    return;
  }
  if (labelText) labelText.textContent = 'Resume selected';
  if (nameEl) {
    nameEl.textContent = `${file.name} • ${Math.round(file.size / 1024)} KB`;
    nameEl.classList.remove('hidden');
  }
});

// ── Step 0: Resume Upload (PDF / DOCX / TXT) ────────────────
async function uploadResume() {
  const inp  = document.getElementById('resume-file');
  const file = inp?.files?.[0];
  const btn  = document.querySelector('[data-action="upload-resume"]');
  if (!file) { showStatus('Please select your resume file first.', 'err'); return; }

  btn?.setAttribute('disabled', 'true');
  showStatus('Reading file…', 'ok');

  try {
    // Extract text based on file type
    const rawText = await extractResumeText(file);

    if (!rawText || rawText.trim().length < 80) {
      showStatus('Could not read text from this file. Please paste your resume text below instead.', 'err');
      document.getElementById('paste-fallback').classList.remove('hidden');
      return;
    }

    // For PDFs and DOCX files, also recover hyperlink URLs that hide behind
    // clickable label text (e.g. "Portfolio"/"LinkedIn") — these never
    // appear in the visible text at all, only in a separate link target.
    let detectedLinks = null;
    const lowerName = (file.name || '').toLowerCase();
    try {
      if (lowerName.endsWith('.pdf') || file.type === 'application/pdf') {
        const buf = await file.arrayBuffer();
        const links = await extractPDFLinks(buf);
        detectedLinks = classifyContactLinks(links);
      } else if (
        lowerName.endsWith('.docx') ||
        file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      ) {
        const buf = await file.arrayBuffer();
        const links = await extractDOCXLinks(buf);
        detectedLinks = classifyContactLinksFromDocx(links);
      }
    } catch (_) { /* non-fatal — falls back to whatever the AI finds in the text */ }

    showStatus('Parsing with AI — this takes ~15 seconds…', 'ok');

    // Send to background worker which calls AI
    const result = await chrome.runtime.sendMessage({
      type: 'PARSE_RESUME',
      payload: { rawText, detectedLinks }
    });

    if (result.error) throw new Error(result.error);

    const r = result.resumeData;
    populateFromParsed(r);
    showStatus(`✓ Resume parsed! Found ${r.experience?.length || 0} jobs, ${r.education?.length || 0} education entries, ${(r.skills || []).flatMap(s => s.items || []).length} skills.`, 'ok');

    // Auto-advance to review step
    setTimeout(() => goToStep(1), 1200);
  } catch (err) {
    showStatus('Parse failed: ' + err.message, 'err');
    document.getElementById('paste-fallback').classList.remove('hidden');
  } finally {
    btn?.removeAttribute('disabled');
  }
}

// Dispatches to the right pure-JS extractor based on file extension/MIME,
// then falls back to plain-text reading for .txt or unrecognized types.
async function extractResumeText(file) {
  const name = (file.name || '').toLowerCase();
  const arrayBuffer = await file.arrayBuffer();

  let text = '';
  if (name.endsWith('.pdf') || file.type === 'application/pdf') {
    text = await extractPdfBytes(arrayBuffer);
  } else if (
    name.endsWith('.docx') ||
    file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    text = await extractTextFromDOCX(arrayBuffer);
  } else {
    // .txt or unknown — just decode as text
    text = new TextDecoder('utf-8').decode(arrayBuffer);
  }

  text = (text || '').trim();
  if (text.length > 6000) text = text.slice(0, 5500);
  return text;
}

// Paste fallback
document.getElementById('btn-parse-paste')?.addEventListener('click', async () => {
  const raw = document.getElementById('resume-paste').value.trim();
  if (!raw) { showStatus('Please paste your resume text.', 'err'); return; }
  showStatus('Parsing with AI…', 'ok');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'PARSE_RESUME', payload: { rawText: raw } });
    if (result.error) throw new Error(result.error);
    populateFromParsed(result.resumeData);
    showStatus('✓ Resume parsed!', 'ok');
    setTimeout(() => goToStep(1), 900);
  } catch (err) {
    showStatus('Parse failed: ' + err.message, 'err');
  }
});

// ── Populate form from AI-parsed data ─────────────────────
function populateFromParsed(r) {
  // Personal info
  data.userName = r.name || '';
  data.contact  = r.contact || {};
  data.summary  = r.summary || '';

  document.getElementById('p-name').value     = data.userName;
  document.getElementById('p-email').value    = data.contact.email    || '';
  document.getElementById('p-phone').value    = data.contact.phone    || '';
  document.getElementById('p-location').value = data.contact.location || '';
  document.getElementById('p-linkedin').value = data.contact.linkedin || '';
  document.getElementById('p-portfolio').value= data.contact.portfolio|| '';
  document.getElementById('p-github').value   = data.contact.github  || '';
  document.getElementById('p-summary').value  = data.summary;

  // Experience
  data.experience = (r.experience || []).map((e, i) => ({ ...e, id: Date.now() + i }));
  renderExperienceWithDateCheck();

  // Education
  data.education = r.education || [];
  document.getElementById('edu-summary').innerHTML = data.education.map(ed => `
    <div class="parsed-item">
      <strong>${e(ed.degree)}</strong> · ${e(ed.institution)} · <span class="muted">${e(ed.dates)}</span>
    </div>
  `).join('');

  // Projects
  data.projects = r.projects || [];

  // Skills — flatten from categories and pre-populate with 80% confidence
  const allSkills = (r.skills || []).flatMap(cat => (cat.items || []));
  data.skills = [];
  document.getElementById('skills-grid').innerHTML = '';
  for (const name of allSkills) {
    if (data.skills.find(s => s.name.toLowerCase() === name.toLowerCase())) continue;
    data.skills.push({ name, level: 80 });
    renderSkillItem({ name, level: 80 });
  }
}

// ── Step 1: Review ─────────────────────────────────────────
function collectStep(step) {
  if (step === 1) {
    data.userName = document.getElementById('p-name').value.trim();
    data.contact  = {
      email:     document.getElementById('p-email').value.trim(),
      phone:     document.getElementById('p-phone').value.trim(),
      location:  document.getElementById('p-location').value.trim(),
      linkedin:  document.getElementById('p-linkedin').value.trim(),
      portfolio: document.getElementById('p-portfolio').value.trim(),
      github:    document.getElementById('p-github').value.trim()
    };
    data.summary = document.getElementById('p-summary').value.trim();
  }
}

// ── Step 2: Hidden experience ──────────────────────────────
function addHiddenExp() {
  const id = Date.now();
  const list = document.getElementById('hidden-exp-list');
  const card = document.createElement('div');
  card.className = 'exp-card';
  card.id = `hexp-${id}`;
  card.innerHTML = `
    <div class="exp-card__header">
      <span class="exp-card__title">Additional Role / Experience</span>
      <button class="btn--danger" data-action="remove-hidden-exp">×</button>
    </div>
    <div class="grid-2" style="margin-bottom:12px">
      <div class="field"><label class="label">Company / Context</label>
        <input type="text" class="input hexp-company" placeholder="Freelance, Side Project, etc."></div>
      <div class="field"><label class="label">Role / Title</label>
        <input type="text" class="input hexp-title" placeholder="Full Stack Developer"></div>
    </div>
    <div class="field" style="margin-bottom:12px"><label class="label">Dates</label>
      <input type="text" class="input hexp-dates" placeholder="Jun 2023 – Dec 2023"></div>
    <div class="bullets-label">What did you do? (bullet points)</div>
    <div class="bullet-list" id="hbullets-${id}">
      <div class="bullet-row"><span class="bullet-dot">•</span>
        <input type="text" class="input bullet-input" placeholder="Built X using Y, achieving Z…"></div>
    </div>
    <button class="btn--add-bullet" data-action="add-bullet" data-exp-id="${id}">+ Add bullet</button>
  `;
  list.appendChild(card);
}

function addHiddenProject() {
  const id = Date.now();
  const list = document.getElementById('hidden-proj-list');
  const card = document.createElement('div');
  card.className = 'exp-card';
  card.id = `hproj-${id}`;
  card.innerHTML = `
    <div class="exp-card__header">
      <span class="exp-card__title">Additional Project</span>
      <button class="btn--danger" data-action="remove-hidden-proj">×</button>
    </div>
    <div class="grid-2" style="margin-bottom:12px">
      <div class="field"><label class="label">Project Name</label>
        <input type="text" class="input hproj-name" placeholder="E-commerce Platform"></div>
      <div class="field"><label class="label">Dates</label>
        <input type="text" class="input hproj-dates" placeholder="Apr 2024 – Present"></div>
    </div>
    <div class="bullets-label">What did you build / achieve?</div>
    <div class="bullet-list" id="hpbullets-${id}">
      <div class="bullet-row"><span class="bullet-dot">•</span>
        <input type="text" class="input bullet-input" placeholder="Built X using Y…"></div>
    </div>
    <button class="btn--add-bullet" data-action="add-bullet" data-exp-id="${id}">+ Add bullet</button>
  `;
  list.appendChild(card);
}

function addBullet(expId) {
  const list = document.getElementById(`hbullets-${expId}`) || document.getElementById(`hpbullets-${expId}`);
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'bullet-row';
  row.innerHTML = `<span class="bullet-dot">•</span>
    <input type="text" class="input bullet-input" placeholder="Another achievement…">`;
  list.appendChild(row);
}

function collectHiddenExp() {
  const exps = [];
  document.querySelectorAll('[id^="hexp-"]').forEach(card => {
    const company = card.querySelector('.hexp-company')?.value.trim();
    const title   = card.querySelector('.hexp-title')?.value.trim();
    const dates   = card.querySelector('.hexp-dates')?.value.trim();
    const bullets = Array.from(card.querySelectorAll('.bullet-input')).map(i => i.value.trim()).filter(Boolean);
    if (company || title) exps.push({ company, title, dates, bullets });
  });
  return exps;
}

function collectHiddenProjects() {
  const projs = [];
  document.querySelectorAll('[id^="hproj-"]').forEach(card => {
    const name   = card.querySelector('.hproj-name')?.value.trim();
    const dates  = card.querySelector('.hproj-dates')?.value.trim();
    const bullets= Array.from(card.querySelectorAll('.bullet-input')).map(i => i.value.trim()).filter(Boolean);
    if (name) projs.push({ name, dates, bullets });
  });
  return projs;
}

// ── Step 3: Skills ─────────────────────────────────────────
function addSkill() {
  const input = document.getElementById('skill-input');
  const level = parseInt(document.getElementById('skill-level').value, 10);
  const raw   = input.value.trim();
  if (!raw) return;
  const names = raw.split(',').map(s => s.trim()).filter(Boolean);
  for (const name of names) {
    if (data.skills.find(s => s.name.toLowerCase() === name.toLowerCase())) continue;
    data.skills.push({ name, level });
    renderSkillItem({ name, level });
  }
  input.value = '';
}

function renderSkillItem({ name, level }) {
  const grid = document.getElementById('skills-grid');
  const item = document.createElement('div');
  item.className = 'skill-item';
  item.dataset.skill = name;
  item.innerHTML = `
    <span class="skill-item__name">${e(name)}</span>
    <input type="range" class="skill-item__slider" min="0" max="100" value="${level}">
    <span class="skill-item__pct">${level}%</span>
    <button class="btn--danger" data-action="remove-skill" data-skill="${e(name)}">×</button>
  `;
  const slider = item.querySelector('input[type=range]');
  const pct    = item.querySelector('.skill-item__pct');
  slider.addEventListener('input', () => {
    const v = parseInt(slider.value, 10);
    pct.textContent = v + '%';
    const sk = data.skills.find(s => s.name === name);
    if (sk) sk.level = v;
  });
  grid.appendChild(item);
}

function removeSkill(name) {
  data.skills = data.skills.filter(s => s.name !== name);
  document.querySelector(`.skill-item[data-skill="${name}"]`)?.remove();
}

// ── Step 4: Review ─────────────────────────────────────────
function renderReview() {
  const hiddenExp  = collectHiddenExp();
  const hiddenProj = collectHiddenProjects();

  document.getElementById('review-panel').innerHTML = `
    <div class="review-section">
      <div class="review-section__head">Personal</div>
      <div class="review-section__body">
        <strong>${e(data.userName)}</strong> · ${e(data.contact.email)} · ${e(data.contact.location)}
      </div>
    </div>
    <div class="review-section">
      <div class="review-section__head">Experience from resume (${data.experience.length})</div>
      <div class="review-section__body">
        ${data.experience.map(ex => `<strong>${e(ex.title)}</strong> at ${e(ex.company)} · ${e(ex.dates)}<br>`).join('')}
      </div>
    </div>
    ${hiddenExp.length ? `
    <div class="review-section">
      <div class="review-section__head">Additional experience you added (${hiddenExp.length})</div>
      <div class="review-section__body">
        ${hiddenExp.map(ex => `<strong>${e(ex.title)}</strong> at ${e(ex.company)} · ${e(ex.dates)}<br>`).join('')}
      </div>
    </div>` : ''}
    ${hiddenProj.length ? `
    <div class="review-section">
      <div class="review-section__head">Additional projects you added (${hiddenProj.length})</div>
      <div class="review-section__body">
        ${hiddenProj.map(p => `<strong>${e(p.name)}</strong><br>`).join('')}
      </div>
    </div>` : ''}
    <div class="review-section">
      <div class="review-section__head">Skills (${data.skills.length})</div>
      <div class="review-section__body">
        ${data.skills.map(s => `<strong>${e(s.name)}</strong> ${s.level}%`).join(' · ')}
      </div>
    </div>
  `;
}

// ── Save ───────────────────────────────────────────────────
async function saveAll() {
  collectStep(currentStep);
  const hiddenExp  = collectHiddenExp();
  const hiddenProj = collectHiddenProjects();

  // Merge hidden experience into the resume data so AI can use it
  const fullExperience = [
    ...data.experience,
    ...hiddenExp
  ];

  const fullProjects = [
    ...data.projects,
    ...hiddenProj
  ];

  const resumeData = {
    name:           data.userName,
    contact:        data.contact,
    summary:        data.summary,
    experience:     fullExperience,
    education:      data.education,
    projects:       fullProjects,
    skills:         data.skills.map(s => ({ category: 'Skills', items: [s.name] })),
    certifications: []
  };

  const skillProfile = { skills: data.skills };

  await chrome.storage.local.set({ userName: data.userName, resumeData, skillProfile });

  // Also save under the signed-in user's email so it's restored on next login
  const { user } = await chrome.storage.local.get(['user']);
  if (user?.email) {
    const key = `profile_${user.email}`;
    await chrome.storage.local.set({ [key]: { resumeData, skillProfile } });
  }

  document.getElementById('save-success').classList.remove('hidden');
  document.querySelector('.btn--save').textContent = 'Saved ✓';
  document.querySelector('.btn--save').disabled    = true;
}

// ── Load existing ──────────────────────────────────────────
async function loadExisting() {
  const stored = await chrome.storage.local.get(['userName', 'resumeData', 'skillProfile']);
  if (!stored.resumeData) return;

  const r = stored.resumeData;
  populateFromParsed({
    ...r,
    skills: r.skills || []
  });

  // Restore skill levels from skillProfile
  if (stored.skillProfile?.skills) {
    for (const sk of stored.skillProfile.skills) {
      const existing = data.skills.find(s => s.name.toLowerCase() === sk.name.toLowerCase());
      if (existing) {
        existing.level = sk.level;
        const slider = document.querySelector(`.skill-item[data-skill="${sk.name}"] input[type=range]`);
        const pct    = document.querySelector(`.skill-item[data-skill="${sk.name}"] .skill-item__pct`);
        if (slider) slider.value = sk.level;
        if (pct)    pct.textContent = sk.level + '%';
      }
    }
  }
}

// ── Utils ──────────────────────────────────────────────────
function showStatus(msg, type) {
  const el = document.getElementById('resume-status');
  if (!el) return;
  el.textContent = msg;
  el.className   = `key-status ${type}`;
  el.classList.remove('hidden');
}

function e(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

loadExisting();
