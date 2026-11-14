
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
import { createMemoryService } from './application/memory-service.js';
import { createMemoryRepository } from './database/memory-repository.js';
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
import { createWhatsAppAdapters, registerQueuedMessageHandler } from './whatsapp/message-adapter.js';
import {
  getRuntimeSummary,
  inspectRuntime,
} from './config/runtime-diagnostics.js';
import { getAiFailureMessage } from './ai/ai-failure-message.js';
import { ASSISTANT_REQUEST_LIMITS } from './ai/assistant-request.js';
import {
  buildConversationContents,
  normalizeConversationHistory,
  readAssistantResponse,
} from './ai/conversation-context.js';
import { createMessageService } from './application/message-service.js';
import { createCommandRouter } from './application/command-router.js';
import { createApplication } from './application/application-lifecycle.js';
import {
  generateWithModelFallback,
  getModelChain,
} from './ai/model-fallback.js';
import whatsapp from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { createRequire } from 'node:module';
import { inspect } from 'node:util';

const packageMetadata = createRequire(import.meta.url)('../package.json');

const { Client, LocalAuth, MessageMedia } = whatsapp;


const BOT_NAME = process.env.BOT_NAME || 'Friday';
const commandRouter = createCommandRouter({
  botName: BOT_NAME,
  version: packageMetadata.version,
});
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
  }, database, memoryService) {
    // Tentukan jenis percakapan.
    const isGroup = Boolean(sharedGroupSession);

    // Ambil riwayat hanya dari sesi yang sedang digunakan.
    // Grup tidak boleh membaca riwayat percakapan pribadi.
    const activeSession = isGroup
      ? sharedGroupSession
      : privateSession;

    const rawHistory = database.loadHistory(activeSession, 10);
    const normalizedHistory = normalizeConversationHistory(rawHistory);
    const history = normalizedHistory.history;
    if (normalizedHistory.removedEmptyEntries > 0) {
      logEvent(
        'warn',
        'Entri riwayat kosong dilewati',
        `Jumlah: ${normalizedHistory.removedEmptyEntries}`,
      );
    }
    if (normalizedHistory.excludedOlderEntries > 0) {
      logEvent(
        'warn',
        'Riwayat lama dikeluarkan dari konteks Gemini',
        `Jumlah: ${normalizedHistory.excludedOlderEntries}; batas teks history aplikasi: ${ASSISTANT_REQUEST_LIMITS.maxHistoryTextBytes} byte`,
      );
    }
    const userMemories = isGroup
      ? []
      : memoryService.retrieve(privateSession, question);

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

    const { contents } = buildConversationContents({
      question,
      history,
      image,
      systemInstruction: config.systemInstruction,
      conversationType: isGroup ? 'group' : 'private',
      senderName,
    });

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

    return readAssistantResponse(response);
  }


const incomingMessageQueue = createMessageQueue({ maxPending: 3 });
const incomingMessageDeduplicator = createMessageDeduplicator();
let acceptingMessages = false;
let fridayReadyAt = 0;
let client;
let whatsappAdapters;
let databaseOperations;
let memoryService;

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
        add: (...args) => memoryService.add(...args),
        list: (...args) => memoryService.list(...args),
        delete: (...args) => memoryService.delete(...args),
        clear: (...args) => memoryService.clear(...args),
      },
    ),
  },
  commands: commandRouter,
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
    ask: (input) => askFriday(input, databaseOperations, memoryService),
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
    saveConversationTurn: (...args) =>
      databaseOperations.saveConversationTurn(...args),
  },
  formatMessage: formatWhatsAppMessage,
  deliver: {
    sendVideo: (...args) => whatsappAdapters.deliver.sendVideo(...args),
    sendSticker: (...args) => whatsappAdapters.deliver.sendSticker(...args),
    sendImage: (...args) => whatsappAdapters.deliver.sendImage(...args),
    sendVoice: (...args) => whatsappAdapters.deliver.sendVoice(...args),
  },
  logger: {
    event: logEvent,
    error: (label, error) => {
      console.error(`[${label}]`, inspect(error, { depth: 6, colors: false }));
    },
  },
});

function registerMessageHandler(clientInstance) {
  registerQueuedMessageHandler(clientInstance, {
    botName: BOT_NAME,
    canAccept: () => acceptingMessages,
    isQueueableMessage,
    getDeduplicationKey: getMessageDeduplicationKey,
    deduplicator: incomingMessageDeduplicator,
    queue: incomingMessageQueue,
    normalize: (message) => whatsappAdapters.normalize(message),
    handle: (message, transport) => messageService.handle(message, transport),
    reply: (message) => whatsappAdapters.reply(message),
    logger: {
      log: console.log.bind(console),
      error: (...args) => console.error(
        args[0],
        inspect(args[1], { depth: 4, colors: false }),
      ),
    },
  });
}

const application = createApplication({
  openDatabase: () => {
    databaseOperations = initializeDefaultDatabase();
    memoryService = createMemoryService({
      repository: createMemoryRepository(databaseOperations),
    });
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
    whatsappAdapters = createWhatsAppAdapters({
      client: createdClient,
      MessageMedia,
      downloadMedia: downloadMediaWithRetry,
      readStickerData: readImageStickerData,
    });
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
