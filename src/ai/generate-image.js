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

function getApiErrorPayload(error) {
  const directPayload = error?.error || error?.response?.data;

  if (directPayload && typeof directPayload === 'object') {
    return directPayload.error || directPayload;
  }

  const message = String(error?.message || '');
  const jsonStart = message.indexOf('{"error"');

  if (jsonStart === -1) {
    return null;
  }

  try {
    const parsed = JSON.parse(message.slice(jsonStart));
    return parsed.error || parsed;
  } catch {
    return null;
  }
}

function getRetryDelaySeconds(error) {
  const payload = getApiErrorPayload(error);
  const retryInfo = payload?.details?.find((detail) =>
    detail?.['@type']?.endsWith('.RetryInfo'),
  );
  const retryDelay = retryInfo?.retryDelay;
  const match = String(retryDelay || getErrorText(error))
    .match(/(\d+(?:\.\d+)?)\s*s/i);

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

function getQuotaViolations(error) {
  const payload = getApiErrorPayload(error);
  const quotaFailure = payload?.details?.find((detail) =>
    detail?.['@type']?.endsWith('.QuotaFailure'),
  );
  const descriptions = (quotaFailure?.violations || [])
    .map((violation) => violation?.description)
    .filter(Boolean);

  return [...new Set(descriptions)].slice(0, 3);
}

export function getImageGenerationQuotaDiagnostic(error, model = IMAGE_MODEL) {
  const violations = getQuotaViolations(error);
  const retryDelay = getRetryDelaySeconds(error);
  const details = violations.length
    ? violations.join('; ')
    : 'Gemini API menolak request karena kuota atau limit model.';
  const retryText = retryDelay
    ? `Estimasi API untuk mencoba lagi: ${formatRetryDelay(retryDelay)}.`
    : 'API tidak memberikan estimasi waktu untuk mencoba lagi.';

  return {
    model,
    details,
    retryText,
    freeTierLimitZero: /free.?tier.*limit[: ]+0|limit[: ]+0.*free.?tier/i.test(
      `${details} ${getErrorText(error)}`,
    ),
  };
}

export function getImageGenerationFailureMessage(error) {
  if (!isImageGenerationQuotaError(error)) {
    return 'Maaf, gambar belum berhasil dibuat. Coba ubah deskripsinya atau coba lagi beberapa saat ya.';
  }

  const diagnostic = getImageGenerationQuotaDiagnostic(error);
  const zeroFreeTier = diagnostic.freeTierLimitZero
    ? ' Respons API menyebut limit Free Tier untuk model ini 0, jadi menunggu saja mungkin tidak cukup.'
    : '';

  return (
    `Kuota Gemini API untuk model ${diagnostic.model} sedang habis atau tidak tersedia. ` +
    `${diagnostic.retryText}${zeroFreeTier}\n\n` +
    'Langkah berikutnya:\n' +
    '1. Buka https://aistudio.google.com/ dan pastikan project yang dipakai API key Friday benar.\n' +
    '2. Cek limit model di https://ai.google.dev/gemini-api/docs/rate-limits.\n' +
    '3. Jika limit Free Tier model ini 0, cek kelayakan billing/plan atau gunakan model gambar lain yang tersedia untuk project tersebut.\n' +
    'Setelah akses kuota berubah, restart Friday lalu coba lagi.'
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
