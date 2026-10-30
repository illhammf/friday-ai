import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadMediaWithRetry } from '../src/whatsapp/download-media.js';

test('returns media when the first download attempt succeeds', async () => {
  const media = { mimetype: 'image/jpeg', data: 'image-data' };
  let attempts = 0;

  const result = await downloadMediaWithRetry({}, async () => {
    attempts++;
    return media;
  });

  assert.equal(result, media);
  assert.equal(attempts, 1);
});

test('retries once when WhatsApp media download fails temporarily', async () => {
  const media = { mimetype: 'image/jpeg', data: 'image-data' };
  let attempts = 0;

  const result = await downloadMediaWithRetry({}, async () => {
    attempts++;
    if (attempts === 1) {
      throw new Error('Temporary WhatsApp download failure');
    }
    return media;
  });

  assert.equal(result, media);
  assert.equal(attempts, 2);
});

test('preserves the final download error after retrying', async () => {
  const error = new Error('WhatsApp media decryption failed');
  let attempts = 0;

  await assert.rejects(
    downloadMediaWithRetry({}, async () => {
      attempts++;
      throw error;
    }),
    (result) => {
      assert.match(result.message, /setelah 2 percobaan/);
      assert.equal(result.cause, error);
      return true;
    },
  );
  assert.equal(attempts, 2);
});

test('passes the message MIME type to WhatsApp media decryption', async () => {
  const originalWindow = globalThis.window;
  const mediaMessage = {
    directPath: '/media/image',
    encFilehash: 'encrypted-hash',
    filehash: 'hash',
    mediaKey: 'key',
    mediaKeyTimestamp: 123,
    type: 'image',
    mimetype: 'image/jpeg',
    size: 12,
    mediaData: { mediaStage: 'RESOLVED' },
  };

  globalThis.window = {
    require(name) {
      if (name === 'WAWebCollections') {
        return {
          Msg: {
            get: () => mediaMessage,
          },
        };
      }

      if (name === 'WAWebDownloadManager') {
        return {
          downloadManager: {
            async downloadAndMaybeDecrypt(options) {
              assert.equal(options.type, 'image');
              assert.equal(options.mimetype, 'image/jpeg');
              return Buffer.from('image bytes');
            },
          },
        };
      }

      throw new Error(`Unexpected WhatsApp module: ${name}`);
    },
    WWebJS: {
      async arrayBufferToBase64Async(buffer) {
        return Buffer.from(buffer).toString('base64');
      },
    },
  };

  try {
    const media = await downloadMediaWithRetry({
      id: { _serialized: 'message-id' },
      client: {
        pupPage: {
          async evaluate(callback, messageId) {
            return callback(messageId);
          },
        },
      },
    });

    assert.equal(media.mimetype, 'image/jpeg');
    assert.equal(Buffer.from(media.data, 'base64').toString(), 'image bytes');
  } finally {
    if (originalWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = originalWindow;
    }
  }
});
