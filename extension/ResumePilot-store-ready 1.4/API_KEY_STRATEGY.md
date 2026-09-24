# ResumePilot Hosted API Strategy

## Decision

Do not ask users for AI provider API keys.

For a real Chrome extension product, the extension should call your backend, and your backend should call Gemini/OpenAI/Claude using your private server-side key.

```text
Chrome Extension
  -> ResumePilot Backend
     -> AI Provider
        -> ResumePilot Backend
           -> Chrome Extension
```

## Why

- Users get a product-like experience with no API setup.
- Your provider key is not exposed in extension source code.
- You can add login, subscriptions, free trials, abuse prevention, rate limits, and analytics.
- You can swap AI providers without shipping a new extension for every prompt/provider change.

## Extension Endpoint

Already configured for development/demo use in `src/background/ai.js`:

```js
const HOSTED_AI_ENDPOINT = 'https://wispy-recipe-d3bd.my1assistant-support.workers.dev';
```

Point this at your own backend before publishing your own copy (see `server/hosted-api-example.js` for a ready-to-paste Cloudflare Worker that proxies to Groq).

## AI Endpoint Contract

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

Calls made by the extension (all via the same endpoint above, differing only in `systemInstruction`/`userMessage`):

- Parse uploaded/pasted resume text into structured JSON
- Tailor resume JSON to a job description
- Generate a cover letter
- Generate a short "Why this company?" answer
- Answer custom application questions

## Resume Parsing — Fully Local, No Endpoint

PDF and DOCX text extraction happen entirely in the browser (`src/lib/pdf-extract.js`, `src/lib/docx-extract.js`) — files are never uploaded anywhere for parsing. Only the resulting plain text is sent to the AI endpoint above to be structured into JSON.

## Backend Responsibilities

- Store AI provider keys in environment variables only.
- Authenticate users before allowing generation.
- Enforce per-user rate limits.
- Log request IDs and usage metadata, not raw resumes unless the user explicitly agrees.
- Return clean text responses to the extension.
- For `tailor_resume`, return valid JSON matching the resume schema.

## Security Notes

- Never embed a provider key in `manifest.json`, popup code, content scripts, or background scripts.
- Treat resumes and job descriptions as sensitive personal data.
- Use HTTPS only.
- Add CORS rules that allow requests from your extension ID after publishing.
