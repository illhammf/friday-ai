# Sprint 4.24 — Runtime and Conversation Reliability Audit

## Executive summary

Audit-only Sprint 4.24 menelusuri tiga gejala live pada 26 November 2026: respons sosial yang kurang pragmatis, retry/fallback Gemini yang lambat, dan beberapa `validation_error` inbound. Tidak ada source code, test, dependency, database, atau WhatsApp auth yang diubah.

Temuan paling penting:

1. **CONFIRMED** — HTTP 503 diklasifikasikan retryable. Satu model dapat mencoba maksimal dua kali dengan delay 1,5 detik lalu 3 detik; fallback model dicoba bila error termasuk status 500/502/503/504 atau kategori yang diizinkan.
2. **CONFIRMED** — angka `6313 tokens` pada terminal berasal dari `usageMetadata.totalTokenCount`, bukan output token. Label terminal terlalu umum.
3. **CONFIRMED** — `validation_error` adalah kategori agregat untuk self-sent, missing/unsupported content, group tanpa prefix Friday, duplicate ID, dan normalisasi gagal. Log saat ini belum membedakan penyebabnya.
4. **UNCONFIRMED** — transcript `hai,bls ham` yang terlihat tertukar belum membuktikan stale provider response atau duplicate processing. Source tidak menyimpan response global; perlu correlation ID live untuk memastikan.

**Verdict: CONDITIONALLY READY untuk audit evidence dan provider safety. NOT READY untuk menyatakan masalah live message ordering telah selesai tanpa observability tambahan dan supervised verification.**

## Observed problems

Percakapan sosial `Makasih ❤️` → `kok nggak ada lovenya?` menunjukkan Friday tidak menangkap permintaan pragmatis untuk balasan hangat dengan emoji hati. Balasan tetap grammatically valid, tetapi tidak memenuhi maksud sosial.

Log provider menunjukkan rentang `14:37:56` sampai `14:38:08` (sekitar 12 detik berdasarkan timestamp detik). 503 terjadi pada model utama, retry kedua gagal, lalu fallback berhasil. Balasan kemudian tercatat `transport_uncertain` dan hanya input disimpan sesuai aturan outbound.

Log inbound berikutnya menampilkan `validation_error` pada `14:39:17`, `14:39:23`, dan `14:39:32`, tetapi tidak menyertakan alasan aman yang membedakan reject type.

## Source files inspected

- `src/config/system-instruction.js`
- `src/ai/conversation-style.js`
- `src/ai/conversation-context-policy.js`
- `src/ai/conversation-context.js`
- `src/application/message-service.js`
- `src/application/conversation-observability.js`
- `src/application/terminal-presenter.js`
- `src/application/conversation-scope.js`
- `src/application/runtime-clock.js`
- `src/application/temporal-service.js`
- `src/whatsapp/message-adapter.js`
- `src/whatsapp/message-queue.js`
- `src/friday-runtime.js`
- relevant provider, queue, adapter, context, and observability tests

## Conversational intelligence findings

### CONFIRMED — personality supports warmth but not deterministic pragmatic intent

`src/ai/conversation-style.js` recognizes affectionate/casual language and allows contextual emoji, while `system-instruction.js` says emoji should not be forced. However, there is no deterministic rule that maps “kok nggak ada lovenya?” to “the previous reply should include a heart.” The current correction policy is primarily factual/style correction and does not establish a structured social-repair intent.

### LIKELY — context may be insufficient for social repair

`conversation-context-policy.js` can classify corrections and exclude old context. That protects topic isolation, but a social correction may need the immediately preceding assistant turn. Whether this exact message was classified as correction in the live run cannot be proven without its normalized request and correlation ID.

### Recommendation

Next sprint should add a small, testable social-repair classification or response-style signal only when the user explicitly references a missing reaction (`love`, heart, emoji, warmth). It should not force emojis globally and should preserve technical/serious tone.

## Provider reliability findings

### CONFIRMED — retry and fallback are bounded

`generateWithRetry()` in `src/friday-runtime.js` permits two attempts per model. Temporary Gemini errors are retried; quota errors are not retried by this loop. `generateWithModelFallback()` tries the next configured model only when `isModelFallbackError()` accepts the error. 503 is explicitly accepted.

The supplied 12-second timeline is consistent with provider calls plus retry delay and network/model latency. Exact per-attempt durations are unknown because the human terminal output only shows stage timestamps rounded to seconds.

No tool execution is connected to this legacy assistant path, so provider retry/fallback cannot repeat a tool side effect here. Existing orchestration tests separately enforce no unsafe replay.

### CONFIRMED — token label is ambiguous/misleading

`askFriday()` reads `response.usageMetadata` and emits `inputTokens`, `outputTokens`, and `totalTokens`. The terminal presenter displays only `totalTokens` as `tokens`. Therefore `6313` is confirmed to be total token count when the provider supplied that field; it is not evidence of generated output length.

### Recommendation

Rename human output to `input=… · output=… · total=…` when fields exist. Add a request-level duration and per-attempt duration in structured mode. Do not change retry count until production latency and provider SLA evidence justify it.

## Outbound uncertainty

### CONFIRMED — safe state transition

`message-service.js` marks a non-null reply result as local `submitted`; null/undefined or thrown send is `uncertain`. On uncertainty it persists the received user input but does not persist the assistant answer as successful and does not send an automatic duplicate fallback. This matches the observed `DELIVERY UNCERTAIN` → `INPUT SAVED` sequence.

A visible WhatsApp message cannot prove recipient delivery/read, and a null SDK result cannot prove failure. No change is recommended in this sprint.

## Inbound validation audit

### CONFIRMED — rejection conditions are broad

`isQueueableMessage()` rejects:

- `fromMe` messages;
- missing `from`;
- unsupported type with empty body;
- group messages without the configured Friday prefix.

`registerQueuedMessageHandler()` also emits `validation_error` when normalization returns null or deduplication rejects an already-claimed message ID. Thus the three live errors cannot be attributed to one validator from timestamps alone.

### CONFIRMED — missing identity is separate

`identity unavailable` is emitted after a message has passed queue admission and normalization. It is not itself an inbound `validation_error`, and it must remain fail-closed.

### CONFIRMED — duplicate PROCESSING labels are expected mapping

The queue emits `message_processing_started`; message service emits `message_processing` with outcome `started`. Both map to `PROCESSING` in `terminal-presenter.js`. This is duplicate presentation of two lifecycle stages, not proof of duplicate message execution.

### Recommendation

Add an allowlisted `rejectReason` such as `from_me`, `missing_from`, `unsupported_content`, `group_prefix_required`, `duplicate_message_id`, or `normalization_failed`. Keep raw message fields out of logs. Consider mapping the two processing stages to distinct labels or suppressing one in human mode while preserving JSON events.

## Cross-system integrity

- **CONFIRMED:** per-chat queue serializes tasks; sender-scoped group context remains selected by current message scope.
- **CONFIRMED:** correlation IDs are created per accepted event and passed into message service stages.
- **CONFIRMED:** duplicate message IDs are rejected while identical text with different IDs remains admissible.
- **CONFIRMED:** uncertain outbound does not trigger resend.
- **UNCONFIRMED:** stale-response reuse, out-of-order visual rendering, or duplicate live listener registration. Existing lifecycle tests cover idempotent startup, but the supplied log lacks correlation IDs to connect events.
- **NOT REPRODUCIBLE from source/tests:** a provider response being returned to a different message through a global mutable cache.

## Prioritized next-sprint plan

1. Add safe inbound `rejectReason` diagnostics and correlation IDs to human/JSON event output.
2. Add provider attempt duration plus explicit input/output/total token labels.
3. Add synthetic social-repair intent tests for missing heart/warmth requests and concise correction replies.
4. Capture a supervised live trace with one correlation ID per WhatsApp message to test stale-response and duplicate-listener hypotheses.
5. Only after evidence, adjust human-stage deduplication or retry latency; do not add automatic resend.

## Suggested regression tests

- 503 retry twice, then safe model fallback, with bounded attempts.
- quota error does not use unsafe retry path.
- token fields preserve input/output/total distinctions.
- uncertain reply persists input only and sends no duplicate fallback.
- each reject condition emits a safe reason without message content or IDs.
- duplicate processing stages remain one accepted task.
- social correction requests are concise and context-aware.
- concurrent messages retain correlation and response association.
- sender/group/private context and personal-memory denial remain unchanged.

## Verification

Audit verification used Node.js `v24.22.1` and npm `11.19.1`:

- `npm run check`: passed
- `npm test`: **373 passed, 0 failed, 0 skipped, 0 cancelled**
- `git diff --check`: passed

No source code, tests, dependencies, database, `.wwebjs_auth`, or production logs were modified. The current working tree changes are pre-existing Sprint 4.23 context files plus this new audit report; no audit fix was applied.

## Live verification requirements

Owner should capture JSON-mode logs with correlation IDs while testing:

1. Send one social correction sequence and verify whether the correction event includes the preceding assistant context.
2. Send two distinct messages quickly and confirm each `message_received`, provider, and reply event shares only its own correlation ID.
3. Send the same text twice with different WhatsApp message IDs and verify two accepted events.
4. Replay one duplicate event and verify one `duplicate_message_id` rejection.
5. Record provider model, attempt, status, duration, and outbound result without exposing message content.

Do not treat this checklist as completed until the owner performs it with a real supervised session.

## Final readiness verdict

**CONDITIONALLY READY for current safety and bounded provider behavior. NOT READY to claim conversational pragmatics or live message-order integrity are fixed.** The next implementation sprint should prioritize reject-reason observability, token-label clarity, and correlation-based live diagnosis before changing retry or context behavior further.
