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
const MAX_STICKER_TEXT_LENGTH = 80;
const MAX_STICKER_TEXT_LINES = 5;
const MAX_STICKER_TEXT_LINE_LENGTH = 18;

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

export function parseImageStickerOptions(text) {
  const message = String(text || '');
  const crop = /\b(?:crop|cropping|potong|zoom|fokus(?:kan)?|isi penuh)\b/i.test(
    message,
  );
  const quotedText = message.match(
    /\b(?:tulisan|teks|caption)\s*[:=]?\s*["“]([^"”\n]{1,80})["”]/i,
  );
  const labeledText = message.match(
    /\b(?:tulisan|teks|caption)\s*[:=]\s*(.+)$/i,
  );
  const descriptiveText = message.match(
    /\b(?:dengan|pakai|pake)\s+(?:tulisan|teks|caption)\s+(.+)$/i,
  );
  const actionText = message.match(
    /\b(?:kasih|tambah(?:kan)?|tulis(?:kan)?)\s+(?:(?:tulisan|teks|caption)\s+)?(.+)$/i,
  );
  const rawText = quotedText?.[1]
    || labeledText?.[1]
    || descriptiveText?.[1]
    || actionText?.[1]
    || '';
  const stickerText = rawText
    .replace(/\b(?:crop|cropping|potong|zoom|fokus(?:kan)?|isi penuh)\b/gi, '')
    .replace(/\b(?:ya|dong|deh|nih|coba|please)\b[.!?]*$/i, '')
    .replace(/^[\s"'“”:=,-]+|[\s"'“”:=,-]+$/g, '')
    .trim();

  return {
    crop: crop ? 'cover' : 'contain',
    text: stickerText || null,
  };
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
    text = null,
    crop = 'contain',
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

  const stickerText = String(text || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (Array.from(stickerText).length > MAX_STICKER_TEXT_LENGTH) {
    throw createStickerError(
      'STICKER_TEXT_TOO_LONG',
      `Teks stiker melebihi ${MAX_STICKER_TEXT_LENGTH} karakter.`,
    );
  }

  const cropMode = crop === 'cover' ? 'cover' : 'contain';
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'friday-sticker-'));
  const sourcePath = join(temporaryDirectory, `source.${extension}`);
  const stickerPath = join(temporaryDirectory, 'friday-sticker.webp');
  const textPath = join(temporaryDirectory, 'sticker-caption.txt');
  let completed = false;

  try {
    await writeFile(sourcePath, imageData, { flag: 'wx' });
    const wrappedText = stickerText
      ? wrapStickerText(stickerText)
      : '';

    if (wrappedText) {
      await writeFile(textPath, wrappedText, { flag: 'wx' });
    }

    for (const { canvas, quality } of ENCODING_ATTEMPTS) {
      try {
        await rm(stickerPath, { force: true });
        const fitFilter = cropMode === 'cover'
          ? `scale=${canvas}:${canvas}:force_original_aspect_ratio=increase:force_divisible_by=2,crop=${canvas}:${canvas},setsar=1,format=yuva420p`
          : `scale=${canvas}:${canvas}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${canvas}:${canvas}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=yuva420p`;
        const textFilter = wrappedText
          ? `,drawtext=font='${process.env.FRIDAY_STICKER_FONT || 'DejaVu Sans'}':textfile='${textPath}':expansion=none:fontcolor=white:fontsize=h/12:borderw=2:bordercolor=black@0.9:box=1:boxcolor=black@0.58:boxborderw=12:line_spacing=6:x=(w-text_w)/2:y=h-text_h-12`
          : '';

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
            `${fitFilter}${textFilter}`,
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
    case 'STICKER_TEXT_TOO_LONG':
      return `Teks stikernya terlalu panjang. Pendekkan jadi maksimal ${MAX_STICKER_TEXT_LENGTH} karakter, ya.`;
    default:
      return 'Foto diterima, tetapi stikernya belum berhasil dibuat. Coba kirim ulang fotonya ya.';
  }
}

function wrapStickerText(text) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';

  for (const word of words) {
    const characters = Array.from(word);
    const chunks = [];

    while (characters.length > MAX_STICKER_TEXT_LINE_LENGTH) {
      chunks.push(characters.splice(0, MAX_STICKER_TEXT_LINE_LENGTH).join(''));
    }
    if (characters.length) {
      chunks.push(characters.join(''));
    }

    for (const chunk of chunks) {
      const nextLine = line ? `${line} ${chunk}` : chunk;

      if (Array.from(nextLine).length > MAX_STICKER_TEXT_LINE_LENGTH) {
        lines.push(line);
        line = chunk;
      } else {
        line = nextLine;
      }
    }
  }

  if (line) {
    lines.push(line);
  }

  if (lines.length > MAX_STICKER_TEXT_LINES) {
    throw createStickerError(
      'STICKER_TEXT_TOO_LONG',
      `Teks stiker melebihi ${MAX_STICKER_TEXT_LENGTH} karakter.`,
    );
  }

  return lines.join('\n');
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
