
import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import whatsapp from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { inspect } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const { Client, LocalAuth, MessageMedia } = whatsapp;

const BOT_NAME = process.env.BOT_NAME || 'Friday';
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error('API key belum dikonfigurasi. Periksa file .env.');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: API_KEY });

async function transcribeVoiceNote(media) { // Untuk transkripsi catatan suara, media adalah objek yang berisi data audio.
  if (!media?.data || !media.mimetype?.startsWith('audio/')) {
    throw new Error('Lampiran bukan audio yang didukung.');
  }

  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), 'friday-audio-'),
  );

  const audioPath = join(temporaryDirectory, 'voice-note.ogg');

  try {
    const audioBuffer = Buffer.from(media.data, 'base64');
    await writeFile(audioPath, audioBuffer);

    const uploadedAudio = await ai.files.upload({
      file: audioPath,
      config: {
        mime_type: media.mimetype,
      },
    });

    const transcription = await ai.interactions.create({
      model: 'gemini-3.5-transcribe',
      input: [
        {
          type: 'audio',
          uri: uploadedAudio.uri,
          mime_type: uploadedAudio.mimeType,
        },
      ],
    });

    const transcript = transcription.output_text?.trim();

    if (!transcript) {
      throw new Error('Transkripsi audio tidak menghasilkan teks.');
    }

    return transcript;
  } finally {
    await rm(temporaryDirectory, {
      recursive: true,
      force: true,
    });
  }
}

async function generateVoiceNote(text) {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), 'friday-tts-'),
  );

  const wavPath = join(temporaryDirectory, 'answer.wav');
  const oggPath = join(temporaryDirectory, 'answer.ogg');

  try {
    const interaction = await ai.interactions.create({
      model: 'gemini-3.8-flash-tts',
      input: [
        {
          type: 'user_input',
          content: [
            {
              type: 'text',
              text: text.slice(0, 4000),
              annotations: [
                {
                  type: 'speech_metadata',
                  style: 'warm, friendly, clear, and conversational',
                },
              ],
            },
          ],
        },
      ],
      response_format: { type: 'audio' },
      generation_config: {
        speech_config: [
          { voice: 'Kore' },
        ],
      },
    });

    if (!interaction.output_audio?.data) {
      throw new Error('Gemini tidak menghasilkan data audio.');
    }

    await writeFile(
      wavPath,
      Buffer.from(interaction.output_audio.data, 'base64'),
    );

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    await execFileAsync('ffmpeg', [
      '-y',
      '-i', wavPath,
      '-vn',
      '-c:a', 'libopus',
      '-b:a', '32k',
      '-vbr', 'on',
      '-application', 'voip',
      '-ac', '1',
      '-ar', '48000',
      oggPath,
    ]);

    return {
      path: oggPath,
      cleanup: () => rm(temporaryDirectory, {
        recursive: true,
        force: true,
      }),
    };
  } catch (error) {
    await rm(temporaryDirectory, {
      recursive: true,
      force: true,
    });
    throw error;
  }
}

mkdirSync('data', { recursive: true });

const db = new DatabaseSync(join('data', 'friday.sqlite'));

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'model')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session
  ON messages (session_id, id);
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (session_id, role, content)
  VALUES (?, ?, ?)
`);

const getHistory = db.prepare(`
  SELECT role, content
  FROM messages
  WHERE session_id = ?
  ORDER BY id DESC
  LIMIT 20
`);

const trimHistory = db.prepare(`
  DELETE FROM messages
  WHERE session_id = ?
  AND id NOT IN (
    SELECT id FROM messages
    WHERE session_id = ?
    ORDER BY id DESC
    LIMIT 20
  )
`);

function saveMessage(sessionId, role, content) {
  insertMessage.run(sessionId, role, content);
  trimHistory.run(sessionId, sessionId);
}

function privateSessionId(userId) {
  return `private:${userId}`;
}

function groupSessionId(groupId) {
  return `group:${groupId}`;
}

function loadHistory(sessionId, limit = 10) {
  return getHistory.all(sessionId)
    .reverse()
    .slice(-limit)
    .map(({ role, content }) => ({
      role,
      parts: [{ text: content }],
    }));
}


 // Fungsi utama untuk menangani pertanyaan dari pengguna dan mengirimkannya ke model AI.
async function askFriday({
  question,
  privateSession,
  sharedGroupSession = null,
  senderName = 'Pengguna',
}) {
  // Memori pribadi hanya berisi percakapan pengguna tersebut.
  const privateHistory = loadHistory(privateSession, 10);

  // Konteks grup bersifat bersama dan hanya digunakan dalam grup.
  const groupHistory = sharedGroupSession
    ? loadHistory(sharedGroupSession, 10)
    : [];

  const contents = [
    ...groupHistory,
    ...privateHistory,
    {
      role: 'user',
      parts: [{ text: question }],
    },
  ];

  const response = await ai.models.generateContent({
    model: MODEL,
    contents,
    config: {
    systemInstruction: `
    Kamu adalah FRIDAY, asisten AI pribadi yang ramah,
    cerdas, sopan, dan membantu.

    IDENTITAS FRIDAY:
    - Nama: FRIDAY.
    - Fungsi: Personal AI Assistant.
    - Teknologi AI: Google Gemini.
    - Pembuat: Ilham Firmansyah.
    - Afiliasi pembuat: Mahasiswa Fakultas Ilmu Komputer,
      Program Studi Teknik Informatika,
      Universitas Esa Unggul.

    ATURAN IDENTITAS:
    - Jika ditanya siapa pembuat, pengembang, atau pencipta FRIDAY,
      jelaskan bahwa FRIDAY dikembangkan oleh Ilham Firmansyah,
      mahasiswa Fakultas Ilmu Komputer, Program Studi Teknik
      Informatika, Universitas Esa Unggul.
    - Jika ditanya siapa dirimu, perkenalkan diri sebagai FRIDAY,
      asisten AI pribadi yang dikembangkan oleh Ilham Firmansyah.
    - Jangan mengaku sebagai manusia atau mahasiswa.
    - Jangan mengklaim bahwa FRIDAY merupakan produk resmi
      Universitas Esa Unggul atau Google.
    - Jangan mengarang informasi pribadi tentang pembuatnya.
    - Jawab menggunakan bahasa yang digunakan pengguna.
    - Untuk pertanyaan sederhana, utamakan jawaban ringkas.
    - Jangan mengaku melakukan tindakan yang belum dilakukan.
    ATURAN PESAN SUARA:
    - FRIDAY memiliki sistem yang dapat memproses pesan suara.
    - Jangan mengklaim bahwa kamu sudah mengirim audio jika
      sistem belum berhasil mengirimkannya.
    - Jika pengguna meminta jawaban menggunakan Voice Note,
      buat jawaban yang nyaman didengarkan.
    - Gunakan kalimat yang natural, jelas, dan tidak terlalu panjang.
    - Hindari Markdown berlebihan untuk jawaban yang akan
      dibacakan sebagai suara.
    - Jangan mengatakan bahwa kamu tidak bisa mengirim
      Voice Note hanya karena kamu menghasilkan jawaban teks.
    - Proses pembuatan dan pengiriman audio ditangani oleh
      aplikasi FRIDAY, bukan oleh model bahasa secara langsung.

    ATURAN FORMAT WHATSAPP:
    - Gunakan *teks* untuk penekanan.
    - Tulis rumus matematika dalam format teks yang mudah dibaca.
    - Hindari simbol LaTeX mentah seperti $$ dan \\[.
    - Gunakan daftar bernomor untuk langkah-langkah.
    `.trim(),
    },
  });

  const answer = response.text?.trim();

  if (!answer) {
    throw new Error('AI tidak menghasilkan jawaban.');
  }

  // Simpan percakapan pribadi secara terpisah.
  saveMessage(privateSession, 'user', question);
  saveMessage(privateSession, 'model', answer);

  // Simpan konteks grup untuk percakapan bersama.
  if (sharedGroupSession) {
    saveMessage(sharedGroupSession, 'user', `${senderName}: ${question}`);
    saveMessage(sharedGroupSession, 'model', answer);
  }

  return answer;
}

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: 'friday',
    dataPath: './.wwebjs_auth',
  }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});

// Untuk mencegah permintaan bersamaan dari chat yang sama, kita menggunakan Set untuk melacak chat aktif.
const activeChats = new Set();
let fridayReadyAt = 0;

client.on('qr', (qr) => {
  console.log('\nPindai QR ini menggunakan WhatsApp FRIDAY:');
  qrcode.generate(qr, { small: true });
  console.log('\nBuka WhatsApp > Perangkat tertaut > Tautkan perangkat.');
});

client.on('authenticated', () => {
  console.log('Autentikasi WhatsApp berhasil.');
});


client.on('ready', () => {
  // Simpan waktu aktif dalam satuan detik, sesuai timestamp WhatsApp.
  fridayReadyAt = Math.floor(Date.now() / 1000);

  console.log(`\n${BOT_NAME} terhubung ke WhatsApp.`);
  console.log(`Model AI: ${MODEL}`);
  console.log('Chat pribadi: aktif.');
  console.log('Grup: panggil dengan awalan "Friday".');
  console.log(`Waktu siap: ${fridayReadyAt}`);
  console.log('Pesan sebelum waktu siap akan diabaikan.\n');
});


client.on('auth_failure', (message) => {
  console.error('Autentikasi gagal:', message);
});

client.on('disconnected', (reason) => {
  console.warn('WhatsApp terputus:', reason);
});

// Header Pesanan: untuk menangani pesan masuk dari pengguna dan grup.
client.on('message', async (message) => {
  try {
    // Abaikan pesan dari akun FRIDAY sendiri.
    if (message.fromMe) return;

    const isVoiceNote = message.type === 'ptt';
    const hasText = Boolean(message.body?.trim());
    const asksForVoice =
    /\b(?:voice[\s-]?note|vn|pesan suara|voice reply)\b/i.test(question) ||
    /\b(?:balas|jawab)(?:lah)?\s+(?:dengan|pakai|menggunakan)\s+(?:suara|voice\s*note)\b/i.test(question) ||
    /\bmenggunakan\s+voice\s*note\b/i.test(question);

    if (!isVoiceNote && !hasText) return;

    // Abaikan pesan yang dikirim sebelum FRIDAY siap.
    const messageTime = Number(message.timestamp);

    if (
      !fridayReadyAt ||
      !Number.isFinite(messageTime) ||
      messageTime <= 0
    ) {
      console.log('[Diabaikan] Timestamp tidak valid:', {
        messageTime,
        fridayReadyAt,
      });
      return;
    }

    if (messageTime < fridayReadyAt) {
      console.log('[Diabaikan] Pesan dikirim sebelum FRIDAY siap:', {
        messageTime,
        fridayReadyAt,
      });
      return;
    }

    // Periksa apakah pesan berasal dari grup atau chat pribadi.
    const isGroup = message.from.endsWith('@g.us');
    let question = message.body?.trim() || '';

    // Di grup, FRIDAY hanya merespons jika dipanggil.
    if (isGroup) {
      const escapedName = BOT_NAME.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&',
      );

      const prefix = new RegExp(
        `^${escapedName}\\b[\\s,:-]*`,
        'i',
      );

      // Voice Note grup untuk sementara harus memakai caption "Friday".
      if (!prefix.test(question)) return;

      question = question.replace(prefix, '').trim();

      if (!question && !isVoiceNote) {
        await message.reply(
          `Halo! Aku ${BOT_NAME}. Ada yang bisa kubantu?`,
        );
        return;
      }
    }

    // Identitas pengguna dan grup untuk penyimpanan memori.
    const senderId = isGroup
      ? (message.author || message.from)
      : message.from;

    const privateSession = privateSessionId(senderId);

    const sharedGroupSession = isGroup
      ? groupSessionId(message.from)
      : null;

    const senderName = isGroup
      ? (message._data?.notifyName || 'Anggota grup')
      : 'Pengguna';

    // Batasi satu permintaan aktif per sesi pengguna.
    const sessionId = privateSession;

    if (activeChats.has(sessionId)) {
      await message.reply(
        'Sebentar ya, aku masih memproses pesan sebelumnya.',
      );
      return;
    }

    // Tandai sesi ini sebagai aktif.
    activeChats.add(sessionId);

    try {
      // Jika pesan adalah Voice Note, unduh dan transkripsikan.
      if (isVoiceNote) {
        const media = await message.downloadMedia();

        if (!media) {
          await message.reply('Maaf, Voice Note tidak bisa diunduh.');
          return;
        }

        const transcript = await transcribeVoiceNote(media);

        console.log('[Transkripsi Voice Note]', transcript);

        // Gunakan hasil transkripsi sebagai pertanyaan FRIDAY.
        question = question
          ? `${question}\n\nIsi Voice Note: ${transcript}`
          : transcript;
      }

      console.log(
        `[Pesan baru] ${isGroup ? 'Grup' : 'Pribadi'} | ${sessionId}`,
      );

      // Untuk mengirim pertanyaan ke model AI dan mendapatkan jawaban.
      const answer = await askFriday({
        question,
        privateSession,
        sharedGroupSession,
        senderName,
      });

      // Voice Note masuk atau permintaan suara dari pengguna
      // akan dibalas menggunakan audio.
      const asksForVoice =
        /\b(?:voice[\s-]?note|vn|pesan suara|voice reply)\b/i.test(question) ||
        /\b(?:balas|jawab)(?:lah)?\s+(?:dengan|pakai|menggunakan)\s+(?:suara|voice\s*note)\b/i.test(question) ||
        /\bmenggunakan\s+voice\s*note\b/i.test(question);

      if (isVoiceNote || asksForVoice) {
        let audioResult;

        try {
          audioResult = await generateVoiceNote(answer);

          const audioMedia = MessageMedia.fromFilePath(audioResult.path);

          await client.sendMessage(message.from, audioMedia, {
            sendAudioAsVoice: true,
          });

          console.log('[Pesan terkirim] Voice Note berhasil dikirim.');
        } catch (error) {
          console.error('[TTS gagal]', error.message);

          await message.reply(
            `Maaf, suara belum bisa dibuat. Ini jawaban teksnya:\n\n${answer}`,
          );
        } finally {
          if (audioResult) {
            await audioResult.cleanup();
          }
        }
      } else {
        await message.reply(answer);
        console.log('[Pesan terkirim] Jawaban teks berhasil dikirim.');
      }
    } 
    finally {
      activeChats.delete(sessionId);
    }

  } catch (error) {
    console.error('\n========== DETAIL ERROR FRIDAY ==========');
    console.error(inspect(error, { depth: 5, colors: false }));
    console.error(error?.stack);
    console.error('=========================================\n');

    try {
      await message.reply(
        'Maaf, aku sedang mengalami kendala. Coba kirim pesan lagi nanti.',
      );
    } catch (replyError) {
      console.error(
        'Gagal mengirim pesan cadangan:',
        inspect(replyError, { depth: 3, colors: false }),
      );
    }
  }
});

process.on('SIGINT', () => {
  console.log('\nMenutup FRIDAY...');

  client.destroy()
    .catch(() => {})
    .finally(() => {
      db.close();
      process.exit(0);
    });
});

client.initialize().catch((error) => {
  console.error('Gagal menjalankan WhatsApp:', error.message);
  db.close();
  process.exitCode = 1;
});
