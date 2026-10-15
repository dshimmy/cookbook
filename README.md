# My Cookbook

A personal recipe collection that runs on your computer.

## Run it

```
npm start
```

Then open http://localhost:3000. Use `npm run dev` to auto-restart the server after code changes.

## Adding recipes

- **From photos**: cookbook pages, recipe cards (handwritten works too), or screenshots. Add several photos for a recipe that spans pages. iPhone HEIC photos are fine. The original photos stay attached to the recipe.
- **From a link**: most recipe sites work instantly. Some sites block automated access; for those, copy the text and use *Paste text*, or take a screenshot.
- **Paste text**: messy text from an email, a notes app, or a web page.
- **Type it in**: start with a blank recipe.

Every import opens for review before it's saved.

Photo and text imports use Claude, so they need an Anthropic API key in `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
```

## Using it

- Notes: dated notes on each recipe ("used less sugar", "kids loved it").
- Edit / tweak: change anything. Each save keeps the previous version in *Version history*, and you can restore it.
- Share: send through Messages/Mail/AirDrop, copy as text, or email. **Save as PDF** writes a formatted PDF into the `Saved PDFs/` folder (needs Google Chrome installed). The 📁 Saved PDFs button opens that folder.
- Ingredient scaling (½×–3×), check off ingredients and steps while cooking, star ratings, favorites, tags, search, print.

## Where your data lives

`data/cookbook.db` (SQLite) and `data/uploads/` (photos). To back up, copy the `data/` folder.

## Getting a shared recipe collection

If someone has given you access to their private recipes repo, clone it into `data/` (before the first `npm start`, or after moving the old `data/` folder aside):

```
git clone https://github.com/dshimmy/cookbook.git
cd cookbook
npm install
git clone https://github.com/dshimmy/cookbook-recipes.git data
npm start
```

To get new recipes later, run `git -C data pull`. Recipes you add or edit locally will block that pull, so treat the shared collection as read-only, or keep your own copy separate.
