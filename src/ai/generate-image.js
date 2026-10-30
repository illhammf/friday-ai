import { ai } from './gemini.js';

const MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';

export function extractGeneratedImage(response) {
  const parts = response.candidates?.flatMap(
    (candidate) => candidate.content?.parts ?? [],
  ) ?? [];

  const imagePart = parts.find(
    (part) =>
      part.inlineData?.data &&
      part.inlineData.mimeType?.startsWith('image/'),
  );

  if (!imagePart) {
    throw new Error('Gemini tidak menghasilkan data gambar.');
  }

  return {
    data: imagePart.inlineData.data,
    mimeType: imagePart.inlineData.mimeType,
    text: parts
      .filter((part) => typeof part.text === 'string')
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join('\n'),
  };
}

export async function generateImage(prompt) {
  const normalizedPrompt = String(prompt || '').trim();

  if (!normalizedPrompt) {
    throw new Error('Deskripsi gambar tidak boleh kosong.');
  }

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: normalizedPrompt,
    config: {
      responseModalities: ['TEXT', 'IMAGE'],
    },
  });

  return extractGeneratedImage(response);
}
