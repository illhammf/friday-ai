# Friday AI — Sprint 0 Architecture Audit

**Audit date:** 2026-11-08

**Repository:** [illhammf/friday-ai](https://github.com/illhammf/friday-ai)

**Scope:** Read-only inspection of the current source, tests, package metadata,
runtime scripts, and documentation. No database contents, API-key values, or
WhatsApp session credentials were inspected.

## 1. Executive Summary

Friday is a working, single-process WhatsApp assistant with real implementations
for chat, photo analysis, image generation, static stickers, voice-note
transcription and replies, social-video downloads, private user memory, runtime
diagnostics, and controlled message processing. The actual application entry
point is `src/index.js`.

The project has useful boundaries around several operations: image generation,
model fallback, sticker conversion, social-video download/conversion, message
queueing, failure-message formatting, and SQLite persistence each have
dedicated modules and focused tests. However, the application lifecycle and
most routing/business decisions are still implemented in one large event
handler in `src/index.js`. The existing small modules are primarily utilities
and concrete adapters, not a complete application/domain/adapter architecture.

The current memory feature is deliberately explicit and user-controlled, not
the proposed Smart Memory capability. There is no tool registry or Gemini
function calling, multi-agent orchestration, human-approval workflow, scheduler,
or local dashboard in the inspected source. The repository has four empty
JavaScript files whose names imply future service boundaries but currently
contain no implementation.

SQLite currently initializes two tables and two indexes at module import.
There is no schema version or migration runner, no transaction around
multi-statement history writes, and no direct database tests. History and
memory are local to one process/database file; queue deduplication is also
in-memory and is not durable across restarts or shared across instances.

The lowest-risk path toward the long-term vision is incremental: first add
characterization/integration tests around message routing, then extract the
message application service behind injected WhatsApp, AI, media, and
persistence dependencies. Preserve the current WhatsApp behavior, session IDs,
database tables, environment variables, and model fallback settings while
introducing those seams. Add schema migrations only when an approved feature
requires schema changes.

### Audit verification

- `npm test`: **86 tests passed, 0 failed**.
- `npm run check`: passed.
- The shell used for this audit reports Node.js **18.19.1**, while
  `package.json` requires Node.js **>=24**. The test suite passes in this
  environment, but that is not a supported-runtime validation of the whole
  application; the tests do not import the SQLite module or start WhatsApp.
- Worktree was clean before this report was created.

## 2. Current Architecture

### Architectural shape

Friday is a single Node.js process using JavaScript ES modules. `src/index.js`
loads environment configuration, creates the Gemini/WhatsApp clients, registers
WhatsApp lifecycle handlers, routes incoming messages, invokes concrete media
and database helpers, and handles shutdown. Most application orchestration is
imperative and lives inside that entry point.

Current dependencies flow directly from the entry point to concrete
implementations:

```text
WhatsApp Web event
       |
       v
src/index.js
  |-- AI behavior, context assembly, Gemini client
  |-- message routing and response delivery
  |-- SQLite history/memory helpers
  |-- WhatsApp media download helper
  |-- sticker, voice-note, and video helpers
  `-- runtime diagnostics and shutdown
```

Some utilities already accept injected functions for testing, notably the
sticker/video FFmpeg commands, social-video downloader, image-generation API
call, runtime command runner, and memory store. This is useful prior art for
introducing ports without a broad rewrite.

### Actual entry point

`package.json` declares `src/index.js` as `main`, and `npm start` executes
`node src/index.js`. The WhatsApp `Client` is constructed in that file using
`LocalAuth` and headless Puppeteer. `src/ai/gemini.js` constructs a singleton
`GoogleGenAI` client from `GEMINI_API_KEY`.

### Tightly coupled areas

- `src/index.js` owns both WhatsApp transport callbacks and application
  decisions: message eligibility, group-prefix behavior, memory command
  routing, video/sticker/image-generation selection, history context,
  conversation style, voice-note response selection, persistence, delivery,
  and top-level errors.
- The local `askFriday()` function in `src/index.js` retrieves history and
  memory, constructs Gemini content/system instructions, calls fallback
  models, logs token usage, and persists the generated exchange.
- The same entry point imports `MessageMedia` and sends WhatsApp text/media
  directly, so use cases are coupled to `whatsapp-web.js` data types and APIs.
- `src/whatsapp/download-media.js` evaluates code in WhatsApp Web's Puppeteer
  page and accesses internal `WAWebCollections` and
  `WAWebDownloadManager` modules.
- `src/audio/transcribe-voice-note.js` and
  `src/audio/generate-voice-note.js` call the global Gemini client directly
  and hard-code their model/interaction formats.
- `src/database/sqlite.js` opens the database and creates tables as a module
  import side effect.
- `src/ai/ask-friday.js`, `src/config/env.js`, `src/whatsapp/client.js`, and
  `src/whatsapp/message-handler.js` are zero-byte files; they are not current
  service boundaries.

## 3. Repository Structure

### Application source

| Path | Current responsibility |
| --- | --- |
| [`src/index.js`](../../src/index.js) | Entry point; creates clients, registers WhatsApp events, routes messages, assembles chat context, calls AI/media services, persists selected results, sends replies, logs failures, and wires startup/shutdown. |
| [`src/ai/ai-failure-message.js`](../../src/ai/ai-failure-message.js) | Maps Gemini error categories to safe user-facing chat responses. |
| [`src/ai/ask-friday.js`](../../src/ai/ask-friday.js) | Empty placeholder; no exported behavior. |
| [`src/ai/conversation-style.js`](../../src/ai/conversation-style.js) | Detects explicit/adaptive response styles and returns style instructions. |
| [`src/ai/gemini.js`](../../src/ai/gemini.js) | Loads `.env`, validates `GEMINI_API_KEY`, and creates the `GoogleGenAI` singleton. |
| [`src/ai/generate-image.js`](../../src/ai/generate-image.js) | Detects/extracts supported generated image data, classifies image quota errors, retries temporary errors, and runs an image-model fallback chain. |
| [`src/ai/image-generation-request.js`](../../src/ai/image-generation-request.js) | Recognizes image-generation requests and filters common description/caption questions and negations. |
| [`src/ai/model-fallback.js`](../../src/ai/model-fallback.js) | Builds ordered, deduplicated model lists; classifies fallback-worthy failures; calls configured candidates in order. |
| [`src/ai/user-memory.js`](../../src/ai/user-memory.js) | Parses explicit memory commands, applies input/secret/size limits, and builds untrusted memory context for Gemini. |
| [`src/audio/generate-voice-note.js`](../../src/audio/generate-voice-note.js) | Calls Gemini TTS, writes temporary WAV data, converts it to OGG/Opus using FFmpeg, and returns a cleanup callback. |
| [`src/audio/transcribe-voice-note.js`](../../src/audio/transcribe-voice-note.js) | Validates and stages incoming audio, uploads it to Gemini, requests transcription, and removes local temporary files. |
| [`src/audio/voice-note-failure.js`](../../src/audio/voice-note-failure.js) | Identifies quota failures and builds a text-response fallback for voice delivery failures. |
| [`src/config/env.js`](../../src/config/env.js) | Empty placeholder; environment loading currently occurs through `dotenv/config` in `src/index.js` and `src/ai/gemini.js`. |
| [`src/config/runtime-diagnostics.js`](../../src/config/runtime-diagnostics.js) | Checks Node version, API-key presence (without printing its value), `yt-dlp`, and FFmpeg. |
| [`src/config/system-instruction.js`](../../src/config/system-instruction.js) | Large Indonesian FRIDAY behavior/system prompt; feature execution remains in application code. |
| [`src/database/history.js`](../../src/database/history.js) | Re-exports SQLite history, memory, session-ID, and close functions. |
| [`src/database/sqlite.js`](../../src/database/sqlite.js) | Opens `data/friday.sqlite`, creates current schema/indexes, and implements history/memory operations. |
| [`src/video/download-social-video.js`](../../src/video/download-social-video.js) | Validates supported social hosts, invokes `yt-dlp`, converts to H.264/AAC MP4, enforces size/time bounds, and cleans temporary files. |
| [`src/video/video-download-failure.js`](../../src/video/video-download-failure.js) | Maps download, conversion, and send errors to WhatsApp-safe explanations. |
| [`src/video/video-download-request.js`](../../src/video/video-download-request.js) | Requires an explicit download action and rejects negated requests. |
| [`src/whatsapp/client.js`](../../src/whatsapp/client.js) | Empty placeholder; client setup lives in `src/index.js`. |
| [`src/whatsapp/download-media.js`](../../src/whatsapp/download-media.js) | Retrieves/decrypts WhatsApp media in the browser page and retries failed downloads. |
| [`src/whatsapp/format-message.js`](../../src/whatsapp/format-message.js) | Normalizes generated text/Markdown for WhatsApp display. |
| [`src/whatsapp/image-sticker.js`](../../src/whatsapp/image-sticker.js) | Detects sticker intent/options, writes a static WebP sticker using FFmpeg, enforces limits, and returns safe failure messages. |
| [`src/whatsapp/message-handler.js`](../../src/whatsapp/message-handler.js) | Empty placeholder; routing lives in `src/index.js`. |
| [`src/whatsapp/message-queue.js`](../../src/whatsapp/message-queue.js) | Per-chat FIFO queue, bounded pending work, in-memory message deduplication, and queue eligibility checks. |
| [`src/whatsapp/shutdown.js`](../../src/whatsapp/shutdown.js) | Idempotent shutdown sequence that drains messages, destroys WhatsApp client, closes resources, and reports cleanup failures. |
| [`scripts/doctor.js`](../../scripts/doctor.js) | CLI runtime/dependency diagnostic using `src/config/runtime-diagnostics.js`. |

### Tests and project metadata

- `test/` contains 13 test files; see [Testing Assessment](#7-testing-assessment).
- `src/backups/` contains five tracked historical `index.js` snapshots:
  `index.js.backup`, `index.js.before-audio`, `index.js.before-database`,
  `index.js.before-gemini-fix`, and `index.js.before-system-instruction`.
  These are not active modules in the current entry-point import graph.
- Root configuration/documentation includes `package.json`,
  `package-lock.json`, `.env.example`, `.gitignore`, `README.md`, `LICENSE`,
  and `CITATION.cff`.
- `.gitignore` excludes `.env`, WhatsApp authentication/cache directories,
  local SQLite database files, `node_modules`, and logs.

## 4. Message Lifecycle

The current message path is implemented primarily by the `message` event
callback and `handleIncomingMessage()` in `src/index.js`.

1. **Receive:** `whatsapp-web.js` emits `client.on('message')`.
2. **Eligibility and deduplication:** The callback ignores events during
   shutdown, calls `isQueueableMessage()`, constructs a key from WhatsApp chat
   and message IDs, and claims it in an in-memory cache. Duplicate event
   deliveries are discarded. The cache is bounded and has a 24-hour TTL, but
   is not persisted.
3. **Queue:** `createMessageQueue()` enqueues work under `message.from`.
   Messages from a chat run in FIFO order; different chat queues may run
   independently. The default allows one active task plus up to three
   additional pending tasks per key. A full queue triggers a retry notice.
4. **Validation/readiness:** `handleIncomingMessage()` rejects self/unsupported
   messages, checks timestamps against the time Friday became ready, and
   determines private versus group chat. Group text must start with
   `BOT_NAME`; unaddressed groups are ignored.
5. **Session identity:** Private sessions use `private:<user-id>`. Group
   conversations use `group:<group-id>` for shared history. In group messages,
   the sender's private session is separately available for user identity,
   but memory commands are explicitly rejected in groups and group AI context
   loads no private memories.
6. **Pre-routing commands:** Social-video intent/link count is detected.
   Explicit memory commands are handled before the general chat lock and
   return early.
7. **Per-session lock:** `activeChats` prevents overlapping operations on the
   same private session. The queue is keyed by WhatsApp chat; in group chats,
   queue serialization is per group while the lock key is derived from the
   sender's private session.
8. **Feature routing and media processing:**
   - Explicit social-video requests call `downloadSocialVideo()`, then send
     the converted file through `client.sendMessage()`. Internal errors are
     logged; a stage-aware user message is returned. Video requests do not
     currently enter the conversation-history table.
   - Incoming voice notes use `downloadMediaWithRetry()` and
     `transcribeVoiceNote()`; the transcript is added to the question.
   - Incoming images use `downloadMediaWithRetry()`. A detected sticker request
     goes to `createImageSticker()` and is sent as a WhatsApp sticker. Other
     images are passed inline to the chat AI.
   - Image-generation requests without an attached image call `generateImage()`
     and send the generated image.
   - Remaining requests call local `askFriday()`, including normal text,
     image analysis, and transcribed voice content.
9. **History/context retrieval:** `askFriday()` loads at most ten recent
   `messages` rows from the active session and, only in private chats, loads
   user memories. It prepends the system prompt, conversation-style
   instruction, and memory instruction to a Gemini `generateContent()` call.
   Current image bytes are supplied inline; stored prior history is text only.
10. **AI, fallback, and accounting:** Chat tries `GEMINI_MODEL` then configured
    fallback models. The chat wrapper retries transient non-quota errors;
    quota errors move immediately to the next model. Successful token usage is
    logged to the terminal but is not written to a usage table or budget.
11. **Persistence and delivery:** `askFriday()` saves the user/model text
    exchange after a successful AI response and before the WhatsApp reply is
    sent, so a failed outbound send can leave an exchange in history. Image
    generation and sticker records are saved after their sends. Voice-note
    content flows through `askFriday()` before attempting audio delivery.
    Memory commands have their own storage and are not ordinary chat history.
12. **Errors and cleanup:** Feature helpers provide specialized failure
    messages; the outer handler logs exception details and uses a safe AI
    fallback response. Queue task rejections are logged by the event callback.
    Shutdown stops new queue admission, drains current queue work, then closes
    WhatsApp and SQLite.

### Entry-point coupling

Routing, session construction, media decisions, AI context assembly, response
delivery, persistence timing, and error mapping are interwoven in
`src/index.js`. `handleIncomingMessage()` is not a separately injectable
application service. There is no transport-neutral message/use-case contract
or integration harness that can exercise the entire lifecycle without
constructing the concrete client and database modules.

## 5. Database Assessment

### Initialization and current schema

`src/database/sqlite.js` imports `DatabaseSync` from `node:sqlite`, creates a
`data/` directory relative to the process working directory, opens
`data/friday.sqlite`, and executes `CREATE TABLE IF NOT EXISTS` plus index
creation when the module loads.

Current schema:

```sql
messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('user', 'model')),
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)

user_memories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (session_id, content)
)
```

Indexes:

- `idx_messages_session` on `messages(session_id, id)`
- `idx_user_memories_session` on `user_memories(session_id, id)`

No schema version, migration table, foreign keys, or explicit database
configuration is present in the inspected initialization code.

### History

`saveMessage()` inserts one row, then separately deletes all but the latest
20 rows for that session. `loadHistory()` fetches recent rows in reverse
chronological order, reverses them into conversation order, and applies its
requested limit (default 10). Chat uses `loadHistory(activeSession, 10)`.
History is therefore bounded per session during writes, but it is a row count,
not a turn count or token-budget policy. `closeDatabase()` closes the singleton
connection.

### Current memory

`user_memories` stores explicit text memories keyed by a session ID. The
application uses `private:<user-id>` and does not load memory into group
context. `user-memory.js` applies a 30-entry maximum, a 500-character limit,
duplicate checks, and simple keyword rejection for credentials/secrets.
`saveUserMemory()` checks case-insensitive duplicates and count in application
code, then uses `INSERT OR IGNORE` with a SQL unique constraint. Memory is
plain local data, not encrypted.

### Transactions, lifecycle, and gaps

- `saveMessage()` insert and history trimming are separate statements without
  an explicit transaction. A failure between them can leave extra history.
- Memory count/duplicate checks and insertion are also separate operations,
  though the current synchronous single-process design limits interleaving.
- No migration mechanism or direct SQLite tests exist.
- The database path is relative to the current working directory, so changing
  launch directory changes which local database file is used.
- SQLite APIs are synchronous. Current operations are small, but more
  frequent writes, a dashboard, or concurrent jobs would need explicit
  contention/lifecycle handling.
- `src/database/history.js` is only a re-export facade; it does not add
  repository abstraction, transaction semantics, or lifecycle ownership.

**Compatibility requirement:** retain the current `messages` and
`user_memories` data and session-ID formats. Any schema change should use an
explicit, tested migration and a backup/rollback strategy, not destructive
table recreation.

## 6. AI Integration Assessment

### Client, configuration, and models

`src/ai/gemini.js` initializes `GoogleGenAI` from `GEMINI_API_KEY` and throws
if it is missing. Chat defaults to `gemini-3.5-flash-lite` via `GEMINI_MODEL`;
ordered fallbacks come from `GEMINI_FALLBACK_MODELS` and the legacy
`GEMINI_FALLBACK_MODEL`. Image generation has a separate primary model and
`GEMINI_IMAGE_FALLBACK_MODELS`, because image output capability differs.
Voice transcription and TTS use hard-coded Gemini model names in their audio
modules and do not use the chat/image fallback chain.

### Retry and fallback

Chat uses `generateWithRetry()` in `src/index.js`, with at most two attempts
for temporary non-quota failures. Quota errors bypass retry so
`generateWithModelFallback()` can move to the next model. The fallback helper
also recognizes selected server errors and model-not-found responses; invalid
credentials/permissions are not classified as fallback-worthy by its tests.
Image generation has its own retry loop and model chain in
`src/ai/generate-image.js`.

There is no shared provider interface, capability declaration, provider
selection policy, circuit breaker, model-health cache, or quota ledger. Model
fallback settings are helpful but require operator-maintained model lists.

### Context and system instruction

`askFriday()` builds request contents from up to ten prior text message rows,
the current user text, and current inline image bytes. It builds system
instructions from the large `systemInstruction`, a per-message style
instruction, and optional memory context. The app supplies only currently
attached image data; prior images are not stored/replayed as image parts.

Memory content is encoded as JSON in the instruction and explicitly described
as user-provided, untrusted context. There is no explicit context token
budgeting/truncation strategy beyond limiting the number of history rows.

### Image and audio

- Image understanding goes through the chat model with the current image
  attached as `inlineData`.
- Image generation parses Gemini response candidates and validates returned
  MIME type/base64 before sending. It maps quota/service/configuration failures
  to user-safe messages.
- Incoming audio is staged locally, uploaded to Gemini, and transcribed via
  `ai.interactions.create()`. The code cleans its local temporary directory;
  it does not call a remote file-delete API in the inspected implementation.
- TTS calls `ai.interactions.create()`, writes returned audio locally, then
  uses FFmpeg to produce OGG/Opus. Failures are caught by the entry point and
  text fallback is attempted.
- There are no provider-level mocks or direct unit tests for actual
  transcription/TTS request construction, remote file lifecycle, or FFmpeg
  audio conversion.

### Reusable abstraction seams

`src/ai/model-fallback.js`, injected image generation, and command-runner
injection offer an initial seam. A future provider port should model
capabilities separately—text generation, image understanding/generation,
transcription, and speech synthesis—rather than assuming every model/provider
supports every modality. Keep Gemini as the first adapter and preserve current
model-chain behavior while moving orchestration out of `src/index.js`.

## 7. Testing Assessment

### Existing suite

`npm test` invokes Node's built-in `node:test` runner for 13 files and 86 test
cases:

| Test file | Main coverage |
| --- | --- |
| `test/conversation-style.test.js` | Style detection, negation, contextual tone, instruction boundaries. |
| `test/download-media.test.js` | Media-download retry and MIME forwarding into WhatsApp decryption. |
| `test/format-message.test.js` | Markdown/HTML normalization and WhatsApp-readable output. |
| `test/image-generation.test.js` | Request recognition, response validation, retry, model fallback, quota diagnostics, safe errors. |
| `test/image-sticker.test.js` | Intent/options parsing, FFmpeg argument shape, output limits, cleanup, sticker errors. |
| `test/message-queue.test.js` | FIFO behavior, bounded queue, cross-chat concurrency, draining, eligibility, in-memory dedupe. |
| `test/model-fallback.test.js` | Model-list normalization/order, fallback errors, auth failures, exhausted chains. |
| `test/runtime-diagnostics.test.js` | Required/optional dependency results and API-key redaction. |
| `test/shutdown.test.js` | Drain/destroy/close order, idempotency, cleanup errors. |
| `test/social-video.test.js` | URL validation, explicit download intent, command/conversion injection, size limits, cleanup, selected failures. |
| `test/user-memory.test.js` | Command parsing, in-memory fake store, private scoping, bounds, unsafe strings, instruction handling. |
| `test/video-download-failure.test.js` | User-facing video failure categories and diagnostic redaction. |
| `test/voice-note-failure.test.js` | Voice quota and text fallback messaging; shared AI error messaging. |

### Mocking strategy

Tests mostly call pure helpers or inject fake commands/stores/generators.
WhatsApp's browser context is simulated by temporarily installing
`globalThis.window`. Sticker and video tests commonly stub FFmpeg/`yt-dlp`
while checking arguments and temporary-file cleanup. Memory tests use an
in-memory fake store rather than SQLite. No external API or real WhatsApp
account is used by the suite.

### Coverage gaps and missing regressions

- No tests for `src/index.js` or an end-to-end incoming-message lifecycle:
  readiness/timestamps, group routing, branch priority, sends, history timing,
  and outer error behavior are not tested as a whole.
- No tests for `src/database/sqlite.js` or `history.js`: actual DDL, retention,
  isolation, uniqueness, migration, transaction behavior, and close/reopen
  behavior are unverified.
- No direct tests for `src/ai/gemini.js` initialization or `scripts/doctor.js`
  CLI output/exit behavior.
- No direct tests for voice-note transcription/TTS model calls, uploaded-file
  cleanup, actual audio FFmpeg arguments/output, or text fallback delivery.
- No WhatsApp client integration tests for QR/auth/ready/disconnect/shutdown.
- Media tests use fake process outputs; they do not prove compatibility with
  changing WhatsApp Web internals or TikTok/Instagram responses.
- Queue/dedup tests cover in-process behavior only; they do not test restarts,
  multiple Friday instances, or durable duplicate suppression.
- No tests yet for allowlists/permission checks, tool execution, approvals,
  scheduler concurrency, dashboard authentication, or schema migration because
  those features do not exist.

Before feature work, add characterization tests around routing and
persistence/delivery boundaries without connecting real accounts or services.
Use temporary SQLite files for database tests under Node 24.

## 8. Architecture Gap Analysis

| Target capability | Status | Evidence and gap |
| --- | --- | --- |
| Smart Memory System | **Partially implemented** | `user-memory.js` supports explicit private-chat save/list/delete/clear and bounded memory context. It has no semantic retrieval, episodic/summary memory, salience/expiry, provenance, recall policy, or comprehensive settings/consent lifecycle. |
| Tool Calling and Tool Registry | **Not implemented** | `index.js` uses explicit regex/branch routing for image, sticker, voice, and video. No Gemini function declarations, tool schemas, common registry, typed result contract, or policy-enforced executor is present. |
| Multi-Agent Orchestration | **Not implemented** | There is one assistant context and one request path. No agent definitions, delegated runs, planner, task graph, or agent state. |
| Permission and Human Approval System | **Not implemented** | Explicit user wording gates social download, but there is no general permission model, approval queue, owner allowlist, confirmation token, or durable audit record. |
| Proactive Assistant and Scheduler | **Not implemented** | No scheduler, background job table, timers, recurrence parser, delivery policy, or startup recovery. |
| Local Web Dashboard | **Not implemented** | The interface is WhatsApp plus terminal/QR diagnostics. There is no HTTP server, UI, local API, or dashboard authentication. |

## 9. Technical Risks

1. **High change blast radius:** business routing and provider/transport calls
   share a large `src/index.js` handler. Adding tools, approval states, or jobs
   directly there will increase branch interactions and make regression
   testing harder.
2. **No sender allowlist:** any message accepted by the linked account's event
   stream can invoke private-chat AI/media paths. This can consume quota and
   process content from people beyond the owner unless deployment controls
   restrict access.
3. **Unofficial WhatsApp internals:** browser-side decryption uses private
   `WAWeb*` modules and Puppeteer page internals, which may change without
   compatibility guarantees.
4. **Process-local reliability:** queue and dedup state disappear on restart
   and are not shared across instances. Queue admission is not a durable job
   system or exactly-once send guarantee.
5. **Persistence/delivery divergence:** normal AI exchanges are committed
   before outbound send; video messages are not saved to conversation history.
   Other branches persist at different points. Retries after uncertain sends
   could not be reconciled using a durable outbound-message ledger.
6. **No schema evolution path:** `CREATE TABLE IF NOT EXISTS` handles only
   initial creation. New state for approvals/tools/schedules will require
   explicit migrations and tested rollback/backup behavior.
7. **Local data is not encrypted:** history and memories are stored in a local
   SQLite database; WhatsApp session credentials and API keys also exist as
   local runtime data. The report does not inspect or reproduce those values.
8. **Provider-specific orchestration:** chat/image/transcription/TTS have
   separate Gemini APIs, retry rules, error handling, and model settings.
   Adding providers without an explicit capability contract risks inconsistent
   behavior and hidden paid model usage.
9. **No usage ledger/budget:** token counts are terminal logs only; there is no
   per-user quota, cost cap, or persisted usage view.
10. **Runtime evidence gap:** audit tooling here uses Node 18 although the
    project requires Node 24. SQLite and the running bot were not validated in
    this environment.
11. **Startup diagnostics ordering:** `src/ai/gemini.js` throws during module
    initialization if the API key is missing. Since `src/index.js` statically
    imports it, the later runtime-diagnostic routine cannot report this
    particular startup failure first; `npm run doctor` remains a separate
    check.
11. **Empty and historical source files:** four empty placeholder modules and
    old source snapshots can mislead maintainers about active architecture
    and increase repository navigation noise.
12. **Audio remote-file lifecycle:** transcription uploads audio to Gemini but
    no remote deletion call is visible in the current implementation; verify
    provider retention semantics and add explicit cleanup where supported.

## 10. Proposed Target Architecture

Use incremental ports/adapters around the existing code; do not rewrite
features or move every file in one change.

```text
src/
  application/
    message-service.js       # transport-neutral message use cases/routing
    conversation-service.js  # history/context/AI orchestration
    tool-execution-service.js
    approval-service.js
  domain/
    conversation.js          # session/message policies and value objects
    memory.js                # memory policy and retrieval contracts
    permissions.js           # actor/resource/action policy
    tools.js                 # tool definitions and execution results
  ports/
    chat-provider.js
    media-provider.js
    message-repository.js
    memory-repository.js
    messenger.js
    scheduler.js
  adapters/
    whatsapp/                # existing client, message/media adapters
    gemini/                  # text, vision, image, transcription, TTS
    sqlite/                  # existing history/memory repository + migrations
    media/                   # FFmpeg and yt-dlp process adapters
  tools/
    registry.js
    definitions/
  jobs/
    scheduler-service.js
    job-repository.js
  web/                       # optional loopback-only dashboard and API
```

The names are a target organization, not a requirement to create all these
directories immediately. Keep `src/index.js` as the composition root that
constructs adapters and registers WhatsApp lifecycle events. Use plain
JavaScript contracts/JSDoc initially; no type-system or dependency change is
required to obtain the first useful seams.

### Design boundaries

- **Application services** accept normalized messages and injected ports;
  they do not import `whatsapp-web.js`, Gemini SDK objects, or process globals.
- **WhatsApp adapter** translates library messages/events/media and delivery
  outcomes to application DTOs.
- **AI provider port** exposes modality-specific capabilities and normalized
  errors/usage. Gemini is the first adapter; fallback policy remains outside
  provider SDK details.
- **Repositories** own persistence operations and transactions. Use cases do
  not construct SQL or open the database.
- **Tool registry** stores immutable metadata/schema and handler references.
  Execution must pass permission/policy checks and return a normalized result.
- **Approval service** records pending action, requester, target, expiry, and
  status; approvals bind to a specific action and cannot be reused.
- **Scheduler** stores jobs durably and recovers pending work after restart;
  WhatsApp send retries need an idempotency strategy.
- **Dashboard** is optional, local-only by default, authenticated even on
  localhost, and must not expose raw credentials, QR/session data, or
  unrestricted tool execution.

### Database evolution policy

Do not change the existing schema as part of Sprint 0. Before adding
tool/approval/job tables, introduce a versioned migration runner that:

1. takes or verifies a backup of the current local database;
2. applies ordered, transactional migrations;
3. preserves existing `messages`, `user_memories`, and session IDs;
4. records applied migration IDs and can fail safely before app startup;
5. is tested against an old-schema fixture and an interrupted migration.

Possible later tables include `schema_migrations`, `tool_runs`,
`approval_requests`, and `scheduled_jobs`; add only the tables required by an
approved implementation slice.

## 11. Incremental Migration Roadmap

| Stage | Scope | Compatibility and exit criteria |
| --- | --- | --- |
| 0. Characterize current behavior | Add tests around message routing/branch priority, session IDs, persistence timing, and safe failures using fake ports. | No behavior/schema/dependency change; current 86 tests remain green. |
| 1. Extract message application service | Move the normalized-message lifecycle from `src/index.js` to a small injected service; retain current handlers and WhatsApp adapter. | `src/index.js` remains composition root; preserve private/group behavior, queue order, feature order, and replies. Add router-level tests. |
| 2. Repository and migration boundary | Define history/memory repository contracts; test SQLite using temporary files; add migration framework only when the first schema change is approved. | Existing tables/data/session IDs continue to work; avoid importing/creating DB during unrelated unit tests. |
| 3. AI provider port | Wrap existing Gemini text/image/audio operations and normalize errors, capabilities, usage, and model fallback. | Gemini remains default; existing environment variables and fallback order remain valid. No silent provider switch to a paid model. |
| 4. Tool registry (first platform capability) | Register existing media features as tools with schemas, handlers, timeouts, outputs, and permission metadata; initially retain explicit request routing. | Do not grant the model arbitrary process/URL access. Preserve explicit social-video intent and existing size/time limits. |
| 5. Permission and human approval | Add allowlisted actors/chats and approval records for selected side-effectful tools; start with owner-only configuration and one action requiring confirmation. | Deny by default when policy cannot be established; bind approval to action/parameters/expiry; log decisions without secrets. |
| 6. Smart Memory evolution | Add explicit memory categories/provenance, retrieval limits, retention/forget controls, and evaluation tests before semantic retrieval. | Existing `user_memories` remains readable; group isolation and secret rejection remain; additions require a migration. |
| 7. Multi-agent orchestration | Introduce bounded task delegation only after tools, budgets, permissions, and tracing are stable. | Agents share permission policy; cap depth, calls, latency, context, and model spend. |
| 8. Proactive scheduler | Add durable scheduled-job repository and delivery/retry/idempotency behavior. | Restart-safe jobs, owner controls, timezone/recurrence tests, cancellation, and no unsolicited sends without opt-in. |
| 9. Local dashboard | Add only if operational need is demonstrated; bind to loopback by default and add explicit authentication/CSRF protections. | No public bind by default; redact secrets; manual approval still required for actions. |

No additional runtime dependency is necessary for Stages 0–3. Later dashboard,
advanced scheduling, or semantic-memory dependencies should be selected only
when the corresponding scope is approved and their maintenance/security
trade-offs are known.

### Backward compatibility requirements

- Preserve current commands and Indonesian/English intent behavior.
- Preserve `private:<id>` and `group:<id>` session naming.
- Preserve current history ordering/retention until a separate migration is
  tested and approved.
- Preserve `GEMINI_MODEL`, `GEMINI_FALLBACK_MODEL`,
  `GEMINI_FALLBACK_MODELS`, `GEMINI_IMAGE_MODEL`, and
  `GEMINI_IMAGE_FALLBACK_MODELS`.
- Preserve text/photo/sticker/voice/video reply semantics and WhatsApp-safe
  error messages.
- Preserve local authentication/database locations or provide explicit,
  tested migration instructions before changing them.
- Keep media tools optional for unrelated text-chat startup.

## 12. Recommended First Implementation Task

**Add message-lifecycle characterization tests, then extract the inbound
message use case behind injected ports.**

Suggested bounded first PR:

1. Define a normalized incoming-message DTO containing chat ID, sender ID,
   message ID, type, text/caption, and media reference—without WhatsApp SDK
   internals.
2. Move only routing/orchestration from `handleIncomingMessage()` into
   `src/application/message-service.js`; keep `src/index.js` responsible for
   event registration, client construction, queue/dedupe, and dependency
   wiring.
3. Inject messenger, history/memory repository, AI, and media operations so
   tests use fakes and do not require credentials, WhatsApp login, FFmpeg, or
   a real database.
4. Add regression tests for group prefix behavior, memory-command isolation,
   explicit-only video downloads, image/sticker routing priority, duplicate
   response boundaries, and delivery/persistence ordering.
5. Keep all existing modules and features; no database schema or dependency
   changes in this first implementation.

This task creates the seam required by the future platform capabilities while
limiting the risk of a large rewrite. The audit itself does not implement this
task or any other feature.

## Sprint 1 Implementation Addendum

The Sprint 0 sections above are a snapshot of the repository at audit time.
Sprint 1 has since extracted the inbound message routing into
[`src/application/message-service.js`](../../src/application/message-service.js).
`src/index.js` remains the composition root: it normalizes WhatsApp messages,
keeps queue and deduplication behavior, adapts media and reply operations, and
injects concrete AI, persistence, feature, and delivery dependencies.
Focused transport-free lifecycle tests are in
[`test/message-service.test.js`](../../test/message-service.test.js), with
duplicate and queue-overflow characterization in
[`test/message-queue.test.js`](../../test/message-queue.test.js). The database
schema and runtime dependencies remain unchanged.
