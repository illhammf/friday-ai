# Sprint 4.19 — Natural Conversational Personality & Context Recall Precision

## 1. Observed failures

Live testing showed that the assistant could answer Java content after a casual greeting, repeat an introduction around identity questions, return to Java after a correction about the greeting, and select an older SQA topic when asked what was proposed immediately before Java. The desired behavior is a direct, friendly response to the latest message and precise recall of the requested historical slice.

## 2. Confirmed root causes

- Prior-topic recall was handled by broad recent-history selection rather than the specific exchange immediately before the latest topic switch.
- Correction messages such as “kok halo masih ikut” had no intent boundary, so active-topic Java context remained available.
- Existing identity/open-topic handling could still leave the model with unnecessary context for a direct self-conversation response.
- The previous policy did not explicitly distinguish a proposed topic from a completed lesson.

No duplicate persistence or WhatsApp message-processing defect was established. Quoted `message.reply()` presentation remains the supported explanation for repeated user text in copied transcripts.

## 3. Personality design changes

System instructions now allow restrained casual Indonesian expression: light elongation (`iyaa`, `jangannn`), `hehe`/`wkwk`, and occasional contextual emoji. They explicitly prohibit forced slang, repeated greetings, unnecessary introductions, and generic closing questions. Technical, academic, formal, or sensitive responses remain clear and appropriately restrained. Personality remains language behavior only; Friday does not claim human experiences, emotions, or capabilities.

Correction intent instructions require a brief acknowledgment/apology and immediate application of the user’s correction without returning to the old topic.

## 4. Context recall improvements

`conversation-context-policy.js` now supports:

- `previous_topic_recall`: selects the last user/model exchange before the latest topic switch. For “Sebelum pindah ke Java tadi aku mau bahas apa?”, this is the Python proposal and Pak Rahmat context.
- `correction`: clears unrelated active-topic context for feedback such as “halo masih ikut”.
- Existing `identity`, `open_topic`, `topic_switch`, `recent_recall`, `active_topic`, and short-message intents remain deterministic.

The policy does not delete history. It projects only the relevant context into the current Gemini request, while explicit historical recall and recent-history recall remain available. Memory retrieval is skipped for identity, correction, short, and recent-recall intents to avoid unrelated memory competition.

## 5. Regression coverage

Added tests for:

- Python proposal + Pak Rahmat followed by Java switch and previous-topic recall.
- Lecturer/topic proposal distinction.
- Greeting correction clearing Java context.
- Natural identity/open-topic/recent-recall intent classification.
- Existing short, active-topic, historical recall, chronology, and current-message-once behavior.

Existing tests continue covering private/group isolation, explicit memory, WhatsApp ID deduplication, uncertain outbound handling, and queue serialization.

## 6. Verification

```text
node --version   -> v24.22.1
npm --version    -> 11.19.1
npm run check    -> passed
npm test         -> 360 passed, 0 failed, 0 skipped, 0 cancelled
git diff --check -> passed
```

No production conversation data, WhatsApp authentication, live WhatsApp account, or live Gemini request was accessed. Production tool execution remains disabled.

## 7. Files changed

- Modified: `src/ai/conversation-context-policy.js`, `src/config/system-instruction.js`, `src/friday-runtime.js`, `test/conversation-context-policy.test.js`.
- Added: this report.
- No database schema, migration, dependency, adapter, authentication, or persistence changes.

## 8. Remaining limitations

- Intent recognition is deterministic pattern-based; unusual Indonesian phrasing may require additional examples.
- Automated tests validate context projection and instructions, not guaranteed provider wording.
- Emoji/elongation choices remain model-controlled within the new boundaries.
- Local WhatsApp submission remains distinct from recipient delivery/read confirmation.

## 9. Supervised live-test readiness

**CONDITIONALLY READY** for another supervised test. Recommended sequence:

1. Propose Python and mention Pak Rahmat.
2. Switch to Java.
3. Ask what was proposed before Java; expect Python and optionally Pak Rahmat, without SQA or a new introduction.
4. Say “kok halo masih ikut”; expect a short apology/correction acknowledgment, without Java explanation.
5. Ask “Siapa dosen yang tadi aku sebut?”; expect Pak Rahmat only if that exchange is available in the same session.
6. Ask “Apa yang barusan kita bahas?”; expect the latest substantive exchange, not an empty-session claim.

Automated verification is complete; live WhatsApp/Gemini behavior remains owner-supervised and unclaimed.
