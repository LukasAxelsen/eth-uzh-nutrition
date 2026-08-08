# ETH & UZH Mensa Menus

Today's menus for every ETH and UZH Mensa — with calories, nutrition facts, and photos for most dishes. Updated automatically every morning, free, no account, no app.

The official ETH and UZH menu pages don't show calories — this site does.

Live: <https://lukasaxelsen.github.io/eth-uzh-nutrition/>

## Features

- Separate lunch and dinner menus with a one-tap switch
- Nutrition per dish — kcal, protein, fat, saturated fat, carbs, sugar, salt — per 100 g and per serving where available
- Dish photos — switch them on in Settings
- Filter by Mensa or campus area (Central, Höngg, Irchel), or save your own group of favorites
- Dark mode, and a layout that works on phones

Static site: no accounts, no tracking.

## For developers

- `index.txt` — one line per dish, for scripts and LLMs
- A "raw data" panel on the site with a copy button
- [CONTRACT.md](CONTRACT.md) — exact `data.json` schema and DOM class contract

## Data sources

| Source | What we use |
| --- | --- |
| [ETH Cookpit API](https://idapps.ethz.ch/cookpit-pub-services/v1/meals) | Public JSON API for all ETH facilities. Energy comes in kJ and is converted to kcal; dish photos via the image endpoint. |
| [UZH Food2050](https://app.food2050.ch) | Public GraphQL API for the outlet list; per-dish nutrition and photos are scraped from the weekly menu pages. |

Both are public, no API key required. The script waits between requests to stay under Food2050's rate limits.

## How it works

`menu.py` is the whole backend. It fetches ETH and UZH menus, merges them, and writes:

- `output/data.json` — structured data for the frontend
- `output/index.txt` — one line per dish (see [For developers](#for-developers))
- `output/index.html`, `output/style.css`, `output/app.js` — the assembled site

The frontend in `template/` is plain HTML/CSS/JS (no framework, no build).

## Project layout

```
menu.py                 Fetches everything, writes output/
template/
  index.html            Page shell (placeholders get filled in by menu.py)
  style.css             Apple-flat styling, dark mode, responsive
  app.js                Selection state, favorite groups, rendering
.github/workflows/
  menu.yml              Daily cron + manual dispatch, deploys to gh-pages
CONTRACT.md             Exact data.json schema + DOM class contract
```

## Running it locally

Requirements: Python 3.10+ and `curl` (used for HTTP requests). No dependencies to install.

```sh
python3 menu.py
```

Then serve the `output/` directory:

```sh
cd output
python3 -m http.server 8000
```

Open <http://localhost:8000>.

## Deployment

GitHub Actions runs `menu.py` on a cron schedule (04:00 UTC) and deploys `output/` to the `gh-pages` branch with [peaceiris/actions-gh-pages](https://github.com/peaceiris/actions-gh-pages). You can also trigger it manually from the Actions tab.

## License

© Aeneanicus. Menu data is property of ETH Zürich and the University of Zurich.
