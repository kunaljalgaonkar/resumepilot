// ResumePilot — Application Tracker (external JS, CSP-compliant)
'use strict';

let allApps = [];
let allPrepItems = [];

// Same real-doc-first pattern as the panel's version — kept as a small,
// separate copy since this page has no shared module system with panel.js.
const LEARNING_RESOURCES = {
  'kubernetes':   'https://kubernetes.io/docs/tutorials/',
  'docker':       'https://docs.docker.com/get-started/',
  'rust':         'https://doc.rust-lang.org/book/',
  'graphql':      'https://graphql.org/learn/',
  'pytorch':      'https://pytorch.org/tutorials/',
  'tensorflow':   'https://www.tensorflow.org/tutorials',
  'langchain':    'https://python.langchain.com/docs/tutorials/',
  'langgraph':    'https://langchain-ai.github.io/langgraph/tutorials/',
  'terraform':    'https://developer.hashicorp.com/terraform/tutorials',
  'kafka':        'https://kafka.apache.org/quickstart',
  'spark':        'https://spark.apache.org/docs/latest/quick-start.html',
  'elasticsearch':'https://www.elastic.co/guide/en/elasticsearch/reference/current/quickstart.html',
};
function resourceFor(skill) {
  const k = skill.toLowerCase().trim();
  for (const [name, url] of Object.entries(LEARNING_RESOURCES)) {
    if (k.includes(name) || name.includes(k)) return url;
  }
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(skill + ' tutorial')}`;
}

// ── Load ──────────────────────────────────────────────────────────────────
async function load() {
  if (typeof chrome === 'undefined' || !chrome.storage) {
    allApps = [
      { id: 'demo1', company: 'DoorDash', jobTitle: 'Software Engineer, ML Infrastructure', appliedAt: Date.now() - 86400000, status: 'interview', url: '', fingerprint: 'demo1' },
      { id: 'demo2', company: 'OpenAI', jobTitle: 'Applied AI Engineer', appliedAt: Date.now() - 2*86400000, status: 'applied', url: '', fingerprint: 'demo2' },
    ];
    allPrepItems = [];
  } else {
    const stored = await chrome.storage.local.get(['applicationLog', 'skillsToPrepare']);
    allApps = stored.applicationLog || [];
    allPrepItems = stored.skillsToPrepare || [];
  }
  renderStats();
  renderTable();
  renderPrepList();
}

// ── Stats ─────────────────────────────────────────────────────────────────
function renderStats() {
  const now = Date.now();
  const weekAgo = now - 7 * 86400000;
  document.getElementById('stat-total').textContent = allApps.length;
  document.getElementById('stat-week').textContent = allApps.filter(a => a.appliedAt >= weekAgo).length;
  document.getElementById('stat-interviews').textContent = allApps.filter(a => a.status === 'interview').length;
  document.getElementById('stat-offers').textContent = allApps.filter(a => a.status === 'offer').length;
}

// ── Table ─────────────────────────────────────────────────────────────────
function renderTable() {
  const search = document.getElementById('search').value.toLowerCase();
  const filterStatus = document.getElementById('filter-status').value;
  const filterPeriod = document.getElementById('filter-period').value;
  const now = Date.now();

  const filtered = allApps.filter(a => {
    if (search && !a.company.toLowerCase().includes(search) && !(a.jobTitle||'').toLowerCase().includes(search)) return false;
    if (filterStatus && a.status !== filterStatus) return false;
    if (filterPeriod === 'week' && a.appliedAt < now - 7*86400000) return false;
    if (filterPeriod === 'month' && a.appliedAt < now - 30*86400000) return false;
    return true;
  });

  const list = document.getElementById('app-list');
  list.innerHTML = '';

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `
      <div class="empty-icon">📋</div>
      <div class="empty-title">${allApps.length === 0 ? 'No applications yet' : 'No results'}</div>
      <div class="empty-body">${allApps.length === 0
        ? 'When you click Apply on a job page with ResumePilot open, it\'s automatically logged here.'
        : 'Try adjusting your search or filters.'}</div>
    `;
    if (allApps.length === 0) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.textContent = '+ Add your first application';
      btn.addEventListener('click', openAddModal);
      empty.appendChild(btn);
    }
    list.appendChild(empty);
    return;
  }

  filtered.forEach(a => {
    const row = document.createElement('div');
    row.className = 'app-row';
    row.id = 'row-' + a.id;

    // Company/role cell
    const cellRole = document.createElement('div');
    const nameEl = document.createElement('div');
    nameEl.className = 'app-company';
    nameEl.textContent = a.company || '—';
    const roleEl = document.createElement('div');
    roleEl.className = 'app-role';
    roleEl.title = a.jobTitle || '';
    roleEl.textContent = a.jobTitle || '—';
    cellRole.appendChild(nameEl);
    cellRole.appendChild(roleEl);

    // Skills the user added for this application
    if (Array.isArray(a.addedSkills) && a.addedSkills.length) {
      const skillsWrap = document.createElement('div');
      skillsWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:5px;';
      a.addedSkills.slice(0, 5).forEach(s => {
        const skillName = typeof s === 'string' ? s : s.skill;
        const placedIn = typeof s === 'object' ? s.target : null;
        const tag = document.createElement('span');
        const isExp = placedIn && placedIn !== 'Skills';
        tag.style.cssText = isExp
          ? 'font-size:9.5px;padding:2px 6px;border-radius:8px;background:rgba(34,197,94,0.14);color:#22c55e;border:1px solid rgba(34,197,94,0.25);'
          : 'font-size:9.5px;padding:2px 6px;border-radius:8px;background:rgba(79,124,255,0.12);color:#4f7cff;border:1px solid rgba(79,124,255,0.22);';
        tag.textContent = skillName;
        tag.title = isExp ? `Added to experience: ${placedIn}` : 'Listed under Skills';
        skillsWrap.appendChild(tag);
      });
      if (a.addedSkills.length > 5) {
        const more = document.createElement('span');
        more.style.cssText = 'font-size:9.5px;color:var(--text-2);padding:2px 4px;';
        more.textContent = `+${a.addedSkills.length - 5}`;
        skillsWrap.appendChild(more);
      }
      cellRole.appendChild(skillsWrap);

      // Prep note for skills the user listed as familiar rather than hands-on.
      const familiar = a.addedSkills.filter(s => typeof s === 'object' && s.targetType === 'skills');
      if (familiar.length) {
        const note = document.createElement('div');
        note.style.cssText = 'font-size:9.5px;color:#f59e0b;margin-top:4px;';
        note.textContent = `📚 Brush up before interview: ${familiar.map(s => s.skill).join(', ')}`;
        note.title = 'You listed these as familiar rather than hands-on';
        cellRole.appendChild(note);
      }
    }
    row.appendChild(cellRole);

    // Date
    const dateEl = document.createElement('div');
    dateEl.className = 'app-date';
    dateEl.textContent = formatDate(a.appliedAt);
    row.appendChild(dateEl);

    // Status dropdown
    const statusEl = document.createElement('div');
    const sel = document.createElement('select');
    sel.className = 'status-select';
    sel.style.cssText = `background:${statusBg(a.status)};color:${statusColor(a.status)};border-radius:20px;padding:3px 8px;border:none;font-family:inherit;font-size:11px;font-weight:600;cursor:pointer;outline:none;`;
    ['applied','interview','offer','rejected'].forEach(s => {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s.charAt(0).toUpperCase() + s.slice(1);
      if (a.status === s) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => updateStatus(a.id, sel.value));
    statusEl.appendChild(sel);
    row.appendChild(statusEl);

    // Source
    const srcEl = document.createElement('div');
    srcEl.className = 'app-date';
    srcEl.textContent = sourceLabel(a.url, a.source);
    row.appendChild(srcEl);

    // Actions
    const actionsEl = document.createElement('div');
    actionsEl.className = 'row-actions';
    if (a.url) {
      const linkBtn = document.createElement('button');
      linkBtn.className = 'row-btn';
      linkBtn.title = 'Open job posting';
      linkBtn.textContent = '↗';
      linkBtn.addEventListener('click', () => window.open(a.url, '_blank'));
      actionsEl.appendChild(linkBtn);
    }
    const delBtn = document.createElement('button');
    delBtn.className = 'row-btn';
    delBtn.title = 'Delete';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', () => deleteApp(a.id));
    actionsEl.appendChild(delBtn);
    row.appendChild(actionsEl);

    list.appendChild(row);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────
function statusBg(s) {
  return {applied:'rgba(79,124,255,0.15)',interview:'rgba(245,158,11,0.15)',offer:'rgba(34,197,94,0.15)',rejected:'rgba(239,68,68,0.1)'}[s] || '';
}
function statusColor(s) {
  return {applied:'#4f7cff',interview:'#f59e0b',offer:'#22c55e',rejected:'#ef4444'}[s] || '#6b7698';
}
function sourceLabel(url, source) {
  if (source === 'confirmation_url') return '✓ Confirmed';
  if (source === 'success_text') return '✓ Confirmed';
  if (source === 'resume_injected') return 'Injected';
  if (source === 'pdf_downloaded') return 'Downloaded';
  if (!url) return '—';
  if (url.includes('linkedin.com')) return 'LinkedIn';
  if (url.includes('greenhouse.io')) return 'Greenhouse';
  if (url.includes('lever.co')) return 'Lever';
  if (url.includes('ashbyhq.com')) return 'Ashby';
  if (url.includes('indeed.com')) return 'Indeed';
  try { return new URL(url).hostname.replace('www.','').replace('jobs.','').replace('careers.','').split('.')[0]; }
  catch { return 'Direct'; }
}
function formatDate(ts) {
  return new Date(ts).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
}

// ── Actions ───────────────────────────────────────────────────────────────
async function updateStatus(id, newStatus) {
  const app = allApps.find(a => a.id === id);
  if (!app) return;
  app.status = newStatus;
  // Re-style the select
  const sel = document.querySelector(`#row-${id} select`);
  if (sel) { sel.style.background = statusBg(newStatus); sel.style.color = statusColor(newStatus); }
  await save();
  renderStats();
  showToast('Status updated');
}

async function deleteApp(id) {
  if (!confirm('Remove this application from your tracker?')) return;
  allApps = allApps.filter(a => a.id !== id);
  await save();
  renderStats();
  renderTable();
  showToast('Application removed');
}

// ── Add manually ──────────────────────────────────────────────────────────
function openAddModal() {
  document.getElementById('m-date').value = new Date().toISOString().slice(0,10);
  document.getElementById('add-modal').classList.add('show');
}
function closeAddModal() {
  document.getElementById('add-modal').classList.remove('show');
}
async function saveManual() {
  const company = document.getElementById('m-company').value.trim();
  const role    = document.getElementById('m-role').value.trim();
  const date    = document.getElementById('m-date').value;
  if (!company || !role) { showToast('Company and role are required'); return; }
  const entry = {
    id: `manual_${Date.now()}`,
    company, jobTitle: role,
    appliedAt: date ? new Date(date).getTime() : Date.now(),
    status: document.getElementById('m-status').value,
    url: document.getElementById('m-url').value.trim(),
    fingerprint: `manual_${Date.now()}`,
    source: 'manual'
  };
  allApps.unshift(entry);
  await save();
  renderStats(); renderTable();
  closeAddModal();
  showToast('Application added ✓');
  ['m-company','m-role','m-url'].forEach(id => { document.getElementById(id).value = ''; });
}

async function save() {
  if (typeof chrome !== 'undefined' && chrome.storage) {
    await chrome.storage.local.set({ applicationLog: allApps });
  }
}

// ── Skills to Prepare ────────────────────────────────────────────────────
function renderPrepList() {
  const list = document.getElementById('prep-list');
  list.innerHTML = '';

  if (!allPrepItems.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `<div class="empty-icon">📚</div><div class="empty-title">Nothing to prepare yet</div>` +
      `<div class="empty-body">When you mark a skill as "familiar" or "don't know it" while tailoring, it'll show up here with a link to learn it.</div>`;
    list.appendChild(empty);
    return;
  }

  // Newest first — matches how they were marked, most recent job first.
  const sorted = [...allPrepItems].sort((a, b) => (b.markedAt || 0) - (a.markedAt || 0));

  sorted.forEach(item => {
    const row = document.createElement('div');
    row.className = 'prep-row';

    const skill = document.createElement('div');
    skill.className = 'prep-skill';
    skill.textContent = item.skill;

    const context = document.createElement('div');
    context.className = 'prep-context';
    const parts = [item.jobTitle, item.company].filter(Boolean);
    context.textContent = parts.length ? parts.join(' @ ') : '—';

    const badge = document.createElement('div');
    badge.className = `prep-badge ${item.status === 'familiar' ? 'familiar' : 'declined'}`;
    badge.textContent = item.status === 'familiar' ? 'Familiar' : "Don't know";

    const link = document.createElement('a');
    link.className = 'prep-link';
    link.href = resourceFor(item.skill);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Learn it →';

    row.appendChild(skill); row.appendChild(context); row.appendChild(badge); row.appendChild(link);
    list.appendChild(row);
  });
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

// ── Wire event listeners (no inline handlers — CSP compliant) ─────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-back').addEventListener('click', () => window.close());
  document.getElementById('btn-add-manual').addEventListener('click', openAddModal);
  document.getElementById('search').addEventListener('input', renderTable);
  document.getElementById('filter-status').addEventListener('change', renderTable);
  document.getElementById('filter-period').addEventListener('change', renderTable);
  document.getElementById('btn-cancel-modal').addEventListener('click', closeAddModal);
  document.getElementById('btn-save-modal').addEventListener('click', saveManual);
  document.getElementById('add-modal').addEventListener('click', e => { if (e.target.id === 'add-modal') closeAddModal(); });

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    });
  });

  load();
});
