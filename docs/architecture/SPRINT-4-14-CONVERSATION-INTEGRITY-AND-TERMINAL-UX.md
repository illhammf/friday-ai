# Sprint 4.14 — Conversation Integrity, Context Accuracy, WhatsApp Delivery Investigation & Terminal Experience

## 1. Ringkasan

Audit terhadap implementasi aktual tidak menemukan bukti bahwa SQLite menukar urutan pesan atau mencampur sesi private dan group. Riwayat terbaru memang masuk ke request Gemini dan pesan saat ini hanya ditambahkan satu kali. Namun, jendela konteks sebelumnya masih dapat memuat percakapan lama yang tidak relevan. Perubahan kecil pada kebijakan seleksi konteks sekarang selalu mempertahankan empat entri terbaru dan hanya menambahkan entri lama yang memiliki irisan istilah dengan pertanyaan aktif.

Instruksi grounding juga diperjelas: pesan saat ini dan percakapan terbaru menjadi bukti utama; memori eksplisit hanya pelengkap; klaim tentang pesan pengguna harus didukung konteks yang tersedia; dan konteks yang tidak ada harus diakui sebagai tidak dapat dipastikan. Ini mengurangi peluang model memilih cerita lama, tetapi tidak menjamin perilaku model live secara absolut.

Output terminal dipisahkan dari observability terstruktur melalui `terminal-presenter.js`. Mode `human` menjadi default interaktif, sedangkan `json` dan `quiet` tetap tersedia. Warna, timezone Asia/Jakarta, preview opsional, sanitasi control character, dan isolasi kegagalan output ditangani tanpa dependency baru.

## 2. Audit awal dan temuan terkonfirmasi

- `message-service` memilih session private atau group sebelum memanggil assistant. Group tidak mengambil private memory.
- SQLite mengembalikan history berdasarkan session dan urutan ID ascending; runtime menormalisasi lalu menyusun request secara kronologis.
- `buildConversationContents` mempertahankan role history dan menggabungkan pesan berurutan dengan role sama tanpa mengubah urutan. Pesan aktif ditambahkan sekali pada content user terakhir.
- Setelah perubahan Sprint 4.13B, inbound user message tetap disimpan walaupun reply `null`, `undefined`, atau melempar error. Assistant hanya disimpan setelah hasil outbound lokal non-null.
- Adapter reply mengembalikan langsung hasil `message.reply(text)`. Hasil non-null hanya berarti local SDK submission; bukan bukti pesan dibaca atau diterima penerima.
- Quoted reply WhatsApp menggunakan metadata quote SDK; adapter memakai `message.body` sebagai teks, sehingga tidak ditemukan kode yang menambahkan ulang quoted body ke prompt.
- Jendela Gemini sebelumnya dapat berisi pesan sticker/voice-note lama bersama pesan Dart terbaru. Test deterministik kini memastikan fakta terbaru tetap berada di request dan konteks lama yang tak relevan dikeluarkan.

## 3. Hipotesis yang tetap belum terbukti

Penyebab persis jawaban model live yang memilih sticker dan voice note belum dapat dipastikan tanpa request/provider response live. Kemungkinan yang tersisa adalah prioritisasi model terhadap konteks lama, ambiguitas pertanyaan, atau efek memory retrieval yang tidak relevan. Automated tests hanya membuktikan request yang dibangun aplikasi dan policy seleksinya, bukan jaminan recall Gemini live.

## 4. Perubahan konteks dan grounding

`src/ai/conversation-context-policy.js` menyediakan seleksi deterministik: empat entri terbaru selalu dipertahankan; hingga empat entri lebih lama hanya dipilih bila memiliki kata bermakna yang tumpang tindih dengan pertanyaan; urutan asli dipertahankan. `friday-runtime.js` menerapkan policy setelah normalisasi history sebelum request Gemini.

`src/config/system-instruction.js` mendapat aturan singkat untuk pertanyaan “barusan”, “tadi”, “sebelumnya”, “yang aku bilang”, dan “apa yang aku minta”. Instruksi melarang klaim tanpa bukti dan meminta pengakuan ketidakpastian bila konteks tidak cukup.

Tidak ada perubahan schema, session ID, memory policy, retry provider, atau tool execution.

## 5. Temuan outbound WhatsApp

`createWhatsAppAdapters().reply` sudah meneruskan Promise dan nilai hasil `message.reply`. Karena whatsapp-web.js dapat mengembalikan `Message`, `null`, `undefined`, atau throw tergantung kondisi, klasifikasi `submitted` versus `uncertain` tetap dipertahankan. Tidak ditambahkan resend otomatis. Event terminal memakai istilah `ANSWER SUBMITTED` hanya untuk hasil non-null dan `DELIVERY UNCERTAIN` untuk hasil yang tidak dapat dibuktikan.

## 6. Arsitektur terminal

`src/application/terminal-presenter.js` menerima event terstruktur melalui dependency injection dan tidak menjadi sumber observability. Runtime meneruskan stage yang sudah disanitasi dari conversation observability. `registerQueuedMessageHandler` juga mengirim event incoming dengan kategori private/group dan tipe pesan, tanpa raw WhatsApp ID.

Mode:

- `human`: output berwarna jika TTY mendukung dan `NO_COLOR` tidak aktif.
- `json`: event machine-readable, tanpa preview pesan.
- `quiet`: tidak menulis output terminal normal.

`FRIDAY_TIMEZONE` dapat mengatur timezone; nilai invalid aman kembali ke `Asia/Jakarta`. `FRIDAY_MESSAGE_PREVIEWS=true` mengaktifkan preview terpotong. Teks preview membersihkan ANSI/control characters. Kegagalan menulis ke terminal ditelan secara aman agar tidak menghentikan pemrosesan pesan.

## 7. Keamanan dan privasi

Tidak ada API key, token, prompt penuh, response provider, private memory, nomor telepon, raw WhatsApp ID, atau stack trace yang ditambahkan ke output human. Tool executor, orchestrator, grant lifecycle, identity verification, private/group isolation, database schema, `.wwebjs_auth`, dan database produksi tidak diubah. Tidak ada koneksi live WhatsApp/Gemini.

## 8. File diubah dan ditambahkan

- Diubah: `package.json`, `src/friday-runtime.js`, `src/config/system-instruction.js`, `src/application/terminal-presenter.js`, `src/whatsapp/message-adapter.js`.
- Ditambahkan: `src/ai/conversation-context-policy.js` (kebijakan konteks yang digunakan runtime), `test/conversation-context-policy.test.js`, `test/terminal-presenter.test.js`.
- Tidak ada perubahan dependency, lockfile, migration, atau database schema.

## 9. Test dan verifikasi

Perintah yang dijalankan:

```text
node --version                 # Node.js v24.22.1
npm --version                  # npm 11.19.1
npm run check                  # berhasil
npm test                       # 346 passed, 0 failed, 0 skipped, 0 cancelled
git diff --check               # berhasil
```

Test baru mencakup Dart versus sticker/voice lama, current message sekali, urutan kronologis, preview sanitization, NO_COLOR/non-TTY, timezone invalid fallback, json mode tanpa preview, dan kegagalan terminal yang tidak memutus caller. Tidak ada real TTY, WhatsApp, atau Gemini live verification pada sprint ini.

## 10. Keterbatasan dan langkah verifikasi owner

Model live tetap probabilistik; aplikasi tidak dapat membuktikan jawaban model secara sempurna. Jalankan manual dalam satu private session: kirim perkenalan Dart/variabel, tanyakan topik, lalu tanyakan dua fakta sebelumnya. Periksa bahwa terminal menunjukkan correlation/stage yang benar dan jawaban hanya menyebut fakta yang benar-benar tersedia. Ulangi dengan history lama sticker/voice dan pastikan tidak ada resend saat status outbound `UNCERTAIN`.

## 11. Verdict

**CONDITIONALLY READY** untuk audit dan penggunaan supervised terbatas. Integritas request dan terminal observability memiliki regression coverage, tetapi akurasi recall Gemini live serta konfirmasi outbound WhatsApp tetap memerlukan pengujian manual owner. Production tool execution tetap disabled.

### Ringkasan Indonesia

Sumber masalah yang terbukti bukan pertukaran urutan SQLite, melainkan konteks lama yang sebelumnya masih ikut dikirim dan tidak memiliki prioritas eksplisit. Sekarang konteks terbaru dipertahankan secara deterministik, instruksi grounding diperketat, dan terminal memiliki tampilan human/json/quiet yang aman. Tes lengkap lulus 346/346; verifikasi live belum dilakukan.
