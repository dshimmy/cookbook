import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { UPLOAD_DIR } from "./db.js";

const MODEL = "claude-opus-5-5";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

// ---------- Claude extraction ----------

const RecipeSchema = z.object({
  found: z.boolean().describe("false if no recipe could be identified in the input"),
  title: z.string(),
  description: z.string(),
  servings: z.string(),
  prep_time: z.string(),
  cook_time: z.string(),
  total_time: z.string(),
  ingredients: z.array(z.string()),
  instructions: z.array(z.string()),
  tags: z.array(z.string()),
});

const SYSTEM = `You transcribe recipes into a personal cookbook.
Rules:
- Transcribe faithfully. Keep the author's quantities, units and wording; fix only obvious OCR/typo errors. Never invent ingredients, steps or times that aren't in the source.
- ingredients: one ingredient per entry, quantity first (e.g. "2 cups all-purpose flour").
- instructions: one step per entry, without leading step numbers.
- If the recipe groups ingredients or steps into sections (e.g. "For the sauce"), insert a header entry in that list formatted as "# Section name" before the section's items.
- Times like "15 min" or "1 hr 30 min"; empty string if not stated. servings like "4" or "12 cookies"; empty if not stated.
- description: one or two sentences from the source (headnote) if present, otherwise empty.
- tags: 2-5 short lowercase tags inferred from the dish (e.g. "dessert", "chicken", "vegetarian", "italian").
- Handwritten margin notes or personal annotations: append them to description prefixed with "Notes on original: ".
- If the input spans several images, they are pages of the same recipe in order; merge them.
- If there is no recipe, set found=false and leave other fields empty.`;

let client;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    const err = new Error(
      "No Anthropic API key configured. Add ANTHROPIC_API_KEY to the .env file and restart the server."
    );
    err.status = 400;
    throw err;
  }
  client ??= new Anthropic();
  return client;
}

async function extractWithClaude(content) {
  const response = await getClient().beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: betaZodOutputFormat(RecipeSchema) },
    system: SYSTEM,
    messages: [{ role: "user", content }],
  });
  if (response.stop_reason === "refusal") throw httpError(422, "Claude declined to process this input.");
  if (response.stop_reason === "max_tokens") throw httpError(422, "Recipe was too long to transcribe.");
  const parsed = response.parsed_output;
  if (!parsed) throw httpError(502, "Couldn't parse the recipe from Claude's response.");
  if (!parsed.found) throw httpError(422, "No recipe found in that input.");
  const { found, ...recipe } = parsed;
  return recipe;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// ---------- Image handling ----------

const SUPPORTED = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" };
const MAX_BYTES = 3.5 * 1024 * 1024;

// Converts HEIC (iPhone photos) and shrinks large images using macOS `sips`,
// returning a path to a file the API accepts.
export function normalizeImage(filePath, originalName = "") {
  let ext = path.extname(originalName || filePath).toLowerCase();
  let current = filePath;
  const needsConvert = !SUPPORTED[ext];
  const tooBig = fs.statSync(current).size > MAX_BYTES;
  if (needsConvert || tooBig) {
    const out = `${filePath}-norm.jpg`;
    const args = ["-s", "format", "jpeg", "-s", "formatOptions", "85"];
    if (tooBig) args.push("-Z", "2400");
    try {
      execFileSync("sips", [...args, current, "--out", out], { stdio: "ignore" });
    } catch {
      throw httpError(415, `Unsupported image type "${ext || "unknown"}". Use JPG, PNG, WEBP or HEIC.`);
    }
    current = out;
    ext = ".jpg";
  }
  return { path: current, mediaType: SUPPORTED[ext] };
}

export async function importFromImages(files) {
  const content = files.map((f) => {
    const img = normalizeImage(f.path, f.originalname);
    return {
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: fs.readFileSync(img.path).toString("base64") },
    };
  });
  content.push({ type: "text", text: "Transcribe the recipe in these images." });
  const recipe = await extractWithClaude(content);
  // Keep the original photos alongside the transcription.
  return { ...recipe, source_type: "photo", source_images: files.map(storeUpload) };
}

export async function importFromText(text) {
  if (!text.trim()) throw httpError(400, "Paste some recipe text first.");
  const recipe = await extractWithClaude([{ type: "text", text: `Transcribe this recipe:\n\n${text}` }]);
  return { ...recipe, source_type: "text" };
}

// Moves an uploaded file into permanent storage and returns its stored filename.
export function storeUpload(file) {
  const img = normalizeImage(file.path, file.originalname);
  const name = `${crypto.randomUUID()}${path.extname(img.path).toLowerCase() || ".jpg"}`;
  fs.copyFileSync(img.path, path.join(UPLOAD_DIR, name));
  return name;
}

async function downloadImage(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return "";
    const type = res.headers.get("content-type") || "";
    const ext = type.includes("png") ? ".png" : type.includes("webp") ? ".webp" : type.includes("gif") ? ".gif" : ".jpg";
    const name = `${crypto.randomUUID()}${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), Buffer.from(await res.arrayBuffer()));
    return name;
  } catch {
    return "";
  }
}

// ---------- URL import ----------

export async function importFromUrl(url) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (!/^https?:$/.test(parsedUrl.protocol)) throw new Error();
  } catch {
    throw httpError(400, "That doesn't look like a valid web address.");
  }

  const res = await fetch(parsedUrl, { headers: { "User-Agent": UA, Accept: "text/html" } });
  if ([401, 403, 429].includes(res.status)) {
    throw httpError(502, "This site blocks automatic imports. Copy the recipe from the page and use \"Paste text\", or screenshot it and use \"From photos\".");
  }
  if (!res.ok) throw httpError(502, `The site returned an error (${res.status}).`);
  const html = await res.text();

  // Most recipe sites embed schema.org Recipe data — no AI needed.
  const ld = findJsonLdRecipe(html);
  let recipe;
  let imageUrl = "";
  if (ld && asArray(ld.recipeIngredient).length) {
    recipe = mapJsonLd(ld);
    imageUrl = pickImage(ld.image);
  } else {
    const text = htmlToText(html);
    recipe = await extractWithClaude([
      { type: "text", text: `Extract the recipe from this web page (${parsedUrl.href}):\n\n${text}` },
    ]);
    imageUrl = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i)?.[1] || "";
  }
  if (imageUrl) recipe.image = await downloadImage(new URL(decode(imageUrl), parsedUrl).href);
  return { ...recipe, source_url: parsedUrl.href, source_type: "url" };
}

function asArray(v) {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

function findJsonLdRecipe(html) {
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [, raw] of blocks) {
    let data;
    try {
      data = JSON.parse(raw.trim());
    } catch {
      continue;
    }
    const found = searchRecipe(data);
    if (found) return found;
  }
  return null;
}

function searchRecipe(node) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = searchRecipe(n);
      if (f) return f;
    }
    return null;
  }
  if (asArray(node["@type"]).includes("Recipe")) return node;
  return searchRecipe(node["@graph"]) || searchRecipe(node.mainEntity);
}

function mapJsonLd(ld) {
  const instructions = [];
  const walk = (item) => {
    if (typeof item === "string") {
      item.split(/\n+/).map(clean).filter(Boolean).forEach((s) => instructions.push(s));
    } else if (Array.isArray(item)) {
      item.forEach(walk);
    } else if (item && typeof item === "object") {
      if (asArray(item["@type"]).includes("HowToSection")) {
        if (item.name) instructions.push(`# ${clean(item.name)}`);
        walk(item.itemListElement);
      } else if (item.text || item.name) {
        instructions.push(clean(item.text || item.name));
      } else if (item.itemListElement) {
        walk(item.itemListElement);
      }
    }
  };
  walk(ld.recipeInstructions);

  // Site keywords tend to be SEO noise, so only fall back to them if there's no category/cuisine.
  const norm = (list) => list.flatMap((t) => String(t).split(",")).map((t) => clean(t).toLowerCase()).filter((t) => t && t.length < 25);
  let tags = norm([...asArray(ld.recipeCategory), ...asArray(ld.recipeCuisine)]);
  if (!tags.length) tags = norm(asArray(ld.keywords)).slice(0, 3);

  const yieldVal = asArray(ld.recipeYield).map(String);
  return {
    title: clean(ld.name) || "Untitled recipe",
    description: clean(ld.description),
    servings: yieldVal.find((y) => /\D/.test(y)) || yieldVal[0] || "",
    prep_time: duration(ld.prepTime),
    cook_time: duration(ld.cookTime),
    total_time: duration(ld.totalTime),
    ingredients: asArray(ld.recipeIngredient).map((i) => clean(String(i))).filter(Boolean),
    instructions,
    tags: [...new Set(tags)].slice(0, 5),
  };
}

function pickImage(img) {
  const first = asArray(img)[0];
  if (!first) return "";
  return typeof first === "string" ? first : first.url || first.contentUrl || "";
}

// ISO 8601 duration (PT1H30M) -> "1 hr 30 min"
function duration(iso) {
  if (!iso || typeof iso !== "string") return "";
  const m = iso.match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i);
  if (!m) return iso;
  let [, d, h, min] = m.map((x) => Number(x) || 0);
  h += d * 24;
  h += Math.floor(min / 60);
  min %= 60;
  return [h && `${h} hr`, min && `${min} min`].filter(Boolean).join(" ");
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", frac12: "½", frac14: "¼", frac34: "¾", deg: "°" };
function decode(s) {
  return String(s ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z0-9]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

function clean(s) {
  return decode(String(s ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function htmlToText(html) {
  return decode(
    html
      .replace(/<(script|style|noscript|svg|nav|footer|header|iframe)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(br|\/p|\/li|\/h\d|\/div|\/tr)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}
