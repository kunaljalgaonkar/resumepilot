// ─────────────────────────────────────────────────────────
//  ResumePilot – Background Service Worker
// ─────────────────────────────────────────────────────────

import { parseResumeText, buildTailoredResume, buildCoverLetter, buildWhyUs, buildApplicationAnswers, buildAtsAnalysis, buildChatEdit, buildAnswerQuestion } from './ai.js';
import { generatePDF, generateCoverLetterPDF } from './pdf.js';
import { computeChangeSummary } from '../lib/analysis.js';

// ── Anonymous usage tracking ───────────────────────────────
// Counts total installs / tailors / applications and weekly active users
// for the admin dashboard. No name, no email, no resume content ever
// leaves the device through this path — just a random ID generated once
// per install and an event type + timestamp.
const TRACKING_ENDPOINT = 'https://wispy-recipe-d3bd.my1assistant-support.workers.dev/event';
const FEEDBACK_ENDPOINT = 'https://wispy-recipe-d3bd.my1assistant-support.workers.dev/feedback';
const CONFIG_ENDPOINT   = 'https://wispy-recipe-d3bd.my1assistant-support.workers.dev/config';

// ── Remote-controlled timing settings ──────────────────────
// Values like "how often should the feedback popup appear" now live on the
// Worker (admin-editable, see the Worker's /admin page) instead of being
// hardcoded here. This means changing the cadence is a database edit, not a
// code change — no new extension version, no Chrome Web Store review.
//
// Cached locally for CONFIG_CACHE_MS so we're not hitting the network on
// every single tailor. If the fetch fails (offline, Worker down) we fall
// back to whatever was last cached, or these hardcoded defaults if we've
// genuinely never successfully fetched — the extension must never break or
// block just because the config endpoint is unreachable.
const CONFIG_CACHE_MS = 4 * 60 * 60 * 1000; // re-check every 4 hours
const CONFIG_HARD_DEFAULTS = {
  feedbackIntervalHours: 168,    // 1 week
  breakThresholdMinutes: 60,
  breakSnoozeMinutes: 45
};

async function getRemoteConfig() {
  const stored = await chrome.storage.local.get(['rpRemoteConfig', 'rpRemoteConfigFetchedAt']);
  const cached = stored.rpRemoteConfig;
  const fetchedAt = stored.rpRemoteConfigFetchedAt || 0;

  if (cached && (Date.now() - fetchedAt) < CONFIG_CACHE_MS) return cached;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(CONFIG_ENDPOINT, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error('config fetch failed');
    const config = await res.json();
    await chrome.storage.local.set({ rpRemoteConfig: config, rpRemoteConfigFetchedAt: Date.now() });
    return config;
  } catch (_) {
    // Network hiccup or Worker down — use whatever we have. A stale cached
    // config is still far better than crashing or falling back to nothing.
    return cached || CONFIG_HARD_DEFAULTS;
  }
}

async function getAnonId() {
  const stored = await chrome.storage.local.get(['rpAnonId']);
  if (stored.rpAnonId) return stored.rpAnonId;
  const id = (crypto.randomUUID && crypto.randomUUID()) ||
    `anon_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  await chrome.storage.local.set({ rpAnonId: id });
  return id;
}

// Fire-and-forget: tracking must never slow down or break the actual
// product. Any failure here (offline, worker down, D1 hiccup) is swallowed.
function pingEvent(type) {
  getAnonId()
    .then(anon_id => fetch(TRACKING_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anon_id, type })
    }))
    .catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  if (msg.type === 'PARSE_RESUME') {
    handleParseResume(msg.payload).then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === 'TAILOR_RESUME') {
    handleTailorResume(msg.payload).then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === 'ANSWER_QUESTION') {
    const { question, tailoredResume, jobDescription } = msg.payload || {};
    buildAnswerQuestion({ question, tailoredResume, jobDescription })
      .then(answer => sendResponse({ answer }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === 'CHAT_EDIT') {
    handleChatEdit(msg.payload).then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === 'OPEN_ONBOARDING') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/onboarding/onboarding.html') });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'OPEN_TRACKER') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/pages/tracker.html') });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'OPEN_PLANS') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/pages/plans.html') });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'EVALUATE_ATS') {
    handleEvaluateAts(msg.payload).then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === 'APPLICATION_SUBMITTED') {
    handleApplicationSubmitted(msg).then(sendResponse).catch(() => sendResponse({ ok: true }));
    return true;
  }

  // Fired by the OTHER 3 application-logging paths in detector.js
  // (Greenhouse/Lever/Ashby/Workday confirmation, resume-injection signal,
  // generic confirmation-page text match) — these already write their own
  // applicationLog entry with their own dedup logic, so this does NOT
  // duplicate that write. It only runs the same anonymous ping + every-5th
  // feedback counter that handleApplicationSubmitted runs for the LinkedIn
  // path, so all four application sources count consistently.
  if (msg.type === 'APPLICATION_LOGGED_ELSEWHERE') {
    handleApplicationLoggedElsewhere().then(sendResponse).catch(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'SUBMIT_FEEDBACK') {
    handleSubmitFeedback(msg.payload).then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === 'GET_REMOTE_CONFIG') {
    // Used by panel.js for the break reminder timing (breakThresholdMinutes,
    // breakSnoozeMinutes) — panel.js can't call getRemoteConfig() directly
    // since it runs in the iframe, not the background service worker.
    getRemoteConfig().then(sendResponse).catch(() => sendResponse(CONFIG_HARD_DEFAULTS));
    return true;
  }

  if (msg.type === 'GENERATE_COVER_LETTER') {
    handleCoverLetter(msg.payload).then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === 'GENERATE_WHY_US') {
    handleWhyUs(msg.payload).then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === 'GENERATE_APPLICATION_ANSWERS') {
    handleApplicationAnswers(msg.payload).then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === 'OPEN_ONBOARDING') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/onboarding/onboarding.html') });
    sendResponse({ ok: true });
    return true;
  }
});

// ── Parse resume text via AI into structured JSON ──────────
async function handleParseResume({ rawText, detectedLinks }) {
  const resumeData = await parseResumeText(rawText);

  // Real hyperlink URLs (recovered from PDF link annotations, not from
  // visible text) are more trustworthy than anything the AI could infer
  // from plain text — clickable label words like "Portfolio"/"LinkedIn"
  // carry no URL at all in the text itself. Prefer them whenever found.
  if (detectedLinks) {
    resumeData.contact = resumeData.contact || {};
    if (detectedLinks.linkedin) resumeData.contact.linkedin = detectedLinks.linkedin;
    if (detectedLinks.portfolio) resumeData.contact.portfolio = detectedLinks.portfolio;
    if (detectedLinks.github) resumeData.contact.github = detectedLinks.github;
  }

  await chrome.storage.local.set({ resumeData, parsedResumeText: rawText });
  return { resumeData };
}

// ── Tailor resume for job description ─────────────────────
async function handleTailorResume({ jobDescription, skillProfile, additionalInfo }) {
  const stored = await chrome.storage.local.get(['resumeData', 'parsedResumeText']);
  const resumeData   = stored.resumeData;
  const originalText = stored.parsedResumeText || null;

  if (!resumeData) throw new Error('No resume found. Please complete onboarding first.');

  const tplStored = await chrome.storage.local.get(['resumeTemplate']);
  const template = tplStored.resumeTemplate || 'modern';

  // callAI() (in ai.js) already retries transient failures internally —
  // up to 3 attempts at 25s each, so a single call can legitimately take up
  // to ~90s in the worst case. This is a pure safety net against a truly
  // hung promise, not a second retry cycle — it deliberately sits well
  // above that worst case so it doesn't preempt callAI's own retries
  // before they get a chance to finish.
  const TIMEOUT_MS = 110000; // 110s
  const tailorPromise = buildTailoredResume({ jobDescription, resumeData, skillProfile, originalText, additionalInfo });
  const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error('The AI service is taking unusually long to respond. Please try again in a moment.')), TIMEOUT_MS));

  const tailored = await Promise.race([tailorPromise, timeoutPromise]);

  const pdfBase64 = await generatePDF(tailored, template);
  const change_summary = computeChangeSummary(resumeData, tailored);
  pingEvent('tailor');   // anonymous count only — see top of file

  // Feedback cadence: at most once per the admin-configured interval (see
  // getRemoteConfig — this now comes from the Worker, not a hardcoded
  // constant), gated on a tailor actually completing. Tailoring has exactly
  // one code path (this function) vs. application logging, which has four
  // independent detectors across detector.js, each with its own dedup rules
  // — one source of truth here means the timing can't drift out of sync
  // with itself.
  //
  // lastFeedbackPromptAt starts at 0 for a brand-new install. Treat that as
  // "just installed, not due yet" rather than "way overdue" — asking for
  // feedback before someone has even seen their first tailored resume is
  // exactly backwards. First feedback prompt is anchored to first tailor
  // completion, then the interval applies normally from there.
  const config = await getRemoteConfig();
  const feedbackIntervalMs = (config.feedbackIntervalHours || CONFIG_HARD_DEFAULTS.feedbackIntervalHours) * 60 * 60 * 1000;

  const stored2 = await chrome.storage.local.get(['lastFeedbackPromptAt']);
  const lastPrompt = stored2.lastFeedbackPromptAt;
  let feedbackDue = false;
  if (lastPrompt === undefined) {
    // First-ever tailor for this install — start the clock, don't prompt yet.
    await chrome.storage.local.set({ lastFeedbackPromptAt: Date.now() });
  } else if (Date.now() - lastPrompt >= feedbackIntervalMs) {
    feedbackDue = true;
    await chrome.storage.local.set({ lastFeedbackPromptAt: Date.now() });
  }

  return { tailored, pdfBase64, change_summary, feedbackDue };
}

// ── On-demand ATS analysis (separate from tailoring) ──────
async function handleEvaluateAts({ jobDescription, tailoredResume, skillsAddedCount, placedSkills = [], listedOnlySkills = [], existingRequirements = null }) {
  try {
    const ats_analysis = await buildAtsAnalysis({ jobDescription, tailoredResume, skillsAddedCount, placedSkills, listedOnlySkills, existingRequirements });
    return { ats_analysis };
  } catch (err) {
    console.warn('[ResumePilot] AI ATS analysis failed after retry:', err?.message || err);
    // Do NOT silently substitute the keyword-frequency fallback here. It has
    // no semantic understanding of what it's reading — on a long or complex
    // JD it can surface the hiring company's own name, or stray verbs from
    // bullet points, as if they were real missing skills. That is actively
    // misleading, worse than telling the user the analysis didn't complete.
    return {
      error: 'analysis_failed',
      message: "Couldn't fully analyze this job's requirements — it may be an unusually long posting. Tap Evaluate again to retry."
    };
  }
}

async function handleApplicationSubmitted(payload = {}) {
  const stored = await chrome.storage.local.get(['applicationGoal', 'applicationProgress', 'applicationLog']);
  const goal = stored.applicationGoal;
  const now = Date.now();

  // ── Log to application tracker ──────────────────────────
  const log = stored.applicationLog || [];
  const entry = {
    id: `app_${now}_${Math.random().toString(36).slice(2, 6)}`,
    jobTitle: payload.jobTitle || 'Unknown Role',
    company: payload.company || 'Unknown Company',
    url: payload.url || '',
    fingerprint: payload.fingerprint || '',
    appliedAt: now,
    status: 'applied'
  };
  // Avoid duplicate entries for the same job within 10 minutes
  const isDuplicate = log.some(e => e.fingerprint === entry.fingerprint && (now - e.appliedAt) < 10 * 60 * 1000);
  if (!isDuplicate) {
    log.unshift(entry); // newest first
    await chrome.storage.local.set({ applicationLog: log.slice(0, 500) }); // keep last 500
    pingEvent('application');   // anonymous count only — see top of file
  }

  // ── Goal tracking ────────────────────────────────────────
  if (!goal || !goal.count) return { ok: true };
  const periodStart = (() => {
    const d = new Date(now);
    if (goal.period === 'day') return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    if (goal.period === 'week') return new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay()).getTime();
    return 0;
  })();
  let progress = stored.applicationProgress;
  if (!progress || progress.periodStart !== periodStart) progress = { count: 0, periodStart };
  const wasAlreadyComplete = progress.count >= goal.count;
  progress.count += 1;
  await chrome.storage.local.set({ applicationProgress: progress });
  const justReached = !wasAlreadyComplete && progress.count >= goal.count;
  chrome.runtime.sendMessage({ type: 'APPLICATION_RECORDED', progress, justReached }).catch(() => {});
  return { ok: true, progress, justReached };
}

// Anonymous ping ONLY — used by the 3 non-LinkedIn application-logging paths
// in detector.js, which already write their own applicationLog entry with
// their own dedup rules before calling this. Kept separate from
// handleApplicationSubmitted so we never write two log entries for one
// application. Feedback cadence no longer keys off applications (see
// FEEDBACK_INTERVAL config / handleTailorResume) — this only keeps the
// admin dashboard's "applications logged" count accurate across all 4
// detection paths.
async function handleApplicationLoggedElsewhere() {
  pingEvent('application');   // anonymous count only — see top of file
  return { ok: true };
}

// ── Feedback submission ─────────────────────────────────────
// Unlike the anonymous /event pings, this one deliberately carries name and
// email — the user is choosing to identify themselves when they submit
// feedback, so it can be shown next to their name on the admin page.
async function handleSubmitFeedback({ name, email, message } = {}) {
  if (!message || !message.trim()) throw new Error('Please write a message before submitting.');

  const res = await fetch(FEEDBACK_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name || '', email: email || '', message: message.trim() })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Could not send feedback right now.');
  }
  return { ok: true };
}

// ── Chat-driven resume edit ────────────────────────────────
// Applies a plain-English instruction to the current tailored resume.
// Uses the same AI and schema enforcement as regular tailoring so the
// output is always a valid, renderable resume object.
async function handleChatEdit({ instruction, tailoredResume, jobDescription }) {
  if (!tailoredResume) throw new Error('No tailored resume to edit. Tailor your resume first.');
  if (!instruction?.trim()) throw new Error('No instruction provided.');

  const tplStored = await chrome.storage.local.get(['resumeTemplate']);
  const template = tplStored.resumeTemplate || 'modern';

  const edited = await buildChatEdit({ instruction, tailoredResume, jobDescription });
  const pdfBase64 = await generatePDF(edited, template);
  return { tailored: edited, pdfBase64 };
}

async function handleCoverLetter({ jobDescription, tailoredResume, skillProfile, applicantName, companyName, roleTitle }) {
  const coverLetter = await buildCoverLetter({ jobDescription, tailoredResume, skillProfile, applicantName, companyName, roleTitle });
  let coverLetterPdfBase64 = null;
  try {
    coverLetterPdfBase64 = await generateCoverLetterPDF(coverLetter, { title: 'Cover Letter' });
  } catch (_) { /* non-fatal — text injection into textareas still works without the PDF */ }
  return { coverLetter, coverLetterPdfBase64 };
}

async function handleWhyUs({ jobDescription, tailoredResume, applicantName, companyName, roleTitle }) {
  const whyUs = await buildWhyUs({ jobDescription, tailoredResume, applicantName, companyName, roleTitle });
  return { whyUs };
}

async function handleApplicationAnswers({ jobDescription, tailoredResume, applicantName, companyName, roleTitle, questions }) {
  const answers = await buildApplicationAnswers({ jobDescription, tailoredResume, applicantName, companyName, roleTitle, questions });
  return { answers };
}
