/* ===========================================================================
 * Shared UI utilities — toasts, modals, navigation, mock data, diff
 * ========================================================================= */
import { icon } from "./icons.js";
import { getUser, logout } from "./api.js";

// ---- Toasts ----
function ensureToastWrap() {
  let el = document.querySelector(".toast-wrap");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast-wrap";
    document.body.appendChild(el);
  }
  return el;
}

export function toast(message, kind = "info", timeout = 3500) {
  const wrap = ensureToastWrap();
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `${icon(kind === "success" ? "check" : kind === "error" ? "warning" : "spark", 16)}<div style="flex:1">${message}</div>`;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity 0.2s ease";
    setTimeout(() => el.remove(), 200);
  }, timeout);
}

// ---- Confirm modal ----
export function confirmDialog({ title, body, confirmText = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal">
        <h3>${title}</h3>
        <p>${body}</p>
        <div class="modal-footer">
          <button class="btn btn-outline" data-act="cancel">Cancel</button>
          <button class="btn ${danger ? "btn-danger" : ""}" data-act="confirm">${confirmText}</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) { backdrop.remove(); resolve(false); }
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "cancel") { backdrop.remove(); resolve(false); }
      if (act === "confirm") { backdrop.remove(); resolve(true); }
    });
  });
}

// ---- Render shared topbar ----
export async function renderTopbar(activeRoute = "tailor") {
  const user = await getUser();
  const host = document.querySelector("#topbar");
  if (!host) return;
  host.innerHTML = `
    <header class="topbar">
      <div class="topbar-inner">
        <a class="brand" href="app.html">
          <div class="mark">${icon("spark", 16)}</div>
          <div class="name">
            <strong>TRUERESUME</strong>
            <span>ATS Tailoring Engine</span>
          </div>
        </a>
        <nav class="nav">
          <a class="nav-link ${activeRoute === "tailor" ? "active" : ""}" href="app.html">${icon("spark", 14)} New tailoring</a>
          <a class="nav-link ${activeRoute === "history" ? "active" : ""}" href="history.html">${icon("history", 14)} History</a>
          ${user ? `<div class="dropdown" id="userMenu">
            <button class="nav-link" data-toggle="userMenuM" style="border:1px solid var(--neutral-200);background:white;cursor:pointer">
              <span style="display:inline-flex;width:24px;height:24px;background:#171717;color:white;align-items:center;justify-content:center;font-weight:700;font-size:11px">${(user.name || user.email || "U").slice(0,1).toUpperCase()}</span>
              <span style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${user.name || user.email}</span>
            </button>
            <div class="dropdown-menu" id="userMenuM">
              <div style="padding:8px 12px;font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--muted)">${user.email}</div>
              <div class="dropdown-divider"></div>
              <button class="dropdown-item danger" id="signOutBtn">${icon("signOut", 14)} Sign out</button>
            </div>
          </div>` : `<a class="btn btn-sm" href="auth.html">Sign in</a>`}
        </nav>
      </div>
    </header>`;

  // dropdown toggle
  host.querySelectorAll("[data-toggle]").forEach((t) => {
    t.addEventListener("click", (e) => {
      e.stopPropagation();
      const m = document.getElementById(t.dataset.toggle);
      m?.classList.toggle("open");
    });
  });
  document.addEventListener("click", () => {
    document.querySelectorAll(".dropdown-menu.open").forEach((m) => m.classList.remove("open"));
  });

  document.getElementById("signOutBtn")?.addEventListener("click", async () => {
    await logout();
    location.href = "auth.html";
  });
}

export function renderFooter() {
  const host = document.querySelector("#footer");
  if (!host) return;
  host.innerHTML = `
    <footer class="footer">
      <div class="container">
        <div class="label-overline">Truthfulness first · ATS-aligned</div>
        <div class="mono">© ${new Date().getFullYear()} TrueResume</div>
      </div>
    </footer>`;
}

// ---- Word-level LCS diff (for Compare tab) ----
function tokenize(s) { return (s || "").split(/(\s+)/).filter((t) => t.length > 0); }
function lcsMatrix(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}
export function wordDiff(before, after) {
  const a = tokenize(before), b = tokenize(after), dp = lcsMatrix(a, b);
  const out = []; let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ t: "eq", x: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: "del", x: a[i++] }); }
    else { out.push({ t: "add", x: b[j++] }); }
  }
  while (i < a.length) out.push({ t: "del", x: a[i++] });
  while (j < b.length) out.push({ t: "add", x: b[j++] });
  return out;
}

export function resumeJsonToText(resume) {
  if (!resume) return "";
  const L = [];
  const c = resume.contact || {};
  if (resume.name) L.push(resume.name);
  const top = [c.email, c.phone, c.location, c.linkedin, c.portfolio].filter(Boolean);
  if (top.length) L.push(top.join(" • "));
  L.push("");
  if (resume.summary) { L.push("SUMMARY"); L.push(resume.summary); L.push(""); }
  const skillCats = (resume.skills || []).filter(s => (s.items || []).length);
  if (skillCats.length) {
    L.push("SKILLS");
    for (const cat of skillCats) {
      L.push(`${cat.category ? cat.category + ": " : ""}${(cat.items || []).join(" • ")}`);
    }
    L.push("");
  }
  if ((resume.experience || []).length) {
    L.push("EXPERIENCE");
    for (const e of resume.experience) {
      L.push(`${e.title || ""} — ${e.company || ""}`.trim());
      const sub = [e.location, e.dates].filter(Boolean).join(" | ");
      if (sub) L.push(sub);
      for (const b of e.bullets || []) L.push(`• ${b}`);
      L.push("");
    }
  }
  if ((resume.projects || []).length) {
    L.push("PROJECTS");
    for (const p of resume.projects) {
      L.push(`${p.name || ""}`);
      if (p.dates) L.push(p.dates);
      for (const b of p.bullets || []) L.push(`• ${b}`);
      L.push("");
    }
  }
  if ((resume.education || []).length) {
    L.push("EDUCATION");
    for (const ed of resume.education) {
      L.push(`${ed.degree || ""} — ${ed.institution || ""}`.trim());
      const sub = [ed.location, ed.dates].filter(Boolean).join(" | ");
      if (sub) L.push(sub);
      L.push("");
    }
  }
  if ((resume.certifications || []).length) {
    L.push("CERTIFICATIONS");
    for (const c2 of resume.certifications) L.push(`• ${c2}`);
    L.push("");
  }
  return L.join("\n").trim();
}

// ---- Mock data (for demoing the UI without backend) ----
export const MOCK_RESULT = {
  id: "demo-001",
  created_at: new Date().toISOString(),
  job_title: "Senior Frontend Engineer at Acme",
  resume_text: "Jane Doe\njane@example.com • +1 555 0100 • San Francisco, CA\n\nSUMMARY\nProduct-focused frontend engineer with 7 years of experience building accessible web apps.\n\nSKILLS\nJavaScript • React • Redux • Node • CSS • HTML • Git\n\nEXPERIENCE\nFrontend Engineer — Initech\nSan Francisco | 2022 – Present\n• Built admin dashboards used by 1000+ internal users.\n• Migrated legacy jQuery codebase to React.\n• Improved page load times by 40%.\n\nFrontend Engineer — Pied Piper\nRemote | 2019 – 2022\n• Owned the design system across 4 product surfaces.\n• Mentored 3 junior engineers.\n\nPROJECTS\nPersonal site — janedoe.dev\nReact, Next.js\n• Static site with MDX-powered blog.\n\nEDUCATION\nBSc Computer Science — UC Berkeley\nBerkeley, CA | 2015 – 2019",
  result: {
    tailored_resume: {
      name: "Jane Doe",
      contact: { email: "jane@example.com", phone: "+1 555 0100", location: "San Francisco, CA", linkedin: "linkedin.com/in/janedoe", portfolio: "janedoe.dev" },
      summary: "Product-focused Senior Frontend Engineer with 7 years building accessible, performant React applications. Strong in TypeScript, design systems, and frontend performance.",
      skills: [
        { category: "Languages", items: ["TypeScript", "JavaScript", "HTML", "CSS"] },
        { category: "Frameworks", items: ["React", "Next.js", "Redux"] },
        { category: "Other", items: ["Design Systems", "Accessibility (WCAG)", "Performance Tuning", "Node.js", "Git"] },
      ],
      experience: [
        { title: "Senior Frontend Engineer", company: "Initech", location: "San Francisco", dates: "2022 – Present",
          bullets: [
            "Owned the React + TypeScript admin platform used by 1000+ internal operators.",
            "Led migration from jQuery to a typed React design system, retiring 18K lines of legacy code.",
            "Improved Largest Contentful Paint by 40% across the dashboard surface.",
          ] },
        { title: "Frontend Engineer", company: "Pied Piper", location: "Remote", dates: "2019 – 2022",
          bullets: [
            "Built and maintained the cross-surface design system used by 4 products.",
            "Mentored 3 junior engineers on React patterns, testing, and accessibility.",
          ] },
      ],
      projects: [
        { name: "janedoe.dev", dates: "2023", bullets: ["Personal site with MDX-powered blog and dark mode, built with React + Next.js."] },
      ],
      education: [{ degree: "BSc Computer Science", institution: "UC Berkeley", location: "Berkeley, CA", dates: "2015 – 2019" }],
      certifications: [],
    },
    ats_analysis: {
      score: 87,
      matching_skills: ["TypeScript", "React", "Design Systems", "Accessibility", "Performance"],
      matching_technologies: ["React", "Next.js", "Redux", "Node.js"],
      matching_responsibilities: ["Mentoring", "Owning a frontend codebase", "Performance work"],
      missing_requirements: ["GraphQL experience", "Storybook ownership", "iOS/Swift exposure"],
      notes: "Strong match overall. Missing items were not added because they are not present in your sources of truth."
    },
    change_summary: {
      added: ["Promoted role title to Senior in summary (only if your resume supported it)", "Surfaced TypeScript + design systems higher in Skills"],
      removed: ["Older Git tooling references"],
      reordered: ["Moved Experience above Projects", "Skills sorted by JD-relevance"],
      rewritten_bullets: [
        { before: "Built admin dashboards used by 1000+ internal users.", after: "Owned the React + TypeScript admin platform used by 1000+ internal operators." },
        { before: "Improved page load times by 40%.", after: "Improved Largest Contentful Paint by 40% across the dashboard surface." }
      ]
    },
    cover_letter: "Dear Acme Hiring Team,\n\nI'm applying for the Senior Frontend Engineer role because the work you describe — building accessible, performant React applications at scale — is exactly what I've spent the last 7 years doing.\n\nAt Initech, I rebuilt our internal admin platform in React + TypeScript and led the migration off a 5-year-old jQuery codebase. The team now ships features twice as fast and our LCP dropped by 40%. Before that, at Pied Piper, I owned the cross-surface design system that four product teams depended on day to day.\n\nI'd love to bring that combination — strong design-system fundamentals plus real performance work — to Acme.\n\nSincerely,\nJane Doe",
    application_qa: [
      { question: "Why are you interested in this role?", answer: "The Acme role specifically calls out design systems and frontend performance — two areas I've intentionally specialized in over the last four years. I want to keep doing this work at a place that takes it seriously." },
      { question: "Describe a project you're proud of.", answer: "Migrating Initech's admin platform from jQuery to React + TypeScript. I scoped it, wrote the migration plan, and led three engineers through it over six months. We retired 18K lines of legacy code with zero regressions and cut average page load times by 40%." }
    ]
  }
};

// ---- escape / dedupe helpers ----
export const esc = (s) => (s == null ? "" : String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])));
