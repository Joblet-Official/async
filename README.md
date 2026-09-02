# Async job-search MCP server

The server answers searches and widget resource reads from one validated,
read-only SQLite snapshot. Feed refreshes run in a separate child process,
build a new database in the snapshot directory, validate it, and atomically
promote it. A refresh failure never replaces the last-good snapshot.

## Build and start

Compile and verify changes with development dependencies installed:

```text
npm ci
npm run build
npm run typecheck
npm test
```

Production starts the checked-in compiled entry point and does not require the
development-only `tsx` or TypeScript packages:

```text
npm ci --omit=dev
npm start
```

Rebuild and commit `dist/index.js` whenever `server/src/index.ts` changes.

## Persistent production storage

On Render, point both database settings at a mounted persistent disk. For
example:

```text
SQLITE_DB_PATH=/var/data/async/jobs.db
SQLITE_SNAPSHOT_DIR=/var/data/async/snapshots
```

`SQLITE_DB_PATH` is retained as a backward-compatible legacy snapshot. New
snapshots and `active-snapshot.json` are stored in `SQLITE_SNAPSHOT_DIR`.
Without a persistent disk, a brand-new instance cannot retain the last-good
snapshot from the previous instance. Run one refresh-owning service instance
per snapshot directory.

## Freshness settings

- `SYNC_INTERVAL_MS`: refresh interval; default 1 hour.
- `ASYNC_STALE_AFTER_MS`: health becomes `degraded`; default is at least 2 hours.
- `ASYNC_MAX_STALE_MS`: health becomes `expired` and search stops using the old data; default 24 hours.
- `FEED_FETCH_TIMEOUT_MS`: worker feed timeout; default 10 minutes.
- `ASYNC_REFRESH_WORKER_TIMEOUT_MS`: hard worker timeout; default feed timeout plus 5 minutes.
- `ASYNC_SNAPSHOT_RETENTION`: generated snapshots to retain; default 3, minimum 2.
- `ASYNC_MIN_SNAPSHOT_RETENTION_PERCENT`: minimum size of a refresh relative to the last-good snapshot; default 80.
- `ASYNC_MAX_INVALID_JOB_PERCENT`: maximum malformed/oversized/unsafe job-element percentage; default 1. Intentional content exclusions do not count as invalid.
- `ASYNC_MIN_PROMOTED_JOBS`: absolute floor for every newly downloaded production snapshot; default 3000 for the current 4,000+ listing feed. Lower this only after confirming an intentional feed-size change.
- `MIN_VALID_JOBS`: absolute minimum accepted snapshot size; default 25.
- `MAX_FEED_MB`: maximum downloaded feed size; default 512 MB.
- `ASYNC_MCP_BODY_LIMIT_BYTES`: maximum MCP JSON request body; default 65536 bytes.
- `ASYNC_MCP_MAX_CONCURRENT_REQUESTS`: maximum in-flight MCP requests; default 64.
- `ASYNC_MCP_RATE_LIMIT_WINDOW_MS`: per-client rate window; default 60000 ms.
- `ASYNC_MCP_RATE_LIMIT_MAX_REQUESTS`: requests allowed per client and window; default 600.
- `ASYNC_MCP_RATE_LIMIT_MAX_CLIENTS`: maximum tracked client windows; default 10000.

`/health` returns HTTP 200 for fresh or degraded-but-usable snapshots and HTTP
503 only when no valid snapshot exists or the configured maximum age is
exceeded. Widget resources remain available in every state.

Every failed refresh emits a structured JSON log event named
`async_feed_refresh_failed`. Configure a Render log alert for that event (and
for repeated `degraded` health checks) so an operator is notified while the
service continues using its last-good snapshot.

Run the regression checks with:

```text
npm run typecheck
npm test
```
