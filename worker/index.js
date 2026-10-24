// ─────────────────────────────────────────────────────────
//  ResumePilot – Cloudflare Worker (Claude API backend)
//  Paste this entire file into your Cloudflare Worker editor
//  and set ANTHROPIC_API_KEY in Settings → Variables (Secret).
//
//  Why Claude + tool-use instead of "ask nicely for JSON":
//  The previous Groq/Llama-3.1-8B backend would sometimes return
//  resume bullets as objects instead of strings, which rendered as
//  literal "[object Object]" in the generated PDF. Small open models
//  often drift from a schema described only in the prompt. Here we
//  define the exact JSON Schema for each task and force Claude to
//  call a single tool matching that schema — the API itself rejects
//  any output that doesn't match the types (e.g. bullets MUST be an
//  array of strings), so that failure mode can't happen anymore.
// ─────────────────────────────────────────────────────────

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

// ── JSON Schemas for structured tasks ────────────────────────────────────
// Both resume-parsing and resume-tailoring return the same resume shape.
const RESUME_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    contact: {
      type: 'object',
      properties: {
        email: { type: 'string' },
        phone: { type: 'string' },
        location: { type: 'string' },
        linkedin: { type: 'string' },
        portfolio: { type: 'string' },
        github: { type: 'string' }
      },
      required: ['email', 'phone', 'location', 'linkedin', 'portfolio', 'github']
    },
    summary: { type: 'string' },
    experience: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          company: { type: 'string' },
          location: { type: 'string' },
          title: { type: 'string' },
          dates: { type: 'string' },
          bullets: { type: 'array', items: { type: 'string' } }
        },
        required: ['company', 'location', 'title', 'dates', 'bullets']
      }
    },
    education: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          institution: { type: 'string' },
          location: { type: 'string' },
          degree: { type: 'string' },
          dates: { type: 'string' }
        },
        required: ['institution', 'location', 'degree', 'dates']
      }
    },
    skills: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          items: { type: 'array', items: { type: 'string' } }
        },
        required: ['category', 'items']
      }
    },
    projects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          dates: { type: 'string' },
          bullets: { type: 'array', items: { type: 'string' } }
        },
        required: ['name', 'dates', 'bullets']
      }
    },
    certifications: { type: 'array', items: { type: 'string' } }
  },
  required: ['name', 'contact', 'summary', 'experience', 'education', 'skills', 'projects', 'certifications']
};

const ANSWERS_SCHEMA = {
  type: 'object',
  properties: {
    answers: { type: 'array', items: { type: 'string' } }
  },
  required: ['answers']
};

const ATS_EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    job_title: { type: ['string', 'null'], description: 'The exact role title read from the JD content itself, or null if unclear.' },
    company: { type: ['string', 'null'], description: 'The hiring company read from the JD content itself, or null if unclear.' },
    requirements: {
      type: 'array',
      description: 'Every requirement this job description states, enumerated once. No resume is involved in this pass — just what the job asks for.',
      items: {
        type: 'object',
        properties: {
          requirement: { type: 'string', description: 'What the job asks for, in a few words — not the JD sentence.' },
          kind: { type: 'string', enum: ['technical', 'experience', 'domain'], description: 'technical = named tool/tech/cert. experience = something done, addable via a resume edit. domain = industry/functional background.' },
          artifact: { type: 'string', description: 'What ANY candidate who genuinely met this requirement would show an interviewer to prove it — independent of whether this specific candidate has it.' }
        },
        required: ['requirement', 'kind', 'artifact']
      }
    }
  },
  required: ['requirements']
};

const ATS_JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer', description: 'Your own holistic 0-100 read of overall fit — kept separate from, and never blended into, the coverage score computed client-side.' },
    requirements: {
      type: 'array',
      description: 'The FIXED checklist given in the prompt, reproduced item for item in the same order, with covered/artifact filled in. Never add, remove, or reorder items.',
      items: {
        type: 'object',
        properties: {
          requirement: { type: 'string', description: 'Copied verbatim from the checklist given in the prompt.' },
          kind: { type: 'string', enum: ['technical', 'experience', 'domain'], description: 'Copied verbatim from the checklist given in the prompt.' },
          covered: { type: 'boolean', description: 'Does the resume show real evidence of this? Be honest, not generous — adjacent is not equivalent.' },
          artifact: { type: 'string', description: 'What a candidate would show an interviewer to prove this.' }
        },
        required: ['requirement', 'kind', 'covered']
      }
    },
    matching_responsibilities: { type: 'array', items: { type: 'string' }, description: 'At most 3 job duties the resume shows real evidence of having handled.' }
  },
  required: ['score', 'requirements']
};

const TASK_TOOLS = {
  parse_resume: { name: 'emit_resume', description: 'Return the parsed resume as structured JSON.', input_schema: RESUME_SCHEMA },
  tailor_resume: { name: 'emit_resume', description: 'Return the tailored resume as structured JSON.', input_schema: RESUME_SCHEMA },
  application_answers: { name: 'emit_answers', description: 'Return the answers as structured JSON.', input_schema: ANSWERS_SCHEMA },
  ats_extract: { name: 'emit_checklist', description: 'Return the extracted requirements checklist as structured JSON.', input_schema: ATS_EXTRACT_SCHEMA },
  ats_judge: { name: 'emit_judgment', description: 'Return the coverage judgment as structured JSON.', input_schema: ATS_JUDGE_SCHEMA }
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return cors(null, 204);

    // ── New: usage tracking + feedback + admin dashboard ──────────────────
    if (url.pathname === '/event')    return handleEvent(request, env);
    if (url.pathname === '/feedback') return handleFeedback(request, env);
    if (url.pathname === '/admin')    return handleAdmin(request, env);
    if (url.pathname === '/config')   return handleConfig(request, env);

    // ── Everything below is the original AI proxy, untouched ──────────────
    if (request.method !== 'POST') return cors(new Response('Method not allowed', { status: 405 }));

    let body;
    try { body = await request.json(); }
    catch (_) { return json({ error: 'Invalid JSON body' }, 400); }

    const { systemInstruction, userMessage, jsonMode, task } = body;

    if (!userMessage) return json({ error: 'Missing userMessage' }, 400);
    if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY not configured in Worker environment' }, 500);

    const model = DEFAULT_MODEL;
    const tool = jsonMode ? TASK_TOOLS[task] : null;

    const anthropicBody = {
      model,
      max_tokens: (task === 'ats_extract' || task === 'ats_judge') ? 6000 : (task === 'tailor_resume' ? 8000 : (tool ? 3000 : 1200)),
      temperature: jsonMode ? 0 : 0.7,
      system: systemInstruction ? [
        {
          type: 'text',
          text: systemInstruction,
          cache_control: { type: 'ephemeral' }
        }
      ] : undefined,
      messages: [{ role: 'user', content: userMessage }],
      ...(tool ? { tools: [tool], tool_choice: { type: 'tool', name: tool.name } } : {})
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);

    let upstreamRes;
    try {
      upstreamRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': ANTHROPIC_VERSION,
          'anthropic-beta': 'prompt-caching-2024-07-31'
        },
        body: JSON.stringify(anthropicBody),
        signal: controller.signal
      });
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') return json({ error: 'Request timed out talking to Claude.' }, 504);
      return json({ error: `Failed to reach Claude: ${err.message}` }, 502);
    }
    clearTimeout(timer);

    const data = await upstreamRes.json().catch(() => ({}));

    if (!upstreamRes.ok) {
      const message = data?.error?.message || `Claude API error ${upstreamRes.status}`;
      const retryAfter = upstreamRes.headers.get('retry-after');
      return json({ error: message, status: upstreamRes.status }, upstreamRes.status, retryAfter);
    }

    let text = null;
    if (tool) {
      const toolBlock = (data.content || []).find(b => b.type === 'tool_use' && b.name === tool.name);
      if (toolBlock) text = JSON.stringify(toolBlock.input);
    } else {
      const textBlock = (data.content || []).find(b => b.type === 'text');
      if (textBlock) text = textBlock.text;
    }

    if (!text) return json({ error: 'Claude returned no usable content' }, 502);
    return json({ text });
  }
};

// ── /event — anonymous usage ping ──────────────────────────────────────
// Body: { anon_id: string, type: 'tailor' | 'application' }
// No name, no email, no resume content — just a stable random ID the
// extension generates once on install and a timestamped event type.
async function handleEvent(request, env) {
  if (request.method !== 'POST') return cors(new Response('Method not allowed', { status: 405 }));
  if (!env.DB) return json({ error: 'Tracking not configured' }, 500);

  let body;
  try { body = await request.json(); } catch (_) { return json({ error: 'Invalid JSON' }, 400); }

  const anonId = String(body.anon_id || '').trim();
  const type = String(body.type || '').trim();
  if (!anonId || anonId.length > 100) return json({ error: 'Missing or invalid anon_id' }, 400);
  if (!['tailor', 'application'].includes(type)) return json({ error: 'Invalid event type' }, 400);

  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO installs (anon_id, first_seen, last_seen) VALUES (?, ?, ?)
         ON CONFLICT(anon_id) DO UPDATE SET last_seen = excluded.last_seen`
      ).bind(anonId, now, now),
      env.DB.prepare(
        `INSERT INTO events (anon_id, type, ts) VALUES (?, ?, ?)`
      ).bind(anonId, type, now)
    ]);
  } catch (err) {
    // Tracking must never break the actual product. Log and swallow.
    console.error('event insert failed', err.message);
  }

  return json({ ok: true });
}

// ── /feedback — named feedback submission ──────────────────────────────
// Body: { name, email, message }
// Deliberate: the person is choosing to identify themselves here, unlike
// the anonymous /event pings above.
async function handleFeedback(request, env) {
  if (request.method !== 'POST') return cors(new Response('Method not allowed', { status: 405 }));
  if (!env.DB) return json({ error: 'Feedback not configured' }, 500);

  let body;
  try { body = await request.json(); } catch (_) { return json({ error: 'Invalid JSON' }, 400); }

  const name = String(body.name || '').trim().slice(0, 200);
  const email = String(body.email || '').trim().slice(0, 200);
  const message = String(body.message || '').trim().slice(0, 5000);

  if (!message) return json({ error: 'Feedback message is required' }, 400);

  try {
    await env.DB.prepare(
      `INSERT INTO feedback (name, email, message, created_at) VALUES (?, ?, ?, ?)`
    ).bind(name || null, email || null, message, Date.now()).run();
  } catch (err) {
    console.error('feedback insert failed', err.message);
    return json({ error: 'Could not save feedback' }, 500);
  }

  return json({ ok: true });
}

// ── /admin — password-gated dashboard ──────────────────────────────────
// GET /admin?key=YOUR_ADMIN_KEY
async function handleAdmin(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key') || '';

  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
    return new Response('Not authorized. Append ?key=YOUR_ADMIN_KEY to the URL.', {
      status: 401,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
  if (!env.DB) return new Response('Database not configured.', { status: 500 });

  const now = Date.now();
  const DAY = 86400000;
  const weekAgo = now - 7 * DAY;
  const fourWeeksAgo = now - 28 * DAY;

  const [totalUsersRow, totalTailorsRow, totalAppsRow, activeWeekRow, feedbackRows, weeklySeriesRows, settingsRows] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS c FROM installs`).first(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM events WHERE type = 'tailor'`).first(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM events WHERE type = 'application'`).first(),
    env.DB.prepare(`SELECT COUNT(DISTINCT anon_id) AS c FROM events WHERE ts >= ?`).bind(weekAgo).first(),
    env.DB.prepare(`SELECT name, email, message, created_at FROM feedback ORDER BY created_at DESC LIMIT 200`).all(),
    env.DB.prepare(
      `SELECT (ts / (7*86400000)) AS week_bucket, COUNT(DISTINCT anon_id) AS active_users, COUNT(*) AS total_events
       FROM events WHERE ts >= ? GROUP BY week_bucket ORDER BY week_bucket ASC`
    ).bind(fourWeeksAgo).all(),
    env.DB.prepare(`SELECT key, value FROM settings`).all()
  ]);

  const totalUsers = totalUsersRow?.c || 0;
  const totalTailors = totalTailorsRow?.c || 0;
  const totalApps = totalAppsRow?.c || 0;
  const activeThisWeek = activeWeekRow?.c || 0;
  const feedback = feedbackRows?.results || [];
  const weeklySeries = weeklySeriesRows?.results || [];

  const config = { ...CONFIG_DEFAULTS };
  for (const row of settingsRows?.results || []) {
    if (CONFIG_KEYS.includes(row.key)) {
      const n = Number(row.value);
      if (Number.isFinite(n) && n > 0) config[row.key] = n;
    }
  }

  const html = renderAdminHTML({ totalUsers, totalTailors, totalApps, activeThisWeek, feedback, weeklySeries, config, adminKey: key });
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function renderAdminHTML({ totalUsers, totalTailors, totalApps, activeThisWeek, feedback, weeklySeries, config, adminKey }) {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = ts => new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  const maxActive = Math.max(1, ...weeklySeries.map(w => w.active_users));
  const barsHtml = weeklySeries.map(w => {
    const h = Math.round((w.active_users / maxActive) * 100);
    const wkLabel = new Date(w.week_bucket * 7 * 86400000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `<div class="bar-col">
      <div class="bar-val">${w.active_users}</div>
      <div class="bar" style="height:${h}%"></div>
      <div class="bar-label">${esc(wkLabel)}</div>
    </div>`;
  }).join('');

  const feedbackHtml = feedback.length ? feedback.map(f => `
    <tr>
      <td>${esc(f.name) || '<span class="muted">—</span>'}</td>
      <td>${esc(f.email) || '<span class="muted">—</span>'}</td>
      <td class="msg-cell">${esc(f.message)}</td>
      <td class="muted">${fmtDate(f.created_at)}</td>
    </tr>`).join('') : `<tr><td colspan="4" class="muted" style="text-align:center;padding:24px;">No feedback submitted yet.</td></tr>`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>ResumePilot — Admin</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f6f7fb; color: #1f2937; margin: 0; padding: 32px 24px 64px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #6b7280; font-size: 13px; margin-bottom: 28px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 14px; margin-bottom: 28px; max-width: 900px; }
  .stat-card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px 18px; }
  .stat-num { font-size: 26px; font-weight: 700; color: #1e3a8a; }
  .stat-label { font-size: 12px; color: #6b7280; margin-top: 2px; }
  .panel { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 20px; max-width: 900px; margin-bottom: 24px; }
  .panel h2 { font-size: 14px; margin: 0 0 16px; color: #374151; }
  .chart { display: flex; align-items: flex-end; gap: 18px; height: 140px; padding: 0 8px; }
  .bar-col { display: flex; flex-direction: column; align-items: center; justify-content: flex-end; flex: 1; height: 100%; }
  .bar-val { font-size: 11px; color: #1e3a8a; font-weight: 600; margin-bottom: 4px; }
  .bar { width: 28px; background: linear-gradient(180deg, #4f7cff, #1e3a8a); border-radius: 4px 4px 0 0; min-height: 3px; }
  .bar-label { font-size: 10.5px; color: #9ca3af; margin-top: 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; color: #9ca3af; padding: 8px 10px; border-bottom: 1px solid #e5e7eb; }
  td { padding: 10px; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
  .msg-cell { max-width: 420px; white-space: pre-wrap; }
  .muted { color: #9ca3af; }
</style></head>
<body>
  <h1>ResumePilot — Usage &amp; Feedback</h1>
  <div class="sub">Anonymous install-level counts. No names or emails are attached to tailor/application activity.</div>

  <div class="stats">
    <div class="stat-card"><div class="stat-num">${totalUsers}</div><div class="stat-label">Total users (installs)</div></div>
    <div class="stat-card"><div class="stat-num">${totalTailors}</div><div class="stat-label">Resumes tailored</div></div>
    <div class="stat-card"><div class="stat-num">${totalApps}</div><div class="stat-label">Applications logged</div></div>
    <div class="stat-card"><div class="stat-num">${activeThisWeek}</div><div class="stat-label">Active users (last 7 days)</div></div>
  </div>

  <div class="panel">
    <h2>Weekly active users (last 4 weeks)</h2>
    ${weeklySeries.length ? `<div class="chart">${barsHtml}</div>` : '<div class="muted">Not enough data yet.</div>'}
  </div>

  <div class="panel">
    <h2>Timing settings</h2>
    <p class="muted" style="margin:-8px 0 20px;font-size:12.5px;">
      Drag a slider and hit Save. Changes take effect for users within a few hours
      (the extension re-checks periodically) — no code change, no Chrome Web Store review needed.
    </p>

    <div style="max-width:520px;margin-bottom:24px;">
      <label style="display:flex;justify-content:space-between;font-size:12.5px;color:#374151;font-weight:600;margin-bottom:8px;">
        <span>Feedback popup — how often</span>
        <span id="cfg-feedback-label" style="color:#1e3a8a;"></span>
      </label>
      <input id="cfg-feedback" type="range" min="0" max="${FEEDBACK_STEPS.length - 1}" step="1"
        value="${nearestStepIndex(FEEDBACK_STEPS, config.feedbackIntervalHours)}"
        style="width:100%;accent-color:#1e3a8a;">
      <div style="display:flex;justify-content:space-between;font-size:10.5px;color:#9ca3af;margin-top:2px;">
        <span>${FEEDBACK_STEPS[0].label}</span><span>${FEEDBACK_STEPS[FEEDBACK_STEPS.length - 1].label}</span>
      </div>
    </div>

    <div style="max-width:520px;margin-bottom:24px;">
      <label style="display:flex;justify-content:space-between;font-size:12.5px;color:#374151;font-weight:600;margin-bottom:8px;">
        <span>Break reminder — nudge after</span>
        <span id="cfg-break-label" style="color:#1e3a8a;"></span>
      </label>
      <input id="cfg-break" type="range" min="15" max="180" step="5" value="${config.breakThresholdMinutes}"
        style="width:100%;accent-color:#1e3a8a;">
      <div style="display:flex;justify-content:space-between;font-size:10.5px;color:#9ca3af;margin-top:2px;">
        <span>15 min</span><span>3 hours</span>
      </div>
    </div>

    <div style="max-width:520px;margin-bottom:8px;">
      <label style="display:flex;justify-content:space-between;font-size:12.5px;color:#374151;font-weight:600;margin-bottom:8px;">
        <span>Break snooze — hide for</span>
        <span id="cfg-snooze-label" style="color:#1e3a8a;"></span>
      </label>
      <input id="cfg-snooze" type="range" min="5" max="120" step="5" value="${config.breakSnoozeMinutes}"
        style="width:100%;accent-color:#1e3a8a;">
      <div style="display:flex;justify-content:space-between;font-size:10.5px;color:#9ca3af;margin-top:2px;">
        <span>5 min</span><span>2 hours</span>
      </div>
    </div>

    <button id="cfg-save" style="margin-top:16px;padding:8px 18px;font-size:13px;font-weight:600;border:none;border-radius:8px;background:#1e3a8a;color:#fff;cursor:pointer;">Save settings</button>
    <span id="cfg-status" style="margin-left:10px;font-size:12.5px;"></span>
  </div>

  <div class="panel">
    <h2>Feedback (${feedback.length})</h2>
    <table>
      <thead><tr><th>Name</th><th>Email</th><th>Message</th><th>When</th></tr></thead>
      <tbody>${feedbackHtml}</tbody>
    </table>
  </div>

  <script>
    // Curated steps for the feedback slider — every position is a sensible,
    // nameable value rather than an arbitrary hour count. Mirrors
    // FEEDBACK_STEPS on the server so the label text matches exactly.
    const FEEDBACK_STEPS = ${JSON.stringify(FEEDBACK_STEPS)};

    function minutesLabel(mins) {
      if (mins < 60) return mins + ' min';
      const h = mins / 60;
      return (h % 1 === 0 ? h : h.toFixed(1)) + (h === 1 ? ' hour' : ' hours');
    }

    const feedbackSlider = document.getElementById('cfg-feedback');
    const feedbackLabel = document.getElementById('cfg-feedback-label');
    function updateFeedbackLabel() { feedbackLabel.textContent = FEEDBACK_STEPS[Number(feedbackSlider.value)].label; }
    feedbackSlider.addEventListener('input', updateFeedbackLabel);
    updateFeedbackLabel();

    const breakSlider = document.getElementById('cfg-break');
    const breakLabel = document.getElementById('cfg-break-label');
    function updateBreakLabel() { breakLabel.textContent = minutesLabel(Number(breakSlider.value)); }
    breakSlider.addEventListener('input', updateBreakLabel);
    updateBreakLabel();

    const snoozeSlider = document.getElementById('cfg-snooze');
    const snoozeLabel = document.getElementById('cfg-snooze-label');
    function updateSnoozeLabel() { snoozeLabel.textContent = minutesLabel(Number(snoozeSlider.value)); }
    snoozeSlider.addEventListener('input', updateSnoozeLabel);
    updateSnoozeLabel();

    document.getElementById('cfg-save').addEventListener('click', async () => {
      const status = document.getElementById('cfg-status');
      status.textContent = 'Saving…';
      status.style.color = '#6b7280';
      try {
        const res = await fetch('/config?key=${encodeURIComponent(adminKey)}', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            feedbackIntervalHours: FEEDBACK_STEPS[Number(feedbackSlider.value)].hours,
            breakThresholdMinutes: Number(breakSlider.value),
            breakSnoozeMinutes: Number(snoozeSlider.value)
          })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Save failed');
        status.textContent = '✓ Saved';
        status.style.color = '#16a34a';
      } catch (err) {
        status.textContent = '✕ ' + err.message;
        status.style.color = '#dc2626';
      }
    });
  </script>
</body></html>`;
}

// ── /config — remotely-controlled timing settings ──────────────────────
//
// Lets you change things like "how often should the feedback popup appear"
// or "after how long should the break reminder show" WITHOUT touching
// extension code or waiting for Chrome Web Store review — the extension
// reads these values from here periodically (cached locally, refreshed
// every few hours) instead of using hardcoded constants.
//
// GET  /config              → anyone can read current settings (extension calls this)
// POST /config?key=ADMIN_KEY → update settings (admin page calls this)
//
// Backed by a simple key-value `settings` table. Missing/never-configured
// keys fall back to sane hardcoded defaults below, so a fresh deploy or an
// empty table never breaks the extension — it just uses the defaults until
// you set something via the admin page.
const CONFIG_DEFAULTS = {
  feedbackIntervalHours: 168,     // 1 week
  breakThresholdMinutes: 60,      // nudge after 1 hour of active use
  breakSnoozeMinutes: 45          // snooze length after dismissing
};
const CONFIG_KEYS = Object.keys(CONFIG_DEFAULTS);

// Curated, human-readable steps for the admin dashboard's feedback-interval
// slider. Linear hour values don't work well here — you want fine control
// down at "a few hours" for testing, but also need to comfortably reach
// "once a month" without an absurdly long slider or a coarse, unusable
// step size. Every position on the slider is one of these named values.
const FEEDBACK_STEPS = [
  { hours: 1,    label: '1 hour' },
  { hours: 3,    label: '3 hours' },
  { hours: 6,    label: '6 hours' },
  { hours: 12,   label: '12 hours' },
  { hours: 24,   label: '1 day' },
  { hours: 48,   label: '2 days' },
  { hours: 72,   label: '3 days' },
  { hours: 168,  label: '1 week' },
  { hours: 336,  label: '2 weeks' },
  { hours: 720,  label: '1 month' }
];

// Finds the closest FEEDBACK_STEPS index to a stored hour value, so the
// slider starts wherever the currently-saved setting actually is — even if
// that value was set some other way (e.g. directly in the database) and
// doesn't land exactly on one of the named steps.
function nearestStepIndex(steps, hours) {
  let bestIdx = 0, bestDiff = Infinity;
  steps.forEach((s, i) => {
    const diff = Math.abs(s.hours - hours);
    if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
  });
  return bestIdx;
}

async function handleConfig(request, env) {
  if (!env.DB) return json(CONFIG_DEFAULTS); // no DB yet — defaults keep the extension working

  if (request.method === 'GET') {
    try {
      const rows = await env.DB.prepare(`SELECT key, value FROM settings`).all();
      const out = { ...CONFIG_DEFAULTS };
      for (const row of rows.results || []) {
        if (CONFIG_KEYS.includes(row.key)) {
          const n = Number(row.value);
          if (Number.isFinite(n) && n > 0) out[row.key] = n;
        }
      }
      return json(out);
    } catch (err) {
      console.error('config read failed', err.message);
      return json(CONFIG_DEFAULTS); // fail open with defaults, never break the extension
    }
  }

  if (request.method === 'POST') {
    const url = new URL(request.url);
    const key = url.searchParams.get('key') || '';
    if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
      return json({ error: 'Not authorized' }, 401);
    }

    let body;
    try { body = await request.json(); } catch (_) { return json({ error: 'Invalid JSON' }, 400); }

    const writes = [];
    for (const k of CONFIG_KEYS) {
      if (body[k] === undefined) continue;
      const n = Number(body[k]);
      if (!Number.isFinite(n) || n <= 0) return json({ error: `${k} must be a positive number` }, 400);
      writes.push(
        env.DB.prepare(
          `INSERT INTO settings (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        ).bind(k, String(n))
      );
    }
    if (!writes.length) return json({ error: 'No valid settings provided' }, 400);

    try {
      await env.DB.batch(writes);
    } catch (err) {
      console.error('config write failed', err.message);
      return json({ error: 'Could not save settings' }, 500);
    }
    return json({ ok: true });
  }

  return cors(new Response('Method not allowed', { status: 405 }));
}

function json(data, status = 200, retryAfter = null) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  };
  if (retryAfter) headers['Retry-After'] = retryAfter;
  return new Response(JSON.stringify(data), { status, headers });
}

function cors(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

/* ─────────────────────────────────────────────────────────────────────────
   ONE-TIME SETUP for the new tracking/feedback/admin routes:

   1. Create the D1 database:
        Cloudflare dashboard → Workers & Pages → D1 → Create database
        Name it e.g. "resumepilot-db"

   2. Bind it to this Worker:
        Worker → Settings → Bindings → Add → D1 database
        Variable name: DB
        Database: resumepilot-db

   3. Run this schema against the new database (D1 console → Query, or
      `wrangler d1 execute resumepilot-db --file=schema.sql`):

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

   4. Add a Secret variable ADMIN_KEY — any password you choose. This is
      what gates https://your-worker-url/admin?key=... and the ability to
      change settings via POST /config?key=...

   5. Deploy. Visit https://your-worker-url/admin?key=YOUR_ADMIN_KEY
───────────────────────────────────────────────────────────────────────── */
