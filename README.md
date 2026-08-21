# Zmittag

Today's menus for every ETH and UZH Mensa — calories, nutrition facts, and photos for many dishes, plus opening hours and prices. Updated automatically every morning, free, no account, no app.

Live: <https://lukasaxelsen.github.io/eth-uzh-zmittag/>

## Features

- Separate lunch and dinner menus with a one-tap switch
- Nutrition per dish — kcal, protein, fat, saturated fat, carbs, sugar, salt — per 100 g and per serving where available
- Dish photos, opening hours, and dish prices — all toggleable in the Setting panel
- A calendar to browse menus for today and the next two weeks
- Filter by Mensa or campus area (Central, Hoengg, Irchel, Oerlikon, Other), or save your own group of favorites
- Light, dark, and auto theme, and a layout that works on phones

Static site: no tracking.

## For developers

- `index.txt` — one line per dish, for scripts and LLMs
- A "raw data" panel on the site with a copy button
- [CONTRACT.md](CONTRACT.md) — `data.json` schema, DOM class contract, and the animation contract
- [AGENTS.md](AGENTS.md) — mandatory rules for any agent/human editing this repo (animation architecture, prohibitions, workflow)
- `scripts/verify-anim-contract.py` — machine-checkable animation contract; run after any frontend change
- `scripts/verify-menu-data.py` — deployment guard for the generated menu data

## Data sources

| Source | What we use |
| --- | --- |
| [ETH Cookpit API](https://idapps.ethz.ch/cookpit-pub-services/v1/meals) | Public JSON API for all ETH facilities. Energy comes in kJ and is converted to kcal; dish photo URLs come from the API's `image-url` field. |
| [UZH Food2050](https://app.food2050.ch) | Public GraphQL API (today's offer, fallback when the weekly pages are empty); per-dish nutrition and photos are scraped from each dish's detail page (reached via the weekly menu). |

Both are public, no API key required. The script waits between requests to stay under Food2050's rate limits.

## How it works

`menu.py` is the whole backend. It fetches ETH and UZH menus, merges them, and writes:

- `output/data.json` — structured data for the frontend
- `output/index.txt` — one line per dish (see [For developers](#for-developers))
- `output/index.html`, `output/style.css`, `output/app.js` — the assembled site

The frontend in `template/` is plain HTML/CSS/JS (no framework, no build).

## Project layout

```
menu.py                     Fetches everything, writes output/
template/
  index.html                Page shell (placeholders get filled in by menu.py)
  style.css                 Apple-flat styling, light/dark/auto themes, responsive
  app.js                    Selection state, date picker, groups, settings, rendering
scripts/
  verify-anim-contract.py   Machine-checkable animation contract; run after frontend changes
  verify-menu-data.py       Blocks malformed or unexpectedly empty weekday data
.github/workflows/
  menu.yml                  Daily cron + manual dispatch, builds and deploys a Pages artifact
AGENTS.md                   Rules for any agent or human editing this repo
CONTRACT.md                 data.json schema, DOM class contract, animation contract
```

## Running it locally

Requirements: Python 3.9+ and `curl` (used for HTTP requests). No dependencies to install.

```sh
python3 menu.py   # on Windows: py menu.py
```

Then serve the `output/` directory:

```sh
cd output
python3 -m http.server 8000
```

Open <http://localhost:8000>.

## Deployment

GitHub Actions runs `menu.py` on a cron schedule (04:00 UTC), validates
`output/data.json`, uploads `output/` as a GitHub Pages artifact, and deploys
that artifact. The workflow has read-only repository access while it builds;
only the separate deployment job can publish to Pages.

In **Settings → Pages**, set the publishing source to **GitHub Actions** once
before using this workflow. A weekday result with no dishes is blocked before
deployment. For a known holiday or closure, use **Run workflow** and enable
`allow_empty_today` to publish the intentionally empty menu.

## License

© Aeneanicus. Menu data is property of ETH Zürich and the University of Zurich.
