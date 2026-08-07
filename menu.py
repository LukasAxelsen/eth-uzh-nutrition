#!/usr/bin/env python3
"""
Fetch all ETH + UZH mensa menus into data.json (structured, for the frontend)
and index.txt (plain text, for AI consumption).

Sources:
  - ETH facilities: Cookpit REST API (public, no auth). One call returns all
    facilities; meals are filtered client-side via meal-times mapping.
  - UZH outlets: Food2050 GraphQL API (public). Per-location call returns
    kitchens + dish list; per-dish pages are scraped for nutrition (stats).
"""
import json
import os
import re
import subprocess
import time
from datetime import timezone, timedelta, datetime

# Pause before every HTTP request. Food2050 (app.food2050.ch) rate-limits
# rapid bursts, so the pacing lives inside http_get/http_post and covers the
# whole UZH scrape: list-API POSTs, weekly pages and per-dish detail pages.
SCRAPE_DELAY = 0.4  # seconds

USER_AGENT = "Mozilla/5.0 (compatible; eth-uzh-nutrition/1.0)"

# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------

TODAY = datetime.now(timezone(timedelta(hours=2))).date().isoformat()

BASE = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(BASE, "output")
TEMPLATE_DIR = os.path.join(BASE, "template")

# ETH facility-id -> (display name, default group)
ETH_FACILITIES = {
    1: ("bQm", "Central"),
    2: ("CafeBar", "Central"),
    3: ("Clausiusbar", "Central"),
    4: ("Kiosk CLA", "Central"),
    5: ("Dozentenfoyer", "Central"),
    6: ("Einstein & Zweistein", "Central"),
    7: ("food&lab", "Central"),
    8: ("Archimedes", "Medizin"),
    9: ("Mensa Polyterrasse", "Central"),
    10: ("Polysnack", "Central"),
    11: ("Tannenbar", "Central"),
    12: ("Eureka Take Away", "Medizin"),
    13: ("Zwei Grad Bistro", "Central"),
    14: ("Alumni quattro Lounge", "Central"),
    15: ("Bellavista", "Hoengg"),
    16: ("Mendokoro", "Hoengg"),
    19: ("food market", "Irchel"),
    20: ("FUSION meal", "Hoengg"),
    22: ("Rice Up!", "Hoengg"),
    23: ("Octavo", "Oerlikon"),
    27: ("Science Lounge", "Irchel"),
    28: ("Flavour Kitchen", "Irchel"),
}

# ETH meal-time names -> Lunch/Dinner (anything else is dropped)
ETH_LUNCH_NAMES = ("Mittag", "Mittagessen", "Lunch")
ETH_DINNER_NAMES = ("Abend", "Abendessen", "Dinner")

# Food2050 location-id -> (default group, kitchen-slug -> display name)
UZH_LOCATIONS = {
    "e321519e-3f83-4a10-b6d8-22d395ebfc5d": ("Central", {
        "untere-mensa": "Untere Mensa", "obere-mensa": "Obere Mensa",
        "lichthof": "Lichthof",
    }),
    "2d415736-961b-4237-9a6e-f825577e6c73": ("Irchel", {
        "mensa": "Mensa Irchel", "green-kitchen": "Green Kitchen Lab",
        "seerose": "Seerose",
    }),
    "6c3a3659-a85b-4224-b340-a342396626b3": ("Oerlikon", {
        "uzh-binzmuehle": "Mensa Oerlikon",
    }),
    "2f761b0c-5a03-43dc-8cdc-378df8536d01": ("City", {
        "uzh-cityport": "Cityport Mensa",
    }),
    "0663eb48-5f4d-4ca0-bdd7-238257009003": ("Other", {
        "tierspital": "Tierspital Mensa",
    }),
    "5bbfd257-fb0a-48c2-a406-891fa647da45": ("Other", {
        "uzh-botanischergarten": "Botanischer Garten",
    }),
}

# Outlets with a public Food2050 weekly page (used for nutrition scraping)
UZH_WEEKLY_URLS = {
    "untere-mensa": "https://app.food2050.ch/de/v2/zfv/universitat-zurich,campus-zentrum/untere-mensa/mittagsverpflegung/menu/weekly",
    "obere-mensa": "https://app.food2050.ch/de/v2/zfv/universitat-zurich,campus-zentrum/obere-mensa/mittagsverpflegung/menu/weekly",
    "lichthof": "https://app.food2050.ch/de/v2/zfv/universitat-zurich,campus-zentrum/lichthof/mittagsverpflegung/menu/weekly",
    "mensa": "https://app.food2050.ch/de/v2/zfv/universitat-zurich,campus-irchel/mensa/mittagsverpflegung/menu/weekly",
    "green-kitchen": "https://app.food2050.ch/de/v2/zfv/universitat-zurich,campus-irchel/green-kitchen/mittagsverpflegung/menu/weekly",
    "seerose": "https://app.food2050.ch/de/v2/zfv/universitat-zurich,campus-irchel/seerose/mittagsverpflegung/menu/weekly",
    "uzh-binzmuehle": "https://app.food2050.ch/de/v2/zfv/universitat-zurich,campus-oerlikon/mensa-binzmuhle/mittagsverpflegung/menu/weekly",
}

# All nutrition rows the frontend table shows (fixed order)
NUTRITION_KEYS = ["kcal", "protein", "fat", "saturated", "carbs", "sugar", "salt", "fiber", "weight"]

ETH_NUTRIENT_KEYS = ["energy", "protein", "fat", "saturated-fatty-acids", "carbohydrates", "sugar", "salt"]
ETH_NUTRIENT_LABELS = ["kcal", "protein", "fat", "saturated", "carbs", "sugar", "salt"]

# Food2050 stats key -> data.json label. The source emits "fibers"
# (plural) and "energy" already in kcal — no conversion needed.
UZH_NUTRIENT_MAP = {
    "energy": "kcal", "protein": "protein", "fat": "fat",
    "carbohydrates": "carbs", "sugar": "sugar",
    "salt": "salt", "fibers": "fiber",
}


# --------------------------------------------------------------------------
# HTTP + numeric helpers
# --------------------------------------------------------------------------

def _num(value):
    """Return value as a float, or None when missing / zero / non-numeric."""
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if f != 0 else None


def _keep_number(value):
    """Like _num, but keeps integers as ints (UZH per-serving amounts)."""
    f = _num(value)
    if f is None:
        return None
    return int(f) if f.is_integer() else f


def _curl(args, timeout=30):
    """Run curl and return stdout text, or '' after attempts with backoff."""
    cmd = ["curl", "-s", "-A", USER_AGENT] + args
    for attempt in range(2):
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
            if result.stdout:
                return result.stdout
        except Exception:
            pass
        if attempt == 0:
            time.sleep(SCRAPE_DELAY)  # brief backoff before the retry
    return ""


def http_get(url, timeout=30):
    """GET a URL and return the body text (or '' on failure)."""
    time.sleep(SCRAPE_DELAY)  # pace every request (Food2050 rate limits)
    return _curl([url], timeout=timeout)


def http_post(url, body, headers=None, timeout=30):
    """POST a JSON body and return the parsed dict (or {} on failure)."""
    time.sleep(SCRAPE_DELAY)  # pace every request (Food2050 rate limits)
    args = ["-X", "POST", url, "-H", "Content-Type: application/json"]
    for k, v in (headers or {}).items():
        args += ["-H", f"{k}: {v}"]
    args += ["-d", body]
    text = _curl(args, timeout=timeout)
    try:
        return json.loads(text) if text else {}
    except ValueError:
        return {}


# --------------------------------------------------------------------------
# ETH
# --------------------------------------------------------------------------

def eth_meal_slot(meal_time_name):
    """Map an ETH meal-time name to a slot ('Lunch'|'Dinner') or None."""
    if any(t in meal_time_name for t in ETH_DINNER_NAMES):
        return "Dinner"
    if any(t in meal_time_name for t in ETH_LUNCH_NAMES):
        return "Lunch"
    return None


def fetch_eth():
    """Return list of {id, name, group, meals: {Lunch: [...], Dinner: [...]}}."""
    url = (
        f"https://idapps.ethz.ch/cookpit-pub-services/v1/meals"
        f"?client-id=ethz-wcms&lang=de&date={TODAY}&facility-id=9"
        f"&meal-times-after={TODAY}T00:00:00Z&meal-times-before={TODAY}T23:59:59Z"
    )
    data = json.loads(http_get(url) or "{}")
    meals = data.get("meals", [])
    meal_times = data.get("meal-times", [])

    # meal-time-id -> (facility-id, meal-time-name)
    mt_map = {
        mt.get("meal-time-id"): (mt.get("facility-id"), mt.get("meal-time-name", ""))
        for mt in meal_times if mt.get("meal-time-id")
    }

    # facility-id -> {Lunch: [dishes], Dinner: [dishes]}
    per_facility = {}
    for m in meals:
        if not m.get("meal-name"):
            continue
        mt_id = m.get("meal-time-id")
        if mt_id not in mt_map:
            continue
        fid, mt_name = mt_map[mt_id]
        if fid not in ETH_FACILITIES:
            continue
        slot = eth_meal_slot(mt_name)
        if slot is None:
            continue

        dish = {
            "line": m.get("line-name", ""),
            "dish": m["meal-name"],
            "desc": m.get("description", "").strip(),
            "nutrition": {},
        }
        # ETH reports energy in kJ — convert to kcal. Missing/zero values
        # are skipped so dishes never carry fabricated 0s.
        nutr = {}
        for nk, nl in zip(ETH_NUTRIENT_KEYS, ETH_NUTRIENT_LABELS):
            val = _num(m.get(nk))
            if val is None:
                continue
            if nl == "kcal":
                val = round(val / 4.184, 1)
            nutr[nl] = val
        dish["nutrition"]["p100"] = nutr
        dish["nutrition"]["total"] = {}

        per_facility.setdefault(fid, {"Lunch": [], "Dinner": []})[slot].append(dish)

    result = []
    for fid, (name, group) in ETH_FACILITIES.items():
        meals_by_slot = per_facility.get(fid)
        if not meals_by_slot:
            continue  # facility has no dishes today — drop it entirely
        result.append({
            "id": f"eth-{fid}",
            "name": f"ETH {name}",
            "group": group,
            "meals": {
                "Lunch": meals_by_slot.get("Lunch", []),
                "Dinner": meals_by_slot.get("Dinner", []),
            },
        })
    return result


# --------------------------------------------------------------------------
# UZH (Food2050)
# --------------------------------------------------------------------------

FOOD2050_QUERY = (
    'query ExampleQuery($locationId: String!) { location(id: $locationId) { '
    "kitchens { slug, todayOffer { digitalMenuItems { displayName "
    "recipe { title(returnAll: true) } } } } } }"
)


def fetch_uzh():
    """Return list of {id, name, group, meals} for all UZH Food2050 outlets."""
    result = []
    for loc_id, (group, slug_names) in UZH_LOCATIONS.items():
        body = json.dumps({
            "query": FOOD2050_QUERY,
            "variables": {"locationId": loc_id},
            "operationName": "ExampleQuery",
        })
        data = http_post("https://api.app.food2050.ch/", body)
        kitchens = (data.get("data") or {}).get("location") or {}
        kitchens = kitchens.get("kitchens") or []

        for k in kitchens:
            slug = k.get("slug", "")
            if slug not in slug_names:
                continue
            name = slug_names[slug]

            dishes = scrape_uzh_weekly(slug)
            if dishes is None:
                dishes = uzh_dishes_from_list(k.get("todayOffer") or [])

            if not dishes:
                continue  # outlet has no dishes today — drop it entirely
            result.append({
                # Some kitchen slugs already carry a "uzh-" prefix
                # (uzh-binzmuehle, uzh-cityport, uzh-botanischergarten).
                "id": "uzh-" + slug.removeprefix("uzh-"),
                "name": name,
                "group": group,
                "meals": {"Lunch": dishes, "Dinner": []},
            })
    return result


def uzh_dishes_from_list(today_offer):
    """Build dishes from the list API (no nutrition available).

    Recipe titles can be empty (Botanischer Garten publishes only display
    names) — fall back to the displayName so the outlet is not dropped.
    """
    dishes = []
    for offer in today_offer:
        for item in offer.get("digitalMenuItems") or []:
            recipe = item.get("recipe") or {}
            title = (recipe.get("title") or {}).get("de") or ""
            name = (title or item.get("displayName") or "").strip()
            if not name:
                continue
            dishes.append({
                "line": "",
                "dish": name,
                "desc": "",
                "nutrition": {"p100": {}, "total": {}},
            })
    return dishes


def scrape_uzh_weekly(slug):
    """Scrape today's dishes + nutrition from the Food2050 weekly page.

    Returns a list of dishes, or None if the weekly page is unavailable
    (caller then falls back to the list API).
    """
    url = UZH_WEEKLY_URLS.get(slug)
    if not url:
        return None

    html = http_get(url)
    m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html)
    if not m:
        return None
    try:
        data = json.loads(m.group(1))
        outlet = data["props"]["pageProps"]["organisation"]["outlet"]
        calendar = (outlet.get("menuCategory") or {}).get("calendar")
        if calendar is None:
            calendar = outlet.get("calendar")  # some outlets render it at outlet level
        daily = calendar["week"]["daily"]
    except (KeyError, ValueError, TypeError):
        return None

    items = []
    for day in daily:
        for item in day.get("menuItems", []):
            if item.get("detailUrl", "").endswith(TODAY):
                items.append(item)
    if not items:
        return []  # page loaded, but nothing is served today

    dishes = []
    for item in items:
        dish_name = (item.get("dish") or {}).get("name", "")
        if not dish_name:
            continue
        dishes.append({
            "line": (item.get("category") or {}).get("name", ""),
            "dish": dish_name,
            "desc": "",
            "nutrition": scrape_uzh_stats(item.get("detailUrl")),
        })
    return dishes


def scrape_uzh_stats(detail_url):
    """Fetch one Food2050 dish page and extract per-100g + per-serving stats."""
    html = http_get(detail_url)
    m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html)
    if not m:
        return {"p100": {}, "total": {}}
    try:
        data = json.loads(m.group(1))
        stats = data["props"]["pageProps"]["organisation"]["outlet"]["menuCategory"]["menuItem"]["dish"]["stats"]
    except (KeyError, ValueError, TypeError):
        return {"p100": {}, "total": {}}

    p100, total = {}, {}
    for key, label in UZH_NUTRIENT_MAP.items():
        v = stats.get(key)
        if not isinstance(v, dict):
            continue
        per100 = _num(v.get("amountPer100g"))
        if per100 is not None:
            p100[label] = round(per100, 1)
        amount = _keep_number(v.get("amount"))
        if amount is not None:
            total[label] = amount

    # servingWeight belongs to total only (contract: weight never in p100)
    sw = stats.get("servingWeight")
    if isinstance(sw, dict):
        weight = _keep_number(sw.get("amount"))
        if weight is not None:
            total["weight"] = weight

    return {"p100": p100, "total": total}


# --------------------------------------------------------------------------
# Plain-text dump (raw data for AI consumption)
# --------------------------------------------------------------------------

def format_nutrition(nutr):
    """One nutrition segment, e.g. 'kcal=152.0, protein=5.3g' ('' when empty)."""
    parts = []
    for key in NUTRITION_KEYS:
        v = nutr.get(key)
        if v:
            unit = "" if key == "kcal" else "g"
            parts.append(f"{key}={v}{unit}")
    return ", ".join(parts)


def render_txt(mensas):
    """One physical line per dish: NAME/SLOT: line — dish: desc | per100g: … | total: …"""
    lines = [f"ETH/UZH Mensa Menus — {TODAY}", "=" * 60, ""]
    for m in mensas:
        for slot in ("Lunch", "Dinner"):
            for d in m["meals"][slot]:
                segs = []
                p100 = format_nutrition(d["nutrition"].get("p100", {}))
                if p100:
                    segs.append(f"per100g: {p100}")
                total = format_nutrition(d["nutrition"].get("total", {}))
                if total:
                    segs.append(f"total: {total}")
                nutr_str = " | ".join(segs) if segs else "nutrition=N/A"
                # Collapse embedded whitespace/newlines (ETH descriptions
                # contain them) so index.txt stays one physical line per dish.
                body = " ".join(f'{d["line"]} — {d["dish"]}: {d["desc"]}'.split())
                lines.append(f'{m["name"]}/{slot}: {body} | {nutr_str}')
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------
# Assemble output
# --------------------------------------------------------------------------

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    eth = fetch_eth()
    uzh = fetch_uzh()
    mensas = eth + uzh

    payload = {"date": TODAY, "mensas": mensas}
    with open(os.path.join(OUTPUT_DIR, "data.json"), "w") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)

    txt = render_txt(mensas)
    with open(os.path.join(OUTPUT_DIR, "index.txt"), "w") as f:
        f.write(txt)

    # Assemble static site from template/. Cache-busting version: git short
    # hash (falls back to a timestamp) — forces browsers to fetch fresh
    # style.css/app.js on every deploy instead of serving stale caches.
    try:
        rev = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, timeout=5,
        ).stdout.strip() or datetime.now().strftime("%Y%m%d%H%M")
    except Exception:
        rev = datetime.now().strftime("%Y%m%d%H%M")

    with open(os.path.join(TEMPLATE_DIR, "index.html")) as f:
        html = (f.read()
                .replace("DATE_PLACEHOLDER", TODAY)
                .replace("VER_PLACEHOLDER", rev))
    with open(os.path.join(OUTPUT_DIR, "index.html"), "w") as f:
        f.write(html)

    with open(os.path.join(TEMPLATE_DIR, "style.css")) as f:
        css = f.read()
    with open(os.path.join(OUTPUT_DIR, "style.css"), "w") as f:
        f.write(css)

    with open(os.path.join(TEMPLATE_DIR, "app.js")) as f:
        js = f.read().replace("DATE_PLACEHOLDER", TODAY)
    with open(os.path.join(OUTPUT_DIR, "app.js"), "w") as f:
        f.write(js)

    n = sum(len(m["meals"]["Lunch"]) + len(m["meals"]["Dinner"]) for m in mensas)
    print(f"Done — {len(mensas)} mensas, {n} dishes")


if __name__ == "__main__":
    main()
