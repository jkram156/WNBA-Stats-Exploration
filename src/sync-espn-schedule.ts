import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Options = {
  dbPath: string;
  season: number;
  limit: number;
  insecureTls: boolean;
  storeExtractedJson: boolean;
};

type JsonRecord = Record<string, unknown>;

type EspnEvent = JsonRecord & {
  id?: string;
  uid?: string;
  date?: string;
  name?: string;
  shortName?: string;
  season?: {
    year?: number;
    type?: number;
    slug?: string;
  };
  competitions?: EspnCompetition[];
  status?: EspnStatus;
};

type EspnCompetition = JsonRecord & {
  id?: string;
  date?: string;
  timeValid?: boolean;
  neutralSite?: boolean;
  conferenceCompetition?: boolean;
  venue?: {
    id?: string;
    fullName?: string;
    address?: {
      city?: string;
      state?: string;
    };
  };
  competitors?: EspnCompetitor[];
  broadcasts?: Array<{ names?: string[] }>;
  broadcast?: string;
};

type EspnCompetitor = JsonRecord & {
  id?: string;
  uid?: string;
  order?: number;
  homeAway?: string;
  winner?: boolean;
  score?: string;
  records?: unknown;
  team?: {
    id?: string;
    uid?: string;
    location?: string;
    name?: string;
    abbreviation?: string;
    displayName?: string;
    shortDisplayName?: string;
    color?: string;
    logo?: string;
  };
};

type EspnStatus = {
  type?: {
    id?: string;
    name?: string;
    state?: string;
    completed?: boolean;
    description?: string;
    detail?: string;
    shortDetail?: string;
  };
};

type ScheduleResponse = {
  events?: EspnEvent[];
};

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, "wnba_raw.sqlite");
const ESPN_WNBA_SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard";

function parseArgs(argv: string[]): Options {
  const options: Options = {
    dbPath: process.env.WNBA_RAW_DB ?? DEFAULT_DB_PATH,
    season: new Date().getFullYear(),
    limit: 1000,
    insecureTls: false,
    storeExtractedJson: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--db" && next) {
      options.dbPath = path.resolve(next);
      i += 1;
    } else if (arg === "--season" && next) {
      options.season = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--limit" && next) {
      options.limit = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--insecure-tls") {
      options.insecureTls = true;
    } else if (arg === "--store-extracted-json") {
      options.storeExtractedJson = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.season) || options.season < 1997) {
    throw new Error("--season must be a WNBA season year");
  }

  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new Error("--limit must be a positive integer");
  }

  return options;
}

function printHelp(): void {
  console.log(`Usage: pnpm run sync:espn-schedule -- [options]

Options:
  --db <path>       SQLite database path. Defaults to ${DEFAULT_DB_PATH}
  --season <year>   ESPN WNBA season to fetch. Defaults to the current year.
  --limit <n>       ESPN API event limit. Defaults to 1000.
  --insecure-tls    Disable Node TLS verification for this fetch.
  --store-extracted-json
                    Store raw ESPN event/competitor JSON sidecars. Off by default.
  -h, --help        Show this help text.
`);
}

function ensureSchema(db: Database.Database): void {
  db.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS espn_schedule_sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_url TEXT NOT NULL,
      season INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      events_seen INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS espn_schedule_events (
      event_id TEXT PRIMARY KEY,
      uid TEXT,
      season_year INTEGER,
      season_type INTEGER,
      season_slug TEXT,
      date TEXT,
      name TEXT,
      short_name TEXT,
      status_id TEXT,
      status_name TEXT,
      status_state TEXT,
      status_completed INTEGER,
      status_detail TEXT,
      venue_id TEXT,
      venue_name TEXT,
      venue_city TEXT,
      venue_state TEXT,
      neutral_site INTEGER,
      conference_competition INTEGER,
      time_valid INTEGER,
      broadcast TEXT,
      source_url TEXT NOT NULL,
      raw_json TEXT,
      last_synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS espn_schedule_competitors (
      event_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      uid TEXT,
      order_index INTEGER,
      home_away TEXT,
      winner INTEGER,
      score REAL,
      team_location TEXT,
      team_name TEXT,
      team_abbreviation TEXT,
      team_display_name TEXT,
      team_short_display_name TEXT,
      team_color TEXT,
      team_logo TEXT,
      records_json TEXT,
      raw_json TEXT,
      PRIMARY KEY (event_id, team_id),
      FOREIGN KEY (event_id) REFERENCES espn_schedule_events(event_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_espn_schedule_events_date ON espn_schedule_events(date);
    CREATE INDEX IF NOT EXISTS idx_espn_schedule_events_season ON espn_schedule_events(season_year, season_type);
    CREATE INDEX IF NOT EXISTS idx_espn_schedule_events_status ON espn_schedule_events(status_completed, status_state);
    CREATE INDEX IF NOT EXISTS idx_espn_schedule_competitors_team ON espn_schedule_competitors(team_id);
  `);
}

function scheduleUrl(options: Options): string {
  const params = new URLSearchParams({
    dates: String(options.season),
    limit: String(options.limit),
  });

  return `${ESPN_WNBA_SCOREBOARD_URL}?${params.toString()}`;
}

async function fetchSchedule(url: string, insecureTls: boolean): Promise<ScheduleResponse> {
  if (insecureTls) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }

  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "wnba-stats-exploration/0.1",
    },
  });

  if (!response.ok) {
    throw new Error(`ESPN schedule fetch failed: HTTP ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as ScheduleResponse;
}

function syncSchedule(db: Database.Database, options: Options, sourceUrl: string, events: EspnEvent[]): void {
  const run = db
    .prepare(
      `
      INSERT INTO espn_schedule_sync_runs (source_url, season, started_at, status)
      VALUES (?, ?, CURRENT_TIMESTAMP, 'running')
    `,
    )
    .run(sourceUrl, options.season);

  const insertEvent = db.prepare(`
    INSERT INTO espn_schedule_events (
      event_id, uid, season_year, season_type, season_slug, date, name, short_name,
      status_id, status_name, status_state, status_completed, status_detail,
      venue_id, venue_name, venue_city, venue_state, neutral_site,
      conference_competition, time_valid, broadcast, source_url, raw_json, last_synced_at
    )
    VALUES (
      @eventId, @uid, @seasonYear, @seasonType, @seasonSlug, @date, @name, @shortName,
      @statusId, @statusName, @statusState, @statusCompleted, @statusDetail,
      @venueId, @venueName, @venueCity, @venueState, @neutralSite,
      @conferenceCompetition, @timeValid, @broadcast, @sourceUrl, @rawJson, CURRENT_TIMESTAMP
    )
    ON CONFLICT(event_id) DO UPDATE SET
      uid = excluded.uid,
      season_year = excluded.season_year,
      season_type = excluded.season_type,
      season_slug = excluded.season_slug,
      date = excluded.date,
      name = excluded.name,
      short_name = excluded.short_name,
      status_id = excluded.status_id,
      status_name = excluded.status_name,
      status_state = excluded.status_state,
      status_completed = excluded.status_completed,
      status_detail = excluded.status_detail,
      venue_id = excluded.venue_id,
      venue_name = excluded.venue_name,
      venue_city = excluded.venue_city,
      venue_state = excluded.venue_state,
      neutral_site = excluded.neutral_site,
      conference_competition = excluded.conference_competition,
      time_valid = excluded.time_valid,
      broadcast = excluded.broadcast,
      source_url = excluded.source_url,
      raw_json = excluded.raw_json,
      last_synced_at = CURRENT_TIMESTAMP
  `);

  const deleteCompetitors = db.prepare("DELETE FROM espn_schedule_competitors WHERE event_id = ?");
  const insertCompetitor = db.prepare(`
    INSERT INTO espn_schedule_competitors (
      event_id, team_id, uid, order_index, home_away, winner, score,
      team_location, team_name, team_abbreviation, team_display_name,
      team_short_display_name, team_color, team_logo, records_json, raw_json
    )
    VALUES (
      @eventId, @teamId, @uid, @orderIndex, @homeAway, @winner, @score,
      @teamLocation, @teamName, @teamAbbreviation, @teamDisplayName,
      @teamShortDisplayName, @teamColor, @teamLogo, @recordsJson, @rawJson
    )
  `);

  const finishRun = db.prepare(`
    UPDATE espn_schedule_sync_runs
    SET finished_at = CURRENT_TIMESTAMP, events_seen = ?, status = ?, error = ?
    WHERE id = ?
  `);

  try {
    const syncTransaction = db.transaction(() => {
      for (const event of events) {
        const eventId = event.id;
        if (!eventId) {
          continue;
        }

        const competition = event.competitions?.[0];
        const statusType = event.status?.type;
        const venue = competition?.venue;

        insertEvent.run({
          eventId,
          uid: valueOrNull(event.uid),
          seasonYear: numberOrNull(event.season?.year),
          seasonType: numberOrNull(event.season?.type),
          seasonSlug: valueOrNull(event.season?.slug),
          date: valueOrNull(event.date ?? competition?.date),
          name: valueOrNull(event.name),
          shortName: valueOrNull(event.shortName),
          statusId: valueOrNull(statusType?.id),
          statusName: valueOrNull(statusType?.name),
          statusState: valueOrNull(statusType?.state),
          statusCompleted: booleanToInteger(statusType?.completed),
          statusDetail: valueOrNull(statusType?.detail ?? statusType?.description ?? statusType?.shortDetail),
          venueId: valueOrNull(venue?.id),
          venueName: valueOrNull(venue?.fullName),
          venueCity: valueOrNull(venue?.address?.city),
          venueState: valueOrNull(venue?.address?.state),
          neutralSite: booleanToInteger(competition?.neutralSite),
          conferenceCompetition: booleanToInteger(competition?.conferenceCompetition),
          timeValid: booleanToInteger(competition?.timeValid),
          broadcast: valueOrNull(broadcastLabel(competition)),
          sourceUrl,
          rawJson: options.storeExtractedJson ? JSON.stringify(event) : "",
        });

        deleteCompetitors.run(eventId);
        for (const competitor of competition?.competitors ?? []) {
          const teamId = competitor.team?.id ?? competitor.id;
          if (!teamId) {
            continue;
          }

          insertCompetitor.run({
            eventId,
            teamId,
            uid: valueOrNull(competitor.team?.uid ?? competitor.uid),
            orderIndex: numberOrNull(competitor.order),
            homeAway: valueOrNull(competitor.homeAway),
            winner: booleanToInteger(competitor.winner),
            score: numericStringOrNull(competitor.score),
            teamLocation: valueOrNull(competitor.team?.location),
            teamName: valueOrNull(competitor.team?.name),
            teamAbbreviation: valueOrNull(competitor.team?.abbreviation),
            teamDisplayName: valueOrNull(competitor.team?.displayName),
            teamShortDisplayName: valueOrNull(competitor.team?.shortDisplayName),
            teamColor: valueOrNull(competitor.team?.color),
            teamLogo: valueOrNull(competitor.team?.logo),
            recordsJson: options.storeExtractedJson && competitor.records !== undefined ? JSON.stringify(competitor.records) : null,
            rawJson: options.storeExtractedJson ? JSON.stringify(competitor) : "",
          });
        }
      }
    });

    syncTransaction();
    finishRun.run(events.length, "success", null, run.lastInsertRowid);
  } catch (error) {
    finishRun.run(events.length, "failed", error instanceof Error ? error.message : String(error), run.lastInsertRowid);
    throw error;
  }
}

function broadcastLabel(competition: EspnCompetition | undefined): string | null {
  if (!competition) {
    return null;
  }

  if (competition.broadcast) {
    return competition.broadcast;
  }

  const names = competition.broadcasts?.flatMap((broadcast) => broadcast.names ?? []) ?? [];
  return names.length > 0 ? names.join("/") : null;
}

function valueOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numericStringOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanToInteger(value: unknown): 0 | 1 | null {
  if (typeof value !== "boolean") {
    return null;
  }

  return value ? 1 : 0;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const url = scheduleUrl(options);
  const response = await fetchSchedule(url, options.insecureTls);
  const events = response.events ?? [];
  const db = new Database(options.dbPath);

  try {
    ensureSchema(db);
    syncSchedule(db, options, url, events);
  } finally {
    db.close();
  }

  const completed = events.filter((event) => event.status?.type?.completed === true).length;
  const scheduled = events.length - completed;
  console.log(`Synced ${events.length.toLocaleString()} ESPN WNBA ${options.season} schedule events to ${options.dbPath}`);
  console.log(`${completed.toLocaleString()} completed, ${scheduled.toLocaleString()} not completed`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
