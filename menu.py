#!/usr/bin/env python3
"""Fetch ETH/UZH daily menus with full nutritional data."""
import json, re, subprocess, os, sys
from datetime import timezone, timedelta, datetime
zurich = timezone(timedelta(hours=2))
today = datetime.now(zurich).date().isoformat()

OUTPUT_DIR = "output"
os.makedirs(OUTPUT_DIR, exist_ok=True)

lines = []
lines.append(f"ETH/UZH Mensa Menus — {today}")
lines.append("=" * 60)
lines.append("")

# =====================================================================
# ETH Mensas (Cookpit REST API)
# =====================================================================
ETH_URL = (
    f"https://idapps.ethz.ch/cookpit-pub-services/v1/meals"
    f"?client-id=ethz-wcms&lang=de&date={today}&facility-id=9"
    f"&meal-times-after={today}T10:00:00Z&meal-times-before={today}T22:00:00Z"
)

FACILITY_NAMES = {9: "ETH Mensa Polyterrasse", 3: "ETH Mensa Clausiusbar", 8: "ETH Mensa Archimedes"}
TARGETS = {9, 3, 8}
NUTRIENT_KEYS = ["energy","protein","fat","saturated-fatty-acids","carbohydrates","sugar","salt"]
NUTRIENT_LABELS = ["kcal","protein","fat","saturated","carbs","sugar","salt"]

try:
    result = subprocess.run(["curl", "-s", ETH_URL], capture_output=True, text=True, timeout=30)
    data = json.loads(result.stdout)
    meals = data.get("meals", [])
    meal_times = data.get("meal-times", [])

    mt_map = {}
    for mt in meal_times:
        mt_map[mt["meal-time-id"]] = (mt["facility-id"], mt["meal-time-name"])

    for fid in sorted(TARGETS):
        found = False
        for m in meals:
            mt_id = m.get("meal-time-id")
            if mt_id not in mt_map:
                continue
            mt_fid, mt_name = mt_map[mt_id]
            if mt_fid != fid:
                continue

            line_name = m["line-name"]
            dish = m["meal-name"]
            desc = m.get("description", "")

            nutr_parts = []
            for nk, nl in zip(NUTRIENT_KEYS, NUTRIENT_LABELS):
                v = m.get(nk, "")
                if v and float(v) != 0:
                    unit = "g" if nl != "kcal" else ""
                    nutr_parts.append(f"{nl}={v}{unit}")
            nutr_str = ", ".join(nutr_parts)

            if nutr_str:
                lines.append(f"{FACILITY_NAMES[fid]}/{mt_name}: {line_name} — {dish}: {desc} | per100g: {nutr_str}")
                found = True
        if not found:
            lines.append(f"{FACILITY_NAMES[fid]}: no meals today (closed or on break)")
except Exception as e:
    lines.append(f"ETH Mensas: fetch error — {e}")

lines.append("")

# =====================================================================
# UZH Obere Mensa (Food2050 scraping)
# =====================================================================
try:
    weekly_url = "https://app.food2050.ch/de/v2/zfv/universitat-zurich,campus-zentrum/obere-mensa/mittagsverpflegung/menu/weekly"
    result = subprocess.run(["curl", "-s", weekly_url], capture_output=True, text=True, timeout=30)
    html = result.stdout

    m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html)
    if not m:
        lines.append("UZH Obere Mensa: could not parse weekly overview")
    else:
        data = json.loads(m.group(1))
        daily = data["props"]["pageProps"]["organisation"]["outlet"]["menuCategory"]["calendar"]["week"]["daily"]

        all_items = []
        for day in daily:
            all_items.extend(day.get("menuItems", []))
        today_items = [item for item in all_items if item.get("detailUrl", "").endswith(today)]

        if not today_items:
            lines.append("UZH Obere Mensa: no dishes for today (possibly closed)")
        else:
            for item in today_items:
                url = item["detailUrl"]
                cat = item.get("category", {}).get("name", "?")
                dish_name = item.get("dish", {}).get("name", "?")

                result2 = subprocess.run(["curl", "-s", url], capture_output=True, text=True, timeout=30)
                dish_html = result2.stdout
                m2 = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', dish_html)

                if not m2:
                    lines.append(f"UZH Obere Mensa/Mittag: {cat} — {dish_name} | nutrition=N/A")
                    continue

                dish_data = json.loads(m2.group(1))
                menu_item = dish_data["props"]["pageProps"]["organisation"]["outlet"]["menuCategory"].get("menuItem", {})
                stats = menu_item.get("dish", {}).get("stats", {})

                if not stats:
                    lines.append(f"UZH Obere Mensa/Mittag: {cat} — {dish_name} | nutrition=N/A")
                    continue

                nutr_map = {
                    "energy": ("kcal", ""), "protein": ("protein", "g"), "fat": ("fat", "g"),
                    "carbohydrates": ("carbs", "g"), "sugar": ("sugar", "g"),
                    "salt": ("salt", "g"), "fibers": ("fiber", "g"),
                }
                p100_parts = []
                tot_parts = []
                for key, (label, unit) in nutr_map.items():
                    v = stats.get(key, {})
                    if not isinstance(v, dict):
                        continue
                    p100 = v.get("amountPer100g")
                    amt = v.get("amount")
                    if p100 is not None and float(p100) != 0:
                        p100_parts.append(f"{label}={round(float(p100), 1)}{unit}")
                    if amt is not None and float(amt) != 0:
                        tot_parts.append(f"{label}={amt}{unit}")

                tw = stats.get("servingWeight", {})
                if isinstance(tw, dict) and tw.get("amount"):
                    tot_parts.append(f"weight={tw['amount']}{tw.get('unit', 'g')}")

                sections = []
                if p100_parts:
                    sections.append("per100g: " + ", ".join(p100_parts))
                if tot_parts:
                    sections.append("total: " + ", ".join(tot_parts))
                nutr_str = " | ".join(sections) if sections else "nutrition=N/A"
                lines.append(f"UZH Obere Mensa/Mittag: {cat} — {dish_name} | {nutr_str}")
except Exception as e:
    lines.append(f"UZH Obere Mensa: fetch error — {e}")

# =====================================================================
# Write output
# =====================================================================
text = "\n".join(lines) + "\n"

# Plain text version
with open(os.path.join(OUTPUT_DIR, "index.txt"), "w") as f:
    f.write(text)

# Assemble static site: copy template files, inject date into index.html
BASE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE_DIR = os.path.join(BASE, "template")

with open(os.path.join(TEMPLATE_DIR, "index.html")) as f:
    html_content = f.read().replace("DATE_PLACEHOLDER", today)
with open(os.path.join(OUTPUT_DIR, "index.html"), "w") as f:
    f.write(html_content)

with open(os.path.join(TEMPLATE_DIR, "style.css")) as f:
    with open(os.path.join(OUTPUT_DIR, "style.css"), "w") as out:
        out.write(f.read())

with open(os.path.join(TEMPLATE_DIR, "app.js")) as f:
    js_content = f.read().replace("DATE_PLACEHOLDER", today)
with open(os.path.join(OUTPUT_DIR, "app.js"), "w") as f:
    f.write(js_content)

print(f"Done — {sum(1 for l in lines if 'kcal=' in l)} dishes written")
