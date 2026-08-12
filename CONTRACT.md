# Contract — eth-uzh-zmittag site

> **Agents: also read AGENTS.md (animation architecture, prohibitions,
> workflow) before changing code. The animation contract below is the
> detailed, human-readable version of it.**

## data.json (backend produces, frontend consumes)
```json
{
  "date": "2026-08-08",
  "availableDates": ["2026-08-08", "2026-08-10", "..."],
  "days": {
    "2026-08-08": {
      "mensas": [
        {
          "id": "eth-9",
          "name": "ETH Mensa Polyterrasse",
          "group": "Central",
          "opening": {"Lunch": "11:00 - 14:00", "Dinner": null},
          "meals": {
            "Lunch":  [{"line": "STREET", "dish": "Lomo Saltado", "desc": "ingredients...", "photo": "https://…", "price": [{"label": "STUD", "value": 13.2}, {"label": "INT", "value": 14.2}, {"label": "EXT", "value": 16.5}], "priceUnit": "Portion", "nutrition": {"p100": {"kcal": 152.0, "protein": 5.3, "fat": 9.9, "saturated": 1.1, "carbs": 12.0, "sugar": 1.3, "salt": 0.53}, "total": {}}}],
            "Dinner": []
          }
        }
      ]
    }
  }
}
```
- The frontend renders the ACTIVE day: `data.days[selectedDate].mensas`
  through `activeMensas()` — `data.mensas` no longer exists.
- nutrition keys (fixed set): kcal, protein, fat, saturated, carbs, sugar, salt, fiber, weight
- Values are NUMBERS (no units). kcal unit=kcal, all others = g. weight only in total.
- p100 = per-100g values; total = per-serving values. Empty object {} means no data.
- `photo`: absolute image URL or "" (ETH URLs carry `?client-id=ethz-wcms`; UZH photos are dish.imageUrl on the detail page). Empty string = no photo.
- `price`: array of `{label, value}` (labels STUD, INT, INT&STUD, EXT, ALL); empty array = no price data. `priceUnit`: "Portion" | "100 g"; absent on UZH dishes.
- mensa `opening`: `{slot: "HH:MM - HH:MM" or null}` — per meal slot; null = no service that slot.
- group values: Central, Hoengg, Irchel, Oerlikon, Other
- meal slots: "Lunch" | "Dinner"
- availableDates = sorted ISO dates with ANY data (weekends absent or
  empty — the calendar disables them).

## index.txt (backend produces, AI raw text)
One line per dish: `NAME/SLOT: line — dish | desc | per100g: kcal=152.0, protein=5.3g, ... | total: ...`
- `line` is dropped when empty or identical to `dish`; `desc` is a pipe-separated ingredient list (always " | ").
- Names are title-cased when the source is ALL CAPS (UZH blobs, some ETH entries); UZH blobs are split at the first comma into `dish` (main dish) + `desc` (ingredients).

## DOM class contract (frontend generates, design styles)
```
header .header
  button.menu-btn (hamburger, 3 bars)  -> toggles #selector
  button.date-trigger (wraps h1#date-heading; hover shows slim outline;
                       toggles the calendar — TRIGGER ONLY, choosing a
                       date does NOT close it, Escape closes)
  .calendar (in-flow disclosure between heading and segmented:
    grid -> max-height disclosure via expandBody/collapseBody;
    .calendar-inner carries the frame's padding/border — the CLIPPED
    box itself must stay clean, see prohibition #4 in AGENTS.md)
    .calendar-head (.cal-nav prev/next, .cal-title month year)
    .cal-weekdays (Mon..Sun)
    .cal-grid > button.cal-cell[data-date] (.today ring, .selected fill,
      .disabled when no data)
    .cal-note (count of days with menus this month)
  .segmented (Lunch/Dinner switch, iOS style)
    .seg-thumb (sliding indicator)
    button.seg-option[data-meal=Lunch|Dinner]
#selector (collapsible panel)
  .selector-columns (2 columns)
    .selector-mensas (scrollable list)
      .mensa-row (each: .mensa-check circle + label)
    .selector-groups
      .group-row (group name + .group-select-all + count)
      .group-add (input + button to add custom group)
    .selector-pane-title "Setting" (bottom-most pane)
    .photo-row (.mensa-row style; .selected = photos on; label "Show menu photos")
    #opening-row (.mensa-row .photo-row style; label "Show opening times")
    #price-row (.mensa-row .photo-row style; label "Show prices")
    #appearance-seg (light/dark/auto segmented switch)
main#content
  section.mensa-section (collapsible: click .mensa-title toggles)
    h2.mensa-title (with .mensa-caret)
    .dish (one per dish)
      .dish-main (.dish-label, .dish-name, .dish-desc)
      img.dish-photo (optional; HEIGHT transition 0->natural px on open,
        natural->0 + remove on close — NEVER opacity/fade)
      .nutrition-col > table.nutrition-table (thead Nutrition|per 100g|Total; tbody 9 fixed rows)
.raw-section (#raw-toggle button, #raw-panel > .raw-inner with #copy-btn, #raw-text)
  #raw-panel is a max-height disclosure (overflow hidden; JS animates)
footer.footer
```
- Mensa row selected style: filled circle (•) vs empty circle
- NO cards, NO box-shadows, NO borders around containers — flat Apple.com style
- dark mode via prefers-color-scheme (html[data-theme] light|dark|auto); responsive at 600px/768px

## Animation contract (see AGENTS.md for the enforceable version)

Every content change runs through the ONE pipeline:
`handler -> state -> renderAll() -> snapshot -> keyed diffs -> FLIP`.
- `renderAll()` (app.js) is the single render entry; `FLIP_CONTAINERS`
  registers every dynamic container; children carry stable `data-key`s.
- Disclosures (raw panel, mensa collapse, calendar) = max-height +
  scrollHeight (expandBody/collapseBody), never grid-fr, never height:auto.
- Photos = idempotent <img> insert/remove in REUSED dish nodes; open/close
  = height transition (0 -> natural px, then clear inline height).
- NO opacity/fade/view-transitions anywhere in content animation.
- First paint silent (animEnabled); prefers-reduced-motion respected.

## localStorage key: "eth-uzh-nutrition-prefs"
```json
{"meal":"Lunch","selected":["eth-9","uzh-obere-mensa",...],"photos":true,"theme":"light","customGroups":{"My Group":["eth-3",...]},"collapsedMensas":[]}
```
- photos: bool, DEFAULT true (photos on — product owner); openingTimes/prices:
  bool, DEFAULT true, NOT persisted — savePrefs omits them, so the toggles
  reset to on after a reload (loadPrefs supports them; savePrefs doesn't write
  them yet); selection
  DEFAULT: all of the Central group when nothing is stored (see
  validatePrefsAgainstData); theme DEFAULT "light" (first visit shows the
  light switch active, matching the light default palette — "auto"
  confused users into thinking Light was broken/grey).
- The calendar date (selectedDate) is intentionally NOT persisted — the
  site is a "today" product.
