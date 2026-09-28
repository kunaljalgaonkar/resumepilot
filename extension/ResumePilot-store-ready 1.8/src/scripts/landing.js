/* Landing page wiring — populate icons + feature cards + steps. */
import { icon } from "./icons.js";

document.getElementById("ctaPrimary").innerHTML = `Start tailoring — it's free ${icon("arrowRight", 18)}`;
document.getElementById("bottomCta").innerHTML = `Create your account ${icon("arrowRight", 18)}`;

["bullet1","bullet2","bullet3"].forEach((id, i) => {
  const labels = ["No fabricated experience", "ATS keyword alignment", "PDF export ready"];
  document.getElementById(id).innerHTML = `<span class="text-success">${icon("check", 18)}</span><span>${labels[i]}</span>`;
});

const featGrid = document.getElementById("featGrid");
const features = [
  { ic: "spark", title: "Truthful by design", body: "We never invent employment, projects, skills, dates, or metrics. Every line is anchored to what you provided." },
  { ic: "target", title: "ATS keyword alignment", body: "Bullets are rewritten to mirror the job description's terminology — without keyword stuffing." },
  { ic: "diff", title: "See every change", body: "A transparent diff shows what was added, removed, reordered, or rewritten, with before/after lines." },
];
featGrid.innerHTML = features.map((f) => `
  <div style="background:white;padding:32px">
    <span class="text-ikb">${icon(f.ic, 28)}</span>
    <h3 class="text-xl font-bold tracking-tight" style="margin-top:20px">${f.title}</h3>
    <p class="mt-2 text-sm text-muted" style="line-height:1.6">${f.body}</p>
  </div>`).join("");

const stepsGrid = document.getElementById("stepsGrid");
const steps = [
  { n: "01", t: "Upload your resume", d: "PDF, DOCX, or TXT. We extract the text — your real history stays the only source of truth." },
  { n: "02", t: "Paste the job description", d: "Add any extra projects or info you want considered. We rank everything by relevance to the role." },
  { n: "03", t: "Get five outputs", d: "Tailored Resume, ATS Match Analysis, Change Summary, Cover Letter, and Application Q&A — all downloadable." },
];
stepsGrid.innerHTML = steps.map((s) => `
  <div style="background:white;padding:32px">
    <div class="mono text-xs text-ikb">${s.n}</div>
    <h3 class="text-xl font-bold tracking-tight" style="margin-top:12px">${s.t}</h3>
    <p class="mt-2 text-sm text-muted" style="line-height:1.6">${s.d}</p>
  </div>`).join("");

document.getElementById("footerLeft").innerHTML = `${icon("file", 14)}<span class="label-overline">Truthfulness first</span>`;
document.getElementById("yr").textContent = new Date().getFullYear();
