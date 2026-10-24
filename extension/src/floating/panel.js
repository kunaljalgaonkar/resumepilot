// ResumePilot Floating Panel — side-by-side layout
// Left column: tailor/resume/ATS. Right column: chatbot. Always both visible.
// chrome.* calls relay via postMessage → content script.

const ATS_FREE_LIMIT = 6;
const $ = id => document.getElementById(id);
function show(id) { $(id)?.classList.remove('hidden'); }
function hide(id) { $(id)?.classList.add('hidden'); }

// ── postMessage relay ─────────────────────────────────────────────────────
function send(type, payload = {}) {
  return new Promise(resolve => {
    const id = Math.random().toString(36).slice(2);
    function handler(e) {
      if (e.data?.rp_response_id === id) {
        window.removeEventListener('message', handler);
        // Any response that reports how the PDF came out (tailor, chat
        // edit, regenerate) refreshes the "fits 1 page" status line.
        try { if (e.data.result?.pageInfo) updatePageBadge(e.data.result.pageInfo); } catch (_) {}
        resolve(e.data.result || {});
      }
    }
    window.addEventListener('message', handler);
    window.parent.postMessage({ rp_type: type, rp_id: id, ...payload }, '*');
    setTimeout(() => { window.removeEventListener('message', handler); resolve({ error: 'Timeout' }); }, 90000);
  });
}

// ── State ─────────────────────────────────────────────────────────────────
let state = {
  jd: null, fingerprint: null,
  resumeData: null, userName: null,
  tailoredResume: null, pdfBase64: null,
  coverLetter: null, coverLetterPdfBase64: null,
  atsAnalysis: null, atsUsed: 0,
  skillsAddedSinceEval: 0,
  skillsAddedTotal: 0
};

// Per-JD result cache so switching back to a previous job restores the work

// ── Init ──────────────────────────────────────────────────────────────────
async function init() {
  const result = await send('GET_INITIAL_STATE');
  state.resumeData = result.resumeData || null;
  state.userName   = result.userName   || null;
  state.atsUsed    = result.atsUsed    || 0;
  state.jd          = result.jd          || null;
  state.jdSource    = result.jdSource    || 'page';
  state.fingerprint = result.fingerprint || null;
  state.atsEvaluatedJobs = result.atsEvaluatedJobs || [];
  state.session   = result.session || null;
  state.lastSyncedTs = result.session?.ts || 0;
  state.archived  = result.archived || null;
  state.skillsAddedThisJob = (state.session?.addedSkills || []).length;

  // A fresh page for a job already worked on should open where the last page
  // left off: same resume, same score, same chips, notes not repeated.
  if (state.session && !state.session.applied) {
    const s = state.session;
    if (s.tailoredResume) { state.tailoredResume = s.tailoredResume; state.pdfBase64 = s.pdfBase64 || null; state.lastWorkSavedAt = s.workSavedAt || 0; }
    if (s.atsAnalysis)    state.atsAnalysis      = s.atsAnalysis;
    if (s.missingKinds)   state.missingKinds     = s.missingKinds;
    if (s.placedSkills)   state.placedSkills     = s.placedSkills;
    if (s.listedOnlySkills) state.listedOnlySkills = s.listedOnlySkills;
    if (s.notesShown) {
      state.gapNoteShown     = !!s.notesShown.gap;
      state.fitNoteShown     = !!s.notesShown.fit;
      state.bulletOfferShown = !!s.notesShown.bullet;
    }
  }

  // Seed the cache with the last-used result if it matches the current JD
  if (result.cached && result.fingerprint) {
    state.tailoredResume = result.cached.tailoredResume;
    state.pdfBase64      = result.cached.pdfBase64;
    state.atsAnalysis    = result.cached.atsAnalysis || null;
  }

  // Every step below is UI rendering based on possibly-stale session data —
  // an old session from before a schema change (the atsAnalysis shape has
  // changed several times over this project: id field, bonus_requirements,
  // new kind values) could make any single one of these throw. None of that
  // should ever be able to take down the chat greeting below, which is the
  // most fundamental, always-should-work part of the panel. Isolated so a
  // failure here is silent rather than fatal to everything after it.
  try {
    updateHeader();
    updateMainArea();
    renderQuote();
    logActivity(); setInterval(logActivity, 60000); setInterval(checkBreakReminder, 60000);
    checkBreakReminder();

    if (state.resumeData || state.userName) {
      const footerUser = $('footer-user');
      if (footerUser) footerUser.textContent = state.resumeData?.name || state.userName || '';
      show('panel-footer');
    }
    if (state.tailoredResume) {
      hide('btn-tailor-fab');
      show('result-area');
      // Render without announcing — the score was already announced on the page
      // that produced it, and the chat replay will show that message.
      if (state.atsAnalysis) renderAtsResultOnly(state.atsAnalysis);
      else showAtsPrompt();
    }
  } catch (_) {
    // Fall back to a clean slate rather than a half-rendered, possibly
    // stale left panel — the chat below is unaffected either way.
    state.atsAnalysis = null;
    show('btn-tailor-fab');
  }

  try {
    initChatbot();
  } catch (_) {
    const msgs = $('chat-messages');
    if (msgs && msgs.children.length === 0) {
      pushAssistantMessage(`Hi there! Navigate to a job listing — I'll help you tailor your resume and spot skill gaps.`);
    }
  }

  // Refresh the ATS credit count whenever this panel becomes visible again.
  // The count is shared across all pages via storage, but each page's panel
  // holds its own copy in memory — so a panel on LinkedIn would show a stale
  // count after you evaluated a job on another page. Re-reading on focus keeps
  // every panel in sync.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshSharedState();
  });
  window.addEventListener('focus', refreshSharedState);

  // Tooltips + first-run tour. Wrapped separately from everything above —
  // this is pure onboarding polish, never something that should be able to
  // take down the actual panel if it throws.
  try {
    initTooltips();
    initHelpTour();
  } catch (_) {}
  try { initPageModeControl(); } catch (_) {}

  // Admin-configurable free-evaluation limit (see the Worker's /admin page).
  // showAtsPrompt() is synchronous and called frequently, so rather than
  // await a fetch there, seed state.atsFreeLimit once here in the
  // background and let that function read whatever's already resolved —
  // falls back to the hardcoded ATS_FREE_LIMIT constant until this
  // completes, and again if the fetch ever fails.
  getBreakConfig().then(config => {
    if (config?.evaluateFreeLimit) {
      state.atsFreeLimit = config.evaluateFreeLimit;
      // Re-render the prompt if it's already on screen so a just-raised
      // limit reflects immediately rather than waiting for the next
      // natural re-render.
      if (!document.getElementById('fab-ats-prompt')?.classList.contains('hidden')) {
        showAtsPrompt();
      }
    }
  }).catch(() => {});
}

// ── Resume length (Auto / 1 page / 2 pages) ──────────────────────────────
// 'auto' is the original behaviour. 'one' asks the AI for a concise one-page
// draft AND makes the PDF step shrink spacing/margins (never body text below
// 9pt) until it fits; if it can't, the normal layout is kept and the user is
// told by how much. 'two' lets it run to two pages. The choice is stored in
// chrome.storage.local.resumePageMode so every later tailor/edit uses it, and
// switching it re-renders the CURRENT resume instantly with no AI call.
function renderPageModeButtons() {
  document.querySelectorAll('#seg-page-mode .seg-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === (state.pageMode || 'auto'));
  });
}

function updatePageBadge(info) {
  const el = $('page-info');
  if (!el || !info) return;
  el.classList.remove('hidden', 'ok', 'warn');
  const pages = info.pages || 1;
  if (info.mode === 'one' && info.fitsOnePage) {
    el.classList.add('ok');
    el.textContent = `✓ Fits one page · ${info.bodyPt}pt text${info.summaryDropped ? ' · summary left out of the PDF' : ''}`;
  } else if (info.mode === 'one') {
    el.classList.add('warn');
    el.textContent = `⚠ About ${info.overflowLines} line${info.overflowLines === 1 ? '' : 's'} too long for one page even at the smallest readable size — showing ${pages} pages`;
  } else {
    el.textContent = `${pages} page${pages === 1 ? '' : 's'}`;
  }
}

// Said once after a tailor, and after the user switches modes — NOT after
// every small edit (the status line above already covers those).
function announcePageFit(info) {
  if (!info || info.mode !== 'one') return;
  if (info.fitsOnePage && info.summaryDropped) {
    pushAssistantMessage(
      `Fitted to **one page**. Smaller text and margins weren't quite enough, so I left the **professional summary** out of the PDF to make room — nothing else was cut, and body text is ${info.bodyPt}pt. ` +
      `The summary is still saved in your resume: switch to **Auto** or **2 pages** and it comes back.`
    );
  } else if (info.fitsOnePage) {
    pushAssistantMessage(`Fitted to **one page** with all your points and your summary — body text is ${info.bodyPt}pt${info.bodyPt < 10 ? ', a little tighter than the standard layout but still easy to read' : ''}.`);
  } else {
    pushAssistantMessageWithAction(
      `Even with the smallest readable text (9pt), the tightest margins, and the summary left out, this is about **${info.overflowLines} line${info.overflowLines === 1 ? '' : 's'}** too long for one page. I haven't cut anything — I kept the complete ${info.pages}-page version. ` +
      `You can switch to **2 pages** above to keep everything, or I can help trim a few of the least important points.`,
      'Reduce points',
      () => showReduceBulletsPicker()
    );
  }
}

async function setPageMode(mode) {
  if (state.pageModeBusy || mode === state.pageMode) return;
  state.pageModeBusy = true;
  const buttons = document.querySelectorAll('#seg-page-mode .seg-btn');
  buttons.forEach(b => { b.disabled = true; });
  state.pageMode = mode;
  renderPageModeButtons();
  try {
    await send('SET_STORAGE', { data: { resumePageMode: mode } });
    if (state.tailoredResume) {
      const res = await send('REGENERATE_PDF', { tailoredResume: state.tailoredResume, pageMode: mode });
      if (res && !res.error && res.pdfBase64) {
        state.pdfBase64 = res.pdfBase64;
        await saveWork();
        if (mode === 'one') announcePageFit(res.pageInfo);
        else if (mode === 'two') pushAssistantMessage(`Set to up to **two pages**. New tailors will aim for fuller experience sections.`);
        else pushAssistantMessage(`Back to **automatic** length.`);
      } else {
        pushAssistantMessage(`I saved your length preference, but couldn't re-render the current resume (${res?.error || 'unknown error'}). It will apply the next time you tailor or edit.`);
      }
    }
  } finally {
    buttons.forEach(b => { b.disabled = false; });
    state.pageModeBusy = false;
  }
}

function initPageModeControl() {
  const group = $('seg-page-mode');
  if (!group) return;
  group.addEventListener('click', e => {
    const btn = e.target.closest('.seg-btn');
    if (btn && btn.dataset.mode) setPageMode(btn.dataset.mode);
  });
  send('GET_STORAGE', { keys: ['resumePageMode'] }).then(stored => {
    const m = stored?.resumePageMode;
    state.pageMode = (m === 'one' || m === 'two') ? m : 'auto';
    renderPageModeButtons();
  }).catch(() => {});
}

// ── Hover tooltips ──────────────────────────────────────────────────────
// Any element with a data-tip attribute gets a small dark tooltip on hover,
// positioned above (or below, if too close to the top of the panel) the
// element. One shared tooltip DOM node is reused for all of them rather
// than creating one per element — cheaper, and avoids z-index headaches
// from dozens of tooltip nodes sitting in the layout at once.
function initTooltips() {
  const tip = document.createElement('div');
  tip.className = 'rp-tooltip';
  document.body.appendChild(tip);

  let hideTimer = null;

  function showTip(el) {
    const text = el.getAttribute('data-tip');
    if (!text) return;
    clearTimeout(hideTimer);
    tip.textContent = text;
    tip.classList.remove('arrow-below');

    const rect = el.getBoundingClientRect();
    tip.style.left = '0px'; tip.style.top = '0px'; // reset before measuring
    tip.classList.add('visible');
    const tipRect = tip.getBoundingClientRect();

    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    left = Math.max(6, Math.min(left, window.innerWidth - tipRect.width - 6));

    let top = rect.top - tipRect.height - 10;
    if (top < 4) {
      // Not enough room above — flip below the element instead.
      top = rect.bottom + 10;
      tip.classList.add('arrow-below');
    }

    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  function hideTip() {
    tip.classList.remove('visible');
  }

  // Event delegation on the body rather than one listener per tipped
  // element — this also means elements added to the DOM LATER (quick
  // action buttons, chips that render after AI responses, etc.) get
  // tooltips automatically without any extra wiring, as long as they carry
  // data-tip.
  document.body.addEventListener('mouseover', e => {
    const el = e.target.closest('[data-tip]');
    if (el) showTip(el);
  });
  document.body.addEventListener('mouseout', e => {
    const el = e.target.closest('[data-tip]');
    if (el && !el.contains(e.relatedTarget)) hideTip();
  });
  document.body.addEventListener('focusin', e => {
    const el = e.target.closest('[data-tip]');
    if (el) showTip(el);
  });
  document.body.addEventListener('focusout', e => {
    const el = e.target.closest('[data-tip]');
    if (el) hideTip();
  });
  // Hide on scroll/resize so a stale tooltip doesn't float away from its
  // anchor — cheap enough to just always hide rather than reposition.
  window.addEventListener('scroll', hideTip, true);
  window.addEventListener('resize', hideTip);
}

// ── First-run guided tour ───────────────────────────────────────────────
// A short walkthrough for someone using the extension for the first time
// with nobody there to explain it. Anchors to elements carrying
// data-tour="N" in panel.html, walked in numeric order. Shown once
// automatically (gated on a flag in chrome.storage.local so it survives
// across page loads within the same install), and always replayable via
// the "?" button in the header.
const TOUR_STEPS = [
  { anchor: '1', title: 'Start here', body: 'Tap "Tailor for This Job" any time you\'re on a job posting — it rewrites your resume to match it in about 30 seconds.' },
  { anchor: '2', title: 'Get it onto the application', body: 'Once tailored, "Inject" auto-fills the resume into this page\'s upload field. Or use the download icon to save it as a PDF yourself.' },
  { anchor: '3', title: 'Check your match', body: '"Evaluate" scores how well your resume covers what this job is asking for, and shows exactly which skills are missing.' },
  { anchor: '4', title: 'Ask for anything', body: 'This chat can make any change in plain English — shorten your summary, add a skill, remove a section, or answer application questions using your resume.' },
];

// ── Notify Me ────────────────────────────────────────────────────────────
// Lets the user opt into update notifications via email, a native Chrome
// notification, or both — genuinely opt-in, nothing is ever sent without
// this being completed first. Reuses the same anon_id already used for
// anonymous usage counts rather than generating a second identifier.
async function openNotifyCard() {
  const backdrop = $('rp-notify-backdrop');
  const card = $('rp-notify-card');
  if (!backdrop || !card) return;

  // Pull current local subscription state (set by SUBSCRIBE_NOTIFICATIONS
  // on a previous save) so re-opening the card reflects what's actually
  // saved, not a reset form every time.
  const stored = await send('GET_STORAGE', { keys: ['rpNotifySubscribed', 'rpNotifyWantsChrome', 'rpNotifyWantsEmail', 'rpNotifyEmail'] });
  const isSubscribed = !!stored.rpNotifySubscribed;
  const wantsChrome = !!stored.rpNotifyWantsChrome;
  const wantsEmail = !!stored.rpNotifyWantsEmail;
  const savedEmail = stored.rpNotifyEmail || state.resumeData?.contact?.email || '';

  backdrop.classList.remove('hidden');
  card.classList.remove('hidden');
  requestAnimationFrame(() => { backdrop.classList.add('visible'); card.classList.add('visible'); });

  card.innerHTML = `
    <div class="rp-notify-title">🔔 Notify me about updates</div>
    <div class="rp-notify-sub">We'll only reach out when we ship something worth knowing about — new features, fixes, or improvements. No spam, unsubscribe anytime.</div>

    <label class="rp-notify-row">
      <input type="checkbox" id="rp-notify-chrome" ${wantsChrome ? 'checked' : ''}>
      <span class="rp-notify-row-label">Show me a notification in Chrome</span>
    </label>

    <label class="rp-notify-row">
      <input type="checkbox" id="rp-notify-email-check" ${wantsEmail ? 'checked' : ''}>
      <span class="rp-notify-row-label">Email me</span>
    </label>
    <div id="rp-notify-email-wrap" style="margin-left:24px;margin-top:-6px;margin-bottom:12px;${wantsEmail ? '' : 'display:none;'}">
      <input type="email" id="rp-notify-email" class="rp-notify-email-input" placeholder="you@example.com" value="${String(savedEmail).replace(/"/g, '&quot;')}">
    </div>

    <div class="rp-notify-actions">
      <button class="rp-notify-save" id="rp-notify-save-btn">${isSubscribed ? 'Update' : 'Subscribe'}</button>
      <button class="rp-notify-cancel" id="rp-notify-cancel-btn">Cancel</button>
    </div>
    ${isSubscribed ? `<button class="rp-notify-cancel" id="rp-notify-unsub-btn" style="width:100%;margin-top:8px;border-color:transparent;color:#dc2626;">Unsubscribe from updates</button>` : ''}
    <div class="rp-notify-status" id="rp-notify-status"></div>
  `;

  const emailCheckbox = card.querySelector('#rp-notify-email-check');
  const emailWrap = card.querySelector('#rp-notify-email-wrap');
  emailCheckbox?.addEventListener('change', () => {
    emailWrap.style.display = emailCheckbox.checked ? '' : 'none';
  });

  function closeNotifyCard() {
    backdrop.classList.remove('visible');
    card.classList.remove('visible');
    setTimeout(() => { backdrop.classList.add('hidden'); card.classList.add('hidden'); }, 180);
  }

  card.querySelector('#rp-notify-cancel-btn')?.addEventListener('click', closeNotifyCard);
  backdrop.onclick = closeNotifyCard;

  card.querySelector('#rp-notify-save-btn')?.addEventListener('click', async () => {
    const statusEl = card.querySelector('#rp-notify-status');
    const chromeChecked = card.querySelector('#rp-notify-chrome')?.checked;
    const emailChecked = card.querySelector('#rp-notify-email-check')?.checked;
    const emailVal = card.querySelector('#rp-notify-email')?.value.trim() || '';

    if (!chromeChecked && !emailChecked) {
      statusEl.textContent = 'Pick at least one way to be notified.';
      statusEl.style.color = '#dc2626';
      return;
    }
    if (emailChecked && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal)) {
      statusEl.textContent = 'Enter a valid email, or uncheck "Email me."';
      statusEl.style.color = '#dc2626';
      return;
    }

    statusEl.textContent = 'Saving…';
    statusEl.style.color = '#6b7280';
    const res = await send('SUBSCRIBE_NOTIFICATIONS', { wantsChrome: !!chromeChecked, wantsEmail: !!emailChecked, email: emailVal });
    if (res.error) {
      statusEl.textContent = res.error;
      statusEl.style.color = '#dc2626';
      return;
    }
    // Mirror the save into local storage keys openNotifyCard reads from,
    // so re-opening the card (without a round trip) shows the right state
    // immediately — SUBSCRIBE_NOTIFICATIONS's handler already sets
    // rpNotifySubscribed/rpNotifyWantsChrome; fill in the two it doesn't.
    await send('SET_STORAGE', { data: { rpNotifyWantsEmail: !!emailChecked, rpNotifyEmail: emailVal } });
    if (res.remoteSaved === false) {
      // Saved on this device, but the update server didn't take it — be
      // straight about it instead of showing a full success.
      statusEl.textContent = "Saved on this device, but I couldn't reach the update server just now. I'll keep retrying in the background — until it goes through, emails won't reach you.";
      statusEl.style.color = '#b45309';
      setTimeout(closeNotifyCard, 4200);
    } else {
      statusEl.textContent = '✓ Saved — thanks!';
      statusEl.style.color = '#16a34a';
      setTimeout(closeNotifyCard, 900);
    }
  });

  card.querySelector('#rp-notify-unsub-btn')?.addEventListener('click', async () => {
    const statusEl = card.querySelector('#rp-notify-status');
    statusEl.textContent = 'Unsubscribing…';
    statusEl.style.color = '#6b7280';
    await send('UNSUBSCRIBE_NOTIFICATIONS', {});
    await send('SET_STORAGE', { data: { rpNotifyWantsEmail: false, rpNotifyEmail: '' } });
    statusEl.textContent = 'Unsubscribed.';
    statusEl.style.color = '#16a34a';
    setTimeout(closeNotifyCard, 700);
  });
}

function initHelpTour() {
  const helpBtn = $('btn-help-tour');
  if (helpBtn) helpBtn.addEventListener('click', () => runTour());

  // Auto-run once per install, only once the panel actually has something
  // to point at (a resume exists — otherwise "Tailor for This Job" isn't
  // even visible yet, and the tour would be pointing at nothing).
  send('GET_STORAGE', { keys: ['rpTourSeen'] }).then(stored => {
    if (!stored.rpTourSeen && state.resumeData) {
      // Small delay so the tour doesn't compete with the initial render —
      // let the panel settle visually first.
      setTimeout(() => runTour({ isFirstRun: true }), 600);
    }
  }).catch(() => {});
}

function runTour({ isFirstRun = false } = {}) {
  const backdrop = $('rp-tour-backdrop');
  const highlight = $('rp-tour-highlight');
  const card = $('rp-tour-card');
  if (!backdrop || !highlight || !card) return;

  // Only step through anchors that actually exist and are visible right
  // now — e.g. before a resume is tailored, the Inject/Evaluate buttons
  // aren't in the DOM's visible flow yet. Skipping them rather than
  // pointing at an invisible element keeps the tour coherent regardless
  // of what state the panel happens to be in when replayed via "?".
  const steps = TOUR_STEPS
    .map(s => ({ ...s, el: document.querySelector(`[data-tour="${s.anchor}"]`) }))
    .filter(s => s.el && s.el.offsetParent !== null);

  if (!steps.length) return; // nothing visible to point at right now

  let i = 0;
  backdrop.classList.remove('hidden');
  highlight.classList.remove('hidden');
  card.classList.remove('hidden');
  requestAnimationFrame(() => backdrop.classList.add('visible'));

  function positionOn(el) {
    const r = el.getBoundingClientRect();
    const pad = 6;
    highlight.style.top = `${r.top - pad}px`;
    highlight.style.left = `${r.left - pad}px`;
    highlight.style.width = `${r.width + pad * 2}px`;
    highlight.style.height = `${r.height + pad * 2}px`;

    // Card position: below the highlighted element if there's room,
    // otherwise above it.
    const cardWidth = 260;
    let cardLeft = r.left;
    cardLeft = Math.max(10, Math.min(cardLeft, window.innerWidth - cardWidth - 10));
    let cardTop = r.bottom + pad + 12;
    const estCardHeight = 140;
    if (cardTop + estCardHeight > window.innerHeight) {
      cardTop = r.top - pad - estCardHeight - 12;
    }
    card.style.left = `${cardLeft}px`;
    card.style.top = `${Math.max(10, cardTop)}px`;
  }

  function renderStep() {
    const step = steps[i];
    positionOn(step.el);
    const isLast = i === steps.length - 1;
    card.innerHTML = `
      <div class="rp-tour-step-label">Step ${i + 1} of ${steps.length}</div>
      <div class="rp-tour-title">${step.title}</div>
      <div class="rp-tour-body">${step.body}</div>
      <div class="rp-tour-actions">
        <button class="rp-tour-skip" id="rp-tour-skip-btn">Skip</button>
        <button class="rp-tour-next" id="rp-tour-next-btn">${isLast ? 'Got it' : 'Next'}</button>
      </div>
      <div class="rp-tour-dots">
        ${steps.map((_, idx) => `<span class="rp-tour-dot${idx === i ? ' active' : ''}"></span>`).join('')}
      </div>
    `;
    requestAnimationFrame(() => card.classList.add('visible'));

    $('rp-tour-next-btn')?.addEventListener('click', () => {
      if (isLast) { endTour(); return; }
      i++;
      card.classList.remove('visible');
      setTimeout(renderStep, 120);
    });
    $('rp-tour-skip-btn')?.addEventListener('click', endTour);
  }

  function endTour() {
    backdrop.classList.remove('visible');
    card.classList.remove('visible');
    setTimeout(() => {
      backdrop.classList.add('hidden');
      highlight.classList.add('hidden');
      card.classList.add('hidden');
    }, 200);
    if (isFirstRun) send('SET_STORAGE', { data: { rpTourSeen: true } });
  }

  // Clicking the dimmed backdrop itself also exits — matches how most
  // guided-tour / modal patterns behave, so it's not a dead end if someone
  // clicks outside the card by habit.
  backdrop.onclick = endTour;

  renderStep();
}


// Persist everything this panel produced, so the next page picks up exactly
// where this one left off. Called after any mutation of the work product.
async function saveWork() {
  // The moment THIS panel produced this work. Recorded locally too, so a
  // later session read can be compared against it: only a session whose
  // workSavedAt is newer than this holds a genuinely newer resume.
  const workSavedAt = Date.now();
  state.lastWorkSavedAt = workSavedAt;
  const res = await send('SESSION_SAVE_WORK', {
    workSavedAt,
    tailoredResume:   state.tailoredResume,
    pdfBase64:        state.pdfBase64,
    atsAnalysis:      state.atsAnalysis,
    missingKinds:     state.missingKinds || {},
    placedSkills:     state.placedSkills || [],
    listedOnlySkills: state.listedOnlySkills || [],
    notesShown: {
      gap:    !!state.gapNoteShown,
      fit:    !!state.fitNoteShown,
      bullet: !!state.bulletOfferShown
    }
  });
  // This save is now the freshest known-good state — record its timestamp so
  // a later read that happens to catch a stale copy of storage (a real risk
  // across tabs/pages sharing one session) can never overwrite it.
  if (res?.ts) state.lastSyncedTs = Math.max(state.lastSyncedTs || 0, res.ts);
  return res;
}

// Adopt the session's work product into this panel and re-render the left side.
// Without this, a panel that slept through the tailoring shows a stale score.
function adoptWork(sess) {
  if (!sess) return false;
  // Never regress to older data than what this panel already has — sess.ts
  // is the session's own last-write timestamp, set fresh on every save.
  if (sess.ts && state.lastSyncedTs && sess.ts <= state.lastSyncedTs) return false;
  if (sess.ts) state.lastSyncedTs = Math.max(state.lastSyncedTs || 0, sess.ts);

  let changed = false;

  // sess.ts moves on EVERY session write (chat lines, fingerprints, applied
  // flag...), so on its own it cannot tell a newer resume from a stale one
  // that merely got re-written later. workSavedAt only moves when a panel
  // actually saves work, so that is what decides whether the session's
  // resume / score / placed-skills are newer than what this panel holds.
  // A panel with no resume yet (fresh page) takes whatever the session has.
  const sessionWorkIsNewer = !state.tailoredResume
    || (sess.workSavedAt || 0) > (state.lastWorkSavedAt || 0);

  if (sessionWorkIsNewer) {
    if (sess.tailoredResume && sess.tailoredResume !== state.tailoredResume) {
      state.tailoredResume = sess.tailoredResume;
      state.pdfBase64 = sess.pdfBase64 || state.pdfBase64;
      changed = true;
    }
    if (sess.missingKinds)     state.missingKinds     = sess.missingKinds;
    if (sess.placedSkills)     state.placedSkills     = sess.placedSkills;
    if (sess.listedOnlySkills) state.listedOnlySkills = sess.listedOnlySkills;
    if (sess.workSavedAt)      state.lastWorkSavedAt  = sess.workSavedAt;
  }

  // Notes are per-job, not per-page. If another panel already warned about the
  // seniority gap, this one must not warn again.
  if (sess.notesShown) {
    state.gapNoteShown    = state.gapNoteShown    || !!sess.notesShown.gap;
    state.fitNoteShown    = state.fitNoteShown    || !!sess.notesShown.fit;
    state.bulletOfferShown= state.bulletOfferShown|| !!sess.notesShown.bullet;
  }

  if (sessionWorkIsNewer && sess.atsAnalysis && sess.atsAnalysis !== state.atsAnalysis) {
    state.atsAnalysis = sess.atsAnalysis;
    changed = true;
  }

  if (changed && state.tailoredResume) {
    hide('btn-tailor-fab');
    show('result-area');
    if (state.atsAnalysis) renderAtsResultOnly(state.atsAnalysis);
    else showAtsPrompt();
  }
  return changed;
}

async function refreshSharedState() {
  const stored = await send('GET_STORAGE', { keys: ['atsUsageCount', 'atsEvaluatedJobs', 'rpSession'] });
  if (!stored) return;
  state.atsUsed = Number(stored.atsUsageCount || 0);
  state.atsEvaluatedJobs = stored.atsEvaluatedJobs || [];

  const prompt = $('fab-ats-prompt');
  if (prompt && !prompt.classList.contains('hidden')) showAtsPrompt();

  // Each page runs its own panel instance. When the user tailors on the company
  // careers page and comes back to LinkedIn, this panel is still showing the
  // conversation as it was when they left. Re-read the shared session and
  // replay anything that happened while we weren't looking.
  const sess = stored.rpSession;
  if (!sess) return;

  // A session must EARN its way into this panel: it has to be fresh, and it
  // has to belong to the job this panel is showing. Without these guards, an
  // applied session from days-old testing leaks in on any tab focus — showing
  // "already applied" for a job the user is seeing for the first time, and
  // adopting a stale resume from a different posting.
  const fresh = (Date.now() - (sess.ts || 0)) < 90 * 60 * 1000;
  const belongsHere = !state.fingerprint
    || (Array.isArray(sess.fingerprints) && sess.fingerprints.includes(state.fingerprint));
  if (!fresh || !belongsHere) return;

  // Take on any work another page did while this panel was idle.
  adoptWork(sess);

  if (!sess.chatHistory) return;

  // Replay only what this panel hasn't rendered. state.rendered counts what's
  // actually on screen; the session's snapshot goes stale the moment we push
  // a message, so comparing against it replays the visible conversation.
  const shown = state.rendered || 0;
  const total = sess.chatHistory.length;
  if (total > shown) {
    const msgs = $('chat-messages');
    const lastOnScreen = msgs?.lastElementChild?.innerText?.trim() || '';
    sess.chatHistory.slice(shown).forEach(m => {
      // A panel that just tailored will have rendered "Resume tailored!" itself
      // AND persisted it. Skip a replayed message identical to what's already
      // the last thing on screen.
      if (m.text?.trim() && lastOnScreen.includes(m.text.trim().slice(0, 40))) {
        state.rendered++;
        return;
      }
      if (m.role === 'user') pushUserMessage(m.text, true);
      else pushAssistantMessage(m.text, [], true);
    });
  }

  // Applied while we were away → show the banner.
  if (sess.applied && !state.session?.applied) {
    addAppliedBanner(sess.company, sess.appliedAt);
  }
  state.session = sess;
}

// ── Live updates from content script ─────────────────────────────────────
window.addEventListener('message', e => {
  const d = e.data;
  if (!d) return;

  if (d.rp_push === 'JD_DETECTED') {
    // Ignore empty pushes — never wipe a recovered JD back to "Scanning…".
    if (!d.jd || (typeof d.jd === 'string' && d.jd.trim().length < 20)) return;

    state.jdSource = 'page';
    const newFingerprint = d.fingerprint;

    // Same job as we're already showing? Update the text quietly and stop.
    // LinkedIn re-renders the job card repeatedly (lazy-load, "see more"),
    // and each re-render must NOT re-announce the job or reset the panel.
    if (!newFingerprint || newFingerprint === state.fingerprint) {
      state.jd = d.jd;
      updateHeader();
      return;
    }

    // A genuinely different job. Switch to it.
    state.jd = d.jd;
    state.fingerprint = newFingerprint;

    // Reset everything tied to the previous job. The session is the single
    // source of truth now — no separate local cache to fall out of sync.
    state.tailoredResume = null;
    state.pdfBase64 = null;
    state.atsAnalysis = null;
    state.missingKinds = {};
    state.placedSkills = [];
    state.listedOnlySkills = [];
    state.skillsAddedSinceEval = 0;
    state.skillsAddedThisJob = 0;
    state.expGapShown = false;
    state.fitNoteShown = false;
    state.gapNoteShown = false;
    state.bulletOfferShown = false;
    // Without this, jobKey (session.sessionId || fingerprint) kept resolving
    // to the PREVIOUS job's session — so a brand-new job could silently
    // inherit "already evaluated" and show "Re-evaluate (free)" instead of
    // "Evaluate". A fresh session for this job gets adopted on the next
    // focus-sync / evaluate call; until then, the fingerprint alone is correct.
    state.session = null;

    // Prefer the title read from the page's own heading — reliable. If
    // that's not available, use the company name (extracted separately,
    // via DOM/URL — not prose-guessing) rather than guessing a specific
    // title from JD prose, which has proven unreliable (sidebar badges,
    // upsell banners, section headers, and ordinary bullet sentences
    // containing a word like "lead" have all been wrongly picked as a
    // title by prose-guessing in the past).
    const jobTitle = d.title || (d.company && d.company !== 'Unknown Company' ? `New role at ${d.company}` : extractJobTitle(d.jd));
    resetResultUI();
    addThreadSeparator(jobTitle);
    pushAssistantMessage(
      `📋 New job detected: **${jobTitle}**\n\nThe resume on the left is reset. Tap ⚡ to tailor it for this role — about 30 seconds.`
    );
    updateQuickActions([]);
    updateHeader();
    updateMainArea();
    // Catch state.session up to this new job as soon as the content script's
    // session creation lands, rather than waiting for the next tab focus.
    setTimeout(() => refreshSharedState().catch(() => {}), 400);
  }

  if (d.rp_push === 'FEEDBACK_DUE') {
    showFeedbackModal();
  }

  if (d.rp_push === 'PROFILE_UPDATED') {
    state.resumeData = d.resumeData;
    state.userName   = d.userName || state.userName;
    const footerUser = $('footer-user');
    if (footerUser) footerUser.textContent = state.resumeData?.name || state.userName || '';
    show('panel-footer');
    hide('no-profile'); updateMainArea();
    // Only announce a genuine profile change (from onboarding), not the
    // incremental skill-add writes. d.announce is set only for real updates.
    if (d.announce) pushAssistantMessage(`Profile updated! Your new resume is ready to use.`);
  }

  if (d.rp_push === 'TITLE_CORRECTED' && d.jobTitle) {
    // The AI read the real title directly from the JD text — more reliable
    // than the DOM/prose extraction used for the initial announcement,
    // which can be wrong when a site changes its page structure. Correct
    // the most recently added thread separator (the job-name label shown
    // above "New job detected") to reflect it.
    const separators = document.querySelectorAll('.thread-separator span');
    const last = separators[separators.length - 1];
    if (last) last.textContent = d.jobTitle;
  }
});

// ── Header ────────────────────────────────────────────────────────────────
function updateHeader() {
  const dot = $('jd-dot-header'), label = $('jd-label-header');
  if (!dot || !label) return;
  if (state.jd) {
    dot.className = 'jd-dot-header detected';
    // Show whether we're using the page's JD or a saved one from the session
    label.textContent = (state.jdSource && state.jdSource !== 'page')
      ? 'Using saved JD ✓'
      : 'JD detected ✓';
    label.title = (state.jdSource && state.jdSource !== 'page')
      ? 'No JD on this page — using the job you were applying to'
      : '';
  } else {
    dot.className = 'jd-dot-header scanning';
    label.textContent = 'Scanning…';
  }
}

// ── Main area ─────────────────────────────────────────────────────────────
function updateMainArea() {
  if (!state.resumeData) {
    show('no-profile'); hide('main-area'); return;
  }
  hide('no-profile'); show('main-area');
  const chip = $('chip-name');
  if (chip) chip.textContent = state.resumeData.name || state.userName || 'Your Resume';
  show('profile-chip');
  if (state.jd) { show('btn-tailor-fab'); hide('no-jd-msg'); }
  else           { hide('btn-tailor-fab'); show('no-jd-msg'); }
}

// ── Reset UI when switching to a new JD — back to step 1 ─────────────────
function resetResultUI() {
  hide('result-area');
  hide('cl-output');
  hide('fab-ats-prompt');
  hide('fab-ats-result');
  hide('progress-area');
  const missingEl = $('fab-ats-missing');
  if (missingEl) missingEl.innerHTML = '';
  const clPreview = $('cl-preview-fab');
  if (clPreview) clPreview.textContent = '';
  hide('btn-reevaluate');
  // Explicitly show the tailor button if a JD is present — this is "step 1"
  if (state.jd) show('btn-tailor-fab');
}

// ── Tailoring ─────────────────────────────────────────────────────────────
$('btn-tailor-fab')?.addEventListener('click', async () => {
  if (!state.jd) return;
  hide('btn-tailor-fab'); resetResultUI();
  show('progress-area');
  startGlow();
  const stopProgress = startCyclingProgress([
    'Reading job description…',
    'Matching your experience…',
    'Rewriting bullet points…',
    'Tuning your skills section…',
    'Finalizing formatting…'
  ]);
  const res = await send('TAILOR_RESUME', { jobDescription: state.jd });
  stopProgress();
  stopGlow();
  hide('progress-area');
  if (res.error) { show('btn-tailor-fab'); showError(res.message || res.error); return; }
  state.tailoredResume = res.tailored; state.pdfBase64 = res.pdfBase64;
  state.atsAnalysis = null; state.skillsAddedSinceEval = 0;
  // Save to JD cache
  show('result-area'); showAtsPrompt();
  saveWork();
  pushAssistantMessage(`Resume tailored! You can evaluate your match score above, or use the shortcuts below to refine it.`);
  announcePageFit(res.pageInfo);
  showExperienceGapNote();   // readable from the JD alone — say it before they invest more time
  updateQuickActions([]); // re-render buttons as active now that resume exists
  // Every Nth tailor (see FEEDBACK_EVERY_N_TAILORS in worker.js), res carries
  // feedbackDue straight through — no cross-context relay needed here, this
  // handler already has the tailor response in scope.
  if (res.feedbackDue) showFeedbackModal();
});

// Glowing star icon during any async AI operation — a purely visual cue,
// separate from the text messages, so the user has an at-a-glance signal
// that something is happening even without reading the cycling text.
// Reference-counted so two overlapping operations (rare, but possible)
// don't turn the glow off when only one of them finishes.
let _glowCount = 0;
function startGlow() {
  _glowCount++;
  $('ai-star-icon')?.classList.add('glowing');
}
function stopGlow() {
  _glowCount = Math.max(0, _glowCount - 1);
  if (_glowCount === 0) $('ai-star-icon')?.classList.remove('glowing');
}

function setProgress(pct, text, ids = { fill: 'progress-fill', label: 'progress-text' }) {
  const fill = $(ids.fill), label = $(ids.label);
  if (fill) fill.style.width = pct + '%';
  if (label) label.textContent = text;
}

// Cycles through plausible stage messages on a timer while a real request is
// in flight. There's no genuine progress to report from a single AI call, so
// this is deliberately a believable simulation, not a real percentage — it
// stops cleanly the moment the actual response arrives, whatever stage it
// happened to be showing.
const STILL_WORKING_POOL = [
  'Almost there…', 'Just a moment more…', 'Wrapping up…',
  'Hang tight…', 'Nearly finished…', 'A little longer…'
];

function startCyclingProgress(stages, intervalMs = 1600, ids) {
  let tick = 0;
  let stopped = false;
  setProgress(12, stages[0], ids);
  function scheduleNext() {
    // Real stages advance at the normal pace — each one is new information.
    // Once exhausted there's nothing new to say, so the still-working phase
    // paces slower — otherwise a normal-length wait cycles the same small
    // set of phrases past twice, which reads as repetitive rather than
    // reassuring.
    const delay = tick < stages.length ? intervalMs : intervalMs * 2;
    setTimeout(() => {
      if (stopped) return;
      tick++;
      // Advance forward through the real stages once, in order — never back
      // to an earlier one. "Reading job description…" reappearing after
      // "Finalizing formatting…" made no sense, which is exactly what an
      // earlier wrap-around version did.
      const stageText = tick < stages.length
        ? stages[tick]
        : STILL_WORKING_POOL[(tick - stages.length) % STILL_WORKING_POOL.length];
      // The bar keeps asymptotically creeping toward 95% independent of the
      // text, so it never looks frozen even once the text has cycled.
      const pct = Math.min(95, 12 + Math.round(83 * (1 - 1 / (1 + tick * 0.35))));
      setProgress(pct, stageText, ids);
      scheduleNext();
    }, delay);
  }
  scheduleNext();
  return () => { stopped = true; };
}

const EVAL_PROGRESS_IDS = { fill: 'eval-progress-fill', label: 'eval-progress-text' };

// Builds "resume_FirstLast.pdf" from the resume owner's own name —
// state.resumeData.name, parsed from their uploaded resume at onboarding
// and available synchronously from page load. No dependency on job
// detection, session timing, or any async refresh: this can't race.
// Falls back to the old generic name only if no resume has been parsed yet
// (shouldn't happen once Download/Inject are even clickable, but be safe).
function resumeFilename() {
  const name = state.resumeData?.name || state.userName;
  if (!name) return 'resume_tailored.pdf';
  const safe = String(name)
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')   // strip accents
    .replace(/[^a-zA-Z0-9]+/g, '_')                        // non-alphanumeric → _
    .replace(/^_+|_+$/g, '')                                // trim leading/trailing _
    .slice(0, 60);                                          // keep it sane
  return safe ? `resume_${safe}.pdf` : 'resume_tailored.pdf';
}

// Last-resort, independent check: does the ACTUAL resume JSON really
// contain every skill the UI believes was successfully placed? This is
// deliberately separate from (and doesn't trust) whatever the placement
// flow itself reported — it exists specifically because that reporting can
// be wrong (a real incident: "11 skills placed" while the resume had none
// of them), and a check that only re-validates the same data the bug
// already fooled wouldn't catch it. This one inspects the final object
// directly, right before it's about to leave the extension.
// Core check: which of `skills` have no real trace anywhere in `resume`'s
// JSON. Same word-level matching used server-side in ai.js — short skills
// (≤2 significant words) require every word present, longer phrases
// tolerate natural rephrasing (60%+ of significant words). Deliberately
// duplicated client-side rather than trusted to the server-side guard
// alone: a real incident showed the server-side check can be bypassed by a
// path not yet fully traced, so this independent client-side check is the
// actual backstop, not a redundant formality.
function findSkillsMissingFromGiven(resume, skills) {
  if (!skills?.length || !resume) return [];
  const STOP = new Set(['a','an','the','and','or','to','of','in','on','for','with','by','at','as','is','are','writing','development','programming']);
  const words = s => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 2 && !STOP.has(w));
  const haystack = JSON.stringify(resume).toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  return skills.filter(skill => {
    const w = words(skill);
    if (!w.length) return true;
    const hits = w.filter(x => haystack.includes(x));
    return w.length <= 2 ? hits.length < w.length : hits.length < Math.ceil(w.length * 0.6);
  });
}

// Checks whether placing a skill into `target` (a company or project name)
// caused that entry's ORIGINAL bullets to be wholesale replaced rather than
// added to. Real confirmed incident: placing one experience-kind skill
// caused all 4 original bullets at that entry to be deleted and replaced
// with 3 new bullets only about the new skill. Returns true if the entry
// looks replaced (most of its original content is gone), independent of
// whether bullet count went up, down, or stayed flat — a pure count check
// can't see this failure mode, since a replacement can net the same count.
function entryLooksReplaced(beforeResume, afterResume, targetName) {
  if (!beforeResume || !afterResume || !targetName) return false;
  const findEntry = (resume, name) => {
    const inExp = (resume.experience || []).find(e => e.company === name);
    if (inExp) return inExp;
    return (resume.projects || []).find(p => p.name === name) || null;
  };
  const before = findEntry(beforeResume, targetName);
  const after = findEntry(afterResume, targetName);
  if (!before || !after) return false;
  const origBullets = Array.isArray(before.bullets) ? before.bullets : [];
  const resultBullets = Array.isArray(after.bullets) ? after.bullets : [];
  if (!origBullets.length) return false;

  const STOP = new Set(['a','an','the','and','or','to','of','in','on','for','with','by','at','as','is','are','was','were','be','been','this','that','these','those','it','its','their','our','your']);
  const jaccard = (a, b) => {
    const tok = s => String(s||'').toLowerCase().replace(/[.,;:!?()]/g,'').split(/\s+/).filter(w=>w&&!STOP.has(w));
    const ta = new Set(tok(a)), tb = new Set(tok(b));
    const inter = [...ta].filter(w=>tb.has(w)).length;
    const union = new Set([...ta,...tb]).size;
    return union===0?0:inter/union;
  };

  const survived = origBullets.filter(ob => {
    if (String(ob || '').length > 260) return true; // too long to expect a clean trace — don't penalize
    const bestMatch = Math.max(0, ...resultBullets.map(ab => jaccard(ob, ab)));
    return bestMatch >= 0.15;
  }).length;
  const lost = origBullets.length - survived;
  return origBullets.length <= 2 ? lost > 0 : lost > 1;
}

function findSkillsMissingFromResume() {
  return findSkillsMissingFromGiven(state.tailoredResume, state.placedSkills || []);
}

// ── Download & Inject ─────────────────────────────────────────────────────
$('btn-download-fab')?.addEventListener('click', () => {
  if (!state.pdfBase64) return;
  const actuallyMissing = findSkillsMissingFromResume();
  if (actuallyMissing.length) {
    pushAssistantMessage(`⚠️ Before downloading: ${actuallyMissing.join(', ')} ${actuallyMissing.length === 1 ? "was" : "were"} marked as added, but I don't actually see ${actuallyMissing.length === 1 ? 'it' : 'them'} in your resume. Downloading anyway, but you may want to re-add ${actuallyMissing.length === 1 ? 'it' : 'them'} via the chat.`);
  }
  send('DOWNLOAD_FILE', { base64: state.pdfBase64, filename: resumeFilename() });
});
$('btn-inject-fab')?.addEventListener('click', async () => {
  if (!state.pdfBase64) return;
  const actuallyMissingAtInject = findSkillsMissingFromResume();
  if (actuallyMissingAtInject.length) {
    pushAssistantMessage(`⚠️ Before injecting: ${actuallyMissingAtInject.join(', ')} ${actuallyMissingAtInject.length === 1 ? "was" : "were"} marked as added, but I don't actually see ${actuallyMissingAtInject.length === 1 ? 'it' : 'them'} in your resume. Injecting anyway, but you may want to re-add ${actuallyMissingAtInject.length === 1 ? 'it' : 'them'} via the chat first.`);
  }
  const btn = $('btn-inject-fab');
  const res = await send('INJECT_RESUME', { pdfBase64: state.pdfBase64, filename: resumeFilename() });
  if (res.filled) {
    flash(btn, '✓ Ready');
    pushAssistantMessage(`Found the resume upload field — click the "Use Tailored Resume" button that appeared next to it on the page.`);
  } else {
    flash(btn, '✕ Not found');
    pushAssistantMessage(`Couldn't find a resume upload field on this page — download the PDF and attach it manually instead.`);
  }
});

// ── Cover letter ──────────────────────────────────────────────────────────
$('btn-cl-collapse')?.addEventListener('click', () => {
  const p = $('cl-preview-fab'), b = $('btn-cl-collapse');
  if (!p || !b) return;
  const hidden = p.classList.contains('hidden');
  p.classList.toggle('hidden', !hidden);
  b.textContent = hidden ? '−' : '+';
});
$('btn-gen-cl-fab')?.addEventListener('click', async () => {
  const btn = $('btn-gen-cl-fab');
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  show('cl-progress-area');
  startGlow();
  const stopProgress = startCyclingProgress([
    'Reading the job description…',
    'Finding your strongest angle…',
    'Drafting the letter…',
    'Polishing the tone…'
  ], 1600, { fill: 'cl-progress-fill', label: 'cl-progress-text' });
  const res = await send('GENERATE_COVER_LETTER', { jobDescription: state.jd, tailoredResume: state.tailoredResume });
  stopProgress();
  stopGlow();
  hide('cl-progress-area');
  if (btn) { btn.disabled = false; btn.textContent = '✦ Generate'; }
  if (res.error) { showError(res.message || res.error); return; }
  state.coverLetter = res.coverLetter; state.coverLetterPdfBase64 = res.coverLetterPdfBase64 || null;
  const p = $('cl-preview-fab');
  if (p) { p.textContent = res.coverLetter || ''; p.classList.remove('hidden'); }
  const cb = $('btn-cl-collapse');
  if (cb) cb.textContent = '−';
  show('cl-output');
});
$('btn-cl-download-fab')?.addEventListener('click', () => { if (state.coverLetterPdfBase64) send('DOWNLOAD_FILE', { base64: state.coverLetterPdfBase64, filename: 'cover_letter.pdf' }); });
$('btn-cl-inject-fab')?.addEventListener('click', async () => {
  if (!state.coverLetter) return;
  const btn = $('btn-cl-inject-fab');
  const res = await send('INJECT_COVER_LETTER', { text: state.coverLetter, pdfBase64: state.coverLetterPdfBase64 });
  if (res.filled) {
    flash(btn, '✓');
  } else {
    // Be honest — no matching field was found on this page, rather than
    // showing success when nothing actually happened.
    flash(btn, '✕ Not found');
    pushAssistantMessage(`Couldn't find a cover letter field on this page — copy it manually instead.`);
  }
});
$('btn-cl-copy-fab')?.addEventListener('click', () => { if (state.coverLetter) { send('COPY_TEXT', { text: state.coverLetter }); flash($('btn-cl-copy-fab'), '✓'); } });

// A stable fingerprint of the resume's *content*. The evaluation depends on
// exactly two things: the job description, and this. Nothing else.
function resumeFingerprint(resume) {
  if (!resume) return 'none';
  try {
    const skills = (resume.skills || [])
      .flatMap(c => c.items || [])
      .map(s => String(s).toLowerCase().trim())
      .sort()
      .join('|');
    const bullets = (resume.experience || [])
      .flatMap(e => e.bullets || [])
      .join(' ')
      .toLowerCase()
      .replace(/\s+/g, ' ');
    const summary = String(resume.summary || '').toLowerCase().replace(/\s+/g, ' ');
    const seed = `${skills}##${bullets}##${summary}`;
    let h = 0;
    for (let i = 0; i < seed.length; i++) { h = ((h << 5) - h) + seed.charCodeAt(i); h |= 0; }
    return `r_${Math.abs(h).toString(36)}`;
  } catch (_) { return 'err'; }
}

// Run the evaluation, or return the cached one if nothing that affects it has
// changed. Two pages looking at the same job with the same resume must see the
// same number — and the only way to guarantee that is to not ask twice.
async function evaluateOrReuse(jd) {
  // No real JD → don't fabricate a 0/100. Tell the caller to surface guidance.
  if (!jd || jd.trim().length < 150) {
    return { error: 'no_jd', message: 'No job description available yet. Open the job listing, or wait for the session to carry it over from the page you applied from.' };
  }
  const rfp = resumeFingerprint(state.tailoredResume);
  const cached = state.atsAnalysis;

  // Reuse only COMPLETE results. A degraded one (score but no requirement
  // breakdown — truncated response or heuristic fallback) must re-run on the
  // next evaluate, or "tap Re-evaluate to fetch it" would hand back the same
  // empty breakdown forever.
  const cachedComplete = cached && (cached.total_requirements || 0) > 0;
  if (cachedComplete && cached._resumeFingerprint === rfp && cached._jdLength === jd.length) {
    return { ats_analysis: cached, reused: true };
  }

  // A cache miss means the resume changed since the last evaluation — but if
  // we already have a checklist for THIS job, don't let the AI derive a new
  // one from scratch. That's how closing 6 of 10 gaps could surface 3 brand
  // new, previously-unseen ones on the next check: a fresh full read is a
  // fresh judgment call, and the exact same JD can reasonably parse into a
  // slightly different set of items each time. Passing the existing
  // checklist locks the items; only "covered" gets re-judged.
  const existingRequirements = Array.isArray(cached?.requirements) && cached.requirements.length > 0
    ? cached.requirements
    : null;

  const res = await send('EVALUATE_ATS', {
    jobDescription: jd,
    tailoredResume: state.tailoredResume,
    placedSkills: state.placedSkills || [],
    listedOnlySkills: state.listedOnlySkills || [],
    existingRequirements
  });
  if (res.error) return res;

  // Stamp the result so any page can tell whether it still applies.
  res.ats_analysis._resumeFingerprint = rfp;
  res.ats_analysis._jdLength = jd.length;
  return res;
}

// ── ATS ───────────────────────────────────────────────────────────────────
function showAtsPrompt() {
  // Same job, whichever page you're on — key on the session, not the URL.
  const jobKey = state.session?.sessionId || state.fingerprint;
  const alreadyEvaluated = state.atsEvaluatedJobs?.includes(jobKey);
  const freeLimit = state.atsFreeLimit || ATS_FREE_LIMIT;
  const remaining = Math.max(0, freeLimit - state.atsUsed);
  const countEl = $('fab-ats-count'), evalBtn = $('btn-fab-evaluate');
  if (countEl) countEl.textContent = alreadyEvaluated ? 'Re-evaluate this job (free)' : remaining > 0 ? `${remaining} free ${remaining === 1 ? 'analysis' : 'analyses'} left` : 'Upgrade for more analyses';
  if (evalBtn) evalBtn.disabled = (!alreadyEvaluated && remaining === 0);
  show('fab-ats-prompt'); hide('fab-ats-result');
}

// Render the ATS result into the left panel. No chat messages — a panel that
// adopts work done elsewhere must show the score without re-announcing it.
function renderAtsResultOnly(ats) {
  hide('fab-ats-prompt');
  // A null score means the JD couldn't be read — don't render a fake 0/100.
  if (ats.score === null || ats.score === undefined) {
    const scoreEl = $('fab-ats-score');
    if (scoreEl) { scoreEl.textContent = '—'; scoreEl.className = 'mini-score'; }
    const missingEl = $('fab-ats-missing');
    if (missingEl) missingEl.innerHTML = '<div class="ats-missing-hint">Couldn\'t read a job description on this page. Open the listing, or the session will carry it over.</div>';
    show('fab-ats-result');
    return;
  }
  const score = Math.max(0, Math.min(100, Math.round(ats.score || 0)));
  const scoreEl = $('fab-ats-score');
  if (scoreEl) { scoreEl.textContent = `${score}/100`; scoreEl.className = `mini-score ${score >= 75 ? 'good' : score >= 50 ? 'mid' : 'low'}`; }
  const missingEl = $('fab-ats-missing');
  // missing_requirements now carries { skill, kind }. Normalise so the rest of
  // the panel can treat them uniformly, while keeping the kind for placement.
  // missing_requirements now carries { skill, kind, id }. id is the stable
  // reference into atsAnalysis.requirements — matching on it, rather than on
  // the label text, is what makes confirming a skill reliable even if the
  // label passed through normalization slightly differently somewhere.
  const missing = (ats.missing_requirements || []).map(m =>
    typeof m === 'string' ? { skill: m, kind: 'technical', id: null } : m
  );
  // Language items are evaluated but never scored — shown in their own
  // section below, but sharing the same lookup maps so the SAME placement
  // flow (Familiar / Don't know / pick a role) works for them unchanged.
  const bonus = (ats.bonus_requirements || []);
  const allForMaps = [...missing, ...bonus];
  state.missingKinds = Object.fromEntries(allForMaps.map(m => [extractKeyword(m.skill), m.kind]));
  // Confirming a skill sends back the CHIP's text (extractKeyword output),
  // never the raw checklist label. Matching that text against the stored
  // checklist directly was fragile — any normalization difference anywhere
  // in the pipeline silently broke it. This map is built from and consumed
  // by the exact same source data in the exact same render, so the lookup
  // can never diverge from what's actually on screen.
  state.skillIdByKw = Object.fromEntries(allForMaps.map(m => [extractKeyword(m.skill), m.id]).filter(([, id]) => id !== null && id !== undefined));
  if (missingEl) {
    if (missing.length) {
      missingEl.innerHTML = '';
      const label = document.createElement('div'); label.className = 'ats-missing-label';
      label.textContent = "Select skills to add, then tap 'Add selected'"; missingEl.appendChild(label);

      // Grouped visually so it's clear at a glance what KIND of gap each one
      // is — a raw tool reads differently from a named methodology, which
      // reads differently from a demonstrated practice.
      const GROUPS = [
        { kinds: ['technical'], title: 'Technical' },
        { kinds: ['methodology'], title: 'Methodologies' },
        { kinds: ['experience', 'domain'], title: 'Experience & Domain' }
      ];
      const selectedSkills = new Set();
      const allKeywords = missing.map(m => extractKeyword(m.skill));
      const chipButtons = {}; // kw -> button, shared across all group rows

      GROUPS.forEach(group => {
        const items = missing.filter(m => group.kinds.includes(m.kind));
        if (!items.length) return;
        const groupLabel = document.createElement('div');
        groupLabel.className = 'ats-group-label';
        groupLabel.style.cssText = 'font-size:11px;font-weight:600;color:var(--text-2);margin-top:8px;text-transform:uppercase;letter-spacing:0.03em;';
        groupLabel.textContent = group.title;
        missingEl.appendChild(groupLabel);

        const chipsRow = document.createElement('div');
        chipsRow.className = 'ats-missing-chips';
        missingEl.appendChild(chipsRow);

        items.forEach(m => {
          const kw = extractKeyword(m.skill);
          const btn = document.createElement('button'); btn.className = 'ats-skill-btn'; btn.textContent = `+ ${kw}`; btn.dataset.skill = kw;
          btn.addEventListener('click', () => {
            if (btn.classList.contains('added')) return;
            if (selectedSkills.has(kw)) { selectedSkills.delete(kw); btn.classList.remove('selected'); btn.textContent = `+ ${kw}`; }
            else { selectedSkills.add(kw); btn.classList.add('selected'); btn.textContent = `✓ ${kw}`; }
            updateSubmitLabel();
          });
          chipsRow.appendChild(btn);
          chipButtons[kw] = btn;
        });
      });

      const submitWrap = document.createElement('div'); submitWrap.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap;';
      const submitBtn = document.createElement('button'); submitBtn.className = 'ats-add-btn hidden'; submitBtn.textContent = 'Add selected'; submitWrap.appendChild(submitBtn);
      const addAllBtn = document.createElement('button'); addAllBtn.className = 'ats-add-btn'; addAllBtn.style.cssText = 'background:none;border:1px solid var(--blue);color:var(--blue);'; addAllBtn.textContent = 'Add all'; submitWrap.appendChild(addAllBtn);
      const hint = document.createElement('div'); hint.className = 'ats-missing-hint'; hint.textContent = 'Only add skills you genuinely have.'; submitWrap.appendChild(hint);
      missingEl.appendChild(submitWrap);

      // Named so bonus (interpersonal/language) chips can call this exact
      // same logic when they join this shared selection — one combined
      // "Add N skills" label covering both groups, not two separate counts.
      function updateSubmitLabel() {
        if (selectedSkills.size > 0) { submitBtn.classList.remove('hidden'); submitBtn.textContent = `Add ${selectedSkills.size} skill${selectedSkills.size > 1 ? 's' : ''}`; }
        else submitBtn.classList.add('hidden');
      }

      // Shared add function — now asks WHERE each skill was used, then places it.
      async function addSkills(skillsArr, triggerBtn) {
        if (!skillsArr.length) return;
        submitBtn.classList.add('hidden'); addAllBtn.classList.add('hidden');
        selectedSkills.clear();
        // Mark chips as pending
        skillsArr.forEach(kw => { const chip = chipButtons[kw]; if (chip) chip.classList.add('added'); });
        // Walk the user through placing each skill
        await placeSkillsSequentially(skillsArr);
      }

      submitBtn.addEventListener('click', () => addSkills([...selectedSkills], submitBtn));
      addAllBtn.addEventListener('click', () => addSkills(allKeywords.filter(kw => {
        const chip = chipButtons[kw];
        return chip && !chip.classList.contains('added');
      }), addAllBtn));

      // Hand this section's selection/buttons to the bonus (Interpersonal
      // Skills / Languages) section below, so its chips join the SAME
      // selection and SAME submit/add-all — one combined pick, one
      // placement call, instead of two separate flows for what reads as
      // one action to the user.
      renderBonusSkills(bonus, { selectedSkills, chipButtons, updateSubmitLabel, allKeywords });
      show('fab-ats-result');
      return; // bonus already rendered above with the shared controls — skip the call at the bottom of this function
    } else {
      // No missing skills — but WHY? Zero requirements means the evaluator had
      // no job description to read (empty on a form page), which is a failure,
      // not a perfect match. Only a real, non-zero coverage is worth praising.
      const totalReqs = ats.total_requirements || 0;
      if (totalReqs === 0) {
        // A score with no requirement breakdown = the AI's response arrived
        // incomplete (or the heuristic fallback ran). The score is still
        // meaningful — don't tell the user their JD is unreadable when it
        // isn't. Offer the actual remedy: run it again.
        missingEl.innerHTML = `<div class="ats-missing-hint" style="color:var(--text-2)">Got your overall score, but the requirement-by-requirement breakdown didn't come through this time. Tap ↻ Re-evaluate to fetch it.</div>`;
      } else if (score >= 75) {
        missingEl.innerHTML = `<div class="ats-missing-hint" style="color:var(--green)">✓ Strong match — no major skill gaps!</div>`;
      } else {
        missingEl.innerHTML = `<div class="ats-missing-hint" style="color:var(--green)">✓ You cover every requirement this job lists.</div>`;
      }
    }
  }
  renderBonusSkills(bonus);
  show('fab-ats-result');
}

// Language requirements — real, worth showing, but never counted in the
// score above (same treatment tenure gets). Rendered as a separate,
// clearly-labeled block below the main missing-skills area rather than
// interleaved into it, so it's obvious at a glance these don't affect the
// number. Reuses the same placement flow as the main list.
// `shared`, when provided by the main missing-skills section, is
// { selectedSkills, chipButtons, updateSubmitLabel, allKeywords }. Bonus
// chips then add into that SAME Set and update the SAME submit/add-all
// buttons the main section already built — one combined selection, one
// placement call, instead of running the whole "where did you use this"
// flow (and the AI call behind it) twice for what the user experiences as
// one action. Falls back to fully independent controls when `shared` is
// omitted — the case where the main list is empty (e.g. 100% technical
// coverage) but bonus items remain, which still needs its own button.
function renderBonusSkills(bonus, shared = null) {
  let el = $('fab-ats-bonus');
  if (!el) {
    el = document.createElement('div');
    el.id = 'fab-ats-bonus';
    const missingEl = $('fab-ats-missing');
    missingEl?.parentNode?.insertBefore(el, missingEl.nextSibling);
  }
  el.innerHTML = '';
  if (!bonus || !bonus.length) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.style.cssText = 'margin-top:10px;padding-top:10px;border-top:1px dashed var(--border);';

  const label = document.createElement('div');
  label.className = 'ats-missing-label';
  label.style.color = 'var(--text-2)';
  label.textContent = shared
    ? "Good to have — not counted in your score, but you can add these together with the skills above"
    : "Good to have — not counted in your score";
  el.appendChild(label);

  const BONUS_GROUPS = [
    { kinds: ['language'], title: 'Languages' },
    { kinds: ['interpersonal'], title: 'Interpersonal Skills' }
  ];
  // Join the shared selection when available; otherwise keep this
  // section's own independent state exactly as before.
  const selectedSkills = shared ? shared.selectedSkills : new Set();
  const chipButtons = shared ? shared.chipButtons : {};

  let submitBtn, submitWrap; // only used in the standalone (no shared) path

  BONUS_GROUPS.forEach(group => {
    const items = bonus.filter(m => group.kinds.includes(m.kind));
    if (!items.length) return;
    const groupLabel = document.createElement('div');
    groupLabel.className = 'ats-group-label';
    groupLabel.style.cssText = 'font-size:11px;font-weight:600;color:var(--text-2);margin-top:6px;text-transform:uppercase;letter-spacing:0.03em;';
    groupLabel.textContent = group.title;
    el.appendChild(groupLabel);

    const chipsRow = document.createElement('div');
    chipsRow.className = 'ats-missing-chips';
    el.appendChild(chipsRow);

    items.forEach(m => {
      const kw = extractKeyword(m.skill);
      const btn = document.createElement('button');
      btn.className = 'ats-skill-btn';
      btn.textContent = `+ ${kw}`;
      btn.dataset.skill = kw;
      btn.addEventListener('click', () => {
        if (btn.classList.contains('added')) return;
        if (selectedSkills.has(kw)) { selectedSkills.delete(kw); btn.classList.remove('selected'); btn.textContent = `+ ${kw}`; }
        else { selectedSkills.add(kw); btn.classList.add('selected'); btn.textContent = `✓ ${kw}`; }
        if (shared) {
          shared.updateSubmitLabel();
        } else if (selectedSkills.size > 0) {
          submitBtn.classList.remove('hidden'); submitBtn.textContent = `Add ${selectedSkills.size} skill${selectedSkills.size > 1 ? 's' : ''}`;
        } else {
          submitBtn.classList.add('hidden');
        }
      });
      chipsRow.appendChild(btn);
      chipButtons[kw] = btn;
      if (shared) shared.allKeywords.push(kw); // include in this section's own "Add all" sweep too
    });
  });

  if (shared) return; // the main section's submit/add-all buttons already cover these chips now

  submitWrap = document.createElement('div');
  submitWrap.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap;';
  submitBtn = document.createElement('button');
  submitBtn.className = 'ats-add-btn hidden';
  submitBtn.textContent = 'Add selected';
  submitWrap.appendChild(submitBtn);
  el.appendChild(submitWrap);

  submitBtn.addEventListener('click', async () => {
    const skillsArr = [...selectedSkills];
    if (!skillsArr.length) return;
    submitBtn.classList.add('hidden');
    selectedSkills.clear();
    skillsArr.forEach(kw => { const chip = chipButtons[kw]; if (chip) chip.classList.add('added'); });
    // Same placement flow as the main list — this is still a real claim
    // about the resume, just one that won't move the score either way.
    await placeSkillsSequentially(skillsArr);
  });
}

// Render AND announce. Used when this panel produced the result itself.
function showAtsResult(ats) {
  renderAtsResultOnly(ats);

  // A null score means the JD couldn't be read. Say so once, plainly, and
  // stop — do not fall through and compose a contradictory "Coverage: 0/100"
  // message under a header that already says "—".
  if (ats.score === null || ats.score === undefined) {
    pushAssistantMessage(
      `I couldn't read a job description to evaluate against. If you're on an application form, the listing's description should carry over automatically — try going back to the listing once, then returning here.`
    );
    return;
  }

  const score = Math.max(0, Math.min(100, Math.round(ats.score || 0)));
  const missing = (ats.missing_requirements || []).map(m =>
    typeof m === 'string' ? { skill: m, kind: 'technical', id: null } : m
  );

  const total = ats.total_requirements || 0;
  const coveredN = ats.covered_requirements || 0;

  // Diagnostic only — should never fire. missing.length here and the chip
  // count rendered by renderAtsResultOnly (called just above with this same
  // ats object) are supposed to be mathematically identical, since both
  // derive from ats.missing_requirements in the same synchronous call. If
  // this ever logs, it's real evidence of a genuine divergence rather than
  // a screenshot to theorize from after the fact.
  if (total > 0 && missing.length !== total - coveredN) {
    console.warn('[ResumePilot] missing-count mismatch:', {
      missingLength: missing.length,
      total, coveredN,
      expectedMissing: total - coveredN,
      missingRequirements: ats.missing_requirements,
      allRequirements: ats.requirements
    });
  }

  // Every gap is addable now — there's no separate uncloseable bucket. Close
  // everything shown here and the score reaches 100. Tenure gaps (years of
  // experience) are handled entirely by the standalone note, not scored here.
  if (total > 0) {
    const closeable = missing.length;
    const bonusCount = (ats.bonus_requirements || []).length;

    let msg = `Score: **${score}**. ${closeable} skill${closeable === 1 ? '' : 's'} missing.`;
    if (closeable) {
      msg += ` Select them on the left to close them.`;
    } else {
      msg += ` You cover everything this job states.`;
    }
    if (bonusCount) {
      msg += ` There ${bonusCount === 1 ? 'is' : 'are'} also ${bonusCount} good-to-have item${bonusCount === 1 ? '' : 's'} below — not counted in the score.`;
    }

    pushAssistantMessage(msg);
  } else if (missing.length) {
    // Truncated response: we got a score and some gaps, but no total. Say what
    // we can rather than a bare "Coverage: 73/100." with no context.
    let msg = `Score: **${score}**.\n\n**${missing.length} skill${missing.length === 1 ? '' : 's'}** to close on the left — select them and tell me where you've used them.`;
    pushAssistantMessage(msg);
  } else {
    pushAssistantMessage(`Score: **${score}**.`);
  }

  // We can strengthen bullets ourselves — never tell the user to go do it.
  if (!missing.length && state.tailoredResume) offerBulletStrengthening();

  // Fit is a separate, visible note — never a hidden drag on the score.
  showFitNote(ats);
}

// ── Experience-gap helpers (used by the fit note) ─────────────────────────
function parseRequiredYears(jd) {
  if (!jd) return null;
  const patterns = [
    /(\d+)\s*\+?\s*(?:to|-|–)\s*\d+\s*\+?\s*years?/i,       // "5-7 years" → 5
    /(?:minimum|at least|min\.?)\s*(?:of\s*)?(\d+)\s*\+?\s*years?/i,
    /(\d+)\s*\+\s*years?/i,
    /(\d+)\s*years?\s+(?:of\s+)?(?:relevant\s+|professional\s+|industry\s+)?experience/i,
  ];
  for (const p of patterns) {
    const m = jd.match(p);
    if (m) {
      const yrs = parseInt(m[1], 10);
      if (yrs > 0 && yrs <= 25) return yrs;
    }
  }
  return null;
}

function estimateResumeYears(resume) {
  const exp = resume?.experience || [];
  if (!exp.length) return 0;
  let earliest = null;
  exp.forEach(e => {
    const dates = `${e.dates || e.duration || ''}`;
    const years = dates.match(/(19|20)\d{2}/g);
    if (years) years.forEach(y => {
      const yr = parseInt(y, 10);
      if (!earliest || yr < earliest) earliest = yr;
    });
  });
  if (!earliest) return exp.length * 1.5;   // rough fallback
  return Math.max(0, new Date().getFullYear() - earliest);
}

// ── Fit note ──────────────────────────────────────────────────────────────
// The score is coverage, and coverage is closable. But coverage says nothing
// about whether this role actually suits you. When there's a real gap — years
// of experience, or a wholesale role change — say so plainly, once, and leave
// the decision with the user. Never fold it into the number.
// The experience gap is readable from the JD alone — no evaluation needed.
// Surface it right after tailoring, so the user knows what they're walking
// into before they invest time closing skill gaps.
// Every 5th logged application, the background worker sets feedbackDue and
// the content script pushes this. Prefilled from the parsed resume so it's
// low-friction — name/email are editable, and the person can skip entirely.
// Unlike the anonymous tailor/application counts, this DOES carry name and
// email — the person is choosing to identify themselves by submitting it.
function showFeedbackModal() {
  const msgs = $('chat-messages');
  if (!msgs) return;

  const prefillName  = state.resumeData?.name || '';
  const prefillEmail = state.resumeData?.contact?.email || '';

  const card = document.createElement('div');
  card.style.cssText = 'margin:6px 0 10px 40px;padding:14px;background:#f8faff;border:1px solid #c7d7fe;border-radius:10px;';
  card.innerHTML = `
    <div style="font-size:10.5px;font-weight:700;color:#1e3a8a;letter-spacing:0.04em;text-transform:uppercase;margin-bottom:8px;">Quick feedback</div>
    <div style="font-size:12px;color:#374151;line-height:1.45;margin-bottom:10px;">You've applied to a few roles with ResumePilot — how's it going? Anything broken, confusing, or missing?</div>
    <input type="text" class="fb-name" placeholder="Name" value="${String(prefillName).replace(/"/g, '&quot;')}"
      style="width:100%;font-family:inherit;font-size:12px;padding:7px 9px;border:1px solid #c7d7fe;border-radius:6px;margin-bottom:6px;outline:none;box-sizing:border-box;">
    <input type="email" class="fb-email" placeholder="Email" value="${String(prefillEmail).replace(/"/g, '&quot;')}"
      style="width:100%;font-family:inherit;font-size:12px;padding:7px 9px;border:1px solid #c7d7fe;border-radius:6px;margin-bottom:6px;outline:none;box-sizing:border-box;">
    <textarea class="fb-message" placeholder="Your feedback…" rows="3"
      style="width:100%;font-family:inherit;font-size:12px;padding:7px 9px;border:1px solid #c7d7fe;border-radius:6px;outline:none;resize:vertical;box-sizing:border-box;"></textarea>
    <div style="display:flex;gap:8px;margin-top:10px;">
      <button class="fb-submit" style="flex:1;padding:7px 10px;font-size:12px;font-weight:600;border:none;border-radius:8px;background:#1e3a8a;color:#fff;cursor:pointer;">Send feedback</button>
      <button class="fb-skip" style="flex:1;padding:7px 10px;font-size:12px;font-weight:600;border:1px solid #c7d7fe;border-radius:8px;background:transparent;color:#1e3a8a;cursor:pointer;">Not now</button>
    </div>
    <div class="fb-status" style="font-size:11px;color:#dc2626;margin-top:6px;"></div>
  `;
  msgs.appendChild(card);
  msgs.scrollTop = msgs.scrollHeight;

  const nameEl = card.querySelector('.fb-name');
  const emailEl = card.querySelector('.fb-email');
  const msgEl = card.querySelector('.fb-message');
  const statusEl = card.querySelector('.fb-status');
  const submitBtn = card.querySelector('.fb-submit');
  const skipBtn = card.querySelector('.fb-skip');

  function lockCard() {
    card.querySelectorAll('input, textarea, button').forEach(el => el.disabled = true);
    card.style.opacity = '0.7';
  }

  submitBtn.addEventListener('click', async () => {
    const message = msgEl.value.trim();
    if (!message) { statusEl.textContent = 'Please write a note before sending.'; return; }
    submitBtn.disabled = true; submitBtn.textContent = 'Sending…'; statusEl.textContent = '';
    const res = await send('SUBMIT_FEEDBACK', { name: nameEl.value.trim(), email: emailEl.value.trim(), message });
    if (res.error) {
      statusEl.textContent = res.message || res.error;
      submitBtn.disabled = false; submitBtn.textContent = 'Send feedback';
      return;
    }
    lockCard();
    pushAssistantMessage('Thanks — that helps a lot. 🙌');
  });

  skipBtn.addEventListener('click', () => {
    lockCard();
  });
}

function showExperienceGapNote() {
  if (state.gapNoteShown || !state.resumeData) return;

  // Read the requirement from the session's JD, not this page's. Pages abridge
  // the posting differently — LinkedIn may drop the line that names the years
  // while the careers page keeps it. The requirement belongs to the job, so
  // read it from the job, and check every text we hold for this job.
  const texts = [state.session?.jd, state.jd].filter(Boolean);
  let required = null;
  for (const t of texts) {
    required = parseRequiredYears(t);
    if (required) break;
  }
  if (!required) return;

  const actual = estimateResumeYears(state.resumeData);
  if (actual <= 0 || (required - actual) <= 5) return;

  state.gapNoteShown = true;
  saveWork();
  pushAssistantMessage(
    `📋 This role asks for ~**${required} years**, your resume shows ~**${Math.round(actual)}**. Not a dealbreaker, but worth knowing before you apply.`
  );
}

// Role fit needs the evaluation — how much of what they want is already yours.
function showFitNote(ats) {
  if (state.fitNoteShown) return;
  const missingCount = (ats.missing_requirements || []).length;
  const matchedCount = ats.covered_requirements || 0;
  const fitSignal = typeof ats.fit_signal === 'number' ? ats.fit_signal : null;

  const totalReqs = ats.total_requirements || (matchedCount + missingCount);
  if (totalReqs < 4) return;
  const coverage = matchedCount / totalReqs;

  // Most of what they want isn't in your background.
  if (coverage < 0.45 && fitSignal !== null && fitSignal < 55) {
    state.fitNoteShown = true;
    pushAssistantMessage(
      `📋 This role is a stretch from your background — most of what it asks for isn't in your resume yet. ` +
      `All ${missingCount} gaps are listed below; go through them honestly, and decide if it's worth the effort.`
    );
    return;
  }

  // Strong alignment — worth saying.
  if (coverage >= 0.8 && !state.gapNoteShown) {
    state.fitNoteShown = true;
    pushAssistantMessage(`🎯 This role lines up well with your background — most of what they want is already in your resume.`);
  }
}

// Offer to do the work rather than instructing the user to do it themselves.
function offerBulletStrengthening() {
  const container = $('quick-actions');
  if (!container || state.bulletOfferShown) return;
  state.bulletOfferShown = true;

  const btn = document.createElement('button');
  btn.className = 'quick-action-btn';
  btn.textContent = '✨ Strengthen my bullets';
  btn.title = 'Rewrite experience bullets to show impact more clearly';
  btn.addEventListener('click', async () => {
    pushUserMessage('Strengthen my experience bullets');
    const t = pushThinkingMessage();
    const res = await send('CHAT_EDIT', {
      instruction:
        `Rewrite the experience bullets so each one leads with impact and names the technology used. ` +
        `Use strong, specific verbs. Keep every factual claim exactly as-is — do NOT invent metrics, ` +
        `outcomes, companies, dates, or responsibilities that are not already present. ` +
        `You are rephrasing for clarity and impact, not adding new information.`,
      tailoredResume: state.tailoredResume, jobDescription: state.jd
    });
    removeThinkingMessage(t);
    if (res.error) { pushAssistantMessage(`Couldn't rewrite: ${res.message || res.error}`); return; }
    state.tailoredResume = res.tailored; state.pdfBase64 = res.pdfBase64;
    pushAssistantMessage(`Rewrote your experience bullets to lead with impact — same facts, sharper delivery. Download the updated PDF. ↓`);
    updateQuickActions([]);
  });
  container.prepend(btn);
}

// ── Guided skill placement ────────────────────────────────────────────────
// For each skill the user selected, ask WHERE they actually used it. Options
// are their real roles and projects (pulled from the resume), plus a
// "familiar / never used it that way" option that only lists it under Skills.
// This keeps every claim factual — we never invent employment history.
async function placeSkillsSequentially(skills) {
  // Ask ONCE for all skills, not one at a time. The user sees the whole list
  // and assigns each skill to where they used it, in a single pass.
  const assignments = await askBulkPlacement(skills);
  if (!assignments) return;

  const skillsOnly = assignments.filter(a => a.targetType === 'skills');       // Familiar → add to Skills
  const declined   = assignments.filter(a => a.targetType === 'declined');     // Don't know → resume untouched
  const placements = assignments.filter(a => a.targetType === 'experience' || a.targetType === 'project');
  if (!skillsOnly.length && !declined.length && !placements.length) return;

  // Lock the quick-action buttons ("Remove a section", "Shorter summary",
  // etc.) for the ENTIRE placement flow below, not just around each
  // individual CHAT_EDIT call. This flow can fire multiple sequential
  // CHAT_EDIT calls (one for "Familiar" skills, one per experience/project
  // target) that together take many seconds. Without this lock, a user
  // clicking "Remove a section" partway through starts its OWN concurrent
  // CHAT_EDIT built from whatever state.tailoredResume was at that moment
  // — and if that second edit's response lands AFTER this flow's last
  // update to state.tailoredResume, it silently overwrites the just-added
  // skills with a stale, skill-less version. This was the exact cause of
  // "skills were there right after adding, gone after Remove Summary."
  const qaContainer = $('quick-actions');
  const qaButtons = qaContainer?.querySelectorAll('button');
  qaButtons?.forEach(b => { b.disabled = true; b.style.opacity = '0.4'; });
  const chatSendBtn = $('btn-chat-send');
  if (chatSendBtn) chatSendBtn.disabled = true;

  // Snapshot each entry's bullet count BEFORE any placement happens, keyed
  // by the same identifier used elsewhere (company+title, or project name)
  // so growth can be measured per entry once placement finishes — adding
  // many skills across a few roles is exactly what makes one entry balloon
  // to 6+ bullets while others stay at 3, and the user should be told that
  // happened (and offered a one-tap fix) rather than just seeing a longer
  // resume with no explanation.
  // Keyed exactly the way `target` is built below (company name only for
  // experience, project name only for projects — see the `roles`/`projects`
  // arrays a little further down, which is what the placement dropdown's
  // option values are built from). Using any other format here would
  // silently fail to match a single placement.
  // Full snapshot (not just counts) taken before any placement edit in this
  // round — entryLooksReplaced uses it to confirm each target's ORIGINAL
  // bullets survived that target's own edit.
  const resumeBeforeThisRound = state.tailoredResume ? JSON.parse(JSON.stringify(state.tailoredResume)) : null;
  const bulletCountsBefore = new Map();
  (state.tailoredResume?.experience || []).forEach(exp => {
    if (exp.company) bulletCountsBefore.set(`exp:${exp.company}`, (exp.bullets || []).length);
  });
  (state.tailoredResume?.projects || []).forEach(proj => {
    if (proj.name) bulletCountsBefore.set(`proj:${proj.name}`, (proj.bullets || []).length);
  });

  const { row: t, stop: stopThinking } = pushCyclingThinkingMessage([
    'Reviewing what you told me…',
    'Updating your resume…',
    'Weaving in your experience…',
    'Adding it to your bullets…'
  ]);

  let skillsOnlyFailed = false;
  let skillsOnlyError = null;

  // 1) Familiar → Skills section, regardless of what kind the requirement is.
  if (skillsOnly.length) {
    const list = skillsOnly.map(s => s.skill).join(', ');
    const res = await send('CHAT_EDIT', {
      instruction: `Add these skills to the Skills section only: ${list}. Do NOT modify experience or projects.`,
      tailoredResume: state.tailoredResume, jobDescription: state.jd,
      requiredSkills: skillsOnly.map(s => s.skill)
    });
    if (!res.error) { state.tailoredResume = res.tailored; state.pdfBase64 = res.pdfBase64; }
    else { skillsOnlyFailed = true; skillsOnlyError = res.message || res.error; }
  }

  // 2) Placed into a specific role/project — batched by target. Technical
  // items still also go into Skills; experience items go into a bullet only.
  const byTarget = {};
  placements.forEach(p => { (byTarget[p.target] ||= []).push(p); });

  // Track which TARGETS failed, not a single blanket flag — one bad edit
  // among several targets shouldn't cost the ones that succeeded their
  // coverage update, profile save, or session tracking.
  const failedTargets = new Set();
  let lastError = null;

  for (const [target, group] of Object.entries(byTarget)) {
    const tools       = group.filter(g => (state.missingKinds?.[g.skill] || 'technical') === 'technical');
    const engagements = group.filter(g => (state.missingKinds?.[g.skill] || 'technical') !== 'technical');

    let instruction = `The candidate confirms the following about their work at/on "${target}".\n\n`;
    if (tools.length) {
      instruction +=
        `TECHNOLOGIES THEY USED: ${tools.map(t => t.skill).join(', ')}\n` +
        `Surface these in the bullets under "${target}", distributed where they fit best — ` +
        `do not cram them into one bullet. Also add them to the Skills section.\n\n`;
    }
    if (engagements.length) {
      instruction +=
        `WORK THEY DID: ${engagements.map(e => e.skill).join('; ')}\n` +
        `ADD one new bullet under "${target}" to reflect this work in the candidate's own register. ` +
        `DO NOT modify, remove, or rewrite any of the existing bullets under "${target}" — only append the new one. ` +
        `Do NOT add these to the Skills section.\n\n`;
    }
    instruction +=
      `Do NOT invent metrics, outcomes, dates, or scope — write down only what they told you. ` +
      `Change nothing outside "${target}"${tools.length ? ' and the Skills section' : ''}.`;

    const res = await send('CHAT_EDIT', {
      instruction, tailoredResume: state.tailoredResume, jobDescription: state.jd,
      requiredSkills: group.map(g => g.skill)
    });
    if (!res.error) {
      // Independent re-check: did THIS target's original bullets survive?
      // A confirmed incident showed placing one skill delete all four
      // original bullets of an entry and come back without any error.
      if (entryLooksReplaced(resumeBeforeThisRound, res.tailored, target)) {
        failedTargets.add(target);
        lastError = `the update for "${target}" would have deleted your existing bullets there instead of adding to them, so I didn't apply it.`;
      } else {
        state.tailoredResume = res.tailored; state.pdfBase64 = res.pdfBase64;
      }
    }
    else { failedTargets.add(target); lastError = res.message || res.error; }
  }

  stopThinking();
  t?.remove();

  // Partition into what actually succeeded vs. what didn't — a skill only
  // counts as failed if ITS specific target failed, not because some other,
  // unrelated target in the same batch had a problem.
  const successfulPlacements = placements.filter(p => !failedTargets.has(p.target));
  const failedPlacements = placements.filter(p => failedTargets.has(p.target));
  const successfulSkillsOnly = skillsOnlyFailed ? [] : skillsOnly;

  if (!successfulSkillsOnly.length && !successfulPlacements.length && !declined.length) {
    // Nothing succeeded at all — the one message that covers everything.
    pushAssistantMessage(`Couldn't finish adding those skills: ${lastError || skillsOnlyError}`);
    updateQuickActions([]); // re-enable the buttons locked at the top of this function
    return;
  }

  // Declined items never touch the resume or the skill profile — they're
  // an honest "I don't have this," not a claim of any kind. Only the
  // SUCCESSFUL skills/placements count here — a failed target's skills
  // never touched the resume, so they can't be marked covered or saved.
  const all = [...successfulSkillsOnly, ...declined, ...successfulPlacements];
  successfulSkillsOnly.forEach(p => send('SAVE_SKILL_TO_PROFILE', { skill: p.skill }));
  successfulPlacements
    .filter(p => (state.missingKinds?.[p.skill] || 'technical') === 'technical')
    .forEach(p => send('SAVE_SKILL_TO_PROFILE', { skill: p.skill }));
  send('SESSION_ADD_SKILLS', { skills: all });
  state.skillsAddedThisJob = (state.skillsAddedThisJob || 0) + all.length;
  state.placedSkills = [...(state.placedSkills || []), ...successfulPlacements.map(p => p.skill)];
  state.listedOnlySkills = [...(state.listedOnlySkills || []), ...successfulSkillsOnly.map(s => s.skill)];

  // Await this specifically — the user may navigate away the instant they
  // see the confirmation message below, and a fire-and-forget save here
  // could be silently cut short by that navigation, leaving the next page
  // to load a session that never received this update. This is exactly
  // what caused already-added skills to reappear as missing after Apply.
  await saveWork();

  // Short, plain confirmation — no long explainer, just what happened.
  // A partial failure is reported honestly alongside the real successes,
  // rather than either hiding it or letting it blank out what did work.
  const parts = [];
  if (successfulSkillsOnly.length || successfulPlacements.length) {
    const closedNames = [...successfulSkillsOnly, ...successfulPlacements].map(s => s.skill).join(', ');
    parts.push(`Added: ${closedNames}.`);
  }
  if (declined.length) {
    parts.push(`Marked as not used: ${declined.map(d => d.skill).join(', ')}.`);
  }
  if (skillsOnlyFailed) {
    parts.push(`Couldn't add ${skillsOnly.map(s => s.skill).join(', ')} to Skills: ${skillsOnlyError}`);
  }
  if (failedPlacements.length) {
    parts.push(`Couldn't add ${failedPlacements.map(p => p.skill).join(', ')}: ${lastError}`);
  }
  const confirmMsg = parts.join(' ');

  // Recompute the score LOCALLY — no AI call, so it's free, instant, and the
  // checklist size never changes.
  const closedSkills = [...successfulSkillsOnly, ...successfulPlacements];
  const declinedLabels = declined.map(d => d.skill);
  const localUpdate = (closedSkills.length || declinedLabels.length)
    ? applyLocalCoverageUpdate(closedSkills.map(a => a.skill), declinedLabels)
    : null;

  if (localUpdate !== null) {
    const { score: newScore, total, covered, declinedCount } = localUpdate;
    let line;
    if (newScore >= 100) {
      line = `Score: ${newScore}. You cover everything this job states.`;
    } else if (declinedCount > 0 && declinedCount === total - covered) {
      // Every remaining gap is one the user explicitly said they don't have —
      // that's not a shortfall, that's a fully honest answer.
      line = `Score: ${newScore}. You've covered everything you have — the rest (${declinedCount}) you've told us you don't have. That's honest, not a gap.`;
    } else if (declinedCount > 0) {
      line = `Score: ${newScore}. ${total - covered - declinedCount} left to review, ${declinedCount} you've said you don't have.`;
    } else {
      line = `Score: ${newScore}. ${total - covered} missing.`;
    }
    pushAssistantMessage(`${confirmMsg}\n\n${line}`);
  } else if (closedSkills.length) {
    show('btn-reevaluate');
    pushAssistantMessage(`${confirmMsg}\n\nTap ↻ Re-evaluate to see your updated score.`);
  } else if (confirmMsg) {
    pushAssistantMessage(confirmMsg);
  }

  if (successfulSkillsOnly.length) offerLearningResources(successfulSkillsOnly.map(s => s.skill));

  // Proactive "this got longer, here's why, want it shorter?" — rather than
  // a button buried in the quick-actions row that the user has to go find
  // on their own. Fires right where the growth happened, naming exactly
  // which skills caused it and exactly which entry to offer a fix for.
  announceBulletGrowth(successfulPlacements, bulletCountsBefore);

  updateQuickActions([]); // re-enable the buttons locked at the top of this function
}

// GROWTH_FLAG_THRESHOLD: how many NET NEW bullets on one entry is worth
// proactively flagging. 2 is deliberately low — even going from 3 to 5
// bullets (common after placing 3-4 skills into one role) is exactly the
// "content got stuffed in" case described, and the message is framed as a
// helpful heads-up with a one-tap fix, not an alarm — so erring toward
// flagging more often, not less, costs little.
const GROWTH_FLAG_THRESHOLD = 2;

function announceBulletGrowth(successfulPlacements, bulletCountsBefore) {
  if (!successfulPlacements.length || !state.tailoredResume) return;

  // Group the skills that landed in each target, and look up that entry's
  // CURRENT bullet count against its snapshot from before this round.
  const byTarget = {};
  successfulPlacements.forEach(p => { (byTarget[p.target] ||= []).push(p.skill); });

  const grown = [];
  for (const [target, skills] of Object.entries(byTarget)) {
    const exp = (state.tailoredResume.experience || []).find(e => e.company === target);
    const proj = !exp ? (state.tailoredResume.projects || []).find(p => p.name === target) : null;
    const entry = exp || proj;
    if (!entry) continue;

    const key = exp ? `exp:${target}` : `proj:${target}`;
    const before = bulletCountsBefore.get(key);
    const after = (entry.bullets || []).length;
    if (before === undefined) continue;
    const delta = after - before;
    if (delta < GROWTH_FLAG_THRESHOLD) continue;

    grown.push({ target, label: exp ? `${entry.title || 'Role'} at ${target}` : target, kind: exp ? 'experience' : 'project', skills, before, after, delta });
  }

  if (!grown.length) return;

  // One message per grown entry, each with its own "Shorten it" action —
  // multiple entries can grow in the same placement round (e.g. skills
  // spread across 3-4 roles), and each deserves its own clear explanation
  // rather than one combined paragraph naming everything at once.
  grown.forEach(g => {
    const skillList = g.skills.length > 1 ? `${g.skills.slice(0, -1).join(', ')} and ${g.skills[g.skills.length - 1]}` : g.skills[0];
    const msg =
      `📌 **${g.label}** grew from ${g.before} to ${g.after} points — ` +
      `that's because I wove in ${skillList} there, as you asked. ` +
      `If you'd rather keep it tighter, I can condense it back down without losing any of it.`;
    pushAssistantMessageWithAction(
      msg,
      'Shorten it',
      () => {
        // Condense back toward the original count, not all the way below
        // it — floor at g.before, since going below what the resume had
        // BEFORE this placement round would start deleting pre-existing
        // content the user never asked to touch. One fewer than current
        // is a meaningful trim without being an aggressive single-click cut.
        const floorCount = Math.max(1, g.before);
        const startTarget = Math.max(floorCount, g.after - 1);
        const subject = g.kind === 'experience' ? `the experience entry "${g.label}"` : `the project "${g.label}"`;
        executeCondenseEdit({
          buildInstruction: (n) => `Condense ${subject} from its current ${g.after} bullets down to exactly ${n} bullets. Every skill, tool, and achievement currently mentioned anywhere in those ${g.after} bullets must still appear somewhere in the ${n} result — combine 2-3 related original bullets into one denser bullet rather than dropping any of them. Never state the same point twice. Do not touch any other section or entry — their bullets must come back byte-for-byte identical to how they are now.`,
          confirmationLabel: (n) => `Condensed **${g.label}** to ${n} points, everything kept. Download updated PDF. ↓`,
          targetCount: startTarget,
          floorCount,
          entryLabel: `**${g.label}**`,
          kind: g.kind,
          preserveAllContent: true,
          skillsToVerify: g.skills,
          entryRef: { kind: g.kind, name: g.target },
          fromCount: g.after
        });
      }
    );
  });
}

// Flip exactly the requirements the user just confirmed to "covered", and
// recompute score/missing locally — no AI call. Returns the new score, or
// null if nothing could be matched (caller falls back to a real re-evaluate).
function applyLocalCoverageUpdate(confirmedSkillLabels, declinedSkillLabels = []) {
  const ats = state.atsAnalysis;
  if (!ats || !Array.isArray(ats.requirements) || !ats.requirements.length) return null;

  const norm = s => String(s).toLowerCase().trim();
  const confirmedText = new Set(confirmedSkillLabels.map(norm));
  const declinedText = new Set(declinedSkillLabels.map(norm));
  // Translate each confirmed chip label to its stable id via the lookup
  // built when the chips were rendered. This is the primary match — it
  // can't drift, because both sides came from the same render.
  const idMap = state.skillIdByKw || {};
  const confirmedIds = new Set(
    confirmedSkillLabels.map(kw => idMap[kw]).filter(id => id !== null && id !== undefined)
  );
  const declinedIds = new Set(
    declinedSkillLabels.map(kw => idMap[kw]).filter(id => id !== null && id !== undefined)
  );

  let matchedAny = false;
  const updatedReqs = ats.requirements.map(r => {
    if (r.covered === true) return r;
    const matchesById = r.id !== null && r.id !== undefined && confirmedIds.has(r.id);
    const matchesByText = confirmedText.has(norm(r.requirement));
    if (matchesById || matchesByText) { matchedAny = true; return { ...r, covered: true }; }
    // Declined: never covered, but tagged so the score message can credit
    // the honesty instead of treating it the same as an unreviewed gap.
    const declinedById = r.id !== null && r.id !== undefined && declinedIds.has(r.id);
    const declinedByText = declinedText.has(norm(r.requirement));
    if (declinedById || declinedByText) { matchedAny = true; return { ...r, declined: true }; }
    return r;
  });
  if (!matchedAny) return null;

  const total = updatedReqs.length;
  const covered = updatedReqs.filter(r => r.covered === true).length;
  const score = total > 0 ? Math.round((covered / total) * 100) : ats.score;
  const declinedCount = updatedReqs.filter(r => r.covered !== true && r.declined === true).length;

  const missing = updatedReqs
    .filter(r => r.covered !== true)
    .map(r => ({ skill: r.requirement, kind: r.kind, id: r.id, declined: r.declined === true }));

  // Bug 1 fix: also remove confirmed/declined bonus skills from bonus_requirements
  // so their chips don't re-render after being added (e.g. "Credibility With Engineers")
  const updatedBonus = (ats.bonus_requirements || []).filter(b => {
    const bNorm = norm(b.skill || b);
    const bId = b.id !== null && b.id !== undefined ? b.id : null;
    const confirmedByText = confirmedText.has(bNorm);
    const confirmedById = bId !== null && confirmedIds.has(bId);
    const declinedByText = declinedText.has(bNorm);
    const declinedById = bId !== null && declinedIds.has(bId);
    return !confirmedByText && !confirmedById && !declinedByText && !declinedById;
  });

  state.atsAnalysis = {
    ...ats,
    requirements: updatedReqs,
    total_requirements: total,
    covered_requirements: covered,
    score,
    missing_requirements: missing,
    bonus_requirements: updatedBonus
  };

  renderAtsResultOnly(state.atsAnalysis);
  return { score, total, covered, declinedCount };
}

// Show every skill at once, each with a dropdown of the user's real roles and
// projects. One pass, one submit — no interrogation loop.
function askBulkPlacement(skills) {
  return new Promise(resolve => {
    const msgs = $('chat-messages');
    if (!msgs) { resolve(null); return; }

    pushAssistantMessage(`Where have you used these? Pick a role, or mark familiar/unused.`);

    const roles    = (state.tailoredResume?.experience || []).map(e => e.company).filter(Boolean);
    const projects = (state.tailoredResume?.projects   || []).map(p => p.name).filter(Boolean);

    const card = document.createElement('div');
    card.style.cssText = 'margin:6px 0 10px 40px;padding:12px;background:#f8faff;border:1px solid #c7d7fe;border-radius:10px;';

    const rows = skills.map(skill => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:7px;';

      const label = document.createElement('span');
      label.textContent = skill;
      label.style.cssText = 'flex:1;font-size:11.5px;font-weight:600;color:#1e3a8a;';

      const sel = document.createElement('select');
      sel.style.cssText = 'font-family:inherit;font-size:10.5px;padding:4px 6px;border:1px solid #c7d7fe;border-radius:6px;background:white;color:#1e3a8a;outline:none;max-width:190px;';

      // "Familiar" is the DEFAULT now: the user tapped "+" on this skill (or
      // "Add all") specifically because they recognize it as something they
      // have. Defaulting to "don't know it" punished the common path — every
      // skill left untouched in a bulk "Add all" silently got declined and
      // never reached the resume, which is backwards from what tapping "+"
      // meant in the first place. "Don't know it" is still one click away
      // for the genuine exceptions.
      const familiarOpt = document.createElement('option');
      familiarOpt.value = '__familiar__';
      familiarOpt.textContent = '📋 Familiar — add to Skills';
      sel.appendChild(familiarOpt);

      const dontKnowOpt = document.createElement('option');
      dontKnowOpt.value = '__dont_know__';
      dontKnowOpt.textContent = "🙅 Haven't used this / don't know it";
      sel.appendChild(dontKnowOpt);

      roles.forEach(r => {
        const o = document.createElement('option');
        o.value = `exp:${r}`; o.textContent = `💼 ${r}`;
        sel.appendChild(o);
      });
      projects.forEach(p => {
        const o = document.createElement('option');
        o.value = `proj:${p}`; o.textContent = `🛠 ${p}`;
        sel.appendChild(o);
      });
      row.appendChild(label); row.appendChild(sel);
      card.appendChild(row);
      return { skill, sel };
    });

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;margin-top:10px;';

    const applyBtn = document.createElement('button');
    applyBtn.className = 'quick-action-btn';
    applyBtn.textContent = `✓ Add ${skills.length} skill${skills.length > 1 ? 's' : ''}`;

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'quick-action-btn';
    cancelBtn.textContent = '✕ Cancel';

    btnRow.appendChild(applyBtn); btnRow.appendChild(cancelBtn);
    card.appendChild(btnRow);
    msgs.appendChild(card);
    msgs.scrollTop = msgs.scrollHeight;

    const finish = (result) => {
      card.querySelectorAll('select, button').forEach(el => el.disabled = true);
      applyBtn.style.opacity = '0.5'; cancelBtn.style.opacity = '0.5';
      resolve(result);
    };

    applyBtn.addEventListener('click', () => {
      const out = [];
      rows.forEach(({ skill, sel }) => {
        const v = sel.value;
        if (v === '__dont_know__') out.push({ skill, target: null, targetType: 'declined' });
        else if (v === '__familiar__') out.push({ skill, target: 'Skills', targetType: 'skills' });
        else if (v.startsWith('exp:'))  out.push({ skill, target: v.slice(4), targetType: 'experience' });
        else if (v.startsWith('proj:')) out.push({ skill, target: v.slice(5), targetType: 'project' });
      });
      const placedCount = out.filter(o => o.targetType === 'experience' || o.targetType === 'project').length;
      pushUserMessage(`${out.length} skill${out.length !== 1 ? 's' : ''} reviewed${placedCount ? ` (${placedCount} placed)` : ''}`);
      finish(out);
    });

    cancelBtn.addEventListener('click', () => { pushUserMessage('Cancelled'); finish(null); });
  });
}

// Learning resources for skills the user listed as "familiar" only.
const LEARNING_RESOURCES = {
  'kubernetes':   'https://kubernetes.io/docs/tutorials/',
  'docker':       'https://docs.docker.com/get-started/',
  'rust':         'https://doc.rust-lang.org/book/',
  'graphql':      'https://graphql.org/learn/',
  'ruby on rails':'https://guides.rubyonrails.org/getting_started.html',
  'pytorch':      'https://pytorch.org/tutorials/',
  'tensorflow':   'https://www.tensorflow.org/tutorials',
  'langchain':    'https://python.langchain.com/docs/tutorials/',
  'langgraph':    'https://langchain-ai.github.io/langgraph/tutorials/',
  'terraform':    'https://developer.hashicorp.com/terraform/tutorials',
  'kafka':        'https://kafka.apache.org/quickstart',
  'spark':        'https://spark.apache.org/docs/latest/quick-start.html',
  'elasticsearch':'https://www.elastic.co/guide/en/elasticsearch/reference/current/quickstart.html',
  'vllm':         'https://docs.vllm.ai/en/latest/getting_started/quickstart.html',
};

function resourceFor(skill) {
  const k = skill.toLowerCase().trim();
  for (const [name, url] of Object.entries(LEARNING_RESOURCES)) {
    if (k.includes(name) || name.includes(k)) return url;
  }
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(skill + ' tutorial')}`;
}

function offerLearningResources(skills) {
  const lines = skills.slice(0, 5).map(s => `• **${s}** — [learn it](${resourceFor(s)})`).join('\n');
  pushAssistantMessage(`Worth brushing up before the interview:\n\n${lines}`);
}

function extractKeyword(description) {
  let s = description.trim();

  // Strip diagnostic qualifiers after a dash
  s = s.replace(/\s*[-–—]\s*(no evidence|only mentions|not demonstrated|limited evidence|not shown|needs improvement).*/i, '');

  // Strip experience-level prefixes but only if something meaningful remains
  const withoutYears = s.replace(/^\d+\+?\s+years?\s+(of\s+)?(production\s+)?/i, '').trim();
  if (withoutYears.length >= 4) s = withoutYears;
  const withoutExpWith = s.replace(/^(hands-?on\s+)?(experience\s+with|knowledge\s+of|proficiency\s+in|familiarity\s+with|understanding\s+of)\s+/i, '').trim();
  if (withoutExpWith.length >= 4) s = withoutExpWith;

  // Cut after "or" / "and" only if the first part is at least 2 words
  const beforeOr = s.replace(/\s+(or|and)\s+.*/i, '').trim();
  if (beforeOr.split(/\s+/).length >= 2) s = beforeOr;

  // Remove parenthetical
  s = s.replace(/\s*\(.*\)/, '');

  // Strip trailing filler nouns
  s = s.replace(/\s+(framework|system|tool|platform|experience|skills?|infrastructure|architecture|design|implementation|engineering|concepts?|fundamentals?|principles?)s?$/i, '').trim();

  // If longer than 5 words, take first 3
  const words = s.split(/\s+/);
  if (words.length > 5) s = words.slice(0, 3).join(' ');

  // Title-case (preserve existing uppercase like ML, API, etc.)
  return s.split(/(\s+|\/|-)/).map(w => /^[a-z]/.test(w) ? w.charAt(0).toUpperCase() + w.slice(1) : w).join('');
}

$('btn-fab-evaluate')?.addEventListener('click', async () => {
  const btn = $('btn-fab-evaluate');
  // Always use the STABLE cached JD for this job fingerprint so the same job
  // always evaluates against the same JD text (consistent scores). Fall back
  // through active session → last → in-memory only if no cached version exists.
  // The session's JD is authoritative for the whole application journey.
  // Each page renders the posting differently — LinkedIn shows it in full, a
  // company careers page often abridges it — so evaluating whatever text the
  // current page happens to show scores the same job differently on every hop.
  // The session's JD is now LOCKED at first capture (see cacheJD) — it is
  // THE single source for every page in this journey, full stop, until the
  // user selects a different job back on the listing. state.jd (already in
  // memory) is the only real fallback, for the narrow race where this page's
  // own storage write hasn't landed yet.
  const recovered = await send('GET_STORAGE', { keys: ['rpSession'] });
  const sess = recovered?.rpSession;
  const MIN_JD_LEN = 150;
  const sessionUsable = sess?.jd && sess.jd.trim().length >= MIN_JD_LEN && !sess.applied && (Date.now() - (sess.ts || 0)) < 90 * 60 * 1000;

  let jd = sessionUsable ? sess.jd : (state.jd || null);
  // Never regress below what THIS page already has in memory. state.jd was
  // just set moments ago by a confirmed JD_DETECTED — trust it over a stale
  // or thinner storage read.
  if (state.jd && state.jd.trim().length > (jd?.trim().length || 0)) jd = state.jd;
  if (jd) state.jd = jd;

  if (!jd || jd.trim().length < 20) {
    showError('No job description detected. Open a job posting first, then evaluate.');
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  show('eval-progress-area');
  startGlow();
  const stopProgress = startCyclingProgress([
    'Reading requirements…',
    'Checking your skills…',
    'Comparing experience…',
    'Scoring coverage…'
  ], 1600, EVAL_PROGRESS_IDS);
  const res = await evaluateOrReuse(jd);
  stopProgress();
  stopGlow();
  hide('eval-progress-area');
  if (res.error) { showError(res.message || res.error); if (btn) { btn.disabled = false; btn.textContent = '✦ Evaluate'; } return; }
  state.atsAnalysis = res.ats_analysis;
  // The AI read the role and company out of the JD — hand them to the session
  // so the tracker records the real job, not whatever the page header said.
  if (res.ats_analysis?.job_title || res.ats_analysis?.company) {
    send('SESSION_CONFIRM_IDENTITY', { jobTitle: res.ats_analysis.job_title, company: res.ats_analysis.company });
  }
  // Charge per JOB, not per page. LinkedIn and the application page have
  // different URL fingerprints but are the same job — the session id is what
  // identifies it. And a reused (cached) result never costs anything.
  const jobKey = state.session?.sessionId || state.fingerprint;
  const alreadyEvaluated = state.atsEvaluatedJobs?.includes(jobKey);
  if (!alreadyEvaluated && !res.reused) {
    state.atsUsed = (state.atsUsed || 0) + 1;
    if (!state.atsEvaluatedJobs) state.atsEvaluatedJobs = [];
    state.atsEvaluatedJobs.push(jobKey);
    await send('SET_STORAGE', { data: { atsUsageCount: state.atsUsed, atsEvaluatedJobs: state.atsEvaluatedJobs } });
  }
  state.skillsAddedSinceEval = 0; hide('btn-reevaluate');
  showAtsResult(res.ats_analysis);
  saveWork();
  if (btn) { btn.disabled = false; btn.textContent = '✦ Evaluate'; }
});

$('btn-reevaluate')?.addEventListener('click', async () => {
  const btn = $('btn-reevaluate');
  // Same stable-JD logic as evaluate — re-evaluating the same job must use
  // the same JD text so only the resume changes affect the score.
  // The session's JD is authoritative for the whole application journey.
  // Each page renders the posting differently — LinkedIn shows it in full, a
  // company careers page often abridges it — so evaluating whatever text the
  // current page happens to show scores the same job differently on every hop.
  // The session's JD is now LOCKED at first capture (see cacheJD) — it is
  // THE single source for every page in this journey, full stop, until the
  // user selects a different job back on the listing. state.jd (already in
  // memory) is the only real fallback, for the narrow race where this page's
  // own storage write hasn't landed yet.
  const recovered = await send('GET_STORAGE', { keys: ['rpSession'] });
  const sess = recovered?.rpSession;
  const MIN_JD_LEN = 150;
  const sessionUsable = sess?.jd && sess.jd.trim().length >= MIN_JD_LEN && !sess.applied && (Date.now() - (sess.ts || 0)) < 90 * 60 * 1000;

  let jd = sessionUsable ? sess.jd : (state.jd || null);
  // Never regress below what THIS page already has in memory. state.jd was
  // just set moments ago by a confirmed JD_DETECTED — trust it over a stale
  // or thinner storage read.
  if (state.jd && state.jd.trim().length > (jd?.trim().length || 0)) jd = state.jd;
  if (jd) state.jd = jd;

  if (!jd || jd.trim().length < 20) { showError('No job description available to re-evaluate.'); return; }
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  show('eval-progress-area');
  startGlow();
  const stopProgress = startCyclingProgress([
    'Reading requirements…',
    'Checking your skills…',
    'Comparing experience…',
    'Scoring coverage…'
  ], 1600, EVAL_PROGRESS_IDS);
  const res = await evaluateOrReuse(jd);
  stopProgress();
  stopGlow();
  hide('eval-progress-area');
  if (!res.error) { state.atsAnalysis = res.ats_analysis; state.skillsAddedSinceEval = 0; showAtsResult(res.ats_analysis); saveWork(); }
  hide('btn-reevaluate');
  if (btn) { btn.disabled = false; btn.textContent = '↻ Re-evaluate'; }
});

// ── Chatbot ───────────────────────────────────────────────────────────────
// No more tab system — chatbot column is always visible.
// Called once during init(), but quick actions are refreshed independently.

function initChatbot() {
  const msgs = $('chat-messages');
  if (!msgs) return;

  if (msgs.children.length === 0) {
    const userName = state.resumeData?.name?.split(' ')[0] || 'there';
    const history = state.session?.chatHistory || [];

    // Restore the conversation from the session — same chat across every page
    // of the application journey (LinkedIn → careers → ATS form).
    if (history.length) {
      history.forEach(m => {
        if (!m || typeof m.text !== 'string') return; // skip a malformed entry rather than losing the rest
        if (m.role === 'user') pushUserMessage(m.text, true);
        else pushAssistantMessage(m.text, [], true);
      });
      if (state.session?.applied) {
        addAppliedBanner(state.session.company, state.session.appliedAt);
      } else if (state.jdSource !== 'page') {
        const t = state.session?.jobTitle;
        // The chat history is built incrementally, message by message, as
        // the conversation happens — it can't get "stuck" the way a single
        // stored field can. If the session's jobTitle doesn't appear
        // anywhere in the conversation we just restored, that's a strong
        // signal it's stale from some earlier job, not this one. Rather than
        // confidently state a title the conversation itself contradicts,
        // fall back to the generic message.
        const historyText = history.map(m => m.text || '').join(' ');
        const titleMatchesHistory = t && historyText.includes(t);
        const known = t && t !== 'Unknown Role' && t !== 'this role' && titleMatchesHistory;
        pushAssistantMessage(
          known
            ? `_Continuing where you left off — still working on **${t}**._`
            : `_Continuing where you left off — using the job description from the listing you came from._`,
          [], true);
      }
    } else if (state.archived?.applied && state.archived.jobTitle && state.archived.company
               && state.archived.jobTitle !== 'Unknown Role' && state.archived.company !== 'Unknown Company') {
      // Returning to a job you already applied to (e.g. back on LinkedIn).
      addAppliedBanner(state.archived.company, state.archived.appliedAt);
      pushAssistantMessage(`You already applied to **${state.archived.jobTitle}** at **${state.archived.company}**. Want to tailor for a different role?`);
    } else if (state.tailoredResume) {
      pushAssistantMessage(`Hi ${userName}! Resume ready. Ask me to change anything, or check your match score on the left.`);
    } else if (state.jd) {
      pushAssistantMessage(`Hi ${userName}! Job detected. Tap ⚡ on the left to tailor your resume, then I can help refine it.`);
    } else {
      pushAssistantMessage(`Hi ${userName}! Navigate to a job listing — I'll help you tailor your resume and spot skill gaps.`);
    }
  }
  updateQuickActions([]);
}

function addAppliedBanner(company, appliedAt) {
  const msgs = $('chat-messages');
  if (!msgs) return;
  const when = appliedAt ? new Date(appliedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  const div = document.createElement('div');
  div.style.cssText = 'margin:8px 0;padding:8px 12px;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:8px;font-size:11.5px;color:#065f46;font-weight:600;text-align:center;';
  div.textContent = `✓ Applied to ${company || 'this job'}${when ? ` on ${when}` : ''}`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

const userInitials = () => {
  const name = state.resumeData?.name || state.userName || '';
  const parts = name.trim().split(/\s+/);
  return parts.length >= 2 ? (parts[0][0] + parts[parts.length-1][0]).toUpperCase() : (parts[0]?.[0] || '?').toUpperCase();
};

// Same bubble as pushAssistantMessage, with one small inline action button
// inside it. Used for proactive, actionable heads-ups (e.g. "this section
// grew, want it shorter?") where the fix should be one tap away in the
// conversation itself, not a separate quick-action button the user has to
// go find in the row below the resume.
function pushAssistantMessageWithAction(text, actionLabel, onAction) {
  const msgs = $('chat-messages');
  if (!msgs) return;
  state.rendered = (state.rendered || 0) + 1;
  send('SESSION_APPEND_CHAT', { message: { role: 'assistant', text, ts: Date.now() } });
  const html = text
    .replace(/</g, '&lt;')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
  const row = document.createElement('div');
  row.className = 'chat-msg-row';
  const safeLabel = String(actionLabel || '').replace(/</g, '&lt;');
  row.innerHTML = `<div class="chat-avatar bot">✦</div><div class="chat-bubble assistant">${html}<div style="margin-top:8px;"><button class="chat-inline-action-btn" style="padding:6px 12px;font-size:12px;font-weight:600;border:1px solid #c7d7fe;border-radius:7px;background:#f8faff;color:#1e3a8a;cursor:pointer;font-family:inherit;">${safeLabel}</button></div></div>`;
  msgs.appendChild(row);
  msgs.scrollTop = msgs.scrollHeight;

  const btn = row.querySelector('.chat-inline-action-btn');
  btn?.addEventListener('click', () => {
    btn.disabled = true;
    btn.textContent = 'Working on it…';
    btn.style.opacity = '0.6';
    btn.style.cursor = 'default';
    onAction();
  });
}

function pushAssistantMessage(text, skillsToAdd = [], skipPersist = false) {
  const msgs = $('chat-messages');
  if (!msgs) return;
  // Count every message this panel has rendered. Focus-sync replays anything
  // the session has beyond this count; without it we'd replay what's on screen.
  state.rendered = (state.rendered || 0) + 1;
  if (!skipPersist) send('SESSION_APPEND_CHAT', { message: { role: 'assistant', text, ts: Date.now() } });
  const html = text
    .replace(/</g, '&lt;')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    // [label](url) → a real anchor. Without this, a raw URL (e.g. a long
    // YouTube search link) rendered as plain text — one unbroken "word" the
    // browser can't wrap — and overflowed the bubble's fixed width.
    //
    // The URL group used to stop at the first ")" ([^\s)]+), which truncates
    // any URL that legitimately contains one — including our own YouTube
    // search links once the query has certain punctuation. Match balanced
    // parens one level deep (URL may contain "(...)" itself) so the link
    // closes only at the ")" that actually matches the opening "(".
    .replace(/\[([^\]]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\n/g, '<br>');
  const row = document.createElement('div');
  row.className = 'chat-msg-row';
  row.innerHTML = `<div class="chat-avatar bot">✦</div><div class="chat-bubble assistant">${html}</div>`;
  msgs.appendChild(row);
  msgs.scrollTop = msgs.scrollHeight;
  if (skillsToAdd.length > 0) updateQuickActions(skillsToAdd);
}

function pushUserMessage(text, skipPersist = false) {
  const msgs = $('chat-messages');
  if (!msgs) return;
  state.rendered = (state.rendered || 0) + 1;
  if (!skipPersist) send('SESSION_APPEND_CHAT', { message: { role: 'user', text, ts: Date.now() } });
  const row = document.createElement('div');
  row.className = 'chat-msg-row user-row';
  row.innerHTML = `<div class="chat-avatar user">${userInitials()}</div><div class="chat-bubble user">${text.replace(/</g,'&lt;')}</div>`;
  msgs.appendChild(row);
  msgs.scrollTop = msgs.scrollHeight;
}

function pushThinkingMessage() {
  const msgs = $('chat-messages');
  if (!msgs) return null;
  const row = document.createElement('div');
  row.className = 'chat-msg-row';
  row.innerHTML = `<div class="chat-avatar bot">✦</div><div class="chat-bubble thinking">Thinking…</div>`;
  msgs.appendChild(row);
  msgs.scrollTop = msgs.scrollHeight;
  startGlow();
  return row;
}

// Paired with pushThinkingMessage — removes the row and stops the glow
// together, so the two can never drift out of sync.
function removeThinkingMessage(row) {
  row?.remove();
  stopGlow();
}

// Same bubble, but cycles through stage text on a timer instead of sitting on
// a static "Thinking…". Placing several skills can mean multiple sequential
// AI calls (one per role they're attributed to, plus one for skills-only
// items), which genuinely takes a while — a static message reads as stuck.
// Returns { row, stop } — call stop() before removing the row.
function pushCyclingThinkingMessage(stages, intervalMs = 1800) {
  const row = pushThinkingMessage();
  if (!row) return { row: null, stop: () => {} };
  const bubble = row.querySelector('.chat-bubble');
  let tick = 0;
  let stopped = false;
  if (bubble) bubble.textContent = stages[0];
  function scheduleNext() {
    const delay = tick < stages.length ? intervalMs : intervalMs * 2;
    setTimeout(() => {
      if (stopped) return;
      tick++;
      const text = tick < stages.length
        ? stages[tick]
        : STILL_WORKING_POOL[(tick - stages.length) % STILL_WORKING_POOL.length];
      if (bubble) bubble.textContent = text;
      const msgs = $('chat-messages');
      if (msgs) msgs.scrollTop = msgs.scrollHeight;
      scheduleNext();
    }, delay);
  }
  scheduleNext();
  return { row, stop: () => { stopped = true; stopGlow(); } };
}

// ── Job title extraction ──────────────────────────────────────────────────
const NOT_A_JOB_TITLE = /^(see all|view all|back to|all jobs|browse|search|apply now|apply|share|save|print|home|careers?|jobs?|menu|skip to|sign in|log ?in|register|about us|contact|overview|benefits|culture|life at|our team|who we are|join us|welcome|posted|similar jobs|related jobs|show more|read more|learn more)\b/i;
const JOB_TITLE_HINT = /\b(engineer|developer|scientist|analyst|manager|director|architect|designer|consultant|specialist|lead|principal|senior|staff|associate|intern|coordinator|administrator|technician|researcher|strategist|officer|president|head of|vp|advocate|evangelist|writer|recruiter|producer)\b/i;
// LinkedIn job-card badges ("Verified job", "Actively hiring", "Promoted")
// appear inline on job cards — including sidebar "similar jobs" suggestion
// cards. A real job title never contains one. Same check as detector.js's
// copy of this logic — kept in sync since this file can't share code with it.
const HAS_JOB_CARD_BADGE = /\((verified job|actively hiring|actively recruiting|promoted|easy apply)\)/i;
// Same section-header detection as detector.js's copy — catches "Key
// Responsibilities", "What We Are Looking For", "Who You Are" etc., not
// just exact phrase matches. Kept in sync since this file can't share code.
function looksLikeSectionHeader(line) {
  const t = line.trim();
  if (/:\s*$/.test(t)) return true;
  if (/^(position overview|about the role|about this role|what you.?ll do|responsibilities|requirements|qualifications|the role|summary|job summary|about the team|about us)\s*:?\s*$/i.test(t)) return true;
  if (t.length <= 45 && !JOB_TITLE_HINT.test(t) &&
      /\b(responsibilit(y|ies)|requirements?|qualifications?|what (you|we)|who you are|about (the|this)|overview|benefits|day.?to.?day)\b/i.test(t)) {
    return true;
  }
  return false;
}

function extractJobTitle(jdText) {
  if (!jdText) return 'this role';
  const lines = jdText.split('\n').map(l => l.trim()).filter(Boolean);

  const plausible = lines.slice(0, 20).filter(line =>
    line.length >= 6 && line.length <= 90 &&
    !NOT_A_JOB_TITLE.test(line) &&
    !HAS_JOB_CARD_BADGE.test(line) &&
    !looksLikeSectionHeader(line) &&
    !/^(remote|hybrid|on.?site|full.?time|part.?time|contract|\$|http|about|we are|\d+\s)/i.test(line) &&
    !/^[^a-z]*$/i.test(line)
  );

  const titled = plausible.find(l => JOB_TITLE_HINT.test(l));
  if (titled) return titled;
  return plausible[0] || 'this role';
}

// ── Thread separator for JD switches ─────────────────────────────────────
function addThreadSeparator(jobTitle) {
  const msgs = $('chat-messages');
  if (!msgs) return;
  const sep = document.createElement('div');
  sep.className = 'thread-separator';
  sep.innerHTML = `<span>${jobTitle}</span>`;
  msgs.appendChild(sep);
  msgs.scrollTop = msgs.scrollHeight;
}

function updateQuickActions(skillsToAdd = []) {
  const container = $('quick-actions');
  if (!container) return;
  container.innerHTML = '';
  skillsToAdd.slice(0, 3).forEach(skill => {
    const kw = extractKeyword(skill);
    const btn = document.createElement('button');
    btn.className = 'quick-action-btn'; btn.textContent = `+ ${kw}`;
    btn.addEventListener('click', () => addSkillToResume(kw));
    container.appendChild(btn);
  });
  const hasTailored = !!state.tailoredResume;
  [
    ['✕ Remove a section', hasTailored, () => {
      pushUserMessage('Remove a section'); pushAssistantMessage('Which section?');
      showSectionButtons(['Summary', 'Projects', 'Skills'], s => {
        const inst = {'Summary':'Set summary to "". Do not touch anything else.','Projects':'Set projects to []. Do not touch anything else.','Skills':'Set skills to []. Do not touch anything else.'};
        executeChatEdit(inst[s] || `Remove ${s} only.`, `**${s}** removed. Download updated PDF. ↓`);
      });
    }],
    ['− Reduce points', hasTailored, () => showReduceBulletsPicker()],
    ['✏ Shorter summary', hasTailored, () => executeChatEdit('Make professional summary 2 sentences max.', 'Summary shortened. ↓')],
    ['＋ Add hidden project', hasTailored, () => executeChatEdit("Add candidate's most recent project from profile to Projects.", 'Project added. ↓')],
    ['🔗 Your links', true, () => showYourLinks()],
    ['💬 Answer interview Q', true, () => showInterviewQOptions()],
    ['📋 Tracker', true, () => send('OPEN_TRACKER')],
  ].forEach(([label, active, onClick]) => makeQuickBtn(container, label, active, onClick));
}

// Surfaces LinkedIn/portfolio from the resume with one-tap copy buttons, so
// the user doesn't need to switch tabs to find and copy a link an
// application form is asking for.
function showYourLinks() {
  const contact = state.tailoredResume?.contact || state.resumeData?.contact || {};
  const links = [
    ['LinkedIn', contact.linkedin],
    ['Portfolio', contact.portfolio],
    ['GitHub', contact.github]
  ].filter(([, url]) => url && url.trim());

  pushUserMessage('Your links');
  if (!links.length) {
    pushAssistantMessage(`No LinkedIn, portfolio, or GitHub link found on your resume.`);
    return;
  }
  pushAssistantMessage(`Here ${links.length === 1 ? 'it is' : 'they are'}:`);
  const msgs = $('chat-messages');
  if (!msgs) return;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin:2px 0 8px 40px;display:flex;flex-direction:column;gap:6px;';
  links.forEach(([label, url]) => {
    const card = document.createElement('div');
    card.style.cssText = 'display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--surface-alt,#f8f9fb);border:1px solid var(--border);border-radius:8px;';
    const textCol = document.createElement('div');
    textCol.style.cssText = 'flex:1;min-width:0;'; // min-width:0 lets this shrink instead of pushing the button
    const labelEl = document.createElement('div');
    labelEl.style.cssText = 'font-size:10px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:0.03em;';
    labelEl.textContent = label;
    const urlEl = document.createElement('div');
    urlEl.style.cssText = 'font-size:11.5px;color:var(--blue);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    urlEl.textContent = url;
    urlEl.title = url; // full URL on hover, since it may be truncated
    textCol.appendChild(labelEl); textCol.appendChild(urlEl);
    const copyBtn = document.createElement('button');
    copyBtn.className = 'quick-action-btn';
    copyBtn.style.cssText = 'flex-shrink:0;'; // never pushed to a new line, regardless of URL length
    copyBtn.textContent = '⎘ Copy';
    copyBtn.addEventListener('click', async () => {
      await send('COPY_TEXT', { text: url });
      copyBtn.textContent = '✓ Copied!';
      setTimeout(() => { copyBtn.textContent = '⎘ Copy'; }, 2000);
    });
    card.appendChild(textCol); card.appendChild(copyBtn);
    wrap.appendChild(card);
  });
  msgs.appendChild(wrap);
  msgs.scrollTop = msgs.scrollHeight;
}

function makeQuickBtn(container, label, active, onClick) {
  const btn = document.createElement('button');
  btn.className = 'quick-action-btn' + (active ? '' : ' quick-action-btn--dim');
  btn.textContent = label;
  btn.title = active ? '' : 'Tailor your resume first';
  btn.addEventListener('click', () => {
    if (!active) { pushAssistantMessage('Tailor first using ⚡ on the left.'); return; }
    onClick();
  });
  container.appendChild(btn);
}

function showInterviewQOptions() {
  pushAssistantMessage('Which question would you like me to answer using your resume and this JD?');
  showSectionButtons(['Why this company?', 'Why this role?', 'Tell me about yourself', 'Greatest strength?'], question => {
    answerApplicationQuestion(question);
  });
}

// Show a row of sub-option buttons in the chat, call onSelect when one is clicked.
// Rebuilds normal quick actions afterward via updateQuickActions() so event
// listeners are properly reattached (innerHTML restore would lose them).
// Lets the user pick a SPECIFIC experience or project entry (by its actual
// company/title or project name, not a generic section label) and trim its
// bullet count by one. Pairs with the floor-enforcement fix in
// restoreMissingBullets (ai.js) — that fix keeps the AI from leaving one
// entry thinner than the rest; this button is the reverse direction, for
// when a user looks at an already-balanced resume and decides a specific
// entry is still too long for their taste (e.g. it runs the page over,
// or they just want it tighter) and wants to shorten just that one.
function showReduceBulletsPicker() {
  const resume = state.tailoredResume;
  if (!resume) return;

  const entries = [];
  (resume.experience || []).forEach((exp, i) => {
    const count = Array.isArray(exp.bullets) ? exp.bullets.length : 0;
    if (count < 2) return; // nothing meaningful to trim below 1 bullet
    entries.push({ label: `${exp.title || 'Role'} at ${exp.company || 'Company'}`, kind: 'experience', index: i, count });
  });
  (resume.projects || []).forEach((proj, i) => {
    const count = Array.isArray(proj.bullets) ? proj.bullets.length : 0;
    if (count < 2) return;
    entries.push({ label: proj.name || 'Project', kind: 'project', index: i, count });
  });

  try {
    console.info('[ResumePilot] reduce-points picker — entries seen:',
      [...(resume.experience || []).map(e => `exp:${e.company} (${Array.isArray(e.bullets) ? e.bullets.length : typeof e.bullets})`),
       ...(resume.projects   || []).map(p => `proj:${p.name} (${Array.isArray(p.bullets) ? p.bullets.length : typeof p.bullets})`)]);
  } catch (_) {}
  pushUserMessage('Reduce points');
  if (!entries.length) {
    pushAssistantMessage("Every section is already down to its shortest form — nothing left to trim.");
    return;
  }
  pushAssistantMessage('Which one should I shorten?');

  const labels = entries.map(en => `${en.label} (${en.count} pts)`);
  showSectionButtons(labels, selectedLabel => {
    const chosen = entries[labels.indexOf(selectedLabel)];
    if (!chosen) return;
    // Targeted instruction naming the EXACT entry by its real identifier
    // (company+title, or project name) — not a vague "shorten experience",
    // which could land on the wrong entry or touch all of them. Asks for
    // one fewer bullet than it currently has, floor of 1, and explicitly
    // scopes the edit to just this one entry so the rest of the resume
    // (including its own bullet-count balance) isn't disturbed.
    const targetCount = Math.max(1, chosen.count - 1);
    const subject = chosen.kind === 'experience' ? `the experience entry "${chosen.label}"` : `the project "${chosen.label}"`;
    // Which skills the user added THIS SESSION actually live in the entry
    // being trimmed? Those must survive the trim. Checked against this
    // entry's own bullets (not the whole resume), so a skill that also sits
    // in the Skills section can't mask a bullet that lost it. Everything
    // else in the entry is fair game to merge or drop — that is what
    // "reduce points" means.
    const entryObj = chosen.kind === 'experience' ? (state.tailoredResume.experience || [])[chosen.index]
                                                  : (state.tailoredResume.projects   || [])[chosen.index];
    const entryRef = { kind: chosen.kind, index: chosen.index,
                       name: chosen.kind === 'experience' ? entryObj?.company : entryObj?.name };
    const addedHere = (state.placedSkills || []).filter(sk =>
      findSkillsMissingFromGiven({ bullets: entryObj?.bullets || [] }, [sk]).length === 0);
    const keepClause = addedHere.length
      ? ` The candidate deliberately added these to this entry and each one MUST still be clearly written into its remaining bullets: ${addedHere.join('; ')}. ` +
        `Merge or drop OTHER, less important points to reach the count — never these.`
      : '';
    executeCondenseEdit({
      buildInstruction: (n) => `Reduce ${subject} to exactly ${n} bullet${n === 1 ? '' : 's'} by merging or condensing its existing points — keep the most impactful ones. Never state the same point twice.${keepClause} Do not touch any other section or entry (including the Skills section) — their content must come back byte-for-byte identical to how it is now.`,
      confirmationLabel: (n) => `Trimmed **${chosen.label}** from ${chosen.count} to ${n} point${n === 1 ? '' : 's'}${addedHere.length ? `, keeping ${addedHere.join(', ')}` : ''}. Download updated PDF. ↓`,
      targetCount,
      floorCount: 1,
      entryLabel: `**${chosen.label}**`,
      kind: chosen.kind,
      skillsToVerify: addedHere,
      entryRef,
      fromCount: chosen.count
      // preserveAllContent deliberately false: Reduce Points is allowed to
      // drop the least-important points — only the skills above are protected.
    });
  });
}

function showSectionButtons(sections, onSelect) {
  const container = $('quick-actions');
  if (!container) return;
  container.innerHTML = '';
  sections.forEach(section => {
    const btn = document.createElement('button');
    btn.className = 'quick-action-btn';
    btn.textContent = section;
    btn.addEventListener('click', () => {
      pushUserMessage(section);
      updateQuickActions([]); // rebuild with fresh listeners
      onSelect(section);
    });
    container.appendChild(btn);
  });
  const cancel = document.createElement('button');
  cancel.className = 'quick-action-btn';
  cancel.textContent = '✕ Cancel';
  cancel.addEventListener('click', () => updateQuickActions([]));
  container.appendChild(cancel);
}

// Execute a chat edit and show a specific confirmation message (not generic)
// Wraps executeChatEdit specifically for condense/reduce actions (Shorten
// It, Reduce Points). ai.js's guards already retry once internally with a
// reinforced instruction — by the time THIS function sees a failure, two
// real attempts have already failed to fit everything into targetCount
// without losing or duplicating content. Rather than a dead-end "something
// went wrong," offer the one honest next step: one fewer bullet than what
// was just attempted, where there's more room for the same content to fit.
// If even targetCount+1 was already at the entry's original size (nothing
// smaller to offer), say so plainly instead of suggesting a retry that
// can't help.
// Finds the experience/project entry a condense edit is aimed at, in any
// version of the resume, by its real identifier (company or project name).
// Index is only a fallback — the AI is free to reorder entries.
function findEntryByRef(resume, ref) {
  if (!resume || !ref) return null;
  const list = ref.kind === 'experience' ? (resume.experience || []) : (resume.projects || []);
  const key = ref.kind === 'experience' ? 'company' : 'name';
  return list.find(e => e && e[key] === ref.name)
    || (Number.isInteger(ref.index) ? list[ref.index] : null)
    || null;
}

// Which of `skills` have no trace in THIS ENTRY's bullets. The whole-resume
// check (findSkillsMissingFromGiven on the full resume) is too forgiving
// for a condense: a skill that also sits in the Skills section counts as
// "present" even when the bullet that carried it was merged away — which is
// exactly how WebSocket could vanish from the Roomiehub bullet unnoticed.
function findSkillsMissingFromEntry(resume, ref, skills) {
  if (!skills?.length) return [];
  const entry = findEntryByRef(resume, ref);
  if (!entry) return skills.slice();   // entry vanished entirely: nothing survived
  return findSkillsMissingFromGiven({ bullets: entry.bullets || [] }, skills);
}

// Skills-section items present before but gone after. A condense is scoped
// to one entry's bullets; the Skills section is never supposed to change.
function skillsSectionItemsLost(beforeResume, afterResume) {
  const items = r => new Set((r?.skills || []).flatMap(c => Array.isArray(c.items) ? c.items : [])
    .map(x => String(x).toLowerCase().trim()).filter(Boolean));
  const before = items(beforeResume), after = items(afterResume);
  return [...before].filter(x => !after.has(x));
}

// Wraps the CHAT_EDIT call for the two "make this entry shorter" actions
// (Shorten It, Reduce Points).
//
//  skillsToVerify : skills that must still be written into THIS entry's
//                   bullets afterwards (Shorten It: the skills just woven
//                   in; Reduce Points: whichever added skills live in the
//                   entry being trimmed).
//  entryRef       : { kind, name, index } of the entry being edited.
//  fromCount      : how many bullets the entry has right now — so a failure
//                   only offers an easier target that is still genuinely
//                   shorter than what's there.
//
// The edit always runs against ONE snapshot of the resume (baseResume), and
// the result is verified against that same snapshot before anything is
// saved. A result that loses a required skill gets exactly one retry that
// names the missing skills; if it still can't keep them, nothing changes
// and the user is told which skills were the problem.
async function executeCondenseEdit({ buildInstruction, confirmationLabel, targetCount, floorCount, entryLabel, kind, preserveAllContent = false, skillsToVerify = [], entryRef = null, fromCount = null }) {
  if (!state.tailoredResume) return;
  const container = $('quick-actions');
  const btns = container?.querySelectorAll('button');
  btns?.forEach(b => { b.disabled = true; b.style.opacity = '0.4'; });
  const sendBtn = $('btn-chat-send');
  if (sendBtn) sendBtn.disabled = true;
  const t = pushThinkingMessage();
  const reenable = () => {
    if (sendBtn) sendBtn.disabled = false;
    btns?.forEach(b => { b.disabled = false; b.style.opacity = ''; });
  };

  const baseResume = state.tailoredResume;
  let res = null;
  let lostSkills = [];      // required skills missing from the entry's bullets
  let lostSectionItems = []; // Skills-section items that disappeared

  for (let attempt = 0; attempt < 2; attempt++) {
    const reinforce = attempt === 0 ? '' :
      ` IMPORTANT: your previous attempt left ${lostSkills.length ? `these out of this entry's bullets: ${lostSkills.join(', ')}` : 'items out of the Skills section'}. ` +
      `${lostSkills.length ? 'Each of them must be clearly written into the result — fold it into a merged bullet and drop some OTHER, less important point instead. ' : ''}` +
      `The Skills section must come back exactly as it is now.`;
    res = await send('CHAT_EDIT', {
      instruction: buildInstruction(targetCount) + reinforce,
      tailoredResume: baseResume, jobDescription: state.jd,
      allowReduction: true, preserveAllContent,
      requiredSkills: skillsToVerify
    });
    if (res.error) break;
    lostSkills = entryRef ? findSkillsMissingFromEntry(res.tailored, entryRef, skillsToVerify)
                          : findSkillsMissingFromGiven(res.tailored, skillsToVerify);
    lostSectionItems = skillsSectionItemsLost(baseResume, res.tailored);
    if (!lostSkills.length && !lostSectionItems.length) break;
  }
  removeThinkingMessage(t);

  const failed = res.error || lostSkills.length || lostSectionItems.length;
  if (failed) {
    // Easier target only if it is still genuinely shorter than what's there.
    const easier = targetCount + 1;
    const canOfferEasier = easier <= 50 && (fromCount === null || easier < fromCount);
    let reason;
    if (!res.error && lostSkills.length) {
      reason = `couldn't get ${entryLabel} down to ${targetCount} points without losing ${lostSkills.join(', ')} — which you added on purpose`;
    } else if (!res.error && lostSectionItems.length) {
      reason = `the shorter version also changed your Skills section (it dropped ${lostSectionItems.slice(0, 4).join(', ')}${lostSectionItems.length > 4 ? '…' : ''})`;
    } else {
      reason = preserveAllContent
        ? `couldn't fit everything into ${targetCount} points without dropping or repeating something — ${entryLabel} may genuinely have too much distinct content for that count`
        : `the result didn't come out clean at ${targetCount} points — something repeated, or another section got touched`;
    }
    if (canOfferEasier) {
      pushAssistantMessageWithAction(
        `I tried twice and ${reason}, so I left it exactly as it was. I can try ${easier} points instead, which leaves a bit more room.`,
        `Try ${easier} points instead`,
        () => executeCondenseEdit({ buildInstruction, confirmationLabel, targetCount: easier, floorCount, entryLabel, kind, preserveAllContent, skillsToVerify, entryRef, fromCount })
      );
    } else {
      pushAssistantMessage(`I tried twice and ${reason}, so I left it exactly as it was. It's already as tight as it can get while keeping everything you added.`);
    }
    reenable();
    return;
  }

  state.tailoredResume = res.tailored; state.pdfBase64 = res.pdfBase64;
  await saveWork();
  pushAssistantMessage(confirmationLabel(targetCount));
  updateQuickActions([]);
}

async function executeChatEdit(instruction, confirmationMsg, allowReduction = false) {
  if (!state.tailoredResume) return;
  // Disable all quick action buttons during processing
  const container = $('quick-actions');
  const btns = container?.querySelectorAll('button');
  btns?.forEach(b => { b.disabled = true; b.style.opacity = '0.4'; });
  const sendBtn = $('btn-chat-send');
  if (sendBtn) sendBtn.disabled = true;
  const t = pushThinkingMessage();
  const res = await send('CHAT_EDIT', { instruction, tailoredResume: state.tailoredResume, jobDescription: state.jd, allowReduction });
  removeThinkingMessage(t);
  if (sendBtn) sendBtn.disabled = false;
  if (res.error) {
    pushAssistantMessage(`Something went wrong: ${res.message || res.error}`);
    btns?.forEach(b => { b.disabled = false; b.style.opacity = ''; });
    return;
  }
  state.tailoredResume = res.tailored; state.pdfBase64 = res.pdfBase64;
  saveWork();
  pushAssistantMessage(confirmationMsg);
  updateQuickActions([]); // re-render fresh (also re-enables buttons)
}

async function addSkillToResume(keyword) {
  if (!state.tailoredResume) { pushAssistantMessage('Tailor your resume first, then I can add skills.'); return; }
  pushUserMessage(`Add "${keyword}" to my skills`);
  const t = pushThinkingMessage();
  const res = await send('CHAT_EDIT', { instruction: `Add "${keyword}" to the most relevant skills category. Only add to Skills — no fabrication.`, tailoredResume: state.tailoredResume, jobDescription: state.jd });
  removeThinkingMessage(t);
  if (res.error) { pushAssistantMessage(`Couldn't add that: ${res.message || res.error}`); return; }
  state.tailoredResume = res.tailored; state.pdfBase64 = res.pdfBase64;
  send('SAVE_SKILL_TO_PROFILE', { skill: keyword });
  pushAssistantMessage(`Done! "${keyword}" added to Skills. Download the updated PDF from the left.`);
  updateQuickActions([]); // restore standard buttons
}

async function sendChatMessage() {
  const input = $('chat-input');
  const text = input?.value?.trim();
  if (!text) return;
  if (!state.tailoredResume) { pushAssistantMessage('Tailor your resume first using the left panel, then I can help modify it.'); input.value = ''; return; }
  input.value = '';
  pushUserMessage(text);

  // Explicit edit language — "add X to my resume", "put this in my skills",
  // "update my experience with..." — is a clear, unambiguous signal.
  if (looksLikeEditRequest(text)) {
    await executeChatEdit(text, 'Done! Resume updated. Download the updated PDF from the left. ↓');
    return;
  }

  // Explicit answer language, or a real question — also unambiguous.
  if (isApplicationQuestion(text)) {
    await answerApplicationQuestion(text);
    return;
  }

  // Genuinely ambiguous — a bare phrase with no verb pointing either way is
  // exactly what a copy-pasted application-form question label looks like
  // ("Evidence of Excellence", "Describe a challenge"), and it's just as
  // plausibly "add this to my resume." Guessing wrong toward editing is a
  // destructive, easy-to-miss mistake — so ask instead of guessing.
  askEditOrAnswer(text);
}

// Explicit signal that the user wants this WRITTEN INTO the resume, not
// just answered. Verb-first phrasing aimed at the resume/experience/skills.
function looksLikeEditRequest(text) {
  return /\b(add|include|put|insert|update|change|rewrite|edit)\b.{0,40}\b(resume|cv|experience|skills?|bullet|project|summary)\b/i.test(text)
      || /\b(resume|cv|experience|skills?|bullet|project|summary)\b.{0,40}\b(add|include|put|insert|update|change|rewrite|edit)\b/i.test(text);
}

// Ask which the user means, rather than guessing — reuses the same
// quick-action-button pattern as the copy-answer button elsewhere.
function askEditOrAnswer(text) {
  pushAssistantMessage(`Do you want this added to your resume, or should I just write you an answer for it?`);
  const msgs = $('chat-messages');
  if (!msgs) return;
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:6px;margin:4px 0 8px 40px;flex-wrap:wrap;';
  const editBtn = document.createElement('button');
  editBtn.className = 'quick-action-btn';
  editBtn.textContent = '✎ Add to resume';
  const answerBtn = document.createElement('button');
  answerBtn.className = 'quick-action-btn';
  answerBtn.textContent = '💬 Just answer it';
  editBtn.addEventListener('click', async () => {
    row.remove();
    pushUserMessage('Add to resume');
    await executeChatEdit(text, 'Done! Resume updated. Download the updated PDF from the left. ↓');
  });
  answerBtn.addEventListener('click', async () => {
    row.remove();
    pushUserMessage('Just answer it');
    await answerApplicationQuestion(text);
  });
  row.appendChild(editBtn); row.appendChild(answerBtn);
  msgs.appendChild(row);
  msgs.scrollTop = msgs.scrollHeight;
}

// Heuristic to detect application/interview questions in the chat input
function isApplicationQuestion(text) {
  const lower = text.toLowerCase();
  // Explicit "answer this" / "help me answer" / "write the answer" prefix
  // or phrasing anywhere in the message — this was the exact miss: "Help me
  // write the answer to a question..." has no "you/your/why/what" in it,
  // so the old check alone didn't catch it.
  if (/^(answer\s+this|answer:|respond\s+to|reply\s+to)\s*/i.test(text)) return true;
  if (/\b(help\s+me\s+)?(write|draft|give\s+me)\s+(an?\s+|the\s+)?(answer|response)\b/i.test(text)) return true;
  if (/\bhow\s+(do|should)\s+i\s+answer\b/i.test(lower)) return true;
  if (/\banswer\s+to\s+(a|this|the)\s+question\b/i.test(lower)) return true;
  // Imperative behavioral-question phrasing — "Describe a time you...",
  // "Tell me about a challenge you..." — extremely common application
  // question format, often with no question mark at all.
  if (/\b(describe|tell\s+me\s+about)\b.{0,60}\byou\b/i.test(text)) return true;
  // Question marks with "you/your" — likely a personal/behavioral question
  if (text.includes('?') && /\b(you|your|why|what|how|tell\s+me|describe|share)\b/i.test(text)) return true;
  // Common application question patterns
  if (/\b(why\s+do\s+you|what\s+interests\s+you|tell\s+us\s+about|describe\s+yourself|your\s+experience\s+with|why\s+(this|our|the)\s+(company|role|position|team)|motivates\s+you|passion|excited\s+about|fit\s+for)\b/i.test(lower)) return true;
  return false;
}

async function answerApplicationQuestion(question) {
  const sendBtn = $('btn-chat-send');
  if (sendBtn) sendBtn.disabled = true;
  const t = pushThinkingMessage();
  const res = await send('ANSWER_QUESTION', {
    question: question.replace(/^(answer\s+this\s*[-–:]*\s*)/i, '').trim(),
    tailoredResume: state.tailoredResume,
    jobDescription: state.jd
  });
  removeThinkingMessage(t);
  if (sendBtn) sendBtn.disabled = false;
  if (res.error) { pushAssistantMessage(`Couldn't generate an answer: ${res.message || res.error}`); return; }
  pushAssistantMessage(`Here's a suggested answer:\n\n${res.answer}`);
  // Add a real, working copy button below the answer
  addCopyButton(res.answer);
}

function addCopyButton(text) {
  const msgs = $('chat-messages');
  if (!msgs) return;
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:6px;margin:4px 0 8px 40px;';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'quick-action-btn';
  copyBtn.textContent = '⎘ Copy answer';
  copyBtn.addEventListener('click', async () => {
    await send('COPY_TEXT', { text });
    copyBtn.textContent = '✓ Copied!';
    setTimeout(() => { copyBtn.textContent = '⎘ Copy answer'; }, 2000);
  });
  row.appendChild(copyBtn);
  msgs.appendChild(row);
  msgs.scrollTop = msgs.scrollHeight;
}

$('btn-chat-send')?.addEventListener('click', sendChatMessage);
$('chat-input')?.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); } });

// ── Profile hub ───────────────────────────────────────────────────────────
const hubMenu = $('profile-hub-menu');
let hubOpen = false;

$('btn-profile-hub')?.addEventListener('click', (e) => {
  e.stopPropagation();
  hubOpen = !hubOpen;
  hubMenu?.classList.toggle('hidden', !hubOpen);
  if (hubOpen) {
    // Populate user info
    const name = state.resumeData?.name || state.userName || 'Guest';
    const hub_name = $('hub-name');
    if (hub_name) hub_name.textContent = name;
  }
});

// Close when clicking outside
document.addEventListener('click', () => {
  if (hubOpen) { hubOpen = false; hubMenu?.classList.add('hidden'); }
});
hubMenu?.addEventListener('click', e => e.stopPropagation());

$('hub-btn-profile')?.addEventListener('click', () => { hubMenu?.classList.add('hidden'); send('OPEN_ONBOARDING'); });
$('hub-btn-tracker')?.addEventListener('click', () => { hubMenu?.classList.add('hidden'); send('OPEN_TRACKER'); });
$('hub-btn-plans')?.addEventListener('click',   () => { hubMenu?.classList.add('hidden'); send('OPEN_PLANS'); });
$('hub-btn-notify')?.addEventListener('click',  () => { hubMenu?.classList.add('hidden'); openNotifyCard(); });
$('hub-btn-signout')?.addEventListener('click', async () => {
  hubMenu?.classList.add('hidden');
  await send('SIGN_OUT');
  state.resumeData = null; state.tailoredResume = null;
  hide('main-area'); hide('panel-footer'); show('no-profile');
});

$('btn-minimize')?.addEventListener('click', () => window.parent.postMessage({ rp_push: 'MINIMIZE' }, '*'));

// ── Drag the panel by its header ──────────────────────────────────────────
// The panel lives in a cross-origin iframe, so it can't move itself. We post
// screen coordinates to the parent content script, which repositions the frame.
// screenX/screenY are used because they're absolute — unaffected by the iframe's
// own coordinate space, which shifts as it moves.
(function makeHeaderDraggable() {
  const header = document.querySelector('.panel-header');
  if (!header) return;

  header.style.cursor = 'grab';
  header.title = 'Drag to move · double-click to reset position';

  let dragging = false;

  header.addEventListener('mousedown', e => {
    // Don't start a drag from the buttons in the header.
    if (e.target.closest('button')) return;
    dragging = true;
    header.style.cursor = 'grabbing';
    window.parent.postMessage({ rp_push: 'DRAG_START', screenX: e.screenX, screenY: e.screenY }, '*');
    e.preventDefault();
  });

  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    window.parent.postMessage({ rp_push: 'DRAG_MOVE', screenX: e.screenX, screenY: e.screenY }, '*');
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    header.style.cursor = 'grab';
    window.parent.postMessage({ rp_push: 'DRAG_END' }, '*');
  });

  // Double-click the header to snap back to the default corner.
  header.addEventListener('dblclick', e => {
    if (e.target.closest('button')) return;
    window.parent.postMessage({ rp_push: 'RESET_POSITION' }, '*');
  });
})();

// Legacy buttons (keep for backward compat)
$('btn-open-plans-header')?.addEventListener('click', () => send('OPEN_PLANS'));
$('btn-setup-fab')?.addEventListener('click', () => send('OPEN_ONBOARDING'));
$('btn-footer-plans')?.addEventListener('click', () => send('OPEN_PLANS'));
$('btn-footer-signout')?.addEventListener('click', async () => { await send('SIGN_OUT'); state.resumeData = null; state.tailoredResume = null; hide('main-area'); hide('panel-footer'); show('no-profile'); });

// ── Quotes ────────────────────────────────────────────────────────────────
const QUOTES = [
  { text: "The biggest risk is not taking any risk.", author: "Mark Zuckerberg, CEO of Meta" },
  { text: "About half of what separates successful entrepreneurs from the non-successful is pure perseverance.", author: "Steve Jobs, Co-founder of Apple" },
  { text: "The only way to do great work is to love what you do.", author: "Steve Jobs, Co-founder of Apple" },
  { text: "It's more important to heed the lessons of failure than to celebrate success.", author: "Bill Gates, Co-founder of Microsoft" },
  { text: "The way to get started is to quit talking and begin doing.", author: "Walt Disney" },
  { text: "When something is important enough, you do it even if the odds are not in your favor.", author: "Elon Musk, CEO of Tesla & SpaceX" },
  { text: "Don't worry about failure; you only have to be right once.", author: "Drew Houston, Co-founder of Dropbox" },
  { text: "I have not failed. I've just found 10,000 ways that won't work.", author: "Thomas Edison" },
  { text: "I knew that if I failed I wouldn't regret that, but I might regret not trying.", author: "Jeff Bezos, Founder of Amazon" },
  { text: "Success is not final; failure is not fatal: it is the courage to continue that counts.", author: "Winston Churchill" },
  { text: "The secret of getting ahead is getting started.", author: "Mark Twain" },
  { text: "It does not matter how slowly you go as long as you do not stop.", author: "Confucius" },
  { text: "Everything you've ever wanted is on the other side of fear.", author: "George Addair" },
  { text: "Chase the vision, not the money; the money will end up following you.", author: "Tony Hsieh, CEO of Zappos" },
  { text: "The only limit to our realization of tomorrow will be our doubts of today.", author: "Franklin D. Roosevelt" },
  { text: "Move fast and break things. Unless you are breaking stuff, you are not moving fast enough.", author: "Mark Zuckerberg, CEO of Meta" },
  { text: "The people who are crazy enough to think they can change the world are the ones who do.", author: "Steve Jobs, Co-founder of Apple" },
  { text: "If you set your goals ridiculously high and it's a failure, you will fail above everyone else's success.", author: "James Cameron" },
];

async function renderQuote() {
  const strip = $('quote-strip');
  if (!strip) return;
  const today = new Date().toISOString().slice(0, 10);
  const stored = await send('GET_STORAGE', { keys: ['lastQuoteDate', 'todaysQuote'] });
  let quote;
  if (stored.lastQuoteDate === today && stored.todaysQuote) {
    quote = stored.todaysQuote;
  } else {
    quote = QUOTES[Math.floor(Math.random() * QUOTES.length)];
    await send('SET_STORAGE', { data: { lastQuoteDate: today, todaysQuote: quote } });
  }
  const bodyEl = $('quote-body'), authorEl = $('quote-author');
  if (bodyEl) bodyEl.textContent = `"${quote.text}"`;
  if (authorEl) authorEl.textContent = `— ${quote.author}`;
  strip.classList.remove('hidden');
}

// ── Break reminder ────────────────────────────────────────────────────────
// Break reminder: nudge the user to take a break after a period of active
// use. The threshold and snooze length are admin-configurable (see the
// Worker's /admin page) rather than hardcoded — same remote-config system
// used for the feedback popup cadence, so tuning this doesn't require a new
// extension version or a Chrome Web Store review.
const BREAK_CONFIG_CACHE_MS = 4 * 60 * 60 * 1000; // re-check every 4 hours
const BREAK_HARD_DEFAULTS = { breakThresholdMinutes: 60, breakSnoozeMinutes: 45 };

async function getBreakConfig() {
  const stored = await send('GET_STORAGE', { keys: ['rpBreakConfig', 'rpBreakConfigFetchedAt'] });
  const cached = stored.rpBreakConfig;
  const fetchedAt = stored.rpBreakConfigFetchedAt || 0;
  if (cached && (Date.now() - fetchedAt) < BREAK_CONFIG_CACHE_MS) return cached;

  try {
    const res = await send('GET_REMOTE_CONFIG', {});
    if (res && res.breakThresholdMinutes) {
      await send('SET_STORAGE', { data: { rpBreakConfig: res, rpBreakConfigFetchedAt: Date.now() } });
      return res;
    }
  } catch (_) { /* fall through to cached/defaults below */ }
  return cached || BREAK_HARD_DEFAULTS;
}

async function checkBreakReminder() {
  const stored = await send('GET_STORAGE', { keys: ['breakReminderSnoozedUntil', 'rpActivityLog'] });
  if (stored.breakReminderSnoozedUntil && Date.now() < stored.breakReminderSnoozedUntil) return;
  const log = stored.rpActivityLog || [];
  const config = await getBreakConfig();
  const thresholdMs = (config.breakThresholdMinutes || BREAK_HARD_DEFAULTS.breakThresholdMinutes) * 60 * 1000;
  if (computeStreakMs(log) >= thresholdMs) show('break-overlay');
}
async function logActivity() {
  const stored = await send('GET_STORAGE', { keys: ['rpActivityLog'] });
  const log = stored.rpActivityLog || [];
  log.push(Date.now());
  const cutoff = Date.now() - 4 * 60 * 60 * 1000;
  await send('SET_STORAGE', { data: { rpActivityLog: log.filter(t => t > cutoff) } });
}
function computeStreakMs(log) {
  if (!log.length) return 0;
  const sorted = [...log].sort((a, b) => a - b);
  let streakStart = sorted[0];
  for (let i = 1; i < sorted.length; i++) { if (sorted[i] - sorted[i-1] > 15*60*1000) streakStart = sorted[i]; }
  return sorted[sorted.length-1] - streakStart;
}
async function snoozeBreak() {
  const config = await getBreakConfig();
  const snoozeMs = (config.breakSnoozeMinutes || BREAK_HARD_DEFAULTS.breakSnoozeMinutes) * 60 * 1000;
  await send('SET_STORAGE', { data: { breakReminderSnoozedUntil: Date.now() + snoozeMs } });
  hide('break-overlay');
}
$('btn-take-break')?.addEventListener('click', snoozeBreak);
$('btn-keep-going')?.addEventListener('click', snoozeBreak);


// ── Utility ───────────────────────────────────────────────────────────────
function showError(msg) { const el = $('error-msg'); if (!el) return; el.textContent = msg; el.classList.remove('hidden'); setTimeout(() => el.classList.add('hidden'), 5000); }
function flash(btn, label) { if (!btn) return; const orig = btn.textContent; btn.textContent = label; setTimeout(() => { btn.textContent = orig; }, 2000); }

init();