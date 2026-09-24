# ResumePilot

A Chrome extension that tailors your resume to a job posting in real time, using Claude to parse resumes, rewrite them against a job description, score ATS keyword coverage, and generate cover letters — all from a floating panel that appears on job sites.

## What it does

- Detects a job description on the current page (LinkedIn, Greenhouse, Lever, Workday, Ashby, SmartRecruiters, Indeed, and most direct company careers pages)
- Tailors your resume to that specific posting with one click
- Scores ATS skill coverage and shows exactly which skills are missing, with a guided flow to add them (into Skills, or woven into a specific role/project's bullets)
- Generates a matching cover letter
- Tracks applications you've submitted, with status (applied / interview / offer / rejected)
- Injects the tailored resume/cover letter PDF directly into a site's upload field, or downloads it

## Repo structure

```
resumepilot/
├── extension/          # The Chrome extension itself
│   ├── manifest.json
│   └── src/
│       ├── background/ # Service worker: AI calls, PDF generation, message routing
│       ├── content/    # detector.js — runs on every page, finds job postings,
│       │                 injects the floating panel, relays messages
│       ├── floating/    # panel.js/html — the UI that lives in the injected iframe
│       ├── onboarding/  # First-run resume upload + review flow
│       ├── pages/       # Standalone pages: tracker, plans, auth
│       ├── popup/       # Toolbar icon popup
│       └── lib/         # PDF/DOCX parsing, PDF generation, shared helpers
│
└── worker/              # Cloudflare Worker — the backend
    └── index.js         # Proxies requests to the Anthropic API, tracks
                          # anonymous usage stats, collects feedback, serves
                          # the admin dashboard, and serves remote-controlled
                          # timing config (feedback popup cadence, break
                          # reminder timing) so those can be changed without
                          # a new extension release
```

## How it's built

**Extension side** — vanilla JavaScript, no build step, no framework. Manifest V3. The content script (`detector.js`) injects an iframe (`panel.html`/`panel.js`) onto job-posting pages and relays messages between that iframe and the background service worker (`worker.js`), since the iframe can't call `chrome.runtime` APIs directly.

**Backend** — a single Cloudflare Worker (`worker/index.js`) that:
- Proxies all AI calls to Anthropic's API using Claude with structured tool-use (forces JSON-schema-conformant output for resume parsing/tailoring/ATS scoring — this is why resume fields never come back malformed)
- Stores anonymous usage counts and user feedback in a Cloudflare D1 (SQLite) database
- Serves a password-gated `/admin` dashboard showing usage stats and feedback, with sliders to adjust timing settings live
- Serves `/config`, which the extension polls periodically so things like "how often to show the feedback popup" can be changed from the admin dashboard with no new extension release

## Setup (for a fresh deploy)

### Cloudflare Worker

1. Create a Worker in the Cloudflare dashboard, paste in `worker/index.js`.
2. Create a D1 database, bind it to the Worker as `DB` (Settings → Bindings).
3. Run this schema against the database (D1 console → Query):

   ```sql
   CREATE TABLE IF NOT EXISTS installs (
     anon_id    TEXT PRIMARY KEY,
     first_seen INTEGER NOT NULL,
     last_seen  INTEGER NOT NULL
   );

   CREATE TABLE IF NOT EXISTS events (
     id      INTEGER PRIMARY KEY AUTOINCREMENT,
     anon_id TEXT NOT NULL,
     type    TEXT NOT NULL,
     ts      INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
   CREATE INDEX IF NOT EXISTS idx_events_anon ON events(anon_id);

   CREATE TABLE IF NOT EXISTS feedback (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     name       TEXT,
     email      TEXT,
     message    TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );

   CREATE TABLE IF NOT EXISTS settings (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );
   ```

4. Add two Secret environment variables:
   - `ANTHROPIC_API_KEY` — your Anthropic API key
   - `ADMIN_KEY` — any password you choose; gates `/admin` and config changes
5. Deploy. Your admin dashboard is at `https://<your-worker-url>/admin?key=<ADMIN_KEY>`.

### Chrome Extension

1. `extension/` is ready to zip as-is — no build step.
2. To test locally: `chrome://extensions` → enable Developer Mode → "Load unpacked" → select the `extension/` folder.
3. To publish: zip the **contents** of `extension/` (not the folder itself — `manifest.json` should be at the zip's root) and upload via the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
4. Google OAuth (used for sign-in) needs a matching redirect URI registered in [Google Cloud Console](https://console.cloud.google.com) under the OAuth client tied to the `client_id` in `manifest.json` — the redirect URI must be `https://<published-extension-id>.chromiumapp.org/`.

## Deploying a change

There's no CI/CD yet — both sides are deployed manually:

1. **Worker changes** — paste the updated `worker/index.js` into the Cloudflare dashboard's editor and click Deploy. Takes effect immediately, no review process.
2. **Extension changes** — bump the `version` field in `manifest.json`, zip the contents of `extension/`, upload via the Developer Dashboard, and submit for review. Chrome review typically takes a few days; requests for broad host permissions (needed here, since job postings can appear on any domain) may trigger a longer "in-depth review."

## Notes on permissions

This extension requests broad host permissions (`http://*/*`, `https://*/*`) because job postings live on thousands of unpredictable domains — every ATS platform plus every individual company's own careers site. A fixed allowlist of domains would silently break detection on any company not in that list, which is why `activeTab` alone isn't sufficient here (it requires a manual click on every page, with no automatic "job detected" behavior).

## Privacy

- Tailor/application counts sent to the Worker are tied to a random per-install ID, generated once locally — never to a name or email.
- Feedback submissions (from the in-app feedback prompt) do include a name/email, since the user is voluntarily providing them.
- Resume content is sent to Anthropic's API for parsing/tailoring and is not stored by this Worker beyond the request/response cycle.
