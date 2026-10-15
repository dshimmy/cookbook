import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const PDF_DIR = path.join(import.meta.dirname, "..", "Saved PDFs");

const BROWSERS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const isHeader = (line) => line.startsWith("# ");

export function safeFilename(title) {
  return (title || "Recipe").replace(/[\/\\:*?"<>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 120) || "Recipe";
}

// Standalone, print-styled page that Chrome turns into the PDF.
export function printPage(r, { includeNotes = false } = {}) {
  const facts = [["Serves", r.servings], ["Prep", r.prep_time], ["Cook", r.cook_time], ["Total", r.total_time]].filter(([, v]) => v);
  const list = (items, ordered) =>
    items.map((l) => (isHeader(l) ? `<li class="sec">${esc(l.slice(2))}</li>` : `<li${ordered ? ' class="step"' : ""}>${esc(l)}</li>`)).join("");
  let source = "";
  if (r.source_url) {
    try {
      source = new URL(r.source_url).hostname.replace(/^www\./, "");
    } catch {}
  }

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(r.title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=Inter:wght@400;600&display=swap">
<style>
  @page { size: letter; margin: 0.6in 0.65in; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #2b2420; font: 10.5pt/1.5 "Inter", -apple-system, "Helvetica Neue", sans-serif; }
  h1, h2 { font-family: "Fraunces", Georgia, serif; font-weight: 600; margin: 0; line-height: 1.15; }
  h1 { font-size: 26pt; letter-spacing: -.01em; }
  h2 { font-size: 14pt; color: #c0532e; margin-bottom: 8px; padding-bottom: 4px; border-bottom: 1.5px solid #e6dccd; }
  .head { display: flex; gap: 24px; align-items: flex-start; margin-bottom: 22px; }
  .head-text { flex: 1; }
  .desc { color: #6b5f56; margin: 8px 0 12px; }
  .facts { display: flex; gap: 18px; flex-wrap: wrap; font-size: 9.5pt; }
  .facts b { display: block; font-size: 7.5pt; text-transform: uppercase; letter-spacing: .08em; color: #9a8b7e; }
  .cover { flex: 0 0 auto; max-width: 42%; }
  .cover img { display: block; max-width: 100%; max-height: 3.4in; border-radius: 8px; }
  .body { display: grid; grid-template-columns: 34% 1fr; gap: 28px; }
  ul, ol { list-style: none; margin: 0; padding: 0; }
  .ing li { padding: 4px 0; border-bottom: 1px dotted #e6dccd; break-inside: avoid; }
  ol { counter-reset: s; }
  li.step { counter-increment: s; position: relative; padding: 0 0 9px 26px; break-inside: avoid; }
  li.step::before { content: counter(s); position: absolute; left: 0; top: 0; font-weight: 600; color: #c0532e; }
  li.sec { font: 600 11pt "Fraunces", Georgia, serif; color: #c0532e; padding: 10px 0 4px; border: 0; }
  .notes { margin-top: 22px; background: #f6efe4; border-radius: 8px; padding: 12px 16px; break-inside: avoid; }
  .notes h2 { border: 0; padding: 0; margin-bottom: 6px; }
  .notes li { padding: 2px 0; }
  .notes li::before { content: "•  "; color: #c0532e; }
  .foot { margin-top: 22px; font-size: 8.5pt; color: #9a8b7e; }
</style></head><body>
  <div class="head">
    <div class="head-text">
      <h1>${esc(r.title)}</h1>
      ${r.description ? `<p class="desc">${esc(r.description)}</p>` : ""}
      ${facts.length ? `<div class="facts">${facts.map(([k, v]) => `<div><b>${k}</b>${esc(v)}</div>`).join("")}</div>` : ""}
    </div>
    ${r.image ? `<div class="cover"><img src="/print-img/${encodeURIComponent(r.image)}"></div>` : ""}
  </div>
  <div class="body">
    <div><h2>Ingredients</h2><ul class="ing">${list(r.ingredients, false)}</ul></div>
    <div><h2>Method</h2><ol>${list(r.instructions, true)}</ol></div>
  </div>
  ${includeNotes && r.notes.length ? `<div class="notes"><h2>My notes</h2><ul>${r.notes.map((n) => `<li>${esc(n.body)}</li>`).join("")}</ul></div>` : ""}
  ${source ? `<div class="foot">Source: ${esc(source)}</div>` : ""}
</body></html>`;
}

// Full-size phone photos would make a ~20 MB PDF; print a downsized copy instead.
export function printImage(uploadDir, name) {
  const src = path.join(uploadDir, path.basename(name));
  if (!fs.existsSync(src)) return null;
  const cacheDir = path.join(uploadDir, "..", "print-cache");
  const out = path.join(cacheDir, `${path.basename(name)}.jpg`);
  if (!fs.existsSync(out)) {
    fs.mkdirSync(cacheDir, { recursive: true });
    try {
      execFileSync("sips", ["-Z", "1200", "-s", "format", "jpeg", "-s", "formatOptions", "80", src, "--out", out], { stdio: "ignore" });
    } catch {
      return src;
    }
  }
  return out;
}

export async function savePdf(recipe, { port, includeNotes }) {
  const browser = BROWSERS.find((b) => fs.existsSync(b));
  if (!browser) {
    const err = new Error("Saving PDFs needs Google Chrome installed. Use Print → Save as PDF instead.");
    err.status = 400;
    throw err;
  }
  fs.mkdirSync(PDF_DIR, { recursive: true });
  const file = path.join(PDF_DIR, `${safeFilename(recipe.title)}.pdf`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cookbook-pdf-"));
  try {
    await run(browser, [
      "--headless=new", "--disable-gpu", "--no-first-run", `--user-data-dir=${profile}`,
      "--no-pdf-header-footer", "--virtual-time-budget=5000", `--print-to-pdf=${file}`,
      `http://localhost:${port}/print/${recipe.id}${includeNotes ? "?notes=1" : ""}`,
    ], { timeout: 60000 });
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
  if (!fs.existsSync(file)) throw new Error("PDF couldn't be created.");
  return file;
}
