# Sprint 4.16 — Full Memory Reset & Conversation Intelligence Overhaul

## 1. Audit summary

The workspace was inspected before changes. A pre-existing modification to `.github-token` was preserved and not touched. The configured production database path is `data/friday.sqlite`; its contents were not opened, enumerated, or printed. The application schema identifies `messages` as conversation history and `user_memories` as explicit memory. `schema_migrations` is operational metadata and is protected.

The existing runtime already isolated private/group sessions, persisted inbound messages independently of uncertain outbound results, validated Gemini responses, and kept tool execution disconnected. The remaining confirmed context issue was that short acknowledgments could still be sent with recent history and retrieved memory, allowing an old topic to compete with the actual short message. Older-context relevance also relied on generic keyword overlap.

## 2. Reset implementation and exact scope

Added `npm run reset:conversation-data`, implemented through `src/database/conversation-data-reset.js` and `scripts/reset-conversation-data.js`.

Approved tables: `messages` (conversation history) and `user_memories` (explicit memories). Protected data includes `schema_migrations`, `.env`, credentials, `.wwebjs_auth`, source, dependencies, configuration, and all non-conversational files.

The command refuses a missing/unidentified database, opens the existing file without running migrations, reports the path/table names/counts, and requires the exact phrase:

```text
RESET ALL FRIDAY CONVERSATION DATA
```

Before deletion it creates a timestamped SQLite snapshot using `DatabaseSync.serialize()` while the database handle is open. Deletion of only the two approved tables is performed in one transaction, followed by zero-row verification. Failure rolls back the transaction and the database is closed in all cases.

### Reset execution status

The production reset was **not executed in this sprint**. It was deliberately not run automatically against `data/friday.sqlite`; only temporary test databases were reset. To execute it manually after stopping Friday, run `npm run reset:conversation-data` and type the exact phrase above. The command prints the actual backup path. The backup is a recovery copy and must be removed separately, by its exact path, only if permanent deletion is later intended.

## 3. Conversation-context architecture

The verified flow remains: `WhatsApp event → normalized message → selected private/group session → SQLite history → deterministic context policy → system instruction/memory context → Gemini contents → response validation → outbound submission → persistence decision`.

`selectConversationContext` still retains the four newest messages and preserves chronology. Earlier messages are selected deterministically only when specific terms overlap the current question; generic recall wording is filtered so terms such as “sebutkan”, “sebelumnya”, and “memahami” do not independently pull an old exchange. Current input continues to be appended exactly once by `buildConversationContents`.

For short non-substantive messages (`Tes`, `Halo`, `Pagi`, `Oke`, `Makasih`, `Siap`, and equivalent supported forms), context selection returns no history and runtime memory retrieval is skipped. This prevents an acknowledgment from accidentally answering an old question or triggering an unsolicited recap. Longer messages and explicit recall questions retain the existing context policy.

## 4. Grounding and personal-information policy

The system instruction now explicitly prioritizes the current message, requires evidence before claiming a previous user statement, and instructs concise direct responses to short acknowledgments. Existing explicit-save-only memory behavior remains unchanged. Retrieved memory remains untrusted supplementary context and is still forbidden in group requests.

The system instruction no longer includes unnecessary university/profile detail that could be repeated in unrelated answers. This does not change the supported `/about` command or application metadata; it only removes an unrelated personal profile claim from the model prompt.

## 5. Gemini and outbound safety

No provider retry, fallback, response validation, or outbound uncertainty policy was weakened. A provider failure does not create an assistant turn. A `null`, `undefined`, or thrown WhatsApp reply remains uncertain and is never automatically resent or persisted as successfully delivered. Non-null SDK submission remains local submission only, not delivery/read confirmation.

## 6. Terminal validation

Sprint 4.15 terminal behavior was preserved. Human, JSON, and quiet modes remain available. The reset command itself uses concise non-sensitive output and never prints message content or memory text.

## 7. Tests and verification

New reset tests use temporary SQLite files and verify wrong confirmation, scope/count reporting, snapshot creation, deletion of only approved tables, and preservation of `schema_migrations`. New context tests verify short acknowledgments do not inherit old context and generic recall wording does not select old exchanges by generic overlap. No real WhatsApp account, Gemini request, production database content, or authentication data was used.

Executed:

```text
node --version   -> v24.22.1
npm --version    -> 11.19.1
npm run check    -> passed
npm test         -> 352 passed, 0 failed, 0 skipped, 0 cancelled
git diff --check -> passed
```

## 8. Files changed

- Modified: `package.json`, `src/ai/conversation-context-policy.js`, `src/config/system-instruction.js`, `src/friday-runtime.js`, `test/conversation-context-policy.test.js`, `docs/operations/FRIDAY-DAILY-USE-RUNBOOK.md`.
- Added: `src/database/conversation-data-reset.js`, `scripts/reset-conversation-data.js`, `test/conversation-data-reset.test.js`, this report.
- Preserved unrelated pre-existing change: `.github-token`.
- No dependency, lockfile, schema, migration, WhatsApp auth, or production database changes.

## 9. Evidence boundaries and limitations

- Source inspection verified persistence tables, reset scope, prompt construction, session isolation, and outbound safety.
- Automated tests verified reset behavior on temporary databases and deterministic context behavior.
- Actual production reset: not performed.
- Live WhatsApp testing: not performed.
- Live Gemini testing: not performed.
- Model recall remains probabilistic; deterministic context construction cannot guarantee every provider answer.

## 10. Final verdict

**CONDITIONALLY READY** for supervised conversational use after the owner deliberately runs the reset command and records its printed counts/backup path. The reset is not claimed as executed, and live WhatsApp/Gemini behavior remains unverified. Production tool execution remains disabled.
