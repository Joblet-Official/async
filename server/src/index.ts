// ============================================================================
// Async Job Search (XML Feed, SQLite)
//
// This server syncs job data from an XML feed into a local SQLite database,
// allowing fast full-text searching (FTS5) with low memory usage.
// ============================================================================

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { DatabaseSync } from "node:sqlite";
import { XMLParser } from "fast-xml-parser";
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Async XML feed URL (override with ASYNC_FEED_URL in the environment).
const FEED_URL =
  process.env.ASYNC_FEED_URL ||
  "https://joveo-outbound-feeds-prod.s3-accelerate.amazonaws.com/joveo-8bc66f8d/2ac1d33f.xml?user=joveotest";

// Apply/redirect link host to lock the feed to (e.g. "xxxx.jometer.com").
// Once you have the feed, set ASYNC_APPLY_HOST so only that host is accepted.
// While empty, any https:// apply URL is accepted (fine for local testing).
const APPLY_URL_HOST = (process.env.ASYNC_APPLY_HOST || "tnl2.jometer.com").trim();

// Public domain the widget is served from (used for the ChatGPT App CSP).
const WIDGET_DOMAIN = process.env.ASYNC_WIDGET_DOMAIN || "https://async-0vu1.onrender.com";

// How often to re-download the feed and refresh the table (default 1 hour).
const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS || 60 * 60 * 1000);

// Feed download timeout. Large feeds (100 MB+) need a generous window.
const FEED_FETCH_TIMEOUT_MS = Number(process.env.FEED_FETCH_TIMEOUT_MS || 600000);

// Where the SQLite file lives. Use ":memory:" to keep it in RAM instead.
const DB_PATH = process.env.SQLITE_DB_PATH || path.join(__dirname, "..", "..", "data", "jobs.db");

// ChatGPT uses the resource URI as the widget cache key. Bump this version
// whenever the widget HTML or resource metadata changes.
const WIDGET_URI = "ui://async/job-cards-v3.html";

const REDIRECT_DOMAINS = [
  ...(APPLY_URL_HOST ? ["https://" + APPLY_URL_HOST] : [])
];

// ----------------------------------------------------
// Database setup
// ----------------------------------------------------
if (DB_PATH !== ":memory:") {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id            TEXT PRIMARY KEY,
    title         TEXT,
    company       TEXT,
    workplace     TEXT,
    city          TEXT,
    state         TEXT,
    country       TEXT,
    postcode      TEXT,
    type          TEXT,
    contractType  TEXT,
    salary        TEXT,
    hours         TEXT,
    summary       TEXT,
    url           TEXT,
    category      TEXT,
    location      TEXT,
    search_blob   TEXT,
    loc_blob      TEXT
  );
`);

// Full-text search index over title, company, category, summary, and location
// (external content = the jobs table, so no data is duplicated). Rebuilt after
// every sync. Weighted ranking ensures title matches surface first.
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS jobs_fts
  USING fts5(title, company, category, summary, location, content='jobs', content_rowid='rowid');
`);

// ----------------------------------------------------
// Feed parsing helpers
// ----------------------------------------------------
const xmlParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
});

function normalizeType(raw: unknown): string {
  const key = String(raw ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  const map: Record<string, string> = {
    FULLTIME: "Full-time",
    PARTTIME: "Part-time",
    PERM: "Permanent",
    PERMANENT: "Permanent",
    CONTRACT: "Contract",
    CONTRACTTOHIRE: "Contract to Hire",
    TEMPORARY: "Temporary",
    TEMP: "Temporary",
    INTERN: "Internship",
    INTERNSHIP: "Internship",
  };
  // Only report a job type the feed actually provides — never invent one.
  return map[key] || (raw ? String(raw) : "");
}

function stripHtml(html: unknown): string {
  return String(html ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\*\*/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function summarize(html: unknown, max = 220): string {
  const text = stripHtml(html);
  if (text.length <= max) return text;
  return text.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

interface Row {
  id: string; title: string; company: string; workplace: string;
  city: string; state: string; country: string; postcode: string;
  type: string; contractType: string; salary: string; hours: string;
  summary: string; url: string; category: string;
  location: string; search_blob: string; loc_blob: string;
}

function formatSalary(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  // Feed format: "GBP 30368-30368 ANNUALLY" or "GBP 13.95-13.95 HOURLY"
  const m = s.match(/^([A-Z]{3})\s+([\d.]+)-([\d.]+)\s+(\w+)$/i);
  if (!m) return s;
  const [, currency, low, high, period] = m;
  const lo = parseFloat(low);
  const hi = parseFloat(high);
  const periodLabel = period.charAt(0).toUpperCase() + period.slice(1).toLowerCase();
  if (lo === hi) return `${currency} ${lo.toLocaleString("en-GB")} ${periodLabel}`;
  return `${currency} ${lo.toLocaleString("en-GB")} - ${hi.toLocaleString("en-GB")} ${periodLabel}`;
}

function normalizeCountry(raw: unknown): string {
  const value = str(raw);
  if (/^(us|usa|united states|united states of america)$/i.test(value)) {
    return "United States";
  }
  return value;
}

// ----------------------------------------------------
// Content exclusion
// ----------------------------------------------------
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const DEFAULT_EXCLUDE_TERMS = [
  "casino",
  "gambling",
  "gambler",
  "wager",
  "wagering",
  "betting",
  "sportsbook",
  "sports book",
  "poker",
  "roulette",
  "blackjack",
  "slots machine",
  "igaming",
  "i-gaming",
];

const EXCLUDE_TERMS =
  process.env.ASYNC_EXCLUDE_TERMS !== undefined
    ? process.env.ASYNC_EXCLUDE_TERMS.split(",").map((t) => t.trim()).filter(Boolean)
    : DEFAULT_EXCLUDE_TERMS;

const EXCLUDE_RE = EXCLUDE_TERMS.length
  ? new RegExp(`\\b(${EXCLUDE_TERMS.map(escapeRegExp).join("|")})\\b`, "i")
  : null;

function isExcludedJob(j: any): boolean {
  if (!EXCLUDE_RE) return false;
  const haystack = `${str(j.title)} ${str(j.company)} ${str(j.category)} ${stripHtml(j.description)}`;
  return EXCLUDE_RE.test(haystack);
}

// ----------------------------------------------------
// Deduplication
// ----------------------------------------------------
function baseRef(ref: string): string {
  return ref.replace(/-expVer-\d+$/i, "");
}

function isCanonicalRef(ref: string): boolean {
  return !!ref && !/-expVer-\d+$/i.test(ref);
}

function titleLocation(title: string): { city: string; state: string } | null {
  const m = title.match(/\(([A-Za-zÀ-ÿ .'’-]+),\s*([A-Za-z]{2})\)\s*$/);
  if (!m) return null;
  const code = m[2].toUpperCase();
  if (!VALID_STATE_CODES.has(code)) return null;
  return { city: m[1].trim(), state: code };
}

function mapGroup(baseKey: string, group: any[]): Row {
  const canonical = group.find((j) => isCanonicalRef(str(j.referencenumber)));
  const rep = canonical ?? group[0];

  const title = str(rep.title) || "Open Position";
  const company = str(rep.company) || str(rep.advertiser);
  const category = str(rep.category);
  const workplace = str(rep.location);

  let city = "", state = "", country = "", postcode = "";
  const locSource = canonical ?? null;
  if (locSource) {
    city = str(locSource.city);
    state = str(locSource.state);
    country = normalizeCountry(locSource.country);
    postcode = str(locSource.postalcode);
  } else {
    const t = titleLocation(title);
    if (t) { city = t.city; state = t.state; country = "United States"; }
  }
  const url = str((canonical ?? rep).url);
  const location = [city, state, country].filter(Boolean).join(", ");

  const area = new Set<string>();
  const add = (v: string) => { if (v) area.add(v.toLowerCase()); };
  for (const j of group) {
    add(str(j.city));
    const st = str(j.state);
    add(st);
    add(stateSearchAliases(st));
    add(normalizeCountry(j.country));
    add(str(j.postalcode));
  }
  add(city); add(state); add(stateSearchAliases(state)); add(country);

  return {
    id: baseKey,
    title,
    company,
    workplace,
    city, state, country, postcode,
    type: normalizeType(rep.type),
    contractType: str(rep.contractType),
    salary: formatSalary(rep.salary),
    hours: str(rep.hours),
    summary: summarize(rep.description),
    url,
    category,
    location,
    search_blob: `${title} ${company} ${category}`.toLowerCase(),
    loc_blob: [...area].join(" ").replace(/[^a-z0-9]+/gi, " ").replace(/\s+/g, " ").trim(),
  };
}

// ----------------------------------------------------
// Sync: download feed → replace table contents
// ----------------------------------------------------
let lastSync = 0;
let syncing = false;

async function syncFeed(): Promise<number> {
  const getJobCount = () => {
    const row = db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number } | undefined;
    return row ? row.n : 0;
  };
  if (syncing) return getJobCount();
  syncing = true;
  try {
    db.exec("DROP TABLE IF EXISTS jobs_raw");
    db.exec(`
      CREATE TABLE jobs_raw (
        base_ref TEXT, referencenumber TEXT, title TEXT, company TEXT, advertiser TEXT,
        category TEXT, location TEXT, city TEXT, state TEXT, country TEXT, postalcode TEXT,
        url TEXT, type TEXT, contractType TEXT, salary TEXT, hours TEXT, description TEXT
      );
    `);
    const insertRawStmt = db.prepare(`
      INSERT INTO jobs_raw (base_ref, referencenumber, title, company, advertiser, category, location, city, state, country, postalcode, url, type, contractType, salary, hours, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let rawCount = 0;
    let inRawTx = false;
    const RAW_BATCH = 1000;

    const handleJobXml = (jobXml: string) => {
      let j: any;
      try {
        const parsedJob: any = xmlParser.parse(jobXml);
        j = parsedJob?.job ?? parsedJob;
      } catch {
        return;
      }
      if (!j || typeof j !== "object") return;
      if (isExcludedJob(j)) return;
      const ref = str(j.referencenumber);
      const key = ref ? baseRef(ref) : `${str(j.title)}|${str(j.url)}`.slice(0, 200);
      if (!key) return;
      if (!inRawTx) { db.exec("BEGIN"); inRawTx = true; }
      insertRawStmt.run(
        key, str(j.referencenumber), str(j.title), str(j.company), str(j.advertiser),
        str(j.category), str(j.location), str(j.city), str(j.state), str(j.country), str(j.postalcode),
        str(j.url), str(j.type), str(j.contractType), str(j.salary), str(j.hours), str(j.description)
      );
      rawCount++;
      if (rawCount % RAW_BATCH === 0) { db.exec("COMMIT"); inRawTx = false; }
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FEED_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(FEED_URL, {
        headers: { "Accept": "application/xml, text/xml, */*" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Feed fetch error: ${response.status}`);
      const body = response.body;
      if (!body) throw new Error("Feed response has no body");

      const size = Number(response.headers.get("content-length"));
      const maxFeedMb = Number(process.env.MAX_FEED_MB || 2048);
      if (size && size > maxFeedMb * 1024 * 1024) {
        throw new Error(`Feed size exceeds ${maxFeedMb}MB limit`);
      }

      const findJobOpen = (s: string, from: number): number => {
        let i = from;
        while (true) {
          const idx = s.indexOf("<job", i);
          if (idx === -1) return -1;
          const c = s.charAt(idx + 4);
          if (c === ">" || c === " " || c === "\t" || c === "\n" || c === "\r" || c === "/") return idx;
          i = idx + 4;
        }
      };

      const CLOSE = "</job>";
      let buffer = "";
      const drain = () => {
        while (true) {
          const open = findJobOpen(buffer, 0);
          if (open === -1) {
            if (buffer.length > 4096) buffer = buffer.slice(-16);
            break;
          }
          const close = buffer.indexOf(CLOSE, open);
          if (close === -1) {
            if (open > 0) buffer = buffer.slice(open);
            break;
          }
          const jobXml = buffer.slice(open, close + CLOSE.length);
          buffer = buffer.slice(close + CLOSE.length);
          handleJobXml(jobXml);
        }
      };

      const reader = body.getReader();
      const decoder = new TextDecoder("utf-8");
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) { buffer += decoder.decode(value, { stream: true }); drain(); }
      }
      buffer += decoder.decode();
      drain();

      if (inRawTx) { db.exec("COMMIT"); inRawTx = false; }
    } catch (e) {
      if (inRawTx) { try { db.exec("ROLLBACK"); } catch { } inRawTx = false; }
      db.exec("DROP TABLE IF EXISTS jobs_raw");
      throw e;
    } finally {
      clearTimeout(timeoutId);
    }

    if (rawCount === 0) {
      db.exec("DROP TABLE IF EXISTS jobs_raw");
      throw new Error("Validation failed: feed contains no jobs.");
    }

    db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_raw_base ON jobs_raw(base_ref)");

    const currentCount = getJobCount();

    db.exec("BEGIN");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS jobs_staging (
          id TEXT PRIMARY KEY, title TEXT, company TEXT, workplace TEXT,
          city TEXT, state TEXT, country TEXT, postcode TEXT, type TEXT,
          contractType TEXT, salary TEXT, hours TEXT, summary TEXT, url TEXT,
          category TEXT, location TEXT, search_blob TEXT, loc_blob TEXT
        );
      `);
      db.exec("DELETE FROM jobs_staging");

      const insertStagingStmt = db.prepare(`
        INSERT INTO jobs_staging (id, title, company, workplace, city, state, country, postcode, type, contractType, salary, hours, summary, url, category, location, search_blob, loc_blob)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const baseStmt = db.prepare("SELECT DISTINCT base_ref FROM jobs_raw");
      const groupStmt = db.prepare("SELECT * FROM jobs_raw WHERE base_ref = ?");

      let validJobs = 0;
      const seen = new Set<string>();
      for (const b of baseStmt.all() as { base_ref: string }[]) {
        const group = groupStmt.all(b.base_ref) as any[];
        if (!group.length) continue;
        const r = mapGroup(b.base_ref, group);
        if (seen.has(r.id)) continue;
        if (!r.id || !r.title || !r.company || !r.url) continue;
        if (!r.url.startsWith("https://")) continue;
        if (APPLY_URL_HOST) {
          try {
            if (new URL(r.url).host !== APPLY_URL_HOST) continue;
          } catch { continue; }
        }
        seen.add(r.id);
        insertStagingStmt.run(
          r.id, r.title, r.company, r.workplace, r.city, r.state, r.country, r.postcode,
          r.type, r.contractType, r.salary, r.hours, r.summary, r.url, r.category, r.location, r.search_blob, r.loc_blob
        );
        validJobs++;
      }

      const MIN_VALID_JOBS = Number(process.env.MIN_VALID_JOBS || 25);
      if (validJobs < MIN_VALID_JOBS) {
        throw new Error(`Validation failed: only ${validJobs} valid jobs; minimum is ${MIN_VALID_JOBS}.`);
      }
      if (currentCount > 0 && validJobs < currentCount * 0.25) {
        throw new Error(`Validation failed: Job count dropped by more than 75% (${currentCount} -> ${validJobs}).`);
      }

      db.exec("DELETE FROM jobs");
      db.exec("INSERT INTO jobs SELECT * FROM jobs_staging");
      db.exec("INSERT INTO jobs_fts(jobs_fts) VALUES('rebuild')");
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    } finally {
      db.exec("DROP TABLE IF EXISTS jobs_raw");
    }

    lastSync = Date.now();
    return getJobCount();
  } finally {
    syncing = false;
  }
}

// ----------------------------------------------------
// Search (SQL)
// ----------------------------------------------------
function parseSearch(rawQuery: unknown, explicitLocation?: unknown): { q: string; location: string } {
  let q = String(rawQuery || "").trim();
  let location = explicitLocation ? String(explicitLocation).trim() : "";

  if (!location) {
    const m = q.match(/\s+in\s+(?:the\s+)?([A-Za-zÀ-ÿ0-9.,'’\s-]+?)\s*$/i);
    if (m && m.index !== undefined) {
      location = m[1].trim();
      q = q.slice(0, m.index).trim();
    }
  }

  location = normalizeLocationInput(location);

  const cleaned = q.replace(/\b(jobs|openings|vacancies|opportunities|listings|positions|roles)\b/gi, " ").replace(/\s+/g, " ").trim();
  q = cleaned;

  return { q, location };
}

const US_STATE_CODES: Record<string, string> = {
  "alabama": "AL",
  "alaska": "AK",
  "arizona": "AZ",
  "arkansas": "AR",
  "california": "CA",
  "colorado": "CO",
  "connecticut": "CT",
  "delaware": "DE",
  "district of columbia": "DC",
  "florida": "FL",
  "georgia": "GA",
  "hawaii": "HI",
  "idaho": "ID",
  "illinois": "IL",
  "indiana": "IN",
  "iowa": "IA",
  "kansas": "KS",
  "kentucky": "KY",
  "louisiana": "LA",
  "maine": "ME",
  "maryland": "MD",
  "massachusetts": "MA",
  "michigan": "MI",
  "minnesota": "MN",
  "mississippi": "MS",
  "missouri": "MO",
  "montana": "MT",
  "nebraska": "NE",
  "nevada": "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  "ohio": "OH",
  "oklahoma": "OK",
  "oregon": "OR",
  "pennsylvania": "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  "tennessee": "TN",
  "texas": "TX",
  "utah": "UT",
  "vermont": "VT",
  "virginia": "VA",
  "washington": "WA",
  "west virginia": "WV",
  "wisconsin": "WI",
  "wyoming": "WY",
  "puerto rico": "PR",
};

const COUNTRY_ALIASES: Record<string, string> = {
  "us": "United States",
  "usa": "United States",
  "united states": "United States",
  "united states of america": "United States",
};

const STATE_CODE_TO_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(US_STATE_CODES).map(([name, code]) => [code.toLowerCase(), name])
);

const VALID_STATE_CODES = new Set(Object.values(US_STATE_CODES));

function stateSearchAliases(state: string): string {
  const key = state.toLowerCase().replace(/\./g, "").trim();
  const aliases: string[] = [];
  if (US_STATE_CODES[key]) aliases.push(US_STATE_CODES[key]);
  if (STATE_CODE_TO_NAME[key]) aliases.push(STATE_CODE_TO_NAME[key]);
  return aliases.join(" ");
}

function locationKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLocationInput(raw: unknown): string {
  const value = String(raw ?? "")
    .trim()
    .replace(/\s+/g, " ");

  if (!value) return "";

  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  const secondPartIsCountry =
    parts.length === 2 &&
    Boolean(COUNTRY_ALIASES[locationKey(parts[1])]);

  return parts
    .map((part, index) => {
      const key = locationKey(part);

      const country = COUNTRY_ALIASES[key];
      if (country) return country;

      const stateCode = US_STATE_CODES[key];

      const isStatePosition =
        parts.length === 1 ||
        index > 0 ||
        (index === 0 && secondPartIsCountry);

      if (stateCode && isStatePosition) {
        return stateCode;
      }

      return part;
    })
    .join(", ");
}

const STOP_WORDS = new Set([
  "in", "at", "on", "of", "the", "a", "an", "for", "to", "near", "by",
  "with", "and", "or", "my", "me", "area",
]);

function ftsTokens(q: string): string[] {
  return (q.toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
    .map((t) => t + "*");
}

function runFtsQuery(
  matchExpr: string,
  locTokens: string[],
  locParams: string[],
  limit: number
): { total: number; jobs: Row[] } {
  const locClause = locTokens.length
    ? " AND " + locTokens.map(() => "(' ' || j.loc_blob || ' ') LIKE ?").join(" AND ")
    : "";

  const totalRow = db.prepare(
    `SELECT COUNT(*) AS n FROM jobs_fts f JOIN jobs j ON j.rowid = f.rowid
     WHERE jobs_fts MATCH ?${locClause}`
  ).get(matchExpr, ...locParams) as { n: number } | undefined;
  const total = totalRow ? totalRow.n : 0;

  const rows = db.prepare(
    `SELECT j.* FROM jobs_fts f JOIN jobs j ON j.rowid = f.rowid
     WHERE jobs_fts MATCH ?${locClause}
     ORDER BY bm25(jobs_fts, 10.0, 5.0, 3.0, 1.0, 1.0)
     LIMIT ?`
  ).all(matchExpr, ...locParams, limit) as unknown as Row[];

  return { total, jobs: rows };
}

function searchDb(q: string, location: string, limit: number): { total: number; jobs: Row[] } {
  const locTokens = location.toLowerCase().split(/[\s,]+/).filter((p) => p.length > 1);
  const locParams = locTokens.map((t) => `% ${t} %`);
  const tokens = ftsTokens(q);

  if (tokens.length) {
    let result = runFtsQuery(tokens.join(" AND "), locTokens, locParams, limit);
    if (result.total === 0 && tokens.length > 1) {
      result = runFtsQuery(tokens.join(" OR "), locTokens, locParams, limit);
    }
    return result;
  }

  if (!locTokens.length) {
    return { total: 0, jobs: [] };
  }
  const whereSql = "WHERE " + locTokens.map(() => "(' ' || loc_blob || ' ') LIKE ?").join(" AND ");
  const totalRow2 = db.prepare(`SELECT COUNT(*) AS n FROM jobs ${whereSql}`).get(...locParams) as { n: number } | undefined;
  const total2 = totalRow2 ? totalRow2.n : 0;
  const rows2 = db.prepare(`SELECT * FROM jobs ${whereSql} ORDER BY title ASC LIMIT ?`).all(...locParams, limit) as unknown as Row[];
  return { total: total2, jobs: rows2 };
}

function toClientJob(r: Row) {
  const job: Record<string, string> = {
    title: r.title,
    employer: r.company,
    workplace: r.workplace,
    location: r.location,
    schedule: r.type,
    contractType: r.contractType,
    salary: r.salary,
    summary: r.summary,
    applicationUrl: r.url,
  };
  for (const key of Object.keys(job)) {
    if (!job[key]) delete job[key];
  }
  return job;
}

// ----------------------------------------------------
// Express app + MCP server
// ----------------------------------------------------
const app = express();
app.use(cors({
  origin: "*",
  exposedHeaders: ["mcp-session-id"],
  allowedHeaders: ["Content-Type", "mcp-session-id", "Accept"],
}));
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/", (req, res) => res.json({ name: "Async ChatGPT XML Feed App (SQLite)", status: "running", mcp: "/mcp" }));
app.get("/health", (req, res) => {
  if (lastSync === 0) {
    res.status(503).json({ status: "syncing", service: "async-chatgpt-xmlfeed" });
    return;
  }
  const row = db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number } | undefined;
  const n = row ? row.n : 0;
  res.json({ status: "ok", service: "async-chatgpt-xmlfeed", backend: "sqlite", version: "1.0.0", jobs: n, lastSync });
});

function buildMcpServer() {
  const server = new Server(
    { name: "Async - AI Job Search (XML Feed, SQLite)", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {} } }
  );

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: WIDGET_URI, name: "Async Job Cards", mimeType: "text/html;profile=mcp-app" }],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    if (req.params.uri !== WIDGET_URI) throw new Error("Resource not found");
    const widgetPath = path.join(__dirname, "..", "public", "widget", "job-cards.html");
    let html: string;
    try { html = fs.readFileSync(widgetPath, "utf-8"); }
    catch { html = "<html><body><p>Widget not found</p></body></html>"; }

    return {
      contents: [{
        uri: req.params.uri,
        mimeType: "text/html;profile=mcp-app",
        text: html,
        _meta: {
          ui: {
            domain: WIDGET_DOMAIN,
            prefersBorder: true,
            csp: { connectDomains: [], resourceDomains: [], frameDomains: [] },
          },
          "openai/widgetDomain": WIDGET_DOMAIN,
          "openai/widgetPrefersBorder": true,
          "openai/widgetCSP": {
            connect_domains: [],
            resource_domains: [],
            redirect_domains: REDIRECT_DOMAINS
          },
          "openai/widgetDescription": "Displays up to eight matching job listings in a compact, accessible carousel with one application action per listing.",
        },
      }],
    } as any;
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: "search_async_job_listings",
      title: "Search Async job listings",
      description: "Searches current Async job listings by role or keyword and, when provided, city, state, or country. Returns matching job details and an external application link. Do not use this tool to apply, submit forms, or search employers outside of Async.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The job title, role, or keyword to search for (e.g. 'software engineer', 'nurse'). Do not include a location here.", minLength: 1, maxLength: 120 },
          location: { type: "string", description: "City, state, or country to filter by. Omit if the user did not specify one.", maxLength: 100 },
          limit: { type: "integer", minimum: 1, maximum: 8, default: 6 },
        },
        required: ["query"],
      },
      outputSchema: {
        type: "object",
        properties: {
          type: { type: "string" },
          data: {
            type: "object",
            properties: {
              appliedFilters: { type: "object" },
              totalResults: { type: "number" },
              jobs: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    employer: { type: "string" },
                    workplace: { type: "string" },
                    location: { type: "string" },
                    schedule: { type: "string" },
                    contractType: { type: "string" },
                    salary: { type: "string" },
                    summary: { type: "string" },
                    applicationUrl: { type: "string" },
                  },
                  required: ["title", "applicationUrl"],
                },
              },
            },
            required: ["jobs"],
          },
        },
        required: ["type", "data"],
      },
      annotations: { title: "Search Async job listings", readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      _meta: {
        ui: { resourceUri: WIDGET_URI },
        "openai/outputTemplate": WIDGET_URI,
      },
    } as any],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "search_async_job_listings") throw new Error("Tool not found");
    const args = request.params.arguments as any;

    try {
      const rawQuery = typeof args.query === "string" ? args.query.trim() : "";
      if (!rawQuery || rawQuery.length > 120) {
        return {
          isError: true,
          content: [{ type: "text", text: "Please provide a search query (1–120 characters)." }],
        };
      }
      const rawLocation = typeof args.location === "string" ? args.location.trim().slice(0, 100) : "";
      const limit = Math.max(1, Math.min(Number.isInteger(args.limit) ? args.limit : 6, 8));

      const { q, location } = parseSearch(rawQuery, rawLocation);

      const result = searchDb(q, location, limit);
      const jobs = result.jobs.map(toClientJob);

      let textContent: string;
      if (result.total === 0 && location) {
        textContent = `No matching jobs found in "${location}" for "${q}". Would you like to broaden the search by removing the location filter?`;
      } else if (result.total === 0) {
        textContent = `No matching jobs found for "${q}". Try different keywords or a broader search term.`;
      } else {
        textContent = `Found ${result.total} Async opportunities.`;
      }

      return {
        content: [{ type: "text", text: textContent }],
        structuredContent: {
          type: "application/json",
          data: { appliedFilters: { query: q, location: location || undefined, limit }, totalResults: result.total, jobs },
        },
        annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
        _meta: { ui: { resourceUri: WIDGET_URI } },
      } as any;
    } catch (error) {
      console.error("search_async_job_listings error:", error);
      return {
        isError: true,
        content: [{ type: "text", text: "Sorry, Async job search is temporarily unavailable. Please try again in a moment." }],
      };
    }
  });

  return server;
}

app.get("/.well-known/openai-apps-challenge", (_req, res) => {
  res.setHeader("Content-Type", "text/plain");
  res.status(200).send("MTb_KfghTb2_GX4vGjcRj38JRsg0CCo1RFpZ9HxrJ6I");
});

app.all("/mcp", async (req, res) => {
  try {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res);
    res.on("close", () => server.close().catch(console.error));
  } catch (err) {
    console.error("MCP error:", err);
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  }
});

const PORT = process.env.PORT || 3001;

async function start() {
  const count = await syncFeed();
  console.log(`Initial feed sync completed: ${count} jobs`);

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Feed: ${FEED_URL}`);
    console.log(`DB:   ${DB_PATH}`);
  });

  setInterval(() => {
    syncFeed().catch((error) => {
      console.error("Feed re-sync failed:", error.message);
    });
  }, SYNC_INTERVAL_MS);
}

start().catch((error) => {
  console.error("Startup failed:", error.message);
  process.exit(1);
});
