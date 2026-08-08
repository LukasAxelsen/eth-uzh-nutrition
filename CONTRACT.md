# Contract — eth-uzh-nutrition site

## data.json (backend produces, frontend consumes)
```json
{
  "date": "2026-08-07",
  "mensas": [
    {
      "id": "eth-9",
      "name": "ETH Mensa Polyterrasse",
      "group": "Central",
      "meals": {
        "Lunch":  [{"line": "STREET", "dish": "Lomo Saltado", "desc": "ingredients...", "photo": "https://…", "nutrition": {"p100": {"kcal": 152.0, "protein": 5.3, "fat": 9.9, "saturated": 1.1, "carbs": 12.0, "sugar": 1.3, "salt": 0.53}, "total": {}}}],
        "Dinner": []
      }
    }
  ]
}
```
- nutrition keys (fixed set): kcal, protein, fat, saturated, carbs, sugar, salt, fiber, weight
- Values are NUMBERS (no units). kcal unit=kcal, all others = g. weight only in total.
- p100 = per-100g values; total = per-serving values. Empty object {} means no data.
- `photo`: absolute image URL or "" (ETH URLs carry `?client-id=ethz-wcms`; UZH photos are dish.imageUrl on the detail page). Empty string = no photo.
- group values: Central, Hoengg, Irchel, Oerlikon, Other
- meal slots: "Lunch" | "Dinner"

## index.txt (backend produces, AI raw text)
One line per dish: `NAME/SLOT: line — dish | desc | per100g: kcal=152.0, protein=5.3g, ... | total: ...`
- `line` is dropped when empty or identical to `dish`; `desc` is a pipe-separated ingredient list (always " | ").
- Names are title-cased when the source is ALL CAPS (UZH blobs, some ETH entries); UZH blobs are split at the first comma into `dish` (main dish) + `desc` (ingredients).

## DOM class contract (frontend generates, design styles)
```
header .header
  button.menu-btn (hamburger, 3 bars)  -> toggles #selector
  h1#date-heading
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
main#content
  section.mensa-section (collapsible: click .mensa-title toggles)
    h2.mensa-title (with .mensa-caret)
    .dish (one per dish)
      .dish-main (.dish-label, .dish-name, .dish-desc)
      img.dish-photo (optional; only rendered when photos enabled; fades in)
      .nutrition-col > table.nutrition-table (thead Nutrition|per 100g|Total; tbody 9 fixed rows)
.raw-section (#raw-toggle button, #raw-panel > .raw-inner with #copy-btn, #raw-text)
  #raw-panel is a max-height disclosure (overflow hidden; JS animates)
footer.footer
```
- Mensa row selected style: filled circle (•) vs empty circle
- NO cards, NO box-shadows, NO borders around containers — flat Apple.com style
- dark mode via prefers-color-scheme; responsive at 600px/768px

## localStorage key: "eth-uzh-nutrition-prefs"
```json
{"meal":"Lunch","selected":["eth-9","uzh-obere-mensa",...],"photos":false,"customGroups":{"My Group":["eth-3",...]},"collapsedMensas":[]}
```
