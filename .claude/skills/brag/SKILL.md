---
name: brag
description: Turn this repo's work into brag-worthy, resume-ready accomplishment bullets. Use when the user types /brag or asks for resume bullets, a brag doc, accomplishments, or a LinkedIn-style summary of what was built. Optional argument narrows the angle (e.g. "frontend", "ai", "since last week", "linkedin").
---

# /brag — accomplishment bullets from the codebase

Produce concrete, defensible brag points grounded in what is actually in the repo. Never invent metrics, users, revenue, or adoption numbers.

## 1. Gather evidence

Run these (skip any that don't apply):

- `git log --format='%h %an %ad %s' --date=short` — who did what, when. If the argument names a time range ("this week", "since v1.0"), filter with `--since` / a tag range and brag only about that slice.
- Read `README.md` for the product pitch, architecture and feature list.
- Size the code, excluding `.git` and vendored/minified files:
  `find . -path ./.git -prune -o -type f \( -name '*.js' -o -name '*.html' -o -name '*.css' \) -print0 | xargs -0 wc -l | sort -n | tail -15`
  (paths here contain spaces, e.g. `extension/ResumePilot-store-ready 1.4/` — always use `-print0 | xargs -0`).
- Check `manifest.json` for version and permissions, and skim the largest files (`detector.js`, `panel.js`, `ai.js`, `pdf-extract.js`, `worker/cloudflare-worker.js`) for notable technical decisions.
- For a diff-scoped brag, read `git diff <range> --stat` and the changed files.

## 2. Pick what's impressive

Favor, in order:
1. Hard technical problems solved (e.g. structured tool-use for schema-valid JSON, job-page detection across arbitrary domains, in-browser PDF/DOCX parsing and generation).
2. Product scope shipped end to end (extension + serverless backend + admin dashboard).
3. Operational wins (live remote config without a store re-review, privacy-by-design).
4. Honest, verifiable numbers (LOC, platforms supported, version shipped, zero dependencies/build steps).

## 3. Output

Reply in chat (no files unless asked) with:

- **One-liner** — a single sentence pitch, first person.
- **Resume bullets** — 6–10 bullets, each starting with a strong past-tense verb, stating *what* + *how* + *why it matters*. One line each where possible.
- **Numbers worth quoting** — only figures you measured in step 1.

Adapt to the argument:
- A role (`frontend`, `backend`, `ai`, `fullstack`) → reorder and reword bullets toward that role, drop irrelevant ones.
- `linkedin` → a short, friendly post (≤150 words) instead of bullets.
- `readme` → offer to add a "Highlights" section to `README.md` (confirm before editing).

If the git author differs from the current user, say whose commits these are and phrase bullets neutrally or let the user adjust. End with one line offering the other formats.
