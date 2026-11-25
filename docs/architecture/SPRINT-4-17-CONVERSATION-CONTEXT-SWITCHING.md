# Sprint 4.17 — Conversation Context Switching & Duplicate Message Audit

## 1. Root cause stale-topic behavior

The previous policy always retained the four newest history entries. When the user sent a substantive topic switch such as “Sekarang kita bahas Java, aku sedang belajar Inheritance”, the history available to the request still contained the prior Dart answer and the unanswered lecturer question. The current message was correct and unique, but the mixed recent window allowed Gemini to repeat older context unnecessarily.

This was a context-selection defect, not evidence of SQLite row reordering or private/group session mixing.

## 2. Correction

`src/ai/conversation-context-policy.js` now detects explicit topic-switch language (`sekarang kita bahas`, `now discuss`, `ganti`, `pindah`, `switch`, `discuss`, and related forms) while excluding interrogative questions such as “Apa topik yang sedang kita bahas sekarang?”.

- The topic-switch request receives a clean context containing no previous turns; the current Java message is still included exactly once by `buildConversationContents`.
- A later active-topic question retains only the history suffix beginning at the latest explicit topic switch, so Java/Inheritance remains available without the preceding Dart/disclaimer exchange.
- Explicit historical recall questions remain allowed to retrieve the earlier Dart context.
- Short-message behavior from Sprint 4.16 remains unchanged.
- Private/group session and explicit-memory boundaries remain unchanged.

The policy is deterministic and does not use an AI fact checker or speculative model classification.

## 3. Duplicate message audit

The WhatsApp adapter reads only `message.body`; quoted reply presentation is supplied by WhatsApp when `message.reply(text)` includes the original message as quote metadata. There is no adapter code that concatenates the quoted body into the incoming text.

The event path registers one `message` handler during one application `configureClient` call. `getMessageDeduplicationKey` uses `from` plus the stable WhatsApp message ID/serialized ID, never body text alone. Identical text with different IDs is accepted, while the same ID in the same chat is rejected by the deduplicator. Queue admission, per-chat serialization, and persistence tests remain green.

Therefore the copied transcript’s repeated user text is consistent with normal WhatsApp quoted-reply rendering. No duplicate event registration, duplicate queue admission, or duplicate persistence defect was confirmed, so no speculative deduplication change was made.

## 4. Test coverage

Added/extended deterministic tests for:

- Dart history followed by an explicit Java topic switch.
- Active Java topic retrieval without old Dart context.
- Explicit recall of the pre-switch Dart topic.
- Current topic-switch message appearing once in the constructed Gemini request.
- Unrelated generic wording not selecting old context.
- Existing short-message, chronology, current-message-once, private/group, and duplicate-ID behavior.

Existing adapter and queue tests verify one processing path per stable message ID and acceptance of distinct messages with identical body text.

## 5. Verification

Node/npm versions and full verification are recorded after the implementation run:

```text
node --version   -> v24.22.1
npm --version    -> 11.19.1
npm run check    -> passed
npm test         -> 355 passed, 0 failed, 0 skipped, 0 cancelled
git diff --check -> passed
```

No production conversation data, WhatsApp authentication data, live WhatsApp account, or live Gemini request was accessed. The pre-existing untracked `data/backups/` directory was preserved.

## 6. Files changed

- Modified: `src/ai/conversation-context-policy.js`, `test/conversation-context-policy.test.js`.
- Added: this report.
- No database schema, migration, memory storage, WhatsApp adapter, authentication, dependency, or tool-authorization changes.

## 7. Remaining limitations

- Topic-switch detection is intentionally conservative and language-pattern based; unusual phrasing may need a future explicit rule.
- Gemini can still choose wording imperfectly even when the application supplies only the active topic context.
- Non-null WhatsApp SDK results remain local submission evidence, not recipient delivery/read confirmation.

## 8. Readiness for supervised live testing

**CONDITIONALLY READY** for another supervised WhatsApp test. Use this sequence in one private chat:

1. “Hari ini aku belajar Dart, khususnya variabel.”
2. Ask what is being studied.
3. “Sekarang kita bahas Java, aku sedang belajar Inheritance.”
4. Ask “Apa topik yang sedang kita bahas sekarang?”
5. Confirm the answer focuses on Java Inheritance and does not repeat the Dart/disclaimer unless explicitly requested.
6. Ask “Apa yang aku pelajari sebelum Java?” and confirm Dart remains retrievable on explicit historical recall.

The live result is not claimed until the owner performs this test.
