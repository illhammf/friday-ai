# Friday AI — Sprint 1.6 Implementation

**Implementation date:** 2026-11-08

## 1. Summary of Architectural Changes

Sprint 1.6 separates SQLite connection construction from module import and
introduces an injectable application lifecycle controller. The executable
entry point is now a thin lazy loader; integration composition and startup
occur only when the program is invoked as the entry point or
`startFriday()` is explicitly called.

No database schema, dependency, user-facing message, or feature behavior was
intentionally changed.

## 2. Previous Database Initialization Behavior

Before this change, importing `src/database/sqlite.js` immediately created the
relative `data/` directory, opened `data/friday.sqlite`, and initialized
tables/indexes. Importing `src/index.js` therefore also loaded the database
module, Gemini provider module, WhatsApp integration module, and started the
bot at the end of module evaluation.

## 3. New Database Factory Design

`src/database/sqlite.js` now exports `createDatabase({ dbPath })`. It validates
the path, creates its parent directory, opens a dedicated `DatabaseSync`
connection, initializes the existing schema, prepares statements for that
connection, and returns history/memory operations plus an idempotent `close()`.
If schema or statement initialization fails after opening the connection, the
factory closes that connection and rethrows the original error.

The tables remain `messages` and `user_memories`; indexes remain
`idx_messages_session` and `idx_user_memories_session`. Existing columns,
constraints, indexes, session formats, history retention, and memory semantics
are unchanged. No migration was introduced.

For compatibility, the previous named exports remain as lazy default
operations. They create the application database only on the first database
operation. Normal Friday startup explicitly calls
`initializeDefaultDatabase()` and injects its operations into the assistant,
memory commands, history persistence, and lifecycle controller. Importing the
database/history modules alone no longer opens the production database.

## 4. Application Lifecycle Design

`src/application/application-lifecycle.js` exports `createApplication()`.
Construction is side-effect-free and takes injected database/client factories,
client setup and initialization callbacks, queue drain and admission-stop
operations, and a logger.

The lifecycle opens the database, creates/configures the WhatsApp client, and
initializes it only when `application.start()` is called. It supports fake
dependencies for startup tests and does not import WhatsApp, Gemini, or
SQLite modules.

`src/index.js` is now the executable entry point and only dynamically loads
`src/friday-runtime.js` when run directly or when `startFriday()` is explicitly
called. The runtime keeps the established message service, WhatsApp adapters,
and concrete feature implementations. Client construction and event
registration have moved into the explicit lifecycle startup path. The message
service remains transport-independent.

## 5. Startup Failure Cleanup Behavior

The lifecycle catches the startup failure, disables message admission, drains
queued messages, destroys the client if it was created, and closes the
database if it was opened. Cleanup continues when an individual shutdown
operation fails; the shutdown handler logs failures and sets a nonzero process
exit code. The original startup error is rethrown for the entry point to log.

Shutdown remains idempotent. A shutdown requested while client initialization
is pending waits for initialization to settle before cleanup, preventing a
late initialization from racing resource destruction. Normal cleanup order is:

1. Stop accepting messages.
2. Drain queued work.
3. Destroy the WhatsApp client.
4. Close the database.

## 6. Tests Added

- `test/sqlite.test.js` covers factory/schema initialization, history behavior,
  memory behavior, connection isolation, close/reopen persistence, temporary
  artifact cleanup, and side-effect-free entry-point import.
- `test/application-lifecycle.test.js` covers side-effect-free construction,
  injected startup, database startup failure, original error preservation,
  cleanup continuation, shutdown idempotency, and shutdown requested during
  initialization.
- `test/shutdown.test.js` retains the previous queue/client/database cleanup
  ordering and failure-continuation checks.

Database tests create uniquely named temporary directories under the OS temp
directory and remove only those test-owned directories. They never target
`data/friday.sqlite`.

## 7. Backward Compatibility Assessment

- Existing database operation names and signatures remain available through
  `src/database/history.js`.
- Existing SQL schema, index names, session ID formats, retention limits, and
  stored value formats remain unchanged.
- `npm start` and `npm run dev` still invoke `src/index.js`.
- Existing message service dependencies and WhatsApp behavior remain wired by
  the Friday runtime.
- The runtime lifecycle now explicitly opens the default database before
  diagnostics and WhatsApp initialization.
- No dependencies were added, removed, or updated.

## 8. Remaining Limitations

- The agent execution environment reports Node `v18.19.1` and npm `9.2.0`,
  while the project requires Node `>=24`. The reported developer WSL
  environment (`v24.22.1`, npm `11.19.1`) was not available to this execution.
- Consequently, the five tests that exercise `node:sqlite` factory operations
  are skipped here. Their code is enabled automatically when the built-in
  module is available; they still need to pass under the supported Node 24
  runtime before Sprint 1.6 can be considered fully verified.
- The configured suite does not start a live WhatsApp client or call Gemini.
  Their integrations are not end-to-end tested by this sprint.
- The default application database path remains relative to the process
  working directory for compatibility.

## 9. Database Safety Confirmation

The production database path `data/friday.sqlite` was not opened, reset,
deleted, migrated, or written during this implementation. The factory tests
use only temporary paths. `.wwebjs_auth` was not opened or changed. No
WhatsApp connection, message send, or Gemini API request was initiated.

## 10. Verification Results

- `npm run check`: **PASS** under Node `v18.19.1`.
- `npm test`: **PASS**, 112 tests discovered, 107 passed, 0 failed, 5 skipped
  because `node:sqlite` is unavailable in this runtime.
- Live WhatsApp/Gemini integration: **NOT RUN**, by design and safety
  constraints.
- SQLite factory runtime behavior under Node 24: **NOT VERIFIED in this
  execution**.

Implementation and lifecycle isolation are complete. Full Sprint 1.6
verification remains partial until the SQLite tests pass under Node `>=24`.
