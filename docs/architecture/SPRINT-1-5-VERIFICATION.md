# Friday AI — Sprint 1.5 Runtime Integration Verification

**Verification date:** 2026-11-08

**Scope:** Runtime checks, configured regression tests, and source inspection
of application bootstrap, message-service wiring, SQLite initialization, and
shutdown. The bot was not started. No WhatsApp messages were sent, no Gemini
requests were made, and no existing database or authentication-session data
was opened or changed.

## 1. Executive Summary

**Overall status: PARTIAL.**

The configured static check and all 99 tests pass under the runtime available
to this execution. Source inspection confirms the message service is composed
in `src/index.js`, receives normalized messages through the WhatsApp adapter,
and uses injected persistence and delivery dependencies. Shutdown sequencing
is also covered by unit tests.

The requested supported-runtime verification could not be completed: this
environment runs Node `v18.19.1`, not the reported WSL Node `v24.22.1`, and
does not provide `node:sqlite`. As a result, SQLite was not opened using an
isolated test database, and application bootstrap was not attempted. The
reported Node 24/npm 11 environment still needs to run these checks.

## 2. Runtime Environment

| Check | Status | Result |
| --- | --- | --- |
| `node -v` and executable | **FAIL** (environment requirement) | `/usr/bin/node`, `v18.19.1` |
| `npm -v` and executable | **PARTIAL** | `/usr/bin/npm`, `9.2.0` |
| Node.js version declared in `package.json` | **PASS** (source inspection) | `>=24` |
| Reported WSL executable | **NOT VERIFIED** | `~/.nvm/versions/node/v24.22.1/bin/node` is not present in this agent environment |
| `node:sqlite` import | **FAIL** (runtime capability) | Import reports `ERR_UNKNOWN_BUILTIN_MODULE` under Node 18 |

These are measurements from this execution, not assumptions based on previous
reports. The WSL values Node `v24.22.1` and npm `11.19.1` could not be
independently confirmed here.

## 3. Node.js SQLite Verification

| Check | Status | Result |
| --- | --- | --- |
| Import built-in `node:sqlite` | **FAIL** | The available Node 18 runtime does not include this built-in module |
| Open an isolated temporary database | **NOT VERIFIED** | Not attempted because the required module/runtime is unavailable |
| Create tables and indexes using Node 24 | **NOT VERIFIED** | Node 24 is not installed in this execution environment |
| Close a Node SQLite connection | **NOT VERIFIED** | No connection was opened |

No temporary database artifacts were created. The existing `data/friday.sqlite`
path exists, but it was not opened or inspected. No production data was
modified.

## 4. Application Bootstrap Assessment

**Status: PARTIAL — source inspection only; bootstrap intentionally not run.**

**Entry point:** `src/index.js`, as declared by `package.json` and the `start`
script.

**Observed startup sequence from source:**

1. Environment loading and static module imports occur before top-level
   application setup. The history module imports `src/database/sqlite.js`,
   which creates the relative `data/` directory, opens
   `data/friday.sqlite`, and executes schema/index initialization at import
   time.
2. `src/ai/gemini.js` reads `GEMINI_API_KEY` and throws during module
   evaluation if it is absent; otherwise it constructs the Gemini client.
3. The entry point constructs the WhatsApp client and its `LocalAuth`
   strategy, then initializes in-memory queue/deduplication state and the
   message service with its concrete dependencies.
4. It registers WhatsApp lifecycle and message handlers and installs
   `SIGINT`/`SIGTERM` shutdown handling.
5. At the end of the module, runtime diagnostics run and then
   `client.initialize()` is called. That call may launch Puppeteer, read/write
   the local WhatsApp auth state, and connect to WhatsApp.

The bootstrap was not executed: `client.initialize()` is a real external
connection path, and importing the entry point itself can initialize SQLite
and construct integrations. No external service was contacted during this
verification.

The bootstrap failure handler logs the failure, calls `closeDatabase()`, and
sets `process.exitCode = 1`. It does not call `client.destroy()` if
`client.initialize()` rejects after partially initializing client resources.
This is a risk identified by inspection, not an observed runtime failure.

## 5. Message Service Integration Assessment

**Status: PARTIAL — dependency wiring inspected; service behavior tested with
fakes; WhatsApp adapter not exercised end-to-end.**

**Verified by source inspection:**

- `src/index.js` constructs `createMessageService()` with session, memory,
  video, sticker, image, assistant, audio, history, formatting, delivery, and
  logging dependencies.
- `normalizeIncomingMessage()` maps WhatsApp data into `messageId`, `chatId`,
  `senderId`, `chatType`, `messageType`, `text`, `caption`, `timestamp`, group
  metadata, and a media-download operation.
- `handleIncomingMessage()` passes that normalized object plus a narrow
  `reply()` adapter to `messageService.handle()`. It does not pass the full
  `whatsapp-web.js` message to the application service.
- The media operation closes over the original WhatsApp message and calls
  `downloadMediaWithRetry()` inside the transport adapter. The application
  service receives only the media operation and diagnostic metadata.
- Outbound video, sticker, generated image, and voice-note delivery are
  injected through adapter functions calling `client.sendMessage()`.
- History persistence is injected through `saveMessage`; the SQLite singleton
  is not imported directly by `src/application/message-service.js`.
- Queue eligibility, deduplication, and enqueueing remain in the WhatsApp
  event handler before the application service is called.

**Verified only through unit tests:** configured service tests use normalized
message fakes and injected AI/media/history/delivery doubles. They cover
private/group routing, group prefixes, memory scope, explicit video download,
image/sticker priority, voice-note routing, and persistence/delivery ordering.

**Not verified:** the actual `whatsapp-web.js` message shape through
`normalizeIncomingMessage()`, actual media decryption, or outbound delivery.
There is no configured test that imports `src/index.js` and simulates a real
WhatsApp SDK event. Such a test should avoid importing the current entry point
until its top-level database/provider/client initialization can be isolated.

## 6. SQLite Initialization Assessment

**Status: PARTIAL — source inspection only; Node 24 isolated runtime test
blocked.**

**Verified by source inspection:**

- `src/database/sqlite.js` imports `DatabaseSync` from `node:sqlite`.
- Importing that module creates `data/` relative to the process working
  directory and opens `data/friday.sqlite`.
- It executes idempotent `CREATE TABLE IF NOT EXISTS` statements for
  `messages` and `user_memories`, and creates `idx_messages_session` and
  `idx_user_memories_session`.
- It prepares statements after schema creation and exports history/memory
  operations plus `closeDatabase()`, which calls `db.close()`.
- There is no migration/version mechanism or explicit transaction around
  message insertion and history trimming.

**Not verified:** table/index creation, reads/writes, and close behavior on
Node 24. The runtime cannot import `node:sqlite`; the existing database was
left untouched. Because the database location is relative to the process
working directory, launching Friday from a different directory may open or
create a different database path.

## 7. Graceful Shutdown Assessment

**Status: PARTIAL — ordering and error handling covered by unit tests; live
resource cleanup not exercised.**

**Verified by source inspection and `test/shutdown.test.js`:**

- `SIGINT` and `SIGTERM` first disable new queue admission, then call the
  shutdown handler.
- Shutdown drains the message queue, destroys the WhatsApp client, and closes
  the database in that order.
- Repeated shutdown calls share one promise, making cleanup idempotent.
- A failure in one cleanup operation is logged, later operations still run,
  and the process exit code is set to `1`.
- Queue `drain()` waits until tracked queue work has completed.

**Not verified:** delivery of OS signals to a running Friday process, draining
real media/AI work, destruction of a live WhatsApp client, or closing a live
Node 24 SQLite handle.

## 8. Regression Test Results

| Check | Status | Result |
| --- | --- | --- |
| `npm run check` | **PASS** | Exit code 0; syntax check covers `src/index.js` and `src/application/message-service.js` |
| `npm test` | **PASS** | 99 tests, 0 failures |
| Test runtime | **PARTIAL** | Tests passed under Node `v18.19.1`, below the declared `>=24` minimum |
| WhatsApp/Gemini calls during tests | **PASS** (inspection of test design) | Service dependencies are fakes; no bot bootstrap was run |
| SQLite integration in configured tests | **NOT VERIFIED** | The test suite does not initialize the production SQLite module |

These are automated unit/regression test results, not full external-service
integration results.

## 9. Identified Risks and Integration Gaps

1. **Supported runtime unavailable:** neither the Node 24 executable nor the
   Node 24 SQLite runtime is present in this execution. Supported-runtime
   verification remains blocked.
2. **Bootstrap has import-time side effects:** SQLite opens during module
   evaluation; Gemini initialization may throw before runtime diagnostics;
   the final bootstrap path initializes WhatsApp. This prevents safely
   importing `src/index.js` as a simple integration-test harness.
3. **Startup failure cleanup gap:** the `.catch()` after
   `client.initialize()` closes SQLite but does not destroy a possibly
   partially initialized WhatsApp client.
4. **No adapter-level regression test:** tests exercise the normalized
   service contract but not conversion from actual SDK messages to that
   contract or the outbound `MessageMedia` adapters.
5. **No SQLite test isolation abstraction:** persistence uses a module-level
   database opened at a fixed relative path, so tests cannot inject a
   disposable database without changing the existing module setup.
6. **Live shutdown not tested:** the order is verified with fakes only; real
   WhatsApp and SQLite resource behavior remains untested.

## 10. Final Sprint 1.5 Status

**Status: PARTIAL — not complete against all requested runtime criteria.**

What works and is verified:

- Static checks pass in the available runtime.
- All 99 configured regression tests pass.
- Source inspection confirms the extracted message service's dependency
  wiring, normalized-message adapter, and transport-specific delivery
  adapters.
- Shutdown order, idempotency, and failure continuation pass unit tests.

Remaining blockers:

- Run the verification using the actual Node `v24.22.1` and npm `11.19.1`
  WSL executables.
- Under Node 24, use an isolated temporary database to verify
  `node:sqlite` import, connection, schema/index initialization, and close.
- Do not use the existing `data/friday.sqlite` for destructive or diagnostic
  tests.
- Keep the bot bootstrap and live WhatsApp/Gemini integrations unstarted
  unless a separate, explicitly authorized integration environment is
  provided.

**Recommendation for next sprint:** once Node 24 verification is completed,
address testability and startup lifecycle in a bounded follow-up: isolate the
WhatsApp adapter and SQLite connection factory for injection, add adapter
contract tests, and ensure partially initialized clients are cleaned up on
startup failure. Do not mix that implementation work into this verification
sprint.
