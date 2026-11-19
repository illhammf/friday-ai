# Sprint 4.13C — Conversation Context Accuracy Audit

## Executive Summary

The source audit and fake end-to-end replay show that the recent Dart messages are included in the Gemini request. SQLite session selection, latest-row selection, chronological ordering, and the current-message append behave as implemented. With four older sticker/voice-note records seeded in the same private session, those records also remain in the request because the ten-message history window has not yet evicted them. The fake provider, given the same complete context, selected the recent Dart facts.

No source defect was reproduced that dropped or reordered the recent Dart facts. The live model's choice of older topics is consistent with competing older context, especially because the recent visible replies had uncertain local SDK results and therefore no assistant turns were persisted. This is a plausible explanation, not a proven account of the live provider's internal reasoning. No live database, WhatsApp account, Gemini request, or raw private history was inspected. No source or tests were changed; this report is the sole workspace change.

**Verdict: READY for conversation-history integrity in the scope tested.** This means the fake pipeline preserved and submitted recent context with correct ordering. It does not mean the live Gemini model's recall behavior or the reported live incident has been fixed or verified.

## Confirmed Source-Code Findings

### Session selection and persistence

- The WhatsApp adapter derives a private sender from `message.from`; private session IDs are prefixed `private:`. Group messages use `group:<chatId>`. Runtime history uses the selected private or group session only; group requests do not retrieve private memories.
- For a successful non-null local reply result, `message-service.js` transactionally persists a user/model pair. The result is a local SDK submission result, not a delivery/read acknowledgment.
- After Sprint 4.13B, a normal conversation's inbound user text is persisted by itself when reply submission returns null/undefined or throws, and the assistant result is omitted. The user message is also retained when AI processing fails and a failure response is attempted. The existing queue deduplicates by WhatsApp message ID in process memory (24-hour TTL, bounded entries).
- Deterministic commands and explicit memory commands intentionally do not become AI conversation turns. An untranscribed voice note has no text to persist.

### Retrieval, ordering, and limits

- SQLite selects the latest 20 rows by autoincrement `id DESC`, reverses them to chronological order, then applies the caller's limit. This selects a suffix of the session history; old rows do not displace newer rows.
- The runtime requests ten history rows. This is a message-row count, not ten user/assistant pairs. Therefore older complete exchanges may remain in context alongside recent unanswered user messages until the ten-row window advances past them.
- History order is persisted in insertion order. The service serializes active processing per selected session, and the WhatsApp queue serializes incoming work per chat. Private and group session IDs remain distinct.
- `normalizeConversationHistory()` preserves the supplied order, validates roles/content, excludes empty entries, and applies the configured history byte limit. It does not reorder the history.
- `buildConversationContents()` appends the current request exactly once. For consecutive same-role rows created by uncertain turns, Sprint 4.13B groups their ordered parts into a single Gemini `Content`. This keeps the API role sequence alternating, but makes separate unanswered user messages parts of one `Content` turn.
- Gemini's documented multi-turn `GenerateContent` format expects `user` and `model` roles to alternate. The current grouping follows that constraint. See [Google Gemini multi-turn conversation guidance](https://ai.google.dev/gemini-api/docs/generate-content/text-generation).

### Memory and style context

- Runtime memory retrieval is separate from conversation history, is scoped to the private session, and ranks explicit memories by overlap with the current question. Group requests retrieve no private memory.
- Conversation style is selected from the current question and recent user history. It contributes only a style instruction and does not replace or remove retrieved conversation content.
- The production memory contents and current live request were not inspected. There is no evidence in this audit that memory caused the sticker/voice-note answer.

## Fake End-to-End Reproduction

The required three-message sequence was replayed in a temporary SQLite database through the normalized WhatsApp message shape, message service, history loader, context builder, and a fake Gemini provider. The same private session was seeded with two older unrelated user/model exchanges (sticker and voice note). The first two fake WhatsApp reply calls returned `undefined`, matching the uncertain-result path; the third returned a fake local submission result.

The fake Gemini recorded the serialized request for each step. The diagnostic inspected counts, role sequence, current-message occurrence, context-presence flags, and serialized byte size; it printed no message text, IDs, credentials, or raw serialized payload.

| Step | Retrieved history rows | Request roles | Current message appears once | Recent Dart context | Old sticker context | Old voice-note context | Serialized fake request |
| --- | ---: | --- | ---: | --- | --- | --- | ---: |
| 1 | 4 | user, model, user, model, user | yes | yes | yes | yes | 507 bytes |
| 2 | 5 | user, model, user, model, user | yes | yes | yes | yes | 565 bytes |
| 3 | 6 | user, model, user, model, user | yes | yes | yes | yes | 632 bytes |

The final request contained both recent Dart facts and the older sticker/voice-note exchanges. The fake provider's deterministic rule chose the Dart facts and produced the expected answer. This verifies data availability and ordering, not how a live Gemini model weighs competing history.

The newer messages were not displaced by the old ones in this reproduction. The old messages remained because the complete history was only six rows, below the ten-row request limit. In the supplied live logs, the two earlier replies were both marked `uncertain`; under Sprint 4.13B, that means their assistant answers would be absent while their user inputs remain. The exact live session rows and request were not available for safe verification.

## Live Incident: What Is Known and What Is Not

**Confirmed:** The 4.13B persistence rule can produce recent user-only entries after uncertain WhatsApp sends. These entries are included in subsequent history. Older sticker/voice-note exchanges can also remain in the last ten rows. In a user-only tail, multiple consecutive user messages are grouped in one Gemini `Content` with parts in chronological order; the latest current question appears once.

**Most plausible explanation:** The final live request may have included the recent Dart/variables statements and the older sticker/voice-note exchanges at once. Since the recent exchanges lacked assistant turns but the older items had complete user/model pairs, the older exchanges could have appeared more salient to Gemini. The final wording was also broad. This could explain the stale recall, but cannot be confirmed without the actual live request contents and response conditions.

**Not established:** The supplied correlation IDs were not queried against logs or SQLite. The approximate token counts do not identify which history rows were present. The fake provider cannot reproduce Gemini's semantic selection. No model, prompt, history limit, or persistence rule was changed.

## WhatsApp Quoted Reply Behavior

Installed `whatsapp-web.js@1.34.7` sets `Message.body` from the SDK message body (or media caption) and exposes quote state separately through `hasQuotedMsg` / `getQuotedMessage()`. The Friday adapter normalizes only `message.body`; it does not append quoted-message text. `Message.reply(content)` calls `client.sendMessage()` with `quotedMessageId` set to the inbound message ID. That makes WhatsApp display a quoted preview above Friday's reply. Source inspection therefore indicates the repeated original text in the transcript is the normal quoted-reply presentation, while Friday's actual message body is just its generated answer. No reply behavior was changed.

## Root Cause and Recommended Correction

There is no confirmed history retrieval or ordering defect in the code under test. The live stale answer is most likely a model-context selection issue involving old complete exchanges still within the ten-row window and newer user-only entries after uncertain outbound results. The exact live cause remains unproven.

Do not change the history limit or prompt based on this single unaudited live request. The smallest next diagnostic is a supervised replay with test-only, content-free instrumentation recording: private/group category, history row count, role sequence, current-input count, booleans for the relevant recent/old test facts (only in a synthetic fixture), and serialized request size. Never log the actual request or private history. If the live environment cannot safely prove which context entered the request, retain the current safety behavior and investigate model selection separately before changing prompt policy.

## Regression Tests and Verification

- No repository test was added because the audit did not reproduce missing, reordered, or cross-session recent context. The exact fake end-to-end reproduction was run as a one-off using temporary SQLite and fake WhatsApp/Gemini implementations.
- Existing tests cover the Sprint 4.13B uncertain persistence path, chronological SQLite ordering and limits, session isolation, same-session queue serialization/deduplication, context ordering/role grouping, and current-message append.
- Node.js: `v24.22.1`; npm: `11.19.1`.
- `npm run check`: passed.
- `npm test`: 339 passed, 0 failed, 0 skipped, 0 cancelled.
- `git diff --check`: passed.
- No source files, tests, dependencies, database schema, or WhatsApp patch changed. The sole changed file is this new report.
- No live WhatsApp or Gemini request was made. No production database or authentication data was opened.
