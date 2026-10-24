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
        portfolio: { type: 'string' }
      },
      required: ['email', 'phone', 'location', 'linkedin', 'portfolio']
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
    if (request.method === 'OPTIONS') return cors(null, 204);
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
      // ats_extract lists {requirement, kind, artifact} per item — no resume,
      // no score, no covered field. ats_judge echoes that same fixed list back
      // with covered added, plus a holistic score. Each item in either schema
      // is ~30-35 tokens as JSON; even a very rich 80-item JD comfortably fits
      // under 6000 tokens per pass. This replaced one combined call that asked
      // for everything at once and needed a much larger, riskier ceiling.
      // tailor_resume returns the FULL resume JSON on every tailor AND every
      // chat edit — a heavily-tailored resume (3 companies, multiple
      // projects, a large skills section after many rounds of additions)
      // can genuinely need more than the old 3000-token default. Truncating
      // this specific output mid-generation is what silently cuts off
      // whatever comes last in the JSON structure — usually the final
      // experience entry's bullets.
      max_tokens: (task === 'ats_extract' || task === 'ats_judge') ? 6000 : (task === 'tailor_resume' ? 8000 : (tool ? 3000 : 1200)),
      temperature: jsonMode ? 0 : 0.7,
      // Wrap the system prompt in a content block with cache_control so
      // Anthropic caches its KV state across calls. The system prompt is
      // identical for every request of the same task type (user-specific data
      // lives in userMessage, not here), so the cache hit rate will be near
      // 100% after the first request per 5-minute window. Cache reads cost
      // 10% of standard input price — no quality impact whatsoever, the model
      // sees exactly the same tokens either way.
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

    // Bound the upstream call so a hung request fails fast instead of
    // hanging the extension indefinitely — the client already retries.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000); // 25s server-side ceiling

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

    // Extract the response: either a forced tool_use block (jsonMode) or
    // the first text block (plain generation, e.g. cover letters).
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
