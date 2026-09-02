# Async job-search MCP server

The server answers searches and widget resource reads from one validated,
read-only SQLite snapshot. Feed refreshes run in a separate child process,
build a new database in the snapshot directory, validate it, and atomically
promote it. A refresh failure never replaces the last-good snapshot.

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
