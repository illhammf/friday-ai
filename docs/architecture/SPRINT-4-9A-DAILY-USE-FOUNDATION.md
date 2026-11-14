# Sprint 4.9A — Friday Daily-Use Foundation

## 1. Executive Summary

Sprint ini menambahkan command WhatsApp deterministik `/help`, `/ping`, dan `/about` melalui application module terisolasi. Command diproses tanpa Gemini, tidak masuk ke conversation history, tidak mengakses memory, database, filesystem, atau tool system. Pesan biasa tetap memakai assistant dan flow media yang sudah ada.

Penanganan diperketat untuk command router yang gagal dan kegagalan pengiriman balasan teks final: error dicatat, respons pengguna tetap aman, dan balasan tidak dikirim ulang ketika status pengiriman pertama tidak pasti.

**Status:** implementasi selesai. `npm run check` lulus. `npm test` menjalankan 282 test: 273 lulus, 2 gagal karena lingkungan memakai Node `v18.19.1` tanpa `node:sqlite` (proyek mensyaratkan Node `>=24`), dan 7 diskip. Tidak ada live WhatsApp atau Gemini yang digunakan.

## 2. Existing Runtime Architecture

Incoming event diterima oleh `registerQueuedMessageHandler()` di `src/whatsapp/message-adapter.js`. Adapter memfilter event yang dapat diproses, memakai deduplication key, lalu memasukkan pesan ke `createMessageQueue()` per chat. Pesan dinormalisasi dan dikirim ke `createMessageService()`.

Message service mengabaikan input kosong atau whitespace, memvalidasi timestamp terhadap waktu kesiapan runtime, lalu mempertahankan aturan prefix `BOT_NAME` untuk pesan grup. Pesan yang lolos diarahkan ke perintah memori yang sudah ada, video, voice note, gambar/stiker, image generation, atau assistant AI. Assistant mengambil riwayat dari sesi aktif, mengambil memori hanya untuk private session, memanggil Gemini dengan fallback model yang sudah ada, memvalidasi bahwa respons memiliki teks, menyimpan percakapan, lalu membalas melalui transport WhatsApp.

Private session masih diturunkan dari sender ID dan group session dari chat ID sesuai aturan legacy. Batas identitas WhatsApp yang belum tervalidasi tetap berlaku: sprint ini tidak mengubah klasifikasi private/group, principal, atau sesi.

## 3. Changes Implemented

- Menambahkan `src/application/command-router.js` dengan allowlist eksplisit dan dependency configuration (`botName`, versi package, deskripsi).
- Menghubungkan router pada composition root `src/friday-runtime.js`; versi dibaca dari metadata package lokal dengan `createRequire`.
- Menambahkan routing command di `src/application/message-service.js` sesudah validasi readiness dan aturan prefix grup, sebelum jalur media, memory, dan AI.
- Command router error menghasilkan balasan aman dan log diagnostik. Kegagalan pengiriman command dan balasan teks final tidak memicu balasan kedua dengan hasil pengiriman yang tidak pasti.
- Menambah `test/command-router.test.js` serta regression tests di `test/message-service.test.js`.
- Memasukkan file command router dalam script `check` dan test baru dalam script `test`.
- Tidak ada dependency atau lockfile yang berubah.

## 4. Command Reference

| Command | Perilaku |
|---|---|
| `/help` | Bantuan ringkas dalam bahasa Indonesia tentang percakapan alami, fitur yang sudah tersedia, command, batas memory privat, dan fitur tools yang belum tersedia/eksperimental. |
| `/ping` | Membalas `Pong! Friday siap menerima pesan.` tanpa Gemini. |
| `/about` | Menampilkan nama Friday, deskripsi singkat, versi dari `package.json`, dan status pengembangan. |
| Command lain | Membalas bahwa command belum tersedia dan mengarahkan ke `/help`; tidak diteruskan ke Gemini. |

Pencocokan nama command tidak peka huruf besar/kecil. Whitespace luar dibuang. Command yang menerima argumen saat ini menolak argumen; argumen tidak pernah dieksekusi atau ditafsirkan. Teks biasa yang sekadar mengandung `/help` tetap dianggap percakapan normal. Di grup, command harus mengikuti prefix yang sudah ada, misalnya `Friday: /ping`.

## 5. Message Routing Flow

1. Event masuk melalui filter, deduplicator, dan queue yang sudah ada.
2. Adapter menormalisasi payload.
3. Message service mengabaikan input kosong/unsupported, memvalidasi timestamp, dan menerapkan aturan prefix grup.
4. Jika isi pesan mulai dengan `/`, command router menentukan response dari allowlist. Command dikenal maupun tak dikenal ditangani tanpa assistant.
5. Jika isi pesan bukan command, flow yang sudah ada dilanjutkan: memory command, media, atau assistant.
6. Command response dikirim memakai `transport.reply()` yang sama, tanpa menyimpan user/model turn ke history.

## 6. Error Handling

- Router yang melempar error dicatat pada logger aplikasi dan dijawab dengan pesan aman; Gemini tidak dipanggil.
- Kegagalan transport saat mengirim command dicatat. Tidak dilakukan pengiriman fallback kedua karena pesan pertama mungkin sudah terkirim.
- Kegagalan mengirim jawaban teks Gemini final juga dicatat tanpa mengirim fallback kedua. Kegagalan provider sebelum pengiriman tetap memakai `getAiFailureMessage()` yang ada.
- Model fallback dan retry provider tidak diubah. Tidak ada retry baru atau retry tanpa batas.
- Input kosong/whitespace dan message type tanpa teks/media yang didukung tetap diabaikan tanpa panggilan Gemini.
- Diagnostik tetap pada logger; isi pesan, kredensial, dan data identitas tidak ditambahkan ke log baru.

## 7. Memory Compatibility

Command router berjalan sebelum perhitungan session dan sebelum memory handler. `/help`, `/ping`, `/about`, serta command yang tidak dikenal tidak membaca atau menulis memory/history. Perintah memory dengan bahasa alami tetap lewat parser memory lama. Group memory tetap ditolak; assistant group menggunakan group history dan tidak mengambil private memory. Session identifiers dan skema SQLite tidak berubah.

Test suite yang tidak memerlukan `node:sqlite` mencakup memory parser/service dan routing legacy. Dua file integration test SQLite tidak dapat dimuat oleh Node 18 yang tersedia di host ini; verifikasi tersebut perlu dijalankan pada Node yang memenuhi engine proyek (`>=24`).

## 8. Security Boundaries

Command router hanya mengembalikan response teks statis berbasis konfigurasi aplikasi. Ia tidak memanggil tool assistant, tool orchestrator, executor, registry dispatch, grant lifecycle, privileged action, filesystem, atau database. Command bukan mekanisme autentikasi maupun otorisasi.

`src/ai/tool-orchestrator.js` dan jalur tool tetap tidak dihubungkan dari production WhatsApp message path. Gemini function calling tidak diaktifkan. Identitas private/group, principal resolution, grant evaluation, dan sesi tidak diubah. Keterbatasan autoritatif pada audit Sprint 4.8D tetap menjadi blocker untuk tool production.

## 9. Test Coverage

Test baru memeriksa:

- Ketiga command dan konten respons `/help` serta `/about`.
- Case-insensitive matching, whitespace, unknown command, `/` dan `//` malformed, serta argumen mirip shell.
- Teks percakapan yang memuat `/help` tidak dianggap command.
- Command melewati Gemini dan history; percakapan biasa tetap memakai assistant.
- Command grup tetap memerlukan prefix Friday.
- Error router dan kegagalan pengiriman command tidak merusak service/tidak menghasilkan balasan ulang.
- Input whitespace dan tipe unsupported tidak memanggil Gemini.
- Kegagalan pengiriman balasan final tidak memicu fallback ganda.

Hasil aktual `npm test`: **282 tests, 273 passed, 2 failed, 7 skipped**. Dua file yang gagal adalah `test/database-migrations.test.js` dan `test/smart-memory.test.js`; keduanya berhenti saat import `node:sqlite`, yang tidak tersedia pada Node `v18.19.1`. Tidak ada kegagalan test command/router pada test terfokus (23 test terfokus lulus setelah penambahan regression cases). `npm run check` lulus. `git diff --check` diperiksa final.

## 10. Known Limitations

- Belum dilakukan verifikasi manual dengan akun WhatsApp; tidak ada koneksi WhatsApp atau panggilan Gemini live.
- `/help` bersifat statis dan harus diperbarui ketika fitur produk berubah.
- Semua command slash yang tidak dikenal ditangani oleh router dan tidak dikirim ke Gemini.
- Node host saat verifikasi lebih tua dari engine proyek; test SQLite perlu diulang pada Node `>=24` sebelum menyatakan seluruh suite hijau.
- Sistem tetap bergantung pada konfigurasi runtime dan provider yang sudah ada untuk fitur AI/media.
- Verifikasi identitas WhatsApp dan privileged tool execution tetap belum siap.

## 11. Manual WhatsApp Verification Guide

Lakukan setelah menjalankan Friday pada lingkungan Node `>=24` dan konfigurasi aplikasi yang sudah dipakai:

1. Di chat pribadi, kirim `/ping`; pastikan balasan Pong muncul tanpa menunggu respons AI.
2. Kirim `/help` dan `/about`; cek daftar fitur, status pengembangan, dan versi aplikasi.
3. Kirim `/UNKNOWN` dan `/ping argumen`; pastikan masing-masing mendapat pesan penolakan yang jelas.
4. Kirim kalimat biasa yang berisi `/help` di tengah kalimat; pastikan Friday menjawab sebagai percakapan AI.
5. Di grup, kirim `/ping` tanpa prefix dan pastikan Friday tidak membalas; kirim `Friday: /ping` dan pastikan mendapat Pong.
6. Lanjutkan percakapan normal, perintah memory privat, gambar, dan voice note untuk memastikan route lama tetap bekerja.
7. Tinjau history: respons command tidak seharusnya menambah turn percakapan.

Panduan ini belum dijalankan pada akun nyata.

## 12. Recommended Next Sprint

Jalankan kembali `npm run check` dan `npm test` dengan Node `>=24` agar dua test SQLite bisa dieksekusi. Setelah itu, lanjutkan peningkatan usability yang terpisah dari authorization, atau lanjutkan roadmap keamanan identitas WhatsApp. Jangan mengaktifkan production tool execution sebelum blocker identitas dan private conversation pada Sprint 4.8D ditutup melalui bukti serta review terpisah.

## Verification and Change Summary

- `npm run check`: lulus.
- `npm test`: 282 total; 273 passed, 2 failed karena modul bawaan `node:sqlite` tidak tersedia pada Node 18 host, 7 skipped.
- `git diff --check`: lulus.
- Source files: `src/application/command-router.js` (baru), `src/application/message-service.js`, `src/friday-runtime.js`.
- Test files: `test/command-router.test.js` (baru), `test/message-service.test.js`.
- Documentation: file laporan ini.
- `package.json`: script check/test diperbarui; tidak ada perubahan dependencies.
- Tidak ada perubahan schema, flow identitas, atau lifecycle aplikasi.
