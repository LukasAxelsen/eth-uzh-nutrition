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


def _current_date():
    """Zurich-local today (used to decide whether todayOffer fallback applies)."""
    return datetime.now(timezone(timedelta(hours=2))).date().isoformat()

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
    8: ("Archimedes", "Central"),
    9: ("Mensa Polyterrasse", "Central"),
    10: ("Polysnack", "Central"),
    11: ("Tannenbar", "Central"),
    12: ("Eureka Take Away", "Central"),
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
    "2f761b0c-5a03-43dc-8cdc-378df8536d01": ("Other", {
        "uzh-cityport": "Cityport Mensa",
    }),
    "0663eb48-5f4d-4ca0-bdd7-238257009003": ("Other", {
        "tierspital": "Tierspital Mensa",
    }),
    "5bbfd257-fb0a-48c2-a406-891fa647da45": ("Other", {
        "uzh-botanischergarten": "Botanischer Garten",
    }),
}

# Outlets with a public Food2050 weekly page (used for nutrition scraping).
# NOTE: web slugs/paths differ from the GraphQL API slugs (e.g. API
# "green-kitchen" -> web "green-kitchen-lab", API "uzh-cityport" -> web
# "cityport/cityport"). Each entry was verified against the outlet page's
# own /menu/weekly links.
UZH_WEEKLY_URLS = {
    "untere-mensa": "https://app.food2050.ch/de/v2/zfv/universitat-zurich,campus-zentrum/untere-mensa/mittagsverpflegung/menu/weekly",
    "obere-mensa": "https://app.food2050.ch/de/v2/zfv/universitat-zurich,campus-zentrum/obere-mensa/mittagsverpflegung/menu/weekly",
    "lichthof": "https://app.food2050.ch/de/v2/zfv/universitat-zurich,campus-zentrum/lichthof/mittagsverpflegung/menu/weekly",
    "mensa": "https://app.food2050.ch/de/v2/zfv/universitat-zurich,campus-irchel/mensa/mittagsverpflegung/menu/weekly",
    "green-kitchen": "https://app.food2050.ch/de/v2/zfv/universitat-zurich,campus-irchel/green-kitchen-lab/mittagsverpflegung/menu/weekly",
    "seerose": "https://app.food2050.ch/de/v2/zfv/universitat-zurich,campus-irchel/seerose/mittag/menu/weekly",
    "uzh-binzmuehle": "https://app.food2050.ch/de/v2/zfv/universitat-zurich,campus-oerlikon/mensa-binzmuhle/mittagsverpflegung/menu/weekly",
    "uzh-cityport": "https://app.food2050.ch/de/v2/zfv/universitat-zurich,cityport/cityport/mittagsverpflegung/menu/weekly",
    "tierspital": "https://app.food2050.ch/de/v2/zfv/universitat-zurich,tierspital-1/tierspital/mittagsverpflegung/menu/weekly",
    "uzh-botanischergarten": "https://app.food2050.ch/de/v2/zfv/universitat-zurich,botanischer-garten/botanischer-garten/mittagsverpflegung/menu/weekly",
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


# --------------------------------------------------------------------------
# Text normalization (name/desc formatting sync)
#
# Sources disagree wildly: UZH dishes are ALL-CAPS blobs ("HUMMUS BOWL,
# Ofengemüse, Süsskartoffeln"), ETH sometimes stores names in caps too
# (Flavour Kitchen, some Abend entries), separators vary (' | ', ', ', '/'),
# and line names are lowercase slugs ('farm') or brand caps ('STREET').
# These helpers normalize everything to the Polyterrasse-lunch style:
#   line — Dish | Ingredient | Ingredient …
# --------------------------------------------------------------------------

# Words kept lowercase when title-casing ALL-CAPS names (de/en/fr/it).
TITLE_CASE_STOPWORDS = {
    "mit", "und", "of", "and", "the", "a", "an", "de", "la", "le", "les",
    "en", "au", "aux", "du", "des", "in", "im", "auf", "aus", "für", "fuer",
    "bei", "von", "zum", "zur", "am", "zu", "an", "da", "del", "di", "della",
    "on", "at", "&",
}

# Category words that sometimes leak into UZH dish names ("FARM SHAKSHUKA").
UZH_NAME_PREFIXES = ("FARM ", "BUTCHER ", "GARDEN ", "VEGAN ")


def clean_text(s):
    """Strip and collapse internal whitespace ('a  |  b' -> 'a | b')."""
    return " ".join(str(s or "").split())


def title_case(s):
    """Title-case an ALL-CAPS name: 'HUMMUS BOWL' -> 'Hummus Bowl'."""
    words = []
    for w in s.split():
        low = w.lower()
        if low in TITLE_CASE_STOPWORDS:
            words.append(low)
        else:
            words.append(w[0].upper() + w[1:].lower())
    return " ".join(words)


def clean_dish_name(name):
    """Trim a dish name and de-CAPSIFY it when the source is all caps."""
    name = clean_text(name)
    if name.isupper():
        name = title_case(name)
    return name


def title_slug(line):
    """Line names: title-case lowercase slugs ('farm' -> 'Farm'); keep brand caps."""
    line = clean_text(line)
    if line.islower():
        return title_case(line)
    return line


def normalize_desc(desc):
    """Unify ingredient lists to ' | ' separators regardless of source style
    (ETH pipes, UZH commas, Tannenbar slashes)."""
    desc = clean_text(desc)
    if not desc:
        return ""
    chunks = []
    for part in re.split(r"[,/|]", desc):
        part = part.strip()
        if part:
            chunks.append(part)
    return " | ".join(chunks)


def split_uzh_name(name):
    """Split a UZH blob into (head, rest): 'HUMMUS BOWL, Ofengemüse, ...'
    -> ('HUMMUS BOWL', 'Ofengemüse, ...'). No comma -> (name, '')."""
    if "," in name:
        head, rest = name.split(",", 1)
        return head.strip(), rest.strip()
    return name.strip(), ""


def strip_uzh_prefix(head):
    """Drop a category word that leaked into the name ('FARM SHAKSHUKA' -> 'SHAKSHUKA')."""
    upper = head.upper()
    for p in UZH_NAME_PREFIXES:
        if upper.startswith(p) and len(upper) > len(p) + 1:
            return head[len(p):].strip()
    return head


def build_uzh_dish(name, line) -> dict:
    """One UZH dish with the name/desc split + normalized casing."""
    head, rest = split_uzh_name(name)
    head = strip_uzh_prefix(head)
    return {
        "line": title_slug(line),
        "dish": clean_dish_name(head),
        "desc": normalize_desc(rest),
    }


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

        # ETH occasionally packs "Main dish | Side" into meal-name — fold
        # the side part into the desc so the dish name stays clean.
        name_parts = [p for p in m["meal-name"].split("|")]
        extra = " | ".join(p.strip() for p in name_parts[1:])
        raw_desc = m.get("description", "")
        if extra:
            raw_desc = f"{extra} | {raw_desc}"

        dish = {
            "line": title_slug(m.get("line-name", "")),
            "dish": clean_dish_name(name_parts[0]),
            "desc": normalize_desc(raw_desc),
            # ETH image URLs require the client-id query param — without
            # it the API returns an error text, not the JPEG.
            "photo": (m.get("image-url") or "").rstrip("/") + "?client-id=ethz-wcms" if m.get("image-url") else "",
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
        # Keep every configured facility even when it has no dishes today
        # (weekends, holidays) so the frontend renders it with its
        # "no meals" notice instead of silently disappearing.
        meals_by_slot = per_facility.get(fid, {"Lunch": [], "Dinner": []})
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
    """Return list of {id, name, group, meals} for all UZH Food2050 outlets.

    Every configured outlet is always included, even with empty meals
    (weekends, holidays, API hiccups) so the frontend renders it with
    its "no meals" notice instead of dropping it silently.
    """
    is_today = TODAY == _current_date()
    result = []
    for loc_id, (group, slug_names) in UZH_LOCATIONS.items():
        # The GraphQL list API is only needed for the current day's
        # todayOffer fallback; future dates are served purely via the
        # weekly-page category templates, so skip the POST entirely.
        by_slug = {}
        if is_today:
            body = json.dumps({
                "query": FOOD2050_QUERY,
                "variables": {"locationId": loc_id},
                "operationName": "ExampleQuery",
            })
            data = http_post("https://api.app.food2050.ch/", body)
            kitchens = (data.get("data") or {}).get("location") or {}
            by_slug = {k.get("slug"): k for k in kitchens.get("kitchens") or []}

        for slug, name in slug_names.items():
            dishes = []
            # Weekly page for the current week; future dates via
            # category templates (see scrape_uzh_date).
            dishes = scrape_uzh_date(slug, TODAY)
            # Fall back to the list API ONLY for the current day —
            # for other dates the todayOffer is that day's data and
            # would be wrong (it never applies to future dates).
            if not dishes and is_today:
                kitchen = by_slug.get(slug)
                if kitchen is not None:
                    dishes = uzh_dishes_from_list(kitchen.get("todayOffer") or [])

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
            name = title or item.get("displayName") or ""
            if not clean_text(name):
                continue
            d = build_uzh_dish(name, "")
            d["photo"] = ""
            d["nutrition"] = {"p100": {}, "total": {}}
            dishes.append(d)
    return dishes


def scrape_uzh_weekly(slug):
    """Scrape today's dishes + nutrition from the Food2050 weekly page.

    Returns a list of dishes, or None if the weekly page is unavailable
    (caller then falls back to the list API).
    """
    wk = _load_uzh_weekly(slug)
    if wk is None:
        return None
    items = wk.get(TODAY) or []
    if not items:
        return []  # page loaded, but nothing is served today

    dishes = []
    for item in items:
        dish_name = (item.get("dish") or {}).get("name", "")
        if not clean_text(dish_name):
            continue
        d = build_uzh_dish(dish_name, (item.get("category") or {}).get("name", ""))
        detail = scrape_uzh_detail(item.get("detailUrl"))
        d["photo"] = detail["photo"]
        d["nutrition"] = detail["nutrition"]
        dishes.append(d)
    return dishes


# Weekly page parsed once per slug: {date: [menuItems]} plus the
# category path segments found in the week's detailUrls (used to build
# detail URLs for future dates). Cached across the multi-day loop.
_weekly_cache = {}


def _load_uzh_weekly(slug):
    """Parse the weekly page once per slug.

    Returns {date: [menuItems]} (date = YYYY-MM-DD) plus a parallel
    structure of detailUrl templates, or None on failure.
    """
    if slug in _weekly_cache:
        return _weekly_cache[slug]
    url = UZH_WEEKLY_URLS.get(slug)
    if not url:
        _weekly_cache[slug] = None
        return None

    html = http_get(url)
    m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html)
    if not m:
        _weekly_cache[slug] = None
        return None
    try:
        data = json.loads(m.group(1))
        outlet = data["props"]["pageProps"]["organisation"]["outlet"]
        calendar = (outlet.get("menuCategory") or {}).get("calendar")
        if calendar is None:
            calendar = outlet.get("calendar")  # some outlets render it at outlet level
        daily = calendar["week"]["daily"]
    except (KeyError, ValueError, TypeError):
        _weekly_cache[slug] = None
        return None

    by_date = {}
    for day in daily:
        frm = (day.get("from") or {}).get("dateLocal", "")
        day_date = frm[:10] if frm else ""
        if not day_date:
            continue
        by_date[day_date] = day.get("menuItems", [])
    _weekly_cache[slug] = by_date
    return by_date


def _uzh_category_templates(slug):
    """Category path segments seen in the current week's detailUrls.

    Detail URLs look like .../mittagsverpflegung,unten,{category}/{date};
    replacing the date segment yields a valid URL for ANY date, because
    the detail page resolves dishes by the date in its path. Categories
    seen this week are the ones that exist for the outlet.
    """
    by_date = _load_uzh_weekly(slug) or {}
    cats = set()
    for items in by_date.values():
        for item in items:
            u = item.get("detailUrl", "")
            # .../mittagsverpflegung,unten,{cat}/YYYY-MM-DD (and the
            # seerose variant .../mittag,{cat}/YYYY-MM-DD). The last
            # comma-separated path segment before the date is always
            # the category slug.
            m = re.search(r"([^/,]+)/\d{4}-\d{2}-\d{2}$", u)
            if m:
                cats.add(m.group(1))
    return sorted(cats)


def scrape_uzh_date(slug, date):
    """Dishes + nutrition for an arbitrary calendar date.

    The weekly page only serves the current week: dates inside it are
    read from its own menuItems; other dates (future) reuse the week's
    category templates with the date substituted in the detail URL —
    the detail page resolves by path date, so this works for any date
    the source publishes.
    """
    by_date = _load_uzh_weekly(slug)
    if by_date is None:
        return []
    items = by_date.get(date)
    if items is not None:
        # Date is inside the served week — use its own items.
        dishes = []
        for item in items:
            dish_name = (item.get("dish") or {}).get("name", "")
            if not clean_text(dish_name):
                continue
            d = build_uzh_dish(dish_name, (item.get("category") or {}).get("name", ""))
            detail = scrape_uzh_detail(item.get("detailUrl"))
            d["photo"] = detail["photo"]
            d["nutrition"] = detail["nutrition"]
            dishes.append(d)
        return dishes

    # Future date: build detail URLs from the category templates.
    # The weekly page only covers the current week; categories seen in
    # its detailUrls are the outlet's lines, and the detail page
    # resolves by path date — so substituting the date works for any
    # future date the source publishes.
    dishes = []
    for cat in _uzh_category_templates(slug):
        # Base = any detailUrl of this category with the date stripped:
        # .../mittagsverpflegung,unten,{cat}/YYYY-MM-DD
        base = next(
            (u.rsplit("/", 1)[0] for items0 in by_date.values() for u in
             (i.get("detailUrl", "") for i in items0)
             if re.search(rf"{re.escape(cat)}/\d{{4}}-\d{{2}}-\d{{2}}$", u)),
            None,
        )
        if not base:
            continue
        d = build_uzh_dish_from_detail(f"{base}/{date}")
        if d is not None:
            dishes.append(d)
    return dishes


def build_uzh_dish_from_detail(detail_url):
    """Build a dish from a detail page alone (name + nutrition + photo).

    Returns None when the detail page has no dish for that URL/date.
    """
    html = http_get(detail_url)
    m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html)
    if not m:
        return None
    try:
        data = json.loads(m.group(1))
        outlet = data["props"]["pageProps"]["organisation"]["outlet"]
        menu_item = (outlet.get("menuCategory") or {}).get("menuItem") or {}
        dish = menu_item.get("dish") or {}
    except (KeyError, ValueError, TypeError):
        return None
    dish_name = dish.get("name", "")
    if not clean_text(dish_name):
        return None
    # The detail page's menuItem carries no category field — the
    # category slug lives in the URL path (.../mittagsverpflegung,unten,
    # {cat}/{date}, seerose: .../mittag,{cat}/{date}). Recover it from
    # the last path segment before the date, restoring hyphens that
    # stand in for spaces ("voll-anders" -> "voll anders").
    category = (menu_item.get("category") or {}).get("name", "")
    if not category:
        m = re.search(r"([^/,]+)/\d{4}-\d{2}-\d{2}$", detail_url)
        if m:
            category = m.group(1).replace("-", " ")
    d = build_uzh_dish(dish_name, category)
    d["photo"] = clean_text(dish.get("imageUrl"))
    stats = dish.get("stats") or {}
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
    sw = stats.get("servingWeight")
    if isinstance(sw, dict):
        weight = _keep_number(sw.get("amount"))
        if weight is not None:
            total["weight"] = weight
    d["nutrition"] = {"p100": p100, "total": total}
    return d


def scrape_uzh_detail(detail_url):
    """Fetch one Food2050 dish page: nutrition stats + dish photo.

    Returns {"nutrition": {"p100": …, "total": …}, "photo": url-or-""}.
    """
    html = http_get(detail_url)
    m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html)
    if not m:
        return {"nutrition": {"p100": {}, "total": {}}, "photo": ""}
    try:
        data = json.loads(m.group(1))
        dish = data["props"]["pageProps"]["organisation"]["outlet"]["menuCategory"]["menuItem"]["dish"]
        stats = dish["stats"]
    except (KeyError, ValueError, TypeError):
        return {"nutrition": {"p100": {}, "total": {}}, "photo": ""}

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

    return {
        "nutrition": {"p100": p100, "total": total},
        "photo": clean_text(dish.get("imageUrl")),
    }


# --------------------------------------------------------------------------
# Plain-text dump (raw data for AI consumption)
# --------------------------------------------------------------------------

def _fmt_num(v):
    """Render a number the way JS String(n) does: whole floats lose the
    trailing '.0' (18.0 -> '18', 0.58 -> '0.58'). Keeps index.txt byte-
    identical with the frontend copy button (JSON round-trip drops .0)."""
    if isinstance(v, int):
        return str(v)
    s = str(v)
    return s.rstrip("0").rstrip(".") if "." in s else s


def format_nutrition(nutr):
    """One nutrition segment, e.g. 'kcal=152, protein=5.3g' ('' when empty)."""
    parts = []
    for key in NUTRITION_KEYS:
        v = nutr.get(key)
        if v:
            unit = "" if key == "kcal" else "g"
            parts.append(f"{key}={_fmt_num(v)}{unit}")
    return ", ".join(parts)


def dish_body(line, dish, desc):
    """'line — dish | desc' with empty segments and line==dish duplicates dropped."""
    line = clean_text(line)
    dish = clean_text(dish)
    if line and line.lower() != dish.lower():
        head = f"{line} — {dish}"
    else:
        head = dish
    if desc:
        return f"{head} | {desc}"
    return head


def render_txt(mensas):
    """One physical line per dish: NAME/SLOT: line — dish | desc | per100g: … | total: …"""
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
                body = " ".join(dish_body(d["line"], d["dish"], d["desc"]).split())
                lines.append(f'{m["name"]}/{slot}: {body} | {nutr_str}')
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------
# Assemble output
# --------------------------------------------------------------------------

def main():
    global TODAY  # the multi-date loop swaps the module-level date
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # Calendar data window: today + the next 14 calendar days. Weekends
    # and days without source data are included as empty-day entries so
    # the calendar can mark them unavailable; the frontend only enables
    # dates that actually carry data.
    today_dt = datetime.strptime(TODAY, "%Y-%m-%d").date()
    date_window = [TODAY] + [
        (today_dt + timedelta(days=i)).isoformat()
        for i in range(1, 15)
    ]

    days = {}
    for d in date_window:
        # ETH: one call returns all facilities for the date.
        # UZH: weekly page only serves the CURRENT week, so detail URLs
        # (category + date path segments) are derived from the weekly
        # page's own links and the date is substituted per day.
        # (single-threaded, sequential loop, so swapping TODAY is safe)
        TODAY = d
        eth = fetch_eth()
        uzh = fetch_uzh()
        days[d] = {"mensas": eth + uzh}

    # Restore for the plain-text render (index.txt is always "today").
    TODAY = date_window[0]

    payload = {
        "date": TODAY,
        "days": days,
        "availableDates": sorted(days.keys()),
    }
    with open(os.path.join(OUTPUT_DIR, "data.json"), "w") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)

    txt = render_txt(days[TODAY]["mensas"])
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

    n = sum(len(m["meals"]["Lunch"]) + len(m["meals"]["Dinner"]) for m in days[TODAY]["mensas"])
    total = sum(
        len(mm["meals"]["Lunch"]) + len(mm["meals"]["Dinner"])
        for day in days.values() for mm in day["mensas"]
    )
    print(f"Done — {len(days[TODAY]['mensas'])} mensas today ({n} dishes); "
          f"{len(days)} dates, {total} dishes total")


if __name__ == "__main__":
    main()
