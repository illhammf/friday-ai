# Sprint 4.21 — Per-Sender Group Conversation Context Isolation

## Executive summary

Audit ini menemukan bahwa seluruh pesan grup sebelumnya memakai satu `group:<chatId>` session. Akibatnya, topik Python milik satu peserta dapat terbaca ketika peserta lain sedang membahas Java.

Perbaikan menambahkan dua lapisan percakapan baru tanpa mengubah schema:

- sender-scoped group context: `group-sender:<sha256(group evidence + sender evidence)>`;
- shared group context: `group:<chatId>`.

Pesan grup biasa memakai sender scope bila `message.author` tersedia. Permintaan eksplisit seperti “rangkum diskusi grup” memakai shared scope. Missing author tidak pernah fallback ke group ID, display name, quoted author, atau principal.

**Verdict: CONDITIONALLY READY untuk konteks percakapan grup baru berdasarkan source dan automated tests. NOT READY untuk verified identity, personal memory ownership, atau privileged authorization.**

## Audit dan arsitektur

Alur tetap:

`WhatsApp event → normalize → queue/deduplication → message-service → scope selection → context policy → assistant → outbound reply → persistence`.

Sprint 4.20 sudah menghapus fallback group ID sebagai sender dan mempertahankan identity verifier fail-closed. Temuan utama Sprint 4.21 adalah history group masih dipilih sebagai history utama untuk semua peserta.

### Sender-scoped group context

`createGroupSenderScope(groupId, senderEvidence)` membuat partition key deterministik hanya jika kedua evidence valid dan tidak kosong. SHA-256 dipakai agar ID mentah tidak menjadi nama session baru; ini bukan bukti identitas atau jaminan anonimisasi.

Scope berbeda untuk dua sender dalam group yang sama, dan sender yang sama di dua group berbeda. Scope ini hanya kunci partition percakapan, bukan authenticated principal.

### Shared group context

`group:<chatId>` dipertahankan untuk diskusi bersama dan legacy history. Turn baru group ditulis ke sender scope dan shared scope. Shared scope hanya dipilih saat user meminta ringkasan diskusi grup secara eksplisit.

Legacy shared history tidak dipindahkan ke peserta tertentu. Ini mencegah pesan lama salah dianggap milik Ilham, Gunawan, atau peserta lain.

### Personal memory

Tidak berubah dari Sprint 4.20. `sender-identity.js` tetap default `unavailable`; sender scope dan shared scope tidak boleh dipakai sebagai personal memory, principal, atau authorization.

## Perilaku routing dan reply

- Current sender berasal dari normalized `message.author` bila tersedia.
- Group ID tidak pernah menjadi sender scope.
- Display name hanya label.
- Quoted-message author tidak mengganti current sender.
- Reply Gunawan terhadap jawaban untuk Ilham tetap memakai scope Gunawan bila evidence Gunawan tersedia.
- Bila sender evidence hilang, Friday hanya memakai shared context yang aman atau tanpa sender history.
- Private session tetap terpisah dari seluruh group session.

System instruction membedakan sumber `CURRENT_MESSAGE`, `CURRENT_SENDER_GROUP_HISTORY`, `SHARED_GROUP_CONTEXT`, dan verified personal memory bila authorized. Shared content tidak dilabeli sebagai fakta pribadi current sender.

## Persistence dan reliability

Message service tetap mempertahankan queue serialization, deduplication, correlation ID, dan uncertain outbound behavior.

Untuk sender valid, inbound dan successful assistant turn ditulis ke sender scope serta shared scope. Assistant turn tetap hanya disimpan setelah outbound result non-null. Null/undefined/throw tidak memicu resend atau fallback kedua.

Untuk sender evidence tidak tersedia, hanya shared scope yang digunakan. Persistence failure tidak mengubah aturan delivery uncertainty.

## Files changed

- `src/application/conversation-scope.js`
- `src/application/message-service.js`
- `src/database/sqlite.js`
- `src/database/history.js`
- `src/friday-runtime.js`
- `src/ai/conversation-context-policy.js`
- `test/conversation-scope.test.js`
- `test/message-service.test.js`

Tidak ada perubahan schema, migration, `.wwebjs_auth`, production database, personal-memory trust model, atau tool execution.

## Test results

Focused run menggunakan Node.js 24.22.1:

- `node --check src/application/conversation-scope.js`: passed.
- Scope, message service, adapter, dan context policy: **59 passed, 0 failed, 0 skipped**.

Coverage baru mencakup sender/group scope determinism, two-sender isolation, different-group isolation, missing evidence, sender+shared persistence, dan shared-only fallback. Existing media, uncertain transport, memory denial, topic switching, and deduplication tests juga lulus pada focused run.

Full project suite kemudian dijalankan:

- `npm run check`: passed.
- `npm test`: **369 passed, 0 failed, 0 skipped, 0 cancelled**.
- `node --test test/conversation-scope.test.js`: **2 passed, 0 failed**.
- `git diff --check`: passed.

Automated tests tidak membuktikan live WhatsApp atau Gemini behavior.

## Security review dan limitations

Raw WhatsApp sender evidence belum membuktikan nomor, LID equivalence, account ownership, atau real-world identity. Personal memory tetap ditolak saat verifier `unavailable`; privileged tools tetap disabled.

Normal sender request tidak otomatis mengambil shared history peserta lain. Ringkasan grup eksplisit tetap merupakan diskusi bersama, bukan fakta pribadi pengirim.

Sender context baru tidak mewarisi legacy shared history secara otomatis. Ini aman dari salah kepemilikan, tetapi recall personal atas pesan grup lama dapat kosong sampai history baru terbentuk.

SHA-256 partition key bukan privacy guarantee. Secret mapping yang lebih kuat memerlukan desain secret-management terpisah dan tidak ditambahkan dalam sprint ini.

## Manual WhatsApp verification

1. Ilham: `Friday, aku belajar Python, khususnya function.`
2. Gunawan: `Friday, aku belajar Java, khususnya inheritance.`
3. Masing-masing meminta `tadi kita bahas apa?`; jawaban harus sesuai sender masing-masing.
4. Ilham pindah ke Dart; topic Gunawan harus tetap Java.
5. Minta `rangkum diskusi grup`; jawaban boleh memakai shared context dan harus menjaga attribution.
6. Gunawan membalas quoted reply milik Ilham; current sender tetap Gunawan.
7. Simulasikan author kosong; tidak boleh memilih group ID atau history peserta lain.
8. Uji memory command di grup; personal memory tetap ditolak saat verifier unavailable.

Jangan menganggap balasan yang terlihat sebagai bukti delivery/read atau identity verification.

## Final readiness verdict

| Area | Verdict |
|---|---|
| New sender-scoped group context | CONDITIONALLY READY |
| Shared group discussion separation | CONDITIONALLY READY |
| Private/group isolation | CONDITIONALLY READY |
| Missing sender denial behavior | READY untuk safe denial |
| Legacy ownership migration | Tidak dilakukan by design |
| Verified personal identity/memory | NOT READY |
| Privileged tools/authorization | NOT READY dan tetap disabled |
| Live WhatsApp verification | Belum dilakukan |

Sprint ini membuat satu group dapat memiliki beberapa konteks sender yang terpisah sekaligus shared discussion context, tanpa mengklaim bahwa Friday mengetahui identitas nyata setiap peserta.
