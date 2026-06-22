import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Options = {
  sourceRoot: string;
  dbPath: string;
  prune: boolean;
  dryRun: boolean;
  storeRawContent: boolean;
};

type SourceFile = {
  absolutePath: string;
  relativePath: string;
  dataset: string;
  extension: string;
  size: number;
  mtimeMs: number;
  inferredYear: number | null;
  inferredEntityId: string | null;
};

type LoadedSourceFile = SourceFile & {
  sha256: string;
  contentText: string | null;
  contentBlob: Buffer | null;
  jsonValid: 0 | 1 | null;
};

type JsonRecord = Record<string, unknown>;

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SOURCE_ROOT = "C:\\Users\\jkram\\github\\wehoop-wnba-raw";
const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, "wnba_raw.sqlite");
const SYNCED_EXTENSIONS = new Set([".json", ".parquet", ".rds"]);

function parseArgs(argv: string[]): Options {
  const options: Options = {
    sourceRoot: process.env.WNBA_RAW_ROOT ?? DEFAULT_SOURCE_ROOT,
    dbPath: process.env.WNBA_RAW_DB ?? DEFAULT_DB_PATH,
    prune: false,
    dryRun: false,
    storeRawContent: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--source" && next) {
      options.sourceRoot = next;
      i += 1;
    } else if (arg === "--db" && next) {
      options.dbPath = path.resolve(next);
      i += 1;
    } else if (arg === "--prune") {
      options.prune = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--store-raw-content") {
      options.storeRawContent = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  options.sourceRoot = path.resolve(options.sourceRoot);
  options.dbPath = path.resolve(options.dbPath);
  return options;
}

function printHelp(): void {
  console.log(`Usage: npm run sync:raw -- [options]

Options:
  --source <path>  wehoop-wnba-raw checkout. Defaults to ${DEFAULT_SOURCE_ROOT}
  --db <path>      SQLite database path. Defaults to ${DEFAULT_DB_PATH}
  --prune          Delete database rows for source files that no longer exist.
  --dry-run        Scan and report changes without writing to SQLite.
  --store-raw-content
                  Store JSON text and parquet/RDS blobs in raw_files. Off by default.
  -h, --help       Show this help text.
`);
}

function ensureSchema(db: Database.Database): void {
  db.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_root TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      files_seen INTEGER NOT NULL DEFAULT 0,
      files_inserted INTEGER NOT NULL DEFAULT 0,
      files_updated INTEGER NOT NULL DEFAULT 0,
      files_unchanged INTEGER NOT NULL DEFAULT 0,
      files_pruned INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS raw_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dataset TEXT NOT NULL,
      relative_path TEXT NOT NULL UNIQUE,
      extension TEXT NOT NULL,
      source_path TEXT NOT NULL,
      source_size INTEGER NOT NULL,
      source_mtime_ms REAL NOT NULL,
      sha256 TEXT NOT NULL,
      content_text TEXT,
      content_blob BLOB,
      json_valid INTEGER,
      inferred_year INTEGER,
      inferred_entity_id TEXT,
      first_synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_raw_files_dataset ON raw_files(dataset);
    CREATE INDEX IF NOT EXISTS idx_raw_files_extension ON raw_files(extension);
    CREATE INDEX IF NOT EXISTS idx_raw_files_inferred_year ON raw_files(inferred_year);
    CREATE INDEX IF NOT EXISTS idx_raw_files_inferred_entity_id ON raw_files(inferred_entity_id);
    CREATE INDEX IF NOT EXISTS idx_raw_files_sha256 ON raw_files(sha256);

    CREATE TABLE IF NOT EXISTS teams (
      team_id TEXT PRIMARY KEY,
      uid TEXT,
      slug TEXT,
      abbreviation TEXT,
      location TEXT,
      name TEXT,
      display_name TEXT,
      short_display_name TEXT,
      color TEXT,
      alternate_color TEXT,
      logo TEXT,
      raw_json TEXT,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS athletes (
      athlete_id TEXT PRIMARY KEY,
      uid TEXT,
      guid TEXT,
      display_name TEXT,
      short_name TEXT,
      first_name TEXT,
      last_name TEXT,
      position_name TEXT,
      position_abbreviation TEXT,
      raw_json TEXT,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS games (
      game_id TEXT PRIMARY KEY,
      uid TEXT,
      season_year INTEGER,
      season_type INTEGER,
      name TEXT,
      short_name TEXT,
      date TEXT,
      status_type TEXT,
      status_state TEXT,
      completed INTEGER,
      neutral_site INTEGER,
      conference_competition INTEGER,
      venue_id TEXT,
      venue_name TEXT,
      source_relative_path TEXT NOT NULL,
      raw_header_json TEXT,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS game_competitors (
      game_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      home_away TEXT,
      score REAL,
      winner INTEGER,
      seed INTEGER,
      records_json TEXT,
      linescores_json TEXT,
      raw_json TEXT,
      PRIMARY KEY (game_id, team_id)
    );

    CREATE TABLE IF NOT EXISTS game_team_box_stats (
      game_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      stat_name TEXT NOT NULL,
      display_name TEXT,
      abbreviation TEXT,
      value REAL,
      display_value TEXT,
      raw_json TEXT,
      PRIMARY KEY (game_id, team_id, stat_name)
    );

    CREATE TABLE IF NOT EXISTS game_player_box_stats (
      game_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      athlete_id TEXT NOT NULL,
      category_name TEXT NOT NULL,
      stat_key TEXT NOT NULL,
      stat_label TEXT,
      stat_description TEXT,
      stat_value TEXT,
      starter INTEGER,
      did_not_play INTEGER,
      ejected INTEGER,
      active INTEGER,
      raw_athlete_json TEXT,
      PRIMARY KEY (game_id, team_id, athlete_id, category_name, stat_key)
    );

    CREATE TABLE IF NOT EXISTS game_plays (
      source_relative_path TEXT NOT NULL,
      play_id TEXT NOT NULL,
      game_id TEXT,
      sequence_number INTEGER,
      period INTEGER,
      clock_display TEXT,
      home_score INTEGER,
      away_score INTEGER,
      team_id TEXT,
      scoring_play INTEGER,
      shooting_play INTEGER,
      score_value INTEGER,
      text TEXT,
      raw_json TEXT NOT NULL,
      PRIMARY KEY (source_relative_path, play_id)
    );

    CREATE TABLE IF NOT EXISTS team_season_stats (
      requested_season INTEGER NOT NULL,
      team_id TEXT NOT NULL,
      category_name TEXT NOT NULL,
      stat_name TEXT NOT NULL,
      display_name TEXT,
      abbreviation TEXT,
      value REAL,
      display_value TEXT,
      per_game_value REAL,
      per_game_display_value TEXT,
      raw_json TEXT,
      PRIMARY KEY (requested_season, team_id, category_name, stat_name)
    );

    CREATE TABLE IF NOT EXISTS player_season_stats (
      requested_season INTEGER NOT NULL,
      athlete_id TEXT NOT NULL,
      category_name TEXT NOT NULL,
      row_season_year INTEGER NOT NULL,
      team_id TEXT,
      team_slug TEXT,
      position TEXT,
      stat_key TEXT NOT NULL,
      stat_label TEXT,
      stat_display_name TEXT,
      stat_description TEXT,
      stat_value TEXT,
      PRIMARY KEY (requested_season, athlete_id, category_name, row_season_year, team_id, stat_key)
    );

    CREATE TABLE IF NOT EXISTS draft_picks (
      draft_year INTEGER NOT NULL,
      pick_id TEXT NOT NULL,
      round_number INTEGER,
      overall_pick_number INTEGER,
      round_pick_number INTEGER,
      team_id TEXT,
      athlete_id TEXT,
      athlete_display_name TEXT,
      position_name TEXT,
      position_abbreviation TEXT,
      raw_json TEXT,
      PRIMARY KEY (draft_year, pick_id)
    );

    CREATE INDEX IF NOT EXISTS idx_games_season_year ON games(season_year);
    CREATE INDEX IF NOT EXISTS idx_game_plays_game_id ON game_plays(game_id);
    CREATE INDEX IF NOT EXISTS idx_game_player_box_stats_athlete ON game_player_box_stats(athlete_id);
    CREATE INDEX IF NOT EXISTS idx_player_season_stats_athlete ON player_season_stats(athlete_id);
  `);
}

function* walkFiles(root: string): Generator<string> {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(absolutePath);
    } else if (entry.isFile()) {
      yield absolutePath;
    }
  }
}

function discoverFiles(sourceRoot: string): SourceFile[] {
  const wnbaRoot = path.join(sourceRoot, "wnba");
  if (!existsSync(wnbaRoot)) {
    throw new Error(`Expected a wnba directory under source root: ${wnbaRoot}`);
  }

  const files: SourceFile[] = [];
  for (const absolutePath of walkFiles(wnbaRoot)) {
    const extension = path.extname(absolutePath).toLowerCase();
    if (!SYNCED_EXTENSIONS.has(extension)) {
      continue;
    }

    const stat = statSync(absolutePath);
    const relativePath = normalizeRelativePath(path.relative(sourceRoot, absolutePath));
    const pathParts = relativePath.split("/");
    const inferredYear = inferYear(pathParts);

    files.push({
      absolutePath,
      relativePath,
      dataset: inferDataset(pathParts),
      extension: extension.slice(1),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      inferredYear,
      inferredEntityId: path.basename(absolutePath, extension),
    });
  }

  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function loadSourceFile(file: SourceFile, storeRawContent: boolean): LoadedSourceFile {
  const content = readFileSync(file.absolutePath);
  const contentText = storeRawContent && file.extension === "json" ? content.toString("utf8") : null;

  return {
    ...file,
    sha256: createHash("sha256").update(content).digest("hex"),
    contentText,
    contentBlob: storeRawContent && file.extension !== "json" ? content : null,
    jsonValid: contentText === null ? null : isValidJson(contentText),
  };
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

function isValidJson(value: string | null): 0 | 1 {
  if (value === null) {
    return 0;
  }

  try {
    JSON.parse(value);
    return 1;
  } catch {
    return 0;
  }
}

function inferDataset(pathParts: string[]): string {
  if (pathParts.length >= 3 && pathParts[0] === "wnba") {
    return pathParts[1];
  }

  const filename = pathParts.at(-1) ?? "unknown";
  return filename.replace(/\.[^.]+$/, "");
}

function inferYear(pathParts: string[]): number | null {
  for (const part of pathParts) {
    if (/^(19|20)\d{2}$/.test(part)) {
      return Number(part);
    }
  }

  const filename = pathParts.at(-1) ?? "";
  const yearMatch = filename.match(/(19|20)\d{2}/);
  return yearMatch ? Number(yearMatch[0]) : null;
}

function refreshExtractedTables(db: Database.Database, files: SourceFile[]): void {
  const statements = buildExtractionStatements(db);

  db.exec(`
    DELETE FROM draft_picks;
    DELETE FROM player_season_stats;
    DELETE FROM team_season_stats;
    DELETE FROM game_plays;
    DELETE FROM game_player_box_stats;
    DELETE FROM game_team_box_stats;
    DELETE FROM game_competitors;
    DELETE FROM games;
    DELETE FROM athletes;
    DELETE FROM teams;
  `);

  for (const file of files) {
    if (file.extension !== "json") {
      continue;
    }

    const contentText = readFileSync(file.absolutePath, "utf8");
    if (isValidJson(contentText) !== 1) {
      continue;
    }

    const loadedFile: LoadedSourceFile = {
      ...file,
      sha256: "",
      contentText,
      contentBlob: null,
      jsonValid: 1,
    };
    const json = JSON.parse(contentText) as JsonRecord;
    extractGameDocument(statements, loadedFile, json);
    extractTeamSeasonStats(statements, loadedFile, json);
    extractPlayerSeasonStats(statements, loadedFile, json);
    extractDraft(statements, loadedFile, json);
  }
}

function buildExtractionStatements(db: Database.Database) {
  return {
    team: db.prepare(`
      INSERT INTO teams (
        team_id, uid, slug, abbreviation, location, name, display_name,
        short_display_name, color, alternate_color, logo, raw_json, last_seen_at
      )
      VALUES (
        @teamId, @uid, @slug, @abbreviation, @location, @name, @displayName,
        @shortDisplayName, @color, @alternateColor, @logo, @rawJson, CURRENT_TIMESTAMP
      )
      ON CONFLICT(team_id) DO UPDATE SET
        uid = COALESCE(excluded.uid, teams.uid),
        slug = COALESCE(excluded.slug, teams.slug),
        abbreviation = COALESCE(excluded.abbreviation, teams.abbreviation),
        location = COALESCE(excluded.location, teams.location),
        name = COALESCE(excluded.name, teams.name),
        display_name = COALESCE(excluded.display_name, teams.display_name),
        short_display_name = COALESCE(excluded.short_display_name, teams.short_display_name),
        color = COALESCE(excluded.color, teams.color),
        alternate_color = COALESCE(excluded.alternate_color, teams.alternate_color),
        logo = COALESCE(excluded.logo, teams.logo),
        raw_json = COALESCE(excluded.raw_json, teams.raw_json),
        last_seen_at = CURRENT_TIMESTAMP
    `),
    athlete: db.prepare(`
      INSERT INTO athletes (
        athlete_id, uid, guid, display_name, short_name, first_name, last_name,
        position_name, position_abbreviation, raw_json, last_seen_at
      )
      VALUES (
        @athleteId, @uid, @guid, @displayName, @shortName, @firstName, @lastName,
        @positionName, @positionAbbreviation, @rawJson, CURRENT_TIMESTAMP
      )
      ON CONFLICT(athlete_id) DO UPDATE SET
        uid = COALESCE(excluded.uid, athletes.uid),
        guid = COALESCE(excluded.guid, athletes.guid),
        display_name = COALESCE(excluded.display_name, athletes.display_name),
        short_name = COALESCE(excluded.short_name, athletes.short_name),
        first_name = COALESCE(excluded.first_name, athletes.first_name),
        last_name = COALESCE(excluded.last_name, athletes.last_name),
        position_name = COALESCE(excluded.position_name, athletes.position_name),
        position_abbreviation = COALESCE(excluded.position_abbreviation, athletes.position_abbreviation),
        raw_json = COALESCE(excluded.raw_json, athletes.raw_json),
        last_seen_at = CURRENT_TIMESTAMP
    `),
    game: db.prepare(`
      INSERT INTO games (
        game_id, uid, season_year, season_type, name, short_name, date,
        status_type, status_state, completed, neutral_site, conference_competition,
        venue_id, venue_name, source_relative_path, raw_header_json, last_seen_at
      )
      VALUES (
        @gameId, @uid, @seasonYear, @seasonType, @name, @shortName, @date,
        @statusType, @statusState, @completed, @neutralSite, @conferenceCompetition,
        @venueId, @venueName, @sourceRelativePath, @rawHeaderJson, CURRENT_TIMESTAMP
      )
      ON CONFLICT(game_id) DO UPDATE SET
        uid = COALESCE(excluded.uid, games.uid),
        season_year = COALESCE(excluded.season_year, games.season_year),
        season_type = COALESCE(excluded.season_type, games.season_type),
        name = COALESCE(excluded.name, games.name),
        short_name = COALESCE(excluded.short_name, games.short_name),
        date = COALESCE(excluded.date, games.date),
        status_type = COALESCE(excluded.status_type, games.status_type),
        status_state = COALESCE(excluded.status_state, games.status_state),
        completed = COALESCE(excluded.completed, games.completed),
        neutral_site = COALESCE(excluded.neutral_site, games.neutral_site),
        conference_competition = COALESCE(excluded.conference_competition, games.conference_competition),
        venue_id = COALESCE(excluded.venue_id, games.venue_id),
        venue_name = COALESCE(excluded.venue_name, games.venue_name),
        source_relative_path = excluded.source_relative_path,
        raw_header_json = COALESCE(excluded.raw_header_json, games.raw_header_json),
        last_seen_at = CURRENT_TIMESTAMP
    `),
    gameCompetitor: db.prepare(`
      INSERT OR REPLACE INTO game_competitors (
        game_id, team_id, home_away, score, winner, seed, records_json, linescores_json, raw_json
      )
      VALUES (@gameId, @teamId, @homeAway, @score, @winner, @seed, @recordsJson, @linescoresJson, @rawJson)
    `),
    gameTeamBoxStat: db.prepare(`
      INSERT OR REPLACE INTO game_team_box_stats (
        game_id, team_id, stat_name, display_name, abbreviation, value, display_value, raw_json
      )
      VALUES (@gameId, @teamId, @statName, @displayName, @abbreviation, @value, @displayValue, @rawJson)
    `),
    gamePlayerBoxStat: db.prepare(`
      INSERT OR REPLACE INTO game_player_box_stats (
        game_id, team_id, athlete_id, category_name, stat_key, stat_label, stat_description,
        stat_value, starter, did_not_play, ejected, active, raw_athlete_json
      )
      VALUES (
        @gameId, @teamId, @athleteId, @categoryName, @statKey, @statLabel, @statDescription,
        @statValue, @starter, @didNotPlay, @ejected, @active, @rawAthleteJson
      )
    `),
    gamePlay: db.prepare(`
      INSERT OR REPLACE INTO game_plays (
        source_relative_path, play_id, game_id, sequence_number, period, clock_display,
        home_score, away_score, team_id, scoring_play, shooting_play, score_value, text, raw_json
      )
      VALUES (
        @sourceRelativePath, @playId, @gameId, @sequenceNumber, @period, @clockDisplay,
        @homeScore, @awayScore, @teamId, @scoringPlay, @shootingPlay, @scoreValue, @text, @rawJson
      )
    `),
    teamSeasonStat: db.prepare(`
      INSERT OR REPLACE INTO team_season_stats (
        requested_season, team_id, category_name, stat_name, display_name, abbreviation,
        value, display_value, per_game_value, per_game_display_value, raw_json
      )
      VALUES (
        @requestedSeason, @teamId, @categoryName, @statName, @displayName, @abbreviation,
        @value, @displayValue, @perGameValue, @perGameDisplayValue, @rawJson
      )
    `),
    playerSeasonStat: db.prepare(`
      INSERT OR REPLACE INTO player_season_stats (
        requested_season, athlete_id, category_name, row_season_year, team_id, team_slug, position,
        stat_key, stat_label, stat_display_name, stat_description, stat_value
      )
      VALUES (
        @requestedSeason, @athleteId, @categoryName, @rowSeasonYear, @teamId, @teamSlug, @position,
        @statKey, @statLabel, @statDisplayName, @statDescription, @statValue
      )
    `),
    draftPick: db.prepare(`
      INSERT OR REPLACE INTO draft_picks (
        draft_year, pick_id, round_number, overall_pick_number, round_pick_number, team_id,
        athlete_id, athlete_display_name, position_name, position_abbreviation, raw_json
      )
      VALUES (
        @draftYear, @pickId, @roundNumber, @overallPickNumber, @roundPickNumber, @teamId,
        @athleteId, @athleteDisplayName, @positionName, @positionAbbreviation, @rawJson
      )
    `),
  };
}

type ExtractionStatements = ReturnType<typeof buildExtractionStatements>;

function extractGameDocument(statements: ExtractionStatements, file: LoadedSourceFile, json: JsonRecord): void {
  const header = asRecord(json.header);
  const competitions = asArray(header?.competitions);
  const competition = asRecord(competitions[0]);
  const gameId = toText(json.gameId) ?? toText(header?.id) ?? toText(competition?.id) ?? file.inferredEntityId;
  if (!gameId || !header || !competition) {
    return;
  }

  const season = asRecord(json.season) ?? asRecord(header.season);
  const status = asRecord(competition.status);
  const statusType = asRecord(status?.type);
  const venue = asRecord(competition.venue);

  statements.game.run({
    gameId,
    uid: toText(header.uid) ?? toText(competition.uid),
    seasonYear: toInteger(season?.year),
    seasonType: toInteger(season?.type),
    name: toText(competition.name),
    shortName: toText(competition.shortName),
    date: toText(competition.date),
    statusType: toText(statusType?.name) ?? toText(statusType?.type),
    statusState: toText(statusType?.state),
    completed: toBooleanInteger(statusType?.completed),
    neutralSite: toBooleanInteger(competition.neutralSite),
    conferenceCompetition: toBooleanInteger(competition.conferenceCompetition),
    venueId: toText(venue?.id),
    venueName: toText(venue?.fullName) ?? toText(venue?.name),
    sourceRelativePath: file.relativePath,
    rawHeaderJson: JSON.stringify(header),
  });

  for (const competitor of asArray(competition.competitors)) {
    const competitorRecord = asRecord(competitor);
    const team = asRecord(competitorRecord?.team);
    const teamId = toText(team?.id) ?? toText(competitorRecord?.id);
    if (!competitorRecord || !teamId) {
      continue;
    }
    upsertTeam(statements, team);
    statements.gameCompetitor.run({
      gameId,
      teamId,
      homeAway: toText(competitorRecord.homeAway),
      score: toNumber(competitorRecord.score),
      winner: toBooleanInteger(competitorRecord.winner),
      seed: toInteger(competitorRecord.curatedRank),
      recordsJson: stringifyNullable(competitorRecord.records),
      linescoresJson: stringifyNullable(competitorRecord.linescores),
      rawJson: JSON.stringify(competitorRecord),
    });
  }

  const boxscore = asRecord(json.boxscore);
  for (const teamBox of asArray(boxscore?.teams)) {
    const teamBoxRecord = asRecord(teamBox);
    const team = asRecord(teamBoxRecord?.team);
    const teamId = toText(team?.id);
    if (!teamBoxRecord || !teamId) {
      continue;
    }
    upsertTeam(statements, team);
    for (const stat of asArray(teamBoxRecord.statistics)) {
      const statRecord = asRecord(stat);
      const statName = toText(statRecord?.name);
      if (!statRecord || !statName) {
        continue;
      }
      statements.gameTeamBoxStat.run({
        gameId,
        teamId,
        statName,
        displayName: toText(statRecord.displayName),
        abbreviation: toText(statRecord.abbreviation),
        value: toNumber(statRecord.value),
        displayValue: toText(statRecord.displayValue),
        rawJson: JSON.stringify(statRecord),
      });
    }
  }

  for (const playerTeam of asArray(boxscore?.players)) {
    const playerTeamRecord = asRecord(playerTeam);
    const team = asRecord(playerTeamRecord?.team);
    const teamId = toText(team?.id);
    if (!playerTeamRecord || !teamId) {
      continue;
    }
    upsertTeam(statements, team);
    for (const category of asArray(playerTeamRecord.statistics)) {
      const categoryRecord = asRecord(category);
      const categoryName = toText(categoryRecord?.name) ?? "boxscore";
      const keys = asArray(categoryRecord?.keys).map(toText);
      const labels = asArray(categoryRecord?.labels).map(toText);
      const descriptions = asArray(categoryRecord?.descriptions).map(toText);

      for (const athleteRow of asArray(categoryRecord?.athletes)) {
        const athleteRowRecord = asRecord(athleteRow);
        const athlete = asRecord(athleteRowRecord?.athlete);
        const athleteId = toText(athlete?.id);
        if (!athleteRowRecord || !athlete || !athleteId) {
          continue;
        }
        upsertAthlete(statements, athlete);

        const values = asArray(athleteRowRecord.stats).map(toText);
        for (let index = 0; index < values.length; index += 1) {
          const statKey = keys[index] ?? labels[index] ?? `stat_${index + 1}`;
          statements.gamePlayerBoxStat.run({
            gameId,
            teamId,
            athleteId,
            categoryName,
            statKey,
            statLabel: labels[index] ?? null,
            statDescription: descriptions[index] ?? null,
            statValue: values[index],
            starter: toBooleanInteger(athleteRowRecord.starter),
            didNotPlay: toBooleanInteger(athleteRowRecord.didNotPlay),
            ejected: toBooleanInteger(athleteRowRecord.ejected),
            active: toBooleanInteger(athleteRowRecord.active),
            rawAthleteJson: JSON.stringify(athleteRowRecord),
          });
        }
      }
    }
  }

  for (const play of asArray(json.plays)) {
    const playRecord = asRecord(play);
    const playId = toText(playRecord?.id);
    if (!playRecord || !playId) {
      continue;
    }
    statements.gamePlay.run({
      sourceRelativePath: file.relativePath,
      playId,
      gameId,
      sequenceNumber: toInteger(playRecord.sequenceNumber),
      period: toInteger(playRecord["period.number"]) ?? toInteger(asRecord(playRecord.period)?.number) ?? toInteger(playRecord.period),
      clockDisplay: toText(playRecord["clock.displayValue"]) ?? toText(asRecord(playRecord.clock)?.displayValue),
      homeScore: toInteger(playRecord.homeScore),
      awayScore: toInteger(playRecord.awayScore),
      teamId: toText(playRecord["team.id"]) ?? toText(asRecord(playRecord.team)?.id),
      scoringPlay: toBooleanInteger(playRecord.scoringPlay),
      shootingPlay: toBooleanInteger(playRecord.shootingPlay),
      scoreValue: toInteger(playRecord.scoreValue),
      text: toText(playRecord.text),
      rawJson: JSON.stringify(playRecord),
    });
  }
}

function extractTeamSeasonStats(statements: ExtractionStatements, file: LoadedSourceFile, json: JsonRecord): void {
  if (file.dataset !== "team_stats") {
    return;
  }

  const team = asRecord(json.team);
  const teamId = toText(team?.id) ?? file.inferredEntityId;
  const requestedSeason = toInteger(json.requestedSeason) ?? file.inferredYear;
  if (!teamId || !requestedSeason) {
    return;
  }

  upsertTeam(statements, team);
  const categories = asArray(asRecord(asRecord(json.results)?.stats)?.categories);
  for (const category of categories) {
    const categoryRecord = asRecord(category);
    const categoryName = toText(categoryRecord?.name) ?? "stats";
    for (const stat of asArray(categoryRecord?.stats)) {
      const statRecord = asRecord(stat);
      const statName = toText(statRecord?.name);
      if (!statRecord || !statName) {
        continue;
      }
      statements.teamSeasonStat.run({
        requestedSeason,
        teamId,
        categoryName,
        statName,
        displayName: toText(statRecord.displayName),
        abbreviation: toText(statRecord.abbreviation),
        value: toNumber(statRecord.value),
        displayValue: toText(statRecord.displayValue),
        perGameValue: toNumber(statRecord.perGameValue),
        perGameDisplayValue: toText(statRecord.perGameDisplayValue),
        rawJson: JSON.stringify(statRecord),
      });
    }
  }
}

function extractPlayerSeasonStats(statements: ExtractionStatements, file: LoadedSourceFile, json: JsonRecord): void {
  if (file.dataset !== "player_season_stats") {
    return;
  }

  const athleteId = file.inferredEntityId;
  const requestedSeason = file.inferredYear;
  if (!athleteId || !requestedSeason) {
    return;
  }

  for (const category of asArray(json.categories)) {
    const categoryRecord = asRecord(category);
    const categoryName = toText(categoryRecord?.name) ?? "stats";
    const keys = asArray(categoryRecord?.names).map(toText);
    const labels = asArray(categoryRecord?.labels).map(toText);
    const displayNames = asArray(categoryRecord?.displayNames).map(toText);
    const descriptions = asArray(categoryRecord?.descriptions).map(toText);

    for (const statRow of asArray(categoryRecord?.statistics)) {
      const statRowRecord = asRecord(statRow);
      const rowSeasonYear = toInteger(asRecord(statRowRecord?.season)?.year);
      if (!statRowRecord || !rowSeasonYear) {
        continue;
      }

      const values = asArray(statRowRecord.stats).map(toText);
      for (let index = 0; index < values.length; index += 1) {
        const statKey = keys[index] ?? labels[index] ?? `stat_${index + 1}`;
        statements.playerSeasonStat.run({
          requestedSeason,
          athleteId,
          categoryName,
          rowSeasonYear,
          teamId: toText(statRowRecord.teamId),
          teamSlug: toText(statRowRecord.teamSlug),
          position: toText(statRowRecord.position),
          statKey,
          statLabel: labels[index] ?? null,
          statDisplayName: displayNames[index] ?? null,
          statDescription: descriptions[index] ?? null,
          statValue: values[index],
        });
      }
    }
  }
}

function extractDraft(statements: ExtractionStatements, file: LoadedSourceFile, json: JsonRecord): void {
  if (file.dataset !== "draft") {
    return;
  }

  const draftYear = toInteger(json.year) ?? file.inferredYear;
  if (!draftYear) {
    return;
  }

  for (const team of asArray(json.teams)) {
    upsertTeam(statements, asRecord(team));
  }

  for (const pick of asArray(json.picks)) {
    const pickRecord = asRecord(pick);
    const pickId = toText(pickRecord?.id) ?? `${draftYear}-${toText(pickRecord?.overall) ?? toText(pickRecord?.pick)}`;
    if (!pickRecord || !pickId) {
      continue;
    }

    const team = asRecord(pickRecord.team);
    const athlete = asRecord(pickRecord.athlete);
    const position = asRecord(athlete?.position) ?? asRecord(pickRecord.position);
    upsertTeam(statements, team);
    upsertAthlete(statements, athlete);

    statements.draftPick.run({
      draftYear,
      pickId,
      roundNumber: toInteger(pickRecord.round),
      overallPickNumber: toInteger(pickRecord.overall) ?? toInteger(pickRecord.overallPickNumber),
      roundPickNumber: toInteger(pickRecord.pick) ?? toInteger(pickRecord.roundPickNumber),
      teamId: toText(team?.id),
      athleteId: toText(athlete?.id),
      athleteDisplayName: toText(athlete?.displayName) ?? toText(pickRecord.displayName),
      positionName: toText(position?.name) ?? toText(position?.displayName),
      positionAbbreviation: toText(position?.abbreviation),
      rawJson: JSON.stringify(pickRecord),
    });
  }
}

function upsertTeam(statements: ExtractionStatements, team: JsonRecord | null | undefined): void {
  const teamId = toText(team?.id);
  if (!team || !teamId) {
    return;
  }

  statements.team.run({
    teamId,
    uid: toText(team.uid),
    slug: toText(team.slug),
    abbreviation: toText(team.abbreviation),
    location: toText(team.location),
    name: toText(team.name),
    displayName: toText(team.displayName),
    shortDisplayName: toText(team.shortDisplayName),
    color: toText(team.color),
    alternateColor: toText(team.alternateColor),
    logo: toText(team.logo),
    rawJson: JSON.stringify(team),
  });
}

function upsertAthlete(statements: ExtractionStatements, athlete: JsonRecord | null | undefined): void {
  const athleteId = toText(athlete?.id);
  if (!athlete || !athleteId) {
    return;
  }

  const position = asRecord(athlete.position);
  statements.athlete.run({
    athleteId,
    uid: toText(athlete.uid),
    guid: toText(athlete.guid),
    displayName: toText(athlete.displayName),
    shortName: toText(athlete.shortName),
    firstName: toText(athlete.firstName),
    lastName: toText(athlete.lastName),
    positionName: toText(position?.name) ?? toText(position?.displayName),
    positionAbbreviation: toText(position?.abbreviation),
    rawJson: JSON.stringify(athlete),
  });
}

function asRecord(value: unknown): JsonRecord | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as JsonRecord;
  }
  return null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toText(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : null;
  }
  return null;
}

function toInteger(value: unknown): number | null {
  const numberValue = toNumber(value);
  return numberValue === null ? null : Math.trunc(numberValue);
}

function toBooleanInteger(value: unknown): 0 | 1 | null {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "number") {
    return value === 0 ? 0 : 1;
  }
  return null;
}

function stringifyNullable(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();

  console.log(`Scanning ${options.sourceRoot}`);
  const files = discoverFiles(options.sourceRoot);
  console.log(`Found ${files.length.toLocaleString()} source files`);

  if (options.dryRun) {
    const datasets = new Map<string, number>();
    for (const file of files) {
      datasets.set(file.dataset, (datasets.get(file.dataset) ?? 0) + 1);
    }

    console.log("Dry run dataset counts:");
    for (const [dataset, count] of [...datasets.entries()].sort()) {
      console.log(`  ${dataset}: ${count.toLocaleString()}`);
    }
    return;
  }

  const db = new Database(options.dbPath);
  ensureSchema(db);

  const createRun = db.prepare(`
    INSERT INTO sync_runs (source_root, started_at, status)
    VALUES (?, ?, 'running')
  `);
  const runId = Number(createRun.run(options.sourceRoot, startedAt).lastInsertRowid);

  const existing = db.prepare("SELECT sha256 FROM raw_files WHERE relative_path = ?");
  const upsert = db.prepare(`
    INSERT INTO raw_files (
      dataset,
      relative_path,
      extension,
      source_path,
      source_size,
      source_mtime_ms,
      sha256,
      content_text,
      content_blob,
      json_valid,
      inferred_year,
      inferred_entity_id,
      last_synced_at
    )
    VALUES (
      @dataset,
      @relativePath,
      @extension,
      @absolutePath,
      @size,
      @mtimeMs,
      @sha256,
      @contentText,
      @contentBlob,
      @jsonValid,
      @inferredYear,
      @inferredEntityId,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT(relative_path) DO UPDATE SET
      dataset = excluded.dataset,
      extension = excluded.extension,
      source_path = excluded.source_path,
      source_size = excluded.source_size,
      source_mtime_ms = excluded.source_mtime_ms,
      sha256 = excluded.sha256,
      content_text = excluded.content_text,
      content_blob = excluded.content_blob,
      json_valid = excluded.json_valid,
      inferred_year = excluded.inferred_year,
      inferred_entity_id = excluded.inferred_entity_id,
      last_synced_at = CURRENT_TIMESTAMP
  `);
  const pruneMissing = db.prepare(`
    DELETE FROM raw_files
    WHERE relative_path NOT IN (${files.map(() => "?").join(",")})
  `);
  const finishRun = db.prepare(`
    UPDATE sync_runs
    SET finished_at = ?,
        files_seen = ?,
        files_inserted = ?,
        files_updated = ?,
        files_unchanged = ?,
        files_pruned = ?,
        status = ?,
        error = ?
    WHERE id = ?
  `);

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let pruned = 0;

  const sync = db.transaction(() => {
    for (const file of files) {
      const loadedFile = loadSourceFile(file, options.storeRawContent);
      const row = existing.get(loadedFile.relativePath) as { sha256: string } | undefined;
      if (row?.sha256 === loadedFile.sha256) {
        unchanged += 1;
        continue;
      }

      upsert.run(loadedFile);
      if (row) {
        updated += 1;
      } else {
        inserted += 1;
      }
    }

    if (options.prune) {
      if (files.length === 0) {
        pruned = db.prepare("DELETE FROM raw_files").run().changes;
      } else {
        pruned = pruneMissing.run(...files.map((file) => file.relativePath)).changes;
      }
    }

    refreshExtractedTables(db, files);
  });

  try {
    sync();
    finishRun.run(
      new Date().toISOString(),
      files.length,
      inserted,
      updated,
      unchanged,
      pruned,
      "ok",
      null,
      runId,
    );
  } catch (error) {
    finishRun.run(
      new Date().toISOString(),
      files.length,
      inserted,
      updated,
      unchanged,
      pruned,
      "error",
      error instanceof Error ? error.message : String(error),
      runId,
    );
    throw error;
  } finally {
    db.close();
  }

  console.log(`SQLite database: ${options.dbPath}`);
  console.log(`Inserted ${inserted.toLocaleString()}, updated ${updated.toLocaleString()}, unchanged ${unchanged.toLocaleString()}, pruned ${pruned.toLocaleString()}`);
}

main();
