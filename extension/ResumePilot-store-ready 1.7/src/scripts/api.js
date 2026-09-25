/* ===========================================================================
 * API bridge — routes calls through the RTE background worker
 * when running as a Chrome extension, falling back to direct fetch otherwise.
 * Tokens stored in chrome.storage.local.
 * ========================================================================= */
/* global chrome */
import { extractPDFText, extractPDFLinks, classifyContactLinks } from "../lib/pdf-extract.js";
import { extractTextFromDOCX, extractDOCXLinks, classifyContactLinksFromDocx } from "../lib/docx-extract.js";
import { generateResumeDocx, generateCoverLetterDocx } from "../lib/docx-generate.js";
import { generateCoverLetterPDF } from "../background/pdf.js";

const isExt = typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;

// ---- token/user storage ----
async function getToken() {
  if (isExt) return new Promise(res => chrome.storage.local.get(["token"], r => res(r.token || "")));
  return localStorage.getItem("token") || "";
}
async function setToken(t) {
  if (isExt) return new Promise(res => chrome.storage.local.set({ token: t }, res));
  localStorage.setItem("token", t);
}
async function clearToken() {
  if (isExt) return new Promise(res => chrome.storage.local.remove(["token", "user"], res));
  localStorage.removeItem("token"); localStorage.removeItem("user");
}
async function setUser(u) {
  if (isExt) return new Promise(res => chrome.storage.local.set({ user: u }, res));
  localStorage.setItem("user", JSON.stringify(u));
}
export async function getUser() {
  if (isExt) return new Promise(res => chrome.storage.local.get(["user"], r => res(r.user || null)));
  try { return JSON.parse(localStorage.getItem("user") || "null"); } catch { return null; }
}

// ---- helper: send a message to background worker ----
function bgMsg(payload) {
  return new Promise((res, rej) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) return rej(new Error(chrome.runtime.lastError.message));
      if (response?.error) return rej(Object.assign(new Error(response.error), { detail: response.error }));
      res(response);
    });
  });
}

// ---- Parse resume via RTE background ----
export async function parseResume(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();

  // Extract real text based on file type (PDF/DOCX use pure-JS binary
  // parsers; TXT/anything else is read as plain text).
  let rawText;
  let detectedLinks = null;
  try {
    if (ext === "pdf") {
      const buf = await file.arrayBuffer();
      rawText = await extractPDFText(buf);
      // Recover hyperlink URLs hiding behind clickable label text (e.g.
      // "Portfolio"/"LinkedIn") — these never appear in the visible text,
      // only in a separate link annotation.
      try {
        const links = await extractPDFLinks(buf);
        detectedLinks = classifyContactLinks(links);
      } catch (_) { /* non-fatal */ }
    } else if (ext === "docx") {
      const buf = await file.arrayBuffer();
      rawText = await extractTextFromDOCX(buf);
      try {
        const links = await extractDOCXLinks(buf);
        detectedLinks = classifyContactLinksFromDocx(links);
      } catch (_) { /* non-fatal */ }
    } else {
      rawText = await file.text();
    }
  } catch (err) {
    throw Object.assign(new Error("Could not read file."), { detail: "Could not extract text from this file." });
  }

  if (!rawText || rawText.trim().length < 20) {
    throw Object.assign(new Error("Empty resume."), { detail: "Couldn't find readable text in that file. Try another file or paste your resume text instead." });
  }

  const result = await bgMsg({ type: "PARSE_RESUME", payload: { rawText, detectedLinks } });
  // Return in the shape tailor.js expects: { filename, format, text }
  return {
    filename: file.name,
    format: ext.toUpperCase(),
    text: rawText,
    resumeData: result.resumeData
  };
}

// ---- Tailoring via RTE background ----
export async function createTailoring({ resume_text, job_description, additional_info, include_cover_letter, application_questions }) {
  // Pull cached resumeData (set by parseResume() on upload, or by onboarding).
  let stored = await new Promise(res => chrome.storage.local.get(["resumeData", "parsedResumeText", "skillProfile"], res));

  // The cache is only trustworthy if it was parsed from the EXACT text
  // currently in the textarea — the user may have pasted text directly
  // (skipping parseResume entirely) or hand-edited the extracted text
  // after upload, in which case stored.resumeData would be stale/missing.
  // Re-parse fresh from resume_text whenever it doesn't match.
  if (!stored.resumeData || stored.parsedResumeText !== resume_text) {
    const parsed = await bgMsg({ type: "PARSE_RESUME", payload: { rawText: resume_text } });
    stored = { ...stored, resumeData: parsed.resumeData, parsedResumeText: resume_text };
  }

  // Run tailoring
  const tailorRes = await bgMsg({
    type: "TAILOR_RESUME",
    payload: {
      jobDescription: job_description,
      resumeData: stored.resumeData,
      skillProfile: stored.skillProfile,
      additionalInfo: additional_info
    }
  });

  // Build a result object in the shape the result.js page expects
  const id = "local_" + Date.now();
  const resultObj = {
    id,
    created_at: new Date().toISOString(),
    job_title: _extractJobTitle(job_description),
    resume_text,
    result: {
      tailored_resume: tailorRes.tailored,
      ats_analysis: tailorRes.ats_analysis || { score: 0, matching_skills: [], missing_requirements: [] },
      change_summary: tailorRes.change_summary || { added: [], removed: [], reordered: [], rewritten_bullets: [] },
      cover_letter: "",
      application_qa: []
    }
  };

  // Optionally generate cover letter + application Q&A answers
  if (include_cover_letter) {
    try {
      const clRes = await bgMsg({
        type: "GENERATE_COVER_LETTER",
        payload: {
          jobDescription: job_description,
          tailoredResume: tailorRes.tailored,
          skillProfile: stored.skillProfile,
          applicantName: tailorRes.tailored?.name || "Applicant",
          companyName: _extractCompany(job_description),
          roleTitle: _extractJobTitle(job_description)
        }
      });
      resultObj.result.cover_letter = clRes.coverLetter || "";
    } catch (_) { /* non-fatal */ }
  }

  if ((application_questions || []).length) {
    try {
      const qaRes = await bgMsg({
        type: "GENERATE_APPLICATION_ANSWERS",
        payload: {
          jobDescription: job_description,
          tailoredResume: tailorRes.tailored,
          applicantName: tailorRes.tailored?.name || "Applicant",
          companyName: _extractCompany(job_description),
          roleTitle: _extractJobTitle(job_description),
          questions: application_questions
        }
      });
      resultObj.result.application_qa = qaRes.answers || [];
    } catch (_) { /* non-fatal */ }
  }

  // Save resume PDF (from tailoring) and resume DOCX for download/history
  const filesToStore = {};
  if (tailorRes.pdfBase64) filesToStore[`pdf_${id}`] = tailorRes.pdfBase64;
  try {
    filesToStore[`docx_${id}`] = generateResumeDocx(tailorRes.tailored);
  } catch (_) { /* non-fatal — PDF download still works */ }

  // Generate cover letter PDF/DOCX once we have the final cover letter text
  if (resultObj.result.cover_letter.trim()) {
    try {
      filesToStore[`coverPdf_${id}`] = await generateCoverLetterPDF(resultObj.result.cover_letter);
    } catch (_) { /* non-fatal */ }
    try {
      filesToStore[`coverDocx_${id}`] = generateCoverLetterDocx(resultObj.result.cover_letter, { title: "Cover Letter" });
    } catch (_) { /* non-fatal */ }
  }

  if (Object.keys(filesToStore).length) {
    await new Promise(res => chrome.storage.local.set(filesToStore, res));
  }

  // Persist to history in chrome.storage
  const { rp_history = [] } = await new Promise(res => chrome.storage.local.get(["rp_history"], res));
  rp_history.unshift({ id, created_at: resultObj.created_at, job_title: resultObj.job_title, score: resultObj.result.ats_analysis.score });
  if (rp_history.length > 50) rp_history.splice(50);
  await new Promise(res => chrome.storage.local.set({ rp_history, [`result_${id}`]: resultObj }, res));

  return { id };
}

export async function listTailorings() {
  const { rp_history = [] } = await new Promise(res => chrome.storage.local.get(["rp_history"], res));
  return { items: rp_history };
}

export async function getTailoring(id) {
  const stored = await new Promise(res => chrome.storage.local.get([`result_${id}`], res));
  const obj = stored[`result_${id}`];
  if (!obj) throw Object.assign(new Error("Not found"), { detail: "Tailoring not found." });
  return obj;
}

export async function renameTailoring(id, job_title) {
  const stored = await new Promise(res => chrome.storage.local.get([`result_${id}`, "rp_history"], res));
  const obj = stored[`result_${id}`];
  if (obj) { obj.job_title = job_title; await new Promise(res => chrome.storage.local.set({ [`result_${id}`]: obj }, res)); }
  const hist = (stored.rp_history || []).map(x => x.id === id ? { ...x, job_title } : x);
  await new Promise(res => chrome.storage.local.set({ rp_history: hist }, res));
  return { ok: true };
}

export async function deleteTailoring(id) {
  const stored = await new Promise(res => chrome.storage.local.get(["rp_history"], res));
  const hist = (stored.rp_history || []).filter(x => x.id !== id);
  await new Promise(res => chrome.storage.local.remove(
    [`result_${id}`, `pdf_${id}`, `docx_${id}`, `coverPdf_${id}`, `coverDocx_${id}`], res
  ));
  await new Promise(res => chrome.storage.local.set({ rp_history: hist }, res));
  return { ok: true };
}

// Resolves a fake REST-style path (e.g. "/tailor/{id}/resume.docx" or
// "/tailor/{id}/cover-letter.pdf") to the right chrome.storage key + MIME
// type for the artifact that was actually generated for that tailoring.
function _resolveArtifact(path) {
  const id = path.match(/local_\d+/)?.[0];
  if (!id) return null;
  const isCover = /cover-letter/.test(path);
  const isDocx = /\.docx$/.test(path);
  const key = isCover
    ? (isDocx ? `coverDocx_${id}` : `coverPdf_${id}`)
    : (isDocx ? `docx_${id}` : `pdf_${id}`);
  const mime = isDocx
    ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    : "application/pdf";
  return { id, key, mime };
}

// Stubs for download (use base64 artifact from storage)
export async function downloadFile(path, filename) {
  const art = _resolveArtifact(path);
  if (!art) return;
  const stored = await new Promise(res => chrome.storage.local.get([art.key], res));
  const b64 = stored[art.key];
  if (!b64) { throw Object.assign(new Error("Not generated"), { detail: "That file wasn't generated for this tailoring." }); }
  const a = document.createElement("a");
  a.href = `data:${art.mime};base64,` + b64;
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
}

export async function openInNewTab(path) {
  const art = _resolveArtifact(path);
  if (!art) return;
  const stored = await new Promise(res => chrome.storage.local.get([art.key], res));
  const b64 = stored[art.key];
  if (!b64) { throw Object.assign(new Error("Not generated"), { detail: "That file wasn't generated for this tailoring." }); }
  const blob = _b64toBlob(b64, art.mime);
  window.open(URL.createObjectURL(blob), "_blank");
}

// Stub auth (the full-page app doesn't need auth for the local RTE backend)
// ── Auth helpers (local credential store) ────────────────────────────────
// Passwords are hashed with PBKDF2-SHA256 (10k iterations) using the
// SubtleCrypto API, which is available in Chrome extension pages. No
// plaintext password is ever stored. The stored credential format is:
//   { email, name, salt (hex), hash (hex) }
// All stored under the key "rp_accounts" (array) in chrome.storage.local.

async function pbkdf2Hash(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(salt), iterations: 10000, hash: 'SHA-256' }, keyMaterial, 256);
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes = 16) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes))).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getAccounts() {
  return new Promise(res => chrome.storage.local.get(['rp_accounts'], r => res(r.rp_accounts || [])));
}

async function saveAccounts(accounts) {
  return new Promise(res => chrome.storage.local.set({ rp_accounts: accounts }, res));
}

export async function login({ email, password } = {}) {
  if (!email || !password) throw Object.assign(new Error('Email and password are required.'), { detail: 'Email and password are required.' });
  const accounts = await getAccounts();
  const account = accounts.find(a => a.email.toLowerCase() === email.toLowerCase().trim());
  if (!account) throw Object.assign(new Error('No account found with that email.'), { detail: 'No account found with that email. Did you mean to create one?' });
  if (account.googleOnly) throw Object.assign(new Error('This account was created with Google. Please use the Google sign-in button.'), { detail: 'This account was created with Google. Please use the Google sign-in button.' });
  const hash = await pbkdf2Hash(password, account.salt);
  if (hash !== account.hash) throw Object.assign(new Error('Incorrect password.'), { detail: 'Incorrect password. Please try again.' });
  const user = { name: account.name, email: account.email };
  await setUser(user);

  // Restore the resume/skill profile that was saved under this account
  // (persisted at logout so the user's data comes back when they sign in).
  const key = `profile_${account.email}`;
  const saved = await new Promise(res => chrome.storage.local.get([key], r => res(r[key] || null)));
  if (saved?.resumeData) {
    await new Promise(res => chrome.storage.local.set({ resumeData: saved.resumeData, skillProfile: saved.skillProfile, userName: user.name }, res));
  }

  return user;
}

export async function register({ name, email, password, googleToken } = {}) {
  if (googleToken) {
    // Google sign-in path — no password needed
    const user = { name: name || 'User', email: email || '' };
    const accounts = await getAccounts();
    if (!accounts.find(a => a.email.toLowerCase() === (email || '').toLowerCase())) {
      accounts.push({ email: user.email, name: user.name, googleOnly: true, salt: '', hash: '' });
      await saveAccounts(accounts);
    }
    await setUser(user);
    // Restore saved profile if this user has signed in before
    if (email) {
      const key = `profile_${email}`;
      const saved = await new Promise(res => chrome.storage.local.get([key], r => res(r[key] || null)));
      if (saved?.resumeData) {
        await new Promise(res => chrome.storage.local.set({ resumeData: saved.resumeData, skillProfile: saved.skillProfile, userName: user.name }, res));
      }
    }
    return user;
  }
  if (!name || !name.trim()) throw Object.assign(new Error('Name is required.'), { detail: 'Please enter your full name.' });
  if (!email || !email.trim()) throw Object.assign(new Error('Email is required.'), { detail: 'Please enter your email address.' });
  if (!password || password.length < 8) throw Object.assign(new Error('Password too short.'), { detail: 'Password must be at least 8 characters.' });
  const accounts = await getAccounts();
  if (accounts.find(a => a.email.toLowerCase() === email.toLowerCase().trim())) {
    throw Object.assign(new Error('An account with this email already exists.'), { detail: 'An account with this email already exists. Please sign in instead.' });
  }
  const salt = randomHex(16);
  const hash = await pbkdf2Hash(password, salt);
  accounts.push({ email: email.trim(), name: name.trim(), salt, hash });
  await saveAccounts(accounts);
  const user = { name: name.trim(), email: email.trim() };
  await setUser(user);
  return user;
}

export async function logout() { await clearToken(); }

export async function me() { return getUser(); }

// ---- helpers ----
function _extractJobTitle(jd = "") {
  const m = jd.match(/^([^\n]{5,80})/);
  return m ? m[1].trim() : "Untitled role";
}
function _extractCompany(jd = "") {
  const m = jd.match(/at\s+([A-Z][A-Za-z\s&,]+?)(?:\.|,|\n|is |-|–)/);
  return m?.[1]?.trim() || "the company";
}
function _b64toBlob(b64, type) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type });
}
