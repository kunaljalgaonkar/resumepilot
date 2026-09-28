/* Result page — renders all 5 outputs (Resume, Compare, Changes, Cover, Q&A, Raw). */
import { icon } from "./icons.js";
import { renderTopbar, renderFooter, toast, wordDiff, resumeJsonToText, esc, MOCK_RESULT } from "./common.js";
import { getTailoring, downloadFile, openInNewTab, getUser } from "./api.js";

(async () => {
  const params = new URLSearchParams(location.search);
  const id = params.get("id");
  const isDemo = !id || id === "demo";

  const u = await getUser();
  if (!u && !isDemo) { location.href = "auth.html"; return; }
  await renderTopbar("history");
  renderFooter();

  // Load data (falls back to mock if id is missing or fetch fails — for design preview)
  let data;
  if (isDemo) {
    data = MOCK_RESULT;
  } else {
    try { data = await getTailoring(id); }
    catch (e) {
      toast(e.detail || "Could not load result. Showing demo.", "error");
      data = MOCK_RESULT;
    }
  }

  const result = data.result || {};
  const resume = result.tailored_resume || {};
  const ats = result.ats_analysis || {};
  const changes = result.change_summary || {};
  const qa = result.application_qa || [];
  const coverLetter = result.cover_letter || "";

  // Header
  document.getElementById("backLink").innerHTML = `${icon("arrowLeft", 14)} Back to history`;
  document.getElementById("jobTitle").textContent = data.job_title || "Untitled role";
  document.getElementById("createdAt").textContent = `Created ${new Date(data.created_at).toLocaleString()}`;
  document.getElementById("openResume").innerHTML = `${icon("external", 16)} Open resume PDF`;
  document.getElementById("dlBtn").innerHTML = `${icon("download", 16)} Download ${icon("caret", 12)}`;

  document.querySelector('[data-act="download-resume-pdf"]').innerHTML = `${icon("download", 14)} Resume — PDF`;
  document.querySelector('[data-act="download-resume-docx"]').innerHTML = `${icon("file", 14)} Resume — DOCX`;
  if (coverLetter.trim()) {
    const ec = document.getElementById("dlCover");
    ec.classList.remove("hidden");
    ec.innerHTML = `${icon("envelope", 14)} Cover letter — PDF`;
    const ecd = document.getElementById("dlCoverDocx");
    ecd.classList.remove("hidden");
    ecd.innerHTML = `${icon("file", 14)} Cover letter — DOCX`;
  }

  // dropdown toggles
  document.querySelectorAll("[data-toggle]").forEach((t) => {
    t.addEventListener("click", (e) => {
      e.stopPropagation();
      document.getElementById(t.dataset.toggle)?.classList.toggle("open");
    });
  });
  document.addEventListener("click", () => {
    document.querySelectorAll(".dropdown-menu.open").forEach((m) => m.classList.remove("open"));
  });

  // Wire actions (only call backend if id is real)
  document.getElementById("openResume").addEventListener("click", async () => {
    if (!id || id === "demo") { toast("This is a demo result — wire BACKEND_URL to use real PDFs.", "info"); return; }
    try { await openInNewTab(`/tailor/${id}/resume.pdf`); }
    catch (e) { toast(e.detail || "Could not open.", "error"); }
  });
  const dlAction = async (kind) => {
    if (!id || id === "demo") { toast("This is a demo result — wire BACKEND_URL to download.", "info"); return; }
    try {
      if (kind === "download-resume-pdf") await downloadFile(`/tailor/${id}/resume.pdf`, `tailored-resume-${id.slice(0,8)}.pdf`);
      if (kind === "download-resume-docx") await downloadFile(`/tailor/${id}/resume.docx`, `tailored-resume-${id.slice(0,8)}.docx`);
      if (kind === "download-cover-pdf") await downloadFile(`/tailor/${id}/cover-letter.pdf`, `cover-letter-${id.slice(0,8)}.pdf`);
      if (kind === "download-cover-docx") await downloadFile(`/tailor/${id}/cover-letter.docx`, `cover-letter-${id.slice(0,8)}.docx`);
    } catch (e) { toast(e.detail || "Download failed.", "error"); }
  };
  document.querySelectorAll("[data-act]").forEach((b) => {
    b.addEventListener("click", () => dlAction(b.dataset.act));
  });

  // ---- ATS Bento ----
  const score = Math.max(0, Math.min(100, Math.round(Number(ats.score || 0))));
  const sc = score >= 75 ? "var(--success)" : score >= 50 ? "var(--warning)" : "var(--error)";
  const chips = (items, tone = "") => (items || []).map((s) => `<span class="chip ${tone}">${esc(s)}</span>`).join("");

  document.getElementById("bento").innerHTML = `
    <div>
      <div class="label-overline">ATS Match Score</div>
      <div style="display:flex;align-items:flex-end;gap:8px;margin-top:8px">
        <div class="text-6xl font-black tracking-tighter" style="color:${sc};line-height:1">${score}</div>
        <div class="text-sm text-muted" style="padding-bottom:8px">/ 100</div>
      </div>
      <div class="score-bar"><div class="score-bar-fill" style="width:${score}%;background:${sc}"></div></div>
      ${ats.notes ? `<p class="text-xs text-muted mt-3" style="line-height:1.6">${esc(ats.notes)}</p>` : ""}
    </div>
    <div>
      <div class="label-overline" style="display:flex;align-items:center;gap:6px">
        <span class="text-success">${icon("check", 14)}</span> Matched
      </div>
      <div class="mt-3">
        <div class="text-xs font-bold mb-2">Skills</div><div>${chips(ats.matching_skills, "chip-success")}</div>
        <div class="text-xs font-bold mb-2 mt-3">Technologies</div><div>${chips(ats.matching_technologies, "chip-success")}</div>
        <div class="text-xs font-bold mb-2 mt-3">Responsibilities</div><div>${chips(ats.matching_responsibilities, "chip-success")}</div>
      </div>
    </div>
    <div>
      <div class="label-overline" style="display:flex;align-items:center;gap:6px">
        <span class="text-error">${icon("x", 14)}</span> Missing
      </div>
      <div class="mt-3">
        <div class="text-xs font-bold mb-2">Requirements not found in your data</div>
        <div>${chips(ats.missing_requirements, "chip-error")}</div>
      </div>
      <p class="text-xs text-muted mt-3" style="line-height:1.6">
        We never fabricated these. Add truthful info under "Additional information" and re-tailor to include them.
      </p>
    </div>`;

  // ---- Tabs ----
  const tabsDef = [
    { id: "tabResume", label: "Resume", ic: "target" },
    { id: "tabCompare", label: "Compare", ic: "cols" },
    { id: "tabChanges", label: "Changes", ic: "diff" },
    { id: "tabCover", label: "Cover letter", ic: "envelope" },
    { id: "tabQa", label: "Application Q&A", ic: "q" },
    { id: "tabRaw", label: "Raw JSON", ic: "bar" },
  ];
  document.getElementById("tabs").innerHTML = tabsDef
    .map((t, i) => `<button class="tab ${i === 0 ? "active" : ""}" data-tab="${t.id}">${icon(t.ic, 14)} ${t.label}</button>`)
    .join("");
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      document.getElementById(btn.dataset.tab).classList.add("active");
    });
  });
  document.getElementById("tabResume").classList.add("active");

  // ---- Tab content: Resume ----
  document.getElementById("tabResume").innerHTML = renderResumePreview(resume);

  // ---- Tab content: Compare ----
  const originalText = (data.resume_text || "").trim();
  document.getElementById("tabCompare").innerHTML = renderCompare(originalText, resumeJsonToText(resume));
  wireCompare();

  // ---- Tab content: Changes ----
  document.getElementById("tabChanges").innerHTML = renderChanges(changes);

  // ---- Tab content: Cover ----
  document.getElementById("tabCover").innerHTML = coverLetter.trim()
    ? `<div class="card">
        <div class="card-h flex items-center justify-between">
          <div class="label-overline">Cover letter</div>
        </div>
        <div class="card-b" style="white-space:pre-wrap;max-width:760px;font-size:14px;line-height:1.65">${esc(coverLetter)}</div>
      </div>`
    : `<div class="card" style="padding:32px;color:var(--muted)">Cover letter was not requested for this tailoring.</div>`;

  // ---- Tab content: Q&A ----
  document.getElementById("tabQa").innerHTML = qa.length
    ? qa.map((it, i) => `
        <div class="card" style="margin-bottom:1px;padding:24px">
          <div class="label-overline mb-2">Question ${i + 1}</div>
          <div class="font-bold" style="font-size:15px">${esc(it.question)}</div>
          <div class="mt-3" style="white-space:pre-wrap;font-size:14px;line-height:1.6">${esc(it.answer)}</div>
        </div>`).join("")
    : `<div class="card" style="padding:32px;color:var(--muted)">No application questions were submitted.</div>`;

  // ---- Tab content: Raw ----
  document.getElementById("tabRaw").innerHTML =
    `<pre class="mono" style="background:var(--neutral-900);color:#f5f5f5;padding:24px;overflow:auto;max-height:600px;font-size:12px">${esc(JSON.stringify(result, null, 2))}</pre>`;
})();

function renderResumePreview(resume) {
  if (!resume) return "";
  const c = resume.contact || {};
  const top = [c.email, c.phone, c.location, c.linkedin, c.portfolio].filter(Boolean);
  let h = `<div class="resume-preview">`;
  if (resume.name) h += `<h2>${esc(resume.name)}</h2>`;
  if (top.length) h += `<div class="contact-line">${top.map(esc).join(" • ")}</div>`;

  if (resume.summary) h += `<div class="section"><div class="section-title">Summary</div><p>${esc(resume.summary)}</p></div>`;

  const skillCats = (resume.skills || []).filter(s => (s.items || []).length);
  if (skillCats.length) {
    h += `<div class="section"><div class="section-title">Skills</div>`;
    for (const cat of skillCats) {
      h += `<p>${cat.category ? `<strong>${esc(cat.category)}:</strong> ` : ""}${esc((cat.items || []).join(" • "))}</p>`;
    }
    h += `</div>`;
  }

  if ((resume.experience || []).length) {
    h += `<div class="section"><div class="section-title">Experience</div>`;
    for (const e of resume.experience) {
      const head = [e.title, e.company].filter(Boolean).join(" — ");
      const sub = [e.location, e.dates].filter(Boolean).join(" | ");
      h += `<div class="item"><div class="item-head">${esc(head)}</div>${sub ? `<div class="item-sub">${esc(sub)}</div>` : ""}<ul>${(e.bullets||[]).map(b=>`<li>${esc(b)}</li>`).join("")}</ul></div>`;
    }
    h += `</div>`;
  }

  if ((resume.projects || []).length) {
    h += `<div class="section"><div class="section-title">Projects</div>`;
    for (const p of resume.projects) {
      h += `<div class="item"><div class="item-head">${esc(p.name || "")}</div>${p.dates?`<div class="item-sub">${esc(p.dates)}</div>`:""}<ul>${(p.bullets||[]).map(b=>`<li>${esc(b)}</li>`).join("")}</ul></div>`;
    }
    h += `</div>`;
  }

  if ((resume.education || []).length) {
    h += `<div class="section"><div class="section-title">Education</div>`;
    for (const ed of resume.education) {
      const head = [ed.degree, ed.institution].filter(Boolean).join(" — ");
      const sub = [ed.location, ed.dates].filter(Boolean).join(" | ");
      h += `<div class="item"><div class="item-head">${esc(head)}</div>${sub ? `<div class="item-sub">${esc(sub)}</div>` : ""}</div>`;
    }
    h += `</div>`;
  }

  if ((resume.certifications || []).length) {
    h += `<div class="section"><div class="section-title">Certifications</div><ul>${resume.certifications.map(c2=>`<li>${esc(c2)}</li>`).join("")}</ul></div>`;
  }
  h += `</div>`;
  return h;
}

function renderCompare(originalText, tailoredText) {
  if (!originalText) {
    return `<div class="card" style="padding:32px;color:var(--muted)">Original resume text isn't available for this tailoring.</div>`;
  }
  return `
    <div class="card">
      <div class="card-h flex items-center justify-between">
        <div>
          <div class="label-overline">Compare</div>
          <div class="text-sm font-bold tracking-tight mt-1">Original resume vs Tailored resume</div>
        </div>
        <div style="display:flex;border:1px solid var(--neutral-300)">
          <button class="cmp-mode btn-dark" data-mode="side" style="padding:6px 12px;font-size:12px;font-weight:600;background:var(--neutral-900);color:white;border:none;cursor:pointer">Side-by-side</button>
          <button class="cmp-mode" data-mode="inline" style="padding:6px 12px;font-size:12px;font-weight:600;background:white;color:var(--neutral-700);border:none;border-left:1px solid var(--neutral-300);cursor:pointer">Inline diff</button>
        </div>
      </div>

      <div id="cmpSide" class="compare-side">
        <div><div class="label-overline mb-2" style="color:var(--muted)">Original</div><pre class="compare-pre" style="color:var(--neutral-700)">${esc(originalText)}</pre></div>
        <div><div class="label-overline mb-2 text-ikb">Tailored</div><pre class="compare-pre">${esc(tailoredText)}</pre></div>
      </div>

      <div id="cmpInline" class="hidden" style="padding:20px">
        <pre class="compare-pre">${
          wordDiff(originalText, tailoredText).map((tok) => {
            if (tok.t === "eq") return esc(tok.x);
            if (tok.t === "add") return `<span class="diff-add">${esc(tok.x)}</span>`;
            return `<span class="diff-del">${esc(tok.x)}</span>`;
          }).join("")
        }</pre>
      </div>
    </div>`;
}

function wireCompare() {
  document.querySelectorAll(".cmp-mode").forEach((b) => {
    b.addEventListener("click", () => {
      const mode = b.dataset.mode;
      document.querySelectorAll(".cmp-mode").forEach((x) => {
        x.style.background = "white"; x.style.color = "var(--neutral-700)";
      });
      b.style.background = "var(--neutral-900)"; b.style.color = "white";
      const side = document.getElementById("cmpSide");
      const inl = document.getElementById("cmpInline");
      if (mode === "side") { side.classList.remove("hidden"); inl.classList.add("hidden"); }
      else { side.classList.add("hidden"); inl.classList.remove("hidden"); }
    });
  });
}

function renderChanges(changes) {
  const tone = {
    added: 'style="background:#ECFDF5;border:1px solid #D1FAE5"',
    removed: 'style="background:#FEF2F2;border:1px solid #FEE2E2;text-decoration:line-through;color:var(--muted)"',
    neutral: 'style="background:white;border:1px solid var(--border)"',
  };
  const panel = (title, items, key, ic) => `
    <div style="background:white;padding:24px">
      <div class="label-overline mb-3" style="display:flex;align-items:center;gap:6px">${ic} ${title}</div>
      ${(items || []).length === 0
        ? `<div class="text-sm text-muted">No items.</div>`
        : (items || []).map((it) => `<div class="text-sm" ${tone[key]} style="${tone[key].replace(/"/g, '')};padding:10px;margin-bottom:8px">${esc(it)}</div>`).join("")}
    </div>`;

  const rewritten = (changes.rewritten_bullets || []);
  return `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--border);border:1px solid var(--border)">
      ${panel("Added", changes.added, "added", `<span class="text-success">${icon("check", 14)}</span>`)}
      ${panel("Removed", changes.removed, "removed", `<span class="text-error">${icon("x", 14)}</span>`)}
      ${panel("Reordered", changes.reordered, "neutral", icon("diff", 14))}
      <div style="background:white;padding:24px">
        <div class="label-overline mb-3" style="display:flex;align-items:center;gap:6px">${icon("pencil", 14)} Rewritten bullets</div>
        ${rewritten.length === 0
          ? `<div class="text-sm text-muted">No bullets were rewritten.</div>`
          : rewritten.map((b) => `
              <div style="border:1px solid var(--border);padding:10px;margin-bottom:10px">
                <div class="text-xs text-muted" style="text-decoration:line-through">${esc(b.before)}</div>
                <div class="text-xs text-ikb font-bold mt-1" style="display:flex;gap:4px">${icon("arrowRight", 12)} <span style="color:var(--fg)">${esc(b.after)}</span></div>
              </div>
            `).join("")}
      </div>
    </div>`;
}
