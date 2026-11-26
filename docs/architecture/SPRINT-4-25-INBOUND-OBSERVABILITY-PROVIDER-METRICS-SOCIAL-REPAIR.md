# Sprint 4.25 — Inbound Observability, Provider Metrics & Social Repair

## Executive summary

Sprint 4.25 mengimplementasikan tiga temuan terkonfirmasi dari audit Sprint 4.24 tanpa mengubah arsitektur, schema database, retry policy, identity trust, atau outbound uncertainty.

1. Inbound rejection kini memiliki `rejectReason` allowlist dan correlation ID yang sama dengan event terkait.
2. Provider metrics terminal kini membedakan `input=`, `output=`, `total=`, durasi, dan attempt.
3. Social-repair intent mengenali permintaan kontekstual seperti “kok nggak ada lovenya?” dan menyertakan hanya dua turn terakhir agar Friday dapat memperbaiki respons sosial tanpa membawa topik lama.

Tool execution tetap disabled, personal memory tetap membutuhkan verified principal, dan live WhatsApp/Gemini tidak digunakan.

## 1. Inbound observability

### Rejection mapping

`getMessageRejectionReason()` sekarang memetakan kondisi yang sudah ada tanpa mengubah keputusan validasinya:

| Kondisi | Reason |
|---|---|
| self-authored event | `from_me` |
| missing chat/from | `missing_from` |
| unsupported/empty content | `unsupported_content` |
| group tanpa prefix Friday | `group_prefix_required` |
| duplicate claimed message ID | `duplicate_message_id` |
| normalization menghasilkan null | `normalization_failed` |
| queue admission penuh | `queue_full` |

Reason adalah nilai allowlist, bukan message body, ID, nama, atau exception text. Unknown failure tetap memakai kategori aman yang sudah ada.

Correlation ID dibuat sebelum validasi dan diteruskan ke accepted maupun rejected event. Terminal human mode menampilkan `MESSAGE REJECTED — <reason>`; JSON mode mempertahankan structured fields.

Missing sender identity tidak dipetakan sebagai invalid message structure. Identity verifier Sprint 4.20 tetap fail-closed.

## 2. Provider metrics

`generateWithRetry()` sekarang mencatat `attempt` dan durasi per provider attempt. Retry count, delay, fallback order, dan classification tidak diubah.

Terminal human output tidak lagi menulis label ambigu `tokens`. Bila metadata tersedia, format menjadi:

```text
GENERATING RESPONSE — 11768ms · input=4200 · output=180 · total=4380 · attempt=1
```

Nilai yang hilang tidak dibuat-buat. JSON mode tetap menyimpan `inputTokens`, `outputTokens`, `totalTokens`, `durationMs`, dan `attempt` sebagai field terpisah. Provider error tetap hanya menampilkan safe category/status/model.

## 3. Social-repair intent

`isSocialRepairQuestion()` mengenali sinyal terbatas dan kontekstual seperti `love/lovenya`, `hati`, `emoji/emot`, dan `kurang hangat` ketika digunakan dalam bentuk koreksi atau permintaan reaksi. Ini bukan regex besar untuk semua nuansa percakapan.

Intent `social_repair` memiliki precedence sebelum generic factual correction. Context selection mengambil maksimal dua entry terakhir—biasanya user request dan assistant response yang sedang dikoreksi—sehingga:

- respons sebelumnya tersedia sebagai evidence;
- tanggal atau topic lama tidak ikut terbawa;
- current message tetap masuk satu kali melalui request builder;
- private/group dan sender-scoped boundaries tetap utuh.

System instruction mengarahkan balasan agar singkat, hangat, langsung memperbaiki, tidak defensif, dan tidak memaksakan emoji pada semua respons. Technical messages tetap memakai style teknis.

## 4. Files changed

- `src/whatsapp/message-queue.js` — allowlisted inbound rejection reason helper.
- `src/whatsapp/message-adapter.js` — rejectReason dan correlation diagnostics.
- `src/application/terminal-presenter.js` — rejected label, explicit token labels, attempt display.
- `src/application/message-service.js` — safe attempt metadata propagation.
- `src/friday-runtime.js` — provider attempt duration/attempt metadata and safe log propagation.
- `src/ai/conversation-context-policy.js` — social-repair classification and bounded preceding context.
- `src/config/system-instruction.js` — inspected; no change was required because the existing context/style rules already provide the needed boundary.
- `test/message-adapter.test.js` — rejection reason coverage.
- `test/terminal-presenter.test.js` — explicit metric/rejection output coverage.
- `test/conversation-context-policy.test.js` — social-repair context coverage.
- `docs/architecture/SPRINT-4-25-INBOUND-OBSERVABILITY-PROVIDER-METRICS-SOCIAL-REPAIR.md`.

Tidak ada dependency, migration, database production, `.env`, `.wwebjs_auth`, atau tool policy change.

## 5. Tests and verification

Focused regression tests: **69 passed, 0 failed, 0 skipped, 0 cancelled**.

Full verification:

- Node.js: `v24.22.1`
- npm: `11.19.1`
- `npm run check`: passed
- `npm test`: **376 passed, 0 failed, 0 skipped, 0 cancelled**
- `git diff --check`: passed

New tests cover rejection mapping, token labels, attempt display, social-repair intent, immediate context selection, and preservation of existing message/context behavior.

## 6. Security and compatibility review

- No raw message bodies, phone numbers, WhatsApp IDs, credentials, memory, or provider payloads are logged.
- Group prefix and deduplication semantics remain unchanged.
- Sender identity remains unavailable by default; group ID/display name/quoted author are not trusted identities.
- Personal memory and privileged tools remain disabled under existing policy.
- 503 retry/fallback and uncertain outbound behavior remain unchanged.
- No automatic resend was introduced.

## 7. Remaining limitations

Automated tests cannot prove that Gemini will always infer emotional nuance correctly. The social-repair signal only constrains context and instruction; generated wording remains provider-dependent.

Live transcript ordering and the earlier `hai,bls ham` observation still require supervised JSON-mode correlation logs. `rejectReason` now makes future diagnosis possible, but no live WhatsApp verification was performed in this sprint.

## 8. Manual WhatsApp verification checklist

1. Send `Makasih ❤️`; verify a warm acknowledgment is possible without forced verbosity.
2. Send `Kok nggak ada lovenya?`; verify Friday repairs the prior response concisely and does not repeat unrelated history.
3. Send a factual correction and a technical follow-up; confirm social repair does not override technical clarity.
4. Send a group message without Friday prefix; verify `group_prefix_required` in JSON logs.
5. Replay the same message ID; verify `duplicate_message_id` and no second processing.
6. Send identical text with a different message ID; verify it is accepted.
7. Trigger a provider 503 in a supervised environment; verify attempt, model, duration, and input/output/total labels without secrets.
8. Confirm uncertain outbound submission does not resend automatically.

These are owner-run live checks and are not marked passed by this report.

## Final readiness verdict

**CONDITIONALLY READY.** The three confirmed audit issues now have bounded, tested corrections. Live WhatsApp/Gemini behavior, especially pragmatic social tone and cross-event response ordering, still requires supervised verification. Existing identity, memory, privacy, queue, retry, and tool-execution boundaries remain intact.
