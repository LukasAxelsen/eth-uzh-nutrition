# ETH & UZH Mensa Menus

A small static site that shows what ETH and UZH outlets are serving today, with nutrition facts per dish. Updated automatically every morning.

Live: <https://lukasaxelsen.github.io/eth-uzh-nutrition/>

## Features

- Menus for ETH and UZH outlets, refreshed daily at 04:00 UTC
- Nutrition per dish: kcal, protein, fat, saturated fat, carbs, sugar, salt (per 100 g and per serving where available)
- A mensa selector with groups (Central, Höngg, Irchel, plus groups you define yourself)
- Lunch/Dinner switch, dark mode, and a layout that works on phones
- A "raw data" panel with a copy button, and a plain-text dump (`index.txt`) for scripts and LLMs

Static site: no accounts, no tracking, no build step.

## Data sources

| Source | What we use |
| --- | --- |
| [ETH Cookpit API](https://idapps.ethz.ch/cookpit-pub-services/v1/meals) | Public JSON API for all ETH facilities. Energy comes in kJ and is converted to kcal. |
| [UZH Food2050](https://app.food2050.ch) | Public GraphQL API for the outlet list; per-dish nutrition is scraped from the weekly menu pages. |

Both are public, no API key required. The script waits between requests to stay under Food2050's rate limits.

## How it works

`menu.py` is the whole backend. It fetches ETH and UZH menus, merges them, and writes:

- `output/data.json` — structured data for the frontend
- `output/index.txt` — one line per dish, for scripts and command-line tools
- `output/index.html`, `output/style.css`, `output/app.js` — the assembled site

The frontend in `template/` is plain HTML/CSS/JS (no framework, no build).

## Project layout

```
menu.py                 Fetches everything, writes output/
template/
  index.html            Page shell (placeholders get filled in by menu.py)
  style.css             Apple-flat styling, dark mode, responsive
  app.js                Selection state, group chips, rendering
.github/workflows/
  menu.yml              Daily cron + manual dispatch, deploys to gh-pages
CONTRACT.md             Exact data.json schema + DOM class contract
```

See [CONTRACT.md](CONTRACT.md) for the exact schema.

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
