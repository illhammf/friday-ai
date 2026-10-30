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
  const status = Number(error?.status || error?.code);
  const message = String(error?.message || error);

  return (
    [429, 500, 502, 503, 504].includes(status) ||
    /\b429\b|\b500\b|\b502\b|\b503\b|\b504\b|UNAVAILABLE|high demand|rate.?limit|quota exceeded|overloaded|temporarily unavailable/i.test(message)
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
