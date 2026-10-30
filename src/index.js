
import 'dotenv/config';
import { generateVoiceNote } from './audio/generate-voice-note.js';
import {
  getVoiceNoteFailureMessage,
  isVoiceNoteQuotaError,
} from './audio/voice-note-failure.js';
import { transcribeVoiceNote } from './audio/transcribe-voice-note.js';
import {
  saveMessage,
  loadHistory,
  privateSessionId,
  groupSessionId,
  closeDatabase,
} from './database/history.js';
import { detectConversationStyle, getStyleInstruction } from './ai/conversation-style.js';
import {
  generateImage,
  getImageGenerationFailureMessage,
  getImageGenerationQuotaDiagnostic,
  isImageGenerationQuotaError,
} from './ai/generate-image.js';
import { isImageGenerationRequest } from './ai/image-generation-request.js';
import { systemInstruction } from './config/system-instruction.js';
import { ai } from './ai/gemini.js';
import {
  downloadSocialVideo,
  getSocialVideoUrls,
} from './video/download-social-video.js';
import { isSocialVideoDownloadRequest } from './video/video-download-request.js';
import { downloadMediaWithRetry } from './whatsapp/download-media.js';
import {
  getRuntimeSummary,
  inspectRuntime,
} from './config/runtime-diagnostics.js';
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
      logEvent('ai', `Model ${model}`, `Percobaan ${attempt}/${maxAttempts}`);

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

      logEvent(
        'warn',
        'Layanan AI sedang sibuk',
        `Mencoba ulang dalam ${delayMs / 1000} detik`
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

// Fungsi log dengan warna dan label.
const logStyle = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  purple: '\x1b[35m',
};

function logEvent(type, title, detail = '') {
  const styles = {
    info: ['INFO', logStyle.cyan],
    ai: ['GEMINI', logStyle.purple],
    success: ['SUCCESS', logStyle.green],
    warn: ['RETRY', logStyle.yellow],
    error: ['ERROR', logStyle.red],
    voice: ['VOICE', logStyle.blue],
  };

  const [label, color] = styles[type] || styles.info;
  const timestamp = new Date().toLocaleTimeString('id-ID', {
    hour12: false,
  });

  console.log(
    `${logStyle.gray}${timestamp}${logStyle.reset} ` +
    `${color}${logStyle.bold}[${label}]${logStyle.reset} ` +
    `${title}` +
    (detail ? ` ${logStyle.gray}│ ${detail}${logStyle.reset}` : '')
  );
}

function logDivider() {
  console.log(
    `${logStyle.gray}────────────────────────────────────────────${logStyle.reset}`
  );
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

    // Catat waktu respons dan penggunaan token.
    const elapsedSeconds = (
      (Date.now() - aiStart) / 1000
    ).toFixed(2);

    const usage = response.usageMetadata || {};

    logEvent(
      'success',
      'Respons Gemini diterima',
      `${elapsedSeconds}s`
    );

    logEvent(
      'ai',
      'Penggunaan token',
      `Input: ${usage.promptTokenCount ?? '?'} | ` +
      `Output: ${usage.candidatesTokenCount ?? '?'} | ` +
      `Total: ${usage.totalTokenCount ?? '?'}`
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

async function logRuntimeDiagnostics() {
  const results = await inspectRuntime();
  const summary = getRuntimeSummary(results);

  for (const result of results) {
    if (result.ok) {
      logEvent('success', `${result.label} tersedia`, result.detail);
    } else {
      const eventType = result.required ? 'error' : 'warn';
      logEvent(eventType, `${result.label} belum siap`, result.detail);
      console.warn(`[Runtime] ${result.guidance}`);
    }
  }

  if (summary.requiredFailed.length > 0) {
    logEvent(
      'warn',
      'Friday berjalan dengan runtime yang tidak didukung',
      'Perbaiki kebutuhan wajib yang ditandai ERROR.',
    );
  }
}


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

    const socialVideoUrls = getSocialVideoUrls(question);
    const asksToDownloadVideo =
      socialVideoUrls.length > 0 &&
      isSocialVideoDownloadRequest(question);

    if (asksToDownloadVideo && socialVideoUrls.length > 1) {
      await message.reply(
        'Kirim satu tautan TikTok atau Instagram dulu ya, supaya aku bisa mengunduh videonya.'
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
      if (asksToDownloadVideo && socialVideoUrls.length === 1) {
        let videoResult = null;

        try {
          videoResult = await downloadSocialVideo(socialVideoUrls[0]);
          const videoMedia = MessageMedia.fromFilePath(videoResult.path);

          await client.sendMessage(message.from, videoMedia, {
            caption: 'Ini video dari tautan yang kamu kirim.',
          });

          logEvent('success', 'Video berhasil diunduh dan dikirim', 'WhatsApp');
        } catch (error) {
          const errorMessage = String(error?.message || error);
          const errorCode = error?.code;

          console.error(
            '[Unduhan video gagal]',
            inspect(error, { depth: 4, colors: false }),
          );

          let reply;

          if (errorCode === 'YT_DLP_NOT_INSTALLED') {
            reply =
              'Fitur unduh video belum siap di server Friday. Admin perlu memasang yt-dlp dan ffmpeg terlebih dahulu.';
          } else if (errorCode === 'FFMPEG_NOT_INSTALLED') {
            reply =
              'Fitur unduh video belum siap di server Friday. Admin perlu memasang ffmpeg terlebih dahulu.';
          } else if (/64 MB|too large|maximum file size/i.test(errorMessage)) {
            reply =
              'Video terlalu besar untuk dikirim lewat WhatsApp. Coba tautan video yang lebih pendek atau berukuran lebih kecil ya.';
          } else if (error?.killed || error?.signal === 'SIGTERM') {
            reply =
              'Proses unduh video terlalu lama dan dihentikan. Coba lagi nanti atau gunakan tautan lain ya.';
          } else {
            reply =
              'Video belum berhasil diunduh. Pastikan tautannya publik dan videonya bisa diakses, lalu coba lagi ya.';
          }

          await message.reply(reply);
          logEvent('error', 'Unduhan video gagal', errorCode || 'periksa log terminal');
        } finally {
          if (videoResult?.cleanup) {
            await videoResult.cleanup();
          }
        }

        return;
      }

      // Unduh dan transkripsikan Voice Note masuk.
      if (isVoiceNote) {
        const media = await downloadMediaWithRetry(message);

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
        let media;

        try {
          media = await downloadMediaWithRetry(message);
        } catch (error) {
          const cause = error?.cause;
          const detail = cause?.message || error?.message || String(error);
          const mediaDetails = [
            `type=${message.type}`,
            `hasMedia=${message.hasMedia}`,
            `mimetype=${message._data?.mimetype || 'unknown'}`,
            `size=${message._data?.size ?? 'unknown'}`,
            `directPath=${Boolean(message._data?.directPath)}`,
            `mediaKey=${Boolean(message._data?.mediaKey)}`,
            `encFilehash=${Boolean(message._data?.encFilehash)}`,
            `mediaStage=${message._data?.mediaData?.mediaStage || 'unknown'}`,
          ].join(' ');

          console.error('[Detail unduhan media]', mediaDetails);
          console.error(
            '[Error unduhan media]',
            inspect(cause?.mediaDiagnostic || error, {
              depth: 8,
              colors: false,
            }),
          );
          logEvent(
            'error',
            'WhatsApp gagal mengunduh gambar',
            detail,
          );
          await message.reply(
            'Aku menerima fotonya, tetapi WhatsApp gagal mengunduh file gambar. Coba teruskan fotonya ke chat Friday. Jika masih gagal, admin perlu memeriksa detail error WhatsApp Web di log.'
          );
          return;
        }

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

      if (!image && isImageGenerationRequest(question)) {
        logEvent(
          'ai',
          'Permintaan gambar dikenali',
          `Model: ${process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image'}`,
        );
        let generatedImage;

        try {
          generatedImage = await generateImage(question);
        } catch (error) {
          if (isImageGenerationQuotaError(error)) {
            const diagnostic = getImageGenerationQuotaDiagnostic(error);
            const terminalDetails = [
              diagnostic.details,
              diagnostic.retryText,
              diagnostic.freeTierLimitZero
                ? 'Free Tier limit model=0; menunggu saja mungkin tidak cukup.'
                : '',
              'Tindakan: cek project API key, kuota model, dan billing/plan di Google AI Studio.',
            ].filter(Boolean).join(' ');

            logEvent(
              'error',
              'Kuota generate gambar tidak tersedia',
              `${diagnostic.model} │ ${terminalDetails}`,
            );
          } else {
            console.error(
              '[Pembuatan gambar gagal]',
              inspect(error, { depth: 5, colors: false }),
            );
          }

          await message.reply(getImageGenerationFailureMessage(error));
          return;
        }

        const extension = generatedImage.mimeType === 'image/jpeg'
          ? 'jpg'
          : generatedImage.mimeType === 'image/webp'
            ? 'webp'
            : 'png';
        const imageMedia = new MessageMedia(
          generatedImage.mimeType,
          generatedImage.data,
          `friday-generated.${extension}`,
        );
        const caption = (
          generatedImage.text || 'Ini gambar yang kamu minta.'
        ).slice(0, 1000);

        await client.sendMessage(message.from, imageMedia, { caption });

        const activeSession = sharedGroupSession || privateSession;
        const userMessage = isGroup
          ? `${senderName}: ${question}`
          : question;

        saveMessage(activeSession, 'user', userMessage);
        saveMessage(
          activeSession,
          'model',
          `Gambar dibuat untuk permintaan: ${question}`,
        );
        logEvent('success', 'Gambar berhasil dibuat dan dikirim', 'WhatsApp');
        return;
      }

      logDivider();

      logEvent(
        'info',
        `Pesan masuk · ${isGroup ? 'Grup' : 'Pribadi'}`,
        `Sesi: ${sessionId}`
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

      // Deteksi apakah pengguna meminta jawaban berupa Voice Note.
       const asksForVoice =
          /\b(?:vn|voice[\s-]?note|voice message|pesan suara)\b/i.test(question) ||
          /\b(?:balas|jawab|bales)(?:lah)?\b.{0,100}\b(?:pakai|pake|dengan|menggunakan|lewat|melalui)\s+(?:vn|suara|voice[\s-]?note|audio)\b/i.test(question) ||
          /\b(?:kirim|buat|bikin|ubah|jadikan)\b.{0,60}\b(?:vn|voice[\s-]?note|pesan suara)\b/i.test(question) ||
          /\b(?:ngomong|berbicara|ucapkan|bacakan)\b/i.test(question);

        // Voice Note masuk atau permintaan VN akan diarahkan ke pengiriman audio.
        if (isVoiceNote || asksForVoice) {
          let audioResult = null;
          let audioSent = false;

          try {
            console.log('[VN] Menyiapkan jawaban audio...');

            audioResult = await generateVoiceNote(answer);

            if (!audioResult?.path) {
              throw new Error(
                'Proses pembuat audio tidak menghasilkan file audio.'
              );
            }

            const audioMedia = MessageMedia.fromFilePath(
              audioResult.path
            );

            await client.sendMessage(message.from, audioMedia, {
              sendAudioAsVoice: true,
            });

            audioSent = true;

            logEvent('voice', 'Voice Note berhasil dikirim', 'WhatsApp');

          } catch (error) {
            console.error(
              '[TTS/pengiriman audio gagal]',
              inspect(error, { depth: 6, colors: false }),
            );

            if (isVoiceNoteQuotaError(error)) {
              logEvent(
                'warn',
                'Kuota Voice Note tercapai',
                `Status: ${error?.status || error?.code || 'unknown'}; detail lengkap ada di log terminal.`,
              );
            }

            // Beri tahu pengguna secara natural dan tetap sediakan jawaban teks.
            const fallbackText = getVoiceNoteFailureMessage(error, answer);

            try {
              await message.reply(fallbackText);

              console.log(
                '[Fallback] Penjelasan dan jawaban teks berhasil dikirim.'
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

          if (audioSent) {
            console.log('[VN] Proses pengiriman selesai.');
          }
        } else {
          // Permintaan biasa tetap mendapatkan jawaban teks.
          await message.reply(answer);

          logEvent('success', 'Jawaban teks berhasil dikirim', 'WhatsApp');
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

logRuntimeDiagnostics()
  .then(() => client.initialize())
  .catch((error) => {
    console.error('Gagal menjalankan WhatsApp:', error.message);
    closeDatabase();
    process.exitCode = 1;
  });
