#!/usr/bin/env python3
"""verify-anim-contract.py — enforceable animation-contract checks.

Reads AGENTS.md / CONTRACT.md (the animation contract) and verifies the
code still honors it. Run after ANY change to template/app.js or
template/style.css:

    python3 scripts/verify-anim-contract.py

Exit 0 = contract intact. Non-zero with a message = a regression slipped
in; fix it before committing. This is the machine-readable half of the
contract — the human-readable half lives in AGENTS.md.
"""

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
JS = (ROOT / "template" / "app.js").read_text(encoding="utf-8")
CSS = (ROOT / "template" / "style.css").read_text(encoding="utf-8")

FAILURES = []


def check(name, ok, detail=""):
    if ok:
        print(f"  ok  {name}")
    else:
        FAILURES.append(name)
        print(f" FAIL {name}  {detail}")


def section(start_marker, end_markers):
    """Slice JS from start_marker to the earliest end_marker."""
    i = JS.index(start_marker)
    ends = [JS.index(m, i) for m in end_markers if m in JS[i:]]
    return JS[i:min(ends)] if ends else JS[i:]


def section_css(start_marker, end_markers):
    """Slice CSS from start_marker to the earliest end_marker."""
    i = CSS.index(start_marker)
    ends = [CSS.index(m, i) for m in end_markers if m in CSS[i:]]
    return CSS[i:min(ends)] if ends else CSS[i:]


print("== A. unified pipeline (one render entry) ==")
check("renderAll is the single entry", "function renderAll()" in JS)
ra = section("function renderAll()", ["/* ---------- keyed"])
check("renderAll snapshots then diffs then FLIPs",
      "flipFirst(c)" in ra and "applyPhotos();" in ra and "flipPlay(c, first)" in ra)
fc = JS[JS.index("const FLIP_CONTAINERS"):JS.index("function renderAll")]
check("FLIP_CONTAINERS registers content",
      "getElementById('content')" in fc)
# Every call site of the render functions must be inside renderAll or
# renderSelector (which renderAll calls) — no handler may render directly.
calls = [m.start() for m in re.finditer(r"renderContent\(\);", JS)]
allowed = JS.index("function renderAll()"), JS.index("function renderSelector()")
ok = all(any(i < c < JS.index("function", i + 10) for i in allowed) for c in calls)
check("renderContent only called from renderAll/renderSelector", ok)

print("== B. prohibitions (each one was a regression) ==")
ap = section("function applyPhotos()", ["/* ---------- segmented"])
check("photos: no opacity/fade", "opacity" not in ap)
check("photos: no WAAPI scale anim", "el.animate" not in ap and "scale(.96)" not in ap)
check("photos: height choreography (0 -> natural px)",
      "el.style.height = '0'" in ap and "el.offsetHeight" in ap and "h + 'px'" in ap)
check("photos: close pins -> shrinks -> removes on transitionend",
      "clientHeight + 'px'" in ap and "img.style.height = '0'" in ap and "transitionend" in ap)
check("no view transitions anywhere",
      "startViewTransition" not in JS)
cal_css = section_css(".calendar {", [".calendar-head"])
check("no grid-fr disclosure anims (Safari<16 jumps)",
      "grid-template-rows" not in cal_css and "minmax(0, 0fr)" not in CSS)
check("no negative-margin hacks",
      not re.search(r"margin:\s*-\d", CSS))
check("no border-box+max-height+padding trap on clipped box",
      "box-sizing" not in cal_css)
check("no animating height:auto",
      not re.search(r"height\s*=\s*['\"]auto['\"]", JS) or
      "el.offsetHeight" in ap)  # allowed only in the measure-then-px pattern

print("== B2. easing (Apple standard curve, one source of truth) ==")
APPLE_EASE = "cubic-bezier(.32, .72, 0, 1)"
ease_decl = re.search(r"--ease:\s*([^;]+);", CSS)
check("--ease token is Apple's curve",
      bool(ease_decl) and APPLE_EASE in ease_decl.group(1))
# bare `ease` keyword = NOT var(--ease)/var(--ease-sym): strip the
# variable refs first (longest first — "var(--ease)" is NOT a substring
# of "var(--ease-sym)", both must go or the sym token self-triggers)
no_var = CSS.replace("var(--ease-sym)", "").replace("var(--ease)", "")
check("no bare `ease` keyword transitions",
      not re.search(r"transition:[^;]*\bease\b", no_var))
# JS-generated inline transitions must honor the same rule — the mensa
# collapse once shipped 'transition:max-height .35s ease' inline (a
# second, invisible easing curve the CSS-only check missed).
check("no bare `ease` in JS inline transition strings",
      not re.search(r"transition:[^;]*\bease\b", JS))
check("no hardcoded Material curve leftovers",
      "cubic-bezier(.4, 0, .2, 1)" not in CSS)
check("JS ANIM_EASE matches --ease",
      "const ANIM_EASE = '" + APPLE_EASE + "'" in JS)
# Height grow/shrink (disclosures AND content enter/exit) uses a
# SYMMETRIC curve --ease-sym — the Apple ease-out opens with a snap
# (11% of time = 76% of travel) and drags on close, so open/close felt
# different speeds; on tall mensa sections the fixed-.45s Apple grow
# slammed content up/down on checkbox toggles. FLIP and the content
# glide keep --ease. Both tokens are single sources of truth, mirrored
# in JS (ANIM_EASE / ENTER_EXIT_EASE).
SYM_EASE = "cubic-bezier(.42, 0, .58, 1)"
sym_decl = re.search(r"--ease-sym:\s*([^;]+);", CSS)
check("--ease-sym token is the symmetric ease-in-out",
      bool(sym_decl) and SYM_EASE in sym_decl.group(1))
check("JS ENTER_EXIT_EASE matches --ease-sym",
      "const ENTER_EXIT_EASE = '" + SYM_EASE + "'" in JS)
no_var2 = CSS.replace("var(--ease-sym)", "")
check("every max-height transition uses var(--ease-sym)",
      not re.search(r"transition:[^;]*max-height[^;]*var\(--ease\)", no_var2))
check("no max-height transition with bare ease",
      not re.search(r"transition:[^;]*max-height[^;]*\bease\b", no_var2))
# renderAll coalesces in-flight disclosures (content rebuild would
# otherwise clip/snap against the stale max-height lock).
ra = JS[JS.index("function renderAll"):JS.index("function flipPlay")]
check("renderAll coalesces in-flight disclosures",
      "el._expandTimer" in ra and "el.style.maxHeight = 'none'" in ra)

print("== B3. corners (Apple tokens + squircle upgrade) ==")
# All border-radius values must be tokens (exclude comment lines).
# NOTE: the \s* lives INSIDE the negative lookahead — putting it outside
# lets the regex backtrack past it and match " var(--r-...)" anyway.
bad_radius = [m for m in re.findall(r"border-radius:(?!\s*(?:var\(--r-(?:sm|md|lg|pill|circle)\)|calc\(var\(--r-(?:sm|md|lg|pill|circle)\)[^)]*\)|inherit|15%))[^;]+;", CSS)
              if "*/" not in m]
check("every border-radius uses a --r-* token", not bad_radius, str(bad_radius[:3]))
for tok in ("--r-sm", "--r-md", "--r-lg", "--r-pill", "--r-circle"):
    check(f"token {tok} defined", f"{tok}:" in CSS)
check("squircle progressive enhancement present",
      "@supports (corner-shape: squircle)" in CSS and
      "corner-shape: squircle" in CSS)
def block_after(marker, text):
    """Text inside the first balanced {…} after marker (for @supports)."""
    i = text.index(marker) + len(marker)
    j = text.index("{", i)
    depth, k = 0, j
    while k < len(text):
        if text[k] == "{":
            depth += 1
        elif text[k] == "}":
            depth -= 1
            if depth == 0:
                return text[j + 1:k]
        k += 1
    return ""

# Squircle is a progressive enhancement for the two LARGE FRAMED
# surfaces ONLY (AGENTS.md #9) — controls stay pills. The old check
# sliced to EOF, so it passed vacuously no matter what the @supports
# block contained (and demanded the opposite of AGENTS.md).
sq = block_after("@supports (corner-shape: squircle)", CSS)
check("squircle covers ONLY framed surfaces (controls stay pills)",
      ".calendar-inner" in sq and ".raw-inner" in sq and
      not any(s in sq for s in (".segmented", ".seg-thumb", ".group-chip")))

print("== B4. design decisions (product owner, hard-coded) ==")
check("trigger outline is box-shadow inset (not border)",
      "box-shadow: inset 0 0 0 1px transparent" in CSS and
      not re.search(r"\.date-trigger\s*\{[^}]*border:\s*1px", CSS))
# Toggle rows (mensa + photo) are FLAT on hover — the M3 state-layer
# grey was explicitly rejected (product owner). Group chips keep theirs.
check("no hover grey on toggle rows (mensa/photo)",
      ".mensa-row:hover" not in CSS and ".mensa-row::before" not in CSS)
check("calendar gap symmetric (::before spacer + constant seg margin, NO margin animation)",
      ".calendar::before" in CSS and
      "margin: 24px auto" not in CSS and
      ".header.calendar-open .segmented" not in CSS and
      "NO margin animation" in CSS)
check("no negative margins anywhere",
      not re.search(r"margin:\s*-\d", CSS))
check("dark palette two entry points in sync",
      CSS.count("--bg: #000000") >= 2)
check("groupMembers single source of truth",
      "function groupMembers(name)" in JS and
      "members: groupMembers(" in JS)
check("photos height choreography (no fade path)",
      "el.style.height = '0'" in ap and "opacity" not in ap)

print("== C. disclosure machinery (max-height + scrollHeight) ==")
check("expandBody/collapseBody exist and are used by calendar",
      "function expandBody(body)" in JS and "collapseBody(cal)" in JS)
check("raw panel stays a max-height disclosure",
      "expandBody" in JS)
check("content-height glide exists for wholesale swaps",
      "function animateContentHeight(node, oldH, newH)" in JS and
      "node.style.height = oldH + 'px'" in JS and
      "node.style.height = newH + 'px'" in JS)
check("glide is driven from renderAll with entering/exiting guard",
      "!content.querySelector('[data-entering]')" in JS and
      "!content.querySelector('[data-exiting]')" in JS and
      "animateContentHeight(content, oldH, newH)" in JS)
check("rapid toggles coalesce (settle before measuring)",
      "function settleContentHeight(node)" in JS and
      "if (content._heightGlideEnd) settleContentHeight(content)" in JS)
check("glide has timeout fallback (transitionend may never fire)",
      "_glideTimer = setTimeout" in JS)
# The 'none' poison: settleContentHeight must clear the inline
# transition with '' — 'none' stays inline and the NEXT glide builds
# the invalid "none, height ..." list, silently killing the animation
# (the "content appears without animation" regression).
check("settle clears transition with '' (not 'none')",
      "node.style.transition = '';" in JS and
      "node.style.transition = 'none';" not in JS)
check("glide/enter never prepend 'none' to a transition list",
      JS.count("cur !== 'none'") >= 2)
check("glide target includes photos (applyPhotos before newH, fresh at natural height)",
      "applyPhotos(); // idempotent <img> sync — BEFORE the height measurement" in JS and
      "dishEl.dataset.fresh === '1'" in JS and
      "delete dishEl.dataset.fresh" in JS)

print("== C2. enter/exit symmetry (pipeline default, not per-feature) ==")
enter_sec = JS[JS.index("function animateEnter"):JS.index("function animateExit")]
check("animateEnter exists and grows from 0 height",
      "function animateEnter(node)" in JS and
      "node.style.height = '0'" in enter_sec)
check("enter keeps overflow clipped through grow, then restores it on end/fallback",
      "node.style.overflow = 'hidden';" in enter_sec and
      "const finishEnter = () => {" in enter_sec and
      "node.style.overflow = '';" in enter_sec and
      "if (e.target === node && e.propertyName === 'height') finishEnter();" in enter_sec and
      "setTimeout(finishEnter, dur + 150)" in enter_sec)
check("reconcileChildren calls animateEnter for added nodes",
      "animateEnter(node)" in JS[JS.index("function reconcileChildren"):JS.index("function updatePhotoToggle")])
check("nested-enter guard (closest data-entering)",
      "closest('[data-entering]')" in JS)
check("no per-feature enter fades elsewhere",
      "opacity" not in enter_sec)
# Deferred removal (AnimatePresence / Vue TransitionGroup "leave" hook):
# removed nodes shrink to 0 height first, then are physically removed —
# siblings slide up during the shrink (no jump); a key that reappears
# mid-exit is REVIVED, not duplicated. The 500ms timer is the
# transitionend fallback (the event is not generated when a transition
# is removed before completion — MDN).
exit_sec = JS[JS.index("function animateExit"):JS.index("function reconcileChildren")]
check("animateExit shrinks then removes (deferred removal)",
      "function animateExit(node)" in JS and
      "node.style.height = '0px'" in exit_sec and
      "node.remove()" in exit_sec and
      "_exitTimer = setTimeout" in exit_sec and
      "clearTimeout(node._exitTimer)" in exit_sec)
check("reconcile exits removed nodes (not instant remove)",
      "animateExit(child)" in JS[JS.index("function reconcileChildren"):JS.index("function updatePhotoToggle")])
# The exit shrink must reach TRUE zero: the boxes are border-box, so
# height:0 alone leaves the vertical padding as a visible strip that
# pops when the node is removed (prohibition #4's clipped-box padding
# trap in exit form). reviveExit must restore it for rapid re-adds.
check("animateExit zeroes vertical padding (no strip pop on remove)",
      "node.style.paddingTop = '0px'" in exit_sec and
      "node.style.paddingBottom = '0px'" in exit_sec and
      "padding ' + dur + 'ms" in exit_sec)
# Enter/exit duration scales with the node's height (the disclosure
# rule): a fixed .45s slammed tall sections open/shut — the checkbox
# "content rushes up from below" complaint. The grow/shrink uses the
# symmetric disclosure curve, not the front-loaded Apple ease.
check("enter/exit duration scales with node height (expandDuration)",
      "const dur = expandDuration(node, h)" in exit_sec and
      "dur + 150" in exit_sec and
      "dur + 150" in JS[JS.index("function animateEnter"):JS.index("function animateExit")])
check("animateEnter scales duration + symmetric curve (no fixed .45s)",
      "expandDuration(node, h)" in enter_sec and
      "'height ' + dur + 'ms ' + ENTER_EXIT_EASE" in enter_sec and
      ".45s" not in enter_sec and
      ".45s" not in exit_sec)
# The enter side zeroes the vertical padding too (symmetric with
# animateExit): border-box height:0 alone leaves the padding as a
# visible strip that flashes the title's top half and stalls the grow
# while the first frames climb past the padding floor (the checkbox-add
# stall). The measure restores the padding first so h includes it.
check("animateEnter zeroes vertical padding (no strip flash at grow start)",
      "node.style.paddingTop = '0px'" in enter_sec and
      "node.style.paddingBottom = '0px'" in enter_sec and
      "padding ' + dur + 'ms" in enter_sec and
      "node.style.paddingTop = ''" in enter_sec)
check("reviveExit restores the padding (rapid re-add keeps the air)",
      "node.style.paddingTop = ''" in exit_sec and
      "node.style.paddingBottom = ''" in exit_sec)
# Sibling FLIP after exit: the container snapshots its children BEFORE
# the removed node is dropped, then flipPlay glides the survivors into
# the freed space (reflows the height shrink cannot carry — e.g. chips
# re-wrapping). The exiting node must NOT be a FLIP anchor anywhere.
check("sibling FLIP after exit (removeExited snapshots parent)",
      "flipFirst(parent)" in exit_sec and
      "flipPlay(parent, first)" in exit_sec)
check("reappearing key revives exiting node (rapid toggles)",
      "reviveExit(node)" in JS and
      "delete node.dataset.exiting" in JS)
# Insertion anchors: BOTH exiting nodes AND stale nodes (key not in the
# target key list) must be skipped. A stale node used as an anchor
# walks every survivor in front of the doomed node — the doomed node
# lands at the END of the list, everything above jumps up instantly,
# and the exit shrink runs off-screen (the checkbox-remove
# no-animation regression).
check("stale nodes skipped as anchors (nextLiveChild filters by key set)",
      "function nextLiveChild(container, idx, keep)" in JS and
      "child.dataset.exiting) continue" in JS and
      "keep.has(child.dataset.key)) continue" in JS and
      "const keep = new Set(keys)" in JS)
check("FLIP skipped while entering OR exiting (no fight with height anims)",
      "container.querySelector('[data-exiting]')" in JS and
      "container.querySelector('[data-entering]')" in JS)
check("collapseBody clears the expand timer (no mid-collapse spring-open)",
      "clearTimeout(body._expandTimer)" in JS)
check("enter state has fallback timer (transitionend may never fire)",
      "_enterTimer = setTimeout" in JS and
      "clearTimeout(node._enterTimer)" in JS)
check("animateExit takes over entering nodes cleanly (rapid toggles)",
      "delete node.dataset.entering" in JS[JS.index("function animateExit"):JS.index("function reviveExit")] and
      "node.removeEventListener('transitionend', node._enterEnd);" in
      JS[JS.index("function animateExit"):JS.index("function reviveExit")])
check("closing photo revived on reopen (photoClosing guard)",
      "img.dataset.photoClosing" in JS and
      "delete img.dataset.photoClosing" in JS and
      "if (img.dataset.photoClosing) img.remove()" in JS)
check("dishes swap symmetrically (enter=true in renderContent)",
      ", false, true);" in JS[JS.index("function renderContent"):JS.index("function applyPhotos")] and
      ", false, false);" not in JS[JS.index("function renderContent"):JS.index("function applyPhotos")])

print("== D. data model ==")
check("activeMensas is the single dataset accessor",
      "function activeMensas()" in JS and "data.days[selectedDate]" in JS)
check("no raw data.mensas refs",
      "data.mensas" not in JS.replace("activeMensas()", ""))
check("calendar date NOT persisted (today-product)",
      "selectedDate" in JS and
      "selectedDate" not in JS[JS.index("function loadPrefs"):JS.index("function savePrefs")])
# Prices + opening hours: the frontend renders them from the dish/mensa
# records — data.json must carry them or the UI silently shows nothing.
check("dish price rendered from record (priceHTML + slide wrap)",
      "function priceHTML(d)" in JS and
      "d.price" in JS and "price-wrap" in JS and "dish-price" in JS)
check("price slide driven by show-prices setting (no parens)",
      "show-prices" in JS and "show-opening" in JS and
      "html.show-prices .price-wrap" in CSS and
      "max-height: 0" in CSS[CSS.index(".price-wrap"):CSS.index(".dish-price")] and
      "(' + parts.join" not in JS)
check("opening hours rendered from record (hours-line + setting)",
      "hours-line" in JS and "hours-pop" not in JS and
      "hours-dot" not in JS and
      "Not open today" in JS and "(m.opening || {})" in JS)
check("normalizeMensas keeps opening (hours regression guard)",
      "m.opening" in JS[JS.index("function normalizeMensas"):JS.index("function validatePrefsAgainstData")])
check("settings rows bound (opening-row / price-row)",
      "opening-row" in JS and "price-row" in JS and
      "function updateHoursLines" in JS and
      "updateHoursLines();" in JS[JS.index("function renderAll"):JS.index("function flipPlay")])
check("closed slots: no caret/body, always 'No meals available'",
      "no-meal-slot" in JS and
      "No meals available" in JS and
      "No meals available" in JS[JS.index("function updateHoursLines"):JS.index("function dishKey")] and
      "slotClosed ? '' : body" in JS and
      "if (section.classList.contains('no-meal-slot')) return;" in JS)
# Expand/collapse: duration scales with content height (a 3000px menu
# must not "snap" at the same duration as a 40px empty slot), and the
# section contains its layout so meal-switch reflows stay local.
check("expand duration scales with content height",
      "function expandDuration" in JS and
      "transitionDuration" in JS and
      "Math.min(900, Math.max(450" in JS and
      "var(--expand-d" not in CSS and
      "var(--expand-d" not in JS)
check("sections contain layout (meal-switch reflow isolation)",
      "contain: layout style paint" in CSS and
      "content-visibility: auto" not in CSS)
# Duplicate-section regression guards: every section rendered by
# mensaSectionHTML carries its own data-key (outerHTML replacements
# keep it, so keyed reconcile never duplicates), and reconcile drops
# keyless leftovers IMMEDIATELY (no exit animation — they are dirty
# data that would linger as text-less duplicates).
check("mensaSectionHTML renders data-key (duplicate-section guard)",
      'data-key="' in JS[JS.index("function mensaSectionHTML"):JS.index("function updateHoursLines")] and
      "data-key" in JS[JS.index("function mensaSectionHTML"):JS.index("function updateHoursLines")])
check("reconcile removes keyless nodes immediately",
      "if (!child.dataset.key) {" in JS and
      "child.remove();" in JS[JS.index("for (const child of Array.from(container.children))"):JS.index("// Enter choreography")])
check("hours text rendered at section creation (no text-less duplicates)",
      "hoursText" in JS and
      "esc(hoursText)" in JS)

print("== D2. decoupling (no duplicate sync helpers, no stray DOM surgery) ==")
check("no positionThumb duplicate (updateSegmented is the only sync)",
      "positionThumb" not in JS)
check("no second segmented sync helper",
      JS.count("function updateSegmented") == 1 and
      JS.count("seg.dataset.meal = prefs.meal") <= 2)
# The appearance switch has its own options (data-theme) and its own
# sync (updateAppearance). A blanket '.seg-option' query in the meal
# sync wipes the appearance switch's active class on load/resize —
# the "Light starts grey" regression.
check("updateSegmented scoped to [data-meal] (appearance switch isolated)",
      ".seg-option[data-meal]" in JS[JS.index("function updateSegmented"):JS.index("function updateRawText")] and
      "querySelectorAll('.seg-option')" not in JS[JS.index("function updateSegmented"):JS.index("function updateRawText")])
check("feature code has no raw appendChild loops",
      not re.search(r"for \([^)]*\) \{[^}]*appendChild", JS) or
      "reconcileChildren" in JS)  # reconcile owns inserts
check("state accessors are the only data reads",
      JS.count("activeMensas()") >= 6 and JS.count("groupMembers(") >= 3)

print("== E. syntax ==")
r = subprocess.run(["node", "--check", str(ROOT / "template" / "app.js")],
                   capture_output=True, text=True)
check("node --check app.js", r.returncode == 0, r.stderr[:200])
r = subprocess.run([sys.executable, "-m", "py_compile", str(ROOT / "menu.py")],
                   capture_output=True, text=True)
check("python compile menu.py", r.returncode == 0, r.stderr[:200])

print()
if FAILURES:
    print(f"CONTRACT VIOLATIONS ({len(FAILURES)}):")
    for f in FAILURES:
        print(f"  - {f}")
    sys.exit(1)
print("Contract intact — all checks passed.")
