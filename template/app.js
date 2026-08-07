/* ============================================================
   ETH/UZH University Menus — render logic
   Reads index.txt, renders Apple-style dish list with
   fixed 9-row nutrition tables (per 100g | Total).
   ============================================================ */

'use strict';

const DATE_STR = 'DATE_PLACEHOLDER';
let RAW_TEXT = '';

/* ---------- Date ---------- */

function formatDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

/* ---------- Data loading ---------- */

async function init() {
  try {
    const resp = await fetch('index.txt');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    RAW_TEXT = await resp.text();
    document.getElementById('raw-text').textContent = RAW_TEXT;
    render(parseText(RAW_TEXT));
  } catch (e) {
    document.getElementById('content').innerHTML =
      '<div class="error">Failed to load menu data</div>';
    console.error(e);
  }
}

/* ---------- Parsing ---------- */

// Line formats (index.txt):
//   ETH: ... | per100g: kcal=554, protein=5.6g, ...
//   UZH: ... | per100g: kcal=132, ... | total: kcal=768, ..., weight=545g
const LINE_RE = /^(.+?)\/(.+?):\s+(.+?)\s+—\s+(.+?)(?::\s+(.*?))?\s*\|\s+(per100g:\s+kcal=.+)$/;

function parseNutrition(segment) {
  const obj = {};
  for (const part of segment.split(', ')) {
    const eq = part.indexOf('=');
    if (eq > 0) obj[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return obj;
}

function parseText(text) {
  const mensas = {};

  for (const line of text.split('\n')) {
    const m = line.match(LINE_RE);
    if (m) {
      const [, mensaName, mealTime, lineName, dishRaw, descRaw, nutrStr] = m;
      const key = mensaName.trim();
      if (!mensas[key]) mensas[key] = { name: key, closed: false, dishes: [] };

      // nutrition segments: "per100g: ..." and/or "total: ..."
      const nutrition = { p100: {}, total: {} };
      for (const seg of nutrStr.split(/\s*\|\s*(?=per100g:|total:)/)) {
        const sm = seg.match(/^(per100g|total):\s*(.+)$/);
        if (sm) nutrition[sm[1] === 'per100g' ? 'p100' : 'total'] = parseNutrition(sm[2]);
      }

      // dish name vs ingredients:
      //   ETH: name comes whole, desc = ingredients
      //   UZH: name contains "MAIN, ingredient, ingredient" — split at first comma
      let dishName = dishRaw.trim();
      let desc = (descRaw || '').trim();
      if (!desc) {
        const comma = dishName.indexOf(',');
        if (comma > 0) {
          desc = dishName.slice(comma + 1).trim();
          dishName = dishName.slice(0, comma).trim();
        }
      }

      mensas[key].dishes.push({
        mealTime: mealTime.trim(),
        line: lineName.trim(),
        dish: dishName,
        desc,
        nutrition,
      });
    } else if (line.includes(': no meals today') || line.includes(': no dishes for today')) {
      const name = line.slice(0, line.indexOf(':')).trim();
      if (!mensas[name]) mensas[name] = { name, closed: true, dishes: [] };
    }
  }

  return Object.values(mensas);
}

/* ---------- Render ---------- */

const NUTRITION_ROWS = [
  { label: 'Energy', key: 'kcal', fmt: (v) => v + ' kcal' },
  { label: 'Protein', key: 'protein' },
  { label: 'Fat', key: 'fat' },
  { label: 'Saturated', key: 'saturated' },
  { label: 'Carbs', key: 'carbs' },
  { label: 'Sugar', key: 'sugar' },
  { label: 'Salt', key: 'salt' },
  { label: 'Fiber', key: 'fiber' },
  { label: 'Weight', key: 'weight' },
];

function cell(value) {
  return value ? value : '';
}

function nutritionTableHTML(nutrition) {
  const rows = NUTRITION_ROWS.map((row) => {
    const p100 = nutrition.p100[row.key];
    const total = nutrition.total[row.key];
    const val = (v) => (v ? (row.fmt ? row.fmt(v) : v) : '');
    return (
      '<tr>' +
      '<td class="n-label">' + row.label + '</td>' +
      '<td class="n-val">' + cell(val(p100)) + '</td>' +
      '<td class="n-val">' + cell(val(total)) + '</td>' +
      '</tr>'
    );
  }).join('');

  return (
    '<table class="nutrition-table">' +
    '<thead><tr><th>Nutrition</th><th>per 100g</th><th>Total</th></tr></thead>' +
    '<tbody>' + rows + '</tbody>' +
    '</table>'
  );
}

function dishHTML(dish) {
  return (
    '<div class="dish">' +
    '<div class="dish-main">' +
    '<div class="dish-label">' + dish.line + ' &middot; ' + dish.mealTime + '</div>' +
    '<h3 class="dish-name">' + dish.dish + '</h3>' +
    (dish.desc ? '<p class="dish-desc">' + dish.desc + '</p>' : '') +
    '</div>' +
    '<div class="nutrition-col">' + nutritionTableHTML(dish.nutrition) + '</div>' +
    '</div>'
  );
}

function render(mensas) {
  const content = document.getElementById('content');

  if (mensas.length === 0) {
    content.innerHTML = '<div class="no-meals">No menu data available for today.</div>';
    return;
  }

  content.innerHTML = mensas
    .map((mensa) => {
      const body = mensa.closed
        ? '<div class="no-meals">No meals available today.</div>'
        : mensa.dishes.map(dishHTML).join('');
      return '<section class="mensa-section"><h2 class="mensa-title">' + mensa.name + '</h2>' + body + '</section>';
    })
    .join('');
}

/* ---------- Raw toggle + copy ---------- */

function toggleRaw() {
  const panel = document.getElementById('raw-panel');
  const btn = document.getElementById('raw-toggle');
  const isOpen = panel.classList.toggle('open');
  btn.textContent = isOpen ? 'Hide Raw Data' : 'Show Raw Data';
}

function copyRaw() {
  const btn = document.getElementById('copy-btn');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(RAW_TEXT)
      .then(() => flashCopied(btn))
      .catch(() => fallbackCopy(btn));
  } else {
    fallbackCopy(btn);
  }
}

function fallbackCopy(btn) {
  const ta = document.createElement('textarea');
  ta.value = RAW_TEXT;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    flashCopied(btn);
  } catch (e) { /* ignore */ }
  document.body.removeChild(ta);
}

function flashCopied(btn) {
  const orig = btn.textContent;
  btn.textContent = 'Copied';
  btn.classList.add('copied');
  setTimeout(() => {
    btn.textContent = orig;
    btn.classList.remove('copied');
  }, 1500);
}

/* ---------- Boot ---------- */

document.getElementById('date-heading').textContent = formatDate(DATE_STR);
init();
