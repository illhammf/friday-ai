# Sprint 4.13C — Conversation Context Accuracy Audit

## Executive Summary

The audit was repeated against the current repository without opening the production SQLite database or contacting WhatsApp/Gemini. The current pipeline selects the active private/group session, retrieves the latest history suffix, preserves chronological order, validates entries, and appends the current user message once.

A fake end-to-end replay with temporary SQLite, fake WhatsApp, and fake Gemini included the recent Dart/variables messages in every request. Seeded older sticker and voice-note exchanges also remained in the request because the history window is ten message rows, not ten complete turns. The fake provider selected the recent Dart facts. No history drop, session mix-up, or ordering defect was reproduced.

The live model's stale answer is therefore not proven to come from SQLite or WhatsApp quote handling. The most plausible explanation is competing context: older complete exchanges remained within the ten-row window while uncertain outbound results created newer user-only history entries. That can make older exchanges appear more structurally complete to a model, but the live provider request and response were not inspected.

**Verdict: READY for history integrity in the audited scope.** This does not claim that the live Gemini recall incident has been fixed or that live WhatsApp behavior was verified.

## Confirmed Source-Code Findings

### End-to-end path

1. WhatsApp `message.body` is normalized into transport-neutral text.
2. Private messages use `private:<senderId>`; group messages use `group:<chatId>`.
3. The runtime loads history only from the selected session.
4. SQLite selects rows by session and newest autoincrement ID, then reverses them to chronological order.
5. The runtime requests ten rows from SQLite.
6. History validation removes empty entries and rejects malformed roles/content.
7. The context builder maps `model` to Gemini `model`, preserves order, groups adjacent same-role content, and adds the current question exactly once.
8. Gemini receives the resulting `contents`, system instruction, and separately built memory/style context.

### Limits and persistence

- SQLite retains at most 20 rows per session.
- The Gemini request uses at most ten history rows before validation/byte filtering.
- The limit counts message rows, not user/model pairs. Older complete pairs can remain alongside newer user-only messages.
- Successful local outbound submission persists an atomic user/model pair.
- Null/undefined or thrown outbound results persist the inbound user message only; the assistant response is not falsely recorded as delivered and is not resent.
- Queue and service serialization preserve per-chat/session ordering. Private and group session prefixes remain isolated.

## Fake Reproduction

The exact sequence was replayed in one private synthetic session:

- User introduces learning Dart and wanting to understand variables.
- User asks which topic they are studying.
- User asks to recall two earlier facts.

The session was seeded with older unrelated sticker and voice-note user/model exchanges. Sanitized diagnostics showed:

| Step | History rows read | Request roles | Current input count | Dart context | Sticker context | Voice-note context |
| --- | ---: | --- | ---: | --- | --- | --- |
| 1 | 4 | user/model/user/model/user | 1 | present | present | present |
| 2 | 5 | user/model/user/model/user | 1 | present | present | present |
| 3 | 6 | user/model/user/model/user | 1 | present | present | present |

The final fake request included both recent Dart facts and older topics. A deterministic fake provider returned the expected Dart/variables answer. This proves request construction and data availability, not the semantic behavior of a live Gemini model.

The old records remained because six rows are below the ten-row history limit. They did not displace the newer messages. No production records were read.

## Alternative Explanations

Confirmed:

- Recent context is available to the provider in the tested pipeline.
- Older unrelated context can remain in the same request.
- Uncertain sends can leave a user-only tail in history.
- The current message appears once.

Not proven:

- The exact rows present in the owner's live request.
- Whether the live model weighted older complete turns more strongly.
- Whether the supplied correlation IDs correspond to the shown transcript.
- Whether memory retrieval affected the answer. Private memories were not inspected.

The approximate token count cannot identify which records were included.

## WhatsApp Quoted Reply Behavior

Installed `whatsapp-web.js@1.34.7` sets `Message.body` from the message body or media caption and exposes quote state through `hasQuotedMsg`/`getQuotedMessage()`. `Message.reply()` sends the generated content with `quotedMessageId`. The adapter passes only `message.body` into Friday's normalized text; it does not append quoted-message text. The repeated original message shown in WhatsApp is therefore the normal quoted-reply presentation, not evidence that Friday sent duplicated prompt text.

## Root Cause Assessment

No reproducible history or context-integrity defect was found. The strongest supported explanation is a model-selection issue caused by a mixed context window: recent Dart statements and older sticker/voice-note turns were all available, while uncertain replies omitted assistant turns for the recent exchanges. This is an inference, not a confirmed live root cause.

Changing the database schema, deleting history, increasing retries, or changing WhatsApp reply behavior is not justified by this audit. A future supervised diagnostic may record only session category, row count, role sequence, current-message count, synthetic context-presence flags, and request byte size. It must never record real prompts, IDs, memories, credentials, or raw provider payloads.

## Regression Tests and Verification

The existing Sprint 4.13B tests cover SQLite ordering/limits, uncertain inbound-only persistence, private/group isolation, queue ordering/deduplication, adjacent-role grouping, and current-message uniqueness. The required fake replay was executed with temporary data and fake providers; no repository test was added because no source defect was reproduced.

Required verification was run with Node.js `v24.22.1` and npm `11.19.1`:

- `npm run check`: passed.
- `npm test`: 339 passed, 0 failed, 0 skipped, 0 cancelled.
- `git diff --check`: passed.

No source, test, dependency, schema, WhatsApp patch, production database, or authentication data was changed for this repeat audit. The pre-existing untracked Sprint 4.14 files were preserved. The 4.13C report was recreated because it had been deleted in the working tree.

## Remaining Live Verification

The owner must still perform a supervised WhatsApp/Gemini replay to confirm the live provider's behavior. Automated fake tests do not establish that Gemini will always choose recent facts when older relevant-looking turns are present. Production tool execution remains disabled.
