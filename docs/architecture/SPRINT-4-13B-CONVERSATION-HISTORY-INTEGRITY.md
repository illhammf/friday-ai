# Sprint 4.13B — Conversation History Integrity

## Audit Findings (recorded before correction)

### Conversation lifecycle

For regular AI text, Friday selects `private:<senderId>` or `group:<chatId>`, then `askFriday()` loads the latest ten records from that exact session. SQLite fetches rows by descending autoincrement ID, reverses them into chronological order, then applies the requested limit. The context builder validates and preserves history order and appends the current question once as the final Gemini user content. The private and group prefixes isolate history.

The message service currently writes the user/assistant pair atomically only after `transport.reply()` returns a non-null result. Null/undefined returns and thrown outbound sends are treated as uncertain and intentionally do not persist the assistant response or retry a fallback. However, the user input is also not persisted in these cases. This behavior is confirmed in source and existing tests.

Therefore, when a reply is visible but the installed WhatsApp SDK returns no message object, the corresponding user turn and generated assistant answer can both be absent from SQLite. The next request then loads older records from the same session. That mechanism can explain stale sticker-related context if the first exchange was missing and an older sticker request exists in retained history. We did not inspect the live database or private messages, so the correlation IDs and exact stale record cannot be verified here; the live causal link remains strongly consistent but unproven.

### Other integrity checks

- Successful pairs are committed atomically using `BEGIN IMMEDIATE`; a failed write rolls back both rows.
- Writes use autoincrement IDs and reads restore ascending chronological order.
- Existing history cap is 20 rows in storage and ten messages at the Gemini caller; application byte bounds remain in `conversation-context.js` / `assistant-request.js`.
- The current question is passed once as the current Gemini content and is not loaded as history before its successful pair write.
- Gemini's GenerateContent chat guidance requires alternating `user` and `model` content roles. When an unpaired user entry is followed by another user message, the prior projection could produce adjacent `user` roles. The app request validator does not enforce alternation. This is an additional confirmed context-integrity issue; see [Google Gemini multi-turn conversation guidance](https://ai.google.dev/gemini-api/docs/generate-content/text-generation).
- The message service serializes active work by selected private/group session. WhatsApp queue serialization and message deduplication remain upstream protections.
- Session helpers use distinct `private:` and `group:` namespaces. No schema evidence indicates cross-session leakage.
- The history schema stores only role/content, not transport delivery state or source message IDs. It cannot record confirmed recipient delivery. We do not need a schema change to save an inbound user message independently while withholding an uncertain assistant response.

## Implemented Correction

Use the existing `saveMessage(sessionId, 'user', content)` operation for the current conversation input if an outbound result is null/undefined, a send throws, or provider processing fails before an ordinary answer is submitted. A per-invocation guard avoids inserting the inbound turn multiple times if multiple local failure paths run. Continue using atomic `saveConversationTurn()` for a non-null local SDK submission result; do not represent that as recipient delivery. Never persist the generated assistant answer on an uncertain send, and do not resend it. Empty text is not persisted when a voice note could not be transcribed.

At Gemini request construction, adjacent same-role history entries are grouped into one `Content` object with ordered parts; if the history ends in a user role, the current user content is appended to that same user content. This preserves all text in sequence and places the current request once while producing the role alternation expected by Gemini. The application database rows themselves are not rewritten.

The existing WhatsApp queue deduplicates event deliveries during a process lifetime (24-hour key TTL with bounded in-memory entries). The schema has no durable source-message ID, so it cannot guarantee exactly-once persistence across process restarts if WhatsApp redelivers the same event; introducing a migration is outside this minimal correction.

## Regression Coverage

- Null, undefined, and thrown outbound replies preserve the inbound user text only; no assistant model turn is written and no duplicate fallback is sent.
- Provider failure preserves the input while the safe fallback remains separate from conversation history.
- A temporary SQLite test sends one uncertain turn, then checks the next request retrieves it; after a successful subsequent turn it verifies ordering, private/group isolation, and that the next prompt still has alternating Gemini roles with the current user input once.
- Existing tests continue to cover atomic turn rollback, successful persistence, history count/byte bounds, queue ordering/deduplication, group/private separation, and memory behavior.

## Verification

- Node.js: `v24.22.1`; npm: `11.19.1`.
- `npm run check`: passed.
- `npm test`: 339 passed, 0 failed, 0 skipped, 0 cancelled.
- `git diff --check`: passed.
- Two new tests were added: one covers undefined reply handling and one exercises a sequence through temporary SQLite and Gemini prompt construction. Existing null, thrown-send, provider-failure, successful-pair, queue-order, and dedup tests were updated or retained.
- Files changed: `src/application/message-service.js`, `src/ai/conversation-context.js`, `test/message-service.test.js`, `test/conversation-context.test.js`, `test/sqlite.test.js`, and this report.
- Final Git status: five modified tracked files and this new untracked report. No other work was discarded or modified.
- No live WhatsApp account, production database, private history, or Gemini request was used. The supplied correlation IDs were not used to query logs or database records; the actual private database was not opened. Live correction remains to be confirmed by the owner.
- No schema migration, dependency change, or change to the WhatsApp Puppeteer patch was made; production tool execution remains disabled.
