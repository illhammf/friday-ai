
import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import whatsapp from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';

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

function loadHistory(sessionId) {
  return getHistory.all(sessionId)
    .reverse()
    .map(({ role, content }) => ({
      role,
      parts: [{ text: content }],
    }));
}

async function askFriday(sessionId, question) {
  const contents = [
    ...loadHistory(sessionId),
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
cerdas, dan membantu. Jawab menggunakan bahasa pengguna.
Gunakan riwayat percakapan untuk memahami konteks.
Untuk pertanyaan sederhana, jawab secara ringkas.
Jangan mengaku melakukan tindakan yang belum kamu lakukan.
      `.trim(),
    },
  });

  const answer = response.text?.trim();

  if (!answer) {
    throw new Error('AI tidak menghasilkan jawaban.');
  }

  saveMessage(sessionId, 'user', question);
  saveMessage(sessionId, 'model', answer);

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

    const chat = await message.getChat();
    const isGroup = chat.isGroup;
    let question = message.body.trim();

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
    const sessionId = `whatsapp:${message.from}`;

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

      const answer = await askFriday(sessionId, question);

      await message.reply(answer);

      console.log('[Pesan terkirim] Jawaban FRIDAY berhasil dikirim.\n');
    } finally {
      activeChats.delete(sessionId);
    }
  } catch (error) {
    console.error('Gagal memproses pesan:', error.message);

    try {
      await message.reply(
        'Maaf, aku sedang mengalami kendala. Coba kirim pesan lagi nanti.',
      );
    } catch {
      console.error('Balasan error juga gagal dikirim.');
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
