# Sprint 4.18 — Conversational Context Intelligence

## 1. Observed failures

Supervised testing showed four distinct behaviors:

- `Tess` received an unsolicited Java Inheritance explanation.
- “Loh aku belum tanya, kamu siapa sih?” received a correct identity answer contaminated by Java context.
- “Coba sekarang kita bahas apa” was an open-ended topic-choice question, not a substantive topic switch.
- After SQA was explained, “Tadi barusan kita bahas apa sih?” was answered as if the session were empty.

## 2. Confirmed causes

The prior policy recognized only exact short-message spellings such as `tes`; stretched casual forms like `Tess` were sent with the normal history path. Identity questions had no dedicated intent boundary, so active Java context remained available. The phrase “Coba sekarang kita bahas apa” matched the generic topic-switch pattern even though it asked what to discuss. Recent-history phrases containing “bahas” could also be mistaken for topic switches before recall handling ran.

The adapter audit did not confirm duplicate event processing. `message.reply()` provides WhatsApp quoted-message presentation, `message.body` is normalized once, listener registration occurs once during application configuration, and ID-based deduplication rejects repeated delivery of the same WhatsApp message while accepting distinct IDs with identical text.

## 3. Context model before and after

The policy now classifies the current message before selecting history:

- `short`: short tests, greetings, acknowledgments, and stretched casual spellings (`Tess`, `Hehe`, `Wkwk`). No old history or memory is supplied.
- `identity`: `kamu siapa`, `perkenalkan dirimu`, `bahas kamu`, and similar questions. The answer uses configured identity instructions without unrelated active-topic history.
- `open_topic`: “Coba sekarang kita bahas apa”. Old topic context is excluded; the assistant invites a new topic.
- `topic_switch`: substantive changes such as Java or SQA. The current message starts a clean topic context.
- `recent_recall`: “tadi”, “barusan”, or “apa yang kita bahas”. The latest stored exchanges are selected even when the wording has little overlap with the topic name.
- `active_topic`: follow-up questions after a switch retain the active-topic suffix.
- `conversation`: normal requests retain relevant history under the existing deterministic limits.

Stored history is never deleted by context selection. Explicit historical recall can still retrieve earlier topics, and the current user message remains exactly once in the Gemini request.

## 4. Natural expression and identity behavior

System instructions now request short, direct replies for tests/greetings, direct identity answers, and natural casual expression. Light Indonesian chat elongation such as “iyaa” or “jangannn” and occasional emoji/emotes are allowed when contextually appropriate, while technical or serious answers remain clear and restrained. This controls style without fabricating capabilities or personal facts.

## 5. Tests

Added deterministic tests for:

- `Tess`, `Hehe`, and other short forms.
- Identity questions and “bahas kamu”.
- Open-topic choice versus real topic switch.
- SQA recent-history recall without topic keyword overlap.
- Java active-topic continuity after identity discussion.
- Explicit recall of earlier Dart context.
- Current message exactly once and existing chronology/session boundaries.

Existing duplicate ID, identical-text distinct-message, adapter, queue, memory isolation, and uncertain outbound tests remain active.

## 6. Verification

```text
node --version   -> v24.22.1
npm --version    -> 11.19.1
npm run check    -> passed
npm test         -> 358 passed, 0 failed, 0 skipped, 0 cancelled
git diff --check -> passed
```

No production conversation data, WhatsApp authentication, live WhatsApp account, or live Gemini request was accessed. Production tool execution remains disabled.

## 7. Files changed

- Modified: `src/ai/conversation-context-policy.js`, `src/config/system-instruction.js`, `src/friday-runtime.js`, `test/conversation-context-policy.test.js`.
- Added: this report.
- No database schema, migration, dependency, message adapter, authentication, or persistence changes.

## 8. Remaining limitations

- Intent recognition is deterministic pattern-based and may need additional language examples for unusual phrasing.
- Automated tests validate context construction and policy, not guaranteed Gemini wording.
- WhatsApp quote display and local submission semantics remain platform behavior; they are not delivery/read confirmation.

## 9. Final assessment

**CONDITIONALLY READY** for another supervised WhatsApp test. The observed stale Java response for stretched short input, identity contamination, open-topic misclassification, and recent SQA recall path now have explicit regression coverage. Live WhatsApp/Gemini verification is still required before claiming the manual incident is fully resolved.
