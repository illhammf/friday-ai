# Sprint 4.10 — Runtime Reliability & Release Readiness

## Audit Findings (Recorded Before Source Changes)

1. **Runtime:** `package.json` requires Node `>=24`; `src/config/runtime-diagnostics.js` checks Node's major version and masks the Gemini key value. README already states Node 24 or newer and `npm ci`, but offers no NVM example. Node `v24.22.1` and npm `11.19.1` are available at the repository owner's NVM installation. `src/database/sqlite.js` uses the built-in `node:sqlite` `DatabaseSync`; replacing it or lowering the engine requirement is unnecessary.
2. **Startup/lifecycle:** `createApplication()` creates database → client → configures event handlers → initializes client, shares concurrent startup, cleans up partially created resources, preserves the startup error, and makes repeated shutdown calls idempotent. `createShutdownHandler()` runs stop admission → drain queue → destroy client → close database and sets a nonzero exit code when cleanup operations reject.
3. **Readiness race:** the WhatsApp `ready` listener unconditionally sets `acceptingMessages = true`. If shutdown starts while `client.initialize()` is pending and the `ready` event arrives before it settles, admission can become active again briefly despite the shutdown request.
4. **Queue/shutdown:** `createMessageQueue()` serializes work per chat, enforces a bounded pending count, and recovers its tail after task failures. The runtime stops admission before calling `drain()`. However, `drain()` has no deadline; a hung provider/transport task can leave shutdown waiting forever. Closing SQLite while that task is still running would be unsafe, so timeout handling must preserve the database until the drain eventually settles.
5. **WhatsApp initialization:** installed `whatsapp-web.js` `Client.initialize()` navigates with `timeout: 0` and its injected initialization waits for WhatsApp socket state changes. Application shutdown previously waited for `startPromise` before stopping admission; a signal during QR/auth initialization could therefore wait indefinitely and allow a late `ready` event to reopen admission.
6. **SQLite/migrations:** `DatabaseSync` operations are synchronous on the Node event loop. `saveConversationTurn()` wraps both inserts and retention in one transaction; migrations use `BEGIN IMMEDIATE` and rollback; database close is guarded for repeated calls. No schema change or write retry is justified by this audit.
7. **Configuration/security:** `.gitignore` excludes `.env` (except `.env.example`), WhatsApp auth/cache directories, SQLite files, and logs. The runtime diagnostics report whether `GEMINI_API_KEY` is configured without printing its value. Media-tool failures are optional. Paths are relative to the working directory. No real `.env`, WhatsApp auth files, or production database were read or modified for this audit.
8. **Existing regression protection:** current tests cover startup success/failure/partial cleanup, repeated shutdown, startup interrupted by shutdown, queue ordering/admission/recovery/drain, atomic SQLite writes/rollback, migrations, and memory isolation. They did not cover readiness racing with shutdown or hung startup/queue/cleanup deadlines.

## 1. Executive Summary

The audit verified Node `v24.22.1` and npm `11.19.1` from the installed NVM runtime. Baseline `npm run check` and all 321 baseline tests passed under that runtime. Lifecycle defects were corrected: shutdown did not stop admission until after startup settled, a late WhatsApp `ready` event could reopen admission, and startup/queue/client/database shutdown waits had no deadline. Admission now stops immediately; readiness cannot reopen. Startup and queue waits each have a 30-second deadline, and each cleanup operation has its own 30-second deadline. Timeouts report incomplete shutdown and keep resources open while startup or queued work may still depend on them. Database schema, migrations, message ordering, deduplication, and conversation behavior are unchanged.

## 2. Runtime Compatibility Audit

`package.json` continues to declare `node >=24`; no engine downgrade or runtime dependency was introduced. `src/config/runtime-diagnostics.js` checks Node's major version and masks the Gemini API key. SQLite uses Node's `node:sqlite` `DatabaseSync`, available in the supported runtime. README already stated the Node 24 requirement; this sprint adds portable `nvm install 24` / `nvm use 24` steps and makes `node --version` part of runtime checks. Verified versions: Node `v24.22.1`, npm `11.19.1`.

## 3. Application Lifecycle Audit

The existing lifecycle initializes DB, client, event handlers, and WhatsApp in order. Startup errors preserve the original error and run cleanup for resources actually assigned. Repeated start while running and repeated shutdown are idempotent. Shutdown now stops admission before waiting for startup and bounds that wait at 30 seconds. A readiness gate prevents the WhatsApp `ready` event from setting admission true after shutdown has begun. Cleanup callbacks keep the app in `stopping` while a timed-out operation is still running; failed cleanup ends in `failed`, not `stopped`.

## 4. Queue Lifecycle Audit

The queue remains per-chat serialized, bounded, and recoverable after task rejection; its implementation and deduplication behavior are unchanged. Shutdown stops admission before waiting for startup or draining. Startup and drain each have a 30-second default deadline. On queue timeout it returns without destroying the client or closing SQLite; deferred cleanup runs only after accepted work settles. Drain failure also leaves both resources open. Client destroy and resource close each have independent 30-second deadlines. A cleanup timeout is reported as incomplete, never as a successful shutdown. The in-memory queue is not durable; forced process termination can still lose accepted work.

## 5. SQLite Reliability Audit

`DatabaseSync` calls and turn/migration transactions are synchronous. Conversation turn writes use one transaction and rollback partial writes. Migration application uses `BEGIN IMMEDIATE`, validates migration history, and rolls back on failure. Application lifecycle closes the injected database only after queue drain completes; timed-out active work keeps the DB open. Existing SQLite transaction rollback, migrations, and memory isolation tests passed under Node 24. No database file was opened directly during this audit; tests use their existing temporary databases. Schema and migration history are unchanged.

## 6. Configuration and Deployment Readiness

`GEMINI_API_KEY` is required and its value is not included in runtime diagnostics. `.gitignore` excludes `.env` except `.env.example`, WhatsApp authentication/cache, SQLite database files, and logs. README now explains supported Node setup with NVM and confirms the active version. Media tools remain optional. Configuration paths remain relative/configurable; no machine-specific absolute path was added to product configuration. The real `.env`, auth directory, and local database were not read or modified.

## 7. Changes Implemented

- Added `src/application/runtime-readiness.js` and used it in the WhatsApp `ready` and shutdown paths so readiness cannot reopen after shutdown.
- Reworked `src/whatsapp/shutdown.js` to bound queue drain and each cleanup wait. A queue timeout or failure does not destroy the client or close SQLite while accepted work may still use them. Late cleanup is observed, and the app remains `stopping` until it finishes.
- Updated `src/application/application-lifecycle.js` to stop admission immediately, bound startup waiting, expose timeout configuration, and reflect incomplete/failed cleanup truthfully.
- Added readiness, drain timeout, cleanup timeout, safe resource ordering, and lifecycle state regression tests.
- Added NVM usage and active Node-version confirmation to README.
- No change was necessary to `src/whatsapp/message-queue.js`, SQLite transaction code, or migration code; their existing behavior passed the Node 24 suite.

## 8. Automated Test Results

Final checks ran with Node `v24.22.1` and npm `11.19.1`: `npm run check` passed; `npm test` passed all 327 tests, with 0 failed, 0 skipped, and 0 cancelled; focused lifecycle/queue/readiness tests passed 26/26; `git diff --check` passed. The 321-test baseline also passed before source edits. All SQLite, migration, and memory-isolation tests executed successfully under Node 24. Tests used fakes/temporary DBs; no live WhatsApp or Gemini request was made.

## 9. Security Boundaries Preserved

Production AI still uses the legacy conversation path only. Tool execution, executor/orchestrator wiring, identity verification, private/group classification, session derivation, memory policies, and grants were not changed. Tests use fakes and temporary databases; no live Gemini or WhatsApp requests were made. Local auth and production SQLite files remain untouched.

## 10. Known Limitations

The queue is in-memory and is not durable across forced process termination. If startup or an accepted task never settles, shutdown returns after its deadline with a nonzero exit code but intentionally leaves resources open; lifecycle stays `stopping` and the process may remain alive. A later settle triggers deferred cleanup. WhatsApp initialization is not forcibly cancelled at the deadline because closing resources while initialization may still use them is unsafe. Operators may need to force termination if startup/task never resolves, which can lose queued work. This is safer for SQLite consistency than closing resources still in use, but it is not a durable-job guarantee.

## 11. Recommended Next Sprint

Run the complete final checks recorded below and continue deployment-specific operational work only if needed (for example, persistent queue recovery or explicit cancellation semantics). Keep WhatsApp identity verification and production tool execution on their existing security roadmap.

## Final Verification and Change Summary

Node `v24.22.1`; npm `11.19.1`. No dependencies, lockfiles, or database schema/migration changes. Security boundaries are unchanged. The queue remains in memory; if an operation never settles, the app keeps resources open and remains `stopping` after reporting a nonzero exit status.

Sprint 4.10 files: `README.md`, `package.json`, `src/application/application-lifecycle.js`, `src/application/runtime-readiness.js` (new), `src/friday-runtime.js`, `src/whatsapp/shutdown.js`, `test/application-lifecycle.test.js`, `test/runtime-readiness.test.js` (new), `test/shutdown.test.js`, and this report.

The workspace also contains uncommitted Sprint 4.9C files that were present before this sprint began: `src/application/message-service.js`, `src/whatsapp/message-adapter.js`, `src/application/conversation-observability.js`, `test/message-adapter.test.js`, `test/message-service.test.js`, `test/conversation-observability.test.js`, and `docs/architecture/SPRINT-4-9C-CONVERSATION-RELIABILITY-OBSERVABILITY.md`. `package.json` and `src/friday-runtime.js` are shared files updated by both sprints. No pre-existing Sprint 4.9C changes were discarded.

Final Git status contains 11 modified and 6 untracked paths; the untracked paths include both Sprint 4.9C and Sprint 4.10 additions.
