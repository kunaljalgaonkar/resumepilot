# ResumePilot - Hosted Chrome Extension

ResumePilot helps job seekers tailor a resume and generate application answers directly while applying to jobs.

## Current Product Flow

1. User installs the Chrome extension.
2. User uploads a resume (PDF, DOCX, or TXT — parsed entirely client-side, no upload to any server) or pastes resume text, then reviews/edits parsed details during onboarding (or directly on the **app.html** tailoring page).
3. User opens a job posting or application page, or pastes a job description into app.html.
4. The content script detects the job description on supported pages.
5. When the user clicks **Tailor My Resume** (popup) or **Tailor my application** (app.html), the extension sends the job description and structured resume JSON to the hosted AI endpoint.
6. The hosted endpoint (a small Cloudflare Worker — see `server/hosted-api-example.js`) calls Groq with your private API key and returns the model's text.
7. The extension receives tailored resume JSON, generates a PDF and DOCX locally (no CDN dependency — see `src/background/pdf.js` and `src/lib/docx-generate.js`), and lets the user download both or inject the PDF into a file upload field.
8. The extension can also generate a cover letter (PDF + DOCX), a short "Why this company?" answer, and answers to custom application questions — all grounded in the same tailored resume.
9. An ATS-style keyword match score and a structural change summary (added/reordered/rewritten content) are computed locally and shown on the results page.

## Hosted AI Endpoint

The extension is already wired to a working hosted endpoint for development/demo use:

```js
// src/background/ai.js
const HOSTED_AI_ENDPOINT = 'https://wispy-recipe-d3bd.my1assistant-support.workers.dev';
```

Before publishing your own copy, point this at your own backend (see `server/hosted-api-example.js` for a ready-to-paste Cloudflare Worker). The endpoint contract is:

Request:

```json
{
  "model": "llama-3.1-8b-instant",
  "systemInstruction": "...",
  "userMessage": "...",
  "jsonMode": true
}
```

Response:

```json
{ "text": "..." }
```

Resume parsing (PDF/DOCX text extraction) happens **entirely client-side** in the extension via `src/lib/pdf-extract.js` and `src/lib/docx-extract.js` — no file ever leaves the browser for parsing. Only the already-extracted plain text is sent to the AI endpoint above for structuring into JSON.

## Files

```text
app/
├── manifest.json
├── package.json
├── server/
│   └── hosted-api-example.js   Cloudflare Worker example backend
├── assets/
├── src/
│   ├── background/
│   │   ├── ai.js          Hosted AI client + resume tailoring prompts
│   │   ├── pdf.js         Local no-CDN PDF generator (resume + cover letter)
│   │   └── worker.js      Message router (service worker)
│   ├── lib/
│   │   ├── pdf-extract.js   Pure-JS PDF text extraction (no pdfjs-dist)
│   │   ├── docx-extract.js  Pure-JS DOCX text extraction
│   │   ├── docx-generate.js Pure-JS DOCX generation (resume + cover letter)
│   │   ├── zip.js           Minimal ZIP reader/writer (used by DOCX modules)
│   │   └── analysis.js      Deterministic ATS score + change-summary diff
│   ├── content/
│   │   └── detector.js    JD detection, file/text injection, right-side alerts
│   ├── onboarding/
│   │   ├── onboarding.html  Deep editor: AI resume parse + skill confidence
│   │   ├── onboarding.css
│   │   └── onboarding.js
│   ├── popup/
│   │   ├── popup.html       Per-job-page quick tailor popup
│   │   ├── popup.css
│   │   └── popup.js
│   ├── pages/                TrueResume UI (primary product surface)
│   │   ├── landing.html / auth.html / app.html / history.html / result.html
│   └── scripts/
│       ├── api.js, auth.js, tailor.js, result.js, history.js, common.js, icons.js, landing.js
└── API_KEY_STRATEGY.md
```

## Load Locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this `app` folder.

The `manifest.json` includes a fixed `"key"` field so the extension always loads with the same extension ID, even when reloaded unpacked. This is required for Google Sign-In (`chrome.identity.getAuthToken`) to keep working — see the Google OAuth setup steps for the exact ID and Cloud Console configuration.

## Notes

- AI provider keys live only on the hosted backend (Cloudflare Worker), never in extension code.
- PDF and DOCX generation are fully local (`src/background/pdf.js`, `src/lib/docx-generate.js`) — no CDN dependency.
- PDF and DOCX resume parsing are fully local too (`src/lib/pdf-extract.js`, `src/lib/docx-extract.js`) — files never leave the browser for text extraction; only the extracted plain text is sent to the AI endpoint for structuring.
- The ATS match score and change summary on the results page are computed locally with simple keyword-overlap heuristics (`src/lib/analysis.js`) — not an official ATS score, and no extra AI call is made for them.
