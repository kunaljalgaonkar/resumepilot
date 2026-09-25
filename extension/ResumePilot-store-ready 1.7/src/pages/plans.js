// ── Load user state from chrome.storage ─────────────────────────────────
async function loadUserState() {
  if (typeof chrome === 'undefined' || !chrome.storage) return;
  const stored = await chrome.storage.local.get(['user', 'atsUsageCount', 'applicationProgress', 'applicationGoal']);
  const user = stored.user;

  if (user) {
    document.getElementById('user-pill').style.display = 'flex';
    document.getElementById('user-name-display').textContent = user.name || user.email || 'Account';

    // ATS usage
    const atsUsed = Number(stored.atsUsageCount || 0);
    const atsLimit = 6; // free limit
    const atsPct = Math.min(100, (atsUsed / atsLimit) * 100);
    document.getElementById('ats-used').textContent = atsUsed;
    document.getElementById('ats-limit').textContent = atsLimit;
    const atsBar = document.getElementById('ats-bar');
    atsBar.style.width = atsPct + '%';
    if (atsPct >= 100) atsBar.classList.add('full');
    else if (atsPct >= 67) atsBar.classList.add('warning');

    // Application count
    const goal = stored.applicationGoal;
    const progress = stored.applicationProgress;
    const appCount = progress?.count || 0;
    document.getElementById('app-count').textContent = appCount;
    if (goal?.count) {
      const appPct = Math.min(100, (appCount / goal.count) * 100);
      document.getElementById('app-bar').style.width = appPct + '%';
    }

    document.getElementById('usage-card').classList.add('show');

    // Mark current plan (free for now until payments live)
    markCurrentPlan('free');
  }
}

function markCurrentPlan(plan) {
  // Update Free card
  if (plan === 'free') {
    const freeBtnEl = document.getElementById('btn-free');
    freeBtnEl.textContent = '✓ Your current plan';
    freeBtnEl.className = 'plan-btn current-btn';
    const freeCard = document.getElementById('card-free');
    freeCard.classList.add('current-plan');
    const badge = document.createElement('div');
    badge.className = 'current-badge'; badge.textContent = '✓ Current plan';
    freeCard.prepend(badge);
  }
}

// ── Billing toggle ────────────────────────────────────────────────────────
let isAnnual = true;
document.getElementById('billing-toggle').addEventListener('click', function() {
  this.classList.toggle('annual');
  isAnnual = this.classList.contains('annual');
  updatePrices();
});

function updatePrices() {
  const monthly = 16.99;
  const annual = (monthly * 0.7).toFixed(2);
  const price = isAnnual ? annual : monthly.toFixed(2);
  document.getElementById('pro-price').innerHTML =
    `<sup>$</sup>${price}<span> / mo${isAnnual ? ' · billed annually' : ''}</span>`;
  document.getElementById('pro-cta-price').textContent = `$${price}/mo`;
}

// ── Plan button handlers ──────────────────────────────────────────────────
document.getElementById('btn-free').addEventListener('click', function() {
  if (this.classList.contains('current-btn')) return;
  window.close();
});

document.getElementById('btn-pro').addEventListener('click', function() {
  openModal('PRO');
});

document.getElementById('btn-teams').addEventListener('click', function() {
  openModal('TEAMS');
});

// ── Coming soon modal ─────────────────────────────────────────────────────
function openModal(planName) {
  document.getElementById('modal-plan-name').textContent = planName;
  document.getElementById('notify-success').style.display = 'none';
  // Pre-fill email if user is signed in
  if (typeof chrome !== 'undefined' && chrome.storage) {
    chrome.storage.local.get(['user'], r => {
      if (r.user?.email) document.getElementById('notify-email').value = r.user.email;
    });
  }
  document.getElementById('modal').classList.add('show');
}

window.closeModal = function() {
  document.getElementById('modal').classList.remove('show');
};

document.getElementById('modal').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
});

window.submitNotify = async function() {
  const email = document.getElementById('notify-email').value.trim();
  if (!email || !email.includes('@')) {
    showToast('Please enter a valid email address');
    return;
  }
  // Store notify email in chrome.storage so we can batch-collect later
  if (typeof chrome !== 'undefined' && chrome.storage) {
    const stored = await chrome.storage.local.get(['notifyList']);
    const list = stored.notifyList || [];
    if (!list.includes(email)) list.push(email);
    await chrome.storage.local.set({ notifyList: list });
  }
  document.getElementById('notify-success').style.display = 'block';
  showToast('You\'re on the list ✓');
};

// ── FAQ accordion ─────────────────────────────────────────────────────────
document.querySelectorAll('.faq-q').forEach(q => {
  q.addEventListener('click', () => {
    const answer = q.nextElementSibling;
    const isOpen = q.classList.contains('open');
    // Close all
    document.querySelectorAll('.faq-q').forEach(el => { el.classList.remove('open'); el.nextElementSibling.classList.remove('open'); });
    if (!isOpen) { q.classList.add('open'); answer.classList.add('open'); }
  });
});

// ── Toast ─────────────────────────────────────────────────────────────────
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

// ── Init ──────────────────────────────────────────────────────────────────
updatePrices();
loadUserState();

// ── Wire previously-inline handlers (CSP-compliant) ───────────────────────
document.getElementById('btn-back-ext')?.addEventListener('click', (e) => { e.preventDefault(); window.close(); });
document.getElementById('btn-modal-close')?.addEventListener('click', () => closeModal());
document.getElementById('btn-notify')?.addEventListener('click', () => submitNotify());
