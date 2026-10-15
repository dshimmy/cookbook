const app = document.getElementById("app");
let draft = null; // unsaved imported recipe awaiting review
const libraryState = { q: "", tag: "", favOnly: false };

// ---------- helpers ----------
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const imgUrl = (name) => (name ? `/uploads/${encodeURIComponent(name)}` : "");
const isHeader = (line) => line.startsWith("# ");

async function api(path, opts = {}) {
  const init = { ...opts };
  if (opts.json !== undefined) {
    init.body = JSON.stringify(opts.json);
    init.headers = { "Content-Type": "application/json" };
  }
  const res = await fetch(path, init);
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = `toast${isError ? " error" : ""}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 6000 : 2500);
}

function formatDate(sqlDate) {
  const d = new Date(sqlDate.replace(" ", "T") + "Z");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
    " · " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function placeholder(title) {
  return `<div class="placeholder">${esc((title || "?").trim().charAt(0).toUpperCase())}</div>`;
}

function loading(msg) {
  app.innerHTML = `<div class="loading"><div class="spinner"></div><div>${esc(msg)}</div></div>`;
}

function confirmModal(message, confirmLabel = "Delete") {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `<div class="modal"><p>${esc(message)}</p>
      <div class="form-actions" style="position:static;background:none">
        <button class="btn" data-no>Cancel</button>
        <button class="btn btn-primary" data-yes>${esc(confirmLabel)}</button></div></div>`;
    const done = (v) => { back.remove(); resolve(v); };
    back.querySelector("[data-no]").onclick = () => done(false);
    back.querySelector("[data-yes]").onclick = () => done(true);
    back.onclick = (e) => e.target === back && done(false);
    document.body.append(back);
  });
}

// ---------- quantity scaling ----------
const UNICODE_FRAC = { "½": 0.5, "⅓": 1 / 3, "⅔": 2 / 3, "¼": 0.25, "¾": 0.75, "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875 };
const NUM = String.raw`(?:\d+\s+\d+\/\d+|\d+\/\d+|\d*[.,]?\d+(?:\s*[½⅓⅔¼¾⅛⅜⅝⅞])?|[½⅓⅔¼¾⅛⅜⅝⅞])`;
const QTY_RE = new RegExp(String.raw`^(${NUM})(\s*(?:-|–|to)\s*(${NUM}))?`);

function parseNum(s) {
  s = s.trim().replace(",", ".");
  let total = 0;
  const uf = s.match(/[½⅓⅔¼¾⅛⅜⅝⅞]/);
  if (uf) { total += UNICODE_FRAC[uf[0]]; s = s.replace(uf[0], "").trim(); }
  if (!s) return total;
  if (s.includes(" ")) { const [w, f] = s.split(/\s+/); return total + Number(w) + parseNum(f); }
  if (s.includes("/")) { const [n, d] = s.split("/"); return total + Number(n) / Number(d); }
  return total + Number(s);
}

function formatNum(n) {
  const whole = Math.floor(n + 1e-9);
  const frac = n - whole;
  const fracs = [[0, ""], [0.125, "⅛"], [0.25, "¼"], [1 / 3, "⅓"], [0.375, "⅜"], [0.5, "½"], [0.625, "⅝"], [2 / 3, "⅔"], [0.75, "¾"], [0.875, "⅞"], [1, ""]];
  const [val, sym] = fracs.reduce((best, f) => (Math.abs(f[0] - frac) < Math.abs(best[0] - frac) ? f : best));
  if (Math.abs(val - frac) > 0.04 && n < 10) return String(Math.round(n * 100) / 100);
  const w = val === 1 ? whole + 1 : whole;
  return w === 0 && sym ? sym : `${w}${sym}`;
}

function scaleLine(line, factor) {
  if (factor === 1) return line;
  const m = line.match(QTY_RE);
  if (!m) return line;
  const a = formatNum(parseNum(m[1]) * factor);
  const b = m[3] ? formatNum(parseNum(m[3]) * factor) : null;
  return (b ? `${a}–${b}` : a) + line.slice(m[0].length);
}

// ---------- router ----------
async function route() {
  const [, view, id] = location.hash.replace(/^#/, "").split("/");
  window.scrollTo(0, 0);
  try {
    if (!view) return await renderLibrary();
    if (view === "recipe") return await renderRecipe(id);
    if (view === "new") return renderAdd();
    if (view === "review") return draft ? renderEditor(draft, { isNew: true }) : (location.hash = "#/new");
    if (view === "edit") return renderEditor(await api(`/api/recipes/${id}`), { isNew: false });
    location.hash = "#/";
  } catch (e) {
    app.innerHTML = `<div class="empty"><h2>Something went wrong</h2><p>${esc(e.message)}</p><a class="btn" href="#/">Back to cookbook</a></div>`;
  }
}
window.addEventListener("hashchange", route);
document.getElementById("openPdfs").onclick = () => api("/api/pdfs/open", { method: "POST" }).catch((e) => toast(e.message, true));

// ---------- library ----------
async function renderLibrary() {
  const recipes = await api("/api/recipes");
  if (!recipes.length) {
    app.innerHTML = `<div class="empty"><h2>Your cookbook is empty</h2>
      <p>Snap a photo of a recipe card, paste a link, or type one in.</p>
      <a class="btn btn-primary" href="#/new">+ Add your first recipe</a></div>`;
    return;
  }
  const tagCounts = {};
  recipes.forEach((r) => r.tags.forEach((t) => (tagCounts[t] = (tagCounts[t] || 0) + 1)));
  const tags = Object.keys(tagCounts).sort((a, b) => tagCounts[b] - tagCounts[a] || a.localeCompare(b));

  app.innerHTML = `
    <div class="library-head"><div><h1>Recipes</h1><div class="count" id="count"></div></div></div>
    <div class="filters">
      <input type="search" id="q" placeholder="Search recipes or ingredients…" value="${esc(libraryState.q)}" />
      <button class="chip ${libraryState.favOnly ? "active" : ""}" id="fav">★ Favorites</button>
      <div class="chips" id="tags">${tags.map((t) => `<button class="chip ${libraryState.tag === t ? "active" : ""}" data-tag="${esc(t)}">${esc(t)}</button>`).join("")}</div>
    </div>
    <div class="grid" id="grid"></div>`;

  const draw = () => {
    const q = libraryState.q.toLowerCase();
    const shown = recipes.filter((r) =>
      (!libraryState.favOnly || r.favorite) &&
      (!libraryState.tag || r.tags.includes(libraryState.tag)) &&
      (!q || [r.title, r.description, ...r.ingredients, ...r.tags].join(" ").toLowerCase().includes(q))
    );
    document.getElementById("count").textContent =
      shown.length === recipes.length ? `${recipes.length} recipe${recipes.length === 1 ? "" : "s"}` : `${shown.length} of ${recipes.length}`;
    document.getElementById("grid").innerHTML = shown.length
      ? shown.map(card).join("")
      : `<p class="muted">No recipes match.</p>`;
  };
  draw();

  document.getElementById("q").oninput = (e) => { libraryState.q = e.target.value; draw(); };
  document.getElementById("fav").onclick = (e) => {
    libraryState.favOnly = !libraryState.favOnly;
    e.target.classList.toggle("active", libraryState.favOnly);
    draw();
  };
  document.getElementById("tags").onclick = (e) => {
    const t = e.target.dataset.tag;
    if (t === undefined) return;
    libraryState.tag = libraryState.tag === t ? "" : t;
    document.querySelectorAll("#tags .chip").forEach((c) => c.classList.toggle("active", c.dataset.tag === libraryState.tag));
    draw();
  };
}

function card(r) {
  const time = r.total_time || r.cook_time || r.prep_time;
  return `<a class="card" href="#/recipe/${r.id}">
    <div class="card-img">${r.image ? `<img src="${imgUrl(r.image)}" alt="" loading="lazy" />` : placeholder(r.title)}
      ${r.favorite ? `<span class="card-fav">★</span>` : ""}</div>
    <div class="card-body">
      <h3>${esc(r.title)}</h3>
      <div class="card-meta">
        ${time ? `<span>⏱ ${esc(time)}</span>` : ""}
        ${r.servings ? `<span>🍽 ${esc(r.servings)}</span>` : ""}
        ${r.rating ? `<span style="color:var(--gold)">${"★".repeat(r.rating)}</span>` : ""}
        ${r.note_count ? `<span>✎ ${r.note_count} note${r.note_count > 1 ? "s" : ""}</span>` : ""}
      </div>
      <div class="chips">${r.tags.slice(0, 3).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>
    </div></a>`;
}

// ---------- recipe view ----------
async function renderRecipe(id) {
  const r = await api(`/api/recipes/${id}`);
  let scale = 1;
  const facts = [["Serves", r.servings], ["Prep", r.prep_time], ["Cook", r.cook_time], ["Total", r.total_time]].filter(([, v]) => v);

  app.innerHTML = `
    <a class="back" href="#/">← All recipes</a>
    <section class="hero">
      <div class="hero-img">${r.image ? `<img src="${imgUrl(r.image)}" alt="" />` : placeholder(r.title)}</div>
      <div>
        <h1>${esc(r.title)}</h1>
        ${r.description ? `<p class="desc">${esc(r.description)}</p>` : ""}
        ${facts.length ? `<div class="facts">${facts.map(([k, v]) => `<div class="fact"><b>${k}</b>${esc(v)}</div>`).join("")}</div>` : ""}
        <div class="chips">${r.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>
        <div class="actions">
          <span class="stars" id="stars">${[1, 2, 3, 4, 5].map((n) => `<button data-n="${n}" class="${n <= r.rating ? "on" : ""}" title="${n} star${n > 1 ? "s" : ""}">★</button>`).join("")}</span>
          <button class="btn btn-sm" id="fav">${r.favorite ? "★ Favorited" : "☆ Favorite"}</button>
          <a class="btn btn-sm" href="#/edit/${r.id}">✎ Edit / tweak</a>
          <button class="btn btn-sm" id="share">↗ Share</button>
          <button class="btn btn-sm btn-ghost btn-danger" id="del">Delete</button>
        </div>
        ${r.source_url ? `<div class="source">Source: <a href="${esc(r.source_url)}" target="_blank" rel="noopener">${esc(new URL(r.source_url).hostname)}</a></div>` : ""}
      </div>
    </section>

    <section class="recipe-body">
      <div class="panel ingredients">
        <h2>Ingredients
          <span class="scaler" id="scaler">${[0.5, 1, 2, 3].map((f) => `<button data-f="${f}" class="${f === 1 ? "active" : ""}">${f === 0.5 ? "½" : f}×</button>`).join("")}</span>
        </h2>
        <ul class="ing-list" id="ings"></ul>
      </div>
      <div class="side-stack">
        <div class="panel">
          <h2>Method</h2>
          <ol class="step-list">${r.instructions.map((s) => isHeader(s)
            ? `<li class="section-head">${esc(s.slice(2))}</li>`
            : `<li class="step"><span>${esc(s)}</span></li>`).join("") || `<li class="muted">No steps yet.</li>`}</ol>
        </div>

        <div class="panel notes">
          <h2>Notes</h2>
          <form id="noteForm">
            <textarea id="noteBody" rows="2" placeholder="e.g. Used half the sugar — still great. Try browning the butter next time."></textarea>
            <button class="btn btn-primary btn-sm">Add note</button>
          </form>
          <div id="notes">${r.notes.map(noteHtml).join("") || `<p class="muted" id="noNotes">No notes yet. Jot down what you changed or how it turned out.</p>`}</div>
        </div>

        ${r.source_images.length ? `<div class="panel"><h2>Original</h2><div class="originals">
          ${r.source_images.map((s) => `<a href="${imgUrl(s)}" target="_blank"><img src="${imgUrl(s)}" alt="Original recipe photo" loading="lazy" /></a>`).join("")}</div></div>` : ""}

        ${r.revisions.length ? `<div class="panel history"><h2>Version history</h2><ul>
          ${r.revisions.map((v) => `<li><span>Before edit · ${formatDate(v.created_at)}</span>
            <span><button class="btn btn-sm btn-ghost" data-view="${v.id}">View</button>
            <button class="btn btn-sm" data-restore="${v.id}">Restore</button></span></li>`).join("")}</ul></div>` : ""}
      </div>
    </section>`;

  const drawIngredients = () => {
    document.getElementById("ings").innerHTML = r.ingredients.map((line, i) => isHeader(line)
      ? `<li class="section-head">${esc(line.slice(2))}</li>`
      : `<li data-i="${i}"><input type="checkbox" /><span>${esc(scaleLine(line, scale))}</span></li>`).join("") || `<li class="muted">No ingredients yet.</li>`;
  };
  drawIngredients();

  document.getElementById("ings").onclick = (e) => {
    const li = e.target.closest("li[data-i]");
    if (!li) return;
    const box = li.querySelector("input");
    if (e.target !== box) box.checked = !box.checked;
    li.classList.toggle("done", box.checked);
  };
  document.querySelector(".step-list").onclick = (e) => e.target.closest("li.step")?.classList.toggle("done");
  document.getElementById("scaler").onclick = (e) => {
    if (!e.target.dataset.f) return;
    scale = Number(e.target.dataset.f);
    document.querySelectorAll("#scaler button").forEach((b) => b.classList.toggle("active", b === e.target));
    drawIngredients();
  };

  document.getElementById("stars").onclick = async (e) => {
    const n = Number(e.target.dataset.n);
    if (!n) return;
    r.rating = r.rating === n ? 0 : n;
    await api(`/api/recipes/${r.id}`, { method: "PUT", json: { rating: r.rating } });
    document.querySelectorAll("#stars button").forEach((b) => b.classList.toggle("on", Number(b.dataset.n) <= r.rating));
  };
  document.getElementById("fav").onclick = async (e) => {
    r.favorite = !r.favorite;
    await api(`/api/recipes/${r.id}`, { method: "PUT", json: { favorite: r.favorite } });
    e.target.textContent = r.favorite ? "★ Favorited" : "☆ Favorite";
  };
  document.getElementById("share").onclick = () => shareModal(r);
  document.getElementById("del").onclick = async () => {
    if (!(await confirmModal(`Delete "${r.title}"? This can't be undone.`))) return;
    await api(`/api/recipes/${r.id}`, { method: "DELETE" });
    toast("Recipe deleted");
    location.hash = "#/";
  };

  document.getElementById("noteForm").onsubmit = async (e) => {
    e.preventDefault();
    const body = document.getElementById("noteBody").value.trim();
    if (!body) return;
    const note = await api(`/api/recipes/${r.id}/notes`, { method: "POST", json: { body } });
    document.getElementById("noNotes")?.remove();
    document.getElementById("notes").insertAdjacentHTML("afterbegin", noteHtml(note));
    document.getElementById("noteBody").value = "";
  };
  document.getElementById("notes").onclick = async (e) => {
    const id = e.target.dataset.delNote;
    if (!id || !(await confirmModal("Delete this note?"))) return;
    await api(`/api/recipes/${r.id}/notes/${id}`, { method: "DELETE" });
    e.target.closest(".note").remove();
  };

  document.querySelector(".history")?.addEventListener("click", async (e) => {
    const { view, restore } = e.target.dataset;
    if (view) {
      const rev = await api(`/api/recipes/${r.id}/revisions/${view}`);
      showRevision(rev);
    } else if (restore) {
      if (!(await confirmModal("Restore this version? Your current version will be saved in history.", "Restore"))) return;
      await api(`/api/recipes/${r.id}/revisions/${restore}/restore`, { method: "POST" });
      toast("Version restored");
      renderRecipe(r.id);
    }
  });
}

// ---------- sharing ----------
// The app runs locally, so instead of a link we send the recipe itself.
function recipeText(r, { includeNotes = false } = {}) {
  const out = [r.title.toUpperCase()];
  if (r.description) out.push("", r.description);
  const facts = [["Serves", r.servings], ["Prep", r.prep_time], ["Cook", r.cook_time], ["Total", r.total_time]]
    .filter(([, v]) => v).map(([k, v]) => `${k} ${v}`);
  if (facts.length) out.push("", facts.join(" · "));
  if (r.ingredients.length) {
    out.push("", "INGREDIENTS");
    r.ingredients.forEach((l) => out.push(isHeader(l) ? `\n${l.slice(2)}:` : `• ${l}`));
  }
  if (r.instructions.length) {
    out.push("", "METHOD");
    let n = 0;
    r.instructions.forEach((l) => out.push(isHeader(l) ? `\n${l.slice(2)}:` : `${++n}. ${l}`));
  }
  if (includeNotes && r.notes.length) {
    out.push("", "MY NOTES");
    r.notes.forEach((note) => out.push(`• ${note.body}`));
  }
  if (r.source_url) out.push("", `Source: ${r.source_url}`);
  return out.join("\n");
}

async function coverFile(r) {
  if (!r.image) return null;
  try {
    const blob = await (await fetch(imgUrl(r.image))).blob();
    return new File([blob], `${r.title.replace(/[^\w\s-]/g, "").trim() || "recipe"}${r.image.slice(r.image.lastIndexOf("."))}`, { type: blob.type });
  } catch {
    return null;
  }
}

function shareModal(r) {
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `<div class="modal share">
    <h2>Share “${esc(r.title)}”</h2>
    ${r.notes.length ? `<label class="check"><input type="checkbox" id="incNotes" /> Include my notes</label>` : ""}
    <div class="share-options">
      ${navigator.share ? `<button class="share-opt" data-act="native"><b>Send…</b><span>Messages, Mail, AirDrop${r.image ? ", with the photo" : ""}</span></button>` : ""}
      <button class="share-opt" data-act="copy"><b>Copy as text</b><span>Paste into a text, email or doc</span></button>
      <button class="share-opt" data-act="email"><b>Email</b><span>Opens a new email with the recipe</span></button>
      <button class="share-opt" data-act="pdf"><b>Save as PDF</b><span>Saves to your Saved PDFs folder, ready to attach</span></button>
      <button class="share-opt" data-act="print"><b>Print</b><span>Send to a printer</span></button>
    </div>
    <div class="form-actions" style="position:static;background:none"><button class="btn" data-act="close">Close</button></div></div>`;
  document.body.append(back);
  const close = () => back.remove();
  back.onclick = async (e) => {
    if (e.target === back) return close();
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    const text = recipeText(r, { includeNotes: back.querySelector("#incNotes")?.checked });
    if (act === "close") return close();
    if (act === "copy") {
      await navigator.clipboard.writeText(text);
      toast("Recipe copied");
      return close();
    }
    if (act === "email") {
      location.href = `mailto:?subject=${encodeURIComponent(`Recipe: ${r.title}`)}&body=${encodeURIComponent(text)}`;
      return close();
    }
    if (act === "print") {
      close();
      return window.print();
    }
    if (act === "pdf") {
      const btn = e.target.closest("[data-act]");
      btn.disabled = true;
      btn.querySelector("span").textContent = "Saving…";
      try {
        const { filename } = await api(`/api/recipes/${r.id}/pdf`, { method: "POST", json: { notes: back.querySelector("#incNotes")?.checked } });
        toast(`Saved “${filename}” to Saved PDFs`);
        close();
      } catch (err) {
        btn.disabled = false;
        btn.querySelector("span").textContent = "Saves to your Saved PDFs folder, ready to attach";
        toast(err.message, true);
      }
      return;
    }
    if (act === "native") {
      const data = { title: r.title, text };
      const file = await coverFile(r);
      if (file && navigator.canShare?.({ files: [file] })) data.files = [file];
      try {
        await navigator.share(data);
        close();
      } catch (err) {
        if (err.name !== "AbortError") toast("Couldn't open the share menu. Try “Copy as text”.", true);
      }
    }
  };
}

function noteHtml(n) {
  return `<div class="note"><time>${formatDate(n.created_at)}</time><p>${esc(n.body)}</p>
    <button class="btn btn-sm btn-ghost del" data-del-note="${n.id}" title="Delete note">✕</button></div>`;
}

function showRevision(rev) {
  const s = rev.snapshot;
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `<div class="modal">
    <p class="muted">Version saved ${formatDate(rev.created_at)}</p>
    <h2>${esc(s.title)}</h2>
    ${s.description ? `<p>${esc(s.description)}</p>` : ""}
    <h3>Ingredients</h3><ul>${s.ingredients.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>
    <h3>Method</h3><ol>${s.instructions.map((i) => `<li>${esc(i)}</li>`).join("")}</ol>
    <div class="form-actions" style="position:static;background:none"><button class="btn">Close</button></div></div>`;
  back.onclick = (e) => (e.target === back || e.target.tagName === "BUTTON") && back.remove();
  document.body.append(back);
}

// ---------- add recipe ----------
function renderAdd() {
  let tab = "photo";
  let files = [];
  app.innerHTML = `<div class="narrow">
    <a class="back" href="#/">← All recipes</a>
    <h1 class="page-title">Add a recipe</h1>
    <div class="tabs" id="tabs">
      <button data-tab="photo" class="active">📷 From photos</button>
      <button data-tab="url">🔗 From a link</button>
      <button data-tab="text">📋 Paste text</button>
      <button data-tab="manual">✎ Type it in</button>
    </div>
    <div id="pane"></div></div>`;

  const panes = {
    photo: () => `
      <div class="dropzone" id="drop"><strong>Drop recipe photos here</strong>
        <span class="muted">or click to choose · cookbook pages, recipe cards, screenshots · multiple pages OK</span>
        <input type="file" id="file" accept="image/*,.heic,.heif" multiple hidden /></div>
      <div class="thumbs" id="thumbs"></div>
      <div class="form-actions" style="position:static;background:none"><button class="btn btn-primary" id="go" disabled>Read recipe</button></div>`,
    url: () => `
      <form id="urlForm" class="form">
        <div><label for="url">Recipe link</label>
        <input type="url" id="url" placeholder="https://www.example.com/best-banana-bread" required autofocus />
        <p class="hint">Works with most recipe sites. You'll get to review everything before it's saved.</p></div>
        <div class="form-actions" style="position:static;background:none"><button class="btn btn-primary">Import</button></div>
      </form>`,
    text: () => `
      <form id="textForm" class="form">
        <div><label for="text">Recipe text</label>
        <textarea id="text" rows="14" placeholder="Paste a recipe from a website, email, notes app…" required></textarea>
        <p class="hint">Messy is fine. It'll be sorted into ingredients and steps for you to review.</p></div>
        <div class="form-actions" style="position:static;background:none"><button class="btn btn-primary">Import</button></div>
      </form>`,
    manual: () => `<div class="empty" style="padding:40px 20px"><p>Start with a blank recipe card.</p><button class="btn btn-primary" id="blank">Start writing</button></div>`,
  };

  const drawThumbs = () => {
    document.getElementById("thumbs").innerHTML = files.map((f, i) =>
      `<figure><img src="${f.preview}" alt="" /><button class="rm" data-rm="${i}">×</button><figcaption>${esc(f.file.name)}</figcaption></figure>`).join("");
    document.getElementById("go").disabled = !files.length;
  };
  const addFiles = (list) => {
    for (const file of list) files.push({ file, preview: /hei[cf]/i.test(file.type + file.name) ? "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 110 140'%3E%3Crect width='110' height='140' fill='%23ddd'/%3E%3Ctext x='55' y='75' font-size='14' text-anchor='middle' fill='%23777'%3EHEIC%3C/text%3E%3C/svg%3E" : URL.createObjectURL(file) });
    drawThumbs();
  };

  const draw = () => {
    document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    document.getElementById("pane").innerHTML = panes[tab]();
    if (tab === "photo") {
      const drop = document.getElementById("drop");
      const input = document.getElementById("file");
      drop.onclick = () => input.click();
      input.onchange = () => { addFiles(input.files); input.value = ""; };
      drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
      drop.ondragleave = () => drop.classList.remove("over");
      drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); addFiles(e.dataTransfer.files); };
      document.getElementById("thumbs").onclick = (e) => {
        if (e.target.dataset.rm === undefined) return;
        files.splice(Number(e.target.dataset.rm), 1);
        drawThumbs();
      };
      document.getElementById("go").onclick = async () => {
        const fd = new FormData();
        files.forEach((f) => fd.append("photos", f.file));
        loading("Reading your recipe… this can take up to a minute.");
        try {
          draft = await api("/api/import/photos", { method: "POST", body: fd });
          location.hash = "#/review";
        } catch (e) {
          renderAdd();
          toast(e.message, true);
        }
      };
      drawThumbs();
    } else if (tab === "url") {
      document.getElementById("urlForm").onsubmit = async (e) => {
        e.preventDefault();
        const url = document.getElementById("url").value;
        loading("Fetching recipe…");
        try {
          draft = await api("/api/import/url", { method: "POST", json: { url } });
          location.hash = "#/review";
        } catch (err) {
          renderAdd();
          toast(err.message, true);
        }
      };
    } else if (tab === "text") {
      document.getElementById("textForm").onsubmit = async (e) => {
        e.preventDefault();
        const text = document.getElementById("text").value;
        loading("Organizing your recipe…");
        try {
          draft = await api("/api/import/text", { method: "POST", json: { text } });
          location.hash = "#/review";
        } catch (err) {
          renderAdd();
          toast(err.message, true);
        }
      };
    } else {
      document.getElementById("blank").onclick = () => {
        draft = { title: "", ingredients: [], instructions: [], tags: [], source_type: "manual" };
        location.hash = "#/review";
      };
    }
  };
  document.getElementById("tabs").onclick = (e) => {
    if (!e.target.dataset.tab) return;
    tab = e.target.dataset.tab;
    draw();
  };
  draw();
}

// ---------- editor (new drafts & tweaks) ----------
function renderEditor(r, { isNew }) {
  let image = r.image || "";
  const imported = isNew && r.source_type !== "manual";
  app.innerHTML = `<div class="narrow">
    <a class="back" href="${isNew ? "#/new" : `#/recipe/${r.id}`}">← ${isNew ? "Back" : "Back to recipe"}</a>
    <h1 class="page-title">${isNew ? (imported ? "Review imported recipe" : "New recipe") : "Edit recipe"}</h1>
    ${imported ? `<div class="banner">Check everything looks right, fix anything that was misread, then save.</div>` : ""}
    ${!isNew ? `<div class="banner">Your previous version is kept in history, so feel free to experiment.</div>` : ""}
    <form class="form" id="form">
      <div><label for="title">Title</label><input type="text" id="title" value="${esc(r.title)}" required placeholder="Grandma's apple pie" /></div>
      <div><label for="description">Description</label><textarea id="description" rows="2" placeholder="A short intro (optional)">${esc(r.description)}</textarea></div>
      <div class="row">
        <div><label for="servings">Servings</label><input type="text" id="servings" value="${esc(r.servings)}" placeholder="4" /></div>
        <div><label for="prep_time">Prep</label><input type="text" id="prep_time" value="${esc(r.prep_time)}" placeholder="15 min" /></div>
        <div><label for="cook_time">Cook</label><input type="text" id="cook_time" value="${esc(r.cook_time)}" placeholder="45 min" /></div>
        <div><label for="total_time">Total</label><input type="text" id="total_time" value="${esc(r.total_time)}" placeholder="1 hr" /></div>
      </div>
      <div><label for="ingredients">Ingredients</label>
        <textarea id="ingredients" rows="10" placeholder="2 cups flour&#10;1 tsp salt&#10;# For the glaze&#10;1 cup powdered sugar">${esc(r.ingredients.join("\n"))}</textarea>
        <p class="hint">One per line. Start a line with <code># </code> to make a section heading.</p></div>
      <div><label for="instructions">Method</label>
        <textarea id="instructions" rows="12" placeholder="Preheat oven to 350°F.&#10;Whisk the dry ingredients together.">${esc(r.instructions.join("\n"))}</textarea>
        <p class="hint">One step per line. <code># </code> for section headings.</p></div>
      <div><label for="tags">Tags</label><input type="text" id="tags" value="${esc(r.tags.join(", "))}" placeholder="dessert, baking, holiday" />
        <p class="hint">Comma separated.</p></div>
      <div><label for="source_url">Source link</label><input type="url" id="source_url" value="${esc(r.source_url)}" placeholder="Optional" /></div>
      <div><label>Cover photo</label>
        <div class="cover-edit">
          <div class="preview" id="coverPreview"></div>
          <div class="row" style="flex:0 1 auto">
            <button type="button" class="btn btn-sm" id="coverPick">Upload photo</button>
            ${r.source_images?.length ? `<button type="button" class="btn btn-sm" id="coverOrig">Use original photo</button>` : ""}
            <button type="button" class="btn btn-sm btn-ghost" id="coverRm">Remove</button>
            <input type="file" id="coverFile" accept="image/*,.heic,.heif" hidden />
          </div>
        </div></div>
      <div class="form-actions">
        <a class="btn" href="${isNew ? "#/" : `#/recipe/${r.id}`}">Cancel</a>
        <button class="btn btn-primary" id="save">${isNew ? "Save to cookbook" : "Save changes"}</button>
      </div>
    </form></div>`;

  const drawCover = () => {
    document.getElementById("coverPreview").innerHTML = image ? `<img src="${imgUrl(image)}" alt="" />` : placeholder(r.title || "?");
  };
  drawCover();
  const coverFile = document.getElementById("coverFile");
  document.getElementById("coverPick").onclick = () => coverFile.click();
  document.getElementById("coverRm").onclick = () => { image = ""; drawCover(); };
  const orig = document.getElementById("coverOrig");
  if (orig) orig.onclick = () => { image = r.source_images[0]; drawCover(); };
  coverFile.onchange = async () => {
    if (!coverFile.files[0]) return;
    const fd = new FormData();
    fd.append("image", coverFile.files[0]);
    try {
      image = (await api("/api/upload", { method: "POST", body: fd })).filename;
      drawCover();
    } catch (e) {
      toast(e.message, true);
    }
  };

  const lines = (id) => document.getElementById(id).value.split("\n").map((l) => l.trim()).filter(Boolean);
  document.getElementById("form").onsubmit = async (e) => {
    e.preventDefault();
    const val = (id) => document.getElementById(id).value.trim();
    const data = {
      title: val("title"),
      description: val("description"),
      servings: val("servings"),
      prep_time: val("prep_time"),
      cook_time: val("cook_time"),
      total_time: val("total_time"),
      ingredients: lines("ingredients"),
      instructions: lines("instructions"),
      tags: [...new Set(val("tags").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean))],
      source_url: val("source_url"),
      image,
    };
    document.getElementById("save").disabled = true;
    try {
      let saved;
      if (isNew) {
        saved = await api("/api/recipes", { method: "POST", json: { ...r, ...data } });
        draft = null;
      } else {
        saved = await api(`/api/recipes/${r.id}`, { method: "PUT", json: data });
      }
      toast(isNew ? "Saved to your cookbook" : "Changes saved");
      location.hash = `#/recipe/${saved.id}`;
    } catch (err) {
      document.getElementById("save").disabled = false;
      toast(err.message, true);
    }
  };
}

route();
