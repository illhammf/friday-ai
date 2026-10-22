
import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import whatsapp from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { inspect } from 'node:util';

const { Client, LocalAuth } = whatsapp;

const BOT_NAME = process.env.BOT_NAME || 'Friday';
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error('API key belum dikonfigurasi. Periksa file .env.');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: API_KEY });

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
Kamu adalah ${BOT_NAME}, asisten AI pribadi yang ramah,
cerdas, dan membantu.

Pengirim pesan saat ini: ${senderName}.
Jawab menggunakan bahasa pengguna dan pahami konteks percakapan.

ATURAN FORMAT WHATSAPP:
- Gunakan *teks* untuk penekanan, bukan **teks**.
- Gunakan _teks_ untuk penekanan ringan.
- Tulis rumus matematika dalam teks biasa yang mudah dibaca.
- Jangan tampilkan pembatas LaTeX seperti $$, \\[, atau \\].
- Untuk kode, gunakan blok kode dengan tiga backtick jika diperlukan.
- Gunakan daftar bernomor untuk langkah-langkah.
- Jangan mengarang referensi, fakta, atau sumber.
- Jangan mengaku melakukan tindakan yang belum dilakukan.
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

const activeChats = new Set();

client.on('qr', (qr) => {
  console.log('\nPindai QR ini menggunakan WhatsApp FRIDAY:');
  qrcode.generate(qr, { small: true });
  console.log('\nBuka WhatsApp > Perangkat tertaut > Tautkan perangkat.');
});

client.on('authenticated', () => {
  console.log('Autentikasi WhatsApp berhasil.');
});

client.on('ready', () => {
  console.log(`\n${BOT_NAME} terhubung ke WhatsApp.`);
  console.log(`Model AI: ${MODEL}`);
  console.log('Chat pribadi: aktif.');
  console.log('Grup: panggil dengan awalan "Friday".\n');
});

client.on('auth_failure', (message) => {
  console.error('Autentikasi gagal:', message);
});

client.on('disconnected', (reason) => {
  console.warn('WhatsApp terputus:', reason);
});

client.on('message', async (message) => {
  try {
    // Jangan membalas pesan dari akun bot sendiri.
    if (message.fromMe || !message.body?.trim()) return;

    // Grup hanya merespons jika pesan diawali nama bot.
    if (isGroup) {
      const prefix = new RegExp(
        `^${BOT_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[\\s,:-]*`,
        'i',
      );

      if (!prefix.test(question)) return;

      question = question.replace(prefix, '').trim();

      if (!question) {
        await message.reply(
          `Halo! Aku ${BOT_NAME}. Ada yang bisa kubantu?`,
        );
        return;
      }
    }

    // Setiap chat memiliki konteks memori terpisah.
    const isGroup = message.from.endsWith('@g.us');

    const senderId = isGroup
      ? message.author
      : message.from;

    const privateSession = privateSessionId(senderId);
    const sharedGroupSession = isGroup
      ? groupSessionId(message.from)
      : null;

    const senderName = isGroup
      ? (message._data?.notifyName || 'Anggota grup')
      : 'Pengguna';

    // Hindari permintaan bersamaan dari chat yang sama.
    if (activeChats.has(sessionId)) {
      await message.reply(
        'Sebentar ya, aku masih memproses pesan sebelumnya.',
      );
      return;
    }

    activeChats.add(sessionId);

    try {
      console.log(
        `[Pesan masuk] ${isGroup ? 'Grup' : 'Pribadi'} | ${sessionId}`,
      );

      const answer = await askFriday({
        question,
        privateSession,
        sharedGroupSession, 
        senderName,
      });

      await message.reply(answer);

      console.log('[Pesan terkirim] Jawaban FRIDAY berhasil dikirim.\n');
    } finally {
      activeChats.delete(sessionId);
    }

    } catch (error) {
    console.error('\n========== DETAIL ERROR FRIDAY ==========');
    console.error(inspect(error, {
        depth: 5,
        colors: false,
    }));
    console.error('Stack:', error?.stack);
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
