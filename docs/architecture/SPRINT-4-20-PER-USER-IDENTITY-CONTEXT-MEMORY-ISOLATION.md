# Sprint 4.20 — Per-User Identity, Context & Memory Isolation

## 1. Executive summary

Audit ini menindaklanjuti insiden ketika peserta grup lain menanyakan apakah FRIDAY masih mengingatnya, tetapi respons membawa konteks pribadi milik pengguna lain. Akar masalah yang terkonfirmasi adalah batas antara identitas percakapan grup dan identitas pengirim belum cukup ketat: adapter sebelumnya dapat menggunakan ID grup sebagai `senderId` ketika `message.author` tidak tersedia, sementara riwayat grup memang bersifat bersama.

Perbaikan yang diterapkan bersifat minimal dan fail-closed:

- `senderId` untuk pesan grup sekarang hanya berasal dari `message.author` yang valid; tidak ada fallback ke `message.from`/ID grup.
- Ditambahkan boundary `sender-identity` dengan status `verified`, `unavailable`, `invalid`, dan `ambiguous`.
- Verifier produksi default selalu `unavailable` karena `whatsapp-web.js@1.34.7` belum menyediakan bukti otoritatif untuk mengikat identitas WhatsApp ke principal aplikasi.
- Memori pribadi hanya boleh dipakai jika resolver aplikasi mengembalikan principal terverifikasi. Group context tetap shared dan tidak menjadi personal memory.
- Pertanyaan identitas termasuk “masih ingat aku?” kini tidak menarik riwayat lama secara otomatis.
- Metadata quoted message tidak digunakan untuk mengganti identitas pengirim saat ini.

Tidak ada reset, migrasi, perubahan schema, akses database produksi, akses akun WhatsApp nyata, atau aktivasi tool execution.

**Verdict keseluruhan: NOT READY untuk per-user personal memory/authorization produksi.** Isolasi aman dan percakapan biasa dapat diuji lebih lanjut, tetapi fitur personal memory tetap ditolak sampai resolver identitas otoritatif disediakan.

## 2. Audit dan temuan terkonfirmasi

### 2.1 Alur aktual

Alur yang diverifikasi dari source:

`WhatsApp event → normalizeWhatsAppMessage() → message queue → message-service → session selection → context policy → memory retrieval → Gemini assistant → reply transport → persistence/observability`.

Private session memakai session berbasis `message.from`. Group session memakai session bersama berbasis chat ID. Itu sesuai untuk percakapan bersama, tetapi tidak cukup untuk memisahkan memori pribadi antaranggota.

### 2.2 Temuan identitas

Sebelum koreksi, normalisasi grup menggunakan `message.author || message.from`. Bila author hilang, ID grup dapat terlihat sebagai identitas sender. Ini melanggar invariant bahwa chat ID tidak pernah boleh menjadi sender identity.

Setelah koreksi, author yang hilang menjadi `null`. Tidak ada display name, quoted author, atau ID chat yang dianggap bukti principal.

`sender-identity.js` menerima hanya evidence yang sudah dinormalisasi dan menghasilkan status eksplisit. Hasil `verified` wajib memiliki principal aplikasi dengan format tervalidasi; hasil malformed, error resolver, atau status tak dikenal berubah menjadi `unavailable`.

### 2.3 Temuan memory

Repository lama menyimpan memori dengan `session_id`; belum ada kolom principal ownership dan tidak ada mapping LID/phone yang terbukti otoritatif. Karena itu tidak aman menganggap raw WhatsApp ID atau session ID sebagai kepemilikan personal lintas format.

Runtime sekarang hanya mengambil/menulis memori pribadi pada scope `private:principal:<principalId>` ketika status identity `verified`. Dengan verifier default `unavailable`, operasi memori pribadi ditolak secara aman. Group messages tidak mengambil memori pribadi.

### 2.4 Temuan context

Policy context tetap memisahkan history, active topic, recent recall, identity question, topic switch, dan correction. Pertanyaan singkat atau identitas tidak menyertakan history lama. Penambahan “masih ingat aku?”, “ingat aku?”, dan “remember me” ke klasifikasi identity mencegah pertanyaan identitas peserta grup menghidupkan konteks lama.

## 3. Kontrak identity dan alur isolasi

Kontrak konseptual yang kini tersedia melalui dependency injection:

```js
{ status: 'verified', principalId: 'principal:...' }
{ status: 'unavailable', reason: '...' }
{ status: 'invalid', reason: '...' }
{ status: 'ambiguous', reason: '...' }
```

Hanya `verified` + `principalId` yang dapat menjadi kunci memori pribadi. Model Gemini tidak memilih principal, tidak mengubah status, dan tidak dapat memberikan capability. Resolver masa depan harus application-owned serta membuktikan pemetaan identitas secara independen.

Group flow:

1. History group tetap shared berdasarkan chat group.
2. `message.author` adalah evidence sender bila tersedia, bukan otomatis principal.
3. Author hilang/ambigu tidak diisi dengan group ID.
4. Personal memory retrieval/write tidak dilakukan tanpa principal terverifikasi.
5. Quoted-message author hanya metadata referensi dan tidak menggantikan current sender.

Private flow memakai session private untuk percakapan biasa, tetapi personal memory tetap memerlukan identity verifier jika boundary tersebut dipakai oleh runtime.

## 4. Perubahan yang diimplementasikan

- `src/application/sender-identity.js`: verifier dependency-injected, status normalisasi, dan `canUsePersonalMemory()`.
- `src/whatsapp/message-adapter.js`: menghapus fallback author grup ke ID grup.
- `src/application/message-service.js`: identity resolution stage, deny-safe memory commands, principal-scoped memory session, dan propagation identity status yang aman.
- `src/friday-runtime.js`: default verifier fail-closed, personal memory retrieval hanya untuk principal terverifikasi, serta instruksi group/shared context.
- `src/config/system-instruction.js`: penegasan bahwa group statements dan labels bukan personal memory current sender.
- `src/ai/conversation-context-policy.js`: pertanyaan “ingat aku” dikategorikan sebagai identity question.
- `test/sender-identity.test.js`, `test/message-service.test.js`, dan `test/conversation-context-policy.test.js`: regression coverage untuk missing author, quoted identity boundary, unavailable/verified principal, dan identity recall.

Tidak ada perubahan schema, migrasi, dependency, WhatsApp auth, tool authorization, atau production conversation data.

## 5. Pengujian dan verifikasi

Automated tests menggunakan fake dependencies dan tidak terhubung ke WhatsApp/Gemini nyata. Hasil terakhir setelah perubahan:

- Node.js: `v24.22.1`
- npm: `11.19.1`
- `npm run check`: berhasil
- `npm test`: **367 passed, 0 failed, 0 skipped, 0 cancelled**
- `git diff --check`: berhasil

Coverage baru memverifikasi:

- Default verifier tidak pernah menganggap evidence WhatsApp sebagai verified.
- Injected verified principal menggunakan scope personal yang berbeda.
- Resolver error/malformed/ambiguous fail closed.
- Group author yang hilang tidak menjadi group ID.
- Quoted author tidak menjadi current sender evidence.
- Memory command unavailable ditolak tanpa handler memory.
- “Friday masih ingat aku?” masuk identity context tanpa history lama.

## 6. Batasan dan risiko tersisa

Temuan source dan test di atas tidak membuktikan live WhatsApp behavior. Belum dilakukan live test, dan tidak ada database produksi yang dibaca atau diubah.

Blocker utama tetap sama dengan audit Sprint 4.8D: dependency terpasang belum memberikan mekanisme publik dan otoritatif untuk membuktikan pemetaan LID ↔ nomor telepon ↔ akun yang sama pada boundary aplikasi. Karena itu personal memory lintas participant, principal binding, dan privileged authorization belum boleh diaktifkan.

Memori lama berbasis raw session tidak otomatis dimigrasikan ke principal scope; ini sengaja untuk mencegah salah-kepemilikan. Setelah resolver tepercaya tersedia, pemetaan legacy harus diaudit terpisah sebelum digunakan.

## 7. Manual verification yang masih diperlukan

Owner dapat menguji secara terawasi dengan dua akun sintetis/nyata yang memang berada di satu grup:

1. Participant A menyimpan fakta pribadi melalui mekanisme memory yang sudah ada.
2. Participant B bertanya “masih ingat aku?” dan mengutip pesan FRIDAY.
3. Pastikan respons B tidak memakai fakta A dan tidak mengklaim B terverifikasi.
4. Kirim pesan grup tanpa `author` jika dapat disimulasikan; pastikan tidak menjadi sender ID grup.
5. Uji private session A dan B secara terpisah.
6. Pastikan status terminal/structured log menunjukkan `identityStatus: unavailable` bila resolver belum dipasang.

Jangan menandai personal memory atau authorization sebagai berhasil hanya karena balasan terlihat di WhatsApp. Local SDK submission bukan bukti delivery/read dan bukan bukti identity equivalence.

## 8. Final readiness verdict

| Area | Verdict |
|---|---|
| Group/private session isolation | CONDITIONALLY READY, berdasarkan source dan automated tests |
| Safe handling missing/ambiguous sender | READY untuk deny-safe behavior |
| Per-user personal memory | NOT READY tanpa verified principal resolver |
| LID/phone canonicalization | NOT READY |
| Principal-to-session binding | NOT READY |
| Privileged authorization/tool execution | NOT READY dan tetap disabled |
| Live WhatsApp correctness | Belum diverifikasi |

Kesimpulannya, Friday sekarang tidak lagi boleh mengubah group participant atau group ID menjadi pemilik memori pribadi secara diam-diam. Namun, kebutuhan “buat per orang” belum dapat dinyatakan selesai secara penuh sampai identitas pengirim dapat diverifikasi secara otoritatif oleh boundary aplikasi.
