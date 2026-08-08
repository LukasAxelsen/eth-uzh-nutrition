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
const DATE_STR = '2026-08-08';
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
//   { meal, selected: [ids], customGroups: {name: [ids]}, collapsedMensas: [ids] }
let prefs = {
  meal: 'Lunch',
  selected: new Set(),
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
  const p = { meal: 'Lunch', selected: new Set(), customGroups: {}, collapsedMensas: new Set() };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return p;
    const parsed = JSON.parse(raw);
    if (parsed.meal === 'Lunch' || parsed.meal === 'Dinner') p.meal = parsed.meal;
    if (Array.isArray(parsed.selected)) p.selected = new Set(parsed.selected.map(String));
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
  renderSelector();
  renderContent();
  updateRawText();
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

function dishHTML(d) {
  const nutrition = d.nutrition || { p100: {}, total: {} };
  // The label is dropped when it duplicates the dish name (Rice Up!
  // publishes "Rice Up! Bowl" as both line and dish).
  const line = String(d.line || '').trim();
  const dish = String(d.dish || '').trim();
  const label = line && line.toLowerCase() !== dish.toLowerCase() ? line : '';
  return '<div class="dish">' +
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
      ? dishes.map(dishHTML).join('')
      : '<div class="no-meals">' + EMPTY_MEALS_TEXT + '</div>') +
    '</div>';

  return '<section class="mensa-section' + (collapsed ? ' collapsed' : '') + '" data-mensa="' + esc(m.id) + '">' +
    '<h2 class="mensa-title" role="button" tabindex="0" aria-expanded="' + !collapsed + '">' +
    '<span class="mensa-caret" aria-hidden="true"></span>' +
    esc(m.name) +
    '</h2>' + body +
    '</section>';
}

function renderContent() {
  const content = document.getElementById('content');
  const selected = data.mensas.filter((m) => prefs.selected.has(m.id));

  if (!selected.length) {
    content.innerHTML = '<div class="no-meals">' + EMPTY_MEALS_TEXT + '</div>';
    return;
  }
  content.innerHTML = selected.map(mensaSectionHTML).join('');
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
  renderContent();   // only this meal slot's dishes
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
    renderAll();
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
