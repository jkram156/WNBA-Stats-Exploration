import Database from "better-sqlite3";
import { PlaywrightCrawler } from "crawlee";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Options = {
  dbPath: string;
  bookmaker: string | null;
  from: string;
  to: string | null;
  limit: number;
  outPath: string | null;
  timeToleranceHours: number;
  sourceUrl: string;
  headless: boolean;
  browserChannel: string | null;
  minDelayMs: number;
  maxDelayMs: number;
  postNavigationDelayMs: number;
  navigationTimeoutSecs: number;
  debugDumpPath: string | null;
};

type ScheduledGame = {
  eventId: string;
  date: string;
  dateMs: number;
  shortName: string;
  homeTeam: string;
  awayTeam: string;
};

type OddsOutcome = {
  name: string;
  price?: number;
  point?: number;
};

type OddsMarket = {
  key: string;
  outcomes: OddsOutcome[];
};

type OddsBookmaker = {
  key: string;
  title: string;
  markets: OddsMarket[];
};

type OddsEvent = {
  id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: OddsBookmaker[];
};

type MarketOutput = {
  eventId: string;
  shortName: string;
  homeTeam: string;
  awayTeam: string;
  homeImpliedProbability: number;
  awayImpliedProbability: number;
  homeMoneyline?: number;
  awayMoneyline?: number;
  homeSpread?: number;
  awaySpread?: number;
  book: string;
  note: string;
};

type BookLine = {
  bookmakerKey: string;
  bookmakerTitle: string;
  homeMoneyline: number;
  awayMoneyline: number;
  homeNoVigProbability: number;
  awayNoVigProbability: number;
  homeSpread: number | null;
  awaySpread: number | null;
};

type MatchedMarket = {
  game: ScheduledGame;
  oddsEvent: OddsEvent;
  lines: BookLine[];
  output: MarketOutput;
};

type CrawledPage = {
  url: string;
  text: string;
  html: string;
  matchupLinks: string[];
};

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, "wnba_raw.sqlite");
const PINNACLE_WNBA_URL = "https://www.pinnacle.com/en/basketball/wnba/matchups/";
const REGULAR_SEASON_TYPE = 2;
const PINNACLE_BOOK_KEY = "pinnacle";
const PINNACLE_BOOK_TITLE = "Pinnacle";

const TEAM_ALIASES = new Map<string, string>([
  ["atl", "atl"],
  ["atlanta", "atl"],
  ["atlanta dream", "atl"],
  ["chi", "chi"],
  ["chicago", "chi"],
  ["chicago sky", "chi"],
  ["con", "con"],
  ["connecticut", "con"],
  ["connecticut sun", "con"],
  ["dal", "dal"],
  ["dallas", "dal"],
  ["dallas wings", "dal"],
  ["gs", "gs"],
  ["golden state", "gs"],
  ["golden state valkyries", "gs"],
  ["ind", "ind"],
  ["indiana", "ind"],
  ["indiana fever", "ind"],
  ["la", "la"],
  ["los angeles", "la"],
  ["los angeles sparks", "la"],
  ["lv", "lv"],
  ["las vegas", "lv"],
  ["las vegas aces", "lv"],
  ["min", "min"],
  ["minnesota", "min"],
  ["minnesota lynx", "min"],
  ["ny", "ny"],
  ["new york", "ny"],
  ["new york liberty", "ny"],
  ["phx", "phx"],
  ["phoenix", "phx"],
  ["phoenix mercury", "phx"],
  ["por", "por"],
  ["portland", "por"],
  ["portland fire", "por"],
  ["sea", "sea"],
  ["seattle", "sea"],
  ["seattle storm", "sea"],
  ["tor", "tor"],
  ["toronto", "tor"],
  ["toronto tempo", "tor"],
  ["wsh", "wsh"],
  ["was", "wsh"],
  ["washington", "wsh"],
  ["washington mystics", "wsh"],
]);

function parseArgs(argv: string[]): Options {
  const options: Options = {
    dbPath: process.env.WNBA_RAW_DB ?? DEFAULT_DB_PATH,
    bookmaker: null,
    from: new Date().toISOString(),
    to: null,
    limit: 24,
    outPath: null,
    timeToleranceHours: 36,
    sourceUrl: process.env.PINNACLE_WNBA_URL ?? PINNACLE_WNBA_URL,
    headless: process.env.PINNACLE_HEADLESS !== "0",
    browserChannel: process.env.PINNACLE_BROWSER_CHANNEL ?? "chrome",
    minDelayMs: 5_000,
    maxDelayMs: 9_000,
    postNavigationDelayMs: 7_000,
    navigationTimeoutSecs: 60,
    debugDumpPath: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--db" && next) {
      options.dbPath = path.resolve(next);
      i += 1;
    } else if (arg === "--bookmaker" && next) {
      options.bookmaker = next;
      i += 1;
    } else if (arg === "--from" && next) {
      options.from = normalizeDate(next);
      i += 1;
    } else if (arg === "--to" && next) {
      options.to = normalizeDate(next);
      i += 1;
    } else if (arg === "--limit" && next) {
      options.limit = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--out" && next) {
      options.outPath = path.resolve(next);
      i += 1;
    } else if (arg === "--time-tolerance-hours" && next) {
      options.timeToleranceHours = Number.parseFloat(next);
      i += 1;
    } else if (arg === "--source-url" && next) {
      options.sourceUrl = next;
      i += 1;
    } else if (arg === "--headed") {
      options.headless = false;
    } else if (arg === "--headless") {
      options.headless = true;
    } else if (arg === "--browser-channel" && next) {
      options.browserChannel = next === "bundled" ? null : next;
      i += 1;
    } else if (arg === "--min-delay-ms" && next) {
      options.minDelayMs = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--max-delay-ms" && next) {
      options.maxDelayMs = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--post-navigation-delay-ms" && next) {
      options.postNavigationDelayMs = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--navigation-timeout-secs" && next) {
      options.navigationTimeoutSecs = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--debug-dump" && next) {
      options.debugDumpPath = path.resolve(next);
      i += 1;
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

  if (!Number.isFinite(options.timeToleranceHours) || options.timeToleranceHours <= 0) {
    throw new Error("--time-tolerance-hours must be positive");
  }

  if (!Number.isInteger(options.minDelayMs) || options.minDelayMs < 0) {
    throw new Error("--min-delay-ms must be a non-negative integer");
  }

  if (!Number.isInteger(options.maxDelayMs) || options.maxDelayMs < options.minDelayMs) {
    throw new Error("--max-delay-ms must be an integer greater than or equal to --min-delay-ms");
  }

  if (!Number.isInteger(options.postNavigationDelayMs) || options.postNavigationDelayMs < 0) {
    throw new Error("--post-navigation-delay-ms must be a non-negative integer");
  }

  if (!Number.isInteger(options.navigationTimeoutSecs) || options.navigationTimeoutSecs < 1) {
    throw new Error("--navigation-timeout-secs must be a positive integer");
  }

  return options;
}

function printHelp(): void {
  console.log(`Usage: pnpm run fetch:markets -- [options]

Options:
  --db <path>                  SQLite database path. Defaults to ${DEFAULT_DB_PATH}
  --source-url <url>           Pinnacle WNBA matchups URL. Defaults to ${PINNACLE_WNBA_URL}
  --bookmaker <key-or-title>   Keep compatibility with predictors; pinnacle is the only fetched book.
  --from <iso/date>            First local schedule tip time to match. Defaults to now.
  --to <iso/date>              Optional latest local schedule tip time to match.
  --limit <n>                  Number of local schedule games to match. Defaults to 24.
  --out <path>                 Also export matched consensus lines to a JSON file.
  --time-tolerance-hours <n>   Max start-time gap for matching. Defaults to 36.
  --headed                     Show the browser while Crawlee runs.
  --headless                   Force headless browser mode. This is the default.
  --browser-channel <name>     Playwright browser channel. Defaults to chrome; use bundled for Playwright-managed Chromium.
  --min-delay-ms <n>           Random polite delay before navigation. Defaults to 5000.
  --max-delay-ms <n>           Random polite delay upper bound before navigation. Defaults to 9000.
  --post-navigation-delay-ms <n> Wait after page load for odds hydration. Defaults to 7000.
  --navigation-timeout-secs <n> Browser navigation timeout. Defaults to 60.
  --debug-dump <path>          Save the rendered page text/html used by the scraper.
  -h, --help                   Show this help text.
`);
}

function ensureMarketSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS market_line_sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      sport TEXT NOT NULL,
      regions TEXT,
      bookmakers_requested TEXT,
      bookmaker_selected TEXT,
      markets TEXT NOT NULL,
      from_date TEXT NOT NULL,
      to_date TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      odds_events_seen INTEGER NOT NULL DEFAULT 0,
      local_games_seen INTEGER NOT NULL DEFAULT 0,
      local_games_matched INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS market_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      event_id TEXT NOT NULL,
      short_name TEXT NOT NULL,
      scheduled_date TEXT NOT NULL,
      source_event_id TEXT NOT NULL,
      source_commence_time TEXT NOT NULL,
      source_home_team TEXT NOT NULL,
      source_away_team TEXT NOT NULL,
      bookmaker_key TEXT NOT NULL,
      bookmaker_title TEXT NOT NULL,
      home_team TEXT NOT NULL,
      away_team TEXT NOT NULL,
      home_moneyline INTEGER NOT NULL,
      away_moneyline INTEGER NOT NULL,
      home_no_vig_probability REAL NOT NULL,
      away_no_vig_probability REAL NOT NULL,
      home_spread REAL,
      away_spread REAL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (run_id) REFERENCES market_line_sync_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_market_lines_event_run ON market_lines(event_id, run_id);
    CREATE INDEX IF NOT EXISTS idx_market_lines_bookmaker ON market_lines(bookmaker_key);
    CREATE INDEX IF NOT EXISTS idx_market_sync_runs_status ON market_line_sync_runs(status, id);
  `);
}

function normalizeDate(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${value}T00:00:00.000Z`;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Could not parse date: ${value}`);
  }

  return parsed.toISOString();
}

function loadScheduledGames(db: Database.Database, options: Options): ScheduledGame[] {
  const rows = db
    .prepare(
      `
      SELECT
        e.event_id AS eventId,
        e.date AS date,
        e.short_name AS shortName,
        COALESCE(home.team_abbreviation, home.team_short_display_name, home.team_display_name, home.team_id) AS homeTeam,
        COALESCE(away.team_abbreviation, away.team_short_display_name, away.team_display_name, away.team_id) AS awayTeam
      FROM espn_schedule_events e
      JOIN espn_schedule_competitors home ON home.event_id = e.event_id AND home.home_away = 'home'
      JOIN espn_schedule_competitors away ON away.event_id = e.event_id AND away.home_away = 'away'
      WHERE e.season_type = ?
        AND e.status_completed = 0
        AND e.date >= ?
        AND (? IS NULL OR e.date <= ?)
      ORDER BY e.date, e.event_id
      LIMIT ?
    `,
    )
    .all(REGULAR_SEASON_TYPE, options.from, options.to, options.to, options.limit) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    eventId: String(row.eventId),
    date: String(row.date),
    dateMs: Date.parse(String(row.date)),
    shortName: String(row.shortName),
    homeTeam: String(row.homeTeam),
    awayTeam: String(row.awayTeam),
  }));
}

async function fetchOdds(options: Options, scheduledGames: ScheduledGame[]): Promise<OddsEvent[]> {
  const listingPage = await crawlPinnaclePage(options.sourceUrl, options);
  const detailUrls = matchupDetailUrlsForGames(listingPage.matchupLinks, scheduledGames);
  const pages = [listingPage];

  for (const detailUrl of detailUrls) {
    pages.push(await crawlPinnaclePage(detailUrl, options));
  }

  writeDebugDump(options, pages);

  if (pages.every((page) => !page.text.trim())) {
    throw new Error("Pinnacle page rendered no body text; try --headed or --debug-dump to inspect the page.");
  }

  return scheduledGames
    .map((game) => pinnacleEventFromPages(game, pages))
    .filter((event): event is OddsEvent => event !== null);
}

async function crawlPinnaclePage(url: string, options: Options): Promise<CrawledPage> {
  let pageText = "";
  let pageHtml = "";
  let matchupLinks: string[] = [];

  const crawler = new PlaywrightCrawler({
    headless: options.headless,
    launchContext: {
      launchOptions: options.browserChannel ? { channel: options.browserChannel } : {},
    },
    maxConcurrency: 1,
    maxRequestsPerCrawl: 1,
    navigationTimeoutSecs: options.navigationTimeoutSecs,
    requestHandlerTimeoutSecs: options.navigationTimeoutSecs + 45,
    preNavigationHooks: [
      async () => {
        await sleep(randomInt(options.minDelayMs, options.maxDelayMs));
      },
    ],
    async requestHandler({ page }: { page: import("playwright").Page }) {
      await page.waitForLoadState("domcontentloaded");
      await sleep(options.postNavigationDelayMs);
      await page.evaluate(async () => {
        await new Promise<void>((resolve) => {
          let totalHeight = 0;
          const distance = 700;
          const timer = window.setInterval(() => {
            window.scrollBy(0, distance);
            totalHeight += distance;
            if (totalHeight >= document.body.scrollHeight) {
              window.clearInterval(timer);
              resolve();
            }
          }, 300);
        });
      });
      await sleep(1_000);
      pageText = await page.locator("body").innerText({ timeout: 10_000 });
      pageHtml = await page.content();
      matchupLinks = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/basketball/wnba/"][href*="-vs-"]'))
          .map((anchor) => anchor.href)
          .filter((href) => {
            const url = new URL(href);
            return url.pathname.includes("/basketball/wnba/");
          })
          .filter((href, index, values) => values.indexOf(href) === index),
      );
    },
  });

  await crawler.run([url]);
  return { url, text: pageText, html: pageHtml, matchupLinks };
}

function matchupDetailUrlsForGames(matchupLinks: string[], scheduledGames: ScheduledGame[]): string[] {
  const urls = new Set<string>();

  for (const game of scheduledGames) {
    const matched = matchupLinks.find((url) => urlMatchesGame(url, game));
    if (matched) {
      urls.add(matched);
    }
  }

  return [...urls];
}

function urlMatchesGame(url: string, game: ScheduledGame): boolean {
  const normalizedUrl = normalizeTeamName(url.replace(/https?:\/\/[^/]+/i, " "));
  return teamVariants(game.homeTeam).some((variant) => normalizedUrl.includes(normalizeTeamName(variant))) &&
    teamVariants(game.awayTeam).some((variant) => normalizedUrl.includes(normalizeTeamName(variant)));
}

function pinnacleEventFromPages(game: ScheduledGame, pages: CrawledPage[]): OddsEvent | null {
  const detailPage = pages.find((page) => page.url.includes("-vs-") && urlMatchesGame(page.url, game));
  const candidatePages = detailPage ? [detailPage, ...pages.filter((page) => page !== detailPage)] : pages;

  for (const page of candidatePages) {
    const event = pinnacleEventFromPageText(game, page.text, page.url);
    if (event) {
      return event;
    }
  }

  return null;
}

function pinnacleEventFromPageText(game: ScheduledGame, pageText: string, sourceUrl: string): OddsEvent | null {
  const windowText = textWindowForGame(pageText, game);
  if (!windowText) {
    return null;
  }

  const moneyline = extractMoneyline(windowText, game);
  if (!moneyline) {
    return null;
  }

  const spread = extractSpread(windowText, game);

  return {
    id: `${PINNACLE_BOOK_KEY}:${game.eventId}`,
    commence_time: game.date,
    home_team: game.homeTeam,
    away_team: game.awayTeam,
    bookmakers: [
      {
        key: PINNACLE_BOOK_KEY,
        title: PINNACLE_BOOK_TITLE,
        markets: [
          {
            key: "h2h",
            outcomes: [
              { name: game.homeTeam, price: moneyline.home },
              { name: game.awayTeam, price: moneyline.away },
            ],
          },
          {
            key: "spreads",
            outcomes:
              spread === null
                ? []
                : [
                    { name: game.homeTeam, price: spread.homePrice, point: spread.homePoint },
                    { name: game.awayTeam, price: spread.awayPrice, point: spread.awayPoint },
                  ],
          },
        ],
      },
    ],
  };
}

function textWindowForGame(pageText: string, game: ScheduledGame): string | null {
  const normalizedText = normalizeTeamName(pageText);
  const homeIndex = firstVariantIndex(normalizedText, teamVariants(game.homeTeam));
  const awayIndex = firstVariantIndex(normalizedText, teamVariants(game.awayTeam));

  if (homeIndex < 0 || awayIndex < 0) {
    return null;
  }

  const start = Math.max(0, Math.min(homeIndex, awayIndex) - 1_500);
  const end = Math.min(pageText.length, Math.max(homeIndex, awayIndex) + 3_500);
  return pageText.slice(start, end);
}

function firstVariantIndex(text: string, variants: string[]): number {
  const indexes = variants.map((variant) => text.indexOf(normalizeTeamName(variant))).filter((index) => index >= 0);
  return indexes.length === 0 ? -1 : Math.min(...indexes);
}

function extractMoneyline(text: string, game: ScheduledGame): { home: number; away: number } | null {
  const gameMoneylineSection = marketSection(text, /Money Line\s+[–-]\s+Game/i, /(?:Handicap|Total|Team Total|Money Line\s+[–-]\s+1st Half)/i);
  if (gameMoneylineSection) {
    const sectionMoneyline = extractMoneylineFromSection(gameMoneylineSection, game);
    if (sectionMoneyline) {
      return sectionMoneyline;
    }
  }

  return extractMoneylineFromSection(text, game);
}

function extractMoneylineFromSection(text: string, game: ScheduledGame): { home: number; away: number } | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const homeLine = firstLineIndex(lines, teamVariants(game.homeTeam));
  const awayLine = firstLineIndex(lines, teamVariants(game.awayTeam));

  if (homeLine >= 0 && awayLine >= 0) {
    const home = firstOddAfter(lines, homeLine, awayLine);
    const away = firstOddAfter(lines, awayLine, homeLine);
    if (home !== null && away !== null) {
      return { home, away };
    }
  }

  const odds = oddsTokens(text).map((token) => parseOddsToken(token)).filter((value): value is number => value !== null);
  return odds.length >= 2 ? { away: odds[0], home: odds[1] } : null;
}

function extractSpread(
  text: string,
  game: ScheduledGame,
): { homePoint: number; awayPoint: number; homePrice: number; awayPrice: number } | null {
  const gameSpreadSection = marketSection(text, /Handicap\s+[–-]\s+Game/i, /(?:Total|Team Total|Money Line\s+[–-]\s+1st Half|Handicap\s+[–-]\s+1st Half)/i);
  const sourceText = gameSpreadSection ?? text;
  const sectionLines = sourceText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const homeMatch = firstLineMatch(sectionLines, teamVariants(game.homeTeam));
  const awayMatch = firstLineMatch(sectionLines, teamVariants(game.awayTeam));
  const homeLine = homeMatch?.line ?? -1;
  const awayLine = awayMatch?.line ?? -1;

  if (homeLine < 0 || awayLine < 0) {
    return null;
  }

  const orderedTeamLines = [
    { side: "home" as const, index: homeLine, column: homeMatch?.column ?? 0 },
    { side: "away" as const, index: awayLine, column: awayMatch?.column ?? 0 },
  ].sort((left, right) => left.index - right.index || left.column - right.column);
  const orderedPairs = spreadPairsAfter(sectionLines, Math.max(homeLine, awayLine) + 1);
  if (orderedPairs.length >= 2) {
    const bySide = new Map<"home" | "away", { point: number; price: number }>([
      [orderedTeamLines[0].side, orderedPairs[0]],
      [orderedTeamLines[1].side, orderedPairs[1]],
    ]);
    const home = bySide.get("home");
    const away = bySide.get("away");
    if (home && away) {
      return {
        homePoint: home.point,
        awayPoint: away.point,
        homePrice: home.price,
        awayPrice: away.price,
      };
    }
  }

  const homeSpread = firstSpreadAfter(sectionLines, homeLine, awayLine);
  const awaySpread = firstSpreadAfter(sectionLines, awayLine, homeLine);
  if (!homeSpread || !awaySpread) {
    return null;
  }

  return {
    homePoint: homeSpread.point,
    awayPoint: awaySpread.point,
    homePrice: homeSpread.price,
    awayPrice: awaySpread.price,
  };
}

function marketSection(text: string, startsWith: RegExp, endsWith: RegExp): string | null {
  const start = text.search(startsWith);
  if (start < 0) {
    return null;
  }

  const rest = text.slice(start);
  const end = rest.slice(1).search(endsWith);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

function firstLineIndex(lines: string[], variants: string[]): number {
  return firstLineMatch(lines, variants)?.line ?? -1;
}

function firstLineMatch(lines: string[], variants: string[]): { line: number; column: number } | null {
  for (let i = 0; i < lines.length; i += 1) {
    const normalized = normalizeTeamName(lines[i]);
    const columns = variants
      .map((variant) => normalized.indexOf(normalizeTeamName(variant)))
      .filter((column) => column >= 0);
    if (columns.length > 0) {
      return { line: i, column: Math.min(...columns) };
    }
  }

  return null;
}

function firstOddAfter(lines: string[], teamLine: number, otherTeamLine: number): number | null {
  const start = teamLine + 1;
  const end = Math.min(lines.length, Math.max(start + 12, otherTeamLine > teamLine ? otherTeamLine : start + 12));
  for (let i = start; i < end; i += 1) {
    const odd = parseOddsToken(lines[i]);
    if (odd !== null) {
      return odd;
    }
  }

  return null;
}

function firstSpreadAfter(lines: string[], teamLine: number, otherTeamLine: number): { point: number; price: number } | null {
  const start = teamLine + 1;
  const end = Math.min(lines.length, Math.max(start + 12, otherTeamLine > teamLine ? otherTeamLine : start + 12));
  for (let i = start; i < end - 1; i += 1) {
    const point = parseSpreadPoint(lines[i]);
    const price = parseOddsToken(lines[i + 1]);
    if (point !== null && price !== null) {
      return { point, price };
    }
  }

  return null;
}

function spreadPairsAfter(lines: string[], start: number): Array<{ point: number; price: number }> {
  const pairs: Array<{ point: number; price: number }> = [];
  for (let i = start; i < lines.length - 1; i += 1) {
    const point = parseSpreadPoint(lines[i]);
    const price = parseOddsToken(lines[i + 1]);
    if (point !== null && price !== null) {
      pairs.push({ point, price });
      i += 1;
    }
  }

  return pairs;
}

function oddsTokens(text: string): string[] {
  return text.match(/(?:[+-]\d{3,4})|(?:\b\d+\.\d{2,3}\b)/g) ?? [];
}

function parseOddsToken(value: string): number | null {
  const token = value.replace(/\s/g, "");
  if (/^[+-]\d{3,4}$/.test(token)) {
    return Number.parseInt(token, 10);
  }

  if (/^\d+\.\d{2,3}$/.test(token)) {
    const decimal = Number.parseFloat(token);
    if (decimal > 1 && decimal <= 25) {
      return decimalOddsToAmerican(decimal);
    }
  }

  return null;
}

function parseSpreadPoint(value: string): number | null {
  const token = value.replace(/\s/g, "");
  if (!/^[+-]\d{1,2}(?:\.\d)?$/.test(token)) {
    return null;
  }

  const point = Number.parseFloat(token);
  return Math.abs(point) <= 60 ? point : null;
}

function decimalOddsToAmerican(decimal: number): number {
  const raw = decimal >= 2 ? (decimal - 1) * 100 : -100 / (decimal - 1);
  return Math.round(raw);
}

function teamVariants(team: string): string[] {
  const token = teamToken(team);
  const variantsByToken = new Map<string, string[]>([
    ["atl", ["ATL", "Atlanta", "Atlanta Dream"]],
    ["chi", ["CHI", "Chicago", "Chicago Sky"]],
    ["con", ["CON", "Connecticut", "Connecticut Sun"]],
    ["dal", ["DAL", "Dallas", "Dallas Wings"]],
    ["gs", ["GS", "Golden State", "Golden State Valkyries"]],
    ["ind", ["IND", "Indiana", "Indiana Fever"]],
    ["la", ["LA", "Los Angeles", "Los Angeles Sparks"]],
    ["lv", ["LV", "Las Vegas", "Las Vegas Aces"]],
    ["min", ["MIN", "Minnesota", "Minnesota Lynx"]],
    ["ny", ["NY", "New York", "New York Liberty"]],
    ["phx", ["PHX", "Phoenix", "Phoenix Mercury"]],
    ["por", ["POR", "Portland", "Portland Fire"]],
    ["sea", ["SEA", "Seattle", "Seattle Storm"]],
    ["tor", ["TOR", "Toronto", "Toronto Tempo"]],
    ["wsh", ["WSH", "WAS", "Washington", "Washington Mystics"]],
  ]);

  return [team, ...(variantsByToken.get(token) ?? [])];
}

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function writeDebugDump(options: Options, pages: CrawledPage[]): void {
  if (!options.debugDumpPath) {
    return;
  }

  mkdirSync(path.dirname(options.debugDumpPath), { recursive: true });
  writeFileSync(
    options.debugDumpPath,
    JSON.stringify(
      {
        sourceUrl: options.sourceUrl,
        fetchedAt: new Date().toISOString(),
        pages,
      },
      null,
      2,
    ),
    "utf8",
  );
}

function buildMarketOutputs(
  scheduledGames: ScheduledGame[],
  oddsEvents: OddsEvent[],
  options: Options,
): { matches: MatchedMarket[]; unmatched: ScheduledGame[] } {
  const matches: MatchedMarket[] = [];
  const unmatched: ScheduledGame[] = [];
  const toleranceMs = options.timeToleranceHours * 60 * 60 * 1000;

  for (const game of scheduledGames) {
    const oddsEvent = bestOddsMatch(game, oddsEvents, toleranceMs);
    if (!oddsEvent) {
      unmatched.push(game);
      continue;
    }

    const lines = linesForEvent(oddsEvent, game);
    const selectedLines = options.bookmaker ? lines.filter((line) => bookmakerMatches(line, options.bookmaker ?? "")) : lines;
    if (selectedLines.length === 0) {
      unmatched.push(game);
      continue;
    }

    const matchedLines = options.bookmaker ? [selectedLines[0]] : selectedLines;
    matches.push({
      game,
      oddsEvent,
      lines: matchedLines,
      output: marketOutputFromLines(game, oddsEvent, matchedLines),
    });
  }

  return { matches, unmatched };
}

function bestOddsMatch(game: ScheduledGame, oddsEvents: OddsEvent[], toleranceMs: number): OddsEvent | null {
  const matches = oddsEvents
    .filter((event) => sameTeam(event.home_team, game.homeTeam) && sameTeam(event.away_team, game.awayTeam))
    .map((event) => ({ event, timeDiff: Math.abs(Date.parse(event.commence_time) - game.dateMs) }))
    .filter((match) => Number.isFinite(match.timeDiff) && match.timeDiff <= toleranceMs)
    .sort((a, b) => a.timeDiff - b.timeDiff);

  return matches[0]?.event ?? null;
}

function linesForEvent(event: OddsEvent, game: ScheduledGame): BookLine[] {
  const lines: BookLine[] = [];

  for (const bookmaker of event.bookmakers) {
    const h2h = bookmaker.markets.find((market) => market.key === "h2h");
    const spreads = bookmaker.markets.find((market) => market.key === "spreads");
    const homeMoneyline = outcomeForTeam(h2h, game.homeTeam)?.price;
    const awayMoneyline = outcomeForTeam(h2h, game.awayTeam)?.price;

    if (homeMoneyline === undefined || awayMoneyline === undefined) {
      continue;
    }

    const homeRawProbability = americanOddsImpliedProbability(homeMoneyline);
    const awayRawProbability = americanOddsImpliedProbability(awayMoneyline);
    const noVig = normalizeTwoWayProbability(homeRawProbability, awayRawProbability);
    const normalizedSpreads = normalizeSpreadPair(
      outcomeForTeam(spreads, game.homeTeam)?.point ?? null,
      outcomeForTeam(spreads, game.awayTeam)?.point ?? null,
      homeMoneyline,
      awayMoneyline,
    );

    lines.push({
      bookmakerKey: bookmaker.key,
      bookmakerTitle: bookmaker.title,
      homeMoneyline,
      awayMoneyline,
      homeNoVigProbability: noVig.home,
      awayNoVigProbability: noVig.away,
      homeSpread: normalizedSpreads.home,
      awaySpread: normalizedSpreads.away,
    });
  }

  return lines;
}

function normalizeSpreadPair(
  homeSpread: number | null,
  awaySpread: number | null,
  homeMoneyline: number,
  awayMoneyline: number,
): { home: number | null; away: number | null } {
  if (homeSpread === null && awaySpread === null) {
    return { home: null, away: null };
  }

  if (homeSpread !== null && awaySpread === null) {
    return { home: homeSpread, away: -homeSpread };
  }

  if (homeSpread === null && awaySpread !== null) {
    return { home: -awaySpread, away: awaySpread };
  }

  const home = homeSpread ?? 0;
  const away = awaySpread ?? 0;
  const sameMagnitude = Math.abs(Math.abs(home) - Math.abs(away)) < 0.001;
  if (!sameMagnitude) {
    return { home, away };
  }

  const homeIsFavored = homeMoneyline < awayMoneyline;
  if (homeIsFavored) {
    return { home: -Math.abs(home), away: Math.abs(away) };
  }

  if (awayMoneyline < homeMoneyline) {
    return { home: Math.abs(home), away: -Math.abs(away) };
  }

  if (Math.abs(home + away) < 0.001) {
    return { home, away };
  }

  return { home, away: -home };
}

function outcomeForTeam(market: OddsMarket | undefined, team: string): OddsOutcome | undefined {
  return market?.outcomes.find((outcome) => sameTeam(outcome.name, team));
}

function marketOutputFromLines(game: ScheduledGame, oddsEvent: OddsEvent, lines: BookLine[]): MarketOutput {
  const homeImpliedProbability = average(lines.map((line) => line.homeNoVigProbability));
  const awayImpliedProbability = average(lines.map((line) => line.awayNoVigProbability));
  const homeSpreads = lines.map((line) => line.homeSpread).filter((value): value is number => value !== null);
  const awaySpreads = lines.map((line) => line.awaySpread).filter((value): value is number => value !== null);
  const singleLine = lines.length === 1 ? lines[0] : null;

  const output: MarketOutput = {
    eventId: game.eventId,
    shortName: game.shortName,
    homeTeam: game.homeTeam,
    awayTeam: game.awayTeam,
    homeImpliedProbability: round(homeImpliedProbability, 6),
    awayImpliedProbability: round(awayImpliedProbability, 6),
    book: singleLine ? singleLine.bookmakerTitle : `consensus (${lines.length} books)`,
    note: `Pinnacle event ${oddsEvent.id}; ${oddsEvent.away_team} @ ${oddsEvent.home_team}; fetched ${new Date().toISOString()}`,
  };

  if (singleLine) {
    output.homeMoneyline = singleLine.homeMoneyline;
    output.awayMoneyline = singleLine.awayMoneyline;
  }

  if (homeSpreads.length > 0) {
    output.homeSpread = round(average(homeSpreads), 2);
  }

  if (awaySpreads.length > 0) {
    output.awaySpread = round(average(awaySpreads), 2);
  }

  return output;
}

function bookmakerMatches(line: BookLine, requested: string): boolean {
  const target = normalizeBookmaker(requested);
  return normalizeBookmaker(line.bookmakerKey) === target || normalizeBookmaker(line.bookmakerTitle) === target;
}

function normalizeBookmaker(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sameTeam(left: string, right: string): boolean {
  return teamToken(left) === teamToken(right);
}

function teamToken(value: string): string {
  const normalized = normalizeTeamName(value);
  return TEAM_ALIASES.get(normalized) ?? normalized;
}

function normalizeTeamName(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\bthe\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function americanOddsImpliedProbability(odds: number): number {
  if (!Number.isFinite(odds) || odds === 0) {
    throw new Error(`Invalid American odds: ${odds}`);
  }

  return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
}

function normalizeTwoWayProbability(home: number, away: number): { home: number; away: number } {
  const total = home + away;
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error("Cannot normalize market probabilities with a non-positive total");
  }

  return { home: home / total, away: away / total };
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function writeMarketFile(outputs: MarketOutput[], options: Options): void {
  if (!options.outPath) {
    return;
  }

  mkdirSync(path.dirname(options.outPath), { recursive: true });
  writeFileSync(options.outPath, `${JSON.stringify(outputs, null, 2)}\n`, "utf8");
}

function persistMarketLines(
  db: Database.Database,
  options: Options,
  scheduledGames: ScheduledGame[],
  oddsEvents: OddsEvent[],
  matches: MatchedMarket[],
  startedAt: string,
): number {
  const insertRun = db.prepare(`
    INSERT INTO market_line_sync_runs (
      source, sport, regions, bookmakers_requested, bookmaker_selected, markets,
      from_date, to_date, started_at, finished_at, odds_events_seen,
      local_games_seen, local_games_matched, status, error
    )
    VALUES (
      @source, @sport, @regions, @bookmakersRequested, @bookmakerSelected, @markets,
      @fromDate, @toDate, @startedAt, @finishedAt, @oddsEventsSeen,
      @localGamesSeen, @localGamesMatched, @status, @error
    )
  `);
  const insertLine = db.prepare(`
    INSERT INTO market_lines (
      run_id, event_id, short_name, scheduled_date, source_event_id,
      source_commence_time, source_home_team, source_away_team,
      bookmaker_key, bookmaker_title, home_team, away_team,
      home_moneyline, away_moneyline, home_no_vig_probability,
      away_no_vig_probability, home_spread, away_spread
    )
    VALUES (
      @runId, @eventId, @shortName, @scheduledDate, @sourceEventId,
      @sourceCommenceTime, @sourceHomeTeam, @sourceAwayTeam,
      @bookmakerKey, @bookmakerTitle, @homeTeam, @awayTeam,
      @homeMoneyline, @awayMoneyline, @homeNoVigProbability,
      @awayNoVigProbability, @homeSpread, @awaySpread
    )
  `);

  const transaction = db.transaction(() => {
    const run = insertRun.run({
      source: "pinnacle-sportsbook",
      sport: "basketball_wnba",
      regions: null,
      bookmakersRequested: PINNACLE_BOOK_KEY,
      bookmakerSelected: options.bookmaker,
      markets: "h2h,spreads",
      fromDate: options.from,
      toDate: options.to,
      startedAt,
      finishedAt: new Date().toISOString(),
      oddsEventsSeen: oddsEvents.length,
      localGamesSeen: scheduledGames.length,
      localGamesMatched: matches.length,
      status: "success",
      error: null,
    });
    const runId = Number(run.lastInsertRowid);

    for (const match of matches) {
      for (const line of match.lines) {
        insertLine.run({
          runId,
          eventId: match.game.eventId,
          shortName: match.game.shortName,
          scheduledDate: match.game.date,
          sourceEventId: match.oddsEvent.id,
          sourceCommenceTime: match.oddsEvent.commence_time,
          sourceHomeTeam: match.oddsEvent.home_team,
          sourceAwayTeam: match.oddsEvent.away_team,
          bookmakerKey: line.bookmakerKey,
          bookmakerTitle: line.bookmakerTitle,
          homeTeam: match.game.homeTeam,
          awayTeam: match.game.awayTeam,
          homeMoneyline: line.homeMoneyline,
          awayMoneyline: line.awayMoneyline,
          homeNoVigProbability: line.homeNoVigProbability,
          awayNoVigProbability: line.awayNoVigProbability,
          homeSpread: line.homeSpread,
          awaySpread: line.awaySpread,
        });
      }
    }

    return runId;
  });

  return transaction();
}

function persistFailedMarketRun(
  db: Database.Database,
  options: Options,
  scheduledGamesSeen: number,
  startedAt: string,
  error: unknown,
): number {
  const result = db
    .prepare(
      `
      INSERT INTO market_line_sync_runs (
        source, sport, regions, bookmakers_requested, bookmaker_selected, markets,
        from_date, to_date, started_at, finished_at, odds_events_seen,
        local_games_seen, local_games_matched, status, error
      )
      VALUES (
        @source, @sport, @regions, @bookmakersRequested, @bookmakerSelected, @markets,
        @fromDate, @toDate, @startedAt, @finishedAt, @oddsEventsSeen,
        @localGamesSeen, @localGamesMatched, @status, @error
      )
    `,
    )
    .run({
      source: "pinnacle-sportsbook",
      sport: "basketball_wnba",
      regions: null,
      bookmakersRequested: PINNACLE_BOOK_KEY,
      bookmakerSelected: options.bookmaker,
      markets: "h2h,spreads",
      fromDate: options.from,
      toDate: options.to,
      startedAt,
      finishedAt: new Date().toISOString(),
      oddsEventsSeen: 0,
      localGamesSeen: scheduledGamesSeen,
      localGamesMatched: 0,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });

  return Number(result.lastInsertRowid);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const db = new Database(options.dbPath, { fileMustExist: true });
  let scheduledGamesSeen = 0;

  try {
    ensureMarketSchema(db);
    const scheduledGames = loadScheduledGames(db, options);
    scheduledGamesSeen = scheduledGames.length;
    if (scheduledGames.length === 0) {
      console.log(`No upcoming ESPN schedule games found from ${options.from}`);
      return;
    }

    const oddsEvents = await fetchOdds(options, scheduledGames);
    const { matches, unmatched } = buildMarketOutputs(scheduledGames, oddsEvents, options);
    const outputs = matches.map((match) => match.output);
    const runId = persistMarketLines(db, options, scheduledGames, oddsEvents, matches, startedAt);
    writeMarketFile(outputs, options);

    console.log(`Fetched ${oddsEvents.length} odds events from Pinnacle.`);
    console.log(`Matched ${matches.length} of ${scheduledGames.length} local scheduled games.`);
    console.log(`Stored ${matches.reduce((sum, match) => sum + match.lines.length, 0)} bookmaker lines in market_line_sync_runs.id=${runId}.`);

    if (options.outPath) {
      console.log(`Wrote market file: ${options.outPath}`);
    }

    if (unmatched.length > 0) {
      console.log("");
      console.log("Unmatched local games:");
      for (const game of unmatched) {
        console.log(`- ${game.shortName} ${game.date}`);
      }
    }
  } catch (error) {
    const runId = persistFailedMarketRun(db, options, scheduledGamesSeen, startedAt, error);
    console.error(`Stored failed market sync in market_line_sync_runs.id=${runId}.`);
    throw error;
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
