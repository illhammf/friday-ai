import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadMediaWithRetry } from '../src/whatsapp/download-media.js';

test('returns media when the first download attempt succeeds', async () => {
  const media = { mimetype: 'image/jpeg', data: 'image-data' };
  let attempts = 0;

  const result = await downloadMediaWithRetry({
    async downloadMedia() {
      attempts++;
      return media;
    },
  });

  assert.equal(result, media);
  assert.equal(attempts, 1);
});

test('retries once when WhatsApp media download fails temporarily', async () => {
  const media = { mimetype: 'image/jpeg', data: 'image-data' };
  let attempts = 0;

  const result = await downloadMediaWithRetry({
    async downloadMedia() {
      attempts++;
      if (attempts === 1) {
        throw new Error('Temporary WhatsApp download failure');
      }
      return media;
    },
  });

  assert.equal(result, media);
  assert.equal(attempts, 2);
});

test('preserves the final download error after retrying', async () => {
  const error = new Error('WhatsApp media decryption failed');
  let attempts = 0;

  await assert.rejects(
    downloadMediaWithRetry({
      async downloadMedia() {
        attempts++;
        throw error;
      },
    }),
    (result) => {
      assert.match(result.message, /setelah 2 percobaan/);
      assert.equal(result.cause, error);
      return true;
    },
  );
  assert.equal(attempts, 2);
});
