import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Options = {
  dbPath: string;
  vacuum: boolean;
  keepSourceMetadata: boolean;
};

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, "wnba_raw.sqlite");

const SIDECAR_COLUMNS: Record<string, string[]> = {
  teams: ["raw_json"],
  athletes: ["raw_json"],
  games: ["raw_header_json"],
  game_competitors: ["records_json", "linescores_json", "raw_json"],
  game_team_box_stats: ["raw_json"],
  game_player_box_stats: ["raw_athlete_json"],
  game_plays: ["raw_json"],
  game_officials: ["raw_json"],
  team_standings_stats: ["raw_json"],
  team_roster_members: ["raw_json"],
  game_roster_members: ["raw_json"],
  team_season_stats: ["raw_json"],
  draft_picks: ["raw_json"],
  espn_schedule_events: ["raw_json"],
  espn_schedule_competitors: ["records_json", "raw_json"],
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    dbPath: process.env.WNBA_RAW_DB ?? DEFAULT_DB_PATH,
    vacuum: true,
    keepSourceMetadata: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--db" && next) {
      options.dbPath = path.resolve(next);
      i += 1;
    } else if (arg === "--no-vacuum") {
      options.vacuum = false;
    } else if (arg === "--keep-source-metadata") {
      options.keepSourceMetadata = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  options.dbPath = path.resolve(options.dbPath);
  return options;
}

function printHelp(): void {
  console.log(`Usage: pnpm run compact:db -- [options]

Options:
  --db <path>              SQLite database path. Defaults to ${DEFAULT_DB_PATH}
  --no-vacuum              Strip raw sidecars without reclaiming file space.
  --keep-source-metadata   Keep raw_files source inventory metadata.
  -h, --help               Show this help text.
`);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 AS exists_flag FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { exists_flag: 1 } | undefined;
  return row !== undefined;
}

function columnInfo(db: Database.Database, tableName: string): Map<string, { notnull: number }> {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as Array<{
    name: string;
    notnull: number;
  }>;
  return new Map(rows.map((row) => [row.name, { notnull: row.notnull }]));
}

function stripSidecars(db: Database.Database): string[] {
  const changes: string[] = [];

  for (const [tableName, columns] of Object.entries(SIDECAR_COLUMNS)) {
    if (!tableExists(db, tableName)) {
      continue;
    }

    const info = columnInfo(db, tableName);
    const assignments = columns
      .filter((column) => info.has(column))
      .map((column) => {
        const value = info.get(column)?.notnull ? "''" : "NULL";
        return `${quoteIdentifier(column)} = ${value}`;
      });

    if (assignments.length === 0) {
      continue;
    }

    db.prepare(`UPDATE ${quoteIdentifier(tableName)} SET ${assignments.join(", ")}`).run();
    changes.push(`${tableName}: ${assignments.length} sidecar column(s) stripped`);
  }

  return changes;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const db = new Database(options.dbPath);

  try {
    db.pragma("foreign_keys = OFF");
    const transaction = db.transaction(() => {
      const changes = stripSidecars(db);
      if (!options.keepSourceMetadata && tableExists(db, "raw_files")) {
        db.prepare("DROP TABLE raw_files").run();
        changes.push("raw_files: dropped source inventory table");
      }
      return changes;
    });

    const changes = transaction();
    for (const change of changes) {
      console.log(change);
    }

    if (options.vacuum) {
      console.log("Running VACUUM to reclaim disk space...");
      db.exec("VACUUM");
    }

    console.log(`Compacted SQLite database: ${options.dbPath}`);
  } finally {
    db.close();
  }
}

main();
