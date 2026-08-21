#!/usr/bin/env python3
"""Fail a deployment before a malformed or unexpectedly empty menu goes live."""

import argparse
import json
import sys
from datetime import date
from pathlib import Path


EXPECTED_MENSA_COUNT = 32
MEAL_SLOTS = ("Lunch", "Dinner")


def fail(message):
    print(f"Menu health check failed: {message}", file=sys.stderr)
    raise SystemExit(1)


def load_payload(path):
    try:
        with path.open(encoding="utf-8") as f:
            payload = json.load(f)
    except (OSError, json.JSONDecodeError) as err:
        fail(f"cannot read {path}: {err}")

    if not isinstance(payload, dict):
        fail("root must be a JSON object")
    return payload


def validate_payload(payload, allow_empty_today=False):
    today = payload.get("date")
    if not isinstance(today, str):
        fail("missing string field 'date'")
    try:
        today_date = date.fromisoformat(today)
    except ValueError:
        fail(f"'date' is not an ISO date: {today!r}")

    days = payload.get("days")
    if not isinstance(days, dict):
        fail("missing object field 'days'")
    day = days.get(today)
    if not isinstance(day, dict):
        fail(f"missing active day {today!r} in 'days'")
    mensas = day.get("mensas")
    if not isinstance(mensas, list):
        fail(f"active day {today!r} has no mensa list")
    if len(mensas) != EXPECTED_MENSA_COUNT:
        fail(
            f"active day {today!r} has {len(mensas)} mensas; "
            f"expected {EXPECTED_MENSA_COUNT}"
        )

    ids = set()
    dish_count = 0
    by_slot = {slot: 0 for slot in MEAL_SLOTS}
    for mensa in mensas:
        if not isinstance(mensa, dict):
            fail("mensa list contains a non-object entry")
        mensa_id = mensa.get("id")
        if not isinstance(mensa_id, str) or not mensa_id:
            fail("mensa is missing a non-empty string 'id'")
        if mensa_id in ids:
            fail(f"duplicate mensa id {mensa_id!r}")
        ids.add(mensa_id)

        meals = mensa.get("meals")
        if not isinstance(meals, dict):
            fail(f"mensa {mensa_id!r} is missing its 'meals' object")
        for slot in MEAL_SLOTS:
            dishes = meals.get(slot)
            if not isinstance(dishes, list):
                fail(f"mensa {mensa_id!r} has no {slot!r} dish list")
            for dish in dishes:
                if not isinstance(dish, dict) or not str(dish.get("dish", "")).strip():
                    fail(f"mensa {mensa_id!r} has an invalid {slot!r} dish")
            by_slot[slot] += len(dishes)
            dish_count += len(dishes)

    weekday = today_date.weekday() < 5
    if weekday and dish_count == 0 and not allow_empty_today:
        fail(
            f"{today} is a weekday but contains no dishes. "
            "Fix the scraper or re-run manually with allow_empty_today=true "
            "for a known holiday or closure."
        )

    status = "allowed empty day" if dish_count == 0 else f"{dish_count} dishes"
    print(
        f"Menu health check passed: {today}; {len(mensas)} mensas; {status} "
        f"(Lunch {by_slot['Lunch']}, Dinner {by_slot['Dinner']})."
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("data_file", type=Path)
    parser.add_argument(
        "--allow-empty-today",
        action="store_true",
        help="allow zero dishes on an active weekday for a known closure",
    )
    args = parser.parse_args()
    validate_payload(load_payload(args.data_file), args.allow_empty_today)


if __name__ == "__main__":
    main()
