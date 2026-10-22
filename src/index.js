
import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { createInterface } from 'node:readline/promises';
import { performance } from 'node:perf_hooks';

const BOT_NAME = process.env.BOT_NAME || 'Friday';
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY || API_KEY === 'MASUKKAN_API_KEY_KAMU_DI_SINI') {
  console.error('API key belum dikonfigurasi. Periksa file .env.');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: API_KEY });

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

async function askFriday(question) {
  const startedAt = performance.now();
  let firstTokenAt = null;

  const stream = await ai.models.generateContentStream({
    model: MODEL,
    contents: question,
    config: {
      systemInstruction: `
Kamu adalah ${BOT_NAME}, asisten AI pribadi yang ramah,
cerdas, dan membantu. Jawab dalam bahasa yang digunakan
pengguna. Utamakan jawaban yang jelas dan mudah dipahami.
Untuk pertanyaan sederhana, jawab secara ringkas.
Jangan mengaku melakukan tindakan yang belum kamu lakukan.
      `.trim(),
    },
  });

  process.stdout.write(`\n${BOT_NAME}: `);

  for await (const chunk of stream) {
    const text = chunk.text || '';

    if (text) {
      if (firstTokenAt === null) {
        firstTokenAt = performance.now();
      }

      process.stdout.write(text);
    }
  }

  const finishedAt = performance.now();

  console.log('\n');
  console.log(
    `[Waktu] Respons pertama: ${
      firstTokenAt === null
        ? 'tidak tersedia'
        : ((firstTokenAt - startedAt) / 1000).toFixed(2) + ' detik'
    }`,
  );
  console.log(
    `[Waktu] Total permintaan: ${((finishedAt - startedAt) / 1000).toFixed(2)} detik\n`,
  );
}

async function main() {
  console.log(`\n${BOT_NAME} AI — Mode Terminal`);
  console.log(`Model: ${MODEL}`);
  console.log('Ketik "exit" untuk keluar.\n');

  try {
    while (true) {
      const question = await rl.question('Kamu: ');

      if (question.trim().toLowerCase() === 'exit') {
        break;
      }

      if (!question.trim()) {
        continue;
      }

      try {
        await askFriday(question);
      } catch (error) {
        console.error('\nGagal menghubungi AI:', error.message);
        console.error('Periksa koneksi, API key, model, dan kuota.\n');
      }
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error('FRIDAY gagal dijalankan:', error.message);
  process.exitCode = 1;
});
