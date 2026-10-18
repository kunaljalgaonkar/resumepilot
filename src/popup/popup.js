// ResumePilot — Toolbar Popup
// Purely a launcher and account card. All workflow lives in the ✦ floating panel.

const $ = id => document.getElementById(id);

async function init() {
  const stored = await chrome.storage.local.get(['user']);
  const user = stored.user;

  if (user) {
    $('acct-in').classList.remove('hidden');
    $('acct-out').classList.add('hidden');
    $('acct-name-val').textContent = user.name || '';
    $('acct-email-val').textContent = user.email || '';
    $('btn-signout-action').classList.remove('hidden');
  } else {
    $('acct-in').classList.add('hidden');
    $('acct-out').classList.remove('hidden');
    $('btn-signout-action').classList.add('hidden');
  }
}

$('btn-signout')?.addEventListener('click', signOut);
$('btn-signout-action')?.addEventListener('click', signOut);

async function signOut() {
  const stored = await chrome.storage.local.get(['user', 'resumeData', 'skillProfile']);
  if (stored.user?.email && stored.resumeData) {
    const key = `profile_${stored.user.email}`;
    await chrome.storage.local.set({ [key]: { resumeData: stored.resumeData, skillProfile: stored.skillProfile } });
  }
  await chrome.storage.local.remove(['user', 'token', 'resumeData', 'skillProfile', 'parsedResumeText', 'userName']);
  $('acct-in').classList.add('hidden');
  $('acct-out').classList.remove('hidden');
  $('btn-signout-action').classList.add('hidden');
  toast('Signed out');
}

$('btn-signin-bar')?.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/pages/auth.html') });
  window.close();
});

$('btn-tracker')?.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/pages/tracker.html') });
  window.close();
});

$('btn-edit-profile')?.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/onboarding/onboarding.html') });
  window.close();
});

$('btn-view-plans')?.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/pages/plans.html') });
  window.close();
});

function toast(msg) {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2000);
}

init();
