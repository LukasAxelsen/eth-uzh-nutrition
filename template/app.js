/* ============================================================
   ETH/UZH University Menus — frontend logic (vanilla JS)

   - Fetches data.json (same directory as the page) and renders
     mensa sections grouped/ordered by the data file.
   - Lunch/Dinner segmented switch with a smoothly sliding thumb.
   - Hamburger-driven mensa selector panel (two columns:
     mensa list + group rows incl. custom groups).
   - Selection, active meal and collapsed sections persist to
     localStorage under "eth-uzh-nutrition-prefs".
   - Filtered raw-data view (selected mensas, active meal slot)
     with copy-to-clipboard.

   DOM contract: class names in CONTRACT.md are mandatory — the
   design stylesheet targets them; do not rename. Inline styles
   in this file are functional fallbacks only (segmented thumb
   geometry, collapse animation) and may be overridden by the
   design stylesheet.
   ============================================================ */

'use strict';

/* ------------------------------------------------------------
   1. Constants & configuration
   ------------------------------------------------------------ */

// Replaced at deploy time (e.g. "2026-08-07"). Keep the token verbatim.
const DATE_STR = 'DATE_PLACEHOLDER';
const STORAGE_KEY = 'eth-uzh-nutrition-prefs';

// Default groups, in display order (custom groups are appended after).
const DEFAULT_GROUPS = ['Central', 'Hoengg', 'Irchel'];

// Fixed nutrition keys, in display order. kcal is unitless, everything
// else is grams; weight only ever appears in "total".
const NUTRI_KEYS = ['kcal', 'protein', 'fat', 'saturated', 'carbs', 'sugar', 'salt', 'fiber', 'weight'];

// Nutrition table rows (9 fixed rows per contract).
const NUTRITION_ROWS = [
  { label: 'Energy', key: 'kcal' },
  { label: 'Protein', key: 'protein' },
  { label: 'Fat', key: 'fat' },
  { label: 'Saturated', key: 'saturated' },
  { label: 'Carbs', key: 'carbs' },
  { label: 'Sugar', key: 'sugar' },
  { label: 'Salt', key: 'salt' },
  { label: 'Fiber', key: 'fiber' },
  { label: 'Weight', key: 'weight' },
];

const EMPTY_MEALS_TEXT = 'No meals available today.';

/* ------------------------------------------------------------
   2. App state
   ------------------------------------------------------------ */

// Normalized data.json contents.
let data = null;

// User preferences. Sets for membership (fast lookup), plain object
// for custom groups. Mirrors the localStorage schema exactly:
//   { meal, selected: [ids], photos: bool, customGroups: {name: [ids]}, collapsedMensas: [ids] }
let prefs = {
  meal: 'Lunch',
  selected: new Set(),
  photos: false,
  customGroups: {},
  collapsedMensas: new Set(),
};

// Most recently built filtered raw text (what the copy button copies).
let rawFiltered = '';

/* ------------------------------------------------------------
   3. Persistence (localStorage)
   ------------------------------------------------------------ */

/** Read + sanitize stored prefs; fall back to defaults on any error. */
function loadPrefs() {
  const p = { meal: 'Lunch', selected: new Set(), photos: false, customGroups: {}, collapsedMensas: new Set() };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return p;
    const parsed = JSON.parse(raw);
    if (parsed.meal === 'Lunch' || parsed.meal === 'Dinner') p.meal = parsed.meal;
    if (Array.isArray(parsed.selected)) p.selected = new Set(parsed.selected.map(String));
    if (typeof parsed.photos === 'boolean') p.photos = parsed.photos;
    if (parsed.customGroups && typeof parsed.customGroups === 'object' && !Array.isArray(parsed.customGroups)) {
      for (const [name, ids] of Object.entries(parsed.customGroups)) {
        if (Array.isArray(ids)) p.customGroups[String(name)] = ids.map(String);
      }
    }
    if (Array.isArray(parsed.collapsedMensas)) p.collapsedMensas = new Set(parsed.collapsedMensas.map(String));
  } catch (err) {
    console.warn('Could not read prefs; using defaults.', err);
  }
  return p;
}

/** Serialize prefs back to localStorage. */
function savePrefs() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      meal: prefs.meal,
      selected: Array.from(prefs.selected),
      photos: prefs.photos,
      customGroups: prefs.customGroups,
      collapsedMensas: Array.from(prefs.collapsedMensas),
    }));
  } catch (err) {
    console.warn('Could not save prefs.', err);
  }
}

/* ------------------------------------------------------------
   4. Data loading & normalization
   ------------------------------------------------------------ */

/** Fetch data.json (same directory as the page). */
async function fetchData() {
  const resp = await fetch('data.json', { cache: 'no-cache' });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const json = await resp.json();
  if (!json || !Array.isArray(json.mensas)) throw new Error('Unexpected data.json shape');
  return json;
}

/** Guarantee every mensa has id/name/group and Lunch/Dinner arrays. */
function normalizeMensas(raw) {
  return raw.map((m) => ({
    id: String(m.id),
    name: m.name || String(m.id),
    group: m.group || 'Other',
    meals: {
      Lunch: Array.isArray(m.meals && m.meals.Lunch) ? m.meals.Lunch : [],
      Dinner: Array.isArray(m.meals && m.meals.Dinner) ? m.meals.Dinner : [],
    },
  }));
}

/** Drop stale ids (closed mensas etc.), default selection to Central. */
function validatePrefsAgainstData() {
  const ids = new Set(data.mensas.map((m) => m.id));

  prefs.selected = new Set(Array.from(prefs.selected).filter((id) => ids.has(id)));

  for (const name of Object.keys(prefs.customGroups)) {
    prefs.customGroups[name] = prefs.customGroups[name].filter((id) => ids.has(id));
    if (!prefs.customGroups[name].length) delete prefs.customGroups[name];
  }

  prefs.collapsedMensas = new Set(Array.from(prefs.collapsedMensas).filter((id) => ids.has(id)));

  // No stored selection (or all of it went stale) -> default: all Central.
  if (!prefs.selected.size) {
    prefs.selected = new Set(mensasInGroup('Central').map((m) => m.id));
  }

  savePrefs();
}

/* ---------- mensa/group lookup helpers ---------- */

function mensaById(id) {
  return data.mensas.find((m) => m.id === id) || null;
}

/** All mensas belonging to a default group (data order). */
function mensasInGroup(group) {
  return data.mensas.filter((m) => m.group === group);
}

/** Member ids of a group row — default group or custom group. */
function groupMembers(name) {
  if (prefs.customGroups[name]) return prefs.customGroups[name];
  return mensasInGroup(name).map((m) => m.id);
}

/* ------------------------------------------------------------
   5. Formatting helpers
   ------------------------------------------------------------ */

/** Escape text for safe injection into innerHTML. */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * Number formatting matching the backend dump: Number.toString() is
 * the JS equivalent of Python's str(float) for JSON numbers. The
 * backend strips trailing ".0" (18.0 -> "18") so the raw text from
 * the copy button is byte-identical with index.txt.
 */
function fmtNum(v) {
  const n = Number(v);
  if (!isFinite(n)) return '';
  return String(n);
}

/** Nutrition table cell: value + unit (kcal unitless). */
function fmtCell(v, key) {
  if (v == null || v === '') return '';
  return fmtNum(v) + (key === 'kcal' ? ' kcal' : ' g');
}

/**
 * One nutrition segment for the raw text, e.g.
 * "kcal=152.0, protein=5.3g, fat=9.9g" (empty string when no data).
 * Matches the backend: falsy values are skipped, kcal has no unit,
 * everything else gets "g". weight is only included in total.
 */
function nutriSegment(nutr, includeWeight) {
  const parts = [];
  for (const key of NUTRI_KEYS) {
    if (key === 'weight' && !includeWeight) continue;
    const v = nutr[key];
    if (!v) continue; // skips null/undefined/0/''/NaN — same as backend
    parts.push(key + '=' + fmtNum(v) + (key === 'kcal' ? '' : 'g'));
  }
  return parts.join(', ');
}

/**
 * One raw-text line, index.txt format:
 *   NAME/SLOT: line — dish | desc | per100g: … | total: …
 * Empty segments and line==dish duplicates are dropped (mirrors the
 * backend dish_body()). Emits "nutrition=N/A" when the dish carries
 * no nutrition at all.
 */
function dishRawLine(m, d) {
  const nutrition = d.nutrition || { p100: {}, total: {} };
  const line = String(d.line || '').trim();
  const dish = String(d.dish || '').trim();
  const desc = String(d.desc || '').trim();

  let head;
  if (line && line.toLowerCase() !== dish.toLowerCase()) head = line + ' — ' + dish;
  else head = dish;
  if (desc) head += ' | ' + desc;

  const segs = [];
  const p100 = nutriSegment(nutrition.p100 || {}, false);
  const total = nutriSegment(nutrition.total || {}, true);
  if (p100) segs.push('per100g: ' + p100);
  if (total) segs.push('total: ' + total);

  return m.name + '/' + prefs.meal + ': ' + head +
    (segs.length ? ' | ' + segs.join(' | ') : ' | nutrition=N/A');
}

/** Filtered raw text: selected mensas, current meal slot only. */
function buildRawText() {
  const lines = [];
  for (const m of data.mensas) {
    if (!prefs.selected.has(m.id)) continue;
    for (const d of m.meals[prefs.meal]) lines.push(dishRawLine(m, d));
  }
  return lines.join('\n');
}

/** "Friday, August 7" from the DATE_STR placeholder (deploy replaces it). */
function formatDate(iso) {
  let d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) d = new Date(); // placeholder not replaced yet
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

/* ------------------------------------------------------------
   6. Rendering
   ------------------------------------------------------------ */

/** Full re-render of everything derived from state. */
function renderAll() {
  updateSegmented();
  updatePhotoToggle();
  renderSelector();
  renderContent();
  updateRawText();
}

/* ---------- keyed reconciliation + FLIP (Vue TransitionGroup pattern) ----------
   Every mensa section and dish carries a stable data-key. On re-render we
   diff the key lists: nodes with an existing key are REUSED untouched (no
   diff => no re-render, no animation); new keys fade/slide in; removed
   keys disappear; surviving nodes whose position changed slide smoothly
   via FLIP (First-Last-Invert-Play, transform-only, 60fps). This replaces
   the full innerHTML swap that used to snap, and the View-Transition
   snapshot approach that caused jank on height changes. */

const ANIM_MS = 350;
const ANIM_EASE = 'cubic-bezier(.4, 0, .2, 1)';

// Animations are enabled ONLY after the initial render completes — the
// first paint must be silent (content just appears), per FLIP practice
// (Vue TransitionGroup / react-flip-toolkit): transitions are for user
// interactions, not for page load.
let animEnabled = false;

/** Respect the user's reduced-motion preference (same as the CSS guard). */
function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Animations run only for user-driven updates, never on first paint. */
function animationsAllowed() {
  return animEnabled && !prefersReducedMotion();
}

/** First: record each child's top offset, keyed by the node itself.
    Any in-flight transform animation is committed first (WAAPI finish)
    so the measured position is the true layout spot, never a mid-flight
    offset — otherwise overlapping FLIP passes would compute wrong deltas. */
function flipFirst(container) {
  const first = new Map();
  for (const child of container.children) {
    if (child.getAnimations) {
      for (const a of child.getAnimations()) {
        if (a.playState === 'running' || a.playState === 'pending') a.finish();
      }
    }
    first.set(child, child.getBoundingClientRect().top);
  }
  return first;
}

/** Invert + Play: slide every surviving child from its old top to the new
    one via a transform-only WAAPI animation. Newly added children (not in
    `first`) are skipped — they run their own enter animation. */
function flipPlay(container, first) {
  if (!animationsAllowed()) return;
  for (const child of container.children) {
    if (!first.has(child)) continue;
    const delta = first.get(child) - child.getBoundingClientRect().top;
    if (delta) {
      child.animate(
        [{ transform: 'translateY(' + delta + 'px)' }, { transform: 'translateY(0)' }],
        { duration: ANIM_MS, easing: ANIM_EASE }
      );
    }
  }
}

/** Keyed reconciliation: keep existing nodes in order, create missing ones
    via makeEl(key), drop stale ones. No enter/leave fades — newly added
    nodes just appear, and every surviving node whose position changed
    slides smoothly via FLIP (the Vue TransitionGroup move choreography:
    the list "makes room" for additions/removals instead of popping).
    Pass doFlip=false when the caller wants to batch one FLIP pass across
    several containers (see renderContent) to avoid double-measuring. */
function reconcileChildren(container, keys, makeEl, doFlip) {
  const first = flipFirst(container);
  const existing = new Map();
  for (const child of container.children) {
    if (child.dataset.key) existing.set(child.dataset.key, child);
  }
  const seen = new Set();

  for (const key of keys) {
    let node = existing.get(key);
    if (!node) {
      node = makeEl(key);
      node.dataset.key = key;
      container.appendChild(node); // appears in place; neighbors slide via flipPlay
    } else {
      container.appendChild(node); // move to its new position if reordered
    }
    seen.add(key);
  }

  // Drop stale keyed nodes AND any keyless leftovers (e.g. a no-meals
  // div from a previous render path) — every surviving child must be
  // keyed and present in the new list.
  for (const child of Array.from(container.children)) {
    if (!child.dataset.key || !seen.has(child.dataset.key)) child.remove();
  }

  if (doFlip !== false) flipPlay(container, first);
}

/** Reflect prefs.photos on the drawer row (filled dot = on). */
function updatePhotoToggle() {
  const row = document.getElementById('photo-row');
  if (!row) return;
  row.classList.toggle('selected', prefs.photos);
  row.setAttribute('aria-pressed', String(prefs.photos));
}

function onPhotoToggleClick() {
  prefs.photos = !prefs.photos;
  savePrefs();
  updatePhotoToggle();
  applyPhotos(); // pure DOM insert/remove — no re-render
}

/* ---------- selector: mensa list (left column) ---------- */

function renderSelector() {
  renderMensaList();
  renderGroupList();
}

function mensaRowHTML(m) {
  const sel = prefs.selected.has(m.id);
  return '<div class="mensa-row' + (sel ? ' selected' : '') + '" data-mensa="' + esc(m.id) + '"' +
    ' role="button" tabindex="0" aria-pressed="' + sel + '">' +
    '<span class="mensa-check" aria-hidden="true"></span>' +
    '<span class="mensa-label">' + esc(m.name) + '</span>' +
    '</div>';
}

function renderMensaList() {
  const container = document.querySelector('.selector-mensas');
  container.innerHTML = data.mensas.map(mensaRowHTML).join('');
}

/** In-place update of every mensa row (preserves scroll position).
    The filled dot is drawn by CSS (.mensa-check::after) — no text. */
function refreshMensaRows() {
  document.querySelectorAll('.mensa-row').forEach((row) => {
    const sel = prefs.selected.has(row.dataset.mensa);
    row.classList.toggle('selected', sel);
    row.setAttribute('aria-pressed', String(sel));
  });
}

/* ---------- selector: group chips (horizontal filter chips) ---------- */

function groupRowHTML(g) {
  // Material-style filter chip: click applies the group (replaces the
  // current selection with its members); custom chips carry a delete (x).
  const count = g.members.length;
  return '<button class="group-chip' + (g.custom ? ' custom' : '') + '" type="button"' +
    (count ? '' : ' disabled') +
    ' data-group="' + esc(g.name) + '" aria-label="Apply group ' + esc(g.name) + '">' +
    '<span class="chip-name">' + esc(g.name) + '</span>' +
    '<span class="chip-count">' + count + '</span>' +
    (g.custom
      ? '<span class="chip-x" role="button" tabindex="-1" aria-label="Delete group ' + esc(g.name) + '">&times;</span>'
      : '') +
    '</button>';
}

function renderGroupList() {
  const container = document.querySelector('.group-rows');

  // Default groups in fixed order, then any data groups not listed, then custom.
  const known = new Set(DEFAULT_GROUPS);
  const groups = DEFAULT_GROUPS.map((name) => ({ name, members: mensasInGroup(name).map((m) => m.id), custom: false }));
  for (const m of data.mensas) {
    if (!known.has(m.group)) {
      known.add(m.group);
      groups.push({ name: m.group, members: [m.id], custom: false });
    }
  }
  for (const name of Object.keys(prefs.customGroups)) {
    groups.push({ name, members: prefs.customGroups[name], custom: true });
  }

  container.innerHTML = groups.map(groupRowHTML).join('');
}

/* ---------- content: mensa sections ---------- */

function dishHTML(d, key) {
  const nutrition = d.nutrition || { p100: {}, total: {} };
  // The label is dropped when it duplicates the dish name (Rice Up!
  // publishes "Rice Up! Bowl" as both line and dish).
  const line = String(d.line || '').trim();
  const dish = String(d.dish || '').trim();
  const label = line && line.toLowerCase() !== dish.toLowerCase() ? line : '';
  const keyAttr = key ? ' data-key="' + esc(key) + '"' : '';
  const photo = d.photo ? ' data-photo="' + esc(d.photo) + '"' : '';
  return '<div class="dish"' + keyAttr + photo + '>' +
    '<div class="dish-main">' +
    (label ? '<div class="dish-label">' + esc(label) + '</div>' : '') +
    '<h3 class="dish-name">' + esc(dish) + '</h3>' +
    (d.desc ? '<p class="dish-desc">' + esc(d.desc) + '</p>' : '') +
    '</div>' +
    '<div class="nutrition-col">' + nutritionTableHTML(nutrition) + '</div>' +
    '</div>';
}

function nutritionTableHTML(nutrition) {
  const p100 = nutrition.p100 || {};
  const total = nutrition.total || {};
  const rows = NUTRITION_ROWS.map((row) =>
    '<tr>' +
    '<td class="n-label">' + row.label + '</td>' +
    '<td class="n-val">' + fmtCell(p100[row.key], row.key) + '</td>' +
    '<td class="n-val">' + fmtCell(total[row.key], row.key) + '</td>' +
    '</tr>'
  ).join('');

  return '<table class="nutrition-table">' +
    '<thead><tr><th>Nutrition</th><th>per 100g</th><th>Total</th></tr></thead>' +
    '<tbody>' + rows + '</tbody>' +
    '</table>';
}

function mensaSectionHTML(m) {
  const dishes = m.meals[prefs.meal];
  const collapsed = prefs.collapsedMensas.has(m.id);

  // .mensa-dishes is the collapsible body (inline styles are the
  // functional fallback for the max-height animation).
  const bodyStyle = 'overflow:hidden;transition:max-height .35s ease' + (collapsed ? ';max-height:0' : '');
  const body = '<div class="mensa-dishes" style="' + bodyStyle + '">' +
    (dishes.length
      ? dishes.map((d, i) => dishHTML(d, dishKey(m, d, i))).join('')
      : '<div class="no-meals">' + EMPTY_MEALS_TEXT + '</div>') +
    '</div>';

  return '<section class="mensa-section' + (collapsed ? ' collapsed' : '') + '" data-mensa="' + esc(m.id) + '">' +
    '<h2 class="mensa-title" role="button" tabindex="0" aria-expanded="' + !collapsed + '">' +
    '<span class="mensa-caret" aria-hidden="true"></span>' +
    esc(m.name) +
    '</h2>' + body +
    '</section>';
}

/** Stable key for one dish inside its mensa: meal slot + line + name.
    Collision-safe enough in practice (same line+name twice in one slot
    is rare; duplicates then share one key and reuse the first node). */
function dishKey(m, d, i) {
  return prefs.meal + '|' + (d.line || '') + '|' + (d.dish || '') + '|' + i;
}

/**
 * Keyed re-render of #content. Mensa sections are reconciled by mensa id;
 * dishes inside each section by dishKey. Nodes with unchanged keys are
 * REUSED (no re-render, no animation). One FLIP pass measures ALL old
 * positions up front, performs every DOM change (section add/remove AND
 * dish content swaps that change section heights), then slides every
 * surviving section from its old spot to the new one. This is the Vue
 * TransitionGroup move choreography: the list makes room dynamically —
 * nothing pops, nothing fades. First paint stays silent (animEnabled).
 */
function renderContent() {
  const content = document.getElementById('content');
  const selected = data.mensas.filter((m) => prefs.selected.has(m.id));

  if (!selected.length) {
    reconcileChildren(content, ['__empty__'], () => {
      const div = document.createElement('div');
      div.className = 'no-meals';
      div.textContent = EMPTY_MEALS_TEXT;
      return div;
    });
    return;
  }

  // ONE measurement of every current position, before ANY change.
  const first = flipFirst(content);

  // Section level: key = mensa id. Reuse existing sections untouched.
  reconcileChildren(content, selected.map((m) => m.id), (key) => {
    const section = document.createElement('section');
    section.innerHTML = mensaSectionHTML(mensaById(key));
    return section.firstChild;
  }, false); // defer flip — dish pass below also shifts heights

  // Dish level inside each surviving section.
  for (const section of content.querySelectorAll('.mensa-section')) {
    const m = mensaById(section.dataset.mensa);
    if (!m) continue;
    const body = section.querySelector('.mensa-dishes');
    const dishes = m.meals[prefs.meal];

    if (!dishes.length) {
      reconcileChildren(body, ['__empty__'], () => {
        const div = document.createElement('div');
        div.className = 'no-meals';
        div.textContent = EMPTY_MEALS_TEXT;
        return div;
      }, false);
      continue;
    }
    reconcileChildren(body, dishes.map((d, i) => dishKey(m, d, i)), (key) => {
      const dish = document.createElement('div');
      dish.innerHTML = dishHTML(dishes[Number(key.split('|').pop())]);
      return dish.firstChild;
    }, false);
  }

  // ONE slide: every surviving section glides from its old top to the new.
  flipPlay(content, first);

  // Rebuilt dishes carry no <img> (dishHTML never renders it) — restore
  // photos when the toggle is on so meal switches keep the photo state.
  if (prefs.photos) applyPhotos();
}

/** Photo toggle: insert/remove <img class="dish-photo"> on existing
    dishes with FULL FLIP participation — the height change slides every
    section below (same choreography as mensa toggling). Photos are
    preloaded via Image() + decode() so the browser cache makes repeated
    on/off toggling instant (web.dev image decode practice). No re-render:
    only the <img> nodes are touched. */
function applyPhotos() {
  const show = prefs.photos;
  const dishes = [...document.querySelectorAll('.dish')];
  const content = document.getElementById('content');

  if (show) {
    const pending = [];

    for (const dishEl of dishes) {
      const url = dishEl.dataset.photo;
      if (!url || dishEl.querySelector('.dish-photo')) continue;
      const img = document.createElement('img');
      img.className = 'dish-photo';
      img.alt = (dishEl.querySelector('.dish-name') || {}).textContent || '';
      img.loading = 'lazy';
      // Preload + decode BEFORE inserting: the layout shift (and its FLIP
      // slide) then happens once, with the image already available — no
      // pop-in after the slide, no second reflow when bytes arrive.
      const pre = new Image();
      pre.src = url;
      pending.push({ dishEl, img, pre });
    }

    if (!pending.length) return;

    // Wait for all decodes, then insert + FLIP once.
    Promise.all(pending.map((p) => p.pre.decode().catch(() => {}))).then(() => {
      if (!prefs.photos) return; // toggled off while loading
      const first = flipFirst(content); // positions measured with photos absent
      for (const p of pending) {
        if (!p.dishEl.isConnected || p.dishEl.querySelector('.dish-photo')) continue;
        p.dishEl.querySelector('.dish-main').appendChild(p.img); // appears; neighbors slide via flipPlay
      }
      flipPlay(content, first);
    });
  } else {
    // Off: remove photos. Record positions first so the collapse slides.
    const first = flipFirst(content);
    for (const dishEl of dishes) {
      const img = dishEl.querySelector('.dish-photo');
      if (img) img.remove();
    }
    flipPlay(content, first);
  }
}

/* ---------- segmented switch + sliding thumb ---------- */

function updateSegmented() {
  const seg = document.querySelector('.segmented');
  if (seg) seg.dataset.meal = prefs.meal;   // CSS [data-meal=...] drives the thumb
  document.querySelectorAll('.seg-option').forEach((btn) => {
    const active = btn.dataset.meal === prefs.meal;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
}

/**
 * Keep the CSS-driven thumb in sync. Best practice for a segmented
 * control: the thumb is a fixed-width pill at the track origin and the
 * active state is expressed purely via CSS transform (translateX 0%→100%)
 * keyed off the container's data-meal attribute. No inline geometry —
 * measuring offsets here would fight the CSS transition and cause
 * double-shift (the bug this replaces).
 */
function positionThumb() {
  const seg = document.querySelector('.segmented');
  if (seg) seg.dataset.meal = prefs.meal;
}

/* ---------- raw panel ---------- */

function updateRawText() {
  rawFiltered = buildRawText();
  document.getElementById('raw-text').textContent =
    rawFiltered || 'No dishes available for the current selection.';
}

/* ---------- collapse animation (max-height) ---------- */

function expandBody(body) {
  body.style.maxHeight = body.scrollHeight + 'px';
  const onEnd = (e) => {
    if (e.propertyName === 'max-height') {
      body.style.maxHeight = 'none';
      body.removeEventListener('transitionend', onEnd);
    }
  };
  body._onExpandEnd = onEnd; // so an interrupted expand can be cleaned up
  body.addEventListener('transitionend', onEnd);
}

function collapseBody(body) {
  if (body._onExpandEnd) {
    body.removeEventListener('transitionend', body._onExpandEnd);
    body._onExpandEnd = null;
  }
  body.style.maxHeight = body.scrollHeight + 'px';
  void body.offsetHeight; // force reflow so the transition actually runs
  body.style.maxHeight = '0px';
}

/* ------------------------------------------------------------
   7. Event handlers
   ------------------------------------------------------------ */

function bindEvents() {
  // The single hamburger both opens AND closes the drawer (it slides to
  // the top-right corner while open, so it stays visible/tappable).
  document.getElementById('menu-btn').addEventListener('click', toggleSelector);
  document.querySelector('.segmented').addEventListener('click', onSegmentedClick);

  const photoRow = document.getElementById('photo-row');
  photoRow.addEventListener('click', onPhotoToggleClick);
  photoRow.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onPhotoToggleClick();
    }
  });

  const mensaList = document.querySelector('.selector-mensas');
  mensaList.addEventListener('click', onMensaListClick);
  mensaList.addEventListener('keydown', onMensaListKeydown);

  document.querySelector('.selector-groups').addEventListener('click', onGroupsClick);
  document.getElementById('group-add-btn').addEventListener('click', addCustomGroup);
  document.getElementById('group-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addCustomGroup();
  });

  const content = document.getElementById('content');
  content.addEventListener('click', onContentClick);
  content.addEventListener('keydown', onContentKeydown);

  document.getElementById('raw-toggle').addEventListener('click', toggleRaw);
  document.getElementById('copy-btn').addEventListener('click', copyRaw);

  window.addEventListener('resize', positionThumb);
  window.addEventListener('load', positionThumb); // fonts/layout settle

  // Esc closes the drawer (accessibility best practice).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('menu-open')) {
      closeSelector();
    }
  });
}

/** Hamburger: slide the #selector drawer in/out.
    Mobile: the .app content is pushed aside (CSS body.menu-open .app).
    Desktop: the drawer overlays the left margin. */
function toggleSelector() {
  const open = document.body.classList.toggle('menu-open');
  setSelectorOpen(open);
}

function closeSelector() {
  document.body.classList.remove('menu-open');
  setSelectorOpen(false);
}

let unlockScrollTimer = null;

function setSelectorOpen(open) {
  const panel = document.getElementById('selector');
  panel.classList.toggle('open', open);
  panel.setAttribute('aria-hidden', String(!open));
  document.getElementById('menu-btn').setAttribute('aria-expanded', String(open));
  // Scroll lock while the drawer is open (Bootstrap-offcanvas pattern).
  // Prevents background scrolling that breaks position:fixed on iOS
  // (drawer would "jump" to the scroll position instead of the left edge).
  // On close, the lock is removed ONLY after the slide-out finishes:
  // removing it mid-animation forces a full layout reflow that janks the
  // return transition (the "return sticks" bug).
  const root = document.documentElement;
  if (open) {
    clearTimeout(unlockScrollTimer);
    root.classList.add('scroll-locked');
  } else {
    clearTimeout(unlockScrollTimer);
    // 320ms > 300ms transition + small margin; cleared on reopen.
    unlockScrollTimer = setTimeout(() => root.classList.remove('scroll-locked'), 320);
  }
}

function onSegmentedClick(e) {
  const btn = e.target.closest('.seg-option');
  if (!btn || btn.dataset.meal === prefs.meal) return;
  prefs.meal = btn.dataset.meal;
  savePrefs();
  updateSegmented(); // animates the thumb
  renderContent();   // keyed reconcile: only changed dishes animate
  updateRawText();
}

function onMensaListClick(e) {
  const row = e.target.closest('.mensa-row');
  if (row) toggleMensa(row.dataset.mensa);
}

function onMensaListKeydown(e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('.mensa-row');
  if (!row) return;
  e.preventDefault();
  toggleMensa(row.dataset.mensa);
}

function toggleMensa(id) {
  if (prefs.selected.has(id)) prefs.selected.delete(id);
  else prefs.selected.add(id);
  savePrefs();
  refreshMensaRows();
  renderGroupList();
  renderContent();
  updateRawText();
  // NOTE: no auto-close — the drawer stays usable for multi-select;
  // the user closes it via the hamburger (slides back to the top-left).
}

function onGroupsClick(e) {
  // The chip's (x) deletes a custom group without applying it.
  const x = e.target.closest('.chip-x');
  if (x) {
    const chip = x.closest('.group-chip');
    if (chip) deleteCustomGroup(chip.dataset.group);
    return;
  }
  // Clicking a chip applies the group: the selection is replaced by
  // that group's members.
  const chip = e.target.closest('.group-chip');
  if (chip) applyGroup(chip.dataset.group);
}

/** Apply a group (default or custom): REPLACE the current selection
    with the group's members (not a union). */
function applyGroup(name) {
  const members = groupMembers(name);
  if (!members.length) return;
  prefs.selected = new Set(members);
  savePrefs();
  refreshMensaRows();
  renderGroupList();
  renderContent();
  updateRawText();
  // NOTE: no auto-close (same as toggleMensa) — drawer stays usable
  // until the user closes it via the hamburger.
}

function deleteCustomGroup(name) {
  delete prefs.customGroups[name];
  savePrefs();
  renderGroupList();
}

/** Create a custom group whose members = currently selected mensas.
    Recreating with an existing name redefines its members (update). */
function addCustomGroup() {
  const input = document.getElementById('group-input');
  const name = input.value.trim();
  if (!name) {
    showGroupMsg('Enter a group name');
    return;
  }
  if (DEFAULT_GROUPS.includes(name)) {
    showGroupMsg('That name is reserved');
    return;
  }
  prefs.customGroups[name] = Array.from(prefs.selected);
  savePrefs();
  renderGroupList();
  input.value = '';
  showGroupMsg('');
}

let groupMsgTimer = null;
function showGroupMsg(text) {
  const msg = document.getElementById('group-add-msg');
  msg.textContent = text;
  clearTimeout(groupMsgTimer);
  if (text) groupMsgTimer = setTimeout(() => { msg.textContent = ''; }, 2000);
}

function onContentClick(e) {
  const title = e.target.closest('.mensa-title');
  if (title) toggleSection(title.closest('.mensa-section'));
}

function onContentKeydown(e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const title = e.target.closest('.mensa-title');
  if (!title) return;
  e.preventDefault();
  toggleSection(title.closest('.mensa-section'));
}

/** Collapse/expand one mensa section; state persists in prefs. */
function toggleSection(section) {
  const id = section.dataset.mensa;
  const collapsed = prefs.collapsedMensas.has(id);
  const body = section.querySelector('.mensa-dishes');
  const title = section.querySelector('.mensa-title');

  if (collapsed) {
    prefs.collapsedMensas.delete(id);
    section.classList.remove('collapsed');
    if (body) expandBody(body);
  } else {
    prefs.collapsedMensas.add(id);
    section.classList.add('collapsed');
    if (body) collapseBody(body);
  }
  if (title) title.setAttribute('aria-expanded', String(!collapsed));
  savePrefs();
}

function toggleRaw() {
  const panel = document.getElementById('raw-panel');
  const btn = document.getElementById('raw-toggle');
  const open = panel.classList.toggle('open');
  btn.textContent = open ? 'Hide Raw Data' : 'Show Raw Data';
  btn.setAttribute('aria-expanded', String(open));
  // Same max-height disclosure as the mensa sections — the panel
  // glides open/closed instead of popping (display:none flash).
  if (open) expandBody(panel);
  else collapseBody(panel);
}

function copyRaw() {
  const btn = document.getElementById('copy-btn');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(rawFiltered)
      .then(() => flashCopied(btn))
      .catch(() => fallbackCopy(btn));
  } else {
    fallbackCopy(btn);
  }
}

/** execCommand fallback for older browsers / non-secure contexts. */
function fallbackCopy(btn) {
  const ta = document.createElement('textarea');
  ta.value = rawFiltered;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    flashCopied(btn);
  } catch (err) {
    /* ignore — nothing sensible to do */
  }
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

/* ------------------------------------------------------------
   8. Boot
   ------------------------------------------------------------ */

async function init() {
  document.getElementById('date-heading').textContent = formatDate(DATE_STR);
  bindEvents();
  prefs = loadPrefs();

  try {
    const json = await fetchData();
    data = { date: json.date, mensas: normalizeMensas(json.mensas) };
    validatePrefsAgainstData();
    renderAll(); // silent first paint — animations stay disabled
    animEnabled = true; // from here on, user interactions animate
    positionThumb();
  } catch (err) {
    console.error(err);
    document.getElementById('content').innerHTML =
      '<div class="error">Failed to load menu data. Please try again later.</div>';
  }

  // Re-position the thumb once webfonts settle (widths may shift).
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => positionThumb()).catch(() => {});
  }
}

init();
