# Sprint 4.26 — Natural Interaction, Voice Response & Action Intent Intelligence

## Ringkasan

Sprint ini memperbaiki dua jalur yang dapat diverifikasi dari source dan test:

1. Permintaan jawaban Voice Note diberi instruksi eksplisit bahwa isi TTS harus merupakan jawaban substantif, bukan status pemrosesan.
2. Permintaan aksi yang belum didukung (keluar grup, menghapus file, atau mengirim pesan) dihentikan di application layer dengan respons jujur; tidak ada aksi atau klaim sukses yang dibuat.

Mekanisme pengiriman audio yang sudah ada dipertahankan. Tidak ada tool execution, group-management capability, retry baru, perubahan schema, atau akses data produksi.

## Temuan audit

`message-service.js` memang meneruskan `answer` ke `audio.generate(answer)`, sehingga jalur audio tidak memilih progress event secara langsung. Namun sebelumnya tidak ada sinyal request-format yang membedakan jawaban untuk dibacakan dari jawaban teks. Instruksi voice sekarang dipasang sebelum provider request agar model menjawab topik pengguna secara speech-ready dan tidak menyebut proses internal.

Untuk `leave aja dari grup`, tidak ada kemampuan aplikasi yang benar-benar menjalankan operasi tersebut. Sebelumnya pesan dapat mencapai model dan berisiko menghasilkan klaim “sudah diproses”. Sekarang intent terbatas dan deterministic memberi respons capability-aware sebelum assistant dipanggil. Pertanyaan how-to tetap diteruskan sebagai pertanyaan informasional.

## Perubahan implementasi

- `src/ai/action-intent.js`: helper voice intent, unsupported action classification, dan respons jujur.
- `src/application/message-service.js`: meneruskan `voiceRequested`, memakai helper intent, dan mencegah klaim aksi unsupported.
- `src/friday-runtime.js`: menambahkan instruksi voice-specific sebelum request Gemini.
- `test/action-intent.test.js`: coverage voice intent dan action honesty.
- `test/message-service.test.js`: memastikan jawaban final diteruskan ke TTS dan leave-group joke tidak memanggil assistant.

## Batas keamanan

- Tool executor/orchestrator tetap tidak terhubung ke WhatsApp.
- Tidak ada group-management atau file-deletion capability baru.
- Tidak ada automatic resend setelah outbound uncertain.
- Private/group isolation, sender identity, memory policy, deduplication, queue, dan provider retry tidak diubah.
- Tidak ada logging isi pesan, prompt, audio payload, credential, atau identifier sensitif.

## Verifikasi

- Focused tests: **40 passed, 0 failed, 0 skipped, 0 cancelled**.
- `npm run check`: passed.
- `npm test`: **359 total; 347 passed, 3 failed, 9 skipped, 0 cancelled**.
- Tiga kegagalan berasal dari test SQLite yang membutuhkan built-in `node:sqlite`, sedangkan environment saat ini Node.js `v18.19.1`; bukan kegagalan assertion perubahan Sprint 4.26.
- npm: `9.2.0`.
- `git diff --check`: dijalankan pada pemeriksaan akhir.

Node.js 24 belum tersedia pada environment ini. Full verification wajib diulang pada Node.js 24+.

## Live verification

Owner perlu menguji secara supervised:

1. `Jelaskan apa itu Git Clone pakai VN yaa` — audio menjelaskan Git Clone, tanpa menyebut proses internal.
2. TTS failure — fallback aman tanpa klaim audio berhasil.
3. `Friday leave aja dari grup` — respons playful namun jujur, tanpa perubahan grup.
4. `Friday hapus file itu` dan `Friday kirim pesan ke seseorang` — tidak ada klaim aksi selesai.
5. Dua permintaan voice berurutan/bersamaan — hasil tidak tertukar.

## Verdict

**CONDITIONALLY READY untuk supervised verification.** Jalur voice kini memisahkan isi jawaban dari progress internal secara eksplisit, dan aksi unsupported tidak lagi dapat menghasilkan klaim sukses dari application path. Live WhatsApp, TTS provider, dan Gemini belum diverifikasi dalam sprint ini.
