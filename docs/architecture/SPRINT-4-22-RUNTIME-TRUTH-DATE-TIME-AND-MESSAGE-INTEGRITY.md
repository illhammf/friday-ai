# Sprint 4.22 — Runtime Truth, Date-Time Grounding & Message Integrity

## Executive summary

Live testing pada 26 November 2026 menunjukkan jawaban tanggal yang salah dan berulang: Friday menjawab `Senin, 20 Mei 2024` untuk pertanyaan waktu saat ini. Audit menemukan belum ada application-owned clock atau deterministic date handler pada message path. Gemini sebelumnya dapat menjawab waktu hanya dari pengetahuannya sendiri, sehingga tidak authoritative.

Perbaikan sprint ini:

- menambahkan injectable runtime clock;
- default timezone `Asia/Jakarta` dengan fallback aman untuk timezone invalid;
- menghitung tanggal/waktu pada setiap request, bukan sekali saat startup;
- menambahkan handler deterministik untuk hari, tanggal, bulan, jam, besok, kemarin, dan lusa;
- menyuntikkan temporal metadata trusted ke prompt Gemini untuk pertanyaan umum yang tetap memakai AI;
- menjaga sender-scoped group context Sprint 4.21, deduplication, queue, dan outbound uncertainty.

**Verdict: CONDITIONALLY READY untuk date/time correctness berdasarkan automated tests. Live WhatsApp masih perlu diuji; stale-response hypothesis belum terbukti dari source saja.**

## Observed incidents

Insiden yang diberikan mencakup:

- tanggal lama `20 Mei 2024` muncul berulang;
- koreksi `ngaco` dan `bukan nya Rabu?` belum memicu pemeriksaan runtime yang deterministik;
- beberapa transcript tampak memiliki pesan/respons yang tertukar atau berulang;
- pesan singkat seperti `hmm` memicu respons generik yang tidak selalu sesuai konteks.

## Audit dan root cause

### Confirmed

Source audit tidak menemukan `FRIDAY_TIMEZONE`, runtime clock, atau deterministic current-date route yang digunakan message service. `friday-runtime.js` hanya membangun prompt biasa dan tidak menyediakan current timestamp authoritative. Karena itu jawaban tanggal sebelumnya bergantung pada model/context dan dapat stale atau salah.

Message service memang membuat correlation ID per accepted event, queue tetap bounded, deduplicator menggunakan message identity, dan reply dikirim melalui transport untuk request tersebut. Tidak ditemukan global variable yang menyimpan jawaban provider untuk dipakai request berikutnya.

### Not confirmed

Transcript `hai,bls ham` yang tampak menempel pada pesan lain belum membuktikan stale-response reuse. Kemungkinan yang masih terbuka:

- quoted-message presentation WhatsApp;
- transcript copy yang menggabungkan pesan;
- event/message update dari client;
- duplicate listener atau duplicate event di live runtime;
- out-of-order visual delivery.

Konfirmasi membutuhkan correlation IDs dan stage logs dari live run. Tidak ada live WhatsApp access dilakukan dalam sprint ini.

## Runtime clock architecture

`src/application/runtime-clock.js` menyediakan `createRuntimeClock({ now, timezone })`. `now` injectable untuk test dan dievaluasi saat `getContext()` dipanggil. Context berisi local date, weekday, time, dan timezone.

Timezone divalidasi melalui `Intl.DateTimeFormat`. Nilai invalid atau kosong fallback ke `Asia/Jakarta`. Tidak ada tanggal hardcoded dan tidak ada external time service.

`src/application/temporal-service.js` membuat context temporal per request dan menghasilkan metadata:

```text
TRUSTED_RUNTIME_TIME
CURRENT_RUNTIME_TIME
TIMEZONE
LOCAL_DATE
LOCAL_WEEKDAY
```

Metadata ini bukan conversation history, tidak dipersist sebagai turn, dan diposisikan sebagai application metadata yang lebih authoritative daripada tanggal lama di history.

## Deterministic date/time handling

Pertanyaan sederhana berikut dijawab tanpa Gemini:

- hari sekarang/hari ini;
- tanggal sekarang;
- bulan dan tahun sekarang;
- jam sekarang;
- besok hari apa;
- kemarin hari apa;
- lusa tanggal berapa.

Prefix `Friday` didukung. Matching sengaja anchored agar kalimat seperti `Hari ini aku belajar Python` tidak dianggap sebagai date command. Pertanyaan historical date yang tidak cocok pola tetap masuk ke percakapan biasa.

Handler ini tidak menulis conversation history, tidak memakai memory, dan tetap melalui reply transport serta uncertainty handling yang sama.

## Correction behavior

Jika user menantang jawaban date/time, request baru sekarang memiliki akses ke clock saat itu. Handler deterministik tidak memakai jawaban sebelumnya sebagai sumber tanggal. Untuk koreksi yang tidak cocok pola date command, context policy dan system instruction tetap mengarahkan Friday untuk tidak mengulang fakta lama secara membabi buta.

Respons seperti `Friday hmm 🤨` tidak otomatis menjadi identity introduction; short-message/context policy lama tetap dipertahankan. Perubahan sprint ini tidak menambahkan greeting generik baru.

## Message integrity audit

Preserved guarantees:

- correlation ID per accepted message;
- queue serialization dan bounded admission;
- message-ID deduplication;
- identical text dengan ID berbeda tetap diterima;
- sender-scoped group context tetap terpisah;
- current message masuk sekali ke request;
- outbound null/undefined/throw tetap `uncertain`;
- tidak ada automatic resend atau duplicate fallback;
- assistant history persistence tetap mengikuti successful local submission policy.

Tidak ada source evidence bahwa provider result disimpan di global state atau digunakan ulang untuk message berikutnya. Live correlation logs tetap diperlukan untuk membedakan stale response dari transcript/WhatsApp presentation issue.

## Files changed

- `src/application/runtime-clock.js` — injectable timezone-aware clock.
- `src/application/temporal-service.js` — deterministic temporal answers and request metadata.
- `src/application/message-service.js` — temporal handler before Gemini.
- `src/friday-runtime.js` — runtime clock/temporal service injection and trusted request context.
- `test/temporal-service.test.js` — clock, timezone, relative date, and classification tests.
- `test/message-service.test.js` — deterministic temporal bypass test.

Sprint 4.20/4.21 identity, memory, group-scope, queue, lifecycle, and tool restrictions tetap dipertahankan.

## Verification

Environment:

- Node.js `v24.22.1`
- npm `11.19.1`

Focused tests:

- temporal clock/service + message service: **39 passed, 0 failed, 0 skipped**.

Full verification:

- `npm run check`: passed.
- `npm test`: **370 passed, 0 failed, 0 skipped, 0 cancelled**.
- `git diff --check`: passed.

Automated tests tidak membuktikan live WhatsApp/Gemini delivery atau transcript ordering.

## Security and privacy

- Tidak ada API key, prompt, message body, phone number, LID, atau memory content baru yang dilog.
- Temporal metadata tidak dipersist sebagai conversation turn.
- Tidak ada perubahan database schema atau production data.
- Tidak ada `.wwebjs_auth` access, dependency patch, atau tool activation.
- Deterministic date handler tidak memberi capability atau authorization.

## Manual WhatsApp verification

1. Tanyakan `Friday sekarang hari apa dan tanggal berapa?`; cocokkan dengan tanggal Asia/Jakarta.
2. Tanyakan `sekarang bulan apa?`, `jam berapa sekarang?`, `besok hari apa?`, dan `kemarin hari apa?`.
3. Tanyakan `Friday hari apa ini?`, lalu kirim `ngaco` atau `kok salah, cek lagi`; pastikan jawaban berikutnya tidak mengulang tanggal lama.
4. Kirim beberapa pesan berbeda cepat-cepat; cocokkan tiap reply dengan correlation log.
5. Kirim teks identik dua kali sebagai dua WhatsApp message ID; keduanya harus diterima.
6. Verifikasi duplicate event tidak menghasilkan dua balasan.
7. Uji group Python/Java dari Sprint 4.21 dan pastikan sender scope tetap terpisah.
8. Kirim `Friday hmm 🤨`; pastikan respons mengikuti konteks tanpa intro tidak perlu.

Catat hasil manual terpisah. Jangan menyatakan stale-response bug terpecahkan hanya dari fake tests.

## Final readiness verdict

| Area | Verdict |
|---|---|
| Dynamic runtime date/time | CONDITIONALLY READY berdasarkan automated tests |
| Deterministic current-date questions | CONDITIONALLY READY |
| Timezone fallback and relative dates | CONDITIONALLY READY |
| Message correlation/dedup source audit | CONDITIONALLY READY |
| Stale live response reuse | Belum terbukti |
| Sender-scoped group context | Tetap CONDITIONALLY READY |
| Personal memory and privileged tools | NOT READY dan tetap disabled |
| Live WhatsApp verification | Belum dilakukan |

Friday sekarang memiliki sumber waktu aplikasi yang dinamis dan deterministic. Masalah transcript/message reuse masih memerlukan bukti live dengan correlation ID sebelum dapat dinyatakan sebagai bug yang sudah diperbaiki.
