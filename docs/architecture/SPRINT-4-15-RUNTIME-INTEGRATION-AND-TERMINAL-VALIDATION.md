# Sprint 4.15 — Runtime Integration & Terminal Experience Validation

## 1. Initial findings

Source inspection confirmed that Sprint 4.14's terminal presenter was used by the main conversation logger, incoming-message adapter, startup banner, and WhatsApp connection events. The context policy was applied before `buildConversationContents`, and existing lifecycle/queue/shutdown tests still covered admission gating, ordered draining, and cleanup safety.

The audit also found integration gaps:

1. `quiet` mode suppressed failed and uncertain operations, hiding important failures.
2. `json` mode had no startup record and a QR callback could write terminal QR art outside JSON.
3. Application shutdown still received the raw `console` logger, so drain/cleanup events bypassed the presenter.
4. The terminal configuration options were implemented but not documented in `.env.example` and the daily-use runbook.

No regression was found in session isolation, history ordering, context byte limits, queue serialization, startup idempotency, or shutdown resource ordering.

## 2. Confirmed defects and corrections

### Quiet mode

Before the correction, `quiet` returned immediately for every stage/event/status. It now suppresses ordinary informational events but still emits failed, uncertain, and red error states.

### JSON mode and QR

Startup now emits one machine-readable JSON event containing safe runtime metadata. QR ASCII output is skipped in `json` and `quiet` modes so it cannot corrupt a JSON stream or violate quiet output. Human mode still displays the local QR required for supervised linking.

### Shutdown integration

The runtime now injects a sanitized lifecycle logger backed by the terminal presenter. Shutdown start, queue drain failures/timeouts, cleanup failures, and safe completion therefore use the same human/JSON/quiet policy. No lifecycle behavior or timeout ordering was changed.

### Documentation

`.env.example` and `FRIDAY-DAILY-USE-RUNBOOK.md` now document `FRIDAY_LOG_MODE`, `FRIDAY_MESSAGE_PREVIEWS`, and `FRIDAY_TIMEZONE`, including their safe defaults and uncertainty semantics.

## 3. Context validation

The four-message recent-context policy remains unchanged. Older entries are selected only by deterministic term overlap, chronology is preserved, and `buildConversationContents` still adds the current user input once. Existing private/group session and memory isolation tests remain green. No thresholds, schema, retry policy, or prompt boundaries were changed in this sprint.

## 4. Terminal lifecycle coverage

The presenter supports source-backed states for startup, QR required, authenticated, connected/ready, incoming, processing, provider attempts/retries, model fallback, generated response, reply submission, uncertain submission, failures, and shutdown logs. It does not invent a delivery/read acknowledgment. `SUBMITTED` remains local SDK submission only; `DELIVERY UNCERTAIN` remains explicitly uncertain.

Human mode avoids correlation IDs in normal lines. JSON mode preserves structured stage fields for diagnostics. Previews remain disabled unless explicitly enabled and are sanitized for ANSI/control characters. Invalid timezones fall back to `Asia/Jakarta`; non-TTY and `NO_COLOR` output contains no ANSI escape sequences.

## 5. Files changed

- Modified: `.env.example`, `docs/operations/FRIDAY-DAILY-USE-RUNBOOK.md`, `src/application/terminal-presenter.js`, `src/friday-runtime.js`, `test/terminal-presenter.test.js`.
- Added in the preceding Sprint 4.14 work and preserved: `src/ai/conversation-context-policy.js`, `test/conversation-context-policy.test.js`, `docs/architecture/SPRINT-4-14-CONVERSATION-INTEGRITY-AND-TERMINAL-UX.md`.
- Added in this sprint: this report.
- No dependency, lockfile, database schema, authentication data, or production database changes.

## 6. Automated test coverage

New/updated focused coverage verifies:

- JSON startup validity.
- Quiet mode suppresses ordinary events but reports uncertainty and errors.
- QR output policy by mode through source-backed behavior.
- Lifecycle and shutdown regression behavior.
- Existing context selection, chronology, adapter, and queue behavior.

## 7. Verification results

Executed with Node.js 24:

```text
node --version  -> v24.22.1
npm --version   -> 11.19.1
npm run check   -> passed
npm test        -> 347 passed, 0 failed, 0 skipped, 0 cancelled
git diff --check -> passed
```

No live WhatsApp account or Gemini request was used. No real TTY session was required for the automated tests; human rendering was tested with injected TTY/non-TTY fakes.

## 8. Remaining limitations

- Live WhatsApp QR/authentication and end-to-end delivery remain owner-supervised checks.
- A non-null SDK message result is not authoritative recipient delivery/read confirmation.
- Gemini recall remains probabilistic even when the application request is deterministic and grounded.
- Shutdown cannot cancel an underlying provider/media operation; existing bounded drain and cleanup behavior is preserved.

## 9. Live verification requirements

Owner should manually verify, in one local process:

1. Start in human mode and observe startup, QR (if needed), authenticated, and ready states.
2. Send `/ping` and one normal text message; confirm one response and correct lifecycle stages.
3. Repeat with `FRIDAY_LOG_MODE=json` and validate each line parses as JSON; do not use QR linking in JSON mode unless another trusted QR display path is available.
4. Repeat with `FRIDAY_LOG_MODE=quiet`; confirm ordinary stages are quiet while an induced safe failure/uncertain result remains visible.
5. Press Ctrl+C once and verify queue drain precedes WhatsApp/database cleanup.
6. Confirm an uncertain outbound result is not automatically resent.

## 10. Final verdict

**CONDITIONALLY READY.** Integration defects found by source inspection were corrected and 347 automated tests pass. Runtime, queue, context, and presenter behavior are verified by source inspection and automated fakes. Live WhatsApp/Gemini behavior, recipient delivery, and model recall still require supervised owner testing and are not claimed as verified.
