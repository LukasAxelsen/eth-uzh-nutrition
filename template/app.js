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
   in this file are TRANSIENT animation state only (heights/
   transitions applied while an animation runs); they take
   precedence over stylesheet rules and are always cleaned up on
   transitionend. Geometry, tokens and steady-state styles live
   in style.css.
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
  { label: 'Saturated fat', key: 'saturated' },
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

// Normalized data.json contents: { date, days: {ISO: {mensas}},
// availableDates: [ISO...] }. `data.days[state.date].mensas` is the
// ACTIVE dataset — every render reads from it.
let data = null;

// Selected calendar date (ISO). Starts at the served date, changes via
// the calendar popover. NOT persisted: the menu site is a "today"
// product; a remembered past date would confuse the next visit.
let selectedDate = '';

// Precomputed once when data.json loads: every ISO date that carries at
// least one dish. data.days is immutable after load, so the Set never
// goes stale — the calendar's per-cell hasData() scans become O(1)
// lookups (renderCalendar builds ~40 cells, each scanning every mensa).
let dataDates = new Set();

// User preferences. Sets for membership (fast lookup), plain object
// for custom groups. Mirrors the localStorage schema exactly:
//   { meal, selected: [ids], photos: bool, theme: 'light'|'dark'|'auto',
//     customGroups: {name: [ids]}, collapsedMensas: [ids] }
let prefs = {
  meal: 'Lunch',
  selected: new Set(),
  photos: true,   // photos ON by default (product owner)
  theme: 'light',
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
  const p = { meal: 'Lunch', selected: new Set(), photos: true, openingTimes: true, prices: true, theme: 'light', customGroups: {}, collapsedMensas: new Set() };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return p;
    const parsed = JSON.parse(raw);
    if (parsed.meal === 'Lunch' || parsed.meal === 'Dinner') p.meal = parsed.meal;
    if (Array.isArray(parsed.selected)) p.selected = new Set(parsed.selected.map(String));
    if (typeof parsed.photos === 'boolean') p.photos = parsed.photos;
    if (typeof parsed.openingTimes === 'boolean') p.openingTimes = parsed.openingTimes;
    if (typeof parsed.prices === 'boolean') p.prices = parsed.prices;
    if (parsed.theme === 'light' || parsed.theme === 'dark' || parsed.theme === 'auto') p.theme = parsed.theme;
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
      theme: prefs.theme,
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
  if (!json || !json.days || typeof json.days !== 'object') {
    throw new Error('Unexpected data.json shape');
  }
  // Normalize every day's mensas up front (one pass, cached per day).
  const days = {};
  for (const [iso, day] of Object.entries(json.days)) {
    days[iso] = normalizeMensas(day.mensas || []);
  }
  // One pass over the normalized days: precompute which dates actually
  // carry dishes (the same logic the old hasData ran per calendar cell).
  dataDates = new Set(
    Object.entries(days)
      .filter(([, mensas]) => mensas.some((m) => m.meals.Lunch.length || m.meals.Dinner.length))
      .map(([iso]) => iso)
  );
  return { date: json.date, days, availableDates: json.availableDates || [] };
}

/** Guarantee every mensa has id/name/group, Lunch/Dinner arrays and
    opening hours (the hours-line reads them — dropping them here made
    every mensa show "Not open today"). */
function normalizeMensas(raw) {
  return raw.map((m) => ({
    id: String(m.id),
    name: m.name || String(m.id),
    group: m.group || 'Other',
    opening: {
      Lunch: (m.opening && m.opening.Lunch) || null,
      Dinner: (m.opening && m.opening.Dinner) || null,
    },
    meals: {
      Lunch: Array.isArray(m.meals && m.meals.Lunch) ? m.meals.Lunch : [],
      Dinner: Array.isArray(m.meals && m.meals.Dinner) ? m.meals.Dinner : [],
    },
  }));
}

/** Drop stale ids (closed mensas etc.), default selection to Central. */
function validatePrefsAgainstData() {
  const ids = new Set(activeMensas().map((m) => m.id));

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

/** The ACTIVE dataset: the selected day's mensas. Every render reads
    through this so switching the calendar date automatically feeds the
    whole pipeline (content, selector, raw text) — no per-feature wiring. */
function activeMensas() {
  return (data && data.days[selectedDate]) || [];
}

function mensaById(id) {
  return activeMensas().find((m) => m.id === id) || null;
}

/** All mensas belonging to a default group (data order). */
function mensasInGroup(group) {
  return activeMensas().filter((m) => m.group === group);
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
  for (const m of activeMensas()) {
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

/**
 * The unified animation pipeline (Vue TransitionGroup / react-flip-toolkit
 * declarative model, vanilla): ALL dynamic containers register here; ANY
 * state change funnels through renderAll() which measures every container,
 * applies every diff, then FLIPs everything that moved in one pass.
 *
 * Extending the site: add a new dynamic element to this list and make its
 * children keyed (data-key) — it inherits smooth move animations with no
 * new code and no edge cases. Non-keyed or unchanged children never move
 * and never re-render.
 */
const FLIP_CONTAINERS = () => [
  document.getElementById('content'),
  document.querySelector('.selector-mensas'),
  document.querySelector('.group-rows'),
];

/** Full re-render of everything derived from state — the ONE render entry
    point. Order: snapshot every container -> mutate all DOM (reconciles
    use doFlip=false) -> FLIP all containers once. */
function renderAll() {
  const content = document.getElementById('content');
  // Coalesce a still-running content glide BEFORE measuring: the old
  // glide's inline height would otherwise be read as the "current"
  // height (oldH) AND as the post-render height (newH), locking the
  // layout to a stale mid-flight value — rapid date toggling then
  // never settles and the page feels stuck. Snap to natural height,
  // then measure and glide cleanly from true old -> true new.
  if (content._heightGlideEnd) settleContentHeight(content);
  // Coalesce in-flight disclosure animations (expandBody): their
  // max-height lock was measured against the PRE-render content. The
  // render below rebuilds dishes (meal/date switch, photo toggle), so
  // the old lock would clip the new content or snap at transitionend.
  // Same philosophy as the glide coalesce above — snap the disclosure
  // to its natural height; the next open/close animates cleanly.
  for (const el of content.querySelectorAll('.mensa-dishes, .calendar, #raw-panel')) {
    if (el._expandTimer) {
      clearTimeout(el._expandTimer);
      el._expandTimer = null;
      if (el._onExpandEnd) {
        el.removeEventListener('transitionend', el._onExpandEnd);
        el._onExpandEnd = null;
      }
      el.style.maxHeight = 'none';
    }
  }
  const snapshots = FLIP_CONTAINERS().map((c) => [c, flipFirst(c)]);
  updateSegmented();
  updatePhotoToggle();
  updateOpeningToggle();
  updatePriceToggle();
  updateAppearance();
  renderSelector();
  const oldH = content.getBoundingClientRect().height;
  renderContent();
  updateHoursLines(); // sections survive meal switches — refresh the text
  applyPhotos(); // idempotent <img> sync — BEFORE the height measurement:
                // fresh dishes insert photos at natural height so newH
                // includes them (a glide to a photo-less height would
                // jump by the photo stack when the inline height drops);
                // reused dishes (photo toggle) keep their 0->natural
                // grow animation, which drives the height itself.
  const newH = content.getBoundingClientRect().height;
  // Content-height glide: when the day/meal swap dishes wholesale (no
  // section entering or exiting), lock the OLD height and glide to the
  // new one — the dish swap itself is instant, but the layout glides
  // smoothly instead of jumping (the date/meal-switch "flash"
  // regression). Fresh sections (checkbox adds) are exempt: their own
  // grow animation drives the height continuously. Exiting nodes
  // (animateExit shrinks) likewise drive the height themselves, so a
  // glide on top would fight them.
  if (!content.querySelector('[data-entering]') &&
      !content.querySelector('[data-exiting]') &&
      Math.abs(newH - oldH) > 2 && animationsAllowed()) {
    animateContentHeight(content, oldH, newH);
  } else {
    settleContentHeight(content); // also clears any stale timer/listener
  }
  updateRawText();
  for (const [c, first] of snapshots) flipPlay(c, first);
}

/* ---------- keyed reconciliation + FLIP (Vue TransitionGroup pattern) ----------
   Every mensa section and dish carries a stable data-key. On re-render we
   diff the key lists: nodes with an existing key are REUSED untouched (no
   diff => no re-render, no animation); new keys fade/slide in; removed
   keys disappear; surviving nodes whose position changed slide smoothly
   via FLIP (First-Last-Invert-Play, transform-only, 60fps). This replaces
   the full innerHTML swap that used to snap, and the View-Transition
   snapshot approach that caused jank on height changes. */

const ANIM_MS = 450;
// Apple's standard easing (HIG "ease"): strong ease-out — instant
// response, long graceful settle. This is the single curve for ALL
// content animation (FLIP, disclosures); keep in sync with --ease in
// style.css.
const ANIM_EASE = 'cubic-bezier(.32, .72, 0, 1)';

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
  // A container with entering/exiting nodes skips FLIP entirely: the
  // enter/exit height transitions drive layout continuously (siblings
  // slide with the growth/shrink). FLIP here would measure the
  // mid-animation layout and fight it with a reverse displacement
  // (the date-switch "flash").
  if (container.querySelector('[data-entering]') ||
      container.querySelector('[data-exiting]')) return;
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

/** Enter animation for a freshly reconciled node: it grows from 0 height
    to its natural height (same choreography as the photo open — the
    layout-animation primitive of this site). The node is inserted at
    0 height so it does NOT shove its siblings down; on the next frame
    the natural height is measured and a height transition grows it,
    which smoothly pushes everything below it. No fades, no FLIP needed
    for the enter itself (the sibling FLIP pass measures ~0 delta and
    stays out of the way). Also the site-wide default for ADDED content:
    every new section/dish/chip enters this way — no per-feature wiring.
    Call right after the node is inserted and populated. */
function animateEnter(node) {
  if (!animationsAllowed() || !node.isConnected) return;
  node.dataset.entering = '1';
  // Inline the height transition for the grow (the node's own CSS may
  // not transition height — e.g. .mensa-section doesn't), APPENDED to
  // any existing transition so state feedback (hover etc.) keeps
  // working during the grow. Cleaned up with the height afterwards.
  const cur = getComputedStyle(node).transition;
  // Defensive: 'none' or the default must not be prepended — "none,
  // height ..." is an invalid transition list that silently kills the
  // animation. Only append to a real transition (e.g. 'all').
  node.style.transition = (cur && cur !== 'all 0s ease 0s' && cur !== 'none'
                           ? cur + ', ' : '') +
                          'height .45s ' + ANIM_EASE;
  node.style.height = '0';
  node.style.overflow = 'hidden';
  requestAnimationFrame(() => {
    if (!node.isConnected) return;
    node.style.height = 'auto';
    const h = node.offsetHeight; // natural height
    node.style.height = '0px';
    void node.offsetHeight; // reflow: transition starts from 0
    node.style.height = h + 'px';
    node.style.overflow = '';
    // Drop the inline height once grown so layout stays responsive.
    const onEnd = (e) => {
      if (e.propertyName === 'height') {
        node.style.height = '';
        node.style.transition = '';
        delete node.dataset.entering;
        node.removeEventListener('transitionend', onEnd);
        if (node._enterTimer) { clearTimeout(node._enterTimer); node._enterTimer = null; }
      }
    };
    node.addEventListener('transitionend', onEnd);
    // Fallback: transitionend may never fire (interrupted transition,
    // background tab) — clear the enter state anyway (same pattern as
    // animateExit / glide / expandBody).
    node._enterTimer = setTimeout(() => {
      if (node.dataset.entering) {
        node.style.height = '';
        node.style.transition = '';
        node.style.overflow = '';
        delete node.dataset.entering;
      }
    }, 600); // 450ms transition + margin; transitionend is the normal path
  });
}

/** Exit animation — the mirror of animateEnter (AnimatePresence /
    Vue TransitionGroup "leave" hook, vanilla): a node leaving the list
    shrinks from its natural height to 0, and is physically removed only
    after the shrink finishes (deferred removal). During the shrink the
    node still occupies flow, so siblings slide up continuously — no
    FLIP needed, no jump. Reconcile ignores nodes marked data-exiting;
    a key that reappears while its node is still shrinking is REVIVED
    (reviveExit) instead of removed. Same transition-list 'none' poison
    guard as animateEnter. */
function animateExit(node) {
  if (!node.isConnected) return;
  if (node.dataset.exiting) return; // already exiting — let it finish
  if (node.dataset.entering) {
    // An entering node is being removed (rapid toggling): hand over to
    // the exit cleanly — the enter timer/state must not linger.
    if (node._enterTimer) { clearTimeout(node._enterTimer); node._enterTimer = null; }
    delete node.dataset.entering;
  }
  if (!animationsAllowed()) { node.remove(); return; }
  node.dataset.exiting = '1';
  const cur = getComputedStyle(node).transition;
  node.style.transition = (cur && cur !== 'all 0s ease 0s' && cur !== 'none'
                           ? cur + ', ' : '') +
                          'height .45s ' + ANIM_EASE;
  const h = node.offsetHeight; // natural height (before shrinking)
  node.style.height = h + 'px';
  node.style.overflow = 'hidden';
  void node.offsetHeight; // reflow: lock current height, then shrink
  node.style.height = '0px';
  const onEnd = (e) => {
    if (e.propertyName === 'height') {
      if (node._exitTimer) { clearTimeout(node._exitTimer); node._exitTimer = null; }
      node.remove();
    }
  };
  node.addEventListener('transitionend', onEnd);
  // Fallback: transitionend may never fire (interrupted transition,
  // background tab, sub-pixel target) — remove anyway (MDN: the event
  // is not generated when a transition is removed before completion).
  node._exitTimer = setTimeout(() => {
    if (node.isConnected) node.remove();
  }, 600); // 450ms transition + margin; transitionend is the normal path
}

/** Cancel an in-flight exit when the node's key reappears in the same
    render (rapid toggling): restore natural height, drop all exit
    state, so the node is reused normally instead of being removed. */
function reviveExit(node) {
  if (!node.dataset.exiting) return;
  if (node._exitTimer) { clearTimeout(node._exitTimer); node._exitTimer = null; }
  node.style.transition = '';
  node.style.height = '';
  node.style.overflow = '';
  delete node.dataset.exiting;
}

/** The idx-th child that is NOT exiting (exiting nodes are shrinking
    away and must not be used as insertion anchors). */
function nextLiveChild(container, idx) {
  let i = 0;
  for (const child of container.children) {
    if (child.dataset.exiting) continue;
    if (i === idx) return child;
    i++;
  }
  return null;
}

/** Keyed reconciliation: keep existing nodes in order, create missing ones
    via makeEl(key), drop stale ones. No enter/leave fades — newly added
    nodes grow in from 0 height (animateEnter), and every surviving node
    whose position changed slides smoothly via FLIP (the Vue
    TransitionGroup move choreography: the list "makes room" for
    additions/removals instead of popping).
    The FLIP pass itself is orchestrated by renderAll() (doFlip stays
    false there); standalone callers may pass doFlip=true. */
function reconcileChildren(container, keys, makeEl, doFlip, enter = true) {
  const first = flipFirst(container);
  const existing = new Map();
  for (const child of container.children) {
    if (child.dataset.key) existing.set(child.dataset.key, child);
  }
  const seen = new Set();
  const added = [];

  // Walk the desired order with an index into the live children: a node
  // that is ALREADY at its target position is left untouched — calling
  // appendChild on a positioned node forces a reflow that kills any
  // in-flight CSS transition (e.g. the .mensa-check dot scale) on the
  // very next style change. Exiting nodes (shrinking away) are skipped
  // as anchors — a key that reappears while its node is still exiting
  // is REVIVED instead of duplicated.
  let targetIdx = 0;
  for (const key of keys) {
    let node = existing.get(key);
    if (node && node.dataset.exiting) reviveExit(node);
    if (!node) {
      node = makeEl(key);
      node.dataset.key = key;
      container.insertBefore(node, nextLiveChild(container, targetIdx) || null);
      added.push(node);
    } else if (nextLiveChild(container, targetIdx) !== node) {
      container.insertBefore(node, nextLiveChild(container, targetIdx) || null);
    }
    seen.add(key);
    targetIdx++;
  }

  // Drop stale keyed nodes AND any keyless leftovers (e.g. a no-meals
  // div from a previous render path). Nodes shrink away first
  // (animateExit — deferred removal), so siblings slide up smoothly;
  // a node already exiting is left to finish. Every surviving child
  // must be keyed and present in the new list. KEYLESS nodes are
  // removed IMMEDIATELY (no exit animation): they are dirty data —
  // e.g. an outerHTML-replaced section that lost its data-key would
  // otherwise linger as a duplicate while animating out and be
  // re-triggered on every render (the duplicate-section bug).
  // Nodes whose ANCESTOR is already exiting (e.g. dishes inside a
  // section being removed) are silently dropped — the ancestor's
  // shrink with overflow:hidden clips them, so per-dish exits are
  // wasted transitions that fight the section-level exit and cause
  // layout thrash (the checkbox-remove stutter).
  for (const child of Array.from(container.children)) {
    if (child.dataset.exiting) continue;
    if (!child.dataset.key) {
      child.remove();
    } else if (!seen.has(child.dataset.key)) {
      if (enter && !child.closest('[data-exiting]')) animateExit(child);
      else child.remove();
    }
  }

  // Enter choreography for freshly added nodes: grow from 0 height.
  // Deferred to the end so all siblings are in their final positions
  // before the measurement frame runs. A node whose ANCESTOR is already
  // entering (e.g. a dish inside a freshly added section) is skipped —
  // the outer grow carries it, and a nested grow would corrupt the outer
  // measurement (the section would measure the dishes at 0 height and
  // clip their growth). Standalone adds (new section, new chip, dishes
  // swapped by a meal switch inside a SURVIVING section) animate.
  if (enter) {
    for (const node of added) {
      if (node.closest('[data-entering]')) continue;
      animateEnter(node);
    }
  }

  if (doFlip === true) flipPlay(container, first);
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
  // Photo toggle is a plain state change — the unified renderAll()
  // pipeline diffs everything (including the idempotent <img> sync in
  // applyPhotos) and FLIPs all moved containers in one pass.
  renderAll();
}

/* Opening-times / prices settings: plain CSS-class toggles (the
   .hours-line-wrap / .price-wrap strips slide via max-height), so NO
   renderAll — the DOM stays untouched, only html gets the class. */
function updateOpeningToggle() {
  const row = document.getElementById('opening-row');
  if (!row) return;
  row.classList.toggle('selected', prefs.openingTimes);
  row.setAttribute('aria-pressed', String(prefs.openingTimes));
  document.documentElement.classList.toggle('show-opening', prefs.openingTimes);
}

function onOpeningToggleClick() {
  prefs.openingTimes = !prefs.openingTimes;
  savePrefs();
  updateOpeningToggle();
}

function updatePriceToggle() {
  const row = document.getElementById('price-row');
  if (!row) return;
  row.classList.toggle('selected', prefs.prices);
  row.setAttribute('aria-pressed', String(prefs.prices));
  document.documentElement.classList.toggle('show-prices', prefs.prices);
}

function onPriceToggleClick() {
  prefs.prices = !prefs.prices;
  savePrefs();
  updatePriceToggle();
}

/* ---------- appearance (light/dark/auto) ---------- */

/** Apply prefs.theme to <html data-theme> and drive the appearance
    segmented thumb (CSS container-transform, same as Lunch/Dinner). */
function updateAppearance() {
  document.documentElement.dataset.theme = prefs.theme;
  const seg = document.getElementById('appearance-seg');
  if (!seg) return;
  seg.dataset.theme = prefs.theme; // CSS --seg-index moves the thumb
  seg.querySelectorAll('.seg-option').forEach((btn) => {
    const active = btn.dataset.theme === prefs.theme;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
}

function onAppearanceClick(e) {
  const btn = e.target.closest('.seg-option');
  if (!btn || btn.dataset.theme === prefs.theme) return;
  prefs.theme = btn.dataset.theme;
  savePrefs();
  // Theme variables change on <html>; the CSS transition on body/colors
  // cross-fades the palette (smooth dark-mode switch).
  updateAppearance();
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
  // Keyed reconcile: rows are keyed by mensa id, so toggling a selection
  // reuses the DOM node (only the .selected class flips via CSS) and the
  // list never re-renders wholesale. Same pipeline as #content.
  reconcileChildren(container, activeMensas().map((m) => m.id), (key) => {
    const row = document.createElement('div');
    row.innerHTML = mensaRowHTML(mensaById(key));
    return row.firstChild;
  });
  refreshMensaRows(); // sync .selected class on (possibly reused) rows
}

/** In-place update of every mensa row (preserves scroll position).
    The filled dot is drawn by CSS (.mensa-check::after) — no text.
    NOTE: skip rows without data-mensa (e.g. the photo-row in Setting,
    which is a .mensa-row for styling but is NOT a selectable mensa). */
function refreshMensaRows() {
  document.querySelectorAll('.mensa-row').forEach((row) => {
    if (!row.dataset.mensa) return;
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

  // Build the FULL group catalog: default groups (fixed order), then every
  // data group not covered, then custom groups. members comes from
  // groupMembers(name) — the SAME function applyGroup uses — so the badge
  // count, the applied selection and the active highlight can never
  // disagree (the old bug: data groups were built with only the first
  // mensa, so after applying the group the members never matched the
  // selection and the chip never turned black).
  const groups = [];
  const seen = new Set();
  const pushGroup = (name, custom) => {
    if (!name || seen.has(name)) return;   // dedupe (defensive)
    seen.add(name);
    groups.push({ name, members: groupMembers(name), custom });
  };
  DEFAULT_GROUPS.forEach((name) => pushGroup(name, false));
  activeMensas().forEach((m) => pushGroup(m.group, false));
  Object.keys(prefs.customGroups).forEach((name) => pushGroup(name, true));

  // Keyed reconcile: chips are keyed by group name, so adding/removing a
  // custom group slides the remaining chips into place (FLIP) instead of
  // rebuilding the whole row with a flash.
  reconcileChildren(container, groups.map((g) => g.name), (key) => {
    const chip = document.createElement('div');
    chip.innerHTML = groupRowHTML(groups.find((g) => g.name === key));
    return chip.firstChild;
  });

  // Active state: the group whose members exactly match the current
  // selection is highlighted (CSS transition, no rebuild).
  const active = (g) => g.members.length > 0 &&
    g.members.length === prefs.selected.size &&
    g.members.every((id) => prefs.selected.has(id));
  container.querySelectorAll('.group-chip').forEach((chip) => {
    const g = groups.find((x) => x.name === chip.dataset.group);
    chip.classList.toggle('active', !!(g && active(g)));
  });
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
  // The photo URL rides as data-photo: the <img> itself is inserted and
  // removed by applyPhotos() WITHOUT rebuilding the dish node, so toggling
  // photos never re-renders the dish text/nutrition (no flash). The dish
  // key deliberately excludes the photo bit for the same reason.
  const photo = d.photo ? ' data-photo="' + esc(d.photo) + '"' : '';
  const price = priceHTML(d);
  return '<div class="dish"' + keyAttr + photo + '>' +
    '<div class="dish-main">' +
    (label
      ? '<div class="dish-label">' + esc(label) + price + '</div>'
      : '') +
    '<h3 class="dish-name">' + esc(dish) + (label ? '' : price) + '</h3>' +
    (d.desc ? '<p class="dish-desc">' + esc(d.desc) + '</p>' : '') +
    '</div>' +
    '<div class="nutrition-col">' + nutritionTableHTML(nutrition) + '</div>' +
    '</div>';
}

/** Price suffix: "STUD 7.90 | INT 10.90 | EXT 13.90" — grey, small,
    after the grey line label (or the dish name when the label is
    dropped). Wrapped in .price-wrap so the Show prices setting can
    slide it open/closed (max-height transition, symmetric ease). */
function priceHTML(d) {
  const prices = d.price || [];
  if (!prices.length) return '';
  const parts = prices.map((p) => esc(String(p.label)) + ' ' + Number(p.value).toFixed(2));
  const unit = d.priceUnit === '100 g' ? ' / 100g' : '';
  return '<span class="price-wrap" aria-hidden="true">' +
    '<span class="dish-price">' + parts.join(' | ') + unit + '</span>' +
    '</span>';
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
  // Closed slot (no meals this meal): NO expand/collapse at all — no
  // caret, no content body, title not interactive; the hours strip
  // ALWAYS shows "No meals available" (independent of the Show opening
  // times setting).
  const slotClosed = !dishes.length;

  // .mensa-dishes is the collapsible body. The collapsed state is a
  // CLASS (.mensa-section.collapsed -> max-height:0) and the transition
  // lives in style.css with the --ease token — no inline transition:
  // an inline one would smuggle a second easing curve past the
  // contract verifier (which only greps stylesheet text).
  const body = '<div class="mensa-dishes">' +
    (dishes.length
      ? dishes.map((d, i) => dishHTML(d, dishKey(m, d, i))).join('')
      : '<div class="no-meals">' + EMPTY_MEALS_TEXT + '</div>') +
    '</div>';

  // Opening hours strip: "No meals available" when the slot is
  // closed (always visible, setting-independent); the current meal
  // slot's hours otherwise (slid by the Show opening times setting).
  // The text is rendered HERE (not left for updateHoursLines) so a
  // section created by outerHTML replacement is complete from birth —
  // a text-less duplicate was the "no hours shown" repeat bug.
  const hoursText = slotClosed
    ? 'No meals available'
    : ((m.opening || {})[prefs.meal] || 'Not open today');
  return '<section class="mensa-section' +
    (slotClosed ? ' no-meal-slot' : collapsed ? ' collapsed' : '') +
    '" data-mensa="' + esc(m.id) + '" data-key="' + esc(m.id) + '">' +
    '<h2 class="mensa-title"' +
    (slotClosed ? '' : ' role="button" tabindex="0" aria-expanded="' + !collapsed + '"') +
    '>' +
    (slotClosed
      ? ''
      : '<svg class="mensa-caret" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M2.5 3.5 6 8.5 9.5 3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>') +
    '<span class="mensa-name">' + esc(m.name) + '</span>' +
    '<span class="hours-line-wrap" aria-hidden="' + slotClosed + '">' +
    '<span class="hours-line">' + esc(hoursText) + '</span>' +
    '</span>' +
    '</h2>' +
    (slotClosed ? '' : body) +
    '</section>';
}

/** Sync every section's closed-slot shape + hours text.
    Sections are keyed-reused across meal switches — a section that
    OPENS when the meal changes (and vice versa) must rebuild its
    header/body (no caret, no body, "No meals available" strip) or the
    stale open shape lingers. Shape change rebuilds via
    mensaSectionHTML (no animation: no entering/exiting nodes);
    unchanged shape only refreshes the hours text. */
function updateHoursLines() {
  for (const section of document.querySelectorAll('.mensa-section')) {
    const m = mensaById(section.dataset.mensa);
    if (!m) continue;
    const slotClosed = !(m.meals[prefs.meal] || []).length;
    const shaped = section.classList.contains('no-meal-slot');
    if (slotClosed !== shaped) {
      // Full replace (mensaSectionHTML returns a complete <section>);
      // no animation — no entering/exiting nodes are involved.
      section.outerHTML = mensaSectionHTML(m);
      continue;
    }
    const line = section.querySelector('.hours-line');
    if (!line) continue;
    if (slotClosed) {
      line.textContent = 'No meals available';
      continue;
    }
    const hours = (m.opening || {})[prefs.meal];
    line.textContent = hours || 'Not open today';
  }
}

/** Stable key for one dish inside its mensa: meal slot + line + name.
    Deliberately EXCLUDES the photo state: photos are toggled by
    applyPhotos() as a pure <img> insert/remove inside the (reused) dish
    node, so the dish itself never rebuilds and never flashes. */
function dishKey(m, d, i) {
  // NOTE: index MUST be the last segment — reconcileChildren's makeEl
  // recovers the dish via key.split('|').pop().
  return prefs.meal + '|' + (d.line || '') + '|' + (d.dish || '') + '|' + i;
}

/**
 * Keyed re-render of #content. Mensa sections are reconciled by mensa id;
 * dishes inside each section by dishKey. Nodes with unchanged keys are
 * REUSED (no re-render, no animation). FLIP is orchestrated by renderAll()
 * — this function only performs the diffs. First paint stays silent.
 */
function renderContent() {
  const content = document.getElementById('content');
  const selected = activeMensas().filter((m) => prefs.selected.has(m.id));

  if (!selected.length) {
    reconcileChildren(content, ['__empty__'], () => {
      const div = document.createElement('div');
      div.className = 'no-meals';
      div.textContent = EMPTY_MEALS_TEXT;
      return div;
    }, false, true);
    return;
  }

  // Section level: key = mensa id. Reuse existing sections untouched.
  reconcileChildren(content, selected.map((m) => m.id), (key) => {
    const section = document.createElement('section');
    section.innerHTML = mensaSectionHTML(mensaById(key));
    return section.firstChild;
  });

  // Dish level inside each surviving section.
  for (const section of content.querySelectorAll('.mensa-section')) {
    const m = mensaById(section.dataset.mensa);
    if (!m) continue;
    const body = section.querySelector('.mensa-dishes');
    if (!body) continue; // closed slots render no body at all
    const dishes = m.meals[prefs.meal];

    if (!dishes.length) {
      reconcileChildren(body, ['__empty__'], () => {
        const div = document.createElement('div');
        div.className = 'no-meals';
        div.textContent = EMPTY_MEALS_TEXT;
        return div;
      }, false, true);
      continue;
    }
    reconcileChildren(body, dishes.map((d, i) => dishKey(m, d, i)), (key) => {
      const dish = document.createElement('div');
      dish.innerHTML = dishHTML(dishes[Number(key.split('|').pop())]);
      const node = dish.firstChild;
      node.dataset.fresh = '1'; // new dish this render (photo at natural height)
      return node;
    }, false, true);
    // enter/exit symmetry: replaced dishes (date/meal swap) shrink out
    // (animateExit) while the new ones grow in (animateEnter) — the
    // section height changes continuously, so even an equal-height swap
    // animates (the old "same-height content flashed" case). The
    // #content glide stays off while any node is entering/exiting
    // (renderAll guard); sections added by a checkbox carry their
    // dishes via the nested-enter guard. Fresh sections still grow as
    // one unit.
  }
}

/**
 * Idempotent photo sync: makes the DOM match prefs.photos by inserting or
 * removing <img class="dish-photo"> inside REUSED dish nodes — dish text/
 * nutrition never rebuilds (no flash). Runs inside renderAll()'s diff
 * pass.
 * Choreography (no fades — layout animation only): photos OPEN by
 * growing from 0 height (content slides down naturally), CLOSE by
 * shrinking back to 0 height (content slides up), then the node is
 * removed. Height transitions are layout animations, so they are
 * self-contained: the FLIP pass measures a ~0 delta and stays out of
 * the way — no double animation, works in every browser.
 */
function applyPhotos() {
  const show = prefs.photos;
  const content = document.getElementById('content');

  for (const dishEl of content.querySelectorAll('.dish')) {
    const url = dishEl.dataset.photo;
    const main = dishEl.querySelector('.dish-main');
    const img = dishEl.querySelector('.dish-photo');
    // The fresh flag is ONE render's property: renderContent sets it on
    // newly created dishes, and it must be consumed (deleted) in this
    // same pass even when photos are OFF — a stale flag would let a
    // LATER photos-on toggle insert the photo at natural height and
    // skip the 0->natural grow the reused-dish choreography promises
    // (the animation-consistency bug).
    const fresh = dishEl.dataset.fresh === '1';
    if (fresh) delete dishEl.dataset.fresh;
    if (show && url && img && img.dataset.photoClosing) {
      // A closing photo is being reopened (rapid toggle): cancel the
      // shrink and restore it — don't wait for the next render.
      if (img._photoTimer) { clearTimeout(img._photoTimer); img._photoTimer = null; }
      img.style.height = '';
      img.style.marginTop = '16px';
      delete img.dataset.photoClosing;
    }
    if (show && url && !img) {
      const el = document.createElement('img');
      el.className = 'dish-photo';
      el.src = url;
      el.alt = (dishEl.querySelector('.dish-name') || {}).textContent || '';
      el.loading = 'lazy';
      // FRESH dish (wholesale swap) OR dish inside an ENTERING section
      // (checkbox add): insert at NATURAL height — the section's own
      // animateEnter measures its natural height on the next frame, and
      // that measurement MUST include the full photo height. A 0→natural
      // photo grow (the reused-dish path) runs in a later RAF than the
      // section's measurement RAF, so the section's enter target would
      // miss the photo stack and snap on transitionend (the checkbox-add
      // stutter). REUSED dish (photo toggle): keep the 0→natural grow
      // choreography. (The fresh flag itself was already read + consumed
      // at the top of this loop.)
      const sectionEntering = dishEl.closest('[data-entering]');
      if (fresh || sectionEntering) {
        el.style.height = 'auto';
        el.style.marginTop = '16px';
        el.style.display = 'block';
        main.appendChild(el);
      } else if (animationsAllowed()) {
        el.style.height = '0';
        el.style.marginTop = '0';
        main.appendChild(el);
        requestAnimationFrame(() => {
          el.style.height = 'auto';
          const h = el.offsetHeight; // natural height (aspect-ratio)
          el.style.height = '0px';
          void el.offsetHeight; // reflow: transition starts from 0
          el.style.height = h + 'px';
          el.style.marginTop = '16px';
          // After the grow finishes, drop the inline height so the
          // layout returns to the natural aspect-ratio height (keeps
          // it responsive on resize).
          const onEnd = (e) => {
            if (e.propertyName === 'height') {
              el.style.height = '';
              el.removeEventListener('transitionend', onEnd);
              if (el._photoTimer) { clearTimeout(el._photoTimer); el._photoTimer = null; }
            }
          };
          el.addEventListener('transitionend', onEnd);
          // Fallback: transitionend may never fire (interrupted
          // transition, background tab) — drop the inline height
          // anyway (same pattern as every other animation path).
          // Shares the _photoTimer slot with the close path: the
          // close's clearTimeout also hands over a still-growing
          // photo, so no timer can fire mid-shrink.
          el._photoTimer = setTimeout(() => {
            if (el._photoTimer) { clearTimeout(el._photoTimer); el._photoTimer = null; }
            el.style.height = '';
            el.removeEventListener('transitionend', onEnd);
          }, 600); // 450ms transition + margin; transitionend is the normal path
        });
      } else {
        el.style.height = 'auto';
        el.style.marginTop = '16px';
        el.style.display = 'block';
        main.appendChild(el);
      }
    } else if (!show && img) {
      if (img.dataset.photoClosing) {
        // Already shrinking (a previous render started the close; the
        // node is removed on transitionend). Idempotence: one shrink
        // per img — do not re-bind listeners or restart the transition,
        // or the first transitionend would remove the img out from
        // under the second listener.
        continue;
      }
      if (animationsAllowed()) {
        // Pin current height, force reflow, then shrink to 0; the
        // transitionend removes the node once the collapse finished.
        // Fallback timer: transitionend may never fire (interrupted
        // transition, target already 0 on rapid toggles) — remove
        // anyway so no hidden <img> accumulates. The clearTimeout
        // below also hands over a still-pending GROW timer: a photo
        // mid-grow that gets closed must not have its grow fallback
        // fire mid-shrink (it would reset the inline height and pop
        // the image back open — same hand-over as animateExit taking
        // over an entering node).
        if (img._photoTimer) { clearTimeout(img._photoTimer); img._photoTimer = null; }
        img.dataset.photoClosing = '1';
        img.style.height = img.clientHeight + 'px';
        void img.offsetHeight; // reflow so the transition starts from the pinned height
        img.style.height = '0';
        img.style.marginTop = '0';
        const onEnd = () => {
          // Revived (reopened) photos are NOT removed — only closing ones.
          if (!img.dataset.photoClosing) return;
          delete img.dataset.photoClosing;
          img.remove();
        };
        img.addEventListener('transitionend', onEnd, { once: true });
        img._photoTimer = setTimeout(() => {
          if (img.dataset.photoClosing) img.remove();
        }, 600); // 450ms transition + margin; transitionend is the normal path
      } else {
        img.remove();
      }
    }
  }
}

/* ---------- segmented switch + sliding thumb ---------- */

function updateSegmented() {
  const seg = document.querySelector('.segmented');
  if (seg) seg.dataset.meal = prefs.meal;   // CSS [data-meal=...] drives the thumb
  // [data-meal] ONLY: the appearance switch (.segmented.appearance) has
  // its own options (data-theme) and its own sync (updateAppearance).
  // A blanket .seg-option query here would wipe the appearance switch's
  // active class on every load/resize — the "Light starts grey" bug.
  document.querySelectorAll('.seg-option[data-meal]').forEach((btn) => {
    const active = btn.dataset.meal === prefs.meal;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
}

/* ---------- raw panel ---------- */

function updateRawText() {
  rawFiltered = buildRawText();
  document.getElementById('raw-text').textContent =
    rawFiltered || 'No dishes available for the current selection.';
}

/* ---------- collapse animation (max-height) ---------- */

/** Instantly settle a node to its natural height: cancel any inline
    height transition and drop the inline height (no animation). Used
    to coalesce rapid wholesale swaps — the old glide's mid-flight
    height must never leak into the next render's measurements. */
function settleContentHeight(node) {
  // '' (not 'none') — 'none' stays as an inline declaration and poisons
  // the NEXT glide: animateContentHeight would build the invalid
  // "none, height .45s ..." transition and the animation silently dies
  // (the "content appears without animation" regression). '' removes
  // the inline rule, so the computed value goes back to the default.
  node.style.transition = '';
  node.style.height = '';
  node.style.overflow = '';
  if (node._glideTimer) { clearTimeout(node._glideTimer); node._glideTimer = null; }
  if (node._heightGlideEnd) {
    node.removeEventListener('transitionend', node._heightGlideEnd);
    node._heightGlideEnd = null;
  }
  void node.offsetHeight; // reflow: settle at the natural height
}

/** Glide a container's height from oldH to newH (Apple ease). Used when
    content swaps wholesale (date/meal switch): the DOM swap is instant,
    but locking the old height and transitioning to the new one makes
    the layout glide instead of jump. Interrupt-safe: a running glide
    is cleaned up before a new one starts; a timeout fallback settles
    the node even when the browser never fires transitionend (e.g. the
    target equals the locked height to sub-pixel — no transition runs,
    so no event; without the fallback the inline height would stick). */
function animateContentHeight(node, oldH, newH) {
  if (node._heightGlideEnd) {
    node.removeEventListener('transitionend', node._heightGlideEnd);
    node._heightGlideEnd = null;
  }
  if (node._glideTimer) { clearTimeout(node._glideTimer); node._glideTimer = null; }
  const cur = getComputedStyle(node).transition;
  // Defensive: 'none' or the default must not be prepended — "none,
  // height ..." is an invalid transition list that silently kills the
  // animation. Only append to a real transition (e.g. 'all').
  node.style.transition = (cur && cur !== 'all 0s ease 0s' && cur !== 'none'
                           ? cur + ', ' : '') +
                          'height .45s ' + ANIM_EASE;
  node.style.height = oldH + 'px';
  node.style.overflow = 'hidden';
  void node.offsetHeight; // reflow: lock at oldH, then glide
  node.style.height = newH + 'px';
  const onEnd = (e) => {
    if (e.propertyName === 'height') {
      node.style.height = '';
      node.style.overflow = '';
      node.style.transition = '';
      node.removeEventListener('transitionend', onEnd);
      node._heightGlideEnd = null;
      if (node._glideTimer) { clearTimeout(node._glideTimer); node._glideTimer = null; }
    }
  };
  node._heightGlideEnd = onEnd;
  node.addEventListener('transitionend', onEnd);
  node._glideTimer = setTimeout(() => {
    if (node._heightGlideEnd) settleContentHeight(node);
  }, 600); // 450ms glide + margin; transitionend is the normal path
}

/** Duration for one disclosure toggle: scales with content height so
    the perceived slide speed matches a small (empty) slot — a 3000px
    menu gets ~900ms instead of snapping through at 6.9px/ms while a
    40px slot crawls at 0.1px/ms ("opens too fast" report). Clamped to
    [450, 900]ms: 450 is the NN/g large-motion floor, 900 the ceiling
    before a disclosure feels draggy ("sometimes normal but too slow"). */
function expandDuration(body) {
  const h = body.scrollHeight || 0;
  return Math.min(900, Math.max(450, Math.round(h * 0.35)));
}

function expandBody(body) {
  if (body._expandTimer) { clearTimeout(body._expandTimer); body._expandTimer = null; }
  const dur = expandDuration(body);
  // Override the transition DURATION directly (transitionDuration is
  // its own property — the shorthand stays CSS-owned so the curve
  // token can't be smuggled past the contract verifier).
  body.style.transitionDuration = dur + 'ms';
  body.style.maxHeight = body.scrollHeight + 'px';
  const onEnd = (e) => {
    if (e.propertyName === 'max-height') {
      body.style.maxHeight = 'none';
      body.removeEventListener('transitionend', onEnd);
      body._onExpandEnd = null;
    }
  };
  body._onExpandEnd = onEnd; // so an interrupted expand can be cleaned up
  body.addEventListener('transitionend', onEnd);
  // Fallback: if transitionend never fires (interrupted transition, or
  // target == current height so no transition runs — rapid re-expand),
  // the inline pin must still be dropped: a stale pin + overflow:hidden
  // clips content (photo toggles, resize). Same pattern as the glide.
  body._expandTimer = setTimeout(() => {
    if (body._onExpandEnd) {
      body.removeEventListener('transitionend', body._onExpandEnd);
      body._onExpandEnd = null;
    }
    body.style.maxHeight = 'none';
  }, dur + 150); // dur transition + margin; transitionend is the normal path
}

function collapseBody(body) {
  // The expand timer must not fire mid-collapse: it would force
  // max-height back to 'none' and the content would spring open
  // (the collapse-interrupt "flash" regression, 890eb0c follow-up).
  if (body._expandTimer) { clearTimeout(body._expandTimer); body._expandTimer = null; }
  if (body._onExpandEnd) {
    body.removeEventListener('transitionend', body._onExpandEnd);
    body._onExpandEnd = null;
  }
  const dur = expandDuration(body);
  body.style.transitionDuration = dur + 'ms';
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

  // Calendar popover: trigger toggle + month nav + grid selection.
  document.getElementById('date-trigger').addEventListener('click', () => toggleCalendar());
  document.getElementById('cal-prev').addEventListener('click', () => onCalendarNav(-1));
  document.getElementById('cal-next').addEventListener('click', () => onCalendarNav(1));
  document.getElementById('cal-grid').addEventListener('click', onCalendarGridClick);

  const appearanceSeg = document.getElementById('appearance-seg');
  appearanceSeg.addEventListener('click', onAppearanceClick);
  appearanceSeg.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onAppearanceClick(e);
    }
  });

  const photoRow = document.getElementById('photo-row');
  photoRow.addEventListener('click', onPhotoToggleClick);
  photoRow.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onPhotoToggleClick();
    }
  });

  const openingRow = document.getElementById('opening-row');
  openingRow.addEventListener('click', onOpeningToggleClick);
  openingRow.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpeningToggleClick();
    }
  });

  const priceRow = document.getElementById('price-row');
  priceRow.addEventListener('click', onPriceToggleClick);
  priceRow.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onPriceToggleClick();
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

  window.addEventListener('resize', updateSegmented);
  window.addEventListener('load', updateSegmented); // fonts/layout settle

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
  renderAll();
}

/* ---------- calendar (date picker popover) ---------- */

// Month currently displayed in the calendar grid (first day of month).
let calMonth = '';

/** All dates that carry ANY data, keyed by ISO date. */
function availableDates() {
  return (data && data.availableDates) || [];
}

/** True when the date carries any dish (calendar cell enabled). O(1)
    lookup into the precomputed dataDates set (built once at load by
    scanning each day's DISHES — days[iso] always has the full mensa
    list, empty meals included). */
function hasData(iso) {
  return dataDates.has(iso);
}

/** Toggle the calendar disclosure (WAI-ARIA date-picker dialog pattern).
    The calendar is IN THE DOCUMENT FLOW between the date heading and
    the meal switch: expanding pushes Lunch/Dinner (and everything
    below) smoothly down; collapsing lets it back up. The animation is
    max-height driven by expandBody/collapseBody (scrollHeight
    measurement + transition — the same disclosure machinery as the
    raw panel and mensa collapse, works in every browser).
    Trigger click toggles; choosing a date does NOT close (users can
    compare several days in a row); Escape closes (keyboard access). */
function toggleCalendar() {
  const cal = document.getElementById('calendar');
  const header = document.querySelector('.header');
  const trigger = document.getElementById('date-trigger');
  const open = !header.classList.contains('calendar-open');

  if (open) {
    if (!calMonth) {
      // First of the selected month. With no data loaded (fetch
      // failed) selectedDate is '' — leave calMonth empty too and let
      // renderCalendar show the graceful empty state instead of
      // garbage dates.
      calMonth = selectedDate ? selectedDate.slice(0, 7) + '-01' : '';
    }
    renderCalendar();
    header.classList.add('calendar-open');
    expandBody(cal); // max-height: scrollHeight -> none (smooth push-down)
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('keydown', onCalendarKeydown);
  } else {
    header.classList.remove('calendar-open');
    collapseBody(cal); // max-height: scrollHeight -> 0 (smooth pull-up)
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onCalendarKeydown);
  }
}

function onCalendarKeydown(e) {
  if (e.key === 'Escape') toggleCalendar();
}

/** Render the calendar grid for calMonth: weekday-aligned cells with
    enabled/disabled states; today, selected and data-bearing markers. */
function renderCalendar() {
  const grid = document.getElementById('cal-grid');
  const title = document.getElementById('cal-title');
  const note = document.getElementById('cal-note');

  // No data loaded (data.json fetch failed): render a graceful empty
  // state — an empty calMonth/selectedDate would otherwise produce
  // garbage cells ("January 0", year-0 date labels).
  if (!data) {
    title.textContent = 'No menu data';
    grid.innerHTML = '';
    note.textContent = 'No menu data available.';
    return;
  }

  const [y, m] = calMonth.split('-').map(Number);

  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  title.textContent = months[m - 1] + ' ' + y;

  // Monday-first grid: 0 = Monday. JS getDay(): 0=Sun..6=Sat.
  const first = new Date(y, m - 1, 1);
  const lead = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(y, m, 0).getDate();
  const todayIso = data ? data.date : '';

  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<span class="cal-cell cal-empty"></span>');
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const enabled = hasData(iso);
    const classes = ['cal-cell'];
    if (iso === selectedDate) classes.push('selected');
    if (iso === todayIso) classes.push('today');
    if (!enabled) classes.push('disabled');
    cells.push(
      `<button class="${classes.join(' ')}" type="button" data-date="${iso}"` +
      (enabled ? '' : ' disabled') +
      ` aria-label="${formatDate(iso)}${enabled ? '' : ' (no data)'}">${d}</button>`
    );
  }
  grid.innerHTML = cells.join('');

  // Footer note: how many days carry data in this month.
  const monthPrefix = calMonth.slice(0, 7);
  const n = availableDates().filter((iso) => iso.startsWith(monthPrefix)).length;
  note.textContent = n ? `${n} day${n === 1 ? '' : 's'} with menus in this month` : 'No menus in this month';
}

/** Switch the active date: swap dataset + re-render through the unified
    pipeline (content FLIPs, selector/raw refresh). The calendar stays
    OPEN so several days can be compared in a row — the trigger or
    Escape closes it. */
function selectDate(iso) {
  if (!hasData(iso) || iso === selectedDate) return;
  selectedDate = iso;
  document.getElementById('date-heading').textContent = formatDate(iso);
  renderAll(); // everything reads activeMensas() — one pipeline
  renderCalendar(); // move the selected-cell highlight
}

function onCalendarNav(dir) {
  if (!data) return; // no data loaded — nothing to navigate
  const [y, m] = calMonth.split('-').map(Number);
  const dt = new Date(y, m - 1 + dir, 1);
  calMonth = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-01`;
  renderCalendar();
}

function onCalendarGridClick(e) {
  const cell = e.target.closest('.cal-cell[data-date]');
  if (cell && !cell.disabled) selectDate(cell.dataset.date);
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
  renderAll();
  // Defer persistence: localStorage can block for several ms on
  // Windows, and renderAll's synchronous measurements + DOM mutations
  // already push the frame budget. Delaying the write to the next
  // idle moment keeps the animation-critical path under 16ms and
  // prevents a visible hitch (the checkbox stutter).
  savePrefs();
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
  renderAll();
  savePrefs();
}

function deleteCustomGroup(name) {
  delete prefs.customGroups[name];
  savePrefs();
  renderAll(); // chips reconcile + FLIP; selected rows already updated
}

/** Create a custom group whose members = currently selected mensas.
    Recreating with an existing name redefines its members (update).
    Reserved names (default groups AND data groups) are rejected so a
    custom chip can never shadow a real group — the catalog in
    renderGroupList dedupes by name, so a shadowing custom group would
    silently replace the real one. */
function addCustomGroup() {
  const input = document.getElementById('group-input');
  const name = input.value.trim();
  if (!name) {
    showGroupMsg('Enter a group name');
    return;
  }
  if (DEFAULT_GROUPS.includes(name) || activeMensas().some((m) => m.group === name)) {
    showGroupMsg('That name is reserved');
    return;
  }
  prefs.customGroups[name] = Array.from(prefs.selected);
  savePrefs();
  renderAll();
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

/** Content-level click delegation: mensa titles collapse/expand. */
function onContentClick(e) {
  const title = e.target.closest('.mensa-title');
  if (title) {
    e.preventDefault();
    toggleSection(title.closest('.mensa-section'));
  }
}

/** Keydown on content: Enter/Space toggles a focused mensa title
    (button role on the h2). */

function onContentKeydown(e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const title = e.target.closest('.mensa-title');
  if (!title) return;
  e.preventDefault();
  toggleSection(title.closest('.mensa-section'));
}

/** Collapse/expand one mensa section; state persists in prefs.
    Closed slots (no meals this meal) are NOT collapsible — their
    section carries .no-meal-slot and renders no body. */
function toggleSection(section) {
  if (section.classList.contains('no-meal-slot')) return;
  const id = section.dataset.mensa;
  const collapsed = prefs.collapsedMensas.has(id);
  const body = section.querySelector('.mensa-dishes');
  const title = section.querySelector('.mensa-title');

  if (collapsed) {
    prefs.collapsedMensas.delete(id);
    // Lock the body's inline max-height at 0 BEFORE removing the
    // 'collapsed' class, so dropping the CSS max-height:0 rule can't
    // jump the body to 'none' (instant full open). expandBody then
    // animates from the locked 0 to scrollHeight — symmetric with the
    // collapse-side lock (first-expand flash regression).
    if (body) body.style.maxHeight = '0px';
    section.classList.remove('collapsed');
    if (body) expandBody(body);
  } else {
    prefs.collapsedMensas.add(id);
    // Lock the body's inline max-height BEFORE adding 'collapsed' class,
    // so the CSS rule max-height:0 cannot flash-clip the content.
    // collapseBody then animates from the locked concrete value.
    if (body) body.style.maxHeight = body.scrollHeight + 'px';
    section.classList.add('collapsed');
    if (body) collapseBody(body);
  }
  // aria-expanded reflects the POST-toggle state — reading prefs again
  // (mutated above), not the captured `collapsed`: the old code used
  // !collapsed, which inverted the attribute on every toggle (a section
  // that just collapsed announced aria-expanded=true to screen readers).
  if (title) title.setAttribute('aria-expanded', String(!prefs.collapsedMensas.has(id)));
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
    data = json;
    selectedDate = json.date;
    document.getElementById('date-heading').textContent = formatDate(selectedDate);
    validatePrefsAgainstData();
    renderAll(); // silent first paint — animations stay disabled
    animEnabled = true; // from here on, user interactions animate
    document.documentElement.classList.add('anim-ready'); // CSS transitions live
    updateSegmented();
  } catch (err) {
    console.error(err);
    document.getElementById('content').innerHTML =
      '<div class="error">Failed to load menu data. Please try again later.</div>';
  }

  // Re-sync the segmented control once webfonts settle (widths may shift).
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => updateSegmented()).catch(() => {});
  }
}

init();
