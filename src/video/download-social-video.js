import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_VIDEO_BYTES = 64 * 1024 * 1024;
const VIDEO_DOWNLOAD_TIMEOUT_MS = 180_000;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SUPPORTED_HOSTS = new Set([
  'instagram.com',
  'www.instagram.com',
  'instagr.am',
  'www.instagr.am',
  'tiktok.com',
  'www.tiktok.com',
  'm.tiktok.com',
  'vm.tiktok.com',
  'vt.tiktok.com',
]);

export function getSocialVideoUrls(text) {
  const candidates = String(text || '').match(/https?:\/\/[^\s<>"'`]+/gi) || [];
  const urls = new Set();

  for (const candidate of candidates) {
    const trimmed = candidate.replace(/[),.!?;:]+$/g, '');

    try {
      const url = new URL(trimmed);

      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.port ||
        !SUPPORTED_HOSTS.has(url.hostname.toLowerCase())
      ) {
        continue;
      }

      urls.add(url.href);
    } catch {
      continue;
    }
  }

  return [...urls];
}

export async function downloadSocialVideo(
  url,
  runCommand = execFileAsync,
  runFfmpeg = execFileAsync,
) {
  const urls = getSocialVideoUrls(url);

  if (urls.length !== 1) {
    throw new Error('Tautan video TikTok atau Instagram tidak valid.');
  }

  const [validatedUrl] = urls;
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'friday-video-'));
  const outputTemplate = join(temporaryDirectory, '%(id)s.%(ext)s');
  const args = [
    '--ignore-config',
    '--no-cache-dir',
    '--no-warnings',
    '--no-progress',
    '--no-playlist',
    '--user-agent',
    process.env.YT_DLP_USER_AGENT || DEFAULT_USER_AGENT,
    '--max-filesize',
    '64M',
    '--format',
    'best[ext=mp4]/best',
    '--merge-output-format',
    'mp4',
    '--remux-video',
    'mp4',
    '--output',
    outputTemplate,
    validatedUrl,
  ];

  if (process.env.FFMPEG_PATH) {
    args.splice(
      args.indexOf('--output'),
      0,
      '--ffmpeg-location',
      process.env.FFMPEG_PATH,
    );
  }

  let completed = false;

  try {
    try {
      await runCommand(
        process.env.YT_DLP_PATH || 'yt-dlp',
        args,
        {
          timeout: VIDEO_DOWNLOAD_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
        },
      );
    } catch (error) {
      const errorOutput = [
        error?.message,
        error?.stdout,
        error?.stderr,
      ].filter(Boolean).join('\n');

      if (error?.code === 'ENOENT') {
        const missingToolError = new Error(
          'yt-dlp tidak ditemukan. Pasang yt-dlp dan ffmpeg di mesin Friday, lalu pastikan keduanya tersedia di PATH.',
          { cause: error },
        );
        missingToolError.code = 'YT_DLP_NOT_INSTALLED';
        throw missingToolError;
      }

      if (
        /ffmpeg.*not found|ffmpeg.*not installed|you have requested merging/i.test(
          `${error?.message || ''}\n${error?.stderr || ''}`,
        )
      ) {
        const missingFfmpegError = new Error(
          'ffmpeg tidak ditemukan. Pasang ffmpeg dan pastikan tersedia di PATH sebelum mengunduh video.',
          { cause: error },
        );
        missingFfmpegError.code = 'FFMPEG_NOT_INSTALLED';
        throw missingFfmpegError;
      }

      if (
        /unexpected response from webpage request/i.test(errorOutput) &&
        /\btiktok\b/i.test(errorOutput)
      ) {
        const blockedRequestError = new Error(
          'TikTok menolak respons permintaan unduhan dari server Friday.',
          { cause: error },
        );
        blockedRequestError.code = 'TIKTOK_REQUEST_BLOCKED';
        throw blockedRequestError;
      }

      throw error;
    }

    const videoFiles = (await readdir(temporaryDirectory, {
      withFileTypes: true,
    }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.mp4'))
      .map((entry) => join(temporaryDirectory, entry.name));

    if (videoFiles.length !== 1) {
      throw new Error('yt-dlp tidak menghasilkan satu file video MP4.');
    }

    const sourcePath = videoFiles[0];
    const sourceStats = await stat(sourcePath);

    if (sourceStats.size > MAX_VIDEO_BYTES) {
      throw new Error('Ukuran video melebihi batas pengiriman 64 MB.');
    }

    const videoPath = join(temporaryDirectory, 'friday-compatible.mp4');

    try {
      await runFfmpeg(
        process.env.FFMPEG_PATH || 'ffmpeg',
        [
          '-nostdin',
          '-y',
          '-i',
          sourcePath,
          '-map',
          '0:v:0',
          '-map',
          '0:a:0?',
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '27',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-ac',
          '2',
          '-movflags',
          '+faststart',
          videoPath,
        ],
        {
          timeout: VIDEO_DOWNLOAD_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
        },
      );
    } catch (error) {
      if (error?.code === 'ENOENT') {
        const missingFfmpegError = new Error(
          'ffmpeg tidak ditemukan. Pasang ffmpeg dan pastikan tersedia di PATH sebelum mengunduh video.',
          { cause: error },
        );
        missingFfmpegError.code = 'FFMPEG_NOT_INSTALLED';
        throw missingFfmpegError;
      }

      const transcodeError = new Error(
        error?.killed
          ? 'Konversi video melebihi batas waktu.'
          : 'Video berhasil diunduh, tetapi tidak dapat dikonversi ke format WhatsApp.',
        { cause: error },
      );
      transcodeError.code = error?.killed
        ? 'VIDEO_TRANSCODE_TIMEOUT'
        : 'VIDEO_TRANSCODE_FAILED';
      throw transcodeError;
    }

    const convertedStats = await stat(videoPath);

    if (convertedStats.size > MAX_VIDEO_BYTES) {
      throw new Error('Ukuran video melebihi batas pengiriman 64 MB.');
    }

    completed = true;

    return {
      path: videoPath,
      size: convertedStats.size,
      format: 'H.264/AAC',
      cleanup: () => rm(temporaryDirectory, {
        recursive: true,
        force: true,
      }),
    };
  } finally {
    if (!completed) {
      await rm(temporaryDirectory, {
        recursive: true,
        force: true,
      });
    }
  }
}
