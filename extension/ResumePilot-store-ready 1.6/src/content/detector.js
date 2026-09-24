// ─────────────────────────────────────────────────────────
//  ResumePilot Content Script
//  Detects JDs, watches apply buttons, injects resume/cover
//  letter, and caches JDs across navigation (LinkedIn→ATS).
// ─────────────────────────────────────────────────────────

// ── Immediate application tracking ───────────────────────
// This runs BEFORE the main IIFE, with zero dependencies.
// Strategy: watch for URL patterns and success text that
// indicate a confirmed application submission, then write
// directly to chrome.storage.local.
(function trackApplicationSubmission() {
  // Local, self-contained — this IIFE is deliberately independent of the
  // main one below (see the header comment above), so it can't reference
  // that IIFE's isContextValid; it's out of scope here entirely.
  function isContextValid() {
    try {
      return !!(chrome?.runtime?.id);
    } catch (_) {
      return false;
    }
  }

  // Anonymous usage ping only — same as the LinkedIn confirmation path.
  // WITHOUT writing a second applicationLog entry (the caller already wrote
  // its own, with its own dedup rules, right before calling this).
  // Feedback cadence keys off tailor count now (see worker.js), not
  // applications, so this no longer needs to relay anything back to the
  // panel — fire and forget.
  function notifyApplicationLogged() {
    if (!isContextValid()) return;
    try {
      chrome.runtime.sendMessage({ type: 'APPLICATION_LOGGED_ELSEWHERE' }).catch(() => {});
    } catch (_) {}
  }
  try {
    const url = window.location.href;
    const hostname = window.location.hostname;

    // ── URL-based confirmation patterns ──
    const isConfirmationUrl =
      /\/confirmation(\?|$|\/)/i.test(url) ||
      /\/thanks(\?|$|\/)/i.test(url) ||
      /\/apply\/confirmation/i.test(url) ||
      /\/application[_-]?(submitted|received|success)/i.test(url) ||
      /[?&]applied=true/i.test(url);

    // ── Extract company from URL slug ──
    function getCompanyFromUrl() {
      // Oracle Fusion Cloud HCM: the path is deep and the real company isn't
      // the first segment — /hcmUI/CandidateExperience/en/sites/{Company}Careers/...
      // The generic first-segment logic below would extract "hcmUI" here, so
      // this has to be checked first.
      if (/\.oraclecloud\.com$/i.test(hostname)) {
        const oracleMatch = window.location.pathname.match(/\/sites\/([^/]+?)(careers)?\//i);
        if (oracleMatch) return oracleMatch[1].charAt(0).toUpperCase() + oracleMatch[1].slice(1);
      }
      // Greenhouse: job-boards.greenhouse.io/COMPANY/jobs/ID
      // Lever:      jobs.lever.co/COMPANY/UUID
      // Ashby:      jobs.ashbyhq.com/COMPANY/UUID
      const pathMatch = window.location.pathname.match(/^\/([a-zA-Z0-9_-]{2,40})\//);
      if (pathMatch) {
        const slug = pathMatch[1]
          .replace(/usa$/i, '')
          .replace(/[-_]/g, ' ')
          .trim();
        return slug.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      }
      // Fallback: subdomain (careers.stripe.com → Stripe)
      const parts = hostname.replace('www.','').split('.');
      if (!['job-boards','jobs','careers','boards','greenhouse','lever','ashbyhq','workday','myworkdayjobs','indeed','linkedin'].includes(parts[0])) {
        return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
      }
      return hostname;
    }

    // ── Write to tracker ──
    function logApplication(source) {
      const now = Date.now();
      const company = getCompanyFromUrl();
      const jobIdMatch = url.match(/\/jobs?\/(\d+)/i);
      const fingerprint = jobIdMatch
        ? `gh_${jobIdMatch[1]}`
        : `url_${url.replace(/[^a-z0-9]/gi, '_').slice(-60)}`;

      const platform = hostname.includes('greenhouse.io') ? 'Greenhouse'
        : hostname.includes('lever.co') ? 'Lever'
        : hostname.includes('ashbyhq.com') ? 'Ashby'
        : hostname.includes('linkedin.com') ? 'LinkedIn'
        : hostname.includes('workday') ? 'Workday'
        : source === 'confirmation_url' ? 'Confirmed' : 'Applied';

      chrome.storage.local.get(['applicationLog', `jd_${fingerprint}`, 'jd_last', 'rpSession', 'rpSessionArchive'], (stored) => {
        const log = stored.applicationLog || [];

        // Prefer the SESSION for accurate title/company — it was captured on
        // the original job listing page, before any navigation.
        const session = stored.rpSession;
        const cachedEntry = stored[`jd_${fingerprint}`] || stored['jd_last'];

        let jobTitle = session?.jobTitle || cachedEntry?.jobTitle || '';
        let finalCompany = session?.company || cachedEntry?.company || company;
        const addedSkills = session?.addedSkills || [];

        if (!jobTitle) {
          const rawTitle = document.title?.split(/[|\-–]/)[0]?.trim() || '';
          const isGarbage = /notification|messaging|feed|\(\d+\)|linkedin|inbox|home|dashboard|join the|movement|thank you|apply|confirmation|application/i.test(rawTitle) || rawTitle.length < 4;
          if (!isGarbage) jobTitle = rawTitle;
          else if (cachedEntry?.jd) {
            const firstLine = cachedEntry.jd.split('\n').map(l => l.trim()).find(l =>
              l.length >= 4 && l.length <= 80 && !/^(remote|hybrid|full.?time|\$|http|about|we are|join the|welcome)/i.test(l)
            );
            if (firstLine) jobTitle = firstLine;
          }
        }

        const companyIsGarbage = /^(linkedin|greenhouse|lever|ashby|indeed|workday|glassdoor)(\.com|\.io)?$/i.test(finalCompany) || finalCompany.includes('.');
        if (companyIsGarbage && !jobTitle) return;
        if (companyIsGarbage) finalCompany = cachedEntry?.company || 'Unknown Company';
        if (!jobTitle) jobTitle = 'Applied position';

        // Same robust, multi-signal dedup used by the main IIFE's shared
        // isDuplicateApplication — duplicated here since this IIFE is
        // deliberately self-contained. Fingerprint isn't stable across two
        // detections of the same event (a URL shift, a different cache key
        // matching on a second lookup); exact title match isn't reliable
        // either (a provisional title vs. a later AI-confirmed one). Session
        // match is the most reliable signal when available; company alone,
        // in a shorter window, is the steadiest fallback.
        const sid = session?.sessionId || null;
        const isDupe =
          (sid && log.some(e => e.sessionId === sid)) ||
          log.some(e => e.fingerprint === fingerprint && (now - e.appliedAt) < 60 * 60 * 1000) ||
          log.some(e => e.jobTitle === jobTitle && e.company === finalCompany && (now - e.appliedAt) < 60 * 60 * 1000) ||
          log.some(e => e.company === finalCompany && (now - e.appliedAt) < 45 * 60 * 1000);
        if (isDupe) return;

        // Mark the session applied + archive it so returning to LinkedIn shows
        // "You applied to this job" with the full conversation available.
        if (session?.sessionId) {
          const appliedSession = { ...session, applied: true, appliedAt: now };
          const archive = stored.rpSessionArchive || {};
          archive[session.sessionId] = appliedSession;
          chrome.storage.local.set({ rpSession: appliedSession, rpSessionArchive: archive });
        }

        log.unshift({
          id: `app_${now}_${Math.random().toString(36).slice(2, 6)}`,
          jobTitle, company: finalCompany,
          url: document.referrer || url,
          fingerprint, appliedAt: now,
          addedSkills,                 // skills the user added for this job
          sessionId: session?.sessionId || null,
          status: 'applied', source: platform
        });
        chrome.storage.local.set({ applicationLog: log.slice(0, 500) });
        notifyApplicationLogged();
      });
    }

    // ── Trigger 1: URL is already a confirmation page ──
    if (isConfirmationUrl) {
      logApplication('confirmation_url');
      return; // done, no need to watch
    }

    // ── Trigger 2: Watch for success text appearing (SPA like Ashby) ──
    const SUCCESS_TEXT = [
      /successfully\s+submitted/i,
      /application\s+.{0,30}submitted/i,
      /application\s+.{0,30}received/i,
      /thank\s+you\s+for\s+(apply|your\s+application)/i,
      /your\s+application\s+was\s+sent/i,
    ];

    let textObserverFired = false;
    const textObserver = new MutationObserver(() => {
      if (!isContextValid()) { textObserver.disconnect(); return; }
      if (textObserverFired) return;
      const text = document.body?.innerText || '';
      if (SUCCESS_TEXT.some(p => p.test(text))) {
        textObserverFired = true;
        textObserver.disconnect();
        // Confirm the success message PERSISTS for 1.5s before logging.
        // This prevents false positives from transient banners that flash
        // and then get replaced by an error (e.g. Ashby validation failures).
        setTimeout(() => {
          const stillThere = document.body?.innerText || '';
          const errorShowing = /error|failed|could\s?n.t|try again|something went wrong|invalid/i.test(stillThere);
          if (SUCCESS_TEXT.some(p => p.test(stillThere)) && !errorShowing) {
            logApplication('success_text');
          }
        }, 1500);
      }
    });
    const isATS = /greenhouse\.io|lever\.co|ashbyhq\.com|workday\.com|myworkdayjobs\.com|greenhouse-io|smartrecruiters\.com|rippling\.com|gusto\.com|jobvite\.com|taleo\.net|successfactors|icims\.com/i.test(hostname);
    if (isATS) {
      textObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    }

  } catch (_) {}
})();

(function () {
  'use strict';

  // ── Global context guard ─────────────────────────────────
  // If extension was reloaded while this tab was open, bail out entirely.
  function isContextValid() {
    try {
      return !!(chrome?.runtime?.id);
    } catch (_) {
      return false;
    }
  }

  // Length alone isn't a reliable signal that scraped text is a real job
  // description — a login/auth page's boilerplate, legal text, or cookie
  // notice can easily exceed 150 characters without describing a job at
  // all. Requiring at least one JD-typical phrase is a cheap, low-risk
  // backstop: virtually every real posting contains one of these somewhere,
  // so genuine JDs should never get rejected by it — but it makes incidental
  // page text much less likely to be mistaken for one and wrongly create or
  // overwrite a session that was already correctly established.
  const JD_MIN_LEN = 150;
  const JD_CONTENT_SIGNAL = /\b(responsibilit|requirement|qualificat|years?\s+(of\s+)?experience|experience\s+(with|in|working)|skills?\b|you will|we are looking|about the role|about this (role|job|position)|what you('ll| will) (do|bring)|minimum qualifications|preferred qualifications|job description)/i;
  function looksLikeRealJD(text) {
    return !!text && text.trim().length >= JD_MIN_LEN && JD_CONTENT_SIGNAL.test(text);
  }

  // The extension can be reloaded (a new version installed) at any point
  // while this tab is already open, invalidating this script's connection
  // to it — any chrome.* call made after that throws "Extension context
  // invalidated." There's no meaningful recovery once that happens short of
  // refreshing the page, so rather than auditing every individual chrome.*
  // call site across every observer, timer, and listener in this file,
  // this suppresses that specific error class globally wherever it
  // surfaces — the same "fix the general case, not each specific spot"
  // approach used elsewhere in this file.
  window.addEventListener('error', (e) => {
    if (/context invalidated|extension context/i.test(e.message || '')) {
      e.preventDefault();
    }
  });
  window.addEventListener('unhandledrejection', (e) => {
    const msg = e.reason?.message || String(e.reason || '');
    if (/context invalidated|extension context/i.test(msg)) {
      e.preventDefault();
    }
  });

  if (!isContextValid()) return;

  let detectedJD     = null;
  let tailoredPdfB64 = null;
  let tailoredFilename = 'resume_tailored.pdf';
  let coverLetterText = null;
  let coverLetterPdfB64 = null;

  // ── Safe chrome.storage wrapper ──────────────────────────
  // Every chrome API call goes through these so we never crash
  // on an invalidated context.

  async function storageSet(data) {
    if (!isContextValid()) return;
    try {
      await chrome.storage.local.set(data);
    } catch (e) {
      if (!e.message?.includes('Extension context invalidated')) throw e;
    }
  }

  async function storageGet(keys) {
    if (!isContextValid()) return {};
    try {
      return await chrome.storage.local.get(keys);
    } catch (e) {
      if (e.message?.includes('Extension context invalidated')) return {};
      throw e;
    }
  }

  // Shared by every path that can log an application (confirmation-page
  // detection, resume-injection detection) so they can't drift out of sync
  // with each other the way they did before — one used title+company, the
  // other used fingerprint only, and neither caught the other's duplicate.
  //
  // Fingerprint isn't stable across two detections of the SAME event (a URL
  // shift, or a different cache key matching on a second lookup, can change
  // it). Exact title match ALSO isn't reliable — a real application can be
  // detected once with a provisional/fallback title and again later with the
  // AI-confirmed one, so two genuine sightings of ONE application can carry
  // different jobTitle values. Company alone, in a short window, is the
  // steadiest signal: applying twice to the same company within minutes is
  // rare enough that this can't reasonably suppress a genuine second
  // application, but is exactly what a re-fire or a second detection path
  // for the SAME submission looks like.
  function isDuplicateApplication(log, { fingerprint, jobTitle, company, sessionId }, now) {
    // Same session = same application journey, full stop, no time window
    // needed — a real multi-step ATS flow (personal info, work history,
    // EEO questions, review, submit) can easily take 20-40+ minutes, and
    // this signal doesn't care how long it took.
    const bySession = sessionId && log.some(e => e.sessionId === sessionId);
    const byFingerprint = fingerprint && log.some(e => e.fingerprint === fingerprint && (now - e.appliedAt) < 60 * 60 * 1000);
    const byTitle = jobTitle && company && log.some(e =>
      e.jobTitle === jobTitle && e.company === company && (now - e.appliedAt) < 60 * 60 * 1000
    );
    const byCompany = company && log.some(e =>
      e.company === company && (now - e.appliedAt) < 45 * 60 * 1000
    );
    return !!(bySession || byFingerprint || byTitle || byCompany);
  }

  function safeSendMessage(payload) {
    if (!isContextValid()) return;
    try {
      chrome.runtime.sendMessage(payload).catch(() => {});
    } catch (_) {}
  }

  // ── JD Detection ─────────────────────────────────────────

  // Strips job-board UI chrome (posted-date badges, applicant counts, Easy
  // Apply buttons, "X people clicked apply", related-jobs sidebar text,
  // etc.) that can end up captured alongside the real description — broad
  // CSS selectors (especially the generic [class*="job-description"]
  // fallbacks) sometimes match a wrapping container that includes both.
  // Two layers: full-phrase patterns for well-formed lines, and a
  // fragment-word check for cases where flex/grid layouts cause innerText
  // to break a badge like "Posted 2 weeks ago" across several short lines.
  const CHROME_LINE_PATTERNS = [
    /^(posted|reposted)\s+\d+\s+(day|week|month|hour|minute)s?\s+ago$/i,
    /^\d+\s+(day|week|month|hour|minute)s?\s+ago$/i,
    /^\d+[\d,]*\+?\s+(applicants?|people clicked apply|connections?|alumni work here|followers)$/i,
    /^(easy apply|apply now|save job|saved|share job|report this job)$/i,
    /^show (more|less)$/i,
    /^see (more|less)$/i,
    /^(promoted|be an early applicant|actively (recruiting|reviewing)|hiring now)$/i,
    /^(on-?site|remote|hybrid)\s*[·•].*$/i,
    /^(view|hide)\s+(similar|all)\s+jobs?$/i,
    /^\d{1,4}$/, // lone short number — almost always a fragment of a badge like "57 applicants" or "2 weeks ago", never meaningful JD prose on its own
    /^click here.*$/i,
    /^(people also viewed|similar jobs|related jobs|more jobs like this)$/i,
    /^(on-?site|remote|hybrid|full-?time|part-?time|contract|permanent|internship)$/i
  ];
  const CHROME_FRAGMENT_WORDS = new Set([
    'ago', 'week', 'weeks', 'day', 'days', 'month', 'months', 'hour', 'hours',
    'minute', 'minutes', 'posted', 'reposted', 'here', 'apply', 'applicants',
    'applicant', 'save', 'saved', 'share', 'promoted', 'hiring', 'easy',
    'followers', 'connections', 'alumni', 'report', 'show', 'more', 'less',
    'view', 'hide', 'similar', 'recruiting', 'reviewing', 'actively', 'early',
    'onsite', 'remote', 'hybrid', 'fulltime', 'parttime', 'contract', 'permanent',
    'internship', 'san', 'francisco', 'jose', 'angeles', 'diego', 'nyc', 'sf',
    'applied', 'verified', 'urgently', 'employer', 'matches', 'response', 'reply', 'typically'
  ]);
  function isChromeFragmentLine(line) {
    const words = line.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length || words.length > 4) return false;
    return words.every(w => CHROME_FRAGMENT_WORDS.has(w.replace(/[^\w]/g, '')));
  }
  // A "People also viewed" / "Similar jobs" section doesn't just have a header
  // to filter — everything BELOW it is a list of OTHER people's job postings
  // (other titles, other companies). Line-filtering only the header leaves
  // those titles sitting in the text looking exactly like real content, which
  // is how "Software Engineer" — someone else's sidebar posting — kept
  // winning over the actual job title being viewed.
  const SIDEBAR_BOUNDARY = /^(people also viewed|similar jobs|related jobs|more jobs like this|people also searched for|jobs you might be interested in|recommended jobs)\s*:?\s*$/i;

  function cleanJobDescriptionText(text) {
    if (!text) return text;
    const lines = text.split('\n');
    const cutIdx = lines.findIndex(l => SIDEBAR_BOUNDARY.test(l.trim()));
    const scoped = cutIdx === -1 ? lines : lines.slice(0, cutIdx);

    const cleaned = scoped
      .filter(line => {
        const t = line.trim();
        if (!t) return true; // keep blank lines for paragraph structure
        if (CHROME_LINE_PATTERNS.some(re => re.test(t))) return false;
        if (isChromeFragmentLine(t)) return false;
        return true;
      })
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return cleaned;
  }

  const ATS_SELECTORS = [
    // LinkedIn — ordered from most to least specific. #job-details is a
    // more stable container id LinkedIn has used across versions; the
    // wildcard class matches are more resilient to LinkedIn renaming their
    // exact class names than a hardcoded string.
    '#job-details',
    '.jobs-description__content',
    '.job-view-layout .description__text',
    '[class*="jobs-description"]',
    '[class*="description__text"]',
    // Greenhouse / Ashby embedded
    '#content .job__description',
    '.job-post__body',
    '[class*="job-post-description"]',
    // Ashby
    '[class*="ashby-job-posting-brief-description"]',
    '[class*="PostingDescription"]',
    '[class*="jobPosting"]',
    'div[data-testid="job-description"]',
    // Lever
    '.posting-headline ~ div',
    '.section-wrapper',
    '[class*="posting-description"]',
    // Workday
    '[data-automation-id="jobPostingDescription"]',
    // Indeed
    '#jobDescriptionText',
    '.jobsearch-JobComponent-description',
    // Glassdoor
    '[class*="JobDetails_jobDescription"]',
    // SmartRecruiters
    '.job-sections',
    // Rippling, Gusto, Lattice
    '[class*="job-description"]',
    '[class*="jobDescription"]',
    '[id*="job-description"]',
    '[class*="job-details"]',
    'article.job',
    // Catch-all — any element with id/class containing "description" that's large enough
    '[id*="description"]',
    '[class*="description"]',
  ];

  // True when the current URL is an application FORM page, not a job listing.
  // On these pages we must NOT scrape the page for the JD — the form text is
  // sparse/reordered and produces a different, worse JD than the real listing.
  // Instead we rely on the cached JD from the job listing page.
  function isApplicationFormPage() {
    const url = window.location.href;
    const hostname = window.location.hostname;
    return /\/application(\?|\/|$)/i.test(url)
      || /\/apply(\?|\/|$)/i.test(url)
      || /\/oneclick-ui\//i.test(url)          // SmartRecruiters one-click form
      || /smartrecruiters\.com\/.*\/publication/i.test(url)
      || /\/submit(\?|\/|$)/i.test(url)
      // Common intermediate steps in a multi-page ATS flow — account
      // creation, sign-in, questionnaires, EEO/voluntary-disclosure forms,
      // a final review step. None of these carry their own job description;
      // without recognizing them, the extension would try to scrape one
      // from what's really just an account form, instead of correctly
      // falling back to the JD already carried over in the session.
      || /\/register(\?|\/|$)/i.test(url)
      || /\/(sign.?in|sign.?up|log.?in|account)(\?|\/|$)/i.test(url)
      || /\/questionnaire(\?|\/|$)/i.test(url)
      || /\/(eeo|voluntary.?disclosures?)(\?|\/|$)/i.test(url)
      || /\/review(\?|\/|$)/i.test(url)
      // Many enterprise identity providers put this in the SUBDOMAIN, not
      // the path — login.microsoftonline.com, accounts.google.com, an
      // Okta/Auth0/SSO tenant. The path-only checks above never match these.
      || /^(login|signin|sso|auth|accounts|identity)\./i.test(hostname);
  }

  // Phrases that indicate LinkedIn/ATS UI chrome, NOT a real job description.
  // If the detected text starts with or is dominated by these, reject it.
  const UI_NOISE_PATTERNS = [
    /job moved to/i,
    /clicked apply/i,
    /application (started|in progress|submitted)/i,
    /you('ve| have) applied/i,
    /save(d)? (this )?job/i,
    /\d+ (people |applicants? )?clicked apply/i,
    /notification/i,
    /^(home|my network|jobs|messaging|notifications)\b/i,
  ];

  function looksLikeUiNoise(text) {
    if (!text) return true;
    const firstChunk = text.trim().slice(0, 120);
    return UI_NOISE_PATTERNS.some(p => p.test(firstChunk));
  }

  // Confirmed via direct diagnostic evidence: LinkedIn's left-hand search
  // results sidebar — a stack of multiple job CARDS concatenated together,
  // not a single job's description — was winning the generic fallback's
  // scoring. It's large (15,000+ characters) and contains enough scattered
  // keywords across all its stacked snippets ("requirements", "experience",
  // etc.) to score high, and since the top pinned/promoted card in that
  // list doesn't change as the user clicks through different jobs, this
  // silently explained why the same wrong title kept appearing regardless
  // of which job was actually selected. These are all strong, LinkedIn-
  // specific signatures of a job LIST rather than a single job's content.
  function looksLikeJobResultsList(text) {
    if (!text) return false;
    const badgeCount = (text.match(/\((verified job|actively hiring|actively recruiting|promoted)\)/gi) || []).length;
    if (badgeCount >= 2) return true;                          // multiple job cards, each with their own badge
    if (/^\s*\d+\+?\s*results\b/i.test(text.trim())) return true; // "99+ results" search-results header
    if (/connections work here/i.test(text)) return true;       // per-card LinkedIn network signal, repeats per listing
    if (/how promoted jobs are ranked/i.test(text)) return true; // LinkedIn's sponsored-jobs tooltip label
    if (/you.?d be a top applicant/i.test(text)) return true;   // LinkedIn Premium upsell banner
    if (/more likely to hear back/i.test(text)) return true;    // same upsell banner, alternate wording
    return false;
  }

  function detectJobDescription() {
    // On application form pages, don't scrape — the listing JD is cached.
    if (isApplicationFormPage()) return null;

    for (const sel of ATS_SELECTORS) {
      try {
        const el = document.querySelector(sel);
        if (el) {
          const text = cleanJobDescriptionText(el.innerText.trim());
          if (text.length > 200 && !looksLikeUiNoise(text) && !looksLikeJobResultsList(text)) {
            return text;
          }
        }
      } catch (_) {}
    }

    // A real single job description is rarely more than a few thousand
    // characters. The contamination that keeps winning here (first
    // LinkedIn's search-results sidebar, now a different upsell banner) is
    // large specifically BECAUSE it's multiple unrelated page sections
    // concatenated together — capping length targets that entire class of
    // "accidentally scraped a big container" bug generally, rather than
    // excluding LinkedIn's specific UI phrases one at a time forever.
    const MAX_SINGLE_JD_LEN = 10000;
    const candidates = Array.from(document.querySelectorAll('div, section, article'))
      .filter(el => {
        const t = el.innerText || '';
        return t.length > 400 && t.length <= MAX_SINGLE_JD_LEN &&
          /responsibilities|requirements|qualifications|about (the )?role|what you.ll do|we.re looking for/i.test(t) &&
          !looksLikeUiNoise(t) &&
          !looksLikeJobResultsList(t);   // exclude the search-results sidebar BEFORE it can win on score
      });

    if (candidates.length) {
      const scored = candidates.map(el => {
        const t = el.innerText;
        let score = 0;
        if (/responsibilities/i.test(t))   score += 3;
        if (/requirements/i.test(t))       score += 3;
        if (/qualifications/i.test(t))     score += 3;
        if (/experience/i.test(t))         score += 2;
        if (/skills/i.test(t))             score += 2;
        return { el, score, len: t.length };
      });
      // Prefer the SHORTEST candidate that ties on score, not the longest —
      // a bigger block scoring the same is more likely a larger container
      // spanning multiple sections, not a more complete single JD.
      scored.sort((a, b) => b.score - a.score || a.len - b.len);
      if (scored[0].score >= 3) {
        const cleaned = cleanJobDescriptionText(scored[0].el.innerText.trim().slice(0, 8000));
        if (cleaned.length > 200 && !looksLikeUiNoise(cleaned) && !looksLikeJobResultsList(cleaned)) return cleaned;
      }
    }
    return null;
  }

  // ── Job URL fingerprint ───────────────────────────────────

  function getJobFingerprint() {
    const url = window.location.href;
    // LinkedIn job page (direct)
    const li  = url.match(/linkedin\.com\/jobs\/view\/(\d+)/);
    if (li) return `linkedin_${li[1]}`;
    // LinkedIn search results — job panel opens via ?currentJobId=
    const liSearch = url.match(/[?&]currentJobId=(\d+)/);
    if (liSearch) return `linkedin_${liSearch[1]}`;
    // Greenhouse
    const gh  = url.match(/[?&]gh_jid=(\w+)/) || url.match(/greenhouse\.io\/.*?\/(\d+)/);
    if (gh) return `gh_${gh[1]}`;
    // Lever
    const lv  = url.match(/lever\.co\/.*?\/([a-f0-9-]{36})/);
    if (lv) return `lv_${lv[1]}`;
    // Workday
    const wd  = url.match(/myworkdayjobs\.com.*?\/(\w+)$/);
    if (wd) return `wd_${wd[1]}`;
    // Indeed
    const ind = url.match(/[?&]jk=([a-z0-9]+)/);
    if (ind) return `indeed_${ind[1]}`;
    // Ashby
    const ash = url.match(/ashbyhq\.com\/.*?\/([a-f0-9-]{36})/);
    if (ash) return `ash_${ash[1]}`;
    // Generic fallback — use full URL so every distinct URL gets its own fingerprint
    return `url_${url.replace(/[^a-z0-9]/gi, '_').slice(-80)}`;
  }

  // ── Cache JD ─────────────────────────────────────────────

  // ── Application Session ───────────────────────────────────
  // One session = one job application journey. It follows the user from the
  // LinkedIn listing → company careers page → external ATS form, carrying the
  // JD, chat history, tailored resume, and added skills. Keyed by a stable
  // sessionId so every page in the journey resolves to the same session.
  //
  // Storage shape:
  //   rpSession        = { sessionId, jd, jobTitle, company, fingerprints[],
  //                        chatHistory[], addedSkills[], applied, appliedAt, ts,
  //                        // the work product — shared so every page shows the
  //                        // same resume, the same score, the same gaps
  //                        tailoredResume, pdfBase64, atsAnalysis, missingKinds,
  //                        placedSkills[], listedOnlySkills[], notesShown{} }
  //   rpSessionArchive = { [sessionId]: session }   (completed applications)

  const SESSION_TTL_MS = 90 * 60 * 1000; // 90 minutes of inactivity

  function makeSessionId(jd, company) {
    // Stable hash from the JD's first 200 chars + company — same job always
    // yields the same id, even across different domains/URLs.
    const seed = `${(company || '').toLowerCase()}|${(jd || '').slice(0, 200).replace(/\s+/g, ' ').trim().toLowerCase()}`;
    let h = 0;
    for (let i = 0; i < seed.length; i++) { h = ((h << 5) - h) + seed.charCodeAt(i); h |= 0; }
    return `s_${Math.abs(h).toString(36)}`;
  }

  async function getSession() {
    const stored = await storageGet(['rpSession']);
    const s = stored.rpSession;
    if (!s) return null;
    if (Date.now() - (s.ts || 0) > SESSION_TTL_MS) return null; // expired
    return s;
  }

  async function saveSession(patch) {
    const current = (await getSession()) || {};
    const merged = { ...current, ...patch, ts: Date.now() };
    await storageSet({ rpSession: merged });
    return merged;
  }

  // Start (or resume) a session for the JD detected on this page.
  // A session's identity must be trustworthy — it drives "you already applied
  // to X" and the tracker. Reject anything that looks like page chrome.
  function isValidJobIdentity(jobTitle, company) {
    if (!jobTitle || !company) return false;
    if (jobTitle === 'Unknown Role' || company === 'Unknown Company') return false;
    // Title must not be navigation text or a bare result count.
    if (NOT_A_JOB_TITLE.test(jobTitle)) return false;
    if (/^\d+\+?\s*(results?|jobs?|matches?)/i.test(jobTitle)) return false;
    if (jobTitle.length < 6 || jobTitle.length > 90) return false;
    // Company must not be the platform itself.
    if (/^(linkedin|indeed|glassdoor|greenhouse|lever|ashby|workday|smartrecruiters|monster|ziprecruiter)$/i.test(company)) return false;
    if (company.includes('.')) return false;
    return true;
  }

  // Does this page's URL belong to the company we're applying to?
  //
  // Once LinkedIn tells us the company, every subsequent page in the journey
  // usually names it somewhere in the URL — careers.servicenow.com,
  // ashbyhq.com/hackerone, smartrecruiters.com/company/ServiceNow. Matching on
  // that is a strong "same journey" signal and lets us carry the JD forward.
  //
  // It is not sufficient on its own: Workday hides the company behind opaque
  // paths. So this is one signal among several, not the only gate.
  function urlBelongsToCompany(company) {
    if (!company) return false;
    const canon = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    const target = canon(company);
    if (target.length < 3) return false;   // "HP", "3M" — too short to match safely

    // Drop corporate suffixes so "DoorDash USA" can meet the slug "doordash".
    const stem = target.replace(/(incorporated|inc|llc|corp|ltd|limited|usa|global|group|holdings|technologies|labs|co)$/, '');
    const forms = [target, stem].filter(f => f.length >= 3);

    // Match against URL *tokens*, not the raw string. A naive substring test
    // ("does the URL contain 'apple'?") matches pineapple.io, dropbox.com for
    // "Box", and metabase.com for "Meta". Tokens make the boundary explicit.
    let tokens = [];
    try {
      const u = new URL(window.location.href);
      tokens = [
        ...u.hostname.split('.'),        // careers, servicenow, com
        ...u.pathname.split('/'),        // '', doordashusa, jobs, 8013249
        ...(u.search.match(/[a-zA-Z0-9_-]{3,}/g) || []),   // ?company=ServiceNow
      ];
    } catch (_) {
      tokens = window.location.href.split(/[/.?&=_-]+/);
    }

    const canonTokens = tokens.map(canon).filter(t => t.length >= 3);

    // Suffixes a company legitimately appends to its own ATS slug.
    // Anything else appended makes it a different word — "meta" + "base"
    // is Metabase, not Meta.
    const SLUG_SUFFIX = /^(usa|us|uk|inc|llc|corp|co|ltd|global|group|careers|jobs|hq|team|talent|hiring|eng|labs|technologies|tech)$/;

    return canonTokens.some(tok =>
      forms.some(form => {
        if (tok === form) return true;

        // Slug extends the company name — allowed only by a known suffix.
        // "doordashusa" → "doordash" + "usa" ✓ ;  "metabase" → "meta" + "base" ✗
        if (tok.startsWith(form)) {
          const rest = tok.slice(form.length);
          return SLUG_SUFFIX.test(rest);
        }

        // Company name carries a suffix its slug dropped.
        // "Eight Sleep Inc" → "eightsleepinc", slug is "eightsleep".
        if (form.startsWith(tok)) {
          const rest = form.slice(tok.length);
          return SLUG_SUFFIX.test(rest);
        }

        return false;
      })
    );
  }

  // How similar are two job descriptions? Cheap token-overlap — enough to tell
  // "the same job, described on a different page" from "a different job".
  function jdSimilarity(a, b) {
    if (!a || !b) return 0;
    const norm = s => new Set(
      s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3)
    );
    const A = norm(a.slice(0, 1500));
    const B = norm(b.slice(0, 1500));
    if (!A.size || !B.size) return 0;
    let shared = 0;
    A.forEach(w => { if (B.has(w)) shared++; });
    return shared / Math.min(A.size, B.size);
  }

  // Do two job TITLES look like different roles? JD bodies share a lot of
  // generic scaffolding language ("requires 5 years experience", "cross-
  // functional teams") even across genuinely different postings, which
  // makes jdSimilarity alone unreliable for telling two roles at the same
  // company apart. Titles are short and precise — strip only level/seniority
  // qualifiers (keep role-family words like "engineer"/"manager", since
  // those ARE meaningful) and compare what's left.
  const LEVEL_WORD = new Set(['senior','sr','staff','principal','junior','jr','associate','i','ii','iii','iv','v','entry','mid','lead','full','time','part']);
  function titlesDiffer(a, b) {
    const normalize = s => String(s || '')
      .replace(/\([^)]*\)/g, ' ')
      .replace(/[-–—|,]/g, ' ')
      .replace(/\b(remote|hybrid|on-?site|full-?time|part-?time|contract|united states|usa|us)\b/gi, ' ')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1 && !LEVEL_WORD.has(w));
    const wordsA = new Set(normalize(a));
    const wordsB = new Set(normalize(b));
    // If nothing distinctive survives on either side, we can't tell —
    // don't veto, let the other signals decide.
    if (!wordsA.size || !wordsB.size) return false;
    let shared = 0;
    wordsA.forEach(w => { if (wordsB.has(w)) shared++; });
    return (shared / Math.min(wordsA.size, wordsB.size)) < 0.4;
  }

  async function startOrResumeSession(jd) {
    if (!jd || jd.trim().length < 150) return null;   // too thin to be a real JD

    const existing = await getSession();
    const recent = existing && (Date.now() - (existing.ts || 0)) < SESSION_TTL_MS;

    // ── Are we still in the same application journey? ──
    //
    // The user's path is: LinkedIn listing → company careers page → ATS form.
    // Each page describes the job differently, so hashing the text and
    // comparing gives a different id every hop. Instead, ask whether this page
    // plausibly belongs to the job we already have open.
    if (existing && recent && !existing.applied && existing.jd) {
      const fp = getJobFingerprint();
      const existingFps = Array.isArray(existing.fingerprints) ? existing.fingerprints : [];
      const platformOf = f => (f || '').split('_')[0];
      const samePlatform = fp && existingFps.some(f => platformOf(f) === platformOf(fp));

      if (samePlatform) {
        // Same platform (e.g. both linkedin_...) means the ID itself is a
        // direct, unambiguous comparison — already seen this exact page, or
        // a genuinely different posting. Fuzzy text/title similarity has no
        // business overriding that: AI/ML job titles in particular share so
        // much vocabulary ("AI Software Engineer II" vs "AI Native Software
        // Engineer" vs "Software Engineer - AI") that similarity scoring
        // reliably mistakes them for the same role. Trust the ID.
        if (existingFps.includes(fp)) {
          return await saveSession({ fingerprints: existingFps });
        }
        // Different ID, same platform → definitely a different job. Fall
        // through to start fresh — no fuzzy check needed or wanted.
      } else {
        // ── Genuinely cross-platform (e.g. LinkedIn → company careers site) ──
        // No direct ID comparison is possible here — this is the actual case
        // fuzzy matching exists for, since the same job legitimately gets a
        // different URL structure, and therefore a different fingerprint
        // prefix, on each platform.
        const sameCompanyUrl = urlBelongsToCompany(existing.company);

        // "Clicked Apply from LinkedIn" case: user lands on the company's own
        // application form (or a sign-in / OTP / review step on the way to
        // one). These pages usually carry a short header blurb that scrapes
        // as a "JD" but shares almost no vocabulary with the actual posting,
        // so a similarity check reliably scores low and the old session gets
        // archived — the user then sees an empty panel on the resume-upload
        // step. If the URL is same-company AND matches an application-form
        // pattern, that's a strong enough signal on its own; skip the
        // similarity check and keep the session.
        if (sameCompanyUrl && isApplicationFormPage()) {
          const fps = existingFps;
          if (fp && !fps.includes(fp)) fps.push(fp);
          return await saveSession({ fingerprints: fps });
        }

        const sim = jdSimilarity(existing.jd, jd);
        const freshTitle = extractPageTitle(window.location.hostname);
        const titlesClash = existing.jobTitle && freshTitle && titlesDiffer(existing.jobTitle, freshTitle);

        if (!titlesClash && (sim >= 0.45 || (sameCompanyUrl && sim >= 0.15))) {
          const fps = existingFps;
          if (fp && !fps.includes(fp)) fps.push(fp);
          return await saveSession({ fingerprints: fps });
        }
      }
      // Neither matched → a genuinely different job. Fall through and start fresh.
    }

    // ── A new job. Identify it, then open a session. ──
    //
    // Identity comes from the AI reading the JD, requested asynchronously. Until
    // it lands we hold a provisional identity so nothing depends on page chrome.
    // Prefer the page's own heading — same reasoning as notifyPanelJD.
    const provisionalTitle = extractPageTitle(window.location.hostname) || safeTitleFallback();
    const provisionalCompany = extractCompany(document.title || '', window.location.hostname);

    if (existing && !existing.applied) await archiveSession(existing);

    const sessionId = makeSessionId(jd, provisionalCompany);
    const fp = getJobFingerprint();

    return await saveSession({
      sessionId, jd,
      jobTitle: provisionalTitle,
      company: provisionalCompany,
      identityConfirmed: false,       // upgraded when the AI reports back
      fingerprints: fp ? [fp] : [],
      chatHistory: [], addedSkills: [],
      applied: false, appliedAt: null,
      // saveSession MERGES with whatever's currently stored, and archiving
      // the old session only COPIES it — the original stays in place. Every
      // one of these must be explicitly cleared here, or the previous job's
      // resume, score, and gaps silently survive into this "new" session.
      tailoredResume: null, pdfBase64: null, atsAnalysis: null,
      missingKinds: {}, placedSkills: [], listedOnlySkills: [],
      notesShown: {}
    });
  }

  // The AI reads role + company straight from the JD, which beats scraping page
  // furniture. Called once the first evaluation returns. The session's identity
  // is what the tracker records, so getting it right matters.
  async function confirmSessionIdentity(jobTitle, company) {
    if (!jobTitle && !company) return;
    const s = await getSession();
    if (!s || s.identityConfirmed) return;
    const patch = { identityConfirmed: true };
    // The AI's title, read directly from the JD text, is far more reliable
    // than the DOM/prose heuristics used for the initial "New job detected"
    // announcement — those can be wrong when a site changes its page
    // structure. If this is a genuine correction (not just confirming the
    // same value), tell the panel so it can fix what's actually displayed,
    // not just the session data used for the tracker.
    const titleChanged = jobTitle && s.jobTitle && jobTitle.trim() !== s.jobTitle.trim();
    if (jobTitle) patch.jobTitle = jobTitle;
    if (company)  patch.company  = company;
    await saveSession(patch);
    if (titleChanged && panelIframe?.contentWindow) {
      panelIframe.contentWindow.postMessage({ rp_push: 'TITLE_CORRECTED', jobTitle }, '*');
    }
  }

  // Resolve the session for a page with NO detectable JD (the ATS form page).
  // Matched by fingerprint if we've seen this page, otherwise the live session.
  async function resolveSessionForPage() {
    const s = await getSession();
    if (!s) return null;

    // Rule: as long as this page did NOT surface a new JD of its own (the
    // caller only invokes us in that case), keep showing whatever the open
    // session already has — resume, chat, score, everything. Login pages,
    // OTP screens, EEO forms, review steps, unfamiliar ATS chrome all fall
    // under "no new JD" and should not clear the panel.
    //
    // The earlier guards (TTL, sameCompany, fingerprint-seen, 20-min window)
    // were meant to prevent resurrecting a stale session onto an unrelated
    // page, but in practice they caused mid-application drops that were
    // worse than any resurrection: the user reached the resume-upload step
    // with an empty panel. A new JD, when it does appear, replaces this
    // session via startOrResumeSession — that's the intended eviction path.
    //
    // Record the fingerprint so subsequent lookups know we've walked
    // through this page.
    const fp = getJobFingerprint();
    const fps = Array.isArray(s.fingerprints) ? s.fingerprints : [];
    if (fp && !fps.includes(fp)) {
      fps.push(fp);
      await saveSession({ fingerprints: fps });
    }
    return s;
  }

  async function archiveSession(session) {
    if (!session?.sessionId) return;
    // Never archive a session we couldn't name — it would resurface as a
    // false "you already applied to X" banner.
    if (!isValidJobIdentity(session.jobTitle, session.company)) return;
    const stored = await storageGet(['rpSessionArchive']);
    const archive = stored.rpSessionArchive || {};
    archive[session.sessionId] = session;
    const keys = Object.keys(archive);
    if (keys.length > 50) delete archive[keys[0]];
    await storageSet({ rpSessionArchive: archive });
  }

  // One-time cleanup: earlier builds could store sessions named from page
  // chrome ("99+ results" at "LinkedIn"). Purge those so they stop surfacing.
  async function purgePoisonedSessions() {
    const stored = await storageGet(['rpSession', 'rpSessionArchive', '_rpSessionsPurged_v3']);
    if (stored._rpSessionsPurged_v3) return;
    const patch = { _rpSessionsPurged_v3: 1 };

    const badJd = stored.rpSession && (!stored.rpSession.jd || stored.rpSession.jd.trim().length < 150);
    if (stored.rpSession && (badJd || !isValidJobIdentity(stored.rpSession.jobTitle, stored.rpSession.company))) {
      patch.rpSession = null;   // stale/empty session from an earlier broken build
    }
    // Wipe the archive outright rather than filter it. Today's fixes touched
    // the confirmation detector, the session model, and the identity logic —
    // any "applied" entry from before this point can't be trusted (the
    // tracker, a separate log, is the real record and is unaffected by this).
    patch.rpSessionArchive = {};
    await storageSet(patch);
  }

  // Look up an archived (completed) session for this page's job.
  async function findArchivedSession(jd, company) {
    if (!jd || jd.trim().length < 150) return null;
    if (!company || /^(linkedin|indeed|glassdoor|greenhouse|lever|ashby|workday|smartrecruiters)$/i.test(company)) return null;
    const sessionId = makeSessionId(jd, company);
    const stored = await storageGet(['rpSessionArchive']);
    const found = stored.rpSessionArchive?.[sessionId] || null;
    // Never surface a poisoned entry ("Applied to 99+ results at LinkedIn").
    if (found && !isValidJobIdentity(found.jobTitle, found.company)) return null;
    return found;
  }

  // Mark the current session as applied and archive it.
  async function markSessionApplied() {
    const s = await getSession();
    if (!s || s.applied) return null;
    const applied = { ...s, applied: true, appliedAt: Date.now() };
    await archiveSession(applied);
    await storageSet({ rpSession: applied });
    return applied;
  }

  async function cacheJD(jd, reliableTitle = null) {
    if (!isContextValid()) return;
    const key      = getJobFingerprint();
    const docTitle = document.title || '';
    // Prefer the title read from the page's own heading element. Only fall
    // back to guessing from JD prose if that element wasn't found.
    const jobTitle  = reliableTitle || extractFirstLine(jd);
    const company   = extractCompany(docTitle, window.location.hostname);

    // Resolve the session FIRST. If this page belongs to a journey we already
    // opened, the session's JD is LOCKED — the page that first captured it
    // (almost always the LinkedIn listing) is the one and only source, for
    // every page that follows, until the user picks a different job.
    //
    // Earlier this compared lengths and let a "richer-looking" later page
    // overwrite the session's JD. That was still two competing scanners
    // fighting over the same session, just with a tie-breaker — and a
    // sidebar-truncated or partial read on a later page could still win the
    // comparison and quietly replace a perfectly good captured JD. Simpler
    // and correct: whoever captured it first owns it. Full stop.
    const session = await startOrResumeSession(jd);
    const sessionOwnsThisJob = session && !session.applied && session.jd;
    const authoritativeJd = sessionOwnsThisJob ? session.jd : jd;

    const entry = {
      jd: authoritativeJd,
      url: window.location.href, title: docTitle,
      jobTitle: session?.jobTitle || jobTitle,
      company:  session?.company  || company,
      ts: Date.now()
    };
    await storageSet({ [`jd_${key}`]: entry, jd_last: entry, rpActiveJob: entry });
  }

  // ── Recover cached JD (for ATS pages after LinkedIn nav) ──
  // Priority: exact fingerprint match → active session → last seen.
  async function recoverCachedJD() {
    if (!isContextValid()) return null;
    const key    = getJobFingerprint();
    const stored = await storageGet([`jd_${key}`, 'rpActiveJob', 'jd_last']);
    const byKey  = stored[`jd_${key}`];
    if (byKey?.jd) return byKey.jd;
    const active = stored.rpActiveJob;
    if (active?.jd && (Date.now() - active.ts) < 45 * 60 * 1000) return active.jd;
    const last = stored.jd_last;
    if (last?.jd && (Date.now() - last.ts) < 30 * 60 * 1000) return last.jd;
    return null;
  }

  // ── Apply Button Watcher ──────────────────────────────────

  // Apply button patterns — excludes "Easy Apply" which only opens the modal,
  // not the actual submission. LinkedIn Easy Apply submissions are caught by
  // the confirmation modal observer below.
  const APPLY_PATTERNS = [
    /^apply(\s+now)?$/i,
    /^submit(\s+application)?$/i,
    /^quick apply$/i,
    /^1-click apply$/i,
    /^apply on company site$/i,
    /^apply for (this )?job$/i,
  ];

  function isApplyButton(el) {
    if (!['BUTTON', 'A', 'INPUT'].includes(el.tagName)) return false;
    const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
    return APPLY_PATTERNS.some(p => p.test(text));
  }

  // ── LinkedIn Easy Apply confirmation detector ─────────────
  // When LinkedIn shows "Your application was sent to [Company]!"
  // that's the authoritative signal the application was actually submitted.
  // We extract the company name directly from that text.
  let confirmationObserver = null;
  function watchLinkedInConfirmation() {
    if (confirmationObserver) return;
    confirmationObserver = new MutationObserver(() => {
      if (!isContextValid()) { confirmationObserver.disconnect(); return; }
      const allText = document.body.innerText || '';
      const match = allText.match(/Your application was sent to ([^!\n]+)!/);
      if (!match) return;
      const company = match[1].trim();
      if (!company || company.length > 60) return; // sanity check
      const key = `li_confirm_${company}`;
      if (watchLinkedInConfirmation[key] && Date.now() - watchLinkedInConfirmation[key] < 30000) return;
      watchLinkedInConfirmation[key] = Date.now();
      const fp = getJobFingerprint();
      // Use cached JD for an accurate job title (document.title on LinkedIn is
      // usually "N notifications | LinkedIn" — useless).
      chrome.storage.local.get([`jd_${fp}`, 'jd_last'], (stored) => {
        const cached = stored[`jd_${fp}`] || stored['jd_last'];
        let jobTitle = cached?.jobTitle || (detectedJD ? extractFirstLine(detectedJD) : 'Applied position');
        if (!isContextValid()) return;
        try {
          chrome.runtime.sendMessage({
            type: 'APPLICATION_SUBMITTED',
            jobTitle,
            company,
            url: window.location.href,
            fingerprint: fp,
            source: 'LinkedIn'
          }).catch(() => {});
        } catch (_) {}
      });
    });
    confirmationObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // Start watching for LinkedIn confirmation on linkedin.com
  if (window.location.hostname.includes('linkedin.com')) {
    watchLinkedInConfirmation();
  }

  document.addEventListener('click', async (e) => {
    if (!isContextValid()) return;
    const target = e.target.closest('button, a, input[type="submit"]');
    if (!target || !isApplyButton(target)) return;
    // Clicking Apply just opens the application form — it is NOT a submission.
    // We only cache the JD here so the resume can be tailored. The actual
    // tracker logging happens on the confirmation page / success message.
    const jd = detectedJD || detectJobDescription();
    if (jd) {
      detectedJD = jd;
      await cacheJD(jd);
      safeSendMessage({ type: 'JD_DETECTED', jd });
    }
  }, true);

  // ── File Upload Injection ─────────────────────────────────

  function watchFileInputs() {
    const observer = new MutationObserver(() => {
      if (!isContextValid()) { observer.disconnect(); return; }
      document.querySelectorAll('input[type="file"]').forEach(inp => {
        if (!inp._rpWatched) { inp._rpWatched = true; maybeAddResumeBtn(inp); }
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    document.querySelectorAll('input[type="file"]').forEach(inp => {
      if (!inp._rpWatched) { inp._rpWatched = true; maybeAddResumeBtn(inp); }
    });
  }

  function detectFileFieldKind(input) {
    const label = getFieldLabel(input);
    const isCoverLetter = /cover.?letter|motivation letter|letter of interest|personal statement/i.test(label);
    const isResume = /resume|curriculum vitae|\bcv\b/i.test(label);
    if (isCoverLetter && !isResume) return 'cover-letter';
    if (isResume && !isCoverLetter) return 'resume';
    return 'unknown'; // ambiguous or unlabeled — caller resolves via preferredKind
  }

  // preferredKind: what an AMBIGUOUS/unlabeled field should default to, when
  // the caller knows the user's specific intent (which button they clicked,
  // or which PDF just became available). Passive background scans
  // (watchFileInputs, the mutation observer) have no such intent and keep
  // the historical default of 'resume' — the common case of one plainly-
  // labeled upload field on a form.
  //
  // Without this, a page with a single unlabeled file field would ALWAYS
  // get a "Use Tailored Resume" button — added the moment the resume PDF
  // became available, or on first page scan — and clicking "Cover letter
  // Inject" later would find that same button already sitting there,
  // never becoming a cover-letter button. That's the bug: the inject
  // buttons matched whichever PDF happened to populate first, not what
  // the user actually asked for.
  function maybeAddResumeBtn(input, preferredKind = 'resume') {
    if (input._rpBtn) return null;
    const kind = detectFileFieldKind(input);

    if (kind === 'cover-letter') {
      if (!coverLetterPdfB64) return null; // nothing to inject yet — don't add a button that does nothing
      addFileInjectButton(input, '✦ Use Tailored Cover Letter', coverLetterPdfB64, 'cover_letter.pdf');
      input._rpBtnKind = 'cover-letter';
      return 'cover-letter';
    }

    if (kind === 'resume') {
      if (!tailoredPdfB64) return null;
      addFileInjectButton(input, '✦ Use Tailored Resume', tailoredPdfB64, tailoredFilename);
      input._rpBtnKind = 'resume';
      return 'resume';
    }

    // Ambiguous/unlabeled field — resolve using the caller's stated intent.
    if (preferredKind === 'cover-letter') {
      if (!coverLetterPdfB64) return null;
      addFileInjectButton(input, '✦ Use Tailored Cover Letter', coverLetterPdfB64, 'cover_letter.pdf');
      input._rpBtnKind = 'cover-letter';
      return 'cover-letter';
    }
    if (!tailoredPdfB64) return null;
    addFileInjectButton(input, '✦ Use Tailored Resume', tailoredPdfB64, tailoredFilename);
    input._rpBtnKind = 'resume';
    return 'resume';
  }

  function addFileInjectButton(input, label, pdfBase64, filename) {
    const btn = document.createElement('button');
    btn.textContent = label;
    Object.assign(btn.style, {
      marginLeft: '8px', padding: '6px 14px',
      background: '#1a3a8f', color: '#fff',
      border: 'none', borderRadius: '6px',
      fontSize: '13px', fontWeight: '600',
      cursor: 'pointer', zIndex: '999999',
      verticalAlign: 'middle'
    });
    btn.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      await injectFile(input, pdfBase64, filename, label);
    });
    input.parentNode.insertBefore(btn, input.nextSibling);
    input._rpBtn = btn;
  }

  async function injectFile(fileInput, pdfBase64, filename, originalLabel) {
    if (!pdfBase64) return;
    const bytes = Uint8Array.from(atob(pdfBase64), c => c.charCodeAt(0));
    const file  = new File([bytes], filename, { type: 'application/pdf' });
    const dt    = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    fileInput.dispatchEvent(new Event('input',  { bubbles: true }));
    fileInput._rpBtn.textContent = '✓ Injected!';
    fileInput._rpBtn.style.background = '#1a7a3f';
    setTimeout(() => {
      if (fileInput._rpBtn) {
        fileInput._rpBtn.textContent = originalLabel;
        fileInput._rpBtn.style.background = '#1a3a8f';
      }
    }, 3000);
    // NOTE: We intentionally do NOT log to the tracker on inject.
    // Injecting a resume just fills the form field — the user hasn't
    // submitted yet (and may hit an error). Tracker logging happens ONLY
    // on a genuine confirmation page / success message (see the standalone
    // trackApplicationSubmission IIFE at the top of this file).
  }

  // ── Cover Letter Injection ────────────────────────────────

  const CL_PATTERNS = [
    /cover.?letter/i,
    /motivation letter/i,
    /letter of interest/i,
    /personal statement/i,
    /why (do you want|are you interested|should we|you('?re| are))/i,
    /what makes you( a)? (good|great|strong) fit/i,
    /tell us (about yourself|why|more about)/i,
    /introduce yourself/i,
    /additional (information|comments|details|notes?)/i,
    /anything else you('?d| would) like (us )?to (know|share|add)/i,
    /message (to|for) (the )?(hiring|recruiter|team)/i,
    /note to (the )?(hiring manager|recruiter|team)/i,
    /optional message/i
  ];

  function getFieldLabel(el) {
    const parts = [
      el.placeholder || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('name') || '',
      el.getAttribute('id') || ''
    ];
    if (el.id) {
      const lbl = document.querySelector(`label[for="${el.id}"]`);
      if (lbl) parts.push(lbl.innerText);
    }
    let parent = el.parentElement;
    for (let i = 0; i < 3 && parent; i++) {
      parts.push(parent.innerText?.slice(0, 200) || '');
      parent = parent.parentElement;
    }
    return parts.join(' ');
  }

  function watchCoverLetterFields() {
    const observer = new MutationObserver(() => {
      if (!isContextValid()) { observer.disconnect(); return; }
      scanCLFields();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    scanCLFields();
  }

  const knownCLFields = new Set();

  function scanCLFields() {
    let found = false;
    const claimed = new Set(); // textareas already matched by label, or already known
    document.querySelectorAll('textarea, [contenteditable="true"]').forEach(el => {
      if (!CL_PATTERNS.some(p => p.test(getFieldLabel(el)))) return;
      found = true;
      claimed.add(el);
      knownCLFields.add(el);
      // Only auto-fill the FIRST time a field is discovered. This function
      // also runs from a MutationObserver on every DOM change, which fires
      // constantly on a real page — auto-filling on every pass would silently
      // overwrite anything the user typed into the field themselves after
      // the first fill.
      if (el._rpCLWatched) return;
      el._rpCLWatched = true;
      if (coverLetterText) fillCL(el);
      addCLButton(el);
    });

    // Fallback: label-pattern matching keeps missing real cover letter
    // fields across different ATS platforms, however many phrasings get
    // added to the pattern list. A more reliable signal doesn't depend on
    // the label at all — a cover letter field is nearly always the ONE
    // substantial, multi-row textarea on an application page (name/email/
    // phone are single-line; a genuine long-form field stands out by shape,
    // not by wording). Only acts when there's exactly one such candidate —
    // multiple would be too ambiguous to guess between safely.
    if (!found) {
      const candidates = Array.from(document.querySelectorAll('textarea')).filter(el => {
        if (claimed.has(el) || el._rpCLWatched) return false;
        if (el.offsetHeight === 0 || el.offsetParent === null) return false; // hidden
        const rows = parseInt(el.getAttribute('rows') || '0', 10);
        return rows >= 3 || el.offsetHeight >= 80;
      });
      if (candidates.length === 1) {
        found = true;
        const el = candidates[0];
        knownCLFields.add(el);
        el._rpCLWatched = true;
        el._rpCLUncertain = true; // never auto-filled, even on a later refill — must be confirmed via the button
        addCLButton(el, true); // true = uncertain match, label says so
      }
    }
    return found;
  }

  // Explicit re-fill: the user clicked Inject again (e.g. after regenerating
  // the letter). Unlike the passive scan above, this is a deliberate action
  // and should always overwrite, even for fields already discovered.
  function refillKnownCLFields() {
    let filled = false;
    knownCLFields.forEach(el => {
      if (el._rpCLUncertain) return; // requires an explicit button click, never auto-filled
      if (document.body.contains(el) && coverLetterText) { fillCL(el); filled = true; }
    });
    return filled;
  }

  function addCLButton(textarea, uncertain = false) {
    if (textarea._rpCLBtn) return;
    const btn = document.createElement('button');
    btn.textContent = uncertain ? '✦ Use as Cover Letter?' : '✦ Fill Cover Letter';
    Object.assign(btn.style, {
      display: 'block', marginTop: '6px', padding: '6px 14px',
      background: '#6b1a8f', color: '#fff',
      border: 'none', borderRadius: '6px',
      fontSize: '13px', fontWeight: '600',
      cursor: 'pointer', zIndex: '999999'
    });
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      fillCL(textarea);
    });
    textarea.parentNode.insertBefore(btn, textarea.nextSibling);
    textarea._rpCLBtn = btn;
  }

  function fillCL(textarea) {
    if (!coverLetterText) return;
    if (textarea.tagName === 'TEXTAREA') {
      textarea.value = coverLetterText;
      textarea.dispatchEvent(new Event('input',  { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      textarea.innerText = coverLetterText;
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    if (textarea._rpCLBtn) {
      textarea._rpCLBtn.textContent = '✓ Filled!';
      textarea._rpCLBtn.style.background = '#1a7a3f';
      setTimeout(() => {
        if (textarea._rpCLBtn) {
          textarea._rpCLBtn.textContent = '✦ Fill Cover Letter';
          textarea._rpCLBtn.style.background = '#6b1a8f';
        }
      }, 3000);
    }
  }

  // ── Message bus ───────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!isContextValid()) return;

    if (msg.type === 'GET_JD') {
      const live = detectJobDescription();
      if (live) detectedJD = live;

      if (detectedJD) {
        sendResponse({ jd: detectedJD });
        return true;
      }

      // No live JD — try cache (ATS page after LinkedIn navigation)
      recoverCachedJD().then(cached => {
        if (cached) detectedJD = cached;
        sendResponse({ jd: cached || null, fromCache: !!cached });
      }).catch(() => sendResponse({ jd: null }));
      return true;
    }

    if (msg.type === 'SET_TAILORED_PDF') {
      tailoredPdfB64 = msg.pdfBase64;
      if (msg.filename) tailoredFilename = msg.filename;
      document.querySelectorAll('input[type="file"]').forEach(inp => {
        if (!inp._rpBtn) maybeAddResumeBtn(inp, 'resume');
      });
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'SET_COVER_LETTER_PDF') {
      coverLetterPdfB64 = msg.pdfBase64;
      document.querySelectorAll('input[type="file"]').forEach(inp => {
        if (!inp._rpBtn) maybeAddResumeBtn(inp, 'cover-letter');
      });
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'SET_COVER_LETTER') {
      coverLetterText = msg.text;
      scanCLFields();
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'GET_PAGE_URL') {
      sendResponse({ url: window.location.href, title: document.title });
      return true;
    }
  });

  // ── Live profile updates → push to panel ──────────────────
  // When the user completes onboarding (sets up their profile), they navigate
  // back to the job page. Without this, the panel still shows "No resume
  // uploaded yet" until a manual page refresh. chrome.storage.onChanged
  // fires in the content script context whenever storage is written from
  // any extension page, so we can push the update to the panel immediately.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.resumeData || changes.userName) {
      chrome.storage.local.get(['resumeData', 'userName', '_silentSkillUpdate'], stored => {
        // Suppress PROFILE_UPDATED when the change was a skill addition.
        // The flag is a timestamp; while it's recent (<5s), ALL resumeData
        // changes are treated as silent skill writes. We do NOT clear it on
        // first read — otherwise rapid successive skill writes (6 at once)
        // would each fire the message after the first one cleared the flag.
        const isSilent = stored._silentSkillUpdate && (Date.now() - stored._silentSkillUpdate) < 5000;
        if (isSilent) return; // let the flag expire naturally by time
        if (stored.resumeData) {
          // Only push a JD if we actually have one — never wipe the panel's
          // recovered JD with null (notifyPanelJD already guards this).
          notifyPanelJD(detectedJD);
          panelIframe?.contentWindow?.postMessage({
            rp_push: 'PROFILE_UPDATED',
            resumeData: stored.resumeData,
            userName: stored.userName || null,
            announce: true  // genuine profile change (onboarding), show the message
          }, '*');
        }
      });
    }
  });

  // Navigation links, buttons, and page chrome that are never job titles.
  const NOT_A_JOB_TITLE = /^(see all|view all|back to|all jobs|browse|search|apply now|apply|share|save|print|home|careers?|jobs?|menu|skip to|sign in|log ?in|register|about us|contact|overview|benefits|culture|life at|our team|who we are|join us|welcome|posted|share this|email this|similar jobs|related jobs|next|previous|show more|read more|learn more)\b/i;

  // LinkedIn job-card badges ("Verified job", "Actively hiring", "Promoted")
  // appear inline on job cards — including sidebar "similar jobs" suggestion
  // cards, not just the main posting. A real job title never contains one,
  // and unlike NOT_A_JOB_TITLE (which only checks the start of the text),
  // this checks anywhere in it, since the badge is appended at the end.
  const HAS_JOB_CARD_BADGE = /\((verified job|actively hiring|actively recruiting|promoted|easy apply)\)/i;

  // Section headers from a JD ("Position Overview:", "Requirements:") caught
  // mid-render, before the real title loaded. A real job title is never just
  // a heading fragment ending in a colon.
  function looksLikeSectionHeader(line) {
    const t = line.trim();
    if (/:\s*$/.test(t)) return true;
    if (/^(position overview|about the role|about this role|what you.?ll do|responsibilities|requirements|qualifications|the role|summary|job summary|about the team|about us)\s*:?\s*$/i.test(t)) return true;
    // Broader check: a short line CONTAINING a section-header signal word,
    // even with extra words around it ("Key Responsibilities", "What We
    // Are Looking For", "Who You Are", "Core Requirements") — not just an
    // exact match. Only applies to short lines (a real title is rarely a
    // full sentence), and never overrides a line that also contains a real
    // job-title word, so a legitimate title mentioning "requirements" or
    // similar in context isn't wrongly rejected.
    if (t.length <= 45 && !JOB_TITLE_HINT.test(t) &&
        /\b(responsibilit(y|ies)|requirements?|qualifications?|what (you|we)|who you are|about (the|this)|overview|benefits|day.?to.?day)\b/i.test(t)) {
      return true;
    }
    return false;
  }

  // Prose-guessing a title from JD body text has failed in five distinct,
  // different ways across many rounds — sidebar badges, results-list
  // contamination, upsell banners, section headers, and ordinary bullet
  // sentences that happen to contain a word like "lead" or "senior" used
  // as a normal verb/adjective, not a title prefix ("Ability to LEAD
  // projects" matching the same pattern as "LEAD Engineer"). There is no
  // finite list of exclusion patterns that fixes this — the flaw isn't a
  // missing pattern, it's asking a keyword heuristic to do something only
  // real language understanding can do reliably. Rather than keep guessing
  // a specific-sounding-but-possibly-wrong title, this is honest about
  // what's actually known: the company name, extracted via a separate,
  // DOM-based mechanism (not prose-guessing) that's been independently
  // hardened and confirmed correct across many ATS platforms. The real,
  // specific title still arrives promptly via the AI-based correction
  // (SESSION_CONFIRM_IDENTITY) once the user tailors — this only changes
  // what shows before that happens.
  function safeTitleFallback() {
    const company = extractCompany(document.title || '', window.location.hostname);
    if (company && company !== 'Unknown Company') return `New role at ${company}`;
    return 'New role';
  }

  // Words that commonly appear in real job titles — used as a positive signal.
  const JOB_TITLE_HINT = /\b(engineer|developer|scientist|analyst|manager|director|architect|designer|consultant|specialist|lead|principal|senior|staff|associate|intern|coordinator|administrator|technician|researcher|strategist|officer|president|head of|vp|advocate|evangelist|writer|recruiter|producer)\b/i;

  function extractFirstLine(text) {
    if (!text) return 'Unknown Role';
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

    const plausible = lines.slice(0, 20).filter(line =>
      line.length >= 6 && line.length <= 90 &&
      !NOT_A_JOB_TITLE.test(line) &&
      !looksLikeSectionHeader(line) &&
      !HAS_JOB_CARD_BADGE.test(line) &&
      !/^(remote|hybrid|on.?site|full.?time|part.?time|contract|\$|http|about|we are|\d+\s)/i.test(line) &&
      !/^[^a-z]*$/i.test(line)              // not just symbols/numbers
    );

    // Strongly prefer a line that actually looks like a job title.
    const titled = plausible.find(l => JOB_TITLE_HINT.test(l));
    if (titled) return titled;

    return plausible[0] || 'Unknown Role';
  }

  // A DOM-read title and the confirmed JD text should always agree — they
  // describe the same job. If they don't, the title element is almost
  // certainly stale relative to the JD body: LinkedIn's SPA can update the
  // JD text and the title heading at slightly different speeds during a
  // re-render, so the JD can pass the stability gate and be genuinely fresh
  // while the title heading hasn't caught up to it yet. Requiring the title
  // to actually appear in the JD text catches this regardless of the exact
  // timing involved.
  function titleConsistentWithJD(title, jd) {
    if (!title || !jd) return false;
    const norm = s => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const nJd = norm(jd.slice(0, 2000));
    const nTitle = norm(title);

    // Fast path: whole title present verbatim. Rare — JDs usually don't
    // repeat the sidebar/header title in body prose.
    if (nJd.includes(nTitle)) return true;

    // If the extracted title contains a real job-title token (engineer,
    // manager, scientist, …) it came from a heading selector we trust; the
    // JD not repeating it word-for-word is normal, not a red flag. This is
    // what was rejecting good LinkedIn / Greenhouse titles and dumping us
    // to "New role" — the JD body opens with "About the job" and never
    // restates the heading.
    if (JOB_TITLE_HINT.test(title)) return true;

    // Weaker fallback for titles without a canonical role word: at least one
    // multi-char content token from the title must appear in the JD.
    const tokens = nTitle.split(' ').filter(t => t.length >= 4);
    if (!tokens.length) return false;
    return tokens.some(t => nJd.includes(t));
  }

  // Read the job title from the page's own heading element, not from JD prose.
  // Prose-parsing is inherently unreliable: postings routinely open with a
  // generic line ("We are looking for a Software Engineer to join our team")
  // before the real, specific title appears — and every posting that opens
  // that way would extract to the same wrong generic title. Known ATSes
  // render the real title in a dedicated heading; read that directly.
  function extractPageTitle(hostname) {
    const bySite = {
      // No bare 'h1' fallback for LinkedIn — it has caused two different
      // false positives (a sidebar "Verified job" badge card, and a
      // page-level heading unrelated to the specific job in view, like a
      // search-query display). A bare h1 has no way to distinguish the
      // actual job card's heading from any other heading on the page. If
      // neither specific selector matches, this returns null and the
      // caller falls back to extractFirstLine() on the JD text instead —
      // which is scoped to content the stability gate has already proven
      // fresh and correct for this specific job, not just page-wide.
      'linkedin.com': [
        '.job-details-jobs-unified-top-card__job-title',
        '.jobs-unified-top-card__job-title',
        '.topcard__title',
        '[class*="job-title" i]',   // resilient to LinkedIn renaming the exact class, but still scoped to job-title elements specifically — never a bare heading
      ],
      'greenhouse.io': ['h1.app-title', 'h1'],
      'lever.co': ['.posting-headline h2', 'h2'],
      'ashbyhq.com': ['h1', '[class*="PostingHeader"] h1'],
      'myworkdayjobs.com': ['[data-automation-id="jobPostingHeader"]', 'h2'],
      'smartrecruiters.com': ['h1', '.job-title'],
      'indeed.com': ['h1.jobsearch-JobInfoHeader-title', 'h1'],
    };
    for (const [domain, sels] of Object.entries(bySite)) {
      if (!hostname.includes(domain)) continue;
      for (const s of sels) {
        // A generic selector (a bare 'h1') can legitimately match several
        // headings on the page — a sidebar suggestion card as well as the
        // real job. Check every match, not just the first, so a rejected
        // first candidate doesn't mean giving up on this selector entirely.
        const els = Array.from(document.querySelectorAll(s)).slice(0, 10);
        for (const el of els) {
          const t = el?.innerText?.trim();
          if (t && t.length >= 4 && t.length <= 100 && !NOT_A_JOB_TITLE.test(t) && !looksLikeSectionHeader(t) && !HAS_JOB_CARD_BADGE.test(t)) {
            return t;
          }
        }
      }
    }

    // Fallback for unknown ATSes / direct careers pages: parse document.title.
    // Common shapes:
    //   "Senior Software Engineer at OpenAI"
    //   "Senior Software Engineer | OpenAI | LinkedIn"
    //   "OpenAI — Careers — Senior Software Engineer"
    //   "Careers | Senior Software Engineer"
    // Take the segment that contains a job-title hint token. Reject boilerplate
    // like "Careers", "Home", "Jobs at X".
    const raw = (document.title || '').trim();
    if (raw && raw.length <= 200) {
      const segs = raw.split(/\s+(?:[|\-–—·•@]|at)\s+/i).map(s => s.trim()).filter(Boolean);
      for (const seg of segs) {
        if (seg.length < 4 || seg.length > 100) continue;
        if (NOT_A_JOB_TITLE.test(seg) || looksLikeSectionHeader(seg)) continue;
        if (/\b(careers?|jobs?|home|apply|welcome|thank|search|results?|listings?)\b/i.test(seg)) continue;
        if (JOB_TITLE_HINT.test(seg)) return seg;
      }
    }

    return null;   // no known heading — caller falls back to prose-parsing
  }

  function extractCompany(pageTitle, hostname) {
    // LinkedIn: the real company is in the job card, not the hostname.
    if (hostname.includes('linkedin.com')) {
      const sels = [
        '.job-details-jobs-unified-top-card__company-name a',
        '.job-details-jobs-unified-top-card__company-name',
        '.jobs-unified-top-card__company-name',
        '.topcard__org-name-link',
        '[class*="company-name" i]',   // resilient to LinkedIn renaming the exact class, same fix as the title selector
      ];
      for (const s of sels) {
        try {
          const els = Array.from(document.querySelectorAll(s)).slice(0, 5);
          for (const el of els) {
            const t = el?.innerText?.trim();
            if (t && t.length > 1 && t.length < 60 && !HAS_JOB_CARD_BADGE.test(t)) return t;
          }
        } catch (_) {}
      }
      return 'Unknown Company';   // never claim the company is "LinkedIn"
    }

    // Third-party ATS platforms host MANY different companies' postings under
    // their own domain (jobs.ashbyhq.com/snowflake/..., not
    // careers.snowflake.com) — these checks must run BEFORE the generic
    // careers-subdomain fallback below, or that fallback intercepts them
    // first and returns the ATS provider's own name ("Ashbyhq") instead of
    // the real hiring company ("Snowflake").

    // SmartRecruiters: jobs.smartrecruiters.com/oneclick-ui/company/ServiceNow/...
    const sr = window.location.pathname.match(/\/company\/([^/]+)/i);
    if (hostname.includes('smartrecruiters.com') && sr) {
      return decodeURIComponent(sr[1]).replace(/[-_]/g, ' ');
    }
    // Ashby: jobs.ashbyhq.com/companyslug/...
    const ashby = window.location.pathname.match(/^\/([^/]+)\//);
    if (hostname.includes('ashbyhq.com') && ashby) {
      return ashby[1].charAt(0).toUpperCase() + ashby[1].slice(1);
    }
    // Greenhouse: job-boards.greenhouse.io/companyslug/jobs/...
    const gh = window.location.pathname.match(/^\/([^/]+)\/jobs/);
    if (hostname.includes('greenhouse.io') && gh) {
      const slug = gh[1].replace(/usa$/i,'').replace(/[-_]/g,' ');
      return slug.split(' ').map(w => w.charAt(0).toUpperCase()+w.slice(1)).join(' ');
    }
    // Lever: jobs.lever.co/companyslug/...
    const lever = window.location.pathname.match(/^\/([^/]+)\//);
    if (hostname.includes('lever.co') && lever) {
      return lever[1].charAt(0).toUpperCase() + lever[1].slice(1);
    }
    // Oracle Fusion Cloud HCM (widely used enterprise ATS — Uber and many
    // others): the hosting subdomain is a meaningless instance identifier
    // (iaziqy.fa.ocs.oraclecloud.com), but the real company is encoded right
    // in the path as /sites/{Company}Careers/.
    if (/\.oraclecloud\.com$/i.test(hostname)) {
      const oracle = window.location.pathname.match(/\/sites\/([^/]+?)(careers)?\//i);
      if (oracle) return oracle[1].charAt(0).toUpperCase() + oracle[1].slice(1);
    }

    // Company's OWN branded careers subdomain: careers.servicenow.com →
    // ServiceNow. Only reached once none of the third-party ATS platforms
    // above matched — this hostname genuinely belongs to the employer.
    if (/^(careers|jobs|apply|work|talent)\./i.test(hostname)) {
      const parts = hostname.split('.');
      if (parts[1]) return parts[1].charAt(0).toUpperCase() + parts[1].slice(1);
    }

    // Try page title: "Senior Engineer | Stripe" or "Job at OpenAI - Thanks"
    const titleParts = pageTitle.split(/[|\-–—]/);
    if (titleParts.length > 1) {
      const last = titleParts[titleParts.length - 1].trim();
      if (last.length > 1 && last.length < 40 && !/thank|apply|confirm|success/i.test(last)) return last;
    }
    // Domain fallback
    const domain = hostname.replace('www.','').replace('job-boards.','').replace('jobs.','').replace('careers.','');
    const parts = domain.split('.');
    if (parts[0] && !['linkedin','indeed','greenhouse','ashbyhq','lever'].includes(parts[0])) {
      return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
    }
    return 'Unknown Company';
  }

  // ── Floating Action Button & Panel (Grammarly-style) ─────
  // Injects a ✦ button into the bottom-right of every page where a JD is
  // found. Clicking it opens a floating iframe panel with the full
  // ResumePilot workflow (tailoring, ATS, chatbot) without needing the
  // user to open the Chrome extension toolbar popup at all.

  let fabEl = null;
  let panelIframe = null;
  let panelVisible = false;

  function injectFAB() {
    if (fabEl) return;
    fabEl = document.createElement('div');
    fabEl.id = 'rp-fab';
    fabEl.setAttribute('aria-label', 'Open ResumePilot');
    fabEl.style.cssText = `
      position: fixed; bottom: 28px; right: 28px; z-index: 2147483646;
      width: 52px; height: 52px; border-radius: 50%;
      background: linear-gradient(135deg, #1e3a8a 0%, #2563eb 100%);
      box-shadow: 0 4px 20px rgba(37,99,235,0.45);
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; font-size: 22px; color: white;
      font-family: sans-serif; transition: transform 0.15s, box-shadow 0.15s;
      user-select: none;
    `;
    fabEl.textContent = '✦';
    fabEl.title = 'ResumePilot';

    fabEl.addEventListener('mouseenter', () => {
      fabEl.style.transform = 'scale(1.1)';
      fabEl.style.boxShadow = '0 6px 28px rgba(37,99,235,0.6)';
    });
    fabEl.addEventListener('mouseleave', () => {
      fabEl.style.transform = 'scale(1)';
      fabEl.style.boxShadow = '0 4px 20px rgba(37,99,235,0.45)';
    });
    fabEl.addEventListener('click', () => togglePanel());

    document.body.appendChild(fabEl);
  }

  // ── Draggable panel position ──────────────────────────────
  // The panel can cover a page's Apply button, so the user can drag it by its
  // header. Mouse events inside a cross-origin iframe don't reach us, so the
  // panel posts drag deltas and we move the iframe here. Position persists.
  const PANEL_W = 660, PANEL_H = 680;
  let panelPos = null;   // { left, top } in px, or null = default corner

  function clampPanelPos(left, top) {
    const maxLeft = Math.max(0, window.innerWidth  - PANEL_W - 8);
    const maxTop  = Math.max(0, window.innerHeight - PANEL_H - 8);
    return {
      left: Math.min(Math.max(8, left), maxLeft),
      top:  Math.min(Math.max(8, top),  maxTop)
    };
  }

  function applyPanelPos(pos) {
    if (!panelIframe) return;
    if (!pos) {
      // Default: bottom-right corner
      panelIframe.style.left = 'auto';
      panelIframe.style.top = 'auto';
      panelIframe.style.bottom = '92px';
      panelIframe.style.right = '28px';
      return;
    }
    const { left, top } = clampPanelPos(pos.left, pos.top);
    panelIframe.style.left = `${left}px`;
    panelIframe.style.top = `${top}px`;
    panelIframe.style.bottom = 'auto';
    panelIframe.style.right = 'auto';
  }

  async function loadPanelPos() {
    const stored = await storageGet(['rpPanelPos']);
    panelPos = stored.rpPanelPos || null;
    applyPanelPos(panelPos);
  }

  function savePanelPos() {
    if (panelPos) storageSet({ rpPanelPos: panelPos });
  }

  // Keep the panel on screen if the window is resized.
  window.addEventListener('resize', () => {
    if (panelPos && panelIframe) {
      panelPos = clampPanelPos(panelPos.left, panelPos.top);
      applyPanelPos(panelPos);
    }
  });

  function injectPanel() {
    if (panelIframe) return;
    if (!isContextValid()) return; // extension was reloaded — nothing to do until the page refreshes
    const panelUrl = chrome.runtime.getURL('src/floating/panel.html');
    panelIframe = document.createElement('iframe');
    panelIframe.id = 'rp-panel';
    panelIframe.src = panelUrl;
    panelIframe.allow = 'clipboard-write';
    panelIframe.style.cssText = `
      position: fixed; bottom: 92px; right: 28px; z-index: 2147483645;
      width: ${PANEL_W}px; height: 0; max-height: ${PANEL_H}px;
      border: none; border-radius: 12px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.2), 0 0 0 1px rgba(0,0,0,0.08);
      transition: height 0.25s cubic-bezier(0.34,1.56,0.64,1), opacity 0.2s;
      opacity: 0; overflow: hidden;
    `;
    document.body.appendChild(panelIframe);
    loadPanelPos();
  }

  function togglePanel() {
    if (!panelIframe) injectPanel();
    if (!panelIframe) return;   // inject can no-op if context invalidated / detached
    panelVisible = !panelVisible;
    if (panelVisible) {
      panelIframe.style.height = '680px';
      panelIframe.style.opacity = '1';
      if (fabEl) {
        fabEl.textContent = '✕';
        fabEl.style.background = 'linear-gradient(135deg, #374151 0%, #1f2937 100%)';
      }
    } else {
      panelIframe.style.height = '0';
      panelIframe.style.opacity = '0';
      if (fabEl) {
        fabEl.textContent = '✦';
        fabEl.style.background = 'linear-gradient(135deg, #1e3a8a 0%, #2563eb 100%)';
      }
    }
  }

  // ── postMessage relay ──────────────────────────────────────────────────
  // The panel iframe can't call chrome.* APIs directly (cross-origin
  // iframe restriction), so it sends postMessage to the parent page, and
  // this relay forwards to chrome.runtime.sendMessage (background worker)
  // and sends the response back via another postMessage.
  window.addEventListener('message', async (e) => {
    if (e.source !== panelIframe?.contentWindow) return;
    const { rp_type, rp_id } = e.data || {};
    if (!rp_type || !rp_id) return;

    let result = {};

    try {
      if (rp_type === 'SESSION_CONFIRM_IDENTITY') {
        // The AI read the role and company from the JD itself — far more
        // reliable than scraping page chrome, which yields "99+ results".
        await confirmSessionIdentity(e.data.jobTitle, e.data.company);
        result = { ok: true };

      } else if (rp_type === 'SESSION_APPEND_CHAT') {
        // Persist a chat message into the active session so it survives navigation.
        const s = await getSession();
        if (s) {
          const history = Array.isArray(s.chatHistory) ? s.chatHistory : [];
          history.push(e.data.message);
          await saveSession({ chatHistory: history.slice(-60) }); // cap
        }
        result = { ok: true };

      } else if (rp_type === 'SESSION_ADD_SKILLS') {
        // Record which skills the user added, and where they placed them.
        const s = await getSession();
        if (s) {
          const added = Array.isArray(s.addedSkills) ? s.addedSkills : [];
          (e.data.skills || []).forEach(sk => {
            if (!added.some(a => a.skill === sk.skill)) added.push(sk);
          });
          await saveSession({ addedSkills: added });
        }

        // Skills marked "familiar" (listed, not demonstrated) or "declined"
        // (don't have it at all) go into a persistent, cross-job list — this
        // needs to survive even for jobs the user never applies to, and
        // accumulate across every job, not reset per session like the above.
        const prepItems = (e.data.skills || []).filter(sk => sk.targetType === 'skills' || sk.targetType === 'declined');
        if (prepItems.length) {
          const stored = await storageGet(['skillsToPrepare']);
          const list = Array.isArray(stored.skillsToPrepare) ? stored.skillsToPrepare : [];
          const jobTitle = s?.jobTitle || null;
          const company  = s?.company || null;
          prepItems.forEach(sk => {
            // De-dupe on skill+job — the same skill genuinely missing from
            // two different jobs should appear twice (different prep context).
            const already = list.some(x => x.skill === sk.skill && x.jobTitle === jobTitle && x.company === company);
            if (already) return;
            list.unshift({
              id: `prep_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              skill: sk.skill,
              status: sk.targetType === 'skills' ? 'familiar' : 'declined',
              jobTitle, company,
              markedAt: Date.now()
            });
          });
          await storageSet({ skillsToPrepare: list.slice(0, 500) });
        }
        result = { ok: true };

      } else if (rp_type === 'SESSION_SAVE_WORK') {
        // The tailored resume, its score, and the gaps belong to the JOB, not
        // to whichever page happened to produce them. Without this, a user who
        // tailors on the careers page and returns to LinkedIn sees a stale
        // score, stale chips, and would inject the older resume.
        const saved = await saveSession({
          tailoredResume:  e.data.tailoredResume,
          pdfBase64:       e.data.pdfBase64,
          atsAnalysis:     e.data.atsAnalysis,
          missingKinds:    e.data.missingKinds,
          placedSkills:    e.data.placedSkills,
          listedOnlySkills:e.data.listedOnlySkills,
          notesShown:      e.data.notesShown
        });
        result = { ok: true, ts: saved?.ts || Date.now() };

      } else if (rp_type === 'SESSION_MARK_APPLIED') {
        const applied = await markSessionApplied();
        result = { ok: true, applied: !!applied };

      } else if (rp_type === 'GET_STORAGE') {
        result = await new Promise(res => chrome.storage.local.get(e.data.keys || [], res));

      } else if (rp_type === 'SET_STORAGE') {
        await new Promise(res => chrome.storage.local.set(e.data.data || {}, res));
        result = { ok: true };

      } else if (rp_type === 'GET_INITIAL_STATE') {
        const stored = await new Promise(res => chrome.storage.local.get(['resumeData', 'userName', 'atsUsageCount', 'atsEvaluatedJobs', 'popupLastResult', 'rpActiveJob', 'jd_last'], res));

        // Resolve the application session for this page. If this page has a
        // SUBSTANTIAL JD of its own, start/resume a session for it. Otherwise
        // (an ATS form page, or a thin/junk match — a generic CSS selector
        // catching a few words of portal chrome on some unfamiliar ATS),
        // resolve the live session so the same conversation continues. This
        // is deliberately general rather than another per-platform URL
        // pattern: instead of needing to recognize every ATS's specific
        // "/portalcareer", "/apply", "/register" naming, anything that
        // didn't yield a real job description falls back to trusting the
        // session that's already open.
        const MIN_JD_LEN = 150;
        const detectedJdUsable = looksLikeRealJD(detectedJD);
        let session = null;
        if (detectedJdUsable) session = await startOrResumeSession(detectedJD);
        else session = await resolveSessionForPage();

        // A session.jd that merely EXISTS isn't enough to trust — a thin or
        // leftover value from earlier testing would silently mean "no JD
        // available" while looking like it succeeded (jdSource: 'session').
        const sessionJdUsable = session?.jd && session.jd.trim().length >= MIN_JD_LEN;

        let effectiveJd = (detectedJdUsable ? detectedJD : null) || (sessionJdUsable ? session.jd : null) || null;
        let jdSource = detectedJdUsable ? 'page' : (sessionJdUsable ? 'session' : 'none');
        if (!effectiveJd) {
          const active = stored.rpActiveJob;
          if (active?.jd && active.jd.trim().length >= MIN_JD_LEN && (Date.now() - active.ts) < 45 * 60 * 1000) { effectiveJd = active.jd; jdSource = 'active_session'; }
          else if (stored.jd_last?.jd && stored.jd_last.jd.trim().length >= MIN_JD_LEN && (Date.now() - stored.jd_last.ts) < 30 * 60 * 1000) { effectiveJd = stored.jd_last.jd; jdSource = 'last'; }
        }

        // If this job was already applied to, surface the archived session so
        // the panel can show "You applied to this on <date>".
        let archived = null;
        if (effectiveJd && !session?.applied) {
          const pageTitle = document.title || '';
          const company = extractCompany(pageTitle, window.location.hostname);
          archived = await findArchivedSession(effectiveJd, company);
        }

        const currentFp = getJobFingerprint();
        const lastResult = stored.popupLastResult;
        let cachedForThisJob = null;
        if (lastResult?.tailoredResume) {
          const sameFingerprint = lastResult.fingerprint && lastResult.fingerprint === currentFp;
          const sameJd = lastResult.jd && effectiveJd && lastResult.jd.trim() === effectiveJd.trim();
          if (sameFingerprint || sameJd) cachedForThisJob = lastResult;
        }
        result = {
          jd: effectiveJd,
          jdSource,
          fingerprint: currentFp,
          session: session ? {
            sessionId: session.sessionId,
            jobTitle: session.jobTitle,
            company: session.company,
            chatHistory: session.chatHistory || [],
            addedSkills: session.addedSkills || [],
            applied: !!session.applied,
            appliedAt: session.appliedAt || null,
            // Work already done for this job, on any page.
            tailoredResume:   session.tailoredResume   || null,
            pdfBase64:        session.pdfBase64        || null,
            atsAnalysis:      session.atsAnalysis      || null,
            missingKinds:     session.missingKinds     || {},
            placedSkills:     session.placedSkills     || [],
            listedOnlySkills: session.listedOnlySkills || [],
            notesShown:       session.notesShown       || {}
          } : null,
          archived: archived ? { applied: true, appliedAt: archived.appliedAt, jobTitle: archived.jobTitle, company: archived.company, addedSkills: archived.addedSkills || [] } : null,
          resumeData: stored.resumeData || null,
          userName: stored.userName || null,
          atsUsed: Number(stored.atsUsageCount || 0),
          atsEvaluatedJobs: stored.atsEvaluatedJobs || [],
          cached: cachedForThisJob
        };

      } else if (rp_type === 'TAILOR_RESUME') {
        const stored = await new Promise(res => chrome.storage.local.get(['resumeData', 'skillProfile'], res));
        result = await new Promise(res => chrome.runtime.sendMessage({
          type: 'TAILOR_RESUME',
          payload: { jobDescription: e.data.jobDescription, skillProfile: stored.skillProfile }
        }, res));
        // Persist result for popup pickup, tagged with the job fingerprint
        // so we only restore it on the SAME job (not a different one).
        if (result.tailored) {
          const existing = await new Promise(res => chrome.storage.local.get(['popupLastResult'], res));
          const merged = { ...(existing.popupLastResult || {}), tailoredResume: result.tailored, pdfBase64: result.pdfBase64, jd: e.data.jobDescription, fingerprint: getJobFingerprint(), savedAt: Date.now() };
          await new Promise(res => chrome.storage.local.set({ popupLastResult: merged }, res));
        }

      } else if (rp_type === 'EVALUATE_ATS') {
        // Just run the analysis — credit counting is handled in panel.js
        // with per-job fingerprint logic (re-evaluating same job is free).
        result = await new Promise(res => chrome.runtime.sendMessage({
          type: 'EVALUATE_ATS',
          payload: { jobDescription: e.data.jobDescription, tailoredResume: e.data.tailoredResume, placedSkills: e.data.placedSkills || [], listedOnlySkills: e.data.listedOnlySkills || [], skillsAddedCount: e.data.skillsAddedCount || 0, existingRequirements: e.data.existingRequirements || null }
        }, res));

      } else if (rp_type === 'SUBMIT_FEEDBACK') {
        result = await new Promise(res => chrome.runtime.sendMessage({
          type: 'SUBMIT_FEEDBACK',
          payload: { name: e.data.name, email: e.data.email, message: e.data.message }
        }, res));

      } else if (rp_type === 'GET_REMOTE_CONFIG') {
        result = await new Promise(res => chrome.runtime.sendMessage({ type: 'GET_REMOTE_CONFIG' }, res));

      } else if (rp_type === 'ANSWER_QUESTION') {
        result = await new Promise(res => chrome.runtime.sendMessage({
          type: 'ANSWER_QUESTION',
          payload: { question: e.data.question, tailoredResume: e.data.tailoredResume, jobDescription: e.data.jobDescription }
        }, res));

      } else if (rp_type === 'CHAT_EDIT') {
        result = await new Promise(res => chrome.runtime.sendMessage({
          type: 'CHAT_EDIT',
          payload: { instruction: e.data.instruction, tailoredResume: e.data.tailoredResume, jobDescription: e.data.jobDescription }
        }, res));
        // Persist updated resume
        if (result.tailored) {
          const existing = await new Promise(res => chrome.storage.local.get(['popupLastResult'], res));
          const merged = { ...(existing.popupLastResult || {}), tailoredResume: result.tailored, pdfBase64: result.pdfBase64, savedAt: Date.now() };
          await new Promise(res => chrome.storage.local.set({ popupLastResult: merged }, res));
        }

      } else if (rp_type === 'GENERATE_COVER_LETTER') {
        const stored = await new Promise(res => chrome.storage.local.get(['resumeData', 'skillProfile', 'userName'], res));
        result = await new Promise(res => chrome.runtime.sendMessage({
          type: 'GENERATE_COVER_LETTER',
          payload: {
            jobDescription: e.data.jobDescription,
            tailoredResume: e.data.tailoredResume,
            skillProfile: stored.skillProfile,
            applicantName: stored.userName || stored.resumeData?.name || '',
            companyName: '',
            roleTitle: ''
          }
        }, res));

      } else if (rp_type === 'DOWNLOAD_FILE') {
        const a = document.createElement('a');
        a.href = 'data:application/pdf;base64,' + e.data.base64;
        a.download = e.data.filename || 'file.pdf';
        a.click();
        // NOTE: downloading a PDF is NOT an application submission — no tracker logging here.
        result = { ok: true };

      } else if (rp_type === 'INJECT_COVER_LETTER') {
        coverLetterText = e.data.text || null;
        if (e.data.pdfBase64) coverLetterPdfB64 = e.data.pdfBase64;
        const scanOnce = () => {
          const foundNew = scanCLFields();
          const refilled = refillKnownCLFields();
          let fileButtonAdded = false;
          document.querySelectorAll('input[type="file"]').forEach(inp => {
            if (!inp._rpBtn) {
              const kind = maybeAddResumeBtn(inp, 'cover-letter');
              if (kind === 'cover-letter') fileButtonAdded = true;
            }
          });
          return foundNew || refilled || fileButtonAdded;
        };
        let filled = scanOnce();
        if (!filled) {
          // The field may still be rendering (revealed by another part of
          // the form finishing up) — a passive mutation-observer scan would
          // eventually catch it, but give the immediate Inject click one
          // short retry before reporting failure.
          await new Promise(res => setTimeout(res, 800));
          filled = scanOnce();
        }
        result = { ok: true, filled };

      } else if (rp_type === 'COPY_TEXT') {
        try { await navigator.clipboard.writeText(e.data.text || ''); } catch (_) {}
        result = { ok: true };

      } else if (rp_type === 'DOWNLOAD_PDF') {
        // Trigger download by creating a link in the page context
        const a = document.createElement('a');
        a.href = 'data:application/pdf;base64,' + e.data.pdfBase64;
        a.download = 'resume_tailored.pdf';
        a.click();
        result = { ok: true };

      } else if (rp_type === 'INJECT_RESUME') {
        tailoredPdfB64 = e.data.pdfBase64;
        if (e.data.filename) tailoredFilename = e.data.filename;
        let resumeButtonReady = false;
        document.querySelectorAll('input[type="file"]').forEach(inp => {
          if (!inp._rpBtn) {
            const kind = maybeAddResumeBtn(inp, 'resume');
            if (kind === 'resume') resumeButtonReady = true;
          } else if (inp._rpBtnKind !== 'cover-letter') {
            // A button already exists here from an earlier scan. Check what
            // it was actually resolved to (_rpBtnKind, set in
            // addFileInjectButton) rather than re-deriving from the field's
            // label — an ambiguous field's existing button may have been
            // resolved to cover-letter by an earlier INJECT_COVER_LETTER
            // click, and label-based re-detection would wrongly call it
            // resume-ready just because the label itself isn't cover-letter-
            // specific.
            resumeButtonReady = true;
          }
        });

        // ── Log to application tracker ──────────────────────
        // Injecting the resume is the strongest possible signal that
        // the user is actively submitting an application. At this point
        // we have full context: the JD (detectedJD), the current page's
        // fingerprint, and we can extract company/role reliably.
        // Write DIRECTLY to storage — no worker relay needed, no
        // confirmation page detection needed, no pattern matching.
        (async () => {
          try {
            const fp = getJobFingerprint();
            const pageTitle = document.title || '';
            const jobTitle = detectedJD ? extractFirstLine(detectedJD) : (pageTitle.split('|')[0].split(' - ')[0].trim() || 'Unknown Role');
            const company = extractCompany(pageTitle, window.location.hostname);
            const now = Date.now();
            const stored = await new Promise(res => chrome.storage.local.get(['applicationLog'], res));
            const log = stored.applicationLog || [];
            const currentSession = await getSession();
            const sessionId = currentSession?.sessionId || null;
            if (!isDuplicateApplication(log, { fingerprint: fp, jobTitle, company, sessionId }, now)) {
              log.unshift({
                id: `app_${now}_${Math.random().toString(36).slice(2,6)}`,
                jobTitle, company, sessionId,
                url: window.location.href,
                fingerprint: fp,
                appliedAt: now,
                status: 'applied',
                source: 'resume_injected'
              });
              await new Promise(res => chrome.storage.local.set({ applicationLog: log.slice(0, 500) }, res));
              // Anonymous ping for the admin dashboard's application count.
              // Feedback cadence keys off tailor count now, not applications
              // — see FEEDBACK_EVERY_N_TAILORS in worker.js.
              try {
                chrome.runtime.sendMessage({ type: 'APPLICATION_LOGGED_ELSEWHERE' }).catch(() => {});
              } catch (_) {}
            }
          } catch (_) {}
        })();

        result = { ok: true, filled: resumeButtonReady };

      } else if (rp_type === 'SIGN_OUT') {
        // Save profile under user email before clearing
        const stored = await new Promise(res => chrome.storage.local.get(['user','resumeData','skillProfile'], res));
        if (stored.user?.email && stored.resumeData) {
          const key = `profile_${stored.user.email}`;
          await new Promise(res => chrome.storage.local.set({ [key]: { resumeData: stored.resumeData, skillProfile: stored.skillProfile } }, res));
        }
        await new Promise(res => chrome.storage.local.remove(['user','token','resumeData','skillProfile','parsedResumeText','userName'], res));
        result = { ok: true };

      } else if (rp_type === 'SAVE_SKILL_TO_PROFILE') {
        // Persist the newly added skill to the stored resumeData so it
        // survives the next tailor session. Set _silentSkillUpdate so the
        // onChanged listener suppresses the "Profile updated!" message.
        const stored = await new Promise(res => chrome.storage.local.get(['resumeData'], res));
        const rd = stored.resumeData;
        if (rd && e.data.skill) {
          if (!rd.skills) rd.skills = [];
          if (rd.skills.length === 0) rd.skills.push({ category: 'Additional Skills', items: [] });
          const target = rd.skills[rd.skills.length - 1];
          if (target.items && !target.items.includes(e.data.skill)) {
            target.items.push(e.data.skill);
          }
          // Set flag and write resumeData together so the listener sees the flag.
          await new Promise(res => chrome.storage.local.set({ resumeData: rd, _silentSkillUpdate: Date.now() }, res));
        }
        result = { ok: true };

      } else if (rp_type === 'OPEN_ONBOARDING') {
        chrome.runtime.sendMessage({ type: 'OPEN_ONBOARDING' });
        result = { ok: true };

      } else if (rp_type === 'OPEN_TRACKER') {
        chrome.runtime.sendMessage({ type: 'OPEN_TRACKER' });
        result = { ok: true };

      } else if (rp_type === 'OPEN_PLANS') {
        chrome.runtime.sendMessage({ type: 'OPEN_PLANS' });
        result = { ok: true };
      }
    } catch (err) {
      const raw = err.message || String(err);
      // The extension was updated/reloaded while this tab's content script
      // was still running the old version — its connection to the
      // extension is now dead. The fix is always the same: refresh the
      // page. Say that plainly instead of surfacing Chrome's internal
      // error text, which means nothing to someone hitting "Tailor".
      const contextDead = /context invalidated|extension context/i.test(raw);
      result = { error: contextDead ? 'refresh_needed' : raw, message: contextDead ? 'This tab is running an older version of the extension — refresh the page and try again.' : undefined };
    }

    panelIframe?.contentWindow?.postMessage({ rp_response_id: rp_id, result }, '*');
  });

  // Push JD detection updates to the panel live
  function notifyPanelJD(jd, reliableTitle = null) {
    // NEVER push a null/empty JD — doing so would wipe the panel's recovered
    // saved JD (from the active application session) and send it back to
    // "Scanning…". Only notify when we actually have a real JD on this page.
    if (!jd || (typeof jd === 'string' && jd.trim().length < 20)) return;
    if (panelIframe?.contentWindow) {
      const hostname = window.location.hostname;
      // Use the title already resolved by the caller if given (tryDetectJD
      // computes it once from the page's own heading). Only compute it here
      // as a fallback for callers that don't have one on hand (profile-update
      // pushes) — the panel is a sandboxed iframe with no DOM access of its
      // own, so this is the only place either path CAN read it.
      const domTitle = reliableTitle || extractPageTitle(hostname);
      panelIframe.contentWindow.postMessage({
        rp_push: 'JD_DETECTED',
        jd,
        title: domTitle,   // null if no known heading matched — panel falls back to prose
        company: extractCompany(document.title || '', hostname),
        fingerprint: getJobFingerprint()
      }, '*');
    }
  }

  // Messages from the panel: minimize + drag
  let dragOrigin = null;  // { startLeft, startTop, startX, startY }

  window.addEventListener('message', e => {
    if (e.source !== panelIframe?.contentWindow) return;
    const d = e.data;
    if (!d) return;

    if (d.rp_push === 'MINIMIZE') {
      togglePanel();
      return;
    }

    // ── Drag: the panel posts pointer deltas from its header ──
    if (d.rp_push === 'DRAG_START') {
      if (!panelIframe) return;
      const rect = panelIframe.getBoundingClientRect();
      dragOrigin = { startLeft: rect.left, startTop: rect.top, startX: d.screenX, startY: d.screenY };
      // Disable transitions while dragging so it tracks the cursor exactly.
      panelIframe.style.transition = 'none';
      document.body.style.userSelect = 'none';
    }

    if (d.rp_push === 'DRAG_MOVE' && dragOrigin) {
      const dx = d.screenX - dragOrigin.startX;
      const dy = d.screenY - dragOrigin.startY;
      panelPos = clampPanelPos(dragOrigin.startLeft + dx, dragOrigin.startTop + dy);
      applyPanelPos(panelPos);
    }

    if (d.rp_push === 'DRAG_END' && dragOrigin) {
      dragOrigin = null;
      if (panelIframe) panelIframe.style.transition = 'height 0.25s cubic-bezier(0.34,1.56,0.64,1), opacity 0.2s';
      document.body.style.userSelect = '';
      savePanelPos();
    }

    if (d.rp_push === 'RESET_POSITION') {
      panelPos = null;
      applyPanelPos(null);
      storageSet({ rpPanelPos: null });
    }
  });

  // While dragging, the pointer may leave the iframe — track it on the page too.
  document.addEventListener('mousemove', e => {
    if (!dragOrigin) return;
    const dx = e.screenX - dragOrigin.startX;
    const dy = e.screenY - dragOrigin.startY;
    panelPos = clampPanelPos(dragOrigin.startLeft + dx, dragOrigin.startTop + dy);
    applyPanelPos(panelPos);
  });

  document.addEventListener('mouseup', () => {
    if (!dragOrigin) return;
    dragOrigin = null;
    if (panelIframe) {
      panelIframe.style.transition = 'height 0.25s cubic-bezier(0.34,1.56,0.64,1), opacity 0.2s';
    }
    document.body.style.userSelect = '';
    savePanelPos();
  });

  // ── Init ──────────────────────────────────────────────────

  async function init() {
    if (!isContextValid()) return;
    // The FAB is the only way the user can reach the extension on this page
    // at all — it must never be able to fail silently just because
    // something else in init() below throws. Isolated in its own try/catch,
    // called first, independent of everything that follows.
    try { injectFAB(); } catch (_) {}
    try {
      purgePoisonedSessions();   // clear bad sessions from earlier builds
      watchFileInputs();
      watchCoverLetterFields();

      // ── Confirmation page detection ──────────────────────
      // Many ATSes navigate to a dedicated confirmation page after
      // submission (Greenhouse /confirmation, Lever /thanks, etc.).
      // Detect these on page load and fire APPLICATION_SUBMITTED
      // with whatever context we can extract.
      checkConfirmationPage();

      // Initial JD detection
      tryDetectJD();

      let lastUrl = location.href;
      setInterval(() => {
        if (!isContextValid()) return;
        const currentUrl = location.href;
        if (currentUrl !== lastUrl) {
          lastUrl = currentUrl;
          detectedJD = null;
          confirmationFired = false;
          // Don't reset the stability tracker here — a URL change means a
          // DIFFERENT candidate is now in view, and tryDetectJD's own
          // confirm-on-second-read logic (below) decides whether it's real.
          setTimeout(checkConfirmationPage, 500);
          setTimeout(tryDetectJD, 300);
          setTimeout(tryDetectJD, 900);
          setTimeout(tryDetectJD, 1800);
        }
      }, 500);

      let mutationDebounce = null;
      let confirmationDebounce = null;
      const observer = new MutationObserver(() => {
        if (!isContextValid()) { observer.disconnect(); return; }
        clearTimeout(mutationDebounce);
        mutationDebounce = setTimeout(tryDetectJD, 400);
        // Also check for SPA-injected success banners (Ashby, Workday etc.
        // that stay on the same URL and show an inline confirmation message)
        if (!confirmationFired) {
          clearTimeout(confirmationDebounce);
          confirmationDebounce = setTimeout(checkConfirmationPage, 600);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

    } catch (e) {
      if (e.message?.includes('Extension context invalidated')) return;
      console.warn('[ResumePilot]', e.message);
    }
  }

  // ── Confirmation page patterns ────────────────────────────
  // URL-based confirmation signals (ATSes that navigate to a new page)
  const CONFIRMATION_URL_PATTERNS = [
    /\/confirmation\/?(\?|$)/i,          // Greenhouse: /jobs/123/confirmation
    /\/thanks\/?(\?|$)/i,                // Lever
    /\/apply\/confirmation/i,            // Workday
    /[?&]applied=true/i,                 // Generic
    /\/application[_-]?submitted/i,      // Generic
    /\/application[_-]?received/i,       // Generic
    /\/success\/?(\?|$)/i,               // Various
  ];

  // Text-based confirmation signals (visible on the page)
  const CONFIRMATION_TEXT_PATTERNS = [
    /thank\s+you\s+for\s+(apply|your\s+application)/i,
    /application\s+.{0,30}(received|submitted|sent)/i,   // "was successfully submitted", "has been received"
    /successfully\s+submitted/i,                          // Ashby: "successfully submitted"
    /application\s+was\s+sent\s+to/i,                    // LinkedIn Easy Apply
    /we.{0,10}received\s+your\s+application/i,
    /you.{0,10}applied\s+(for|to|at)/i,
  ];

  let confirmationFired = false; // prevent double-firing on the same page load

  function checkConfirmationPage() {
    if (confirmationFired) return;
    const currentUrl = window.location.href;
    const isConfirmationUrl = CONFIRMATION_URL_PATTERNS.some(p => p.test(currentUrl));
    const bodyText = document.body?.innerText || '';
    const isConfirmationText = CONFIRMATION_TEXT_PATTERNS.some(p => p.test(bodyText));

    if (!isConfirmationUrl && !isConfirmationText) return;
    confirmationFired = true;

    // ── Look up cached job details by fingerprint ──────────────
    // When we detected the JD earlier (on the job listing page), we stored
    // { jobTitle, company, url } keyed by fingerprint. On Greenhouse the
    // fingerprint is gh_JOBID — same for the listing, form, and confirmation
    // pages. On Ashby it's ash_UUID. This lookup always gives accurate data.
    const tryKeys = [
      `jd_${getJobFingerprint()}`,      // current page fingerprint
      `jd_gh_${currentUrl.match(/\/jobs\/(\d+)/)?.[1]}`,   // Greenhouse by job ID in URL
      `jd_ash_${currentUrl.match(/\/([a-f0-9-]{36})\//)?.[1]}`, // Ashby by UUID in URL
    ].filter(Boolean);

    // Also try referrer fingerprint
    try {
      if (document.referrer) {
        const ref = document.referrer;
        const ghRef = ref.match(/greenhouse\.io\/[^/]+\/jobs\/(\d+)/);
        if (ghRef) tryKeys.push(`jd_gh_${ghRef[1]}`);
        const ashRef = ref.match(/([a-f0-9-]{36})/);
        if (ashRef) tryKeys.push(`jd_ash_${ashRef[1]}`);
      }
    } catch (_) {}
    tryKeys.push('jd_last'); // absolute fallback: whatever was last detected

    chrome.storage.local.get([...tryKeys, 'applicationLog', 'rpSession'], (stored) => {
      // Find the first matching cached JD entry
      let cachedJob = null;
      for (const k of tryKeys) {
        if (stored[k]?.jobTitle) { cachedJob = stored[k]; break; }
      }

      const now = Date.now();
      const jobTitle = cachedJob?.jobTitle || extractFirstLine(bodyText) || document.querySelector('h1,h2')?.innerText?.trim() || 'Unknown Role';
      const company  = cachedJob?.company  || extractCompany(document.title, window.location.hostname);
      const fp       = cachedJob ? tryKeys.find(k => stored[k]?.jobTitle === cachedJob.jobTitle)?.replace('jd_','') || getJobFingerprint() : getJobFingerprint();
      const sessionId = stored.rpSession?.sessionId || null;

      const log = stored.applicationLog || [];
      if (isDuplicateApplication(log, { fingerprint: fp, jobTitle, company, sessionId }, now)) return;

      log.unshift({
        id: `app_${now}_${Math.random().toString(36).slice(2,6)}`,
        jobTitle, company, sessionId,
        url: cachedJob?.url || document.referrer || currentUrl,
        fingerprint: fp,
        appliedAt: now,
        status: 'applied',
        source: 'confirmation_page'
      });
      chrome.storage.local.set({ applicationLog: log.slice(0, 500) });
      notifyApplicationLogged();
    });
  }

  function tryDetectJD() {
    const live = detectJobDescription();
    // Same check used at the GET_INITIAL_STATE decision point — a thin or
    // non-JD match (a generic selector catching a few words of page chrome,
    // or a login/legal page's boilerplate text) shouldn't announce a new
    // job or start a session for it.
    if (!looksLikeRealJD(live)) return;
    const fp = getJobFingerprint();
    const now = Date.now();

    // ── Confirm before announcing ──────────────────────────────────────
    //
    // LinkedIn's job panel fires this in bursts: three timers per URL change
    // plus a mutation observer on every DOM tick (view counters, lazy-loaded
    // sidebars). None of those calls wait for the panel to finish rendering,
    // and a user scrolling past a job can trigger several of them before
    // moving on. Announcing on the first read meant partial text ("Position
    // Overview:" with nothing else yet) got captured as if it were the whole
    // JD, and jobs merely scrolled past got announced as "selected".
    //
    // So: a fingerprint only becomes "the current job" once we see it TWICE
    // in a row with settled content. A single fleeting read never confirms —
    // which is also the right behaviour for a job the user only scrolled past.
    const candidate = tryDetectJD._candidate;
    const sameCandidate = candidate && candidate.fp === fp;
    const lengthSettled = sameCandidate && Math.abs(candidate.textLen - live.length) < Math.max(40, live.length * 0.05);

    if (fp === tryDetectJD._confirmedFp) {
      // Already the confirmed job — just keep the text current, quietly.
      detectedJD = live;
      cacheJD(live);
      tryDetectJD._candidate = { fp, textLen: live.length, at: now, firstSeenAt: now };
      return;
    }

    if (!sameCandidate) {
      // First sighting of this fingerprint. Hold it, don't announce yet.
      tryDetectJD._candidate = { fp, textLen: live.length, at: now, firstSeenAt: now };
      return;
    }

    if (!lengthSettled) {
      // Same fingerprint, but the content is still growing (still loading).
      // Update the held length and keep waiting — but preserve firstSeenAt,
      // since that's tracking total time held on this fingerprint, not time
      // since the last individual read.
      tryDetectJD._candidate = { fp, textLen: live.length, at: now, firstSeenAt: candidate.firstSeenAt };
      return;
    }

    // Stale-read guard: length-stability alone can't tell "fully loaded and
    // settled" apart from "hasn't started updating yet" — both look
    // identical if the DOM simply hasn't caught up to a URL change (a real
    // race on LinkedIn's job panel: the URL updates instantly on click, the
    // new job's content arrives via a slightly-delayed fetch). If this
    // "settled" text is IDENTICAL to the PREVIOUSLY confirmed job's FULL
    // text, this is almost certainly still the old job's stale content —
    // comparing the full text rather than just a prefix matters here, since
    // real postings routinely share 500+ characters of company boilerplate
    // (mission statement, EEO notice, benefits) before any role-specific
    // content appears, and a prefix-only comparison would falsely flag
    // every genuinely different job that happens to share that boilerplate.
    // Capped by a max-hold escape hatch below — this can never get a
    // fingerprint permanently stuck, even for the rare case of two truly
    // identical postings (an exact duplicate/reposted listing).
    const MAX_HOLD_MS = 6000;
    const heldTooLong = (now - (candidate.firstSeenAt || now)) > MAX_HOLD_MS;
    if (fp !== tryDetectJD._confirmedFp && tryDetectJD._lastConfirmedText && !heldTooLong) {
      const norm = s => s.toLowerCase().replace(/\s+/g, ' ').trim();
      if (norm(live) === norm(tryDetectJD._lastConfirmedText)) {
        tryDetectJD._candidate = { fp, textLen: live.length, at: now, firstSeenAt: candidate.firstSeenAt };
        return;
      }
    }

    // Confirmed: same fingerprint, settled content, on a second read.
    // Two extra guards:
    //   (a) A hard floor between any two announcements — 1.2s.
    //   (b) Don't re-announce a fingerprint already announced within 10 min.
    //       The state machine correctly re-confirms when you scroll away and
    //       back to the same job, but the CHAT should still not re-announce
    //       it — that just produces the duplicate lines in the log.
    if (now - (tryDetectJD._lastAnnounceAt || 0) < 1200) return;
    tryDetectJD._recentAnnounces = tryDetectJD._recentAnnounces || new Map();
    // Expire entries older than 10 minutes so a genuinely revisited job later
    // still announces once — the guard is against back-to-back re-announces.
    const RECENT_MS = 10 * 60 * 1000;
    for (const [f, at] of tryDetectJD._recentAnnounces) {
      if (now - at > RECENT_MS) tryDetectJD._recentAnnounces.delete(f);
    }
    if (tryDetectJD._recentAnnounces.has(fp)) {
      // Silently confirm — same job, already announced recently.
      tryDetectJD._confirmedFp = fp;
      tryDetectJD._lastConfirmedText = live;
      detectedJD = live;
      let pageTitle = extractPageTitle(window.location.hostname);
      if (!titleConsistentWithJD(pageTitle, live)) pageTitle = safeTitleFallback();
      cacheJD(live, pageTitle);
      return;
    }
    tryDetectJD._recentAnnounces.set(fp, now);

    tryDetectJD._confirmedFp = fp;
    tryDetectJD._lastConfirmedText = live;
    tryDetectJD._lastAnnounceAt = now;
    detectedJD = live;
    // Read the title from the page's own heading — trustworthy. If that
    // doesn't match a known selector, or disagrees with the JD text that
    // just passed the stability gate, fall back to a safe, honest
    // placeholder rather than guessing a specific-but-possibly-wrong title
    // from JD prose (see safeTitleFallback for why prose-guessing was
    // abandoned). The real title arrives via the AI correction on tailor.
    let pageTitle = extractPageTitle(window.location.hostname);
    if (!titleConsistentWithJD(pageTitle, live)) pageTitle = safeTitleFallback();
    cacheJD(live, pageTitle);
    safeSendMessage({ type: 'JD_DETECTED', jd: live, jobTitle: pageTitle });
    notifyPanelJD(live, pageTitle);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();