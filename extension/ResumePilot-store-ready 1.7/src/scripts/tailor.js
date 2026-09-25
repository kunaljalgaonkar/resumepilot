/* Tailor (new tailoring) page — UI logic. */
import { icon } from "./icons.js";
import { renderTopbar, renderFooter, toast, esc } from "./common.js";
import { parseResume, createTailoring, getUser } from "./api.js";

(async () => {
  // Guard: require user signed in
  const u = await getUser();
  if (!u) { location.href = "auth.html"; return; }

  await renderTopbar("tailor");
  renderFooter();

  // populate icon spots
  document.getElementById("warnIcon").innerHTML = icon("warning", 20);
  ["ckIcon1", "ckIcon2", "ckIcon3"].forEach((id) => {
    document.getElementById(id).innerHTML = icon("check", 16);
  });
  document.getElementById("boltIcon").innerHTML = icon("bolt", 16);
  document.getElementById("uploadBtn").innerHTML = `${icon("upload", 28)}
    <div class="text-sm font-bold">Click to upload your resume</div>
    <div class="text-xs text-muted">PDF, DOCX, or TXT · up to 5MB</div>`;
  document.getElementById("addQ").innerHTML = `${icon("plus", 12)} Add another question`;
  document.getElementById("submitBtn").innerHTML = `${icon("spark", 16)} <span>Tailor my application</span>`;

  // --- State ---
  let resumeFileMeta = null; // { filename, format, size }
  const questionsHost = document.getElementById("questions");
  let questions = [""];

  const renderQs = () => {
    questionsHost.innerHTML = questions.map((q, i) => `
      <div style="display:flex;gap:8px">
        <input class="input" data-qidx="${i}" value="${esc(q)}" placeholder="e.g. Why are you interested in this role?" style="height:40px" />
        ${questions.length > 1 ? `<button type="button" data-removeq="${i}"
            style="height:40px;width:40px;border:1px solid var(--neutral-300);background:white;cursor:pointer;color:var(--muted);display:inline-flex;align-items:center;justify-content:center">
            ${icon("trash", 14)}
          </button>` : ""}
      </div>
    `).join("");
    questionsHost.querySelectorAll("[data-qidx]").forEach((el) => {
      el.addEventListener("input", () => { questions[+el.dataset.qidx] = el.value; });
    });
    questionsHost.querySelectorAll("[data-removeq]").forEach((b) => {
      b.addEventListener("click", () => {
        questions.splice(+b.dataset.removeq, 1);
        renderQs();
      });
    });
  };
  renderQs();
  document.getElementById("addQ").addEventListener("click", () => { questions.push(""); renderQs(); });

  // --- Upload ---
  const fileInput = document.getElementById("fileInput");
  const uploadBtn = document.getElementById("uploadBtn");
  const uploadedCard = document.getElementById("uploadedCard");
  const resumeText = document.getElementById("resumeText");

  uploadBtn.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    const lower = file.name.toLowerCase();
    if (!/\.(pdf|docx|txt)$/.test(lower)) { toast("Use PDF, DOCX, or TXT.", "error"); return; }
    if (file.size > 5 * 1024 * 1024) { toast("File too large (5MB max).", "error"); return; }
    uploadBtn.disabled = true;
    uploadBtn.innerHTML = `${icon("upload", 28)}<div class="text-sm font-bold">Parsing…</div>`;
    try {
      const data = await parseResume(file);
      resumeFileMeta = { filename: data.filename, format: data.format };
      resumeText.value = data.text;
      uploadBtn.classList.add("hidden");
      uploadedCard.classList.remove("hidden");
      uploadedCard.innerHTML = `
        <div style="height:40px;width:40px;background:var(--neutral-100);display:inline-flex;align-items:center;justify-content:center">${icon("file", 20, "text-ikb")}</div>
        <div style="flex:1;min-width:0">
          <div class="text-sm font-bold" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(data.filename)}</div>
          <div class="text-xs text-muted mono">${data.format.toUpperCase()} · ${data.text.length.toLocaleString()} characters extracted</div>
        </div>
        <span class="text-success">${icon("check", 20)}</span>
        <button id="removeResume" title="Remove" style="background:none;border:none;cursor:pointer;color:var(--muted);padding:4px">${icon("trash", 16)}</button>`;
      document.getElementById("removeResume").addEventListener("click", () => {
        resumeFileMeta = null; resumeText.value = "";
        uploadedCard.classList.add("hidden");
        uploadBtn.classList.remove("hidden");
        uploadBtn.disabled = false;
        uploadBtn.innerHTML = `${icon("upload", 28)}
          <div class="text-sm font-bold">Click to upload your resume</div>
          <div class="text-xs text-muted">PDF, DOCX, or TXT · up to 5MB</div>`;
      });
      toast(`Parsed ${data.format.toUpperCase()} · ${data.text.length} characters`, "success");
    } catch (err) {
      toast(err.detail || "Could not parse the file.", "error");
      uploadBtn.disabled = false;
      uploadBtn.innerHTML = `${icon("upload", 28)}
        <div class="text-sm font-bold">Click to upload your resume</div>
        <div class="text-xs text-muted">PDF, DOCX, or TXT · up to 5MB</div>`;
    }
  });

  // JD char counter
  const jd = document.getElementById("jdInput");
  const jdCount = document.getElementById("jdCount");
  const updateJdCount = () => { jdCount.textContent = `${jd.value.length.toLocaleString()} characters`; };
  jd.addEventListener("input", updateJdCount);
  updateJdCount();

  // --- Submit ---
  document.getElementById("submitBtn").addEventListener("click", async () => {
    const rt = resumeText.value.trim();
    const jdv = jd.value.trim();
    if (rt.length < 20) { toast("Please upload or paste your resume first.", "error"); return; }
    if (jdv.length < 20) { toast("Job description looks too short.", "error"); return; }
    const btn = document.getElementById("submitBtn");
    btn.disabled = true; btn.innerHTML = `${icon("spark", 16)} <span>Tailoring — hold on…</span>`;
    try {
      const cleanQs = questions.map((q) => q.trim()).filter(Boolean);
      const data = await createTailoring({
        resume_text: rt,
        job_description: jdv,
        additional_info: document.getElementById("additional").value || "",
        include_cover_letter: document.getElementById("includeCover").checked,
        application_questions: cleanQs,
      });
      toast("Tailoring complete.", "success");
      location.href = `result.html?id=${encodeURIComponent(data.id)}`;
    } catch (err) {
      toast(err.detail || "Tailoring failed.", "error");
      btn.disabled = false; btn.innerHTML = `${icon("spark", 16)} <span>Tailor my application</span>`;
    }
  });
})();
