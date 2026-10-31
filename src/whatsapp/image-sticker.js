import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_STICKER_BYTES = 100 * 1024 - 512;
const SUPPORTED_IMAGE_TYPES = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
]);
const ENCODING_ATTEMPTS = [
  { canvas: 512, quality: 78 },
  { canvas: 512, quality: 60 },
  { canvas: 512, quality: 42 },
  { canvas: 384, quality: 48 },
  { canvas: 320, quality: 42 },
  { canvas: 256, quality: 35 },
];

export function isImageStickerRequest(text) {
  const message = String(text || '').trim();

  if (!message) {
    return false;
  }

  const normalized = message.toLowerCase();

  if (
    /\b(?:jangan|tidak|nggak|enggak|gak|ga|bukan)\b(?:\s+\w+){0,3}\s+(?:buat(?:kan)?|bikin(?:in)?|jadi(?:kan|in)?|ubah(?:kan|in)?|stikerin|stickerize|create|make|turn)\b/i.test(
      normalized,
    ) ||
    /^(?:gimana|bagaimana|cara)\b/i.test(normalized)
  ) {
    return false;
  }

  return (
    /\b(?:buat(?:kan)?|bikin(?:in)?|jadi(?:kan|in)?|ubah(?:kan|in)?|create|make|turn)\b[\s\S]{0,60}\b(?:stiker|sticker)\b/i.test(
      normalized,
    ) ||
    /\b(?:stiker|sticker)\b[\s\S]{0,40}\b(?:dari|from)\b/i.test(normalized) ||
    /\b(?:stikerin|stickerize)\b/i.test(normalized)
  );
}

function createStickerError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

export async function createImageSticker(
  media,
  {
    runFfmpeg = execFileAsync,
    ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
  } = {},
) {
  const extension = SUPPORTED_IMAGE_TYPES.get(media?.mimetype);

  if (!extension) {
    throw createStickerError(
      'STICKER_UNSUPPORTED_IMAGE',
      'Format gambar belum didukung untuk stiker.',
    );
  }

  if (typeof media.data !== 'string' || !media.data) {
    throw createStickerError(
      'STICKER_INVALID_IMAGE',
      'Data gambar kosong atau tidak valid.',
    );
  }

  const imageData = Buffer.from(media.data, 'base64');

  if (!imageData.length) {
    throw createStickerError(
      'STICKER_INVALID_IMAGE',
      'Data gambar kosong atau tidak valid.',
    );
  }

  if (imageData.length > MAX_SOURCE_BYTES) {
    throw createStickerError(
      'STICKER_SOURCE_TOO_LARGE',
      'Foto sumber melebihi batas ukuran pemrosesan stiker.',
    );
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'friday-sticker-'));
  const sourcePath = join(temporaryDirectory, `source.${extension}`);
  const stickerPath = join(temporaryDirectory, 'friday-sticker.webp');
  let completed = false;

  try {
    await writeFile(sourcePath, imageData, { flag: 'wx' });

    for (const { canvas, quality } of ENCODING_ATTEMPTS) {
      try {
        await rm(stickerPath, { force: true });
        await runFfmpeg(
          ffmpegPath,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-nostdin',
            '-y',
            '-i',
            sourcePath,
            '-map',
            '0:v:0',
            '-frames:v',
            '1',
            '-an',
            '-vf',
            `scale=${canvas}:${canvas}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${canvas}:${canvas}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=yuva420p`,
            '-c:v',
            'libwebp',
            '-lossless',
            '0',
            '-quality',
            String(quality),
            '-compression_level',
            '6',
            stickerPath,
          ],
          {
            timeout: 30_000,
            maxBuffer: 1024 * 1024,
          },
        );
      } catch (error) {
        if (error?.code === 'ENOENT') {
          throw createStickerError(
            'STICKER_FFMPEG_MISSING',
            'ffmpeg tidak tersedia untuk membuat stiker.',
            error,
          );
        }

        throw createStickerError(
          error?.killed ? 'STICKER_PROCESS_TIMEOUT' : 'STICKER_CONVERSION_FAILED',
          'Foto tidak dapat dikonversi menjadi stiker.',
          error,
        );
      }

      const stickerStats = await stat(stickerPath);

      if (stickerStats.size <= MAX_STICKER_BYTES) {
        completed = true;
        return {
          path: stickerPath,
          size: stickerStats.size,
          mimetype: 'image/webp',
          cleanup: () => rm(temporaryDirectory, {
            recursive: true,
            force: true,
          }),
        };
      }
    }

    throw createStickerError(
      'STICKER_OUTPUT_TOO_LARGE',
      'Detail foto terlalu tinggi untuk batas ukuran stiker WhatsApp.',
    );
  } finally {
    if (!completed) {
      await rm(temporaryDirectory, {
        recursive: true,
        force: true,
      });
    }
  }
}

export function getImageStickerFailureMessage(error) {
  switch (error?.code) {
    case 'STICKER_FFMPEG_MISSING':
      return 'Fitur stiker belum siap di server Friday. Admin perlu memeriksa ffmpeg.';
    case 'STICKER_UNSUPPORTED_IMAGE':
      return 'Format foto ini belum didukung untuk dibuat menjadi stiker. Coba kirim JPG, PNG, atau WebP.';
    case 'STICKER_SOURCE_TOO_LARGE':
      return 'Ukuran foto terlalu besar untuk diproses menjadi stiker. Coba kirim foto yang lebih kecil.';
    case 'STICKER_OUTPUT_TOO_LARGE':
      return 'Foto terlalu detail untuk batas ukuran stiker WhatsApp. Coba crop bagian utama atau kirim gambar yang lebih sederhana.';
    case 'STICKER_PROCESS_TIMEOUT':
      return 'Proses membuat stikernya terlalu lama. Coba kirim foto yang lebih kecil ya.';
    default:
      return 'Foto diterima, tetapi stikernya belum berhasil dibuat. Coba kirim ulang fotonya ya.';
  }
}

export async function readImageStickerData(stickerPath) {
  if (extname(stickerPath).toLowerCase() !== '.webp') {
    throw createStickerError(
      'STICKER_INVALID_OUTPUT',
      'Hasil stiker bukan file WebP.',
    );
  }

  return readFile(stickerPath, { encoding: 'base64' });
}
