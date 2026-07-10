"""Fetch only completed WNBA games that do not have a final JSON file yet."""

from __future__ import annotations

import argparse
import importlib.util
import os
from pathlib import Path
from types import ModuleType

import pandas as pd


def load_raw_scraper(raw_root: Path) -> ModuleType:
    scraper_path = raw_root / "python" / "scrape_wnba_json.py"
    if not scraper_path.is_file():
        raise FileNotFoundError(f"Raw game scraper not found: {scraper_path}")

    spec = importlib.util.spec_from_file_location("wehoop_scrape_wnba_json", scraper_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load raw game scraper: {scraper_path}")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def outstanding_game_ids(raw_root: Path, season: int) -> tuple[pd.DataFrame, list[int]]:
    schedule_path = raw_root / "wnba" / "schedules" / "parquet" / f"wnba_schedule_{season}.parquet"
    if not schedule_path.is_file():
        raise FileNotFoundError(f"Season schedule not found: {schedule_path}")

    schedule = pd.read_parquet(schedule_path)
    required_columns = {"game_id", "season", "status_type_completed"}
    missing_columns = required_columns.difference(schedule.columns)
    if missing_columns:
        raise ValueError(f"Schedule is missing required columns: {', '.join(sorted(missing_columns))}")

    final_dir = raw_root / "wnba" / "json" / "final"
    existing_ids = {
        int(path.stem)
        for path in final_dir.glob("*.json")
        if path.stem.isdigit()
    }
    completed = schedule[
        (schedule["season"] == season)
        & (schedule["status_type_completed"] == True)  # noqa: E712 - pandas comparison
    ].copy()
    completed["game_id"] = completed["game_id"].astype(int)
    outstanding = sorted(set(completed["game_id"]).difference(existing_ids))
    return schedule, outstanding


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw-root", type=Path, required=True, help="Path to the wehoop-wnba-raw checkout")
    parser.add_argument("--season", type=int, required=True, help="WNBA season year")
    parser.add_argument("--dry-run", action="store_true", help="List outstanding game IDs without fetching them")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    raw_root = args.raw_root.resolve()
    schedule, game_ids = outstanding_game_ids(raw_root, args.season)

    print(f"Found {len(game_ids)} completed {args.season} game(s) without final JSON.")
    if game_ids:
        print("Outstanding game IDs: " + ", ".join(str(game_id) for game_id in game_ids))

    if args.dry_run or not game_ids:
        return 0

    original_directory = Path.cwd()
    try:
        os.chdir(raw_root)
        scraper = load_raw_scraper(raw_root)
        scraper.download_game_pbps(
            game_ids,
            True,
            scraper.path_to_raw,
            scraper.path_to_final,
        )
        scraper.add_game_to_schedule(schedule, args.season)
    finally:
        os.chdir(original_directory)

    unresolved = [
        game_id
        for game_id in game_ids
        if not (raw_root / "wnba" / "json" / "final" / f"{game_id}.json").is_file()
    ]
    fetched = len(game_ids) - len(unresolved)
    print(f"Fetched final JSON for {fetched} of {len(game_ids)} outstanding game(s).")
    if unresolved:
        print("Still outstanding and eligible for retry: " + ", ".join(str(game_id) for game_id in unresolved))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
