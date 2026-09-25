/* History page — list + rename + delete (UI only — wires to /tailor endpoints) */
import { icon } from "./icons.js";
import { renderTopbar, renderFooter, toast, confirmDialog, esc } from "./common.js";
import { listTailorings, renameTailoring, deleteTailoring, getUser } from "./api.js";

(async () => {
  const u = await getUser();
  if (!u) { location.href = "auth.html"; return; }

  await renderTopbar("history");
  renderFooter();

  document.getElementById("newTailorBtn").innerHTML = `${icon("spark", 16)} New tailoring`;

  const content = document.getElementById("content");
  let items = [];

  const load = async () => {
    content.innerHTML = `<div class="label-overline">Loading…</div>`;
    try {
      const data = await listTailorings();
      items = data.items || [];
    } catch (e) {
      // Show demo data if backend unreachable (so user sees the UI design)
      items = [{
        id: "demo",
        created_at: new Date().toISOString(),
        job_title: "Senior Frontend Engineer at Acme (demo)",
        score: 87,
      }];
      toast("Showing demo row (backend not reachable yet).", "info");
    }
    render();
  };

  const render = () => {
    if (!items.length) {
      content.innerHTML = `
        <div style="border:1px dashed var(--neutral-300);padding:64px;text-align:center">
          ${icon("file", 32, "text-muted")}
          <div class="text-lg font-bold mt-3">Nothing here yet.</div>
          <div class="text-sm text-muted">Run your first tailoring to see it here.</div>
          <a class="btn mt-4" href="app.html" style="margin-top:20px">Start tailoring ${icon("arrowRight", 16)}</a>
        </div>`;
      return;
    }

    content.innerHTML = `<div class="card" id="listBox"></div>`;
    const box = document.getElementById("listBox");
    box.innerHTML = items.map((it) => {
      const s = Number(it.score || 0);
      const color = s >= 75 ? "var(--success)" : s >= 50 ? "var(--warning)" : "var(--error)";
      return `
      <div class="row" data-id="${esc(it.id)}">
        <div class="text-center">
          <div class="text-2xl font-black tracking-tighter" style="color:${color};line-height:1">${s}</div>
          <div class="label-overline">ats</div>
        </div>
        <div style="min-width:0">
          <div class="row-view">
            <a href="result.html?id=${encodeURIComponent(it.id)}" style="text-decoration:none;color:var(--fg)">
              <div class="font-bold" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.job_title || "Untitled")}</div>
              <div class="text-xs text-muted mono mt-1">${new Date(it.created_at).toLocaleString()}</div>
            </a>
          </div>
          <div class="row-edit hidden" style="display:flex;gap:8px;align-items:center">
            <input class="input" data-rename-input style="height:36px;flex:1" />
            <button class="btn btn-sm" data-rename-save>${icon("check", 14)}</button>
            <button class="btn btn-sm btn-outline" data-rename-cancel>${icon("x", 14)}</button>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <a class="text-sm text-ikb font-bold" href="result.html?id=${encodeURIComponent(it.id)}" style="text-decoration:none;display:inline-flex;align-items:center;gap:4px">
            View ${icon("arrowRight", 14)}
          </a>
          <div class="dropdown">
            <button class="btn btn-sm btn-ghost" data-toggle="m-${esc(it.id)}" title="Actions">${icon("dots", 18)}</button>
            <div class="dropdown-menu" id="m-${esc(it.id)}">
              <a class="dropdown-item" href="result.html?id=${encodeURIComponent(it.id)}">${icon("arrowRight", 14)} Open</a>
              <button class="dropdown-item" data-act="rename">${icon("pencil", 14)} Rename</button>
              <div class="dropdown-divider"></div>
              <button class="dropdown-item danger" data-act="delete">${icon("trash", 14)} Delete</button>
            </div>
          </div>
        </div>
      </div>`;
    }).join("");

    // Dropdowns
    box.querySelectorAll("[data-toggle]").forEach((t) => {
      t.addEventListener("click", (e) => {
        e.stopPropagation();
        // close other menus
        document.querySelectorAll(".dropdown-menu.open").forEach((m) => {
          if (m.id !== t.dataset.toggle) m.classList.remove("open");
        });
        document.getElementById(t.dataset.toggle)?.classList.toggle("open");
      });
    });
    document.addEventListener("click", () => {
      document.querySelectorAll(".dropdown-menu.open").forEach((m) => m.classList.remove("open"));
    });

    // Row actions
    box.querySelectorAll(".row").forEach((row) => {
      const id = row.dataset.id;
      const viewEl = row.querySelector(".row-view");
      const editEl = row.querySelector(".row-edit");
      const input = row.querySelector("[data-rename-input]");

      row.querySelector('[data-act="rename"]').addEventListener("click", () => {
        const cur = items.find((x) => x.id === id);
        input.value = cur?.job_title || "";
        viewEl.classList.add("hidden");
        editEl.classList.remove("hidden");
        requestAnimationFrame(() => input.focus());
      });

      const cancel = () => {
        viewEl.classList.remove("hidden");
        editEl.classList.add("hidden");
      };
      row.querySelector("[data-rename-cancel]").addEventListener("click", cancel);

      const save = async () => {
        const next = input.value.trim();
        if (!next) { toast("Title can't be empty.", "error"); return; }
        try {
          if (id === "demo") {
            items = items.map((x) => (x.id === id ? { ...x, job_title: next } : x));
            toast("Renamed (demo).", "success");
          } else {
            await renameTailoring(id, next);
            items = items.map((x) => (x.id === id ? { ...x, job_title: next } : x));
            toast("Renamed.", "success");
          }
          render();
        } catch (e) {
          toast(e.detail || "Rename failed.", "error");
        }
      };
      row.querySelector("[data-rename-save]").addEventListener("click", save);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") save();
        if (e.key === "Escape") cancel();
      });

      row.querySelector('[data-act="delete"]').addEventListener("click", async () => {
        const cur = items.find((x) => x.id === id);
        const ok = await confirmDialog({
          title: "Delete this tailoring?",
          body: `This permanently removes "${esc(cur?.job_title || "")}" and its generated outputs. This action cannot be undone.`,
          confirmText: "Delete",
          danger: true,
        });
        if (!ok) return;
        try {
          if (id !== "demo") await deleteTailoring(id);
          items = items.filter((x) => x.id !== id);
          toast("Deleted.", "success");
          render();
        } catch (e) {
          toast(e.detail || "Delete failed.", "error");
        }
      });
    });
  };

  await load();
})();
