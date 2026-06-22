import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Options = {
  dbPath: string;
  windows: number[];
  trainThroughSeason: number;
  validateSeason: number;
  testSeason: number;
  rollingFromSeason: number;
  rollingThroughSeason: number | null;
  includeSingleSplit: boolean;
  skipMixed: boolean;
  ablation: boolean;
  opponentAdjusted: boolean;
  stability: boolean;
  leanCandidates: boolean;
  noContextDrops: boolean;
  bestCandidateCleanup: boolean;
  calibration: boolean;
  splits: boolean;
  baselineCompare: boolean;
  teamErrors: boolean;
  seasonContext: boolean;
  bootstrap: boolean;
  bootstrapSamples: number;
  bootstrapSeed: number;
  postseason: boolean;
  contextReintro: boolean;
  errorCases: boolean;
  gameTypeAudit: boolean;
  minPriorGames: number;
  l2: number;
  iterations: number;
  learningRate: number;
};

type TeamGame = {
  gameId: string;
  teamId: string;
  opponentTeamId: string;
  seasonYear: number;
  date: string;
  dateMs: number;
  home: number;
  scoreFor: number;
  scoreAgainst: number;
  winner: number;
  stats: Record<string, number>;
};

type AdjustedForm = {
  adjustedOffense?: number;
  adjustedDefense?: number;
  adjustedMargin?: number;
};

type FeatureRow = {
  gameId: string;
  teamId: string;
  opponentTeamId: string;
  seasonYear: number;
  date: string;
  dateMs: number;
  home: number;
  scoreFor: number;
  scoreAgainst: number;
  restAdvantage: number;
  y: number;
  features: number[];
};

type TrainedModel = {
  weights: number[];
  mean: number[];
  std: number[];
};

type Metrics = {
  rows: number;
  logLoss: number;
  brier: number;
  accuracy: number;
  auc: number;
};

type Prediction = {
  y: number;
  p: number;
  gameId: string;
  teamId: string;
  opponentTeamId: string;
  seasonYear: number;
  date: string;
  dateMs: number;
  home: number;
  scoreFor: number;
  scoreAgainst: number;
  restAdvantage: number;
};

type WindowSpec = number | Record<string, number>;

type WindowResult = {
  label: string;
  trainRows: number;
  validation: Metrics;
  test: Metrics;
};

type ImportanceRow = {
  feature: string;
  coefficient: number;
  oddsRatio: number;
  permutationLogLossDelta: number;
};

type AblationResult = {
  featureSet: string;
  windowLabel: string;
  trainRows: number;
  test: Metrics;
  deltaVsAll: number;
};

type StabilityCandidate = {
  label: string;
  windowSize: number;
  opponentAdjusted: boolean;
  featureSet: string;
};

type StabilityResult = {
  candidate: string;
  season: string;
  trainRows: number;
  test: Metrics;
};

type LeanCandidate = {
  label: string;
  windowSize: number;
  opponentAdjusted: boolean;
  select: (name: string) => boolean;
};

type CalibrationResult = {
  candidate: string;
  rows: number;
  logLoss: number;
  brier: number;
  ece: number;
  buckets: CalibrationBucket[];
};

type CalibrationBucket = {
  label: string;
  rows: number;
  avgPredicted: number;
  winRate: number;
  error: number;
};

type SplitResult = {
  candidate: string;
  split: string;
  group: string;
  test: Metrics;
};

type ContextReintroductionReport = {
  stability: StabilityResult[];
  splits: SplitResult[];
};

type ErrorCaseReport = {
  metrics: Metrics;
  highConfidenceMisses: Prediction[];
  lowConfidenceMetrics: Metrics;
  lowConfidenceExamples: Prediction[];
  weakTeamSummaries: SplitResult[];
  worstLosses: Prediction[];
};

type TeamErrorResult = {
  candidate: string;
  team: string;
  metrics: Metrics;
  avgPredicted: number;
  actualWinRate: number;
  upsetRate: number;
  highConfidenceMisses: number;
  worstRows: Prediction[];
};

type SeasonContextReport = {
  stability: StabilityResult[];
  restSplits: Array<{
    candidate: string;
    season: string;
    restGroup: string;
    test: Metrics;
  }>;
};

type BootstrapResult = {
  baselineCandidate: string;
  challengerCandidate: string;
  games: number;
  rows: number;
  samples: number;
  seed: number;
  baselineLogLoss: number;
  challengerLogLoss: number;
  observedDelta: number;
  meanDelta: number;
  lowerDelta: number;
  upperDelta: number;
  challengerWinRate: number;
};

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_WINDOWS = [3, 5, 8, 10, 12, 14, 16, 20];

const REGULAR_SEASON_TYPE = 2;

const POSTSEASON_TYPE = 3;

const NON_FRANCHISE_TEAM_IDS = ["96", "97", "112530", "126287", "131246", "131247"];

const STAT_NAMES = [
  "assists",
  "blocks",
  "defensiveRebounds",
  "fieldGoalPct",
  "freeThrowPct",
  "offensiveRebounds",
  "steals",
  "threePointFieldGoalPct",
  "totalRebounds",
  "turnovers",
];

const ROLLING_STAT_NAMES = [
  "scoreFor",
  "scoreAgainst",
  "margin",
  ...STAT_NAMES,
];

const BASE_CONTEXT_FEATURE_NAMES = [
  "home_indicator",
  "team_rest_days",
  "opponent_rest_days",
  "rest_advantage",
  "team_back_to_back",
  "opponent_back_to_back",
];

const ROLLING_CONTEXT_STAT_NAMES = ["winPct", "homeRate", "avgRestDays", "closeGameRate"];

const ADJUSTED_FORM_STAT_NAMES = ["adjustedOffense", "adjustedDefense", "adjustedMargin"];

function parseArgs(argv: string[]): Options {
  const options: Options = {
    dbPath: path.join(PROJECT_ROOT, "wnba_raw.sqlite"),
    windows: DEFAULT_WINDOWS,
    trainThroughSeason: 2023,
    validateSeason: 2024,
    testSeason: 2025,
    rollingFromSeason: 2023,
    rollingThroughSeason: null,
    includeSingleSplit: false,
    skipMixed: false,
    ablation: false,
    opponentAdjusted: false,
    stability: false,
    leanCandidates: false,
    noContextDrops: false,
    bestCandidateCleanup: false,
    calibration: false,
    splits: false,
    baselineCompare: false,
    teamErrors: false,
    seasonContext: false,
    bootstrap: false,
    bootstrapSamples: 1000,
    bootstrapSeed: 20260616,
    postseason: false,
    contextReintro: false,
    errorCases: false,
    gameTypeAudit: false,
    minPriorGames: 3,
    l2: 0.01,
    iterations: 2000,
    learningRate: 0.05,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--db" && next) {
      options.dbPath = path.resolve(next);
      i += 1;
    } else if (arg === "--windows" && next) {
      options.windows = next.split(/[,\s]+/).map((value) => Number.parseInt(value.trim(), 10));
      i += 1;
    } else if (arg === "--train-through" && next) {
      options.trainThroughSeason = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--validate-season" && next) {
      options.validateSeason = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--test-season" && next) {
      options.testSeason = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--rolling-from" && next) {
      options.rollingFromSeason = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--rolling-through" && next) {
      options.rollingThroughSeason = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--single-split") {
      options.includeSingleSplit = true;
    } else if (arg === "--skip-mixed") {
      options.skipMixed = true;
    } else if (arg === "--ablation") {
      options.ablation = true;
    } else if (arg === "--opponent-adjusted") {
      options.opponentAdjusted = true;
    } else if (arg === "--stability") {
      options.stability = true;
    } else if (arg === "--lean-candidates") {
      options.leanCandidates = true;
    } else if (arg === "--no-context-drops") {
      options.noContextDrops = true;
    } else if (arg === "--best-candidate-cleanup") {
      options.bestCandidateCleanup = true;
    } else if (arg === "--calibration") {
      options.calibration = true;
    } else if (arg === "--splits") {
      options.splits = true;
    } else if (arg === "--baseline-compare") {
      options.baselineCompare = true;
    } else if (arg === "--team-errors") {
      options.teamErrors = true;
    } else if (arg === "--season-context") {
      options.seasonContext = true;
    } else if (arg === "--bootstrap") {
      options.bootstrap = true;
    } else if (arg === "--bootstrap-samples" && next) {
      options.bootstrapSamples = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--bootstrap-seed" && next) {
      options.bootstrapSeed = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--postseason") {
      options.postseason = true;
    } else if (arg === "--context-reintro") {
      options.contextReintro = true;
    } else if (arg === "--error-cases") {
      options.errorCases = true;
    } else if (arg === "--game-type-audit") {
      options.gameTypeAudit = true;
    } else if (arg === "--min-prior-games" && next) {
      options.minPriorGames = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--l2" && next) {
      options.l2 = Number.parseFloat(next);
      i += 1;
    } else if (arg === "--iterations" && next) {
      options.iterations = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--learning-rate" && next) {
      options.learningRate = Number.parseFloat(next);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (options.windows.some((window) => !Number.isInteger(window) || window < 1)) {
    throw new Error("--windows must be a comma-separated list of positive integers");
  }

  if (!Number.isInteger(options.bootstrapSamples) || options.bootstrapSamples < 1) {
    throw new Error("--bootstrap-samples must be a positive integer");
  }

  if (!Number.isInteger(options.bootstrapSeed)) {
    throw new Error("--bootstrap-seed must be an integer");
  }

  return options;
}

function printHelp(): void {
  console.log(`Usage: pnpm eval:rolling [options]

Options:
  --db <path>                 SQLite database path. Defaults to ./wnba_raw.sqlite
  --windows <csv>             Rolling windows to compare. Defaults to ${DEFAULT_WINDOWS.join(",")}
  --train-through <season>    Last season in training split. Defaults to 2023
  --validate-season <season>  Validation season. Defaults to 2024
  --test-season <season>      Test season. Defaults to 2025
  --rolling-from <season>     First target season for rolling-origin backtest. Defaults to 2023
  --rolling-through <season>  Last target season for rolling-origin backtest. Defaults to latest season in DB
  --single-split              Also print the older train/validate/test split report
  --skip-mixed                Skip mixed-window selection/evaluation
  --ablation                  Print grouped feature ablation tables for each global window
  --opponent-adjusted         Add opponent-strength-adjusted recent form features
  --stability                 Print per-season results for leading candidate feature sets
  --lean-candidates           Compare compact raw-margin and adjusted-margin candidates
  --no-context-drops          Compare adjusted no-context models with one non-context family removed
  --best-candidate-cleanup    Compare cleanup variants of the best adjusted no-context model
  --calibration               Print calibration buckets for selected candidate models
  --splits                    Print split diagnostics for selected candidate models
  --baseline-compare          Print compact canonical baseline candidate comparison
  --team-errors               Print per-team error diagnostics for leading candidates
  --season-context            Print context variants by season and rest split
  --bootstrap                 Bootstrap game-level CI for raw n=20 vs adjusted n=10
  --bootstrap-samples <n>     Bootstrap sample count. Defaults to 1000
  --bootstrap-seed <n>        Bootstrap RNG seed. Defaults to 20260616
  --postseason                Use postseason franchise games as a separate row universe
  --context-reintro           Compare surgical context reintroduction candidates
  --error-cases               Print row-level error analysis for the best candidate
  --game-type-audit           Print completed-game season type and canonical filter counts
  --min-prior-games <n>       Minimum prior games per team/opponent. Defaults to 3
  --l2 <number>               L2 regularization strength. Defaults to 0.01
  --iterations <n>            Logistic regression iterations. Defaults to 2000
  --learning-rate <number>    Logistic regression learning rate. Defaults to 0.05
`);
}

function parseNumeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return null;
  }

  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function loadTeamGames(db: Database.Database, seasonType = REGULAR_SEASON_TYPE): TeamGame[] {
  const rows = db
    .prepare(
      `
      WITH stat_values AS (
        SELECT
          game_id,
          team_id,
          stat_name,
          CASE
            WHEN value IS NOT NULL THEN value
            WHEN display_value GLOB '-[0-9]*' OR display_value GLOB '[0-9]*' THEN CAST(display_value AS REAL)
            ELSE NULL
          END AS numeric_value
        FROM game_team_box_stats
        WHERE stat_name IN (${STAT_NAMES.map(() => "?").join(",")})
      ),
      team_stats AS (
        SELECT
          game_id,
          team_id,
          ${STAT_NAMES.map(
            (statName) => `MAX(CASE WHEN stat_name = '${statName}' THEN numeric_value END) AS ${statName}`,
          ).join(",\n          ")}
        FROM stat_values
        GROUP BY game_id, team_id
      )
      SELECT
        g.game_id AS gameId,
        g.season_year AS seasonYear,
        g.date AS date,
        c.team_id AS teamId,
        o.team_id AS opponentTeamId,
        CASE WHEN c.home_away = 'home' THEN 1 ELSE 0 END AS home,
        c.score AS scoreFor,
        o.score AS scoreAgainst,
        c.winner AS winner,
        ${STAT_NAMES.map((statName) => `s.${statName} AS ${statName}`).join(",\n        ")}
      FROM games g
      JOIN game_competitors c ON c.game_id = g.game_id
      JOIN game_competitors o ON o.game_id = c.game_id AND o.team_id <> c.team_id
      LEFT JOIN team_stats s ON s.game_id = c.game_id AND s.team_id = c.team_id
      WHERE g.completed = 1
        AND g.season_type = ?
        AND c.team_id NOT IN (${NON_FRANCHISE_TEAM_IDS.map(() => "?").join(",")})
        AND o.team_id NOT IN (${NON_FRANCHISE_TEAM_IDS.map(() => "?").join(",")})
        AND c.score IS NOT NULL
        AND o.score IS NOT NULL
        AND c.winner IS NOT NULL
      ORDER BY g.date, g.game_id, c.team_id
    `,
    )
    .all(...STAT_NAMES, seasonType, ...NON_FRANCHISE_TEAM_IDS, ...NON_FRANCHISE_TEAM_IDS) as Array<
    Record<string, unknown>
  >;

  return rows.map((row) => {
    const stats: Record<string, number> = {};
    for (const statName of STAT_NAMES) {
      const value = parseNumeric(row[statName]);
      if (value !== null) {
        stats[statName] = value;
      }
    }

    const scoreFor = Number(row.scoreFor);
    const scoreAgainst = Number(row.scoreAgainst);

    return {
      gameId: String(row.gameId),
      teamId: String(row.teamId),
      opponentTeamId: String(row.opponentTeamId),
      seasonYear: Number(row.seasonYear),
      date: String(row.date),
      dateMs: Date.parse(String(row.date)),
      home: Number(row.home),
      scoreFor,
      scoreAgainst,
      winner: Number(row.winner),
      stats,
    };
  });
}

function loadTeamLabels(db: Database.Database): Map<string, string> {
  const rows = db
    .prepare(
      `
      SELECT
        team_id AS teamId,
        COALESCE(abbreviation, short_display_name, display_name, team_id) AS label
      FROM teams
    `,
    )
    .all() as Array<Record<string, unknown>>;

  return new Map(rows.map((row) => [String(row.teamId), String(row.label)]));
}

function teamLabel(teamLabels: Map<string, string>, teamId: string): string {
  const label = teamLabels.get(teamId);
  return label ? `${label} (${teamId})` : teamId;
}

function printGameTypeAudit(db: Database.Database, teamGames: TeamGame[]): void {
  const seasonTypeRows = db
    .prepare(
      `
      SELECT
        season_year AS seasonYear,
        COALESCE(season_type, -1) AS seasonType,
        COUNT(DISTINCT game_id) AS games
      FROM games
      WHERE completed = 1
      GROUP BY season_year, season_type
      ORDER BY season_year, season_type
    `,
    )
    .all() as Array<Record<string, unknown>>;

  console.log("");
  console.log("Completed games by season_year and season_type");
  console.log("season | season_type | games");
  console.log("-".repeat(28));
  for (const row of seasonTypeRows) {
    console.log(
      [
        String(row.seasonYear).padStart(6),
        String(row.seasonType).padStart(11),
        Number(row.games).toLocaleString().padStart(5),
      ].join(" | "),
    );
  }

  const specialTeamRows = db
    .prepare(
      `
      SELECT
        c.team_id AS teamId,
        COALESCE(t.abbreviation, t.short_display_name, t.display_name, c.team_id) AS label,
        COUNT(DISTINCT g.game_id) AS games,
        GROUP_CONCAT(DISTINCT g.season_year) AS seasons
      FROM games g
      JOIN game_competitors c ON c.game_id = g.game_id
      LEFT JOIN teams t ON t.team_id = c.team_id
      WHERE g.completed = 1
        AND g.season_type = ?
        AND c.team_id IN (${NON_FRANCHISE_TEAM_IDS.map(() => "?").join(",")})
      GROUP BY c.team_id, label
      ORDER BY c.team_id
    `,
    )
    .all(REGULAR_SEASON_TYPE, ...NON_FRANCHISE_TEAM_IDS) as Array<Record<string, unknown>>;

  console.log("");
  console.log("Regular-season special/non-franchise team ids detected");
  if (specialTeamRows.length === 0) {
    console.log("(none)");
  } else {
    console.log("team_id | label | games | seasons");
    console.log("-".repeat(40));
    for (const row of specialTeamRows) {
      console.log(
        [
          String(row.teamId).padStart(7),
          String(row.label).padEnd(12),
          Number(row.games).toLocaleString().padStart(5),
          String(row.seasons),
        ].join(" | "),
      );
    }
  }

  console.log("");
  console.log("Canonical regular-season franchise filter includes:");
  console.log(`${new Set(teamGames.map((game) => game.gameId)).size.toLocaleString()} games`);
  console.log(`${teamGames.length.toLocaleString()} team-game rows`);
}

function buildFeatureRows(
  teamGames: TeamGame[],
  windowSpec: WindowSpec,
  minPriorGames: number,
  rollingStatNames = ROLLING_STAT_NAMES,
  includeOpponentAdjusted = false,
): FeatureRow[] {
  const byTeam = new Map<string, TeamGame[]>();
  const historyByTeamGame = new Map<string, TeamGame[]>();
  const adjustedFormByTeamGame = new Map<string, AdjustedForm>();
  const maxWindowSize =
    typeof windowSpec === "number" ? windowSpec : Math.max(...rollingStatNames.map((statName) => windowSpec[statName] ?? 1));

  for (const game of teamGames) {
    const history = byTeam.get(game.teamId) ?? [];
    const opponentHistory = byTeam.get(game.opponentTeamId) ?? [];
    adjustedFormByTeamGame.set(teamGameKey(game.teamId, game.gameId), adjustedFormForGame(game, opponentHistory.slice(-maxWindowSize)));
    historyByTeamGame.set(teamGameKey(game.teamId, game.gameId), history.slice(-maxWindowSize));
    history.push(game);
    byTeam.set(game.teamId, history);
  }

  const featureRows: FeatureRow[] = [];

  for (const game of teamGames) {
    const teamHistory = historyByTeamGame.get(teamGameKey(game.teamId, game.gameId)) ?? [];
    const opponentHistory = historyByTeamGame.get(teamGameKey(game.opponentTeamId, game.gameId)) ?? [];

    if (teamHistory.length < minPriorGames || opponentHistory.length < minPriorGames) {
      continue;
    }

    const previousTeamGame = teamHistory[teamHistory.length - 1];
    const previousOpponentGame = opponentHistory[opponentHistory.length - 1];
    const teamRestDays = restDays(previousTeamGame, game);
    const opponentRestDays = restDays(previousOpponentGame, game);

    const features = [
      game.home,
      teamRestDays,
      opponentRestDays,
      teamRestDays - opponentRestDays,
      teamRestDays <= 1.5 ? 1 : 0,
      opponentRestDays <= 1.5 ? 1 : 0,
    ];
    const rollingValues: Record<string, { team: number; opponent: number }> = {};

    for (const statName of rollingStatNames) {
      const statWindowSize = typeof windowSpec === "number" ? windowSpec : windowSpec[statName];
      const teamValue = rollingAverage(teamHistory.slice(-statWindowSize), statName);
      const opponentValue = rollingAverage(opponentHistory.slice(-statWindowSize), statName);
      rollingValues[statName] = { team: teamValue, opponent: opponentValue };
      features.push(teamValue, opponentValue, teamValue - opponentValue);
    }

    for (const statName of ROLLING_CONTEXT_STAT_NAMES) {
      const statWindowSize = typeof windowSpec === "number" ? windowSpec : Math.max(...Object.values(windowSpec));
      const teamValue = rollingContextAverage(teamHistory.slice(-statWindowSize), statName);
      const opponentValue = rollingContextAverage(opponentHistory.slice(-statWindowSize), statName);
      features.push(teamValue, opponentValue, teamValue - opponentValue);
    }

    if (includeOpponentAdjusted) {
      const statWindowSize = typeof windowSpec === "number" ? windowSpec : Math.max(...Object.values(windowSpec));
      for (const statName of ADJUSTED_FORM_STAT_NAMES) {
        const teamValue = rollingAdjustedAverage(teamHistory.slice(-statWindowSize), adjustedFormByTeamGame, statName);
        const opponentValue = rollingAdjustedAverage(opponentHistory.slice(-statWindowSize), adjustedFormByTeamGame, statName);
        features.push(teamValue, opponentValue, teamValue - opponentValue);
      }
    }

    const teamScoreFor = rollingValues.scoreFor?.team ?? rollingAverage(teamHistory, "scoreFor");
    const teamScoreAgainst = rollingValues.scoreAgainst?.team ?? rollingAverage(teamHistory, "scoreAgainst");
    const opponentScoreFor = rollingValues.scoreFor?.opponent ?? rollingAverage(opponentHistory, "scoreFor");
    const opponentScoreAgainst = rollingValues.scoreAgainst?.opponent ?? rollingAverage(opponentHistory, "scoreAgainst");
    const offenseVsOpponentDefense = teamScoreFor - opponentScoreAgainst;
    const defenseVsOpponentOffense = opponentScoreFor - teamScoreAgainst;
    features.push(offenseVsOpponentDefense, defenseVsOpponentOffense, offenseVsOpponentDefense - defenseVsOpponentOffense);

    featureRows.push({
      gameId: game.gameId,
      teamId: game.teamId,
      opponentTeamId: game.opponentTeamId,
      seasonYear: game.seasonYear,
      date: game.date,
      dateMs: game.dateMs,
      home: game.home,
      scoreFor: game.scoreFor,
      scoreAgainst: game.scoreAgainst,
      restAdvantage: teamRestDays - opponentRestDays,
      y: game.winner,
      features,
    });
  }

  return featureRows.sort((a, b) => a.dateMs - b.dateMs);
}

function featureNames(rollingStatNames = ROLLING_STAT_NAMES, includeOpponentAdjusted = false): string[] {
  const names = [...BASE_CONTEXT_FEATURE_NAMES];

  for (const statName of rollingStatNames) {
    names.push(`team_${statName}_avg`, `opponent_${statName}_avg`, `${statName}_diff`);
  }

  for (const statName of ROLLING_CONTEXT_STAT_NAMES) {
    names.push(`team_${statName}`, `opponent_${statName}`, `${statName}_diff`);
  }

  if (includeOpponentAdjusted) {
    for (const statName of ADJUSTED_FORM_STAT_NAMES) {
      names.push(`team_${statName}_avg`, `opponent_${statName}_avg`, `${statName}_diff`);
    }
  }

  names.push("offense_vs_opponent_defense", "opponent_offense_vs_defense", "point_matchup_edge");

  return names;
}

function ablationFeatureSets(names: string[]): Array<{ label: string; indices: number[] }> {
  const all = names.map((_, index) => index);
  const groups = {
    context: indicesMatching(names, isContextFeature),
    margin_strength: indicesMatching(names, isMarginStrengthFeature),
    shooting: indicesMatching(names, isShootingFeature),
    rebounding: indicesMatching(names, isReboundingFeature),
    turnovers: indicesMatching(names, isTurnoverFeature),
    creation_defense: indicesMatching(names, isCreationDefenseFeature),
    matchup_edges: indicesMatching(names, isMatchupEdgeFeature),
    opponent_adjusted: indicesMatching(names, isOpponentAdjustedFeature),
  };

  const sets = [
    { label: "all_features", indices: all },
    { label: "context_only", indices: groups.context },
    { label: "margin_strength_only", indices: groups.margin_strength },
    { label: "shooting_only", indices: groups.shooting },
    { label: "rebounding_only", indices: groups.rebounding },
    { label: "turnovers_only", indices: groups.turnovers },
    { label: "creation_defense_only", indices: groups.creation_defense },
    { label: "matchup_edges_only", indices: groups.matchup_edges },
    { label: "all_except_context", indices: exceptIndices(all, groups.context) },
    { label: "all_except_margin_strength", indices: exceptIndices(all, groups.margin_strength) },
    { label: "all_except_shooting", indices: exceptIndices(all, groups.shooting) },
    { label: "all_except_rebounding", indices: exceptIndices(all, groups.rebounding) },
    { label: "all_except_turnovers", indices: exceptIndices(all, groups.turnovers) },
    { label: "all_except_creation_defense", indices: exceptIndices(all, groups.creation_defense) },
    { label: "all_except_matchup_edges", indices: exceptIndices(all, groups.matchup_edges) },
  ];

  if (groups.opponent_adjusted.length > 0) {
    sets.splice(8, 0, { label: "opponent_adjusted_only", indices: groups.opponent_adjusted });
    sets.push({ label: "all_except_opponent_adjusted", indices: exceptIndices(all, groups.opponent_adjusted) });
  }

  return sets;
}

function isContextFeature(name: string): boolean {
  return BASE_CONTEXT_FEATURE_NAMES.includes(name);
}

function isHomeFeature(name: string): boolean {
  return name === "home_indicator";
}

function isRestFeature(name: string): boolean {
  return (
    name === "team_rest_days" ||
    name === "opponent_rest_days" ||
    name === "rest_advantage" ||
    name === "team_back_to_back" ||
    name === "opponent_back_to_back"
  );
}

function isMarginStrengthFeature(name: string): boolean {
  return name.includes("margin") || name.includes("winPct") || name.includes("scoreFor") || name.includes("scoreAgainst");
}

function isShootingFeature(name: string): boolean {
  return name.includes("fieldGoalPct") || name.includes("threePointFieldGoalPct") || name.includes("freeThrowPct");
}

function isReboundingFeature(name: string): boolean {
  return name.includes("offensiveRebounds") || name.includes("defensiveRebounds") || name.includes("totalRebounds");
}

function isTurnoverFeature(name: string): boolean {
  return name.includes("turnovers");
}

function isCreationDefenseFeature(name: string): boolean {
  return name.includes("assists") || name.includes("steals") || name.includes("blocks");
}

function isMatchupEdgeFeature(name: string): boolean {
  return name === "offense_vs_opponent_defense" || name === "opponent_offense_vs_defense" || name === "point_matchup_edge";
}

function isOpponentAdjustedFeature(name: string): boolean {
  return name.includes("adjustedOffense") || name.includes("adjustedDefense") || name.includes("adjustedMargin");
}

function indicesMatching(names: string[], predicate: (name: string) => boolean): number[] {
  return names.flatMap((name, index) => (predicate(name) ? [index] : []));
}

function exceptIndices(all: number[], excluded: number[]): number[] {
  const excludedSet = new Set(excluded);
  return all.filter((index) => !excludedSet.has(index));
}

function selectFeatureColumns(rows: FeatureRow[], indices: number[]): FeatureRow[] {
  return rows.map((row) => ({
    ...row,
    features: indices.map((index) => row.features[index] ?? 0),
  }));
}

function selectFeatureSetRows(rows: FeatureRow[], names: string[], featureSet: string): FeatureRow[] {
  const set = ablationFeatureSets(names).find((candidate) => candidate.label === featureSet);
  if (!set) {
    throw new Error(`Unknown feature set: ${featureSet}`);
  }

  return selectFeatureColumns(rows, set.indices);
}

function selectFeatureRowsByPredicate(rows: FeatureRow[], names: string[], predicate: (name: string) => boolean): FeatureRow[] {
  const indices = indicesMatching(names, predicate);
  if (indices.length === 0) {
    throw new Error("Feature predicate selected zero columns");
  }

  return selectFeatureColumns(rows, indices);
}

function teamGameKey(teamId: string, gameId: string): string {
  return `${teamId}:${gameId}`;
}

function rollingAverage(history: TeamGame[], statName: string): number {
  let sum = 0;
  let count = 0;

  for (const game of history) {
    const value = valueForRollingStat(game, statName);
    if (typeof value === "number" && Number.isFinite(value)) {
      sum += value;
      count += 1;
    }
  }

  return count > 0 ? sum / count : 0;
}

function rollingContextAverage(history: TeamGame[], statName: string): number {
  if (history.length === 0) {
    return 0;
  }

  if (statName === "winPct") {
    return average(history.map((game) => game.winner));
  }

  if (statName === "homeRate") {
    return average(history.map((game) => game.home));
  }

  if (statName === "closeGameRate") {
    return average(history.map((game) => (Math.abs(game.scoreFor - game.scoreAgainst) <= 5 ? 1 : 0)));
  }

  if (statName === "avgRestDays") {
    const restValues: number[] = [];
    for (let index = 1; index < history.length; index += 1) {
      restValues.push(restDays(history[index - 1], history[index]));
    }

    return restValues.length > 0 ? average(restValues) : 0;
  }

  return 0;
}

function adjustedFormForGame(game: TeamGame, opponentHistory: TeamGame[]): AdjustedForm {
  if (opponentHistory.length === 0) {
    return {};
  }

  const expectedOpponentDefense = rollingAverage(opponentHistory, "scoreAgainst");
  const expectedOpponentOffense = rollingAverage(opponentHistory, "scoreFor");
  const adjustedOffense = game.scoreFor - expectedOpponentDefense;
  const adjustedDefense = game.scoreAgainst - expectedOpponentOffense;

  return {
    adjustedOffense,
    adjustedDefense,
    adjustedMargin: adjustedOffense - adjustedDefense,
  };
}

function rollingAdjustedAverage(
  history: TeamGame[],
  adjustedFormByTeamGame: Map<string, AdjustedForm>,
  statName: string,
): number {
  let sum = 0;
  let count = 0;

  for (const game of history) {
    const value = adjustedFormByTeamGame.get(teamGameKey(game.teamId, game.gameId))?.[statName as keyof AdjustedForm];
    if (typeof value === "number" && Number.isFinite(value)) {
      sum += value;
      count += 1;
    }
  }

  return count > 0 ? sum / count : 0;
}

function valueForRollingStat(game: TeamGame, statName: string): number | undefined {
  if (statName === "scoreFor") {
    return game.scoreFor;
  }

  if (statName === "scoreAgainst") {
    return game.scoreAgainst;
  }

  if (statName === "margin") {
    return game.scoreFor - game.scoreAgainst;
  }

  return game.stats[statName];
}

function restDays(previousGame: TeamGame | undefined, game: TeamGame): number {
  if (!previousGame) {
    return 0;
  }

  const days = (game.dateMs - previousGame.dateMs) / (24 * 60 * 60 * 1000);
  return Math.max(0, Math.min(14, days));
}

function trainModel(rows: FeatureRow[], options: Options): TrainedModel {
  if (rows.length === 0) {
    throw new Error("Cannot train model with zero rows");
  }

  const featureCount = rows[0]?.features.length ?? 0;
  const mean = Array.from({ length: featureCount }, (_, index) => average(rows.map((row) => row.features[index] ?? 0)));
  const std = Array.from({ length: featureCount }, (_, index) => {
    const variance = average(rows.map((row) => ((row.features[index] ?? 0) - mean[index]) ** 2));
    const value = Math.sqrt(variance);
    return value > 1e-9 ? value : 1;
  });
  const weights = new Array(featureCount + 1).fill(0) as number[];

  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    const gradients = new Array(featureCount + 1).fill(0) as number[];

    for (const row of rows) {
      const prediction = sigmoid(linearPredict(weights, row.features, mean, std));
      const error = prediction - row.y;
      gradients[0] += error;

      for (let index = 0; index < featureCount; index += 1) {
        gradients[index + 1] += error * standardize(row.features[index] ?? 0, mean[index], std[index]);
      }
    }

    for (let index = 0; index < weights.length; index += 1) {
      const penalty = index === 0 ? 0 : options.l2 * weights[index];
      weights[index] -= options.learningRate * (gradients[index] / rows.length + penalty);
    }
  }

  return { weights, mean, std };
}

function evaluate(rows: FeatureRow[], model: TrainedModel): Metrics {
  const predictions = scoreRows(rows, model);

  if (predictions.length === 0) {
    return { rows: 0, logLoss: Number.NaN, brier: Number.NaN, accuracy: Number.NaN, auc: Number.NaN };
  }

  return {
    rows: predictions.length,
    logLoss: average(predictions.map(({ y, p }) => -(y * Math.log(p) + (1 - y) * Math.log(1 - p)))),
    brier: average(predictions.map(({ y, p }) => (p - y) ** 2)),
    accuracy: average(predictions.map(({ y, p }) => (Number(p >= 0.5) === y ? 1 : 0))),
    auc: rocAuc(predictions),
  };
}

function scoreRows(rows: FeatureRow[], model: TrainedModel): Prediction[] {
  return rows.map((row) => {
    const p = clampProbability(sigmoid(linearPredict(model.weights, row.features, model.mean, model.std)));
    return {
      y: row.y,
      p,
      gameId: row.gameId,
      teamId: row.teamId,
      opponentTeamId: row.opponentTeamId,
      seasonYear: row.seasonYear,
      date: row.date,
      dateMs: row.dateMs,
      home: row.home,
      scoreFor: row.scoreFor,
      scoreAgainst: row.scoreAgainst,
      restAdvantage: row.restAdvantage,
    };
  });
}

function featureImportance(rows: FeatureRow[], options: Options, targetSeason: number, names: string[]): ImportanceRow[] {
  const trainRows = rows.filter((row) => row.seasonYear < targetSeason);
  const testRows = rows.filter((row) => row.seasonYear === targetSeason);
  const model = trainModel(trainRows, options);
  const baseline = evaluate(testRows, model);

  return names
    .map((feature, index) => {
      const coefficient = model.weights[index + 1] ?? 0;
      return {
        feature,
        coefficient,
        oddsRatio: Math.exp(coefficient),
        permutationLogLossDelta: permutationLogLossDelta(testRows, model, baseline.logLoss, index),
      };
    })
    .sort((a, b) => b.permutationLogLossDelta - a.permutationLogLossDelta);
}

function permutationLogLossDelta(rows: FeatureRow[], model: TrainedModel, baselineLogLoss: number, featureIndex: number): number {
  if (rows.length === 0 || !Number.isFinite(baselineLogLoss)) {
    return Number.NaN;
  }

  const permutedRows = rows.map((row, rowIndex) => {
    const features = [...row.features];
    const sourceIndex = (rowIndex * 37 + 17) % rows.length;
    features[featureIndex] = rows[sourceIndex].features[featureIndex] ?? 0;
    return { ...row, features };
  });

  return evaluate(permutedRows, model).logLoss - baselineLogLoss;
}

function printImportanceTable(rows: ImportanceRow[], limit: number): void {
  console.log("feature | std coef | odds ratio | perm logloss delta");
  console.log("-".repeat(86));

  for (const row of rows.slice(0, limit)) {
    console.log(
      [
        row.feature.padEnd(36),
        formatSigned(row.coefficient).padStart(8),
        formatMetric(row.oddsRatio).padStart(10),
        formatSigned(row.permutationLogLossDelta).padStart(18),
      ].join(" | "),
    );
  }
}

function formatSigned(value: number): string {
  if (!Number.isFinite(value)) {
    return "n/a";
  }

  return `${value >= 0 ? "+" : ""}${value.toFixed(4)}`;
}

function linearPredict(weights: number[], features: number[], mean: number[], std: number[]): number {
  let value = weights[0] ?? 0;
  for (let index = 0; index < features.length; index += 1) {
    value += (weights[index + 1] ?? 0) * standardize(features[index] ?? 0, mean[index] ?? 0, std[index] ?? 1);
  }

  return value;
}

function standardize(value: number, mean: number, std: number): number {
  return (value - mean) / std;
}

function sigmoid(value: number): number {
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }

  const z = Math.exp(value);
  return z / (1 + z);
}

function clampProbability(value: number): number {
  return Math.min(1 - 1e-12, Math.max(1e-12, value));
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) {
    return Number.NaN;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * quantile)));
  return sorted[index];
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function rocAuc(predictions: Array<{ y: number; p: number }>): number {
  const sorted = [...predictions].sort((a, b) => a.p - b.p);
  const positives = predictions.filter(({ y }) => y === 1).length;
  const negatives = predictions.length - positives;

  if (positives === 0 || negatives === 0) {
    return Number.NaN;
  }

  let rankSum = 0;
  let rank = 1;

  for (let index = 0; index < sorted.length; ) {
    let end = index + 1;
    while (end < sorted.length && sorted[end].p === sorted[index].p) {
      end += 1;
    }

    const averageRank = (rank + rank + (end - index) - 1) / 2;
    for (let tiedIndex = index; tiedIndex < end; tiedIndex += 1) {
      if (sorted[tiedIndex].y === 1) {
        rankSum += averageRank;
      }
    }

    rank += end - index;
    index = end;
  }

  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

function formatMetric(value: number): string {
  return Number.isFinite(value) ? value.toFixed(4) : "n/a";
}

function formatProbability(value: number): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "n/a";
}

function formatDate(value: string): string {
  return value.slice(0, 10);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, Math.max(0, maxLength - 1));
}

function fitAndEvaluate(rows: FeatureRow[], options: Options, label: string): WindowResult {
  const trainRows = rows.filter((row) => row.seasonYear <= options.trainThroughSeason);
  const validationRows = rows.filter((row) => row.seasonYear === options.validateSeason);
  const testRows = rows.filter((row) => row.seasonYear === options.testSeason);
  const model = trainModel(trainRows, options);

  return {
    label,
    trainRows: trainRows.length,
    validation: evaluate(validationRows, model),
    test: evaluate(testRows, model),
  };
}

function fitAndEvaluateSeason(rows: FeatureRow[], options: Options, label: string, targetSeason: number): WindowResult {
  const trainRows = rows.filter((row) => row.seasonYear < targetSeason);
  const testRows = rows.filter((row) => row.seasonYear === targetSeason);
  const model = trainModel(trainRows, options);

  return {
    label,
    trainRows: trainRows.length,
    validation: { rows: 0, logLoss: Number.NaN, brier: Number.NaN, accuracy: Number.NaN, auc: Number.NaN },
    test: evaluate(testRows, model),
  };
}

function selectWindowsByStat(teamGames: TeamGame[], options: Options): Record<string, number> {
  const selected: Record<string, number> = {};

  for (const statName of ROLLING_STAT_NAMES) {
    const candidates = options.windows.map((windowSize) => {
      const rows = buildFeatureRows(teamGames, windowSize, options.minPriorGames, [statName]);
      return {
        windowSize,
        result: fitAndEvaluate(rows, options, statName),
      };
    });

    const best = candidates
      .filter(({ result }) => Number.isFinite(result.validation.logLoss))
      .sort((a, b) => a.result.validation.logLoss - b.result.validation.logLoss)[0];

    selected[statName] = best?.windowSize ?? options.windows[0];
  }

  return selected;
}

function selectWindowsByStatForTargetSeason(teamGames: TeamGame[], options: Options, targetSeason: number): Record<string, number> {
  const validationSeason = targetSeason - 1;
  const selected: Record<string, number> = {};

  for (const statName of ROLLING_STAT_NAMES) {
    const candidates = options.windows.map((windowSize) => {
      const rows = buildFeatureRows(teamGames, windowSize, options.minPriorGames, [statName]);
      const trainRows = rows.filter((row) => row.seasonYear < validationSeason);
      const validationRows = rows.filter((row) => row.seasonYear === validationSeason);
      const model = trainModel(trainRows, options);

      return {
        windowSize,
        validation: evaluate(validationRows, model),
      };
    });

    const best = candidates
      .filter(({ validation }) => Number.isFinite(validation.logLoss))
      .sort((a, b) => a.validation.logLoss - b.validation.logLoss)[0];

    selected[statName] = best?.windowSize ?? options.windows[0];
  }

  return selected;
}

function rollingTargetSeasons(teamGames: TeamGame[], options: Options): number[] {
  const maxSeason = Math.max(...teamGames.map((game) => game.seasonYear));
  const throughSeason = options.rollingThroughSeason ?? maxSeason;
  const seasons = new Set(teamGames.map((game) => game.seasonYear));

  return [...seasons].filter((season) => season >= options.rollingFromSeason && season <= throughSeason).sort((a, b) => a - b);
}

function summarizeSeasonResults(results: WindowResult[], label: string): WindowResult {
  const testMetrics = results.map((result) => result.test).filter((metrics) => metrics.rows > 0);

  return {
    label,
    trainRows: Math.round(average(results.map((result) => result.trainRows))),
    validation: { rows: 0, logLoss: Number.NaN, brier: Number.NaN, accuracy: Number.NaN, auc: Number.NaN },
    test: weightedAverageMetrics(testMetrics),
  };
}

function evaluateAblationsForWindow(
  rows: FeatureRow[],
  options: Options,
  targetSeasons: number[],
  windowLabel: string,
  names: string[],
): AblationResult[] {
  const sets = ablationFeatureSets(names);
  const allFeatureSet = sets.find((set) => set.label === "all_features");
  if (!allFeatureSet) {
    throw new Error("Missing all_features ablation set");
  }

  const allRows = selectFeatureColumns(rows, allFeatureSet.indices);
  const allSummary = summarizeSeasonResults(
    targetSeasons.map((targetSeason) => fitAndEvaluateSeason(allRows, options, windowLabel, targetSeason)),
    windowLabel,
  );

  return sets.map((set) => {
    const selectedRows = selectFeatureColumns(rows, set.indices);
    const summary = summarizeSeasonResults(
      targetSeasons.map((targetSeason) => fitAndEvaluateSeason(selectedRows, options, windowLabel, targetSeason)),
      windowLabel,
    );

    return {
      featureSet: set.label,
      windowLabel,
      trainRows: summary.trainRows,
      test: summary.test,
      deltaVsAll: summary.test.logLoss - allSummary.test.logLoss,
    };
  });
}

function evaluateStability(teamGames: TeamGame[], options: Options, targetSeasons: number[]): StabilityResult[] {
  const candidates: StabilityCandidate[] = [
    { label: "raw_n20_all_features", windowSize: 20, opponentAdjusted: false, featureSet: "all_features" },
    { label: "raw_n20_margin_strength_only", windowSize: 20, opponentAdjusted: false, featureSet: "margin_strength_only" },
    { label: "adjusted_n10_all_features", windowSize: 10, opponentAdjusted: true, featureSet: "all_features" },
    { label: "adjusted_n10_all_except_context", windowSize: 10, opponentAdjusted: true, featureSet: "all_except_context" },
  ];

  return candidates.flatMap((candidate) => {
    const names = featureNames(ROLLING_STAT_NAMES, candidate.opponentAdjusted);
    const rows = selectFeatureSetRows(
      buildFeatureRows(teamGames, candidate.windowSize, options.minPriorGames, ROLLING_STAT_NAMES, candidate.opponentAdjusted),
      names,
      candidate.featureSet,
    );

    const seasonResults = targetSeasons.map((targetSeason) => {
      const result = fitAndEvaluateSeason(rows, options, String(candidate.windowSize), targetSeason);
      return {
        candidate: candidate.label,
        season: String(targetSeason),
        trainRows: result.trainRows,
        test: result.test,
      };
    });
    const averageResult = summarizeSeasonResults(
      seasonResults.map((result) => ({
        label: candidate.label,
        trainRows: result.trainRows,
        validation: { rows: 0, logLoss: Number.NaN, brier: Number.NaN, accuracy: Number.NaN, auc: Number.NaN },
        test: result.test,
      })),
      candidate.label,
    );

    return [
      ...seasonResults,
      {
        candidate: candidate.label,
        season: "average",
        trainRows: averageResult.trainRows,
        test: averageResult.test,
      },
    ];
  });
}

function evaluateLeanCandidates(teamGames: TeamGame[], options: Options, targetSeasons: number[]): StabilityResult[] {
  const candidates: LeanCandidate[] = [
    {
      label: "raw_n20_margin_diff_only",
      windowSize: 20,
      opponentAdjusted: false,
      select: (name) => name === "margin_diff",
    },
    {
      label: "raw_n20_margin_triplet",
      windowSize: 20,
      opponentAdjusted: false,
      select: (name) => name === "team_margin_avg" || name === "opponent_margin_avg" || name === "margin_diff",
    },
    {
      label: "raw_n20_strength_core",
      windowSize: 20,
      opponentAdjusted: false,
      select: isMarginStrengthFeature,
    },
    {
      label: "adjusted_n10_adjusted_margin_only",
      windowSize: 10,
      opponentAdjusted: true,
      select: (name) => name === "adjustedMargin_diff",
    },
    {
      label: "adjusted_n10_adjusted_margin_triplet",
      windowSize: 10,
      opponentAdjusted: true,
      select: (name) =>
        name === "team_adjustedMargin_avg" || name === "opponent_adjustedMargin_avg" || name === "adjustedMargin_diff",
    },
    {
      label: "adjusted_n10_adjusted_form_core",
      windowSize: 10,
      opponentAdjusted: true,
      select: isOpponentAdjustedFeature,
    },
    {
      label: "adjusted_n10_raw_plus_adjusted_margin",
      windowSize: 10,
      opponentAdjusted: true,
      select: (name) =>
        name === "team_margin_avg" ||
        name === "opponent_margin_avg" ||
        name === "margin_diff" ||
        name === "team_adjustedMargin_avg" ||
        name === "opponent_adjustedMargin_avg" ||
        name === "adjustedMargin_diff",
    },
    {
      label: "adjusted_n10_strength_plus_adjusted_form",
      windowSize: 10,
      opponentAdjusted: true,
      select: (name) => isMarginStrengthFeature(name) || isOpponentAdjustedFeature(name),
    },
    {
      label: "adjusted_n10_all_except_context",
      windowSize: 10,
      opponentAdjusted: true,
      select: (name) => !isContextFeature(name),
    },
  ];

  return evaluateLeanCandidateList(teamGames, options, targetSeasons, candidates);
}

function evaluateLeanCandidateList(
  teamGames: TeamGame[],
  options: Options,
  targetSeasons: number[],
  candidates: LeanCandidate[],
): StabilityResult[] {
  return candidates.flatMap((candidate) => {
    const names = featureNames(ROLLING_STAT_NAMES, candidate.opponentAdjusted);
    const rows = selectFeatureRowsByPredicate(
      buildFeatureRows(teamGames, candidate.windowSize, options.minPriorGames, ROLLING_STAT_NAMES, candidate.opponentAdjusted),
      names,
      candidate.select,
    );

    const seasonResults = targetSeasons.map((targetSeason) => {
      const result = fitAndEvaluateSeason(rows, options, String(candidate.windowSize), targetSeason);
      return {
        candidate: candidate.label,
        season: String(targetSeason),
        trainRows: result.trainRows,
        test: result.test,
      };
    });
    const averageResult = summarizeSeasonResults(
      seasonResults.map((result) => ({
        label: candidate.label,
        trainRows: result.trainRows,
        validation: { rows: 0, logLoss: Number.NaN, brier: Number.NaN, accuracy: Number.NaN, auc: Number.NaN },
        test: result.test,
      })),
      candidate.label,
    );

    return [
      ...seasonResults,
      {
        candidate: candidate.label,
        season: "average",
        trainRows: averageResult.trainRows,
        test: averageResult.test,
      },
    ];
  });
}

function evaluateNoContextDrops(teamGames: TeamGame[], options: Options, targetSeasons: number[]): StabilityResult[] {
  const candidates: LeanCandidate[] = [
    {
      label: "raw_n20_strength_core",
      windowSize: 20,
      opponentAdjusted: false,
      select: isMarginStrengthFeature,
    },
    {
      label: "adjusted_n10_all_except_context",
      windowSize: 10,
      opponentAdjusted: true,
      select: (name) => !isContextFeature(name),
    },
    {
      label: "drop_margin_strength",
      windowSize: 10,
      opponentAdjusted: true,
      select: (name) => !isContextFeature(name) && !isMarginStrengthFeature(name),
    },
    {
      label: "drop_shooting",
      windowSize: 10,
      opponentAdjusted: true,
      select: (name) => !isContextFeature(name) && !isShootingFeature(name),
    },
    {
      label: "drop_rebounding",
      windowSize: 10,
      opponentAdjusted: true,
      select: (name) => !isContextFeature(name) && !isReboundingFeature(name),
    },
    {
      label: "drop_turnovers",
      windowSize: 10,
      opponentAdjusted: true,
      select: (name) => !isContextFeature(name) && !isTurnoverFeature(name),
    },
    {
      label: "drop_creation_defense",
      windowSize: 10,
      opponentAdjusted: true,
      select: (name) => !isContextFeature(name) && !isCreationDefenseFeature(name),
    },
    {
      label: "drop_matchup_edges",
      windowSize: 10,
      opponentAdjusted: true,
      select: (name) => !isContextFeature(name) && !isMatchupEdgeFeature(name),
    },
    {
      label: "drop_opponent_adjusted",
      windowSize: 10,
      opponentAdjusted: true,
      select: (name) => !isContextFeature(name) && !isOpponentAdjustedFeature(name),
    },
  ];

  return evaluateLeanCandidateList(teamGames, options, targetSeasons, candidates);
}

function evaluateBestCandidateCleanup(teamGames: TeamGame[], options: Options, targetSeasons: number[]): StabilityResult[] {
  const candidates: LeanCandidate[] = [
    {
      label: "raw_n20_strength_core",
      windowSize: 20,
      opponentAdjusted: false,
      select: isMarginStrengthFeature,
    },
    {
      label: "adjusted_n10_all_except_context",
      windowSize: 10,
      opponentAdjusted: true,
      select: (name) => !isContextFeature(name),
    },
    {
      label: "adjusted_n10_drop_context_rebounding",
      windowSize: 10,
      opponentAdjusted: true,
      select: (name) => !isContextFeature(name) && !isReboundingFeature(name),
    },
    {
      label: "adjusted_n10_drop_context_rebounding_matchup_edges",
      windowSize: 10,
      opponentAdjusted: true,
      select: (name) => !isContextFeature(name) && !isReboundingFeature(name) && !isMatchupEdgeFeature(name),
    },
    {
      label: "adjusted_n10_drop_context_rebounding_shooting",
      windowSize: 10,
      opponentAdjusted: true,
      select: (name) => !isContextFeature(name) && !isReboundingFeature(name) && !isShootingFeature(name),
    },
    {
      label: "adjusted_n10_drop_context_rebounding_turnovers",
      windowSize: 10,
      opponentAdjusted: true,
      select: (name) => !isContextFeature(name) && !isReboundingFeature(name) && !isTurnoverFeature(name),
    },
    {
      label: "adjusted_n10_drop_context_rebounding_creation_defense",
      windowSize: 10,
      opponentAdjusted: true,
      select: (name) => !isContextFeature(name) && !isReboundingFeature(name) && !isCreationDefenseFeature(name),
    },
    {
      label: "adjusted_n10_drop_context_rebounding_shooting_matchup_edges",
      windowSize: 10,
      opponentAdjusted: true,
      select: (name) =>
        !isContextFeature(name) && !isReboundingFeature(name) && !isShootingFeature(name) && !isMatchupEdgeFeature(name),
    },
  ];

  return evaluateLeanCandidateList(teamGames, options, targetSeasons, candidates);
}

function evaluateCalibration(teamGames: TeamGame[], options: Options, targetSeasons: number[]): CalibrationResult[] {
  return selectedDiagnosticCandidates().map((candidate) => {
    const predictions = rollingPredictionsForCandidate(teamGames, options, targetSeasons, candidate);
    const metrics = metricsFromPredictions(predictions);
    const buckets = calibrationBuckets(predictions, 0.05);

    return {
      candidate: candidate.label,
      rows: predictions.length,
      logLoss: metrics.logLoss,
      brier: metrics.brier,
      ece: expectedCalibrationError(buckets),
      buckets,
    };
  });
}

function evaluateSplits(
  teamGames: TeamGame[],
  options: Options,
  targetSeasons: number[],
  teamLabels: Map<string, string>,
): SplitResult[] {
  return evaluateSplitsForCandidates(teamGames, options, targetSeasons, teamLabels, selectedDiagnosticCandidates());
}

function evaluateSplitsForCandidates(
  teamGames: TeamGame[],
  options: Options,
  targetSeasons: number[],
  teamLabels: Map<string, string>,
  candidates: LeanCandidate[],
): SplitResult[] {
  return candidates.flatMap((candidate) => {
    const predictions = rollingPredictionsForCandidate(teamGames, options, targetSeasons, candidate);
    return [
      splitResult(candidate.label, "overall", "all", predictions),
      ...splitBy(candidate.label, "venue", predictions, (prediction) => (prediction.home === 1 ? "home" : "away")),
      ...splitBy(candidate.label, "model_side", predictions, (prediction) => (prediction.p >= 0.5 ? "favorite" : "underdog")),
      ...splitBy(candidate.label, "confidence", predictions, confidenceGroup),
      ...splitBy(candidate.label, "rest", predictions, restGroup),
      ...splitBy(candidate.label, "team", predictions, (prediction) => teamLabel(teamLabels, prediction.teamId)),
    ];
  });
}

function selectedDiagnosticCandidates(): LeanCandidate[] {
  return [
    {
      label: "raw_n20_strength_core",
      windowSize: 20,
      opponentAdjusted: false,
      select: isMarginStrengthFeature,
    },
    {
      label: "adjusted_n10_drop_context_rebounding_matchup_edges",
      windowSize: 10,
      opponentAdjusted: true,
      select: (name) => !isContextFeature(name) && !isReboundingFeature(name) && !isMatchupEdgeFeature(name),
    },
  ];
}

function bestPracticalCandidate(): LeanCandidate {
  return {
    label: "adjusted_n10_drop_context_rebounding_matchup_edges",
    windowSize: 10,
    opponentAdjusted: true,
    select: (name) => !isContextFeature(name) && !isReboundingFeature(name) && !isMatchupEdgeFeature(name),
  };
}

function evaluateBaselineCompare(teamGames: TeamGame[], options: Options, targetSeasons: number[]): StabilityResult[] {
  return evaluateLeanCandidateList(teamGames, options, targetSeasons, contextReintroductionCandidates());
}

function contextReintroductionCandidates(): LeanCandidate[] {
  const bestAdjustedSelect = (name: string) => !isContextFeature(name) && !isReboundingFeature(name) && !isMatchupEdgeFeature(name);

  return [
    {
      label: "raw_n20_strength_core",
      windowSize: 20,
      opponentAdjusted: false,
      select: isMarginStrengthFeature,
    },
    {
      label: "adjusted_n10_drop_context_rebounding_matchup_edges",
      windowSize: 10,
      opponentAdjusted: true,
      select: bestAdjustedSelect,
    },
    {
      label: "adjusted_n10_drop_rebounding_matchup_edges_keep_home",
      windowSize: 10,
      opponentAdjusted: true,
      select: (name) => isHomeFeature(name) || bestAdjustedSelect(name),
    },
    {
      label: "adjusted_n10_drop_rebounding_matchup_edges_keep_home_rest",
      windowSize: 10,
      opponentAdjusted: true,
      select: (name) => isHomeFeature(name) || isRestFeature(name) || bestAdjustedSelect(name),
    },
    {
      label: "adjusted_n10_drop_rebounding_matchup_edges_keep_rest_only",
      windowSize: 10,
      opponentAdjusted: true,
      select: (name) => isRestFeature(name) || bestAdjustedSelect(name),
    },
  ];
}

function evaluateContextReintroduction(
  teamGames: TeamGame[],
  options: Options,
  targetSeasons: number[],
  teamLabels: Map<string, string>,
): ContextReintroductionReport {
  const stability: StabilityResult[] = [];
  const splits: SplitResult[] = [];

  for (const candidate of contextReintroductionCandidates()) {
    const seasonResults = rollingPredictionResultsForCandidate(teamGames, options, targetSeasons, candidate);
    const predictions = seasonResults.flatMap((result) => result.predictions);
    const summary = summarizeSeasonResults(
      seasonResults.map((result) => ({
        label: candidate.label,
        trainRows: result.trainRows,
        validation: { rows: 0, logLoss: Number.NaN, brier: Number.NaN, accuracy: Number.NaN, auc: Number.NaN },
        test: metricsFromPredictions(result.predictions),
      })),
      candidate.label,
    );

    stability.push(
      ...seasonResults.map((result) => ({
        candidate: candidate.label,
        season: String(result.targetSeason),
        trainRows: result.trainRows,
        test: metricsFromPredictions(result.predictions),
      })),
      {
        candidate: candidate.label,
        season: "average",
        trainRows: summary.trainRows,
        test: summary.test,
      },
    );

    splits.push(
      splitResult(candidate.label, "overall", "all", predictions),
      ...splitBy(candidate.label, "venue", predictions, (prediction) => (prediction.home === 1 ? "home" : "away")),
      ...splitBy(candidate.label, "model_side", predictions, (prediction) => (prediction.p >= 0.5 ? "favorite" : "underdog")),
      ...splitBy(candidate.label, "confidence", predictions, confidenceGroup),
      ...splitBy(candidate.label, "rest", predictions, restGroup),
      ...splitBy(candidate.label, "team", predictions, (prediction) => teamLabel(teamLabels, prediction.teamId)),
    );
  }

  return { stability, splits };
}

function evaluateTeamErrors(
  teamGames: TeamGame[],
  options: Options,
  targetSeasons: number[],
  teamLabels: Map<string, string>,
): TeamErrorResult[] {
  return selectedDiagnosticCandidates().flatMap((candidate) => {
    const predictions = rollingPredictionsForCandidate(teamGames, options, targetSeasons, candidate);
    const byTeam = new Map<string, Prediction[]>();

    for (const prediction of predictions) {
      byTeam.set(prediction.teamId, [...(byTeam.get(prediction.teamId) ?? []), prediction]);
    }

    return [...byTeam.entries()]
      .map(([teamId, teamPredictions]) => {
        const wrongPredictions = teamPredictions.filter(predictionIsWrong);
        return {
          candidate: candidate.label,
          team: teamLabel(teamLabels, teamId),
          metrics: metricsFromPredictions(teamPredictions),
          avgPredicted: average(teamPredictions.map((prediction) => prediction.p)),
          actualWinRate: average(teamPredictions.map((prediction) => prediction.y)),
          upsetRate: wrongPredictions.length / teamPredictions.length,
          highConfidenceMisses: wrongPredictions.filter((prediction) => prediction.p >= 0.65 || prediction.p <= 0.35).length,
          worstRows: [...teamPredictions].sort((a, b) => perRowLogLoss(b) - perRowLogLoss(a) || comparePredictionIdentity(a, b)).slice(0, 5),
        };
      })
      .filter((result) => result.metrics.rows >= 20)
      .sort((a, b) => b.metrics.logLoss - a.metrics.logLoss || a.team.localeCompare(b.team));
  });
}

function evaluateSeasonContext(teamGames: TeamGame[], options: Options, targetSeasons: number[]): SeasonContextReport {
  const stability: StabilityResult[] = [];
  const restSplits: SeasonContextReport["restSplits"] = [];

  for (const candidate of contextReintroductionCandidates()) {
    const seasonResults = rollingPredictionResultsForCandidate(teamGames, options, targetSeasons, candidate);
    const summary = summarizeSeasonResults(
      seasonResults.map((result) => ({
        label: candidate.label,
        trainRows: result.trainRows,
        validation: { rows: 0, logLoss: Number.NaN, brier: Number.NaN, accuracy: Number.NaN, auc: Number.NaN },
        test: metricsFromPredictions(result.predictions),
      })),
      candidate.label,
    );

    stability.push(
      ...seasonResults.map((result) => ({
        candidate: candidate.label,
        season: String(result.targetSeason),
        trainRows: result.trainRows,
        test: metricsFromPredictions(result.predictions),
      })),
      {
        candidate: candidate.label,
        season: "average",
        trainRows: summary.trainRows,
        test: summary.test,
      },
    );

    for (const result of seasonResults) {
      restSplits.push(
        ...splitBy(candidate.label, "rest", result.predictions, restGroup).map((split) => ({
          candidate: split.candidate,
          season: String(result.targetSeason),
          restGroup: split.group,
          test: split.test,
        })),
      );
    }
  }

  return { stability, restSplits };
}

function evaluateBootstrap(teamGames: TeamGame[], options: Options, targetSeasons: number[]): BootstrapResult {
  const [baselineCandidate, challengerCandidate] = selectedDiagnosticCandidates();
  if (!baselineCandidate || !challengerCandidate) {
    throw new Error("Bootstrap requires two selected diagnostic candidates");
  }

  const baselinePredictions = rollingPredictionsForCandidate(teamGames, options, targetSeasons, baselineCandidate);
  const challengerPredictions = rollingPredictionsForCandidate(teamGames, options, targetSeasons, challengerCandidate);
  const baselineByGame = predictionsByGame(baselinePredictions);
  const challengerByGame = predictionsByGame(challengerPredictions);
  const gameIds = [...baselineByGame.keys()].filter((gameId) => challengerByGame.has(gameId)).sort();

  if (gameIds.length === 0) {
    throw new Error("Bootstrap requires at least one shared game between candidates");
  }

  const baselineMetrics = metricsFromPredictions(flattenPredictionsForGames(gameIds, baselineByGame));
  const challengerMetrics = metricsFromPredictions(flattenPredictionsForGames(gameIds, challengerByGame));
  const random = seededRandom(options.bootstrapSeed);
  const deltas: number[] = [];
  let challengerWins = 0;

  for (let sample = 0; sample < options.bootstrapSamples; sample += 1) {
    const sampledGameIds = Array.from({ length: gameIds.length }, () => gameIds[Math.floor(random() * gameIds.length)]);
    const baselineSample = metricsFromPredictions(flattenPredictionsForGames(sampledGameIds, baselineByGame));
    const challengerSample = metricsFromPredictions(flattenPredictionsForGames(sampledGameIds, challengerByGame));
    const delta = challengerSample.logLoss - baselineSample.logLoss;
    deltas.push(delta);
    if (delta < 0) {
      challengerWins += 1;
    }
  }

  return {
    baselineCandidate: baselineCandidate.label,
    challengerCandidate: challengerCandidate.label,
    games: gameIds.length,
    rows: baselineMetrics.rows,
    samples: options.bootstrapSamples,
    seed: options.bootstrapSeed,
    baselineLogLoss: baselineMetrics.logLoss,
    challengerLogLoss: challengerMetrics.logLoss,
    observedDelta: challengerMetrics.logLoss - baselineMetrics.logLoss,
    meanDelta: average(deltas),
    lowerDelta: percentile(deltas, 0.025),
    upperDelta: percentile(deltas, 0.975),
    challengerWinRate: challengerWins / deltas.length,
  };
}

function predictionsByGame(predictions: Prediction[]): Map<string, Prediction[]> {
  const byGame = new Map<string, Prediction[]>();
  for (const prediction of predictions) {
    byGame.set(prediction.gameId, [...(byGame.get(prediction.gameId) ?? []), prediction]);
  }
  return byGame;
}

function flattenPredictionsForGames(gameIds: string[], byGame: Map<string, Prediction[]>): Prediction[] {
  return gameIds.flatMap((gameId) => byGame.get(gameId) ?? []);
}

function evaluateErrorCases(
  teamGames: TeamGame[],
  options: Options,
  targetSeasons: number[],
  teamLabels: Map<string, string>,
): ErrorCaseReport {
  const candidate = bestPracticalCandidate();
  const predictions = rollingPredictionsForCandidate(teamGames, options, targetSeasons, candidate);
  const lowConfidencePredictions = predictions.filter((prediction) => prediction.p >= 0.45 && prediction.p <= 0.55);
  const weakTeamIds = ["5", "20", "14", "11", "16"];

  return {
    metrics: metricsFromPredictions(predictions),
    highConfidenceMisses: predictions
      .filter((prediction) => predictionIsWrong(prediction) && (prediction.p >= 0.65 || prediction.p <= 0.35))
      .sort(compareErrorRows)
      .slice(0, 20),
    lowConfidenceMetrics: metricsFromPredictions(lowConfidencePredictions),
    lowConfidenceExamples: [...lowConfidencePredictions].sort(compareErrorRows).slice(0, 20),
    weakTeamSummaries: weakTeamIds.map((teamId) =>
      splitResult(candidate.label, "weak_team", teamLabel(teamLabels, teamId), predictions.filter((prediction) => prediction.teamId === teamId)),
    ),
    worstLosses: [...predictions].sort((a, b) => perRowLogLoss(b) - perRowLogLoss(a) || comparePredictionIdentity(a, b)).slice(0, 20),
  };
}

function predictionIsWrong(prediction: Prediction): boolean {
  return Number(prediction.p >= 0.5) !== prediction.y;
}

function compareErrorRows(a: Prediction, b: Prediction): number {
  return Math.abs(b.p - b.y) - Math.abs(a.p - a.y) || comparePredictionIdentity(a, b);
}

function comparePredictionIdentity(a: Prediction, b: Prediction): number {
  return a.dateMs - b.dateMs || a.gameId.localeCompare(b.gameId) || a.teamId.localeCompare(b.teamId);
}

function perRowLogLoss(prediction: Prediction): number {
  return -(prediction.y * Math.log(prediction.p) + (1 - prediction.y) * Math.log(1 - prediction.p));
}

function rollingPredictionResultsForCandidate(
  teamGames: TeamGame[],
  options: Options,
  targetSeasons: number[],
  candidate: LeanCandidate,
): Array<{ targetSeason: number; trainRows: number; predictions: Prediction[] }> {
  const names = featureNames(ROLLING_STAT_NAMES, candidate.opponentAdjusted);
  const rows = selectFeatureRowsByPredicate(
    buildFeatureRows(teamGames, candidate.windowSize, options.minPriorGames, ROLLING_STAT_NAMES, candidate.opponentAdjusted),
    names,
    candidate.select,
  );

  return targetSeasons.map((targetSeason) => {
    const trainRows = rows.filter((row) => row.seasonYear < targetSeason);
    const testRows = rows.filter((row) => row.seasonYear === targetSeason);
    return {
      targetSeason,
      trainRows: trainRows.length,
      predictions: scoreRows(testRows, trainModel(trainRows, options)),
    };
  });
}

function rollingPredictionsForCandidate(
  teamGames: TeamGame[],
  options: Options,
  targetSeasons: number[],
  candidate: LeanCandidate,
): Prediction[] {
  const names = featureNames(ROLLING_STAT_NAMES, candidate.opponentAdjusted);
  const rows = selectFeatureRowsByPredicate(
    buildFeatureRows(teamGames, candidate.windowSize, options.minPriorGames, ROLLING_STAT_NAMES, candidate.opponentAdjusted),
    names,
    candidate.select,
  );

  return targetSeasons.flatMap((targetSeason) => {
    const trainRows = rows.filter((row) => row.seasonYear < targetSeason);
    const testRows = rows.filter((row) => row.seasonYear === targetSeason);
    return scoreRows(testRows, trainModel(trainRows, options));
  });
}

function splitBy(
  candidate: string,
  split: string,
  predictions: Prediction[],
  groupForPrediction: (prediction: Prediction) => string,
): SplitResult[] {
  const grouped = new Map<string, Prediction[]>();
  for (const prediction of predictions) {
    const group = groupForPrediction(prediction);
    grouped.set(group, [...(grouped.get(group) ?? []), prediction]);
  }

  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, groupPredictions]) => splitResult(candidate, split, group, groupPredictions));
}

function splitResult(candidate: string, split: string, group: string, predictions: Prediction[]): SplitResult {
  return {
    candidate,
    split,
    group,
    test: metricsFromPredictions(predictions),
  };
}

function confidenceGroup(prediction: Prediction): string {
  const confidence = Math.abs(prediction.p - 0.5);

  if (confidence <= 0.05) {
    return "coin_flip_45_55";
  }

  if (confidence <= 0.15) {
    return "lean_35_45_or_55_65";
  }

  return "confident_beyond_65_35";
}

function restGroup(prediction: Prediction): string {
  if (prediction.restAdvantage > 0.5) {
    return "rest_advantage";
  }

  if (prediction.restAdvantage < -0.5) {
    return "rest_disadvantage";
  }

  return "even_rest";
}

function metricsFromPredictions(predictions: Prediction[]): Metrics {
  if (predictions.length === 0) {
    return { rows: 0, logLoss: Number.NaN, brier: Number.NaN, accuracy: Number.NaN, auc: Number.NaN };
  }

  return {
    rows: predictions.length,
    logLoss: average(predictions.map(({ y, p }) => -(y * Math.log(p) + (1 - y) * Math.log(1 - p)))),
    brier: average(predictions.map(({ y, p }) => (p - y) ** 2)),
    accuracy: average(predictions.map(({ y, p }) => (Number(p >= 0.5) === y ? 1 : 0))),
    auc: rocAuc(predictions),
  };
}

function calibrationBuckets(predictions: Prediction[], bucketSize: number): CalibrationBucket[] {
  const bucketCount = Math.ceil(1 / bucketSize);
  const buckets = Array.from({ length: bucketCount }, (_, index) => {
    const lower = index * bucketSize;
    const upper = Math.min(1, lower + bucketSize);
    return {
      label: `${Math.round(lower * 100)}-${Math.round(upper * 100)}%`,
      predictions: [] as Prediction[],
    };
  });

  for (const prediction of predictions) {
    const index = Math.min(bucketCount - 1, Math.floor(prediction.p / bucketSize));
    buckets[index].predictions.push(prediction);
  }

  return buckets
    .filter((bucket) => bucket.predictions.length > 0)
    .map((bucket) => {
      const avgPredicted = average(bucket.predictions.map((prediction) => prediction.p));
      const winRate = average(bucket.predictions.map((prediction) => prediction.y));
      return {
        label: bucket.label,
        rows: bucket.predictions.length,
        avgPredicted,
        winRate,
        error: winRate - avgPredicted,
      };
    });
}

function expectedCalibrationError(buckets: CalibrationBucket[]): number {
  const rows = buckets.reduce((sum, bucket) => sum + bucket.rows, 0);
  return rows > 0 ? buckets.reduce((sum, bucket) => sum + Math.abs(bucket.error) * bucket.rows, 0) / rows : Number.NaN;
}

function weightedAverageMetrics(metrics: Metrics[]): Metrics {
  const rows = metrics.reduce((sum, metric) => sum + metric.rows, 0);

  if (rows === 0) {
    return { rows: 0, logLoss: Number.NaN, brier: Number.NaN, accuracy: Number.NaN, auc: Number.NaN };
  }

  return {
    rows,
    logLoss: weightedAverage(metrics, "logLoss"),
    brier: weightedAverage(metrics, "brier"),
    accuracy: weightedAverage(metrics, "accuracy"),
    auc: weightedAverage(metrics, "auc"),
  };
}

function weightedAverage(metrics: Metrics[], key: keyof Omit<Metrics, "rows">): number {
  const valid = metrics.filter((metric) => Number.isFinite(metric[key]));
  const rows = valid.reduce((sum, metric) => sum + metric.rows, 0);
  return rows > 0 ? valid.reduce((sum, metric) => sum + metric[key] * metric.rows, 0) / rows : Number.NaN;
}

function printResultTable(results: WindowResult[]): void {
  console.log("window | train rows | val logloss | val brier | val acc | val auc | test logloss | test brier | test acc | test auc");
  console.log("-".repeat(110));

  for (const result of results) {
    console.log(formatResultRow(result));
  }
}

function printRollingResultTable(results: WindowResult[]): void {
  console.log("window | avg train rows | eval rows | logloss | brier | acc | auc");
  console.log("-".repeat(74));

  for (const result of results) {
    console.log(
      [
        result.label.padStart(6),
        result.trainRows.toString().padStart(14),
        result.test.rows.toString().padStart(9),
        formatMetric(result.test.logLoss).padStart(7),
        formatMetric(result.test.brier).padStart(6),
        formatMetric(result.test.accuracy).padStart(5),
        formatMetric(result.test.auc).padStart(5),
      ].join(" | "),
    );
  }
}

function printAblationTable(results: AblationResult[]): void {
  console.log("feature set | window | avg train rows | eval rows | logloss | delta vs all | brier | acc | auc");
  console.log("-".repeat(112));

  for (const result of results) {
    console.log(
      [
        result.featureSet.padEnd(28),
        result.windowLabel.padStart(6),
        result.trainRows.toString().padStart(14),
        result.test.rows.toString().padStart(9),
        formatMetric(result.test.logLoss).padStart(7),
        formatSigned(result.deltaVsAll).padStart(12),
        formatMetric(result.test.brier).padStart(6),
        formatMetric(result.test.accuracy).padStart(5),
        formatMetric(result.test.auc).padStart(5),
      ].join(" | "),
    );
  }
}

function printStabilityTable(results: StabilityResult[]): void {
  console.log("candidate | season | train rows | eval rows | logloss | brier | acc | auc");
  console.log("-".repeat(104));

  for (const result of results) {
    console.log(
      [
        result.candidate.padEnd(34),
        result.season.padStart(7),
        result.trainRows.toString().padStart(10),
        result.test.rows.toString().padStart(9),
        formatMetric(result.test.logLoss).padStart(7),
        formatMetric(result.test.brier).padStart(6),
        formatMetric(result.test.accuracy).padStart(5),
        formatMetric(result.test.auc).padStart(5),
      ].join(" | "),
    );
  }
}

function printCalibrationReport(results: CalibrationResult[]): void {
  console.log("candidate | rows | logloss | brier | ece");
  console.log("-".repeat(72));
  for (const result of results) {
    console.log(
      [
        result.candidate.padEnd(50),
        result.rows.toString().padStart(4),
        formatMetric(result.logLoss).padStart(7),
        formatMetric(result.brier).padStart(6),
        formatMetric(result.ece).padStart(6),
      ].join(" | "),
    );
  }

  for (const result of results) {
    console.log("");
    console.log(`${result.candidate} calibration buckets`);
    console.log("bucket | rows | avg predicted | actual win rate | actual - predicted");
    console.log("-".repeat(76));
    for (const bucket of result.buckets) {
      console.log(
        [
          bucket.label.padStart(7),
          bucket.rows.toString().padStart(4),
          formatMetric(bucket.avgPredicted).padStart(13),
          formatMetric(bucket.winRate).padStart(15),
          formatSigned(bucket.error).padStart(18),
        ].join(" | "),
      );
    }
  }
}

function printSplitReport(results: SplitResult[]): void {
  const primarySplits = results.filter((result) => result.split !== "team");
  console.log("candidate | split | group | rows | logloss | brier | acc | auc");
  console.log("-".repeat(124));
  for (const result of primarySplits) {
    printSplitResultRow(result);
  }

  const byCandidate = new Map<string, SplitResult[]>();
  for (const result of results.filter((row) => row.split === "team" && row.test.rows >= 20)) {
    byCandidate.set(result.candidate, [...(byCandidate.get(result.candidate) ?? []), result]);
  }

  for (const [candidate, teamRows] of byCandidate.entries()) {
    const ranked = [...teamRows].sort((a, b) => a.test.logLoss - b.test.logLoss);
    console.log("");
    console.log(`${candidate} team split highlights (minimum 20 rows)`);
    console.log("group | rows | logloss | brier | acc | auc");
    console.log("-".repeat(58));
    console.log("Best teams by log loss");
    for (const result of ranked.slice(0, 5)) {
      printTeamSplitRow(result);
    }
    console.log("Worst teams by log loss");
    for (const result of ranked.slice(-5).reverse()) {
      printTeamSplitRow(result);
    }
  }
}

function printTeamErrorReport(results: TeamErrorResult[], teamLabels: Map<string, string>): void {
  const byCandidate = new Map<string, TeamErrorResult[]>();
  for (const result of results) {
    byCandidate.set(result.candidate, [...(byCandidate.get(result.candidate) ?? []), result]);
  }

  for (const [candidate, teamRows] of byCandidate.entries()) {
    console.log("");
    console.log(`${candidate} team error diagnostics (minimum 20 rows)`);
    console.log("team | rows | logloss | brier | acc | auc | avg p | actual win% | upset rate | high-conf misses");
    console.log("-".repeat(104));
    for (const result of teamRows) {
      console.log(
        [
          truncate(result.team, 12).padEnd(12),
          result.metrics.rows.toString().padStart(4),
          formatMetric(result.metrics.logLoss).padStart(7),
          formatMetric(result.metrics.brier).padStart(6),
          formatMetric(result.metrics.accuracy).padStart(5),
          formatMetric(result.metrics.auc).padStart(5),
          formatProbability(result.avgPredicted).padStart(6),
          formatProbability(result.actualWinRate).padStart(11),
          formatProbability(result.upsetRate).padStart(10),
          result.highConfidenceMisses.toString().padStart(16),
        ].join(" | "),
      );
    }

    console.log("");
    console.log(`${candidate} worst rows for five weakest teams`);
    for (const result of teamRows.slice(0, 5)) {
      console.log("");
      console.log(`${result.team} rows`);
      printPredictionRows(result.worstRows, teamLabels, 5);
    }
  }
}

function printSeasonContextReport(report: SeasonContextReport): void {
  console.log("Season-context candidate results");
  printStabilityTable(report.stability);

  console.log("");
  console.log("Season-context rest split results");
  console.log("candidate | season | rest group | rows | logloss | brier | acc | auc");
  console.log("-".repeat(112));
  for (const result of report.restSplits) {
    console.log(
      [
        result.candidate.padEnd(50),
        result.season.padStart(6),
        result.restGroup.padEnd(17),
        result.test.rows.toString().padStart(4),
        formatMetric(result.test.logLoss).padStart(7),
        formatMetric(result.test.brier).padStart(6),
        formatMetric(result.test.accuracy).padStart(5),
        formatMetric(result.test.auc).padStart(5),
      ].join(" | "),
    );
  }
}

function printBootstrapReport(result: BootstrapResult): void {
  console.log("candidate | games | rows | logloss");
  console.log("-".repeat(72));
  console.log(
    [
      result.baselineCandidate.padEnd(50),
      result.games.toString().padStart(5),
      result.rows.toString().padStart(4),
      formatMetric(result.baselineLogLoss).padStart(7),
    ].join(" | "),
  );
  console.log(
    [
      result.challengerCandidate.padEnd(50),
      result.games.toString().padStart(5),
      result.rows.toString().padStart(4),
      formatMetric(result.challengerLogLoss).padStart(7),
    ].join(" | "),
  );

  console.log("");
  console.log("Bootstrap log-loss delta: challenger - baseline");
  console.log("samples | seed | observed | mean | 2.5% | 97.5% | challenger better");
  console.log("-".repeat(86));
  console.log(
    [
      result.samples.toString().padStart(7),
      result.seed.toString().padStart(10),
      formatSigned(result.observedDelta).padStart(8),
      formatSigned(result.meanDelta).padStart(7),
      formatSigned(result.lowerDelta).padStart(6),
      formatSigned(result.upperDelta).padStart(7),
      formatProbability(result.challengerWinRate).padStart(17),
    ].join(" | "),
  );
}

function printErrorCaseReport(report: ErrorCaseReport, teamLabels: Map<string, string>): void {
  console.log("overall | rows | logloss | brier | acc | auc");
  console.log("-".repeat(54));
  console.log(
    [
      "best_candidate".padEnd(9),
      report.metrics.rows.toString().padStart(4),
      formatMetric(report.metrics.logLoss).padStart(7),
      formatMetric(report.metrics.brier).padStart(6),
      formatMetric(report.metrics.accuracy).padStart(5),
      formatMetric(report.metrics.auc).padStart(5),
    ].join(" | "),
  );

  console.log("");
  console.log("High-confidence misses");
  printPredictionRows(report.highConfidenceMisses, teamLabels);

  console.log("");
  console.log("Low-confidence outcomes (45-55% band)");
  console.log("rows | logloss | brier | acc | auc");
  console.log("-".repeat(36));
  console.log(
    [
      report.lowConfidenceMetrics.rows.toString().padStart(4),
      formatMetric(report.lowConfidenceMetrics.logLoss).padStart(7),
      formatMetric(report.lowConfidenceMetrics.brier).padStart(6),
      formatMetric(report.lowConfidenceMetrics.accuracy).padStart(5),
      formatMetric(report.lowConfidenceMetrics.auc).padStart(5),
    ].join(" | "),
  );
  console.log("");
  console.log("Most surprising low-confidence rows");
  printPredictionRows(report.lowConfidenceExamples, teamLabels, 10);

  console.log("");
  console.log("Weak-team error summary");
  console.log("team | rows | logloss | brier | acc | auc");
  console.log("-".repeat(58));
  for (const result of report.weakTeamSummaries) {
    printTeamSplitRow(result);
  }

  console.log("");
  console.log("Worst individual row log losses");
  printPredictionRows(report.worstLosses, teamLabels);
}

function printPredictionRows(rows: Prediction[], teamLabels: Map<string, string>, limit = 20): void {
  console.log("date | season | game | team | opp | loc | score | actual | pred | p | conf | rest | row loss");
  console.log("-".repeat(130));
  for (const prediction of rows.slice(0, limit)) {
    console.log(formatPredictionRow(prediction, teamLabels));
  }
}

function formatPredictionRow(prediction: Prediction, teamLabels: Map<string, string>): string {
  const actual = prediction.y === 1 ? "win" : "loss";
  const predicted = prediction.p >= 0.5 ? "win" : "loss";
  const confidence = Math.abs(prediction.p - 0.5) * 2;

  return [
    formatDate(prediction.date).padEnd(10),
    prediction.seasonYear.toString().padStart(6),
    truncate(prediction.gameId, 10).padEnd(10),
    truncate(teamLabel(teamLabels, prediction.teamId), 12).padEnd(12),
    truncate(teamLabel(teamLabels, prediction.opponentTeamId), 12).padEnd(12),
    (prediction.home === 1 ? "home" : "away").padEnd(4),
    `${prediction.scoreFor}-${prediction.scoreAgainst}`.padStart(7),
    actual.padEnd(6),
    predicted.padEnd(4),
    formatProbability(prediction.p).padStart(6),
    formatProbability(confidence).padStart(6),
    formatSigned(prediction.restAdvantage).padStart(7),
    formatMetric(perRowLogLoss(prediction)).padStart(8),
  ].join(" | ");
}

function printSplitResultRow(result: SplitResult): void {
  console.log(
    [
      result.candidate.padEnd(50),
      result.split.padEnd(12),
      result.group.padEnd(24),
      result.test.rows.toString().padStart(4),
      formatMetric(result.test.logLoss).padStart(7),
      formatMetric(result.test.brier).padStart(6),
      formatMetric(result.test.accuracy).padStart(5),
      formatMetric(result.test.auc).padStart(5),
    ].join(" | "),
  );
}

function printTeamSplitRow(result: SplitResult): void {
  console.log(
    [
      truncate(result.group, 12).padEnd(12),
      result.test.rows.toString().padStart(4),
      formatMetric(result.test.logLoss).padStart(7),
      formatMetric(result.test.brier).padStart(6),
      formatMetric(result.test.accuracy).padStart(5),
      formatMetric(result.test.auc).padStart(5),
    ].join(" | "),
  );
}

function formatResultRow(result: WindowResult): string {
  return [
    result.label.padStart(6),
    result.trainRows.toString().padStart(10),
    formatMetric(result.validation.logLoss).padStart(11),
    formatMetric(result.validation.brier).padStart(9),
    formatMetric(result.validation.accuracy).padStart(7),
    formatMetric(result.validation.auc).padStart(7),
    formatMetric(result.test.logLoss).padStart(12),
    formatMetric(result.test.brier).padStart(10),
    formatMetric(result.test.accuracy).padStart(8),
    formatMetric(result.test.auc).padStart(8),
  ].join(" | ");
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const db = new Database(options.dbPath, { readonly: true, fileMustExist: true });

  try {
    const gameUniverseLabel = options.postseason ? "postseason franchise" : "regular-season franchise";
    const teamGames = loadTeamGames(db, options.postseason ? POSTSEASON_TYPE : REGULAR_SEASON_TYPE);
    console.log(`Loaded ${teamGames.length.toLocaleString()} ${gameUniverseLabel} team-game rows from ${options.dbPath}`);

    if (options.gameTypeAudit) {
      printGameTypeAudit(db, teamGames);
      return;
    }

    const targetSeasons = rollingTargetSeasons(teamGames, options);
    console.log(`Rolling-origin target seasons: ${targetSeasons.join(", ")}`);

    const barePostseasonReport =
      options.postseason &&
      !options.stability &&
      !options.leanCandidates &&
      !options.noContextDrops &&
      !options.bestCandidateCleanup &&
      !options.calibration &&
      !options.splits &&
      !options.baselineCompare &&
      !options.teamErrors &&
      !options.seasonContext &&
      !options.bootstrap &&
      !options.contextReintro &&
      !options.errorCases;

    if (barePostseasonReport) {
      console.log("");
      console.log("Postseason-only baseline comparison by target season");
      console.log("Each target season is trained on earlier postseason games only.");
      printStabilityTable(evaluateBaselineCompare(teamGames, options, targetSeasons));
      return;
    }

    if (options.stability) {
      console.log("");
      console.log("Candidate stability by target season");
      console.log("Each target season is trained on all earlier seasons.");
      printStabilityTable(evaluateStability(teamGames, options, targetSeasons));
      return;
    }

    if (options.leanCandidates) {
      console.log("");
      console.log("Lean candidate comparison by target season");
      console.log("Each target season is trained on all earlier seasons.");
      printStabilityTable(evaluateLeanCandidates(teamGames, options, targetSeasons));
      return;
    }

    if (options.noContextDrops) {
      console.log("");
      console.log("Adjusted no-context drop-family comparison by target season");
      console.log("Each target season is trained on all earlier seasons.");
      printStabilityTable(evaluateNoContextDrops(teamGames, options, targetSeasons));
      return;
    }

    if (options.bestCandidateCleanup) {
      console.log("");
      console.log("Best-candidate cleanup comparison by target season");
      console.log("Each target season is trained on all earlier seasons.");
      printStabilityTable(evaluateBestCandidateCleanup(teamGames, options, targetSeasons));
      return;
    }

    if (options.calibration) {
      console.log("");
      console.log("Calibration by rolling-origin prediction bucket");
      console.log("Each target season is trained on all earlier seasons.");
      printCalibrationReport(evaluateCalibration(teamGames, options, targetSeasons));
      return;
    }

    if (options.splits) {
      console.log("");
      console.log("Split diagnostics for selected candidate models");
      console.log("Each target season is trained on all earlier seasons.");
      printSplitReport(evaluateSplits(teamGames, options, targetSeasons, loadTeamLabels(db)));
      return;
    }

    if (options.baselineCompare) {
      console.log("");
      console.log("Canonical baseline comparison by target season");
      console.log("Each target season is trained on all earlier seasons.");
      printStabilityTable(evaluateBaselineCompare(teamGames, options, targetSeasons));
      return;
    }

    if (options.teamErrors) {
      const teamLabels = loadTeamLabels(db);
      console.log("");
      console.log("Team-level error diagnostics for leading candidates");
      console.log("Each target season is trained on all earlier seasons.");
      printTeamErrorReport(evaluateTeamErrors(teamGames, options, targetSeasons, teamLabels), teamLabels);
      return;
    }

    if (options.seasonContext) {
      console.log("");
      console.log("Season and rest split diagnostics for context variants");
      console.log("Each target season is trained on all earlier seasons.");
      printSeasonContextReport(evaluateSeasonContext(teamGames, options, targetSeasons));
      return;
    }

    if (options.bootstrap) {
      console.log("");
      console.log("Game-level bootstrap for leading candidate log-loss gap");
      console.log("Each bootstrap sample resamples games and keeps paired team rows together.");
      printBootstrapReport(evaluateBootstrap(teamGames, options, targetSeasons));
      return;
    }

    if (options.contextReintro) {
      const report = evaluateContextReintroduction(teamGames, options, targetSeasons, loadTeamLabels(db));

      console.log("");
      console.log("Surgical context reintroduction by target season");
      console.log("Each target season is trained on all earlier seasons.");
      printStabilityTable(report.stability);

      console.log("");
      console.log("Surgical context reintroduction split diagnostics");
      printSplitReport(report.splits);
      return;
    }

    if (options.errorCases) {
      const teamLabels = loadTeamLabels(db);
      console.log("");
      console.log("Error-case analysis for adjusted_n10_drop_context_rebounding_matchup_edges");
      console.log("Each target season is trained on all earlier seasons.");
      printErrorCaseReport(evaluateErrorCases(teamGames, options, targetSeasons, teamLabels), teamLabels);
      return;
    }

    console.log("");
    console.log("Rolling-origin global-window models");
    console.log("Each target season is trained on all earlier seasons.");

    const rollingGlobalResults = options.windows.map((windowSize) => {
      const rows = buildFeatureRows(teamGames, windowSize, options.minPriorGames, ROLLING_STAT_NAMES, options.opponentAdjusted);
      const seasonResults = targetSeasons.map((targetSeason) => fitAndEvaluateSeason(rows, options, String(windowSize), targetSeason));
      return summarizeSeasonResults(seasonResults, String(windowSize));
    });

    printRollingResultTable(rollingGlobalResults);

    const bestRollingGlobal = [...rollingGlobalResults]
      .filter((result) => Number.isFinite(result.test.logLoss))
      .sort((a, b) => a.test.logLoss - b.test.logLoss)[0];

    if (bestRollingGlobal) {
      console.log("");
      console.log(`Best rolling global log loss: n=${bestRollingGlobal.label} (${formatMetric(bestRollingGlobal.test.logLoss)})`);

      const bestWindowSize = Number.parseInt(bestRollingGlobal.label, 10);
      const latestTargetSeason = targetSeasons[targetSeasons.length - 1];
      if (!options.ablation && Number.isInteger(bestWindowSize) && latestTargetSeason) {
        const rows = buildFeatureRows(teamGames, bestWindowSize, options.minPriorGames, ROLLING_STAT_NAMES, options.opponentAdjusted);
        const importanceRows = featureImportance(rows, options, latestTargetSeason, featureNames(ROLLING_STAT_NAMES, options.opponentAdjusted));
        console.log("");
        console.log(`Top feature factors for n=${bestWindowSize}, evaluated on ${latestTargetSeason}`);
        console.log("Positive coefficients push toward a win for the row's team; permutation delta measures predictive value.");
        printImportanceTable(importanceRows, 15);
      }
    }

    if (options.ablation) {
      console.log("");
      console.log("Grouped feature ablation");
      console.log("Each feature set uses the same rolling-origin seasons as the global-window table.");

      const names = featureNames(ROLLING_STAT_NAMES, options.opponentAdjusted);
      for (const windowSize of options.windows) {
        const rows = buildFeatureRows(teamGames, windowSize, options.minPriorGames, ROLLING_STAT_NAMES, options.opponentAdjusted);
        const ablationResults = evaluateAblationsForWindow(rows, options, targetSeasons, String(windowSize), names);
        console.log("");
        console.log(`Ablation results for n=${windowSize}`);
        printAblationTable(ablationResults);
      }
    }

    if (!options.skipMixed && !options.ablation) {
      console.log("");
      console.log("Rolling-origin mixed-window model");
      console.log("For each target season, stat windows are selected using the immediately prior season.");

      const mixedSeasonResults: WindowResult[] = [];
      for (const targetSeason of targetSeasons) {
        const selectedWindows = selectWindowsByStatForTargetSeason(teamGames, options, targetSeason);
        const rows = buildFeatureRows(teamGames, selectedWindows, options.minPriorGames, ROLLING_STAT_NAMES, options.opponentAdjusted);
        const result = fitAndEvaluateSeason(rows, options, String(targetSeason), targetSeason);
        mixedSeasonResults.push(result);
        console.log(
          `${targetSeason}: logloss=${formatMetric(result.test.logLoss)} brier=${formatMetric(result.test.brier)} acc=${formatMetric(
            result.test.accuracy,
          )} auc=${formatMetric(result.test.auc)}`,
        );
      }

      console.log("");
      console.log("Rolling mixed average");
      printRollingResultTable([summarizeSeasonResults(mixedSeasonResults, "mixed")]);
    }

    if (options.includeSingleSplit) {
      console.log("");
      console.log("Single validation/test split");
      console.log(
        `Splits: train <= ${options.trainThroughSeason}, validate = ${options.validateSeason}, test = ${options.testSeason}`,
      );
      console.log("");
      console.log("Global-window models");

      const results = options.windows.map((windowSize) => {
        const rows = buildFeatureRows(teamGames, windowSize, options.minPriorGames, ROLLING_STAT_NAMES, options.opponentAdjusted);
        return fitAndEvaluate(rows, options, String(windowSize));
      });

      printResultTable(results);

      const best = [...results]
        .filter((result) => Number.isFinite(result.validation.logLoss))
        .sort((a, b) => a.validation.logLoss - b.validation.logLoss)[0];

      if (best) {
        console.log("");
        console.log(`Best global validation log loss: n=${best.label} (${formatMetric(best.validation.logLoss)})`);
      }

      console.log("");
      console.log("Selecting stat-specific windows using validation log loss from one-stat models...");
      const selectedWindows = selectWindowsByStat(teamGames, options);
      for (const statName of ROLLING_STAT_NAMES) {
        console.log(`${statName.padEnd(25)} n=${selectedWindows[statName]}`);
      }

      const mixedRows = buildFeatureRows(teamGames, selectedWindows, options.minPriorGames, ROLLING_STAT_NAMES, options.opponentAdjusted);
      const mixedResult = fitAndEvaluate(mixedRows, options, "mixed");

      console.log("");
      console.log("Mixed-window model");
      printResultTable([mixedResult]);
    }
  } finally {
    db.close();
  }
}

main();
