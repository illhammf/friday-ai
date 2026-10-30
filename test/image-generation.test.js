import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = 'test-api-key';
const [
  {
    extractGeneratedImage,
    generateImage,
    getImageGenerationFailureMessage,
    isImageGenerationQuotaError,
    IMAGE_MODEL,
  },
  { isImageGenerationRequest },
] = await Promise.all([
  import('../src/ai/generate-image.js'),
  import('../src/ai/image-generation-request.js'),
]);

test('recognizes common Indonesian and English image-generation requests', () => {
  for (const prompt of [
    'Buatkan gambar kucing astronot',
    'Buatin gambar kucing tanpa topi',
    'Tolong bikin foto pemandangan pantai saat senja',
    'Generate an image of a cozy cabin in the snow',
    'Gambarin logo sederhana untuk toko kopi',
    'Gambarkan burung merpati di dahan',
    'Gambar burung elang',
    'Bisa gambar burung hantu?',
    'Mau gambar burung kenari',
    'Buat aku wallpaper bertema luar angkasa',
  ]) {
    assert.equal(isImageGenerationRequest(prompt), true, prompt);
  }
});

test('does not treat image questions or text-only image tasks as generation', () => {
  for (const prompt of [
    'Tolong jelaskan gambar ini',
    'Buat caption untuk gambar produk ini',
    'Jangan buat gambar dulu',
    'Tidak usah buatkan gambar sekarang',
    'Jelaskan gambar burung ini',
    'Apa isi gambar burung ini?',
    'Jelasin gambar burung ini',
    'Ceritain gambar burung ini',
    'Caption untuk gambar burung',
    'Apa isi foto ini?',
    '',
  ]) {
    assert.equal(isImageGenerationRequest(prompt), false, prompt);
  }
});

test('extracts image data and accompanying text from Gemini response', () => {
  assert.deepEqual(
    extractGeneratedImage({
      candidates: [{
        content: {
          parts: [
            { text: 'Gambar selesai.' },
            {
              inlineData: {
                mimeType: 'image/png',
                data: 'aW1hZ2U=',
              },
            },
          ],
        },
      }],
    }),
    {
      data: 'aW1hZ2U=',
      mimeType: 'image/png',
      text: 'Gambar selesai.',
    },
  );
});

test('reports when Gemini returns no image', () => {
  assert.throws(
    () => extractGeneratedImage({ candidates: [] }),
    /Gemini tidak menghasilkan data gambar/,
  );
});

test('reports when Gemini blocks image generation for safety', () => {
  assert.throws(
    () => extractGeneratedImage({
      candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }],
    }),
    /finishReason: SAFETY/,
  );
});

test('rejects invalid image data and unsupported image formats', () => {
  assert.throws(
    () => extractGeneratedImage({
      candidates: [{
        content: {
          parts: [{
            inlineData: { mimeType: 'image/png', data: 'not base64!' },
          }],
        },
      }],
    }),
    /Gemini mengembalikan data gambar yang tidak valid/,
  );
  assert.throws(
    () => extractGeneratedImage({
      candidates: [{
        content: {
          parts: [{
            inlineData: { mimeType: 'image/gif', data: 'aW1hZ2U=' },
          }],
        },
      }],
    }),
    /Gemini tidak menghasilkan data gambar/,
  );
});

test('requests image output using the configured Gemini image model', async () => {
  let request;

  const image = await generateImage(
    'Buat gambar kucing astronot',
    async (params) => {
      request = params;
      return {
        candidates: [{
          content: {
            parts: [{
              inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' },
            }],
          },
        }],
      };
    },
  );

  assert.equal(request.model, IMAGE_MODEL);
  assert.equal(request.contents, 'Buat gambar kucing astronot');
  assert.deepEqual(request.config.responseModalities, ['TEXT', 'IMAGE']);
  assert.equal(image.data, 'aW1hZ2U=');
});

test('retries temporary image API failures and propagates permanent errors', async () => {
  let attempts = 0;
  const imageResponse = {
    candidates: [{
      content: {
        parts: [{
          inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' },
        }],
      },
    }],
  };

  const image = await generateImage('A test image', async () => {
    attempts++;
    if (attempts === 1) {
      const error = new Error('Temporary service unavailable');
      error.status = 503;
      throw error;
    }
    return imageResponse;
  });

  assert.equal(attempts, 2);
  assert.equal(image.mimeType, 'image/png');

  const permanentError = new Error('Invalid API key');
  await assert.rejects(
    generateImage('A test image', async () => {
      throw permanentError;
    }),
    (error) => error === permanentError,
  );
});

test('does not retry exhausted Gemini image quotas', async () => {
  let attempts = 0;
  const quotaError = new Error(JSON.stringify({
    error: {
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      message: 'You exceeded your current quota.',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [{
            description: 'Requests per day limit exceeded on Free Tier.',
          }],
        },
        {
          '@type': 'type.googleapis.com/google.rpc.RetryInfo',
          retryDelay: '58286s',
        },
      ],
    },
  }));
  quotaError.status = 429;

  await assert.rejects(
    generateImage('Gambar burung', async () => {
      attempts++;
      throw quotaError;
    }),
    (error) => error === quotaError,
  );

  assert.equal(attempts, 1);
  assert.equal(isImageGenerationQuotaError(quotaError), true);
  assert.match(
    getImageGenerationFailureMessage(quotaError),
    /sekitar 16 jam 11 menit/,
  );
  assert.match(
    getImageGenerationFailureMessage(quotaError),
    /billing di Google AI Studio/,
  );
});
