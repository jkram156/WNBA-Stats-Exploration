# WNBA Stats Exploration

Local SQLite sync tooling for the raw ESPN WNBA exports from `wehoop-wnba-raw`.

## Setup

```powershell
pnpm install
```

This repo includes `wnba_raw.sqlite` as a Git LFS seed database so a fresh clone can start from the compact parsed tables without rebuilding from the full raw export checkout. Install Git LFS before cloning or run this after cloning:

```powershell
git lfs install
git lfs pull
```

The seed database is compact by default: it does not include `raw_files`, raw source payloads, or extracted raw JSON sidecars. Re-run the sync commands below when you want to refresh it from a local `wehoop-wnba-raw` checkout.

## Sync Raw Exports

By default, the sync reads from `C:\Users\jkram\github\wehoop-wnba-raw` and writes `wnba_raw.sqlite` in the current project root. You can override either location with `WNBA_RAW_ROOT`, `WNBA_RAW_DB`, `--source`, or `--db`.

```powershell
pnpm run sync:raw
```

Useful options:

```powershell
pnpm run sync:raw -- --source C:\Users\jkram\github\wehoop-wnba-raw --db .\wnba_raw.sqlite
pnpm run sync:raw -- --prune
pnpm run sync:raw -- --dry-run
pnpm run sync:raw -- --store-source-metadata
pnpm run sync:raw -- --store-raw-content
pnpm run sync:raw -- --store-extracted-json
```

By default, the database stores the parsed relational tables only. The source payloads remain in the source checkout, and raw JSON sidecars in parsed tables are left empty. Use `--store-source-metadata` if you want a `raw_files` inventory table with source paths and hashes, `--store-raw-content` if you also want raw JSON text and parquet/RDS blobs embedded in SQLite, or `--store-extracted-json` if you want raw JSON sidecars in the parsed tables.

To strip an older copied database down to parsed data and reclaim disk space:

```powershell
pnpm run compact:db
```

This drops `raw_files`, clears raw JSON sidecar columns, and runs `VACUUM`. Add `--keep-source-metadata` to retain `raw_files`, or `--no-vacuum` to skip the file rewrite.

## Evaluate Rolling Windows

Compare prior-game rolling averages as predictors of the next team-game result with a rolling-origin backtest from 2023 onward:

```powershell
pnpm run eval:rolling
```

Useful options:

```powershell
pnpm run eval:rolling -- --windows 8,10,12,14,16,20
pnpm run eval:rolling -- --rolling-from 2023 --rolling-through 2025
pnpm run eval:rolling -- --single-split --train-through 2023 --validate-season 2024 --test-season 2025
pnpm run eval:rolling -- --min-prior-games 5
pnpm run eval:rolling -- --rolling-through 2025 --windows 20 --ablation
pnpm run eval:rolling -- --rolling-through 2025 --windows 10,20 --skip-mixed --opponent-adjusted
pnpm run eval:rolling -- --rolling-through 2025 --stability
pnpm run eval:rolling -- --rolling-through 2025 --lean-candidates
pnpm run eval:rolling -- --rolling-through 2025 --no-context-drops
pnpm run eval:rolling -- --rolling-through 2025 --best-candidate-cleanup
pnpm run eval:rolling -- --rolling-through 2025 --calibration
```

## Sync ESPN Schedule

Fetch the WNBA schedule from ESPN's public scoreboard API and store it in the local SQLite database:

```powershell
pnpm run sync:espn-schedule -- --season 2026
```

This writes normalized schedule rows to `espn_schedule_events` and `espn_schedule_competitors`. Raw ESPN event/competitor JSON sidecars are skipped by default; add `--store-extracted-json` if you need them for audit work.

## Predict Upcoming Games

Generate upcoming-game win probabilities from the raw `n=20` strength-core model:

```powershell
pnpm run predict:upcoming -- --from 2026-06-16 --limit 12 --html .\reports\upcoming-predictions.html
```

To compare model probability against the betting market, pass a JSON market file:

```powershell
pnpm run predict:upcoming -- --from 2026-06-16 --limit 12 --markets .\reports\market-lines.example.json --html .\reports\upcoming-predictions.html
```

To fetch current Pinnacle market lines first and store the matched bookmaker lines in SQLite:

```powershell
pnpm run fetch:markets -- --from 2026-06-16 --limit 12
pnpm run predict:upcoming -- --from 2026-06-16 --limit 12 --markets-db --html .\reports\upcoming-predictions.html
```

The fetcher uses Crawlee/Playwright against Pinnacle's WNBA pages, writes one row per matched game to `market_lines`, and records run metadata in `market_line_sync_runs`. It crawls with one request at a time, a randomized pre-navigation delay, and a post-navigation hydration wait. Useful scraper options:

```powershell
pnpm run fetch:markets -- --source-url https://www.pinnacle.com/en/basketball/wnba/matchups/ --min-delay-ms 5000 --max-delay-ms 9000 --post-navigation-delay-ms 7000
pnpm run fetch:markets -- --headed --debug-dump .\reports\pinnacle-debug.json
```

By default, the predictor reads the latest successful market sync and averages no-vig moneyline probabilities across available books. Pinnacle is currently the fetched book, so this selects those rows explicitly:

```powershell
pnpm run predict:upcoming -- --markets-db --market-bookmaker pinnacle --html .\reports\upcoming-predictions.html
```

To also export the fetched consensus market rows to JSON for inspection or manual editing, add `--out` to the fetch step:

```powershell
pnpm run fetch:markets -- --out .\reports\market-lines.json
```

Market rows can be keyed by `eventId`, `shortName`, or `away @ home` text. Use either no-vig-ready implied probabilities or American moneylines; the script normalizes both sides to remove hold before calculating edge.

```json
[
  {
    "shortName": "TOR @ IND",
    "homeImpliedProbability": 0.75,
    "awayImpliedProbability": 0.25,
    "homeSpread": -6.5,
    "book": "manual"
  }
]
```

The value side is `model win probability - no-vig market-implied win probability`. Spreads are displayed as context only; the current model is not yet an against-the-spread cover model.

The evaluator builds one row per team-game, using only each team and opponent's previous games for rolling features. For each target season, it trains on all earlier seasons and reports average log loss, Brier score, accuracy, and ROC AUC across the target seasons.

The feature set includes rolling box-score stats plus basketball context such as home court, rest days, rest advantage, back-to-back indicators, recent win rate, recent home-game rate, recent close-game rate, and point matchup edges.

For faster global-window scans with feature importance:

```powershell
pnpm run eval:rolling -- --skip-mixed --rolling-through 2025
```

After the global-window comparison, it also evaluates a mixed-window model. For each target season, the mixed model selects a separate rolling window for each stat using validation log loss from one-stat models on the immediately prior season, then evaluates the target season.

For grouped feature ablation, use:

```powershell
pnpm run eval:rolling -- --rolling-through 2025 --windows 10,20 --ablation
```

This prints feature-family-only and feature-family-removed results, with log-loss deltas against the same-window all-feature model.

For opponent-strength-adjusted recent form, use:

```powershell
pnpm run eval:rolling -- --rolling-through 2025 --windows 10,20 --skip-mixed --opponent-adjusted
```

This adds rolling adjusted-offense, adjusted-defense, and adjusted-margin features computed from only the opponent information available before each prior game.

For per-season stability checks of the leading candidate feature sets, use:

```powershell
pnpm run eval:rolling -- --rolling-through 2025 --stability
```

For compact raw-margin versus opponent-adjusted-margin comparisons, use:

```powershell
pnpm run eval:rolling -- --rolling-through 2025 --lean-candidates
```

For adjusted no-context drop-family comparisons, use:

```powershell
pnpm run eval:rolling -- --rolling-through 2025 --no-context-drops
```

For cleanup variants of the current best adjusted no-context model, use:

```powershell
pnpm run eval:rolling -- --rolling-through 2025 --best-candidate-cleanup
```

For calibration buckets on the raw strength baseline and current best practical candidate, use:

```powershell
pnpm run eval:rolling -- --rolling-through 2025 --calibration
```
