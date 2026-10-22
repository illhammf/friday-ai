
import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { createInterface } from 'node:readline/promises';

const BOT_NAME = process.env.BOT_NAME || 'Friday';
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
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
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: question,
    config: {
      systemInstruction: `
Kamu adalah ${BOT_NAME}, asisten AI pribadi yang ramah,
cerdas, dan membantu. Jawab dalam bahasa yang digunakan
pengguna. Utamakan penjelasan yang jelas, akurat,
dan mudah dipahami. Jangan mengaku bisa melakukan
tindakan yang sebenarnya belum kamu lakukan.
      `.trim(),
    },
  });

  return response.text || 'Maaf, aku belum bisa menghasilkan jawaban.';
}

async function main() {
  console.log(`\n${BOT_NAME} AI — Mode Terminal`);
  console.log('Ketik pertanyaan untuk mulai mengobrol.');
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
        console.log(`\n${BOT_NAME}: ${await askFriday(question)}\n`);
      } catch (error) {
        console.error('\nGagal menghubungi AI:', error.message);
        console.error('Periksa koneksi internet, API key, model, dan kuota.\n');
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
