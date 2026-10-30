import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = 'test-api-key';
const { extractGeneratedImage } = await import('../src/ai/generate-image.js');

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
