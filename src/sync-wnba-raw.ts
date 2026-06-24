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
  incremental: boolean;
  sinceMtimeMs: number | null;
  storeSourceMetadata: boolean;
  storeRawContent: boolean;
  storeExtractedJson: boolean;
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
  storeExtractedJson: boolean;
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
    incremental: false,
    sinceMtimeMs: null,
    storeSourceMetadata: false,
    storeRawContent: false,
    storeExtractedJson: false,
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
    } else if (arg === "--incremental") {
      options.incremental = true;
    } else if (arg === "--since" && next) {
      const parsed = Date.parse(next);
      if (Number.isNaN(parsed)) {
        throw new Error(`Invalid --since timestamp: ${next}`);
      }
      options.sinceMtimeMs = parsed;
      options.incremental = true;
      i += 1;
    } else if (arg === "--store-source-metadata") {
      options.storeSourceMetadata = true;
    } else if (arg === "--store-raw-content") {
      options.storeRawContent = true;
      options.storeSourceMetadata = true;
    } else if (arg === "--store-extracted-json") {
      options.storeExtractedJson = true;
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
  --incremental    Upsert parsed rows for selected files instead of rebuilding all parsed tables.
  --since <iso>    In incremental mode, only parse source files modified at or after this timestamp.
  --store-source-metadata
                  Store source file paths, hashes, sizes, and inferred metadata in raw_files.
  --store-raw-content
                  Store JSON text and parquet/RDS blobs in raw_files. Also enables --store-source-metadata.
  --store-extracted-json
                  Store raw JSON sidecars in parsed tables. Off by default.
  -h, --help       Show this help text.
`);
}

function ensureSchema(db: Database.Database, storeSourceMetadata: boolean): void {
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
  `);

  if (storeSourceMetadata) {
    db.exec(`
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
    `);
  }

  db.exec(`
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
      raw_json TEXT,
      PRIMARY KEY (source_relative_path, play_id)
    );

    CREATE TABLE IF NOT EXISTS game_officials (
      game_id TEXT NOT NULL,
      official_id TEXT NOT NULL,
      official_order INTEGER NOT NULL,
      first_name TEXT,
      last_name TEXT,
      full_name TEXT,
      display_name TEXT,
      position_id TEXT,
      position_name TEXT,
      position_display_name TEXT,
      source_relative_path TEXT NOT NULL,
      raw_json TEXT,
      PRIMARY KEY (game_id, official_id, official_order)
    );

    CREATE TABLE IF NOT EXISTS team_standings_stats (
      season_year INTEGER NOT NULL,
      season_type INTEGER NOT NULL,
      group_id TEXT NOT NULL,
      group_name TEXT,
      group_abbreviation TEXT,
      team_id TEXT NOT NULL,
      stat_name TEXT NOT NULL,
      display_name TEXT,
      short_display_name TEXT,
      description TEXT,
      abbreviation TEXT,
      stat_type TEXT,
      value REAL,
      display_value TEXT,
      source_relative_path TEXT NOT NULL,
      raw_json TEXT,
      PRIMARY KEY (season_year, season_type, group_id, team_id, stat_name)
    );

    CREATE TABLE IF NOT EXISTS team_roster_members (
      requested_season INTEGER NOT NULL,
      season_type INTEGER,
      team_id TEXT NOT NULL,
      athlete_id TEXT NOT NULL,
      jersey TEXT,
      position_id TEXT,
      position_name TEXT,
      position_display_name TEXT,
      position_abbreviation TEXT,
      height REAL,
      display_height TEXT,
      weight REAL,
      display_weight TEXT,
      age INTEGER,
      date_of_birth TEXT,
      birth_place_city TEXT,
      birth_place_state TEXT,
      birth_place_country TEXT,
      headshot_href TEXT,
      source_relative_path TEXT NOT NULL,
      raw_json TEXT,
      PRIMARY KEY (requested_season, team_id, athlete_id)
    );

    CREATE TABLE IF NOT EXISTS game_roster_members (
      game_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      athlete_id TEXT NOT NULL,
      category_name TEXT NOT NULL,
      category_display_name TEXT,
      starter INTEGER,
      did_not_play INTEGER,
      ejected INTEGER,
      active INTEGER,
      source_relative_path TEXT NOT NULL,
      raw_json TEXT,
      PRIMARY KEY (game_id, team_id, athlete_id, category_name)
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
    CREATE INDEX IF NOT EXISTS idx_game_officials_official ON game_officials(official_id);
    CREATE INDEX IF NOT EXISTS idx_team_standings_stats_team ON team_standings_stats(team_id);
    CREATE INDEX IF NOT EXISTS idx_team_roster_members_athlete ON team_roster_members(athlete_id);
    CREATE INDEX IF NOT EXISTS idx_game_roster_members_game ON game_roster_members(game_id);
    CREATE INDEX IF NOT EXISTS idx_game_roster_members_athlete ON game_roster_members(athlete_id);
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
    storeExtractedJson: false,
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

function refreshExtractedTables(db: Database.Database, files: SourceFile[], storeExtractedJson: boolean): void {
  const statements = buildExtractionStatements(db);

  db.exec(`
    DELETE FROM draft_picks;
    DELETE FROM player_season_stats;
    DELETE FROM team_season_stats;
    DELETE FROM game_roster_members;
    DELETE FROM team_roster_members;
    DELETE FROM team_standings_stats;
    DELETE FROM game_officials;
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

    extractSourceFile(statements, file, storeExtractedJson);
  }
}

function refreshIncrementalExtractedTables(db: Database.Database, files: SourceFile[], storeExtractedJson: boolean): void {
  const statements = buildExtractionStatements(db);

  for (const file of files) {
    if (file.extension !== "json") {
      continue;
    }

    deleteExtractedRowsForFile(db, file);
    extractSourceFile(statements, file, storeExtractedJson);
  }
}

function extractSourceFile(statements: ExtractionStatements, file: SourceFile, storeExtractedJson: boolean): void {
    const contentText = readFileSync(file.absolutePath, "utf8");
    if (isValidJson(contentText) !== 1) {
      return;
    }

    const loadedFile: LoadedSourceFile = {
      ...file,
      sha256: "",
      contentText,
      contentBlob: null,
      jsonValid: 1,
      storeExtractedJson,
    };
    const json = JSON.parse(contentText) as JsonRecord;
    extractGameDocument(statements, loadedFile, json);
    extractOfficials(statements, loadedFile, json);
    extractStandings(statements, loadedFile, json);
    extractTeamRoster(statements, loadedFile, json);
    extractGameRoster(statements, loadedFile, json);
    extractTeamSeasonStats(statements, loadedFile, json);
    extractPlayerSeasonStats(statements, loadedFile, json);
    extractDraft(statements, loadedFile, json);
}

function deleteExtractedRowsForFile(db: Database.Database, file: SourceFile): void {
  const sourceRelativePath = file.relativePath;
  const entityId = file.inferredEntityId;

  if (file.dataset === "json") {
    db.prepare("DELETE FROM game_plays WHERE source_relative_path = ?").run(sourceRelativePath);

    if (entityId && sourceRelativePath.includes("/final/")) {
      deleteGameRows(db, entityId);
    }
    return;
  }

  if (file.dataset === "officials") {
    db.prepare("DELETE FROM game_officials WHERE source_relative_path = ?").run(sourceRelativePath);
    if (entityId) {
      db.prepare("DELETE FROM game_officials WHERE game_id = ?").run(entityId);
    }
    return;
  }

  if (file.dataset === "standings") {
    db.prepare("DELETE FROM team_standings_stats WHERE source_relative_path = ?").run(sourceRelativePath);
    return;
  }

  if (file.dataset === "team_rosters") {
    db.prepare("DELETE FROM team_roster_members WHERE source_relative_path = ?").run(sourceRelativePath);
    return;
  }

  if (file.dataset === "game_rosters") {
    db.prepare("DELETE FROM game_roster_members WHERE source_relative_path = ?").run(sourceRelativePath);
    if (entityId) {
      db.prepare("DELETE FROM game_roster_members WHERE game_id = ?").run(entityId);
    }
    return;
  }

  if (file.dataset === "team_stats" && file.inferredYear && entityId) {
    db.prepare("DELETE FROM team_season_stats WHERE requested_season = ? AND team_id = ?").run(file.inferredYear, entityId);
    return;
  }

  if (file.dataset === "player_season_stats" && file.inferredYear && entityId) {
    db.prepare("DELETE FROM player_season_stats WHERE requested_season = ? AND athlete_id = ?").run(file.inferredYear, entityId);
    return;
  }

  if (file.dataset === "draft" && file.inferredYear) {
    db.prepare("DELETE FROM draft_picks WHERE draft_year = ?").run(file.inferredYear);
  }
}

function deleteGameRows(db: Database.Database, gameId: string): void {
  db.prepare("DELETE FROM game_plays WHERE game_id = ?").run(gameId);
  db.prepare("DELETE FROM game_player_box_stats WHERE game_id = ?").run(gameId);
  db.prepare("DELETE FROM game_team_box_stats WHERE game_id = ?").run(gameId);
  db.prepare("DELETE FROM game_competitors WHERE game_id = ?").run(gameId);
  db.prepare("DELETE FROM games WHERE game_id = ?").run(gameId);
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
    gameOfficial: db.prepare(`
      INSERT OR REPLACE INTO game_officials (
        game_id, official_id, official_order, first_name, last_name, full_name, display_name,
        position_id, position_name, position_display_name, source_relative_path, raw_json
      )
      VALUES (
        @gameId, @officialId, @officialOrder, @firstName, @lastName, @fullName, @displayName,
        @positionId, @positionName, @positionDisplayName, @sourceRelativePath, @rawJson
      )
    `),
    teamStandingsStat: db.prepare(`
      INSERT OR REPLACE INTO team_standings_stats (
        season_year, season_type, group_id, group_name, group_abbreviation, team_id,
        stat_name, display_name, short_display_name, description, abbreviation, stat_type,
        value, display_value, source_relative_path, raw_json
      )
      VALUES (
        @seasonYear, @seasonType, @groupId, @groupName, @groupAbbreviation, @teamId,
        @statName, @displayName, @shortDisplayName, @description, @abbreviation, @statType,
        @value, @displayValue, @sourceRelativePath, @rawJson
      )
    `),
    teamRosterMember: db.prepare(`
      INSERT OR REPLACE INTO team_roster_members (
        requested_season, season_type, team_id, athlete_id, jersey, position_id, position_name,
        position_display_name, position_abbreviation, height, display_height, weight, display_weight,
        age, date_of_birth, birth_place_city, birth_place_state, birth_place_country,
        headshot_href, source_relative_path, raw_json
      )
      VALUES (
        @requestedSeason, @seasonType, @teamId, @athleteId, @jersey, @positionId, @positionName,
        @positionDisplayName, @positionAbbreviation, @height, @displayHeight, @weight, @displayWeight,
        @age, @dateOfBirth, @birthPlaceCity, @birthPlaceState, @birthPlaceCountry,
        @headshotHref, @sourceRelativePath, @rawJson
      )
    `),
    gameRosterMember: db.prepare(`
      INSERT OR REPLACE INTO game_roster_members (
        game_id, team_id, athlete_id, category_name, category_display_name,
        starter, did_not_play, ejected, active, source_relative_path, raw_json
      )
      VALUES (
        @gameId, @teamId, @athleteId, @categoryName, @categoryDisplayName,
        @starter, @didNotPlay, @ejected, @active, @sourceRelativePath, @rawJson
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
    rawHeaderJson: stringifySidecar(file, header),
  });

  for (const competitor of asArray(competition.competitors)) {
    const competitorRecord = asRecord(competitor);
    const team = asRecord(competitorRecord?.team);
    const teamId = toText(team?.id) ?? toText(competitorRecord?.id);
    if (!competitorRecord || !teamId) {
      continue;
    }
    upsertTeam(statements, team, file.storeExtractedJson);
    statements.gameCompetitor.run({
      gameId,
      teamId,
      homeAway: toText(competitorRecord.homeAway),
      score: toNumber(competitorRecord.score),
      winner: toBooleanInteger(competitorRecord.winner),
      seed: toInteger(competitorRecord.curatedRank),
      recordsJson: stringifyNullableSidecar(file, competitorRecord.records),
      linescoresJson: stringifyNullableSidecar(file, competitorRecord.linescores),
      rawJson: stringifySidecar(file, competitorRecord),
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
    upsertTeam(statements, team, file.storeExtractedJson);
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
        rawJson: stringifySidecar(file, statRecord),
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
    upsertTeam(statements, team, file.storeExtractedJson);
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
        upsertAthlete(statements, athlete, file.storeExtractedJson);

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
            rawAthleteJson: stringifySidecar(file, athleteRowRecord),
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
      rawJson: file.storeExtractedJson ? JSON.stringify(playRecord) : "",
    });
  }
}

function extractOfficials(statements: ExtractionStatements, file: LoadedSourceFile, json: JsonRecord): void {
  if (file.dataset !== "officials") {
    return;
  }

  const gameId = file.inferredEntityId;
  if (!gameId) {
    return;
  }

  for (const official of asArray(json.items)) {
    const officialRecord = asRecord(official);
    const officialId = toText(officialRecord?.id);
    const officialOrder = toInteger(officialRecord?.order);
    if (!officialRecord || !officialId || officialOrder === null) {
      continue;
    }

    const position = asRecord(officialRecord.position);
    statements.gameOfficial.run({
      gameId,
      officialId,
      officialOrder,
      firstName: toText(officialRecord.firstName),
      lastName: toText(officialRecord.lastName),
      fullName: toText(officialRecord.fullName),
      displayName: toText(officialRecord.displayName),
      positionId: toText(position?.id),
      positionName: toText(position?.name),
      positionDisplayName: toText(position?.displayName),
      sourceRelativePath: file.relativePath,
      rawJson: stringifySidecar(file, officialRecord),
    });
  }
}

function extractStandings(statements: ExtractionStatements, file: LoadedSourceFile, json: JsonRecord): void {
  if (file.dataset !== "standings") {
    return;
  }

  const groups = asArray(json.children)
    .map(asRecord)
    .filter((group): group is JsonRecord => group !== null);
  const standingGroups = groups.length > 0 ? groups : [json];

  for (const group of standingGroups) {
    const standings = asRecord(group.standings);
    const seasonYear = toInteger(standings?.season) ?? file.inferredYear;
    const seasonType = toInteger(standings?.seasonType) ?? 2;
    const groupId = toText(group.id) ?? "overall";
    if (!seasonYear) {
      continue;
    }

    for (const entry of asArray(standings?.entries)) {
      const entryRecord = asRecord(entry);
      const team = asRecord(entryRecord?.team);
      const teamId = toText(team?.id);
      if (!entryRecord || !teamId) {
        continue;
      }

      upsertTeam(statements, team, file.storeExtractedJson);
      for (const stat of asArray(entryRecord.stats)) {
        const statRecord = asRecord(stat);
        const statName = toText(statRecord?.name);
        if (!statRecord || !statName) {
          continue;
        }

        statements.teamStandingsStat.run({
          seasonYear,
          seasonType,
          groupId,
          groupName: toText(group.name),
          groupAbbreviation: toText(group.abbreviation),
          teamId,
          statName,
          displayName: toText(statRecord.displayName),
          shortDisplayName: toText(statRecord.shortDisplayName),
          description: toText(statRecord.description),
          abbreviation: toText(statRecord.abbreviation),
          statType: toText(statRecord.type),
          value: toNumber(statRecord.value),
          displayValue: toText(statRecord.displayValue),
          sourceRelativePath: file.relativePath,
          rawJson: stringifySidecar(file, statRecord),
        });
      }
    }
  }
}

function extractTeamRoster(statements: ExtractionStatements, file: LoadedSourceFile, json: JsonRecord): void {
  if (file.dataset !== "team_rosters") {
    return;
  }

  const requestedSeason = toInteger(asRecord(json.season)?.year) ?? file.inferredYear;
  const seasonType = toInteger(asRecord(json.season)?.type);
  const teamId = file.inferredEntityId;
  if (!requestedSeason || !teamId || teamId.startsWith("-")) {
    return;
  }

  for (const athlete of rosterAthletes(json.athletes)) {
    const athleteId = toText(athlete.id);
    if (!athleteId) {
      continue;
    }

    upsertAthlete(statements, athlete, file.storeExtractedJson);
    const position = asRecord(athlete.position);
    const birthPlace = asRecord(athlete.birthPlace);
    const headshot = asRecord(athlete.headshot);
    statements.teamRosterMember.run({
      requestedSeason,
      seasonType,
      teamId,
      athleteId,
      jersey: toText(athlete.jersey),
      positionId: toText(position?.id),
      positionName: toText(position?.name),
      positionDisplayName: toText(position?.displayName),
      positionAbbreviation: toText(position?.abbreviation),
      height: toNumber(athlete.height),
      displayHeight: toText(athlete.displayHeight),
      weight: toNumber(athlete.weight),
      displayWeight: toText(athlete.displayWeight),
      age: toInteger(athlete.age),
      dateOfBirth: toText(athlete.dateOfBirth),
      birthPlaceCity: toText(birthPlace?.city),
      birthPlaceState: toText(birthPlace?.state),
      birthPlaceCountry: toText(birthPlace?.country),
      headshotHref: toText(headshot?.href),
      sourceRelativePath: file.relativePath,
      rawJson: stringifySidecar(file, athlete),
    });
  }
}

function extractGameRoster(statements: ExtractionStatements, file: LoadedSourceFile, json: JsonRecord): void {
  if (file.dataset !== "game_rosters") {
    return;
  }

  const gameId = file.inferredEntityId;
  if (!gameId) {
    return;
  }

  const boxscore = asRecord(json.boxscore);
  for (const playerTeam of asArray(boxscore?.players)) {
    const playerTeamRecord = asRecord(playerTeam);
    const team = asRecord(playerTeamRecord?.team);
    const teamId = toText(team?.id);
    if (!playerTeamRecord || !teamId) {
      continue;
    }

    upsertTeam(statements, team, file.storeExtractedJson);
    for (const category of asArray(playerTeamRecord.statistics)) {
      const categoryRecord = asRecord(category);
      const categoryName = toText(categoryRecord?.name) ?? "boxscore";
      const categoryDisplayName = toText(categoryRecord?.displayName);

      for (const athleteRow of asArray(categoryRecord?.athletes)) {
        const athleteRowRecord = asRecord(athleteRow);
        const athlete = asRecord(athleteRowRecord?.athlete);
        const athleteId = toText(athlete?.id);
        if (!athleteRowRecord || !athlete || !athleteId) {
          continue;
        }

        upsertAthlete(statements, athlete, file.storeExtractedJson);
        statements.gameRosterMember.run({
          gameId,
          teamId,
          athleteId,
          categoryName,
          categoryDisplayName,
          starter: toBooleanInteger(athleteRowRecord.starter),
          didNotPlay: toBooleanInteger(athleteRowRecord.didNotPlay),
          ejected: toBooleanInteger(athleteRowRecord.ejected),
          active: toBooleanInteger(athleteRowRecord.active),
          sourceRelativePath: file.relativePath,
          rawJson: stringifySidecar(file, athleteRowRecord),
        });
      }
    }
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

  upsertTeam(statements, team, file.storeExtractedJson);
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
        rawJson: stringifySidecar(file, statRecord),
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

  for (const category of asArray(asRecord(json.splits)?.categories)) {
    const categoryRecord = asRecord(category);
    const categoryName = toText(categoryRecord?.name) ?? "stats";
    for (const stat of asArray(categoryRecord?.stats)) {
      const statRecord = asRecord(stat);
      const statName = toText(statRecord?.name);
      if (!statRecord || !statName) {
        continue;
      }

      statements.playerSeasonStat.run({
        requestedSeason,
        athleteId,
        categoryName,
        rowSeasonYear: requestedSeason,
        teamId: null,
        teamSlug: null,
        position: null,
        statKey: statName,
        statLabel: toText(statRecord.abbreviation),
        statDisplayName: toText(statRecord.displayName),
        statDescription: toText(statRecord.description),
        statValue: toText(statRecord.displayValue) ?? toText(statRecord.value),
      });
    }
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
    upsertTeam(statements, asRecord(team), file.storeExtractedJson);
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
    upsertTeam(statements, team, file.storeExtractedJson);
    upsertAthlete(statements, athlete, file.storeExtractedJson);

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
      rawJson: stringifySidecar(file, pickRecord),
    });
  }
}

function rosterAthletes(value: unknown): JsonRecord[] {
  const athletes = asArray(value);
  const flattened: JsonRecord[] = [];

  for (const athleteOrGroup of athletes) {
    const record = asRecord(athleteOrGroup);
    if (!record) {
      continue;
    }

    const items = asArray(record.items);
    if (items.length > 0) {
      for (const item of items) {
        const athlete = asRecord(item);
        if (athlete) {
          flattened.push(athlete);
        }
      }
    } else {
      flattened.push(record);
    }
  }

  return flattened;
}

function upsertTeam(statements: ExtractionStatements, team: JsonRecord | null | undefined, storeExtractedJson: boolean): void {
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
    rawJson: storeExtractedJson ? JSON.stringify(team) : null,
  });
}

function upsertAthlete(statements: ExtractionStatements, athlete: JsonRecord | null | undefined, storeExtractedJson: boolean): void {
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
    rawJson: storeExtractedJson ? JSON.stringify(athlete) : null,
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

function stringifySidecar(file: LoadedSourceFile, value: unknown): string | null {
  return file.storeExtractedJson ? JSON.stringify(value) : null;
}

function stringifyNullableSidecar(file: LoadedSourceFile, value: unknown): string | null {
  return file.storeExtractedJson ? stringifyNullable(value) : null;
}

function stringifyNullable(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function selectExtractionFiles(files: SourceFile[], options: Options): SourceFile[] {
  if (!options.incremental && options.sinceMtimeMs === null) {
    return files;
  }

  return files.filter((file) => {
    if (options.sinceMtimeMs !== null && file.mtimeMs < options.sinceMtimeMs) {
      return false;
    }

    return true;
  });
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();

  console.log(`Scanning ${options.sourceRoot}`);
  const files = discoverFiles(options.sourceRoot);
  console.log(`Found ${files.length.toLocaleString()} source files`);
  const extractionFiles = selectExtractionFiles(files, options);
  if (options.incremental) {
    console.log(`Incremental parsed-table sync selected ${extractionFiles.length.toLocaleString()} source files`);
  }

  if (options.dryRun) {
    const datasets = new Map<string, number>();
    for (const file of extractionFiles) {
      datasets.set(file.dataset, (datasets.get(file.dataset) ?? 0) + 1);
    }

    console.log("Dry run dataset counts:");
    for (const [dataset, count] of [...datasets.entries()].sort()) {
      console.log(`  ${dataset}: ${count.toLocaleString()}`);
    }
    return;
  }

  const db = new Database(options.dbPath);
  ensureSchema(db, options.storeSourceMetadata);

  const createRun = db.prepare(`
    INSERT INTO sync_runs (source_root, started_at, status)
    VALUES (?, ?, 'running')
  `);
  const runId = Number(createRun.run(options.sourceRoot, startedAt).lastInsertRowid);

  const existing = options.storeSourceMetadata ? db.prepare("SELECT sha256 FROM raw_files WHERE relative_path = ?") : null;
  const upsert = options.storeSourceMetadata
    ? db.prepare(`
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
    `)
    : null;
  const pruneMissing =
    options.storeSourceMetadata && files.length > 0
      ? db.prepare(`
        DELETE FROM raw_files
        WHERE relative_path NOT IN (${files.map(() => "?").join(",")})
      `)
      : null;
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
    if (options.storeSourceMetadata && existing && upsert) {
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
    }

    if (options.prune && options.storeSourceMetadata) {
      if (files.length === 0) {
        pruned = db.prepare("DELETE FROM raw_files").run().changes;
      } else if (pruneMissing) {
        pruned = pruneMissing.run(...files.map((file) => file.relativePath)).changes;
      }
    }

    if (options.incremental) {
      refreshIncrementalExtractedTables(db, extractionFiles, options.storeExtractedJson);
    } else {
      refreshExtractedTables(db, files, options.storeExtractedJson);
    }
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
  if (options.storeSourceMetadata) {
    console.log(`Source metadata inserted ${inserted.toLocaleString()}, updated ${updated.toLocaleString()}, unchanged ${unchanged.toLocaleString()}, pruned ${pruned.toLocaleString()}`);
  } else if (options.incremental) {
    console.log("Source metadata skipped; parsed tables updated incrementally.");
  } else {
    console.log("Source metadata skipped; parsed tables refreshed only.");
  }
}

main();
