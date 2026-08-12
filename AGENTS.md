# AGENTS.md — eth-uzh-zmittag

Rules for any agent (or human) modifying this repository. Read this file
BEFORE changing code. These constraints are the product owner's explicit
requirements, hard-won through several regressions — violating them is a
bug, not a style choice.

## What this project is

A static menu site (ETH + UZH mensas) served from GitHub Pages. Backend
(`menu.py`) scrapes both providers into `output/data.json`; frontend
(`template/app.js`, `template/style.css`, `template/index.html`) renders
it. Build: `python3 menu.py` (writes `output/`). Deploy: GitHub Actions.

## Non-negotiable animation architecture (the "contract")

All content animations MUST go through the ONE unified rendering
pipeline. There is no per-event animation code. The pipeline is:

```
event handler -> mutate state only -> renderAll()
  renderAll(): snapshot all FLIP_CONTAINERS -> apply ALL DOM diffs
               (keyed reconcile, doFlip=false) -> FLIP all containers once
```

- `renderAll()` (template/app.js) is the SINGLE render entry point.
  Handlers only change state (`prefs.*`, `selectedDate`, …) and call it.
- Every dynamic container is registered in `FLIP_CONTAINERS` and its
  children carry stable `data-key`s; new elements get animation by being
  added to a registered container with a key — nothing else.
- Keyed reconcile (`reconcileChildren`): reuse nodes whose key survives;
  move a node ONLY when its order actually changed (unconditional
  appendChild forces reflow and kills CSS transitions — this ate the
  mensa dot animation once).
- `applyPhotos()` is an IDEMPOTENT `<img>` insert/remove inside reused
  dish nodes. Dish nodes are NEVER rebuilt for the photo toggle; the
  photo key bit must NEVER enter `dishKey` (rebuilding the card flashes
  text/nutrition).
- ENTER/EXIT is symmetric by default, and it is a PIPELINE property,
  not a per-feature concern: `reconcileChildren` grows every newly
  added node from 0 height via `animateEnter()` (height transition,
  same choreography as the photo open), and removed nodes collapse via
  the sibling FLIP. Adding a feature = add a keyed reconcile call; the
  animation comes for free. Never hand-write per-feature enter/exit
  animations. Nodes inside an already-entering ancestor are skipped
  (nested reconciles — a dish inside a fresh section doesn't animate
  twice; the outer grow carries it).
- WHOLESALE SWAPS (date/meal change — every dish key changes at once)
  are animated by the #content HEIGHT GLIDE (`animateContentHeight`):
  lock the old height, swap the DOM instantly, glide to the new height.
  Per-dish enters on top of a glide double-animate (the flash
  regression), and a swap without a glide jumps (the no-animation
  regression). Dishes therefore reconcile with enter=false; fresh
  sections keep their own grow. The glide is guarded: skipped while any
  node is entering (a pure-add drives height continuously on its own).
- RAPID TOGGLES COALESCE (`settleContentHeight`): renderAll snaps a
  still-running glide to its natural height BEFORE measuring — the old
  glide's inline height must never leak into oldH/newH (it locked the
  layout to a stale mid-flight value and the page felt stuck).
  A 500ms timeout fallback settles the node even when transitionend
  never fires (target == locked height to sub-pixel). The glide's
  target MUST include photos: applyPhotos runs before the newH
  measurement, and FRESH dishes (one-shot `data-fresh` marker, deleted
  after use) insert photos at natural height — reused dishes (photo
  toggle) keep the 0->natural grow animation.

## Decoupling rules (industry layering, agent-maintainable)

1. **State is the only source of truth.** No function reads the DOM to
   decide what to render; every render reads state (`prefs`, `data`,
   `selectedDate`) through the single accessors (`activeMensas()`,
   `groupMembers()`). Never duplicate data in DOM attributes and then
   read it back as if it were state.
2. **One function per concern.** Rendering (HTML strings + reconcile),
   state mutation (handlers), and animation (FLIP/enter) are separate
   functions in separate commented sections. A handler NEVER contains
   inline DOM surgery; it mutates state and calls `renderAll()`.
3. **The pipeline owns the DOM.** Feature code calls
   `reconcileChildren(container, keys, makeEl)` and nothing else for
   list changes. No direct `appendChild`/`insertBefore`/`remove` loops
   in feature code; no second render path (a feature that renders by
   itself cannot be FLIP-animated and WILL regress).
4. **No duplicate state sync helpers.** One function updates one piece
   of UI (e.g. `updateSegmented` is the ONLY segmented sync; a second
   half-sync helper is dead code). If a sync hook already exists,
   extend it — don't add a lookalike.
5. **CSS owns presentation geometry.** Thumb positions, disclosure
   heights and rhythm use CSS tokens (`--r-*`, `--ease`, spacers).
   JS measures only what CSS cannot express (scrollHeight for
   max-height disclosures, natural height for enter animations).
6. **Contract scripts are part of the build.** `scripts/verify-anim-contract.py`
   encodes prohibitions 1-10 + these decoupling rules as machine checks;
   run it before every commit. If a new rule is needed, add the check
   FIRST, then fix the code to pass it.

## Absolute prohibitions (each one cost a regression)

1. NO fades, NO opacity keyframes, NO view transitions. Content changes
   animate via layout (height/margin transitions) or transform-only FLIP.
   The photo open/close is a HEIGHT transition (0 -> natural px), never
   `opacity`/`scale()` WAAPI.
2. NO `grid-template-rows` fr-value animations for disclosures. Safari
   <16 / Chrome <107 jump instead of animating. Use max-height +
   scrollHeight measurement (`expandBody`/`collapseBody`) — the same
   disclosure machinery as the raw panel and mensa collapse.
   (2026 note: 0fr→1fr grid animation now works in every evergreen
   browser; the max-height machinery stays because expandBody/collapseBody
   need the measured scrollHeight for interrupt-safe choreography — one
   disclosure mechanism for calendar, raw panel and mensa collapse.)
3. NO negative margins as layout hacks. They offset the visible box from
   its flow position (the calendar once overlapped its trigger by 6px).
   Use honest padding, or state-class-driven margin.
4. NO `box-sizing: border-box` + `max-height: 0` + padding on the SAME
   clipped box: padding can't shrink below its content, leaving a
   leftover frame strip when collapsed. The frame's padding/border must
   live on a CHILD of the clipped box (see `.calendar` / `.calendar-inner`).
5. NO animating `height: auto` (0px -> auto doesn't interpolate). Measure
   natural height first (`offsetHeight`), reset to 0, then transition to
   the pixel value; clear the inline height on transitionend.
6. NO changing close behavior of dialogs/popovers without checking the
   WAI-ARIA pattern (date-picker dialog: trigger toggles, choosing a date
   does NOT close, Escape closes).
7. First paint is ALWAYS silent (`animEnabled` gates animations; enabled
   only after initial render). `prefers-reduced-motion` must be respected.
8. ONE easing curve for everything: Apple's standard ease
   `cubic-bezier(.32, .72, 0, 1)` — the `--ease` token in style.css and
   `ANIM_EASE` in app.js are the only two definitions and MUST stay in
   sync. No bare `ease` keywords, no Material `cubic-bezier(.4, 0, .2, 1)`
 (its fast tail reads as "abrupt stop" next to Apple's long settle —
 this was a site-wide smoothness regression). The verifier also flags
 bare `ease` in JS-generated inline transitions — the mensa collapse
 once shipped `transition:max-height .35s ease` inline, invisible to
 the CSS-only check.
9. NO new border-radius values. All radii come from the --r-* tokens
   (--r-sm 8 / --r-md 12 / --r-lg 16 / --r-pill 999 / --r-circle 50%).
   Squircle (`@supports (corner-shape: squircle)`, progressive
   enhancement) covers ONLY the large framed surfaces (calendar-inner,
   raw-inner). Segmented control, chips and thumb stay PILLS (--r-pill)
   — that is the confirmed design; an earlier 8px-squircle experiment on
   controls was explicitly rejected by the product owner.
10. The calendar's 24px vertical rhythm: ABOVE via `.calendar::before`
    spacer row (content of the clipped box — rides the max-height
    animation, zero residue when collapsed); BELOW via the segmented
    control's OWN constant margin-top (24px, never switched to 0 — a
    margin-top:0 state class made Lunch/Dinner jump up 24px when the
    calendar opened). NEVER animate the calendar's margin to create the
    gap: the margin animates independently of the clip and the whole
    calendar visibly "drops" first (the jump regression).
11. Toggle rows (mensa + photo) are FLAT on hover — NO state-layer grey
    (`.mensa-row:hover` background, `::before` overlay). The M3
    hover-grey on those rows was explicitly rejected by the product
    owner; only the check dot and text colour communicate state. Group
    chips keep their own state layer.

## Product owner's design decisions (hard-coded, non-negotiable)

These were each explicitly requested and confirmed by the product owner.
Do not "improve" or "simplify" them without a fresh explicit request.

- **Apple.com minimalism**: white background, SF Pro system font stack,
  large title, hairline `#d2d2d7` borders, NO cards/box-shadows/borders
  around containers. Flat, airy, Apple.com-style.
- **Calendar = in-flow disclosure** (NOT a floating popover): sits
  between the date heading and the Lunch/Dinner switch, pushes content
  down when open, content flows back when closed (WAI-ARIA disclosure).
- **Calendar behavior**: date-trigger click TOGGLES open/close; choosing
  a date does NOT close (compare several days in a row); Escape closes;
  clicking outside does NOT close.
- **Symmetric spacing**: the calendar's air gap above (from the trigger's
  VISIBLE outline, not the text) equals the gap below (to the switch):
  24px both. The trigger uses `box-shadow: inset` for its hover outline
  (a border would offset layout by 1px); no negative margins anywhere.
- **Collapsed disclosure = zero residue**: when closed, nothing of the
  frame may remain visible (max-height clips a clean child box).
- **Photos**: toggle = idempotent <img> insert/remove in REUSED dish
  nodes (never rebuild the card). Open/close = HEIGHT transition
  (0 -> natural px, then clear inline height; natural -> 0, remove on
  transitionend). No opacity, no scale, no fades.
- **M3-style state layers**: mensa rows and group chips get a ::before
  state layer for hover/press feedback + active fill; chips scale(1.04)
  when active. Segmented control uses a sliding thumb driven by
  --seg-count/--seg-index tokens (CSS-only, no JS positioning).
- **Group chips = single source of truth**: every group's members come
  from `groupMembers(name)` (the same function applyGroup uses) —
  count, active state and application can never diverge. Reserved names
  = DEFAULT_GROUPS + data-driven group names.
- **Theme**: light / dark / auto via `html[data-theme]`; the dark palette
  has TWO entry points (forced attribute + prefers-color-scheme media
  query) that MUST stay in sync (same values).
- **Every selection control animates identically** (switch, chips,
  segmented, photo toggle) — same curve, same duration language
  (350ms for content moves, 200-300ms for control states).
- **Drawer**: slides in/out at 0.3s with the same Apple curve as
  content; hamburger, drawer and content move in lockstep.

## Data-layer rules

- `data.json` shape: `{ date, days: {ISO: {mensas}}, availableDates }`.
  The frontend reads the ACTIVE day via `activeMensas()` — never
  `data.mensas` directly (it no longer exists).
- ETH images need `?client-id=ethz-wcms`; UZH photos come from the
  detail page (`dish.imageUrl`), weekly page has none.
- Nutrition is per-100g (kJ must be converted to kcal ÷4.184); empty
  objects `{}` mean "no data" — render empty states, don't drop mensas.
- The 32 mensas always render; no meals => "No meals available today."
- Weekend/future-photo gaps are SOURCE behavior, not bugs: handle
  gracefully, never "fix" by fabricating data.

## Workflow (UI changes)

1. Read this file + CONTRACT.md first.
2. Make the change through the unified pipeline (state -> renderAll).
3. Run `node --check template/app.js` and `python3 -m py_compile menu.py`.
4. Run the contract check: `python3 scripts/verify-anim-contract.py`.
5. Preview on localhost (regenerate `output/` first; bust cache with a
   `?v=` param) and verify behavior in a real browser.
6. UI visual changes are NOT committed until the product owner confirms
   the localhost preview.

## Git identity

Commits must be authored as LukasAxelsen
(`-c user.name='LukasAxelsen' -c user.email='LukasAxelsen@users.noreply.github.com'`).
