import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export const DATA_DIR = path.join(import.meta.dirname, "..", "data");
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "cookbook.db"));
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS recipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    servings TEXT DEFAULT '',
    prep_time TEXT DEFAULT '',
    cook_time TEXT DEFAULT '',
    total_time TEXT DEFAULT '',
    ingredients TEXT DEFAULT '[]',
    instructions TEXT DEFAULT '[]',
    tags TEXT DEFAULT '[]',
    source_url TEXT DEFAULT '',
    source_type TEXT DEFAULT 'manual',
    image TEXT DEFAULT '',
    source_images TEXT DEFAULT '[]',
    favorite INTEGER DEFAULT 0,
    rating INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    snapshot TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

const JSON_FIELDS = ["ingredients", "instructions", "tags", "source_images"];
const EDITABLE = [
  "title", "description", "servings", "prep_time", "cook_time", "total_time",
  "ingredients", "instructions", "tags", "source_url", "source_type", "image", "source_images",
  "favorite", "rating",
];

function hydrate(row) {
  if (!row) return null;
  const r = { ...row };
  for (const f of JSON_FIELDS) r[f] = JSON.parse(r[f] || "[]");
  r.favorite = !!r.favorite;
  return r;
}

function serialize(data) {
  const out = {};
  for (const key of EDITABLE) {
    if (data[key] === undefined) continue;
    let v = data[key];
    if (JSON_FIELDS.includes(key)) v = JSON.stringify(Array.isArray(v) ? v : []);
    else if (key === "favorite") v = v ? 1 : 0;
    else if (key === "rating") v = Math.max(0, Math.min(5, Number(v) || 0));
    else v = String(v ?? "");
    out[key] = v;
  }
  return out;
}

export function listRecipes() {
  return db
    .prepare(
      `SELECT r.*, (SELECT COUNT(*) FROM notes n WHERE n.recipe_id = r.id) AS note_count
       FROM recipes r ORDER BY r.updated_at DESC`
    )
    .all()
    .map(hydrate);
}

export function getRecipe(id) {
  const recipe = hydrate(db.prepare("SELECT * FROM recipes WHERE id = ?").get(id));
  if (!recipe) return null;
  recipe.notes = db
    .prepare("SELECT * FROM notes WHERE recipe_id = ? ORDER BY created_at DESC, id DESC")
    .all(id);
  recipe.revisions = db
    .prepare("SELECT id, created_at FROM revisions WHERE recipe_id = ? ORDER BY id DESC")
    .all(id);
  return recipe;
}

export function createRecipe(data) {
  const fields = serialize({ title: "Untitled recipe", ...data });
  const keys = Object.keys(fields);
  const info = db
    .prepare(`INSERT INTO recipes (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
    .run(...keys.map((k) => fields[k]));
  return getRecipe(info.lastInsertRowid);
}

// Saves the previous version as a revision whenever recipe content changes,
// so tweaks can always be rolled back.
export function updateRecipe(id, data, { snapshot = true } = {}) {
  const current = db.prepare("SELECT * FROM recipes WHERE id = ?").get(id);
  if (!current) return null;
  const fields = serialize(data);
  const keys = Object.keys(fields);
  if (!keys.length) return getRecipe(id);

  const contentChanged = keys.some(
    (k) => !["favorite", "rating"].includes(k) && String(fields[k]) !== String(current[k])
  );
  if (snapshot && contentChanged) {
    db.prepare("INSERT INTO revisions (recipe_id, snapshot) VALUES (?, ?)").run(
      id,
      JSON.stringify(current)
    );
  }
  db.prepare(
    `UPDATE recipes SET ${keys.map((k) => `${k} = ?`).join(", ")}${
      contentChanged ? ", updated_at = datetime('now')" : ""
    } WHERE id = ?`
  ).run(...keys.map((k) => fields[k]), id);
  return getRecipe(id);
}

export function deleteRecipe(id) {
  const row = hydrate(db.prepare("SELECT * FROM recipes WHERE id = ?").get(id));
  db.prepare("DELETE FROM recipes WHERE id = ?").run(id);
  return row;
}

export function getRevision(recipeId, revId) {
  const row = db
    .prepare("SELECT * FROM revisions WHERE id = ? AND recipe_id = ?")
    .get(revId, recipeId);
  return row ? { ...row, snapshot: hydrate(JSON.parse(row.snapshot)) } : null;
}

export function addNote(recipeId, body) {
  const info = db.prepare("INSERT INTO notes (recipe_id, body) VALUES (?, ?)").run(recipeId, body);
  return db.prepare("SELECT * FROM notes WHERE id = ?").get(info.lastInsertRowid);
}

export function deleteNote(recipeId, noteId) {
  db.prepare("DELETE FROM notes WHERE id = ? AND recipe_id = ?").run(noteId, recipeId);
}
