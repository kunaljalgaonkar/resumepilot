// ─────────────────────────────────────────────────────────
//  Pure-JS resume/JD analysis helpers.
//  - computeAtsAnalysis: keyword-overlap match score between a job
//    description and a tailored resume (no AI call — fast & free).
//  - computeChangeSummary: structural diff between the original and
//    tailored resume JSON (added/removed skills, reordered bullets,
//    rewritten bullet text).
// ─────────────────────────────────────────────────────────

// Defensive backstop: strips job-board UI chrome (posted-date badges,
// applicant counts, "Easy Apply", etc.) that can end up in the captured JD
// text on some sites, or get included if a JD is pasted in manually. The
// content script already does this at the source (src/content/detector.js)
// — this is intentionally duplicated here rather than imported, since
// content scripts can't use ES module imports, and this module benefits
// from not trusting its input is already clean.
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
  /^\d{1,4}$/,
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
function cleanJobDescriptionText(text) {
  if (!text) return text;
  return String(text).split('\n').filter(line => {
    const t = line.trim();
    if (!t) return true;
    if (CHROME_LINE_PATTERNS.some(re => re.test(t))) return false;
    if (isChromeFragmentLine(t)) return false;
    return true;
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const STOPWORDS = new Set([
  'the','and','for','with','that','this','from','your','you','our','are','will',
  'have','has','can','able','using','use','also','etc','into','onto','their',
  'they','them','these','those','which','what','when','where','while','about',
  'across','within','without','per','via','more','most','than','then','such',
  'some','any','all','each','every','other','others','including','include',
  'includes','strong','excellent','good','great','team','teams','work','works',
  'working','years','year','experience','experienced','knowledge','skills',
  'skill','ability','abilities','responsibilities','responsibility',
  'requirements','required','requirement','preferred','plus','job','role',
  'position','company','candidate','candidates','we','us','new','build','building',
  'speak','speaking','people','person','various','multiple','wide','range',
  'environment','environments','give','giving','well','help','helping','ensure',
  'ensuring','provide','providing','drive','driving','support','supporting',
  'make','made','like','want','wants','looking','seeking','ideal','right','fit',
  'who','what\'s','get','getting','take','taking','need','needs','needed','how',
  'key','expect','expected','join','head','develop','familiarity','familiar',
  'logistics','interview','process','decision','about','bonus','responsibilities',
  'why','here','client','clients','our','partner','partnering','partnered',
  'find','finding','found','treat','treats','grounded','emphasis','goal',
  'isn\'t','it\'s','you\'re','re-architect','retrofit','compounds','compound',
  'excited','because','opportunity'
]);

const CURATED_TECH = new Set([
  'javascript','typescript','python','java','c++','c#','go','golang','rust','ruby','php','swift','kotlin','scala',
  'react','reactjs','angular','vue','vuejs','nextjs','next.js','node','nodejs','node.js','express','django','flask','spring','springboot',
  'sql','mysql','postgresql','postgres','mongodb','redis','elasticsearch','dynamodb','cassandra','sqlite',
  'aws','azure','gcp','docker','kubernetes','k8s','terraform','jenkins','ci/cd','cicd','git','github','gitlab',
  'graphql','rest','restful','api','microservices','kafka','rabbitmq','spark','hadoop','airflow','etl',
  'html','css','sass','tailwind','webpack','babel','jest','cypress','selenium','pytest',
  'machine learning','ml','ai','deep learning','nlp','tensorflow','pytorch','pandas','numpy','scikit-learn',
  'langchain','langgraph','llamaindex','llm','rag','agentic','openai','anthropic','claude','gpt',
  'genai','mcp','finetuning','fine-tuning','kubernetes','observability',
  'figma','jira','confluence','splunk','elk','datadog','grafana','prometheus',
  'agile','scrum','kanban','devops','sre','linux','unix','bash','shell'
]);

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function tokenize(text) {
  return (text || '').toLowerCase().match(/[a-z0-9][a-z0-9+#.\-]*[a-z0-9]|[a-z0-9]/g) || [];
}

function titleCase(s) {
  const DISPLAY_OVERRIDES = {
    'node.js': 'Node.js', 'next.js': 'Next.js', 'c++': 'C++', 'c#': 'C#',
    'ci/cd': 'CI/CD', 'rest': 'REST', 'graphql': 'GraphQL', 'sql': 'SQL',
    'aws': 'AWS', 'gcp': 'GCP', 'api': 'API', 'nlp': 'NLP', 'llm': 'LLM',
    'rag': 'RAG', 'gpt': 'GPT', 'sre': 'SRE', 'ui': 'UI', 'ux': 'UX',
    'javascript': 'JavaScript', 'typescript': 'TypeScript', 'github': 'GitHub',
    'gitlab': 'GitLab', 'mongodb': 'MongoDB', 'postgresql': 'PostgreSQL',
    'dynamodb': 'DynamoDB', 'mysql': 'MySQL', 'html': 'HTML', 'css': 'CSS',
    'k8s': 'K8s', 'php': 'PHP', 'langgraph': 'LangGraph', 'langchain': 'LangChain',
    'llamaindex': 'LlamaIndex', 'ai-native': 'AI-Native', 'openai': 'OpenAI',
    'ai': 'AI', 'ml': 'ML', 'mlops': 'MLOps', 'genai': 'GenAI', 'mcp': 'MCP'
  };
  if (DISPLAY_OVERRIDES[s]) return DISPLAY_OVERRIDES[s];
  if (s.includes(' ')) {
    return s.split(' ').map(w => DISPLAY_OVERRIDES[w] || w.replace(/\b\w/g, c => c.toUpperCase())).join(' ');
  }
  return s.replace(/\b\w/g, c => c.toUpperCase());
}

function escapeRegexLib(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// What fraction of a term's occurrences in the ORIGINAL (non-lowercased)
// text start with an uppercase letter. Genuinely named tools/technologies
// (LangGraph, GraphQL, Python) are reliably capitalized every time they
// appear; a generic word is only capitalized when it happens to start a
// sentence, so its ratio stays low.
function capitalizationRatio(term, originalText) {
  const re = new RegExp(`\\b${escapeRegexLib(term)}\\b`, 'gi');
  let total = 0, capped = 0, m;
  while ((m = re.exec(originalText))) {
    total++;
    if (/^[A-Z]/.test(m[0])) capped++;
  }
  return total ? capped / total : 0;
}

function extractCandidates(jdText, limit = 25) {
  const fullText = String(jdText || '');
  const freq = new Map();

  // Process line-by-line and skip short, label/badge-like lines entirely.
  // Real JD prose and bullets are virtually never just 1-2 words on their
  // own line — this catches isolated badge fragments ("Verified",
  // "Applied", "On-Site", "Software") structurally, regardless of which
  // specific word a given job site's UI happens to use for them, rather
  // than requiring every such word to be individually enumerated.
  for (const line of fullText.split('\n')) {
    const lineWordCount = line.trim().split(/\s+/).filter(Boolean).length;
    if (lineWordCount < 3) continue;

    const tokens = tokenize(line);
    for (const t of tokens) {
      if (t.length < 3 || STOPWORDS.has(t) || /^\d+$/.test(t)) continue;
      freq.set(t, (freq.get(t) || 0) + 1);
    }
    for (let i = 0; i < tokens.length - 1; i++) {
      const a = tokens[i], b = tokens[i + 1];
      if (STOPWORDS.has(a) || STOPWORDS.has(b) || a.length < 3 || b.length < 3) continue;
      const bg = `${a} ${b}`;
      freq.set(bg, (freq.get(bg) || 0) + 1);
    }
  }

  // Merge naive singular/plural duplicates ("assessment" vs "assessments")
  // into one entry instead of letting them consume two separate candidate
  // slots for the same underlying requirement.
  for (const term of [...freq.keys()]) {
    if (!term.endsWith('s') || term.endsWith('ss')) continue;
    const singular = term.slice(0, -1);
    if (freq.has(singular)) {
      freq.set(singular, freq.get(singular) + freq.get(term));
      freq.delete(term);
    }
  }

  const properNoun = new Set();
  for (const term of freq.keys()) {
    if (capitalizationRatio(term, fullText) > 0.5) properNoun.add(term);
  }

  const ranked = [...freq.entries()].sort((a, b) => {
    const aStrong = (CURATED_TECH.has(a[0]) || properNoun.has(a[0])) ? 1 : 0;
    const bStrong = (CURATED_TECH.has(b[0]) || properNoun.has(b[0])) ? 1 : 0;
    if (aStrong !== bStrong) return bStrong - aStrong;
    return b[1] - a[1];
  });

  // Require a real signal for inclusion — curated tech, reliably
  // capitalized (proper-noun-like), or mentioned more than once. This
  // keeps one-off generic words from displacing genuinely repeated or
  // clearly-named requirements. Falls back to the unfiltered ranking if a
  // short JD doesn't leave enough qualifying candidates.
  const qualifies = ([term]) => CURATED_TECH.has(term) || properNoun.has(term);
  let pool = ranked.filter(qualifies);
  if (pool.length < Math.min(10, ranked.length)) pool = ranked;

  // Suppress any candidate that shares a word with one already selected —
  // e.g. once "machine learning" is selected, neither "machine" nor
  // "learning" nor "learning engineer" should also surface as separate,
  // redundant entries for the same underlying signal. The previous version
  // only blocked a later UNIGRAM from duplicating an already-selected
  // bigram; it never blocked a later bigram from overlapping an already-
  // selected unigram or bigram, which is exactly how "Machine", "Learning",
  // "Machine Learning", and "Learning Engineer" all ended up listed
  // separately.
  const selected = [];
  const usedWords = new Set();
  for (const [term] of pool) {
    if (selected.length >= limit) break;
    const words = term.split(' ');
    if (words.some(w => usedWords.has(w))) continue;
    selected.push(term);
    for (const w of words) usedWords.add(w);
  }
  return selected;
}

function buildResumeCorpus(resume) {
  const parts = [resume.summary || ''];
  for (const cat of resume.skills || []) parts.push(...(cat.items || []));
  for (const e of resume.experience || []) { parts.push(e.title || '', e.company || ''); parts.push(...(e.bullets || [])); }
  for (const p of resume.projects || []) { parts.push(p.name || ''); parts.push(...(p.bullets || [])); }
  for (const c of resume.certifications || []) parts.push(String(c));
  return parts.join(' \n ').toLowerCase();
}

function flatSkillItems(resume) {
  return (resume.skills || []).flatMap(c => (c.items || []).map(i => String(i)));
}

function corpusHas(corpus, term) {
  if (term.includes(' ') || /[+#.\-]/.test(term)) return corpus.includes(term);
  return new RegExp(`\\b${escapeRegex(term)}\\b`).test(corpus);
}

// ── ATS keyword-match score (deterministic, no AI call) ─────────────────────
export function computeAtsAnalysis(jobDescription, tailoredResume) {
  const candidates = extractCandidates(cleanJobDescriptionText(jobDescription || ''), 25);
  const resume = tailoredResume || {};
  const corpus = buildResumeCorpus(resume);
  const skillItemsLower = flatSkillItems(resume).map(s => s.toLowerCase());

  const matching_skills = [];
  const matching_technologies = [];
  const matching_responsibilities = [];
  const missing_requirements = [];

  for (const term of candidates) {
    if (!corpusHas(corpus, term)) {
      if (missing_requirements.length < 8) missing_requirements.push(titleCase(term));
      continue;
    }
    if (skillItemsLower.some(s => s.includes(term) || term.includes(s))) {
      if (matching_skills.length < 10) matching_skills.push(titleCase(term));
    } else if (CURATED_TECH.has(term)) {
      if (matching_technologies.length < 10) matching_technologies.push(titleCase(term));
    } else if (matching_responsibilities.length < 8) {
      matching_responsibilities.push(titleCase(term));
    }
  }

  const matchedCount = matching_skills.length + matching_technologies.length + matching_responsibilities.length;
  const score = candidates.length ? Math.round(Math.min(100, (matchedCount / candidates.length) * 100)) : 0;

  return {
    score,
    fit_signal: score,
    matching_skills,
    matching_technologies,
    matching_responsibilities,
    missing_requirements,
    // The panel's coverage messaging reads these — without them it would
    // show "0 of 0 requirements" even though real matching/missing counts
    // exist right above. This only runs when the AI path has failed twice.
    total_requirements: matchedCount + missing_requirements.length,
    covered_requirements: matchedCount,
    uncloseable_requirements: [],
    notes: 'Keyword-overlap estimate — the detailed AI evaluation was unavailable for this job. We never fabricate missing items.'
  };
}

// ── Structural diff between original and tailored resume JSON ───────────────
function normalize(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

function jaccard(a, b) {
  const sa = new Set(a.split(' ').filter(Boolean));
  const sb = new Set(b.split(' ').filter(Boolean));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter);
}

function dedupe(arr) { return [...new Set(arr)]; }

function diffBulletLists(origList, newList, labelFn, reordered, rewritten) {
  (newList || []).forEach((entry, idx) => {
    const origEntry = (origList || [])[idx];
    if (!origEntry) return;
    const origBullets = origEntry.bullets || [];
    const newBullets = entry.bullets || [];
    const origNorm = origBullets.map(normalize);
    const newNorm = newBullets.map(normalize);

    const sameSet = origNorm.length === newNorm.length && origNorm.every(b => newNorm.includes(b));
    if (sameSet && origNorm.join('|') !== newNorm.join('|')) {
      reordered.push(`Reordered bullets in ${labelFn(entry)} to lead with the most relevant ones.`);
    }

    const usedOrig = new Set();
    newBullets.forEach(nb => {
      const nbNorm = normalize(nb);
      if (origNorm.includes(nbNorm)) return; // unchanged (possibly just reordered)
      let best = -1, bestScore = 0;
      origBullets.forEach((ob, i) => {
        if (usedOrig.has(i)) return;
        const score = jaccard(normalize(ob), nbNorm);
        if (score > bestScore) { bestScore = score; best = i; }
      });
      if (best >= 0 && bestScore >= 0.15) {
        usedOrig.add(best);
        rewritten.push({ before: origBullets[best], after: nb });
      }
    });

    // Positional fallback: same-length lists where a bullet changed but no
    // word-overlap match was found above (a complete rephrase) — pair by
    // index so the rewrite still shows up instead of disappearing silently.
    if (origBullets.length === newBullets.length) {
      newBullets.forEach((nb, i) => {
        if (usedOrig.has(i)) return;
        if (normalize(nb) === origNorm[i]) return;
        if (rewritten.some(r => r.after === nb)) return;
        usedOrig.add(i);
        rewritten.push({ before: origBullets[i], after: nb });
      });
    }
  });
}

export function computeChangeSummary(original, tailored) {
  const orig = original || {};
  const tail = tailored || {};
  const added = [];
  const removed = [];
  const reordered = [];
  const rewritten_bullets = [];

  const origSkills = flatSkillItems(orig);
  const newSkills = flatSkillItems(tail);
  const origSet = new Set(origSkills.map(s => s.toLowerCase()));
  const newSet = new Set(newSkills.map(s => s.toLowerCase()));

  for (const s of newSkills) if (!origSet.has(s.toLowerCase())) added.push(`Added or emphasized skill: ${s}`);
  for (const s of origSkills) if (!newSet.has(s.toLowerCase())) removed.push(`Removed skill: ${s}`);

  const origOrderKey = origSkills.filter(s => newSet.has(s.toLowerCase())).map(s => s.toLowerCase()).join('|');
  const newOrderKey = newSkills.filter(s => origSet.has(s.toLowerCase())).map(s => s.toLowerCase()).join('|');
  if (origOrderKey && newOrderKey && origOrderKey !== newOrderKey) {
    reordered.push('Reordered skills so the most JD-relevant ones appear first.');
  }

  if (normalize(orig.summary) !== normalize(tail.summary) && normalize(tail.summary)) {
    reordered.push('Rewrote the professional summary to speak directly to this role.');
  }

  diffBulletLists(orig.experience, tail.experience, e => `${e.title || 'role'} at ${e.company || 'company'}`, reordered, rewritten_bullets);
  diffBulletLists(orig.projects, tail.projects, p => p.name || 'project', reordered, rewritten_bullets);

  return {
    added: dedupe(added).slice(0, 12),
    removed: dedupe(removed).slice(0, 12),
    reordered: dedupe(reordered).slice(0, 8),
    rewritten_bullets: rewritten_bullets.slice(0, 10)
  };
}
