import { ai } from './gemini.js';

export const IMAGE_MODEL =
  process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';

const SUPPORTED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1000;

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function isTemporaryGeminiError(error) {
  if (isImageGenerationQuotaError(error)) {
    return false;
  }

  const status = Number(error?.status || error?.code);
  const message = String(error?.message || error);

  return (
    status === 429 ||
    [500, 502, 503, 504].includes(status) ||
    /\b429\b|\b500\b|\b502\b|\b503\b|\b504\b|UNAVAILABLE|high demand|rate.?limit|quota exceeded|overloaded|temporarily unavailable/i.test(message)
  );
}

function getErrorText(error) {
  const values = [
    error?.message,
    error?.status,
    error?.code,
    error?.error?.message,
    error?.error?.status,
    error?.response?.data,
  ];

  return values
    .filter((value) => value != null)
    .map((value) => (
      typeof value === 'string' ? value : JSON.stringify(value)
    ))
    .join(' ');
}

export function isImageGenerationQuotaError(error) {
  const status = Number(error?.status || error?.code);
  const details = getErrorText(error);

  return (
    /RESOURCE_EXHAUSTED|quota exceeded|exceeded your current quota|limit:\s*0|requests per day|billing details/i.test(details) ||
    status === 429
  );
}

function getRetryDelaySeconds(error) {
  const details = getErrorText(error);
  const match = details.match(/retryDelay["']?\s*:\s*["']?(\d+(?:\.\d+)?)s/i);

  if (match) {
    return Number(match[1]);
  }

  const seconds = Number(error?.retryDelay);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function formatRetryDelay(seconds) {
  const totalMinutes = Math.floor(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0 && minutes > 0) {
    return `sekitar ${hours} jam ${minutes} menit`;
  }

  if (hours > 0) {
    return `sekitar ${hours} jam`;
  }

  return `sekitar ${Math.max(1, minutes)} menit`;
}

export function getImageGenerationFailureMessage(error) {
  if (!isImageGenerationQuotaError(error)) {
    return 'Maaf, gambar belum berhasil dibuat. Coba ubah deskripsinya atau coba lagi beberapa saat ya.';
  }

  const retryDelay = getRetryDelaySeconds(error);
  const retryText = retryDelay
    ? ` Coba lagi ${formatRetryDelay(retryDelay)}.`
    : '';

  return (
    'Kuota Gemini untuk model gambar sedang habis atau belum tersedia di paket API project ini. ' +
    'Periksa kuota model dan pengaturan billing di Google AI Studio sebelum mencoba lagi.' +
    retryText
  );
}

export function extractGeneratedImage(response) {
  const candidates = response?.candidates ?? [];
  const parts = candidates.flatMap(
    (candidate) => candidate.content?.parts ?? [],
  );

  const imagePart = parts.find(
    (part) =>
      part.inlineData?.data &&
      SUPPORTED_IMAGE_TYPES.has(part.inlineData.mimeType),
  );

  if (!imagePart) {
    const finishReason = candidates
      .map((candidate) => candidate.finishReason)
      .filter(Boolean)
      .join(', ');

    if (finishReason) {
      throw new Error(
        `Gemini tidak menghasilkan gambar (finishReason: ${finishReason}).`,
      );
    }

    throw new Error('Gemini tidak menghasilkan data gambar.');
  }

  const imageData = imagePart.inlineData.data.replace(/^data:image\/[^;]+;base64,/i, '');

  if (
    !imageData ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(imageData) ||
    imageData.length % 4 !== 0 ||
    Buffer.from(imageData, 'base64').length === 0
  ) {
    throw new Error('Gemini mengembalikan data gambar yang tidak valid.');
  }

  return {
    data: imageData,
    mimeType: imagePart.inlineData.mimeType,
    text: parts
      .filter((part) => typeof part.text === 'string')
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join('\n'),
  };
}

export async function generateImage(
  prompt,
  generateContent = (params) => ai.models.generateContent(params),
) {
  const normalizedPrompt = String(prompt || '').trim();

  if (!normalizedPrompt) {
    throw new Error('Deskripsi gambar tidak boleh kosong.');
  }

  let response;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      response = await generateContent({
        model: IMAGE_MODEL,
        contents: normalizedPrompt,
        config: {
          responseModalities: ['TEXT', 'IMAGE'],
        },
      });
      break;
    } catch (error) {
      if (!isTemporaryGeminiError(error) || attempt === MAX_ATTEMPTS) {
        throw error;
      }

      await sleep(RETRY_DELAY_MS);
    }
  }

  return extractGeneratedImage(response);
}
