
import 'dotenv/config';
import { generateVoiceNote } from './audio/generate-voice-note.js';
import {
  getVoiceNoteFailureMessage,
  isVoiceNoteQuotaError,
} from './audio/voice-note-failure.js';
import { transcribeVoiceNote } from './audio/transcribe-voice-note.js';
import {
  privateSessionId,
  groupSessionId,
  initializeDefaultDatabase,
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
import { getVideoDownloadFailureMessage } from './video/video-download-failure.js';
import { formatWhatsAppMessage } from './whatsapp/format-message.js';
import { downloadMediaWithRetry } from './whatsapp/download-media.js';
import {
  handleMemoryCommand,
  getMemoryInstruction,
  parseMemoryCommand,
} from './ai/user-memory.js';
import {
  createImageSticker,
  getImageStickerFailureMessage,
  isImageStickerRequest,
  parseImageStickerOptions,
  readImageStickerData,
} from './whatsapp/image-sticker.js';
import {
  createMessageQueue,
  createMessageDeduplicator,
  getMessageDeduplicationKey,
  isQueueableMessage,
} from './whatsapp/message-queue.js';
import {
  getRuntimeSummary,
  inspectRuntime,
} from './config/runtime-diagnostics.js';
import { getAiFailureMessage } from './ai/ai-failure-message.js';
import { createMessageService } from './application/message-service.js';
import { createApplication } from './application/application-lifecycle.js';
import {
  generateWithModelFallback,
  getModelChain,
} from './ai/model-fallback.js';
import whatsapp from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { inspect } from 'node:util';

const { Client, LocalAuth, MessageMedia } = whatsapp;


const BOT_NAME = process.env.BOT_NAME || 'Friday';
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const MODELS = getModelChain(
  MODEL,
  process.env.GEMINI_FALLBACK_MODELS,
  process.env.GEMINI_FALLBACK_MODEL,
);

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

function isGeminiQuotaError(error) {
  const status = Number(error?.status || error?.code);
  const message = String(error?.message || error);

  return (
    status === 429 ||
    /RESOURCE_EXHAUSTED|quota exceeded|exceeded your current quota|rate.?limit/i.test(
      message,
    )
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

      if (isGeminiQuotaError(error)) {
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
  }, database) {
    // Tentukan jenis percakapan.
    const isGroup = Boolean(sharedGroupSession);

    // Ambil riwayat hanya dari sesi yang sedang digunakan.
    // Grup tidak boleh membaca riwayat percakapan pribadi.
    const activeSession = isGroup
      ? sharedGroupSession
      : privateSession;

    const history = database.loadHistory(activeSession, 10);
    const userMemories = isGroup
      ? []
      : database.loadUserMemories(privateSession);

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

    const conversationStyle = detectConversationStyle(question, history);
    const dynamicStyle = getStyleInstruction(conversationStyle);

    const aiStart = Date.now();


    const config = {
      systemInstruction: [
        systemInstruction,
        dynamicStyle,
        getMemoryInstruction(userMemories),
      ].filter(Boolean).join('\n\n'),
    };

    let response;

    response = await generateWithModelFallback(
      MODELS,
      (model) => generateWithRetry(model, contents, config),
      {
        onFallback: ({ model, nextModel, error }) => {
          console.warn(
            `[Gemini] Model ${model} gagal (${error?.status || error?.code || 'sementara'}). Beralih ke ${nextModel}.`,
          );
        },
      },
    );

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
    database.saveMessage(activeSession, 'user', userMessage);
    database.saveMessage(activeSession, 'model', answer);

    return answer;
  }


const incomingMessageQueue = createMessageQueue({ maxPending: 3 });
const incomingMessageDeduplicator = createMessageDeduplicator();
let acceptingMessages = false;
let fridayReadyAt = 0;
let client;
let databaseOperations;

function configureClientEvents(clientInstance) {
  clientInstance.on('qr', (qr) => {
    console.log('\nPindai QR ini menggunakan WhatsApp FRIDAY:');
    qrcode.generate(qr, { small: true });
    console.log('\nBuka WhatsApp > Perangkat tertaut > Tautkan perangkat.');
  });

  clientInstance.on('authenticated', () => {
    console.log('Autentikasi WhatsApp berhasil.');
  });

  clientInstance.on('ready', () => {
    acceptingMessages = true;
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

  clientInstance.on('auth_failure', (message) => {
    console.error('Autentikasi gagal:', message);
  });

  clientInstance.on('disconnected', (reason) => {
    console.warn('WhatsApp terputus:', reason);
  });
}

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


const messageService = createMessageService({
  botName: BOT_NAME,
  getReadyAt: () => fridayReadyAt,
  sessions: {
    privateSessionId,
    groupSessionId,
  },
  memory: {
    parseCommand: parseMemoryCommand,
    handleCommand: (text, sessionId) => handleMemoryCommand(
      text,
      sessionId,
      {
        add: (...args) => databaseOperations.saveUserMemory(...args),
        list: (...args) => databaseOperations.loadUserMemories(...args),
        delete: (...args) => databaseOperations.deleteUserMemory(...args),
        clear: (...args) => databaseOperations.clearUserMemories(...args),
      },
    ),
  },
  video: {
    getUrls: getSocialVideoUrls,
    isDownloadRequest: isSocialVideoDownloadRequest,
    download: downloadSocialVideo,
    getFailureMessage: getVideoDownloadFailureMessage,
  },
  sticker: {
    isRequest: isImageStickerRequest,
    parseOptions: parseImageStickerOptions,
    create: createImageSticker,
    getFailureMessage: getImageStickerFailureMessage,
  },
  image: {
    isGenerationRequest: isImageGenerationRequest,
    generate: generateImage,
    isQuotaError: isImageGenerationQuotaError,
    getQuotaDiagnostic: (error) => {
      const diagnostic = getImageGenerationQuotaDiagnostic(error);
      return [
        diagnostic.model,
        diagnostic.details,
        diagnostic.retryText,
        diagnostic.freeTierLimitZero
          ? 'Free Tier limit model=0; menunggu saja mungkin tidak cukup.'
          : '',
        'Tindakan: cek project API key, kuota model, dan billing/plan di Google AI Studio.',
      ].filter(Boolean).join(' │ ');
    },
    getFailureMessage: getImageGenerationFailureMessage,
  },
  assistant: {
    ask: (input) => askFriday(input, databaseOperations),
    getFailureMessage: getAiFailureMessage,
  },
  audio: {
    transcribe: transcribeVoiceNote,
    generate: generateVoiceNote,
    isQuotaError: isVoiceNoteQuotaError,
    getFailureMessage: getVoiceNoteFailureMessage,
  },
  history: {
    save: (...args) => databaseOperations.saveMessage(...args),
  },
  formatMessage: formatWhatsAppMessage,
  deliver: {
    sendVideo: (chatId, videoResult, caption) => {
      const media = MessageMedia.fromFilePath(videoResult.path);
      return client.sendMessage(chatId, media, { caption });
    },
    sendSticker: async (chatId, stickerResult, botName) => {
      const media = new MessageMedia(
        stickerResult.mimetype,
        await readImageStickerData(stickerResult.path),
        'friday-sticker.webp',
        stickerResult.size,
      );
      return client.sendMessage(chatId, media, {
        sendMediaAsSticker: true,
        stickerName: botName,
        stickerAuthor: 'Friday AI',
      });
    },
    sendImage: (chatId, generatedImage, caption) => {
      const extension = generatedImage.mimeType === 'image/jpeg'
        ? 'jpg'
        : generatedImage.mimeType === 'image/webp'
          ? 'webp'
          : 'png';
      const media = new MessageMedia(
        generatedImage.mimeType,
        generatedImage.data,
        `friday-generated.${extension}`,
      );
      return client.sendMessage(chatId, media, { caption });
    },
    sendVoice: (chatId, path) => {
      const media = MessageMedia.fromFilePath(path);
      return client.sendMessage(chatId, media, { sendAudioAsVoice: true });
    },
  },
  logger: {
    event: logEvent,
    error: (label, error) => {
      console.error(`[${label}]`, inspect(error, { depth: 6, colors: false }));
    },
  },
});

function normalizeIncomingMessage(message) {
  const id = message.id;

  if (id && id._serialized == null) {
    const serializedId = id.$1 ?? (
      id.fromMe != null && id.remote && id.id
        ? `${id.fromMe}_${id.remote}_${id.id}`
        : null
    );

    if (serializedId) {
      id._serialized = serializedId;
    }
  }

  const isGroup = message.from.endsWith('@g.us');
  const mediaDetails = message._data || {};

  return {
    messageId: typeof id === 'string'
      ? id
      : id?._serialized || id?.$1 || null,
    chatId: message.from,
    senderId: isGroup
      ? (message.author || message.from)
      : message.from,
    chatType: isGroup ? 'group' : 'private',
    messageType: message.type,
    text: message.body?.trim() || '',
    caption: message.type === 'image'
      ? (message.body?.trim() || '')
      : '',
    timestamp: Number(message.timestamp),
    group: isGroup
      ? { senderName: mediaDetails.notifyName || 'Anggota grup' }
      : null,
    media: message.hasMedia || message.type === 'image' || message.type === 'ptt'
      ? {
          download: () => downloadMediaWithRetry(message),
          diagnostics: {
            type: message.type,
            hasMedia: message.hasMedia,
            mimetype: mediaDetails.mimetype || 'unknown',
            size: mediaDetails.size ?? 'unknown',
            directPath: Boolean(mediaDetails.directPath),
            mediaKey: Boolean(mediaDetails.mediaKey),
            encFilehash: Boolean(mediaDetails.encFilehash),
            mediaStage: mediaDetails.mediaData?.mediaStage || 'unknown',
          },
        }
      : null,
  };
}

function handleIncomingMessage(message) {
  const normalizedMessage = normalizeIncomingMessage(message);

  return messageService.handle(normalizedMessage, {
    reply: (text) => message.reply(text),
  });
}

function registerMessageHandler(clientInstance) {
  clientInstance.on('message', (message) => {
    if (!acceptingMessages) {
      return;
    }

    if (!isQueueableMessage(message, BOT_NAME)) {
      return;
    }

    const deduplicationKey = getMessageDeduplicationKey(message);

    if (!incomingMessageDeduplicator.claim(deduplicationKey)) {
      console.log('[Diabaikan] Event pesan WhatsApp duplikat.');
      return;
    }

    const queuedMessage = incomingMessageQueue.enqueue(
      message.from,
      () => handleIncomingMessage(message),
    );

    if (!queuedMessage) {
      incomingMessageDeduplicator.release(deduplicationKey);
      void message.reply(
        'Aku masih memproses beberapa pesan di chat ini. Pesan baru ini belum masuk antrean, coba kirim lagi sebentar ya.',
      ).catch((error) => {
        console.error(
          '[Pemberitahuan antrean penuh gagal]',
          error?.message || error,
        );
      });
      return;
    }

    queuedMessage.catch((error) => {
      console.error(
        '[Pemrosesan pesan antrean gagal]',
        inspect(error, { depth: 4, colors: false }),
      );
    });
  });
}

const application = createApplication({
  openDatabase: () => {
    databaseOperations = initializeDefaultDatabase();
    return databaseOperations;
  },
  createClient: async () => {
    client = new Client({
      authStrategy: new LocalAuth({
        clientId: 'friday',
        dataPath: './.wwebjs_auth',
      }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
    });
    return client;
  },
  configureClient: async (createdClient) => {
    configureClientEvents(createdClient);
    registerMessageHandler(createdClient);
  },
  initializeClient: async (createdClient) => {
    printBanner();
    await logRuntimeDiagnostics();
    await createdClient.initialize();
  },
  stopAccepting: () => {
    acceptingMessages = false;
  },
  drainMessages: () => incomingMessageQueue.drain(),
  logger: console,
});

let signalHandlersRegistered = false;

export function startFriday() {
  if (!signalHandlersRegistered) {
    signalHandlersRegistered = true;
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, () => {
        void application.shutdown(signal);
      });
    }
  }

  return application.start();
}
