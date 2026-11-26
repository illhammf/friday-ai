# Sprint 4.23 — Context Intelligence & Topic Isolation Overhaul

## Executive summary

Audit menemukan policy lama selalu membawa empat pesan terakhir ke request biasa. Akibatnya history tanggal atau topik lama dapat ikut terbawa ketika user memulai topik baru. Ini terjadi di application context selection, bukan dibuktikan sebagai bug Gemini.

Perbaikan menerapkan precedence yang eksplisit:

1. current request;
2. short/identity/correction/open-topic;
3. explicit topic switch;
4. ambiguous reference;
5. recent/historical recall;
6. continuation;
7. relevant conversation only.

Continuation seperti `berikan contohnya`, `jelaskan bagian kedua`, dan `kenapa begitu?` mempertahankan konteks aktif. Substantive request baru tanpa relevance tidak lagi mendapat history lama secara otomatis. Reference ambigu seperti `Bagaimana dengan yang tadi?` menghasilkan konteks kosong agar model meminta klarifikasi, bukan menebak.

**Verdict: CONDITIONALLY READY berdasarkan source audit dan automated tests. Live WhatsApp/Gemini belum diverifikasi.**

## Confirmed findings

- Context policy sebelumnya memiliki recent-window fallback untuk percakapan biasa.
- Date/time handler Sprint 4.22 sudah bypass Gemini dan tidak menyimpan temporal answer sebagai history.
- Sender-scoped group context Sprint 4.21 tetap dipilih oleh runtime; perubahan ini tidak mengubah scope atau identity verifier.
- Current user message tetap dibangun satu kali oleh `buildConversationContents()`.
- Tidak ditemukan source evidence bahwa provider response disimpan sebagai global stale result.

## Classification and history policy

`src/ai/conversation-context-policy.js` sekarang membedakan:

- `short`, `identity`, `correction`, `open_topic`;
- `topic_switch`, `continuation`;
- `recent_recall`, `historical_recall`;
- `ambiguous_reference`, `conversation`.

History baru dipilih bila intent memang membutuhkan history. Topic baru yang tidak overlap dengan active context mendapat request bersih. Historical recall tetap dapat mengambil bounded recent history, tetapi instruction menegaskan bahwa recall tidak mengaktifkan kembali topic lama pada request berikutnya.

Context tetap bounded, chronological, sender-scoped, dan private/group isolated. Shared group context hanya dipakai melalui jalur eksplisit Sprint 4.21.

## System instruction

Instruksi sistem diperbarui agar:

- request terbaru menjadi prioritas;
- tanggal/runtime metadata tidak dikalahkan history lama;
- topic lama tidak disebut tanpa alasan;
- continuation dibedakan dari topic switch;
- historical recall tidak mengaktifkan topic lama;
- reference ambigu meminta klarifikasi;
- group sender history dibedakan dari shared group context.

Instruksi tidak menjadi satu-satunya enforcement; history sudah dibatasi sebelum request Gemini dibuat.

## Files changed

- `src/ai/conversation-context-policy.js`
- `src/config/system-instruction.js`
- `test/conversation-context-policy.test.js`
- `docs/architecture/SPRINT-4-23-CONTEXT-INTELLIGENCE-AND-TOPIC-ISOLATION.md`

Tidak ada database schema change, reset data, perubahan `.wwebjs_auth`, perubahan identity trust, personal-memory activation, tool execution, atau outbound retry.

## Tests

Test tambahan mencakup:

- topic baru setelah topic Java/date tidak membawa history lama;
- continuation mempertahankan active topic;
- ambiguous reference tidak menebak;
- `kenapa begitu?` tidak lagi salah diklasifikasikan sebagai correction;
- existing historical recall, topic switch, recent recall, current-message deduplication, dan sender/group tests tetap dipertahankan.

Verification:

- Node.js: `v24.22.1`
- npm: `11.19.1`
- `npm run check`: passed
- `npm test`: **373 passed, 0 failed, 0 skipped, 0 cancelled**
- `git diff --check`: passed

Automated tests menggunakan synthetic data/fakes dan tidak membuktikan live WhatsApp atau Gemini behavior.

## Manual WhatsApp checklist

1. Tanya tanggal, lalu minta penjelasan Java; Java tidak boleh memuat tanggal lama.
2. Bahas Java, pindah ke AES-256-GCM, lalu tanyakan authentication tag; AES tidak boleh tercampur Java.
3. Setelah Java, kirim `Berikan contohnya`; konteks Java harus dipertahankan.
4. Kirim `Bagaimana dengan yang tadi?` dalam history dengan beberapa kandidat; Friday harus meminta klarifikasi.
5. Recall Python secara eksplisit, lalu tanya database; Python tidak boleh otomatis aktif kembali.
6. Uji Ilham/Gunawan di grup untuk memastikan sender scopes tetap terpisah.
7. Uji private/group isolation dan memory denial seperti Sprint 4.20–4.21.

Catat hasil manual terpisah dari hasil automated tests. Jangan menyatakan live topic leakage selesai hanya karena suite lokal lulus.

## Security and limitations

Personal memory tetap membutuhkan verified principal dan default production tetap `unavailable`. Group ID, display name, quoted author, dan sender scope tidak menjadi identity proof. Temporal metadata trusted tetap terpisah dari history. Tidak ada pesan produksi yang dibaca atau diubah.

Ambiguous references sengaja fail-closed; ini dapat menghasilkan pertanyaan klarifikasi walau manusia mungkin menganggap rujukannya jelas. Live logs dengan correlation ID masih diperlukan untuk mengonfirmasi transcript yang tampak tertukar atau stale-response reuse.

## Final readiness verdict

| Area | Verdict |
|---|---|
| Latest-request priority | CONDITIONALLY READY |
| Topic-switch isolation | CONDITIONALLY READY |
| Continuation handling | CONDITIONALLY READY |
| Historical recall without automatic reactivation | CONDITIONALLY READY |
| Ambiguous-reference safety | READY untuk deny/clarify behavior |
| Sender/group/private isolation | Tetap CONDITIONALLY READY |
| Personal memory and privileged tools | NOT READY dan tetap disabled |
| Live WhatsApp verification | Belum dilakukan |
