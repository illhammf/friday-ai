# Sprint 4.9C — Conversation Reliability & Observability

## Audit Notes (Written Before Implementation)

The following findings were recorded from the existing implementation and Sprint 4.9B report before changing source code.

1. The conversation pipeline has identifiable stages, but no shared correlation value connects the WhatsApp event, queued task, AI request, reply submission, and history write. The runtime uses human-readable terminal messages rather than a stable structured event contract.
2. The adapter only logs duplicate events, queue-full replies, and queue task errors, using different free-form messages. The queue itself correctly catches a prior task rejection before starting the next task, but reports no queue stage or safe error category.
3. The message service has many useful local catch paths. Its outer catch logs a raw error and attempts one generic reply; however, the log does not consistently identify the processing stage, and a thrown transport error in some non-AI branches can enter this catch and cause a fallback attempt even when the first send outcome is uncertain.
4. The text AI reply path already avoids a second fallback after a rejected send promise, treats a null result as uncertain, and does not persist a turn in either case. A successful non-null result is only a local submission result; it does not prove recipient delivery. History persistence failures are caught and not retried, preventing duplicate rows/replies.
5. `askFriday()` logs model attempts, fallback notices, response duration, and token counts. It does not carry an application correlation ID; logs use model names and some provider error values. The safe WhatsApp failure mapper already hides provider diagnostics.
6. Media paths log some raw errors and selected media metadata. Some user-facing media errors ask an administrator to inspect logs, while diagnostic fields can vary by path. No media payload or message body is intentionally logged by the audited code.
7. There is no `/status` command. A useful safe status would need live readiness state injected into the command router and careful private/group response policy. A generic status response would duplicate `/ping`; detailed status risks exposing operational state in groups. The audit found no sufficiently useful, safe need to add it in this sprint.
8. The Sprint 4.9B test suite covers reply and persistence behavior but does not assert structured log fields, correlation propagation, safe error categories, or queue-stage diagnostics.

## 1. Executive Summary

Sprint 4.9C adds structured, privacy-conscious conversation stage logs and deterministic error categories. A generated correlation ID follows an accepted incoming message through normalization, service processing, AI request/response validation, outbound submission, and history persistence. Logs contain stage, outcome, category, and correlation ID, but never message text, AI response text, session/chat/sender IDs, credentials, or memory. Existing flow, user messages, retry policy, persistence semantics, and tool security boundary remain unchanged.

## 2. Existing Observability Audit

The full pipeline remains WhatsApp `message` event → queue admission/deduplication → normalization → `createMessageService()` → session/history/memory preparation → legacy Gemini call → answer formatting → WhatsApp submission → atomic conversation history write. The queue serializes work per chat and safely continues after a task rejects. Existing application logs are a mixture of formatted terminal events, `logger.error()` calls, and adapter console messages. They do not share a correlation ID or consistent field names.

## 3. Concrete Problems Found

- Operators could not reliably connect an accepted event to its later AI, transport, or persistence outcome.
- Queue admission/rejection and service processing did not emit a consistent stage result.
- Raw `Error` objects were logged in different formats, making safe category-based triage inconsistent.
- A few exception paths could reach the outer generic fallback after an uncertain outbound side effect. This sprint must ensure the top-level fallback only happens before a reply attempt, without altering already-safe AI send behavior.
- `/status` would either duplicate `/ping` or disclose runtime state in group conversations; no command is added.

## 4. Changes Implemented

- Added `src/application/conversation-observability.js` with opaque UUID correlation IDs and deterministic categories for validation, provider, transport, persistence, media, and internal failures. Classification returns a category only; it does not serialize error messages or stacks.
- The WhatsApp adapter records accepted/rejected events, queue processing start, normalization rejection, queue-full notice outcome, and queue task failures. The correlation ID is passed alongside the normalized message, not derived from WhatsApp identifiers.
- The message service records processing, routing, AI request/response validation, outbound reply/media submission, and history persistence stages. Per-message stage closures avoid shared mutable correlation state across concurrent chats.
- The runtime emits JSON log records with timestamp, component, stage, correlation ID, outcome, optional category, and safe numeric Gemini timing/token metrics. Existing raw error inspection was removed from the production message and queue logger adapters; error messages, stacks, provider diagnostics, message/response text, chat/session identifiers, and memory are not serialized there.
- A null outbound result or a thrown outbound call is recorded as uncertain. The generic outer fallback is suppressed after any outbound attempt. Existing bounded Gemini retry/model fallback remains unchanged; history persistence is not retried after a submitted reply.
- Updated tests cover categories, opaque IDs, structured correlated stages, content redaction, and uncertain transport handling.

No `/status` command, dependency, database schema, persistent tracking, or acknowledgment subsystem was added.

## 5. Logging Fields and Error Categories

Runtime stage records use `timestamp`, `component: "conversation"`, `stage`, `correlationId`, `outcome`, and optional `category` and safe `operation`. Gemini response records may also contain numeric `durationMs`, `inputTokens`, `outputTokens`, and `totalTokens`; these values are included only when finite numbers. No user text, assistant text, credentials, memory, or WhatsApp/session identifiers are part of this structured record. Correlation IDs are generated UUIDs and are process-local.

The classifier uses these deterministic categories: `validation_error`, `provider_error`, `provider_rate_limit`, `provider_unavailable`, `transport_error`, `transport_uncertain`, `persistence_error`, `media_error`, and `internal_error`. Transport exceptions and missing send results are `transport_uncertain`, because local application evidence cannot establish whether WhatsApp accepted the message remotely. Unknown errors map to `internal_error`; they never map to success.

## 6. Conversation Stage Tracking

The adapter tracks `message_received` as accepted or rejected, then queue processing start and normalization rejection where applicable. The service tracks `message_processing`, `message_routed`, `ai_request`, `ai_response_validation`, `reply_submission`, `history_persistence`, media submission, voice download/transcription, and failures. The runtime tracks provider request/attempt/retry/fallback/response stages. Correlation is passed through the existing normalized message and injected assistant call; no schema or durable state was introduced.

## 7. Failure-Handling Behavior

Queue task rejections are observed after the queue's existing rejection-safe continuation behavior. Queue-full reply submission handles synchronous throws and promise rejections through one promise chain and records a submitted/uncertain outcome. The generic service fallback is sent only when no outbound attempt occurred; after a possibly completed send, Friday does not issue another generic full reply. A successful non-null send result remains local submission evidence, not recipient delivery. History write failures are logged as persistence failures and are not retried. Existing provider retries and fallback model behavior remain bounded and unchanged.

## 8. `/status` Decision and Security Considerations

No `/status` command is added. `/ping` already gives users a deterministic responsiveness check. A richer command would need runtime readiness state and must suppress details in group conversations; that added state and policy do not provide enough value for this sprint.

## 9. Security Boundaries Preserved

No tool executor/orchestrator was connected, no Gemini function calling or privileged action was enabled, and identity verification, private/group classification, session derivation, memory policy, and grant behavior were not changed. The message body and AI answer are intentionally absent from the structured logging interface. No `/status` operational details are exposed in private or group chats.

## 10. Automated Test Results

Local verification used Node `v18.19.1`, below the declared Node `>=24` engine requirement. `npm run check` passed. The focused conversation/adapter/queue/observability set passed 47/47. Full `npm test` reported 304 tests: 294 passed, 2 failed, 8 skipped, 0 cancelled. The two failing files (`test/database-migrations.test.js` and `test/smart-memory.test.js`) could not import `node:sqlite`; SQLite tests were skipped for the same runtime limitation. `git diff --check` passed. Therefore the full required-runtime verification is not complete.

## 11. Known Limitations

Logs describe local application stages. They cannot establish WhatsApp recipient delivery or read state. Correlation IDs are process-local and are not persisted. Some legacy human-readable success/startup events remain alongside the new structured message pipeline stages. Full Node `>=24` verification is required because the current environment provides Node 18.

## 12. Recommended Next Sprint

Run the full test suite under Node `>=24`. Consider adding a separate acknowledgment-tracking design only if operational requirements need recipient delivery status; do not infer delivery from local send results. Keep WhatsApp identity verification and production tool execution on their separate security roadmap.

## Verification and Change Summary

- Changed: `package.json`, `src/application/message-service.js`, `src/friday-runtime.js`, `src/whatsapp/message-adapter.js`, `test/message-adapter.test.js`, and `test/message-service.test.js`.
- Added: `src/application/conversation-observability.js`, `test/conversation-observability.test.js`, and this report.
- Dependencies/lockfiles: unchanged.
- Database schema: unchanged.
- Git working tree: only the nine files above are modified or untracked at completion.
