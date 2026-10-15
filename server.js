import express from "express";
import multer from "multer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as db from "./src/db.js";
import { execFile } from "node:child_process";
import { PDF_DIR, printImage, printPage, savePdf } from "./src/pdf.js";
import { importFromImages, importFromText, importFromUrl, storeUpload } from "./src/importers.js";

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const upload = multer({ dest: path.join(os.tmpdir(), "cookbook-uploads"), limits: { fileSize: 30 * 1024 * 1024 } });

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(import.meta.dirname, "public")));
app.use("/uploads", express.static(db.UPLOAD_DIR));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
function cleanupTemp(files = []) {
  for (const f of files) for (const p of [f.path, `${f.path}-norm.jpg`]) fs.rm(p, { force: true }, () => {});
}

function removeImages(names = []) {
  for (const name of names.filter(Boolean)) fs.rm(path.join(db.UPLOAD_DIR, path.basename(name)), { force: true }, () => {});
}

// ----- Recipes -----
app.get("/api/recipes", (req, res) => res.json(db.listRecipes()));

app.get("/api/recipes/:id", (req, res) => {
  const recipe = db.getRecipe(req.params.id);
  recipe ? res.json(recipe) : res.status(404).json({ error: "Recipe not found" });
});

app.post("/api/recipes", (req, res) => res.status(201).json(db.createRecipe(req.body)));

app.put("/api/recipes/:id", (req, res) => {
  const recipe = db.updateRecipe(req.params.id, req.body);
  recipe ? res.json(recipe) : res.status(404).json({ error: "Recipe not found" });
});

app.delete("/api/recipes/:id", (req, res) => {
  const row = db.deleteRecipe(req.params.id);
  if (row) removeImages([row.image, ...row.source_images]);
  res.status(204).end();
});

// ----- Revisions (history of tweaks) -----
app.get("/api/recipes/:id/revisions/:revId", (req, res) => {
  const rev = db.getRevision(req.params.id, req.params.revId);
  rev ? res.json(rev) : res.status(404).json({ error: "Revision not found" });
});

app.post("/api/recipes/:id/revisions/:revId/restore", (req, res) => {
  const rev = db.getRevision(req.params.id, req.params.revId);
  if (!rev) return res.status(404).json({ error: "Revision not found" });
  const { id, created_at, updated_at, favorite, rating, ...content } = rev.snapshot;
  res.json(db.updateRecipe(req.params.id, content));
});

// ----- Notes -----
app.post("/api/recipes/:id/notes", (req, res) => {
  const body = String(req.body.body || "").trim();
  if (!body) return res.status(400).json({ error: "Note is empty" });
  if (!db.getRecipe(req.params.id)) return res.status(404).json({ error: "Recipe not found" });
  res.status(201).json(db.addNote(req.params.id, body));
});

app.delete("/api/recipes/:id/notes/:noteId", (req, res) => {
  db.deleteNote(req.params.id, req.params.noteId);
  res.status(204).end();
});

// ----- PDFs -----
app.get("/print/:id", (req, res) => {
  const recipe = db.getRecipe(req.params.id);
  if (!recipe) return res.status(404).send("Recipe not found");
  res.send(printPage(recipe, { includeNotes: req.query.notes === "1" }));
});

app.get("/print-img/:name", (req, res) => {
  const file = printImage(db.UPLOAD_DIR, req.params.name);
  file ? res.sendFile(file) : res.status(404).end();
});

app.post("/api/recipes/:id/pdf", wrap(async (req, res) => {
  const recipe = db.getRecipe(req.params.id);
  if (!recipe) return res.status(404).json({ error: "Recipe not found" });
  const file = await savePdf(recipe, { port: PORT, includeNotes: !!req.body.notes });
  execFile("open", ["-R", file]); // show it in Finder
  res.json({ filename: path.basename(file) });
}));

app.post("/api/pdfs/open", (req, res) => {
  fs.mkdirSync(PDF_DIR, { recursive: true });
  execFile("open", [PDF_DIR]);
  res.status(204).end();
});

// ----- Images & importing -----
app.post("/api/upload", upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No image uploaded" });
  try {
    res.json({ filename: storeUpload(req.file) });
  } finally {
    cleanupTemp([req.file]);
  }
});

// Import endpoints return an unsaved draft so it can be reviewed before saving.
app.post("/api/import/url", wrap(async (req, res) => {
  res.json(await importFromUrl(String(req.body.url || "").trim()));
}));

app.post("/api/import/text", wrap(async (req, res) => {
  res.json(await importFromText(String(req.body.text || "")));
}));

app.post("/api/import/photos", upload.array("photos", 10), wrap(async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: "No photos uploaded" });
  try {
    res.json(await importFromImages(req.files));
  } finally {
    cleanupTemp(req.files);
  }
}));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Something went wrong" });
});

app.listen(PORT, () => console.log(`Cookbook running at http://localhost:${PORT}`));
