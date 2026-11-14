# Sprint 4.9B — Conversation Experience Improvement

## 1. Executive Summary

Sprint 4.9B improves the legacy WhatsApp conversation path without enabling tools or changing private/group identity rules. The audit found a concrete adapter contract mismatch that prevented normal assistant replies from being sent, and found that AI turns were written to history before the send attempt. Both are fixed. Conversation history is now validated and byte-bounded before reaching Gemini; only complete, recent entries are retained when the application history window is exceeded. Provider responses are checked for usable text and an application size limit. SQLite writes user/assistant turn pairs atomically.

Long content is rejected with a clear response when it exceeds application limits. No WhatsApp length limit is asserted and no message splitting is attempted.

**Verification environment:** `node -v` reports `v18.19.1`, while the repository requires Node `>=24`. `npm run check` passes. The full `npm test` run reports 298 total, 288 passed, 2 failed, and 8 skipped. The two failed test files cannot load Node's `node:sqlite` built-in on this host; SQLite tests are skipped for the same runtime reason. A Node 24 runtime was not available locally, so Node 24 verification remains outstanding.

## 2. Existing Conversation Flow

1. whatsapp-web.js emits an incoming `message` event.
2. `registerQueuedMessageHandler()` filters queueable messages, claims a message-ID deduplication key, and adds accepted messages to the existing queue keyed by chat ID.
3. The WhatsApp adapter normalizes message ID, sender/chat fields, text, type, timestamp, and lazy media download.
4. `createMessageService()` rejects empty/unsupported text and invalid/pre-ready timestamps. Group messages must retain the configured Friday prefix. Deterministic slash commands run before the legacy AI path.
5. Memory commands remain separate. Normal requests derive the existing private sender session or shared group session; group history is shared within its group, while private memory is read only for private requests.
6. `askFriday()` loads up to 10 history rows. SQLite itself retains at most 20 rows per session, queries newest-first, reverses to chronological order, and then applies the requested limit.
7. Private memory retrieval remains separate from history and is included in the system instruction. Group requests receive no private memory.
8. The current prompt and image are combined with validated history. Conversation style and system instructions are constructed as before.
9. Gemini is called through the existing bounded retry/model fallback chain. No function tools are supplied to this production request.
10. A valid text answer is formatted and submitted through the existing WhatsApp reply adapter. A non-null outbound message result is required before the conversation turn is written.
11. The user/model pair is written in one SQLite transaction. A failed write is logged; Friday does not send a second reply after the original response has already been submitted.

## 3. Audit Findings

Findings are ranked by user impact and data integrity.

1. **High — reply transport mismatch.** `registerQueuedMessageHandler()` passed a bare reply function to `createMessageService()`, while the service calls `transport.reply(...)`. Runtime integration therefore raised a type error instead of sending the assistant response. The previous outer error handling could also try a second fallback. The queue now adapts the callback to the service's documented `{ reply }` transport shape; an end-to-end fake WhatsApp test verifies an actual reply.
2. **High — history was saved before outbound send.** `askFriday()` wrote user and model rows before the service attempted to send the reply. A transport failure could leave an undelivered answer in subsequent Gemini context. Persistence has moved to the application service after the send operation returns a non-null message result.
3. **Medium — the legacy Gemini path bypassed existing request limits.** `assistant-request.js` already defined history, current-message, image, system-instruction, and aggregate byte limits, but the production legacy path did not use them. The new conversation context adapter uses this existing validator before building Gemini contents.
4. **Medium — history entries and provider text were weakly validated.** The old code only called optional `.trim()` on `response.text` and did not enforce an output limit. Missing, non-string, empty, and oversized responses now map to concise Indonesian errors and are never persisted.
5. **Medium — persistence pairs could be partial.** Two independent inserts could leave only a user or model row. `saveConversationTurn()` writes the pair and history trim within one transaction, rolling back on failure.
6. **No confirmed ordering or content-dedup defect.** SQLite returns messages in chronological order after reversing its newest-first query. Identical user text can be a valid repeated question, so the context policy preserves duplicates. The application queue continues to serialize messages per chat and the deduplication contract is unchanged.

## 4. Changes Implemented

- Added `src/ai/conversation-context.js` to validate history, apply byte-window selection, convert normalized role/content data into the legacy Gemini request shape, and validate provider response text.
- Updated `src/friday-runtime.js` to use the context adapter before Gemini and to remove premature history writes from `askFriday()`.
- Updated `src/application/message-service.js` to persist assistant turns only after the outbound API returns a message result. Text, voice fallback, generated image, and sticker conversation rows use the atomic writer after their corresponding send result.
- Added `saveConversationTurn()` to `src/database/sqlite.js`; it uses `BEGIN IMMEDIATE`, writes the user/model pair and trims history, then commits or rolls back. No schema migration was required.
- Fixed the queue-to-service reply transport shape in `src/whatsapp/message-adapter.js`.
- Added safe user-facing size/invalid-response messages in `src/ai/ai-failure-message.js`.
- Added focused context, response, routing, persistence, and SQLite rollback tests. Updated `package.json` check/test scripts to include the new module and test file.

## 5. History Management Policy

- The existing application loads the most recent 10 history rows. SQLite retains up to 20 rows per session; older rows are not deleted by context selection.
- Each row must have a supported role and valid text parts. Malformed history fails closed before Gemini; no synthetic history is constructed.
- Whitespace-only history rows are excluded and the count is logged. Identical non-empty rows are retained because repeated wording can be intentional.
- History is kept in its original chronological order. If its combined text exceeds the 64 KiB application window, the oldest complete rows are excluded until the newest suffix fits; the number excluded is logged. A single malformed or over-limit row is rejected rather than truncated.
- The current user prompt is never truncated. SQLite schema and session IDs are unchanged.
- Assistant user/model rows are inserted atomically after the send API resolves with a non-null outbound message result. A persistence failure rolls back the pair and is logged without sending a duplicate response.

## 6. Context Window Policy

The application uses deterministic UTF-8 byte limits already defined in `assistant-request.js`; it does not estimate tokens:

| Content | Application limit |
|---|---:|
| History | 10 messages and 64 KiB of history text |
| Current text prompt | 16 KiB |
| System instruction | 48 KiB |
| Image | 5 MiB |
| Aggregate serialized assistant request | 8 MiB |

History and memory remain distinct. Memory is retrieved only for private sessions and contributes to the system instruction; it is not inserted into conversation history. Group requests continue to receive an empty private-memory context. No automatic summarization is introduced.

## 7. Gemini Error Handling

The existing retry and model fallback policy is unchanged. Provider errors continue to map to the existing quota, temporary-unavailability, and configuration messages without exposing provider details to WhatsApp users.

Before persistence, the legacy assistant now requires a response object whose `text` is a non-empty string after trimming. Missing/non-string and empty responses receive a safe Indonesian message. Responses exceeding the application output cap receive a concise prompt to request a summary or split the question. No answer is fabricated, and invalid responses are not persisted.

Unexpected request/history validation failures are logged internally and receive a generic safe explanation. Error stacks, credentials, headers, and raw provider diagnostics are not sent to WhatsApp.

## 8. Long Message Handling

- Incoming current text above the 16 KiB application limit is rejected before Gemini; it is never silently truncated.
- Context history uses the recent complete suffix described above. The number of older rows excluded is logged.
- Gemini output and formatted outbound assistant text are capped at 32 KiB by this application. Oversized output is rejected with a user-facing request for a shorter answer or summary.
- No WhatsApp platform length limit is inferred from the installed dependency. Text segmentation is not implemented. This avoids partial multi-message delivery and duplicate fallback behavior while transport acknowledgments remain limited.
- The limits are application policies, not claims about WhatsApp's maximum message size.

## 9. Private and Group Compatibility

Private and group session derivation is unchanged. Group prefix handling remains in place. Group history still uses the group session; private history and memory remain scoped to the existing private session. Context normalization does not infer or change WhatsApp identity. Image understanding, voice transcription/reply, sticker generation, video handling, and image-generation routing remain in their established order; successful media sends now use the atomic history writer where a conversation turn is recorded.

The installed WhatsApp Web.js send call may resolve without a result; that case is treated as unconfirmed and not persisted. A non-null result indicates a locally created outbound message model, not recipient delivery or read status. The separate `message_ack` event is not awaited by the current transport, so later device delivery cannot be guaranteed by these history writes.

## 10. Security Boundaries

The legacy conversation path remains the only production AI path. The tool assistant, orchestrator, executor, privileged registry dispatch, and grant lifecycle remain unreachable from WhatsApp messages. No automatic Gemini function calling is enabled. No authorization capabilities, grants, principal rules, identity checks, private/group classification, or session derivation changed.

The adapter change only wraps the existing reply callback in the object shape expected by the application service. It does not change queue ordering, per-chat serialization, admission, or message deduplication.

## 11. Automated Test Results

Final local run:

- Node: `v18.19.1` (repository engine: `>=24`)
- `npm run check`: passed
- `npm test`: 298 total; 288 passed, 2 failed, 8 skipped, 0 cancelled
- The failed test files are `test/database-migrations.test.js` and `test/smart-memory.test.js`; both fail during import because `node:sqlite` is unavailable in Node 18.
- SQLite tests, including the new atomic rollback test, skip when `node:sqlite` is unavailable.
- No live WhatsApp account or Gemini request was used.
- `git diff --check` is run as the final workspace check.

The non-SQLite conversation, adapter, response-validation, and command regressions pass. The SQLite transaction behavior still needs execution under Node `>=24`.

## 12. Known Limitations

- No Node `>=24` executable was available in the local environment. Full SQLite verification is therefore outstanding; no runtime was downloaded or installed.
- WhatsApp Web.js `Message.reply()` delegates to `Client.sendMessage()`. The latter returns an outbound `Message` model or `undefined`; the separate `message_ack` event reports later ACK states. This application does not wait for a device-delivery or read acknowledgment. History therefore records a turn after a non-null local send result, not proof that a recipient received or read it.
- Oversized assistant output is rejected rather than split into multiple WhatsApp messages.
- An atomic history write can fail after the response has been submitted. The failure is logged and not retried; that response will be absent from future history.
- Conversation limits use bytes, not token counts. Provider token usage remains diagnostic data reported by Gemini.
- Private identity verification remains NOT READY from Sprint 4.8D; privileged tool execution stays disabled.

## 13. Manual Verification Guide

Run under Node `>=24` with the existing application configuration:

1. Send several short private turns and ask a follow-up that depends on the latest answer. Confirm context remains chronological.
2. Repeat the same user sentence twice; confirm both occurrences remain valid history entries.
3. Send a long current message below the application limit, then one above it. Confirm the first reaches the assistant and the second receives a concise size response without truncation.
4. Send messages until history text crosses the 64 KiB window. Confirm the newest suffix remains ordered and the application logs only the count of older rows excluded.
5. Send a normal text prompt and a voice-note prompt. Confirm a history pair is written only after WhatsApp Web returns an outbound message result.
6. Use a fake or controlled transport failure in tests to confirm failed/null send results do not persist a turn or trigger a second full response.
7. In a group, confirm prefix behavior, shared group history, and no private memory retrieval remain unchanged.
8. Recheck `/help`, `/ping`, `/about`, image, sticker, video, and image-generation routes.

This guide has not been run against a real WhatsApp account.

## 14. Recommended Next Sprint

Repeat the complete check and test suite under Node `>=24`, including the SQLite atomic rollback and memory-isolation cases. If transport delivery certainty is required, design a separate message-ack tracking contract with timeout and group semantics before changing history to mean device-delivered. Keep the WhatsApp identity/security roadmap separate; do not enable production tools until its blockers are closed.

## Verification and Change Summary

- Source files: `src/ai/ai-failure-message.js`, `src/ai/conversation-context.js` (new), `src/application/message-service.js`, `src/database/sqlite.js`, `src/friday-runtime.js`, `src/whatsapp/message-adapter.js`.
- Test files: `test/conversation-context.test.js` (new), `test/message-service.test.js`, `test/message-adapter.test.js`, `test/sqlite.test.js`, `test/voice-note-failure.test.js`.
- Documentation: this report.
- `package.json`: check/test scripts updated; no dependencies or lockfiles changed.
- Database schema: unchanged.
- Final Git status: only the files listed above plus `package.json` are modified or newly added.
