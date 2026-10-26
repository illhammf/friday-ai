
import 'dotenv/config';
import { generateVoiceNote } from './audio/generate-voice-note.js';
import { transcribeVoiceNote } from './audio/transcribe-voice-note.js';
import {
  saveMessage,
  loadHistory,
  privateSessionId,
  groupSessionId,
  closeDatabase,
} from './database/history.js';
import { detectConversationStyle, getStyleInstruction } from './ai/conversation-style.js';
import { systemInstruction } from './config/system-instruction.js';
import { ai } from './ai/gemini.js';
import whatsapp from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { inspect } from 'node:util';

const { Client, LocalAuth, MessageMedia } = whatsapp;


const BOT_NAME = process.env.BOT_NAME || 'Friday';
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || '';

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function isTemporaryGeminiError(error) {
  const status = Number(error?.status || error?.code);
  const message = String(error?.message || error);

  return (
    [429, 500, 502, 503, 504].includes(status) ||
    /\b429\b|\b503\b|UNAVAILABLE|high demand|rate.?limit|quota exceeded|overloaded|temporarily unavailable/i.test(message)
  );
}

async function generateWithRetry(model, contents, config) {
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(
        `[Gemini] Model ${model}, percobaan ${attempt}/${maxAttempts}`
      );

      return await ai.models.generateContent({
        model,
        contents,
        config,
      });
    } catch (error) {
      if (!isTemporaryGeminiError(error) || attempt === maxAttempts) {
        throw error;
      }

      const delayMs = 1500 * attempt;

      console.warn(
        `[Gemini] Gangguan sementara. Mencoba lagi dalam ${delayMs / 1000} detik.`
      );

      await sleep(delayMs);
    }
  }

  throw new Error('Semua percobaan Gemini gagal.');
}

// Warna terminal ANSI, tanpa dependensi tambahan.
const terminal = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  brightCyan: '\x1b[96m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
};

function printBanner() {
  const c = terminal;

  console.clear();

  console.log(`${c.brightCyan}${c.bold}
██╗ ██╗      ██╗  ██╗  █████╗  ███╗   ███╗
██║ ██║      ██║  ██║ ██╔══██╗ ████╗ ████║
██║ ██║      ███████║ ███████║ ██╔████╔██║
██║ ██║      ██╔══██║ ██╔══██║ ██║╚██╔╝██║
██║ ███████╗ ██║  ██║ ██║  ██║ ██║ ╚═╝ ██║
╚═╝ ╚══════╝ ╚═╝  ╚═╝ ╚═╝  ╚═╝ ╚═╝     ╚═╝

███████╗ ██╗ ██████╗  ███╗   ███╗  █████╗  ███╗   ██╗ ███████╗ ██╗   ██╗  █████╗  ██╗  ██╗
██╔════╝ ██║ ██╔══██╗ ████╗ ████║ ██╔══██╗ ████╗  ██║ ██╔════╝ ╚██╗ ██╔╝ ██╔══██╗ ██║  ██║
█████╗   ██║ ██████╔╝ ██╔████╔██║ ███████║ ██╔██╗ ██║ ███████╗  ╚████╔╝  ███████║ ███████║
██╔══╝   ██║ ██╔══██╗ ██║╚██╔╝██║ ██╔══██║ ██║╚██╗██║ ╚════██║   ╚██╔╝   ██╔══██║ ██╔══██║
██║      ██║ ██║  ██║ ██║ ╚═╝ ██║ ██║  ██║ ██║ ╚████║ ███████║    ██║    ██║  ██║ ██║  ██║
╚═╝      ╚═╝ ╚═╝  ╚═╝ ╚═╝     ╚═╝ ╚═╝  ╚═╝ ╚═╝  ╚═══╝ ╚══════╝    ╚═╝    ╚═╝  ╚═╝ ╚═╝  ╚═╝
${c.reset}`);

  console.log(`${c.cyan}  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  console.log(`${c.bold}             PERSONAL AI ASSISTANT${c.reset}`);
  console.log(`${c.gray}                 SYSTEM INITIALIZATION${c.reset}`);
  console.log(`${c.cyan}  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}\n`);

  console.log(`  ${c.green}●${c.reset} ${c.bold}FRIDAY${c.reset}       Personal AI Assistant`);
  console.log(`  ${c.green}●${c.reset} ${c.bold}AI ENGINE${c.reset}    ${MODEL}`);
  console.log(`  ${c.yellow}●${c.reset} ${c.bold}WHATSAPP${c.reset}     Menunggu koneksi...`);
  console.log(`  ${c.green}●${c.reset} ${c.bold}PRIVATE CHAT${c.reset} Aktif`);
  console.log(`  ${c.green}●${c.reset} ${c.bold}GROUP MODE${c.reset}   Trigger: Friday`);

  console.log(`\n${c.cyan}  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  console.log(`${c.brightCyan}  Initializing systems. Please wait...${c.reset}\n`);
}


  // Fungsi utama untuk mengajukan pertanyaan ke FRIDAY dan mendapatkan jawaban.
  async function askFriday({
    question,
    privateSession,
    sharedGroupSession = null,
    senderName = 'Pengguna',
    image,
  }) {
    // Tentukan jenis percakapan.
    const isGroup = Boolean(sharedGroupSession);

    // Ambil riwayat hanya dari sesi yang sedang digunakan.
    // Grup tidak boleh membaca riwayat percakapan pribadi.
    const activeSession = isGroup
      ? sharedGroupSession
      : privateSession;

    const history = loadHistory(activeSession, 10);

    // Identitas pengirim hanya ditambahkan pada pesan grup.
    const userMessage = isGroup
      ? `${senderName}: ${question}`
      : question;

    // Tambahkan pertanyaan pengguna dan lampiran gambar (jika ada) ke dalam konten percakapan.
    const userParts = [
      { text: userMessage || 'Tolong jelaskan gambar ini.' },
    ];
    // Jika ada lampiran gambar, tambahkan ke konten percakapan.
    if (image) {
      userParts.push({
        inlineData: {
          mimeType: image.mimetype,
          data: image.data,
        },
      });
    }

    const contents = [
      ...history,
      {
        role: 'user',
        parts: userParts,
      },
    ];

    const conversationStyle = detectConversationStyle(question);
    const dynamicStyle = getStyleInstruction(conversationStyle);

    const aiStart = Date.now();


    const config = {
      systemInstruction: [
        systemInstruction,
        dynamicStyle,
      ].filter(Boolean).join('\n\n'),
    };

    let response;

    try {
      response = await generateWithRetry(MODEL, contents, config);
    } catch (primaryError) {
      if (
        !FALLBACK_MODEL ||
        FALLBACK_MODEL === MODEL ||
        !isTemporaryGeminiError(primaryError)
      ) {
        throw primaryError;
      }

      console.warn(
        `[Gemini] Model utama gagal sementara. Beralih ke ${FALLBACK_MODEL}.`
      );

      response = await generateWithRetry(
        FALLBACK_MODEL,
        contents,
        config
      );
    }

    console.log('[Penggunaan token]', response.usageMetadata);
    
    console.log(
      `[Waktu Gemini] ${((Date.now() - aiStart) / 1000).toFixed(2)} detik`,
    );

    const answer = response.text?.trim();

    if (!answer) {
      throw new Error('AI tidak menghasilkan jawaban.');
    }

    // Simpan hanya ke sesi yang benar-benar digunakan.
    saveMessage(activeSession, 'user', userMessage);
    saveMessage(activeSession, 'model', answer);

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
  fridayReadyAt = Math.floor(Date.now() / 1000);

  const c = terminal;

  console.log(`\n${c.cyan}  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  console.log(`  ${c.green}●${c.reset} ${c.bold}CONNECTION ESTABLISHED${c.reset}`);
  console.log(`  ${c.green}●${c.reset} WhatsApp       ${c.green}CONNECTED${c.reset}`);
  console.log(`  ${c.green}●${c.reset} AI Engine      ${MODEL}`);
  console.log(`  ${c.green}●${c.reset} Private Chat   ACTIVE`);
  console.log(`  ${c.green}●${c.reset} Group Mode     ACTIVE`);
  console.log(`  ${c.gray}  Ready timestamp: ${fridayReadyAt}${c.reset}`);
  console.log(`  ${c.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  console.log(`\n  ${c.brightCyan}${c.bold}${BOT_NAME} is online.${c.reset}`);
  console.log(`  ${c.gray}Menunggu pesan masuk...${c.reset}\n`);
});


client.on('auth_failure', (message) => {
  console.error('Autentikasi gagal:', message);
});

client.on('disconnected', (reason) => {
  console.warn('WhatsApp terputus:', reason);
});


client.on('message', async (message) => {
  
    if (message.fromMe) return;

    // Kompatibilitas ID pesan WhatsApp Web
    const messageId = message.id;

    if (messageId && messageId._serialized == null) {
      const serializedId =
        messageId.$1 ??
        (
          messageId.fromMe != null &&
          messageId.remote &&
          messageId.id
            ? `${messageId.fromMe}_${messageId.remote}_${messageId.id}`
            : null
        );

      if (serializedId) {
        messageId._serialized = serializedId;
      }
    }
  try {
    // Abaikan pesan dari akun FRIDAY sendiri.
    if (message.fromMe) return;

    // Identifikasi jenis pesan.
    const isVoiceNote = message.type === 'ptt';
    const isImage = message.type === 'image';
    const hasText = Boolean(message.body?.trim());

    // Abaikan pesan yang tidak didukung.
    if (!isVoiceNote && !isImage && !hasText) return;

    // Definisikan pertanyaan sebelum digunakan.
    let question = message.body?.trim() || '';

    // Abaikan pesan sebelum FRIDAY siap.
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
      console.log(
        '[Diabaikan] Pesan dikirim sebelum FRIDAY siap.'
      );
      return;
    }

    // Identifikasi chat pribadi atau grup.
    const isGroup = message.from.endsWith('@g.us');

    // Di grup, pesan harus diawali nama FRIDAY.
    if (isGroup) {
      const escapedName = BOT_NAME.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&'
      );

      const prefix = new RegExp(
        `^${escapedName}\\b[\\s,:-]*`,
        'i'
      );

      if (!prefix.test(question)) {
        console.log(
          '[Diabaikan] FRIDAY tidak dipanggil di grup.'
        );
        return;
      }

      question = question.replace(prefix, '').trim();

      // Sapaan teks tanpa pertanyaan.
      if (!question && !isVoiceNote && !isImage) {
        await message.reply(
          `Halo! Aku ${BOT_NAME}. Ada yang bisa kubantu?`
        );
        return;
      }
    } else if (!question && !isVoiceNote && !isImage) {
      // Sapaan kosong di chat pribadi.
      await message.reply(
        `Halo! Aku ${BOT_NAME}. Ada yang bisa kubantu?`
      );
      return;
    }

    // Identitas dan sesi percakapan.
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

    // Cegah permintaan bersamaan dari sesi pengguna yang sama.
    const sessionId = privateSession;

    if (activeChats.has(sessionId)) {
      await message.reply(
        'Sebentar ya, aku masih memproses pesan sebelumnya.'
      );
      return;
    }

    activeChats.add(sessionId);

    try {
      // Unduh dan transkripsikan Voice Note masuk.
      if (isVoiceNote) {
        const media = await message.downloadMedia();

        if (!media) {
          await message.reply(
            'Maaf, Voice Note tidak bisa diunduh. Coba kirim ulang ya.'
          );
          return;
        }

        const transcript = (
          await transcribeVoiceNote(media)
        )?.trim();

        if (!transcript) {
          await message.reply(
            'Maaf, isi Voice Note belum bisa kupahami. Coba kirim ulang atau tuliskan pesannya ya.'
          );
          return;
        }

        console.log('[Transkripsi Voice Note]', transcript);

        question = question
          ? `${question}\n\nIsi Voice Note: ${transcript}`
          : transcript;
      }

      // Unduh gambar untuk analisis Vision AI.
      let image = null;

      if (isImage) {
        console.log('[DEBUG] ID pesan:', JSON.stringify(message.id));
        console.log('[DEBUG] _serialized:', message.id?._serialized);
        console.log('[DEBUG] $1:', message.id?.$1);
        const media = await message.downloadMedia();

        if (!media) {
          await message.reply('Maaf, gambar belum bisa dibaca. Coba kirim ulang ya.');
          return;
        }

        if (!media.mimetype?.startsWith('image/')) {
          await message.reply('File yang diterima bukan gambar yang didukung.');
          return;
        }

        image = {
          mimetype: media.mimetype,
          data: media.data,
        };

        if (!question) {
          question = 'Jelaskan gambar ini secara rinci.';
        }
      }

      console.log(
        `[Pesan baru] ${isGroup ? 'Grup' : 'Pribadi'} | ${sessionId}`
      );

      // Kirim pertanyaan beserta gambar ke model AI.
      const answer = await askFriday({
        question,
        privateSession,
        sharedGroupSession,
        senderName,
        image,
      });

      // Deteksi permintaan balasan suara.
      const asksForVoice =
        /\b(?:voice[\s-]?note|vn|pesan suara|voice reply|voice message)\b/i.test(question) ||
        /\b(?:balas|jawab|bales)(?:lah)?\s+(?:dengan|pakai|menggunakan)\s+(?:suara|voice\s*note|vn)\b/i.test(question) ||
        /\b(?:gunakan|pake|pakai|menggunakan)\s+(?:vn|voice\s*note|pesan suara)\b/i.test(question) ||
        /\b(?:kirim|buat|bikin)\s+(?:aku\s+)?(?:vn|voice\s*note|pesan suara)\b/i.test(question);

      // VN masuk selalu dibalas dengan VN jika memungkinkan.
      if (isVoiceNote || asksForVoice) {
        let audioResult = null;

        try {
          audioResult = await generateVoiceNote(answer);

          const audioMedia = MessageMedia.fromFilePath(
            audioResult.path
          );

          await client.sendMessage(message.from, audioMedia, {
            sendAudioAsVoice: true,
          });

          console.log(
            '[Pesan terkirim] Voice Note berhasil dikirim.'
          );
        } catch (error) {
          const errorMessage = String(
            error?.message || error
          );

          const isRateLimit =
            error?.status === 429 ||
            /\b429\b|rate.?limit|quota exceeded/i.test(
              errorMessage
            );

          console.error(
            '[TTS/pengiriman audio gagal]',
            errorMessage
          );

          if (isRateLimit) {
            console.warn(
              '[TTS] Batas penggunaan tercapai. Beralih ke teks.'
            );
          }

          try {
            await message.reply(
              `Maaf, Voice Note belum bisa dikirim saat ini. Ini jawaban teksnya:\n\n${answer}`
            );

            console.log(
              '[Fallback] Jawaban teks berhasil dikirim.'
            );
          } catch (replyError) {
            console.error(
              '[Fallback teks gagal]',
              replyError?.message || replyError
            );
          }
        } finally {
          if (audioResult?.cleanup) {
            try {
              await audioResult.cleanup();
            } catch (cleanupError) {
              console.error(
                '[Cleanup audio gagal]',
                cleanupError?.message || cleanupError
              );
            }
          }
        }
      } else {
        await message.reply(answer);

        console.log(
          '[Pesan terkirim] Jawaban teks berhasil dikirim.'
        );
      }
    } finally {
      // Pastikan sesi tidak terkunci jika terjadi error.
      activeChats.delete(sessionId);
    }
      
    } catch (error) {
        const errorMessage = String(error?.message || error);
        const errorStatus = Number(error?.status || error?.code);

        const isUnavailable =
          errorStatus === 503 ||
          /\b503\b|UNAVAILABLE|high demand|overloaded/i.test(errorMessage);

        const isRateLimit =
          errorStatus === 429 ||
          /\b429\b|rate.?limit|quota exceeded/i.test(errorMessage);

        console.error(
          '\n========== DETAIL ERROR FRIDAY =========='
        );
        console.error(
          inspect(error, {
            depth: 5,
            colors: false,
          })
        );
        console.error(
          '=========================================\n'
        );

        let fallbackMessage;

        if (isUnavailable) {
          fallbackMessage =
            'Maaf, layanan AI Friday sedang ramai. Coba kirim pesan lagi dalam beberapa saat ya.';
        } else if (isRateLimit) {
          fallbackMessage =
            'Maaf, batas penggunaan AI sedang tercapai. Coba lagi beberapa saat nanti ya.';
        } else {
          fallbackMessage =
            'Maaf, Friday sedang mengalami kendala. Coba kirim pesan lagi nanti ya.';
        }

        try {
          await message.reply(fallbackMessage);
          console.log('[Fallback] Pesan kendala berhasil dikirim.');
        } catch (replyError) {
          console.error(
            '[Fallback gagal]',
            replyError?.message || replyError
          );
        }
  }
});

process.on('SIGINT', () => {
  console.log('\nMenutup FRIDAY...');

  client.destroy()
    .catch(() => {})
    .finally(() => {
      closeDatabase();
      process.exit(0);
    });
});

printBanner();

client.initialize().catch((error) => {
  console.error('Gagal menjalankan WhatsApp:', error.message);
  closeDatabase();
  process.exitCode = 1;
});
