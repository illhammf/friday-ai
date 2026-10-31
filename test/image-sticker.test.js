import test from 'node:test';
import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  createImageSticker,
  getImageStickerFailureMessage,
  isImageStickerRequest,
  readImageStickerData,
} from '../src/whatsapp/image-sticker.js';

const sourceImage = {
  mimetype: 'image/jpeg',
  data: Buffer.from('fake image data').toString('base64'),
};

test('recognizes explicit sticker requests for attached images', () => {
  for (const request of [
    'Buatkan stiker dari foto ini',
    'Bikin stiker dong',
    'Ubah foto ini jadi sticker',
    'Jadikan gambar ini stiker ya',
    'Make a sticker from this photo',
    'Create a sticker from this image',
  ]) {
    assert.equal(isImageStickerRequest(request), true, request);
  }
});

test('does not mistake questions or negated requests for sticker creation', () => {
  for (const request of [
    'Bagaimana cara membuat stiker dari foto?',
    'Jangan buat stiker dari foto ini',
    'Tolong jelaskan foto ini',
    'Buat gambar baru dari foto ini',
    '',
  ]) {
    assert.equal(isImageStickerRequest(request), false, request);
  }
});

test('creates a compact WebP sticker and cleans temporary files', async () => {
  let temporaryDirectory;
  const result = await createImageSticker(sourceImage, {
    runFfmpeg: async (_command, args) => {
      const outputPath = args.at(-1);
      temporaryDirectory = dirname(outputPath);
      assert.ok(args.includes('libwebp'));
      assert.match(args[args.indexOf('-vf') + 1], /scale=512:512/);
      await writeFile(outputPath, 'webp-sticker');
    },
  });

  assert.equal(result.mimetype, 'image/webp');
  assert.equal(result.size, 12);
  assert.equal(await readImageStickerData(result.path), 'd2VicC1zdGlja2Vy');
  await result.cleanup();
  await assert.rejects(access(temporaryDirectory));
});

test('reduces quality and canvas size until the sticker meets the size limit', async () => {
  const canvases = [];
  const result = await createImageSticker(sourceImage, {
    runFfmpeg: async (_command, args) => {
      const canvas = args[args.indexOf('-vf') + 1].match(/scale=(\d+):/)[1];
      canvases.push(Number(canvas));
      await writeFile(
        args.at(-1),
        Buffer.alloc(canvases.length === 1 ? 100 * 1024 + 1 : 50),
      );
    },
  });

  assert.deepEqual(canvases, [512, 512]);
  assert.equal(result.size, 50);
  await result.cleanup();
});

test('rejects files that remain larger than WhatsApp sticker limits and cleans up', async () => {
  let temporaryDirectory;
  let attempts = 0;

  await assert.rejects(
    createImageSticker(sourceImage, {
      runFfmpeg: async (_command, args) => {
        attempts++;
        temporaryDirectory = dirname(args.at(-1));
        await writeFile(args.at(-1), Buffer.alloc(100 * 1024 + 1));
      },
    }),
    (error) => error.code === 'STICKER_OUTPUT_TOO_LARGE',
  );

  assert.equal(attempts, 6);
  await assert.rejects(access(temporaryDirectory));
});

test('reports missing ffmpeg and removes temporary input files', async () => {
  let temporaryDirectory;
  const missingExecutable = Object.assign(new Error('not found'), {
    code: 'ENOENT',
  });

  await assert.rejects(
    createImageSticker(sourceImage, {
      runFfmpeg: async (_command, args) => {
        temporaryDirectory = dirname(args[args.indexOf('-i') + 1]);
        throw missingExecutable;
      },
    }),
    (error) => error.code === 'STICKER_FFMPEG_MISSING',
  );

  await assert.rejects(access(temporaryDirectory));
});

test('rejects unsupported, invalid, and oversized input before conversion', async () => {
  let conversionAttempts = 0;
  const options = {
    runFfmpeg: async () => {
      conversionAttempts++;
    },
  };

  await assert.rejects(
    createImageSticker({ ...sourceImage, mimetype: 'image/bmp' }, options),
    (error) => error.code === 'STICKER_UNSUPPORTED_IMAGE',
  );
  await assert.rejects(
    createImageSticker({ ...sourceImage, data: '' }, options),
    (error) => error.code === 'STICKER_INVALID_IMAGE',
  );
  await assert.rejects(
    createImageSticker({
      ...sourceImage,
      data: Buffer.alloc(20 * 1024 * 1024 + 1).toString('base64'),
    }, options),
    (error) => error.code === 'STICKER_SOURCE_TOO_LARGE',
  );

  assert.equal(conversionAttempts, 0);
});

test('maps sticker errors to safe, actionable WhatsApp messages', () => {
  assert.match(
    getImageStickerFailureMessage({ code: 'STICKER_FFMPEG_MISSING' }),
    /admin perlu memeriksa ffmpeg/i,
  );
  assert.match(
    getImageStickerFailureMessage({ code: 'STICKER_OUTPUT_TOO_LARGE' }),
    /crop bagian utama/,
  );
  assert.match(
    getImageStickerFailureMessage(new Error('internal stack trace')),
    /belum berhasil dibuat/,
  );
  assert.doesNotMatch(
    getImageStickerFailureMessage(new Error('internal stack trace')),
    /internal stack trace/,
  );
});
