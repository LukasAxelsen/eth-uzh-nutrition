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
import sys
import time
from datetime import timezone, timedelta, datetime

# Pause between rapid sequential requests to Food2050 (app.food2050.ch).
# Without it, the batch scraper trips rate limiting and weekly/detail pages
# come back empty, leaving outlets with list-API fallback dishes (no nutrition).
SCRAPE_DELAY = 0.4  # seconds

# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------

TODAY = datetime.now(timezone(timedelta(hours=2))).date().isoformat()

OUTPUT_DIR = "output"
BASE = os.path.dirname(os.path.abspath(__file__))
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

# ETH meal-time names -> Lunch/Dinner
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

UZH_NUTRIENT_MAP = {
    "energy": ("kcal", ""), "protein": ("protein", "g"), "fat": ("fat", "g"),
    "carbohydrates": ("carbs", "g"), "sugar": ("sugar", "g"),
    "salt": ("salt", "g"), "fibers": ("fiber", "g"),
}


def http_get(url, timeout=30):
    """GET a URL and return body text (with UA header + one retry)."""
    cmd = ["curl", "-s", "-A", "Mozilla/5.0 (compatible; eth-uzh-nutrition/1.0)", url]
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


def http_post(url, body, headers=None, timeout=30):
    """POST a JSON body and return parsed JSON."""
    cmd = ["curl", "-s", "-X", "POST", url,
           "-A", "Mozilla/5.0 (compatible; eth-uzh-nutrition/1.0)",
           "-H", "Content-Type: application/json"]
    for k, v in (headers or {}).items():
        cmd += ["-H", f"{k}: {v}"]
    cmd += ["-d", body]
    for attempt in range(2):
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
            if result.stdout:
                return json.loads(result.stdout)
        except Exception:
            pass
    return {}


# --------------------------------------------------------------------------
# ETH
# --------------------------------------------------------------------------

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
    mt_map = {mt["meal-time-id"]: (mt["facility-id"], mt["meal-time-name"]) for mt in meal_times}

    # facility-id -> {Lunch: [dishes], Dinner: [dishes]}
    per_facility = {}
    for m in meals:
        mt_id = m.get("meal-time-id")
        if mt_id not in mt_map:
            continue
        fid, mt_name = mt_map[mt_id]
        if fid not in ETH_FACILITIES:
            continue

        dish = {
            "line": m["line-name"],
            "dish": m["meal-name"],
            "desc": m.get("description", ""),
            "nutrition": {},
        }
        nutr = {}
        for nk, nl in zip(ETH_NUTRIENT_KEYS, ETH_NUTRIENT_LABELS):
            v = m.get(nk, "")
            if v and float(v) != 0:
                val = float(v)
                if nl == "kcal":
                    # ETH API reports energy in kJ — convert to kcal
                    val = round(val / 4.184, 1)
                nutr[nl] = val
        dish["nutrition"]["p100"] = nutr
        dish["nutrition"]["total"] = {}

        meal_slot = "Dinner" if any(t in mt_name for t in ETH_DINNER_NAMES) else "Lunch"
        per_facility.setdefault(fid, {"Lunch": [], "Dinner": []})[meal_slot].append(dish)

    result = []
    for fid, (name, group) in ETH_FACILITIES.items():
        meals_by_slot = per_facility.get(fid)
        if not meals_by_slot:
            continue
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
                continue
            result.append({
                "id": f"uzh-{slug}",
                "name": name,
                "group": group,
                "meals": {"Lunch": dishes, "Dinner": []},
            })
    return result


def uzh_dishes_from_list(today_offer):
    """Build dishes from the list API (no nutrition available)."""
    dishes = []
    for offer in today_offer:
        for item in offer.get("digitalMenuItems") or []:
            recipe = item.get("recipe") or {}
            title = (recipe.get("title") or {}).get("de") or ""
            if not title:
                continue
            dishes.append({
                "line": "",
                "dish": title,
                "desc": "",
                "nutrition": {"p100": {}, "total": {}},
            })
    return dishes


def scrape_uzh_weekly(slug):
    """Scrape today's dishes + nutrition from the Food2050 weekly page.
    Returns a list of dishes, or None if the weekly page is unavailable."""
    url = UZH_WEEKLY_URLS.get(slug)
    if not url:
        return None

    time.sleep(SCRAPE_DELAY)  # pace consecutive weekly-page scrapes (rate limiting)
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
        return []

    dishes = []
    for item in items:
        detail_url = item.get("detailUrl")
        cat = item.get("category", {}).get("name", "")
        dish_name = item.get("dish", {}).get("name", "")
        if not dish_name:
            continue
        time.sleep(SCRAPE_DELAY)  # pace per-dish detail-page scrapes (rate limiting)
        stats = scrape_uzh_stats(detail_url)
        dishes.append({
            "line": cat,
            "dish": dish_name,
            "desc": "",
            "nutrition": stats,
        })
    return dishes


def scrape_uzh_stats(detail_url):
    """Fetch one Food2050 dish page and extract nutrition stats."""
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
    for key, (label, unit) in UZH_NUTRIENT_MAP.items():
        v = stats.get(key)
        if not isinstance(v, dict):
            continue
        if v.get("amountPer100g") is not None and float(v["amountPer100g"]) != 0:
            p100[label] = round(float(v["amountPer100g"]), 1)
        if v.get("amount") is not None and float(v["amount"]) != 0:
            total[label] = v["amount"]

    tw = stats.get("servingWeight")
    if isinstance(tw, dict) and tw.get("amount"):
        total["weight"] = tw["amount"]

    return {"p100": p100, "total": total}


# --------------------------------------------------------------------------
# Plain-text dump (raw data for AI consumption)
# --------------------------------------------------------------------------

def format_nutrition(nutr):
    parts = []
    for key in NUTRITION_KEYS:
        v = nutr.get(key)
        if v:
            unit = "" if key == "kcal" else "g"
            parts.append(f"{key}={v}{unit}")
    return ", ".join(parts)


def render_txt(mensas):
    lines = [f"ETH/UZH Mensa Menus — {TODAY}", "=" * 60, ""]
    for m in mensas:
        for slot in ("Lunch", "Dinner"):
            if not m["meals"][slot]:
                continue
            for d in m["meals"][slot]:
                nutr = format_nutrition(d["nutrition"].get("p100", {}))
                segs = [f"per100g: {nutr}"] if nutr else []
                tot = format_nutrition(d["nutrition"].get("total", {}))
                if tot:
                    segs.append(f"total: {tot}")
                nutr_str = " | ".join(segs) if segs else "nutrition=N/A"
                # Collapse embedded newlines (ETH descriptions contain them)
                # so index.txt stays one physical line per dish.
                body = " ".join(f'{d["line"]} — {d["dish"]}: {d["desc"]}'.split())
                lines.append(f'{m["name"]}/{slot}: {body} | {nutr_str}')
        # closed mensa with no meals at all
        if not m["meals"]["Lunch"] and not m["meals"]["Dinner"]:
            lines.append(f'{m["name"]}: no meals today (closed or on break)')
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

    # Assemble static site from template/
    with open(os.path.join(TEMPLATE_DIR, "index.html")) as f:
        html = f.read().replace("DATE_PLACEHOLDER", TODAY)
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
