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
                lines.append(f"{FACILITY_NAMES[fid]}/{mt_name}: {line_name} — {dish}: {desc} | {nutr_str}")
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
                    "salt": ("salt", "g"), "fibers": ("fibers", "g"),
                }
                parts = []
                for key, (label, unit) in nutr_map.items():
                    v = stats.get(key, {})
                    if isinstance(v, dict) and v.get("amount") is not None and float(v["amount"]) != 0:
                        parts.append(f"{label}={v['amount']}{unit}")

                tw = stats.get("servingWeight", {})
                if isinstance(tw, dict) and tw.get("amount"):
                    parts.append(f"weight={tw['amount']}{tw.get('unit', 'g')}")

                nutr_str = ", ".join(parts) if parts else "nutrition=N/A"
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

# Beautiful Apple iOS 26 + 二次元 style HTML
# The page fetches index.txt at runtime and renders it as beautiful cards
html_content = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ETH/UZH Nutrition DATE_PLACEHOLDER</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*,*::before,*::after{{box-sizing:border-box;margin:0;padding:0}}
:root{{
  --bg:#f5f1ed;--card:#ffffff;--text:#1d1d1f;--sub:#6e6e73;--radius:20px;--radius-sm:12px;
  --eth:#e8f0fe;--eth-accent:#4a7dce;--uzh:#fce4ec;--uzh-accent:#d4687c;
  --kcal:#f97316;--protein:#3b82f6;--fat:#eab308;--carbs:#22c55e;--sugar:#ec4899;
  --salt:#94a3b8;--fiber:#84cc16;--weight:#8b5cf6;
  --shadow:0 1px 3px rgba(0,0,0,.06),0 1px 2px rgba(0,0,0,.04);
  --shadow-md:0 4px 6px rgba(0,0,0,.04),0 2px 4px rgba(0,0,0,.03);
  --shadow-lg:0 10px 15px rgba(0,0,0,.05),0 4px 6px rgba(0,0,0,.03);
}}
@media(prefers-color-scheme:dark){{
  :root{{--bg:#1c1c1e;--card:#2c2c2e;--text:#f5f5f7;--sub:#98989d;
    --eth:#1e2a3a;--uzh:#3a1e2a;--shadow:0 1px 3px rgba(0,0,0,.3);--shadow-md:0 4px 6px rgba(0,0,0,.2);--shadow-lg:0 10px 15px rgba(0,0,0,.25);
  }}
}}
body{{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--text);line-height:1.5;min-height:100vh}}
.container{{max-width:960px;margin:0 auto;padding:clamp(16px,4vw,40px)}}

/* Header */
.header{{text-align:center;padding:clamp(24px,5vw,48px) 0 clamp(16px,3vw,32px);position:relative}}
.header::before{{content:"";position:absolute;inset:0;background:linear-gradient(135deg,rgba(255,182,193,.15),rgba(135,206,250,.15),rgba(255,255,255,0));border-radius:0 0 48px 48px;z-index:-1}}
.header h1{{font-size:clamp(24px,5vw,36px);font-weight:700;letter-spacing:-0.5px;background:linear-gradient(135deg,var(--text) 0%,#888 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}}
.header .date{{font-size:14px;color:var(--sub);margin-top:4px;font-weight:500}}
.header .stats{{font-size:13px;color:var(--sub);margin-top:8px}}

/* Mensa section */
.mensa-section{{margin-bottom:clamp(16px,3vw,28px)}}
.mensa-header{{display:flex;align-items:center;gap:10px;padding:14px 20px;border-radius:var(--radius-sm);font-weight:600;font-size:15px;margin-bottom:12px;backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px)}}
.mensa-header.eth{{background:var(--eth);color:var(--eth-accent)}}
.mensa-header.uzh{{background:var(--uzh);color:var(--uzh-accent)}}
.mensa-header .icon{{font-size:18px}}
.mensa-header .count{{margin-left:auto;font-size:12px;opacity:.7}}

/* Dish cards */
.dish-grid{{display:flex;flex-direction:column;gap:10px}}
.dish-card{{background:var(--card);border-radius:var(--radius-sm);padding:clamp(14px,3vw,18px) clamp(14px,3vw,20px);box-shadow:var(--shadow);transition:box-shadow .2s,transform .2s;border:1px solid rgba(0,0,0,.04);position:relative;overflow:hidden}}
.dish-card:hover{{box-shadow:var(--shadow-lg);transform:translateY(-1px)}}
.dish-card .card-line{{position:absolute;left:0;top:0;bottom:0;width:4px;border-radius:4px 0 0 4px}}
.dish-card .card-line.meat{{background:var(--kcal)}}
.dish-card .card-line.veggie{{background:var(--carbs)}}
.dish-card .card-line.vegan{{background:var(--fiber)}}
.dish-card .card-line.fish{{background:var(--protein)}}

.dish-top{{display:flex;align-items:flex-start;gap:10px;margin-bottom:8px}}
.dish-line{{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--sub);white-space:nowrap;padding-top:3px}}
.dish-name{{font-size:clamp(15px,2.5vw,17px);font-weight:600;line-height:1.3;flex:1}}
.dish-desc{{font-size:13px;color:var(--sub);margin-bottom:12px;line-height:1.5;padding-left:calc(clamp(14px,3vw,18px) + 4px)}}

/* Nutrition pills */
.nutrition-row{{display:flex;flex-wrap:wrap;gap:6px;padding-left:calc(clamp(14px,3vw,18px) + 4px)}}
.nutrition-pill{{display:inline-flex;align-items:center;gap:3px;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:500;white-space:nowrap}}
.nutrition-pill .val{{font-weight:700}}
.nutrition-pill .unit{{font-size:10px;opacity:.7}}
.nutrition-pill.kcal-tag{{background:rgba(249,115,22,.1);color:var(--kcal)}}
.nutrition-pill.protein-tag{{background:rgba(59,130,246,.1);color:var(--protein)}}
.nutrition-pill.fat-tag{{background:rgba(234,179,8,.1);color:var(--fat)}}
.nutrition-pill.carbs-tag{{background:rgba(34,197,94,.1);color:var(--carbs)}}
.nutrition-pill.sugar-tag{{background:rgba(236,72,153,.1);color:var(--sugar)}}
.nutrition-pill.salt-tag{{background:rgba(148,163,184,.15);color:var(--salt)}}
.nutrition-pill.fiber-tag{{background:rgba(132,204,22,.1);color:var(--fiber)}}
.nutrition-pill.weight-tag{{background:rgba(139,92,246,.1);color:var(--weight)}}

/* No meals notice */
.no-meals{{padding:20px;text-align:center;color:var(--sub);font-size:14px;font-style:italic}}

/* Raw text toggle */
.raw-toggle-btn{{display:block;margin:clamp(20px,4vw,32px) auto 0;padding:10px 24px;background:var(--card);border:1px solid rgba(0,0,0,.08);border-radius:24px;font-size:13px;font-weight:500;color:var(--sub);cursor:pointer;transition:all .2s;box-shadow:var(--shadow);font-family:inherit}}
.raw-toggle-btn:hover{{color:var(--text);box-shadow:var(--shadow-md)}}
.raw-content{{margin-top:16px;background:var(--card);border-radius:var(--radius-sm);padding:clamp(16px,3vw,24px);box-shadow:var(--shadow);font-family:"SF Mono",SFMono-Regular,Consolas,"Liberation Mono",Menlo,monospace;font-size:12px;line-height:1.6;white-space:pre-wrap;max-height:0;overflow:hidden;opacity:0;transition:max-height .4s ease,opacity .3s ease,padding .3s ease;border:1px solid rgba(0,0,0,.04)}}
.raw-content.open{{max-height:5000px;opacity:1;padding:clamp(16px,3vw,24px)}}

/* Footer */
.footer{{text-align:center;padding:32px 0;color:var(--sub);font-size:11px;opacity:.6}}

/* Loading / error */
.loading{{text-align:center;padding:60px 20px;color:var(--sub)}}
.error{{text-align:center;padding:40px 20px;color:var(--kcal);font-weight:500}}

/* Sparkle overlay (subtle 二次元) */
.sparkle{{position:fixed;pointer-events:none;z-index:-1;opacity:.15}}
.sparkle.top-right{{top:10%;right:5%;width:200px;height:200px;background:radial-gradient(circle,rgba(255,182,193,.4),transparent 70%)}}
.sparkle.bottom-left{{bottom:5%;left:3%;width:160px;height:160px;background:radial-gradient(circle,rgba(135,206,250,.3),transparent 70%)}}

/* Media queries */
@media(max-width:600px){{
  .dish-card{{padding:12px 14px}}
  .nutrition-pill{{padding:3px 8px;font-size:11px}}
  .dish-line{{font-size:10px}}
}}
</style>
</head>
<body>
<div class="sparkle top-right"></div>
<div class="sparkle bottom-left"></div>
<div class="container">
  <header class="header">
    <h1>Today's Menu</h1>
    <div class="date">DATE_PLACEHOLDER</div>
    <div class="stats" id="dish-count">Loading...</div>
  </header>
  <div id="content"><div class="loading">Loading menu data...</div></div>
  <button class="raw-toggle-btn" id="raw-toggle" onclick="toggleRaw()">Show Raw Data</button>
  <div class="raw-content" id="raw-content"></div>
  <div class="footer">Updated daily at 06:00 Zurich time &middot; <a href="https://github.com/LukasAxelsen/eth-uzh-nutrition" style="color:inherit">GitHub</a></div>
</div>
<script>
async function init(){{
  try{{
    const resp = await fetch('index.txt');
    if(!resp.ok) throw new Error('HTTP '+resp.status);
    const text = await resp.text();
    document.getElementById('raw-content').textContent = text;
    parseAndRender(text);
  }}catch(e){{
    document.getElementById('content').innerHTML = '<div class="error">Failed to load menu data</div>';
    console.error(e);
  }}
}}

function parseAndRender(text){{
  const lines = text.split('\n');
  const mensas = {};
  let currentMensa = null;

  for(const line of lines){
    // Match: "Mensa Name/MealTime: Line — Dish: Desc | kcal=X, protein=Xg, ..."
    const m = line.match(/^(.+?)\/(.+?):\s+(.+?)\s+—\s+(.+?):\s+(.+?)\s*\|\s+(.+)$/);
    if(m){{
      const [,mensaName,mealTime,lineName,dish,desc,nutrStr] = m;
      const key = mensaName.trim();
      if(!mensas[key]) mensas[key] = {{name:key,dishes:[],isETH:key.startsWith('ETH')}};
      
      // Parse nutrition
      const nutrition = {{}};
      for(const part of nutrStr.split(', ')){{
        const eq = part.indexOf('=');
        if(eq > 0){{
          const k = part.substring(0,eq).trim();
          const v = part.substring(eq+1).trim();
          nutrition[k] = v;
        }}
      }}

      mensas[key].dishes.push({{
        mealTime:mealTime.trim(),line:lineName.trim(),dish:dish.trim(),
        desc:desc.trim(),nutrition,isETH:key.startsWith('ETH')
      }});
    }}else if(line.includes(': no meals today')||line.includes(': no dishes for today')){{
      const colonIdx = line.indexOf(':');
      const name = line.substring(0,colonIdx).trim();
      if(!mensas[name]) mensas[name] = {{name,dishes:[],isETH:name.startsWith('ETH'),closed:true}};
    }}
  }}

  const totalDishes = Object.values(mensas).reduce((s,m)=>s+(m.closed?0:m.dishes.length),0);
  document.getElementById('dish-count').textContent = totalDishes+' dishes across '+Object.keys(mensas).length+' mensas';

  if(Object.keys(mensas).length===0){{
    document.getElementById('content').innerHTML = '<div class="no-meals">No menu data available for today</div>';
    return;
  }}

  let html = '';
  for(const [name,mensa] of Object.entries(mensas)){{
    const isETH = mensa.isETH;
    const icon = isETH ? '' : '';
    html += '<section class="mensa-section">';
    html += '<div class="mensa-header '+(isETH?'eth':'uzh')+'">';
    html += '<span class="icon">'+icon+'</span>'+name;
    if(!mensa.closed) html += '<span class="count">'+mensa.dishes.length+' dishes</span>';
    html += '</div>';

    if(mensa.closed){{
      html += '<div class="no-meals">Closed today</div>';
    }}else{{
      html += '<div class="dish-grid">';
      for(const dish of mensa.dishes){{
        // Determine card line color
        const dn = dish.dish.toLowerCase();
        let cls = 'veggie';
        if(/fleisch|poulet|huhn|rind|schwein|burger|wurst|bacon|speck|pulled pork|lomo|pollo|truten/.test(dn)) cls = 'meat';
        else if(/vegan/.test(dn)) cls = 'vegan';
        else if(/fisch|crevette|fish|shrimp/.test(dn)) cls = 'fish';

        html += '<div class="dish-card">';
        html += '<div class="card-line '+cls+'"></div>';
        html += '<div class="dish-top"><span class="dish-line">'+dish.line+' &middot; '+dish.mealTime+'</span>';
        html += '<span class="dish-name">'+dish.dish+'</span></div>';
        html += '<div class="dish-desc">'+dish.desc+'</div>';
        html += '<div class="nutrition-row">';

        const nutrOrder = ['kcal','protein','fat','saturated','carbs','sugar','salt','fibers','weight'];
        const nutrTags = {{kcal:'kcal-tag',protein:'protein-tag',fat:'fat-tag',saturated:'fat-tag',
          carbs:'carbs-tag',sugar:'sugar-tag',salt:'salt-tag',fibers:'fiber-tag',weight:'weight-tag'}};
        for(const key of nutrOrder){{
          const val = dish.nutrition[key];
          if(val){{
            const tagCls = nutrTags[key] || '';
            const num = val.replace(/[^0-9.]/g,'');
            const unit = val.replace(/[0-9.]/g,'');
            html += '<span class="nutrition-pill '+tagCls+'"><span class="val">'+num+'</span><span class="unit">'+unit+'</span></span>';
          }}
        }}
        html += '</div></div>';
      }}
      html += '</div>';
    }}
    html += '</section>';
  }}
  document.getElementById('content').innerHTML = html;
}}

function toggleRaw(){{
  const raw = document.getElementById('raw-content');
  const btn = document.getElementById('raw-toggle');
  const isOpen = raw.classList.toggle('open');
  btn.textContent = isOpen ? 'Hide Raw Data' : 'Show Raw Data';
}}

init();
</script>
</body>
</html>
""".replace("DATE_PLACEHOLDER", today)

with open(os.path.join(OUTPUT_DIR, "index.html"), "w") as f:
    f.write(html_content)

print(f"Done — {sum(1 for l in lines if '| kcal=' in l)} dishes written")
