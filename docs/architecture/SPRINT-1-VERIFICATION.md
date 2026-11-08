# Friday AI — Sprint 1 Runtime Verification

**Verification date:** 2026-11-08

**Scope:** Runtime and automated-test verification plus code inspection of
Sprint 1 message-service wiring, SQLite initialization, and graceful shutdown.
No bot bootstrap was run; no WhatsApp messages were sent; no Gemini requests
were made; no database or authentication-session contents were inspected or
changed.

## 1. Runtime

| Item | Observed value |
| --- | --- |
| Node executable | `/usr/bin/node` |
| Node version | `v18.19.1` |
| npm executable | `/usr/bin/npm` |
| npm version | `9.2.0` |
| Project requirement | Node.js `>=24` (`package.json`) |
| Requested WSL executable | `~/.nvm/versions/node/v24.22.1/bin/node` was not present in this agent environment |

These are direct observations from the execution environment, not values
inferred from the developer's separate WSL report. The reported Node.js
`v24.22.1` and npm `11.19.1` could not be independently verified here.
`node:sqlite` is unavailable in the observed Node 18 runtime
(`ERR_UNKNOWN_BUILTIN_MODULE`).

## 2. Static Check

**Command:** `npm run check`

**Result:** Passed (exit code 0). The script ran:

```text
node --check src/index.js && node --check src/application/message-service.js
```

This verifies JavaScript syntax under Node 18. It does not establish that the
application starts or that the Node 24 SQLite API works.

## 3. Automated Tests

**Command:** `npm test`

**Result:** Passed — 99 tests, 0 failures.

This ran the configured unit tests, including the transport-independent
message-service tests and queue/shutdown tests. They use fakes for AI,
messaging, media, and persistence dependencies; the run did not start the
WhatsApp client or invoke the Gemini SDK.

## 4. Message-Service Integration Assessment

**Verified by code inspection:**

- `src/index.js` constructs `createMessageService()` with concrete session,
  memory, video, sticker, image, assistant, audio, history, formatting,
  delivery, and logging dependencies.
- `normalizeIncomingMessage()` translates WhatsApp fields to the normalized
  contract (`messageId`, `chatId`, `senderId`, `chatType`, `messageType`,
  `text`, `caption`, `timestamp`, group metadata, and a media-download
  operation). The application service receives this object and a narrow
  reply transport, not the full WhatsApp message.
- The WhatsApp `message` event continues to perform admission, queueing, and
  duplicate-event claiming before invoking the adapter/service.
- The message service itself has no direct imports of `whatsapp-web.js`,
  Gemini SDK, SQLite singleton, or process globals.
- Focused service tests cover private/group routing, group prefix and greeting
  behavior, private-only memory commands, explicit video download intent,
  sticker-before-AI image routing, ordinary image analysis, voice-note
  transcription/reply, AI fallback, and persistence/delivery ordering.

**Not verified at runtime:** WhatsApp event payload translation, message
delivery, media download/decryption, actual Gemini calls, and database writes.
Those require live integrations and were deliberately not exercised. A service
unit test passing is not an end-to-end WhatsApp integration test.

## 5. SQLite Initialization Assessment

**Verified by code inspection only:**

- `src/database/sqlite.js` imports `DatabaseSync` from `node:sqlite`.
- Importing the module creates the relative `data/` directory, opens
  `data/friday.sqlite`, then executes idempotent `CREATE TABLE IF NOT EXISTS`
  and index statements.
- The existing tables are `messages` and `user_memories`. Existing indexes are
  `idx_messages_session` and `idx_user_memories_session`.
- There is no migration/version framework or explicit transaction wrapping
  `saveMessage()` plus history trimming.
- `closeDatabase()` calls `db.close()`. The schema and database contents were
  not read or modified during this verification.

**Runtime status:** Not verified. Node 18 in this environment does not provide
`node:sqlite`, and no database initialization command was run. Existing
SQLite contents, compatibility of an existing database under Node 24, and
close/reopen behavior remain untested.

## 6. Graceful Shutdown Assessment

**Verified by code inspection and unit tests:**

- `src/index.js` stops accepting new messages for `SIGINT` and `SIGTERM`, then
  calls the injected shutdown handler.
- The shutdown handler drains queued messages, destroys the WhatsApp client,
  and closes the database in that order.
- It is idempotent across repeated signals. If one operation fails, later
  cleanup operations are still attempted and the exit code is set to `1`.
- `test/shutdown.test.js` verifies ordering, repeated-signal idempotency, and
  continued cleanup after failures.

**Not verified at runtime:** Signal delivery to a running Friday process,
draining a real WhatsApp queue, destruction of a live client, and closure of
the production SQLite handle.

## 7. Safe Integration Tests and Tests Not Performed

The configured automated suite and the focused message-service tests are safe
to run without WhatsApp credentials, real API keys, or network access: they
inject fakes for outbound messaging, AI, and service dependencies. The video
unit tests use injected command runners and temporary files rather than
downloading from social platforms.

No separate live integration test was run. In particular:

- The application bootstrap was not started because it initializes WhatsApp
  and may access local authentication state.
- No real WhatsApp messages or media were sent or downloaded.
- No real Gemini request was made.
- SQLite initialization could not be exercised using the observed Node 18
  runtime, and no existing database was touched.
- Node 24-specific startup, built-in SQLite behavior, and existing database
  compatibility could not be validated because the requested Node executable
  is absent from this environment.

## 8. Remaining Risks

1. The declared minimum runtime remains unmet by this agent environment, so
   successful checks/tests here do not constitute supported-runtime
   verification.
2. The database opens and creates schema at module import time relative to the
   process working directory. Running the application from a different
   directory may select a different database path.
3. There is no migration/version mechanism or direct SQLite test coverage in
   the configured suite; schema compatibility and data lifecycle need a
   controlled Node 24 test using a separate temporary database.
4. No test exercises the complete `whatsapp-web.js` event-to-normalized-message
   adapter. Unit tests validate the application service using normalized
   fakes, not actual SDK message objects.
5. Startup and real shutdown paths remain dependent on WhatsApp, local
   authentication state, and Node 24 SQLite behavior; they were intentionally
   left unexecuted to avoid external side effects.

## 9. Conclusion

Sprint 1's syntax checks and all 99 configured tests pass under the available
Node 18 runtime. Code inspection confirms that the extracted application
service is wired as the message-routing boundary and that queue/deduplication
remain in the WhatsApp composition root. SQLite startup and full application
integration are **not runtime-verified**. Repeat `npm run check` and `npm test`
with the actual Node.js `v24.22.1` WSL executable to complete the requested
supported-runtime verification; exercise SQLite only against a disposable
test database, never by resetting the existing Friday database.
