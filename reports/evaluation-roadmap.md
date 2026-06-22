# WNBA Rolling Window Evaluation Roadmap

## Current Objective

Evaluate which recent-team-form features help predict whether a WNBA team wins its next game, using leakage-safe rolling-origin backtests from 2023 onward.

The main evaluation unit is one team-game row:

- One WNBA game creates two rows, one per team.
- The target is whether that row's team won.
- Features use only games played before the game being predicted.
- The main model is regularized logistic regression.
- Primary metric is log loss because we care about probability quality, not only correct picks.

## Work Log

### 1. Built Initial Rolling Window Evaluator

Created `src/evaluate-rolling-windows.ts`.

Initial evaluator:

- Loaded completed team-game rows from `wnba_raw.sqlite`.
- Built prior-game rolling averages.
- Tested global rolling windows.
- Used chronological splits to avoid leakage.
- Reported log loss, Brier score, accuracy, and ROC AUC.

Initial window candidates:

```text
3, 5, 8, 10, 12, 14, 16, 20
```

### 2. Tested Whether Shorter Windows Help

Shorter windows were tested directly.

Completed-season 2023-2025 global-window results before added context:

```text
n=3   log loss 0.6537
n=5   log loss 0.6412
n=8   log loss 0.6339
n=10  log loss 0.6262
n=12  log loss 0.6267
n=14  log loss 0.6283
n=16  log loss 0.6283
n=20  log loss 0.6260
```

Finding:

- Very short windows, especially `n=3` and `n=5`, were weaker.
- The useful range appears closer to `n=10` through `n=20`.
- `n=20` narrowly led among completed seasons before context features.

### 3. Added Mixed-Window Evaluation

Added a mixed-window approach:

- Each stat can use its own rolling window.
- Window selection uses the immediately prior season.
- The target season is not used to choose windows.

Completed-season 2023-2025 result before added context:

```text
n=20 global  log loss 0.6260
mixed model  log loss 0.6261
```

Finding:

- Mixed windows were competitive.
- They did not clearly beat the best simple global window on completed seasons.
- Mixed windows looked better when partial 2026 was included, but that result is provisional.

### 4. Shifted Evaluation to 2023 Onward

Changed the default approach to rolling-origin evaluation from 2023 onward.

For each target season:

```text
target season = 2023
train = seasons before 2023

target season = 2024
train = seasons before 2024

target season = 2025
train = seasons before 2025
```

Finding:

- This is a better setup than one fixed train/validation/test split.
- It better simulates real future prediction.

### 5. Added More Basketball Context

Added context features beyond raw box-score rolling averages:

- Home indicator.
- Team rest days.
- Opponent rest days.
- Rest advantage.
- Team back-to-back flag.
- Opponent back-to-back flag.
- Recent win rate.
- Recent home-game rate.
- Recent close-game rate.
- Recent average rest.
- Point matchup edges, such as team recent scoring vs opponent recent points allowed.

Latest completed-season global-window results with context:

```text
n=3   log loss 0.6540
n=5   log loss 0.6402
n=8   log loss 0.6347
n=10  log loss 0.6258
n=12  log loss 0.6270
n=14  log loss 0.6287
n=16  log loss 0.6272
n=20  log loss 0.6253
```

Finding:

- Context features slightly improved the best completed-season global log loss from about `0.6260` to `0.6253`.
- `n=20` remains the best simple global window so far.
- `n=10` remains very close.

### 6. Added First Feature Importance Pass

Added two importance checks:

- Standardized coefficient.
- Permutation log-loss delta.

The feature-importance scan was run on the best global window, `n=20`, evaluated on 2025.

Top factors:

```text
home_indicator
margin_diff
team_margin_avg
opponent_margin_avg
scoreAgainst_diff
winPct_diff
assists_diff
fieldGoalPct_diff
scoreFor_diff
homeRate_diff
```

Finding:

- Home court is the strongest single factor in the latest check.
- Recent scoring margin is highly useful.
- Defensive signal matters through points allowed and margin.
- Win-rate difference helps, but margin-related features are stronger.
- Some box-score stats, especially assists and field goal percentage, add smaller signal.

### 7. Created Summary Reports

Created:

- `reports/rolling-window-summary.html`
- `reports/rolling-window-summary-eli5.html`

These summarize the methodology, findings, and plain-English interpretation.

### 8. Added Grouped Feature Ablation

Added `--ablation` mode to `src/evaluate-rolling-windows.ts`.

The first verified run used:

```powershell
pnpm run eval:rolling -- --rolling-through 2025 --windows 20 --ablation
```

Completed-season rolling-origin result for `n=20`:

```text
all_features                 log loss 0.6258
context_only                 log loss 0.6926
margin_strength_only         log loss 0.6242
shooting_only                log loss 0.6657
rebounding_only              log loss 0.6704
turnovers_only               log loss 0.6807
creation_defense_only        log loss 0.6607
matchup_edges_only           log loss 0.6938
all_except_context           log loss 0.6253
all_except_margin_strength   log loss 0.6357
all_except_shooting          log loss 0.6251
all_except_rebounding        log loss 0.6258
all_except_turnovers         log loss 0.6259
all_except_creation_defense  log loss 0.6258
all_except_matchup_edges     log loss 0.6258
```

Finding:

- Margin/strength features carry the clearest signal.
- `margin_strength_only` slightly beat the full model in this first pass.
- Removing margin/strength clearly hurt log loss.
- Shooting and creation/defense have some standalone signal but add little once margin/strength is present.
- Rebounding, turnovers, and matchup-edge features did not improve the full model in this run.
- Context-only is weak, and removing context slightly helped in this first pass, suggesting home/rest context may be duplicated or overfit in the full feature set.

### 9. Tested Opponent-Strength Adjusted Recent Form

Added `--opponent-adjusted` mode to `src/evaluate-rolling-windows.ts`.

The candidate features are:

```text
team_adjustedOffense_avg
opponent_adjustedOffense_avg
adjustedOffense_diff
team_adjustedDefense_avg
opponent_adjustedDefense_avg
adjustedDefense_diff
team_adjustedMargin_avg
opponent_adjustedMargin_avg
adjustedMargin_diff
```

Adjustment method:

- For each prior team-game, compute opponent expectations using only that opponent's games before the prior game.
- `adjustedOffense = team points scored - opponent recent points allowed entering that game`.
- `adjustedDefense = team points allowed - opponent recent points scored entering that game`.
- `adjustedMargin = adjustedOffense - adjustedDefense`.
- Roll those adjusted values forward into the game being predicted.

Verified command:

```powershell
pnpm run eval:rolling -- --rolling-through 2025 --windows 10,20 --skip-mixed --opponent-adjusted
```

Completed-season rolling-origin results:

```text
n=10 adjusted  log loss 0.6244
n=20 adjusted  log loss 0.6271
```

Comparable raw full-feature results:

```text
n=10 raw       log loss 0.6261
n=20 raw       log loss 0.6258
```

Finding:

- Opponent adjustment improved the `n=10` full model by about `0.0017` log-loss points.
- Opponent adjustment made the `n=20` full model worse by about `0.0013` log-loss points.
- The best adjusted full model, `n=10` at `0.6244`, is competitive with but does not beat the current best ablation read, `margin_strength_only` at `0.6242`.
- In the 2025 feature-importance pass for adjusted `n=10`, `adjustedMargin_diff` tied raw `margin_diff` on permutation delta, suggesting adjusted margin is real signal but may duplicate raw margin.

Follow-up adjusted ablation command:

```powershell
pnpm run eval:rolling -- --rolling-through 2025 --windows 10 --ablation --opponent-adjusted
```

Key adjusted `n=10` ablation rows:

```text
all_features                  log loss 0.6244
margin_strength_only          log loss 0.6272
opponent_adjusted_only        log loss 0.6279
all_except_context            log loss 0.6236
all_except_margin_strength    log loss 0.6259
all_except_opponent_adjusted  log loss 0.6261
```

Updated finding:

- The strongest tested row is now adjusted `n=10` with context removed: log loss `0.6236`.
- Removing opponent-adjusted features worsened the adjusted `n=10` full model by about `0.0016`, back to the raw `n=10` result.
- Adjusted features and raw margin-strength features both carry signal; neither family alone matches the best combined no-context model.
- Context remains suspect in the current linear setup: removing it improved adjusted `n=10` from `0.6244` to `0.6236`.

### 10. Added Candidate Stability Check

Added `--stability` mode to compare leading candidate feature sets by target season.

Verified command:

```powershell
pnpm run eval:rolling -- --rolling-through 2025 --stability
```

Per-season log loss:

```text
candidate                         2023    2024    2025    average
raw_n20_all_features              0.6211  0.6341  0.6227  0.6258
raw_n20_margin_strength_only      0.6129  0.6282  0.6303  0.6242
adjusted_n10_all_features         0.6182  0.6327  0.6226  0.6244
adjusted_n10_all_except_context   0.6112  0.6327  0.6261  0.6236
```

Finding:

- Adjusted `n=10` without context remains the best average result.
- Raw `n=20` margin-strength-only is more competitive in 2024 and 2025 and is the best candidate in 2024.
- The no-context adjusted model wins strongly in 2023 but gives back some edge in 2025.
- The choice between raw margin-strength-only and adjusted no-context should not be made from the weighted average alone; the adjusted model is better on average, but the season split shows some instability.

### 11. Added Lean Candidate Comparison

Added `--lean-candidates` mode to isolate raw margin, adjusted margin, and compact no-context combinations.

Verified command:

```powershell
pnpm run eval:rolling -- --rolling-through 2025 --lean-candidates
```

Average completed-season rolling-origin results:

```text
raw_n20_margin_diff_only                   log loss 0.6260
raw_n20_margin_triplet                     log loss 0.6257
raw_n20_strength_core                      log loss 0.6242
adjusted_n10_adjusted_margin_only          log loss 0.6286
adjusted_n10_adjusted_margin_triplet       log loss 0.6282
adjusted_n10_adjusted_form_core            log loss 0.6279
adjusted_n10_raw_plus_adjusted_margin      log loss 0.6260
adjusted_n10_strength_plus_adjusted_form   log loss 0.6253
adjusted_n10_all_except_context            log loss 0.6236
```

Finding:

- Raw `n=20` strength core remains the best compact model tested so far.
- Adjusted margin alone is weaker than raw margin.
- Combining raw margin with adjusted margin is not enough to beat raw strength core.
- The adjusted `n=10` no-context model still wins on average, but its edge is not explained by adjusted margin alone.
- The remaining edge likely comes from broader non-context box-score features interacting with adjusted form, or from regularization benefiting from redundant correlated features.

### 12. Added No-Context Drop-Family Comparison

Added `--no-context-drops` mode to test which non-context feature family explains the adjusted no-context model's edge.

Verified command:

```powershell
pnpm run eval:rolling -- --rolling-through 2025 --no-context-drops
```

Average completed-season rolling-origin results:

```text
raw_n20_strength_core             log loss 0.6242
adjusted_n10_all_except_context   log loss 0.6236
drop_margin_strength              log loss 0.6246
drop_shooting                     log loss 0.6237
drop_rebounding                   log loss 0.6231
drop_turnovers                    log loss 0.6239
drop_creation_defense             log loss 0.6246
drop_matchup_edges                log loss 0.6236
drop_opponent_adjusted            log loss 0.6253
```

Finding:

- The strongest tested model is now adjusted `n=10` with context and rebounding removed: log loss `0.6231`.
- Rebounding features appear to be hurting the adjusted no-context model.
- Dropping matchup edges has almost no effect, reinforcing that those features are redundant with other scoring and margin columns.
- Dropping opponent-adjusted features hurts, so adjusted form is still useful in the broader no-context model.
- Dropping margin/strength or creation/defense also hurts, suggesting those families are worth keeping for now.

### 13. Added Best-Candidate Cleanup

Added `--best-candidate-cleanup` mode to verify and simplify the current best adjusted no-context/no-rebounding candidate.

Verified command:

```powershell
pnpm run eval:rolling -- --rolling-through 2025 --best-candidate-cleanup
```

Average completed-season rolling-origin results:

```text
raw_n20_strength_core                                      log loss 0.6242
adjusted_n10_all_except_context                            log loss 0.6236
adjusted_n10_drop_context_rebounding                       log loss 0.6231
adjusted_n10_drop_context_rebounding_matchup_edges         log loss 0.6231
adjusted_n10_drop_context_rebounding_shooting              log loss 0.6235
adjusted_n10_drop_context_rebounding_turnovers             log loss 0.6232
adjusted_n10_drop_context_rebounding_creation_defense      log loss 0.6240
adjusted_n10_drop_context_rebounding_shooting_matchup_edges log loss 0.6235
```

Finding:

- The `0.6231` result was reproduced, so removing rebounding from the adjusted no-context model is not a one-off table artifact.
- Removing matchup edges after context and rebounding is essentially neutral; they are safe to treat as redundant in this model family.
- Removing shooting or turnovers slightly worsens log loss.
- Removing creation/defense worsens log loss more, so assists/steals/blocks still appear useful in the best candidate family.
- The best practical candidate is now adjusted `n=10` with context, rebounding, and matchup edges removed.

### 14. Added Calibration Check

Added `--calibration` mode to compare probability buckets for:

- Raw `n=20` strength core.
- Adjusted `n=10` with context, rebounding, and matchup edges removed.

Verified command:

```powershell
pnpm run eval:rolling -- --rolling-through 2025 --calibration
```

Summary:

```text
candidate                                           log loss  brier   ECE
raw_n20_strength_core                              0.6242    0.2169  0.0377
adjusted_n10_drop_context_rebounding_matchup_edges 0.6231    0.2169  0.0219
```

Finding:

- The best practical candidate has better log loss and lower expected calibration error than raw strength core.
- Brier score is effectively tied at four decimals.
- Bucket-level calibration is not perfect, especially in smaller tail buckets, but the adjusted candidate is reasonably well calibrated overall.
- There is no immediate evidence that calibration adjustment is more urgent than split/error analysis.

### 15. Added Split Diagnostics

Added `--splits` mode to compare where the leading candidates are strongest and weakest.

Verified command:

```powershell
pnpm run eval:rolling -- --rolling-through 2025 --splits
```

Candidates compared:

```text
raw_n20_strength_core
adjusted_n10_drop_context_rebounding_matchup_edges
```

Overall completed-season rolling-origin results:

```text
raw_n20_strength_core                               log loss 0.6242  brier 0.2169  acc 0.6675  auc 0.7128
adjusted_n10_drop_context_rebounding_matchup_edges  log loss 0.6231  brier 0.2169  acc 0.6507  auc 0.7097
```

Confidence split:

```text
raw_n20_strength_core
coin_flip_45_55          log loss 0.6840  acc 0.5875
lean_35_45_or_55_65      log loss 0.6654  acc 0.6127
confident_beyond_65_35   log loss 0.5611  acc 0.7514

adjusted_n10_drop_context_rebounding_matchup_edges
coin_flip_45_55          log loss 0.6959  acc 0.5080
lean_35_45_or_55_65      log loss 0.6641  acc 0.6197
confident_beyond_65_35   log loss 0.5466  acc 0.7566
```

Rest split:

```text
raw_n20_strength_core
even_rest          log loss 0.6064
rest_advantage     log loss 0.6431
rest_disadvantage  log loss 0.6431

adjusted_n10_drop_context_rebounding_matchup_edges
even_rest          log loss 0.6141
rest_advantage     log loss 0.6328
rest_disadvantage  log loss 0.6328
```

Team split highlights:

```text
raw_n20_strength_core best:   LV, CHI, CONNECTICUT, NY, GS
raw_n20_strength_core worst:  ATL, IND, SEA, PHX, LA

adjusted candidate best:      NY, LV, CONNECTICUT, CHI, GS
adjusted candidate worst:     PHX, IND, ATL, SEA, WSH
```

Finding:

- The adjusted best practical candidate still has the best overall log loss, but it trades lower accuracy and slightly lower AUC for better probability quality.
- Its main edge is in confident predictions: log loss `0.5466` vs `0.5611` for raw strength core.
- Coin-flip predictions remain weak. The adjusted candidate's 45-55% bucket is especially close to noise.
- Rest-advantage and rest-disadvantage rows are harder than even-rest rows for both candidates.
- Home and away aggregate metrics are identical for these two candidates because both tested feature sets exclude home/context features and every game contributes paired team rows.
- Team-level weaknesses are not random: Indiana, Atlanta, Seattle, and Phoenix appear near the weak end for both candidates.

### 16. Tested Surgical Context Reintroduction

Added `--context-reintro` mode to test whether the best adjusted candidate improves when specific base context features are added back.

Verified command:

```powershell
pnpm run eval:rolling -- --rolling-through 2025 --context-reintro
```

Candidates compared:

```text
raw_n20_strength_core
adjusted_n10_drop_context_rebounding_matchup_edges
adjusted_n10_drop_rebounding_matchup_edges_keep_home
adjusted_n10_drop_rebounding_matchup_edges_keep_home_rest
adjusted_n10_drop_rebounding_matchup_edges_keep_rest_only
```

Average completed-season rolling-origin results:

```text
raw_n20_strength_core                                  log loss 0.6242  brier 0.2169  acc 0.6675  auc 0.7131
adjusted_n10_drop_context_rebounding_matchup_edges     log loss 0.6231  brier 0.2169  acc 0.6507  auc 0.7093
adjusted_n10_drop_rebounding_matchup_edges_keep_home   log loss 0.6237  brier 0.2180  acc 0.6495  auc 0.7017
adjusted_n10_drop_rebounding_matchup_edges_keep_home_rest log loss 0.6239  brier 0.2181  acc 0.6435  auc 0.7016
adjusted_n10_drop_rebounding_matchup_edges_keep_rest_only log loss 0.6235  brier 0.2171  acc 0.6543  auc 0.7086
```

Per-season log loss:

```text
candidate                                                2023    2024    2025    average
raw_n20_strength_core                                    0.6129  0.6282  0.6303  0.6242
adjusted_n10_drop_context_rebounding_matchup_edges       0.6126  0.6319  0.6245  0.6231
adjusted_n10_drop_rebounding_matchup_edges_keep_home     0.6192  0.6322  0.6202  0.6237
adjusted_n10_drop_rebounding_matchup_edges_keep_home_rest 0.6196  0.6317  0.6208  0.6239
adjusted_n10_drop_rebounding_matchup_edges_keep_rest_only 0.6116  0.6303  0.6279  0.6235
```

Split read:

```text
candidate                                                confident log loss  coin-flip log loss  rest-adv log loss
adjusted_n10_drop_context_rebounding_matchup_edges       0.5466              0.6959              0.6328
adjusted_n10_drop_rebounding_matchup_edges_keep_home     0.5536              0.6915              0.6273
adjusted_n10_drop_rebounding_matchup_edges_keep_home_rest 0.5529              0.6919              0.6278
adjusted_n10_drop_rebounding_matchup_edges_keep_rest_only 0.5477              0.6931              0.6336
```

Finding:

- The best practical candidate remains adjusted `n=10` with base context, rebounding, and matchup edges removed: log loss `0.6231`.
- Home-only context improves 2025 log loss (`0.6202` vs `0.6245`) and improves rest-advantage/rest-disadvantage rows, but it hurts 2023 and the average.
- Home plus rest does not help beyond home-only and worsens average log loss to `0.6239`.
- Rest-only is closer, at `0.6235`, but still does not beat the current best and worsens 2025.
- Context reintroduction is not the next best global improvement. The next experiment should inspect error cases or team/context-specific misses instead of keeping home/rest globally.

### 17. Added Error-Case Analysis

Added `--error-cases` mode for the current best practical candidate:

```text
adjusted_n10_drop_context_rebounding_matchup_edges
```

Verified command:

```powershell
pnpm run eval:rolling -- --rolling-through 2025 --error-cases
```

Overall result reproduced:

```text
rows 1666
log loss 0.6231
brier 0.2169
accuracy 0.6507
auc 0.7097
```

Low-confidence band:

```text
45-55% rows 374
log loss    0.6959
brier       0.2514
accuracy    0.5080
auc         0.4901
```

Weak-team summary:

```text
team  rows  log loss  accuracy
IND   135   0.6447    0.5704
ATL   131   0.6402    0.6107
SEA   129   0.6396    0.6357
PHX   137   0.6587    0.5912
WSH   125   0.6389    0.6720
```

Top high-confidence misses included:

```text
2025-07-09  SEA lost to CONNECTICUT 83-93 after being projected at 88.0%
2024-05-22  PHX beat LV 98-88 after being projected at 16.5%
2024-08-29  LA beat NY 94-88 after being projected at 17.6%
2024-09-20  LA beat MIN 68-51 after being projected at 17.9%
2025-08-21  CHI beat NY 91-85 after being projected at 18.9%
```

Finding:

- The low-confidence bucket is essentially noise: log loss is worse than random 50/50 and AUC is below 0.50.
- Worst individual losses are paired team-game rows, as expected, because every game contributes one row for each team.
- A 2024 USA vs WNBA All-Stars game appears among the worst errors, which suggests the game universe should be audited before the next modeling feature experiment.
- Phoenix and Indiana remain the weakest listed teams by log loss and accuracy.
- Many worst misses are plausible upset/game-state examples rather than obvious feature-family failures, so the next improvement may come more from data hygiene or player/roster context than another global box-score feature toggle.

### 18. Canonical Regular-Season Franchise-Game Universe

Updated `src/evaluate-rolling-windows.ts` so all evaluator modes now use regular-season WNBA franchise games only:

- `g.completed = 1`
- `g.season_type = 2`
- neither competitor can be one of the known non-franchise/special-event team ids: `96`, `97`, `112530`, `126287`, `131246`, `131247`

The prior leaderboard used all completed rows, which mixed regular season, postseason, and at least one All-Star/special-event row. Local DB inspection confirmed:

```text
season_type = 2 regular season
season_type = 3 postseason
special-event teams can still appear in season_type = 2
```

Verified command:

```powershell
pnpm run eval:rolling -- --rolling-through 2025 --game-type-audit
```

Audit result:

```text
Loaded 10,628 regular-season franchise team-game rows

Regular-season special/non-franchise team ids detected:
112530 WIL       3 games  2019,2022,2023
126287 STE       2 games  2022,2023
131246 CLA       1 game   2025
131247 COL       1 game   2025
96     WNBASTARS 4 games  2024,2004,2010,2021
97     USA       4 games  2024,2004,2010,2021

Canonical regular-season franchise filter includes:
5,314 games
10,628 team-game rows
```

Canonical regular-season-only best-candidate cleanup:

```text
candidate                                                log loss  brier   acc    auc
raw_n20_strength_core                                    0.6232    0.2167  0.6619 0.7115
adjusted_n10_all_except_context                          0.6243    0.2176  0.6358 0.7062
adjusted_n10_drop_context_rebounding                     0.6238    0.2174  0.6371 0.7065
adjusted_n10_drop_context_rebounding_matchup_edges       0.6238    0.2174  0.6371 0.7065
adjusted_n10_drop_context_rebounding_shooting            0.6242    0.2175  0.6332 0.7070
adjusted_n10_drop_context_rebounding_turnovers           0.6239    0.2174  0.6371 0.7067
adjusted_n10_drop_context_rebounding_creation_defense    0.6243    0.2175  0.6410 0.7071
adjusted_n10_drop_context_rebounding_shooting_matchup_edges 0.6242 0.2175 0.6332 0.7069
```

Calibration:

```text
candidate                                           rows  log loss  brier   ECE
raw_n20_strength_core                              1532  0.6232    0.2167  0.0457
adjusted_n10_drop_context_rebounding_matchup_edges 1532  0.6238    0.2174  0.0423
```

Split diagnostics:

```text
raw_n20_strength_core overall                         log loss 0.6232  acc 0.6619  auc 0.7112
adjusted_n10_drop_context_rebounding_matchup_edges    log loss 0.6238  acc 0.6371  auc 0.7074

raw coin_flip_45_55        log loss 0.6884  acc 0.5379
adjusted coin_flip_45_55   log loss 0.6970  acc 0.4610

raw confident_beyond_65_35      log loss 0.5634  acc 0.7350
adjusted confident_beyond_65_35 log loss 0.5486  acc 0.7516

raw even_rest              log loss 0.6018
adjusted even_rest         log loss 0.6113
raw rest_advantage         log loss 0.6433
adjusted rest_advantage    log loss 0.6355
```

Error-case report:

```text
adjusted_n10_drop_context_rebounding_matchup_edges
rows     1532
log loss 0.6238
brier    0.2174
accuracy 0.6371
auc      0.7074

45-55% low-confidence band:
rows     308
log loss 0.6970
brier    0.2519
accuracy 0.4610
auc      0.4792

Weak-team summary:
IND  log loss 0.6378  accuracy 0.5600
ATL  log loss 0.6439  accuracy 0.5726
SEA  log loss 0.6388  accuracy 0.6371
PHX  log loss 0.6659  accuracy 0.5968
WSH  log loss 0.6451  accuracy 0.6423
```

Current canonical read:

- The regular-season-only leaderboard moves the practical lead back to `raw_n20_strength_core`, with average log loss `0.6232`.
- The adjusted `n=10` no-context/no-rebounding/no-matchup-edge candidate is still competitive, but it no longer beats raw `n=20` after excluding postseason and special-event games.
- The adjusted candidate remains better in the confident-pick slice and slightly lower ECE, but raw `n=20` has better overall log loss, Brier score, accuracy, AUC, coin-flip bucket, and even-rest slice.
- Postseason prediction should be evaluated separately later, not mixed into the main baseline.

### 19. Added Bootstrap and Postseason Tracks

Added two evaluator modes:

```text
--bootstrap
--postseason
```

Verified commands:

```powershell
pnpm run eval:rolling -- --rolling-through 2025 --bootstrap
pnpm run eval:rolling -- --rolling-through 2025 --postseason
```

Bootstrap result:

```text
candidate                                           games  rows  log loss
raw_n20_strength_core                                766  1532  0.6232
adjusted_n10_drop_context_rebounding_matchup_edges   766  1532  0.6238

Bootstrap log-loss delta: challenger - baseline
samples  seed      observed  mean     2.5%     97.5%   challenger better
1000     20260616  +0.0006   +0.0008  -0.0125  +0.0134 44.2%
```

Postseason-only result:

```text
candidate                                                rows  log loss  brier   acc    auc
raw_n20_strength_core                                     128  0.6937    0.2503  0.5469 0.4777
adjusted_n10_drop_context_rebounding_matchup_edges        128  0.6866    0.2464  0.6094 0.6357
adjusted_n10_drop_rebounding_matchup_edges_keep_home      128  0.5958    0.2044  0.6719 0.7565
adjusted_n10_drop_rebounding_matchup_edges_keep_home_rest 128  0.5956    0.2043  0.6719 0.7565
adjusted_n10_drop_rebounding_matchup_edges_keep_rest_only 128  0.6855    0.2460  0.5938 0.6344
```

Finding:

- The regular-season `raw_n20_strength_core` edge over the adjusted candidate is only `0.0006` log-loss points, and the game-level bootstrap interval crosses zero widely. Treat the current regular-season lead as practical but not statistically settled.
- The postseason-only sample is tiny: 64 games / 128 team-game prediction rows for 2023-2025.
- Postseason behavior is different from regular season: keeping home or home+rest context performs much better in this postseason-only check.
- Postseason results should remain a separate track. They should not change the canonical regular-season baseline until a richer playoff-specific design is built.

## Current Best Read

### Best Simple Window

Current best simple global rolling window:

```text
n=20 raw strength core on the canonical regular-season franchise-game universe
```

The adjusted `n=10` cleanup candidate remains close, especially for confident predictions, but it no longer leads the main regular-season baseline.

### Short Windows

Current evidence says:

```text
n=3 and n=5 are too noisy
```

They do not perform as well as the 10-20 range.

### Current Best Log Loss vs Random 50/50

Random 50/50 log loss:

```text
0.6931
```

Current best canonical regular-season franchise result:

```text
0.6232
```

Improvement:

```text
0.0699 log-loss points
about 10.1% relative improvement
```

This indicates the model is finding real signal.

## Important Caveats

- The model predicts team-game rows, so each game appears twice, once for each team.
- Some features are correlated with each other, especially margin, points scored, points allowed, and win rate.
- Opponent-adjusted form is also correlated with raw margin/strength features.
- Rebounding features currently appear harmful in the best adjusted no-context candidate.
- Matchup-edge features appear redundant after context and rebounding are removed.
- Because of correlated features, raw p-values are not the best next step.
- Permutation importance is useful, but should be repeated across seasons.
- Candidate comparisons should be checked by season, because the best average model is not best in every target season.
- The adjusted cleanup candidate has lower calibration error than raw strength core, but raw `n=20` is now the better overall regular-season baseline.
- Surgical reintroduction of home/rest context did not beat the current best average model, although home helped in 2025.
- The canonical evaluator now excludes postseason and known special-event/non-franchise team ids from the main regular-season baseline.
- Partial 2026 results should be treated as provisional.
- Current model does not yet include betting market expectations, injuries, travel distance, player availability, or lineup strength.

## Recommended Next Sessions

## Session 1: Grouped Feature Ablation

Goal:

Measure which groups of features actually improve predictive performance.

Why:

Individual features are correlated. Instead of asking whether one feature is significant alone, compare groups.

Feature groups to test:

```text
baseline_context:
  home, rest, back-to-back

team_strength:
  margin, win rate, score for, score against

shooting:
  FG%, 3P%, FT%

possession_box:
  turnovers, offensive rebounds, defensive rebounds, total rebounds

creation_defense:
  assists, steals, blocks

matchup_edges:
  team offense vs opponent defense
  opponent offense vs team defense
```

Evaluation:

- Use rolling-origin 2023-2025.
- Compare log loss, Brier score, accuracy, and ROC AUC.
- Use the same window candidates, especially `n=10` and `n=20`.

Main question:

```text
Which feature families are worth keeping?
```

Expected output:

- Table showing model performance with each group removed.
- Table showing model performance with each group alone.

## Session 2: Opponent-Strength Adjustment

Goal:

Adjust recent stats for the quality of opponents faced.

Why:

A team may look good because it played weak opponents, or bad because it played strong opponents.

Candidate features:

```text
team_recent_margin
opponent_recent_margin
team_recent_margin_adjusted_for_opponents
team_recent_points_for_adjusted_for_opponent_defense
team_recent_points_allowed_adjusted_for_opponent_offense
```

Simple first approach:

For each prior game:

```text
adjusted_offense = team_points_scored - opponent_recent_points_allowed_entering_that_game
adjusted_defense = opponent_points_scored - opponent_recent_points_scored_entering_that_game
```

Then roll those adjusted values forward.

Main question:

```text
Does opponent-adjusted form beat raw form?
```

Current answer:

```text
It helps the n=10 full model, but it does not yet beat the best simplified margin-strength model.
```

## Session 3: Stability of Feature Importance

Goal:

Check whether important factors are stable across seasons.

Why:

A feature that matters only in one season may not generalize.

Plan:

- Run permutation importance separately for 2023, 2024, 2025, and partial 2026.
- Rank features by average importance.
- Track season-to-season variance.
- Compare compact feature-set candidates separately by target season.

Main question:

```text
Which factors are consistently useful?
```

Expected output:

- Average importance table.
- Per-season rank table.
- Stable vs unstable feature list.

## Session 4: Better Probability Calibration

Goal:

Check whether predicted probabilities are well calibrated.

Why:

A model can rank teams well but still give probabilities that are too confident or too timid.

Evaluation:

- Calibration buckets, such as 40-45%, 45-50%, 50-55%, etc.
- Compare predicted win probability to actual win rate in each bucket.
- Track Brier score.

Main question:

```text
When the model says 60%, do those teams actually win about 60% of the time?
```

Expected output:

- Calibration table.
- Calibration chart data.
- Recommendation on whether calibration adjustment is needed.

## Session 5: Team-Level and Home/Away Splits

Goal:

Find whether the model works better for some teams or contexts than others.

Possible splits:

```text
home teams
away teams
favorites by model probability
near coin-flip games
high-rest vs low-rest games
teams with strong recent form
teams with volatile recent form
```

Main question:

```text
Where is the model strongest and weakest?
```

Expected output:

- Split performance table.
- Error analysis notes.

## Session 6: Add Player Availability or Roster Strength

Goal:

Move beyond team-level stats.

Why:

Team rolling averages miss a major basketball reality: who is actually playing.

Possible additions:

- Returning starters.
- Minutes continuity.
- Top-player availability.
- Recent player usage.
- Team injuries if data is available.

Main question:

```text
Can player-level context improve over team-level form?
```

## Session 7: Compare Model Classes

Goal:

Evaluate whether a more flexible model improves prediction.

Candidates:

```text
regularized logistic regression
gradient boosted trees
random forest
generalized additive model style features
```

Important:

- Keep logistic regression as the baseline.
- Do not move to complex models until feature groups are better understood.

Main question:

```text
Is the relationship mostly linear, or do nonlinear interactions matter?
```

## Statistical Evaluation Plan

Prioritize these over raw p-values:

### 1. Out-of-Sample Log Loss

Best primary metric for probability predictions.

### 2. Grouped Ablation

Remove or add whole feature families and measure whether performance changes.

### 3. Permutation Importance

Scramble one feature or feature group and see how much log loss worsens.

### 4. Bootstrap Confidence Intervals

Resample games or seasons to estimate uncertainty around feature importance and model performance.

### 5. Calibration

Check whether predicted probabilities match real observed win rates.

### 6. Coefficient Direction and Size

Use standardized coefficients for interpretability, but do not treat them as the final answer because correlated features can distort them.

## Suggested Immediate Next Task

Use the canonical regular-season split diagnostics to decide the next modeling experiment.

Most useful next explorations, in priority order:

```text
1. Use --team-errors to manually review whether weak-team errors are roster/context issues or ordinary upset noise.
2. Investigate whether the adjusted candidate's confident-pick edge can support an ensemble or thresholded model.
3. Design a better postseason-specific setup that uses regular-season form entering the playoffs, not postseason-only history.
4. Add player availability or roster-strength features before trying more global box-score toggles.
5. Add a small report/export format so leaderboard, bootstrap, and split outputs are easier to compare across runs.
```

Recommended command shape for the next diagnostic pass:

```powershell
pnpm run eval:rolling -- --rolling-through 2025 --splits
pnpm run eval:rolling -- --rolling-through 2025 --error-cases
pnpm run eval:rolling -- --rolling-through 2025 --calibration
pnpm run eval:rolling -- --rolling-through 2025 --team-errors
pnpm run eval:rolling -- --rolling-through 2025 --bootstrap
```

Implemented evaluator modes:

```text
--baseline-compare
  Print one compact canonical table for the main baseline candidates:
  raw_n20_strength_core
  adjusted_n10_drop_context_rebounding_matchup_edges
  any context-rest variant worth keeping as a challenger.

--team-errors
  Print per-team worst misses, average predicted probability, upset rate,
  and whether errors are concentrated against particular opponents.

--season-context
  Evaluate home/rest/context variants separately for 2023, 2024, and 2025,
  with explicit rest-advantage and even-rest sub-splits.

--bootstrap
  Resample games, not paired team-game rows, to estimate confidence intervals
  around the raw n=20 vs adjusted n=10 log-loss gap.

--postseason
  Use season_type = 3 only and keep results separate from the canonical
  regular-season leaderboard.
```

Success criteria:

- Keep `raw_n20_strength_core` as the regular-season baseline until a challenger beats it on log loss with stable season splits.
- Explain whether the adjusted candidate's confident-pick edge is useful enough to justify an ensemble, thresholded use, or calibration layer.
- Identify whether weak-team errors are data-quality issues, roster/context issues, or normal parity/upset noise.
- Treat differences below roughly `0.001` log loss as directionally interesting but not decisive unless bootstrap and season splits support them.
- Keep postseason prediction separate, and redesign it around pre-playoff regular-season form before treating postseason results as actionable.
