import Database from "better-sqlite3";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Options = {
  dbPath: string;
  from: string;
  limit: number;
  minPriorGames: number;
  windowSize: number;
  l2: number;
  iterations: number;
  learningRate: number;
  htmlPath: string | null;
  eli5: boolean;
  marketPath: string | null;
  marketsDb: boolean;
  marketBookmaker: string | null;
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
};

type FeatureRow = {
  y: number;
  features: number[];
};

type TrainedModel = {
  weights: number[];
  mean: number[];
  std: number[];
};

type ScheduledGame = {
  eventId: string;
  date: string;
  dateMs: number;
  shortName: string;
  statusDetail: string | null;
  venueName: string | null;
  broadcast: string | null;
  homeTeamId: string;
  homeTeam: string;
  awayTeamId: string;
  awayTeam: string;
};

type Prediction = {
  game: ScheduledGame;
  homeProbability: number;
  awayProbability: number;
  favorite: string;
  favoriteProbability: number;
  confidence: "coin flip" | "lean" | "solid";
  trainRows: number;
  warning: string | null;
  homeSummary: TeamSummary;
  awaySummary: TeamSummary;
  contributions: Contribution[];
  market: MarketComparison | null;
};

type MarketInput = {
  eventId?: string;
  game?: string;
  shortName?: string;
  homeTeam?: string;
  awayTeam?: string;
  homeMoneyline?: number;
  awayMoneyline?: number;
  homeImpliedProbability?: number;
  awayImpliedProbability?: number;
  homeSpread?: number;
  awaySpread?: number;
  book?: string;
  note?: string;
};

type MarketComparison = {
  homeMarketProbability: number;
  awayMarketProbability: number;
  homeEdge: number;
  awayEdge: number;
  valueSide: string;
  valueEdge: number;
  homeMoneyline: number | null;
  awayMoneyline: number | null;
  homeSpread: number | null;
  awaySpread: number | null;
  book: string | null;
  note: string | null;
};

type TeamSummary = {
  games: number;
  wins: number;
  losses: number;
  winPct: number;
  avgFor: number;
  avgAgainst: number;
  avgMargin: number;
  last5Margin: number;
  restDays: number | null;
  recentGames: Array<{
    date: string;
    opponentTeamId: string;
    scoreFor: number;
    scoreAgainst: number;
    winner: number;
    home: number;
  }>;
};

type Contribution = {
  feature: string;
  value: number;
  standardized: number;
  weight: number;
  contribution: number;
};

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, "wnba_raw.sqlite");
const REGULAR_SEASON_TYPE = 2;
const NON_FRANCHISE_TEAM_IDS = ["96", "97", "112530", "126287", "131246", "131247"];
const STRENGTH_STAT_NAMES = ["scoreFor", "scoreAgainst", "margin", "winPct"];
const STRENGTH_FEATURE_NAMES = STRENGTH_STAT_NAMES.flatMap((name) => [
  `home_${name}_avg`,
  `away_${name}_avg`,
  `${name}_diff`,
]);

function parseArgs(argv: string[]): Options {
  const options: Options = {
    dbPath: process.env.WNBA_RAW_DB ?? DEFAULT_DB_PATH,
    from: new Date().toISOString(),
    limit: 12,
    minPriorGames: 3,
    windowSize: 20,
    l2: 0.01,
    iterations: 2000,
    learningRate: 0.05,
    htmlPath: null,
    eli5: false,
    marketPath: null,
    marketsDb: false,
    marketBookmaker: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--db" && next) {
      options.dbPath = path.resolve(next);
      i += 1;
    } else if (arg === "--from" && next) {
      options.from = normalizeFromDate(next);
      i += 1;
    } else if (arg === "--limit" && next) {
      options.limit = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--min-prior-games" && next) {
      options.minPriorGames = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--window" && next) {
      options.windowSize = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--html" && next) {
      options.htmlPath = path.resolve(next);
      i += 1;
    } else if (arg === "--markets" && next) {
      options.marketPath = path.resolve(next);
      i += 1;
    } else if (arg === "--markets-db") {
      options.marketsDb = true;
    } else if (arg === "--market-bookmaker" && next) {
      options.marketBookmaker = next;
      i += 1;
    } else if (arg === "--eli5") {
      options.eli5 = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new Error("--limit must be a positive integer");
  }

  if (!Number.isInteger(options.minPriorGames) || options.minPriorGames < 1) {
    throw new Error("--min-prior-games must be a positive integer");
  }

  if (!Number.isInteger(options.windowSize) || options.windowSize < 1) {
    throw new Error("--window must be a positive integer");
  }

  return options;
}

function printHelp(): void {
  console.log(`Usage: pnpm run predict:upcoming -- [options]

Options:
  --db <path>             SQLite database path. Defaults to ${DEFAULT_DB_PATH}
  --from <iso/date>       First scheduled tip time to predict. Defaults to now.
                          Date-only values are interpreted as UTC midnight.
  --limit <n>             Number of scheduled games to predict. Defaults to 12.
  --window <n>            Rolling strength window. Defaults to 20.
  --min-prior-games <n>   Minimum team/opponent history. Defaults to 3.
  --html <path>           Also write a self-contained HTML report.
  --markets <path>        Optional JSON market file with moneylines, implied probabilities, and spreads.
  --markets-db            Load latest stored market lines from SQLite.
  --market-bookmaker <b>  With --markets-db, use one bookmaker key/title instead of consensus.
  --eli5                  Add plain-English explanation overlays to the HTML report.
  -h, --help              Show this help text.
`);
}

function normalizeFromDate(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${value}T00:00:00.000Z`;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Could not parse --from date: ${value}`);
  }

  return parsed.toISOString();
}

function loadTeamGames(db: Database.Database): TeamGame[] {
  const rawRows = db
    .prepare(
      `
      SELECT
        g.game_id AS gameId,
        g.season_year AS seasonYear,
        g.date AS date,
        c.team_id AS teamId,
        o.team_id AS opponentTeamId,
        CASE WHEN c.home_away = 'home' THEN 1 ELSE 0 END AS home,
        c.score AS scoreFor,
        o.score AS scoreAgainst,
        c.winner AS winner
      FROM games g
      JOIN game_competitors c ON c.game_id = g.game_id
      JOIN game_competitors o ON o.game_id = c.game_id AND o.team_id <> c.team_id
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
    .all(REGULAR_SEASON_TYPE, ...NON_FRANCHISE_TEAM_IDS, ...NON_FRANCHISE_TEAM_IDS) as Array<Record<string, unknown>>;

  const rawGames = rawRows.map((row) => ({
    gameId: String(row.gameId),
    teamId: String(row.teamId),
    opponentTeamId: String(row.opponentTeamId),
    seasonYear: Number(row.seasonYear),
    date: String(row.date),
    dateMs: Date.parse(String(row.date)),
    home: Number(row.home),
    scoreFor: Number(row.scoreFor),
    scoreAgainst: Number(row.scoreAgainst),
    winner: Number(row.winner),
  }));

  const scheduleRows = db
    .prepare(
      `
      SELECT
        e.event_id AS gameId,
        e.season_year AS seasonYear,
        e.date AS date,
        c.team_id AS teamId,
        o.team_id AS opponentTeamId,
        CASE WHEN c.home_away = 'home' THEN 1 ELSE 0 END AS home,
        c.score AS scoreFor,
        o.score AS scoreAgainst,
        c.winner AS winner
      FROM espn_schedule_events e
      JOIN espn_schedule_competitors c ON c.event_id = e.event_id
      JOIN espn_schedule_competitors o ON o.event_id = c.event_id AND o.team_id <> c.team_id
      LEFT JOIN games g ON g.game_id = e.event_id
      WHERE e.status_completed = 1
        AND e.season_type = ?
        AND g.game_id IS NULL
        AND c.team_id NOT IN (${NON_FRANCHISE_TEAM_IDS.map(() => "?").join(",")})
        AND o.team_id NOT IN (${NON_FRANCHISE_TEAM_IDS.map(() => "?").join(",")})
        AND c.score IS NOT NULL
        AND o.score IS NOT NULL
        AND c.winner IS NOT NULL
      ORDER BY e.date, e.event_id, c.team_id
    `,
    )
    .all(REGULAR_SEASON_TYPE, ...NON_FRANCHISE_TEAM_IDS, ...NON_FRANCHISE_TEAM_IDS) as Array<Record<string, unknown>>;

  const scheduleGames = scheduleRows.map((row) => ({
    gameId: String(row.gameId),
    teamId: String(row.teamId),
    opponentTeamId: String(row.opponentTeamId),
    seasonYear: Number(row.seasonYear),
    date: String(row.date),
    dateMs: Date.parse(String(row.date)),
    home: Number(row.home),
    scoreFor: Number(row.scoreFor),
    scoreAgainst: Number(row.scoreAgainst),
    winner: Number(row.winner),
  }));

  return [...rawGames, ...scheduleGames].sort(
    (a, b) => a.dateMs - b.dateMs || a.gameId.localeCompare(b.gameId) || a.teamId.localeCompare(b.teamId),
  );
}

function loadScheduledGames(db: Database.Database, from: string, limit: number): ScheduledGame[] {
  const rows = db
    .prepare(
      `
      SELECT
        e.event_id AS eventId,
        e.date AS date,
        e.short_name AS shortName,
        e.status_detail AS statusDetail,
        e.venue_name AS venueName,
        e.broadcast AS broadcast,
        home.team_id AS homeTeamId,
        COALESCE(home.team_abbreviation, home.team_short_display_name, home.team_display_name, home.team_id) AS homeTeam,
        away.team_id AS awayTeamId,
        COALESCE(away.team_abbreviation, away.team_short_display_name, away.team_display_name, away.team_id) AS awayTeam
      FROM espn_schedule_events e
      JOIN espn_schedule_competitors home ON home.event_id = e.event_id AND home.home_away = 'home'
      JOIN espn_schedule_competitors away ON away.event_id = e.event_id AND away.home_away = 'away'
      WHERE e.season_type = ?
        AND e.status_completed = 0
        AND e.date >= ?
      ORDER BY e.date, e.event_id
      LIMIT ?
    `,
    )
    .all(REGULAR_SEASON_TYPE, from, limit) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    eventId: String(row.eventId),
    date: String(row.date),
    dateMs: Date.parse(String(row.date)),
    shortName: String(row.shortName),
    statusDetail: stringOrNull(row.statusDetail),
    venueName: stringOrNull(row.venueName),
    broadcast: stringOrNull(row.broadcast),
    homeTeamId: String(row.homeTeamId),
    homeTeam: String(row.homeTeam),
    awayTeamId: String(row.awayTeamId),
    awayTeam: String(row.awayTeam),
  }));
}

function buildTrainingRows(teamGames: TeamGame[], beforeDateMs: number, options: Options): FeatureRow[] {
  const rows: FeatureRow[] = [];
  const historyByTeam = new Map<string, TeamGame[]>();

  for (const game of teamGames) {
    if (game.dateMs >= beforeDateMs) {
      break;
    }

    const teamHistory = historyByTeam.get(game.teamId) ?? [];
    const opponentHistory = historyByTeam.get(game.opponentTeamId) ?? [];

    if (teamHistory.length >= options.minPriorGames && opponentHistory.length >= options.minPriorGames) {
      rows.push({
        y: game.winner,
        features: strengthFeatures(
          teamHistory.slice(-options.windowSize),
          opponentHistory.slice(-options.windowSize),
        ),
      });
    }

    teamHistory.push(game);
    historyByTeam.set(game.teamId, teamHistory);
  }

  return rows;
}

function historiesBefore(teamGames: TeamGame[], beforeDateMs: number): Map<string, TeamGame[]> {
  const historyByTeam = new Map<string, TeamGame[]>();
  for (const game of teamGames) {
    if (game.dateMs >= beforeDateMs) {
      break;
    }

    const history = historyByTeam.get(game.teamId) ?? [];
    history.push(game);
    historyByTeam.set(game.teamId, history);
  }

  return historyByTeam;
}

function predictGames(
  teamGames: TeamGame[],
  scheduledGames: ScheduledGame[],
  options: Options,
  marketsByKey: Map<string, MarketInput>,
): Prediction[] {
  return scheduledGames.map((game) => {
    const trainRows = buildTrainingRows(teamGames, game.dateMs, options);
    const historyByTeam = historiesBefore(teamGames, game.dateMs);
    const model = trainModel(trainRows, options);
    const homeHistory = historyByTeam.get(game.homeTeamId) ?? [];
    const awayHistory = historyByTeam.get(game.awayTeamId) ?? [];
    const warning =
      homeHistory.length < options.minPriorGames || awayHistory.length < options.minPriorGames
        ? `limited history: ${game.homeTeam} ${homeHistory.length}, ${game.awayTeam} ${awayHistory.length}`
        : null;
    const homeFeatures = strengthFeatures(homeHistory.slice(-options.windowSize), awayHistory.slice(-options.windowSize));
    const rawHomeProbability = scoreFeatures(homeFeatures, model);
    const homeProbability = clampProbability(rawHomeProbability);
    const awayProbability = 1 - homeProbability;
    const homeIsFavorite = homeProbability >= 0.5;
    const favoriteProbability = homeIsFavorite ? homeProbability : awayProbability;
    const marketInput = findMarketInput(game, marketsByKey);
    const market = marketInput ? compareToMarket(game, homeProbability, awayProbability, marketInput) : null;

    return {
      game,
      homeProbability,
      awayProbability,
      favorite: homeIsFavorite ? game.homeTeam : game.awayTeam,
      favoriteProbability,
      confidence: confidenceLabel(favoriteProbability),
      trainRows: trainRows.length,
      warning,
      homeSummary: teamSummary(homeHistory, game.dateMs, options.windowSize),
      awaySummary: teamSummary(awayHistory, game.dateMs, options.windowSize),
      contributions: featureContributions(homeFeatures, model),
      market,
    };
  });
}

function loadMarkets(marketPath: string | null): Map<string, MarketInput> {
  const marketsByKey = new Map<string, MarketInput>();
  if (!marketPath) {
    return marketsByKey;
  }

  const parsed = JSON.parse(readFileSync(marketPath, "utf8")) as unknown;
  const rows = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { games?: unknown }).games)
      ? (parsed as { games: unknown[] }).games
      : null;

  if (!rows) {
    throw new Error("--markets must point to a JSON array or an object with a games array");
  }

  for (const row of rows) {
    if (typeof row !== "object" || row === null) {
      throw new Error("Every market row must be an object");
    }

    const market = normalizeMarketInput(row as Record<string, unknown>);
    for (const key of marketKeys(market)) {
      marketsByKey.set(key, market);
    }
  }

  return marketsByKey;
}

function loadMarketsFromDb(db: Database.Database, bookmaker: string | null): Map<string, MarketInput> {
  const marketsByKey = new Map<string, MarketInput>();
  if (!tableExists(db, "market_line_sync_runs") || !tableExists(db, "market_lines")) {
    return marketsByKey;
  }

  const latestRun = db
    .prepare("SELECT id, finished_at AS finishedAt FROM market_line_sync_runs WHERE status = 'success' ORDER BY id DESC LIMIT 1")
    .get() as { id: number; finishedAt: string | null } | undefined;

  if (!latestRun) {
    return marketsByKey;
  }

  const bookmakerFilter = bookmaker ? normalizeBookmaker(bookmaker) : null;
  const rows = db
    .prepare(
      `
      SELECT
        event_id AS eventId,
        short_name AS shortName,
        home_team AS homeTeam,
        away_team AS awayTeam,
        AVG(home_no_vig_probability) AS homeImpliedProbability,
        AVG(away_no_vig_probability) AS awayImpliedProbability,
        AVG(home_spread) AS homeSpread,
        AVG(away_spread) AS awaySpread,
        CASE WHEN COUNT(*) = 1 THEN MAX(home_moneyline) ELSE NULL END AS homeMoneyline,
        CASE WHEN COUNT(*) = 1 THEN MAX(away_moneyline) ELSE NULL END AS awayMoneyline,
        CASE WHEN COUNT(*) = 1 THEN MAX(bookmaker_title) ELSE 'consensus (' || COUNT(*) || ' books)' END AS book
      FROM market_lines
      WHERE run_id = @runId
        AND (
          @bookmakerFilter IS NULL
          OR lower(replace(replace(replace(bookmaker_key, ' ', ''), '-', ''), '_', '')) = @bookmakerFilter
          OR lower(replace(replace(replace(bookmaker_title, ' ', ''), '-', ''), '_', '')) = @bookmakerFilter
        )
      GROUP BY event_id, short_name, home_team, away_team
      ORDER BY scheduled_date, event_id
    `,
    )
    .all({ runId: latestRun.id, bookmakerFilter }) as Array<Record<string, unknown>>;

  for (const row of rows) {
    const market: MarketInput = {
      eventId: String(row.eventId),
      shortName: String(row.shortName),
      homeTeam: String(row.homeTeam),
      awayTeam: String(row.awayTeam),
      homeImpliedProbability: Number(row.homeImpliedProbability),
      awayImpliedProbability: Number(row.awayImpliedProbability),
      homeSpread: nullableNumber(row.homeSpread),
      awaySpread: nullableNumber(row.awaySpread),
      homeMoneyline: nullableNumber(row.homeMoneyline),
      awayMoneyline: nullableNumber(row.awayMoneyline),
      book: String(row.book),
      note: `SQLite market_line_sync_runs.id=${latestRun.id}${latestRun.finishedAt ? ` finished ${latestRun.finishedAt}` : ""}`,
    };

    for (const key of marketKeys(market)) {
      marketsByKey.set(key, market);
    }
  }

  return marketsByKey;
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(tableName) as { found: number } | undefined;
  return row !== undefined;
}

function normalizeMarketInput(row: Record<string, unknown>): MarketInput {
  return {
    eventId: optionalString(row.eventId),
    game: optionalString(row.game),
    shortName: optionalString(row.shortName),
    homeTeam: optionalString(row.homeTeam),
    awayTeam: optionalString(row.awayTeam),
    homeMoneyline: optionalNumber(row.homeMoneyline),
    awayMoneyline: optionalNumber(row.awayMoneyline),
    homeImpliedProbability: optionalProbability(row.homeImpliedProbability),
    awayImpliedProbability: optionalProbability(row.awayImpliedProbability),
    homeSpread: optionalNumber(row.homeSpread),
    awaySpread: optionalNumber(row.awaySpread),
    book: optionalString(row.book),
    note: optionalString(row.note),
  };
}

function marketKeys(market: MarketInput): string[] {
  const keys = [
    market.eventId ? marketKey(market.eventId) : null,
    market.game ? marketKey(market.game) : null,
    market.shortName ? marketKey(market.shortName) : null,
    market.homeTeam && market.awayTeam ? marketKey(`${market.awayTeam} @ ${market.homeTeam}`) : null,
  ];

  return keys.filter((key): key is string => key !== null);
}

function findMarketInput(game: ScheduledGame, marketsByKey: Map<string, MarketInput>): MarketInput | null {
  return (
    marketsByKey.get(marketKey(game.eventId)) ??
    marketsByKey.get(marketKey(game.shortName)) ??
    marketsByKey.get(marketKey(`${game.awayTeam} @ ${game.homeTeam}`)) ??
    null
  );
}

function compareToMarket(
  game: ScheduledGame,
  homeProbability: number,
  awayProbability: number,
  market: MarketInput,
): MarketComparison {
  const marketProbabilities = marketProbabilitiesFromInput(market);
  const homeEdge = homeProbability - marketProbabilities.home;
  const awayEdge = awayProbability - marketProbabilities.away;
  const homeIsValue = homeEdge >= awayEdge;
  const homeSpread = market.homeSpread ?? (market.awaySpread === undefined ? null : -market.awaySpread);
  const awaySpread = market.awaySpread ?? (market.homeSpread === undefined ? null : -market.homeSpread);

  return {
    homeMarketProbability: marketProbabilities.home,
    awayMarketProbability: marketProbabilities.away,
    homeEdge,
    awayEdge,
    valueSide: homeIsValue ? game.homeTeam : game.awayTeam,
    valueEdge: homeIsValue ? homeEdge : awayEdge,
    homeMoneyline: market.homeMoneyline ?? null,
    awayMoneyline: market.awayMoneyline ?? null,
    homeSpread,
    awaySpread,
    book: market.book ?? null,
    note: market.note ?? null,
  };
}

function marketProbabilitiesFromInput(market: MarketInput): { home: number; away: number } {
  if (market.homeImpliedProbability !== undefined && market.awayImpliedProbability !== undefined) {
    return normalizeTwoWayProbability(market.homeImpliedProbability, market.awayImpliedProbability);
  }

  if (market.homeMoneyline !== undefined && market.awayMoneyline !== undefined) {
    return normalizeTwoWayProbability(
      americanOddsImpliedProbability(market.homeMoneyline),
      americanOddsImpliedProbability(market.awayMoneyline),
    );
  }

  throw new Error(
    "Each market row needs either homeImpliedProbability and awayImpliedProbability, or homeMoneyline and awayMoneyline",
  );
}

function normalizeTwoWayProbability(home: number, away: number): { home: number; away: number } {
  const total = home + away;
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error("Market probabilities must have a positive total");
  }

  return { home: home / total, away: away / total };
}

function americanOddsImpliedProbability(odds: number): number {
  if (!Number.isFinite(odds) || odds === 0) {
    throw new Error(`Invalid American odds: ${odds}`);
  }

  return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
}

function strengthFeatures(teamHistory: TeamGame[], opponentHistory: TeamGame[]): number[] {
  const features: number[] = [];
  for (const statName of STRENGTH_STAT_NAMES) {
    const teamValue = rollingValue(teamHistory, statName);
    const opponentValue = rollingValue(opponentHistory, statName);
    features.push(teamValue, opponentValue, teamValue - opponentValue);
  }

  return features;
}

function rollingValue(history: TeamGame[], statName: string): number {
  if (history.length === 0) {
    return 0;
  }

  if (statName === "winPct") {
    return average(history.map((game) => game.winner));
  }

  return average(history.map((game) => valueForRollingStat(game, statName)));
}

function valueForRollingStat(game: TeamGame, statName: string): number {
  if (statName === "scoreFor") {
    return game.scoreFor;
  }

  if (statName === "scoreAgainst") {
    return game.scoreAgainst;
  }

  if (statName === "margin") {
    return game.scoreFor - game.scoreAgainst;
  }

  return 0;
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

function scoreFeatures(features: number[], model: TrainedModel): number {
  return sigmoid(linearPredict(model.weights, features, model.mean, model.std));
}

function featureContributions(features: number[], model: TrainedModel): Contribution[] {
  return STRENGTH_FEATURE_NAMES.map((feature, index) => {
    const value = features[index] ?? 0;
    const standardized = standardize(value, model.mean[index] ?? 0, model.std[index] ?? 1);
    const weight = model.weights[index + 1] ?? 0;
    return {
      feature,
      value,
      standardized,
      weight,
      contribution: standardized * weight,
    };
  }).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
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

function teamSummary(history: TeamGame[], gameDateMs: number, windowSize: number): TeamSummary {
  const window = history.slice(-windowSize);
  const last5 = history.slice(-5);
  const latest = history.at(-1);

  return {
    games: window.length,
    wins: sum(window.map((game) => game.winner)),
    losses: window.length - sum(window.map((game) => game.winner)),
    winPct: window.length > 0 ? average(window.map((game) => game.winner)) : 0,
    avgFor: window.length > 0 ? average(window.map((game) => game.scoreFor)) : 0,
    avgAgainst: window.length > 0 ? average(window.map((game) => game.scoreAgainst)) : 0,
    avgMargin: window.length > 0 ? average(window.map((game) => game.scoreFor - game.scoreAgainst)) : 0,
    last5Margin: last5.length > 0 ? average(last5.map((game) => game.scoreFor - game.scoreAgainst)) : 0,
    restDays: latest ? Math.max(0, Math.min(14, (gameDateMs - latest.dateMs) / (24 * 60 * 60 * 1000))) : null,
    recentGames: history.slice(-5).reverse().map((game) => ({
      date: game.date,
      opponentTeamId: game.opponentTeamId,
      scoreFor: game.scoreFor,
      scoreAgainst: game.scoreAgainst,
      winner: game.winner,
      home: game.home,
    })),
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function confidenceLabel(favoriteProbability: number): Prediction["confidence"] {
  if (favoriteProbability < 0.55) {
    return "coin flip";
  }

  if (favoriteProbability < 0.65) {
    return "lean";
  }

  return "solid";
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function optionalProbability(value: unknown): number | undefined {
  const parsed = optionalNumber(value);
  if (parsed === undefined) {
    return undefined;
  }

  const probability = parsed > 1 ? parsed / 100 : parsed;
  if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) {
    throw new Error(`Invalid probability: ${value}`);
  }

  return probability;
}

function nullableNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function marketKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeBookmaker(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function formatDate(value: string): string {
  return value.replace(".000Z", "Z");
}

function formatProbability(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value: number, digits = 1): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

function formatSigned(value: number, digits = 1): string {
  if (!Number.isFinite(value)) {
    return "n/a";
  }

  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function formatMoneyline(value: number | null): string {
  if (value === null) {
    return "n/a";
  }

  return value > 0 ? `+${value}` : `${value}`;
}

function formatSpread(value: number | null): string {
  return value === null ? "n/a" : formatSigned(value, 1);
}

function formatEdge(value: number): string {
  return `${formatSigned(value * 100, 1)} pts`;
}

function printPredictions(predictions: Prediction[], options: Options): void {
  console.log(`Model: raw_n${options.windowSize}_strength_core`);
  console.log(`From: ${options.from}`);
  console.log("");
  console.log("date | game | favorite | win% | confidence | value side | edge | home win% | train rows | notes");
  console.log("-".repeat(140));

  for (const prediction of predictions) {
    console.log(
      [
        formatDate(prediction.game.date).padEnd(20),
        prediction.game.shortName.padEnd(10),
        prediction.favorite.padEnd(8),
        formatProbability(prediction.favoriteProbability).padStart(6),
        prediction.confidence.padEnd(9),
        (prediction.market?.valueSide ?? "n/a").padEnd(10),
        (prediction.market ? formatEdge(prediction.market.valueEdge) : "n/a").padStart(8),
        `${prediction.game.homeTeam} ${formatProbability(prediction.homeProbability)}`.padEnd(14),
        prediction.trainRows.toLocaleString().padStart(10),
        prediction.warning ?? "",
      ].join(" | "),
    );
  }
}

function writeHtmlReport(predictions: Prediction[], options: Options): void {
  if (!options.htmlPath) {
    return;
  }

  mkdirSync(path.dirname(options.htmlPath), { recursive: true });
  writeFileSync(options.htmlPath, renderHtmlReport(predictions, options), "utf8");
  console.log("");
  console.log(`Wrote HTML report: ${options.htmlPath}`);
}

function renderHtmlReport(predictions: Prediction[], options: Options): string {
  const solidCount = predictions.filter((prediction) => prediction.confidence === "solid").length;
  const leanCount = predictions.filter((prediction) => prediction.confidence === "lean").length;
  const coinFlipCount = predictions.filter((prediction) => prediction.confidence === "coin flip").length;
  const marketCount = predictions.filter((prediction) => prediction.market !== null).length;
  const generatedAt = new Date().toISOString();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WNBA Upcoming Game Predictions</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #1d252c;
      --muted: #5a6670;
      --line: #d9e0e5;
      --panel: #f7f9fb;
      --accent: #0b6b75;
      --eli5: #284f9f;
      --eli5-bg: #eef4ff;
      --good: #0f7b4f;
      --warn: #996b00;
      --bad: #9d2f3d;
      --wash: #eaf3f4;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      font-family: Arial, Helvetica, sans-serif;
      background: #ffffff;
      line-height: 1.45;
    }
    header, main { max-width: 1180px; margin: 0 auto; padding: 24px; }
    header { border-bottom: 1px solid var(--line); }
    h1 { margin: 0 0 8px; font-size: 30px; letter-spacing: 0; }
    h2 { margin: 32px 0 12px; font-size: 20px; }
    h3 { margin: 0 0 10px; font-size: 16px; }
    p { margin: 6px 0; color: var(--muted); }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 9px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { background: var(--panel); color: #32414a; font-weight: 700; }
    .cards { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin-top: 18px; }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; }
    .metric { font-size: 24px; font-weight: 700; color: var(--accent); }
    .label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
    .game { border: 1px solid var(--line); border-radius: 8px; margin: 18px 0; overflow: hidden; }
    .game-head { display: grid; grid-template-columns: 1.4fr 0.9fr 1fr; gap: 16px; padding: 16px; background: var(--wash); }
    .pick { font-size: 22px; font-weight: 700; color: var(--accent); }
    .badge { display: inline-block; padding: 3px 8px; border-radius: 999px; font-size: 12px; font-weight: 700; }
    .solid { background: #dff2e8; color: var(--good); }
    .lean { background: #fff1cf; color: var(--warn); }
    .coin { background: #f2e4e8; color: var(--bad); }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; padding: 16px; }
    .subpanel { border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
    .small { font-size: 12px; color: var(--muted); }
    .right { text-align: right; }
    .pos { color: var(--good); font-weight: 700; }
    .neg { color: var(--bad); font-weight: 700; }
    .note { background: #fff8e6; border-left: 4px solid #c28a00; padding: 10px 12px; margin: 16px 0; color: #4f3b00; }
    .eli5-box {
      background: var(--eli5-bg);
      border: 1px solid #bfd2ff;
      border-left: 5px solid var(--eli5);
      border-radius: 8px;
      padding: 12px 14px;
      margin: 14px 0;
      color: #203d7a;
    }
    .eli5-title {
      display: block;
      color: var(--eli5);
      font-weight: 700;
      margin-bottom: 4px;
    }
    .eli5-inline {
      display: inline-block;
      background: var(--eli5-bg);
      color: var(--eli5);
      border: 1px solid #bfd2ff;
      border-radius: 6px;
      padding: 2px 6px;
      font-size: 12px;
      font-weight: 700;
    }
    @media (max-width: 820px) {
      .cards, .game-head, .grid2 { grid-template-columns: 1fr; }
      header, main { padding: 16px; }
      table { font-size: 12px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>WNBA Upcoming Game Predictions</h1>
    <p>Generated ${escapeHtml(generatedAt)} from local SQLite data using the raw n=${options.windowSize} strength-core logistic model.</p>
    <div class="cards">
      <div class="card"><div class="label">Games Scored</div><div class="metric">${predictions.length}</div></div>
      <div class="card"><div class="label">Solid Picks</div><div class="metric">${solidCount}</div></div>
      <div class="card"><div class="label">Lean Picks</div><div class="metric">${leanCount}</div></div>
      <div class="card"><div class="label">Coin Flips</div><div class="metric">${coinFlipCount}</div></div>
      <div class="card"><div class="label">Market Lines</div><div class="metric">${marketCount}</div></div>
    </div>
  </header>
  <main>
    <section>
      <h2>Model Context</h2>
      <p>The baseline uses each team's prior ${options.windowSize} regular-season franchise games before tipoff. Features are recent points for, points against, scoring margin, and win percentage for the listed home team versus the away team.</p>
      <p>Historical backtesting put this baseline at 0.6232 log loss versus 0.6931 for random 50/50, about a 10.1% relative improvement. Picks below 55% are marked as coin flips because prior diagnostics showed that low-confidence buckets are noisy.</p>
      <p>When a market file is supplied, value side is calculated as model win probability minus the no-vig market-implied win probability. Listed spreads are market context only; this is not yet a spread-cover model.</p>
      ${options.eli5 ? renderEli5Box("Think of the model as a scorekeeper with a short memory. It looks at how each team has played recently, especially scoring margin and win rate, then converts that into a win chance. It does not know who is hurt or resting.") : ""}
      <div class="note">This model does not train on injuries, player availability, betting markets, travel distance, or lineup strength. Optional market inputs are used only after prediction to compare model probability against market-implied probability. Expansion teams have shorter WNBA histories, so their rolling windows may contain fewer than ${options.windowSize} games.</div>
    </section>

    <section>
      <h2>Prediction Board</h2>
      ${options.eli5 ? renderEli5Box("Read this table as: who the model leans toward, how strong the lean is, and whether the edge is worth trusting. A 51-54% pick is basically a shrug; 65%+ means the recent-team-strength numbers agree more loudly.") : ""}
      ${renderPredictionTable(predictions)}
    </section>

    <section>
      <h2>Game Evidence</h2>
      ${predictions.map((prediction) => renderGameEvidence(prediction, options)).join("\n")}
    </section>
  </main>
</body>
</html>`;
}

function renderPredictionTable(predictions: Prediction[]): string {
  return `<table>
    <thead>
      <tr>
        <th>Date</th>
        <th>Game</th>
        <th>Favorite</th>
        <th>Win %</th>
        <th>Confidence</th>
        <th>Value Side</th>
        <th>Model Edge</th>
        <th>Market Home %</th>
        <th>Home Win %</th>
        <th>Margin Edge</th>
        <th>Win-Rate Edge</th>
      </tr>
    </thead>
    <tbody>
      ${predictions
        .map((prediction) => {
          const marginEdge = prediction.homeSummary.avgMargin - prediction.awaySummary.avgMargin;
          const winRateEdge = prediction.homeSummary.winPct - prediction.awaySummary.winPct;
          return `<tr>
            <td>${escapeHtml(formatDate(prediction.game.date))}</td>
            <td>${escapeHtml(prediction.game.shortName)}</td>
            <td><strong>${escapeHtml(prediction.favorite)}</strong></td>
            <td>${formatProbability(prediction.favoriteProbability)}</td>
            <td>${confidenceBadge(prediction.confidence)}</td>
            <td>${prediction.market ? `<strong>${escapeHtml(prediction.market.valueSide)}</strong>` : "n/a"}</td>
            <td class="${prediction.market && prediction.market.valueEdge >= 0 ? "pos" : "neg"}">${prediction.market ? formatEdge(prediction.market.valueEdge) : "n/a"}</td>
            <td>${prediction.market ? formatProbability(prediction.market.homeMarketProbability) : "n/a"}</td>
            <td>${escapeHtml(prediction.game.homeTeam)} ${formatProbability(prediction.homeProbability)}</td>
            <td class="${marginEdge >= 0 ? "pos" : "neg"}">${formatSigned(marginEdge)}</td>
            <td class="${winRateEdge >= 0 ? "pos" : "neg"}">${formatSigned(winRateEdge * 100, 1)} pct pts</td>
          </tr>`;
        })
        .join("\n")}
    </tbody>
  </table>`;
}

function renderGameEvidence(prediction: Prediction, options: Options): string {
  const marginEdge = prediction.homeSummary.avgMargin - prediction.awaySummary.avgMargin;
  const ppgEdge = prediction.homeSummary.avgFor - prediction.awaySummary.avgFor;
  const defenseEdge = prediction.awaySummary.avgAgainst - prediction.homeSummary.avgAgainst;
  const strongestHome = prediction.contributions.filter((row) => row.contribution > 0).slice(0, 3);
  const strongestAway = prediction.contributions.filter((row) => row.contribution < 0).slice(0, 3);
  const eli5 = options.eli5 ? renderGameEli5(prediction, marginEdge, ppgEdge, defenseEdge) : "";

  return `<article class="game">
    <div class="game-head">
      <div>
        <h3>${escapeHtml(prediction.game.shortName)} <span class="small">${escapeHtml(formatDate(prediction.game.date))}</span></h3>
        <p>${escapeHtml(prediction.game.venueName ?? "Venue unavailable")} ${prediction.game.broadcast ? `- ${escapeHtml(prediction.game.broadcast)}` : ""}</p>
        ${options.eli5 ? `<p><span class="eli5-inline">${escapeHtml(eli5ConfidenceText(prediction))}</span></p>` : ""}
      </div>
      <div>
        <div class="label">Pick</div>
        <div class="pick">${escapeHtml(prediction.favorite)} ${formatProbability(prediction.favoriteProbability)}</div>
        ${confidenceBadge(prediction.confidence)}
      </div>
      <div>
        <div class="label">Home Win Probability</div>
        <div class="metric">${formatProbability(prediction.homeProbability)}</div>
        <p>${escapeHtml(prediction.game.homeTeam)} home row vs ${escapeHtml(prediction.game.awayTeam)} away row</p>
      </div>
    </div>
    <div class="grid2">
      ${renderTeamPanel(prediction.game.awayTeam, prediction.awaySummary)}
      ${renderTeamPanel(prediction.game.homeTeam, prediction.homeSummary)}
    </div>
    ${eli5}
    <div class="grid2">
      <div class="subpanel">
        <h3>Key Edges</h3>
        <table>
          <tbody>
            <tr><td>Home rolling margin edge</td><td class="right ${marginEdge >= 0 ? "pos" : "neg"}">${formatSigned(marginEdge)}</td></tr>
            <tr><td>Home rolling scoring edge</td><td class="right ${ppgEdge >= 0 ? "pos" : "neg"}">${formatSigned(ppgEdge)}</td></tr>
            <tr><td>Home defense edge</td><td class="right ${defenseEdge >= 0 ? "pos" : "neg"}">${formatSigned(defenseEdge)}</td></tr>
            <tr><td>Training team-game rows</td><td class="right">${prediction.trainRows.toLocaleString()}</td></tr>
          </tbody>
        </table>
        ${prediction.market ? renderMarketPanel(prediction) : `<p class="small">No market line supplied for this game.</p>`}
      </div>
      <div class="subpanel">
        <h3>Largest Model Drivers</h3>
        <table>
          <thead><tr><th>Favors Home</th><th class="right">Contribution</th></tr></thead>
          <tbody>${strongestHome.map(renderContributionRow).join("") || `<tr><td colspan="2">None</td></tr>`}</tbody>
        </table>
        <table>
          <thead><tr><th>Favors Away</th><th class="right">Contribution</th></tr></thead>
          <tbody>${strongestAway.map(renderContributionRow).join("") || `<tr><td colspan="2">None</td></tr>`}</tbody>
        </table>
      </div>
    </div>
  </article>`;
}

function renderMarketPanel(prediction: Prediction): string {
  const market = prediction.market;
  if (!market) {
    return "";
  }

  return `<h3>Market Comparison</h3>
        <table>
          <tbody>
            <tr><td>Value side</td><td class="right ${market.valueEdge >= 0 ? "pos" : "neg"}">${escapeHtml(market.valueSide)} ${formatEdge(market.valueEdge)}</td></tr>
            <tr><td>${escapeHtml(prediction.game.homeTeam)} model vs market</td><td class="right ${market.homeEdge >= 0 ? "pos" : "neg"}">${formatProbability(prediction.homeProbability)} vs ${formatProbability(market.homeMarketProbability)} (${formatEdge(market.homeEdge)})</td></tr>
            <tr><td>${escapeHtml(prediction.game.awayTeam)} model vs market</td><td class="right ${market.awayEdge >= 0 ? "pos" : "neg"}">${formatProbability(prediction.awayProbability)} vs ${formatProbability(market.awayMarketProbability)} (${formatEdge(market.awayEdge)})</td></tr>
            <tr><td>Moneyline</td><td class="right">${escapeHtml(prediction.game.awayTeam)} ${formatMoneyline(market.awayMoneyline)} / ${escapeHtml(prediction.game.homeTeam)} ${formatMoneyline(market.homeMoneyline)}</td></tr>
            <tr><td>Spread</td><td class="right">${escapeHtml(prediction.game.awayTeam)} ${formatSpread(market.awaySpread)} / ${escapeHtml(prediction.game.homeTeam)} ${formatSpread(market.homeSpread)}</td></tr>
            ${market.book ? `<tr><td>Book/source</td><td class="right">${escapeHtml(market.book)}</td></tr>` : ""}
            ${market.note ? `<tr><td>Note</td><td class="right">${escapeHtml(market.note)}</td></tr>` : ""}
          </tbody>
        </table>`;
}

function renderEli5Box(text: string): string {
  return `<div class="eli5-box"><span class="eli5-title">ELI5</span>${escapeHtml(text)}</div>`;
}

function renderGameEli5(prediction: Prediction, marginEdge: number, ppgEdge: number, defenseEdge: number): string {
  const favoriteSide = prediction.favorite === prediction.game.homeTeam ? "home team" : "away team";
  const confidenceText =
    prediction.confidence === "coin flip"
      ? "This is close enough that the model is not saying much more than 'maybe.'"
      : prediction.confidence === "lean"
        ? "This is a real lean, but not a slam-dunk pick."
        : "This is one of the model's clearer picks on this slate.";
  const edgeText = [
    Math.abs(marginEdge) >= 3
      ? `The home team has a ${formatSigned(marginEdge)} recent margin edge.`
      : "Recent margin is fairly close.",
    Math.abs(ppgEdge) >= 3
      ? `The home team scores ${formatSigned(ppgEdge)} more points per game in this window.`
      : "Recent scoring volume is not a huge separator.",
    Math.abs(defenseEdge) >= 3
      ? `The home team's defense has a ${formatSigned(defenseEdge)} points-allowed edge.`
      : "Recent defense is not a huge separator.",
  ].join(" ");

  return renderEli5Box(
    `${prediction.favorite} is the pick because the model gives the ${favoriteSide} side of this matchup ${formatProbability(
      prediction.favoriteProbability,
    )}. ${confidenceText} ${edgeText}`,
  );
}

function eli5ConfidenceText(prediction: Prediction): string {
  if (prediction.confidence === "coin flip") {
    return "Treat as a toss-up";
  }

  if (prediction.confidence === "lean") {
    return "Model leans this way";
  }

  return "One of the clearer model edges";
}

function renderTeamPanel(label: string, summary: TeamSummary): string {
  return `<div class="subpanel">
    <h3>${escapeHtml(label)} Rolling Form</h3>
    <table>
      <tbody>
        <tr><td>Window record</td><td class="right">${summary.wins}-${summary.losses} in ${summary.games} games</td></tr>
        <tr><td>Win percentage</td><td class="right">${formatProbability(summary.winPct)}</td></tr>
        <tr><td>Points for / against</td><td class="right">${formatNumber(summary.avgFor)} / ${formatNumber(summary.avgAgainst)}</td></tr>
        <tr><td>Avg margin</td><td class="right ${summary.avgMargin >= 0 ? "pos" : "neg"}">${formatSigned(summary.avgMargin)}</td></tr>
        <tr><td>Last 5 margin</td><td class="right ${summary.last5Margin >= 0 ? "pos" : "neg"}">${formatSigned(summary.last5Margin)}</td></tr>
        <tr><td>Rest days</td><td class="right">${summary.restDays === null ? "n/a" : formatNumber(summary.restDays, 1)}</td></tr>
      </tbody>
    </table>
    <p class="small">Recent games: ${summary.recentGames.map(formatRecentGame).join("; ") || "none"}</p>
  </div>`;
}

function renderContributionRow(row: Contribution): string {
  return `<tr>
    <td>${escapeHtml(row.feature)} <span class="small">value ${formatNumber(row.value, 2)}</span></td>
    <td class="right ${row.contribution >= 0 ? "pos" : "neg"}">${formatSigned(row.contribution, 3)}</td>
  </tr>`;
}

function formatRecentGame(game: TeamSummary["recentGames"][number]): string {
  const result = game.winner === 1 ? "W" : "L";
  const venue = game.home === 1 ? "home" : "away";
  return `${formatDate(game.date).slice(5, 10)} ${result} ${game.scoreFor}-${game.scoreAgainst} ${venue}`;
}

function confidenceBadge(confidence: Prediction["confidence"]): string {
  const className = confidence === "solid" ? "solid" : confidence === "lean" ? "lean" : "coin";
  return `<span class="badge ${className}">${escapeHtml(confidence)}</span>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const db = new Database(options.dbPath, { readonly: true, fileMustExist: true });

  try {
    const teamGames = loadTeamGames(db);
    const scheduledGames = loadScheduledGames(db, options.from, options.limit);
    const marketsByKey = options.marketsDb ? loadMarketsFromDb(db, options.marketBookmaker) : loadMarkets(options.marketPath);
    if (scheduledGames.length === 0) {
      console.log(`No upcoming ESPN schedule games found from ${options.from}`);
      return;
    }

    const predictions = predictGames(teamGames, scheduledGames, options, marketsByKey);
    printPredictions(predictions, options);
    writeHtmlReport(predictions, options);
  } finally {
    db.close();
  }
}

main();
